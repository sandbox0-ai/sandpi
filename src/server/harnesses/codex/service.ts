import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";

import type { CodexRolloutActivityFeed } from "@/harnesses/codex/rollout-activity";
import {
  CODEX_TRANSCRIPT_NOTIFICATION_METHODS,
  type CodexEventEnvelope,
  type CodexNativeSnapshot,
  type CodexServerNotification,
  type CodexThread,
} from "@/harnesses/codex/types";
import type {
  CodexEnvironmentSkill,
  CodexMcpAuthStatus,
  CodexMcpInventory,
  CodexMcpServer,
  CodexMcpServerInput,
  CodexMcpTransport,
  CodexSkillDependency,
  CodexSkillError,
  CodexSkillsInventory,
} from "@/harnesses/codex/environment-tools";
import type { Environment } from "@/lib/types";
import { toUnixTimestamp } from "@/lib/time";
import { HttpError } from "@/server/http-error";
import type {
  EnvironmentRuntimeRecord,
  RuntimeAdapter,
} from "@/server/runtime/types";
import {
  SandpiStore,
  type CodexControlTransition,
  type StoredEnvironmentRuntime,
  type StoredSessionRuntime,
} from "@/server/store";
import {
  decodeCodexSupervisorEvents,
  type DecodedCodexRecord,
  type SupervisorOutputEvent,
} from "./jsonl";
import {
  nativeCodexTurnInput,
  type EncodedCodexInputImage,
} from "./input-images";
import { parseCodexRolloutActivity } from "./rollout-activity";

const STREAM_RECONNECT_DELAY_MS = 250;
const STREAM_BATCH_DELAY_MS = 20;
const STREAM_BATCH_MAX_EVENTS = 128;
const RPC_TIMEOUT_MS = 30_000;
const RUNTIME_RECOVERY_LOCK_TIMEOUT_MS = 130_000;
const RUNTIME_RECOVERY_LOCK_RETRY_MS = 250;
const MAX_RPC_RESPONSES_PER_ENVIRONMENT = 512;
const MAX_LIVE_NOTIFICATIONS_PER_SESSION = 1_000;
const CODEX_ENVIRONMENT_CWD = "/workspace";
const CODEX_ENVIRONMENT_HOME = "/workspace/.sandpi/harnesses/codex";
const CODEX_ROLLOUT_ROOTS = [
  `${CODEX_ENVIRONMENT_HOME}/sessions`,
  `${CODEX_ENVIRONMENT_HOME}/archived_sessions`,
] as const;
const CODEX_ROLLOUT_READ_TIMEOUT_MS = 30_000;
const CODEX_MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TRANSCRIPT_NOTIFICATION_METHODS = new Set<string>(
  CODEX_TRANSCRIPT_NOTIFICATION_METHODS,
);

