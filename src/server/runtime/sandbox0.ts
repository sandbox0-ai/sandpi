import { isUtf8 } from "node:buffer";
import { createHash, createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { zstdDecompress } from "node:zlib";

import {
  APIError,
  Client,
  SandboxWaitTimeoutError,
  SandboxRuntimeMetricName,
  SandboxRuntimeMetricStatistic,
  models,
  runtime as generatedRuntime,
  type SandboxMetrics,
} from "sandbox0";

import type { BrowserDashboardViewport } from "@/lib/environment-browser";
import type {
  Environment,
  EnvironmentResourceMetrics,
  EnvironmentSandboxState,
  RuntimeMetricSeries,
  RuntimeMetrics,
  WorkspaceDirectoryListing,
  WorkspaceFile,
  WorkspaceFileSearchResult,
  WorkspaceGitState,
  WorkspaceIdeFile,
  WorkspaceLineChange,
} from "@/lib/types";
import type {
  EnvironmentCredentialMaterial,
  EnvironmentCredentialResolverKind,
} from "@/lib/environment-credentials";
import { toUnixTimestamp } from "@/lib/time";
import {
  repositoryForWorkspacePath,
  userVisibleWorkspaceGitState,
} from "@/lib/workspace-git";
import {
  isWorkspaceGitMetadataPath,
  isWorkspaceIdePathHidden,
  isWorkspaceInternalPath,
  userVisibleWorkspacePath,
  WORKSPACE_IGNORED_DIRECTORY_NAMES,
  WORKSPACE_INTERNAL_ROOT,
  WORKSPACE_ROOT,
} from "@/lib/workspace-path-policy";
import { detectWorkspaceFilePreview } from "@/lib/workspace-file-preview";
import { HttpError } from "@/server/http-error";
import {
  isCodexComposerUploadPath,
  MAX_CODEX_COMPOSER_UPLOAD_BYTES,
} from "@/server/harnesses/codex/input-files";
import { toSandbox0NetworkPolicy } from "./network-policy";
import {
  CODEX_ENVIRONMENT_CREDENTIAL_PATH,
  CODEX_MCP_OAUTH_CALLBACK_BASE_PATH,
  SANDPI_ENVIRONMENT_SKILL_ROOT,
  type EnsureCodexEnvironmentRuntimeOptions,
  type CodexAuthRuntime,
  type EnvironmentRuntimeRecord,
  type EnvironmentSandboxUsageProjection,
  type ProvisionedEnvironment,
  type RecoveredCodexEnvironmentRuntime,
  type RuntimeCredentialSourceMetadata,
  type RuntimeAdapter,
  type RuntimeBrowserDashboard,
  type RuntimeCodexEventStreamHandle,
  type RuntimeUsageWindowPage,
  type RuntimeEnvironmentEgressCredential,
  type RuntimeMcpOAuthCallbackService,
  type RuntimeProvisionEnvironmentInput,
  type RuntimeTerminalHandle,
  type RuntimeWorkspaceBackupSnapshot,
  type RuntimeWorkspaceWatchHandle,
  type Sandbox0AppService,
  type Sandbox0AppServiceView,
  type Sandbox0NetworkPolicy,
} from "./types";
import {
  SANDPI_ENVIRONMENT_SKILL_ASSETS,
  SANDPI_ENVIRONMENT_SKILL_NAME,
} from "./sandpi-environment-skill";
import {
  gitRepositoryRootsFromMarkers,
  lineChangesFromDiff,
  mergeLineChanges,
  parseGitStatus,
  wholeFileLineChanges,
} from "./git-workspace";
import {
  requireWorkspaceFileRevision,
  workspaceFileRevision,
} from "./workspace-edit";
import {
  isPlaywrightBrowserDependencyUnavailable,
  isPlaywrightBrowserNotOpen,
  PLAYWRIGHT_STALE_PROFILE_LOCK_RECOVERY_SCRIPT,
  playwrightProfilePathFromInUseError,
  playwrightStaleProfileLockRecoveryCommand,
  type PlaywrightCliResult,
} from "./playwright-browser-recovery";
import { reconcileTerminalReplayCursor } from "./terminal-replay";
import {
  terminalEnvironmentUpdate,
  terminalSessionEnvironment,
} from "./terminal-environment";

const EVENT_RETENTION_BYTES = 256 * 1024 * 1024;
const EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const CREDENTIAL_SOURCE_DELETE_RETRY_DELAYS_MS = [
  25, 50, 100, 250, 500, 1_000, 2_000,
] as const;
const SANDBOX_LIST_PAGE_SIZE = 100;
// Supervisor journals retain decoded event structures in procd memory as well
// as JSON on disk. A terminal only needs enough tail to rebuild xterm's visible
// history, so it must not inherit the much larger coding-agent event budget.
const TERMINAL_EVENT_RETENTION_BYTES = 4 * 1024 * 1024;
const ENVIRONMENT_CODEX_HOME = "/workspace/.sandpi/harnesses/codex";
const WORKSPACE_CODEX_LAYOUT_MARKER = `${ENVIRONMENT_CODEX_HOME}/.sandpi-layout-environment-v1`;
const ENVIRONMENT_CODEX_AUTH_FILE = CODEX_ENVIRONMENT_CREDENTIAL_PATH;
// Sandpi exposes native Skills and MCP servers, but it has no host surface for
// Codex Apps or plugin-install approvals. Keep their discovery tools out of
// Environment Turns so a request cannot wait forever on an unhandled approval.
const ENVIRONMENT_CODEX_DISABLED_FEATURES =
  "--disable apps --disable plugins --disable remote_plugin --disable tool_suggest";
const MCP_OAUTH_CALLBACK_SERVICE_ID = "sandpi-codex-mcp-oauth";
const MCP_OAUTH_CALLBACK_ROUTE_ID = "oauth-callback";
const MCP_OAUTH_CALLBACK_RATE_LIMIT_RPS = 5;
const MCP_OAUTH_CALLBACK_RATE_LIMIT_BURST = 10;
const BROWSER_DASHBOARD_SERVICE_ID = "sandpi-browser-dashboard";
const BROWSER_DASHBOARD_ROUTE_ID = "dashboard";
const BROWSER_DASHBOARD_PORT = 43_420;
const BROWSER_DASHBOARD_AUTH_HEADER = "X-Sandpi-Browser-Proxy";
const PLAYWRIGHT_CLI_TIMEOUT_SECONDS = 120;
const PLAYWRIGHT_AGENT_SKILL_VERSION_MARKER =
  `${WORKSPACE_INTERNAL_ROOT}/browser/playwright-cli-agent-skill-package-version`;
const PLAYWRIGHT_DASHBOARD_READY_SCRIPT = String.raw`
const net = require("node:net");

const port = Number(process.argv[1]);
const deadline = Date.now() + 30_000;
const connect = () => {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.once("connect", () => {
    socket.end();
    process.exit(0);
  });
  socket.once("error", () => {
    socket.destroy();
    if (Date.now() >= deadline) process.exit(1);
    setTimeout(connect, 25);
  });
};
connect();
`;
const PLAYWRIGHT_DASHBOARD_READY_SCRIPT_BASE64 = Buffer.from(
  PLAYWRIGHT_DASHBOARD_READY_SCRIPT,
  "utf8",
).toString("base64");
const PLAYWRIGHT_STALE_PROFILE_LOCK_RECOVERY_SCRIPT_BASE64 = Buffer.from(
  PLAYWRIGHT_STALE_PROFILE_LOCK_RECOVERY_SCRIPT,
  "utf8",
).toString("base64");
const PLAYWRIGHT_DASHBOARD_START_SCRIPT = [
  "recover_stale_profiles() {",
  "browser_running=1;",
  "for profile in /workspace/.cache/ms-playwright/daemon/*/ud-default-chrome-for-testing; do",
  'test -d "$profile" || continue;',
  "node -e 'eval(Buffer.from(process.env.SANDPI_PLAYWRIGHT_LOCK_RECOVERY_SCRIPT_BASE64, \"base64\").toString(\"utf8\"))' \"$profile\";",
  'recovery_status="$?";',
  'test "$recovery_status" -eq 12 && browser_running=0;',
  "done;",
  'return "$browser_running";',
  "};",
  "ensure_browser() {",
  "recover_stale_profiles && return 0;",
  'browser_error="$(playwright-cli open about:blank --browser chromium --persistent 2>&1)" && return 0;',
  'printf "%s\\n" "$browser_error" >&2;',
  'profile="$(printf "%s\\n" "$browser_error" | sed -n "s/.*Browser is already in use for \\([^,]*\\),.*/\\1/p" | tail -n 1)";',
  'test -n "$profile" || return 1;',
  "node -e 'eval(Buffer.from(process.env.SANDPI_PLAYWRIGHT_LOCK_RECOVERY_SCRIPT_BASE64, \"base64\").toString(\"utf8\"))' \"$profile\" || return 1;",
  "playwright-cli open about:blank --browser chromium --persistent;",
  "};",
  "wait_for_dashboard() {",
  "node -e 'eval(Buffer.from(process.env.SANDPI_PLAYWRIGHT_DASHBOARD_READY_SCRIPT_BASE64, \"base64\").toString(\"utf8\"))' \"$1\";",
  "};",
  `(wait_for_dashboard ${BROWSER_DASHBOARD_PORT} && ensure_browser;`,
  "while :; do",
  "sleep 15;",
  "ensure_browser;",
  "done) &",
  "exec playwright-cli show",
  `--host 0.0.0.0 --port ${BROWSER_DASHBOARD_PORT}`,
].join(" ");
const PLAYWRIGHT_CLI_ENVIRONMENT = {
  HOME: "/workspace",
  PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright",
  PLAYWRIGHT_MCP_BROWSER: "chromium",
  PLAYWRIGHT_MCP_ISOLATED: "false",
  PLAYWRIGHT_MCP_SANDBOX: "false",
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  NO_UPDATE_NOTIFIER: "1",
} as const;
const DEVICE_CODEX_HOME = "/dev/shm/sandpi-codex-device";
const DEVICE_CODEX_AUTH_FILE = `${DEVICE_CODEX_HOME}/auth.json`;
const CODEX_AUTH_MAX_BYTES = 4 * 1024 * 1024;
// Auth runners are short-lived credential flows, not durable Environment
// Sandboxes; retain a fail-safe lifetime if their cleanup process crashes.
const AUTH_SANDBOX_HARD_TTL_SECONDS = 30 * 60;
const MAX_GIT_DISCOVERY_DEPTH = 13;
const MAX_FILE_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_WORKSPACE_FILE_SEARCH_CANDIDATES = 500;
const MAX_WORKSPACE_FILE_SEARCH_RESULTS = 100;
const MAX_CODEX_ROLLOUT_BYTES = 16 * 1024 * 1024;
const CODEX_ROLLOUT_REPRESENTATION_RETRIES = 3;
const CODEX_ROLLOUT_REPRESENTATION_RETRY_MS = 50;
const GIT_STATUS_CONCURRENCY = 4;
const WORKSPACE_GIT_CACHE_TTL_MS = 2_000;
const WORKSPACE_GIT_CACHE_MAX_ENTRIES = 64;
const SANDBOX_AUTO_RESUME_TIMEOUT_MS = 120_000;
const SANDBOX_AUTO_RESUME_RETRY_DELAY_MS = 250;
const SANDBOX_RESUME_FAILURE_MAX_RETRIES = 1;
const SANDBOX0_TRANSPORT_RETRY_DELAYS_MS = [100, 250] as const;
// Sandbox0 commits the paused lifecycle before the deleted runtime Pod's
// finalizer finishes unbinding its ctld volume portal. Retry only that narrow,
// pre-mutation restore conflict while the asynchronous unbind catches up.
const WORKSPACE_RESTORE_UNMOUNT_RETRY_DELAYS_MS = [
  100, 250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000,
] as const;
// Sandbox0's File API lists one directory at a time. Keep cross-harness search
// as one bounded Sandbox command so large trees do not become recursive HTTP
// fan-out, and keep the capability below every coding-agent adapter.
const WORKSPACE_FILE_SEARCH_PRUNE_EXPRESSION = [
  "-name '.git'",
  ...WORKSPACE_IGNORED_DIRECTORY_NAMES.map(
    (name) => `-name ${shellSingleQuoted(name)}`,
  ),
].join(" -o ");
const WORKSPACE_FILE_SEARCH_COMMAND = `cd "$1"
find . -mindepth 1 \\
  \\( -type d \\( ${WORKSPACE_FILE_SEARCH_PRUNE_EXPRESSION} \\) \\) -prune -o \\
  \\( \\( -type f -o -type d \\) -a -ipath "$2" \\) \\
  -printf '%y\\0%p\\0' |
head -z -n ${MAX_WORKSPACE_FILE_SEARCH_CANDIDATES * 2}`;

type SdkRuntimeMetricSeries = SandboxMetrics["series"][number];
const decompressZstd = promisify(zstdDecompress);

function environmentSandboxState(sandbox: {
  paused: boolean;
  status: string;
}): EnvironmentSandboxState {
  if (sandbox.paused || sandbox.status === "paused") return "paused";
  switch (sandbox.status) {
    case "starting":
      return "provisioning";
    case "running":
      return "running";
    case "terminating":
      return "terminated";
    case "failed":
      return "failed";
    default:
      throw new HttpError(
        502,
        "sandbox0_lifecycle_state_invalid",
        `Sandbox0 returned unsupported lifecycle state ${JSON.stringify(sandbox.status)}.`,
      );
  }
}

function validDate(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export class Sandbox0Runtime implements RuntimeAdapter {
  readonly mode = "sandbox0" as const;
  private readonly client: Client;
  private readonly browserProxyKey: Buffer;
  private readonly workspaceGitCache = new Map<
    string,
    {
      expiresAt: number;
      value?: WorkspaceGitState;
      pending?: Promise<WorkspaceGitState>;
    }
  >();

  constructor(options: { apiHost: string; apiKey: string }) {
    this.browserProxyKey = createHash("sha256")
      .update("sandpi/browser-dashboard/v1\0", "utf8")
      .update(options.apiKey, "utf8")
      .digest();
    this.client = new Client({
      token: options.apiKey,
      baseUrl: options.apiHost,
      userAgent: "sandpi/0.1.0",
      // Reading Sandbox0 state is safe to retry and sits on every cold-start
      // and native-session recovery path. Keep mutation retries at their
      // semantic boundaries, where idempotency can be proven separately.
      fetch: fetchSandbox0WithRetry,
    });
  }

  async getEnvironmentSandboxState(
    sandboxId: string,
  ): Promise<EnvironmentSandboxState> {
    return (await this.getEnvironmentSandboxUsageProjection(sandboxId)).state;
  }

  async getEnvironmentSandboxUsageProjection(
    sandboxId: string,
  ): Promise<EnvironmentSandboxUsageProjection> {
    try {
      const sandbox = await this.client.sandboxes.get(sandboxId);
      const state = environmentSandboxState(sandbox);
      return {
        state,
        activeSince:
          state === "running" || state === "provisioning"
            ? validDate(sandbox.claimedAt)
            : undefined,
      };
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  supportsUsageWindows() {
    return Boolean(this.usageResource());
  }

  async listUsageWindows(
    options: {
      cursor?: string;
      limit?: number;
      windowType?: string;
    } = {},
  ): Promise<RuntimeUsageWindowPage> {
    // The public usage resource is supplied by the official Sandbox0 SDK. This
    // compatibility check allows Sandpi and sdk-js changes to be reviewed
    // independently, while deployed Sandpi must install the SDK release that
    // exposes client.usage before usage import can become ready.
    const usage = this.usageResource();
    if (!usage) {
      throw new HttpError(
        503,
        "sandbox0_usage_sdk_unavailable",
        "The installed Sandbox0 SDK does not expose the public usage resource.",
      );
    }
    return usage.listWindows(options);
  }

  private usageResource() {
    return (
      this.client as unknown as {
        usage?: {
          listWindows(input?: {
            cursor?: string;
            limit?: number;
            windowType?: string;
          }): Promise<RuntimeUsageWindowPage>;
        };
      }
    ).usage;
  }

  async provisionEnvironment(
    input: RuntimeProvisionEnvironmentInput,
  ): Promise<ProvisionedEnvironment> {
    let workspaceVolumeId = input.environment.workspaceVolumeId || undefined;
    let sandboxId: string | undefined;
    try {
      if (!workspaceVolumeId) {
        const volume = await this.client.volumes.create({
          accessMode: models.VolumeAccessMode.Rwo,
        });
        workspaceVolumeId = volume.id;
        await input.onResourcesAllocated?.({ workspaceVolumeId });
      }
      const sandbox = await this.client.sandboxes.claim(
        input.environment.templateId,
        {
          snapshotId: input.environment.rootfsSnapshotId || undefined,
          mounts: [
            {
              sandboxvolumeId: workspaceVolumeId,
              mountPoint: "/workspace",
            },
          ],
          // Sandpi owns idle-pause policy while Sandbox0 owns runtime wake-up.
          // Explicitly disable both Sandbox0 TTLs so deployment or template
          // defaults cannot terminate the durable Environment runtime.
          config: {
            ttl: 0,
            hardTtl: 0,
            autoResume: true,
            resources: {
              memory: `${input.environment.sandboxMemoryMiB}Mi`,
            },
            network: toSandbox0NetworkPolicy(
              input.environment.networkPolicy,
              input.credentials,
            ),
            services: [
              browserDashboardService(
                browserDashboardRequestToken(
                  this.browserProxyKey,
                  input.environment.id,
                ),
                0,
              ),
            ],
          },
        },
      );
      sandboxId = sandbox.id;
      await input.onResourcesAllocated?.({ sandboxId, workspaceVolumeId });
      await this.client.sandboxes.waitForLifecycle(
        sandbox.id,
        (state) => state.status === "running",
        { timeoutMs: 120_000 },
      );
      return {
        sandboxId,
        workspaceVolumeId,
      };
    } catch (error) {
      // The allocation journal owns retry/cleanup once a resource id has been
      // published. Only an unpublished Sandbox is safe to delete here.
      if (sandboxId) {
        await this.client.sandboxes.delete(sandboxId).catch(() => undefined);
      }
      throw translateSandbox0Error(error);
    }
  }

  async deleteEnvironmentResources(resources: Partial<ProvisionedEnvironment>) {
    const cleanupErrors: unknown[] = [];
    let sandboxGone = !resources.sandboxId;
    if (resources.sandboxId) {
      try {
        await this.client.sandboxes.delete(resources.sandboxId);
        sandboxGone = true;
      } catch (error) {
        if (isMissingResource(error)) sandboxGone = true;
        else cleanupErrors.push(error);
      }
    }
    if (resources.workspaceVolumeId && sandboxGone) {
      try {
        await this.client.volumes.delete(resources.workspaceVolumeId, {
          force: true,
        });
      } catch (error) {
        if (!isMissingResource(error)) cleanupErrors.push(error);
      }
    }
    if (resources.rootfsSnapshotId) {
      try {
        await this.client.sandboxes.deleteRootFSSnapshot(
          resources.rootfsSnapshotId,
        );
      } catch (error) {
        if (!isMissingResource(error)) cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "Sandbox0 Environment cleanup failed",
      );
    }
  }

  /**
   * Deletes obsolete Sandboxes that still mount this Environment's unique
   * Workspace Volume. A previous Sandpi server may have lost a provisioning
   * race after Sandbox0 accepted its claim, leaving credential bindings behind.
   */
  async deleteRetiredEnvironmentSandboxes(runtime: EnvironmentRuntimeRecord) {
    const candidates: Array<{ id: string }> = [];
    const cleanupErrors: unknown[] = [];
    for (let offset = 0; ; offset += SANDBOX_LIST_PAGE_SIZE) {
      let page: Awaited<ReturnType<Client["sandboxes"]["list"]>>;
      try {
        page = await this.client.sandboxes.list({
          limit: SANDBOX_LIST_PAGE_SIZE,
          offset,
        });
      } catch (error) {
        throw translateSandbox0Error(error);
      }
      candidates.push(...page.sandboxes);
      if (!page.hasMore) break;
    }
    for (const candidate of candidates) {
      if (candidate.id === runtime.sandboxId) continue;
      try {
        const sandbox = await this.client.sandboxes.get(candidate.id);
        const ownsWorkspace = (sandbox.mounts ?? []).some(
          (mount) =>
            mount.sandboxvolumeId === runtime.workspaceVolumeId &&
            mount.mountPoint === WORKSPACE_ROOT,
        );
        if (!ownsWorkspace) continue;
        await this.client.sandboxes.delete(candidate.id);
      } catch (error) {
        if (!isMissingResource(error)) cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors.map(translateSandbox0Error),
        "Retired Environment Sandbox cleanup failed",
      );
    }
  }

  async updateEnvironmentNetworkPolicy(
    runtime: EnvironmentRuntimeRecord,
    policy: Environment["networkPolicy"],
    credentials: RuntimeEnvironmentEgressCredential[] = [],
  ) {
    await this.applyEnvironmentSandboxNetworkPolicy(
      runtime,
      toSandbox0NetworkPolicy(policy, credentials),
    );
  }

  async getEnvironmentCredentialSource(
    sourceRef: string,
  ): Promise<RuntimeCredentialSourceMetadata | undefined> {
    try {
      return runtimeCredentialSourceMetadata(
        await this.client.credentialSources.get(sourceRef),
      );
    } catch (error) {
      if (isMissingResource(error)) return undefined;
      throw translateCredentialSourceControlError(error, "read");
    }
  }

  async createEnvironmentCredentialSource(
    sourceRef: string,
    resolverKind: EnvironmentCredentialResolverKind,
    material: EnvironmentCredentialMaterial,
  ): Promise<RuntimeCredentialSourceMetadata> {
    try {
      return runtimeCredentialSourceMetadata(
        await this.client.credentialSources.create(
          credentialSourceWriteRequest(sourceRef, resolverKind, material),
        ),
      );
    } catch (error) {
      throw translateCredentialSourceWriteError(error);
    }
  }

  async updateEnvironmentCredentialSource(
    sourceRef: string,
    resolverKind: EnvironmentCredentialResolverKind,
    material: EnvironmentCredentialMaterial,
  ): Promise<RuntimeCredentialSourceMetadata> {
    try {
      return runtimeCredentialSourceMetadata(
        await this.client.credentialSources.update(
          sourceRef,
          credentialSourceWriteRequest(sourceRef, resolverKind, material),
        ),
      );
    } catch (error) {
      throw translateCredentialSourceWriteError(error);
    }
  }

  async deleteEnvironmentCredentialSource(sourceRef: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.client.credentialSources.delete(sourceRef);
        return;
      } catch (error) {
        if (isMissingResource(error)) return;
        const retryDelay = CREDENTIAL_SOURCE_DELETE_RETRY_DELAYS_MS[attempt];
        if (
          error instanceof APIError &&
          error.statusCode === 409 &&
          retryDelay !== undefined
        ) {
          await delay(retryDelay);
          continue;
        }
        throw translateCredentialSourceControlError(error, "delete");
      }
    }
  }

  async updateEnvironmentMemory(
    runtime: EnvironmentRuntimeRecord,
    memoryMiB: number,
  ) {
    try {
      await this.client.sandboxes.updateMemory(
        runtime.sandboxId,
        `${memoryMiB}Mi`,
      );
    } catch (error) {
      if (
        error instanceof APIError &&
        error.statusCode >= 500 &&
        error.statusCode < 600 &&
        (await this.environmentMemoryMatches(runtime.sandboxId, memoryMiB))
      ) {
        return;
      }
      throw translateSandbox0Error(error);
    }
  }

  /**
   * Resolves an ambiguous mutation response only when Sandbox0's authoritative
   * state already matches the requested limit. Read failures preserve the
   * original mutation error.
   */
  private async environmentMemoryMatches(
    sandboxId: string,
    memoryMiB: number,
  ) {
    try {
      const sandbox = await this.client.sandboxes.get(sandboxId);
      return sandboxMemoryQuantityMiB(sandbox.resources?.memory) === memoryMiB;
    } catch {
      return false;
    }
  }

  async ensureEnvironmentMcpOAuthCallbackService(
    runtime: EnvironmentRuntimeRecord,
    input: { port: number },
  ): Promise<RuntimeMcpOAuthCallbackService> {
    if (
      !Number.isInteger(input.port) ||
      input.port < 1 ||
      input.port > 65_535
    ) {
      throw new HttpError(
        400,
        "invalid_mcp_oauth_callback_port",
        "The MCP OAuth callback port must be an integer between 1 and 65535.",
      );
    }

    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const existing = await sandbox.getServices();
      const services = existing.services
        .filter((service) => service.id !== MCP_OAUTH_CALLBACK_SERVICE_ID)
        .map(sandboxAppServiceFromView);
      services.push(mcpOAuthCallbackService(input.port));
      const updated = await sandbox.updateServices(services);
      const callback = updated.services.find(
        (service) => service.id === MCP_OAUTH_CALLBACK_SERVICE_ID,
      );
      if (!callback?.publicUrl) {
        throw new HttpError(
          502,
          "sandbox0_mcp_oauth_callback_unavailable",
          "Sandbox0 did not publish the MCP OAuth callback service.",
        );
      }
      return {
        port: input.port,
        publicUrl: callback.publicUrl,
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw translateSandbox0Error(error);
    }
  }

  async ensureEnvironmentBrowserDashboard(
    runtime: EnvironmentRuntimeRecord,
    restart = false,
  ): Promise<RuntimeBrowserDashboard> {
    const requestToken = browserDashboardRequestToken(
      this.browserProxyKey,
      runtime.id,
    );
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const existing = await sandbox.getServices();
      const currentDashboard = existing.services.find(
        (service) => service.id === BROWSER_DASHBOARD_SERVICE_ID,
      );
      const currentRevision = browserDashboardSessionRevision(currentDashboard);
      const desiredDashboard = browserDashboardService(
        requestToken,
        currentDashboard && restart ? currentRevision + 1 : currentRevision,
      );
      if (
        currentDashboard?.publicUrl &&
        sandboxAppServiceConfigurationMatches(
          currentDashboard,
          desiredDashboard,
        )
      ) {
        return {
          publicUrl: currentDashboard.publicUrl,
          requestHeaders: {
            [BROWSER_DASHBOARD_AUTH_HEADER]: requestToken,
          },
        };
      }
      const services = existing.services
        .filter((service) => service.id !== BROWSER_DASHBOARD_SERVICE_ID)
        .map(sandboxAppServiceFromView);
      services.push(desiredDashboard);
      let updated;
      try {
        updated = await sandbox.updateServices(services);
      } catch (error) {
        // A service-spec replacement may be committed before an upstream
        // gateway loses the response. Confirm the canonical stored value so
        // the first Browser mount does not surface a false failure or rewrite
        // the same service again.
        const confirmed = await sandbox.getServices().catch(() => undefined);
        const confirmedDashboard = confirmed?.services.find(
          (service) => service.id === BROWSER_DASHBOARD_SERVICE_ID,
        );
        if (
          !confirmedDashboard?.publicUrl ||
          !sandboxAppServiceConfigurationMatches(
            confirmedDashboard,
            desiredDashboard,
          )
        ) {
          throw error;
        }
        return {
          publicUrl: confirmedDashboard.publicUrl,
          requestHeaders: {
            [BROWSER_DASHBOARD_AUTH_HEADER]: requestToken,
          },
        };
      }
      const dashboard = updated.services.find(
        (service) => service.id === BROWSER_DASHBOARD_SERVICE_ID,
      );
      if (!dashboard?.publicUrl) {
        throw new HttpError(
          503,
          "environment_browser_exposure_unavailable",
          "Sandbox0 did not publish the protected Playwright Dashboard service.",
        );
      }
      return {
        publicUrl: dashboard.publicUrl,
        requestHeaders: {
          [BROWSER_DASHBOARD_AUTH_HEADER]: requestToken,
        },
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw translateSandbox0Error(error);
    }
  }

  async ensureEnvironmentBrowserSession(
    runtime: EnvironmentRuntimeRecord,
  ): Promise<boolean> {
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const tabs = await runPlaywrightCli(sandbox, ["tab-list"]);
      if (tabs.exitCode === 0) return false;
      if (!isPlaywrightBrowserNotOpen(tabs)) {
        requirePlaywrightCliSuccess(tabs);
      }
      await openPlaywrightBrowser(sandbox, "about:blank");
      return true;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw translateSandbox0Error(error);
    }
  }

  async openEnvironmentBrowserUrl(
    runtime: EnvironmentRuntimeRecord,
    url: string,
  ): Promise<boolean> {
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      // The Dashboard AppService supervises the shared browser. Optimistically
      // create the tab so the warm navigation path uses one Sandbox command
      // instead of probing and then issuing a second command.
      const openedTab = await runPlaywrightCli(sandbox, ["tab-new", url]);
      if (openedTab.exitCode === 0) return false;
      if (!isPlaywrightBrowserNotOpen(openedTab)) {
        requirePlaywrightCliSuccess(openedTab);
      }
      await openPlaywrightBrowser(sandbox, url);
      return true;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw translateSandbox0Error(error);
    }
  }

  async resizeEnvironmentBrowserViewport(
    runtime: EnvironmentRuntimeRecord,
    viewport: BrowserDashboardViewport,
  ): Promise<void> {
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      requirePlaywrightCliSuccess(
        await runPlaywrightCli(sandbox, [
          "resize",
          String(viewport.width),
          String(viewport.height),
        ]),
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw translateSandbox0Error(error);
    }
  }

  async createEnvironmentWorkspaceBackup(
    runtime: EnvironmentRuntimeRecord,
    input: { name: string; description: string },
  ): Promise<RuntimeWorkspaceBackupSnapshot> {
    try {
      const snapshot = await this.client.volumes.createSnapshot(
        runtime.workspaceVolumeId,
        input,
      );
      const nativeCreatedAt = new Date(snapshot.createdAt);
      return {
        id: snapshot.id,
        name: snapshot.name,
        sizeBytes: snapshot.sizeBytes,
        // Keep the newly created snapshot manageable even if an older
        // Sandbox0 deployment returns a malformed optional timestamp.
        createdAt: Number.isNaN(nativeCreatedAt.getTime())
          ? new Date()
          : nativeCreatedAt,
      };
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async deleteEnvironmentWorkspaceBackup(
    runtime: EnvironmentRuntimeRecord,
    snapshotId: string,
  ) {
    try {
      await this.client.volumes.deleteSnapshot(
        runtime.workspaceVolumeId,
        snapshotId,
      );
    } catch (error) {
      if (isMissingResource(error)) return;
      throw translateSandbox0Error(error);
    }
  }

  async restoreEnvironmentWorkspaceBackup(
    runtime: EnvironmentRuntimeRecord,
    snapshotId: string,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.client.volumes.restoreSnapshot(
          runtime.workspaceVolumeId,
          snapshotId,
        );
        return;
      } catch (error) {
        const delayMs = WORKSPACE_RESTORE_UNMOUNT_RETRY_DELAYS_MS[attempt];
        if (!isWorkspaceRestoreWaitingForUnmount(error) || delayMs === undefined) {
          throw translateSandbox0Error(error);
        }
        await delay(delayMs);
      }
    }
  }

  private async applyEnvironmentSandboxNetworkPolicy(
    runtime: EnvironmentRuntimeRecord,
    policy: Sandbox0NetworkPolicy,
  ) {
    try {
      await this.client.sandboxes
        .sandbox(runtime.sandboxId)
        .updateNetworkPolicy(policy);
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async applyEnvironmentLifecyclePolicy(runtime: EnvironmentRuntimeRecord) {
    try {
      await this.client.sandboxes.update(runtime.sandboxId, {
        config: {
          ttl: 0,
          hardTtl: 0,
          autoResume: true,
        },
      });
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async pauseEnvironment(
    runtime: EnvironmentRuntimeRecord,
    signal?: AbortSignal,
  ) {
    try {
      const current = await this.client.sandboxes.get(runtime.sandboxId);
      if (current.paused || current.status === "paused") return;
      await this.client.sandboxes.pauseAndWait(runtime.sandboxId, {
        timeoutMs: 120_000,
        signal,
      });
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async resumeEnvironment(
    runtime: EnvironmentRuntimeRecord,
    signal?: AbortSignal,
  ) {
    try {
      const current = await this.client.sandboxes.get(runtime.sandboxId);
      if (current.status === "running" && !current.paused) return;
      await this.client.sandboxes.resumeAndWait(runtime.sandboxId, {
        timeoutMs: 120_000,
        signal,
      });
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  private createCodexSupervisor(
    sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
    idempotencyKey: string,
  ) {
    return sandbox.createSession(
      {
        name: "codex-environment",
        command: [
          "/bin/sh",
          "-lc",
          `install -d -m 700 ${ENVIRONMENT_CODEX_HOME} && rm -rf ${ENVIRONMENT_CODEX_HOME}/auth.json && ln -s ${ENVIRONMENT_CODEX_AUTH_FILE} ${ENVIRONMENT_CODEX_HOME}/auth.json && while [ ! -s ${ENVIRONMENT_CODEX_AUTH_FILE} ]; do sleep 0.2; done && exec codex app-server --stdio -c 'cli_auth_credentials_store="file"' ${ENVIRONMENT_CODEX_DISABLED_FEATURES}`,
        ],
        cwd: "/workspace",
        env: { HOME: "/workspace", CODEX_HOME: ENVIRONMENT_CODEX_HOME },
        io: { mode: "pipes" },
        lifecycle: {
          restart: {
            policy: "always",
            initialBackoffMs: 500,
            maxBackoffMs: 10_000,
          },
          runtimeRecovery: "restart",
        },
        readiness: { type: "process" },
        eventRetention: {
          maxBytes: EVENT_RETENTION_BYTES,
          maxAgeSeconds: EVENT_RETENTION_SECONDS,
        },
      },
      { idempotencyKey },
    );
  }

  async provisionCodexAuth(
    environment: Environment,
    flowId: string,
  ): Promise<CodexAuthRuntime> {
    let sandboxId: string | undefined;
    try {
      // Every Environment uses Sandbox0's coding-agent template. This Auth
      // Runner claims that same template but mounts neither the Environment
      // Workspace Volume nor a rootfs snapshot. It is not a user Session.
      const sandbox = await this.client.sandboxes.claim(
        environment.templateId,
        {
          config: {
            hardTtl: AUTH_SANDBOX_HARD_TTL_SECONDS,
            network: toSandbox0NetworkPolicy(environment.networkPolicy),
          },
        },
      );
      sandboxId = sandbox.id;
      await this.client.sandboxes.waitForLifecycle(
        sandbox.id,
        (state) => state.status === "running",
        { timeoutMs: 120_000 },
      );
      const supervisor = await sandbox.createSession(
        {
          name: "codex-device-auth",
          command: [
            "/bin/sh",
            "-lc",
            `install -d -m 700 ${DEVICE_CODEX_HOME} /dev/shm/sandpi-home && printf '%s\n' 'cli_auth_credentials_store = "file"' > ${DEVICE_CODEX_HOME}/config.toml && exec codex app-server --stdio`,
          ],
          cwd: "/tmp",
          env: {
            HOME: "/dev/shm/sandpi-home",
            CODEX_HOME: DEVICE_CODEX_HOME,
          },
          io: { mode: "pipes" },
          lifecycle: {
            restart: { policy: "never" },
            runtimeRecovery: "restart",
          },
          readiness: { type: "process" },
          eventRetention: {
            maxBytes: 16 * 1024 * 1024,
            maxAgeSeconds: AUTH_SANDBOX_HARD_TTL_SECONDS,
          },
        },
        { idempotencyKey: `sandpi-codex-auth-${flowId}` },
      );
      const running = supervisor.attempt
        ? supervisor
        : await waitForAttempt(sandbox, supervisor.id);
      if (!running.attempt) {
        throw new Error(
          "Codex authentication Supervisor Session did not start",
        );
      }
      return {
        sandboxId: sandbox.id,
        supervisorSessionId: supervisor.id,
        attemptId: running.attempt.id,
        runtimeGeneration: running.runtimeGeneration,
      };
    } catch (error) {
      if (sandboxId) {
        await this.deleteCodexAuthResources({ sandboxId }).catch(
          () => undefined,
        );
      }
      throw translateSandbox0Error(error);
    }
  }

  async deleteCodexAuthResources(resources: Partial<CodexAuthRuntime>) {
    if (!resources.sandboxId) return;
    try {
      await this.client.sandboxes.delete(resources.sandboxId);
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async writeCodexAuthMessage(
    runtime: CodexAuthRuntime,
    message: unknown,
    stableInputId = randomUUID(),
  ) {
    await this.writeSupervisorMessage(runtime, message, stableInputId);
  }

  async listCodexAuthEvents(runtime: CodexAuthRuntime, after = 0) {
    return this.listSupervisorEvents(runtime, after);
  }

  private async listSupervisorEvents(
    runtime: Pick<CodexAuthRuntime, "sandboxId" | "supervisorSessionId">,
    after = 0,
  ) {
    try {
      const page = await this.client.sandboxes
        .sandbox(runtime.sandboxId)
        .listSessionEvents(runtime.supervisorSessionId, {
          after,
          limit: 1_000,
        });
      return {
        events: page.events.map((event) => ({
          ...event,
          occurredAt: event.occurredAt.toISOString(),
        })),
        cursor: page.cursor,
      };
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async readCodexAuthJson(runtime: CodexAuthRuntime) {
    const bytes = await this.client.sandboxes
      .sandbox(runtime.sandboxId)
      .readFile(DEVICE_CODEX_AUTH_FILE);
    if (bytes.byteLength === 0 || bytes.byteLength > CODEX_AUTH_MAX_BYTES) {
      throw new HttpError(
        502,
        "codex_credential_invalid",
        "Codex produced an invalid credential file.",
      );
    }
    return Buffer.from(bytes).toString("utf8");
  }

  async installCodexEnvironmentCredential(
    runtime: EnvironmentRuntimeRecord,
    authJson: string,
  ) {
    await installCodexCredential(
      this.client.sandboxes.sandbox(runtime.sandboxId),
      ENVIRONMENT_CODEX_AUTH_FILE,
      authJson,
    );
  }

  async readCodexEnvironmentCredential(runtime: EnvironmentRuntimeRecord) {
    const bytes = await this.client.sandboxes
      .sandbox(runtime.sandboxId)
      .readFile(ENVIRONMENT_CODEX_AUTH_FILE);
    if (bytes.byteLength === 0 || bytes.byteLength > CODEX_AUTH_MAX_BYTES) {
      throw new Error("Codex Environment credential file is invalid");
    }
    return Buffer.from(bytes).toString("utf8");
  }

  /**
   * Repairs only the native Environment access surface. Workspace and
   * Terminal requests call this after their first direct access proves that a
   * paused Sandbox or disconnected FUSE portal needs recovery.
   */
  async ensureEnvironmentRuntimeAccess(runtime: EnvironmentRuntimeRecord) {
    try {
      await this.ensureSandboxWorkspaceAccess(runtime.sandboxId);
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  /**
   * Reconciles one Environment with its shared native Sandbox0 runtime.
   * A lost Supervisor can be recreated because every native Codex Thread is
   * persisted under the Environment Workspace Volume.
   */
  async ensureCodexEnvironmentRuntime(
    runtime: EnvironmentRuntimeRecord,
    authJson: string,
    options: EnsureCodexEnvironmentRuntimeOptions = {},
  ): Promise<RecoveredCodexEnvironmentRuntime> {
    let sandboxRestarted = false;
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      // /dev/shm is intentionally outside both rootfs and Volume snapshots.
      // Make credential installation the wake-up boundary so the restarted
      // Supervisor can leave its credential wait as soon as Sandbox0 restores
      // the process, before Workspace/FUSE health checks complete.
      let credentialRuntimeGeneration =
        await this.materializeCodexEnvironmentCredentials(
          runtime.sandboxId,
          sandbox,
          authJson,
        );
      let lifecycle = await this.ensureSandboxWorkspaceAccess(
        runtime.sandboxId,
      );
      sandboxRestarted =
        runtime.runtimeGeneration > 0 &&
        lifecycle.runtimeGeneration !== runtime.runtimeGeneration;

      let supervisor;
      if (runtime.supervisorSessionId) {
        try {
          supervisor = await sandbox.getSession(runtime.supervisorSessionId);
        } catch (error) {
          if (
            !isMissingResource(error) &&
            !isWorkspaceTransportDisconnected(error)
          ) {
            throw error;
          }
        }
      }

      if (runtime.supervisorSessionId && !supervisor && !sandboxRestarted) {
        // The Workspace portal and procd's Supervisor-state portal can fail
        // independently. Give the original journal one lifecycle recovery
        // before deciding that its Supervisor metadata is truly gone.
        await this.client.sandboxes.pauseAndWait(runtime.sandboxId, {
          timeoutMs: 120_000,
        });
        await this.withSandboxAutoResume(runtime.sandboxId, () =>
          sandbox.listFiles("/workspace"),
        );
        lifecycle = await this.client.sandboxes.get(runtime.sandboxId);
        sandboxRestarted = true;
        try {
          supervisor = await sandbox.getSession(runtime.supervisorSessionId);
        } catch (error) {
          if (!isMissingResource(error)) throw error;
        }
      }

      if (credentialRuntimeGeneration !== lifecycle.runtimeGeneration) {
        // Workspace and Supervisor repair are allowed to pause the Sandbox
        // after the speculative early hydration above. /dev/shm is empty in
        // the resumed runtime, so hydrate the final Sandbox0 generation before
        // app-server initialization can be admitted.
        credentialRuntimeGeneration =
          await this.materializeCodexEnvironmentCredentials(
            runtime.sandboxId,
            sandbox,
            authJson,
          );
        if (credentialRuntimeGeneration !== lifecycle.runtimeGeneration) {
          throw codexRuntimeEpochChanged();
        }
      }

      await prepareEnvironmentCodexHome(sandbox);

      supervisor ??= await this.createCodexSupervisor(
        sandbox,
        `sandpi-codex-environment-${runtime.id}`,
      );

      if (options.replaceSupervisorAttempt && hasLiveAttempt(supervisor)) {
        const previousAttemptId = supervisor.attempt!.id;
        try {
          supervisor = await sandbox.createSessionAttempt(supervisor.id, true);
        } catch (error) {
          // A concurrent recovery can replace the same attempt first. Accept
          // only an observed live successor; an unchanged attempt means the
          // credential switch has not crossed the process boundary.
          if (!(error instanceof APIError) || error.statusCode !== 409) {
            throw error;
          }
          const raced = await sandbox.getSession(supervisor.id);
          if (
            !hasLiveAttempt(raced) ||
            raced.attempt?.id === previousAttemptId
          ) {
            throw error;
          }
          supervisor = raced;
        }
        if (
          !hasLiveAttempt(supervisor) ||
          supervisor.attempt?.id === previousAttemptId
        ) {
          supervisor = await waitForNewAttempt(
            sandbox,
            supervisor.id,
            previousAttemptId,
          );
        }
        if (
          !hasLiveAttempt(supervisor) ||
          supervisor.attempt?.id === previousAttemptId
        ) {
          throw new HttpError(
            502,
            "supervisor_credential_switch_failed",
            "Codex app-server did not restart with the current Environment credential.",
          );
        }
      }

      if (!hasLiveAttempt(supervisor) && supervisor.phase === "failed") {
        const previousAttemptId = supervisor.attempt?.id;
        try {
          // A failed Supervisor has exhausted its automatic restart window.
          // Reasserting the durable desired state resets that terminal phase
          // without replacing the Session specification or its journal.
          supervisor = await sandbox.setSessionDesiredState(
            supervisor.id,
            "running",
          );
        } catch (error) {
          if (!(error instanceof APIError) || error.statusCode !== 409) {
            throw error;
          }
          const raced = await sandbox.getSession(supervisor.id);
          if (!hasLiveAttempt(raced)) throw error;
          supervisor = raced;
        }
        if (
          !hasLiveAttempt(supervisor) ||
          supervisor.attempt?.id === previousAttemptId
        ) {
          supervisor = await waitForNewAttempt(
            sandbox,
            supervisor.id,
            previousAttemptId,
          );
        }
      }

      if (!hasLiveAttempt(supervisor)) {
        try {
          supervisor = await sandbox.createSessionAttempt(supervisor.id, true);
        } catch (error) {
          // runtimeRecovery can win this race immediately after Sandbox
          // resume. Accept a conflict only when Sandbox0 now proves that the
          // same Supervisor has a live attempt; other 409s remain actionable.
          if (!(error instanceof APIError) || error.statusCode !== 409)
            throw error;
          let raced;
          try {
            raced = await sandbox.getSession(supervisor.id);
          } catch (readError) {
            if (
              isMissingResource(readError) ||
              isWorkspaceTransportDisconnected(readError)
            ) {
              throw codexRuntimeEpochChanged(
                "The Codex Supervisor changed while its process attempt was being recovered.",
              );
            }
            throw readError;
          }
          if (!hasLiveAttempt(raced)) throw error;
          supervisor = raced;
        }
      }
      const running = hasLiveAttempt(supervisor)
        ? supervisor
        : await waitForAttempt(sandbox, supervisor.id);
      sandboxRestarted ||=
        runtime.runtimeGeneration > 0 &&
        running.runtimeGeneration !== runtime.runtimeGeneration;
      if (!running.attempt || running.attempt.finishedAt) {
        throw new HttpError(
          502,
          "supervisor_not_recovered",
          "Codex Supervisor did not recover a running attempt.",
        );
      }

      if (credentialRuntimeGeneration !== running.runtimeGeneration) {
        // An out-of-band Sandbox0 lifecycle change can still land between the
        // Workspace check and final Supervisor observation. Re-hydrate that
        // authoritative generation instead of trusting Sandpi's prior view.
        credentialRuntimeGeneration =
          await this.materializeCodexEnvironmentCredentials(
            runtime.sandboxId,
            sandbox,
            authJson,
          );
        if (credentialRuntimeGeneration !== running.runtimeGeneration) {
          throw codexRuntimeEpochChanged();
        }
      }

      return {
        supervisorSessionId: running.id,
        attemptId: running.attempt.id,
        runtimeGeneration: running.runtimeGeneration,
        sandboxRestarted,
      };
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  /**
   * Returns Sandbox0's authoritative generation after the ephemeral
   * credential write, allowing later repair to prove whether /dev/shm survived.
   */
  private async materializeCodexEnvironmentCredentials(
    sandboxId: string,
    sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
    authJson: string,
  ) {
    // Wake first, then fence the actual credential write on both sides. A
    // write followed by a Sandbox restart and only then a generation read must
    // never be mistaken for hydration of the new empty /dev/shm.
    await this.withSandboxAutoResume(sandboxId, () =>
      sandbox.mkdir(path.posix.dirname(ENVIRONMENT_CODEX_AUTH_FILE), true),
    );
    const before = await this.client.sandboxes.get(sandboxId);
    await this.withSandboxAutoResume(sandboxId, () =>
      installCodexCredential(sandbox, ENVIRONMENT_CODEX_AUTH_FILE, authJson),
    );
    const after = await this.client.sandboxes.get(sandboxId);
    if (before.runtimeGeneration !== after.runtimeGeneration) {
      throw codexRuntimeEpochChanged(
        "The Sandbox runtime changed while the Codex credential was being materialized.",
      );
    }
    return after.runtimeGeneration;
  }

  /**
   * Uses Workspace access as Sandbox0's native wake-up boundary and repairs a
   * stale FUSE portal with one pause/checkpoint cycle. This is shared by
   * harness-neutral access and harness-specific runtime reconciliation.
   */
  private async ensureSandboxWorkspaceAccess(sandboxId: string) {
    const sandbox = this.client.sandboxes.sandbox(sandboxId);
    try {
      // Sandbox0 serializes access with pause and restores a paused
      // auto-resume Sandbox. A gateway may answer `sandbox is waking up`
      // while that native transition commits; observe it instead of calling
      // the explicit resume endpoint.
      await this.withSandboxAutoResume(sandboxId, () =>
        sandbox.listFiles("/workspace"),
      );
      return await this.client.sandboxes.get(sandboxId);
    } catch (error) {
      if (!isWorkspaceTransportDisconnected(error)) throw error;
      const lifecycle = await this.client.sandboxes.get(sandboxId);
      if (!lifecycle.paused && lifecycle.status !== "paused") {
        await this.client.sandboxes.pauseAndWait(sandboxId, {
          timeoutMs: 120_000,
        });
      }
      // A second supported runtime access lets Sandbox0 auto-resume the
      // checkpoint; Sandpi never owns a separate resume state machine.
      await this.withSandboxAutoResume(sandboxId, () =>
        sandbox.listFiles("/workspace"),
      );
      return this.client.sandboxes.get(sandboxId);
    }
  }

  /**
   * Lets a supported runtime request trigger Sandbox0 auto-resume and waits for
   * the resulting native lifecycle transition. This deliberately never calls
   * the explicit resume endpoint; Sandpi only owns explicit pause operations.
   */
  private async withSandboxAutoResume<T>(
    sandboxId: string,
    access: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    let resumeFailureRetries = 0;
    while (true) {
      try {
        return await access();
      } catch (error) {
        if (isSandboxResumeFailed(error)) {
          if (resumeFailureRetries >= SANDBOX_RESUME_FAILURE_MAX_RETRIES) {
            throw sandboxAutoResumeFailed(sandboxId);
          }
          resumeFailureRetries += 1;
          const remainingMs =
            SANDBOX_AUTO_RESUME_TIMEOUT_MS - (Date.now() - startedAt);
          if (remainingMs <= 0) throw sandboxAutoResumeFailed(sandboxId);
          await delay(sandboxAutoResumeRetryDelay(error, remainingMs));
          continue;
        }
        if (!isSandboxWakingUp(error)) throw error;
        const remainingMs =
          SANDBOX_AUTO_RESUME_TIMEOUT_MS - (Date.now() - startedAt);
        if (remainingMs <= 0) throw sandboxAutoResumeTimeout(sandboxId);
        try {
          await this.client.sandboxes.waitForLifecycle(
            sandboxId,
            (sandbox) => sandbox.status === "running" && !sandbox.paused,
            { timeoutMs: remainingMs },
          );
        } catch (waitError) {
          if (waitError instanceof SandboxWaitTimeoutError) {
            throw sandboxAutoResumeTimeout(sandboxId);
          }
          throw waitError;
        }
        const retryRemainingMs =
          SANDBOX_AUTO_RESUME_TIMEOUT_MS - (Date.now() - startedAt);
        if (retryRemainingMs <= 0) throw sandboxAutoResumeTimeout(sandboxId);
        await delay(sandboxAutoResumeRetryDelay(error, retryRemainingMs));
      }
    }
  }

  async writeCodexMessage(
    runtime: EnvironmentRuntimeRecord,
    message: unknown,
    stableInputId = randomUUID(),
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const coordinates = requireCodexSupervisor(runtime);
    await this.writeSupervisorMessage(
      coordinates,
      message,
      stableInputId,
      signal,
    );
  }

  private async writeSupervisorMessage(
    runtime: CodexAuthRuntime,
    message: unknown,
    stableInputId: string,
    signal?: AbortSignal,
  ) {
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const supervisor = await this.getSupervisorSession(runtime, signal);
      if (!supervisor.attempt) {
        throw new HttpError(
          409,
          "supervisor_not_running",
          "The Codex Supervisor Session has no running attempt.",
        );
      }
      if (
        supervisor.attempt.id !== runtime.attemptId ||
        supervisor.runtimeGeneration !== runtime.runtimeGeneration
      ) {
        throw codexRuntimeEpochChanged(
          "The Codex Supervisor runtime changed. Refresh the Environment runtime before retrying.",
        );
      }
      const data = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
      const request = {
        inputId: codexSupervisorInputId(stableInputId, runtime.attemptId),
        expectedAttemptId: runtime.attemptId,
        dataBase64: data.toString("base64"),
      };
      // Supervisor input receipts deduplicate the same input id and content.
      // Retrying an ambiguous transport failure is therefore safe as long as
      // every attempt reuses this exact request.
      // The SDK convenience methods do not accept RequestInit, so cancellable
      // background work uses the public generated API with the same payload.
      await retrySandbox0Transport(
        () =>
          signal
            ? generatedData(
                this.client.apispec.sessions.apiV1SandboxesIdSessionsSessionIdInputsPost(
                  {
                    id: runtime.sandboxId,
                    sessionId: runtime.supervisorSessionId,
                    executionSessionInputRequest: request,
                  },
                  { signal },
                ),
                "write session input returned empty response",
              )
            : sandbox.writeSessionInput(runtime.supervisorSessionId, request),
        signal,
      );
    } catch (error) {
      const translated = await translateGeneratedSandbox0Error(error);
      if (
        translated instanceof HttpError &&
        translated.statusCode === 409 &&
        translated.message.toLowerCase().includes("attempt mismatch")
      ) {
        throw codexRuntimeEpochChanged(
          "The Codex Supervisor runtime changed before input was accepted.",
        );
      }
      throw translated;
    }
  }

  private async getSupervisorSession(
    runtime: Pick<CodexAuthRuntime, "sandboxId" | "supervisorSessionId">,
    signal?: AbortSignal,
  ) {
    try {
      if (signal) {
        return await generatedData(
          this.client.apispec.sessions.apiV1SandboxesIdSessionsSessionIdGet(
            {
              id: runtime.sandboxId,
              sessionId: runtime.supervisorSessionId,
            },
            { signal },
          ),
          "get session returned empty response",
        );
      }
      return await this.client.sandboxes
        .sandbox(runtime.sandboxId)
        .getSession(runtime.supervisorSessionId);
    } catch (error) {
      throw await translateGeneratedSandbox0Error(error);
    }
  }

  async watchCodexEvents(
    runtime: EnvironmentRuntimeRecord,
    after = 0,
    signal?: AbortSignal,
  ): Promise<RuntimeCodexEventStreamHandle> {
    const coordinates = requireCodexSupervisor(runtime);
    try {
      const stream = await this.client.sandboxes
        .sandbox(coordinates.sandboxId)
        .watchSessionEvents(coordinates.supervisorSessionId, { after, signal });
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            try {
              for await (const event of stream) {
                yield {
                  ...event,
                  occurredAt: event.occurredAt.toISOString(),
                };
              }
            } catch (error) {
              throw translateSandbox0Error(error);
            }
          },
        },
        close: () => stream.close(),
      };
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async listFiles(
    runtime: EnvironmentRuntimeRecord,
    requestedPath: string,
  ): Promise<WorkspaceDirectoryListing> {
    return listWorkspaceFiles(
      this.client.sandboxes.sandbox(runtime.sandboxId),
      requestedPath,
    );
  }

  async listPersistentWorkspaceFiles(
    runtime: EnvironmentRuntimeRecord,
    requestedPath: string,
  ): Promise<WorkspaceDirectoryListing> {
    try {
      return await listWorkspaceFiles(
        persistentWorkspaceFileReader(this.client, runtime.workspaceVolumeId),
        requestedPath,
      );
    } catch (error) {
      throw translateWorkspaceFileError(error);
    }
  }

  async searchFiles(
    runtime: EnvironmentRuntimeRecord,
    query: string,
  ): Promise<WorkspaceFileSearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    if (normalizedQuery.includes("\0")) {
      throw new HttpError(
        400,
        "workspace_file_search_query_invalid",
        "Workspace file search cannot contain a null byte.",
      );
    }

    try {
      const result = await this.client.sandboxes
        .sandbox(runtime.sandboxId)
        .cmd("search-workspace-files", {
          command: [
            "/bin/sh",
            "-ceu",
            WORKSPACE_FILE_SEARCH_COMMAND,
            "sandpi-workspace-file-search",
            WORKSPACE_ROOT,
            workspaceFileSearchPattern(normalizedQuery),
          ],
          cwd: WORKSPACE_ROOT,
          envVars: { LC_ALL: "C" },
          ttlSec: 10,
        });
      if (result.exitCode !== undefined && result.exitCode !== 0) {
        throw new HttpError(
          502,
          "workspace_file_search_failed",
          (result.stderr ?? "").trim() ||
            "Sandbox0 could not search the Workspace.",
        );
      }
      return workspaceFileSearchResults(result.stdout, normalizedQuery);
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async writeCodexComposerUpload(
    runtime: EnvironmentRuntimeRecord,
    requestedPath: string,
    content: Uint8Array,
  ) {
    const filePath = path.posix.normalize(requestedPath);
    if (!isCodexComposerUploadPath(filePath)) {
      throw new HttpError(
        400,
        "invalid_codex_file_upload_path",
        "Composer uploads must stay under Sandpi's protected upload directory.",
      );
    }
    if (
      content.byteLength === 0 ||
      content.byteLength > MAX_CODEX_COMPOSER_UPLOAD_BYTES
    ) {
      throw new HttpError(
        413,
        "codex_file_upload_too_large",
        "Uploaded files must be between 1 byte and 20 MiB.",
      );
    }

    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const directory = path.posix.dirname(filePath);
      await sandbox.mkdir(directory, true);
      // The directory is Sandpi-owned but remains inside an agent-writable
      // Workspace. Re-check every component before the File API write so an
      // agent-created symlink cannot redirect browser uploads.
      await assertWorkspacePathHasNoSymlink(sandbox, directory);
      await assertWorkspacePathHasNoSymlink(sandbox, filePath, true);
      await sandbox.writeFile(filePath, content);
    } catch (error) {
      throw translateWorkspaceFileError(error);
    }
  }

  async readFile(runtime: EnvironmentRuntimeRecord, requestedPath: string) {
    try {
      return (
        await readWorkspaceFileData(
          this.client.sandboxes.sandbox(runtime.sandboxId),
          requestedPath,
        )
      ).content;
    } catch (error) {
      throw translateWorkspaceFileError(error);
    }
  }

  async readPersistentWorkspaceFile(
    runtime: EnvironmentRuntimeRecord,
    requestedPath: string,
  ) {
    try {
      return (
        await readWorkspaceFileData(
          persistentWorkspaceFileReader(
            this.client,
            runtime.workspaceVolumeId,
          ),
          requestedPath,
        )
      ).content;
    } catch (error) {
      throw translateWorkspaceFileError(error);
    }
  }

  async readCodexRollout(
    runtime: EnvironmentRuntimeRecord,
    requestedPath: string,
    nativeSessionId: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const filePath = safeCodexRolloutPath(requestedPath, nativeSessionId);
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
    for (
      let attempt = 0;
      attempt < CODEX_ROLLOUT_REPRESENTATION_RETRIES;
      attempt += 1
    ) {
      try {
        return await readCodexRolloutRepresentation(sandbox, filePath, signal);
      } catch (error) {
        if (
          !(error instanceof HttpError) ||
          error.code !== "codex_rollout_representation_missing"
        ) {
          throw error;
        }
        if (attempt === CODEX_ROLLOUT_REPRESENTATION_RETRIES - 1) {
          throw new HttpError(
            404,
            "codex_rollout_not_found",
            "The native Codex rollout is no longer available.",
          );
        }
        await abortableDelay(CODEX_ROLLOUT_REPRESENTATION_RETRY_MS, signal);
      }
    }
    throw new Error("Codex rollout representation retry loop exhausted");
  }

  async getWorkspaceGitState(
    runtime: EnvironmentRuntimeRecord,
  ): Promise<WorkspaceGitState> {
    const key = workspaceRuntimeCacheKey(runtime);
    const cached = this.workspaceGitCache.get(key);
    if (cached?.value && cached.expiresAt > Date.now()) {
      this.workspaceGitCache.delete(key);
      this.workspaceGitCache.set(key, cached);
      return cached.value;
    }
    if (cached?.pending) return cached.pending;

    const entry: {
      expiresAt: number;
      value?: WorkspaceGitState;
      pending?: Promise<WorkspaceGitState>;
    } = { expiresAt: 0 };
    entry.pending = this.scanWorkspaceGitState(runtime).then(
      (value) => {
        if (this.workspaceGitCache.get(key) === entry) {
          entry.value = value;
          entry.expiresAt = Date.now() + WORKSPACE_GIT_CACHE_TTL_MS;
          entry.pending = undefined;
        }
        return value;
      },
      (error) => {
        if (this.workspaceGitCache.get(key) === entry) {
          this.workspaceGitCache.delete(key);
        }
        throw error;
      },
    );
    this.workspaceGitCache.set(key, entry);
    while (this.workspaceGitCache.size > WORKSPACE_GIT_CACHE_MAX_ENTRIES) {
      const oldest = this.workspaceGitCache.keys().next().value;
      if (oldest === undefined) break;
      this.workspaceGitCache.delete(oldest);
    }
    return entry.pending;
  }

  private async scanWorkspaceGitState(
    runtime: EnvironmentRuntimeRecord,
  ): Promise<WorkspaceGitState> {
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
    const discovered = await sandbox.cmd("find-git-repositories", {
      command: [
        "find",
        "/workspace",
        "-mindepth",
        "1",
        "-maxdepth",
        String(MAX_GIT_DISCOVERY_DEPTH),
        "(",
        "-path",
        WORKSPACE_INTERNAL_ROOT,
        "-o",
        "-type",
        "d",
        "(",
        "-name",
        ".*",
        "!",
        "-name",
        ".git",
        "-o",
        "-name",
        "node_modules",
        "-o",
        "-name",
        ".next",
        ")",
        ")",
        "-prune",
        "-o",
        "-name",
        ".git",
        "-print0",
        "-prune",
      ],
      cwd: "/workspace",
      envVars: { LC_ALL: "C" },
      ttlSec: 15,
    });
    if (discovered.exitCode !== undefined && discovered.exitCode !== 0) {
      return { repositories: [] };
    }
    const roots = gitRepositoryRootsFromMarkers(discovered.stdout).filter(
      (root) =>
        userVisibleWorkspacePath(root) === root &&
        !isWorkspaceIdePathHidden(root, true),
    );
    const repositories: WorkspaceGitState["repositories"] = [];
    for (
      let offset = 0;
      offset < roots.length;
      offset += GIT_STATUS_CONCURRENCY
    ) {
      const batch = await Promise.all(
        roots
          .slice(offset, offset + GIT_STATUS_CONCURRENCY)
          .map(async (root) => {
            try {
              const status = await this.runGit(runtime, root, [
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
              ]);
              return parseGitStatus(status, root);
            } catch {
              // A stale/invalid .git marker must not hide other repositories or
              // make a non-Git Workspace unusable in the file browser.
              return undefined;
            }
          }),
      );
      repositories.push(...batch.filter((item) => item !== undefined));
    }
    return userVisibleWorkspaceGitState({ repositories });
  }

  private invalidateWorkspaceGitState(runtime: EnvironmentRuntimeRecord) {
    this.workspaceGitCache.delete(workspaceRuntimeCacheKey(runtime));
  }

  async readWorkspaceIdeFile(
    runtime: EnvironmentRuntimeRecord,
    requestedPath: string,
  ): Promise<WorkspaceIdeFile> {
    const filePath = safeWorkspacePath(requestedPath);
    const sandpiManaged = isWorkspaceInternalPath(filePath);
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
    const verifiedFile = await assertWorkspacePathHasNoSymlink(
      sandbox,
      filePath,
      true,
    );
    const git = sandpiManaged
      ? { repositories: [] }
      : await this.getWorkspaceGitState(runtime);
    const repository = repositoryForWorkspacePath(git.repositories, filePath);
    const change = repository?.files.find(
      (candidate) => candidate.path === filePath,
    );
    let content: Uint8Array;
    let size: number | undefined;
    let modifiedAt: Date | undefined;

    try {
      const file = verifiedFile ?? (await sandbox.statFile(filePath));
      if (file.type !== "file") {
        throw new HttpError(
          400,
          "file_preview_not_regular",
          "Only regular files can be opened in the Web IDE.",
        );
      }
      if ((file.size ?? 0) > MAX_FILE_PREVIEW_BYTES) {
        throw new HttpError(
          413,
          "file_preview_too_large",
          "Files larger than 5 MiB cannot be opened in the Web IDE.",
        );
      }
      content = await sandbox.readFile(filePath);
      size = file.size;
      modifiedAt = file.modTime;
    } catch (error) {
      if (
        !change ||
        change.kind !== "deleted" ||
        !repository ||
        !isMissingResource(error)
      ) {
        throw error;
      }
      const relativePath = path.posix.relative(repository.root, filePath);
      const revision = change.staged
        ? `HEAD:${relativePath}`
        : `:${relativePath}`;
      content = Buffer.from(
        await this.runGit(runtime, repository.root, ["show", revision]),
      );
      size = content.byteLength;
    }

    if (content.byteLength > MAX_FILE_PREVIEW_BYTES) {
      throw new HttpError(
        413,
        "file_preview_too_large",
        "Files larger than 5 MiB cannot be opened in the Web IDE.",
      );
    }
    const name = path.posix.basename(filePath);
    const preview = detectWorkspaceFilePreview(name, content);
    const text =
      preview === undefined && isUtf8(content)
        ? Buffer.from(content).toString("utf8")
        : undefined;
    const lineCount =
      text === undefined
        ? 0
        : Math.max(1, text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
    let lineChanges: WorkspaceLineChange[] = [];

    if (text !== undefined && change && repository) {
      if (change.kind === "untracked") {
        lineChanges = wholeFileLineChanges(lineCount, "added", "unstaged");
      } else if (change.kind === "deleted") {
        const groups: WorkspaceLineChange[][] = [];
        if (change.staged) {
          groups.push(wholeFileLineChanges(lineCount, "deleted", "staged"));
        }
        if (change.unstaged) {
          groups.push(wholeFileLineChanges(lineCount, "deleted", "unstaged"));
        }
        lineChanges = mergeLineChanges(...groups);
      } else if (change.kind === "conflicted") {
        lineChanges = wholeFileLineChanges(
          lineCount,
          "modified",
          "unstaged",
        ).map((line) => ({ ...line, staged: change.staged }));
      } else {
        const relativePath = path.posix.relative(repository.root, filePath);
        const [stagedDiff, unstagedDiff] = await Promise.all([
          change.staged
            ? this.runGit(runtime, repository.root, [
                "diff",
                "--cached",
                "--no-color",
                "--no-ext-diff",
                "--unified=0",
                "--",
                relativePath,
              ])
            : "",
          change.unstaged
            ? this.runGit(runtime, repository.root, [
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--unified=0",
                "--",
                relativePath,
              ])
            : "",
        ]);
        lineChanges = mergeLineChanges(
          lineChangesFromDiff(stagedDiff, "staged"),
          lineChangesFromDiff(unstagedDiff, "unstaged"),
        );
      }
    }

    return {
      path: filePath,
      name,
      revision: workspaceFileRevision(content),
      encoding: "base64",
      content: Buffer.from(content).toString("base64"),
      kind: text === undefined ? "binary" : "text",
      preview,
      bom: hasUtf8Bom(content) ? "utf8" : undefined,
      editable:
        text !== undefined &&
        change?.kind !== "deleted" &&
        !sandpiManaged,
      readOnlyReason:
        text === undefined
          ? "binary"
          : change?.kind === "deleted"
            ? "deleted"
            : sandpiManaged
              ? "sandpi-managed"
              : undefined,
      size: size === undefined ? undefined : formatFileSize(size),
      modifiedAt: modifiedAt ? toUnixTimestamp(modifiedAt) : undefined,
      git: change,
      lineChanges,
    };
  }

  async readPersistentWorkspaceIdeFile(
    runtime: EnvironmentRuntimeRecord,
    requestedPath: string,
  ): Promise<WorkspaceIdeFile> {
    try {
      const { filePath, file, content } = await readWorkspaceFileData(
        persistentWorkspaceFileReader(
          this.client,
          runtime.workspaceVolumeId,
        ),
        requestedPath,
      );
      const name = path.posix.basename(filePath);
      const preview = detectWorkspaceFilePreview(name, content);
      const text =
        preview === undefined && isUtf8(content)
          ? Buffer.from(content).toString("utf8")
          : undefined;
      return {
        path: filePath,
        name,
        revision: workspaceFileRevision(content),
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        kind: text === undefined ? "binary" : "text",
        preview,
        bom: hasUtf8Bom(content) ? "utf8" : undefined,
        editable: false,
        readOnlyReason: "runtime-blocked",
        size: file.size === undefined ? undefined : formatFileSize(file.size),
        modifiedAt: file.modTime
          ? toUnixTimestamp(file.modTime)
          : undefined,
        lineChanges: [],
      };
    } catch (error) {
      throw translateWorkspaceFileError(error);
    }
  }

  async writeWorkspaceIdeFile(
    runtime: EnvironmentRuntimeRecord,
    requestedPath: string,
    content: Uint8Array,
    baseRevision: string,
  ): Promise<WorkspaceIdeFile> {
    const filePath = safeEditableWorkspacePath(requestedPath);
    if (content.byteLength > MAX_FILE_PREVIEW_BYTES) {
      throw new HttpError(
        413,
        "workspace_file_too_large",
        "Files larger than 5 MiB cannot be edited in the Web IDE.",
      );
    }
    if (!isUtf8(content)) {
      throw new HttpError(
        415,
        "workspace_file_not_utf8",
        "The Web IDE currently saves UTF-8 text files only.",
      );
    }

    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
    const file = await assertWorkspacePathHasNoSymlink(sandbox, filePath);
    if (!file) {
      throw new HttpError(
        404,
        "workspace_file_not_found",
        "The Workspace file no longer exists.",
      );
    }
    if (file.type !== "file") {
      throw new HttpError(
        400,
        "workspace_file_not_regular",
        "Only existing regular files can be edited in the Web IDE.",
      );
    }
    if ((file.size ?? 0) > MAX_FILE_PREVIEW_BYTES) {
      throw new HttpError(
        413,
        "workspace_file_too_large",
        "Files larger than 5 MiB cannot be edited in the Web IDE.",
      );
    }
    const current = await sandbox.readFile(filePath);
    if (!isUtf8(current)) {
      throw new HttpError(
        415,
        "workspace_file_not_utf8",
        "Binary files cannot be edited in the Web IDE.",
      );
    }
    // This rejects stale Sandpi clients and the store serializes browser saves
    // with Turn mutations. sdk-js does not yet expose an atomic If-Match write,
    // so a direct terminal write can still race between this check and writeFile.
    requireWorkspaceFileRevision(current, baseRevision);
    await sandbox.writeFile(filePath, content);
    this.invalidateWorkspaceGitState(runtime);
    return {
      path: filePath,
      name: path.posix.basename(filePath),
      revision: workspaceFileRevision(content),
      encoding: "base64",
      content: Buffer.from(content).toString("base64"),
      kind: "text",
      bom: hasUtf8Bom(content) ? "utf8" : undefined,
      editable: true,
      size: formatFileSize(content.byteLength),
      lineChanges: [],
    };
  }

  async createWorkspaceIdeEntry(
    runtime: EnvironmentRuntimeRecord,
    requestedParentPath: string,
    requestedName: string,
    kind: "file" | "folder",
  ): Promise<WorkspaceFile> {
    const parentPath = safeEditableWorkspacePath(requestedParentPath);
    const name = safeWorkspaceEntryName(requestedName);
    const entryPath = safeEditableWorkspacePath(path.posix.join(parentPath, name));
    if (isWorkspaceIdePathHidden(entryPath, kind === "folder")) {
      throw new HttpError(
        400,
        "workspace_entry_hidden",
        "Entries hidden by the Web IDE cannot be created from the file browser.",
      );
    }

    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
    try {
      const parent =
        parentPath === WORKSPACE_ROOT
          ? await sandbox.statFile(parentPath)
          : await assertWorkspacePathHasNoSymlink(sandbox, parentPath);
      if (!parent) {
        throw new HttpError(
          404,
          "workspace_entry_parent_not_found",
          "The target Workspace folder no longer exists.",
        );
      }
      if (parent.type !== "dir") {
        throw new HttpError(
          400,
          "workspace_entry_parent_not_directory",
          "New Workspace entries must be created inside a folder.",
        );
      }

      try {
        await sandbox.statFile(entryPath);
        throw new HttpError(
          409,
          "workspace_entry_exists",
          `“${name}” already exists in this folder.`,
        );
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (!isMissingResource(error)) throw error;
      }

      if (kind === "folder") {
        await sandbox.mkdir(entryPath);
      } else {
        await sandbox.writeFile(entryPath, new Uint8Array());
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof APIError && error.statusCode === 409) {
        throw new HttpError(
          409,
          "workspace_entry_exists",
          `“${name}” already exists in this folder.`,
        );
      }
      throw translateWorkspaceFileError(error);
    }

    this.invalidateWorkspaceGitState(runtime);
    return {
      id: Buffer.from(entryPath).toString("base64url"),
      name,
      path: entryPath,
      kind,
    };
  }

  async renameWorkspaceIdeEntry(
    runtime: EnvironmentRuntimeRecord,
    requestedPath: string,
    requestedName: string,
  ): Promise<WorkspaceFile> {
    const sourcePath = safeMutableWorkspaceEntryPath(requestedPath);
    const name = safeWorkspaceEntryName(requestedName);
    const destinationPath = safeEditableWorkspacePath(
      path.posix.join(path.posix.dirname(sourcePath), name),
    );
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);

    try {
      const sourceFile = await assertWorkspacePathHasNoSymlink(
        sandbox,
        sourcePath,
      );
      if (!sourceFile) {
        throw new HttpError(
          404,
          "workspace_entry_not_found",
          "The Workspace entry no longer exists.",
        );
      }
      const source = mutableWorkspaceEntryFromStat(
        sourcePath,
        sourceFile,
      );
      if (
        isWorkspaceIdePathHidden(
          destinationPath,
          source.kind === "folder",
        )
      ) {
        throw new HttpError(
          400,
          "workspace_entry_hidden",
          "Entries hidden by the Web IDE cannot be renamed from the file browser.",
        );
      }
      if (destinationPath === sourcePath) return source;

      try {
        await sandbox.statFile(destinationPath);
        throw new HttpError(
          409,
          "workspace_entry_exists",
          `“${name}” already exists in this folder.`,
        );
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (!isMissingResource(error)) throw error;
      }

      await sandbox.moveFile(sourcePath, destinationPath);
      this.invalidateWorkspaceGitState(runtime);
      return {
        ...source,
        id: Buffer.from(destinationPath).toString("base64url"),
        name,
        path: destinationPath,
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof APIError && error.statusCode === 409) {
        throw new HttpError(
          409,
          "workspace_entry_exists",
          `“${name}” already exists in this folder.`,
        );
      }
      throw translateWorkspaceEntryMutationError(error);
    }
  }

  async deleteWorkspaceIdeEntry(
    runtime: EnvironmentRuntimeRecord,
    requestedPath: string,
  ): Promise<WorkspaceFile> {
    const entryPath = safeMutableWorkspaceEntryPath(requestedPath);
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);

    try {
      const entryFile = await assertWorkspacePathHasNoSymlink(
        sandbox,
        entryPath,
      );
      if (!entryFile) {
        throw new HttpError(
          404,
          "workspace_entry_not_found",
          "The Workspace entry no longer exists.",
        );
      }
      const entry = mutableWorkspaceEntryFromStat(
        entryPath,
        entryFile,
      );
      await sandbox.deleteFile(entryPath);
      this.invalidateWorkspaceGitState(runtime);
      return entry;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw translateWorkspaceEntryMutationError(error);
    }
  }

  async watchWorkspaceFiles(
    runtime: EnvironmentRuntimeRecord,
    requestedPath: string,
  ): Promise<RuntimeWorkspaceWatchHandle> {
    const watchPath = safeWorkspacePath(requestedPath);
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
    await assertWorkspacePathHasNoSymlink(sandbox, watchPath);
    const watcher = await sandbox.watchFiles(watchPath, false);
    const invalidateGit = () => this.invalidateWorkspaceGitState(runtime);
    return {
      messages: {
        async *[Symbol.asyncIterator]() {
          for await (const message of watcher.events()) {
            if (message.type !== "event" || !message.event || !message.path) {
              continue;
            }
            const eventPath = userVisibleWorkspacePath(message.path);
            if (!eventPath) continue;
            invalidateGit();
            if (
              eventPath === "/workspace/.git" ||
              eventPath.includes("/.git/")
            ) {
              // Git mutates its metadata without necessarily touching a Workspace file
              // (for example `git add` and `git commit`). Emit one opaque sentinel so
              // clients refresh source control state without exposing `.git` contents.
              yield { event: `git:${message.event}`, path: "/workspace" };
              continue;
            }
            if (isWorkspaceIdePathHidden(eventPath)) {
              // Excluded generated directories are absent from the Workspace tree.
              continue;
            }
            yield { event: message.event, path: eventPath };
          }
        },
      },
      close: () => watcher.close(),
    };
  }

  private async runGit(
    runtime: EnvironmentRuntimeRecord,
    root: string,
    args: string[],
  ) {
    const result = await this.client.sandboxes
      .sandbox(runtime.sandboxId)
      .cmd("git", {
        command: ["git", "-C", root, ...args],
        cwd: root,
        envVars: { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
        ttlSec: 15,
      });
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      throw new HttpError(
        502,
        "workspace_git_failed",
        result.stderr.trim() || "Git could not inspect this Workspace.",
      );
    }
    return result.stdout;
  }

  private async getResourceGaugeMetrics(
    runtime: EnvironmentRuntimeRecord,
    window: { startedAt: Date; endedAt: Date },
    statistic: "average" | "last",
    maxPoints: number,
  ) {
    return this.client.sandboxes.sandbox(runtime.sandboxId).getMetrics({
      startTime: window.startedAt,
      endTime: window.endedAt,
      metrics: [
        SandboxRuntimeMetricName.SandboxCpuUtilization,
        SandboxRuntimeMetricName.SandboxMemoryWorkingSet,
        SandboxRuntimeMetricName.SandboxMemoryLimit,
      ],
      statistic,
      maxPoints,
    });
  }

  async getResourceMetrics(
    runtime: EnvironmentRuntimeRecord,
    window: { startedAt: Date; endedAt: Date },
  ): Promise<EnvironmentResourceMetrics> {
    try {
      const gauges = await this.getResourceGaugeMetrics(
        runtime,
        window,
        SandboxRuntimeMetricStatistic.Last,
        4,
      );
      const cpuUtilization = latestMetricValue(
        requireMetric(
          gauges.series,
          SandboxRuntimeMetricName.SandboxCpuUtilization,
        ),
      );
      const memoryWorkingSet = latestMetricValue(
        requireMetric(
          gauges.series,
          SandboxRuntimeMetricName.SandboxMemoryWorkingSet,
        ),
      );
      const memoryLimit = latestMetricValue(
        requireMetric(
          gauges.series,
          SandboxRuntimeMetricName.SandboxMemoryLimit,
        ),
      );
      return {
        cpuUtilization:
          cpuUtilization !== null && cpuUtilization >= 0
            ? cpuUtilization
            : null,
        memoryUtilization:
          memoryWorkingSet !== null &&
          memoryWorkingSet >= 0 &&
          memoryLimit !== null &&
          memoryLimit > 0
            ? memoryWorkingSet / memoryLimit
            : null,
      };
    } catch (error) {
      throw translateMetricsError(error);
    }
  }

  async getMetrics(
    runtime: EnvironmentRuntimeRecord,
    window: { startedAt: Date; endedAt: Date },
  ): Promise<RuntimeMetrics> {
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const gauges = await this.getResourceGaugeMetrics(
        runtime,
        window,
        SandboxRuntimeMetricStatistic.Average,
        120,
      );
      const network = await sandbox.getMetrics({
        startTime: window.startedAt,
        endTime: window.endedAt,
        metrics: [SandboxRuntimeMetricName.SandboxNetworkIo],
        statistic: SandboxRuntimeMetricStatistic.Rate,
        maxPoints: 120,
      });
      const cpu = requireMetric(
        gauges.series,
        SandboxRuntimeMetricName.SandboxCpuUtilization,
      );
      const memory = requireMetric(
        gauges.series,
        SandboxRuntimeMetricName.SandboxMemoryWorkingSet,
      );
      const memoryLimit = requireMetric(
        gauges.series,
        SandboxRuntimeMetricName.SandboxMemoryLimit,
      );
      const receive = requireMetric(
        network.series,
        SandboxRuntimeMetricName.SandboxNetworkIo,
        "receive",
      );
      const transmit = requireMetric(
        network.series,
        SandboxRuntimeMetricName.SandboxNetworkIo,
        "transmit",
      );

      return {
        cpuUtilization: metricProjection(cpu, gauges.stepSeconds),
        memoryWorkingSet: metricProjection(memory, gauges.stepSeconds),
        memoryLimitBytes:
          memoryLimit.segments.at(-1)?.points.at(-1)?.value ?? 0,
        networkReceive: metricProjection(receive, network.stepSeconds),
        networkTransmit: metricProjection(transmit, network.stepSeconds),
      };
    } catch (error) {
      throw translateMetricsError(error);
    }
  }

  async openTerminal(
    runtime: EnvironmentRuntimeRecord,
    after = 0,
    expectedTerminalSessionId?: string,
  ): Promise<RuntimeTerminalHandle> {
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
    let terminal: Awaited<ReturnType<typeof sandbox.getSession>> | undefined;
    if (runtime.terminalSessionId) {
      try {
        terminal = await sandbox.getSession(runtime.terminalSessionId);
      } catch (error) {
        if (!isMissingResource(error)) throw translateSandbox0Error(error);
      }
    }
    if (!terminal) {
      terminal = await sandbox.createSession(
        {
          name: "sandpi-terminal",
          command: ["/bin/bash", "-l"],
          cwd: "/workspace",
          env: terminalSessionEnvironment(),
          io: {
            mode: "pty",
            terminal: { rows: 28, cols: 120, term: "xterm-256color" },
          },
          lifecycle: {
            restart: { policy: "never" },
            runtimeRecovery: "restart",
          },
          readiness: { type: "process" },
          eventRetention: {
            maxBytes: TERMINAL_EVENT_RETENTION_BYTES,
            maxAgeSeconds: EVENT_RETENTION_SECONDS,
          },
        },
        { idempotencyKey: `sandpi-terminal-${runtime.id}` },
      );
    }

    const finishedAttemptId = terminal.attempt?.finishedAt
      ? terminal.attempt.id
      : undefined;
    const terminalStopped =
      finishedAttemptId !== undefined ||
      terminal.phase === "exited" ||
      terminal.phase === "failed" ||
      terminal.phase === "stopped";
    const terminalRetention = {
      maxBytes: TERMINAL_EVENT_RETENTION_BYTES,
      maxAgeSeconds: EVENT_RETENTION_SECONDS,
    };
    const retentionNeedsUpdate =
      terminal.spec.eventRetention?.maxBytes !== terminalRetention.maxBytes ||
      terminal.spec.eventRetention?.maxAgeSeconds !==
        terminalRetention.maxAgeSeconds;
    const environmentUpdate = terminalEnvironmentUpdate(
      terminal.spec.env,
      terminalStopped,
    );
    if (retentionNeedsUpdate || environmentUpdate) {
      // Sandbox0 replaces a running attempt when its process environment
      // changes. Apply that migration only after an explicit shell exit; a
      // browser reconnect must never interrupt Vim or another active TUI.
      terminal = await sandbox.updateSession(terminal.id, {
        ...terminal.spec,
        ...(environmentUpdate ? { env: environmentUpdate } : {}),
        eventRetention: terminalRetention,
      });
    }
    if (terminalStopped) {
      terminal = await sandbox.createSessionAttempt(terminal.id, true);
      if (!terminal.attempt || terminal.attempt.id === finishedAttemptId) {
        terminal = await waitForNewAttempt(
          sandbox,
          terminal.id,
          finishedAttemptId,
        );
      }
    }
    if (!terminal.attempt)
      terminal = await waitForAttempt(sandbox, terminal.id);
    if (!terminal.attempt) {
      throw new HttpError(502, "terminal_not_ready", "Terminal did not start.");
    }
    const terminalSessionChanged = Boolean(
      expectedTerminalSessionId && expectedTerminalSessionId !== terminal.id,
    );
    const replay = reconcileTerminalReplayCursor(
      after,
      terminal.cursor,
      terminalSessionChanged,
    );
    const connection = await sandbox.connectSession(terminal.id, {
      after: replay.after,
    });
    const attemptId = terminal.attempt.id;
    return {
      sessionId: terminal.id,
      attemptId,
      replayAfter: replay.after,
      replayUntil: terminal.cursor.latest,
      replayReset: replay.reset,
      messages: {
        async *[Symbol.asyncIterator]() {
          for await (const message of connection.messages()) {
            yield {
              ...message,
              event: message.event
                ? {
                    seq: message.event.seq,
                    attemptId: message.event.attemptId,
                    stream: message.event.stream,
                    dataBase64: message.event.dataBase64,
                    type: message.event.type,
                    occurredAt: toUnixTimestamp(message.event.occurredAt),
                  }
                : undefined,
            };
          }
        },
      },
      send(message) {
        if (message.type === "input") {
          connection.send({
            type: "input",
            requestId: message.requestId,
            inputId: message.requestId,
            expectedAttemptId: attemptId,
            dataBase64: Buffer.from(message.data ?? []).toString("base64"),
          });
          return;
        }
        if (message.type === "resize") {
          connection.send({
            type: "resize",
            requestId: message.requestId,
            expectedAttemptId: attemptId,
            rows: message.rows ?? 28,
            cols: message.cols ?? 120,
          });
          return;
        }
        connection.send({
          type: "signal",
          requestId: message.requestId,
          expectedAttemptId: attemptId,
          signal: message.signal ?? "TERM",
        });
      },
      close: () => connection.close(),
    };
  }
}

function sandboxAppServiceFromView(
  service: Sandbox0AppService | Sandbox0AppServiceView,
): Sandbox0AppService {
  return {
    id: service.id,
    displayName: service.displayName,
    port: service.port,
    runtime: service.runtime
      ? {
          ...service.runtime,
          command: service.runtime.command
            ? [...service.runtime.command]
            : undefined,
          envVars: service.runtime.envVars
            ? { ...service.runtime.envVars }
            : undefined,
        }
      : undefined,
    ingress: {
      ...service.ingress,
      routes: service.ingress.routes?.map((route) => ({
        ...route,
        methods: route.methods ? [...route.methods] : undefined,
        auth: route.auth ? { ...route.auth } : undefined,
        cors: route.cors
          ? {
              ...route.cors,
              allowedOrigins: route.cors.allowedOrigins
                ? [...route.cors.allowedOrigins]
                : undefined,
              allowedMethods: route.cors.allowedMethods
                ? [...route.cors.allowedMethods]
                : undefined,
              allowedHeaders: route.cors.allowedHeaders
                ? [...route.cors.allowedHeaders]
                : undefined,
              exposeHeaders: route.cors.exposeHeaders
                ? [...route.cors.exposeHeaders]
                : undefined,
            }
          : undefined,
        rateLimit: route.rateLimit ? { ...route.rateLimit } : undefined,
      })),
    },
    healthCheck: service.healthCheck ? { ...service.healthCheck } : undefined,
  };
}

function sandboxAppServiceConfigurationMatches(
  current: Sandbox0AppServiceView,
  desired: Sandbox0AppService,
) {
  return isDeepStrictEqual(
    sandboxAppServiceComparableConfiguration(current),
    sandboxAppServiceComparableConfiguration(desired),
  );
}

function sandboxAppServiceComparableConfiguration(
  service: Sandbox0AppService | Sandbox0AppServiceView,
) {
  // Generated SDK response models retain optional keys with undefined values,
  // while hand-authored request models omit those keys. They serialize to the
  // same API contract and must not trigger an AppService restart.
  return JSON.parse(JSON.stringify(sandboxAppServiceFromView(service)));
}

function browserDashboardSessionRevision(
  service: Sandbox0AppServiceView | undefined,
) {
  const value = Number(
    service?.runtime?.envVars?.SANDPI_BROWSER_SESSION_REVISION ?? 0,
  );
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function browserDashboardRequestToken(
  browserProxyKey: Buffer,
  environmentId: string,
) {
  return createHmac("sha256", browserProxyKey)
    .update(environmentId, "utf8")
    .digest("base64url");
}

function browserDashboardService(
  requestToken: string,
  sessionRevision: number,
): Sandbox0AppService {
  return {
    id: BROWSER_DASHBOARD_SERVICE_ID,
    displayName: "Sandpi Browser",
    port: BROWSER_DASHBOARD_PORT,
    runtime: {
      type: models.SandboxAppServiceRuntimeTypeEnum.Cmd,
      // The public ingress starts this process lazily. Prewarming Chromium in
      // the same Sandbox-native service lifetime overlaps it with Dashboard
      // readiness and avoids multiple high-latency control API commands.
      command: ["sh", "-c", PLAYWRIGHT_DASHBOARD_START_SCRIPT],
      cwd: "/workspace",
      envVars: {
        ...PLAYWRIGHT_CLI_ENVIRONMENT,
        SANDPI_PLAYWRIGHT_DASHBOARD_READY_SCRIPT_BASE64:
          PLAYWRIGHT_DASHBOARD_READY_SCRIPT_BASE64,
        SANDPI_PLAYWRIGHT_LOCK_RECOVERY_SCRIPT_BASE64:
          PLAYWRIGHT_STALE_PROFILE_LOCK_RECOVERY_SCRIPT_BASE64,
        SANDPI_BROWSER_SESSION_REVISION: String(sessionRevision),
      },
    },
    ingress: {
      _public: true,
      routes: [
        {
          id: BROWSER_DASHBOARD_ROUTE_ID,
          pathPrefix: "/",
          methods: ["GET"],
          auth: {
            mode: models.SandboxAppServiceRouteAuthModeEnum.Header,
            headerName: BROWSER_DASHBOARD_AUTH_HEADER,
            headerValueSha256: createHash("sha256")
              .update(requestToken, "utf8")
              .digest("hex"),
          },
          // Sandpi authenticates and authorizes every proxy request before it
          // adds the secret header. Let this protected ingress perform the
          // Sandbox-native auto-resume instead of issuing a separate control
          // API command solely to wake the Environment.
          resume: true,
        },
      ],
    },
  };
}

function runPlaywrightCli(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
  args: string[],
) {
  return sandbox.cmd("playwright-cli", {
    command: ["playwright-cli", ...args],
    cwd: "/workspace",
    envVars: { ...PLAYWRIGHT_CLI_ENVIRONMENT },
    wait: true,
    ttlSec: PLAYWRIGHT_CLI_TIMEOUT_SECONDS,
  });
}

async function openPlaywrightBrowser(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
  url: string,
) {
  const args = [
    "open",
    url,
    "--browser",
    "chromium",
    "--persistent",
  ];
  let result = await runPlaywrightCli(sandbox, args);
  if (result.exitCode === 0) return;

  const profilePath = playwrightProfilePathFromInUseError(result.stderr);
  const recoveryCommand =
    profilePath &&
    playwrightStaleProfileLockRecoveryCommand(profilePath);
  if (recoveryCommand) {
    const recovery = await sandbox.cmd("playwright-profile-lock-recovery", {
      command: recoveryCommand,
      cwd: "/workspace",
      envVars: { ...PLAYWRIGHT_CLI_ENVIRONMENT },
      wait: true,
      ttlSec: PLAYWRIGHT_CLI_TIMEOUT_SECONDS,
    });
    if (recovery.exitCode === 0) {
      result = await runPlaywrightCli(sandbox, args);
      if (result.exitCode === 0) return;
    }
  }
  requirePlaywrightCliSuccess(result);
}

function requirePlaywrightCliSuccess(result: PlaywrightCliResult) {
  if (result.exitCode === 0) return;
  if (isPlaywrightBrowserDependencyUnavailable(result)) {
    throw new HttpError(
      503,
      "environment_browser_dependency_unavailable",
      "This Environment does not include a compatible Playwright CLI and Chromium. Recreate it with the current coding-agent template.",
    );
  }
  throw new HttpError(
    503,
    "environment_browser_recovery_failed",
    "The shared Environment browser could not be recovered. Retry after the Environment finishes resuming.",
  );
}

function mcpOAuthCallbackService(port: number): Sandbox0AppService {
  return {
    id: MCP_OAUTH_CALLBACK_SERVICE_ID,
    displayName: "Codex MCP OAuth callback",
    port,
    runtime: { type: models.SandboxAppServiceRuntimeTypeEnum.Manual },
    ingress: {
      _public: true,
      routes: [
        {
          id: MCP_OAUTH_CALLBACK_ROUTE_ID,
          pathPrefix: `${CODEX_MCP_OAUTH_CALLBACK_BASE_PATH}/`,
          methods: ["GET"],
          auth: {
            mode: models.SandboxAppServiceRouteAuthModeEnum.None,
          },
          rateLimit: {
            rps: MCP_OAUTH_CALLBACK_RATE_LIMIT_RPS,
            burst: MCP_OAUTH_CALLBACK_RATE_LIMIT_BURST,
          },
          // An unauthenticated callback must never wake a paused Environment.
          resume: false,
        },
      ],
    },
  };
}

/**
 * procd input receipts bind an input id to one process attempt. Hashing both
 * coordinates keeps retries idempotent within that attempt while allowing the
 * same logical Codex RPC frame to be replayed after the Supervisor restarts.
 * The fixed ASCII form also avoids forwarding unbounded or unsafe native ids.
 */
function codexSupervisorInputId(stableInputId: string, attemptId: string) {
  const digest = createHash("sha256")
    .update(JSON.stringify([stableInputId, attemptId]))
    .digest("hex");
  return `sandpi-input-${digest}`;
}

function requireCodexSupervisor(runtime: EnvironmentRuntimeRecord) {
  if (!runtime.supervisorSessionId || !runtime.attemptId) {
    throw new HttpError(
      409,
      "codex_runtime_not_ready",
      "The Environment Codex runtime is not ready.",
    );
  }
  return {
    sandboxId: runtime.sandboxId,
    supervisorSessionId: runtime.supervisorSessionId,
    attemptId: runtime.attemptId,
    runtimeGeneration: runtime.runtimeGeneration,
  };
}

function codexRuntimeEpochChanged(
  message = "The Codex Supervisor runtime changed during credential recovery.",
) {
  return new HttpError(409, "codex_runtime_epoch_changed", message);
}

async function prepareEnvironmentCodexHome(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
) {
  const command = `set -eu
internal=${WORKSPACE_INTERNAL_ROOT}
harnesses=/workspace/.sandpi/harnesses
home=${ENVIRONMENT_CODEX_HOME}
marker=${WORKSPACE_CODEX_LAYOUT_MARKER}
browser=/workspace/.sandpi/browser
skills=${SANDPI_ENVIRONMENT_SKILL_ROOT}
sandpi_skill="$skills/${SANDPI_ENVIRONMENT_SKILL_NAME}"
sandpi_skill_agents="$sandpi_skill/agents"
playwright_skill_marker=${PLAYWRIGHT_AGENT_SKILL_VERSION_MARKER}
test ! -L "$internal"
test ! -L "$harnesses"
test ! -L "$browser"
test ! -L "$skills"
test ! -L "$sandpi_skill"
test ! -L "$sandpi_skill_agents"
install -d -m 700 "$internal" "$harnesses" "$browser" "$skills" "$sandpi_skill" "$sandpi_skill_agents"
test ! -L "$home"
install -d -m 700 "$home"
install_managed_file() {
  target="$1"
  encoded="$2"
  temporary="$target.tmp"
  test ! -L "$target"
  test ! -L "$temporary"
  if [ -e "$target" ]; then test -f "$target"; fi
  if [ -e "$temporary" ]; then test -f "$temporary"; fi
  printf '%s' "$encoded" | base64 -d > "$temporary"
  chmod 600 "$temporary"
  if [ -f "$target" ] && cmp -s "$target" "$temporary"; then
    rm -f "$temporary"
  else
    mv -f "$temporary" "$target"
  fi
}
install_managed_file "$sandpi_skill/SKILL.md" "$SANDPI_ENVIRONMENT_SKILL_MD_BASE64"
install_managed_file "$sandpi_skill_agents/openai.yaml" "$SANDPI_ENVIRONMENT_SKILL_OPENAI_YAML_BASE64"
if [ -f "$marker" ]; then
  test "$(cat "$marker")" = environment_v1
else
  printf '%s\\n' environment_v1 > "$marker"
  chmod 600 "$marker"
fi
if command -v playwright-cli >/dev/null 2>&1; then
  playwright_cli_path="$(readlink -f "$(command -v playwright-cli)")"
  playwright_package_json="$(dirname "$playwright_cli_path")/package.json"
  playwright_skill_version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$playwright_package_json" | head -n 1)"
  test -n "$playwright_skill_version"
  test ! -L "$playwright_skill_marker"
  test ! -L "$playwright_skill_marker.tmp"
  if [ ! -f "$playwright_skill_marker" ] || [ "$(cat "$playwright_skill_marker")" != "$playwright_skill_version" ]; then
    NO_UPDATE_NOTIFIER=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 playwright-cli install --skills=agents
    printf '%s\\n' "$playwright_skill_version" > "$playwright_skill_marker.tmp"
    chmod 600 "$playwright_skill_marker.tmp"
    mv -f "$playwright_skill_marker.tmp" "$playwright_skill_marker"
  fi
fi
rm -rf "$home/auth.json"
if [ -L "$home/.credentials.json" ] && [ "$(readlink "$home/.credentials.json")" = "/dev/shm/sandpi-codex-mcp-oauth.json" ]; then
  rm -f "$home/.credentials.json"
fi
ln -s ${ENVIRONMENT_CODEX_AUTH_FILE} "$home/auth.json"
sync -f /workspace 2>/dev/null || sync`;
  const result = await sandbox.cmd("prepare-environment-codex-home", {
    command: ["/bin/sh", "-lc", command],
    cwd: "/workspace",
    envVars: {
      SANDPI_ENVIRONMENT_SKILL_MD_BASE64: Buffer.from(
        SANDPI_ENVIRONMENT_SKILL_ASSETS.skill,
        "utf8",
      ).toString("base64"),
      SANDPI_ENVIRONMENT_SKILL_OPENAI_YAML_BASE64: Buffer.from(
        SANDPI_ENVIRONMENT_SKILL_ASSETS.interfaceYaml,
        "utf8",
      ).toString("base64"),
    },
    ttlSec: 60,
  });
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    throw new HttpError(
      502,
      "codex_home_prepare_failed",
      "Unable to prepare Codex native state in the Environment Workspace.",
    );
  }
}

async function installCodexCredential(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
  authFile: string,
  authJson: string,
) {
  const bytes = Buffer.from(authJson, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > CODEX_AUTH_MAX_BYTES) {
    throw new HttpError(
      500,
      "codex_credential_invalid",
      "Stored Codex credentials are invalid.",
    );
  }
  await sandbox.mkdir(path.posix.dirname(authFile), true);
  await sandbox.writeFile(authFile, bytes);
  const result = await sandbox.cmd(`chmod 600 ${authFile}`, { wait: true });
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    throw new Error("Unable to protect the ephemeral Codex credential file");
  }
}

async function waitForAttempt(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
  supervisorSessionId: string,
) {
  const deadline = Date.now() + 30_000;
  let session = await sandbox.getSession(supervisorSessionId);
  while (!hasLiveAttempt(session) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    session = await sandbox.getSession(supervisorSessionId);
  }
  return session;
}

function hasLiveAttempt(
  session: Awaited<
    ReturnType<ReturnType<Client["sandboxes"]["sandbox"]>["getSession"]>
  >,
) {
  return Boolean(session.attempt && !session.attempt.finishedAt);
}

async function waitForNewAttempt(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
  supervisorSessionId: string,
  previousAttemptId?: string,
) {
  const deadline = Date.now() + 30_000;
  let session = await sandbox.getSession(supervisorSessionId);
  while (
    (!hasLiveAttempt(session) || session.attempt?.id === previousAttemptId) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    session = await sandbox.getSession(supervisorSessionId);
  }
  return session;
}

function shellSingleQuoted(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function workspaceFileSearchPattern(query: string) {
  const fuzzyCharacters = Array.from(query, (character) =>
    "\\*?[]".includes(character) ? `\\${character}` : character,
  );
  return `*${fuzzyCharacters.join("*")}*`;
}

function workspaceFileSearchResults(
  stdout: string,
  query: string,
): WorkspaceFileSearchResult[] {
  const fields = stdout.split("\0");
  const seen = new Set<string>();
  const matches: Array<{
    result: WorkspaceFileSearchResult;
    score: number;
  }> = [];

  for (
    let index = 0;
    index + 1 < fields.length &&
    matches.length < MAX_WORKSPACE_FILE_SEARCH_CANDIDATES;
    index += 2
  ) {
    const entryType = fields[index];
    const candidate = fields[index + 1];
    if ((entryType !== "f" && entryType !== "d") || !candidate) {
      continue;
    }
    const absolutePath = path.posix.isAbsolute(candidate)
      ? path.posix.normalize(candidate)
      : path.posix.resolve(WORKSPACE_ROOT, candidate);
    const visiblePath = userVisibleWorkspacePath(absolutePath);
    const folder = entryType === "d";
    if (
      !visiblePath ||
      visiblePath === WORKSPACE_ROOT ||
      isWorkspaceIdePathHidden(visiblePath, folder) ||
      seen.has(visiblePath)
    ) {
      continue;
    }
    const name = path.posix.basename(visiblePath);
    const score = workspaceFileSearchScore(name, visiblePath, query);
    if (!Number.isFinite(score)) continue;
    seen.add(visiblePath);
    matches.push({
      result: {
        name,
        path: visiblePath,
        kind: folder ? "folder" : "file",
      },
      score,
    });
  }

  return matches
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.result.path.localeCompare(right.result.path),
    )
    .slice(0, MAX_WORKSPACE_FILE_SEARCH_RESULTS)
    .map(({ result }) => result);
}

function workspaceFileSearchScore(
  name: string,
  absolutePath: string,
  query: string,
) {
  const normalizedQuery = query.toLowerCase();
  const normalizedName = name.toLowerCase();
  const relativePath = absolutePath
    .slice(`${WORKSPACE_ROOT}/`.length)
    .toLowerCase();
  const nameFuzzyScore = fuzzySubsequenceScore(normalizedName, normalizedQuery);
  const pathFuzzyScore = fuzzySubsequenceScore(relativePath, normalizedQuery);
  if (!Number.isFinite(nameFuzzyScore) && !Number.isFinite(pathFuzzyScore)) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = Math.max(pathFuzzyScore, nameFuzzyScore + 500);
  if (normalizedName === normalizedQuery) {
    score += 10_000;
  } else if (normalizedName.startsWith(normalizedQuery)) {
    score += 5_000;
  } else {
    const substringIndex = normalizedName.indexOf(normalizedQuery);
    if (substringIndex >= 0) score += 2_500 - substringIndex;
  }
  return score - relativePath.split("/").length;
}

function fuzzySubsequenceScore(candidate: string, query: string) {
  let cursor = 0;
  let previousIndex = -2;
  let score = 0;
  for (const character of query) {
    const index = candidate.indexOf(character, cursor);
    if (index < 0) return Number.NEGATIVE_INFINITY;
    const consecutive = index === previousIndex + 1;
    const boundary =
      index === 0 || "/._- ".includes(candidate[index - 1] ?? "");
    score += (consecutive ? 24 : 4) + (boundary ? 20 : 0);
    score -= Math.max(0, index - cursor);
    cursor = index + 1;
    previousIndex = index;
  }
  return score - Math.max(0, candidate.length - query.length);
}

function safeWorkspacePath(requestedPath: string) {
  const visible = userVisibleWorkspacePath(requestedPath || "/workspace");
  if (visible) return visible;
  throw new HttpError(
    400,
    "invalid_workspace_path",
    "Path must stay under /workspace.",
  );
}

function safeCodexRolloutPath(requestedPath: string, nativeSessionId: string) {
  const normalized = path.posix.normalize(requestedPath);
  const roots = [
    `${ENVIRONMENT_CODEX_HOME}/sessions`,
    `${ENVIRONMENT_CODEX_HOME}/archived_sessions`,
  ];
  const underManagedRoot = roots.some((root) => {
    const relative = path.posix.relative(root, normalized);
    return relative !== "" && relative !== ".." && !relative.startsWith("../");
  });
  if (
    !path.posix.isAbsolute(requestedPath) ||
    normalized !== requestedPath ||
    !underManagedRoot ||
    !path.posix.basename(normalized).endsWith(`-${nativeSessionId}.jsonl`)
  ) {
    throw new HttpError(
      403,
      "codex_rollout_path_invalid",
      "Codex returned an invalid rollout path.",
    );
  }
  return normalized;
}

async function readCodexRolloutRepresentation(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
  plainPath: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const plainFile = await assertCodexRolloutPathHasNoSymlink(
    sandbox,
    plainPath,
    true,
  );
  try {
    if (plainFile) {
      return await readBoundedCodexRolloutFile(
        sandbox,
        plainPath,
        signal,
        plainFile,
      );
    }
  } catch (error) {
    if (!isMissingResource(error)) throw error;
  }

  const compressedPath = `${plainPath}.zst`;
  const compressedFile = await assertCodexRolloutPathHasNoSymlink(
    sandbox,
    compressedPath,
    true,
  );
  if (!compressedFile) {
    throw new HttpError(
      404,
      "codex_rollout_representation_missing",
      "Codex rollout representation is changing.",
    );
  }
  let compressed: Uint8Array;
  try {
    compressed = await readBoundedCodexRolloutFile(
      sandbox,
      compressedPath,
      signal,
      compressedFile,
    );
  } catch (error) {
    if (!isMissingResource(error)) throw error;
    throw new HttpError(
      404,
      "codex_rollout_representation_missing",
      "Codex rollout representation is changing.",
    );
  }

  try {
    const content = await decompressZstd(compressed, {
      maxOutputLength: MAX_CODEX_ROLLOUT_BYTES,
    });
    signal?.throwIfAborted();
    return content;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_BUFFER_TOO_LARGE"
    ) {
      throw new HttpError(
        413,
        "codex_rollout_too_large",
        "This Codex rollout is too large to load as Session Activity.",
      );
    }
    throw new HttpError(
      502,
      "codex_rollout_decompression_failed",
      "The compressed Codex rollout could not be decoded.",
    );
  }
}

async function assertCodexRolloutPathHasNoSymlink(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
  filePath: string,
  allowMissingLeaf: boolean,
) {
  const relative = path.posix.relative("/workspace", filePath);
  const components = relative.split("/").filter(Boolean);
  const paths = components.map((_, index) =>
    path.posix.join("/workspace", ...components.slice(0, index + 1)),
  );
  const files = await Promise.all(
    paths.map(async (componentPath, index) => {
      try {
        return await sandbox.statFile(componentPath);
      } catch (error) {
        if (
          allowMissingLeaf &&
          index === paths.length - 1 &&
          isMissingResource(error)
        ) {
          return undefined;
        }
        throw error;
      }
    }),
  );
  for (const file of files) {
    if (file && (file.type === "symlink" || file.isLink)) {
      throw new HttpError(
        403,
        "codex_rollout_path_symlink",
        "Codex rollout activity cannot be read through a symbolic link.",
      );
    }
  }
  return files.at(-1);
}

async function readBoundedCodexRolloutFile(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
  filePath: string,
  signal?: AbortSignal,
  knownFile?: Awaited<ReturnType<typeof sandbox.statFile>>,
) {
  signal?.throwIfAborted();
  const file = knownFile ?? (await sandbox.statFile(filePath));
  if (file.type !== "file") {
    throw new HttpError(
      502,
      "codex_rollout_not_regular",
      "The native Codex rollout is not a regular file.",
    );
  }
  if ((file.size ?? 0) > MAX_CODEX_ROLLOUT_BYTES) {
    throw new HttpError(
      413,
      "codex_rollout_too_large",
      "This Codex rollout is too large to load as Session Activity.",
    );
  }
  const content = await sandbox.readFile(filePath);
  signal?.throwIfAborted();
  if (content.byteLength > MAX_CODEX_ROLLOUT_BYTES) {
    throw new HttpError(
      413,
      "codex_rollout_too_large",
      "This Codex rollout is too large to load as Session Activity.",
    );
  }
  return content;
}

function safeEditableWorkspacePath(requestedPath: string) {
  const filePath = safeWorkspacePath(requestedPath);
  if (isWorkspaceInternalPath(filePath)) {
    throw new HttpError(
      403,
      "workspace_internal_path_protected",
      "Sandpi-managed Workspace state is read-only in the Web IDE.",
    );
  }
  if (isWorkspaceGitMetadataPath(filePath)) {
    throw new HttpError(
      403,
      "workspace_git_metadata_protected",
      "Git metadata cannot be edited from the Web IDE.",
    );
  }
  return filePath;
}

function safeMutableWorkspaceEntryPath(requestedPath: string) {
  const entryPath = safeEditableWorkspacePath(requestedPath);
  if (entryPath === WORKSPACE_ROOT) {
    throw new HttpError(
      403,
      "workspace_root_protected",
      "The Workspace root cannot be renamed or deleted.",
    );
  }
  return entryPath;
}

function safeWorkspaceEntryName(requestedName: string) {
  const name = requestedName.trim();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    Buffer.byteLength(name, "utf8") > 255 ||
    /[/\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new HttpError(
      400,
      "workspace_entry_name_invalid",
      "Use a file or folder name without slashes or control characters.",
    );
  }
  return name;
}

function mutableWorkspaceEntryFromStat(
  entryPath: string,
  file: {
    type?: string;
    size?: number;
    modTime?: Date;
    isLink?: boolean;
  },
): WorkspaceFile {
  if (file.type === "symlink" || file.isLink) {
    throw new HttpError(
      403,
      "workspace_symlink_not_editable",
      "Symbolic links cannot be changed from the Web IDE.",
    );
  }
  const kind =
    file.type === "dir"
      ? ("folder" as const)
      : file.type === "file"
        ? ("file" as const)
        : undefined;
  if (!kind) {
    throw new HttpError(
      400,
      "workspace_entry_not_supported",
      "Only regular files and folders can be changed from the Web IDE.",
    );
  }
  if (isWorkspaceIdePathHidden(entryPath, kind === "folder")) {
    throw new HttpError(
      403,
      "workspace_entry_hidden",
      "Entries hidden by the Web IDE cannot be changed from the file browser.",
    );
  }
  return {
    id: Buffer.from(entryPath).toString("base64url"),
    name: path.posix.basename(entryPath),
    path: entryPath,
    kind,
    size: file.size === undefined ? undefined : formatFileSize(file.size),
    modifiedAt: file.modTime ? toUnixTimestamp(file.modTime) : undefined,
  };
}

interface NativeWorkspaceFile {
  name?: string;
  path?: string;
  type?: string;
  size?: number;
  modTime?: Date;
  isLink?: boolean;
}

interface WorkspaceFileReader {
  statFile(filePath: string): Promise<NativeWorkspaceFile>;
  listFiles(filePath: string): Promise<NativeWorkspaceFile[]>;
  readFile(filePath: string): Promise<Uint8Array>;
}

function workspaceVolumePath(filePath: string) {
  const relative = path.posix.relative(WORKSPACE_ROOT, filePath);
  return relative ? `/${relative}` : "/";
}

function persistentWorkspaceFileReader(
  client: Client,
  workspaceVolumeId: string,
): WorkspaceFileReader {
  return {
    statFile: (filePath) =>
      client.volumes.statFile(
        workspaceVolumeId,
        workspaceVolumePath(filePath),
      ),
    listFiles: (filePath) =>
      client.volumes.listFiles(
        workspaceVolumeId,
        workspaceVolumePath(filePath),
      ),
    readFile: (filePath) =>
      client.volumes.readFile(
        workspaceVolumeId,
        workspaceVolumePath(filePath),
      ),
  };
}

async function listWorkspaceFiles(
  reader: WorkspaceFileReader,
  requestedPath: string,
): Promise<WorkspaceDirectoryListing> {
  const root = safeWorkspacePath(requestedPath);
  await assertWorkspacePathHasNoSymlink(reader, root);
  const nativeEntries = await reader.listFiles(root);
  const entries: WorkspaceFile[] = [...nativeEntries]
    .sort((left, right) => {
      const leftFolder = left.type === "dir";
      const rightFolder = right.type === "dir";
      if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
      return (left.name ?? "").localeCompare(right.name ?? "");
    })
    .flatMap((entry) => {
      const entryName = entry.name ?? path.posix.basename(entry.path ?? "");
      if (!entryName) return [];
      const visibleEntryPath = userVisibleWorkspacePath(
        path.posix.join(root, entryName),
      );
      if (!visibleEntryPath) return [];
      const folder = entry.type === "dir";
      if (isWorkspaceIdePathHidden(visibleEntryPath, folder)) return [];
      return [
        {
          id: Buffer.from(visibleEntryPath).toString("base64url"),
          name: entryName,
          path: visibleEntryPath,
          kind: folder ? ("folder" as const) : ("file" as const),
          size:
            entry.size === undefined ? undefined : formatFileSize(entry.size),
          modifiedAt: entry.modTime
            ? toUnixTimestamp(entry.modTime)
            : undefined,
        },
      ];
    });
  return { path: root, entries, refreshedAt: toUnixTimestamp(new Date()) };
}

async function readWorkspaceFileData(
  reader: WorkspaceFileReader,
  requestedPath: string,
) {
  const filePath = safeWorkspacePath(requestedPath);
  const file = await assertWorkspacePathHasNoSymlink(reader, filePath);
  if (!file) {
    throw new HttpError(
      404,
      "workspace_file_not_found",
      "The Workspace file no longer exists.",
    );
  }
  if (file.type !== "file") {
    throw new HttpError(
      400,
      "file_preview_not_regular",
      "Only regular files can be previewed.",
    );
  }
  if ((file.size ?? 0) > MAX_FILE_PREVIEW_BYTES) {
    throw new HttpError(
      413,
      "file_preview_too_large",
      "Files larger than 5 MiB cannot be previewed.",
    );
  }
  const content = await reader.readFile(filePath);
  if (content.byteLength > MAX_FILE_PREVIEW_BYTES) {
    throw new HttpError(
      413,
      "file_preview_too_large",
      "Files larger than 5 MiB cannot be previewed.",
    );
  }
  return { filePath, file, content };
}

async function assertWorkspacePathHasNoSymlink(
  sandbox: Pick<WorkspaceFileReader, "statFile">,
  filePath: string,
  allowMissingLeaf = false,
) {
  const relative = path.posix.relative("/workspace", filePath);
  let current = "/workspace";
  const components = relative.split("/").filter(Boolean);
  let leaf: NativeWorkspaceFile | undefined;
  for (const [index, component] of components.entries()) {
    current = path.posix.join(current, component);
    let file;
    try {
      file = await sandbox.statFile(current);
    } catch (error) {
      if (
        allowMissingLeaf &&
        index === components.length - 1 &&
        isMissingResource(error)
      ) {
        return;
      }
      throw error;
    }
    if (file.type === "symlink" || file.isLink) {
      throw new HttpError(
        403,
        "workspace_symlink_not_editable",
        "Files reached through symbolic links cannot be edited in the Web IDE.",
      );
    }
    leaf = file;
  }
  return leaf;
}

function workspaceRuntimeCacheKey(runtime: EnvironmentRuntimeRecord) {
  return `${runtime.sandboxId}:${runtime.runtimeGeneration}`;
}

function formatFileSize(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KiB`;
  return `${Math.round((bytes / 1_024 / 1_024) * 10) / 10} MiB`;
}

function hasUtf8Bom(content: Uint8Array) {
  return content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf;
}

function requireMetric(
  series: SdkRuntimeMetricSeries[],
  metric: SdkRuntimeMetricSeries["metric"],
  direction?: string,
) {
  const value = series.find(
    (candidate) =>
      candidate.metric === metric &&
      (direction === undefined ||
        candidate.dimensions?.direction === direction),
  );
  return value ?? emptyMetric(metric, direction);
}

function latestMetricValue(series: SdkRuntimeMetricSeries) {
  const value = series.segments.at(-1)?.points.at(-1)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function emptyMetric(
  metric: SdkRuntimeMetricSeries["metric"],
  direction?: string,
): SdkRuntimeMetricSeries {
  return {
    metric,
    kind:
      metric === SandboxRuntimeMetricName.SandboxNetworkIo
        ? "counter"
        : "gauge",
    unit:
      metric === SandboxRuntimeMetricName.SandboxCpuUtilization
        ? "ratio"
        : metric === SandboxRuntimeMetricName.SandboxNetworkIo
          ? "bytes"
          : "bytes",
    statistic:
      metric === SandboxRuntimeMetricName.SandboxNetworkIo ? "rate" : "average",
    dimensions: direction ? { direction } : undefined,
    segments: [],
  };
}

function metricProjection(
  series: SdkRuntimeMetricSeries,
  stepSeconds: number,
): RuntimeMetricSeries {
  return {
    metric: series.metric as RuntimeMetricSeries["metric"],
    unit:
      series.metric === SandboxRuntimeMetricName.SandboxNetworkIo
        ? "bytes_per_second"
        : (series.unit as RuntimeMetricSeries["unit"]),
    statistic: series.statistic as RuntimeMetricSeries["statistic"],
    stepSeconds,
    dimensions: series.dimensions,
    segments: series.segments.map((segment) => ({
      points: segment.points.map((point) => ({
        at: toUnixTimestamp(point.time),
        value: point.value,
      })),
    })),
  };
}

function translateMetricsError(error: unknown) {
  if (
    error instanceof APIError &&
    (error.statusCode === 403 || error.statusCode === 503)
  ) {
    return new HttpError(
      error.statusCode,
      error.statusCode === 403
        ? "metrics_not_authorized"
        : "metrics_unavailable",
      error.statusCode === 403
        ? "Runtime metrics is not licensed or authorized for this deployment."
        : "Runtime metrics is not configured or temporarily unavailable.",
    );
  }
  return translateSandbox0Error(error);
}

function translateSandbox0Error(error: unknown) {
  if (error instanceof HttpError) return error;
  if (isSandbox0TransportError(error)) {
    return new HttpError(
      503,
      "sandbox0_unavailable",
      "Sandbox0 is temporarily unreachable. Please try again.",
    );
  }
  if (error instanceof APIError) {
    if (isWorkspaceTransportDisconnected(error)) {
      return new HttpError(
        503,
        "sandbox0_workspace_unavailable",
        "The Workspace storage connection was lost and could not be recovered.",
      );
    }
    if (error.statusCode === 401) {
      return new HttpError(
        401,
        "sandbox0_invalid_api_key",
        "Sandbox0 rejected the deployment API key. Update SANDBOX0_API_KEY and restart Sandpi.",
      );
    }
    if (error.statusCode === 403) {
      return new HttpError(
        403,
        "sandbox0_permission_denied",
        "Sandbox0 denied the deployment API key. Check that it has the required deployment role and permissions.",
      );
    }
    return new HttpError(
      error.statusCode >= 400 ? error.statusCode : 502,
      `sandbox0_${error.code || "request_failed"}`,
      error.message,
    );
  }
  return error;
}

function translateCredentialSourceWriteError(error: unknown) {
  const translated = translateSandbox0Error(error);
  if (
    translated instanceof HttpError &&
    [
      "sandbox0_invalid_api_key",
      "sandbox0_permission_denied",
      "sandbox0_unavailable",
    ].includes(translated.code)
  ) {
    return translated;
  }
  if (translated instanceof HttpError) {
    return new HttpError(
      translated.statusCode,
      translated.code,
      "Sandbox0 rejected the credential source material.",
    );
  }
  return new HttpError(
    502,
    "sandbox0_credential_source_write_failed",
    "Sandbox0 could not store the credential source material.",
  );
}

function translateCredentialSourceControlError(
  error: unknown,
  operation: "read" | "delete",
) {
  const translated = translateSandbox0Error(error);
  if (
    translated instanceof HttpError &&
    [
      "sandbox0_invalid_api_key",
      "sandbox0_permission_denied",
      "sandbox0_unavailable",
    ].includes(translated.code)
  ) {
    return translated;
  }
  return new HttpError(
    translated instanceof HttpError ? translated.statusCode : 502,
    `sandbox0_credential_source_${operation}_failed`,
    operation === "read"
      ? "Sandbox0 could not read the Environment credential source."
      : "Sandbox0 could not delete the Environment credential source.",
  );
}

async function retrySandbox0Transport<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
) {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      signal?.throwIfAborted();
      const delayMs = SANDBOX0_TRANSPORT_RETRY_DELAYS_MS[attempt];
      if (!isSandbox0TransportError(error) || delayMs === undefined) {
        throw error;
      }
      await abortableDelay(delayMs, signal);
    }
  }
}

/** Builds the SDK transport that retries only HTTP methods safe to replay. */
export function createSandbox0FetchWithRetry(
  fetchImplementation: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      return fetchImplementation(input, init);
    }
    return retrySandbox0Transport(
      () => fetchImplementation(input, init),
      init?.signal ?? (input instanceof Request ? input.signal : undefined),
    );
  };
}

const fetchSandbox0WithRetry = createSandbox0FetchWithRetry();

function isSandbox0TransportError(
  error: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return false;
  }
  if (seen.has(error)) return false;
  seen.add(error);

  const candidate = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const message =
    typeof candidate.message === "string"
      ? candidate.message.toLowerCase()
      : "";
  const code = typeof candidate.code === "string" ? candidate.code : "";

  if (name === "AbortError") return false;
  if (
    name === "FetchError" ||
    (name === "TypeError" && message === "fetch failed")
  ) {
    return true;
  }
  if (
    [
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code)
  ) {
    return true;
  }
  if (
    Array.isArray(candidate.errors) &&
    candidate.errors.some((nested) => isSandbox0TransportError(nested, seen))
  ) {
    return true;
  }
  return isSandbox0TransportError(candidate.cause, seen);
}

async function generatedData<T>(
  response: Promise<{ data?: T }>,
  message: string,
) {
  const value = await response;
  if (value.data === undefined) throw new Error(message);
  return value.data;
}

async function translateGeneratedSandbox0Error(error: unknown) {
  if (error instanceof generatedRuntime.ResponseError) {
    return translateSandbox0Error(
      await apiErrorFromGeneratedResponse(error.response),
    );
  }
  return translateSandbox0Error(error);
}

async function apiErrorFromGeneratedResponse(response: Response) {
  const requestId =
    response.headers.get("x-request-id") ??
    response.headers.get("x-requestid") ??
    undefined;
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter =
    retryAfterHeader && /^\d+$/.test(retryAfterHeader.trim())
      ? Number.parseInt(retryAfterHeader, 10)
      : undefined;
  let body: string | undefined;
  let code = "unexpected_response";
  let message = response.statusText || "request failed";
  let details: unknown;
  try {
    body = (await response.text()) || undefined;
    if (body) {
      const payload = JSON.parse(body) as {
        error?: { code?: string; message?: string; details?: unknown };
      };
      code = payload.error?.code ?? code;
      message = payload.error?.message ?? message;
      details = payload.error?.details;
    }
  } catch {
    // Preserve the HTTP status when the upstream error body is not JSON.
  }
  return new APIError({
    statusCode: response.status,
    code,
    message,
    details,
    requestId,
    body,
    retryAfter,
  });
}

function translateWorkspaceFileError(error: unknown) {
  if (error instanceof APIError && error.statusCode === 404) {
    return new HttpError(
      404,
      "workspace_file_not_found",
      "The requested Workspace file does not exist.",
    );
  }
  return translateSandbox0Error(error);
}

function translateWorkspaceEntryMutationError(error: unknown) {
  if (error instanceof APIError && error.statusCode === 404) {
    return new HttpError(
      404,
      "workspace_entry_not_found",
      "The requested Workspace entry does not exist.",
    );
  }
  return translateSandbox0Error(error);
}

type Sandbox0CredentialSourceWriteRequest = Parameters<
  Client["credentialSources"]["create"]
>[0];
type Sandbox0CredentialSourceMetadata = Awaited<
  ReturnType<Client["credentialSources"]["get"]>
>;

function credentialSourceWriteRequest(
  sourceRef: string,
  resolverKind: EnvironmentCredentialResolverKind,
  material: EnvironmentCredentialMaterial,
): Sandbox0CredentialSourceWriteRequest {
  if (resolverKind !== material.type) {
    throw new Error("Environment credential material does not match resolver kind.");
  }
  switch (material.type) {
    case "static_headers":
      return {
        name: sourceRef,
        resolverKind,
        spec: { staticHeaders: { values: material.values } },
      };
    case "static_tls_client_certificate":
      return {
        name: sourceRef,
        resolverKind,
        spec: {
          staticTLSClientCertificate: {
            certificatePem: material.certificatePem,
            privateKeyPem: material.privateKeyPem,
            ...(material.caPem ? { caPem: material.caPem } : {}),
          },
        },
      };
    case "static_username_password":
      return {
        name: sourceRef,
        resolverKind,
        spec: {
          staticUsernamePassword: {
            username: material.username,
            password: material.password,
          },
        },
      };
    case "static_ssh_private_key":
      return {
        name: sourceRef,
        resolverKind,
        spec: {
          staticSSHPrivateKey: {
            privateKeyPem: material.privateKeyPem,
            ...(material.passphrase
              ? { passphrase: material.passphrase }
              : {}),
          },
        },
      };
  }
}

function runtimeCredentialSourceMetadata(
  source: Sandbox0CredentialSourceMetadata,
): RuntimeCredentialSourceMetadata {
  return {
    name: source.name,
    resolverKind: source.resolverKind,
    ...(source.currentVersion
      ? { currentVersion: Number(source.currentVersion) }
      : {}),
    ...(source.status ? { status: source.status } : {}),
    ...(source.createdAt instanceof Date ? { createdAt: source.createdAt } : {}),
    ...(source.updatedAt instanceof Date ? { updatedAt: source.updatedAt } : {}),
  };
}

function isMissingResource(error: unknown) {
  return error instanceof APIError && error.statusCode === 404;
}

// Sandbox0 canonicalizes Kubernetes memory quantities, for example 4096Mi to
// 4Gi, so ambiguous update confirmation must compare values rather than text.
function sandboxMemoryQuantityMiB(quantity: string | undefined) {
  const match = /^([1-9]\d*)(Ki|Mi|Gi|Ti)$/.exec(quantity?.trim() ?? "");
  if (!match) return undefined;
  const binaryUnitBytes = {
    Ki: 1n << 10n,
    Mi: 1n << 20n,
    Gi: 1n << 30n,
    Ti: 1n << 40n,
  } as const;
  const unit = match[2] as keyof typeof binaryUnitBytes;
  const bytes = BigInt(match[1]) * binaryUnitBytes[unit];
  const mebibyte = 1n << 20n;
  if (bytes % mebibyte !== 0n) return undefined;
  const value = bytes / mebibyte;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function isWorkspaceTransportDisconnected(error: unknown) {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("transport endpoint is not connected")
  );
}

function isSandboxWakingUp(error: unknown): error is APIError {
  return (
    error instanceof APIError &&
    error.statusCode === 503 &&
    error.message.toLowerCase().includes("sandbox is waking up")
  );
}

function isSandboxResumeFailed(error: unknown): error is APIError {
  return (
    error instanceof APIError &&
    error.statusCode === 503 &&
    error.code === "sandbox_resume_failed"
  );
}

function sandboxAutoResumeRetryDelay(error: APIError, remainingMs: number) {
  return Math.min(
    remainingMs,
    error.retryAfter === undefined
      ? SANDBOX_AUTO_RESUME_RETRY_DELAY_MS
      : Math.max(
          SANDBOX_AUTO_RESUME_RETRY_DELAY_MS,
          error.retryAfter * 1_000,
        ),
  );
}

function isWorkspaceRestoreWaitingForUnmount(
  error: unknown,
): error is APIError {
  return (
    error instanceof APIError &&
    error.statusCode === 409 &&
    error.message
      .toLowerCase()
      .includes(
        "ctld-mounted volumes must be unmounted before snapshot or restore",
      )
  );
}

function sandboxAutoResumeTimeout(sandboxId: string) {
  return new HttpError(
    503,
    "sandbox0_wakeup_timeout",
    `Sandbox0 did not finish auto-resuming Environment Sandbox ${sandboxId}.`,
  );
}

function sandboxAutoResumeFailed(sandboxId: string) {
  return new HttpError(
    503,
    "sandbox0_resume_failed",
    `Sandbox0 could not auto-resume Environment Sandbox ${sandboxId} after one retry.`,
  );
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  if (!signal) return delay(milliseconds);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
