import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Buffer, isUtf8 } from "node:buffer";
import { Readable, Transform } from "node:stream";

import fastifyCompress from "@fastify/compress";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import fastifyRawBody from "fastify-raw-body";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { Pool } from "pg";
import WebSocket, { type RawData } from "ws";
import { ZodError, z } from "zod";

import type { SandpiDeploymentSummary } from "@/lib/types";
import { sandboxLoopbackUrl } from "@/lib/environment-browser";
import { BillingQuotaService } from "@/server/billing/quota-service";
import { BillingRepository } from "@/server/billing/repository";
import { StripeBillingService } from "@/server/billing/stripe-service";
import { SandboxUsageService } from "@/server/billing/usage-service";
import {
  DEFAULT_ENVIRONMENT_METRIC_RANGE_SECONDS,
  ENVIRONMENT_RESOURCE_METRIC_LOOKBACK_SECONDS,
  isEnvironmentMetricRangeSeconds,
} from "@/lib/environment-metrics";
import { dateFromUnixTimestamp, toUnixTimestamp } from "@/lib/time";
import { WORKSPACE_ROOT } from "@/lib/workspace-path-policy";
import { NativeAuthService } from "@/server/auth/native";
import { OidcIdentityService } from "@/server/auth/oidc";
import type { Principal } from "@/server/auth/principal";
import { loadConfig, type SandpiConfig } from "@/server/config";
import { migrateDatabase } from "@/server/db/migrate";
import { createDatabasePool } from "@/server/db/pool";
import { seedCommunityDefaults } from "@/server/db/seed";
import {
  createEnvironmentEgressCredentialSchema,
  environmentEgressCredentialConfigurationSchema,
  rotateEnvironmentEgressCredentialSchema,
} from "@/server/environment-credentials-schema";
import { EnvironmentEgressCredentialService } from "@/server/environments/egress-credential-service";
import { EnvironmentService } from "@/server/environments/service";
import { EnvironmentLifecycleService } from "@/server/environments/lifecycle-service";
import { EnvironmentRuntimeAccessService } from "@/server/environments/runtime-access-service";
import {
  EnvironmentBrowserService,
  dashboardAssetCacheControl,
  dashboardProxyPrefix,
  dashboardRedirectLocation,
  rewriteDashboardCss,
  rewriteDashboardHtml,
} from "@/server/environments/browser-service";
import {
  BrowserWebSocketDownstreamRelay,
  websocketRawDataSize,
} from "@/server/environments/browser-websocket-relay";
import {
  EnvironmentScheduleService,
  type EnvironmentScheduleConfiguration,
} from "@/server/environments/schedule-service";
import { EnvironmentScheduleStore } from "@/server/environments/schedule-store";
import {
  EnvironmentWebhookService,
  type EnvironmentWebhookConfiguration,
} from "@/server/environments/webhook-service";
import { EnvironmentWebhookStore } from "@/server/environments/webhook-store";
import { EnvironmentWorkspaceBackupService } from "@/server/environments/workspace-backup-service";
import { CodexEnvironmentAuthService } from "@/server/harnesses/codex/auth-service";
import { CodexAuthStore } from "@/server/harnesses/codex/auth-store";
import {
  CODEX_NATIVE_STREAM_AUTH_RETRY_MS,
  codexNativeStreamFailure,
} from "@/server/harnesses/codex/native-stream";
import { CodexService } from "@/server/harnesses/codex/service";
import {
  MAX_CODEX_COMPOSER_UPLOAD_BASE64_LENGTH,
  codexComposerUpload,
  codexComposerUploadPath,
  decodeCodexComposerUpload,
} from "@/server/harnesses/codex/input-files";
import type { CodexRolloutActivityFeed } from "@/harnesses/codex/rollout-activity";
import { HttpError } from "@/server/http-error";
import {
  shouldApplyApiNoStore,
  staticWebCacheControl,
} from "@/server/cache-policy";
import {
  cloudSnapshotEtag,
  requestEtagMatches,
} from "@/server/cloud-sync";
import { createRuntime } from "@/server/runtime";
import type { RuntimeAdapter } from "@/server/runtime/types";
import { RuntimeWebSocketHeartbeat } from "@/server/runtime-websocket-heartbeat";
import {
  allowedOrigins,
  validateApiRequestOrigin,
} from "@/server/request-origin";
import { SecretBox } from "@/server/secrets";
import { SandpiStore } from "@/server/store";
import { TerminalInputQueue } from "@/server/terminal-input-queue";
import {
  billingCheckoutSchema,
  browserOpenSchema,
  browserSessionSchema,
  codexComposerUploadSchema,
  codexHookUpdateSchema,
  codexMcpServerEnabledSchema,
  codexMemoriesSettingsSchema,
  codexPersonalitySelectionSchema,
  codexRateLimitResetSchema,
  codexSkillConfigurationSchema,
  environmentBrowserViewportSchema,
  environmentCreateSchema,
  environmentOrderSchema,
  environmentProvisioningSchema,
  environmentScheduleSchema,
  environmentWebhookSchema,
  environmentUpdateSchema,
  preferencesSchema,
  rotateEnvironmentWebhookSecretSchema,
  sessionCreateSchema,
  sessionForkSchema,
  sessionGoalUpdateSchema,
  sessionMetadataSchema,
  sessionReviewSchema,
  terminalInputSchema,
  turnCreateSchema,
  turnInterruptSchema,
  turnSteerSchema,
  workspaceBackupRestoreSchema,
  workspaceFileSearchQuerySchema,
  workspaceIdeCreateEntrySchema,
  workspaceIdeRenameEntrySchema,
  workspaceIdeWatchSubscriptionSchema,
  workspaceIdeWriteSchema,
} from "@/server/api-schemas";

export const SESSION_COOKIE = "sandpi_session";
const BUILTIN_SIGNED_OUT_COOKIE = "sandpi_builtin_signed_out";
export const AUTH_COOKIE_PATH = "/api/v1";
export const AUTH_COOKIE_CLEAR_PATHS = [AUTH_COOKIE_PATH, "/"] as const;
const CODEX_IMAGE_BODY_LIMIT_BYTES = 36 * 1024 * 1024;
const CODEX_UPLOAD_BODY_LIMIT_BYTES =
  MAX_CODEX_COMPOSER_UPLOAD_BASE64_LENGTH + 64 * 1024;
