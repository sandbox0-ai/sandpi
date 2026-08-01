import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { SandboxPreviewTarget } from "@/lib/environment-preview";
import { sandboxPreviewTarget } from "@/lib/environment-preview";
import { HttpError } from "@/server/http-error";
import type {
  RuntimeAdapter,
  RuntimePreviewProxy,
} from "@/server/runtime/types";
import type { EnvironmentRuntimeAccessService } from "./runtime-access-service";

export const PREVIEW_SESSION_COOKIE = "__Host-sandpi_preview";
export const PREVIEW_INSECURE_SESSION_COOKIE = "sandpi_preview";
export const PREVIEW_TICKET_QUERY = "__sandpi_ticket";
export const PREVIEW_TICKET_TTL_MS = 60_000;
export const PREVIEW_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

interface PreviewTokenClaims {
  version: 1;
  kind: "ticket" | "session";
  userId: string;
  environmentId: string;
  targetHost: SandboxPreviewTarget["hostname"];
  targetPort: number;
  expiresAt: number;
  nonce: string;
}

export interface AuthorizedPreviewSession {
  userId: string;
  environmentId: string;
  targetHost: SandboxPreviewTarget["hostname"];
  targetPort: number;
}

interface CachedPreviewProxy {
  runtimeGeneration: number;
  pending: Promise<RuntimePreviewProxy>;
}

export interface EnvironmentPreviewServiceOptions {
  publicUrl: URL;
  signingKey: Buffer;
  now?: () => number;
}

/** Owns Preview authorization and protected Sandbox0 proxy coordinates. */
export class EnvironmentPreviewService {
  private readonly proxies = new Map<string, CachedPreviewProxy>();
  private readonly now: () => number;

  constructor(
    private readonly runtimeAccess: EnvironmentRuntimeAccessService,
    private readonly runtime: RuntimeAdapter,
    private readonly options: EnvironmentPreviewServiceOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async createSession(userId: string, environmentId: string, value: string) {
    const target = sandboxPreviewTarget(value);
    if (!target) {
      throw new HttpError(
        400,
        "invalid_environment_preview_url",
        "Preview URLs must use HTTP on localhost or 127.0.0.1.",
      );
    }

    await this.proxy(userId, environmentId);
    const claims = this.newClaims("ticket", userId, environmentId, target);
    const url = this.publicTargetUrl(claims, target);
    url.searchParams.set(PREVIEW_TICKET_QUERY, this.sign(claims));
    url.hash = target.hash;
    return { url: url.toString(), target: target.url };
  }

  exchangeTicket(host: string, token: string) {
    const ticket = this.verify(host, token, "ticket");
    const session: PreviewTokenClaims = {
      ...ticket,
      kind: "session",
      expiresAt: this.now() + PREVIEW_SESSION_TTL_MS,
      nonce: randomBytes(12).toString("base64url"),
    };
    return {
      token: this.sign(session),
      expiresAt: new Date(session.expiresAt),
      session: publicClaims(session),
    };
  }

  authorize(host: string, token: string | undefined) {
    if (!token) {
      throw new HttpError(
        401,
        "environment_preview_authentication_required",
        "Open Preview again from its Environment.",
      );
    }
    return publicClaims(this.verify(host, token, "session"));
  }

  async upstream(session: AuthorizedPreviewSession, rawUrl: string) {
    const proxy = await this.proxy(session.userId, session.environmentId);
    const target = new URL(proxy.publicUrl);
    const requestUrl = new URL(rawUrl, "http://preview.invalid");
    target.pathname = requestUrl.pathname;
    target.search = requestUrl.search;
    target.hash = "";
    return {
      url: target,
      headers: {
        ...proxy.requestHeaders,
        "X-Sandpi-Preview-Target-Host": session.targetHost,
        "X-Sandpi-Preview-Target-Port": String(session.targetPort),
      },
    };
  }

  invalidate(environmentId: string) {
    this.proxies.delete(environmentId);
  }

  hostConstraint() {
    return environmentPreviewHostConstraint(this.options.publicUrl);
  }

  isPreviewHost(host: string | undefined) {
    return Boolean(host && this.hostConstraint().test(host));
  }

  previewOrigin(host: string) {
    if (!this.isPreviewHost(host)) {
      throw new HttpError(404, "environment_preview_not_found", "Preview not found.");
    }
    return `${this.options.publicUrl.protocol}//${host.toLowerCase()}`;
  }

  cookieName() {
    return this.options.publicUrl.protocol === "https:"
      ? PREVIEW_SESSION_COOKIE
      : PREVIEW_INSECURE_SESSION_COOKIE;
  }

  cookieOptions(expiresAt: Date) {
    return {
      path: "/",
      httpOnly: true,
      sameSite: "lax" as const,
      secure: this.options.publicUrl.protocol === "https:",
      expires: expiresAt,
    };
  }

  private async proxy(userId: string, environmentId: string) {
    return this.runtimeAccess.withRuntimeAccess(
      userId,
      environmentId,
      async (runtime) => {
        const cached = this.proxies.get(environmentId);
        if (cached?.runtimeGeneration === runtime.runtimeGeneration) {
          return cached.pending;
        }
        const pending = this.runtime.ensureEnvironmentPreviewProxy(runtime);
        const entry = { runtimeGeneration: runtime.runtimeGeneration, pending };
        this.proxies.set(environmentId, entry);
        try {
          return await pending;
        } catch (error) {
          if (this.proxies.get(environmentId) === entry) {
            this.proxies.delete(environmentId);
          }
          throw error;
        }
      },
    );
  }

  private newClaims(
    kind: PreviewTokenClaims["kind"],
    userId: string,
    environmentId: string,
    target: SandboxPreviewTarget,
  ): PreviewTokenClaims {
    return {
      version: 1,
      kind,
      userId,
      environmentId,
      targetHost: target.hostname,
      targetPort: target.port,
      expiresAt:
        this.now() +
        (kind === "ticket" ? PREVIEW_TICKET_TTL_MS : PREVIEW_SESSION_TTL_MS),
      nonce: randomBytes(12).toString("base64url"),
    };
  }

  private publicTargetUrl(
    claims: PreviewTokenClaims,
    target: SandboxPreviewTarget,
  ) {
    const url = new URL(this.options.publicUrl);
    url.hostname = previewHostname(
      claims.environmentId,
      claims.targetPort,
      this.options.publicUrl.hostname,
    );
    url.pathname = target.pathname;
    url.search = target.search;
    return url;
  }

  private sign(claims: PreviewTokenClaims) {
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
      "base64url",
    );
    return `${payload}.${signature(this.options.signingKey, payload)}`;
  }

