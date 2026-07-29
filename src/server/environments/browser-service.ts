import type { EnvironmentRuntimeAccessService } from "./runtime-access-service";
import { embedBrowserDashboard } from "./browser-dashboard-embed";
import { HttpError } from "@/server/http-error";
import type {
  EnvironmentRuntimeRecord,
  RuntimeAdapter,
  RuntimeBrowserDashboard,
} from "@/server/runtime/types";
import type { BrowserDashboardViewport } from "@/lib/environment-browser";

export interface BrowserDashboardUpstream {
  url: string;
  headers: Record<string, string>;
}

interface CachedBrowserDashboard {
  runtimeGeneration: number;
  restartRevision: number;
  pending: Promise<RuntimeBrowserDashboard>;
}

interface CachedBrowserSession {
  runtimeGeneration: number;
  pending: Promise<boolean>;
}

interface BrowserViewportState {
  runtimeGeneration: number;
  applied?: BrowserDashboardViewport;
  inFlight?: BrowserDashboardViewport;
  queued?: BrowserDashboardViewport;
  pending?: Promise<void>;
}

const DASHBOARD_SOCKET_ID = /^[A-Za-z0-9-]{1,128}$/;
const DASHBOARD_ASSET_PATH =
  /^(?:index\.html|playwright-logo\.svg|assets\/[A-Za-z0-9._-]+)$/;
const DASHBOARD_FINGERPRINTED_ASSET =
  /^assets\/.+-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/;
const DASHBOARD_MAX_BROWSER_CACHE_SECONDS = 24 * 60 * 60;

/**
 * Owns only lifecycle, authorization and transport coordinates for the
 * official Playwright Dashboard. Browser control remains in Playwright.
 */
export class EnvironmentBrowserService {
  private readonly dashboards = new Map<string, CachedBrowserDashboard>();
  private readonly dashboardRestartRevisions = new Map<string, number>();
  private readonly appliedDashboardRestartRevisions = new Map<string, number>();
  private readonly sessions = new Map<string, CachedBrowserSession>();
  private readonly viewports = new Map<string, BrowserViewportState>();

  constructor(
    private readonly runtimeAccess: EnvironmentRuntimeAccessService,
    private readonly runtime: RuntimeAdapter,
  ) {}

  async ensureSession(
    userId: string,
    environmentId: string,
    force = false,
  ) {
    if (force) this.restartDashboard(environmentId);
    // Sandbox0 does not reliably admit updateServices and cmd concurrently.
    // Serialize only the short service configuration; Chromium startup then
    // overlaps the Dashboard's ingress and health-check startup.
    await this.dashboard(userId, environmentId);
    await this.runtimeAccess.withRuntimeAccess(
      userId,
      environmentId,
      (runtime) => this.ensureRuntimeSession(runtime, force),
    );
  }

  async openUrl(userId: string, environmentId: string, url: string) {
    await this.dashboard(userId, environmentId);
    await this.runtimeAccess.withRuntimeAccess(
      userId,
      environmentId,
      async (runtime) => {
        await this.runtime.openEnvironmentBrowserUrl(runtime, url);
        this.sessions.set(environmentId, {
          runtimeGeneration: runtime.runtimeGeneration,
          pending: Promise.resolve(false),
        });
      },
    );
  }

  async resizeViewport(
    userId: string,
    environmentId: string,
    viewport: BrowserDashboardViewport,
  ) {
    await this.runtimeAccess.withRuntimeAccess(
      userId,
      environmentId,
      (runtime) => this.queueViewportResize(runtime, viewport),
    );
  }

  async httpUpstream(
    userId: string,
    environmentId: string,
    assetPath: string | undefined,
  ): Promise<BrowserDashboardUpstream> {
    const dashboard = await this.dashboard(userId, environmentId);
    const target = new URL(dashboard.publicUrl);
    target.pathname = dashboardAssetPath(assetPath);
    target.search = "";
    target.hash = "";
    return {
      url: target.toString(),
      headers: { ...dashboard.requestHeaders },
    };
  }