const WORKSPACE_FILE_BODY_LIMIT_BYTES = 7 * 1024 * 1024;
export interface SandpiServerOptions {
  config?: SandpiConfig;
  pool?: Pool;
  advisoryLockPool?: Pool;
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
  const runtime = options.runtime ?? createRuntime(config);
  validateBillingRuntime(config.billing, runtime);
  const ownsPool = !options.pool;
  const pool =
    options.pool ??
    createDatabasePool({ connectionString: config.databaseUrl });
  const ownsAdvisoryLockPool = !options.pool && !options.advisoryLockPool;
  const advisoryLockPool =
    options.advisoryLockPool ??
    (options.pool
      ? pool
      : createDatabasePool({
          connectionString: config.databaseUrl,
          application_name: "sandpi-advisory-locks",
        }));
  await migrateDatabase(pool);
  if (config.auth.mode === "admin") {
    await seedCommunityDefaults(pool);
  }

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    requestIdHeader: "x-request-id",
    genReqId: (request) =>
      request.headers["x-request-id"]?.toString() || randomUUID(),
  });
  const store = new SandpiStore(pool, advisoryLockPool);
  const billingRepository = new BillingRepository(pool);
  const billingQuota = new BillingQuotaService(
    billingRepository,
    config.billing,
    runtime,
  );
  const stripeBilling = new StripeBillingService(
    billingRepository,
    config.billing,
    config.publicUrl,
    app.log,
  );
  const sandboxUsage =
    config.billing.mode === "stripe"
      ? new SandboxUsageService(
          billingRepository,
          billingQuota,
          runtime,
          app.log,
          config.billing.usagePollIntervalMs,
        )
      : undefined;
  const secretBox = config.secretKey
    ? new SecretBox(config.secretKey)
    : undefined;
  const codexAuth = new CodexEnvironmentAuthService(
    store,
    new CodexAuthStore(pool),
    runtime,
    secretBox,
    app.log,
  );
  const lifecycle = new EnvironmentLifecycleService(store, runtime, app.log, {
    quotaGate: billingQuota,
  });
  const workspaceBackups = new EnvironmentWorkspaceBackupService(
    store,
    runtime,
    app.log,
  );
  const runtimeAccess = new EnvironmentRuntimeAccessService(store, runtime, {
    quotaGate: billingQuota,
  });
  const browser = new EnvironmentBrowserService(runtimeAccess, runtime);
  const codex = new CodexService(store, runtime, app.log, codexAuth, {
    runtimeQuotaGate: billingQuota,
  });
  const schedules = new EnvironmentScheduleService(
    new EnvironmentScheduleStore(pool),
    store,
    codex,
    app.log,
  );
  const webhooks = new EnvironmentWebhookService(
    new EnvironmentWebhookStore(pool),
    store,
    codex,
    secretBox,
    config.publicUrl,
    app.log,
  );
  const environments = new EnvironmentService(
    store,
    runtime,
    app.log,
    billingQuota,
    billingQuota,
  );
  const egressCredentials = new EnvironmentEgressCredentialService(
    store,
    runtime,
    app.log,
  );
  lifecycle.setBeforePause(async (environmentId) => {
    await codex.flushEnvironmentCredentials(environmentId);
    codex.suspendEnvironmentWorker(environmentId);
    browser.invalidate(environmentId);
  });
  sandboxUsage?.setPauseForQuota((environmentId) =>
    lifecycle.pauseForQuota(environmentId),
  );
  sandboxUsage?.setReconcilePlanMemory(async (environmentId) => {
    await environments.reconcilePlanMemory(environmentId);
  });
  workspaceBackups.setRestoreHooks({
    before: async (environmentId) => {
      await codex.flushEnvironmentCredentials(environmentId);
      codex.suspendEnvironmentWorker(environmentId);
    },
    afterAttempt: (environmentId, result) =>
      codex.finishEnvironmentWorkspaceRestoreAttempt(environmentId, result),
  });
  environments.setBeforeDelete(async (userId, environmentId) => {
    await codex.flushEnvironmentCredentials(environmentId);
    codex.suspendEnvironmentWorker(environmentId);
    await codexAuth.cancelEnvironmentDeviceLogin(userId, environmentId);
  });
  environments.setAfterRuntimeDelete(
    async (_userId, environmentId, scopedStore) => {
      await egressCredentials.cleanupEnvironmentSources(
        environmentId,
        scopedStore,
      );
    },
  );
  const oidcIdentity =
    config.auth.mode === "oidc" && secretBox
      ? new OidcIdentityService(pool, config.auth, config.publicUrl, secretBox)
      : undefined;
  const nativeAuth = new NativeAuthService(
    pool,
    config.publicUrl,
    Boolean(oidcIdentity),
  );

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
  await app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
  });
  app.removeContentTypeParser("text/plain");
  app.addContentTypeParser(
    ["application/x-www-form-urlencoded", "text/plain"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  await app.register(fastifyCompress, {
    global: true,
    threshold: 1_024,
    encodings: ["br", "gzip"],
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
  registerAuthRoutes(app, config, environments, nativeAuth, oidcIdentity);
  registerApiRoutes(app, {
    config,
    store,
    runtime,
    runtimeAccess,
    browser,
    codex,
    codexAuth,
    environments,
    lifecycle,
    billingQuota,
    stripeBilling,
    egressCredentials,
    workspaceBackups,
    schedules,
    webhooks,
  });

  if (existsSync(config.webDir)) {
    app.get("/preferences", async (request, reply) => {
      const { search } = new URL(request.url, config.publicUrl);
      return reply.redirect(`/preferences/${search}`, 308);
    });
    app.get("/ide", async (request, reply) => {
      const { search } = new URL(request.url, config.publicUrl);
      return reply.redirect(`/ide/${search}`, 308);
    });
    await app.register(fastifyStatic, {
      root: config.webDir,
      prefix: "/",
      wildcard: false,
      index: ["index.html"],
      cacheControl: false,
      setHeaders: (reply, filePath) => {
        reply.header("Cache-Control", staticWebCacheControl(filePath));
      },
    });
  } else {
    app.log.warn({ webDir: config.webDir }, "Static Web build was not found");
  }

  app.addHook("onClose", async () => {
    await sandboxUsage?.close();
    await schedules.close();
    await webhooks.close();
    await workspaceBackups.close();
    await lifecycle.close();
    await codexAuth.close();
    await codex.close();
    if (ownsAdvisoryLockPool) await advisoryLockPool.end();
    if (ownsPool) await pool.end();
  });

  await environments.reconcilePending();
  await egressCredentials.reconcilePending();
  await lifecycle.start();
  sandboxUsage?.start();
  await workspaceBackups.start();
  await codexAuth.resumePending();
  // Runtime recovery is Environment-scoped and may wait for Sandbox0
  // scheduling. Keep API readiness independent so one slow/failed Sandbox
  // cannot hold the entire Sandpi server offline during startup.
  void codex.resumeWorkers().catch((error) => {
    app.log.warn({ err: error }, "Codex Environment recovery deferred");
  });
  await schedules.start();
  await webhooks.start();

  return {
    app,
    config,
    store,
    close: () => app.close(),
  };
}

export function registerHealthRoutes(
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

export function registerAuthRoutes(
  app: FastifyInstance,
  config: SandpiConfig,
  environments: EnvironmentService,
  nativeAuth: NativeAuthService,
  oidcIdentity?: OidcIdentityService,
) {
  app.get("/api/v1/auth/login", async (request, reply) => {
    const returnTo = queryString(request, "return_to") ?? "/";
    if (!oidcIdentity) {
      clearAuthCookie(reply, BUILTIN_SIGNED_OUT_COOKIE);
      return reply.redirect(safeLocalRedirect(returnTo, config));
    }
    const login = await oidcIdentity.startLogin(returnTo);
    return reply.redirect(login.authorizationUrl.toString());
  });

  app.get("/api/v1/auth/callback", async (request, reply) => {
    if (!oidcIdentity) {
      throw new HttpError(
        404,
        "oidc_not_configured",
        "OIDC is not configured.",
      );
    }
    const result = await oidcIdentity.completeLogin(
      new URL(request.url, config.publicUrl),
    );
    // A first-time OIDC user receives a default Environment in the identity
    // transaction. Provision it before the first Web bootstrap so every client
    // observes the same ready/error state without a server restart.
    // EnvironmentService coalesces concurrent reconciliations.
    await environments.reconcilePending();
    reply.setCookie(
      SESSION_COOKIE,
      result.token,
      sessionCookie(config, result.expiresAt),
    );
    clearAuthCookie(reply, BUILTIN_SIGNED_OUT_COOKIE);
    return reply.redirect(result.returnTo);
  });

  app.post("/api/v1/auth/native/prepare", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    validateNativeAuthOrigin(request, config);
    const body = z
      .object({
        returnTo: z.string(),
        verifier: z.string(),
        state: z.string(),
      })
      .parse(request.body);
    const attempt = await nativeAuth.startAttempt(
      body.returnTo,
      body.verifier,
      body.state,
    );
    const authorizationUrl = new URL(
      "/api/v1/auth/native/login",
      config.publicUrl,
    );
    authorizationUrl.searchParams.set("attempt_id", attempt.id);
    return {
      data: {
        authorizationUrl: authorizationUrl.toString(),
        expiresAt: attempt.expiresAt.toISOString(),
      },
    };
  });

  app.get("/api/v1/auth/native/login", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const attemptId = queryString(request, "attempt_id") ?? "";
    await nativeAuth.assertAttemptStartable(attemptId);
    if (!oidcIdentity) {
      const callback = await nativeAuth.authorizeAttempt(
        attemptId,
        "user-admin",
      );
      return reply.redirect(callback.toString());
    }

    const finalize = new URL(
      "/api/v1/auth/native/finalize",
      config.publicUrl,
    );
    finalize.searchParams.set("attempt_id", attemptId);
    const login = await oidcIdentity.startLogin(finalize.toString());
    return reply.redirect(login.authorizationUrl.toString());
  });

  app.get("/api/v1/auth/native/finalize", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const attemptId = queryString(request, "attempt_id") ?? "";
    const callback = await nativeAuth.authorizeAttempt(
      attemptId,
      request.principal.userId,
    );
    return reply.redirect(callback.toString());
  });

  app.post("/api/v1/auth/native/complete", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    validateNativeAuthOrigin(request, config);
    const body = z
      .object({
        attemptId: z.string(),
        code: z.string(),
        verifier: z.string(),
      })
      .parse(request.body);
    const result = await nativeAuth.completeAttempt(
      body.attemptId,
      body.code,
      body.verifier,
    );
    if (result.session) {
      reply.setCookie(
        SESSION_COOKIE,
        result.session.token,
        sessionCookie(config, result.session.expiresAt),
      );
      clearAuthCookie(reply, BUILTIN_SIGNED_OUT_COOKIE);
    } else {
      clearAuthCookie(reply, BUILTIN_SIGNED_OUT_COOKIE);
    }
    return { data: { returnTo: result.returnTo } };
  });

  app.get("/api/v1/auth/me", async (request) => ({ data: request.principal }));
  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token && oidcIdentity) await oidcIdentity.logout(token);
    clearAuthCookie(reply, SESSION_COOKIE);
    if (!oidcIdentity) {
      reply.setCookie(
        BUILTIN_SIGNED_OUT_COOKIE,
        "1",
        builtinSignedOutCookie(config),
      );
    }
    return reply.status(204).send();
  });
}

