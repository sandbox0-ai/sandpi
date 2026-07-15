import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  APIError,
  Client,
  SandboxRuntimeMetricName,
  SandboxRuntimeMetricStatistic,
  models,
  type SandboxMetrics,
} from "sandbox0";

import type {
  RuntimeMetricSeries,
  SessionAuditFeed,
  SessionMetrics,
  WorkspaceFile,
  WorkspaceGitState,
  WorkspaceIdeFile,
  WorkspaceLineChange,
} from "@/lib/types";
import type { SessionMetricRangeSeconds } from "@/lib/session-metrics";
import { toUnixTimestamp } from "@/lib/time";
import {
  repositoryForWorkspacePath,
  userVisibleWorkspaceGitState,
} from "@/lib/workspace-git";
import {
  isWorkspaceInternalPath,
  userVisibleWorkspacePath,
  WORKSPACE_INTERNAL_ROOT,
} from "@/lib/workspace-path-policy";
import { HttpError } from "@/server/http-error";
import { toSandbox0NetworkPolicy } from "./network-policy";
import {
  CODEX_SESSION_CREDENTIAL_PATH,
  type CodexAuthRuntime,
  type HarnessStateLayout,
  type MigratedCodexNativeState,
  type ProvisionedEnvironment,
  type ProvisionedSession,
  type RecoveredCodexRuntime,
  type RuntimeAdapter,
  type RuntimeForkSessionInput,
  type RuntimeForkTurnInput,
  type RuntimeProvisionSessionInput,
  type RuntimeSessionRecord,
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

const SESSION_HARD_TTL_SECONDS = 30 * 24 * 60 * 60;
const EVENT_RETENTION_BYTES = 256 * 1024 * 1024;
const EVENT_RETENTION_SECONDS = SESSION_HARD_TTL_SECONDS;
// Supervisor journals retain decoded event structures in procd memory as well
// as JSON on disk. A terminal only needs enough tail to rebuild xterm's visible
// history, so it must not inherit the much larger coding-agent event budget.
const TERMINAL_EVENT_RETENTION_BYTES = 4 * 1024 * 1024;
const LEGACY_SESSION_CODEX_HOME = "/var/lib/sandpi/codex";
const SESSION_CODEX_HOME = "/workspace/.sandpi/harnesses/codex";
const CODEX_DELIVERY_OUTBOX = "/var/lib/sandpi/codex-delivery-outbox";
const WORKSPACE_CODEX_LAYOUT_MARKER = `${SESSION_CODEX_HOME}/.sandpi-layout-workspace-v2`;
const SESSION_CODEX_AUTH_FILE = CODEX_SESSION_CREDENTIAL_PATH;
const DEVICE_CODEX_HOME = "/dev/shm/sandpi-codex-device";
const DEVICE_CODEX_AUTH_FILE = `${DEVICE_CODEX_HOME}/auth.json`;
const CODEX_AUTH_MAX_BYTES = 4 * 1024 * 1024;
const AUTH_SANDBOX_HARD_TTL_SECONDS = 30 * 60;
const MAX_FILE_TREE_DEPTH = 12;
const MAX_FILE_TREE_ENTRIES = 5_000;
const MAX_FILE_PREVIEW_BYTES = 5 * 1024 * 1024;
const GIT_STATUS_CONCURRENCY = 4;
// The coding-agent template uses /workspace as HOME, so package-manager caches
// are runtime data rather than source files and must not be eagerly traversed.
const HIDDEN_IDE_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".npm",
  "node_modules",
]);

type SdkRuntimeMetricSeries = SandboxMetrics["series"][number];

export class Sandbox0Runtime implements RuntimeAdapter {
  readonly mode = "sandbox0" as const;
  private readonly client: Client;

  constructor(options: { apiHost: string; apiKey: string }) {
    this.client = new Client({
      token: options.apiKey,
      baseUrl: options.apiHost,
      userAgent: "sandpi/0.1.0",
    });
  }

  async provisionEnvironment(): Promise<ProvisionedEnvironment> {
    const volume = await this.client.volumes.create({
      accessMode: models.VolumeAccessMode.Rwo,
    });
    return { workspaceVolumeId: volume.id };
  }

  async deleteEnvironmentResources(resources: ProvisionedEnvironment) {
    await this.client.volumes.delete(resources.workspaceVolumeId, { force: true });
    if (resources.rootfsSnapshotId) {
      await this.client.sandboxes.deleteRootFSSnapshot(resources.rootfsSnapshotId);
    }
  }