interface ServiceLogger {
  debug(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

interface RpcWaiter {
  promise: Promise<Record<string, unknown>>;
  resolve(response: Record<string, unknown>): void;
  reject(error: unknown): void;
}

interface RpcAnchor {
  sessionId: string;
  liveCursor: number;
}

export type CodexLiveUpdate =
  | {
      cursor: number;
      kind: "notification";
      event: CodexEventEnvelope;
      /** The completed Turn may have appended calls omitted by thread/read. */
      refreshPersistedActivity: boolean;
    }
  | {
      cursor: number;
      kind: "invalidation";
      reason: string;
      message?: string;
      unrecoverable?: boolean;
    };

interface LiveNotificationState {
  cursor: number;
  updates: CodexLiveUpdate[];
}

export interface CodexCredentialMaterial {
  sourceId: string;
  revision: number;
  authJson: string;
}

export interface CodexCredentialProvider {
  credentialForEnvironment(
    userId: string,
    environmentId: string,
  ): Promise<CodexCredentialMaterial>;
  credentialForEnvironmentRuntime(
    environmentId: string,
  ): Promise<CodexCredentialMaterial>;
  markCredentialMaterialized(
    environmentId: string,
    credential: CodexCredentialMaterial,
  ): Promise<void>;
  syncCredentialFromRuntime(
    environmentId: string,
    authJson: string,
  ): Promise<CodexCredentialMaterial | undefined>;
}

export interface CodexNativeSnapshotRead {
  snapshot: CodexNativeSnapshot;
  /** Process-local cursor at the exact matching thread/read response. */
  liveCursor: number;
  /** Supplemental rollout read that never delays the conversation snapshot. */
  activity: Promise<CodexRolloutActivityFeed>;
}

/**
 * Codex app-server is Environment-scoped and natively owns many Threads.
 * Sandpi persists only native ids and control coordinates; it never projects a
 * second conversation history into PostgreSQL.
 */
export class CodexService {
  private readonly workers = new Map<string, AbortController>();
  private readonly workerTasks = new Map<string, Promise<void>>();
  private readonly recovering = new Map<
    string,
    Promise<StoredEnvironmentRuntime>
  >();
  private readonly initializing = new Map<string, Promise<void>>();
  private readonly credentialSyncs = new Map<string, Promise<void>>();
  private readonly rpcResponses = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();
  private readonly rpcAnchors = new Map<string, Map<string, RpcAnchor>>();
  private readonly rpcWaiters = new Map<string, Set<RpcWaiter>>();
  private readonly requestOwners = new Map<string, string>();
  private readonly nativeOwners = new Map<string, string>();
  private readonly live = new Map<string, LiveNotificationState>();
  private readonly events = new EventEmitter();
  private readonly startupRecoveries = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly store: SandpiStore,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: ServiceLogger,
    private readonly credentials: CodexCredentialProvider,
    private readonly options: {
      streamReconnectDelayMs?: number;
      streamBatchDelayMs?: number;
    } = {},
  ) {
    this.events.setMaxListeners(0);
  }

  async resumeWorkers() {
    const environmentIds = await this.store.activeEnvironmentRuntimeIds();
    const recoveries: Promise<void>[] = [];
    for (const environmentId of environmentIds) {
      const recovery = this.recoverEnvironmentRuntime(environmentId)
        .then(() => undefined)
        .catch((error) => {
          this.logger.warn(
            { environmentId, error: errorMessage(error) },
            "Codex Environment runtime recovery deferred",
          );
        })
        .finally(() => {
          this.startupRecoveries.delete(recovery);
          if (!this.closed) this.ensureEnvironmentWorker(environmentId);
        });
      this.startupRecoveries.add(recovery);
      recoveries.push(recovery);
    }
    await Promise.allSettled(recoveries);
  }

  async createSession(input: {
    userId: string;
    environment: Environment;
    title: string;
    prompt: string;
    images: EncodedCodexInputImage[];
    modelId?: string;
  }) {
    const environmentRuntime = await this.ensureEnvironmentRuntimeForUser(
      input.userId,
      input.environment,
    );
    const sessionId = await this.store.createSessionMetadata(input);
    try {
      const response = await this.requestCodex(
        input.environment.id,
        environmentRuntime,
        {
          method: "thread/start",
          id: rpcId("thread-start", sessionId),
          params: threadConfiguration(input.modelId),
        },
        sessionId,
      );
      if (response.error) {
        throw new HttpError(
          502,
          "codex_thread_failed",
          rpcErrorMessage(response.error),
        );
      }
      const nativeSessionId = threadIdFromRpcResponse(response);
      if (!nativeSessionId) {
        throw new HttpError(
          502,
          "codex_thread_failed",
          "Codex did not return its native Session id.",
        );
      }
      await this.store.markSessionNativeReady(sessionId, nativeSessionId);
      this.rememberNativeOwner(input.environment.id, nativeSessionId, sessionId);
      await this.startTurn({
        userId: input.userId,
        sessionId,
        text: input.prompt,
        images: input.images,
        modelId: input.modelId,
      });
      this.ensureEnvironmentWorker(input.environment.id);
      return sessionId;
    } catch (error) {
      await this.store.markSessionFailed(sessionId, errorMessage(error));
      throw error;
    }
  }

  async forkSession(input: {
    userId: string;
    sessionId: string;
    title?: string;
  }) {
    return this.createNativeFork({
      ...input,
      kind: "session",
    });
  }

  async forkTurn(input: {
    userId: string;
    sessionId: string;
    nativeTurnId: string;
    title?: string;
  }) {
    return this.createNativeFork({
      ...input,
      kind: "turn",
      selectedNativeTurnId: input.nativeTurnId,
    });
  }

  /**
   * A native fork always becomes a child product Session. Do not replace the
   * source Session's Thread to emulate edit/delete: Codex history can branch,
   * but the Environment's shared Workspace cannot be rolled back with it.
   */
  private async createNativeFork(input: {
    userId: string;
    sessionId: string;
    title?: string;
    kind: "session" | "turn";
    selectedNativeTurnId?: string;
  }) {
    const source = await this.store.getSession(input.userId, input.sessionId);
    const sourceRuntime = await this.requireNativeSessionRuntime(
      input.userId,
      input.sessionId,
    );
    if (source.status !== "waiting" || sourceRuntime.activeNativeTurnId) {
      throw new HttpError(
        409,
        "session_fork_not_ready",
        "Wait for the current Codex Turn to finish before forking.",
      );
    }
    const environment = await this.store.getEnvironment(
      input.userId,
      source.environmentId,
    );
    const environmentRuntime = await this.environmentRuntimeForSession(
      input.userId,
      input.sessionId,
    );
    if (input.selectedNativeTurnId) {
      const thread = await this.readNativeThread(
        environmentRuntime,
        sourceRuntime,
        input.sessionId,
      );
      const selected = thread.turns.find(
        (turn) => turn.id === input.selectedNativeTurnId,
      );
      if (!selected || selected.status === "inProgress") {
        throw new HttpError(
          409,
          "turn_fork_not_ready",
          "The selected native Turn cannot be forked.",
        );
      }
    }
    const childSessionId = await this.store.createForkSessionMetadata({
      userId: input.userId,
      environment,
      source,
      modelId: sourceRuntime.modelId,
      title: input.title,
      kind: input.kind,
      sourceNativeItemId: input.selectedNativeTurnId,
    });
    try {
      const response = await this.requestCodex(
        environment.id,
        environmentRuntime,
        {
          method: "thread/fork",
          id: rpcId("thread-fork", childSessionId),
          params: {
            threadId: sourceRuntime.nativeSessionId,
            ...(input.selectedNativeTurnId
              ? { lastTurnId: input.selectedNativeTurnId }
              : {}),
            ...threadConfiguration(sourceRuntime.modelId),
          },
        },
        childSessionId,
      );
      if (response.error) {
        throw new HttpError(
          502,
          "codex_thread_fork_failed",
          rpcErrorMessage(response.error),
        );
      }
      const nativeSessionId = threadIdFromRpcResponse(response);
      if (!nativeSessionId) {
        throw new HttpError(
          502,
          "codex_thread_fork_failed",
          "Codex did not return the forked native Session.",
        );
      }
      await this.store.markSessionNativeReady(childSessionId, nativeSessionId);
      this.rememberNativeOwner(environment.id, nativeSessionId, childSessionId);
      this.ensureEnvironmentWorker(environment.id);
      return childSessionId;
    } catch (error) {
      await this.store.markSessionFailed(childSessionId, errorMessage(error));
      throw error;
    }
  }

  async listEnvironmentSkills(
    userId: string,
    environmentId: string,
    forceReload = false,
  ): Promise<CodexSkillsInventory> {
    const runtime = await this.environmentRuntimeForEnvironment(
      userId,
      environmentId,
    );
    const response = await this.requestCodex(environmentId, runtime, {
      method: "skills/list",
      id: rpcId("skills-list", environmentId),
      params: {
        cwds: [CODEX_ENVIRONMENT_CWD],
        ...(forceReload ? { forceReload: true } : {}),
      },
    });
    const result = requireRpcResult(
      response,
      "codex_skills_list_failed",
      "Codex could not list Environment skills.",
    );
    return codexSkillsInventory(result);
  }

  async setEnvironmentSkillEnabled(input: {
    userId: string;
    environmentId: string;
    path: string;
    enabled: boolean;
  }) {
    const inventory = await this.listEnvironmentSkills(
      input.userId,
      input.environmentId,
      true,
    );
    if (!inventory.skills.some((skill) => skill.path === input.path)) {
      throw new HttpError(
        404,
        "codex_skill_not_found",
        "The Codex skill is no longer available in this Environment.",
      );
    }
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    const response = await this.requestCodex(input.environmentId, runtime, {
      method: "skills/config/write",
      id: rpcId("skills-config-write", input.environmentId),
      params: { path: input.path, enabled: input.enabled },
    });
    const result = requireRpcResult(
      response,
      "codex_skill_update_failed",
      "Codex could not update the skill.",
    );
    return {
      path: input.path,
      enabled: objectBoolean(result, "effectiveEnabled") ?? input.enabled,
    };
  }

  async listEnvironmentMcpServers(
    userId: string,
    environmentId: string,
  ): Promise<CodexMcpInventory> {
    const runtime = await this.environmentRuntimeForEnvironment(
      userId,
      environmentId,
    );
    return this.readEnvironmentMcpInventory(environmentId, runtime);
  }

  async createEnvironmentMcpServer(input: {
    userId: string;
    environmentId: string;
    name: string;
    server: CodexMcpServerInput;
  }) {
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    const config = await this.readEnvironmentCodexConfig(
      input.environmentId,
      runtime,
    );
    const name = requireMcpServerName(input.name);
    if (Object.hasOwn(config.effectiveServers, name)) {
      throw new HttpError(
        409,
        "codex_mcp_server_exists",
        "An MCP server with this name already exists in the effective Codex configuration.",
      );
    }
    await this.writeEnvironmentMcpServer(
      input.environmentId,
      runtime,
      name,
      input.server,
    );
    return this.readEnvironmentMcpInventory(input.environmentId, runtime);
  }

  async updateEnvironmentMcpServer(input: {
    userId: string;
    environmentId: string;
    name: string;
    server: CodexMcpServerInput;
  }) {
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    const config = await this.readEnvironmentCodexConfig(
      input.environmentId,
      runtime,
    );
    const name = requireMcpServerName(input.name);
    const current = objectRecord(config.userServers[name]);
    if (!current) {
      throw new HttpError(
        404,
        "codex_mcp_server_not_managed",
        "This MCP server is not managed by the Environment Codex configuration.",
      );
    }
    const currentTransport = mcpTransport(current);
    if (currentTransport && currentTransport !== input.server.transport) {
      throw new HttpError(
        409,
        "codex_mcp_transport_immutable",
        "Remove and recreate the MCP server to change its transport.",
      );
    }
    await this.writeEnvironmentMcpServer(
      input.environmentId,
      runtime,
      name,
      input.server,
    );
    return this.readEnvironmentMcpInventory(input.environmentId, runtime);
  }

  async setEnvironmentMcpServerEnabled(input: {
    userId: string;
    environmentId: string;
    name: string;
    enabled: boolean;
  }) {
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    const config = await this.readEnvironmentCodexConfig(
      input.environmentId,
      runtime,
    );
    const name = requireMcpServerName(input.name);
    if (!Object.hasOwn(config.userServers, name)) {
      throw new HttpError(
        404,
        "codex_mcp_server_not_managed",
        "This MCP server is not managed by the Environment Codex configuration.",
      );
    }
    await this.writeCodexConfigValue(input.environmentId, runtime, {
      keyPath: `mcp_servers.${name}.enabled`,
      value: input.enabled,
    });
    await this.reloadEnvironmentMcpServers(input.environmentId, runtime);
    return this.readEnvironmentMcpInventory(input.environmentId, runtime);
  }

  async deleteEnvironmentMcpServer(input: {
    userId: string;
    environmentId: string;
    name: string;
  }) {
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    const config = await this.readEnvironmentCodexConfig(
      input.environmentId,
      runtime,
    );
    const name = requireMcpServerName(input.name);
    if (!Object.hasOwn(config.userServers, name)) {
      throw new HttpError(
        404,
        "codex_mcp_server_not_managed",
        "This MCP server is not managed by the Environment Codex configuration.",
      );
    }
    await this.writeCodexConfigValue(input.environmentId, runtime, {
      keyPath: `mcp_servers.${name}`,
      value: null,
    });
    await this.reloadEnvironmentMcpServers(input.environmentId, runtime);
    return this.readEnvironmentMcpInventory(input.environmentId, runtime);
  }

  private async readEnvironmentMcpInventory(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
  ): Promise<CodexMcpInventory> {
    const config = await this.readEnvironmentCodexConfig(environmentId, runtime);
    const statuses = new Map<string, Record<string, unknown>>();
    let cursor: string | undefined;
    do {
      const response = await this.requestCodex(environmentId, runtime, {
        method: "mcpServerStatus/list",
        id: rpcId("mcp-status-list", environmentId),
        params: {
          detail: "toolsAndAuthOnly",
          ...(cursor ? { cursor } : {}),
        },
      });
      const result = requireRpcResult(
        response,
        "codex_mcp_status_failed",
        "Codex could not inspect MCP server status.",
      );
      const data = result.data;
      if (!Array.isArray(data)) {
        throw invalidCodexResponse(
          "codex_mcp_status_failed",
          "Codex returned an invalid MCP status list.",
        );
      }
      for (const value of data) {
        const status = objectRecord(value);
        const name = objectString(status, "name");
        if (status && name) statuses.set(name, status);
      }
      const nextCursor = result.nextCursor;
      if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
        throw invalidCodexResponse(
          "codex_mcp_status_failed",
          "Codex returned an invalid MCP status cursor.",
        );
      }
      cursor = typeof nextCursor === "string" && nextCursor ? nextCursor : undefined;
    } while (cursor);

    return {
      servers: Object.entries(config.effectiveServers)
        .flatMap(([name, value]) => {
          const definition = objectRecord(value);
          if (!definition) return [];
          return [
            codexMcpServer(
              name,
              definition,
              statuses.get(name),
              Object.hasOwn(config.userServers, name),
            ),
          ];
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  private async readEnvironmentCodexConfig(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
  ) {
    const response = await this.requestCodex(environmentId, runtime, {
      method: "config/read",
      id: rpcId("config-read", environmentId),
      params: { includeLayers: true, cwd: CODEX_ENVIRONMENT_CWD },
    });
    const result = requireRpcResult(
      response,
      "codex_config_read_failed",
      "Codex could not read the Environment configuration.",
    );
    const config = objectRecord(result.config);
    if (!config) {
      throw invalidCodexResponse(
        "codex_config_read_failed",
        "Codex returned an invalid Environment configuration.",
      );
    }
    const effectiveServers = objectRecord(config.mcp_servers) ?? {};
    const layers = Array.isArray(result.layers) ? result.layers : [];
    const userLayer = layers.find((value) => {
      const layer = objectRecord(value);
      const name = objectRecord(layer?.name);
      return objectString(name, "type") === "user" && name?.profile == null;
    });
    const userConfig = objectRecord(objectRecord(userLayer)?.config);
    return {
      effectiveServers,
      userServers: objectRecord(userConfig?.mcp_servers) ?? {},
    };
  }

  private async writeEnvironmentMcpServer(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
    name: string,
    server: CodexMcpServerInput,
  ) {
    const values = codexMcpConfigValues(server);
    const response = await this.requestCodex(environmentId, runtime, {
      method: "config/batchWrite",
      id: rpcId("mcp-config-write", environmentId),
      params: {
        edits: Object.entries(values).map(([key, value]) => ({
          keyPath: `mcp_servers.${name}.${key}`,
          value,
          mergeStrategy: "replace",
        })),
        reloadUserConfig: true,
      },
    });
    requireRpcResult(
      response,
      "codex_mcp_update_failed",
      "Codex could not update the MCP server.",
    );
    await this.reloadEnvironmentMcpServers(environmentId, runtime);
  }

  private async writeCodexConfigValue(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
    edit: { keyPath: string; value: unknown },
  ) {
    const response = await this.requestCodex(environmentId, runtime, {
      method: "config/value/write",
      id: rpcId("config-value-write", environmentId),
      params: {
        ...edit,
        mergeStrategy: "replace",
      },
    });
    requireRpcResult(
      response,
      "codex_config_write_failed",
      "Codex could not update the Environment configuration.",
    );
  }

  private async reloadEnvironmentMcpServers(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
  ) {
    const response = await this.requestCodex(environmentId, runtime, {
      method: "config/mcpServer/reload",
      id: rpcId("mcp-reload", environmentId),
    });
    requireRpcResult(
      response,
      "codex_mcp_reload_failed",
      "Codex saved the MCP configuration but could not reload it.",
    );
  }

  async startTurn(input: {
    userId: string;
    sessionId: string;
    text: string;
    images: EncodedCodexInputImage[];
    modelId?: string;
  }) {
    const sessionRuntime = await this.requireNativeSessionRuntime(
      input.userId,
      input.sessionId,
    );
    const submission = turnSubmissionCoordinates(input.sessionId);
    // Persist pending delivery while holding the same Environment advisory
    // lock used by idle pause. If pause won first, the following native runtime
    // access auto-resumes it; if Turn admission won first, pause observes work.
    await this.store.beginSessionTurn(
      input.userId,
      input.sessionId,
      input.modelId,
      submission,
    );
    try {
      const environmentRuntime = await this.environmentRuntimeForSession(
        input.userId,
        input.sessionId,
      );
      await this.store.markTurnSubmitted(
        input.sessionId,
        submission.requestId,
      );
      const response = await this.requestCodex(
        sessionRuntime.environmentId,
        environmentRuntime,
        {
          method: "turn/start",
          id: submission.requestId,
          params: {
            threadId: sessionRuntime.nativeSessionId,
            clientUserMessageId: submission.clientMessageId,
            input: nativeCodexTurnInput(input.text, input.images),
            ...(input.modelId ? { model: input.modelId } : {}),
          },
        },
        input.sessionId,
        submission.stableInputId,
      );
      if (response.error) {
        await this.store.abandonTurn(input.sessionId, submission.requestId);
        throw new HttpError(
          502,
          "codex_turn_start_failed",
          rpcErrorMessage(response.error),
        );
      }
      const nativeTurnId = turnIdFromRpcResponse(response);
      if (nativeTurnId) {
        await this.store.markTurnAccepted(
          input.sessionId,
          submission.requestId,
          nativeTurnId,
        );
      }
      this.ensureEnvironmentWorker(sessionRuntime.environmentId);
      return { requestId: submission.requestId, nativeTurnId };
    } catch (error) {
      if (isRpcTimeout(error)) {
        // Delivery is ambiguous after a transport timeout. Native events and
        // thread/read remain authoritative, so retain the pending coordinates.
        this.ensureEnvironmentWorker(sessionRuntime.environmentId);
        return { requestId: submission.requestId };
      }
      await this.store.abandonTurn(input.sessionId, submission.requestId);
      throw error;
    }
  }

  async listModels(userId: string, sessionId: string) {
    const sessionRuntime = await this.store.getSessionRuntime(userId, sessionId);
    const environmentRuntime = await this.environmentRuntimeForSession(
      userId,
      sessionId,
    );
    const data: unknown[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.requestCodex(
        sessionRuntime.environmentId,
        environmentRuntime,
        {
          method: "model/list",
          id: rpcId("model-list", sessionId),
          params: cursor ? { cursor } : {},
        },
        sessionId,
      );
      if (response.error) {
        throw new HttpError(
          502,
          "codex_model_list_failed",
          rpcErrorMessage(response.error),
        );
      }
      const page = modelListPage(response.result);
      data.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return { data };
  }

  async readNativeSnapshot(userId: string, sessionId: string) {
    const read = await this.readNativeSnapshotWithCursor(userId, sessionId);
    return {
      ...read.snapshot,
      activity: await read.activity,
    };
  }

  async readNativeSnapshotWithCursor(
    userId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<CodexNativeSnapshotRead> {
    const sessionRuntime = await this.requireNativeSessionRuntime(
      userId,
      sessionId,
    );
    if (sessionRuntime.runtimeErrorCode === "legacy_isolated_runtime") {
      throw new HttpError(
        409,
        "codex_native_session_unrecoverable",
        "This Session belongs to the retired isolated-runtime architecture.",
      );
    }
    const environmentRuntime = await this.environmentRuntimeForSession(
      userId,
      sessionId,
    );
    const requestId = rpcId("thread-read", sessionId);
    const response = await this.requestCodex(
      sessionRuntime.environmentId,
      environmentRuntime,
      {
        method: "thread/read",
        id: requestId,
        params: {
          threadId: sessionRuntime.nativeSessionId,
          includeTurns: true,
        },
      },
      sessionId,
    );
    if (response.error) {
      throw nativeSessionUnavailable(response.error);
    }
    const thread = threadFromRpcResponse(response);
    if (!thread) {
      throw new HttpError(
        502,
        "codex_thread_read_failed",
        "Codex returned an invalid native Session snapshot.",
      );
    }
    const anchor = this.takeRpcAnchor(
      sessionRuntime.environmentId,
      requestId,
      sessionId,
    );
    const activity = this.readCodexRolloutActivity(
      sessionRuntime.environmentId,
      environmentRuntime,
      sessionRuntime.nativeSessionId,
      thread.path,
      signal,
    );
    const latest = await this.store.sessionRuntime(sessionId);
    const forkableTurnIds = thread.turns
      .filter((turn) => turn.status !== "inProgress")
      .map((turn) => turn.id);
    return {
      snapshot: {
        protocol: "codex-app-server",
        nativeSessionId: latest.nativeSessionId ?? sessionRuntime.nativeSessionId,
        historyRevision: latest.historyRevision,
        modelId: latest.modelId ?? "",
        sessionStatus:
          latest.sessionStatus === "provisioning"
            ? "waiting"
            : latest.sessionStatus,
        thread,
        activity: loadingCodexRolloutActivity(),
        forkableTurnIds,
      },
      liveCursor: anchor ?? this.liveCursor(sessionId),
      activity,
    };
  }

  private async readCodexRolloutActivity(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
    nativeSessionId: string,
    nativeRolloutPath: unknown,
    signal?: AbortSignal,
  ): Promise<CodexRolloutActivityFeed> {
    const rolloutPath = validCodexRolloutPath(
      nativeRolloutPath,
      nativeSessionId,
    );
    if (!rolloutPath) {
      return unavailableCodexRolloutActivity(
        nativeRolloutPath !== null && nativeRolloutPath !== undefined
          ? "codex_rollout_path_invalid"
          : "codex_rollout_path_missing",
        nativeRolloutPath !== null && nativeRolloutPath !== undefined
          ? "Codex returned an invalid rollout path. Persisted tool activity is unavailable."
          : "Codex did not expose a rollout path. Persisted tool activity is unavailable.",
      );
    }

    let readTimeout: ReturnType<typeof setTimeout> | undefined;
    let abortRead: (() => void) | undefined;
    try {
      const reads: Array<Promise<Uint8Array>> = [
        this.runtime.readCodexRollout(
          runtime,
          rolloutPath,
          nativeSessionId,
          signal,
        ),
        new Promise<never>((_, reject) => {
          readTimeout = setTimeout(
            () =>
              reject(
                new HttpError(
                  504,
                  "codex_rollout_read_timeout",
                  "Codex rollout activity took too long to load.",
                ),
              ),
            CODEX_ROLLOUT_READ_TIMEOUT_MS,
          );
          readTimeout.unref();
        }),
      ];
      if (signal) {
        reads.push(
          new Promise<never>((_, reject) => {
            abortRead = () =>
              reject(
                new HttpError(
                  499,
                  "codex_rollout_read_aborted",
                  "Codex rollout activity loading was cancelled.",
                ),
              );
            if (signal.aborted) abortRead();
            else signal.addEventListener("abort", abortRead, { once: true });
          }),
        );
      }
      const bytes = await Promise.race(reads);
      return parseCodexRolloutActivity(
        Buffer.from(bytes).toString("utf8"),
        nativeSessionId,
      );
    } catch (error) {
      const code =
        error instanceof HttpError ? error.code : "codex_rollout_read_failed";
      const message = errorMessage(error);
      this.logger.debug(
        {
          environmentId,
          nativeSessionId,
          code,
        },
        "Codex persisted Session Activity unavailable",
      );
      return unavailableCodexRolloutActivity(
        code.startsWith("codex_rollout_")
          ? code
          : "codex_rollout_read_failed",
        message,
      );
    } finally {
      if (readTimeout) clearTimeout(readTimeout);
      if (abortRead) signal?.removeEventListener("abort", abortRead);
    }
  }

  async interruptActiveTurn(input: {
    userId: string;
    sessionId: string;
    turnId: string;
  }) {
    const sessionRuntime = await this.requireNativeSessionRuntime(
      input.userId,
      input.sessionId,
    );
    if (
      sessionRuntime.activeNativeTurnId &&
      sessionRuntime.activeNativeTurnId !== input.turnId
    ) {
      throw new HttpError(
        409,
        "codex_turn_changed",
        "The active native Turn changed before it could be interrupted.",
      );
    }
    const environmentRuntime = await this.environmentRuntimeForSession(
      input.userId,
      input.sessionId,
    );
    const response = await this.requestCodex(
      sessionRuntime.environmentId,
      environmentRuntime,
      {
        method: "turn/interrupt",
        id: rpcId("turn-interrupt", input.sessionId),
        params: {
          threadId: sessionRuntime.nativeSessionId,
          turnId: input.turnId,
        },
      },
      input.sessionId,
    );
    if (response.error) {
      throw new HttpError(
        502,
        "codex_turn_interrupt_failed",
        rpcErrorMessage(response.error),
      );
    }
    return { turnId: input.turnId, status: "interrupting" as const };
  }

  async withRuntimeRecovery<T>(
    userId: string,
    sessionId: string,
    operation: (runtime: StoredEnvironmentRuntime) => Promise<T>,
  ) {
    const session = await this.store.getSession(userId, sessionId);
    return this.withEnvironmentRuntimeRecovery(
      userId,
      session.environmentId,
      operation,
    );
  }

  async withEnvironmentRuntimeRecovery<T>(
    userId: string,
    environmentId: string,
    operation: (runtime: StoredEnvironmentRuntime) => Promise<T>,
  ) {
    const environment = await this.store.getEnvironment(userId, environmentId);
    let runtime = await this.ensureEnvironmentRuntimeForUser(userId, environment);
    let result: T;
    try {
      result = await operation(runtime);
    } catch (error) {
      if (!isRecoverableRuntimeError(error)) throw error;
      runtime = await this.recoverEnvironmentRuntime(environmentId);
      result = await operation(runtime);
    }
    await this.reconcileEnvironmentAfterRuntimeAccess(environmentId);
    return result;
  }

  ensureWorker(sessionId: string) {
    void this.store
      .sessionRuntime(sessionId)
      .then((session) => this.ensureEnvironmentWorker(session.environmentId))
      .catch(() => undefined);
  }

  suspendEnvironmentWorker(environmentId: string) {
    this.workers.get(environmentId)?.abort();
  }

  private ensureEnvironmentWorker(environmentId: string) {
    this.startEnvironmentWorker(environmentId, false);
  }

  private restartEnvironmentWorker(environmentId: string) {
    this.startEnvironmentWorker(environmentId, true);
  }

  private startEnvironmentWorker(environmentId: string, replace: boolean) {
    if (this.closed) return;
    const active = this.workers.get(environmentId);
    if (active && !replace) return;
    active?.abort();
    const controller = new AbortController();
    this.workers.set(environmentId, controller);
    const task = this.runWorker(environmentId, controller.signal).finally(() => {
      if (this.workers.get(environmentId) === controller) {
        this.workers.delete(environmentId);
      }
      if (this.workerTasks.get(environmentId) === task) {
        this.workerTasks.delete(environmentId);
      }
    });
    this.workerTasks.set(environmentId, task);
  }

  private async commitEnvironmentEvents(
    stored: StoredEnvironmentRuntime,
    values: readonly SupervisorOutputEvent[],
  ) {
    if (!stored.supervisorSessionId) {
      throw new HttpError(
        409,
        "codex_runtime_not_ready",
        "The Environment Codex runtime is not ready.",
      );
    }
    const events = values.filter(
      (event) => event.seq > stored.decoder.supervisorCursor,
    );
    if (events.length === 0) return stored;
    const decoded = decodeCodexSupervisorEvents(stored.decoder, events);
    if (decoded.state.supervisorCursor === stored.decoder.supervisorCursor) {
      return stored;
    }
    const transitions = controlTransitions(decoded.records);
    const committed = await this.store.commitEnvironmentTransport(
      stored.id,
      stored.supervisorSessionId,
      stored.decoder,
      decoded.state,
      transitions,
    );
    if (!committed) throw new EnvironmentEventStreamSupersededError();

    const next = {
      ...stored,
      decoder: decoded.state,
      attemptId: decoded.state.attemptId,
      runtimeGeneration: decoded.state.runtimeGeneration,
      version: stored.version + 1,
    };

    for (const record of decoded.records) {
      this.cacheRpcRecord(stored.id, record.message);
      if (!isTranscriptNotification(record.message)) continue;
      const nativeSessionId = notificationThreadId(record.message);
      if (!nativeSessionId) continue;
      const sessionId = await this.ownerForNativeThread(
        stored.id,
        nativeSessionId,
      );
      if (sessionId) this.publishLiveNotification(sessionId, record);
    }
    for (const transition of transitions) {
      if (transition.type !== "turnCompleted") continue;
      const sessionId = await this.ownerForNativeThread(
        stored.id,
        transition.nativeSessionId,
      );
      if (sessionId) this.events.emit(sessionId);
    }
    if (transitions.some((transition) => transition.type === "turnCompleted")) {
      await this.captureEnvironmentCredential(next);
    }
    if (decoded.invalidRecords.length > 0) {
      this.logger.warn(
        { environmentId: stored.id, count: decoded.invalidRecords.length },
        "Codex emitted invalid JSONL records",
      );
    }
    return next;
  }

  liveCursor(sessionId: string) {
    return this.live.get(sessionId)?.cursor ?? 0;
  }

  listLiveNotifications(sessionId: string, after = 0): CodexLiveUpdate[] {
    const state = this.live.get(sessionId);
    if (!state) return [];
    const oldestCursor = state.updates[0]?.cursor;
    if (oldestCursor !== undefined && after < oldestCursor - 1) {
      return [
        {
          cursor: oldestCursor - 1,
          kind: "invalidation",
          reason: "live-window-expired",
          message: "The live Codex update window expired; reload the native snapshot.",
        },
      ];
    }
    return state.updates.filter((update) => update.cursor > after);
  }

  async waitForSessionUpdate(sessionId: string, signal?: AbortSignal) {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.events.removeListener(sessionId, finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, 15_000);
      timer.unref();
      this.events.once(sessionId, finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  async close() {
    this.closed = true;
    for (const controller of this.workers.values()) controller.abort();
    await Promise.allSettled(this.workerTasks.values());
    await Promise.allSettled(this.startupRecoveries);
    await Promise.allSettled(this.recovering.values());
    await Promise.allSettled(this.credentialSyncs.values());
    for (const waiters of this.rpcWaiters.values()) {
      for (const waiter of waiters) waiter.reject(new Error("Codex service closed"));
    }
    this.workers.clear();
    this.workerTasks.clear();
    this.rpcWaiters.clear();
    this.rpcResponses.clear();
    this.rpcAnchors.clear();
  }

  private async ensureEnvironmentRuntimeForUser(
    userId: string,
    environment: Environment,
  ) {
    const current = await this.store.getEnvironmentRuntime(userId, environment.id);
    if (
      current.desiredState === "running" &&
      current.observedState === "running" &&
      current.supervisorSessionId &&
      current.attemptId
    ) {
      await this.ensureProtocolInitialized(current);
      return current;
    }
    // A supported Sandbox0 runtime operation inside recovery is the only wake
    // trigger. Concurrent callers share this Environment-scoped reconciliation.
    return this.recoverEnvironmentRuntime(environment.id);
  }

  private async environmentRuntimeForEnvironment(
    userId: string,
    environmentId: string,
  ) {
    const environment = await this.store.getEnvironment(userId, environmentId);
    if (environment.codingAgent.harness !== "codex") {
      throw new HttpError(
        409,
        "environment_harness_mismatch",
        "This Environment is not bound to the Codex harness.",
      );
    }
    return this.ensureEnvironmentRuntimeForUser(userId, environment);
  }

  private async environmentRuntimeForSession(userId: string, sessionId: string) {
    const session = await this.store.getSession(userId, sessionId);
    const environment = await this.store.getEnvironment(
      userId,
      session.environmentId,
    );
    return this.ensureEnvironmentRuntimeForUser(userId, environment);
  }

  private recoverEnvironmentRuntime(environmentId: string) {
    const active = this.recovering.get(environmentId);
    if (active) return active;
    const recovery = this.performEnvironmentRecovery(environmentId).finally(() => {
      if (this.recovering.get(environmentId) === recovery) {
        this.recovering.delete(environmentId);
      }
    });
    this.recovering.set(environmentId, recovery);
    return recovery;
  }

  private async performEnvironmentRecovery(environmentId: string) {
    const deadline = Date.now() + RUNTIME_RECOVERY_LOCK_TIMEOUT_MS;
    while (!this.closed) {
      const locked = await this.store.withEnvironmentLifecycleLock(
        environmentId,
        () => this.reconcileEnvironmentRuntime(environmentId),
      );
      if (locked.acquired) return locked.value;
      if (Date.now() >= deadline) {
        throw new HttpError(
          503,
          "environment_lifecycle_busy",
          "The Environment lifecycle is still changing. Try again shortly.",
        );
      }
      // Pause owns the same distributed lock through checkpoint commit. Wait
      // for it to finish, then let a supported Sandbox0 access auto-resume the
      // runtime; Sandpi never sends a competing explicit resume request.
      await delay(RUNTIME_RECOVERY_LOCK_RETRY_MS);
    }
    throw new Error("Codex service is closed");
  }

  private async reconcileEnvironmentRuntime(environmentId: string) {
    const current = await this.store.environmentRuntime(environmentId);
    let credential = await this.credentials.credentialForEnvironmentRuntime(
      environmentId,
    );
    try {
      const runtimeAuth = await this.runtime.readCodexEnvironmentCredential(current);
      const authoritative = await this.credentials.syncCredentialFromRuntime(
        environmentId,
        runtimeAuth,
      );
      if (authoritative) credential = authoritative;
    } catch {
      // /dev/shm is expected to be empty after a Sandbox runtime restart.
    }
    const recovered = await this.runtime.ensureCodexEnvironmentRuntime(
      current,
      credential.authJson,
    );
    const ready = await this.store.recordCodexEnvironmentRuntime(
      environmentId,
      recovered,
    );
    await this.credentials.markCredentialMaterialized(environmentId, credential);
    // A recovered Supervisor can have a new Session journal or process
    // attempt. Replace the upstream stream before issuing native RPCs so their
    // retained responses are consumed by the new coordinates.
    this.restartEnvironmentWorker(environmentId);
    await this.ensureProtocolInitialized(ready);
    await this.resumeEnvironmentNativeSessions(ready);
    return ready;
  }

  private async reconcileEnvironmentAfterRuntimeAccess(environmentId: string) {
    const current = await this.store.environmentRuntime(environmentId);
    if (
      current.desiredState === "running" &&
      current.observedState === "running"
    ) {
      return;
    }
    if (current.desiredState === "terminated") {
      throw new HttpError(
        409,
        "environment_terminated",
        "The Environment is being deleted.",
      );
    }
    // An idle pause can begin after request authorization but before the native
    // operation. Sandbox0 serializes that operation and may auto-resume it; the
    // shared lifecycle lock then makes Sandpi's runtime projection match the
    // native generation before this request is considered complete.
    await this.recoverEnvironmentRuntime(environmentId);
  }

  /**
   * A fresh Codex app-server can read persisted rollouts, but Thread execution
   * is native-runtime state. Reattach every product Session after Environment
   * recovery and derive only the refresh-safe active-Turn projection from the
   * native response; conversation content remains exclusively in Codex.
   */
  private async resumeEnvironmentNativeSessions(
    runtime: StoredEnvironmentRuntime,
  ) {
    const sessions = await this.store.sessionRuntimesForEnvironment(runtime.id);
    for (const session of sessions) {
      if (!session.nativeSessionId) continue;
      this.rememberNativeOwner(
        runtime.id,
        session.nativeSessionId,
        session.sessionId,
      );
      try {
        const response = await this.requestCodex(
          runtime.id,
          runtime,
          {
            method: "thread/resume",
            id: rpcId("thread-resume", session.sessionId),
            params: {
              threadId: session.nativeSessionId,
              ...threadConfiguration(session.modelId),
            },
          },
          session.sessionId,
        );
        if (response.error) throw nativeSessionUnavailable(response.error);
        const thread = threadFromRpcResponse(response);
        if (!thread) {
          throw new HttpError(
            502,
            "codex_thread_resume_failed",
            "Codex returned an invalid native Session resume response.",
          );
        }
        const activeNativeTurnId = thread.turns.find(
          (turn) => turn.status === "inProgress",
        )?.id;
        await this.store.reconcileNativeSessionState({
          sessionId: session.sessionId,
          nativeSessionId: session.nativeSessionId,
          historyRevision: session.historyRevision,
          activeNativeTurnId,
        });
      } catch (error) {
        this.logger.warn(
          {
            environmentId: runtime.id,
            sessionId: session.sessionId,
            error: errorMessage(error),
          },
          "Codex native Session could not be resumed",
        );
        this.publishInvalidation(session.sessionId, "native-session-resume-failed", {
          message:
            "The shared Codex runtime recovered, but this native Session could not be reattached yet.",
        });
      }
    }
  }

  private captureEnvironmentCredential(runtime: StoredEnvironmentRuntime) {
    const active = this.credentialSyncs.get(runtime.id);
    if (active) return active;
    const sync = (async () => {
      try {
        const authJson = await this.runtime.readCodexEnvironmentCredential(runtime);
        const authoritative = await this.credentials.syncCredentialFromRuntime(
          runtime.id,
          authJson,
        );
        if (!authoritative) return;
        await this.runtime.installCodexEnvironmentCredential(
          runtime,
          authoritative.authJson,
        );
        await this.credentials.markCredentialMaterialized(
          runtime.id,
          authoritative,
        );
      } catch (error) {
        this.logger.warn(
          { environmentId: runtime.id, error: errorMessage(error) },
          "Codex Environment credential could not be synchronized",
        );
      }
    })().finally(() => {
      if (this.credentialSyncs.get(runtime.id) === sync) {
        this.credentialSyncs.delete(runtime.id);
      }
    });
    this.credentialSyncs.set(runtime.id, sync);
    return sync;
  }

  private ensureProtocolInitialized(runtime: StoredEnvironmentRuntime) {
    if (!runtime.supervisorSessionId || !runtime.attemptId) {
      throw new HttpError(
        409,
        "codex_runtime_not_ready",
        "The Environment Codex runtime is not ready.",
      );
    }
    const key = `${runtime.id}:${runtime.attemptId}`;
    const active = this.initializing.get(key);
    if (active) return active;
    const initialize = (async () => {
      const response = await this.requestCodex(runtime.id, runtime, {
        method: "initialize",
        // Sandpi may restart while the app-server attempt keeps running. The
        // Supervisor input journal deduplicates stable ids, so each process
        // needs a fresh request id to receive a new initialize response.
        id: rpcId("initialize", runtime.id),
        params: {
          clientInfo: { name: "sandpi", title: "Sandpi", version: "0.1.0" },
        },
      });
      if (response.error && !isAlreadyInitializedError(response.error)) {
        throw new HttpError(
          502,
          "codex_initialize_failed",
          rpcErrorMessage(response.error),
        );
      }
      await this.runtime.writeCodexMessage(runtime, {
        method: "initialized",
        params: {},
      });
    })().catch((error) => {
      this.initializing.delete(key);
      throw error;
    });
    this.initializing.set(key, initialize);
    return initialize;
  }

  private async requireNativeSessionRuntime(userId: string, sessionId: string) {
    const runtime = await this.store.getSessionRuntime(userId, sessionId);
    if (!runtime.nativeSessionId) {
      throw new HttpError(
        409,
        "codex_thread_not_ready",
        "Codex native Session is not ready.",
      );
    }
    return runtime as StoredSessionRuntime & { nativeSessionId: string };
  }

  private async readNativeThread(
    environmentRuntime: StoredEnvironmentRuntime,
    sessionRuntime: StoredSessionRuntime & { nativeSessionId: string },
    ownerSessionId: string,
  ) {
    const response = await this.requestCodex(
      sessionRuntime.environmentId,
      environmentRuntime,
      {
        method: "thread/read",
        id: rpcId("thread-read", ownerSessionId),
        params: { threadId: sessionRuntime.nativeSessionId, includeTurns: true },
      },
      ownerSessionId,
    );
    if (response.error) throw nativeSessionUnavailable(response.error);
    const thread = threadFromRpcResponse(response);
    if (!thread) {
      throw new HttpError(
        502,
        "codex_thread_read_failed",
        "Codex returned an invalid native Session snapshot.",
      );
    }
    return thread;
  }

  private async requestCodex(
    environmentId: string,
    runtime: EnvironmentRuntimeRecord,
    message: Record<string, unknown>,
    ownerSessionId?: string,
    stableInputId?: string,
  ) {
    const requestId = message.id;
    if (typeof requestId !== "string") {
      throw new Error("A Codex RPC request must have a string id");
    }
    // The Supervisor journal retains a response written before the SSE
    // subscription finishes connecting, so starting the Environment worker is
    // sufficient; no request-specific polling loop is needed.
    this.ensureEnvironmentWorker(environmentId);
    this.takeRpcResponse(environmentId, requestId);
    if (ownerSessionId) {
      this.requestOwners.set(rpcKey(environmentId, requestId), ownerSessionId);
    }
    const waiter = this.registerRpcWaiter(environmentId, requestId);
    try {
      await this.runtime.writeCodexMessage(
        runtime,
        message,
        stableInputId ?? requestId,
      );
    } catch (error) {
      waiter.reject(error);
      return waiter.promise;
    }
    const response = await waiter.promise;
    await this.reconcileEnvironmentAfterRuntimeAccess(environmentId);
    return response;
  }

  private registerRpcWaiter(environmentId: string, requestId: string): RpcWaiter {
    const cached = this.takeRpcResponse(environmentId, requestId);
    if (cached) {
      return { promise: Promise.resolve(cached), resolve() {}, reject() {} };
    }
    const key = rpcKey(environmentId, requestId);
    let settled = false;
    let resolvePromise!: (response: Record<string, unknown>) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const cleanup = () => {
      clearTimeout(timer);
      const waiters = this.rpcWaiters.get(key);
      waiters?.delete(waiter);
      if (waiters?.size === 0) this.rpcWaiters.delete(key);
    };
    const waiter: RpcWaiter = {
      promise,
      resolve: (response) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(response);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      },
    };
    const timer = setTimeout(() => {
      waiter.reject(
        new HttpError(
          504,
          "codex_rpc_timeout",
          `Codex did not answer ${requestId.split(":", 1)[0]} in time.`,
        ),
      );
    }, RPC_TIMEOUT_MS);
    timer.unref();
    const waiters = this.rpcWaiters.get(key) ?? new Set<RpcWaiter>();
    waiters.add(waiter);
    this.rpcWaiters.set(key, waiters);
    return waiter;
  }

  private cacheRpcRecord(
    environmentId: string,
    message: Record<string, unknown>,
  ) {
    const id = message.id;
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      (message.result === undefined && message.error === undefined)
    ) {
      return;
    }
    const requestId = String(id);
    const key = rpcKey(environmentId, requestId);
    const ownerSessionId = this.requestOwners.get(key);
    if (ownerSessionId) {
      const anchors = this.rpcAnchors.get(environmentId) ?? new Map();
      anchors.delete(requestId);
      anchors.set(requestId, {
        sessionId: ownerSessionId,
        liveCursor: this.liveCursor(ownerSessionId),
      });
      trimMap(anchors, MAX_RPC_RESPONSES_PER_ENVIRONMENT);
      this.rpcAnchors.set(environmentId, anchors);
    }
    const responses = this.rpcResponses.get(environmentId) ?? new Map();
    responses.delete(requestId);
    responses.set(requestId, message);
    trimMap(responses, MAX_RPC_RESPONSES_PER_ENVIRONMENT);
    this.rpcResponses.set(environmentId, responses);
    const waiters = [...(this.rpcWaiters.get(key) ?? [])];
    if (waiters.length > 0) {
      responses.delete(requestId);
      for (const waiter of waiters) waiter.resolve(message);
    }
    this.requestOwners.delete(key);
  }

  private takeRpcResponse(environmentId: string, requestId: string) {
    const responses = this.rpcResponses.get(environmentId);
    const response = responses?.get(requestId);
    if (!response) return undefined;
    responses?.delete(requestId);
    if (responses?.size === 0) this.rpcResponses.delete(environmentId);
    return response;
  }

  private takeRpcAnchor(
    environmentId: string,
    requestId: string,
    sessionId: string,
  ) {
    const anchors = this.rpcAnchors.get(environmentId);
    const anchor = anchors?.get(requestId);
    if (!anchor || anchor.sessionId !== sessionId) return undefined;
    anchors?.delete(requestId);
    if (anchors?.size === 0) this.rpcAnchors.delete(environmentId);
    return anchor.liveCursor;
  }

  private publishLiveNotification(
    sessionId: string,
    record: DecodedCodexRecord,
  ) {
    const state = this.live.get(sessionId) ?? { cursor: 0, updates: [] };
    state.cursor += 1;
    const event: CodexEventEnvelope = {
      harness: "codex",
      harnessVersion: "runtime",
      protocolVersion: "v2",
      sequence: state.cursor,
      receivedAt: toUnixTimestamp(new Date(record.receivedAt)),
      notification: record.message as CodexServerNotification,
    };
    state.updates.push({
      cursor: state.cursor,
      kind: "notification",
      event,
      refreshPersistedActivity:
        event.notification.method === "turn/completed",
    });
    if (state.updates.length > MAX_LIVE_NOTIFICATIONS_PER_SESSION) {
      state.updates.splice(
        0,
        state.updates.length - MAX_LIVE_NOTIFICATIONS_PER_SESSION,
      );
    }
    this.live.set(sessionId, state);
    this.events.emit(sessionId);
  }

  private publishInvalidation(
    sessionId: string,
    reason: string,
    options: { message?: string; unrecoverable?: boolean } = {},
  ) {
    const state = this.live.get(sessionId) ?? { cursor: 0, updates: [] };
    state.cursor += 1;
    state.updates = [
      { cursor: state.cursor, kind: "invalidation", reason, ...options },
    ];
    this.live.set(sessionId, state);
    this.events.emit(sessionId);
  }

  private async invalidateEnvironmentSessions(
    environmentId: string,
    reason: string,
    message: string,
  ) {
    for (const sessionId of await this.store.sessionIdsForEnvironment(
      environmentId,
    )) {
      this.publishInvalidation(sessionId, reason, { message });
    }
  }

  private async ownerForNativeThread(
    environmentId: string,
    nativeSessionId: string,
  ) {
    const key = nativeOwnerKey(environmentId, nativeSessionId);
    const cached = this.nativeOwners.get(key);
    if (cached) return cached;
    const sessionId = await this.store.sessionIdForNativeThread(
      environmentId,
      nativeSessionId,
    );
    if (sessionId) this.nativeOwners.set(key, sessionId);
    return sessionId;
  }

  private rememberNativeOwner(
    environmentId: string,
    nativeSessionId: string,
    sessionId: string,
  ) {
    this.nativeOwners.set(
      nativeOwnerKey(environmentId, nativeSessionId),
      sessionId,
    );
  }

  private forgetNativeOwner(environmentId: string, nativeSessionId: string) {
    this.nativeOwners.delete(nativeOwnerKey(environmentId, nativeSessionId));
  }

  private async runWorker(environmentId: string, signal: AbortSignal) {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      let stream:
        | Awaited<ReturnType<RuntimeAdapter["watchCodexEvents"]>>
        | undefined;
      try {
        let stored = await this.store.environmentRuntime(environmentId);
        if (stored.desiredState !== "running") break;
        if (!stored.supervisorSessionId) {
          throw new HttpError(
            409,
            "codex_runtime_not_ready",
            "The Environment Codex runtime is not ready.",
          );
        }
        stream = await this.runtime.watchCodexEvents(
          stored,
          stored.decoder.supervisorCursor,
          signal,
        );
        consecutiveFailures = 0;
        for await (const batch of batchSupervisorEvents(
          stream.events,
          this.options.streamBatchDelayMs ?? STREAM_BATCH_DELAY_MS,
          STREAM_BATCH_MAX_EVENTS,
          signal,
        )) {
          if (signal.aborted) break;
          stored = await this.commitEnvironmentEvents(stored, batch);
        }
        if (!signal.aborted) {
          consecutiveFailures = 1;
          this.logger.debug(
            { environmentId },
            "Codex Environment event stream ended; reconnecting",
          );
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) break;
        if (error instanceof EnvironmentEventStreamSupersededError) {
          consecutiveFailures = 0;
          continue;
        }
        const earliest = expiredEventCursorEarliest(error);
        if (earliest !== undefined) {
          await this.store.resetEnvironmentDecoder(
            environmentId,
            Math.max(0, earliest - 1),
          );
          await this.invalidateEnvironmentSessions(
            environmentId,
            "supervisor-journal-gap",
            "Live execution events expired; the next reconnect reloads each native Codex Session.",
          );
          consecutiveFailures = 0;
          continue;
        }
        consecutiveFailures += 1;
        this.logger.warn(
          { environmentId, error: errorMessage(error) },
          "Codex Environment event stream failed",
        );
        if (isRecoverableRuntimeError(error)) {
          if (!(await this.store.environmentWantsRunning(environmentId))) break;
          try {
            await this.recoverEnvironmentRuntime(environmentId);
            await this.invalidateEnvironmentSessions(
              environmentId,
              "environment-runtime-recovered",
              "The shared Codex runtime restarted; native Sessions will be reloaded.",
            );
            consecutiveFailures = 0;
          } catch (recoveryError) {
            this.logger.warn(
              { environmentId, error: errorMessage(recoveryError) },
              "Codex Environment recovery failed",
            );
          }
        }
      } finally {
        try {
          await stream?.close();
        } catch {
          // The stream is already disconnected or aborted.
        }
      }
      if (signal.aborted) break;
      if (!(await this.store.environmentWantsRunning(environmentId))) break;
      const backoff = Math.min(
        30_000,
        (this.options.streamReconnectDelayMs ?? STREAM_RECONNECT_DELAY_MS) *
          2 ** Math.min(Math.max(0, consecutiveFailures - 1), 6),
      );
      await delay(backoff, signal);
    }
  }
}

function controlTransitions(
  records: readonly DecodedCodexRecord[],
): CodexControlTransition[] {
  const transitions: CodexControlTransition[] = [];
  for (const record of records) {
    const method = record.message.method;
    if (method !== "turn/started" && method !== "turn/completed") continue;
    const params = objectRecord(record.message.params);
    const turn = objectRecord(params?.turn);
    const nativeSessionId = objectString(params, "threadId");
    const nativeTurnId = objectString(turn, "id");
    if (!nativeSessionId || !nativeTurnId) continue;
    if (method === "turn/started") {
      const startedAt = objectNumber(turn, "startedAt");
      transitions.push({
        type: "turnStarted",
        nativeSessionId,
        nativeTurnId,
        startedAt:
          startedAt === undefined
            ? new Date(record.receivedAt)
            : new Date(startedAt * 1_000),
      });
      continue;
    }
    const status = objectString(turn, "status");
    if (status === "completed" || status === "failed" || status === "interrupted") {
      const completedAt = objectNumber(turn, "completedAt");
      transitions.push({
        type: "turnCompleted",
        nativeSessionId,
        nativeTurnId,
        status,
        completedAt:
          completedAt === undefined
            ? new Date(record.receivedAt)
            : new Date(completedAt * 1_000),
      });
    }
  }
  return transitions;
}

function isTranscriptNotification(
  message: Record<string, unknown>,
): message is Record<string, unknown> & CodexServerNotification {
  return (
    typeof message.method === "string" &&
    TRANSCRIPT_NOTIFICATION_METHODS.has(message.method)
  );
}

function notificationThreadId(message: Record<string, unknown>) {
  const params = objectRecord(message.params);
  return objectString(params, "threadId") ??
    objectString(objectRecord(params?.thread), "id");
}

function threadConfiguration(modelId?: string) {
  return {
    ...(modelId ? { model: modelId } : {}),
    cwd: "/workspace",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };
}

function threadIdFromRpcResponse(response: Record<string, unknown>) {
  return objectString(
    objectRecord(objectRecord(response.result)?.thread),
    "id",
  );
}

function threadFromRpcResponse(response: Record<string, unknown>) {
  const thread = objectRecord(objectRecord(response.result)?.thread);
  if (!thread || typeof thread.id !== "string" || !Array.isArray(thread.turns)) {
    return undefined;
  }
  return thread as unknown as CodexThread;
}

function turnIdFromRpcResponse(response: Record<string, unknown>) {
  return objectString(
    objectRecord(objectRecord(response.result)?.turn),
    "id",
  );
}

function requireRpcResult(
  response: Record<string, unknown>,
  code: string,
  message: string,
) {
  if (response.error) {
    throw new HttpError(502, code, `${message} ${rpcErrorMessage(response.error)}`);
  }
  const result = objectRecord(response.result);
  if (!result) throw invalidCodexResponse(code, message);
  return result;
}

function invalidCodexResponse(code: string, message: string) {
  return new HttpError(502, code, message);
}

function codexSkillsInventory(result: Record<string, unknown>): CodexSkillsInventory {
  if (!Array.isArray(result.data)) {
    throw invalidCodexResponse(
      "codex_skills_list_failed",
      "Codex returned an invalid skills list.",
    );
  }
  const entry = result.data
    .map(objectRecord)
    .find((candidate) => objectString(candidate, "cwd") === CODEX_ENVIRONMENT_CWD);
  if (!entry) {
    return { cwd: CODEX_ENVIRONMENT_CWD, skills: [], errors: [] };
  }
  const skills = Array.isArray(entry.skills)
    ? entry.skills.flatMap((value): CodexEnvironmentSkill[] => {
        const skill = objectRecord(value);
        const name = objectString(skill, "name");
        const path = objectString(skill, "path");
        const scope = objectString(skill, "scope");
        if (!name || !path || !isCodexSkillScope(scope)) return [];
        const skillInterface = objectRecord(skill?.interface);
        const dependencies = objectRecord(skill?.dependencies);
        return [
          {
            name,
            displayName: objectString(skillInterface, "displayName"),
            description: objectString(skill, "description") ?? "",
            shortDescription:
              objectString(skillInterface, "shortDescription") ??
              objectString(skill, "shortDescription"),
            path,
            scope,
            enabled: objectBoolean(skill, "enabled") ?? true,
            dependencies: codexSkillDependencies(dependencies?.tools),
          },
        ];
      })
    : [];
  const errors = Array.isArray(entry.errors)
    ? entry.errors.flatMap((value): CodexSkillError[] => {
        const error = objectRecord(value);
        const path = objectString(error, "path");
        const message = objectString(error, "message");
        return path && message ? [{ path, message }] : [];
      })
    : [];
  return {
    cwd: CODEX_ENVIRONMENT_CWD,
    skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
    errors,
  };
}

function isCodexSkillScope(
  value: string | undefined,
): value is CodexEnvironmentSkill["scope"] {
  return value === "user" || value === "repo" || value === "system" || value === "admin";
}

function codexSkillDependencies(value: unknown): CodexSkillDependency[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): CodexSkillDependency[] => {
    const dependency = objectRecord(candidate);
    const type = objectString(dependency, "type");
    const name = objectString(dependency, "value");
    if (!type || !name) return [];
    const description = objectString(dependency, "description");
    const transport = objectString(dependency, "transport");
    const command = objectString(dependency, "command");
    const url = objectString(dependency, "url");
    return [
      {
        type,
        value: name,
        ...(description ? { description } : {}),
        ...(transport ? { transport } : {}),
        ...(command ? { command } : {}),
        ...(url ? { url } : {}),
      },
    ];
  });
}

function requireMcpServerName(value: string) {
  const name = value.trim();
  if (!CODEX_MCP_SERVER_NAME.test(name)) {
    throw new HttpError(
      400,
      "invalid_codex_mcp_server_name",
      "MCP server names may contain letters, numbers, hyphens and underscores.",
    );
  }
  return name;
}

function mcpTransport(
  definition: Record<string, unknown>,
): CodexMcpTransport | undefined {
  if (typeof definition.command === "string") return "stdio";
  if (typeof definition.url === "string") return "streamable-http";
  return undefined;
}

function codexMcpConfigValues(server: CodexMcpServerInput) {
  return {
    command: server.transport === "stdio" ? server.command : null,
    args:
      server.transport === "stdio" && server.args.length > 0
        ? server.args
        : null,
    url: server.transport === "streamable-http" ? server.url : null,
    enabled: server.enabled,
    required: server.required,
    startup_timeout_sec: server.startupTimeoutSec ?? null,
    tool_timeout_sec: server.toolTimeoutSec ?? null,
    default_tools_approval_mode: server.defaultToolsApprovalMode ?? null,
    enabled_tools: server.enabledTools.length > 0 ? server.enabledTools : null,
    disabled_tools: server.disabledTools.length > 0 ? server.disabledTools : null,
  };
}

function codexMcpServer(
  name: string,
  definition: Record<string, unknown>,
  status: Record<string, unknown> | undefined,
  managed: boolean,
): CodexMcpServer {
  const transport = mcpTransport(definition) ?? "stdio";
  const enabled = objectBoolean(definition, "enabled") ?? true;
  const authStatus = codexMcpAuthStatus(objectString(status, "authStatus"));
  const serverInfo = objectRecord(status?.serverInfo);
  const tools = objectRecord(status?.tools);
  const resources = Array.isArray(status?.resources) ? status.resources : [];
  const resourceTemplates = Array.isArray(status?.resourceTemplates)
    ? status.resourceTemplates
    : [];
  const runtimeStatus = !enabled
    ? "disabled"
    : authStatus === "notLoggedIn"
      ? "authentication-required"
      : serverInfo
        ? "connected"
        : "unavailable";
  return {
    name,
    transport,
    command: objectString(definition, "command"),
    args: objectStringArray(definition.args),
    url: objectString(definition, "url"),
    enabled,
    required: objectBoolean(definition, "required") ?? false,
    startupTimeoutSec: objectNumber(definition, "startup_timeout_sec"),
    toolTimeoutSec: objectNumber(definition, "tool_timeout_sec"),
    defaultToolsApprovalMode: codexMcpApprovalMode(
      objectString(definition, "default_tools_approval_mode"),
    ),
    enabledTools: objectStringArray(definition.enabled_tools),
    disabledTools: objectStringArray(definition.disabled_tools),
    managed,
    authStatus,
    runtimeStatus,
    serverTitle: objectString(serverInfo, "title") ?? objectString(serverInfo, "name"),
    serverVersion: objectString(serverInfo, "version"),
    toolCount: tools ? Object.keys(tools).length : 0,
    resourceCount: resources.length + resourceTemplates.length,
  };
}

function codexMcpAuthStatus(value: string | undefined): CodexMcpAuthStatus {
  return value === "unsupported" ||
    value === "notLoggedIn" ||
    value === "bearerToken" ||
    value === "oAuth"
    ? value
    : "unknown";
}

function codexMcpApprovalMode(
  value: string | undefined,
): CodexMcpServer["defaultToolsApprovalMode"] {
  return value === "auto" ||
    value === "prompt" ||
    value === "writes" ||
    value === "approve"
    ? value
    : undefined;
}

function modelListPage(result: unknown) {
  const page = objectRecord(result);
  if (!page || !Array.isArray(page.data)) {
    throw new HttpError(
      502,
      "codex_model_list_failed",
      "Codex returned an invalid model catalog.",
    );
  }
  const nextCursor = page.nextCursor;
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    typeof nextCursor !== "string"
  ) {
    throw new HttpError(
      502,
      "codex_model_list_failed",
      "Codex returned an invalid model cursor.",
    );
  }
  return {
    data: page.data,
    nextCursor: typeof nextCursor === "string" && nextCursor ? nextCursor : undefined,
  };
}

function nativeSessionUnavailable(error: unknown) {
  return new HttpError(
    409,
    "codex_native_session_unrecoverable",
    `The native Codex Session is unavailable: ${rpcErrorMessage(error)}`,
  );
}

function rpcErrorMessage(error: unknown) {
  const record = objectRecord(error);
  return record && "message" in record
    ? String(record.message)
    : "Codex returned an RPC error.";
}

function isAlreadyInitializedError(error: unknown) {
  return rpcErrorMessage(error).toLowerCase().includes("already initialized");
}

function isRpcTimeout(error: unknown) {
  return error instanceof HttpError && error.code === "codex_rpc_timeout";
}

function isRecoverableRuntimeError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("transport endpoint is not connected")) return true;
  return (
    error instanceof HttpError &&
    (error.code === "supervisor_not_running" ||
      error.code === "codex_runtime_not_ready" ||
      (error.code.startsWith("sandbox0_") &&
        [404, 409, 503].includes(error.statusCode)))
  );
}