export function registerApiRoutes(
  app: FastifyInstance,
  services: {
    config: SandpiConfig;
    store: SandpiStore;
    runtime: RuntimeAdapter;
    runtimeAccess: EnvironmentRuntimeAccessService;
    browser: EnvironmentBrowserService;
    codex: CodexService;
    codexAuth: CodexEnvironmentAuthService;
    environments: EnvironmentService;
    lifecycle: EnvironmentLifecycleService;
    billingQuota: BillingQuotaService;
    stripeBilling: StripeBillingService;
    egressCredentials: EnvironmentEgressCredentialService;
    workspaceBackups: EnvironmentWorkspaceBackupService;
    schedules: EnvironmentScheduleService;
    webhooks: EnvironmentWebhookService;
  },
) {
  const deployment = deploymentSummary(services.config, services.runtime);
  const quotaSafeWorkspaceRead = async <T>(
    userId: string,
    environmentId: string,
    liveRead: (
      runtime: Parameters<RuntimeAdapter["listFiles"]>[0],
    ) => Promise<T>,
    persistentRead: (
      runtime: Parameters<RuntimeAdapter["listFiles"]>[0],
    ) => Promise<T>,
  ) => {
    try {
      return {
        data: await services.runtimeAccess.withRuntimeAccess(
          userId,
          environmentId,
          liveRead,
        ),
        meta: { runtimeAccess: "sandbox" as const },
      };
    } catch (error) {
      if (!isRuntimePlanBlock(error)) throw error;
      return {
        data: await services.runtimeAccess.withPersistentWorkspaceAccess(
          userId,
          environmentId,
          persistentRead,
        ),
        meta: {
          runtimeAccess: "persistent-storage" as const,
          runtimeBlock: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        },
      };
    }
  };
  app.addHook("onSend", async (request, reply, payload) => {
    if (
      shouldApplyApiNoStore(
        request.url,
        reply.hasHeader("Cache-Control"),
      )
    ) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  app.get("/api/v1/bootstrap", async (request) => ({
    data: await services.environments.getBootstrap(
      request.principal.userId,
      deployment,
      queryString(request, "environment"),
      queryString(request, "session"),
      queryString(request, "new") === "1",
    ),
    meta: { runtime: services.runtime.mode },
  }));

  app.get("/api/v1/sync", async (request, reply) => {
    const data = await services.store.getCloudSnapshot(
      request.principal.userId,
    );
    const etag = cloudSnapshotEtag(data);
    reply.header("Cache-Control", "private, no-cache");
    reply.header("ETag", etag);
    if (requestEtagMatches(request.headers["if-none-match"], etag)) {
      return reply.status(304).send();
    }
    return reply.send({ data });
  });

  app.get("/api/v1/billing/summary", async (request) => ({
    data: await services.billingQuota.summary(request.principal.userId),
  }));
  app.post("/api/v1/billing/checkout", async (request) => {
    const body = billingCheckoutSchema.parse(request.body);
    return {
      data: await services.stripeBilling.checkout(
        request.principal.userId,
        body.planId,
        body.idempotencyKey,
      ),
    };
  });
  app.post("/api/v1/billing/portal", async (request) => ({
    data: await services.stripeBilling.customerPortal(
      request.principal.userId,
    ),
  }));
  app.post(
    "/api/v1/billing/webhook",
    {
      bodyLimit: 1024 * 1024,
      config: { rawBody: true },
    },
    async (request, reply) => {
      const signature = request.headers["stripe-signature"];
      if (typeof signature !== "string" || !Buffer.isBuffer(request.rawBody)) {
        throw new HttpError(
          400,
          "stripe_webhook_invalid",
          "A signed Stripe webhook body is required.",
        );
      }
      let event;
      try {
        event = services.stripeBilling.constructWebhookEvent(
          request.rawBody,
          signature,
        );
      } catch {
        throw new HttpError(
          400,
          "stripe_webhook_invalid",
          "The Stripe webhook signature is invalid.",
        );
      }
      await services.stripeBilling.processWebhook(event);
      return reply.status(204).send();
    },
  );

  app.get("/api/v1/environments", async (request) => ({
    data: await services.environments.list(request.principal.userId),
  }));
  app.post("/api/v1/environments", async (request, reply) => {
    const body = environmentCreateSchema.parse(request.body);
    const environment = await services.environments.create({
      userId: request.principal.userId,
      ...body,
    });
    return reply.status(201).send({ data: environment });
  });
  app.put("/api/v1/environments/order", async (request) => {
    const body = environmentOrderSchema.parse(request.body);
    return {
      data: await services.environments.reorder(
        request.principal.userId,
        body.environmentIds,
      ),
    };
  });
  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId",
    async (request) => {
      const body = environmentUpdateSchema.parse(request.body);
      return {
        data: await services.environments.update(
          request.principal.userId,
          request.params.environmentId,
          body,
        ),
      };
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/egress-credentials",
    async (request) => ({
      data: await services.egressCredentials.list(
        request.principal.userId,
        request.params.environmentId,
      ),
    }),
  );
  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/sandbox/pause",
    async (request) => {
      await services.lifecycle.pauseManually(
        request.principal.userId,
        request.params.environmentId,
      );
      return {
        data: await services.environments.get(
          request.principal.userId,
          request.params.environmentId,
        ),
      };
    },
  );
  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/sandbox/restart",
    async (request) => {
      await services.lifecycle.restartManually(
        request.principal.userId,
        request.params.environmentId,
      );
      return {
        data: await services.environments.get(
          request.principal.userId,
          request.params.environmentId,
        ),
      };
    },
  );
  app.post<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/egress-credentials",
    async (request, reply) => {
      const credential = await services.egressCredentials.create(
        request.principal.userId,
        request.params.environmentId,
        createEnvironmentEgressCredentialSchema.parse(request.body),
      );
      return reply.status(201).send({ data: credential });
    },
  );
  app.put<{ Params: { environmentId: string; credentialId: string } }>(
    "/api/v1/environments/:environmentId/egress-credentials/:credentialId",
    async (request) => ({
      data: await services.egressCredentials.update(
        request.principal.userId,
        request.params.environmentId,
        request.params.credentialId,
        environmentEgressCredentialConfigurationSchema.parse(request.body),
      ),
    }),
  );
  app.put<{ Params: { environmentId: string; credentialId: string } }>(
    "/api/v1/environments/:environmentId/egress-credentials/:credentialId/material",
    async (request) => ({
      data: await services.egressCredentials.rotate(
        request.principal.userId,
        request.params.environmentId,
        request.params.credentialId,
        rotateEnvironmentEgressCredentialSchema.parse(request.body),
      ),
    }),
  );
  app.delete<{ Params: { environmentId: string; credentialId: string } }>(
    "/api/v1/environments/:environmentId/egress-credentials/:credentialId",
    async (request) => {
      await services.egressCredentials.delete(
        request.principal.userId,
        request.params.environmentId,
        request.params.credentialId,
      );
      return { data: { id: request.params.credentialId } };
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/workspace-backups",
    async (request) => ({
      data: await services.workspaceBackups.list(
        request.principal.userId,
        request.params.environmentId,
      ),
    }),
  );
  app.post<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/workspace-backups",
    async (request, reply) =>
      reply.status(201).send({
        data: await services.workspaceBackups.createNow(
          request.principal.userId,
          request.params.environmentId,
        ),
      }),
  );
  app.put<{
    Params: { environmentId: string; snapshotId: string };
  }>(
    "/api/v1/environments/:environmentId/workspace-backups/:snapshotId/restore",
    async (request) => {
      const body = workspaceBackupRestoreSchema.parse(request.body);
      const restored = await services.workspaceBackups.restore(
        request.principal.userId,
        request.params.environmentId,
        request.params.snapshotId,
        body.confirmation,
      );
      return {
        data: {
          ...restored,
          environment: await services.environments.authoritativeEnvironment(
            restored.environment,
          ),
        },
      };
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/schedules",
    async (request) => ({
      data: await services.schedules.list(
        request.principal.userId,
        request.params.environmentId,
      ),
    }),
  );
  app.post<{
    Params: { endpointId: string };
    Querystring: { token?: string };
  }>(
    "/api/v1/webhooks/:endpointId",
    { config: { rawBody: true }, bodyLimit: 1_048_576 },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.rawBody)) {
        throw new HttpError(
          400,
          "environment_webhook_body_invalid",
          "The Webhook request body could not be read.",
        );
      }
      const result = await services.webhooks.receive({
        endpointId: request.params.endpointId,
        rawBody: request.rawBody,
        headers: request.headers,
        contentType: request.headers["content-type"],
        queryToken:
          typeof request.query.token === "string"
            ? request.query.token
            : undefined,
      });
      return reply.status(result.statusCode).send(result.body);
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/webhooks",
    async (request) => ({
      data: await services.webhooks.list(
        request.principal.userId,
        request.params.environmentId,
      ),
    }),
  );
  app.post<{ Params: { environmentId: string }; Body: unknown }>(
    "/api/v1/environments/:environmentId/webhooks",
    async (request, reply) => {
      const body = environmentWebhookSchema.parse(request.body);
      return reply.status(201).send({
        data: await services.webhooks.create(
          request.principal.userId,
          request.params.environmentId,
          environmentWebhookConfiguration(body),
        ),
      });
    },
  );
  app.put<{
    Params: { environmentId: string; webhookId: string };
    Body: unknown;
  }>(
    "/api/v1/environments/:environmentId/webhooks/:webhookId",
    async (request) => {
      const body = environmentWebhookSchema.parse(request.body);
      return {
        data: await services.webhooks.update(
          request.principal.userId,
          request.params.environmentId,
          request.params.webhookId,
          environmentWebhookConfiguration(body),
        ),
      };
    },
  );
  app.put<{
    Params: { environmentId: string; webhookId: string };
    Body: unknown;
  }>(
    "/api/v1/environments/:environmentId/webhooks/:webhookId/secret",
    async (request) => {
      const body = rotateEnvironmentWebhookSecretSchema.parse(request.body);
      return {
        data: await services.webhooks.rotateSecret(
          request.principal.userId,
          request.params.environmentId,
          request.params.webhookId,
          body.secret,
        ),
      };
    },
  );
  app.delete<{
    Params: { environmentId: string; webhookId: string };
  }>(
    "/api/v1/environments/:environmentId/webhooks/:webhookId",
    async (request) => {
      await services.webhooks.delete(
        request.principal.userId,
        request.params.environmentId,
        request.params.webhookId,
      );
      return { data: { id: request.params.webhookId } };
    },
  );
  app.get<{
    Params: { environmentId: string; webhookId: string };
  }>(
    "/api/v1/environments/:environmentId/webhooks/:webhookId/runs",
    async (request) => ({
      data: await services.webhooks.listRuns(
        request.principal.userId,
        request.params.environmentId,
        request.params.webhookId,
        boundedIntegerQuery(request, "limit", 50, 1, 100),
      ),
    }),
  );
  app.get<{
    Params: { environmentId: string; webhookId: string };
  }>(
    "/api/v1/environments/:environmentId/webhooks/:webhookId/deliveries",
    async (request) => ({
      data: await services.webhooks.listDeliveries(
        request.principal.userId,
        request.params.environmentId,
        request.params.webhookId,
        boundedIntegerQuery(request, "limit", 50, 1, 100),
      ),
    }),
  );
  app.post<{ Params: { environmentId: string }; Body: unknown }>(
    "/api/v1/environments/:environmentId/schedules",
    async (request, reply) => {
      const body = environmentScheduleSchema.parse(request.body);
      return reply.status(201).send({
        data: await services.schedules.create(
          request.principal.userId,
          request.params.environmentId,
          environmentScheduleConfiguration(body),
        ),
      });
    },
  );
  app.put<{
    Params: { environmentId: string; scheduleId: string };
    Body: unknown;
  }>(
    "/api/v1/environments/:environmentId/schedules/:scheduleId",
    async (request) => {
      const body = environmentScheduleSchema.parse(request.body);
      return {
        data: await services.schedules.update(
          request.principal.userId,
          request.params.environmentId,
          request.params.scheduleId,
          environmentScheduleConfiguration(body),
        ),
      };
    },
  );
  app.delete<{
    Params: { environmentId: string; scheduleId: string };
  }>(
    "/api/v1/environments/:environmentId/schedules/:scheduleId",
    async (request) => {
      await services.schedules.delete(
        request.principal.userId,
        request.params.environmentId,
        request.params.scheduleId,
      );
      return { data: { id: request.params.scheduleId } };
    },
  );
  app.get<{
    Params: { environmentId: string; scheduleId: string };
  }>(
    "/api/v1/environments/:environmentId/schedules/:scheduleId/runs",
    async (request) => ({
      data: await services.schedules.listRuns(
        request.principal.userId,
        request.params.environmentId,
        request.params.scheduleId,
        boundedIntegerQuery(request, "limit", 50, 1, 100),
      ),
    }),
  );
  app.delete<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId",
    async (request) => {
      await services.environments.delete(
        request.principal.userId,
        request.params.environmentId,
      );
      return { data: { id: request.params.environmentId } };
    },
  );
  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/provisioning",
    async (request, reply) => {
      const body = environmentProvisioningSchema.parse(request.body);
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
    "/api/v1/environments/:environmentId/harnesses/codex/account",
    async (request) => ({
      data: await services.codexAuth.accountForEnvironment(
        request.principal.userId,
        request.params.environmentId,
      ),
    }),
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/rate-limits",
    async (request) => ({
      data: await services.codex.accountRateLimitsForEnvironment(
        request.principal.userId,
        request.params.environmentId,
      ),
    }),
  );
  app.put<{ Params: { environmentId: string }; Body: unknown }>(
    "/api/v1/environments/:environmentId/harnesses/codex/rate-limits/reset",
    async (request) => {
      const body = codexRateLimitResetSchema.parse(request.body);
      return {
        data: await services.codex.consumeAccountRateLimitResetCredit({
          userId: request.principal.userId,
          environmentId: request.params.environmentId,
          idempotencyKey: body.idempotencyKey,
        }),
      };
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/models",
    async (request) => ({
      data: await services.codex.listEnvironmentModels(
        request.principal.userId,
        request.params.environmentId,
      ),
      meta: { availability: "available", source: "codex" },
    }),
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/personality",
    async (request) => ({
      data: await services.codex.readEnvironmentPersonality(
        request.principal.userId,
        request.params.environmentId,
      ),
    }),
  );
  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/personality",
    async (request) => {
      const body = codexPersonalitySelectionSchema.parse(request.body);
      return {
        data: await services.codex.setEnvironmentPersonality({
          userId: request.principal.userId,
          environmentId: request.params.environmentId,
          personality: body.personality,
        }),
      };
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/token-usage",
    async (request) => ({
      data: await services.codex.accountTokenUsageForEnvironment(
        request.principal.userId,
        request.params.environmentId,
      ),
    }),
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/memories",
    async (request) => ({
      data: await services.codex.readEnvironmentMemories(
        request.principal.userId,
        request.params.environmentId,
      ),
    }),
  );
  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/memories",
    async (request) => {
      const settings = codexMemoriesSettingsSchema.parse(request.body);
      return {
        data: await services.codex.setEnvironmentMemories({
          userId: request.principal.userId,
          environmentId: request.params.environmentId,
          settings,
        }),
      };
    },
  );
  app.delete<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/memories",
    async (request) => ({
      data: await services.codex.resetEnvironmentMemories(
        request.principal.userId,
        request.params.environmentId,
      ),
    }),
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/hooks",
    async (request) => ({
      data: await services.codex.listEnvironmentHooks(
        request.principal.userId,
        request.params.environmentId,
      ),
    }),
  );
  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/hooks",
    async (request) => {
      const body = codexHookUpdateSchema.parse(request.body);
      return {
        data: await services.codex.updateEnvironmentHook({
          userId: request.principal.userId,
          environmentId: request.params.environmentId,
          ...body,
        }),
      };
    },
  );
  app.post<{ Params: { environmentId: string }; Body: unknown }>(
    "/api/v1/environments/:environmentId/harnesses/codex/uploads",
    { bodyLimit: CODEX_UPLOAD_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const body = codexComposerUploadSchema.parse(request.body);
      const content = decodeCodexComposerUpload(body.dataBase64);
      const uploadId = randomUUID();
      const filePath = codexComposerUploadPath(uploadId, body.name);
      const upload = codexComposerUpload({
        id: `upload:${uploadId}`,
        name: body.name,
        path: filePath,
        mimeType: body.mimeType,
        content,
      });
      await services.runtimeAccess.withRuntimeAccess(
        request.principal.userId,
        request.params.environmentId,
        (runtime) =>
          services.runtime.writeCodexComposerUpload(runtime, filePath, content),
      );
      return reply.status(201).send({
        data: upload,
      });
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/skills",
    async (request) => ({
      data: await services.codex.listEnvironmentSkills(
        request.principal.userId,
        request.params.environmentId,
        queryString(request, "force") === "1",
      ),
    }),
  );
  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/skills/config",
    async (request) => {
      const body = codexSkillConfigurationSchema.parse(request.body);
      return {
        data: await services.codex.setEnvironmentSkillEnabled({
          userId: request.principal.userId,
          environmentId: request.params.environmentId,
          ...body,
        }),
      };
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/mcp-servers",
    async (request) => ({
      data: await services.codex.listEnvironmentMcpServers(
        request.principal.userId,
        request.params.environmentId,
        queryString(request, "detail") === "full"
          ? "full"
          : "toolsAndAuthOnly",
      ),
    }),
  );
  app.put<{ Params: { environmentId: string; name: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/mcp-servers/:name/enabled",
    async (request) => {
      const body = codexMcpServerEnabledSchema.parse(request.body);
      return {
        data: await services.codex.setEnvironmentMcpServerEnabled({
          userId: request.principal.userId,
          environmentId: request.params.environmentId,
          name: request.params.name,
          enabled: body.enabled,
        }),
      };
    },
  );
  app.post<{ Params: { environmentId: string; name: string } }>(
    "/api/v1/environments/:environmentId/harnesses/codex/mcp-servers/:name/oauth/login",
    async (request, reply) =>
      reply.status(202).send({
        data: await services.codex.startEnvironmentMcpServerOAuthLogin({
          userId: request.principal.userId,
          environmentId: request.params.environmentId,
          name: request.params.name,
        }),
      }),
  );

  app.get("/api/v1/sessions", async (request) => ({
    data: await services.store.listSessions(request.principal.userId),
  }));
  app.post(
    "/api/v1/sessions",
    { bodyLimit: CODEX_IMAGE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const body = sessionCreateSchema.parse(request.body);
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
        idempotencyKey: body.idempotencyKey,
        title: body.title || body.prompt.slice(0, 56) || "File task",
        prompt: body.prompt,
        images: body.images,
        localImages: body.localImages,
        modelId: body.modelId,
        reasoningEffort: body.reasoningEffort,
        collaborationMode: body.collaborationMode,
        serviceTier: body.serviceTier,
        sessionStartSource: body.sessionStartSource,
      });
      return reply.status(201).send({
        data: await services.store.getSession(
          request.principal.userId,
          sessionId,
        ),
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
      const body = sessionMetadataSchema.parse(request.body);
      const data = await services.store.setSessionMetadata(
        request.principal.userId,
        request.params.sessionId,
        body,
      );
      if (body.archived === false) {
        await services.codex.scheduleSessionControlStateRepair(
          request.params.sessionId,
        );
      }
      return { data };
    },
  );
  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/turns",
    { bodyLimit: CODEX_IMAGE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const body = turnCreateSchema.parse(request.body);
      const result = await services.codex.startTurn({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
        text: body.text,
        images: body.images,
        modelId: body.modelId,
        reasoningEffort: body.reasoningEffort,
        clientMessageId: body.clientMessageId,
        collaborationMode: body.collaborationMode,
        serviceTier: body.serviceTier,
        localImages: body.localImages,
      });
      return reply.status(202).send({ data: result });
    },
  );
  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/turns/steer",
    { bodyLimit: CODEX_IMAGE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const body = turnSteerSchema.parse(request.body);
      const result = await services.codex.steerTurn({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
        expectedTurnId: body.expectedTurnId,
        text: body.text,
        images: body.images,
        clientMessageId: body.clientMessageId,
        localImages: body.localImages,
      });
      return reply.status(202).send({ data: result });
    },
  );
  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/turns/interrupt",
    async (request, reply) => {
      const body = turnInterruptSchema.parse(request.body);
      const result = await services.codex.interruptActiveTurn({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
        turnId: body.turnId,
      });
      return reply.status(202).send({ data: result });
    },
  );
  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/compact",
    async (request, reply) =>
      reply.status(202).send({
        data: await services.codex.compactSession({
          userId: request.principal.userId,
          sessionId: request.params.sessionId,
        }),
      }),
  );
  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/review",
    async (request, reply) => {
      const body = sessionReviewSchema.parse(request.body);
      return reply.status(202).send({
        data: await services.codex.startReview({
          userId: request.principal.userId,
          sessionId: request.params.sessionId,
          instructions: body.instructions,
        }),
      });
    },
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/goal",
    async (request) => ({
      data: await services.codex.readSessionGoal({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
      }),
    }),
  );
  app.put<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/goal",
    async (request) => {
      const body = sessionGoalUpdateSchema.parse(request.body);
      return {
        data: await services.codex.setSessionGoal({
          userId: request.principal.userId,
          sessionId: request.params.sessionId,
          ...body,
        }),
      };
    },
  );
  app.delete<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/goal",
    async (request) => ({
      data: await services.codex.clearSessionGoal({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
      }),
    }),
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/personality",
    async (request) => ({
      data: await services.codex.readSessionPersonality({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
      }),
    }),
  );
  app.put<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/personality",
    async (request) => {
      const body = codexPersonalitySelectionSchema.parse(request.body);
      return {
        data: await services.codex.setSessionPersonality({
          userId: request.principal.userId,
          sessionId: request.params.sessionId,
          personality: body.personality,
        }),
      };
    },
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/memories",
    async (request) => ({
      data: await services.codex.readSessionMemories({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
      }),
    }),
  );
  app.put<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/memories",
    async (request) => {
      const settings = codexMemoriesSettingsSchema.parse(request.body);
      return {
        data: await services.codex.setSessionMemories({
          userId: request.principal.userId,
          sessionId: request.params.sessionId,
          settings,
        }),
      };
    },
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/background-terminals",
    async (request) => ({
      data: await services.codex.listSessionBackgroundTerminals({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
      }),
    }),
  );
  app.delete<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/background-terminals",
    async (request) => ({
      data: await services.codex.cleanSessionBackgroundTerminals({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
      }),
    }),
  );
  app.delete<{
    Params: { sessionId: string; processId: string };
  }>(
    "/api/v1/sessions/:sessionId/background-terminals/:processId",
    async (request) => {
      const processId = z
        .string()
        .trim()
        .min(1)
        .max(200)
        .parse(request.params.processId);
      return {
        data: await services.codex.terminateSessionBackgroundTerminal({
          userId: request.principal.userId,
          sessionId: request.params.sessionId,
          processId,
        }),
      };
    },
  );
  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/fork",
    async (request, reply) => {
      const body = sessionForkSchema.parse(request.body);
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
    Params: { sessionId: string; nativeTurnId: string };
  }>(
    "/api/v1/sessions/:sessionId/turns/:nativeTurnId/fork",
    async (request, reply) => {
      const body = sessionForkSchema.parse(request.body);
      const sessionId = await services.codex.forkTurn({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
        nativeTurnId: request.params.nativeTurnId,
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
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/models",
    async (request) => {
      try {
        return {
          data: await services.codex.listModels(
            request.principal.userId,
            request.params.sessionId,
          ),
          meta: { availability: "available", source: "codex" },
        };
      } catch (error) {
        if (!isOptionalCodexRuntimeError(error)) throw error;
        request.log.warn(
          { sessionId: request.params.sessionId, code: error.code },
          "Codex model catalog unavailable with Session runtime",
        );
        // Model discovery is a native Codex capability, but it is optional for
        // rendering durable history. Never invent a Sandpi-owned fallback list.
        return {
          data: { data: [] },
          meta: {
            availability: "runtime-unavailable",
            source: "codex",
            message: error.message,
          },
        };
      }
    },
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/agents",
    async (request) => ({
      data: await services.codex.listSessionAgentThreads({
        userId: request.principal.userId,
        sessionId: request.params.sessionId,
      }),
    }),
  );
  app.get<{
    Params: { sessionId: string; nativeThreadId: string };
  }>(
    "/api/v1/sessions/:sessionId/agents/:nativeThreadId",
    async (request) => {
      const nativeThreadId = z
        .string()
        .trim()
        .min(1)
        .max(200)
        .parse(request.params.nativeThreadId);
      return {
        data: await services.codex.readSessionAgentThread({
          userId: request.principal.userId,
          sessionId: request.params.sessionId,
          nativeThreadId,
        }),
      };
    },
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/events",
    async (request, reply) => {
      await services.store.getSession(
        request.principal.userId,
        request.params.sessionId,
      );
      // The selected Session's initial thread/read wakes the Environment and
      // starts its Supervisor stream. Starting a worker before that lazy read
      // could race an intentional idle pause and duplicate recovery.
      return streamHarnessEvents(request, reply, services.codex);
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/files/search",
    async (request) => {
      const query = workspaceFileSearchQuerySchema.parse(
        queryString(request, "query") ?? "",
      );
      return {
        data: await services.runtimeAccess.withRuntimeAccess(
          request.principal.userId,
          request.params.environmentId,
          (runtime) => services.runtime.searchFiles(runtime, query),
        ),
        meta: { source: services.runtime.mode, root: WORKSPACE_ROOT },
      };
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/files",
    async (request) => {
      const requestedPath = queryString(request, "path") ?? "/workspace";
      return quotaSafeWorkspaceRead(
        request.principal.userId,
        request.params.environmentId,
        (runtime) => services.runtime.listFiles(runtime, requestedPath),
        (runtime) =>
          services.runtime.listPersistentWorkspaceFiles(
            runtime,
            requestedPath,
          ),
      );
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/file",
    async (request) => {
      const filePath = queryString(request, "path");
      if (!filePath)
        throw new HttpError(400, "path_required", "File path is required.");
      return quotaSafeWorkspaceRead(
        request.principal.userId,
        request.params.environmentId,
        async (runtime) =>
          workspaceFileResponse(
            filePath,
            await services.runtime.readFile(runtime, filePath),
          ),
        async (runtime) =>
          workspaceFileResponse(
            filePath,
            await services.runtime.readPersistentWorkspaceFile(
              runtime,
              filePath,
            ),
          ),
      );
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/ide",
    async (request) => {
      return quotaSafeWorkspaceRead(
        request.principal.userId,
        request.params.environmentId,
        async (runtime) => {
          const [directory, git] = await Promise.all([
            services.runtime.listFiles(runtime, "/workspace"),
            services.runtime.getWorkspaceGitState(runtime),
          ]);
          return {
            files: [
              {
                id: "workspace",
                name: "workspace",
                path: "/workspace",
                kind: "folder" as const,
                children: directory.entries,
              },
            ],
            git,
            refreshedAt: toUnixTimestamp(new Date()),
          };
        },
        async (runtime) => {
          const directory =
            await services.runtime.listPersistentWorkspaceFiles(
              runtime,
              "/workspace",
            );
          return {
            files: [
              {
                id: "workspace",
                name: "workspace",
                path: "/workspace",
                kind: "folder" as const,
                children: directory.entries,
              },
            ],
            git: { repositories: [] },
            refreshedAt: toUnixTimestamp(new Date()),
          };
        },
      );
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/ide/file",
    async (request) => {
      const filePath = queryString(request, "path");
      if (!filePath) {
        throw new HttpError(400, "path_required", "File path is required.");
      }
      return quotaSafeWorkspaceRead(
        request.principal.userId,
        request.params.environmentId,
        (runtime) => services.runtime.readWorkspaceIdeFile(runtime, filePath),
        (runtime) =>
          services.runtime.readPersistentWorkspaceIdeFile(
            runtime,
            filePath,
          ),
      );
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/ide/git",
    async (request) => ({
      data: await services.runtimeAccess.withRuntimeAccess(
        request.principal.userId,
        request.params.environmentId,
        (runtime) => services.runtime.getWorkspaceGitState(runtime),
      ),
    }),
  );
  app.post<{ Params: { environmentId: string }; Body: unknown }>(
    "/api/v1/environments/:environmentId/ide/entries",
    async (request) => {
      const input = workspaceIdeCreateEntrySchema.parse(request.body);
      return {
        data: await services.runtimeAccess.withRuntimeAccess(
          request.principal.userId,
          request.params.environmentId,
          (runtime) =>
            services.runtime.createWorkspaceIdeEntry(
              runtime,
              input.parentPath,
              input.name,
              input.kind,
            ),
        ),
      };
    },
  );
  app.put<{ Params: { environmentId: string }; Body: unknown }>(
    "/api/v1/environments/:environmentId/ide/entries",
    async (request) => {
      const input = workspaceIdeRenameEntrySchema.parse(request.body);
      return {
        data: await services.runtimeAccess.withRuntimeAccess(
          request.principal.userId,
          request.params.environmentId,
          (runtime) =>
            services.runtime.renameWorkspaceIdeEntry(
              runtime,
              input.path,
              input.name,
            ),
        ),
      };
    },
  );
  app.delete<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/ide/entries",
    async (request) => {
      const entryPath = queryString(request, "path");
      if (!entryPath) {
        throw new HttpError(
          400,
          "path_required",
          "Workspace entry path is required.",
        );
      }
      return {
        data: await services.runtimeAccess.withRuntimeAccess(
          request.principal.userId,
          request.params.environmentId,
          (runtime) =>
            services.runtime.deleteWorkspaceIdeEntry(runtime, entryPath),
        ),
      };
    },
  );
  app.put<{ Params: { environmentId: string }; Body: unknown }>(
    "/api/v1/environments/:environmentId/ide/file",
    { bodyLimit: WORKSPACE_FILE_BODY_LIMIT_BYTES },
    async (request) => {
      const filePath = queryString(request, "path");
      if (!filePath) {
        throw new HttpError(400, "path_required", "File path is required.");
      }
      const input = workspaceIdeWriteSchema.parse(request.body);
      const content = Buffer.from(input.content, "base64");
      return {
        data: await services.runtimeAccess.withRuntimeAccess(
          request.principal.userId,
          request.params.environmentId,
          (runtime) =>
            services.runtime.writeWorkspaceIdeFile(
              runtime,
              filePath,
              content,
              input.baseRevision,
            ),
        ),
      };
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/ide/events",
    { websocket: true },
    async (socket, request) => {
      type WorkspaceWatcher = Awaited<
        ReturnType<RuntimeAdapter["watchWorkspaceFiles"]>
      >;
      const watchers = new Map<string, WorkspaceWatcher>();
      let closed = false;
      let subscriptionTask = Promise.resolve();
      let resolveClosed: (() => void) | undefined;
      const closedPromise = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });

      const closeWatchers = () => {
        if (closed) return;
        closed = true;
        for (const watcher of watchers.values()) watcher.close();
        watchers.clear();
        resolveClosed?.();
      };
      socket.on("close", closeWatchers);

      const relayWatcher = async (
        directoryPath: string,
        watcher: WorkspaceWatcher,
      ) => {
        try {
          for await (const message of watcher.messages) {
            if (closed || socket.readyState !== WebSocket.OPEN) break;
            socket.send(
              JSON.stringify({
                type: "change",
                ...message,
                at: toUnixTimestamp(new Date()),
              }),
            );
          }
        } catch {
          if (!closed && socket.readyState === WebSocket.OPEN) {
            socket.close(1011, "Workspace watch failed");
          }
        } finally {
          if (watchers.get(directoryPath) === watcher) {
            watchers.delete(directoryPath);
          }
          watcher.close();
        }
      };

      const addWatcher = async (directoryPath: string) => {
        if (closed || watchers.has(directoryPath)) return;
        const watcher = await services.runtimeAccess.withRuntimeAccess(
          request.principal.userId,
          request.params.environmentId,
          (runtime) =>
            services.runtime.watchWorkspaceFiles(runtime, directoryPath),
        );
        if (closed) {
          watcher.close();
          return;
        }
        watchers.set(directoryPath, watcher);
        void relayWatcher(directoryPath, watcher);
      };

      const replaceSubscriptions = async (requestedPaths: string[]) => {
        const desired = new Set([WORKSPACE_ROOT, ...requestedPaths]);
        for (const [directoryPath, watcher] of watchers) {
          if (desired.has(directoryPath)) continue;
          watchers.delete(directoryPath);
          watcher.close();
        }
        await Promise.all(
          [...desired]
            .filter((directoryPath) => !watchers.has(directoryPath))
            .map((directoryPath) => addWatcher(directoryPath)),
        );
      };

      socket.on("message", (raw) => {
        let message: unknown;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          socket.close(1008, "Invalid Workspace subscription");
          return;
        }
        const parsed =
          workspaceIdeWatchSubscriptionSchema.safeParse(message);
        if (!parsed.success) {
          socket.close(1008, "Invalid Workspace subscription");
          return;
        }
        subscriptionTask = subscriptionTask
          .then(() => replaceSubscriptions(parsed.data.paths))
          .catch(() => {
            if (!closed && socket.readyState === WebSocket.OPEN) {
              socket.close(1011, "Workspace watch failed");
            }
          });
      });

      try {
        await addWatcher(WORKSPACE_ROOT);
        socket.send(
          JSON.stringify({ type: "ready", at: toUnixTimestamp(new Date()) }),
        );
        await closedPromise;
      } catch {
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "error",
              code: "workspace_watch_unavailable",
              error: "Live Workspace events are temporarily unavailable.",
              at: toUnixTimestamp(new Date()),
            }),
          );
          socket.close(1011, "Workspace watch failed");
        }
      } finally {
        closeWatchers();
      }
    },
  );
  app.post<{ Params: { environmentId: string }; Body: unknown }>(
    "/api/v1/environments/:environmentId/browser/session",
    async (request, reply) => {
      const input = browserSessionSchema.parse(request.body ?? {});
      await services.browser.ensureSession(
        request.principal.userId,
        request.params.environmentId,
        input.force ?? false,
      );
      return reply.status(204).send();
    },
  );
  app.post<{ Params: { environmentId: string }; Body: unknown }>(
    "/api/v1/environments/:environmentId/browser/open",
    async (request, reply) => {
      const input = browserOpenSchema.parse(request.body);
      const url = sandboxLoopbackUrl(input.url);
      if (!url) {
        throw new HttpError(
          400,
          "invalid_environment_browser_url",
          "Browser links must use HTTP or HTTPS on localhost, 127.0.0.1 or ::1.",
        );
      }
      await services.browser.openUrl(
        request.principal.userId,
        request.params.environmentId,
        url,
      );
      return reply.status(204).send();
    },
  );
  app.post<{ Params: { environmentId: string }; Body: unknown }>(
    "/api/v1/environments/:environmentId/browser/viewport",
    async (request, reply) => {
      const viewport = environmentBrowserViewportSchema.parse(request.body);
      await services.browser.resizeViewport(
        request.principal.userId,
        request.params.environmentId,
        viewport,
      );
      return reply.status(204).send();
    },
  );
  app.get<{
    Params: { environmentId: string; dashboardSocketId: string };
  }>(
    "/api/v1/environments/:environmentId/browser/ws/:dashboardSocketId",
    { websocket: true },
    async (socket, request) => {
      await proxyEnvironmentBrowserWebSocket(
        socket,
        request,
        services.browser,
        () =>
          services.runtimeAccess.touchRunningRuntimeActivity(
            request.params.environmentId,
          ),
      );
    },
  );
  // Next's development rewrite can remove the trailing slash before proxying
  // this request. Serve both root spellings directly so the iframe cannot loop
  // between the frontend proxy and a permanent slash redirect.
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/browser",
    async (request, reply) =>
      proxyEnvironmentBrowserAsset(
        services.browser,
        request,
        reply,
        undefined,
      ),
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/browser/",
    async (request, reply) =>
      proxyEnvironmentBrowserAsset(
        services.browser,
        request,
        reply,
        undefined,
      ),
  );
  app.get<{ Params: { environmentId: string; "*": string } }>(
    "/api/v1/environments/:environmentId/browser/*",
    async (request, reply) =>
      proxyEnvironmentBrowserAsset(
        services.browser,
        request,
        reply,
        request.params["*"],
      ),
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/metrics/current",
    async (request) => {
      const runtime = await services.store.getEnvironmentRuntime(
        request.principal.userId,
        request.params.environmentId,
      );
      const endedAt = new Date();
      const startedAt = new Date(
        endedAt.getTime() -
          ENVIRONMENT_RESOURCE_METRIC_LOOKBACK_SECONDS * 1_000,
      );
      return {
        data: await services.runtime.getResourceMetrics(runtime, {
          startedAt,
          endedAt,
        }),
      };
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/metrics",
    async (request) => {
      const requestedRange = Number(
        queryString(request, "rangeSeconds") ??
          DEFAULT_ENVIRONMENT_METRIC_RANGE_SECONDS,
      );
      if (!isEnvironmentMetricRangeSeconds(requestedRange)) {
        throw new HttpError(
          400,
          "invalid_metrics_range",
          "The requested Environment metrics range is not supported.",
        );
      }
      const runtime = await services.store.getEnvironmentRuntime(
        request.principal.userId,
        request.params.environmentId,
      );
      const endedAt = new Date();
      const startedAt = new Date(
        endedAt.getTime() - requestedRange * 1_000,
      );
      const [metrics, pauseIntervals] = await Promise.all([
        services.runtime.getMetrics(runtime, { startedAt, endedAt }),
        services.store.environmentPauseIntervals(
          runtime.id,
          startedAt,
          endedAt,
        ),
      ]);
      return {
        data: {
          ...metrics,
          window: {
            startedAt: toUnixTimestamp(startedAt),
            endedAt: toUnixTimestamp(endedAt),
          },
          pauseIntervals,
        },
      };
    },
  );
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/terminal",
    { websocket: true },
    async (socket, request) => {
      let terminal:
        Awaited<ReturnType<RuntimeAdapter["openTerminal"]>> | undefined;
      let inputQueue:
        TerminalInputQueue<z.infer<typeof terminalInputSchema>> | undefined;
      let heartbeat: RuntimeWebSocketHeartbeat | undefined;
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        heartbeat?.stop();
        inputQueue?.close();
        terminal?.close();
      };
      try {
        const after = Number(queryString(request, "after") ?? 0);
        const opened = await services.runtimeAccess.withRuntimeAccess(
          request.principal.userId,
          request.params.environmentId,
          async (runtime) => ({
            runtime,
            terminal: await services.runtime.openTerminal(
              runtime,
              Number.isFinite(after) ? after : 0,
              queryString(request, "terminalSessionId"),
            ),
          }),
        );
        const { runtime } = opened;
        // A terminal belongs to the shared Environment runtime. Switching
        // product Sessions must not create or replay a different shell.
        terminal = opened.terminal;
        if (runtime.terminalSessionId !== terminal.sessionId) {
          await services.store.setEnvironmentTerminalSession(
            request.params.environmentId,
            terminal.sessionId,
          );
        }
        const forwardTerminalMessage = (
          message: z.infer<typeof terminalInputSchema>,
        ) => {
          const requestId = message.requestId ?? randomUUID();
          if (message.type === "input") {
            terminal?.send({
              type: "input",
              requestId,
              data: Buffer.from(message.data, "utf8"),
            });
            return;
          }
          if (message.type === "binary") {
            terminal?.send({
              type: "input",
              requestId,
              data: Buffer.from(message.dataBase64, "base64"),
            });
            return;
          }
          terminal?.send({ ...message, requestId });
        };
        inputQueue = new TerminalInputQueue({
          authorizeAndForward: (message) =>
            services.store.withTerminalAccess(
              request.principal.userId,
              request.params.environmentId,
              () => {
                forwardTerminalMessage(message);
                heartbeat?.markActivity();
              },
            ),
          requiresAuthorization: (message) => message.type !== "resize",
          forward: forwardTerminalMessage,
          onError: (error) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  error: normalizeError(error).message,
                }),
              );
              socket.close(1008, "Terminal input is locked");
            }
          },
        });
        socket.send(
          JSON.stringify({
            type: "ready",
            sessionId: terminal.sessionId,
            attemptId: terminal.attemptId,
            replayAfter: terminal.replayAfter,
            replayUntil: terminal.replayUntil,
            replayReset: terminal.replayReset,
          }),
        );
        heartbeat = new RuntimeWebSocketHeartbeat(
          socket,
          () =>
            services.runtimeAccess.touchRunningRuntimeActivity(
              request.params.environmentId,
            ),
          {
            onActivityTouchError: (error) => {
              request.log.debug(
                {
                  err: error,
                  environmentId: request.params.environmentId,
                },
                "Environment terminal activity could not extend idle access",
              );
            },
          },
        );
        heartbeat.start();
        socket.on("message", (raw) => {
          try {
            inputQueue?.enqueue(
              terminalInputSchema.parse(JSON.parse(raw.toString())),
            );
          } catch (error) {
            if (socket.readyState === socket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  error: normalizeError(error).message,
                }),
              );
            }
          }
        });
        socket.on("close", cleanup);
        for await (const message of terminal.messages) {
          if (socket.readyState !== socket.OPEN) break;
          socket.send(JSON.stringify(message));
        }
        if (socket.readyState === socket.OPEN) {
          socket.close(1011, "Terminal stream ended");
        }
      } catch (error) {
        const normalized = normalizeError(error);
        request.log.warn(
          {
            err: error,
            code: normalized.code,
            environmentId: request.params.environmentId,
          },
          "Environment terminal connection failed",
        );
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "error",
              code: normalized.code,
              error: normalized.message,
            }),
          );
          socket.close(
            normalized.statusCode === 401 || normalized.statusCode === 403
              ? 1008
              : 1011,
            "Terminal connection failed",
          );
        }
      } finally {
        cleanup();
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
}

