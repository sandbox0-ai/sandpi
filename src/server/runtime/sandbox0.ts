import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  APIError,
  Client,
  SandboxWaitTimeoutError,
  SandboxRuntimeMetricName,
  SandboxRuntimeMetricStatistic,
  models,
  type SandboxMetrics,
} from "sandbox0";

import type {
  Environment,
  RuntimeMetricSeries,
  EnvironmentAuditFeed,
  EnvironmentMetrics,
  WorkspaceDirectoryListing,
  WorkspaceFile,
  WorkspaceGitState,
  WorkspaceIdeFile,
  WorkspaceLineChange,
} from "@/lib/types";
import type { EnvironmentMetricRangeSeconds } from "@/lib/environment-metrics";
import { toUnixTimestamp } from "@/lib/time";
import {
  repositoryForWorkspacePath,
  userVisibleWorkspaceGitState,
} from "@/lib/workspace-git";
import {
  isWorkspaceIdePathHidden,
  isWorkspaceInternalPath,
  userVisibleWorkspacePath,
  WORKSPACE_INTERNAL_ROOT,
} from "@/lib/workspace-path-policy";
import { HttpError } from "@/server/http-error";
import { ENVIRONMENT_SANDBOX_HARD_TTL_SECONDS } from "@/server/environments/lifecycle-policy";
import { toSandbox0NetworkPolicy } from "./network-policy";
import {
  CODEX_ENVIRONMENT_CREDENTIAL_PATH,
  type CodexAuthRuntime,
  type EnvironmentRuntimeRecord,
  type ProvisionedEnvironment,
  type RecoveredCodexEnvironmentRuntime,
  type RuntimeAdapter,
  type RuntimeCodexEventStreamHandle,
  type RuntimeProvisionEnvironmentInput,
  type RuntimeTerminalHandle,
  type RuntimeWorkspaceWatchHandle,
} from "./types";
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
import { reconcileTerminalReplayCursor } from "./terminal-replay";
import {
  terminalEnvironmentUpdate,
  terminalSessionEnvironment,
} from "./terminal-environment";

const EVENT_RETENTION_BYTES = 256 * 1024 * 1024;
const EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
// Supervisor journals retain decoded event structures in procd memory as well
// as JSON on disk. A terminal only needs enough tail to rebuild xterm's visible
// history, so it must not inherit the much larger coding-agent event budget.
const TERMINAL_EVENT_RETENTION_BYTES = 4 * 1024 * 1024;
const ENVIRONMENT_CODEX_HOME = "/workspace/.sandpi/harnesses/codex";
const WORKSPACE_CODEX_LAYOUT_MARKER = `${ENVIRONMENT_CODEX_HOME}/.sandpi-layout-environment-v1`;
const ENVIRONMENT_CODEX_AUTH_FILE = CODEX_ENVIRONMENT_CREDENTIAL_PATH;
const DEVICE_CODEX_HOME = "/dev/shm/sandpi-codex-device";
const DEVICE_CODEX_AUTH_FILE = `${DEVICE_CODEX_HOME}/auth.json`;
const CODEX_AUTH_MAX_BYTES = 4 * 1024 * 1024;
const AUTH_SANDBOX_HARD_TTL_SECONDS = 30 * 60;
const MAX_GIT_DISCOVERY_DEPTH = 13;
const MAX_FILE_PREVIEW_BYTES = 5 * 1024 * 1024;
const GIT_STATUS_CONCURRENCY = 4;
const SANDBOX_AUTO_RESUME_TIMEOUT_MS = 120_000;
const SANDBOX_AUTO_RESUME_RETRY_DELAY_MS = 250;
const SANDBOX0_TRANSPORT_RETRY_DELAYS_MS = [100, 250] as const;

type SdkRuntimeMetricSeries = SandboxMetrics["series"][number];

export class Sandbox0Runtime implements RuntimeAdapter {
  readonly mode = "sandbox0" as const;
  private readonly client: Client;

