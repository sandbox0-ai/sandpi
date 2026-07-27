import type { EnvironmentRuntimeAccessService } from "./runtime-access-service";
import { HttpError } from "@/server/http-error";
import type {
  RuntimeAdapter,
  RuntimeBrowserDashboard,
} from "@/server/runtime/types";

export interface BrowserDashboardUpstream {
  url: string;
  headers: Record<string, string>;
}

const DASHBOARD_SOCKET_ID = /^[A-Za-z0-9-]{1,128}$/;
const DASHBOARD_ASSET_PATH =
  /^(?:index\.html|playwright-logo\.svg|assets\/[A-Za-z0-9._-]+)$/;

/**
 * Owns only lifecycle, authorization and transport coordinates for the
 * official Playwright Dashboard. Browser control remains in Playwright.
 */
export class EnvironmentBrowserService {
  private readonly dashboards = new Map<
    string,
    Promise<RuntimeBrowserDashboard>
  >();

  constructor(
    private readonly runtimeAccess: EnvironmentRuntimeAccessService,
    private readonly runtime: RuntimeAdapter,
  ) {}

  async ensureSession(userId: string, environmentId: string) {
    await this.runtimeAccess.withRuntimeAccess(
      userId,
      environmentId,
      (runtime) => this.runtime.ensureEnvironmentBrowserSession(runtime),
    );
  }

  async openUrl(userId: string, environmentId: string, url: string) {
    await this.runtimeAccess.withRuntimeAccess(
      userId,
      environmentId,
      (runtime) => this.runtime.openEnvironmentBrowserUrl(runtime, url),
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
    this.dashboards.delete(environmentId);
  }

  private async dashboard(userId: string, environmentId: string) {
    let pending = this.dashboards.get(environmentId);
    if (!pending) {
      pending = this.runtimeAccess.withRuntimeAccess(
        userId,
        environmentId,
        (runtime) => this.runtime.ensureEnvironmentBrowserDashboard(runtime),
      );
      this.dashboards.set(environmentId, pending);
      void pending.catch(() => {
        if (this.dashboards.get(environmentId) === pending) {
          this.dashboards.delete(environmentId);
        }
      });
    } else {
      // Even cached coordinates must cross user ownership and Environment
      // lifecycle admission. The protected ingress cannot wake a paused
      // Sandbox independently from Sandpi's state machine.
      await this.runtimeAccess.withRuntimeAccess(
        userId,
        environmentId,
        async () => undefined,
      );
    }
    return pending;
  }
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
  return html.replace(/((?:src|href)=["'])\/(?!\/)/g, `$1${proxyPrefix}/`);
}