async function streamHarnessEvents(
  request: FastifyRequest<{ Params: { sessionId: string } }>,
  reply: FastifyReply,
  codex: CodexService,
) {
  const sessionId = request.params.sessionId;
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  // Codex captures the live cursor at the exact thread/read response record.
  // Notifications before that boundary belong to the native snapshot; only
  // the suffix after it is streamed to the client.
  let initial:
    | Awaited<ReturnType<CodexService["readNativeSnapshotWithCursor"]>>
    | undefined;
  let initialInvalidation:
    { reason: string; message: string; unrecoverable: true } | undefined;
  let initialStreamFailure: ReturnType<typeof codexNativeStreamFailure>;
  try {
    initial = await codex.readNativeSnapshotWithCursor(
      request.principal.userId,
      sessionId,
      controller.signal,
    );
  } catch (error) {
    const normalized = normalizeError(error);
    if (
      normalized.code !== "codex_native_session_unrecoverable" &&
      normalized.code !== "session_allocation_unrecoverable"
    ) {
      initialStreamFailure = codexNativeStreamFailure(normalized);
      if (!initialStreamFailure) throw error;
    } else {
      initialInvalidation = {
        reason:
          normalized.code === "session_allocation_unrecoverable"
            ? "session-allocation-unrecoverable"
            : "native-session-unrecoverable",
        message: normalized.message,
        unrecoverable: true,
      };
    }
  }
  let cursor = initial?.liveCursor ?? codex.liveCursor(sessionId);
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(
    `retry: ${initialStreamFailure ? CODEX_NATIVE_STREAM_AUTH_RETRY_MS : 1_000}\n\n`,
  );
  type NativeSnapshotRead = Awaited<
    ReturnType<CodexService["readNativeSnapshotWithCursor"]>
  >;
  type ActivityIdentity = {
    nativeSessionId: string;
    historyRevision: number;
  };
  let activityGeneration = 0;
  let activityIdentity: ActivityIdentity | undefined = initial
    ? {
        nativeSessionId: initial.snapshot.nativeSessionId,
        historyRevision: initial.snapshot.historyRevision,
      }
    : undefined;
  let latestActivity: CodexRolloutActivityFeed | undefined;
  const writeActivity = (
    identity: ActivityIdentity,
    supplement: Awaited<NativeSnapshotRead["supplement"]>,
    generation: number,
  ) => {
    if (
      generation !== activityGeneration ||
      controller.signal.aborted ||
      reply.raw.destroyed
    ) {
      return;
    }
    activityIdentity = identity;
    latestActivity = supplement.activity;
    reply.raw.write(
      `event: activity\ndata: ${JSON.stringify({
        ...identity,
        ...supplement,
      })}\n\n`,
    );
  };
  const writeActivityFailure = (error: unknown, generation: number) => {
    if (!activityIdentity || generation !== activityGeneration) return;
    const normalized = normalizeError(error);
    const records = latestActivity?.records ?? [];
    writeActivity(
      activityIdentity,
      {
        activity: {
          source: "codex-rollout",
          availability: records.length > 0 ? "partial" : "unavailable",
          records,
          error: {
            code: "codex_rollout_activity_refresh_failed",
            message: `Codex persisted Session Activity could not be refreshed: ${normalized.message}`,
          },
        },
        tokenUsage: null,
      },
      generation,
    );
  };
  const deliverActivity = (read: NativeSnapshotRead, generation: number) => {
    if (generation !== activityGeneration) return;
    const identity = {
      nativeSessionId: read.snapshot.nativeSessionId,
      historyRevision: read.snapshot.historyRevision,
    };
    if (
      activityIdentity?.nativeSessionId !== identity.nativeSessionId ||
      activityIdentity.historyRevision !== identity.historyRevision
    ) {
      latestActivity = undefined;
    }
    activityIdentity = identity;
    void read.supplement
      .then((supplement) => {
        if (generation === activityGeneration) {
          writeActivity(identity, supplement, generation);
        }
      })
      .catch((error: unknown) => writeActivityFailure(error, generation));
  };
  const scheduleActivity = (read: NativeSnapshotRead) => {
    const generation = ++activityGeneration;
    deliverActivity(read, generation);
  };
  const refreshActivity = () => {
    const generation = ++activityGeneration;
    void codex
      .readNativeSnapshotWithCursor(
        request.principal.userId,
        sessionId,
        controller.signal,
      )
      .then((read) => deliverActivity(read, generation))
      .catch((error: unknown) => writeActivityFailure(error, generation));
  };
  if (initial) {
    reply.raw.write("event: snapshot\n");
    reply.raw.write(`data: ${JSON.stringify(initial.snapshot)}\n\n`);
    scheduleActivity(initial);
  } else if (initialStreamFailure) {
    reply.raw.write("event: stream-error\n");
    reply.raw.write(`data: ${JSON.stringify(initialStreamFailure)}\n\n`);
    reply.raw.end();
    return;
  } else {
    reply.raw.write(`id: ${cursor}\n`);
    reply.raw.write("event: invalidation\n");
    reply.raw.write(`data: ${JSON.stringify(initialInvalidation)}\n\n`);
  }
  // IncomingMessage `close` means the GET request body has finished and can
  // fire while the SSE response is still healthy. Track the response socket
  // (plus an explicitly aborted request) so live tool notifications are not
  // cut off immediately after the initial native snapshot.
  reply.raw.once("close", abort);

  while (!controller.signal.aborted && !reply.raw.destroyed) {
    const updates = codex.listLiveNotifications(sessionId, cursor);
    if (updates.length > 0) {
      let snapshotReplacedSuffix = false;
      for (const update of updates) {
        reply.raw.write(`id: ${update.cursor}\n`);
        if (update.kind === "notification") {
          reply.raw.write("event: notification\n");
          reply.raw.write(`data: ${JSON.stringify(update.event)}\n\n`);
          if (update.refreshPersistedActivity) refreshActivity();
        } else {
          reply.raw.write("event: invalidation\n");
          reply.raw.write(
            `data: ${JSON.stringify({
              reason: update.reason,
              message: update.message,
              unrecoverable: update.unrecoverable,
            })}\n\n`,
          );
          if (!update.unrecoverable) {
            try {
              const refreshed = await codex.readNativeSnapshotWithCursor(
                request.principal.userId,
                sessionId,
                controller.signal,
              );
              reply.raw.write("event: snapshot\n");
              reply.raw.write(
                `data: ${JSON.stringify(refreshed.snapshot)}\n\n`,
              );
              // Discard the old drain batch and continue strictly after the
              // response boundary returned with the replacement snapshot.
              cursor = refreshed.liveCursor;
              scheduleActivity(refreshed);
              snapshotReplacedSuffix = true;
            } catch (error) {
              reply.raw.write("event: invalidation\n");
              reply.raw.write(
                `data: ${JSON.stringify({
                  reason: "native-snapshot-unavailable",
                  message: normalizeError(error).message,
                  unrecoverable: false,
                })}\n\n`,
              );
              // A transient native read failure is not evidence that the
              // rollout disappeared. Close this transport so EventSource can
              // reconnect and perform a clean native snapshot handshake.
              controller.abort();
              break;
            }
          }
        }
        if (snapshotReplacedSuffix) break;
        cursor = update.cursor;
      }
      if (controller.signal.aborted) break;
      continue;
    }
    reply.raw.write(": keepalive\n\n");
    await codex.waitForSessionUpdate(sessionId, controller.signal);
  }
  if (!reply.raw.destroyed) reply.raw.end();
}

