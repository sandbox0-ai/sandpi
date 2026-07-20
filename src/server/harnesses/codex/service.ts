import { AsyncLocalStorage } from "node:async_hooks";
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
  CodexAccountPlanType,
  CodexAccountRateLimits,
  CodexCreditsSnapshot,
  CodexEnvironmentSkill,
  CodexMcpAuthStatus,
  CodexMcpInventory,
  CodexMcpServer,
  CodexMcpServerInput,
  CodexMcpTransport,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexSkillDependency,
  CodexSkillError,
  CodexSkillsInventory,
  CodexSpendControlSnapshot,
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
  codexNativeEventIdentity,
  decodeCodexSupervisorEvents,
  type CodexNativeEventIdentity,
  type CodexDecoderState,
  type DecodedCodexRecord,
  type SupervisorOutputEvent,
} from "./jsonl";
import {
  nativeCodexTurnInput,
  type EncodedCodexInputImage,
} from "./input-images";
import type { EncodedCodexLocalImage } from "./input-files";
import { parseCodexRolloutActivity } from "./rollout-activity";

const STREAM_RECONNECT_DELAY_MS = 250;
const STREAM_BATCH_DELAY_MS = 20;
const STREAM_BATCH_MAX_EVENTS = 128;
const RPC_TIMEOUT_MS = 30_000;
const RPC_SUBMISSION_TIMEOUT_MS = 30_000;
const RUNTIME_RECOVERY_LOCK_TIMEOUT_MS = 130_000;
const RUNTIME_RECOVERY_LOCK_RETRY_MS = 250;
const EXCEPTIONAL_PENDING_TURN_GRACE_MS = 10 * 60_000;
const EXCEPTIONAL_SESSION_RETRY_BASE_MS = 1_000;
const EXCEPTIONAL_SESSION_RETRY_MAX_MS = 30_000;
const EXCEPTIONAL_SESSION_ACTIVE_RECHECK_MS = 30_000;
const EXCEPTIONAL_SESSION_REQUEST_TIMEOUT_MS = 5_000;
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
const MAX_CODEX_RATE_LIMIT_BUCKETS = 16;
const CODEX_ACCOUNT_PLAN_TYPES = new Set<CodexAccountPlanType>([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);
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
  armTimeout(): void;
  markDeliveryStarted(): void;
  rejectForRuntimeEpochChange(): void;
}

interface PreparedRpcRequest extends RpcWaiter {
  dispose(): void;
}

interface RpcAnchor {
  sessionId: string;
  liveCursor: number;
}

interface NativeSessionAttachmentState {
  epoch: string;
  threads: Map<string, Promise<void>>;
}

interface ExceptionalSessionReconciliation {
  epoch: string;
  task: Promise<void>;
  rerunRequested: boolean;
  rerunDelayMs?: number;
  retryAttempt: number;
  nextRetryAttempt: number;
  pendingTurnRequests: Map<string, string>;
  controller: AbortController;
}

interface DeferredExceptionalSessionReconciliation {
  pendingTurnRequests: Map<string, string>;
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

export interface CodexMcpOAuthCredentialMaterial {
  sourceId: string;
  revision: number;
  credentialsJson: string;
}

export interface CodexCredentialProvider {
  requireMcpOAuthPersistence?(): void;
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
  mcpOAuthCredentialForEnvironmentRuntime(
    environmentId: string,
  ): Promise<CodexMcpOAuthCredentialMaterial | undefined>;
  markMcpOAuthCredentialMaterialized(
    environmentId: string,
    credential: CodexMcpOAuthCredentialMaterial,
  ): Promise<void>;
  syncMcpOAuthCredentialFromRuntime(
    environmentId: string,
    credentialsJson: string | undefined,
  ): Promise<CodexMcpOAuthCredentialMaterial | undefined>;
}

export interface CodexNativeSnapshotRead {
  snapshot: CodexNativeSnapshot;
  /** Process-local cursor at the exact matching thread/read response. */
  liveCursor: number;
  /** Supplemental rollout read that never delays the conversation snapshot. */
  activity: Promise<CodexRolloutActivityFeed>;
}

export interface CodexMcpNotificationHandler {
  handleCodexMcpNotification(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
    message: Record<string, unknown>,
    event: CodexNativeEventIdentity & { occurredAt: string },
  ): Promise<void>;
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
  private readonly mcpOAuthCredentialSyncs = new Map<string, Promise<void>>();
  private readonly rpcResponses = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();
  private readonly rpcAnchors = new Map<string, Map<string, RpcAnchor>>();
  private readonly rpcWaiters = new Map<string, Set<RpcWaiter>>();
  private readonly requestOwners = new Map<string, string>();
  private readonly nativeOwners = new Map<string, string>();
  private readonly nativeSessionAttachments = new Map<
    string,
    NativeSessionAttachmentState
  >();
  private readonly exceptionalSessionReconciliations = new Map<
    string,
    ExceptionalSessionReconciliation
  >();
  private readonly exceptionalSessionTasks = new Set<Promise<void>>();
  private readonly deferredExceptionalSessionReconciliations = new Map<
    string,
    DeferredExceptionalSessionReconciliation
  >();
  private readonly interactiveEnvironmentOperations = new Map<string, number>();
  private readonly live = new Map<string, LiveNotificationState>();
  private readonly events = new EventEmitter();
  private readonly startupRecoveries = new Set<Promise<void>>();
  private readonly advisoryLockScope = new AsyncLocalStorage<SandpiStore>();
  private mcpNotificationHandler?: CodexMcpNotificationHandler;
  private closed = false;

  constructor(
    private readonly store: SandpiStore,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: ServiceLogger,
    private readonly credentials: CodexCredentialProvider,
    private readonly options: {
      streamReconnectDelayMs?: number;
      streamBatchDelayMs?: number;
      rpcTimeoutMs?: number;
      rpcSubmissionTimeoutMs?: number;
      exceptionalSessionRecoveryDelayMs?: number;
      exceptionalPendingTurnGraceMs?: number;
      exceptionalSessionRetryBaseMs?: number;
      exceptionalSessionActiveRecheckMs?: number;
      exceptionalSessionRequestTimeoutMs?: number;
    } = {},
  ) {
    this.events.setMaxListeners(0);
  }

  setMcpNotificationHandler(handler: CodexMcpNotificationHandler) {
    this.mcpNotificationHandler = handler;
  }

  /**
   * Lets a caller that already owns an advisory lock reuse that connection for
   * nested runtime admission and recovery locks.
   */
  withAdvisoryLockStore<T>(
    store: SandpiStore,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.advisoryLockScope.run(store, operation);
  }

  private advisoryLockStore() {
    return this.advisoryLockScope.getStore() ?? this.store;
  }

