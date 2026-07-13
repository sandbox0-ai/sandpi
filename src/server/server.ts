import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";

import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { Pool } from "pg";
import { ZodError, z } from "zod";

import type {
  NetworkPolicy,
  SandpiDeploymentSummary,
  SandpiPreferences,
} from "@/lib/types";
import { OidcIdentityService } from "@/server/auth/oidc";
import type { Principal } from "@/server/auth/principal";
import { loadConfig, type SandpiConfig } from "@/server/config";
import { migrateDatabase } from "@/server/db/migrate";
import { createDatabasePool } from "@/server/db/pool";
import { seedCommunityDefaults } from "@/server/db/seed";
import { EnvironmentService } from "@/server/environments/service";
import { CodexEnvironmentAuthService } from "@/server/harnesses/codex/auth-service";
import { CodexAuthStore } from "@/server/harnesses/codex/auth-store";
import { CodexService } from "@/server/harnesses/codex/service";
import {
  MAX_CODEX_INPUT_BASE64_LENGTH,
  MAX_CODEX_INPUT_IMAGES,
} from "@/server/harnesses/codex/input-images";
import { HttpError } from "@/server/http-error";
import { createRuntime } from "@/server/runtime";
import type { RuntimeAdapter } from "@/server/runtime/types";
import {
  allowedOrigins,
  validateApiRequestOrigin,
} from "@/server/request-origin";
import { SecretBox } from "@/server/secrets";
import { SandpiStore } from "@/server/store";

const SESSION_COOKIE = "sandpi_session";
const CODEX_IMAGE_BODY_LIMIT_BYTES = 36 * 1024 * 1024;

export interface SandpiServerOptions {
  config?: SandpiConfig;
  pool?: Pool;
  runtime?: RuntimeAdapter;
}

export interface SandpiServer {
  app: FastifyInstance;
  config: SandpiConfig;
  store: SandpiStore;
  close(): Promise<void>;
}

export async function createSandpiServer(
  options: SandpiServerOptions = {},
): Promise<SandpiServer> {
  const config = options.config ?? loadConfig();
  const ownsPool = !options.pool;
  const pool =
    options.pool ?? createDatabasePool({ connectionString: config.databaseUrl });
  await migrateDatabase(pool);
  if (config.auth.mode === "admin") {
    await seedCommunityDefaults(pool);
  }

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    requestIdHeader: "x-request-id",
    genReqId: (request) => request.headers["x-request-id"]?.toString() || randomUUID(),
  });
  const store = new SandpiStore(pool);
  const runtime = options.runtime ?? createRuntime(config);
  const secretBox = config.secretKey ? new SecretBox(config.secretKey) : undefined;
  const codexAuth = new CodexEnvironmentAuthService(
    store,
    new CodexAuthStore(pool),
    runtime,
    secretBox,
    app.log,
  );
  const codex = new CodexService(store, runtime, app.log, codexAuth);
  const environments = new EnvironmentService(store, runtime, app.log);
  const oidcIdentity =
    config.auth.mode === "oidc" && secretBox
      ? new OidcIdentityService(pool, config.auth, config.publicUrl, secretBox)
      : undefined;

  app.decorateRequest("principal");
  await app.register(fastifyCookie, {
    secret: config.auth.cookieSecret,
    hook: "onRequest",
  });
  await app.register(fastifyCors, {
    credentials: true,
    origin: (origin, callback) => {
      if (!origin || allowedOrigins(config).has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed by Sandpi."), false);
    },
  });
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 1_100_000 },
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);
    if (normalized.statusCode >= 500) {
      request.log.error(
        { err: error, code: normalized.code },
        "Sandpi request failed",
      );
    }
    void reply.status(normalized.statusCode).send({
      error: {
        code: normalized.code,
        message: normalized.message,
        requestId: request.id,
        details: normalized.details,
        ...(normalized.statusCode === 401
          ? { loginUrl: "/api/v1/auth/login" }
          : {}),
      },
    });
  });

  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/v1") || publicAuthPath(request.url)) {
      return;
    }
    request.principal = await authenticateRequest(request, oidcIdentity);
    validateApiRequestOrigin(request, config);
  });

  registerHealthRoutes(app, pool, runtime);
  registerAuthRoutes(app, config, environments, oidcIdentity);
  registerApiRoutes(app, {
    config,
    store,
    runtime,
    codex,
    codexAuth,
    environments,
  });

  if (existsSync(config.webDir)) {
    app.get("/preferences", async (_request, reply) =>
      reply.redirect("/preferences/", 308),
    );
    app.get("/team", async (_request, reply) => reply.redirect("/team/", 308));
    await app.register(fastifyStatic, {
      root: config.webDir,
      prefix: "/",
      wildcard: false,
      index: ["index.html"],
    });
  } else {
    app.log.warn({ webDir: config.webDir }, "Static Web build was not found");
  }

  app.addHook("onClose", async () => {
    await codexAuth.close();
    await codex.close();
    if (ownsPool) await pool.end();
  });

  await environments.reconcilePending();
  await codexAuth.resumePending();
  await codex.resumeWorkers();

  return {
    app,
    config,
    store,
    close: () => app.close(),
  };
}