  async websocketUpstream(
    userId: string,
    environmentId: string,
    socketId: string,
  ): Promise<BrowserDashboardUpstream> {
    if (!DASHBOARD_SOCKET_ID.test(socketId)) {
      throw new HttpError(
        400,
        "invalid_environment_browser_socket",
        "Invalid Playwright Dashboard socket id.",
      );
    }
    const dashboard = await this.dashboard(userId, environmentId);
    const target = new URL(dashboard.publicUrl);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    target.pathname = `/${socketId}`;
    target.search = "";
    target.hash = "";
    return {
      url: target.toString(),
      headers: { ...dashboard.requestHeaders },
    };
  }

  invalidate(environmentId: string) {
    // Transport failures and lifecycle transitions invalidate coordinates,
    // but the Sandbox-native AppService already owns process recovery. Do not
    // rewrite and restart a healthy recovered Dashboard merely because its old
    // WebSocket closed.
    this.dashboards.delete(environmentId);
    this.viewports.delete(environmentId);
  }

  private async dashboard(userId: string, environmentId: string) {
    // Every request still crosses ownership and lifecycle admission. The cache
    // only avoids rewriting an identical AppService and is fenced by Sandbox0's
    // authoritative runtime generation.
    return this.runtimeAccess.withRuntimeAccess(
      userId,
      environmentId,
      async (runtime) => {
        const restartRevision =
          this.dashboardRestartRevisions.get(environmentId) ?? 0;
        const cached = this.dashboards.get(environmentId);
        if (
          cached?.runtimeGeneration === runtime.runtimeGeneration &&
          cached.restartRevision === restartRevision
        ) {
          return cached.pending;
        }

        const restart =
          restartRevision >
          (this.appliedDashboardRestartRevisions.get(environmentId) ?? 0);
        const pending = this.runtime.ensureEnvironmentBrowserDashboard(
          runtime,
          restart,
        );
        const entry: CachedBrowserDashboard = {
          runtimeGeneration: runtime.runtimeGeneration,
          restartRevision,
          pending,
        };
        this.dashboards.set(environmentId, entry);
        try {
          const dashboard = await pending;
          if (this.dashboards.get(environmentId) === entry) {
            this.appliedDashboardRestartRevisions.set(
              environmentId,
              restartRevision,
            );
          }
          return dashboard;
        } catch (error) {
          if (this.dashboards.get(environmentId) === entry) {
            this.dashboards.delete(environmentId);
          }
          throw error;
        }
      },
    );
  }

  private restartDashboard(environmentId: string) {
    this.invalidate(environmentId);
    this.dashboardRestartRevisions.set(
      environmentId,
      (this.dashboardRestartRevisions.get(environmentId) ?? 0) + 1,
    );
  }

  private async ensureRuntimeSession(
    runtime: EnvironmentRuntimeRecord,
    force: boolean,
  ) {
    const cached = this.sessions.get(runtime.id);
    if (
      !force &&
      cached?.runtimeGeneration === runtime.runtimeGeneration
    ) {
      await cached.pending;
      return false;
    }

    const pending = this.runtime.ensureEnvironmentBrowserSession(runtime);
    const entry: CachedBrowserSession = {
      runtimeGeneration: runtime.runtimeGeneration,
      pending,
    };
    this.sessions.set(runtime.id, entry);
    try {
      return await pending;
    } catch (error) {
      if (this.sessions.get(runtime.id) === entry) {
        this.sessions.delete(runtime.id);
      }
      throw error;
    }
  }