  private verify(
    host: string,
    token: string,
    expectedKind: PreviewTokenClaims["kind"],
  ) {
    const [payload, presentedSignature, extra] = token.split(".");
    if (!payload || !presentedSignature || extra) throw invalidPreviewToken();
    const expectedSignature = signature(this.options.signingKey, payload);
    const presented = Buffer.from(presentedSignature);
    const expected = Buffer.from(expectedSignature);
    if (
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    ) {
      throw invalidPreviewToken();
    }

    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw invalidPreviewToken();
    }
    if (!isPreviewClaims(claims) || claims.kind !== expectedKind) {
      throw invalidPreviewToken();
    }
    if (claims.expiresAt <= this.now()) {
      throw new HttpError(
        401,
        "environment_preview_session_expired",
        "Open Preview again from its Environment.",
      );
    }
    const expectedHost = previewHostname(
      claims.environmentId,
      claims.targetPort,
      this.options.publicUrl.hostname,
    );
    const expectedAuthority = this.options.publicUrl.port
      ? `${expectedHost}:${this.options.publicUrl.port}`
      : expectedHost;
    if (host.toLowerCase() !== expectedAuthority.toLowerCase()) {
      throw invalidPreviewToken();
    }
    return claims;
  }
}

export function previewHostname(
  environmentId: string,
  port: number,
  rootHostname: string,
) {
  const environmentHash = createHash("sha256")
    .update(environmentId, "utf8")
    .digest("hex")
    .slice(0, 20);
  return `p${port}-${environmentHash}.${rootHostname.toLowerCase()}`;
}

export function environmentPreviewHostConstraint(publicUrl: URL) {
  const hostname = escapeRegExp(publicUrl.hostname);
  const port = publicUrl.port ? `:${escapeRegExp(publicUrl.port)}` : "";
  return new RegExp(
    `^p(?:[1-9]\\d{0,4})-[a-f0-9]{20}\\.${hostname}${port}$`,
    "i",
  );
}

export function previewSigningKey(secret: string | undefined) {
  return createHash("sha256")
    .update("sandpi/environment-preview/session/v1\0", "utf8")
    .update(secret ?? randomBytes(32))
    .digest();
}

function signature(key: Buffer, payload: string) {
  return createHmac("sha256", key).update(payload, "utf8").digest("base64url");
}

function publicClaims(claims: PreviewTokenClaims): AuthorizedPreviewSession {
  return {
    userId: claims.userId,
    environmentId: claims.environmentId,
    targetHost: claims.targetHost,
    targetPort: claims.targetPort,
  };
}

function isPreviewClaims(value: unknown): value is PreviewTokenClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Record<string, unknown>;
  return (
    claims.version === 1 &&
    (claims.kind === "ticket" || claims.kind === "session") &&
    typeof claims.userId === "string" &&
    claims.userId.length > 0 &&
    claims.userId.length <= 512 &&
    typeof claims.environmentId === "string" &&
    claims.environmentId.length > 0 &&
    claims.environmentId.length <= 512 &&
    (claims.targetHost === "localhost" || claims.targetHost === "127.0.0.1") &&
    typeof claims.targetPort === "number" &&
    Number.isInteger(claims.targetPort) &&
    claims.targetPort >= 1 &&
    claims.targetPort <= 65_535 &&
    typeof claims.expiresAt === "number" &&
    Number.isSafeInteger(claims.expiresAt) &&
    typeof claims.nonce === "string" &&
    /^[A-Za-z0-9_-]{16,64}$/.test(claims.nonce)
  );
}

function invalidPreviewToken() {
  return new HttpError(
    401,
    "environment_preview_session_invalid",
    "Open Preview again from its Environment.",
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