const BROWSER_DASHBOARD_PROXY_TIMEOUT_MS = 130_000;
const BROWSER_DASHBOARD_MAX_ASSET_BYTES = 8 * 1024 * 1024;
const BROWSER_DASHBOARD_MAX_QUEUED_CLIENT_WS_BYTES = 1024 * 1024;
const BROWSER_DASHBOARD_MAX_QUEUED_DOWNSTREAM_WS_BYTES = 8 * 1024 * 1024;

async function proxyEnvironmentBrowserAsset(
  browser: EnvironmentBrowserService,
  request: FastifyRequest<{ Params: { environmentId: string } }>,
  reply: FastifyReply,
  assetPath: string | undefined,
) {
  const environmentId = request.params.environmentId;
  let upstream = await browser.httpUpstream(
    request.principal.userId,
    environmentId,
    assetPath,
  );
  let response = await fetchBrowserDashboardAsset(upstream);
  if (response.status === 401 || response.status === 403) {
    browser.invalidate(environmentId);
    upstream = await browser.httpUpstream(
      request.principal.userId,
      environmentId,
      assetPath,
    );
    response = await fetchBrowserDashboardAsset(upstream);
  }

  const prefix = dashboardProxyPrefix(environmentId);
  if (response.status >= 300 && response.status < 400) {
    const location = dashboardRedirectLocation(
      response.headers.get("location"),
      prefix,
    );
    if (!location) {
      throw new HttpError(
        502,
        "environment_browser_proxy_invalid",
        "The Playwright Dashboard returned an invalid redirect.",
      );
    }
    return reply
      .status(response.status)
      .header("Cache-Control", "private, no-store")
      .header("Location", location)
      .send();
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (
    Number.isFinite(contentLength) &&
    contentLength > BROWSER_DASHBOARD_MAX_ASSET_BYTES
  ) {
    throw new HttpError(
      502,
      "environment_browser_asset_too_large",
      "The Playwright Dashboard asset is too large.",
    );
  }
  const contentType = response.headers.get("content-type");
  if (contentType) reply.header("Content-Type", contentType);
  reply.header(
    "Cache-Control",
    response.ok
      ? dashboardAssetCacheControl(
          assetPath,
          response.headers.get("cache-control"),
        )
      : "private, no-store",
  );
  const normalizedAssetPath = assetPath?.replace(/^\/+|\/+$/g, "");
  if (
    normalizedAssetPath === "index.html" ||
    normalizedAssetPath?.endsWith(".css")
  ) {
    const body = await readBrowserDashboardBody(response);
    const payload =
      normalizedAssetPath === "index.html"
        ? rewriteDashboardHtml(body.toString("utf8"), prefix)
        : rewriteDashboardCss(body.toString("utf8"), prefix);
    return reply.status(response.status).send(payload);
  }

  if (!response.body) {
    return reply.status(response.status).send();
  }
  let streamedBytes = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      streamedBytes += chunk.byteLength;
      if (streamedBytes > BROWSER_DASHBOARD_MAX_ASSET_BYTES) {
        callback(
          new HttpError(
            502,
            "environment_browser_asset_too_large",
            "The Playwright Dashboard asset is too large.",
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  return reply
    .status(response.status)
    .send(
      Readable.fromWeb(
        response.body as unknown as import("node:stream/web").ReadableStream,
      ).pipe(bounded),
    );
}

async function readBrowserDashboardBody(response: Response) {
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > BROWSER_DASHBOARD_MAX_ASSET_BYTES) {
    throw new HttpError(
      502,
      "environment_browser_asset_too_large",
      "The Playwright Dashboard asset is too large.",
    );
  }
  return body;
}

async function fetchBrowserDashboardAsset(upstream: {
  url: string;
  headers: Record<string, string>;
}) {
  try {
    return await fetch(upstream.url, {
      method: "GET",
      headers: upstream.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(BROWSER_DASHBOARD_PROXY_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(
      502,
      "environment_browser_proxy_unavailable",
      "The Playwright Dashboard is temporarily unavailable.",
    );
  }
}

async function proxyEnvironmentBrowserWebSocket(
  socket: WebSocket,
  request: FastifyRequest<{
    Params: { environmentId: string; dashboardSocketId: string };
  }>,
  browser: EnvironmentBrowserService,
  touchRuntime: () => Promise<boolean>,
) {
  const queued: Array<{ data: RawData; isBinary: boolean }> = [];
  let queuedBytes = 0;
  let upstream: WebSocket | undefined;
  let downstreamClosed = false;
  const downstreamRelay = new BrowserWebSocketDownstreamRelay({
    maxQueuedBytes: BROWSER_DASHBOARD_MAX_QUEUED_DOWNSTREAM_WS_BYTES,
    send(data, isBinary, callback) {
      if (socket.readyState !== WebSocket.OPEN) {
        callback(new Error("Dashboard downstream is closed"));
        return;
      }
      socket.send(data, { binary: isBinary }, callback);
    },
    onOverflow() {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1009, "Dashboard downstream queue exceeded");
      }
    },
    onSendError(error) {
      request.log.debug(
        { err: error, environmentId: request.params.environmentId },
        "Playwright Dashboard downstream send failed",
      );
      upstream?.terminate();
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1011, "Dashboard downstream unavailable");
      }
    },
  });
  const heartbeat = new RuntimeWebSocketHeartbeat(socket, touchRuntime, {
    pingIntervalMs: 30_000,
    activityTouchIntervalMs: 30_000,
    onActivityTouchError: (error) => {
      request.log.debug(
        { err: error, environmentId: request.params.environmentId },
        "Environment browser activity could not extend idle access",
      );
    },
  });
  heartbeat.start();

  socket.on("message", (data, isBinary) => {
    if (upstream?.readyState === WebSocket.OPEN) {
      heartbeat.markActivity();
      upstream.send(data, { binary: isBinary });
      return;
    }
    queuedBytes += websocketRawDataSize(data);
    if (queuedBytes > BROWSER_DASHBOARD_MAX_QUEUED_CLIENT_WS_BYTES) {
      socket.close(1009, "Dashboard connection queue exceeded");
      return;
    }
    queued.push({ data, isBinary });
    heartbeat.markActivity();
  });
  socket.once("close", () => {
    downstreamClosed = true;
    heartbeat.stop();
    downstreamRelay.close();
    request.log.debug(
      {
        environmentId: request.params.environmentId,
        ...downstreamRelay.stats(),
      },
      "Playwright Dashboard downstream relay closed",
    );
    upstream?.close();
  });
  socket.once("error", () => {
    heartbeat.stop();
    downstreamRelay.close();
    upstream?.terminate();
  });

  try {
    const target = await browser.websocketUpstream(
      request.principal.userId,
      request.params.environmentId,
      request.params.dashboardSocketId,
    );
    if (downstreamClosed) return;
    upstream = new WebSocket(target.url, {
      headers: target.headers,
      handshakeTimeout: BROWSER_DASHBOARD_PROXY_TIMEOUT_MS,
    });
    upstream.once("open", () => {
      for (const message of queued) {
        if (upstream?.readyState !== WebSocket.OPEN) break;
        upstream.send(message.data, { binary: message.isBinary });
      }
      queued.length = 0;
      queuedBytes = 0;
    });
    upstream.on("message", (data, isBinary) => {
      downstreamRelay.enqueue(data, isBinary);
    });
    upstream.once("close", (code, reason) => {
      heartbeat.stop();
      downstreamRelay.close();
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(websocketCloseCode(code), reason.toString().slice(0, 123));
      }
    });
    upstream.once("error", (error) => {
      heartbeat.stop();
      // HTTP auth failures and runtime-generation fencing refresh stale
      // coordinates. A transient socket failure must not force the next
      // Browser mount through another regional control API lookup.
      request.log.warn(
        { err: error, environmentId: request.params.environmentId },
        "Playwright Dashboard WebSocket upstream failed",
      );
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1011, "Dashboard upstream unavailable");
      }
    });
  } catch (error) {
    heartbeat.stop();
    request.log.warn(
      { err: error, environmentId: request.params.environmentId },
      "Playwright Dashboard WebSocket setup failed",
    );
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1011, "Dashboard unavailable");
    }
  }
}