function registerHealthRoutes(
  app: FastifyInstance,
  pool: Pool,
  runtime: RuntimeAdapter,
) {
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready", database: "ready", runtime: runtime.mode };
    } catch {
      return reply.status(503).send({
        status: "not-ready",
        database: "unavailable",
        runtime: runtime.mode,
      });
    }
  });
}

function registerAuthRoutes(
  app: FastifyInstance,
  config: SandpiConfig,
  environments: EnvironmentService,
  oidcIdentity?: OidcIdentityService,
) {
  app.get("/api/v1/auth/login", async (request, reply) => {
    const returnTo = queryString(request, "return_to") ?? "/";
    if (!oidcIdentity) return reply.redirect(safeLocalRedirect(returnTo, config));
    const login = await oidcIdentity.startLogin(returnTo);
    return reply.redirect(login.authorizationUrl.toString());
  });

  app.get("/api/v1/auth/callback", async (request, reply) => {
    if (!oidcIdentity) {
      throw new HttpError(404, "oidc_not_configured", "OIDC is not configured.");
    }
    const result = await oidcIdentity.completeLogin(
      new URL(request.url, config.publicUrl),
    );
    // A first-time OIDC user receives a default Team and Environment in the
    // identity transaction. Provision that Environment before the first Web
    // bootstrap so every client observes the same ready/error state without a
    // server restart. EnvironmentService coalesces concurrent reconciliations.
    await environments.reconcilePending();
    reply.setCookie(SESSION_COOKIE, result.token, sessionCookie(config, result.expiresAt));
    return reply.redirect(result.returnTo);
  });

  app.get("/api/v1/auth/me", async (request) => ({ data: request.principal }));
  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token && oidcIdentity) await oidcIdentity.logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });
}