  async resumeWorkers() {
    const environmentIds =
      await this.store.environmentRuntimeRecoveryCandidateIds();
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
    localImages?: EncodedCodexLocalImage[];
    modelId?: string;
    reasoningEffort?: string;
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
          params: threadConfiguration(input.modelId, input.reasoningEffort),
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
      this.rememberNativeOwner(
        input.environment.id,
        nativeSessionId,
        sessionId,
      );
      this.rememberNativeSessionAttached(environmentRuntime, nativeSessionId);
      await this.startTurn({
        userId: input.userId,
        sessionId,
        text: input.prompt,
        images: input.images,
        localImages: input.localImages,
        modelId: input.modelId,
        reasoningEffort: input.reasoningEffort,
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
      reasoningEffort: sourceRuntime.reasoningEffort,
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
            ...threadConfiguration(
              sourceRuntime.modelId,
              sourceRuntime.reasoningEffort,
            ),
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
      this.rememberNativeSessionAttached(environmentRuntime, nativeSessionId);
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

  async accountRateLimitsForEnvironment(
    userId: string,
    environmentId: string,
  ): Promise<CodexAccountRateLimits> {
    const runtime = await this.environmentRuntimeForEnvironment(
      userId,
      environmentId,
    );
    const response = await this.requestCodex(environmentId, runtime, {
      method: "account/rateLimits/read",
      id: rpcId("account-rate-limits", environmentId),
      params: {},
    });
    const result = requireSafeRpcResult(
      response,
      "codex_account_rate_limits_read_failed",
      "Codex could not read account usage.",
    );
    return codexAccountRateLimits(result);
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

  async environmentRuntimeForMcp(userId: string, environmentId: string) {
    return this.environmentRuntimeForEnvironment(userId, environmentId);
  }

  requireEnvironmentMcpOAuthPersistence() {
    if (!this.credentials.requireMcpOAuthPersistence) {
      throw new HttpError(
        503,
        "credential_encryption_not_configured",
        "MCP OAuth credential persistence is not configured.",
      );
    }
    this.credentials.requireMcpOAuthPersistence();
  }

  async configureEnvironmentMcpOAuthCallback(input: {
    userId: string;
    environmentId: string;
    port: number;
    url: string;
  }) {
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    const response = await this.requestCodex(input.environmentId, runtime, {
      method: "config/batchWrite",
      id: rpcId("mcp-oauth-config", input.environmentId),
      params: {
        edits: [
          {
            keyPath: "mcp_oauth_credentials_store",
            value: "file",
            mergeStrategy: "replace",
          },
          {
            keyPath: "mcp_oauth_callback_port",
            value: input.port,
            mergeStrategy: "replace",
          },
          {
            keyPath: "mcp_oauth_callback_url",
            value: input.url,
            mergeStrategy: "replace",
          },
        ],
        reloadUserConfig: true,
      },
    });
    requireMcpRpcResult(
      response,
      "codex_mcp_oauth_config_failed",
      "Codex could not configure the MCP OAuth callback.",
    );
    return runtime;
  }

  async createEnvironmentMcpOAuthCorrelationThread(input: {
    userId: string;
    environmentId: string;
  }) {
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    const submitted = await this.requestCodexWithRuntime(
      input.environmentId,
      runtime,
      {
        method: "thread/start",
        id: rpcId("mcp-oauth-thread", input.environmentId),
        params: {
          ...threadConfiguration(),
          ephemeral: true,
        },
      },
    );
    const response = submitted.response;
    if (response.error) {
      throw new HttpError(
        502,
        "codex_mcp_oauth_correlation_failed",
        "Codex could not create an isolated MCP OAuth attempt.",
      );
    }
    const nativeThreadId = threadIdFromRpcResponse(response);
    if (!nativeThreadId) {
      throw invalidCodexResponse(
        "codex_mcp_oauth_correlation_failed",
        "Codex returned an invalid MCP OAuth correlation Thread.",
      );
    }
    return { nativeThreadId, runtime: submitted.runtime };
  }

  async beginEnvironmentMcpOAuthLogin(input: {
    environmentId: string;
    name: string;
    nativeThreadId: string;
    runtime: StoredEnvironmentRuntime;
    scopes?: string[];
    timeoutSecs?: number;
  }) {
    if (input.runtime.id !== input.environmentId) {
      throw new Error("MCP OAuth runtime belongs to another Environment.");
    }
    const name = requireMcpServerName(input.name);
    const submitted = await this.requestCodexWithRuntime(
      input.environmentId,
      input.runtime,
      {
        method: "mcpServer/oauth/login",
        id: rpcId("mcp-oauth-login", `${input.environmentId}-${name}`),
        params: {
          name,
          threadId: input.nativeThreadId,
          ...(input.scopes?.length ? { scopes: input.scopes } : {}),
          ...(input.timeoutSecs ? { timeoutSecs: input.timeoutSecs } : {}),
        },
      },
      undefined,
      undefined,
      false,
    );
    const response = submitted.response;
    const result = requireMcpRpcResult(
      response,
      "codex_mcp_oauth_login_failed",
      "Codex could not start MCP OAuth login.",
    );
    const authorizationUrl = objectString(result, "authorizationUrl");
    if (!authorizationUrl) {
      throw invalidCodexResponse(
        "codex_mcp_oauth_login_failed",
        "Codex returned an invalid MCP OAuth authorization URL.",
      );
    }
    return { authorizationUrl, runtime: submitted.runtime };
  }

  async releaseEnvironmentMcpOAuthCorrelationThread(
    runtime: StoredEnvironmentRuntime,
    nativeThreadId: string,
  ) {
    if (!nativeThreadId.trim()) {
      throw new Error("MCP OAuth correlation Thread id is required.");
    }
    const response = await this.requestCodex(
      runtime.id,
      runtime,
      {
        method: "thread/unsubscribe",
        id: rpcId("mcp-oauth-unsubscribe", nativeThreadId),
        params: { threadId: nativeThreadId },
      },
      undefined,
      undefined,
      false,
    );
    requireMcpRpcResult(
      response,
      "codex_mcp_oauth_correlation_cleanup_failed",
      "Codex could not release the MCP OAuth correlation Thread.",
    );
  }

  async testEnvironmentMcpServer(input: {
    userId: string;
    environmentId: string;
    name: string;
  }) {
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    const name = requireMcpServerName(input.name);
    await this.reloadEnvironmentMcpServers(input.environmentId, runtime);
    const inventory = await this.readEnvironmentMcpInventory(
      input.environmentId,
      runtime,
    );
    if (!inventory.servers.some((server) => server.name === name)) {
      throw new HttpError(
        404,
        "codex_mcp_server_not_found",
        "The MCP server is no longer configured.",
      );
    }
    return inventory;
  }

  async logoutEnvironmentMcpServer(input: {
    userId: string;
    environmentId: string;
    name: string;
  }) {
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    await this.discardEnvironmentMcpOAuthCredential(runtime, input.name);
    await this.reloadEnvironmentMcpServers(input.environmentId, runtime);
    return this.readEnvironmentMcpInventory(input.environmentId, runtime);
  }

  async persistEnvironmentMcpOAuthCredential(
    runtime: StoredEnvironmentRuntime,
  ) {
    await this.syncFreshEnvironmentMcpOAuthCredential(runtime);
  }

  async discardEnvironmentMcpOAuthCredential(
    runtime: StoredEnvironmentRuntime,
    name: string,
  ) {
    const validatedName = requireMcpServerName(name);
    await this.syncFreshEnvironmentMcpOAuthCredential(runtime, () =>
      this.runtime.logoutEnvironmentMcpServer(runtime, validatedName),
    );
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
    const config = await this.readEnvironmentCodexConfig(
      environmentId,
      runtime,
    );
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
      const result = requireMcpRpcResult(
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
      if (
        nextCursor !== undefined &&
        nextCursor !== null &&
        typeof nextCursor !== "string"
      ) {
        throw invalidCodexResponse(
          "codex_mcp_status_failed",
          "Codex returned an invalid MCP status cursor.",
        );
      }
      cursor =
        typeof nextCursor === "string" && nextCursor ? nextCursor : undefined;
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
    const result = requireMcpRpcResult(
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
    const userLayer = layers.find((value: unknown) => {
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
    requireMcpRpcResult(
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
    requireMcpRpcResult(
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
    requireMcpRpcResult(
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
    localImages?: EncodedCodexLocalImage[];
    modelId?: string;
    reasoningEffort?: string;
    clientMessageId?: string;
  }) {
    const sessionRuntime = await this.requireNativeSessionRuntime(
      input.userId,
      input.sessionId,
    );
    const releaseInteractiveOperation =
      this.retainInteractiveEnvironmentOperation(sessionRuntime.environmentId);
    try {
      const submission = turnSubmissionCoordinates(
        input.sessionId,
        input.clientMessageId,
      );
      // Persist pending delivery while holding the same Environment advisory
      // lock used by idle pause. If pause won first, the following native
      // runtime access auto-resumes it; if Turn admission won first, pause
      // observes work.
      await this.store.beginSessionTurn(
        input.userId,
        input.sessionId,
        input.modelId,
        submission,
        input.reasoningEffort,
      );
      const turnRuntime = {
        ...sessionRuntime,
        modelId: input.modelId ?? sessionRuntime.modelId,
        reasoningEffort:
          input.reasoningEffort ?? sessionRuntime.reasoningEffort,
      };
      let turnDeliveryAttempted = false;
      let environmentRuntime: StoredEnvironmentRuntime | undefined;
      try {
        environmentRuntime = await this.environmentRuntimeForSession(
          input.userId,
          input.sessionId,
        );
        await this.ensureNativeSessionAttached(environmentRuntime, turnRuntime);
        await this.store.markTurnSubmitted(
          input.sessionId,
          submission.requestId,
        );
        turnDeliveryAttempted = true;
        const response = await this.requestCodex(
          sessionRuntime.environmentId,
          environmentRuntime,
          {
            method: "turn/start",
            id: submission.requestId,
            params: {
              threadId: sessionRuntime.nativeSessionId,
              clientUserMessageId: submission.clientMessageId,
              input: nativeCodexTurnInput(
                input.text,
                input.images,
                input.localImages ?? [],
              ),
              ...(input.modelId ? { model: input.modelId } : {}),
              ...(input.reasoningEffort
                ? { effort: input.reasoningEffort }
                : {}),
            },
          },
          input.sessionId,
          submission.stableInputId,
        );
        if (response.error) {
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
        return {
          requestId: submission.requestId,
          clientMessageId: submission.clientMessageId,
          nativeTurnId,
        };
      } catch (error) {
        if (turnDeliveryAttempted && isAmbiguousTurnDelivery(error)) {
          // Delivery is ambiguous after a response timeout or after the
          // accepted input's runtime epoch disappears. Native events and
          // thread/read remain authoritative, so retain pending coordinates
          // and never replay the mutation automatically.
          this.ensureEnvironmentWorker(sessionRuntime.environmentId);
          if (environmentRuntime) {
            try {
              const currentRuntime = await this.store.environmentRuntime(
                sessionRuntime.environmentId,
              );
              this.scheduleExceptionalSessionReconciliation(currentRuntime, {
                delayMs: 0,
                pendingTurnRequests: new Map([
                  [input.sessionId, submission.requestId],
                ]),
              });
            } catch (reconciliationError) {
              this.logger.warn(
                {
                  environmentId: sessionRuntime.environmentId,
                  error: errorMessage(reconciliationError),
                },
                "Ambiguous Codex Turn reconciliation deferred",
              );
            }
          }
          return {
            requestId: submission.requestId,
            clientMessageId: submission.clientMessageId,
          };
        }
        await this.store.abandonTurn(input.sessionId, submission.requestId);
        throw error;
      }
    } finally {
      releaseInteractiveOperation();
    }
  }

  async listModels(userId: string, sessionId: string) {
    const sessionRuntime = await this.store.getSessionRuntime(
      userId,
      sessionId,
    );
    const environmentRuntime = await this.environmentRuntimeForSession(
      userId,
      sessionId,
    );
    return this.listModelsFromRuntime(
      sessionRuntime.environmentId,
      environmentRuntime,
      sessionId,
      sessionId,
    );
  }

  async listEnvironmentModels(userId: string, environmentId: string) {
    // Model configuration is a live harness capability. Wake and query the
    // Environment-native app-server instead of serving auth metadata or a
    // Sandpi-maintained catalog. Future harness adapters must do the same with
    // their own native capability API.
    const environmentRuntime = await this.environmentRuntimeForEnvironment(
      userId,
      environmentId,
    );
    return this.listModelsFromRuntime(
      environmentId,
      environmentRuntime,
      environmentId,
    );
  }

  private async listModelsFromRuntime(
    environmentId: string,
    environmentRuntime: StoredEnvironmentRuntime,
    requestScopeId: string,
    ownerSessionId?: string,
  ) {
    const data: unknown[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.requestCodex(
        environmentId,
        environmentRuntime,
        {
          method: "model/list",
          id: rpcId("model-list", requestScopeId),
          params: cursor ? { cursor } : {},
        },
        ownerSessionId,
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
    const read = await this.requestCodexWithRuntime(
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
    const { response, runtime: responseRuntime } = read;
    if (response.error) {
      throw nativeSessionUnavailable(response.error);
    }
    const thread = threadFromRpcResponse(response);
    if (!thread || thread.id !== sessionRuntime.nativeSessionId) {
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
      responseRuntime,
      sessionRuntime.nativeSessionId,
      thread.path,
      signal,
    );
    const activeNativeTurnId = thread.turns.find(
      (turn) => turn.status === "inProgress",
    )?.id;
    const nativeIdle = ["idle", "notLoaded"].includes(thread.status.type);
    await this.store.reconcileNativeSessionState({
      sessionId,
      nativeSessionId: sessionRuntime.nativeSessionId,
      historyRevision: sessionRuntime.historyRevision,
      runtimeVersion: sessionRuntime.version,
      environmentId: responseRuntime.id,
      environmentSupervisorSessionId: responseRuntime.supervisorSessionId,
      environmentAttemptId: responseRuntime.attemptId,
      environmentRuntimeGeneration: responseRuntime.runtimeGeneration,
      activeNativeTurnId,
      clearPendingWhenNativeIdle: nativeIdle,
      clearPendingStartedBefore: nativeIdle
        ? new Date(
            Date.now() -
              (this.options.exceptionalPendingTurnGraceMs ??
                EXCEPTIONAL_PENDING_TURN_GRACE_MS),
          )
        : undefined,
    });
    const latest = await this.store.sessionRuntime(sessionId);
    const forkableTurnIds = thread.turns
      .filter((turn) => turn.status !== "inProgress")
      .map((turn) => turn.id);
    return {
      snapshot: {
        protocol: "codex-app-server",
        nativeSessionId:
          latest.nativeSessionId ?? sessionRuntime.nativeSessionId,
        historyRevision: latest.historyRevision,
        modelId: latest.modelId ?? "",
        reasoningEffort: latest.reasoningEffort ?? "",
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
        code.startsWith("codex_rollout_") ? code : "codex_rollout_read_failed",
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
    const releaseInteractiveOperation =
      this.retainInteractiveEnvironmentOperation(sessionRuntime.environmentId);
    try {
      const environmentRuntime = await this.environmentRuntimeForSession(
        input.userId,
        input.sessionId,
      );
      await this.ensureNativeSessionAttached(
        environmentRuntime,
        sessionRuntime,
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
    } finally {
      releaseInteractiveOperation();
    }
  }

  ensureWorker(sessionId: string) {
    void this.store
      .sessionRuntime(sessionId)
      .then((session) => this.ensureEnvironmentWorker(session.environmentId))
      .catch(() => undefined);
  }

  suspendEnvironmentWorker(environmentId: string) {
    this.deferredExceptionalSessionReconciliations.delete(environmentId);
    this.cancelExceptionalSessionReconciliation(environmentId);
    this.workers.get(environmentId)?.abort();
  }

  async flushEnvironmentCredentials(
    environmentId: string,
    lockStore?: SandpiStore,
  ) {
    const runtime = await this.store.environmentRuntime(environmentId);
    await Promise.all([
      this.captureEnvironmentCredential(runtime),
      this.syncFreshEnvironmentMcpOAuthCredential(
        runtime,
        undefined,
        lockStore ?? this.advisoryLockStore(),
      ),
    ]);
  }

  /**
   * Unarchiving can expose control state whose live event was missed while the
   * Session was hidden. Queue metadata-only repair without loading its replies.
   */
  async scheduleSessionControlStateRepair(sessionId: string) {
    try {
      const session = await this.store.sessionRuntime(sessionId);
      const runtime = await this.store.environmentRuntime(
        session.environmentId,
      );
      if (
        runtime.desiredState === "running" &&
        runtime.observedState === "running"
      ) {
        this.scheduleExceptionalSessionReconciliation(runtime, { delayMs: 0 });
      }
    } catch (error) {
      if (this.closed) return;
      this.logger.warn(
        { sessionId, error: errorMessage(error) },
        "Codex Session control-state repair could not be scheduled",
      );
    }
  }

  private ensureEnvironmentWorker(environmentId: string) {
    this.startEnvironmentWorker(environmentId, false);
  }

  private restartEnvironmentWorker(environmentId: string) {
    this.startEnvironmentWorker(environmentId, true);
  }

  private startEnvironmentWorker(environmentId: string, replace: boolean) {
    if (this.advisoryLockScope.getStore()) {
      this.advisoryLockScope.exit(() =>
        this.startEnvironmentWorker(environmentId, replace),
      );
      return;
    }
    if (this.closed) return;
    const active = this.workers.get(environmentId);
    if (active && !replace) return;
    active?.abort();
    const controller = new AbortController();
    this.workers.set(environmentId, controller);
    const task = this.runWorker(environmentId, controller.signal).finally(
      () => {
        if (this.workers.get(environmentId) === controller) {
          this.workers.delete(environmentId);
        }
        if (this.workerTasks.get(environmentId) === task) {
          this.workerTasks.delete(environmentId);
        }
      },
    );
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
    const records = decoded.records.filter((record) =>
      codexRecordBelongsToRuntime(stored, record),
    );
    const epochChanged = environmentDecoderEpochChanged(stored, decoded.state);
    const transitions = controlTransitions(records);
    const next = {
      ...stored,
      decoder: decoded.state,
      version: stored.version + 1,
    };
    if (epochChanged) {
      const committed = await this.store.commitEnvironmentTransport(
        stored.id,
        stored.supervisorSessionId,
        stored.attemptId,
        stored.runtimeGeneration,
        stored.decoder,
        decoded.state,
        [],
      );
      if (!committed) throw new EnvironmentEventStreamSupersededError();
      this.rejectEnvironmentRpcWaitersForEpochChange(stored.id);
      throw codexRuntimeEpochLostAfterSubmission();
    }

    // Cache every response before lifecycle handlers run. An MCP operation can
    // be waiting on a response from this same batch while its lifecycle handler
    // waits for that operation's mutation lock.
    for (const record of records) {
      this.cacheRpcRecord(stored.id, record);
    }
    // MCP lifecycle work is part of consuming the native event. Keep the
    // durable cursor behind it so a crash or handler failure replays the event.
    for (const record of records) {
      if (isMcpLifecycleNotification(record.message)) {
        await this.mcpNotificationHandler?.handleCodexMcpNotification(
          stored.id,
          next,
          record.message,
          {
            ...codexNativeEventIdentity(record),
            occurredAt: record.receivedAt,
          },
        );
      }
    }
    const committed = await this.store.commitEnvironmentTransport(
      stored.id,
      stored.supervisorSessionId,
      stored.attemptId,
      stored.runtimeGeneration,
      stored.decoder,
      decoded.state,
      transitions,
    );
    if (!committed) throw new EnvironmentEventStreamSupersededError();

    for (const record of records) {
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
          message:
            "The live Codex update window expired; reload the native snapshot.",
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
    const exceptionalTasks = [...this.exceptionalSessionTasks];
    const activeReconciliations = [
      ...this.exceptionalSessionReconciliations.values(),
    ];
    this.exceptionalSessionReconciliations.clear();
    for (const reconciliation of activeReconciliations) {
      reconciliation.controller.abort();
    }
    for (const waiters of this.rpcWaiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(new Error("Codex service closed"));
      }
    }
    await Promise.allSettled(this.workerTasks.values());
    await Promise.allSettled(this.startupRecoveries);
    await Promise.allSettled(this.recovering.values());
    await Promise.allSettled(this.credentialSyncs.values());
    await Promise.allSettled(this.mcpOAuthCredentialSyncs.values());
    await Promise.allSettled(exceptionalTasks);
    this.workers.clear();
    this.workerTasks.clear();
    this.initializing.clear();
    this.rpcWaiters.clear();
    this.rpcResponses.clear();
    this.rpcAnchors.clear();
    this.requestOwners.clear();
    this.nativeOwners.clear();
    this.nativeSessionAttachments.clear();
    this.exceptionalSessionTasks.clear();
    this.deferredExceptionalSessionReconciliations.clear();
    this.interactiveEnvironmentOperations.clear();
  }

  private async ensureEnvironmentRuntimeForUser(
    userId: string,
    environment: Environment,
  ) {
    const current = await this.store.getEnvironmentRuntime(
      userId,
      environment.id,
    );
    if (
      current.desiredState === "running" &&
      current.observedState === "running" &&
      current.supervisorSessionId &&
      current.attemptId &&
      this.initializing.has(environmentProtocolKey(current))
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

  private async environmentRuntimeForSession(
    userId: string,
    sessionId: string,
  ) {
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
    const recovery = this.performEnvironmentRecovery(environmentId).finally(
      () => {
        if (this.recovering.get(environmentId) === recovery) {
          this.recovering.delete(environmentId);
        }
      },
    );
    this.recovering.set(environmentId, recovery);
    return recovery;
  }

  private async performEnvironmentRecovery(environmentId: string) {
    const deadline = Date.now() + RUNTIME_RECOVERY_LOCK_TIMEOUT_MS;
    const credential =
      await this.credentials.credentialForEnvironmentRuntime(environmentId);
    while (!this.closed) {
      try {
        const locked =
          await this.advisoryLockStore().withEnvironmentLifecycleLock(
            environmentId,
            async (lockedStore) => {
              const scopedStore = lockedStore ?? this.store;
              return scopedStore.withEnvironmentMcpOAuthCredentialLock(
                environmentId,
                async () => {
                  const mcpOAuthCredential =
                    await this.credentials.mcpOAuthCredentialForEnvironmentRuntime(
                      environmentId,
                    );
                  const ready = await this.reconcileEnvironmentRuntime(
                    environmentId,
                    credential,
                    mcpOAuthCredential,
                    scopedStore,
                  );
                  await this.credentials.markCredentialMaterialized(
                    environmentId,
                    credential,
                  );
                  if (mcpOAuthCredential) {
                    await this.credentials.markMcpOAuthCredentialMaterialized(
                      environmentId,
                      mcpOAuthCredential,
                    );
                  }
                  return ready;
                },
              );
            },
          );
        if (locked.acquired) {
          await this.ensureProtocolInitialized(locked.value);
          this.scheduleExceptionalSessionReconciliation(locked.value);
          return locked.value;
        }
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
      } catch (error) {
        if (!isRuntimeRecoveryRestartError(error)) throw error;
        this.forgetEnvironmentProtocolReadiness(environmentId);
        if (Date.now() >= deadline) throw error;
      }
    }
    throw new Error("Codex service is closed");
  }

  private async reconcileEnvironmentRuntime(
    environmentId: string,
    credential: CodexCredentialMaterial,
    mcpOAuthCredential: CodexMcpOAuthCredentialMaterial | undefined,
    lockedStore: SandpiStore,
  ) {
    const current = await lockedStore.environmentRuntime(environmentId);
    const recovered = await this.runtime.ensureCodexEnvironmentRuntime(
      current,
      credential.authJson,
      mcpOAuthCredential?.credentialsJson,
    );
    const ready = await lockedStore.recordCodexEnvironmentRuntime(
      environmentId,
      recovered,
    );
    // A recovered Supervisor can have a new Session journal or process
    // attempt. Replace the upstream stream before issuing native RPCs so their
    // retained responses are consumed by the new coordinates.
    this.forgetEnvironmentProtocolReadiness(environmentId);
    this.restartEnvironmentWorker(environmentId);
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

  private captureEnvironmentCredential(runtime: StoredEnvironmentRuntime) {
    const active = this.credentialSyncs.get(runtime.id);
    if (active) return active;
    const sync = (async () => {
      try {
        const authJson =
          await this.runtime.readCodexEnvironmentCredential(runtime);
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

  /**
   * Explicit lifecycle transitions must observe native state after every older
   * capture, rather than coalescing with a capture that may predate the change.
   */
  private syncFreshEnvironmentMcpOAuthCredential(
    runtime: StoredEnvironmentRuntime,
    beforeRead?: () => Promise<void>,
    lockStore?: SandpiStore,
  ) {
    const previous =
      this.mcpOAuthCredentialSyncs.get(runtime.id) ?? Promise.resolve();
    const sync = previous.then(() =>
      (
        lockStore ?? this.advisoryLockStore()
      ).withEnvironmentMcpOAuthCredentialLock(runtime.id, async () => {
        await beforeRead?.();
        await this.synchronizeEnvironmentMcpOAuthCredential(runtime);
      }),
    );
    this.trackEnvironmentMcpOAuthCredentialSync(runtime.id, sync);
    return sync;
  }

  private async synchronizeEnvironmentMcpOAuthCredential(
    runtime: StoredEnvironmentRuntime,
  ) {
    const credentialsJson =
      await this.runtime.readCodexMcpOauthCredentials(runtime);
    const authoritative =
      await this.credentials.syncMcpOAuthCredentialFromRuntime(
        runtime.id,
        credentialsJson,
      );
    if (!authoritative) return;
    await this.runtime.installCodexMcpOauthCredentials(
      runtime,
      authoritative.credentialsJson,
    );
    await this.credentials.markMcpOAuthCredentialMaterialized(
      runtime.id,
      authoritative,
    );
  }

  private trackEnvironmentMcpOAuthCredentialSync(
    environmentId: string,
    operation: Promise<void>,
  ) {
    const tail = operation
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.mcpOAuthCredentialSyncs.get(environmentId) === tail) {
          this.mcpOAuthCredentialSyncs.delete(environmentId);
        }
      });
    this.mcpOAuthCredentialSyncs.set(environmentId, tail);
    return tail;
  }

  /**
   * Only stale-looking active delivery state receives background repair. It is
   * outside the blocking Environment recovery path, delayed behind interactive
   * operations, and never considers archived or ordinary waiting Sessions.
   */
  private scheduleExceptionalSessionReconciliation(
    runtime: StoredEnvironmentRuntime,
    options: {
      delayMs?: number;
      pendingTurnRequests?: ReadonlyMap<string, string>;
      retryAttempt?: number;
    } = {},
  ) {
    if (this.advisoryLockScope.getStore()) {
      this.advisoryLockScope.exit(() =>
        this.scheduleExceptionalSessionReconciliation(runtime, options),
      );
      return;
    }
    if (this.closed) return;
    const epoch = environmentRuntimeEpoch(runtime);
    const current = this.exceptionalSessionReconciliations.get(runtime.id);
    if (current?.epoch === epoch) {
      let addedTarget = false;
      for (const [sessionId, requestId] of options.pendingTurnRequests ?? []) {
        addedTarget ||=
          current.pendingTurnRequests.get(sessionId) !== requestId;
        current.pendingTurnRequests.set(sessionId, requestId);
      }
      current.rerunRequested = true;
      current.rerunDelayMs = Math.min(
        current.rerunDelayMs ?? Number.POSITIVE_INFINITY,
        options.delayMs ??
          (addedTarget
            ? 0
            : (this.options.exceptionalSessionRecoveryDelayMs ?? 500)),
      );
      // An explicit earlier deadline (especially a precise ambiguous-delivery
      // request) must not wait behind another Session's long grace timer.
      if (addedTarget || options.delayMs !== undefined) {
        current.controller.abort();
      }
      return;
    }
    const pendingTurnRequests = new Map(current?.pendingTurnRequests);
    for (const [sessionId, requestId] of options.pendingTurnRequests ?? []) {
      pendingTurnRequests.set(sessionId, requestId);
    }
    current?.controller.abort();
    const reconciliation: ExceptionalSessionReconciliation = {
      epoch,
      task: Promise.resolve(),
      rerunRequested: false,
      retryAttempt: options.retryAttempt ?? 0,
      nextRetryAttempt: options.retryAttempt ?? 0,
      pendingTurnRequests,
      controller: new AbortController(),
    };
    reconciliation.task = this.reconcileExceptionalSessions(
      runtime,
      reconciliation,
      options.delayMs ?? (pendingTurnRequests.size > 0 ? 0 : undefined),
    )
      .catch((error) => {
        if (this.closed || reconciliation.controller.signal.aborted) return;
        this.requestExceptionalSessionRetry(reconciliation);
        this.logger.warn(
          { environmentId: runtime.id, error: errorMessage(error) },
          "Exceptional Codex Session reconciliation deferred",
        );
      })
      .finally(() => {
        this.exceptionalSessionTasks.delete(reconciliation.task);
        if (
          this.exceptionalSessionReconciliations.get(runtime.id) ===
          reconciliation
        ) {
          this.exceptionalSessionReconciliations.delete(runtime.id);
          if (reconciliation.rerunRequested && !this.closed) {
            this.scheduleExceptionalSessionReconciliation(runtime, {
              delayMs: reconciliation.rerunDelayMs,
              pendingTurnRequests: reconciliation.pendingTurnRequests,
              retryAttempt: reconciliation.nextRetryAttempt,
            });
          }
        }
      });
    this.exceptionalSessionTasks.add(reconciliation.task);
    this.exceptionalSessionReconciliations.set(runtime.id, reconciliation);
  }

  private async reconcileExceptionalSessions(
    runtime: StoredEnvironmentRuntime,
    reconciliation: ExceptionalSessionReconciliation,
    requestedDelayMs?: number,
  ) {
    await delay(
      requestedDelayMs ?? this.options.exceptionalSessionRecoveryDelayMs ?? 500,
      reconciliation.controller.signal,
    );
    if (!this.isCurrentExceptionalReconciliation(runtime.id, reconciliation)) {
      return;
    }
    await this.waitForEnvironmentRpcIdle(runtime.id, reconciliation);
    if (!this.isCurrentExceptionalReconciliation(runtime.id, reconciliation)) {
      return;
    }
    const sessions =
      await this.store.nativeSessionRecoveryCandidatesForEnvironment(
        runtime.id,
      );
    reconciliation.nextRetryAttempt = 0;
    for (const [sessionId, requestId] of reconciliation.pendingTurnRequests) {
      const candidate = sessions.find(
        (session) => session.sessionId === sessionId,
      );
      if (!candidate || candidate.pendingTurnRequestId !== requestId) {
        reconciliation.pendingTurnRequests.delete(sessionId);
      }
    }
    for (const session of sessions) {
      if (
        !session.nativeSessionId ||
        !this.isCurrentExceptionalReconciliation(runtime.id, reconciliation)
      ) {
        continue;
      }
      const pendingTurnRequestId = session.pendingTurnRequestId;
      const targetedPendingTurn =
        pendingTurnRequestId !== undefined &&
        reconciliation.pendingTurnRequests.get(session.sessionId) ===
          pendingTurnRequestId;
      if (session.pendingTurnPhase && !targetedPendingTurn) {
        // Process-local interactive leases do not cover another Sandpi
        // replica. Defer fresh DB delivery state unless this process owns the
        // exact turn/start request that already reached an ambiguous timeout.
        const pendingDelayMs = exceptionalPendingTurnDelayMs(
          session.pendingTurnStartedAt,
          this.options.exceptionalPendingTurnGraceMs ??
            EXCEPTIONAL_PENDING_TURN_GRACE_MS,
        );
        if (pendingDelayMs > 0) {
          this.requestExceptionalSessionRerun(reconciliation, pendingDelayMs);
          continue;
        }
      }
      const nativeSessionId = session.nativeSessionId;
      await this.waitForEnvironmentRpcIdle(runtime.id, reconciliation);
      if (
        !this.isCurrentExceptionalReconciliation(runtime.id, reconciliation)
      ) {
        return;
      }
      try {
        await this.reconcileExceptionalSession(
          runtime,
          reconciliation,
          session,
          nativeSessionId,
          targetedPendingTurn,
        );
      } catch (error) {
        if (
          this.closed ||
          reconciliation.controller.signal.aborted ||
          isAbortError(error)
        ) {
          return;
        }
        this.requestExceptionalSessionRetry(reconciliation);
        this.logger.warn(
          {
            environmentId: runtime.id,
            sessionId: session.sessionId,
            error: errorMessage(error),
          },
          "Exceptional Codex Session could not be reconciled",
        );
      }
    }
  }

  private async reconcileExceptionalSession(
    runtime: StoredEnvironmentRuntime,
    reconciliation: ExceptionalSessionReconciliation,
    session: StoredSessionRuntime,
    nativeSessionId: string,
    targetedPendingTurn: boolean,
  ) {
    const submitted = await this.requestExceptionalSessionRead(
      runtime.id,
      reconciliation,
      session.sessionId,
      nativeSessionId,
    );
    if (!submitted) return;
    const { response, runtime: latestRuntime } = submitted;
    if (response.error) throw nativeSessionUnavailable(response.error);
    const thread = threadFromRpcResponse(response);
    if (!thread || thread.id !== nativeSessionId) {
      throw new HttpError(
        502,
        "codex_thread_read_failed",
        "Codex returned an invalid native Session snapshot.",
      );
    }
    if (!this.isCurrentExceptionalReconciliation(runtime.id, reconciliation)) {
      return;
    }
    const currentRuntime = await this.store.environmentRuntime(runtime.id);
    if (environmentRuntimeEpoch(currentRuntime) !== reconciliation.epoch) {
      this.handoffExceptionalSessionReconciliation(
        currentRuntime,
        reconciliation,
      );
      return;
    }
    if (
      currentRuntime.desiredState !== "running" ||
      currentRuntime.observedState !== "running"
    ) {
      return;
    }
    if (!["idle", "notLoaded"].includes(thread.status.type)) {
      if (thread.status.type === "active") {
        this.requestExceptionalSessionRerun(
          reconciliation,
          this.options.exceptionalSessionActiveRecheckMs ??
            EXCEPTIONAL_SESSION_ACTIVE_RECHECK_MS,
        );
      } else {
        this.requestExceptionalSessionRetry(reconciliation);
      }
      return;
    }
    const projectionChanged =
      session.activeNativeTurnId !== undefined ||
      Boolean(session.pendingTurnPhase) ||
      session.sessionStatus !== "waiting";
    const reconciled = await this.store.reconcileNativeSessionState({
      sessionId: session.sessionId,
      nativeSessionId,
      historyRevision: session.historyRevision,
      runtimeVersion: session.version,
      environmentId: latestRuntime.id,
      environmentSupervisorSessionId: latestRuntime.supervisorSessionId,
      environmentAttemptId: latestRuntime.attemptId,
      environmentRuntimeGeneration: latestRuntime.runtimeGeneration,
      activeNativeTurnId: undefined,
      clearPendingWhenNativeIdle: true,
      clearPendingRequestId: targetedPendingTurn
        ? session.pendingTurnRequestId
        : undefined,
      clearPendingStartedBefore: targetedPendingTurn
        ? undefined
        : new Date(
            Date.now() -
              (this.options.exceptionalPendingTurnGraceMs ??
                EXCEPTIONAL_PENDING_TURN_GRACE_MS),
          ),
      requireUnarchived: true,
    });
    if (reconciled && projectionChanged) {
      this.publishInvalidation(
        session.sessionId,
        "native-session-state-reconciled",
        {
          message: "Codex execution state was repaired from the native Thread.",
        },
      );
    } else if (!reconciled) {
      this.requestExceptionalSessionRetry(reconciliation);
    }
  }

  /**
   * Serializes only the native read submission with pause/delete/recovery.
   * Waiting for app-server must stay outside the lifecycle lock so a missing
   * response cannot block an Environment transition.
   */
  private async requestExceptionalSessionRead(
    environmentId: string,
    reconciliation: ExceptionalSessionReconciliation,
    sessionId: string,
    nativeSessionId: string,
  ): Promise<
    | {
        response: Record<string, unknown>;
        runtime: StoredEnvironmentRuntime;
      }
    | undefined
  > {
    const requestSignal = AbortSignal.any([
      reconciliation.controller.signal,
      AbortSignal.timeout(
        this.options.exceptionalSessionRequestTimeoutMs ??
          EXCEPTIONAL_SESSION_REQUEST_TIMEOUT_MS,
      ),
    ]);
    const message = {
      method: "thread/read",
      id: rpcId("thread-reconcile", sessionId),
      params: {
        threadId: nativeSessionId,
        includeTurns: false,
      },
    };
    const locked = await this.advisoryLockStore().withEnvironmentLifecycleLock(
      environmentId,
      async (lockedStore) => {
        if (
          !this.isCurrentExceptionalReconciliation(
            environmentId,
            reconciliation,
          )
        ) {
          return undefined;
        }
        const runtime = await (lockedStore ?? this.store).environmentRuntime(
          environmentId,
        );
        if (
          !this.isCurrentExceptionalReconciliation(
            environmentId,
            reconciliation,
          )
        ) {
          return undefined;
        }
        if (environmentRuntimeEpoch(runtime) !== reconciliation.epoch) {
          this.handoffExceptionalSessionReconciliation(runtime, reconciliation);
          return undefined;
        }
        if (
          runtime.desiredState !== "running" ||
          runtime.observedState !== "running"
        ) {
          return undefined;
        }
        const request = this.prepareCodexRequest(
          environmentId,
          message,
          undefined,
          requestSignal,
        );
        await this.submitPreparedCodexRequest(
          runtime,
          message,
          message.id,
          request,
          requestSignal,
        );
        return { request, runtime };
      },
    );
    if (!locked.acquired) {
      if (
        this.isCurrentExceptionalReconciliation(environmentId, reconciliation)
      ) {
        this.requestExceptionalSessionRetry(reconciliation);
      }
      return undefined;
    }
    if (!locked.value) return undefined;

    const { request, runtime } = locked.value;
    try {
      const response = await request.promise;
      if (reconciliation.controller.signal.aborted) {
        throw codexBackgroundRequestCancelled();
      }
      // This path is deliberately lifecycle-neutral. A pause may win after
      // submission; its response must never wake or recover the Environment.
      return { response, runtime };
    } finally {
      request.dispose();
    }
  }

  private async waitForEnvironmentRpcIdle(
    environmentId: string,
    reconciliation: ExceptionalSessionReconciliation,
  ) {
    while (
      this.isCurrentExceptionalReconciliation(environmentId, reconciliation) &&
      (this.hasEnvironmentRpcWaiters(environmentId) ||
        (this.interactiveEnvironmentOperations.get(environmentId) ?? 0) > 0)
    ) {
      await delay(25, reconciliation.controller.signal);
    }
  }

  private retainInteractiveEnvironmentOperation(environmentId: string) {
    const cancelled =
      this.cancelExceptionalSessionReconciliation(environmentId);
    if (cancelled) {
      const deferred = this.deferredExceptionalSessionReconciliations.get(
        environmentId,
      ) ?? {
        pendingTurnRequests: new Map<string, string>(),
      };
      for (const [sessionId, requestId] of cancelled.pendingTurnRequests) {
        deferred.pendingTurnRequests.set(sessionId, requestId);
      }
      this.deferredExceptionalSessionReconciliations.set(
        environmentId,
        deferred,
      );
    }
    this.interactiveEnvironmentOperations.set(
      environmentId,
      (this.interactiveEnvironmentOperations.get(environmentId) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining =
        (this.interactiveEnvironmentOperations.get(environmentId) ?? 1) - 1;
      if (remaining > 0) {
        this.interactiveEnvironmentOperations.set(environmentId, remaining);
      } else {
        this.interactiveEnvironmentOperations.delete(environmentId);
        const deferred =
          this.deferredExceptionalSessionReconciliations.get(environmentId);
        if (deferred) {
          this.deferredExceptionalSessionReconciliations.delete(environmentId);
          this.rescheduleExceptionalSessionReconciliation(
            environmentId,
            deferred,
          );
        }
      }
    };
  }

  private cancelExceptionalSessionReconciliation(environmentId: string) {
    const reconciliation =
      this.exceptionalSessionReconciliations.get(environmentId);
    if (!reconciliation) return undefined;
    this.exceptionalSessionReconciliations.delete(environmentId);
    reconciliation.controller.abort();
    return reconciliation;
  }

  private rescheduleExceptionalSessionReconciliation(
    environmentId: string,
    deferred: DeferredExceptionalSessionReconciliation,
  ) {
    if (this.advisoryLockScope.getStore()) {
      this.advisoryLockScope.exit(() =>
        this.rescheduleExceptionalSessionReconciliation(
          environmentId,
          deferred,
        ),
      );
      return;
    }
    if (this.closed) return;
    const reschedule = this.store
      .environmentRuntime(environmentId)
      .then((runtime) => {
        if (!this.closed) {
          this.scheduleExceptionalSessionReconciliation(runtime, {
            delayMs: deferred.pendingTurnRequests.size > 0 ? 0 : undefined,
            pendingTurnRequests: deferred.pendingTurnRequests,
          });
        }
      })
      .catch((error) => {
        if (this.closed) return;
        this.logger.warn(
          { environmentId, error: errorMessage(error) },
          "Exceptional Codex Session reconciliation could not be rescheduled",
        );
      })
      .finally(() => {
        this.exceptionalSessionTasks.delete(reschedule);
      });
    this.exceptionalSessionTasks.add(reschedule);
  }

  private requestExceptionalSessionRerun(
    reconciliation: ExceptionalSessionReconciliation,
    delayMs: number,
  ) {
    reconciliation.rerunRequested = true;
    reconciliation.rerunDelayMs = Math.min(
      reconciliation.rerunDelayMs ?? Number.POSITIVE_INFINITY,
      Math.max(0, delayMs),
    );
  }

  private requestExceptionalSessionRetry(
    reconciliation: ExceptionalSessionReconciliation,
  ) {
    const baseMs =
      this.options.exceptionalSessionRetryBaseMs ??
      EXCEPTIONAL_SESSION_RETRY_BASE_MS;
    const delayMs = Math.min(
      baseMs * 2 ** Math.min(reconciliation.retryAttempt, 10),
      EXCEPTIONAL_SESSION_RETRY_MAX_MS,
    );
    reconciliation.nextRetryAttempt = Math.max(
      reconciliation.nextRetryAttempt,
      reconciliation.retryAttempt + 1,
    );
    this.requestExceptionalSessionRerun(reconciliation, delayMs);
  }

  private handoffExceptionalSessionReconciliation(
    runtime: StoredEnvironmentRuntime,
    reconciliation: ExceptionalSessionReconciliation,
  ) {
    if (
      runtime.desiredState !== "running" ||
      runtime.observedState !== "running" ||
      environmentRuntimeEpoch(runtime) === reconciliation.epoch
    ) {
      return;
    }
    this.scheduleExceptionalSessionReconciliation(runtime, {
      delayMs: 0,
      pendingTurnRequests: reconciliation.pendingTurnRequests,
    });
  }

  private hasEnvironmentRpcWaiters(environmentId: string) {
    const prefix = `${environmentId}\0`;
    for (const key of this.rpcWaiters.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  private rejectEnvironmentRpcWaitersForEpochChange(environmentId: string) {
    const prefix = `${environmentId}\0`;
    for (const [key, waiters] of this.rpcWaiters) {
      if (!key.startsWith(prefix)) continue;
      for (const waiter of [...waiters]) {
        waiter.rejectForRuntimeEpochChange();
      }
    }
  }

  private forgetEnvironmentProtocolReadiness(environmentId: string) {
    const prefix = `${environmentId}\0`;
    for (const key of this.initializing.keys()) {
      if (key.startsWith(prefix)) this.initializing.delete(key);
    }
  }

  private isCurrentExceptionalReconciliation(
    environmentId: string,
    reconciliation: ExceptionalSessionReconciliation,
  ) {
    return (
      !this.closed &&
      !reconciliation.controller.signal.aborted &&
      this.exceptionalSessionReconciliations.get(environmentId) ===
        reconciliation
    );
  }

  private ensureProtocolInitialized(runtime: StoredEnvironmentRuntime) {
    if (!runtime.supervisorSessionId || !runtime.attemptId) {
      throw new HttpError(
        409,
        "codex_runtime_not_ready",
        "The Environment Codex runtime is not ready.",
      );
    }
    const key = environmentProtocolKey(runtime);
    const active = this.initializing.get(key);
    if (active) return active;
    const initialize = (async () => {
      const response = await this.requestCodex(
        runtime.id,
        runtime,
        {
          method: "initialize",
          // Sandpi may restart while the app-server attempt keeps running. The
          // Supervisor input journal deduplicates stable ids, so each process
          // needs a fresh request id to receive a new initialize response.
          id: rpcId("initialize", runtime.id),
          params: {
            clientInfo: { name: "sandpi", title: "Sandpi", version: "0.1.0" },
          },
        },
        undefined,
        undefined,
        false,
      );
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

  /**
   * Loaded Threads belong to one app-server attempt, not to the Environment
   * Sandbox generation alone. Session execution attaches only the requested
   * native Thread and shares one in-flight resume between concurrent callers.
   */
  private ensureNativeSessionAttached(
    runtime: StoredEnvironmentRuntime,
    session: StoredSessionRuntime & { nativeSessionId: string },
  ) {
    const state = this.nativeSessionAttachmentState(runtime);
    const active = state.threads.get(session.nativeSessionId);
    if (active) return active;

    this.rememberNativeOwner(
      runtime.id,
      session.nativeSessionId,
      session.sessionId,
    );
    const attachment = this.attachNativeSession(runtime, session);
    state.threads.set(session.nativeSessionId, attachment);
    void attachment.catch(() => {
      const current = this.nativeSessionAttachments.get(runtime.id);
      if (
        current === state &&
        current.threads.get(session.nativeSessionId) === attachment
      ) {
        current.threads.delete(session.nativeSessionId);
      }
    });
    return attachment;
  }

  private async attachNativeSession(
    runtime: StoredEnvironmentRuntime,
    session: StoredSessionRuntime & { nativeSessionId: string },
  ) {
    const response = await this.requestCodex(runtime.id, runtime, {
      method: "thread/resume",
      id: rpcId("thread-resume", session.sessionId),
      params: {
        threadId: session.nativeSessionId,
        ...threadConfiguration(session.modelId, session.reasoningEffort),
      },
    });
    if (response.error) throw nativeSessionAttachFailed(response.error);
    const thread = threadFromRpcResponse(response);
    if (!thread || thread.id !== session.nativeSessionId) {
      throw new HttpError(
        502,
        "codex_thread_resume_failed",
        "Codex returned an invalid native Session resume response.",
      );
    }
  }

  private rememberNativeSessionAttached(
    runtime: StoredEnvironmentRuntime,
    nativeSessionId: string,
  ) {
    this.nativeSessionAttachmentState(runtime).threads.set(
      nativeSessionId,
      Promise.resolve(),
    );
  }

  private nativeSessionAttachmentState(runtime: StoredEnvironmentRuntime) {
    if (!runtime.supervisorSessionId || !runtime.attemptId) {
      throw new HttpError(
        409,
        "codex_runtime_not_ready",
        "The Environment Codex runtime is not ready.",
      );
    }
    const epoch = environmentRuntimeEpoch(runtime);
    const current = this.nativeSessionAttachments.get(runtime.id);
    if (current?.epoch === epoch) return current;
    const next: NativeSessionAttachmentState = {
      epoch,
      threads: new Map(),
    };
    this.nativeSessionAttachments.set(runtime.id, next);
    return next;
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
        params: {
          threadId: sessionRuntime.nativeSessionId,
          includeTurns: true,
        },
      },
      ownerSessionId,
    );
    if (response.error) throw nativeSessionUnavailable(response.error);
    const thread = threadFromRpcResponse(response);
    if (!thread || thread.id !== sessionRuntime.nativeSessionId) {
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
    runtime: StoredEnvironmentRuntime,
    message: Record<string, unknown>,
    ownerSessionId?: string,
    stableInputId?: string,
    recoverEpochDrift = true,
  ) {
    const result = await this.requestCodexWithRuntime(
      environmentId,
      runtime,
      message,
      ownerSessionId,
      stableInputId,
      recoverEpochDrift,
    );
    return result.response;
  }

  private async requestCodexWithRuntime(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
    message: Record<string, unknown>,
    ownerSessionId?: string,
    stableInputId?: string,
    recoverEpochDrift = true,
  ) {
    let currentRuntime = runtime;
    for (let attempt = 0; ; attempt += 1) {
      const request = this.prepareCodexRequest(
        environmentId,
        message,
        ownerSessionId,
      );
      try {
        try {
          await this.submitPreparedCodexRequestWithRuntimeAdmission(
            environmentId,
            currentRuntime,
            message,
            stableInputId,
            request,
          );
        } catch (error) {
          request.reject(error);
        }
        const response = await request.promise;
        const submittedRuntime = currentRuntime;
        await this.reconcileEnvironmentAfterRuntimeAccess(environmentId);
        return { response, runtime: submittedRuntime };
      } catch (error) {
        if (
          !recoverEpochDrift ||
          attempt > 0 ||
          !isPreInputRuntimeEpochError(error)
        ) {
          throw error;
        }
        currentRuntime = await this.recoverEnvironmentRuntime(environmentId);
      } finally {
        request.dispose();
      }
    }
  }

  private async submitPreparedCodexRequestWithRuntimeAdmission(
    environmentId: string,
    runtime: EnvironmentRuntimeRecord,
    message: Record<string, unknown>,
    stableInputId: string | undefined,
    request: PreparedRpcRequest,
  ) {
    const deadline = Date.now() + RUNTIME_RECOVERY_LOCK_TIMEOUT_MS;
    while (!this.closed) {
      const locked =
        await this.advisoryLockStore().withEnvironmentRuntimeAccessLock(
          environmentId,
          async (lockedStore) => {
            const scopedStore = lockedStore ?? this.store;
            const current = await scopedStore.environmentRuntime(environmentId);
            if (
              current.desiredState !== "running" ||
              current.observedState !== "running" ||
              environmentRuntimeEpoch(current) !==
                environmentRuntimeEpoch(runtime)
            ) {
              throw codexRuntimeEpochChanged();
            }
            const submitted = await this.submitPreparedCodexRequest(
              runtime,
              message,
              stableInputId,
              request,
              AbortSignal.timeout(
                this.options.rpcSubmissionTimeoutMs ??
                  RPC_SUBMISSION_TIMEOUT_MS,
              ),
            );
            if (submitted) {
              await scopedStore.recordEnvironmentRuntimeAccess(environmentId);
            }
          },
        );
      if (locked.acquired) return;
      if (Date.now() >= deadline) {
        throw new HttpError(
          503,
          "environment_lifecycle_busy",
          "The Environment lifecycle is still changing. Try again shortly.",
        );
      }
      await delay(RUNTIME_RECOVERY_LOCK_RETRY_MS);
    }
    throw new Error("Codex service is closed");
  }

  private prepareCodexRequest(
    environmentId: string,
    message: Record<string, unknown>,
    ownerSessionId?: string,
    signal?: AbortSignal,
  ): PreparedRpcRequest {
    if (this.closed) throw new Error("Codex service is closed");
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
    // Background cancellation can reject while writeCodexMessage is still
    // pending inside the short lifecycle-lock section. Mark the Promise
    // handled immediately; callers still await the original rejecting Promise.
    void waiter.promise.catch(() => undefined);
    const abort = () =>
      waiter.reject(signal?.reason ?? codexBackgroundRequestCancelled());
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    return {
      ...waiter,
      dispose: () => signal?.removeEventListener("abort", abort),
    };
  }

  private async submitPreparedCodexRequest(
    runtime: EnvironmentRuntimeRecord,
    message: Record<string, unknown>,
    stableInputId: string | undefined,
    request: PreparedRpcRequest,
    signal?: AbortSignal,
  ) {
    const requestId = message.id;
    if (typeof requestId !== "string") {
      throw new Error("A Codex RPC request must have a string id");
    }
    try {
      request.markDeliveryStarted();
      await this.runtime.writeCodexMessage(
        runtime,
        message,
        stableInputId ?? requestId,
        signal,
      );
      request.armTimeout();
      return true;
    } catch (error) {
      request.reject(
        signal?.aborted && signal.reason?.name === "TimeoutError"
          ? codexInputDeliveryTimeout()
          : error,
      );
      return false;
    }
  }

  private registerRpcWaiter(
    environmentId: string,
    requestId: string,
  ): RpcWaiter {
    const cached = this.takeRpcResponse(environmentId, requestId);
    if (cached) {
      return {
        promise: Promise.resolve(cached),
        resolve() {},
        reject() {},
        armTimeout() {},
        markDeliveryStarted() {},
        rejectForRuntimeEpochChange() {},
      };
    }
    const key = rpcKey(environmentId, requestId);
    let settled = false;
    let deliveryStarted = false;
    let timer: NodeJS.Timeout | undefined;
    let resolvePromise!: (response: Record<string, unknown>) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
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
      armTimeout: () => {
        if (settled || timer) return;
        timer = setTimeout(() => {
          waiter.reject(
            new HttpError(
              504,
              "codex_rpc_timeout",
              `Codex did not answer ${requestId.split(":", 1)[0]} in time.`,
            ),
          );
        }, this.options.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
        timer.unref();
      },
      markDeliveryStarted: () => {
        deliveryStarted = true;
      },
      rejectForRuntimeEpochChange: () => {
        waiter.reject(
          deliveryStarted
            ? codexRuntimeEpochLostAfterSubmission()
            : codexRuntimeEpochChanged(),
        );
      },
    };
    const waiters = this.rpcWaiters.get(key) ?? new Set<RpcWaiter>();
    waiters.add(waiter);
    this.rpcWaiters.set(key, waiters);
    return waiter;
  }

  private cacheRpcRecord(environmentId: string, record: DecodedCodexRecord) {
    const message = record.message;
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
      refreshPersistedActivity: event.notification.method === "turn/completed",
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
        Awaited<ReturnType<RuntimeAdapter["watchCodexEvents"]>> | undefined;
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
            "Live execution events expired; each open Session will refresh its native Thread lazily.",
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
          if (!this.recovering.has(environmentId)) {
            try {
              await this.recoverEnvironmentRuntime(environmentId);
              await this.invalidateEnvironmentSessions(
                environmentId,
                "environment-runtime-recovered",
                "The shared Codex runtime restarted; open Sessions will refresh lazily.",
              );
              consecutiveFailures = 0;
            } catch (recoveryError) {
              this.logger.warn(
                { environmentId, error: errorMessage(recoveryError) },
                "Codex Environment recovery failed",
              );
            }
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
    if (
      status === "completed" ||
      status === "failed" ||
      status === "interrupted"
    ) {
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

function isMcpLifecycleNotification(message: Record<string, unknown>) {
  return (
    message.method === "mcpServer/oauthLogin/completed" ||
    message.method === "mcpServer/startupStatus/updated"
  );
}

function notificationThreadId(message: Record<string, unknown>) {
  const params = objectRecord(message.params);
  return (
    objectString(params, "threadId") ??
    objectString(objectRecord(params?.thread), "id")
  );
}

function threadConfiguration(modelId?: string, reasoningEffort?: string) {
  return {
    ...(modelId ? { model: modelId } : {}),
    ...(reasoningEffort
      ? { config: { model_reasoning_effort: reasoningEffort } }
      : {}),
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
  if (
    !thread ||
    typeof thread.id !== "string" ||
    !Array.isArray(thread.turns)
  ) {
    return undefined;
  }
  return thread as unknown as CodexThread;
}

function turnIdFromRpcResponse(response: Record<string, unknown>) {
  return objectString(objectRecord(objectRecord(response.result)?.turn), "id");
}

function requireRpcResult(
  response: Record<string, unknown>,
  code: string,
  message: string,
) {
  if (response.error) {
    throw new HttpError(
      502,
      code,
      `${message} ${rpcErrorMessage(response.error)}`,
    );
  }
  const result = objectRecord(response.result);
  if (!result) throw invalidCodexResponse(code, message);
  return result;
}

function requireSafeRpcResult(
  response: Record<string, unknown>,
  code: string,
  message: string,
) {
  if (response.error) throw new HttpError(502, code, message);
  const result = objectRecord(response.result);
  if (!result) throw invalidCodexResponse(code, message);
  return result;
}

/**
 * MCP RPC errors can contain provider-controlled URLs or credential material.
 * Keep those native details out of API responses and server error logs.
 */
function requireMcpRpcResult(
  response: Record<string, unknown>,
  code: string,
  message: string,
) {
  return requireSafeRpcResult(response, code, message);
}

function invalidCodexResponse(code: string, message: string) {
  return new HttpError(502, code, message);
}

function codexAccountRateLimits(
  result: Record<string, unknown>,
): CodexAccountRateLimits {
  const limits: CodexRateLimitSnapshot[] = [];
  const byLimitId = objectRecord(result.rateLimitsByLimitId);
  if (byLimitId) {
    for (const [limitId, value] of Object.entries(byLimitId).slice(
      0,
      MAX_CODEX_RATE_LIMIT_BUCKETS,
    )) {
      const snapshot = codexRateLimitSnapshot(value, limitId);
      if (snapshot) limits.push(snapshot);
    }
  }

  const main = codexRateLimitSnapshot(result.rateLimits);
  if (
    main &&
    (limits.length === 0 ||
      (main.id !== undefined && !limits.some((limit) => limit.id === main.id)))
  ) {
    limits.unshift(main);
  }

  return {
    limits: limits.slice(0, MAX_CODEX_RATE_LIMIT_BUCKETS),
    fetchedAt: toUnixTimestamp(new Date()),
  };
}

function codexRateLimitSnapshot(
  value: unknown,
  fallbackId?: string,
): CodexRateLimitSnapshot | undefined {
  const snapshot = objectRecord(value);
  if (!snapshot) return undefined;
  const id =
    boundedProviderString(snapshot.limitId, 128) ??
    boundedProviderString(fallbackId, 128);
  const name = boundedProviderString(snapshot.limitName, 128);
  const planType = codexAccountPlanType(snapshot.planType);
  const primary = codexRateLimitWindow(snapshot.primary);
  const secondary = codexRateLimitWindow(snapshot.secondary);
  const credits = codexCreditsSnapshot(snapshot.credits);
  const individualLimit = codexSpendControlSnapshot(snapshot.individualLimit);
  const reached =
    objectBoolean(snapshot, "spendControlReached") === true ||
    boundedProviderString(snapshot.rateLimitReachedType, 128) !== undefined;
  if (
    !id &&
    !name &&
    !planType &&
    !primary &&
    !secondary &&
    !credits &&
    !individualLimit &&
    !reached
  ) {
    return undefined;
  }
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(planType ? { planType } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(credits ? { credits } : {}),
    ...(individualLimit ? { individualLimit } : {}),
    reached,
  };
}

function codexRateLimitWindow(
  value: unknown,
): CodexRateLimitWindow | undefined {
  const window = objectRecord(value);
  const usedPercent = normalizedPercent(window?.usedPercent);
  if (!window || usedPercent === undefined) return undefined;
  const windowDurationMins = normalizedPositiveInteger(
    window.windowDurationMins,
    5_256_000,
  );
  const resetsAt = normalizedUnixTimestamp(window.resetsAt);
  return {
    usedPercent,
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function codexCreditsSnapshot(
  value: unknown,
): CodexCreditsSnapshot | undefined {
  const credits = objectRecord(value);
  const hasCredits = objectBoolean(credits, "hasCredits");
  const unlimited = objectBoolean(credits, "unlimited");
  if (!credits || hasCredits === undefined || unlimited === undefined) {
    return undefined;
  }
  const balance = boundedProviderString(credits.balance, 128);
  return {
    hasCredits,
    unlimited,
    ...(balance ? { balance } : {}),
  };
}

function codexSpendControlSnapshot(
  value: unknown,
): CodexSpendControlSnapshot | undefined {
  const limit = objectRecord(value);
  if (!limit) return undefined;
  const maximum = boundedProviderString(limit.limit, 128);
  const used = boundedProviderString(limit.used, 128);
  const remainingPercent = normalizedPercent(limit.remainingPercent);
  const resetsAt = normalizedUnixTimestamp(limit.resetsAt);
  if (
    !maximum ||
    !used ||
    remainingPercent === undefined ||
    resetsAt === undefined
  ) {
    return undefined;
  }
  return { limit: maximum, used, remainingPercent, resetsAt };
}

function codexAccountPlanType(
  value: unknown,
): CodexAccountPlanType | undefined {
  return typeof value === "string" &&
    CODEX_ACCOUNT_PLAN_TYPES.has(value as CodexAccountPlanType)
    ? (value as CodexAccountPlanType)
    : undefined;
}

function boundedProviderString(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength
    ? normalized
    : undefined;
}

function normalizedPercent(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : undefined;
}

function normalizedPositiveInteger(value: unknown, maximum: number) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= maximum
    ? Math.round(value)
    : undefined;
}

function normalizedUnixTimestamp(value: unknown) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 253_402_300_799
    ? Math.round(value)
    : undefined;
}

function codexSkillsInventory(
  result: Record<string, unknown>,
): CodexSkillsInventory {
  if (!Array.isArray(result.data)) {
    throw invalidCodexResponse(
      "codex_skills_list_failed",
      "Codex returned an invalid skills list.",
    );
  }
  const entry = result.data
    .map(objectRecord)
    .find(
      (candidate) => objectString(candidate, "cwd") === CODEX_ENVIRONMENT_CWD,
    );
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
  return (
    value === "user" ||
    value === "repo" ||
    value === "system" ||
    value === "admin"
  );
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
    scopes: server.scopes?.length ? server.scopes : null,
    enabled_tools: server.enabledTools.length > 0 ? server.enabledTools : null,
    disabled_tools:
      server.disabledTools.length > 0 ? server.disabledTools : null,
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
    : serverInfo
      ? "connected"
      : authStatus === "notLoggedIn"
        ? "authentication-required"
        : "unavailable";
  const credentialState =
    transport === "stdio"
      ? "public"
      : authStatus === "bearerToken"
        ? "key-configured"
        : authStatus === "oAuth"
          ? "oauth-authorized"
          : authStatus === "notLoggedIn"
            ? "oauth-required"
            : "unknown";
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
    scopes: objectStringArray(definition.scopes),
    enabledTools: objectStringArray(definition.enabled_tools),
    disabledTools: objectStringArray(definition.disabled_tools),
    managed,
    authStatus,
    runtimeStatus,
    credentialState,
    readiness: !enabled ? "disabled" : serverInfo ? "ready" : "failed",
    hasServerInfo: Boolean(serverInfo),
    serverTitle:
      objectString(serverInfo, "title") ?? objectString(serverInfo, "name"),
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
    nextCursor:
      typeof nextCursor === "string" && nextCursor ? nextCursor : undefined,
  };
}

function nativeSessionUnavailable(error: unknown) {
  return new HttpError(
    409,
    "codex_native_session_unrecoverable",
    `The native Codex Session is unavailable: ${rpcErrorMessage(error)}`,
  );
}

function nativeSessionAttachFailed(error: unknown) {
  return new HttpError(
    503,
    "codex_native_session_attach_failed",
    `Codex could not attach this Session for execution. Retry the operation. Native error: ${rpcErrorMessage(error)}`,
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

function isAmbiguousTurnDelivery(error: unknown) {
  return (
    error instanceof HttpError &&
    (error.code === "codex_rpc_timeout" ||
      error.code === "codex_input_delivery_timeout" ||
      error.code === "codex_runtime_epoch_lost_after_submit" ||
      error.code === "sandbox0_unavailable")
  );
}

function isRecoverableRuntimeError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("transport endpoint is not connected")) return true;
  return (
    error instanceof HttpError &&
    (error.code === "supervisor_not_running" ||
      error.code === "codex_runtime_epoch_changed" ||
      error.code === "codex_runtime_epoch_lost_after_submit" ||
      error.code === "codex_runtime_not_ready" ||
      (error.code.startsWith("sandbox0_") &&
        [404, 409, 503].includes(error.statusCode)))
  );
}

function isPreInputRuntimeEpochError(error: unknown) {
  return (
    error instanceof HttpError &&
    (error.code === "codex_runtime_epoch_changed" ||
      error.code === "supervisor_not_running" ||
      error.code === "codex_runtime_not_ready")
  );
}

function isRuntimeRecoveryRestartError(error: unknown) {
  return (
    isPreInputRuntimeEpochError(error) ||
    (error instanceof HttpError &&
      error.code === "codex_runtime_epoch_lost_after_submit")
  );
}

function codexRuntimeEpochChanged() {
  return new HttpError(
    409,
    "codex_runtime_epoch_changed",
    "The Codex runtime changed before this request was submitted. Sandpi is reconnecting it.",
  );
}

function codexRuntimeEpochLostAfterSubmission() {
  return new HttpError(
    503,
    "codex_runtime_epoch_lost_after_submit",
    "The Codex runtime changed while this request was in flight. Sandpi will reconcile native state without replaying the request.",
  );
}

function codexInputDeliveryTimeout() {
  return new HttpError(
    504,
    "codex_input_delivery_timeout",
    "Codex input delivery did not finish in time. Sandpi will reconcile native state without replaying the request.",
  );
}

function turnSubmissionCoordinates(
  sessionId: string,
  clientMessageId = `user-message:${randomUUID()}`,
) {
  return {
    requestId: rpcId("turn-start", sessionId),
    // The browser may allocate this correlation ID before delivery so its
    // ephemeral prompt can be replaced by the native userMessage in place.
    // It is not a Sandpi transcript ID; Codex remains the message authority.
    clientMessageId,
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

function environmentRuntimeEpoch(runtime: EnvironmentRuntimeRecord) {
  return [
    runtime.supervisorSessionId ?? "",
    runtime.attemptId ?? "",
    runtime.runtimeGeneration,
  ].join("\0");
}

function environmentProtocolKey(runtime: EnvironmentRuntimeRecord) {
  return `${runtime.id}\0${environmentRuntimeEpoch(runtime)}`;
}

function environmentDecoderEpochChanged(
  runtime: EnvironmentRuntimeRecord,
  decoder: CodexDecoderState,
) {
  return (
    decoder.attemptId !== undefined &&
    (decoder.attemptId !== runtime.attemptId ||
      decoder.runtimeGeneration !== runtime.runtimeGeneration)
  );
}

function codexRecordBelongsToRuntime(
  runtime: EnvironmentRuntimeRecord,
  record: DecodedCodexRecord,
) {
  return (
    record.attemptId === runtime.attemptId &&
    record.runtimeGeneration === runtime.runtimeGeneration
  );
}

function exceptionalPendingTurnDelayMs(
  pendingTurnStartedAt: Date | undefined,
  graceMs: number,
) {
  if (!pendingTurnStartedAt) return graceMs;
  const startedAtMs = pendingTurnStartedAt.getTime();
  if (!Number.isFinite(startedAtMs)) return graceMs;
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  return Math.max(0, graceMs - elapsedMs);
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
  return Number.isSafeInteger(earliest) && earliest > 0 ? earliest : undefined;
}

function codexBackgroundRequestCancelled() {
  return new DOMException("Codex background request cancelled", "AbortError");
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