  async provisionSession(
    input: RuntimeProvisionSessionInput,
  ): Promise<ProvisionedSession> {
    let workspaceVolumeId: string | undefined;
    let provisioningStarted = false;
    try {
      const workspace = await this.client.volumes.fork(
        input.environment.workspaceVolumeId,
        { accessMode: models.VolumeAccessMode.Rwo },
      );
      workspaceVolumeId = workspace.id;
      await input.onResourcesAllocated?.({ workspaceVolumeId: workspace.id });
      provisioningStarted = true;
      return await this.provisionCodexRuntime(
        input,
        workspace.id,
        input.environment.rootfsSnapshotId || undefined,
        "fresh",
      );
    } catch (error) {
      if (workspaceVolumeId && !provisioningStarted) {
        await this.client.volumes
          .delete(workspaceVolumeId, { force: true })
          .catch(() => undefined);
      }
      throw translateSandbox0Error(error);
    }
  }

  async forkSession(input: RuntimeForkSessionInput): Promise<ProvisionedSession> {
    let rootfsSnapshotId: string | undefined;
    let workspaceVolumeId: string | undefined;
    let resumeSource = false;
    let provisioningStarted = false;
    try {
      const source = await this.client.sandboxes.get(input.source.sandboxId);
      if (!source.paused) {
        await this.client.sandboxes.pauseAndWait(input.source.sandboxId, {
          timeoutMs: 120_000,
        });
      }
      // Product Sessions do not expose a durable Sandbox pause state yet. If a
      // previous server stopped mid-operation, this fork owns recovery and must
      // resume the source before releasing its reservation.
      resumeSource = true;
      const rootfs = await this.client.sandboxes.createRootFSSnapshot(
        input.source.sandboxId,
        {
          name: `sandpi-session-fork-${input.sessionId.slice(-12)}`,
          description: `Temporary rootfs source for Sandpi Session ${input.sessionId}`,
          expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        },
      );
      rootfsSnapshotId = rootfs.id;
      const workspace = await retryWhileCtldUnmounts(() =>
        this.client.volumes.fork(input.source.workspaceVolumeId, {
          accessMode: models.VolumeAccessMode.Rwo,
        }),
      );
      workspaceVolumeId = workspace.id;
      await input.onResourcesAllocated?.({ workspaceVolumeId: workspace.id });
      if (resumeSource) {
        await this.client.sandboxes.resumeAndWait(input.source.sandboxId, {
          timeoutMs: 120_000,
        });
        resumeSource = false;
      }
      provisioningStarted = true;
      return await this.provisionCodexRuntime(
        input,
        workspace.id,
        rootfsSnapshotId,
        input.source.harnessStateLayout === "rootfs_v1"
          ? "copy_legacy_fork"
          : "preserve",
      );
    } catch (error) {
      if (workspaceVolumeId && !provisioningStarted) {
        await this.client.volumes
          .delete(workspaceVolumeId, { force: true })
          .catch(() => undefined);
      }
      throw translateSandbox0Error(error);
    } finally {
      if (resumeSource) {
        await this.client.sandboxes
          .resumeAndWait(input.source.sandboxId, { timeoutMs: 120_000 })
          .catch(() => undefined);
      }
      if (rootfsSnapshotId) {
        await this.client.sandboxes
          .deleteRootFSSnapshot(rootfsSnapshotId)
          .catch(() => undefined);
      }
    }
  }

  async forkTurn(input: RuntimeForkTurnInput) {
    let workspaceVolumeId: string | undefined;
    let resources: ProvisionedSession | undefined;
    let provisioningStarted = false;
    try {
      // A workspace_v2 checkpoint already contains both the selected files and
      // Codex's native state. A Turn fork therefore needs no second rollout
      // transport or import path.
      const workspace = await this.client.volumes.create({
        accessMode: models.VolumeAccessMode.Rwo,
        snapshotId: input.workspaceSnapshotId,
      });
      workspaceVolumeId = workspace.id;
      await input.onResourcesAllocated?.({ workspaceVolumeId: workspace.id });
      provisioningStarted = true;
      resources = await this.provisionCodexRuntime(
        input,
        workspace.id,
        undefined,
        "preserve",
      );
      return resources;
    } catch (error) {
      if (resources) {
        await this.deleteSessionResources(resources).catch(() => undefined);
      } else if (workspaceVolumeId && !provisioningStarted) {
        await this.client.volumes
          .delete(workspaceVolumeId, { force: true })
          .catch(() => undefined);
      }
      throw translateSandbox0Error(error);
    }
  }