  constructor(options: { apiHost: string; apiKey: string }) {
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
          // Explicitly disable soft TTL so a deployment default cannot race the
          // durable Turn-based pause deadline maintained by Sandpi.
          config: {
            ttl: 0,
            hardTtl: ENVIRONMENT_SANDBOX_HARD_TTL_SECONDS,
            autoResume: true,
            network: toSandbox0NetworkPolicy(input.environment.networkPolicy),
          },
        },
      );
      sandboxId = sandbox.id;
      await input.onResourcesAllocated?.({ sandboxId, workspaceVolumeId });
      const lifecycle = await this.client.sandboxes.waitForLifecycle(
        sandbox.id,
        (state) => state.status === "running",
        { timeoutMs: 120_000 },
      );
      return {
        sandboxId,
        workspaceVolumeId,
        hardExpiresAt: validDate(lifecycle?.hardExpiresAt)
          ? lifecycle.hardExpiresAt
          : new Date(Date.now() + ENVIRONMENT_SANDBOX_HARD_TTL_SECONDS * 1_000),
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

  async updateEnvironmentNetworkPolicy(
    runtime: EnvironmentRuntimeRecord,
    policy: Environment["networkPolicy"],
  ) {
    try {
      await this.client.sandboxes
        .sandbox(runtime.sandboxId)
        .updateNetworkPolicy(toSandbox0NetworkPolicy(policy));
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async configureEnvironmentLifecycle(
    runtime: EnvironmentRuntimeRecord,
    hardTtlSeconds: number,
  ) {
    try {
      const lifecycle = await this.client.sandboxes.update(runtime.sandboxId, {
        config: {
          ttl: 0,
          hardTtl: Math.max(1, Math.ceil(hardTtlSeconds)),
          autoResume: true,
        },
      });
      return {
        hardExpiresAt: lifecycle.hardExpiresAt,
      };
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
          `install -d -m 700 ${ENVIRONMENT_CODEX_HOME} && rm -rf ${ENVIRONMENT_CODEX_HOME}/auth.json && ln -s ${ENVIRONMENT_CODEX_AUTH_FILE} ${ENVIRONMENT_CODEX_HOME}/auth.json && while [ ! -s ${ENVIRONMENT_CODEX_AUTH_FILE} ]; do sleep 0.2; done && exec codex app-server --stdio -c 'cli_auth_credentials_store="file"'`,
        ],
        cwd: "/workspace",
        env: { HOME: "/workspace", CODEX_HOME: ENVIRONMENT_CODEX_HOME },
        io: { mode: "pipes" },
        lifecycle: {
          restart: {
            policy: "on_failure",
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
      const sandbox = await this.client.sandboxes.claim(environment.templateId, {
        config: {
          hardTtl: AUTH_SANDBOX_HARD_TTL_SECONDS,
          network: toSandbox0NetworkPolicy(environment.networkPolicy),
        },
      });
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
        throw new Error("Codex authentication Supervisor Session did not start");
      }
      return {
        sandboxId: sandbox.id,
        supervisorSessionId: supervisor.id,
        attemptId: running.attempt.id,
        runtimeGeneration: running.runtimeGeneration,
      };
    } catch (error) {
      if (sandboxId) {
        await this.deleteCodexAuthResources({ sandboxId }).catch(() => undefined);
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
        .listSessionEvents(runtime.supervisorSessionId, { after, limit: 1_000 });
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
   * Reconciles one Environment with its shared native Sandbox0 runtime.
   * A Sandbox can remain control-plane `running` after its FUSE mount becomes
   * disconnected, while a lost Supervisor can be recreated because every
   * native Codex Thread is persisted under the Environment Workspace Volume.
   */
  async ensureCodexEnvironmentRuntime(
    runtime: EnvironmentRuntimeRecord,
    authJson: string,
  ): Promise<RecoveredCodexEnvironmentRuntime> {
    let sandboxRestarted = false;
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      let lifecycle = await this.client.sandboxes.get(runtime.sandboxId);

      try {
        // This runtime API is the wake-up boundary. Sandbox0 serializes access
        // with pause and restores a paused auto-resume Sandbox. A gateway may
        // answer `sandbox is waking up` while that native transition commits;
        // observe it and retry this same access instead of calling resume.
        await this.withSandboxAutoResume(runtime.sandboxId, () =>
          sandbox.listFiles("/workspace"),
        );
        lifecycle = await this.client.sandboxes.get(runtime.sandboxId);
      } catch (error) {
        if (!isWorkspaceTransportDisconnected(error)) throw error;
        lifecycle = await this.client.sandboxes.get(runtime.sandboxId);
        if (!lifecycle.paused && lifecycle.status !== "paused") {
          await this.client.sandboxes.pauseAndWait(runtime.sandboxId, {
            timeoutMs: 120_000,
          });
        }
        // A second supported runtime access lets Sandbox0 auto-resume the
        // checkpoint; Sandpi never owns a separate resume state machine.
        await this.withSandboxAutoResume(runtime.sandboxId, () =>
          sandbox.listFiles("/workspace"),
        );
        lifecycle = await this.client.sandboxes.get(runtime.sandboxId);
      }
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

      // /dev/shm is intentionally outside both rootfs and Volume snapshots and
      // must be re-materialized after every Sandbox runtime generation change.
      await installCodexCredential(
        sandbox,
        ENVIRONMENT_CODEX_AUTH_FILE,
        authJson,
      );
      await prepareEnvironmentCodexHome(sandbox);

      supervisor ??= await this.createCodexSupervisor(
        sandbox,
        `sandpi-codex-environment-${runtime.id}`,
      );

      if (!hasLiveAttempt(supervisor)) {
        try {
          supervisor = await sandbox.createSessionAttempt(supervisor.id, true);
        } catch (error) {
          // runtimeRecovery can win this race immediately after Sandbox resume.
          if (!(error instanceof APIError) || error.statusCode !== 409) throw error;
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
   * Lets a supported runtime request trigger Sandbox0 auto-resume and waits for
   * the resulting native lifecycle transition. This deliberately never calls
   * the explicit resume endpoint; Sandpi only owns explicit pause operations.
   */
  private async withSandboxAutoResume<T>(
    sandboxId: string,
    access: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    while (true) {
      try {
        return await access();
      } catch (error) {
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
        const retryDelayMs = Math.min(
          retryRemainingMs,
          error.retryAfter === undefined
            ? SANDBOX_AUTO_RESUME_RETRY_DELAY_MS
            : Math.max(
                SANDBOX_AUTO_RESUME_RETRY_DELAY_MS,
                error.retryAfter * 1_000,
              ),
        );
        await delay(retryDelayMs);
      }
    }
  }

  async writeCodexMessage(
    runtime: EnvironmentRuntimeRecord,
    message: unknown,
    stableInputId = randomUUID(),
  ) {
    const coordinates = requireCodexSupervisor(runtime);
    await this.writeSupervisorMessage(coordinates, message, stableInputId);
  }

  private async writeSupervisorMessage(
    runtime: Pick<CodexAuthRuntime, "sandboxId" | "supervisorSessionId">,
    message: unknown,
    stableInputId: string,
  ) {
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const supervisor = await this.getSupervisorSession(runtime);
      if (!supervisor.attempt) {
        throw new HttpError(
          409,
          "supervisor_not_running",
          "The Codex Supervisor Session has no running attempt.",
        );
      }
      const data = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
      const request = {
        inputId: codexSupervisorInputId(stableInputId, supervisor.attempt.id),
        expectedAttemptId: supervisor.attempt.id,
        dataBase64: data.toString("base64"),
      };
      // Supervisor input receipts deduplicate the same input id and content.
      // Retrying an ambiguous transport failure is therefore safe as long as
      // every attempt reuses this exact request.
      await retrySandbox0Transport(() =>
        sandbox.writeSessionInput(runtime.supervisorSessionId, request),
      );
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  private async getSupervisorSession(
    runtime: Pick<CodexAuthRuntime, "sandboxId" | "supervisorSessionId">,
  ) {
    try {
      return await this.client.sandboxes
        .sandbox(runtime.sandboxId)
        .getSession(runtime.supervisorSessionId);
    } catch (error) {
      throw translateSandbox0Error(error);
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
    const root = safeWorkspacePath(requestedPath);
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
    await assertWorkspacePathHasNoSymlink(sandbox, root);
    const nativeEntries = await sandbox.listFiles(root);
    const entries: WorkspaceFile[] = [...nativeEntries]
      .sort((left, right) => {
        const leftFolder = left.type === "dir";
        const rightFolder = right.type === "dir";
        if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
        return (left.name ?? "").localeCompare(right.name ?? "");
      })
      .flatMap((entry) => {
        const entryPath =
          entry.path ?? path.posix.join(root, entry.name ?? "unknown");
        const visibleEntryPath = userVisibleWorkspacePath(entryPath);
        if (!visibleEntryPath) return [];
        const folder = entry.type === "dir";
        if (isWorkspaceIdePathHidden(visibleEntryPath, folder)) {
          return [];
        }
        return [
          {
            id: Buffer.from(visibleEntryPath).toString("base64url"),
            name: entry.name ?? path.posix.basename(visibleEntryPath),
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

  async readFile(runtime: EnvironmentRuntimeRecord, requestedPath: string) {
    try {
      const filePath = safeWorkspacePath(requestedPath);
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      await assertWorkspacePathHasNoSymlink(sandbox, filePath);
      const file = await sandbox.statFile(filePath);
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
      const content = await sandbox.readFile(filePath);
      if (content.byteLength > MAX_FILE_PREVIEW_BYTES) {
        throw new HttpError(
          413,
          "file_preview_too_large",
          "Files larger than 5 MiB cannot be previewed.",
        );
      }
      return content;
    } catch (error) {
      throw translateWorkspaceFileError(error);
    }
  }

  async getWorkspaceGitState(
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
    for (let offset = 0; offset < roots.length; offset += GIT_STATUS_CONCURRENCY) {
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

  async readWorkspaceIdeFile(
    runtime: EnvironmentRuntimeRecord,
    requestedPath: string,
  ): Promise<WorkspaceIdeFile> {
    const filePath = safeWorkspacePath(requestedPath);
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
    await assertWorkspacePathHasNoSymlink(sandbox, filePath, true);
    const git = await this.getWorkspaceGitState(runtime);
    const repository = repositoryForWorkspacePath(git.repositories, filePath);
    const change = repository?.files.find(
      (candidate) => candidate.path === filePath,
    );
    let content: Uint8Array;
    let size: number | undefined;
    let modifiedAt: Date | undefined;

    try {
      const file = await sandbox.statFile(filePath);
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
      const revision = change.staged ? `HEAD:${relativePath}` : `:${relativePath}`;
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
    const text = isUtf8(content)
      ? Buffer.from(content).toString("utf8")
      : undefined;
    const lineCount =
      text === undefined
        ? 0
        : Math.max(
            1,
            text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
          );
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
      name: path.posix.basename(filePath),
      revision: workspaceFileRevision(content),
      encoding: "base64",
      content: Buffer.from(content).toString("base64"),
      kind: text === undefined ? "binary" : "text",
      bom: hasUtf8Bom(content) ? "utf8" : undefined,
      editable: text !== undefined && change?.kind !== "deleted",
      readOnlyReason:
        text === undefined
          ? "binary"
          : change?.kind === "deleted"
            ? "deleted"
            : undefined,
      size: size === undefined ? undefined : formatFileSize(size),
      modifiedAt: modifiedAt ? toUnixTimestamp(modifiedAt) : undefined,
      git: change,
      lineChanges,
    };
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
    await assertWorkspacePathHasNoSymlink(sandbox, filePath);
    const file = await sandbox.statFile(filePath);
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

  async watchWorkspaceFiles(
    runtime: EnvironmentRuntimeRecord,
  ): Promise<RuntimeWorkspaceWatchHandle> {
    const watcher = await this.client.sandboxes
      .sandbox(runtime.sandboxId)
      .watchFiles("/workspace", true);
    return {
      messages: {
        async *[Symbol.asyncIterator]() {
          for await (const message of watcher.events()) {
            if (
              message.type !== "event" ||
              !message.event ||
              !message.path
            ) {
              continue;
            }
            const eventPath = userVisibleWorkspacePath(message.path);
            if (!eventPath) continue;
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
              // Hidden directories are absent from the Workspace tree. Ignore
              // their descendants without suppressing root-level hidden files.
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
    const result = await this.client.sandboxes.sandbox(runtime.sandboxId).cmd(
      "git",
      {
        command: ["git", "-C", root, ...args],
        cwd: root,
        envVars: { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
        ttlSec: 15,
      },
    );
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      throw new HttpError(
        502,
        "workspace_git_failed",
        result.stderr.trim() || "Git could not inspect this Workspace.",
      );
    }
    return result.stdout;
  }

  async getAudit(runtime: EnvironmentRuntimeRecord): Promise<EnvironmentAuditFeed> {
    try {
      const response = await this.client.sandboxes
        .sandbox(runtime.sandboxId)
        .listObservabilityEvents({ limit: 250 });
      return {
        ...response,
        events: response.events.map((event) => ({
          ...event,
          occurredAt: toUnixTimestamp(event.occurredAt),
          ingestedAt: toUnixTimestamp(event.ingestedAt),
        })),
      };
    } catch (error) {
      throw translateObservabilityError(error, "audit");
    }
  }

  async getMetrics(
    runtime: EnvironmentRuntimeRecord,
    rangeSeconds: EnvironmentMetricRangeSeconds,
  ): Promise<EnvironmentMetrics> {
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - rangeSeconds * 1_000);
      const gauges = await sandbox.getMetrics({
        startTime,
        endTime,
        metrics: [
          SandboxRuntimeMetricName.SandboxCpuUtilization,
          SandboxRuntimeMetricName.SandboxMemoryWorkingSet,
          SandboxRuntimeMetricName.SandboxMemoryLimit,
        ],
        statistic: SandboxRuntimeMetricStatistic.Average,
        maxPoints: 120,
      });
      const network = await sandbox.getMetrics({
        startTime,
        endTime,
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
        cpuUtilization: metricProjection(cpu),
        memoryWorkingSet: metricProjection(memory),
        memoryLimitBytes:
          memoryLimit.segments.at(-1)?.points.at(-1)?.value ?? 0,
        networkReceive: metricProjection(receive),
        networkTransmit: metricProjection(transmit),
      };
    } catch (error) {
      throw translateObservabilityError(error, "metrics");
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
    if (!terminal.attempt) terminal = await waitForAttempt(sandbox, terminal.id);
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
  if (!runtime.supervisorSessionId) {
    throw new HttpError(
      409,
      "codex_runtime_not_ready",
      "The Environment Codex runtime is not ready.",
    );
  }
  return {
    sandboxId: runtime.sandboxId,
    supervisorSessionId: runtime.supervisorSessionId,
  };
}

async function prepareEnvironmentCodexHome(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
) {
  const command = `set -eu
internal=${WORKSPACE_INTERNAL_ROOT}
harnesses=/workspace/.sandpi/harnesses
home=${ENVIRONMENT_CODEX_HOME}
marker=${WORKSPACE_CODEX_LAYOUT_MARKER}
test ! -L "$internal"
test ! -L "$harnesses"
install -d -m 700 "$internal" "$harnesses"
test ! -L "$home"
install -d -m 700 "$home"
if [ -f "$marker" ]; then
  test "$(cat "$marker")" = environment_v1
else
  printf '%s\\n' environment_v1 > "$marker"
  chmod 600 "$marker"
fi
rm -rf "$home/auth.json"
ln -s ${ENVIRONMENT_CODEX_AUTH_FILE} "$home/auth.json"
sync -f /workspace 2>/dev/null || sync`;
  const result = await sandbox.cmd("prepare-environment-codex-home", {
    command: ["/bin/sh", "-lc", command],
    cwd: "/workspace",
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

function safeWorkspacePath(requestedPath: string) {
  const visible = userVisibleWorkspacePath(requestedPath || "/workspace");
  if (visible) return visible;
  if (isWorkspaceInternalPath(requestedPath)) {
    throw new HttpError(
      403,
      "workspace_internal_path_protected",
      "Sandpi-managed Workspace state is not available through user file APIs.",
    );
  }
  throw new HttpError(
    400,
    "invalid_workspace_path",
    "Path must stay under /workspace.",
  );
}

function safeEditableWorkspacePath(requestedPath: string) {
  const filePath = safeWorkspacePath(requestedPath);
  if (
    path.posix
      .relative("/workspace", filePath)
      .split("/")
      .includes(".git")
  ) {
    throw new HttpError(
      403,
      "workspace_git_metadata_protected",
      "Git metadata cannot be edited from the Web IDE.",
    );
  }
  return filePath;
}

async function assertWorkspacePathHasNoSymlink(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
  filePath: string,
  allowMissingLeaf = false,
) {
  const relative = path.posix.relative("/workspace", filePath);
  let current = "/workspace";
  const components = relative.split("/").filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = path.posix.join(current, component);
    let file;
    try {
      file = await sandbox.statFile(current);
    } catch (error) {
      if (allowMissingLeaf && index === components.length - 1 && isMissingResource(error)) {
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
  }
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
      (direction === undefined || candidate.dimensions?.direction === direction),
  );
  return value ?? emptyMetric(metric, direction);
}

function emptyMetric(
  metric: SdkRuntimeMetricSeries["metric"],
  direction?: string,
): SdkRuntimeMetricSeries {
  return {
    metric,
    kind: metric === SandboxRuntimeMetricName.SandboxNetworkIo ? "counter" : "gauge",
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

function metricProjection(series: SdkRuntimeMetricSeries): RuntimeMetricSeries {
  return {
    metric: series.metric as RuntimeMetricSeries["metric"],
    unit:
      series.metric === SandboxRuntimeMetricName.SandboxNetworkIo
        ? "bytes_per_second"
        : (series.unit as RuntimeMetricSeries["unit"]),
    statistic: series.statistic as RuntimeMetricSeries["statistic"],
    dimensions: series.dimensions,
    segments: series.segments.map((segment) => ({
      points: segment.points.map((point) => ({
        at: toUnixTimestamp(point.time),
        value: point.value,
      })),
    })),
  };
}

function translateObservabilityError(error: unknown, surface: "audit" | "metrics") {
  if (error instanceof APIError && (error.statusCode === 403 || error.statusCode === 503)) {
    return new HttpError(
      error.statusCode,
      error.statusCode === 403
        ? `${surface}_not_authorized`
        : `${surface}_unavailable`,
      error.statusCode === 403
        ? `${surface === "audit" ? "Signed audit" : "Runtime metrics"} is not licensed or authorized for this deployment.`
        : `${surface === "audit" ? "Signed audit" : "Runtime metrics"} is not configured or temporarily unavailable.`,
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
    return new HttpError(
      error.statusCode >= 400 ? error.statusCode : 502,
      `sandbox0_${error.code || "request_failed"}`,
      error.message,
    );
  }
  return error;
}

async function retrySandbox0Transport<T>(operation: () => Promise<T>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = SANDBOX0_TRANSPORT_RETRY_DELAYS_MS[attempt];
      if (!isSandbox0TransportError(error) || delayMs === undefined) {
        throw error;
      }
      await delay(delayMs);
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
    return retrySandbox0Transport(() => fetchImplementation(input, init));
  };
}

const fetchSandbox0WithRetry = createSandbox0FetchWithRetry();

function isSandbox0TransportError(error: unknown, seen = new Set<unknown>()): boolean {
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
    typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  const code = typeof candidate.code === "string" ? candidate.code : "";

  if (name === "AbortError") return false;
  if (name === "FetchError" || (name === "TypeError" && message === "fetch failed")) {
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

function isMissingResource(error: unknown) {
  return error instanceof APIError && error.statusCode === 404;
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

function sandboxAutoResumeTimeout(sandboxId: string) {
  return new HttpError(
    503,
    "sandbox0_wakeup_timeout",
    `Sandbox0 did not finish auto-resuming Environment Sandbox ${sandboxId}.`,
  );
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