function turnSubmissionCoordinates(sessionId: string) {
  return {
    requestId: rpcId("turn-start", sessionId),
    clientMessageId: `user-message:${randomUUID()}`,
    stableInputId: `turn-input:${sessionId}:${randomUUID()}`,
  };
}

function rpcId(kind: string, sessionId: string) {
  return `${kind}:${sessionId}:${randomUUID()}`;
}

function validCodexRolloutPath(
  nativeRolloutPath: unknown,
  nativeSessionId: string,
) {
  if (
    typeof nativeRolloutPath !== "string" ||
    !nativeRolloutPath ||
    !path.posix.isAbsolute(nativeRolloutPath)
  ) {
    return undefined;
  }
  const normalized = path.posix.normalize(nativeRolloutPath);
  const underManagedRoot = CODEX_ROLLOUT_ROOTS.some((root) => {
    const relative = path.posix.relative(root, normalized);
    return relative !== "" && relative !== ".." && !relative.startsWith("../");
  });
  if (
    normalized !== nativeRolloutPath ||
    !underManagedRoot ||
    !path.posix.basename(normalized).endsWith(`-${nativeSessionId}.jsonl`)
  ) {
    return undefined;
  }
  return normalized;
}

function loadingCodexRolloutActivity(): CodexRolloutActivityFeed {
  return {
    source: "codex-rollout",
    availability: "loading",
    records: [],
    error: null,
  };
}

