import type { EnvironmentRuntimeAccessService } from "./runtime-access-service";
import { embedBrowserDashboard } from "./browser-dashboard-embed";
import { HttpError } from "@/server/http-error";
import type {
  EnvironmentRuntimeRecord,
  RuntimeAdapter,
  RuntimeBrowserUpstream,
} from "@/server/runtime/types";
import type {
  BrowserDashboardViewport,
  EnvironmentBrowserControl,
  EnvironmentBrowserOwner,
  EnvironmentBrowserOwnership,
} from "@/lib/environment-browser";

export interface BrowserDashboardUpstream {
  url: string;
  headers: Record<string, string>;
}

interface CachedBrowserDashboard {
  runtimeGeneration: number;
  restartRevision: number;
  pending: Promise<RuntimeBrowserUpstream>;
}

interface CachedBrowserSession {
  runtimeGeneration: number;
  pending: Promise<boolean>;
}

interface CachedBrowserTakeoverCapability {
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
 * Owns lifecycle, authorization and the exclusive human/agent handoff for one
 * Environment browser profile. Page automation remains in Playwright, while
 * human input remains an opaque VNC transport.
 */
export class EnvironmentBrowserService {
  private readonly dashboards = new Map<string, CachedBrowserDashboard>();
  private readonly dashboardRestartRevisions = new Map<string, number>();
  private readonly appliedDashboardRestartRevisions = new Map<string, number>();
  private readonly sessions = new Map<string, CachedBrowserSession>();
  private readonly takeoverCapabilities = new Map<
    string,
    CachedBrowserTakeoverCapability
  >();
  private readonly viewports = new Map<string, BrowserViewportState>();
  private readonly owners = new Map<string, EnvironmentBrowserOwner>();
  private readonly serviceOperations = new Map<string, Promise<unknown>>();

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
    requireAgentControl(await this.dashboard(userId, environmentId));
    await this.runtimeAccess.withRuntimeAccess(
      userId,
      environmentId,
      (runtime) => this.ensureRuntimeSession(runtime, force),
    );
  }