  async createVolumeCheckpoint(
    runtime: RuntimeSessionRecord,
    label: string,
  ) {
    try {
      const snapshot = await this.client.volumes.createSnapshot(
        runtime.workspaceVolumeId,
        {
          name: label.slice(0, 100),
          description: `Sandpi Turn checkpoint for Session ${runtime.id}`,
        },
      );
      return { snapshotId: snapshot.id };
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async findVolumeCheckpoint(runtime: RuntimeSessionRecord, label: string) {
    try {
      const expectedName = label.slice(0, 100);
      const snapshots = await this.client.volumes.listSnapshots(
        runtime.workspaceVolumeId,
      );
      const snapshot = snapshots
        .filter((candidate) => candidate.name === expectedName)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      return snapshot ? { snapshotId: snapshot.id } : undefined;
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async deleteVolumeCheckpoint(
    runtime: RuntimeSessionRecord,
    snapshotId: string,
  ) {
    try {
      await this.client.volumes.deleteSnapshot(
        runtime.workspaceVolumeId,
        snapshotId,
      );
    } catch (error) {
      if (!isMissingResource(error)) throw translateSandbox0Error(error);
    }
  }

  async restoreVolumeCheckpoint(
    runtime: RuntimeSessionRecord,
    snapshotId: string,
  ) {
    let resumeSandbox = false;
    try {
      const source = await this.client.sandboxes.get(runtime.sandboxId);
      if (!source.paused) {
        await this.client.sandboxes.pauseAndWait(runtime.sandboxId, {
          timeoutMs: 120_000,
        });
      }
      // A paused Sandbox here is an interrupted Sandpi operation, not a user
      // preference. Always resume it after the atomic Volume restore.
      resumeSandbox = true;
      await retryWhileCtldUnmounts(() =>
        this.client.volumes.restoreSnapshot(
          runtime.workspaceVolumeId,
          snapshotId,
        ),
      );
      if (resumeSandbox) {
        await this.client.sandboxes.resumeAndWait(runtime.sandboxId, {
          timeoutMs: 120_000,
        });
        resumeSandbox = false;
      }
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const supervisor = await waitForNewAttempt(
        sandbox,
        runtime.supervisorSessionId,
        runtime.attemptId,
      );
      if (!hasLiveAttempt(supervisor)) {
        throw new HttpError(
          502,
          "supervisor_not_recovered",
          "Codex Supervisor did not recover after restoring the Workspace.",
        );
      }
      const recoveredAttempt = supervisor.attempt!;
      return {
        attemptId: recoveredAttempt.id,
        runtimeGeneration: supervisor.runtimeGeneration,
      };
    } catch (error) {
      throw translateSandbox0Error(error);
    } finally {
      if (resumeSandbox) {
        await this.client.sandboxes
          .resumeAndWait(runtime.sandboxId, { timeoutMs: 120_000 })
          .catch(() => undefined);
      }
    }
  }

  private async provisionCodexRuntime(
    input: RuntimeProvisionSessionInput,
    workspaceVolumeId: string,
    rootfsSnapshotId?: string,
    stateMode: "fresh" | "preserve" | "copy_legacy_fork" = "fresh",
  ): Promise<ProvisionedSession> {
    let sandboxId: string | undefined;

    try {
      const sandbox = await this.client.sandboxes.claim(
        input.environment.templateId,
        {
          snapshotId: rootfsSnapshotId,
          mounts: [
            {
              sandboxvolumeId: workspaceVolumeId,
              mountPoint: "/workspace",
            },
          ],
          config: {
            hardTtl: SESSION_HARD_TTL_SECONDS,
            network: toSandbox0NetworkPolicy(input.environment.networkPolicy),
          },
        },
      );
      sandboxId = sandbox.id;
      await input.onResourcesAllocated?.({
        sandboxId: sandbox.id,
        workspaceVolumeId,
      });
      await this.client.sandboxes.waitForLifecycle(
        sandbox.id,
        (state) => state.status === "running",
        { timeoutMs: 120_000 },
      );

      await installCodexCredential(
        sandbox,
        SESSION_CODEX_AUTH_FILE,
        input.codexAuthJson,
      );
      await prepareWorkspaceCodexHome(sandbox, stateMode);

      const supervisor = await this.createCodexSupervisor(
        sandbox,
        codexSupervisorIdempotencyKey(input.sessionId, "workspace_v2"),
        SESSION_CODEX_HOME,
      );
      const running = hasLiveAttempt(supervisor)
        ? supervisor
        : await waitForAttempt(sandbox, supervisor.id);
      if (!hasLiveAttempt(running)) {
        throw new Error("Codex Supervisor Session did not start an attempt");
      }
      const runningAttempt = running.attempt!;

      return {
        sandboxId: sandbox.id,
        workspaceVolumeId,
        supervisorSessionId: supervisor.id,
        attemptId: runningAttempt.id,
        runtimeGeneration: running.runtimeGeneration,
        nativeCredentialTargetPath: SESSION_CODEX_AUTH_FILE,
        harnessStateLayout: "workspace_v2",
      };
    } catch (error) {
      await this.deleteSessionResources({
        sandboxId,
        workspaceVolumeId,
      });
      throw translateSandbox0Error(error);
    }
  }

  private createCodexSupervisor(
    sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
    idempotencyKey: string,
    codexHome: string,
  ) {
    return sandbox.createSession(
      {
        name:
          codexHome === SESSION_CODEX_HOME ? "codex-workspace-v2" : "codex",
        command: [
          "/bin/sh",
          "-lc",
          `install -d -m 700 ${codexHome} && rm -rf ${codexHome}/auth.json && ln -s ${SESSION_CODEX_AUTH_FILE} ${codexHome}/auth.json && while [ ! -s ${SESSION_CODEX_AUTH_FILE} ]; do sleep 0.2; done && exec codex app-server --stdio -c 'cli_auth_credentials_store="file"'`,
        ],
        cwd: "/workspace",
        env: { HOME: "/workspace", CODEX_HOME: codexHome },
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

  async deleteSessionResources(resources: Partial<ProvisionedSession>) {
    const cleanupErrors: unknown[] = [];
    let sandboxGone = !resources.sandboxId;
    if (resources.sandboxId) {
      try {
        await this.client.sandboxes.delete(resources.sandboxId);
        sandboxGone = true;
      } catch (error) {
        if (isMissingResource(error)) {
          sandboxGone = true;
        } else {
          cleanupErrors.push(error);
        }
      }
    }
    // Never force-delete a Volume while its Sandbox may still be alive. A
    // failed Sandbox deletion is retried by the service reaper with both
    // coordinates intact.
    if (resources.workspaceVolumeId && sandboxGone) {
      try {
        await this.client.volumes.delete(resources.workspaceVolumeId, { force: true });
      } catch (error) {
        if (!isMissingResource(error)) cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Sandbox0 resource cleanup failed");
    }
  }

  async provisionCodexAuth(
    environment: RuntimeProvisionSessionInput["environment"],
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

  async installCodexSessionCredential(
    runtime: RuntimeSessionRecord,
    authJson: string,
  ) {
    await installCodexCredential(
      this.client.sandboxes.sandbox(runtime.sandboxId),
      SESSION_CODEX_AUTH_FILE,
      authJson,
    );
  }

  async readCodexSessionCredential(runtime: RuntimeSessionRecord) {
    const bytes = await this.client.sandboxes
      .sandbox(runtime.sandboxId)
      .readFile(SESSION_CODEX_AUTH_FILE);
    if (bytes.byteLength === 0 || bytes.byteLength > CODEX_AUTH_MAX_BYTES) {
      throw new Error("Codex Session credential file is invalid");
    }
    return Buffer.from(bytes).toString("utf8");
  }

  /**
   * Reconciles a persisted Sandpi Session with its native Sandbox0 runtime.
   * A Sandbox can remain control-plane `running` after its FUSE mount becomes
   * disconnected, while a lost Supervisor must be recreated without changing
   * the native Codex thread stored in CODEX_HOME.
   */
  async recoverCodexRuntime(
    runtime: RuntimeSessionRecord,
    authJson: string,
  ): Promise<RecoveredCodexRuntime> {
    let sandboxRestarted = false;
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const codexHome = codexHomeForLayout(runtime.harnessStateLayout);
      let lifecycle = await this.client.sandboxes.get(runtime.sandboxId);

      if (lifecycle.paused || lifecycle.status === "paused") {
        lifecycle = await this.client.sandboxes.resumeAndWait(runtime.sandboxId, {
          timeoutMs: 120_000,
        });
        sandboxRestarted = true;
      }

      try {
        await sandbox.listFiles("/workspace");
      } catch (error) {
        if (!isWorkspaceTransportDisconnected(error)) throw error;
        if (!lifecycle.paused && lifecycle.status !== "paused") {
          await this.client.sandboxes.pauseAndWait(runtime.sandboxId, {
            timeoutMs: 120_000,
          });
        }
        await this.client.sandboxes.resumeAndWait(runtime.sandboxId, {
          timeoutMs: 120_000,
        });
        sandboxRestarted = true;
        // Do not replace the Supervisor while the Workspace is still broken.
        await sandbox.listFiles("/workspace");
      }

      let supervisor;
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

      if (!supervisor && !sandboxRestarted) {
        // The Workspace portal and procd's Supervisor-state portal can fail
        // independently. Give the original journal one lifecycle recovery
        // before deciding that its Supervisor metadata is truly gone.
        await this.client.sandboxes.pauseAndWait(runtime.sandboxId, {
          timeoutMs: 120_000,
        });
        await this.client.sandboxes.resumeAndWait(runtime.sandboxId, {
          timeoutMs: 120_000,
        });
        sandboxRestarted = true;
        await sandbox.listFiles("/workspace");
        try {
          supervisor = await sandbox.getSession(runtime.supervisorSessionId);
        } catch (error) {
          if (!isMissingResource(error)) throw error;
        }
      }

      // A crash retry in `migrating` may carry either the old or the newly
      // committed Supervisor coordinates. Never reuse a process whose
      // CODEX_HOME disagrees with the durable layout.
      if (supervisor && supervisorCodexHome(supervisor) !== codexHome) {
        supervisor = undefined;
      }

      // /dev/shm is intentionally outside both rootfs and Volume snapshots and
      // must be re-materialized after every Sandbox runtime generation change.
      await installCodexCredential(sandbox, SESSION_CODEX_AUTH_FILE, authJson);
      if (codexHome === SESSION_CODEX_HOME) {
        await prepareWorkspaceCodexHome(sandbox, "preserve");
      }

      supervisor ??= await this.createCodexSupervisor(
        sandbox,
        codexSupervisorIdempotencyKey(runtime.id, runtime.harnessStateLayout),
        codexHome,
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
   * Moves a legacy rootfs CODEX_HOME into the Workspace Volume exactly once.
   * The destination rename and v2 Supervisor idempotency key make the operation
   * safe to retry before or after the Store records the new coordinates.
   */
  async migrateCodexNativeState(
    runtime: RuntimeSessionRecord,
    authJson: string,
  ): Promise<MigratedCodexNativeState> {
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const lifecycle = await this.client.sandboxes.get(runtime.sandboxId);
      if (lifecycle.paused || lifecycle.status === "paused") {
        await this.client.sandboxes.resumeAndWait(runtime.sandboxId, {
          timeoutMs: 120_000,
        });
      }

      let persistedSupervisor;
      try {
        persistedSupervisor = await sandbox.getSession(runtime.supervisorSessionId);
      } catch (error) {
        if (!isMissingResource(error)) throw error;
      }
      if (
        persistedSupervisor &&
        supervisorCodexHome(persistedSupervisor) !== SESSION_CODEX_HOME
      ) {
        await stopSupervisor(sandbox, persistedSupervisor.id);
      }

      const sourceHadRollout = runtime.nativeSessionId
        ? await legacyCodexThreadHasRollout(sandbox, runtime.nativeSessionId)
        : false;
      await installCodexCredential(sandbox, SESSION_CODEX_AUTH_FILE, authJson);
      await migrateLegacyCodexHome(sandbox);

      const supervisor =
        persistedSupervisor &&
        supervisorCodexHome(persistedSupervisor) === SESSION_CODEX_HOME
          ? persistedSupervisor
          : await this.createCodexSupervisor(
              sandbox,
              codexSupervisorIdempotencyKey(runtime.id, "workspace_v2"),
              SESSION_CODEX_HOME,
            );
      let running = supervisor;
      if (!hasLiveAttempt(running)) {
        try {
          running = await sandbox.createSessionAttempt(running.id, true);
        } catch (error) {
          if (!(error instanceof APIError) || error.statusCode !== 409) throw error;
        }
      }
      if (!hasLiveAttempt(running)) {
        running = await waitForAttempt(sandbox, running.id);
      }
      if (!running.attempt || running.attempt.finishedAt) {
        throw new HttpError(
          502,
          "supervisor_not_recovered",
          "Codex Supervisor did not start after native-state migration.",
        );
      }
      return {
        supervisorSessionId: running.id,
        attemptId: running.attempt.id,
        runtimeGeneration: running.runtimeGeneration,
        sandboxRestarted: false,
        harnessStateLayout: "workspace_v2",
        sourceHadRollout,
      };
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async cleanupLegacyCodexNativeState(runtime: RuntimeSessionRecord) {
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const sessions = await sandbox.listSessions();
      for (const session of sessions) {
        if (!isLegacyCodexSupervisor(session)) continue;
        await stopSupervisor(sandbox, session.id);
        try {
          await sandbox.deleteSession(session.id);
        } catch (error) {
          if (!isMissingResource(error)) throw error;
        }
      }
      const cleanup = await sandbox.cmd("cleanup-legacy-codex-home", {
        command: ["/bin/sh", "-lc", `rm -rf ${LEGACY_SESSION_CODEX_HOME}`],
        cwd: "/workspace",
        ttlSec: 30,
      });
      if (cleanup.exitCode !== undefined && cleanup.exitCode !== 0) {
        throw new Error("Unable to clean up legacy Codex native state");
      }
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async writeCodexMessage(
    runtime: RuntimeSessionRecord,
    message: unknown,
    stableInputId = randomUUID(),
  ) {
    await this.writeSupervisorMessage(runtime, message, stableInputId);
  }

  async stageCodexMessage(
    runtime: RuntimeSessionRecord,
    message: unknown,
    stableInputId: string,
  ) {
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const prepared = await sandbox.cmd("prepare-codex-delivery-outbox", {
        command: ["/usr/bin/install", "-d", "-m", "700", CODEX_DELIVERY_OUTBOX],
        cwd: "/",
        ttlSec: 30,
      });
      if (prepared.exitCode !== undefined && prepared.exitCode !== 0) {
        throw new Error("Unable to prepare the Codex delivery outbox");
      }
      const target = codexDeliveryOutboxPath(stableInputId);
      const temporary = `${target}.tmp-${randomUUID()}`;
      await sandbox.writeFile(
        temporary,
        Buffer.from(`${JSON.stringify(message)}\n`, "utf8"),
      );
      const committed = await sandbox.cmd("commit-codex-delivery-outbox", {
        command: ["/bin/mv", "-f", temporary, target],
        cwd: "/",
        ttlSec: 30,
      });
      if (committed.exitCode !== undefined && committed.exitCode !== 0) {
        throw new Error("Unable to commit the Codex delivery outbox frame");
      }
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async hasStagedCodexMessage(
    runtime: RuntimeSessionRecord,
    stableInputId: string,
  ) {
    try {
      await this.client.sandboxes
        .sandbox(runtime.sandboxId)
        .readFile(codexDeliveryOutboxPath(stableInputId));
      return true;
    } catch (error) {
      if (isMissingResource(error)) return false;
      throw translateSandbox0Error(error);
    }
  }

  async dispatchStagedCodexMessage(
    runtime: RuntimeSessionRecord,
    stableInputId: string,
  ) {
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const data = await sandbox.readFile(codexDeliveryOutboxPath(stableInputId));
      const supervisor = await this.getSupervisorSession(runtime);
      if (!supervisor.attempt) {
        throw new HttpError(
          409,
          "supervisor_not_running",
          "The Codex Supervisor Session has no running attempt.",
        );
      }
      await sandbox.writeSessionInput(runtime.supervisorSessionId, {
        inputId: codexSupervisorInputId(stableInputId, supervisor.attempt.id),
        expectedAttemptId: supervisor.attempt.id,
        dataBase64: Buffer.from(data).toString("base64"),
      });
    } catch (error) {
      throw translateSandbox0Error(error);
    }
  }

  async discardStagedCodexMessage(
    runtime: RuntimeSessionRecord,
    stableInputId: string,
  ) {
    try {
      const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
      const removed = await sandbox.cmd("discard-codex-delivery-outbox", {
        command: ["/bin/rm", "-f", codexDeliveryOutboxPath(stableInputId)],
        cwd: "/",
        ttlSec: 30,
      });
      if (removed.exitCode !== undefined && removed.exitCode !== 0) {
        throw new Error("Unable to discard the Codex delivery outbox frame");
      }
    } catch (error) {
      if (isMissingResource(error)) return;
      throw translateSandbox0Error(error);
    }
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
      await sandbox.writeSessionInput(runtime.supervisorSessionId, {
        inputId: codexSupervisorInputId(stableInputId, supervisor.attempt.id),
        expectedAttemptId: supervisor.attempt.id,
        dataBase64: data.toString("base64"),
      });
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

  async listCodexEvents(runtime: RuntimeSessionRecord, after = 0) {
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

  async listFiles(runtime: RuntimeSessionRecord, requestedPath: string) {
    const root = safeWorkspacePath(requestedPath);
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
    await assertWorkspacePathHasNoSymlink(sandbox, root);
    let count = 0;

    const visit = async (directory: string, depth: number): Promise<WorkspaceFile[]> => {
      if (depth > MAX_FILE_TREE_DEPTH || count >= MAX_FILE_TREE_ENTRIES) {
        return [];
      }
      const entries = await sandbox.listFiles(directory);
      const files: WorkspaceFile[] = [];
      const sorted = [...entries].sort((left, right) => {
        const leftFolder = left.type === "dir";
        const rightFolder = right.type === "dir";
        if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
        return (left.name ?? "").localeCompare(right.name ?? "");
      });
      for (const entry of sorted) {
        if (count++ >= MAX_FILE_TREE_ENTRIES) break;
        const entryPath = entry.path ?? path.posix.join(directory, entry.name ?? "unknown");
        const visibleEntryPath = userVisibleWorkspacePath(entryPath);
        if (!visibleEntryPath) continue;
        const folder = entry.type === "dir";
        if (folder && HIDDEN_IDE_DIRECTORIES.has(entry.name ?? "")) continue;
        files.push({
          id: Buffer.from(visibleEntryPath).toString("base64url"),
          name: entry.name ?? path.posix.basename(visibleEntryPath),
          path: visibleEntryPath,
          kind: folder ? "folder" : "file",
          size: entry.size === undefined ? undefined : formatFileSize(entry.size),
          modifiedAt: entry.modTime ? toUnixTimestamp(entry.modTime) : undefined,
          children: folder ? await visit(visibleEntryPath, depth + 1) : undefined,
        });
      }
      return files;
    };

    const children = await visit(root, 0);
    return root === "/workspace"
      ? [
          {
            id: "workspace",
            name: "workspace",
            path: "/workspace",
            kind: "folder" as const,
            children,
          },
        ]
      : children;
  }

  async readFile(runtime: RuntimeSessionRecord, requestedPath: string) {
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
    runtime: RuntimeSessionRecord,
  ): Promise<WorkspaceGitState> {
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
    const discovered = await sandbox.cmd("find-git-repositories", {
      command: [
        "find",
        "/workspace",
        "-mindepth",
        "1",
        "-maxdepth",
        String(MAX_FILE_TREE_DEPTH + 1),
        "(",
        "-path",
        WORKSPACE_INTERNAL_ROOT,
        "-o",
        "-type",
        "d",
        "(",
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
      (root) => userVisibleWorkspacePath(root) === root,
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
    runtime: RuntimeSessionRecord,
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
    runtime: RuntimeSessionRecord,
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
    runtime: RuntimeSessionRecord,
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
            yield { event: message.event, path: eventPath };
          }
        },
      },
      close: () => watcher.close(),
    };
  }

  private async runGit(
    runtime: RuntimeSessionRecord,
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

  async getAudit(runtime: RuntimeSessionRecord): Promise<SessionAuditFeed> {
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
    runtime: RuntimeSessionRecord,
    rangeSeconds: SessionMetricRangeSeconds,
  ): Promise<SessionMetrics> {
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
    runtime: RuntimeSessionRecord,
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

function codexHomeForLayout(layout: HarnessStateLayout) {
  return layout === "rootfs_v1"
    ? LEGACY_SESSION_CODEX_HOME
    : SESSION_CODEX_HOME;
}

function codexSupervisorIdempotencyKey(
  sessionId: string,
  layout: HarnessStateLayout,
) {
  return layout === "rootfs_v1"
    ? `sandpi-codex-${sessionId}`
    : `sandpi-codex-workspace-v2-${sessionId}`;
}

function supervisorCodexHome(session: { spec?: { env?: Record<string, string> } }) {
  return session.spec?.env?.CODEX_HOME;
}

function codexDeliveryOutboxPath(stableInputId: string) {
  const digest = createHash("sha256").update(stableInputId).digest("hex");
  return `${CODEX_DELIVERY_OUTBOX}/${digest}.jsonl`;
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

function isLegacyCodexSupervisor(session: {
  spec?: { name?: string; env?: Record<string, string> };
}) {
  const home = supervisorCodexHome(session);
  return (
    home === LEGACY_SESSION_CODEX_HOME ||
    (home === undefined && session.spec?.name === "codex")
  );
}

async function prepareWorkspaceCodexHome(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
  mode: "fresh" | "preserve" | "copy_legacy_fork" | "migrate_legacy",
) {
  const action =
    mode === "fresh"
      ? `rm -rf "$home" "$stage"
install -d -m 700 "$home"
printf '%s\\n' workspace_v2 > "$marker"
chmod 600 "$marker"`
      : mode === "preserve"
        ? `test -d "$home" && test ! -L "$home"
test "$(cat "$marker")" = workspace_v2`
        : mode === "copy_legacy_fork"
          ? `test -d "$legacy" && test ! -L "$legacy"
rm -rf "$home" "$stage"
install -d -m 700 "$stage"
(cd "$legacy" && tar --exclude='./auth.json' -cf - .) | (cd "$stage" && tar -xf -)
rm -rf "$stage/auth.json"
printf '%s\\n' workspace_v2 > "$stage/.sandpi-layout-workspace-v2"
chmod 600 "$stage/.sandpi-layout-workspace-v2"
mv "$stage" "$home"`
          : `if [ ! -f "$marker" ] || [ "$(cat "$marker")" != workspace_v2 ]; then
  test -d "$legacy" && test ! -L "$legacy"
  rm -rf "$home" "$stage"
  install -d -m 700 "$stage"
  (cd "$legacy" && tar --exclude='./auth.json' -cf - .) | (cd "$stage" && tar -xf -)
  rm -rf "$stage/auth.json"
  printf '%s\\n' workspace_v2 > "$stage/.sandpi-layout-workspace-v2"
  chmod 600 "$stage/.sandpi-layout-workspace-v2"
  mv "$stage" "$home"
fi
test -d "$home" && test ! -L "$home"
test "$(cat "$marker")" = workspace_v2`;
  const command = `set -eu
internal=${WORKSPACE_INTERNAL_ROOT}
harnesses=/workspace/.sandpi/harnesses
home=${SESSION_CODEX_HOME}
stage=/workspace/.sandpi/harnesses/.codex-migrating
legacy=${LEGACY_SESSION_CODEX_HOME}
marker=${WORKSPACE_CODEX_LAYOUT_MARKER}
test ! -L "$internal"
test ! -L "$harnesses"
install -d -m 700 "$internal" "$harnesses"
${action}
rm -rf "$home/auth.json"
ln -s ${SESSION_CODEX_AUTH_FILE} "$home/auth.json"
sync -f /workspace 2>/dev/null || sync`;
  const result = await sandbox.cmd(`prepare-codex-home-${mode}`, {
    command: ["/bin/sh", "-lc", command],
    cwd: "/workspace",
    ttlSec: 60,
  });
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    throw new HttpError(
      502,
      "codex_home_prepare_failed",
      `Unable to prepare Codex native state in the Workspace Volume (${mode}).`,
    );
  }
}

async function migrateLegacyCodexHome(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
) {
  await prepareWorkspaceCodexHome(sandbox, "migrate_legacy");
}

async function legacyCodexThreadHasRollout(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
  nativeSessionId: string,
) {
  if (!/^[A-Za-z0-9_-]+$/.test(nativeSessionId)) {
    throw new HttpError(
      409,
      "codex_thread_invalid",
      "Codex returned an invalid native Session id.",
    );
  }
  const inspected = await sandbox.cmd("inspect-legacy-codex-rollout", {
    command: [
      "/bin/sh",
      "-lc",
      `set -eu
thread_id=$1
if find ${LEGACY_SESSION_CODEX_HOME}/sessions -type f -name "rollout-*-$thread_id.jsonl" -print -quit 2>/dev/null | grep -q .; then
  printf true
else
  printf false
fi`,
      "sandpi-rollout-check",
      nativeSessionId,
    ],
    cwd: "/workspace",
    ttlSec: 30,
  });
  if (inspected.exitCode !== undefined && inspected.exitCode !== 0) {
    throw new Error("Unable to inspect legacy Codex native history");
  }
  return inspected.stdout.trim() === "true";
}

async function stopSupervisor(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
  supervisorSessionId: string,
) {
  let session;
  try {
    session = await sandbox.setSessionDesiredState(
      supervisorSessionId,
      "stopped",
    );
  } catch (error) {
    if (isMissingResource(error)) return;
    throw error;
  }
  const deadline = Date.now() + 30_000;
  while (hasLiveAttempt(session) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      session = await sandbox.getSession(supervisorSessionId);
    } catch (error) {
      if (isMissingResource(error)) return;
      throw error;
    }
  }
  if (hasLiveAttempt(session)) {
    throw new HttpError(
      502,
      "supervisor_stop_timeout",
      "Codex Supervisor did not stop before native-state migration.",
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

async function retryWhileCtldUnmounts<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const waitingForUnmount =
        error instanceof APIError &&
        error.statusCode === 409 &&
        (error.message.toLowerCase().includes("active ctld mounts") ||
          error.message.toLowerCase().includes("must be unmounted"));
      if (!waitingForUnmount || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