function registerApiRoutes(
  app: FastifyInstance,
  services: {
    config: SandpiConfig;
    store: SandpiStore;
    runtime: RuntimeAdapter;
    codex: CodexService;
    codexAuth: CodexEnvironmentAuthService;
    environments: EnvironmentService;
  },
) {
  const deployment = deploymentSummary(services.config, services.runtime);

  app.get("/api/v1/bootstrap", async (request) => ({
    data: await services.store.getBootstrap(
      request.principal.userId,
      deployment,
      queryString(request, "team"),
      queryString(request, "environment"),
      queryString(request, "session"),
      queryString(request, "new") === "1",
    ),
    meta: { runtime: services.runtime.mode },
  }));

  app.get("/api/v1/environments", async (request) => ({
    data: await services.store.listEnvironments(request.principal.userId),
  }));
  app.post("/api/v1/environments", async (request, reply) => {
    const body = z
      .object({ teamId: z.string().min(1), name: z.string().trim().min(1).max(80) })
      .parse(request.body);
    const environment = await services.environments.create({
      userId: request.principal.userId,
      ...body,
    });
    return reply.status(201).send({ data: environment });
  });
  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId",
    async (request) => {
      const body = z
        .object({
          name: z.string().trim().min(1).max(80),
          description: z.string().max(500),
          color: z.string().regex(/^#[0-9a-f]{6}$/i),
          networkPolicy: networkPolicySchema,
        })
        .parse(request.body);
      return {
        data: await services.store.updateEnvironment(
          request.principal.userId,
          request.params.environmentId,
          body,
        ),
      };
    },
  );
  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/provisioning",
    async (request, reply) => {
      const body = z.object({ desiredState: z.literal("ready") }).parse(request.body);
      void body;
      const environment = await services.environments.retry(
        request.principal.userId,
        request.params.environmentId,
      );
      return reply.status(202).send({ data: environment });
    },
  );
  app.post<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/device-login",
    async (request, reply) => {
      const flow = await services.codexAuth.startDeviceLogin(
        request.principal.userId,
        request.params.environmentId,
      );
      return reply.status(201).send({ data: flow });
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/device-login",
    async (request) => ({
      data:
        (await services.codexAuth.activeDeviceLogin(
          request.principal.userId,
          request.params.environmentId,
        )) ?? null,
    }),
  );
  app.get<{ Params: { environmentId: string; flowId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/device-login/:flowId",
    async (request) => ({
      data: await services.codexAuth.getDeviceLogin(
        request.principal.userId,
        request.params.environmentId,
        request.params.flowId,
      ),
    }),
  );
  app.delete<{ Params: { environmentId: string; flowId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/device-login/:flowId",
    async (request) => ({
      data: await services.codexAuth.cancelDeviceLogin(
        request.principal.userId,
        request.params.environmentId,
        request.params.flowId,
      ),
    }),
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/models",
    async (request) => ({
      data: await services.codexAuth.modelsForEnvironment(
        request.principal.userId,
        request.params.environmentId,
      ),
    }),
  );

  app.get("/api/v1/sessions", async (request) => ({
    data: await services.store.listSessions(request.principal.userId),
  }));
  app.post(
    "/api/v1/sessions",
    { bodyLimit: CODEX_IMAGE_BODY_LIMIT_BYTES },
    async (request, reply) => {
    const body = z
      .object({
        environmentId: z.string().min(1),
        prompt: z.string().trim().max(100_000).default(""),
        title: z.string().trim().max(200).optional(),
        modelId: z.string().max(200).optional(),
        images: codexInputImagesSchema,
      })
      .refine((value) => value.prompt.length > 0 || value.images.length > 0, {
        message: "A Session requires text or at least one image.",
      })
      .parse(request.body);
    const environment = await services.store.getEnvironment(
      request.principal.userId,
      body.environmentId,
    );
    if (environment.status !== "ready" || !environment.workspaceVolumeId) {
      throw new HttpError(
        409,
        "environment_not_ready",
        environment.provisioningError ?? "Environment is not ready.",
      );
    }
    const sessionId = await services.codex.createSession({
      userId: request.principal.userId,
      environment,
      title: body.title || body.prompt.slice(0, 56) || "Image task",
      prompt: body.prompt,
      images: body.images,
      modelId: body.modelId,
    });
    return reply.status(201).send({
      data: await services.store.getSession(request.principal.userId, sessionId),
    });
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId",
    async (request) => ({
      data: await services.store.getSession(
        request.principal.userId,
        request.params.sessionId,
      ),
    }),
  );
  app.put<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/metadata",
    async (request) => {
      const body = z
        .object({
          title: z.string().trim().min(1).max(200).optional(),
          pinned: z.boolean().optional(),
          archived: z.boolean().optional(),
          unread: z.boolean().optional(),
        })
        .refine((value) => Object.keys(value).length > 0)
        .parse(request.body);
      return {
        data: await services.store.setSessionMetadata(
          request.principal.userId,
          request.params.sessionId,
          body,
        ),
      };
    },
  );
  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/turns",
    { bodyLimit: CODEX_IMAGE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const body = z
        .object({
          text: z.string().trim().max(100_000).default(""),
          images: codexInputImagesSchema,
        })
        .refine((value) => value.text.length > 0 || value.images.length > 0, {
          message: "A Turn requires text or at least one image.",
        })
        .parse(request.body);
      const result = await services.codex.startTurn({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
        text: body.text,
        images: body.images,
      });
      return reply.status(202).send({ data: result });
    },
  );
  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/fork",
    async (request, reply) => {
      const body = z
        .object({ title: z.string().trim().min(1).max(200).optional() })
        .default({})
        .parse(request.body);
      const sessionId = await services.codex.forkSession({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
        title: body.title,
      });
      return reply.status(201).send({
        data: await services.store.getSession(
          request.principal.userId,
          sessionId,
        ),
      });
    },
  );
  app.post<{
    Params: { sessionId: string; userMessageItemId: string };
  }>(
    "/api/v1/sessions/:sessionId/turns/:userMessageItemId/fork",
    async (request, reply) => {
      const body = z
        .object({ title: z.string().trim().min(1).max(200).optional() })
        .default({})
        .parse(request.body);
      const sessionId = await services.codex.forkTurn({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
        userMessageItemId: request.params.userMessageItemId,
        title: body.title,
      });
      return reply.status(201).send({
        data: await services.store.getSession(
          request.principal.userId,
          sessionId,
        ),
      });
    },
  );
  app.put<{ Params: { sessionId: string; userMessageItemId: string } }>(
    "/api/v1/sessions/:sessionId/turns/:userMessageItemId",
    { bodyLimit: CODEX_IMAGE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const body = z
        .object({
          text: z.string().trim().max(100_000).default(""),
          images: codexInputImagesSchema,
        })
        .refine((value) => value.text.length > 0 || value.images.length > 0, {
          message: "An edited Turn requires text or at least one image.",
        })
        .parse(request.body);
      const result = await services.codex.editTurn({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
        userMessageItemId: request.params.userMessageItemId,
        text: body.text,
        images: body.images,
      });
      return reply.status(202).send({ data: result });
    },
  );
  app.delete<{ Params: { sessionId: string; userMessageItemId: string } }>(
    "/api/v1/sessions/:sessionId/turns/:userMessageItemId",
    async (request) => ({
      data: await services.codex.deleteTurn(
        request.principal.userId,
        request.params.sessionId,
        request.params.userMessageItemId,
      ),
    }),
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/models",
    async (request) => ({
      data: await services.codex.listModels(
        request.principal.userId,
        request.params.sessionId,
      ),
    }),
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/events",
    async (request, reply) => {
      await services.store.getSession(request.principal.userId, request.params.sessionId);
      services.codex.ensureWorker(request.params.sessionId);
      return streamHarnessEvents(request, reply, services.store, services.codex);
    },
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/files",
    async (request) => {
      const runtime = await services.store.getRuntime(
        request.principal.userId,
        request.params.sessionId,
      );
      return {
        data: await services.runtime.listFiles(
          runtime,
          queryString(request, "path") ?? "/workspace",
        ),
      };
    },
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/file",
    async (request) => {
      const filePath = queryString(request, "path");
      if (!filePath) throw new HttpError(400, "path_required", "File path is required.");
      const runtime = await services.store.getRuntime(
        request.principal.userId,
        request.params.sessionId,
      );
      const content = await services.runtime.readFile(runtime, filePath);
      return {
        data: {
          path: filePath,
          encoding: "base64",
          content: Buffer.from(content).toString("base64"),
          kind: isUtf8(content) ? "text" : "binary",
        },
      };
    },
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/audit",
    async (request) => {
      const runtime = await services.store.getRuntime(
        request.principal.userId,
        request.params.sessionId,
      );
      return { data: await services.runtime.getAudit(runtime) };
    },
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/metrics",
    async (request) => {
      const runtime = await services.store.getRuntime(
        request.principal.userId,
        request.params.sessionId,
      );
      return { data: await services.runtime.getMetrics(runtime) };
    },
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/terminal",
    { websocket: true },
    async (socket, request) => {
      try {
        const after = Number(queryString(request, "after") ?? 0);
        const runtime = await services.store.getRuntime(
          request.principal.userId,
          request.params.sessionId,
        );
        const terminal = await services.runtime.openTerminal(
          runtime,
          Number.isFinite(after) ? after : 0,
        );
        if (runtime.terminalSessionId !== terminal.sessionId) {
          await services.store.setTerminalSession(request.params.sessionId, terminal.sessionId);
        }
        socket.send(JSON.stringify({ type: "ready", sessionId: terminal.sessionId }));
        socket.on("message", (raw) => {
          void (async () => {
            try {
              await services.store.assertTerminalWritable(
                request.principal.userId,
                request.params.sessionId,
              );
              const message = terminalInputSchema.parse(JSON.parse(raw.toString()));
              terminal.send({ requestId: message.requestId ?? randomUUID(), ...message });
            } catch (error) {
              socket.send(
                JSON.stringify({ type: "error", error: normalizeError(error).message }),
              );
            }
          })();
        });
        socket.on("close", () => terminal.close());
        for await (const message of terminal.messages) {
          if (socket.readyState !== socket.OPEN) break;
          socket.send(JSON.stringify(message));
        }
      } catch (error) {
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({ type: "error", error: normalizeError(error).message }),
          );
          socket.close(1011, "Terminal connection failed");
        }
      }
    },
  );

  app.get("/api/v1/preferences", async (request) => ({
    data: await services.store.getPreferences(request.principal.userId),
  }));
  app.put("/api/v1/preferences", async (request) => ({
    data: await services.store.updatePreferences(
      request.principal.userId,
      preferencesSchema.parse(request.body),
    ),
  }));
  app.put<{
    Params: { teamId: string; membershipId: string };
  }>(
    "/api/v1/teams/:teamId/members/:membershipId/plan",
    async (request) => {
      const body = z.object({ planId: z.enum(["free", "pro", "max"]) }).parse(request.body);
      return {
        data: await services.store.updateMembershipPlan(
          request.principal.userId,
          request.params.teamId,
          request.params.membershipId,
          body.planId,
        ),
      };
    },
  );
}