function websocketCloseCode(code: number) {
  return code >= 1_000 &&
    code < 5_000 &&
    ![1_004, 1_005, 1_006, 1_015].includes(code)
    ? code
    : 1_011;
}

async function authenticateRequest(
  request: FastifyRequest,
  oidcIdentity?: OidcIdentityService,
): Promise<Principal> {
  if (!oidcIdentity) {
    if (request.cookies[BUILTIN_SIGNED_OUT_COOKIE] === "1") {
      throw new HttpError(
        401,
        "authentication_required",
        "Sign in required.",
      );
    }
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
  if (!principal)
    throw new HttpError(401, "authentication_required", "Sign in required.");
  return principal;
}

export function publicAuthPath(url: string) {
  const path = url.split("?", 1)[0];
  return (
    path === "/api/v1/auth/login" ||
    path === "/api/v1/auth/callback" ||
    path === "/api/v1/auth/native/prepare" ||
    path === "/api/v1/auth/native/login" ||
    path === "/api/v1/auth/native/complete" ||
    path === "/api/v1/billing/webhook" ||
    /^\/api\/v1\/webhooks\/[^/]+$/.test(path)
  );
}

export function validateBillingRuntime(
  billing: SandpiConfig["billing"],
  runtime: Pick<RuntimeAdapter, "supportsUsageWindows">,
) {
  if (billing.mode === "stripe" && !runtime.supportsUsageWindows()) {
    throw new Error(
      "Stripe billing requires a Sandbox0 SDK release with client.usage.listWindows().",
    );
  }
}

function isRuntimePlanBlock(error: unknown): error is HttpError {
  return (
    error instanceof HttpError &&
    (error.code === "sandbox_runtime_quota_exhausted" ||
      error.code === "environment_plan_limit")
  );
}

function workspaceFileResponse(filePath: string, content: Uint8Array) {
  return {
    path: filePath,
    encoding: "base64" as const,
    content: Buffer.from(content).toString("base64"),
    kind: isUtf8(content) ? ("text" as const) : ("binary" as const),
  };
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

export function authCookieAttributes(
  config: Pick<SandpiConfig, "publicUrl">,
) {
  return {
    path: AUTH_COOKIE_PATH,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.publicUrl.protocol === "https:",
  };
}

function clearAuthCookie(reply: FastifyReply, name: string) {
  for (const path of AUTH_COOKIE_CLEAR_PATHS) {
    reply.clearCookie(name, { path });
  }
}

function sessionCookie(config: SandpiConfig, expires: Date) {
  return {
    ...authCookieAttributes(config),
    expires,
  };
}

function builtinSignedOutCookie(config: SandpiConfig) {
  return {
    ...authCookieAttributes(config),
    expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000),
  };
}

function validateNativeAuthOrigin(
  request: Pick<FastifyRequest, "headers">,
  config: SandpiConfig,
) {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins(config).has(origin)) {
    throw new HttpError(
      403,
      "origin_invalid",
      "Native authentication Origin is not allowed.",
    );
  }
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

function boundedIntegerQuery(
  request: FastifyRequest,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
) {
  const value = queryString(request, name);
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(
      400,
      "invalid_request",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

function environmentScheduleConfiguration(
  input: z.infer<typeof environmentScheduleSchema>,
): EnvironmentScheduleConfiguration {
  return {
    name: input.name,
    prompt: input.prompt,
    timing:
      input.timing.kind === "once"
        ? {
            kind: "once",
            runAt: dateFromUnixTimestamp(input.timing.runAt),
          }
        : input.timing,
    target: input.target,
    enabled: input.enabled,
    ...(input.title ? { title: input.title } : {}),
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.reasoningEffort
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
    ...(input.collaborationMode
      ? { collaborationMode: input.collaborationMode }
      : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  };
}

function environmentWebhookConfiguration(
  input: z.infer<typeof environmentWebhookSchema>,
): EnvironmentWebhookConfiguration {
  return {
    name: input.name,
    ...(input.secret ? { secret: input.secret } : {}),
    prompt: input.prompt,
    triggerPolicy: input.triggerPolicy,
    cooldownPolicy: input.cooldownPolicy,
    target: input.target,
    overlapPolicy: input.overlapPolicy,
    maxConcurrentRuns: input.maxConcurrentRuns,
    maxPendingRuns: input.maxPendingRuns,
    enabled: input.enabled,
    ...(input.title ? { title: input.title } : {}),
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.reasoningEffort
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
    ...(input.collaborationMode
      ? { collaborationMode: input.collaborationMode }
      : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  };
}

function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ZodError) {
    return new HttpError(
      400,
      "invalid_request",
      "Request validation failed.",
      error.issues,
    );
  }
  return new HttpError(500, "internal_error", "Internal server error.");
}

function isOptionalCodexRuntimeError(error: unknown): error is HttpError {
  return (
    error instanceof HttpError &&
    (error.code === "codex_native_session_unrecoverable" ||
      error.code === "session_allocation_unrecoverable" ||
      error.code === "supervisor_not_running" ||
      (error.code.startsWith("sandbox0_") &&
        [404, 409, 503].includes(error.statusCode)))
  );
}