  private queueViewportResize(
    runtime: EnvironmentRuntimeRecord,
    viewport: BrowserDashboardViewport,
  ) {
    let state = this.viewports.get(runtime.id);
    if (!state || state.runtimeGeneration !== runtime.runtimeGeneration) {
      state = { runtimeGeneration: runtime.runtimeGeneration };
      this.viewports.set(runtime.id, state);
    }

    const target = state.queued ?? state.inFlight ?? state.applied;
    if (sameViewport(target, viewport)) {
      return state.pending ?? Promise.resolve();
    }
    state.queued = viewport;
    if (!state.pending) {
      const current = state;
      current.pending = this.flushViewportResizes(runtime, current)
        .catch((error) => {
          current.queued = undefined;
          throw error;
        })
        .finally(() => {
          if (this.viewports.get(runtime.id) === current) {
            current.pending = undefined;
            current.inFlight = undefined;
          }
        });
    }
    return state.pending!;
  }

  private async flushViewportResizes(
    runtime: EnvironmentRuntimeRecord,
    state: BrowserViewportState,
  ) {
    while (state.queued) {
      const viewport = state.queued;
      state.queued = undefined;
      if (sameViewport(state.applied, viewport)) continue;
      state.inFlight = viewport;
      await this.runtime.resizeEnvironmentBrowserViewport(runtime, viewport);
      state.applied = viewport;
      state.inFlight = undefined;
    }
  }
}

function sameViewport(
  left: BrowserDashboardViewport | undefined,
  right: BrowserDashboardViewport,
) {
  return left?.width === right.width && left.height === right.height;
}

export function dashboardProxyPrefix(environmentId: string) {
  return `/api/v1/environments/${encodeURIComponent(environmentId)}/browser`;
}

export function dashboardAssetPath(value: string | undefined) {
  const normalized = (value ?? "").replace(/^\/+|\/+$/g, "");
  if (normalized === "") return "/";
  if (!DASHBOARD_ASSET_PATH.test(normalized)) {
    throw new HttpError(
      404,
      "environment_browser_asset_not_found",
      "Playwright Dashboard asset not found.",
    );
  }
  return `/${normalized}`;
}

export function dashboardAssetCacheControl(
  assetPath: string | undefined,
  upstreamCacheControl: string | null,
) {
  const normalized = assetPath?.replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === "index.html") {
    return "private, no-store";
  }
  const upstreamMaxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(
    upstreamCacheControl ?? "",
  )?.[1];
  const maxAge = Math.min(
    upstreamMaxAge ? Number(upstreamMaxAge) : 60 * 60,
    DASHBOARD_MAX_BROWSER_CACHE_SECONDS,
  );
  const immutable = DASHBOARD_FINGERPRINTED_ASSET.test(normalized)
    ? ", immutable"
    : "";
  return `private, max-age=${maxAge}${immutable}`;
}

export function dashboardRedirectLocation(
  location: string | null,
  proxyPrefix: string,
) {
  if (!location) return undefined;
  let target: URL;
  try {
    target = new URL(location, "https://playwright-dashboard.invalid");
  } catch {
    return undefined;
  }
  const socketId = target.searchParams.get("ws") ?? "";
  if (
    target.pathname !== "/index.html" ||
    !DASHBOARD_SOCKET_ID.test(socketId)
  ) {
    return undefined;
  }
  const dashboardSocketPath = `${proxyPrefix.replace(
    /^\/+/,
    "",
  )}/ws/${socketId}`;
  return `${proxyPrefix}/index.html?ws=${encodeURIComponent(dashboardSocketPath)}`;
}

export function rewriteDashboardHtml(html: string, proxyPrefix: string) {
  const rewritten = html.replace(
    /((?:src|href)=["'])\/(?!\/)/g,
    `$1${proxyPrefix}/`,
  );
  return embedBrowserDashboard(rewritten);
}

export function rewriteDashboardCss(css: string, proxyPrefix: string) {
  return css.replace(
    /url\((\s*)(["']?)\/(?!\/)/g,
    `url($1$2${proxyPrefix}/`,
  );
}