async function streamHarnessEvents(
  request: FastifyRequest<{ Params: { sessionId: string } }>,
  reply: FastifyReply,
  store: SandpiStore,
  codex: CodexService,
) {
  const headerCursor = request.headers["last-event-id"];
  let cursor = Number(
    queryString(request, "after") ??
      (Array.isArray(headerCursor) ? headerCursor[0] : headerCursor) ??
      0,
  );
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
  let historyRevision = Number(queryString(request, "revision") ?? 0);
  if (!Number.isFinite(historyRevision) || historyRevision < 0) historyRevision = 0;
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write("retry: 1000\n\n");
  const controller = new AbortController();
  request.raw.once("close", () => controller.abort());

  while (!controller.signal.aborted && !reply.raw.destroyed) {
    const currentRevision = await store.sessionHistoryRevision(
      request.principal.userId,
      request.params.sessionId,
    );
    if (currentRevision !== historyRevision) {
      const session = await store.getSession(
        request.principal.userId,
        request.params.sessionId,
      );
      reply.raw.write("event: reset\n");
      reply.raw.write(`data: ${JSON.stringify(session)}\n\n`);
      historyRevision = currentRevision;
    }
    const events = await store.listHarnessNotifications(
      request.principal.userId,
      request.params.sessionId,
      cursor,
    );
    if (events.length > 0) {
      for (const event of events) {
        reply.raw.write(`id: ${event.sequence}\n`);
        reply.raw.write("event: harness\n");
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        cursor = event.sequence;
      }
      continue;
    }
    reply.raw.write(": keepalive\n\n");
    await codex.waitForSessionUpdate(request.params.sessionId, controller.signal);
  }
  if (!reply.raw.destroyed) reply.raw.end();
}