  async resizeViewport(
    userId: string,
    environmentId: string,
    viewport: BrowserDashboardViewport,
  ) {
    const owner = this.owners.get(environmentId);
    if (owner) {
      requireAgentControl({ owner });
    } else {
      requireAgentControl(await this.dashboard(userId, environmentId));
    }
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
    requireAgentControl(dashboard);
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
        "Invalid Environment browser socket id.",
      );
    }
    const dashboard = await this.dashboard(userId, environmentId);
    if (socketId === "vnc") {
      requireHumanControl(dashboard);
    } else {
      requireAgentControl(dashboard);
    }
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
    this.owners.delete(environmentId);
  }

  async control(
    userId: string,
    environmentId: string,
  ): Promise<EnvironmentBrowserControl> {
    const ownership = await this.dashboard(
      userId,
      environmentId,
    );
    return this.withTakeoverCapability(userId, environmentId, ownership);
  }

  async updateControl(
    userId: string,
    environmentId: string,
    input: { owner: EnvironmentBrowserOwner; force?: boolean },
  ) {
    return this.serializeServiceOperation(environmentId, async () => {
      const control = await this.runtimeAccess.withRuntimeAccess(
        userId,
        environmentId,
        async (runtime) => {
          const ownership =
            await this.runtime.updateEnvironmentBrowserControl(runtime, input);
          const takeoverAvailable =
            ownership.owner === "human"
              ? this.cacheTakeoverCapability(runtime, true)
              : await this.takeoverCapabilityForRuntime(runtime);
          return publicBrowserControl(ownership, takeoverAvailable);
        },
      );
      this.invalidateControlState(environmentId);
      this.owners.set(environmentId, control.owner);
      return control;
    });
  }

  private async withTakeoverCapability(
    userId: string,
    environmentId: string,
    ownership: EnvironmentBrowserOwnership,
  ): Promise<EnvironmentBrowserControl> {
    if (ownership.owner === "human") {
      return publicBrowserControl(ownership, true);
    }
    const takeoverAvailable = await this.serializeServiceOperation(
      environmentId,
      () =>
        this.runtimeAccess.withRuntimeAccess(
          userId,
          environmentId,
          (runtime) => this.takeoverCapabilityForRuntime(runtime),
        ),
    );
    return publicBrowserControl(ownership, takeoverAvailable);
  }

  private async takeoverCapabilityForRuntime(
    runtime: EnvironmentRuntimeRecord,
  ) {
    const cached = this.takeoverCapabilities.get(runtime.id);
    if (cached?.runtimeGeneration === runtime.runtimeGeneration) {
      return cached.pending;
    }
    const pending = this.runtime.isEnvironmentBrowserTakeoverAvailable(runtime);
    const entry = { runtimeGeneration: runtime.runtimeGeneration, pending };
    this.takeoverCapabilities.set(runtime.id, entry);
    try {
      return await pending;
    } catch (error) {
      if (this.takeoverCapabilities.get(runtime.id) === entry) {
        this.takeoverCapabilities.delete(runtime.id);
      }
      throw error;
    }
  }

  private cacheTakeoverCapability(
    runtime: EnvironmentRuntimeRecord,
    available: boolean,
  ) {
    this.takeoverCapabilities.set(runtime.id, {
      runtimeGeneration: runtime.runtimeGeneration,
      pending: Promise.resolve(available),
    });
    return available;
  }

  private async dashboard(userId: string, environmentId: string) {
    // A fresh AppService install and an ownership handoff are both full-spec
    // replacements. Linearize them so a concurrent first mount cannot restore
    // an agent-owned service after human takeover has committed.
    if (
      !this.dashboards.has(environmentId) ||
      this.serviceOperations.has(environmentId)
    ) {
      return this.ensureDashboard(userId, environmentId);
    }

    // Every request still crosses ownership and lifecycle admission. The cache
    // only avoids rewriting an identical AppService and is fenced by Sandbox0's
    // authoritative runtime generation.
    const cached = await this.runtimeAccess.withRuntimeAccess<
      RuntimeBrowserUpstream | undefined
    >(
      userId,
      environmentId,
      async (runtime) => {
        const restartRevision =
          this.dashboardRestartRevisions.get(environmentId) ?? 0;
        const entry = this.dashboards.get(environmentId);
        if (
          entry?.runtimeGeneration === runtime.runtimeGeneration &&
          entry.restartRevision === restartRevision
        ) {
          return entry.pending;
        }
        return undefined;
      },
    );
    if (cached) return cached;

    // Runtime-generation changes are rare. Re-admit after entering the service
    // queue so the replacement cannot race an ownership update.
    return this.ensureDashboard(userId, environmentId);
  }

  private ensureDashboard(
    userId: string,
    environmentId: string,
  ): Promise<RuntimeBrowserUpstream> {
    return this.serializeServiceOperation<RuntimeBrowserUpstream>(
      environmentId,
      () =>
        this.runtimeAccess.withRuntimeAccess<RuntimeBrowserUpstream>(
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
            const pending = this.runtime.ensureEnvironmentBrowserService(
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
              this.owners.set(environmentId, dashboard.owner);
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
        ),
    );
  }

  private serializeServiceOperation<T>(
    environmentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.serviceOperations.get(environmentId);
    const pending = (previous
      ? previous.catch(() => undefined)
      : Promise.resolve()
    ).then(operation);
    this.serviceOperations.set(environmentId, pending);
    void pending
      .finally(() => {
        if (this.serviceOperations.get(environmentId) === pending) {
          this.serviceOperations.delete(environmentId);
        }
      })
      .catch(() => undefined);
    return pending;
  }

  private restartDashboard(environmentId: string) {
    this.invalidate(environmentId);
    this.dashboardRestartRevisions.set(
      environmentId,
      (this.dashboardRestartRevisions.get(environmentId) ?? 0) + 1,
    );
  }

  private invalidateControlState(environmentId: string) {
    this.invalidate(environmentId);
    this.sessions.delete(environmentId);
    this.dashboardRestartRevisions.delete(environmentId);
    this.appliedDashboardRestartRevisions.delete(environmentId);
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

function publicBrowserControl(
  ownership: EnvironmentBrowserOwnership,
  takeoverAvailable: boolean,
): EnvironmentBrowserControl {
  return {
    owner: ownership.owner,
    transport: ownership.transport,
    revision: ownership.revision,
    takeoverAvailable,
  };
}

function sameViewport(
  left: BrowserDashboardViewport | undefined,
  right: BrowserDashboardViewport,
) {
  return left?.width === right.width && left.height === right.height;
}

function requireAgentControl(control: { owner: EnvironmentBrowserOwner }) {
  if (control.owner === "agent") return;
  throw new HttpError(
    409,
    "environment_browser_under_human_control",
    "The Environment browser is under human control. Return it to the agent before using Playwright.",
  );
}

function requireHumanControl(control: { owner: EnvironmentBrowserOwner }) {
  if (control.owner === "human") return;
  throw new HttpError(
    409,
    "environment_browser_under_agent_control",
    "Take control of the Environment browser before opening the interactive viewer.",
  );
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
  const fingerprinted = DASHBOARD_FINGERPRINTED_ASSET.test(normalized);
  const maxAge = fingerprinted
    ? DASHBOARD_MAX_BROWSER_CACHE_SECONDS
    : Math.min(
        upstreamMaxAge ? Number(upstreamMaxAge) : 60 * 60,
        DASHBOARD_MAX_BROWSER_CACHE_SECONDS,
      );
  const immutable = fingerprinted ? ", immutable" : "";
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