function unavailableCodexRolloutActivity(
  code: string,
  message: string,
): CodexRolloutActivityFeed {
  return {
    source: "codex-rollout",
    availability: "unavailable",
    records: [],
    error: { code, message },
  };
}

function rpcKey(environmentId: string, requestId: string) {
  return `${environmentId}\0${requestId}`;
}

function nativeOwnerKey(environmentId: string, nativeSessionId: string) {
  return `${environmentId}\0${nativeSessionId}`;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function objectString(value: unknown, key: string) {
  const field = objectRecord(value)?.[key];
  return typeof field === "string" ? field : undefined;
}

function objectNumber(value: unknown, key: string) {
  const field = objectRecord(value)?.[key];
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
}

function objectBoolean(value: unknown, key: string) {
  const field = objectRecord(value)?.[key];
  return typeof field === "boolean" ? field : undefined;
}

function objectStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function trimMap<K, V>(map: Map<K, V>, maximum: number) {
  while (map.size > maximum) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

class EnvironmentEventStreamSupersededError extends Error {
  constructor() {
    super("Environment event stream coordinates were superseded.");
    this.name = "EnvironmentEventStreamSupersededError";
  }
}

/**
 * Preserve low live latency without committing one PostgreSQL transaction per
 * stdout chunk. The pending iterator read is retained when the batch deadline
 * wins, so no event is cancelled or requested twice.
 */
async function* batchSupervisorEvents(
  source: AsyncIterable<SupervisorOutputEvent>,
  maximumDelayMs: number,
  maximumEvents: number,
  signal: AbortSignal,
) {
  const iterator = source[Symbol.asyncIterator]();
  let pending = iterator.next();
  while (!signal.aborted) {
    const first = await pending;
    if (first.done) return;
    const batch = [first.value];
    pending = iterator.next();
    const deadline = delay(maximumDelayMs, signal).then(() => ({
      kind: "deadline" as const,
    }));

    while (batch.length < maximumEvents && !signal.aborted) {
      const outcome = await Promise.race([
        pending.then((next) => ({ kind: "event" as const, next })),
        deadline,
      ]);
      if (outcome.kind === "deadline") break;
      if (outcome.next.done) {
        yield batch;
        return;
      }
      batch.push(outcome.next.value);
      pending = iterator.next();
    }
    yield batch;
  }
}

function expiredEventCursorEarliest(error: unknown) {
  if (
    !(error instanceof HttpError) ||
    !error.code.endsWith("event_cursor_expired")
  ) {
    return undefined;
  }
  const match = error.message.match(/earliest available sequence is (\d+)/i);
  if (!match) return undefined;
  const earliest = Number(match[1]);
  return Number.isSafeInteger(earliest) && earliest > 0
    ? earliest
    : undefined;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function delay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    function finish() {
      signal?.removeEventListener("abort", finish);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