async function authenticateRequest(
  request: FastifyRequest,
  oidcIdentity?: OidcIdentityService,
): Promise<Principal> {
  if (!oidcIdentity) {
    return {
      userId: "user-admin",
      subject: "builtin:admin",
      email: "admin@sandpi.local",
      name: "Administrator",
      kind: "builtin-admin",
    };
  }
  const token = request.cookies[SESSION_COOKIE];
  const principal = token ? await oidcIdentity.authenticate(token) : undefined;
  if (!principal) throw new HttpError(401, "authentication_required", "Sign in required.");
  return principal;
}

function publicAuthPath(url: string) {
  const path = url.split("?", 1)[0];
  return path === "/api/v1/auth/login" || path === "/api/v1/auth/callback";
}

function deploymentSummary(
  config: SandpiConfig,
  runtime: RuntimeAdapter,
): SandpiDeploymentSummary {
  return {
    mode: "self-hosted",
    identity:
      config.auth.mode === "oidc"
        ? {
            protocol: "oidc",
            provider: "deployment-oidc",
            label: "Deployment SSO",
            managedBy: "deployment",
          }
        : {
            protocol: "builtin",
            provider: "builtin-admin",
            label: "Built-in administrator",
            managedBy: "deployment",
          },
    runtime: {
      provider: "sandbox0",
      status: runtime.mode === "sandbox0" ? "configured" : "unconfigured",
      configurationScope: "deployment",
    },
  };
}

