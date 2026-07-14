import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
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
import { repositoryForWorkspacePath } from "@/lib/workspace-git";
import { HttpError } from "@/server/http-error";
import { toSandbox0NetworkPolicy } from "./network-policy";
import {
  CODEX_SESSION_CREDENTIAL_PATH,
  type CodexAuthRuntime,
  type ProvisionedEnvironment,
  type ProvisionedSession,
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

const SESSION_HARD_TTL_SECONDS = 30 * 24 * 60 * 60;
const EVENT_RETENTION_BYTES = 256 * 1024 * 1024;
const EVENT_RETENTION_SECONDS = SESSION_HARD_TTL_SECONDS;
const SESSION_CODEX_HOME = "/var/lib/sandpi/codex";
const SESSION_CODEX_AUTH_FILE = CODEX_SESSION_CREDENTIAL_PATH;
const DEVICE_CODEX_HOME = "/dev/shm/sandpi-codex-device";
const DEVICE_CODEX_AUTH_FILE = `${DEVICE_CODEX_HOME}/auth.json`;
const CODEX_AUTH_MAX_BYTES = 4 * 1024 * 1024;
const AUTH_SANDBOX_HARD_TTL_SECONDS = 30 * 60;
const MAX_FILE_TREE_DEPTH = 12;
const MAX_FILE_TREE_ENTRIES = 5_000;
const MAX_FILE_PREVIEW_BYTES = 5 * 1024 * 1024;
const GIT_STATUS_CONCURRENCY = 4;
const MAX_CODEX_ROLLOUT_IMPORT_BYTES = 256 * 1024 * 1024;
const HIDDEN_IDE_DIRECTORIES = new Set([".git", ".next", "node_modules"]);

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
      const sourcePath = path.posix.resolve(input.sourceThreadPath);
      const sourceRoot = `${SESSION_CODEX_HOME}/sessions/`;
      if (!sourcePath.startsWith(sourceRoot) || !sourcePath.endsWith(".jsonl")) {
        throw new HttpError(
          409,
          "codex_rollout_path_invalid",
          "Codex returned an invalid native rollout path.",
        );
      }

      const sourceSandbox = this.client.sandboxes.sandbox(input.source.sandboxId);
      const sourceInfo = await sourceSandbox.statFile(sourcePath);
      if (
        sourceInfo.type !== "file" ||
        (sourceInfo.size ?? 0) > MAX_CODEX_ROLLOUT_IMPORT_BYTES
      ) {
        throw new HttpError(
          413,
          "codex_rollout_too_large",
          "The native Codex rollout is too large to fork safely.",
        );
      }
      const nativeHistory = await sourceSandbox.readFile(sourcePath);
      if (nativeHistory.byteLength > MAX_CODEX_ROLLOUT_IMPORT_BYTES) {
        throw new HttpError(
          413,
          "codex_rollout_too_large",
          "The native Codex rollout is too large to fork safely.",
        );
      }

      // A Turn fork intentionally does not copy rootfs. Its Sandbox is a fresh
      // coding-agent claim and its private Workspace Volume starts at the
      // immutable checkpoint selected by the user.
      const workspace = await this.client.volumes.create({
        accessMode: models.VolumeAccessMode.Rwo,
        snapshotId: input.workspaceSnapshotId,
      });
      workspaceVolumeId = workspace.id;
      await input.onResourcesAllocated?.({ workspaceVolumeId: workspace.id });
      provisioningStarted = true;
      resources = await this.provisionCodexRuntime(input, workspace.id);
      const targetSandbox = this.client.sandboxes.sandbox(resources.sandboxId);
      // Keep the native filename and CODEX_HOME-relative location. Sandpi uses
      // Codex's explicit native path contract when available and can fall back
      // to native threadId discovery without maintaining a second history form.
      await targetSandbox.mkdir(path.posix.dirname(sourcePath), true);
      await targetSandbox.writeFile(sourcePath, nativeHistory);
      return { ...resources, nativeThreadImportPath: sourcePath };
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

  async deleteCodexThreadImport(
    runtime: RuntimeSessionRecord,
    importPath: string,
  ) {
    try {
      await this.client.sandboxes.sandbox(runtime.sandboxId).deleteFile(importPath);
    } catch (error) {
      if (!isMissingResource(error)) throw translateSandbox0Error(error);
    }
  }

  async createWorkspaceCheckpoint(
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

  async deleteWorkspaceCheckpoint(
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

  async restoreWorkspaceCheckpoint(
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
      if (!supervisor.attempt) {
        throw new HttpError(
          502,
          "supervisor_not_recovered",
          "Codex Supervisor did not recover after restoring the Workspace.",
        );
      }
      return {
        attemptId: supervisor.attempt.id,
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

      const supervisor = await sandbox.createSession(
        {
          name: "codex",
          command: [
            "/bin/sh",
            "-lc",
            `install -d -m 700 ${SESSION_CODEX_HOME} && printf '%s\n' 'cli_auth_credentials_store = "file"' > ${SESSION_CODEX_HOME}/config.toml && rm -f ${SESSION_CODEX_HOME}/auth.json && ln -s ${SESSION_CODEX_AUTH_FILE} ${SESSION_CODEX_HOME}/auth.json && while [ ! -s ${SESSION_CODEX_AUTH_FILE} ]; do sleep 0.2; done && exec codex app-server --stdio`,
          ],
          cwd: "/workspace",
          env: { HOME: "/workspace", CODEX_HOME: SESSION_CODEX_HOME },
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
        { idempotencyKey: `sandpi-codex-${input.sessionId}` },
      );
      const running = supervisor.attempt
        ? supervisor
        : await waitForAttempt(sandbox, supervisor.id);
      if (!running.attempt) {
        throw new Error("Codex Supervisor Session did not start an attempt");
      }

      return {
        sandboxId: sandbox.id,
        workspaceVolumeId,
        supervisorSessionId: supervisor.id,
        attemptId: running.attempt.id,
        runtimeGeneration: running.runtimeGeneration,
        nativeCredentialTargetPath: SESSION_CODEX_AUTH_FILE,
      };
    } catch (error) {
      await this.deleteSessionResources({
        sandboxId,
        workspaceVolumeId,
      });
      throw translateSandbox0Error(error);
    }
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

  async writeCodexMessage(
    runtime: RuntimeSessionRecord,
    message: unknown,
    stableInputId = randomUUID(),
  ) {
    await this.writeSupervisorMessage(runtime, message, stableInputId);
  }

  private async writeSupervisorMessage(
    runtime: Pick<CodexAuthRuntime, "sandboxId" | "supervisorSessionId">,
    message: unknown,
    stableInputId: string,
  ) {
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
    const supervisor = await sandbox.getSession(runtime.supervisorSessionId);
    if (!supervisor.attempt) {
      throw new HttpError(
        409,
        "supervisor_not_running",
        "The Codex Supervisor Session has no running attempt.",
      );
    }
    const data = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    await sandbox.writeSessionInput(runtime.supervisorSessionId, {
      inputId: stableInputId,
      expectedAttemptId: supervisor.attempt.id,
      dataBase64: data.toString("base64"),
    });
  }

  async listCodexEvents(runtime: RuntimeSessionRecord, after = 0) {
    return this.listSupervisorEvents(runtime, after);
  }

  private async listSupervisorEvents(
    runtime: Pick<CodexAuthRuntime, "sandboxId" | "supervisorSessionId">,
    after = 0,
  ) {
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
  }

  async listFiles(runtime: RuntimeSessionRecord, requestedPath: string) {
    const root = safeWorkspacePath(requestedPath);
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
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
        const folder = entry.type === "dir";
        if (folder && HIDDEN_IDE_DIRECTORIES.has(entry.name ?? "")) continue;
        files.push({
          id: Buffer.from(entryPath).toString("base64url"),
          name: entry.name ?? path.posix.basename(entryPath),
          path: entryPath,
          kind: folder ? "folder" : "file",
          size: entry.size === undefined ? undefined : formatFileSize(entry.size),
          modifiedAt: entry.modTime ? toUnixTimestamp(entry.modTime) : undefined,
          children: folder ? await visit(entryPath, depth + 1) : undefined,
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
    const filePath = safeWorkspacePath(requestedPath);
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
    const file = await sandbox.statFile(filePath);
    if (file.type !== "file") {
      throw new HttpError(400, "file_preview_not_regular", "Only regular files can be previewed.");
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
    const roots = gitRepositoryRootsFromMarkers(discovered.stdout);
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
    return { repositories };
  }

  async readWorkspaceIdeFile(
    runtime: RuntimeSessionRecord,
    requestedPath: string,
  ): Promise<WorkspaceIdeFile> {
    const filePath = safeWorkspacePath(requestedPath);
    const sandbox = this.client.sandboxes.sandbox(runtime.sandboxId);
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
            const eventPath = safeWorkspacePath(message.path);
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
          env: { HOME: "/workspace", TERM: "xterm-256color" },
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
            maxBytes: 64 * 1024 * 1024,
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
    const connection = await sandbox.connectSession(terminal.id, { after });
    const attemptId = terminal.attempt.id;
    return {
      sessionId: terminal.id,
      attemptId,
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
            dataBase64: Buffer.from(message.data ?? "", "utf8").toString("base64"),
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
  while (!session.attempt && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    session = await sandbox.getSession(supervisorSessionId);
  }
  return session;
}

async function waitForNewAttempt(
  sandbox: ReturnType<Client["sandboxes"]["sandbox"]>,
  supervisorSessionId: string,
  previousAttemptId?: string,
) {
  const deadline = Date.now() + 30_000;
  let session = await sandbox.getSession(supervisorSessionId);
  while (
    (!session.attempt || session.attempt.id === previousAttemptId) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    session = await sandbox.getSession(supervisorSessionId);
  }
  return session;
}

function safeWorkspacePath(requestedPath: string) {
  const normalized = path.posix.resolve("/workspace", requestedPath || ".");
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) {
    throw new HttpError(400, "invalid_workspace_path", "Path must stay under /workspace.");
  }
  return normalized;
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
) {
  const relative = path.posix.relative("/workspace", filePath);
  let current = "/workspace";
  for (const component of relative.split("/").filter(Boolean)) {
    current = path.posix.join(current, component);
    const file = await sandbox.statFile(current);
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
    return new HttpError(
      error.statusCode >= 400 ? error.statusCode : 502,
      `sandbox0_${error.code || "request_failed"}`,
      error.message,
    );
  }
  return error;
}

function isMissingResource(error: unknown) {
  return error instanceof APIError && error.statusCode === 404;
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