function sessionCookie(config: SandpiConfig, expires: Date) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.publicUrl.protocol === "https:",
    expires,
  };
}

function safeLocalRedirect(value: string, config: SandpiConfig) {
  try {
    const url = new URL(value, config.publicUrl);
    if (url.origin === config.publicUrl.origin) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Fall back to the workspace root.
  }
  return "/";
}

function queryString(request: FastifyRequest, name: string) {
  const query = request.query;
  if (!query || typeof query !== "object" || !(name in query)) return undefined;
  const value = (query as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ZodError) {
    return new HttpError(400, "invalid_request", "Request validation failed.", error.issues);
  }
  return new HttpError(
    500,
    "internal_error",
    "Internal server error.",
  );
}

function rpcNetworkMode(value: string): NetworkPolicy["mode"] {
  return value as NetworkPolicy["mode"];
}

const networkPolicySchema = z.object({
  mode: z.enum(["restricted", "allow-all", "block-all"]).transform(rpcNetworkMode),
  allowedDomains: z.array(z.string().trim().min(1).max(253)).max(500),
  logDeniedRequests: z.boolean(),
});

const preferencesSchema: z.ZodType<SandpiPreferences> = z.object({
  general: z.object({
    language: z.enum(["en", "zh-CN"]),
    timeZone: z.string().min(1).max(100),
    sendShortcut: z.enum(["enter", "mod-enter"]),
  }),
  appearance: z.object({
    theme: z.enum(["system", "light", "dark"]),
    density: z.enum(["comfortable", "compact"]),
  }),
  notifications: z.object({
    sessionCompleted: z.boolean(),
    needsAttention: z.boolean(),
  }),
});

const terminalInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input"),
    data: z.string().max(1_000_000),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("resize"),
    rows: z.number().int().min(1).max(1_000),
    cols: z.number().int().min(1).max(1_000),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("signal"),
    signal: z.enum(["HUP", "INT", "QUIT", "TERM", "KILL", "WINCH"]),
    requestId: z.string().optional(),
  }),
]);

const codexInputImagesSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(255),
      mimeType: z.enum(["image/gif", "image/jpeg", "image/png", "image/webp"]),
      dataBase64: z.string().max(MAX_CODEX_INPUT_BASE64_LENGTH),
    }),
  )
  .max(MAX_CODEX_INPUT_IMAGES)
  .default([]);
