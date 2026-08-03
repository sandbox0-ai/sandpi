import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";

import type { CodexRolloutActivityFeed } from "@/harnesses/codex/rollout-activity";
import {
  enteredReviewModeItem,
  visibleCodexTurns,
} from "@/harnesses/codex/inline-review";
import {
  CODEX_SESSION_NOTIFICATION_METHODS,
  type CodexEventEnvelope,
  type CodexNativeSnapshot,
  type CodexServerNotification,
  type CodexThread,
  type CodexTurn,
} from "@/harnesses/codex/types";
import {
  CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX,
  CODEX_RUNTIME_RECOVERY_PROMPT_VERSION,
  codexRuntimeRecoveryPrompt,
  isCodexRuntimeRecoveryClientMessageId,
} from "@/harnesses/codex/runtime-recovery";
import type {
  CodexAccountPlanType,
  CodexAccountRateLimits,
  CodexCreditsSnapshot,
  CodexEnvironmentSkill,
  CodexMcpInventory,
  CodexMcpOAuthLogin,
  CodexMcpServer,
  CodexMcpTransport,
  CodexRateLimitResetOutcome,
  CodexRateLimitResetResult,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexSkillDependency,
  CodexSkillError,
  CodexSkillsInventory,
  CodexSpendControlSnapshot,
} from "@/harnesses/codex/environment-tools";
import {
  codexMemoriesFeatureToggleSettings,
  type CodexMemoriesSettings,
} from "@/harnesses/codex/native-capabilities";
import type { Environment } from "@/lib/types";
import { toUnixTimestamp } from "@/lib/time";
import { HttpError } from "@/server/http-error";
import type {
  EnvironmentRuntimeRecord,
  RuntimeAdapter,
} from "@/server/runtime/types";
import type { RuntimeQuotaGate } from "@/server/billing/quota-service";
import {
  CODEX_MCP_OAUTH_CALLBACK_BASE_PATH,
  CODEX_MCP_OAUTH_CALLBACK_PORT,
  SANDPI_MANAGED_SKILL_ROOT,
} from "@/server/runtime/types";
import {
  SandpiStore,
  WORKSPACE_RESTORE_UNAVAILABLE_SESSION_ERROR,
  type CodexControlTransition,
  type IdempotentResourceState,
  type StoredEnvironmentRuntime,
  type StoredSessionRuntime,
  type TurnSubmissionCoordinates,
} from "@/server/store";
import {
  decodeCodexSupervisorEvents,
  type CodexDecoderState,
  type DecodedCodexRecord,
  type SupervisorOutputEvent,
} from "./jsonl";
import {
  nativeCodexTurnInput,
  type EncodedCodexInputImage,
} from "./input-images";
import type { EncodedCodexLocalImage } from "./input-files";
import {
  parseCodexRolloutSupplement,
  type CodexRolloutSupplement,
} from "./rollout-activity";

const STREAM_RECONNECT_DELAY_MS = 250;
const STREAM_BATCH_DELAY_MS = 20;
const STREAM_BATCH_MAX_EVENTS = 128;
const RPC_TIMEOUT_MS = 30_000;
const RPC_SUBMISSION_TIMEOUT_MS = 30_000;
const RUNTIME_RECOVERY_LOCK_TIMEOUT_MS = 130_000;
const RUNTIME_RECOVERY_LOCK_RETRY_MS = 250;
const SESSION_CREATION_IDEMPOTENCY_OPERATION = "session.create";
const SESSION_CREATION_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const SESSION_CREATION_IDEMPOTENCY_POLL_MS = 100;
const SESSION_CREATION_IDEMPOTENCY_WAIT_MS =
  RUNTIME_RECOVERY_LOCK_TIMEOUT_MS + RPC_TIMEOUT_MS;
const ACCEPTED_TURN_SNAPSHOT_RACE_GRACE_MS = 60_000;
const EXCEPTIONAL_PENDING_TURN_GRACE_MS = 10 * 60_000;
const EXCEPTIONAL_SESSION_RETRY_BASE_MS = 1_000;
const EXCEPTIONAL_SESSION_RETRY_MAX_MS = 30_000;
const EXCEPTIONAL_SESSION_ACTIVE_RECHECK_MS = 30_000;
const EXCEPTIONAL_SESSION_REQUEST_TIMEOUT_MS = 5_000;
const AUTOMATIC_TURN_RECOVERY_MAX_ATTEMPTS = 1;
const MAX_RPC_RESPONSES_PER_ENVIRONMENT = 512;
const MAX_LIVE_NOTIFICATIONS_PER_SESSION = 1_000;
const MODEL_CATALOG_CACHE_TTL_MS = 30_000;
const MAX_MODEL_CATALOG_CACHE_ENTRIES = 128;
const CODEX_ENVIRONMENT_CWD = "/workspace";
const CODEX_ENVIRONMENT_HOME = "/workspace/.sandpi/harnesses/codex";
// Register Sandpi-managed product skills beside conventional
// root-account skill locations even though Sandpi isolates CODEX_HOME.
const CODEX_ENVIRONMENT_EXTRA_SKILL_ROOTS = [
  SANDPI_MANAGED_SKILL_ROOT,
  "/root/.codex/skills",
  "/root/.agents/skills",
] as const;
const CODEX_ROLLOUT_ROOTS = [
  `${CODEX_ENVIRONMENT_HOME}/sessions`,
  `${CODEX_ENVIRONMENT_HOME}/archived_sessions`,
] as const;
const CODEX_ROLLOUT_READ_TIMEOUT_MS = 30_000;
const CODEX_USER_SKILL_ROOT = "/workspace/.agents/skills";
const CODEX_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_CODEX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CODEX_SKILL_BYTES = 10 * 1024 * 1024;
const CODEX_MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CODEX_MCP_OAUTH_TIMEOUT_SECONDS = 5 * 60;
const MAX_CODEX_RATE_LIMIT_BUCKETS = 16;
const MAX_CODEX_RATE_LIMIT_RESET_CREDITS = 1_000_000;
const CODEX_APPLY_PATCH_STREAMING_CONFIG =
  "features.apply_patch_streaming_events";
const CODEX_REQUEST_USER_INPUT_CONFIG =
  "tools.experimental_request_user_input.enabled";
const CODEX_THREAD_CREATION_PAGE_LIMIT = 100;
const MAX_CODEX_THREAD_CREATION_LOOKUP = 1_000;
const CODEX_THREAD_CREATION_SOURCE_PREFIX = "sandpi-session:";
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
const CODEX_RATE_LIMIT_RESET_OUTCOMES =
  new Set<CodexRateLimitResetOutcome>([
    "reset",
    "nothingToReset",
    "noCredit",
    "alreadyRedeemed",
  ]);
const SESSION_NOTIFICATION_METHODS = new Set<string>(
  CODEX_SESSION_NOTIFICATION_METHODS,
);
type CodexMcpAuthStatus =
  "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth" | "unknown";

export interface CodexSkillFileInput {
  path: string;
  content: Uint8Array;
  executable: boolean;
}

interface CodexMcpSharedConfiguration {
  enabled: boolean;
  required: boolean;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  enabledTools?: string[];
  disabledTools?: string[];
  defaultToolsApprovalMode?: "auto" | "prompt" | "writes" | "approve";
}

export type CodexMcpServerConfiguration = CodexMcpSharedConfiguration &
  (
    | {
        transport: "stdio";
        command: string;
        args: string[];
        cwd?: string;
        envVars?: string[];
      }
    | {
        transport: "streamable-http";
        url: string;
        auth?: "oauth" | "chatgpt";
        oauthResource?: string;
        scopes?: string[];
      }
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

interface ModelCatalogCacheEntry {
  expiresAt: number;
  promise: Promise<{ data: unknown[] }>;
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
  /** Supplemental rollout state that never delays the conversation snapshot. */
  supplement: Promise<CodexRolloutSupplement>;
}

interface CreateSessionInput {
  userId: string;
  environment: Environment;
  title: string;
  prompt: string;
  images: EncodedCodexInputImage[];
  localImages?: EncodedCodexLocalImage[];
  modelId?: string;
  reasoningEffort?: string;
  collaborationMode?: "plan";
  serviceTier?: string;
  idempotencyKey?: string;
}

interface NativeSnapshotReadEntry {
  key: string;
  promise: Promise<CodexNativeSnapshotRead>;
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
  private readonly mcpReloads = new Map<string, Promise<void>>();
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
  private readonly nativeSnapshotReads = new Map<
    string,
    NativeSnapshotReadEntry
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
  private readonly modelCatalogs = new Map<string, ModelCatalogCacheEntry>();
  private readonly live = new Map<string, LiveNotificationState>();
  private readonly activeInlineReviews = new Map<string, string>();
  private readonly events = new EventEmitter();
  private readonly startupRecoveries = new Set<Promise<void>>();
  private readonly advisoryLockScope = new AsyncLocalStorage<SandpiStore>();
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
      modelCatalogCacheTtlMs?: number;
      runtimeQuotaGate?: RuntimeQuotaGate;
    } = {},
  ) {
    this.events.setMaxListeners(0);
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

  async createSession(input: CreateSessionInput) {
    const idempotencyKey = input.idempotencyKey;
    if (!idempotencyKey) return this.createSessionOnce(input);

    const requestFingerprint = sessionCreationRequestFingerprint(input);
    const claim = await this.store.claimIdempotentResource({
      userId: input.userId,
      operation: SESSION_CREATION_IDEMPOTENCY_OPERATION,
      key: idempotencyKey,
      requestFingerprint,
      resourceId: `session_${randomUUID()}`,
      expiresAt: new Date(Date.now() + SESSION_CREATION_IDEMPOTENCY_TTL_MS),
    });
    if (!claim.claimed) {
      return this.waitForIdempotentSessionCreation(
        input,
        idempotencyKey,
        requestFingerprint,
        claim,
      );
    }

    let sessionId: string;
    try {
      sessionId = await this.createSessionOnce(input, claim.resourceId);
    } catch (error) {
      const failure = sessionCreationFailure(error);
      await this.store
        .failIdempotentResource({
          userId: input.userId,
          operation: SESSION_CREATION_IDEMPOTENCY_OPERATION,
          key: idempotencyKey,
          requestFingerprint,
          resourceId: claim.resourceId,
          responseStatus: failure.statusCode,
          responseBody: {
            code: failure.code,
            message: failure.message,
          },
        })
        .catch((persistenceError) => {
          this.logger.error(
            {
              sessionId: claim.resourceId,
              error: errorMessage(persistenceError),
            },
            "Failed to persist Session creation idempotency failure",
          );
        });
      throw error;
    }
    await this.store.completeIdempotentResource({
      userId: input.userId,
      operation: SESSION_CREATION_IDEMPOTENCY_OPERATION,
      key: idempotencyKey,
      requestFingerprint,
      resourceId: sessionId,
    });
    return sessionId;
  }

  private async createSessionOnce(
    input: CreateSessionInput,
    reservedSessionId?: string,
  ) {
    const environmentRuntime = await this.ensureEnvironmentRuntimeForUser(
      input.userId,
      input.environment,
    );
    const sessionId = await this.store.createSessionMetadata({
      ...input,
      sessionId: reservedSessionId,
    });
    try {
      await this.ensureNativeSessionCreated(
        input,
        sessionId,
        environmentRuntime,
      );
      await this.startTurn({
        userId: input.userId,
        sessionId,
        text: input.prompt,
        images: input.images,
        localImages: input.localImages,
        modelId: input.modelId,
        reasoningEffort: input.reasoningEffort,
        collaborationMode: input.collaborationMode,
        serviceTier: input.serviceTier,
      });
      this.ensureEnvironmentWorker(input.environment.id);
      return sessionId;
    } catch (error) {
      await this.store.markSessionFailed(sessionId, errorMessage(error));
      throw error;
    }
  }

  private async waitForIdempotentSessionCreation(
    input: CreateSessionInput,
    idempotencyKey: string,
    requestFingerprint: string,
    initial: IdempotentResourceState,
  ) {
    const deadline = Date.now() + SESSION_CREATION_IDEMPOTENCY_WAIT_MS;
    let state = initial;
    while (state.status === "processing" && !this.closed) {
      if (Date.now() >= deadline) {
        throw new HttpError(
          409,
          "session_creation_in_progress",
          "This Session is still being created. Try opening it again shortly.",
          { sessionId: state.resourceId },
        );
      }
      await waitForSessionCreationPoll();
      state = await this.store.readIdempotentResource({
        userId: input.userId,
        operation: SESSION_CREATION_IDEMPOTENCY_OPERATION,
        key: idempotencyKey,
        requestFingerprint,
      });
    }
    if (state.status === "completed") return state.resourceId;
    if (state.status === "failed") {
      const code = objectString(state.responseBody, "code");
      const message = objectString(state.responseBody, "message");
      throw new HttpError(
        state.responseStatus ?? 500,
        code ?? "session_creation_failed",
        message ?? "Session creation failed.",
        { sessionId: state.resourceId },
      );
    }
    throw new Error("Codex service closed while Session creation was pending.");
  }

  async ensureAutomationSession(input: {
    userId: string;
    environment: Environment;
    sessionId: string;
    automationRunId: string;
    automationKind: "schedule" | "webhook";
    automationSessionKey?: string;
    title: string;
    modelId?: string;
    reasoningEffort?: string;
    collaborationMode?: "plan";
    serviceTier?: string;
  }) {
    const environmentRuntime = await this.ensureEnvironmentRuntimeForUser(
      input.userId,
      input.environment,
    );
    await this.store.ensureAutomationSessionMetadata(input);
    await this.ensureNativeSessionCreated(
      input,
      input.sessionId,
      environmentRuntime,
    );
    this.ensureEnvironmentWorker(input.environment.id);
    return input.sessionId;
  }

  private async ensureNativeSessionCreated(
    input: {
      userId: string;
      environment: Environment;
      modelId?: string;
      reasoningEffort?: string;
      collaborationMode?: "plan";
      serviceTier?: string;
    },
    sessionId: string,
    environmentRuntime: StoredEnvironmentRuntime,
  ) {
    const existing = await this.store.getSessionRuntime(
      input.userId,
      sessionId,
    );
    if (existing.nativeSessionId) {
      this.rememberNativeOwner(
        input.environment.id,
        existing.nativeSessionId,
        sessionId,
      );
      return {
        nativeSessionId: existing.nativeSessionId,
        runtime: environmentRuntime,
      };
    }

    const threadSource = nativeThreadCreationSource(sessionId);
    const request = {
      method: "thread/start",
      id: rpcId("thread-start", sessionId),
      params: {
        ...threadConfiguration({
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort,
          collaborationMode: input.collaborationMode,
          serviceTier: input.serviceTier,
        }),
        threadSource,
      },
    };
    let response: Record<string, unknown> | undefined;
    let nativeSessionId: string | undefined;
    let nativeSessionAttached = false;
    let nativeRuntime = environmentRuntime;
    try {
      const submitted = await this.requestCodexWithRuntime(
        input.environment.id,
        environmentRuntime,
        request,
        sessionId,
        nativeThreadCreationStableInputId(sessionId),
      );
      response = submitted.response;
      nativeRuntime = submitted.runtime;
    } catch (error) {
      const recovered = await this.findNativeThreadByCreationSource(
        input.environment.id,
        environmentRuntime,
        sessionId,
        threadSource,
      );
      nativeSessionId = recovered.nativeSessionId;
      nativeRuntime = recovered.runtime;
      if (!nativeSessionId) throw error;
    }
    if (!response && !nativeSessionId) {
      throw new HttpError(
        502,
        "codex_thread_failed",
        "Codex did not create a recoverable native Session.",
      );
    }
    if (response?.error) {
      throw new HttpError(
        502,
        "codex_thread_failed",
        rpcErrorMessage(response.error),
      );
    }
    if (response) {
      nativeSessionId = threadIdFromRpcResponse(response);
      nativeSessionAttached = nativeSessionId !== undefined;
      if (!nativeSessionId) {
        const recovered = await this.findNativeThreadByCreationSource(
          input.environment.id,
          nativeRuntime,
          sessionId,
          threadSource,
        );
        nativeSessionId = recovered.nativeSessionId;
        nativeRuntime = recovered.runtime;
      }
    }
    if (!nativeSessionId) {
      throw new HttpError(
        502,
        "codex_thread_failed",
        "Codex did not return its native Session id.",
      );
    }
    await this.store.markSessionNativeReady(sessionId, nativeSessionId);
    this.rememberNativeOwner(input.environment.id, nativeSessionId, sessionId);
    if (nativeSessionAttached) {
      this.rememberNativeSessionAttached(nativeRuntime, nativeSessionId);
    }
    return { nativeSessionId, runtime: nativeRuntime };
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

  async readEnvironmentMemories(
    userId: string,
    environmentId: string,
  ): Promise<CodexMemoriesSettings> {
    const runtime = await this.environmentRuntimeForEnvironment(
      userId,
      environmentId,
    );
    const config = await this.readEnvironmentCodexConfig(
      environmentId,
      runtime,
    );
    return codexMemoriesSettings(config.config);
  }

  async setEnvironmentMemories(input: {
    userId: string;
    environmentId: string;
    settings: CodexMemoriesSettings;
  }): Promise<CodexMemoriesSettings> {
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    return this.writeEnvironmentMemorySettings(
      input.environmentId,
      runtime,
      input.settings,
    );
  }

  async resetEnvironmentMemories(userId: string, environmentId: string) {
    const runtime = await this.environmentRuntimeForEnvironment(
      userId,
      environmentId,
    );
    const response = await this.requestCodex(environmentId, runtime, {
      method: "memory/reset",
      id: rpcId("memory-reset", environmentId),
    });
    requireRpcResult(
      response,
      "codex_memory_reset_failed",
      "Codex could not reset Environment memories.",
    );
    return { reset: true };
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
      const threadSource = nativeThreadCreationSource(childSessionId);
      const request = {
        method: "thread/fork",
        id: rpcId("thread-fork", childSessionId),
        params: {
          threadId: sourceRuntime.nativeSessionId,
          ...(input.selectedNativeTurnId
            ? { lastTurnId: input.selectedNativeTurnId }
            : {}),
          ...threadConfiguration({
            modelId: sourceRuntime.modelId,
            reasoningEffort: sourceRuntime.reasoningEffort,
          }),
          threadSource,
        },
      };
      let response: Record<string, unknown> | undefined;
      let nativeSessionId: string | undefined;
      let nativeSessionAttached = false;
      let nativeRuntime = environmentRuntime;
      try {
        const submitted = await this.requestCodexWithRuntime(
          environment.id,
          environmentRuntime,
          request,
          childSessionId,
          nativeThreadCreationStableInputId(childSessionId),
        );
        response = submitted.response;
        nativeRuntime = submitted.runtime;
      } catch (error) {
        const recovered = await this.findNativeThreadByCreationSource(
          environment.id,
          environmentRuntime,
          childSessionId,
          threadSource,
        );
        nativeSessionId = recovered.nativeSessionId;
        nativeRuntime = recovered.runtime;
        if (!nativeSessionId) throw error;
      }
      if (!response && !nativeSessionId) {
        throw new HttpError(
          502,
          "codex_thread_fork_failed",
          "Codex did not create a recoverable forked Session.",
        );
      }
      if (response?.error) {
        throw new HttpError(
          502,
          "codex_thread_fork_failed",
          rpcErrorMessage(response.error),
        );
      }
      if (response) {
        nativeSessionId = threadIdFromRpcResponse(response);
        nativeSessionAttached = nativeSessionId !== undefined;
        if (!nativeSessionId) {
          const recovered = await this.findNativeThreadByCreationSource(
            environment.id,
            nativeRuntime,
            childSessionId,
            threadSource,
          );
          nativeSessionId = recovered.nativeSessionId;
          nativeRuntime = recovered.runtime;
        }
      }
      if (!nativeSessionId) {
        throw new HttpError(
          502,
          "codex_thread_fork_failed",
          "Codex did not return the forked native Session.",
        );
      }
      await this.store.markSessionNativeReady(childSessionId, nativeSessionId);
      this.rememberNativeOwner(environment.id, nativeSessionId, childSessionId);
      if (nativeSessionAttached) {
        this.rememberNativeSessionAttached(nativeRuntime, nativeSessionId);
      }
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
    extraUserRoots: string[] = [],
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
        ...(extraUserRoots.length > 0
          ? {
              perCwdExtraUserRoots: [
                {
                  cwd: CODEX_ENVIRONMENT_CWD,
                  extraUserRoots,
                },
              ],
            }
          : {}),
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

  async consumeAccountRateLimitResetCredit(input: {
    userId: string;
    environmentId: string;
    idempotencyKey: string;
  }): Promise<CodexRateLimitResetResult> {
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    const response = await this.requestCodex(input.environmentId, runtime, {
      method: "account/rateLimitResetCredit/consume",
      id: rpcId("account-rate-limit-reset", input.environmentId),
      params: { idempotencyKey: input.idempotencyKey },
    });
    const result = requireSafeRpcResult(
      response,
      "codex_account_rate_limit_reset_failed",
      "Codex could not reset account usage.",
    );
    const outcome = boundedProviderString(result.outcome, 64);
    if (
      !outcome ||
      !CODEX_RATE_LIMIT_RESET_OUTCOMES.has(
        outcome as CodexRateLimitResetOutcome,
      )
    ) {
      throw invalidCodexResponse(
        "codex_account_rate_limit_reset_failed",
        "Codex returned an invalid account usage reset result.",
      );
    }
    return { outcome: outcome as CodexRateLimitResetOutcome };
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

  async putEnvironmentSkill(input: {
    userId: string;
    environmentId: string;
    name: string;
    files: CodexSkillFileInput[];
    enabled: boolean;
  }): Promise<CodexSkillsInventory> {
    const name = requireCodexSkillName(input.name);
    requireCodexSkillFiles(input.files);
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );

    // Ask Codex to discover the exact bytes at a temporary user-skill path
    // before replacing the requested path. A malformed SKILL.md must not
    // destroy a working skill in an Environment that is already in use.
    const validationName = `sandpi_validate_${randomUUID().replaceAll("-", "")}`;
    const validationRoot = `${CODEX_USER_SKILL_ROOT}/${validationName}`;
    const validationPath = `${validationRoot}/${name}/SKILL.md`;
    await this.runtime.replaceCodexEnvironmentSkill(
      runtime,
      validationName,
      input.files.map((file) => ({
        ...file,
        path: `${name}/${file.path}`,
      })),
    );
    try {
      const validationInventory = await this.listEnvironmentSkills(
        input.userId,
        input.environmentId,
        true,
        [validationRoot],
      );
      const validated = validationInventory.skills.some(
        (candidate) => candidate.path === validationPath,
      );
      if (!validated) {
        throw new HttpError(
          422,
          "codex_skill_invalid",
          "Codex did not discover the supplied Environment skill.",
          validationInventory.errors.length > 0
            ? { errors: validationInventory.errors }
            : undefined,
        );
      }
      await this.runtime.replaceCodexEnvironmentSkill(
        runtime,
        name,
        input.files,
      );
    } finally {
      await this.runtime.deleteCodexEnvironmentSkill(runtime, validationName);
    }

    let inventory = await this.listEnvironmentSkills(
      input.userId,
      input.environmentId,
      true,
    );
    const skillPath = `${CODEX_USER_SKILL_ROOT}/${name}/SKILL.md`;
    const skill = inventory.skills.find((candidate) => candidate.path === skillPath);
    if (!skill) {
      throw new HttpError(
        422,
        "codex_skill_invalid",
        "Codex did not discover the installed Environment skill.",
        inventory.errors.length > 0 ? { errors: inventory.errors } : undefined,
      );
    }
    if (skill.enabled !== input.enabled) {
      await this.setEnvironmentSkillEnabled({
        userId: input.userId,
        environmentId: input.environmentId,
        path: skillPath,
        enabled: input.enabled,
      });
      inventory = await this.listEnvironmentSkills(
        input.userId,
        input.environmentId,
        true,
      );
    }
    return inventory;
  }

  async deleteEnvironmentSkill(input: {
    userId: string;
    environmentId: string;
    name: string;
  }): Promise<CodexSkillsInventory> {
    const name = requireCodexSkillName(input.name);
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    await this.runtime.deleteCodexEnvironmentSkill(runtime, name);
    return this.listEnvironmentSkills(
      input.userId,
      input.environmentId,
      true,
    );
  }

  async listEnvironmentMcpServers(
    userId: string,
    environmentId: string,
    detail: "full" | "toolsAndAuthOnly" = "toolsAndAuthOnly",
  ): Promise<CodexMcpInventory> {
    const runtime = await this.environmentRuntimeForEnvironment(
      userId,
      environmentId,
    );
    return this.readEnvironmentMcpInventory(environmentId, runtime, detail);
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

  async putEnvironmentMcpServer(input: {
    userId: string;
    environmentId: string;
    name: string;
    configuration: CodexMcpServerConfiguration;
  }): Promise<CodexMcpInventory> {
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    const name = requireMcpServerName(input.name);
    const config = await this.readEnvironmentCodexConfig(
      input.environmentId,
      runtime,
    );
    if (
      Object.hasOwn(config.effectiveServers, name) &&
      !Object.hasOwn(config.userServers, name)
    ) {
      throw new HttpError(
        409,
        "codex_mcp_server_not_managed",
        "This MCP server is supplied by another configuration layer and cannot be replaced.",
      );
    }
    await this.writeCodexConfigValue(input.environmentId, runtime, {
      keyPath: `mcp_servers.${name}`,
      value: codexMcpServerDefinition(input.configuration),
    });
    await this.reloadEnvironmentMcpServers(input.environmentId, runtime);
    return this.readEnvironmentMcpInventory(input.environmentId, runtime);
  }

  async deleteEnvironmentMcpServer(input: {
    userId: string;
    environmentId: string;
    name: string;
  }): Promise<CodexMcpInventory> {
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    const name = requireMcpServerName(input.name);
    const config = await this.readEnvironmentCodexConfig(
      input.environmentId,
      runtime,
    );
    if (!Object.hasOwn(config.userServers, name)) {
      throw new HttpError(
        404,
        "codex_mcp_server_not_managed",
        "This MCP server is not managed by the Environment Codex configuration.",
      );
    }
    // Codex config/value/write removes a user-layer table when it receives a
    // null replacement, while leaving admin and project layers untouched.
    await this.writeCodexConfigValue(input.environmentId, runtime, {
      keyPath: `mcp_servers.${name}`,
      value: null,
    });
    await this.reloadEnvironmentMcpServers(input.environmentId, runtime);
    return this.readEnvironmentMcpInventory(input.environmentId, runtime);
  }

  async startEnvironmentMcpServerOAuthLogin(input: {
    userId: string;
    environmentId: string;
    name: string;
  }): Promise<CodexMcpOAuthLogin> {
    const runtime = await this.environmentRuntimeForEnvironment(
      input.userId,
      input.environmentId,
    );
    const name = requireMcpServerName(input.name);
    const inventory = await this.readEnvironmentMcpInventory(
      input.environmentId,
      runtime,
    );
    const server = inventory.servers.find(
      (candidate) => candidate.name === name,
    );
    if (!server) {
      throw new HttpError(
        404,
        "codex_mcp_server_not_found",
        "This MCP server is not present in the Environment Codex configuration.",
      );
    }
    if (!server.enabled) {
      throw new HttpError(
        409,
        "codex_mcp_server_disabled",
        "Enable this MCP server before connecting it.",
      );
    }
    if (server.transport !== "streamable-http") {
      throw new HttpError(
        409,
        "codex_mcp_oauth_unsupported",
        "OAuth login is available only for streamable HTTP MCP servers.",
      );
    }
    if (server.runtimeStatus !== "authentication-required") {
      throw new HttpError(
        409,
        server.runtimeStatus === "connected"
          ? "codex_mcp_server_already_connected"
          : "codex_mcp_oauth_unavailable",
        server.runtimeStatus === "connected"
          ? "This MCP server is already connected."
          : "Codex did not report that this MCP server supports OAuth login.",
      );
    }

    const callback =
      await this.runtime.ensureEnvironmentMcpOAuthCallbackService(runtime, {
        port: CODEX_MCP_OAUTH_CALLBACK_PORT,
      });
    const callbackUrl = mcpOAuthCallbackUrl(callback.publicUrl);
    const configResponse = await this.requestCodex(
      input.environmentId,
      runtime,
      {
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
              value: callback.port,
              mergeStrategy: "replace",
            },
            {
              keyPath: "mcp_oauth_callback_url",
              value: callbackUrl,
              mergeStrategy: "replace",
            },
          ],
          reloadUserConfig: true,
        },
      },
    );
    requireEffectiveConfigWrite(
      configResponse,
      "codex_mcp_oauth_config_failed",
      "Codex could not configure the MCP OAuth callback.",
    );

    const loginResponse = await this.requestCodex(
      input.environmentId,
      runtime,
      {
        method: "mcpServer/oauth/login",
        id: rpcId("mcp-oauth-login", `${input.environmentId}-${name}`),
        params: {
          name,
          timeoutSecs: CODEX_MCP_OAUTH_TIMEOUT_SECONDS,
        },
      },
    );
    const login = requireMcpRpcResult(
      loginResponse,
      "codex_mcp_oauth_login_failed",
      "Codex could not start MCP OAuth login.",
    );
    const authorizationUrl = safeMcpOAuthAuthorizationUrl(
      objectString(login, "authorizationUrl"),
    );
    return {
      name,
      authorizationUrl,
      expiresAt: toUnixTimestamp(
        new Date(Date.now() + CODEX_MCP_OAUTH_TIMEOUT_SECONDS * 1_000),
      ),
    };
  }

  private async readEnvironmentMcpInventory(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
    detail: "full" | "toolsAndAuthOnly" = "toolsAndAuthOnly",
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
          detail,
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
      config,
      effectiveServers,
      userServers: objectRecord(userConfig?.mcp_servers) ?? {},
    };
  }

  private async writeEnvironmentMemorySettings(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
    settings: CodexMemoriesSettings,
  ) {
    const normalizedSettings = settings.featureEnabled
      ? settings
      : codexMemoriesFeatureToggleSettings(false);
    const response = await this.requestCodex(environmentId, runtime, {
      method: "config/batchWrite",
      id: rpcId("memories-config-write", environmentId),
      params: {
        edits: [
          {
            keyPath: "features.memories",
            value: normalizedSettings.featureEnabled,
            mergeStrategy: "replace",
          },
          {
            keyPath: "memories.use_memories",
            value: normalizedSettings.useMemories,
            mergeStrategy: "replace",
          },
          {
            keyPath: "memories.generate_memories",
            value: normalizedSettings.generateMemories,
            mergeStrategy: "replace",
          },
        ],
        reloadUserConfig: true,
      },
    });
    requireEffectiveConfigWrite(
      response,
      "codex_memories_update_failed",
      "Codex could not update memory settings.",
    );
    const config = await this.readEnvironmentCodexConfig(
      environmentId,
      runtime,
    );
    return codexMemoriesSettings(config.config);
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
    requireEffectiveConfigWrite(
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

  private scheduleEnvironmentMcpReload(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
  ) {
    if (this.closed || this.mcpReloads.has(environmentId)) return;
    const reload = Promise.resolve()
      .then(() => this.reloadEnvironmentMcpServers(environmentId, runtime))
      .catch((error) => {
        if (this.closed) return;
        this.logger.warn(
          { environmentId, error: errorMessage(error) },
          "Codex MCP servers could not reload after OAuth login",
        );
      })
      .finally(() => {
        if (this.mcpReloads.get(environmentId) === reload) {
          this.mcpReloads.delete(environmentId);
        }
      });
    this.mcpReloads.set(environmentId, reload);
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
    collaborationMode?: "plan";
    serviceTier?: string;
    durableSubmission?: TurnSubmissionCoordinates;
  }) {
    const sessionRuntime = await this.requireNativeSessionRuntime(
      input.userId,
      input.sessionId,
    );
    const releaseInteractiveOperation =
      this.retainInteractiveEnvironmentOperation(sessionRuntime.environmentId);
    try {
      const submission =
        input.durableSubmission ??
        turnSubmissionCoordinates(input.sessionId, input.clientMessageId);
      // Persist pending delivery while holding the same Environment advisory
      // lock used by idle pause. If pause won first, the following native
      // runtime access auto-resumes it; if Turn admission won first, pause
      // observes work.
      let resumedDelivery: StoredSessionRuntime | undefined;
      try {
        await this.store.beginSessionTurn(
          input.userId,
          input.sessionId,
          input.modelId,
          submission,
          input.reasoningEffort,
        );
      } catch (error) {
        if (
          !input.durableSubmission ||
          !(error instanceof HttpError) ||
          error.code !== "session_turn_in_progress"
        ) {
          throw error;
        }
        const current = await this.store.getSessionRuntime(
          input.userId,
          input.sessionId,
        );
        if (!sessionRuntimeHasSubmission(current, submission)) throw error;
        resumedDelivery = current;
      }
      const turnRuntime = {
        ...sessionRuntime,
        modelId: input.modelId ?? sessionRuntime.modelId,
        reasoningEffort:
          input.reasoningEffort ?? sessionRuntime.reasoningEffort,
      };
      const turnCollaborationMode = nativeCollaborationMode(
        input.collaborationMode,
        turnRuntime.modelId,
        turnRuntime.reasoningEffort,
      );
      let turnDeliveryAttempted = false;
      let environmentRuntime: StoredEnvironmentRuntime | undefined;
      try {
        environmentRuntime = await this.environmentRuntimeForSession(
          input.userId,
          input.sessionId,
        );
        await this.ensureNativeSessionAttached(environmentRuntime, turnRuntime);
        if (resumedDelivery) {
          const observed = await this.readTurnDeliveryByClientMessage(
            turnRuntime,
            environmentRuntime,
            submission.clientMessageId,
          );
          environmentRuntime = observed.runtime;
          if (observed.turn) {
            if (observed.turn.status === "inProgress") {
              await this.store.markTurnAccepted(
                input.sessionId,
                submission.requestId,
                observed.turn.id,
                environmentRuntime.attemptId,
                environmentRuntime.runtimeGeneration,
              );
            }
            this.ensureEnvironmentWorker(sessionRuntime.environmentId);
            return {
              requestId: submission.requestId,
              clientMessageId: submission.clientMessageId,
              nativeTurnId: observed.turn.id,
              nativeTurnStatus: observed.turn.status,
            };
          }
          if (resumedDelivery.pendingTurnPhase === "accepted") {
            return {
              requestId: submission.requestId,
              clientMessageId: submission.clientMessageId,
              nativeTurnId: resumedDelivery.pendingTurnNativeTurnId,
            };
          }
          if (resumedDelivery.pendingTurnPhase === "submitted") {
            const submittedInCurrentEpoch =
              resumedDelivery.pendingTurnAttemptId ===
                environmentRuntime.attemptId &&
              resumedDelivery.pendingTurnRuntimeGeneration ===
                environmentRuntime.runtimeGeneration;
            if (submittedInCurrentEpoch) {
              this.ensureEnvironmentWorker(sessionRuntime.environmentId);
              return {
                requestId: submission.requestId,
                clientMessageId: submission.clientMessageId,
              };
            }
            const replayPrepared =
              await this.store.prepareDurableTurnReplay({
                sessionId: input.sessionId,
                submission,
                environmentAttemptId: environmentRuntime.attemptId,
                environmentRuntimeGeneration:
                  environmentRuntime.runtimeGeneration,
              });
            if (!replayPrepared) {
              return {
                requestId: submission.requestId,
                clientMessageId: submission.clientMessageId,
              };
            }
          }
        }
        const markedSubmitted = await this.store.markTurnSubmitted(
          input.sessionId,
          submission.requestId,
          environmentRuntime.attemptId,
          environmentRuntime.runtimeGeneration,
        );
        if (!markedSubmitted) {
          throw new HttpError(
            409,
            "codex_turn_changed",
            "The Session changed before Codex input delivery.",
          );
        }
        turnDeliveryAttempted = true;
        const submitted = await this.requestCodexWithRuntime(
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
              ...turnCollaborationMode,
              ...(input.serviceTier
                ? { serviceTier: input.serviceTier }
                : {}),
            },
          },
          input.sessionId,
          submission.stableInputId,
        );
        const { response, runtime: submittedRuntime } = submitted;
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
            submittedRuntime.attemptId,
            submittedRuntime.runtimeGeneration,
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

  /**
   * Adds native user input to the currently active regular Codex Turn.
   *
   * Codex owns the pending-input queue and emits the authoritative
   * userMessage. Sandpi keeps no secondary transcript or delivery projection
   * for this same-Turn input.
   */
  async steerTurn(input: {
    userId: string;
    sessionId: string;
    expectedTurnId: string;
    text: string;
    images: EncodedCodexInputImage[];
    localImages?: EncodedCodexLocalImage[];
    clientMessageId?: string;
  }) {
    const sessionRuntime = await this.requireNativeSessionRuntime(
      input.userId,
      input.sessionId,
    );
    const releaseInteractiveOperation =
      this.retainInteractiveEnvironmentOperation(sessionRuntime.environmentId);
    const clientMessageId =
      input.clientMessageId ?? `user-message:${randomUUID()}`;
    const requestId = rpcId("turn-steer", input.sessionId);
    try {
      const environmentRuntime = await this.environmentRuntimeForSession(
        input.userId,
        input.sessionId,
      );
      if (
        nativeTurnTargetBelongsToReplacedRuntime(
          sessionRuntime,
          input.expectedTurnId,
          environmentRuntime,
        )
      ) {
        this.scheduleExceptionalSessionReconciliation(environmentRuntime, {
          delayMs: 0,
        });
        throw new HttpError(
          409,
          "codex_turn_steer_stale",
          "The active Codex Turn belongs to a replaced runtime. Refresh the Session before sending more input.",
        );
      }
      await this.ensureNativeSessionAttached(
        environmentRuntime,
        sessionRuntime,
      );

      let response: Record<string, unknown>;
      try {
        response = await this.requestCodex(
          sessionRuntime.environmentId,
          environmentRuntime,
          {
            method: "turn/steer",
            id: requestId,
            params: {
              threadId: sessionRuntime.nativeSessionId,
              clientUserMessageId: clientMessageId,
              input: nativeCodexTurnInput(
                input.text,
                input.images,
                input.localImages ?? [],
              ),
              expectedTurnId: input.expectedTurnId,
            },
          },
          input.sessionId,
          `turn-steer:${input.sessionId}:${randomUUID()}`,
        );
      } catch (error) {
        if (!isAmbiguousTurnDelivery(error)) throw error;
        // Once delivery begins, replay could append the same user input twice.
        // Keep the browser's ephemeral row until the native userMessage or
        // Turn completion establishes whether Codex accepted it.
        this.ensureEnvironmentWorker(sessionRuntime.environmentId);
        return {
          requestId,
          clientMessageId,
          nativeTurnId: input.expectedTurnId,
        };
      }
      if (response.error) {
        throw new HttpError(
          409,
          "codex_turn_steer_rejected",
          rpcErrorMessage(response.error),
        );
      }
      const nativeTurnId = steeredTurnIdFromRpcResponse(response);
      if (!nativeTurnId || nativeTurnId !== input.expectedTurnId) {
        throw invalidCodexResponse(
          "codex_turn_steer_failed",
          "Codex returned an invalid active Turn after accepting additional input.",
        );
      }
      this.ensureEnvironmentWorker(sessionRuntime.environmentId);
      return { requestId, clientMessageId, nativeTurnId };
    } finally {
      releaseInteractiveOperation();
    }
  }

  async listModels(userId: string, sessionId: string) {
    const environmentRuntime = await this.environmentRuntimeForSession(
      userId,
      sessionId,
    );
    return this.listModelsFromRuntime(
      environmentRuntime.id,
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
    const key = environmentProtocolKey(environmentRuntime);
    const now = Date.now();
    const cached = this.modelCatalogs.get(key);
    if (cached && cached.expiresAt > now) {
      this.modelCatalogs.delete(key);
      this.modelCatalogs.set(key, cached);
      return cached.promise;
    }
    if (cached) this.modelCatalogs.delete(key);
    this.pruneModelCatalogs(now);

    const promise = this.loadModelsFromRuntime(
      environmentId,
      environmentRuntime,
      requestScopeId,
      ownerSessionId,
    );
    const entry: ModelCatalogCacheEntry = {
      expiresAt: Number.POSITIVE_INFINITY,
      promise,
    };
    this.modelCatalogs.set(key, entry);
    void promise.then(
      () => {
        if (this.modelCatalogs.get(key) !== entry) return;
        entry.expiresAt =
          Date.now() +
          (this.options.modelCatalogCacheTtlMs ??
            MODEL_CATALOG_CACHE_TTL_MS);
      },
      () => {
        if (this.modelCatalogs.get(key) === entry) {
          this.modelCatalogs.delete(key);
        }
      },
    );
    return promise;
  }

  private async loadModelsFromRuntime(
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

  private pruneModelCatalogs(now: number) {
    for (const [key, entry] of this.modelCatalogs) {
      if (entry.expiresAt <= now) this.modelCatalogs.delete(key);
    }
    while (this.modelCatalogs.size >= MAX_MODEL_CATALOG_CACHE_ENTRIES) {
      const oldest = this.modelCatalogs.keys().next().value;
      if (oldest === undefined) break;
      this.modelCatalogs.delete(oldest);
    }
  }

  async readAutomationTurnStatus(input: {
    userId: string;
    sessionId: string;
    clientMessageId: string;
  }) {
    const sessionRuntime = await this.requireNativeSessionRuntime(
      input.userId,
      input.sessionId,
    );
    const environmentRuntime = await this.environmentRuntimeForSession(
      input.userId,
      input.sessionId,
    );
    const observed = await this.readTurnDeliveryByClientMessage(
      sessionRuntime,
      environmentRuntime,
      input.clientMessageId,
    );
    const turn = observed.turn;
    if (!turn) return { status: "absent" as const };
    if (turn.status === "inProgress") {
      return {
        status: "running" as const,
        nativeTurnId: turn.id,
      };
    }
    if (turn.status === "completed") {
      return {
        status: "succeeded" as const,
        nativeTurnId: turn.id,
      };
    }
    if (turn.status === "interrupted") {
      const recoveryTurn = nativeRuntimeRecoveryTurn(
        observed.thread!,
        sessionRuntime.sessionId,
        turn.id,
      );
      if (recoveryTurn) {
        if (recoveryTurn.status === "inProgress") {
          return {
            status: "running" as const,
            nativeTurnId: recoveryTurn.id,
          };
        }
        if (recoveryTurn.status === "completed") {
          return {
            status: "succeeded" as const,
            nativeTurnId: recoveryTurn.id,
          };
        }
        return {
          status: "failed" as const,
          nativeTurnId: recoveryTurn.id,
          error:
            recoveryTurn.error?.message ??
            "The Automation recovery Turn did not complete.",
        };
      }
      if (
        sessionRuntime.recoverySourceNativeTurnId === turn.id ||
        automationTurnNeedsRuntimeRecovery(
          sessionRuntime,
          turn,
          input.clientMessageId,
          observed.runtime,
        )
      ) {
        await this.scheduleSessionControlStateRepair(input.sessionId);
        return {
          status: "running" as const,
          nativeTurnId: turn.id,
        };
      }
    }
    return {
      status: "failed" as const,
      nativeTurnId: turn.id,
      error:
        turn.error?.message ??
        (turn.status === "interrupted"
          ? "The Automation Codex Turn was interrupted."
          : "The Automation Codex Turn failed."),
    };
  }

  private async readTurnDeliveryByClientMessage(
    sessionRuntime: StoredSessionRuntime,
    environmentRuntime: StoredEnvironmentRuntime,
    clientMessageId: string,
  ): Promise<{
    runtime: StoredEnvironmentRuntime;
    thread?: CodexThread;
    turn?: CodexTurn;
  }> {
    if (!sessionRuntime.nativeSessionId) {
      throw new HttpError(
        409,
        "native_session_not_ready",
        "The native Session is not ready.",
      );
    }
    const submitted = await this.requestCodexWithRuntime(
      sessionRuntime.environmentId,
      environmentRuntime,
      {
        method: "thread/read",
        id: rpcId("turn-delivery-read", sessionRuntime.sessionId),
        params: {
          threadId: sessionRuntime.nativeSessionId,
          includeTurns: true,
        },
      },
      sessionRuntime.sessionId,
    );
    if (submitted.response.error) {
      if (isUnmaterializedNativeThreadError(submitted.response.error)) {
        // thread/read reached the current app-server and recognized this
        // ephemeral pre-first-message Thread. It has no rollout to resume, but
        // turn/start may use it directly even after the Sandpi server restarted.
        this.rememberNativeSessionAttached(
          submitted.runtime,
          sessionRuntime.nativeSessionId,
        );
        return { runtime: submitted.runtime };
      }
      throw nativeSessionUnavailable(submitted.response.error);
    }
    const thread = threadFromRpcResponse(submitted.response);
    if (!thread || thread.id !== sessionRuntime.nativeSessionId) {
      throw new HttpError(
        502,
        "codex_thread_read_failed",
        "Codex returned an invalid native Session snapshot.",
      );
    }
    return {
      runtime: submitted.runtime,
      thread,
      turn: nativeTurnForClientMessage(thread, clientMessageId),
    };
  }

  async readNativeSnapshot(userId: string, sessionId: string) {
    const read = await this.readNativeSnapshotWithCursor(userId, sessionId);
    const supplement = await read.supplement;
    return {
      ...read.snapshot,
      activity: supplement.activity,
      tokenUsage: supplement.tokenUsage,
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
    const key = nativeSnapshotReadKey(sessionRuntime, environmentRuntime);
    let entry = this.nativeSnapshotReads.get(sessionId);
    if (!entry || entry.key !== key) {
      const promise = this.loadNativeSnapshotWithCursor(
        sessionId,
        sessionRuntime,
        environmentRuntime,
      );
      const createdEntry = { key, promise };
      entry = createdEntry;
      this.nativeSnapshotReads.set(sessionId, createdEntry);
      const clear = () => {
        if (this.nativeSnapshotReads.get(sessionId) === createdEntry) {
          this.nativeSnapshotReads.delete(sessionId);
        }
      };
      void promise.then(clear, clear);
    }
    return waitForSharedSnapshot(entry.promise, signal);
  }

  private async loadNativeSnapshotWithCursor(
    sessionId: string,
    sessionRuntime: StoredSessionRuntime & { nativeSessionId: string },
    environmentRuntime: StoredEnvironmentRuntime,
  ): Promise<CodexNativeSnapshotRead> {
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
    const nativeThread = threadFromRpcResponse(response);
    if (!nativeThread || nativeThread.id !== sessionRuntime.nativeSessionId) {
      throw new HttpError(
        502,
        "codex_thread_read_failed",
        "Codex returned an invalid native Session snapshot.",
      );
    }
    rememberActiveInlineReview(
      this.activeInlineReviews,
      sessionRuntime.environmentId,
      nativeThread,
    );
    const thread = stabilizeAcceptedTurnStartSnapshot(
      nativeThread,
      sessionRuntime,
      responseRuntime,
    );
    const anchor = this.takeRpcAnchor(
      sessionRuntime.environmentId,
      requestId,
      sessionId,
    );
    const supplement = this.readCodexRolloutSupplement(
      sessionRuntime.environmentId,
      responseRuntime,
      sessionRuntime.nativeSessionId,
      thread.path,
    );
    const activeNativeTurnId = latestInProgressNativeTurn(thread)?.id;
    const projectedTurn = nativeTurnForSessionProjection(
      thread,
      sessionRuntime,
    );
    const requiresExceptionalTurnResolution = Boolean(
      sessionRuntime.recoverySourceNativeTurnId ||
      projectedTurn?.turn.status === "interrupted",
    );
    const nativeSettled = ["idle", "notLoaded", "systemError"].includes(
      thread.status.type,
    );
    const pendingRecoveryCutoff = nativeSettled
      ? new Date(
          Date.now() -
            (this.options.exceptionalPendingTurnGraceMs ??
              EXCEPTIONAL_PENDING_TURN_GRACE_MS),
        )
      : undefined;
    const pendingRecoveryEligible = Boolean(
      pendingRecoveryCutoff &&
      sessionRuntime.pendingTurnStartedAt &&
      sessionRuntime.pendingTurnStartedAt <= pendingRecoveryCutoff,
    );
    const expectedSessionStatus =
      activeNativeTurnId ||
      (sessionRuntime.pendingTurnPhase && !pendingRecoveryEligible)
        ? "running"
        : "waiting";
    const projectionChanged =
      sessionRuntime.activeNativeTurnId !== activeNativeTurnId ||
      pendingRecoveryEligible ||
      sessionRuntime.sessionStatus !== expectedSessionStatus;
    let reconciled = false;
    if (requiresExceptionalTurnResolution) {
      this.scheduleExceptionalSessionReconciliation(responseRuntime, {
        delayMs: 0,
        pendingTurnRequests:
          sessionRuntime.pendingTurnRequestId === undefined
            ? undefined
            : new Map([
                [sessionRuntime.sessionId, sessionRuntime.pendingTurnRequestId],
              ]),
      });
    } else {
      reconciled = await this.store.reconcileNativeSessionState({
        sessionId,
        nativeSessionId: sessionRuntime.nativeSessionId,
        historyRevision: sessionRuntime.historyRevision,
        runtimeVersion: sessionRuntime.version,
        environmentId: responseRuntime.id,
        environmentSupervisorSessionId: responseRuntime.supervisorSessionId,
        environmentAttemptId: responseRuntime.attemptId,
        environmentRuntimeGeneration: responseRuntime.runtimeGeneration,
        activeNativeTurnId,
        clearPendingWhenNativeIdle: nativeSettled,
        clearPendingStartedBefore: pendingRecoveryCutoff,
      });
    }
    if (reconciled && projectionChanged) {
      this.publishInvalidation(sessionId, "native-session-state-reconciled", {
        message: "Codex execution state was repaired from the native Thread.",
      });
    }
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
        tokenUsage: null,
        activity: loadingCodexRolloutActivity(),
        forkableTurnIds,
      },
      liveCursor: anchor ?? this.liveCursor(sessionId),
      supplement,
    };
  }

  private async readCodexRolloutSupplement(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
    nativeSessionId: string,
    nativeRolloutPath: unknown,
    signal?: AbortSignal,
  ): Promise<CodexRolloutSupplement> {
    const rolloutPath = validCodexRolloutPath(
      nativeRolloutPath,
      nativeSessionId,
    );
    if (!rolloutPath) {
      return {
        activity: unavailableCodexRolloutActivity(
          nativeRolloutPath !== null && nativeRolloutPath !== undefined
            ? "codex_rollout_path_invalid"
            : "codex_rollout_path_missing",
          nativeRolloutPath !== null && nativeRolloutPath !== undefined
            ? "Codex returned an invalid rollout path. Persisted tool activity is unavailable."
            : "Codex did not expose a rollout path. Persisted tool activity is unavailable.",
        ),
        tokenUsage: null,
      };
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
      return parseCodexRolloutSupplement(
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
      return {
        activity: unavailableCodexRolloutActivity(
          code.startsWith("codex_rollout_") ? code : "codex_rollout_read_failed",
          message,
        ),
        tokenUsage: null,
      };
    } finally {
      if (readTimeout) clearTimeout(readTimeout);
      if (abortRead) signal?.removeEventListener("abort", abortRead);
    }
  }

  async interruptActiveTurn(input: {
    userId: string;
    sessionId: string;
    turnId?: string;
  }) {
    let sessionRuntime = await this.requireNativeSessionRuntime(
      input.userId,
      input.sessionId,
    );
    const turnId = await this.store.requestTurnInterrupt(
      input.sessionId,
      input.turnId,
    );
    if (!turnId) {
      sessionRuntime = await this.requireNativeSessionRuntime(
        input.userId,
        input.sessionId,
      );
      if (sessionRuntime.sessionStatus !== "running") {
        return { status: "settled" as const };
      }
      throw new HttpError(
        409,
        "codex_turn_not_interruptible",
        "The running Codex Turn has not exposed an interrupt target yet.",
      );
    }
    sessionRuntime = await this.requireNativeSessionRuntime(
      input.userId,
      input.sessionId,
    );
    if (sessionRuntime.sessionStatus !== "running") {
      return { status: "settled" as const };
    }
    if (sessionRuntime.interruptRequestedNativeTurnId !== turnId) {
      return { turnId, status: "interrupting" as const };
    }
    const releaseInteractiveOperation =
      this.retainInteractiveEnvironmentOperation(sessionRuntime.environmentId);
    try {
      const environmentRuntime = await this.environmentRuntimeForSession(
        input.userId,
        input.sessionId,
      );
      if (
        input.turnId !== turnId &&
        nativeTurnTargetBelongsToReplacedRuntime(
          sessionRuntime,
          turnId,
          environmentRuntime,
        )
      ) {
        this.scheduleExceptionalSessionReconciliation(environmentRuntime, {
          delayMs: 0,
        });
        return { turnId, status: "interrupting" as const };
      }
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
            turnId,
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
      return { turnId, status: "interrupting" as const };
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

  async finishEnvironmentWorkspaceRestoreAttempt(
    environmentId: string,
    result: { nativeRestored: boolean; resumeAfterRestore: boolean },
  ) {
    this.suspendEnvironmentWorker(environmentId);
    if (result.nativeRestored) {
      this.resetEnvironmentProtocolState(environmentId);
      await this.invalidateEnvironmentSessions(
        environmentId,
        "environment-workspace-restored",
        "The shared Workspace was restored; reload the native Session snapshot.",
        { includeFailed: true },
      );
    }
    if (result.resumeAfterRestore) {
      this.restartEnvironmentWorker(environmentId);
    }
  }

  async flushEnvironmentCredentials(environmentId: string) {
    const runtime = await this.store.environmentRuntime(environmentId);
    await this.captureEnvironmentCredential(runtime);
  }

  /**
   * Unarchiving can expose control state whose live event was missed while the
   * Session was hidden. Queue a native repair that can also classify recovery.
   */
  async scheduleSessionControlStateRepair(sessionId: string) {
    try {
      const session = await this.store.sessionRuntime(sessionId);
      const runtime = await this.store.environmentRuntime(
        session.environmentId,
      );
      if (runtime.desiredState === "running") {
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
    const transitions = controlTransitions(
      records,
      stored.id,
      this.activeInlineReviews,
    );
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

    for (const record of records) {
      this.cacheRpcRecord(stored.id, record);
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

    if (records.some(isSuccessfulMcpOAuthLoginNotification)) {
      // Never await a new RPC inside the stream consumer that must decode its
      // response. The detached task is coalesced per Environment and starts
      // after this committed batch returns to the worker loop.
      this.scheduleEnvironmentMcpReload(stored.id, next);
    }
    for (const record of records) {
      if (!isSessionNotification(record.message)) continue;
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
    const supervisorFailure = supervisorFailureRequiringRecovery(events, stored);
    if (supervisorFailure) throw supervisorFailure;
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
    await Promise.allSettled(this.mcpReloads.values());
    await Promise.allSettled(exceptionalTasks);
    this.workers.clear();
    this.workerTasks.clear();
    this.initializing.clear();
    this.modelCatalogs.clear();
    this.rpcWaiters.clear();
    this.rpcResponses.clear();
    this.rpcAnchors.clear();
    this.requestOwners.clear();
    this.nativeOwners.clear();
    this.nativeSessionAttachments.clear();
    this.nativeSnapshotReads.clear();
    this.exceptionalSessionTasks.clear();
    this.deferredExceptionalSessionReconciliations.clear();
    this.interactiveEnvironmentOperations.clear();
    this.mcpReloads.clear();
    this.activeInlineReviews.clear();
  }

  private async ensureEnvironmentRuntimeForUser(
    userId: string,
    environment: Environment,
  ) {
    await this.options.runtimeQuotaGate?.assertEnvironmentRuntimeAllowed(
      environment.id,
    );
    // Every caller supplies an Environment already authorized for this user.
    // Avoid repeating the same ownership query before reading its runtime.
    const current = await this.store.environmentRuntime(environment.id);
    if (
      current.desiredState === "running" &&
      current.supervisorSessionId &&
      current.attemptId &&
      current.codexCredentialBindingCurrent === true &&
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
    while (!this.closed) {
      try {
        await this.options.runtimeQuotaGate?.assertEnvironmentRuntimeAllowed(
          environmentId,
        );
        const credential =
          await this.credentials.credentialForEnvironmentRuntime(environmentId);
        const locked =
          await this.advisoryLockStore().withEnvironmentLifecycleLock(
            environmentId,
            async (lockedStore) => {
              const scopedStore = lockedStore ?? this.store;
              return this.reconcileEnvironmentRuntime(
                environmentId,
                credential,
                scopedStore,
              );
            },
          );
        if (locked.acquired) {
          await this.ensureProtocolInitialized(locked.value);
          // A credential binding means the process-local Codex account is
          // ready, not merely that auth.json was written. Publish it only
          // after the replacement app-server answers initialize.
          await this.credentials.markCredentialMaterialized(
            environmentId,
            credential,
          );
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
        // The native attempt can exit after reconciliation but before
        // app-server initialization is accepted. Keep the same recovery
        // owner alive so the replacement worker can consume initialization
        // responses; releasing it here can leave a terminal Supervisor stream
        // waiting forever with no later event to trigger another repair.
        await delay(RUNTIME_RECOVERY_LOCK_RETRY_MS);
      }
    }
    throw new Error("Codex service is closed");
  }

  private async reconcileEnvironmentRuntime(
    environmentId: string,
    credential: CodexCredentialMaterial,
    lockedStore: SandpiStore,
  ) {
    await this.options.runtimeQuotaGate?.assertEnvironmentRuntimeAllowed(
      environmentId,
    );
    const current = await lockedStore.environmentRuntime(environmentId);
    const recovered = await this.runtime.ensureCodexEnvironmentRuntime(
      current,
      credential.authJson,
      {
        replaceSupervisorAttempt:
          Boolean(current.supervisorSessionId && current.attemptId) &&
          current.codexCredentialBindingCurrent !== true,
      },
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
    if (current.desiredState === "running") {
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
    // shared lifecycle lock then refreshes Sandpi's runtime fencing coordinates
    // before this request is considered complete.
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
      if (
        session.pendingTurnPhase &&
        !targetedPendingTurn &&
        !session.activeNativeTurnId &&
        !session.recoverySourceNativeTurnId
      ) {
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
    if (currentRuntime.desiredState !== "running") {
      return;
    }
    const activeTurn = latestInProgressNativeTurn(thread);
    if (thread.status.type === "active" || activeTurn) {
      const pendingMatchesActive =
        activeTurn &&
        session.pendingTurnClientMessageId &&
        nativeTurnForClientMessage(thread, session.pendingTurnClientMessageId)
          ?.id === activeTurn.id;
      const acceptanceNeedsRepair = Boolean(
        activeTurn &&
        pendingMatchesActive &&
        session.pendingTurnRequestId &&
        (session.pendingTurnPhase !== "accepted" ||
          session.pendingTurnNativeTurnId !== activeTurn.id ||
          session.activeNativeTurnId !== activeTurn.id ||
          session.activeTurnAttemptId !== latestRuntime.attemptId ||
          session.activeTurnRuntimeGeneration !==
            latestRuntime.runtimeGeneration),
      );
      if (activeTurn && session.pendingTurnRequestId && acceptanceNeedsRepair) {
        await this.store.markTurnAccepted(
          session.sessionId,
          session.pendingTurnRequestId,
          activeTurn.id,
          latestRuntime.attemptId,
          latestRuntime.runtimeGeneration,
        );
      } else {
        await this.store.reconcileNativeSessionState({
          sessionId: session.sessionId,
          nativeSessionId,
          historyRevision: session.historyRevision,
          runtimeVersion: session.version,
          environmentId: latestRuntime.id,
          environmentSupervisorSessionId: latestRuntime.supervisorSessionId,
          environmentAttemptId: latestRuntime.attemptId,
          environmentRuntimeGeneration: latestRuntime.runtimeGeneration,
          activeNativeTurnId: activeTurn?.id ?? session.activeNativeTurnId,
          requireUnarchived: true,
        });
      }
      this.requestExceptionalSessionRerun(
        reconciliation,
        this.options.exceptionalSessionActiveRecheckMs ??
          EXCEPTIONAL_SESSION_ACTIVE_RECHECK_MS,
      );
      return;
    }
    if (!["idle", "notLoaded", "systemError"].includes(thread.status.type)) {
      this.requestExceptionalSessionRetry(reconciliation);
      return;
    }

    if (
      thread.status.type === "systemError" &&
      session.recoverySourceNativeTurnId
    ) {
      await this.settleExceptionalSession(
        latestRuntime,
        reconciliation,
        session,
        nativeSessionId,
        true,
        true,
        "automatic_turn_recovery_native_unavailable",
      );
      return;
    }

    if (session.recoverySourceNativeTurnId) {
      await this.reconcileClaimedTurnRecovery(
        latestRuntime,
        reconciliation,
        session,
        nativeSessionId,
        thread,
      );
      return;
    }

    const projectedTurn = nativeTurnForSessionProjection(thread, session);
    const runtimeInterrupted =
      thread.status.type !== "systemError" &&
      projectedTurn?.turn.status === "interrupted" &&
      nativeTurnBelongsToReplacedRuntime(session, projectedTurn, latestRuntime);
    if (
      runtimeInterrupted &&
      projectedTurn &&
      session.interruptRequestedNativeTurnId !== projectedTurn.turn.id &&
      session.recoveryAttemptCount < AUTOMATIC_TURN_RECOVERY_MAX_ATTEMPTS
    ) {
      const submission = runtimeRecoveryTurnSubmissionCoordinates(
        session.sessionId,
        projectedTurn.turn.id,
      );
      const claimed = await this.store.claimInterruptedTurnRecovery({
        sessionId: session.sessionId,
        nativeSessionId,
        historyRevision: session.historyRevision,
        runtimeVersion: session.version,
        environmentId: latestRuntime.id,
        environmentSupervisorSessionId: latestRuntime.supervisorSessionId,
        environmentAttemptId: latestRuntime.attemptId,
        environmentRuntimeGeneration: latestRuntime.runtimeGeneration,
        sourceNativeTurnId: projectedTurn.turn.id,
        sourcePendingClientMessageId:
          projectedTurn.matchedBy === "clientMessage"
            ? session.pendingTurnClientMessageId
            : undefined,
        submission,
        promptVersion: CODEX_RUNTIME_RECOVERY_PROMPT_VERSION,
      });
      if (!claimed) {
        this.requestExceptionalSessionRetry(reconciliation);
        return;
      }
      const claimedSession: StoredSessionRuntime = {
        ...session,
        activeNativeTurnId: undefined,
        activeTurnAttemptId: undefined,
        activeTurnRuntimeGeneration: undefined,
        pendingTurnRequestId: submission.requestId,
        pendingTurnClientMessageId: submission.clientMessageId,
        pendingTurnStableInputId: submission.stableInputId,
        pendingTurnPhase: "prepared",
        pendingTurnNativeTurnId: undefined,
        pendingTurnStartedAt: new Date(),
        pendingTurnAttemptId: undefined,
        pendingTurnRuntimeGeneration: undefined,
        interruptRequestedNativeTurnId: undefined,
        recoverySourceNativeTurnId: projectedTurn.turn.id,
        recoveryPromptVersion: CODEX_RUNTIME_RECOVERY_PROMPT_VERSION,
        recoveryAttemptCount: session.recoveryAttemptCount + 1,
        runtimeErrorCode: undefined,
        sessionStatus: "running",
        version: session.version + 1,
      };
      await this.startClaimedTurnRecovery(
        latestRuntime,
        reconciliation,
        claimedSession,
      );
      return;
    }

    const terminalProjection = Boolean(
      projectedTurn && projectedTurn.turn.status !== "inProgress",
    );
    await this.settleExceptionalSession(
      latestRuntime,
      reconciliation,
      session,
      nativeSessionId,
      targetedPendingTurn,
      terminalProjection,
    );
  }

  private async reconcileClaimedTurnRecovery(
    runtime: StoredEnvironmentRuntime,
    reconciliation: ExceptionalSessionReconciliation,
    session: StoredSessionRuntime,
    nativeSessionId: string,
    thread: CodexThread,
  ) {
    if (
      session.interruptRequestedNativeTurnId ===
      session.recoverySourceNativeTurnId
    ) {
      await this.settleExceptionalSession(
        runtime,
        reconciliation,
        session,
        nativeSessionId,
        true,
        true,
      );
      return;
    }
    if (
      !isCodexRuntimeRecoveryClientMessageId(session.pendingTurnClientMessageId)
    ) {
      this.requestExceptionalSessionRetry(reconciliation);
      return;
    }
    if (thread.status.type === "notLoaded") {
      await this.ensureNativeSessionAttached(runtime, {
        ...session,
        nativeSessionId,
      });
      this.requestExceptionalSessionRerun(reconciliation, 0);
      return;
    }
    const recoveryTurn =
      session.pendingTurnNativeTurnId &&
      session.pendingTurnNativeTurnId !== session.recoverySourceNativeTurnId
        ? thread.turns.find(
            (turn) => turn.id === session.pendingTurnNativeTurnId,
          )
        : session.pendingTurnClientMessageId
          ? nativeTurnForClientMessage(
              thread,
              session.pendingTurnClientMessageId,
            )
          : undefined;
    if (recoveryTurn) {
      if (recoveryTurn.status === "inProgress") {
        if (session.pendingTurnRequestId) {
          await this.store.markTurnAccepted(
            session.sessionId,
            session.pendingTurnRequestId,
            recoveryTurn.id,
            runtime.attemptId,
            runtime.runtimeGeneration,
          );
        }
        this.requestExceptionalSessionRerun(
          reconciliation,
          this.options.exceptionalSessionActiveRecheckMs ??
            EXCEPTIONAL_SESSION_ACTIVE_RECHECK_MS,
        );
        return;
      }
      await this.settleExceptionalSession(
        runtime,
        reconciliation,
        session,
        nativeSessionId,
        true,
        true,
        recoveryTurn.status === "interrupted"
          ? "automatic_turn_recovery_exhausted"
          : undefined,
      );
      return;
    }

    if (
      session.pendingTurnPhase === "prepared" &&
      session.pendingTurnRequestId &&
      session.pendingTurnClientMessageId &&
      session.pendingTurnStableInputId
    ) {
      await this.startClaimedTurnRecovery(runtime, reconciliation, session);
      return;
    }

    if (
      session.pendingTurnPhase === "submitted" &&
      session.pendingTurnRequestId
    ) {
      const submittedInCurrentEpoch =
        session.pendingTurnAttemptId === runtime.attemptId &&
        session.pendingTurnRuntimeGeneration === runtime.runtimeGeneration;
      if (submittedInCurrentEpoch) {
        const delayMs = exceptionalPendingTurnDelayMs(
          session.pendingTurnStartedAt,
          this.options.exceptionalPendingTurnGraceMs ??
            EXCEPTIONAL_PENDING_TURN_GRACE_MS,
        );
        if (delayMs > 0) {
          this.requestExceptionalSessionRerun(reconciliation, delayMs);
          return;
        }
        await this.store.failInterruptedTurnRecovery(
          session.sessionId,
          session.pendingTurnRequestId,
          "automatic_turn_recovery_timeout",
        );
        this.publishInvalidation(
          session.sessionId,
          "automatic-turn-recovery-failed",
          {
            message:
              "Sandpi could not confirm that the automatic recovery Turn started.",
          },
        );
        return;
      }
      const prepared = await this.store.prepareInterruptedTurnRecoveryReplay({
        sessionId: session.sessionId,
        nativeSessionId,
        runtimeVersion: session.version,
        requestId: session.pendingTurnRequestId,
        environmentAttemptId: runtime.attemptId,
        environmentRuntimeGeneration: runtime.runtimeGeneration,
      });
      if (!prepared) {
        this.requestExceptionalSessionRetry(reconciliation);
        return;
      }
      await this.startClaimedTurnRecovery(runtime, reconciliation, {
        ...session,
        pendingTurnPhase: "prepared",
        pendingTurnAttemptId: undefined,
        pendingTurnRuntimeGeneration: undefined,
        version: session.version + 1,
      });
      return;
    }

    this.requestExceptionalSessionRetry(reconciliation);
  }

  private async startClaimedTurnRecovery(
    runtime: StoredEnvironmentRuntime,
    reconciliation: ExceptionalSessionReconciliation,
    session: StoredSessionRuntime,
  ) {
    if (
      !session.nativeSessionId ||
      !session.pendingTurnRequestId ||
      !session.pendingTurnClientMessageId ||
      !session.pendingTurnStableInputId ||
      !session.recoverySourceNativeTurnId
    ) {
      this.requestExceptionalSessionRetry(reconciliation);
      return;
    }
    try {
      await this.ensureNativeSessionAttached(runtime, {
        ...session,
        nativeSessionId: session.nativeSessionId,
      });
      const deliveryRuntime = await this.store.environmentRuntime(runtime.id);
      if (
        environmentRuntimeEpoch(deliveryRuntime) !==
          environmentRuntimeEpoch(runtime) ||
        deliveryRuntime.desiredState !== "running"
      ) {
        this.handoffExceptionalSessionReconciliation(
          deliveryRuntime,
          reconciliation,
        );
        return;
      }
      const markedSubmitted = await this.store.markTurnSubmitted(
        session.sessionId,
        session.pendingTurnRequestId,
        deliveryRuntime.attemptId,
        deliveryRuntime.runtimeGeneration,
      );
      if (!markedSubmitted) {
        this.requestExceptionalSessionRetry(reconciliation);
        return;
      }
      const { response, runtime: submittedRuntime } =
        await this.requestCodexWithRuntime(
          session.environmentId,
          deliveryRuntime,
          {
            method: "turn/start",
            id: session.pendingTurnRequestId,
            params: {
              threadId: session.nativeSessionId,
              clientUserMessageId: session.pendingTurnClientMessageId,
              input: nativeCodexTurnInput(
                codexRuntimeRecoveryPrompt(
                  session.recoveryPromptVersion ??
                    CODEX_RUNTIME_RECOVERY_PROMPT_VERSION,
                ),
                [],
                [],
              ),
              ...(session.modelId ? { model: session.modelId } : {}),
              ...(session.reasoningEffort
                ? { effort: session.reasoningEffort }
                : {}),
            },
          },
          session.sessionId,
          session.pendingTurnStableInputId,
          false,
        );
      if (response.error) {
        await this.store.failInterruptedTurnRecovery(
          session.sessionId,
          session.pendingTurnRequestId,
          "automatic_turn_recovery_rejected",
        );
        this.publishInvalidation(
          session.sessionId,
          "automatic-turn-recovery-failed",
          {
            message: "Codex rejected the automatic recovery Turn.",
          },
        );
        return;
      }
      const nativeTurnId = turnIdFromRpcResponse(response);
      if (!nativeTurnId) {
        this.requestExceptionalSessionRetry(reconciliation);
        return;
      }
      await this.store.markTurnAccepted(
        session.sessionId,
        session.pendingTurnRequestId,
        nativeTurnId,
        submittedRuntime.attemptId,
        submittedRuntime.runtimeGeneration,
      );
      this.ensureEnvironmentWorker(session.environmentId);
      this.requestExceptionalSessionRerun(
        reconciliation,
        this.options.exceptionalSessionActiveRecheckMs ??
          EXCEPTIONAL_SESSION_ACTIVE_RECHECK_MS,
      );
      this.publishInvalidation(
        session.sessionId,
        "automatic-turn-recovery-accepted",
        {
          message:
            "Codex accepted Sandpi's recovery Turn after the runtime restart.",
        },
      );
    } catch (error) {
      this.requestExceptionalSessionRetry(reconciliation);
      this.logger.warn(
        {
          environmentId: session.environmentId,
          sessionId: session.sessionId,
          error: errorMessage(error),
        },
        "Automatic Codex Turn recovery deferred",
      );
    }
  }

  private async settleExceptionalSession(
    runtime: StoredEnvironmentRuntime,
    reconciliation: ExceptionalSessionReconciliation,
    session: StoredSessionRuntime,
    nativeSessionId: string,
    targetedPendingTurn: boolean,
    terminalProjection: boolean,
    recoveryErrorCode?: string,
  ) {
    const projectionChanged =
      session.activeNativeTurnId !== undefined ||
      Boolean(session.pendingTurnPhase) ||
      Boolean(session.interruptRequestedNativeTurnId) ||
      Boolean(session.recoverySourceNativeTurnId) ||
      session.sessionStatus !== "waiting";
    const reconciled = await this.store.reconcileNativeSessionState({
      sessionId: session.sessionId,
      nativeSessionId,
      historyRevision: session.historyRevision,
      runtimeVersion: session.version,
      environmentId: runtime.id,
      environmentSupervisorSessionId: runtime.supervisorSessionId,
      environmentAttemptId: runtime.attemptId,
      environmentRuntimeGeneration: runtime.runtimeGeneration,
      activeNativeTurnId: undefined,
      clearPendingWhenNativeIdle: true,
      clearPendingRequestId:
        terminalProjection || targetedPendingTurn
          ? session.pendingTurnRequestId
          : undefined,
      clearPendingStartedBefore:
        terminalProjection || targetedPendingTurn
          ? undefined
          : new Date(
              Date.now() -
                (this.options.exceptionalPendingTurnGraceMs ??
                  EXCEPTIONAL_PENDING_TURN_GRACE_MS),
            ),
      clearRecoveryState: terminalProjection,
      recoveryErrorCode,
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
   * Serializes the native read submission with Environment lifecycle changes.
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
        includeTurns: true,
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
        if (runtime.desiredState !== "running") {
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
    for (const key of this.modelCatalogs.keys()) {
      if (key.startsWith(prefix)) this.modelCatalogs.delete(key);
    }
  }

  private resetEnvironmentProtocolState(environmentId: string) {
    this.forgetEnvironmentProtocolReadiness(environmentId);
    this.nativeSessionAttachments.delete(environmentId);
    this.rpcResponses.delete(environmentId);
    this.rpcAnchors.delete(environmentId);
    this.rejectEnvironmentRpcWaitersForEpochChange(environmentId);
    const prefix = `${environmentId}\0`;
    for (const key of this.nativeOwners.keys()) {
      if (key.startsWith(prefix)) this.nativeOwners.delete(key);
    }
    for (const key of this.requestOwners.keys()) {
      if (key.startsWith(prefix)) this.requestOwners.delete(key);
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
            capabilities: { experimentalApi: true },
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
      await this.registerEnvironmentExtraSkillRoots(runtime);
    })().catch((error) => {
      this.initializing.delete(key);
      throw error;
    });
    this.initializing.set(key, initialize);
    return initialize;
  }

  private async registerEnvironmentExtraSkillRoots(
    runtime: StoredEnvironmentRuntime,
  ) {
    const response = await this.requestCodex(
      runtime.id,
      runtime,
      {
        method: "skills/extraRoots/set",
        id: rpcId("skills-extra-roots", runtime.id),
        params: {
          extraRoots: [...CODEX_ENVIRONMENT_EXTRA_SKILL_ROOTS],
        },
      },
      undefined,
      undefined,
      false,
    );
    if (!response.error) return;
    if (isMethodNotFoundError(response.error)) {
      this.logger.warn(
        {
          environmentId: runtime.id,
          error: rpcErrorMessage(response.error),
        },
        "Codex does not support runtime extra skill roots",
      );
      return;
    }
    throw new HttpError(
      502,
      "codex_skill_roots_registration_failed",
      `Codex could not register compatibility skill roots. ${rpcErrorMessage(response.error)}`,
    );
  }

  private async requireNativeSessionRuntime(userId: string, sessionId: string) {
    const runtime = await this.store.getSessionRuntime(userId, sessionId);
    if (
      runtime.runtimeErrorCode === WORKSPACE_RESTORE_UNAVAILABLE_SESSION_ERROR
    ) {
      throw new HttpError(
        409,
        "codex_session_unavailable_after_workspace_restore",
        "This Session was created after the restored Workspace backup, so its native harness state is unavailable.",
      );
    }
    if (!runtime.nativeSessionId) {
      throw new HttpError(
        409,
        "codex_thread_not_ready",
        "Codex native Session is not ready.",
      );
    }
    return runtime as StoredSessionRuntime & { nativeSessionId: string };
  }

  private async requireIdleNativeSessionRuntime(
    userId: string,
    sessionId: string,
    operation: string,
  ) {
    const runtime = await this.requireNativeSessionRuntime(userId, sessionId);
    if (
      runtime.sessionStatus === "running" ||
      runtime.activeNativeTurnId ||
      runtime.pendingTurnPhase
    ) {
      throw new HttpError(
        409,
        `codex_${operation}_not_ready`,
        `Wait for the current Codex Turn to finish before starting ${operation}.`,
      );
    }
    return runtime;
  }

  private async requestNativeSessionRpc(input: {
    userId: string;
    sessionId: string;
    method: string;
    requestKind: string;
    params?: Record<string, unknown>;
    requireIdleOperation?: string;
  }) {
    const sessionRuntime = input.requireIdleOperation
      ? await this.requireIdleNativeSessionRuntime(
          input.userId,
          input.sessionId,
          input.requireIdleOperation,
        )
      : await this.requireNativeSessionRuntime(
          input.userId,
          input.sessionId,
        );
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
          method: input.method,
          id: rpcId(input.requestKind, input.sessionId),
          params: {
            ...input.params,
            threadId: sessionRuntime.nativeSessionId,
          },
        },
        input.sessionId,
      );
      this.ensureEnvironmentWorker(sessionRuntime.environmentId);
      return response;
    } finally {
      releaseInteractiveOperation();
    }
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
        ...threadConfiguration({
          modelId: session.modelId,
          reasoningEffort: session.reasoningEffort,
        }),
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

  /**
   * A native Thread is durable before app-server answers thread/start or
   * thread/fork. The Sandpi Session id is carried in ThreadSource so a lost
   * response can be reconciled without replaying either creation mutation.
   */
  private async findNativeThreadByCreationSource(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
    ownerSessionId: string,
    threadSource: string,
  ) {
    let currentRuntime = runtime;
    let cursor: string | undefined;
    let scanned = 0;
    const cursors = new Set<string>();
    const matches = new Map<string, CodexThread>();
    do {
      const submitted = await this.requestCodexWithRuntime(
        environmentId,
        currentRuntime,
        {
          method: "thread/list",
          id: rpcId("thread-creation-reconcile", ownerSessionId),
          params: {
            limit: CODEX_THREAD_CREATION_PAGE_LIMIT,
            sortKey: "created_at",
            sortDirection: "desc",
            ...(cursor ? { cursor } : {}),
          },
        },
        ownerSessionId,
      );
      currentRuntime = submitted.runtime;
      if (submitted.response.error) {
        throw new HttpError(
          502,
          "codex_thread_creation_reconcile_failed",
          rpcErrorMessage(submitted.response.error),
        );
      }
      const page = threadListPage(
        submitted.response.result,
        "codex_thread_creation_reconcile_failed",
        "Codex returned an invalid Thread list while reconciling Session creation.",
      );
      scanned += page.data.length;
      for (const thread of page.data) {
        if (
          objectString(objectRecord(thread), "threadSource") === threadSource
        ) {
          matches.set(thread.id, thread);
        }
      }
      if (matches.size > 1) {
        throw new HttpError(
          502,
          "codex_thread_creation_ambiguous",
          "Multiple native Threads claim the same Sandpi Session creation key.",
        );
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) {
        throw new HttpError(
          502,
          "codex_thread_creation_reconcile_failed",
          "Codex repeated a Thread cursor while reconciling Session creation.",
        );
      }
      if (cursor) cursors.add(cursor);
      if (cursor && scanned >= MAX_CODEX_THREAD_CREATION_LOOKUP) {
        throw new HttpError(
          502,
          "codex_thread_creation_reconcile_failed",
          "Codex returned too many Threads to safely reconcile Session creation.",
        );
      }
    } while (cursor && matches.size === 0);

    return {
      nativeSessionId: matches.keys().next().value as string | undefined,
      runtime: currentRuntime,
    };
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
            await this.options.runtimeQuotaGate?.assertEnvironmentRuntimeAllowed(
              environmentId,
            );
            if (
              current.desiredState !== "running" ||
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
    options: { includeFailed?: boolean } = {},
  ) {
    for (const sessionId of await this.store.sessionIdsForEnvironment(
      environmentId,
      options,
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
      let stored: StoredEnvironmentRuntime | undefined;
      let stream:
        Awaited<ReturnType<RuntimeAdapter["watchCodexEvents"]>> | undefined;
      try {
        stored = await this.store.environmentRuntime(environmentId);
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
        const rewindLatest = rewoundEventCursorLatest(error);
        if (
          stored &&
          rewindLatest !== undefined &&
          rewindLatest < stored.decoder.supervisorCursor
        ) {
          const previousCursor = stored.decoder.supervisorCursor;
          await this.store.resetEnvironmentDecoder(
            environmentId,
            previousCursor,
            rewindLatest,
          );
          this.resetEnvironmentProtocolState(environmentId);
          await this.invalidateEnvironmentSessions(
            environmentId,
            "supervisor-journal-rewound",
            "The Supervisor journal restarted behind Sandpi's cursor; reload the native Session snapshot.",
          );
          this.logger.warn(
            { environmentId, previousCursor, latestCursor: rewindLatest },
            "Codex Environment Supervisor journal rewound; decoder reset",
          );
          consecutiveFailures = 0;
          continue;
        }
        const earliest = expiredEventCursorEarliest(error);
        if (stored && earliest !== undefined) {
          await this.store.resetEnvironmentDecoder(
            environmentId,
            stored.decoder.supervisorCursor,
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
  environmentId: string,
  activeInlineReviews: Map<string, string>,
): CodexControlTransition[] {
  const transitions: CodexControlTransition[] = [];
  for (const record of records) {
    const method = record.message.method;
    const params = objectRecord(record.message.params);
    const nativeSessionId = objectString(params, "threadId");
    if (!nativeSessionId) continue;
    const reviewKey = inlineReviewKey(environmentId, nativeSessionId);

    if (method === "item/started") {
      const item = objectRecord(params?.item);
      const nativeTurnId = objectString(params, "turnId");
      if (
        nativeTurnId &&
        objectString(item, "type") === "enteredReviewMode"
      ) {
        activeInlineReviews.set(reviewKey, nativeTurnId);
        transitions.push({
          type: "turnStarted",
          nativeSessionId,
          nativeTurnId,
          startedAt: new Date(record.receivedAt),
        });
      }
      continue;
    }

    if (method === "thread/status/changed") {
      const status = objectString(objectRecord(params?.status), "type");
      if (
        status === "idle" ||
        status === "notLoaded" ||
        status === "systemError"
      ) {
        activeInlineReviews.delete(reviewKey);
      }
      continue;
    }
    if (method !== "turn/started" && method !== "turn/completed") continue;

    const turn = objectRecord(params?.turn);
    const nativeTurnId = objectString(turn, "id");
    if (!nativeTurnId) continue;
    const activeReviewTurnId = activeInlineReviews.get(reviewKey);
    if (activeReviewTurnId && activeReviewTurnId !== nativeTurnId) {
      continue;
    }
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
      if (activeReviewTurnId === nativeTurnId) {
        activeInlineReviews.delete(reviewKey);
      }
    }
  }
  return transitions;
}

function inlineReviewKey(environmentId: string, nativeSessionId: string) {
  return `${environmentId}\0${nativeSessionId}`;
}

function rememberActiveInlineReview(
  activeInlineReviews: Map<string, string>,
  environmentId: string,
  thread: CodexThread,
) {
  const key = inlineReviewKey(environmentId, thread.id);
  const activeReview = visibleCodexTurns(thread.turns).findLast(
    (turn) =>
      turn.status === "inProgress" &&
      enteredReviewModeItem(turn) !== undefined,
  );
  if (activeReview) {
    activeInlineReviews.set(key, activeReview.id);
  } else if (
    thread.status.type === "idle" ||
    thread.status.type === "notLoaded" ||
    thread.status.type === "systemError"
  ) {
    activeInlineReviews.delete(key);
  }
}

function isSuccessfulMcpOAuthLoginNotification(record: DecodedCodexRecord) {
  if (record.message.method !== "mcpServer/oauthLogin/completed") return false;
  return objectBoolean(objectRecord(record.message.params), "success") === true;
}

function isSessionNotification(
  message: Record<string, unknown>,
): message is Record<string, unknown> & CodexServerNotification {
  return (
    typeof message.method === "string" &&
    SESSION_NOTIFICATION_METHODS.has(message.method)
  );
}

function notificationThreadId(message: Record<string, unknown>) {
  const params = objectRecord(message.params);
  return (
    objectString(params, "threadId") ??
    objectString(objectRecord(params?.thread), "id")
  );
}

function nativeCollaborationMode(
  mode: "plan" | undefined,
  modelId?: string,
  reasoningEffort?: string,
) {
  if (!mode) return {};
  if (!modelId) {
    throw new HttpError(
      400,
      "codex_collaboration_mode_model_required",
      "Codex Plan mode requires a model selected from the live model catalog.",
    );
  }
  return {
    collaborationMode: {
      mode,
      settings: {
        model: modelId,
        reasoning_effort: reasoningEffort ?? null,
        developer_instructions: null,
      },
    },
  };
}

function threadConfiguration(input: {
  modelId?: string;
  reasoningEffort?: string;
  collaborationMode?: "plan";
  serviceTier?: string;
}) {
  return {
    ...(input.modelId ? { model: input.modelId } : {}),
    config: {
      [CODEX_APPLY_PATCH_STREAMING_CONFIG]: true,
      [CODEX_REQUEST_USER_INPUT_CONFIG]: false,
      ...(input.reasoningEffort
        ? { model_reasoning_effort: input.reasoningEffort }
        : {}),
    },
    ...nativeCollaborationMode(
      input.collaborationMode,
      input.modelId,
      input.reasoningEffort,
    ),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    cwd: CODEX_ENVIRONMENT_CWD,
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
  return threadFromValue(objectRecord(response.result)?.thread);
}

function threadFromValue(value: unknown) {
  const thread = objectRecord(value);
  if (
    !thread ||
    typeof thread.id !== "string" ||
    !Array.isArray(thread.turns)
  ) {
    return undefined;
  }
  return thread as unknown as CodexThread;
}

function threadListPage(
  result: unknown,
  errorCode = "codex_agent_threads_list_failed",
  errorMessage = "Codex returned an invalid Agent Thread list.",
) {
  const page = objectRecord(result);
  if (!page || !Array.isArray(page.data)) {
    throw invalidCodexResponse(errorCode, errorMessage);
  }
  const data = page.data.map(threadFromValue);
  if (data.some((thread) => !thread)) {
    throw invalidCodexResponse(errorCode, errorMessage);
  }
  const nextCursor = page.nextCursor;
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    typeof nextCursor !== "string"
  ) {
    throw invalidCodexResponse(errorCode, errorMessage);
  }
  return {
    data: data as CodexThread[],
    nextCursor:
      typeof nextCursor === "string" && nextCursor ? nextCursor : undefined,
  };
}

function isUnmaterializedNativeThreadError(error: unknown) {
  const message = rpcErrorMessage(error).toLowerCase();
  return (
    message.includes("not materialized yet") &&
    message.includes("before first user message")
  );
}

function turnIdFromRpcResponse(response: Record<string, unknown>) {
  return objectString(objectRecord(objectRecord(response.result)?.turn), "id");
}

function steeredTurnIdFromRpcResponse(response: Record<string, unknown>) {
  return objectString(objectRecord(response.result), "turnId");
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

function requireEffectiveConfigWrite(
  response: Record<string, unknown>,
  code: string,
  message: string,
) {
  const result = requireSafeRpcResult(response, code, message);
  const status = objectString(result, "status");
  if (status === "ok") return result;
  if (status === "okOverridden") {
    throw new HttpError(
      409,
      "codex_config_overridden",
      "A higher-priority Codex configuration layer overrides this setting.",
    );
  }
  throw invalidCodexResponse(
    code,
    "Codex returned an invalid configuration write result.",
  );
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

  const resetCredits = codexRateLimitResetCredits(
    result.rateLimitResetCredits,
  );
  return {
    limits: limits.slice(0, MAX_CODEX_RATE_LIMIT_BUCKETS),
    ...(resetCredits ? { resetCredits } : {}),
    fetchedAt: toUnixTimestamp(new Date()),
  };
}

function codexRateLimitResetCredits(value: unknown) {
  const credits = objectRecord(value);
  const availableCount = normalizedNonNegativeInteger(
    credits?.availableCount,
    MAX_CODEX_RATE_LIMIT_RESET_CREDITS,
  );
  return availableCount === undefined ? undefined : { availableCount };
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

function normalizedNonNegativeInteger(value: unknown, maximum: number) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? value
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

function requireCodexSkillName(value: string) {
  const name = value.trim();
  if (!CODEX_SKILL_NAME.test(name)) {
    throw new HttpError(
      400,
      "invalid_codex_skill_name",
      "Skill names may contain letters, numbers, hyphens and underscores.",
    );
  }
  return name;
}

function requireCodexSkillFiles(files: CodexSkillFileInput[]) {
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    const normalized = path.posix.normalize(file.path);
    if (
      normalized !== file.path ||
      normalized.startsWith("/") ||
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      file.path.includes("\\")
    ) {
      throw new HttpError(
        400,
        "invalid_codex_skill_file_path",
        "Skill files must use normalized relative POSIX paths.",
      );
    }
    if (paths.has(normalized)) {
      throw new HttpError(
        400,
        "duplicate_codex_skill_file",
        "Skill file paths must be unique.",
      );
    }
    paths.add(normalized);
    if (file.content.byteLength > MAX_CODEX_SKILL_FILE_BYTES) {
      throw new HttpError(
        413,
        "codex_skill_file_too_large",
        "A skill file may contain at most 5 MiB.",
      );
    }
    totalBytes += file.content.byteLength;
  }
  if (!paths.has("SKILL.md")) {
    throw new HttpError(
      400,
      "codex_skill_manifest_missing",
      "A skill must include SKILL.md.",
    );
  }
  if (totalBytes > MAX_CODEX_SKILL_BYTES) {
    throw new HttpError(
      413,
      "codex_skill_too_large",
      "A skill may contain at most 10 MiB of files.",
    );
  }
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

function codexMcpServerDefinition(
  configuration: CodexMcpServerConfiguration,
): Record<string, unknown> {
  const shared = {
    enabled: configuration.enabled,
    required: configuration.required,
    ...(configuration.startupTimeoutSec !== undefined
      ? { startup_timeout_sec: configuration.startupTimeoutSec }
      : {}),
    ...(configuration.toolTimeoutSec !== undefined
      ? { tool_timeout_sec: configuration.toolTimeoutSec }
      : {}),
    ...(configuration.enabledTools
      ? { enabled_tools: configuration.enabledTools }
      : {}),
    ...(configuration.disabledTools
      ? { disabled_tools: configuration.disabledTools }
      : {}),
    ...(configuration.defaultToolsApprovalMode
      ? {
          default_tools_approval_mode:
            configuration.defaultToolsApprovalMode,
        }
      : {}),
  };
  if (configuration.transport === "stdio") {
    return {
      command: configuration.command,
      args: configuration.args,
      ...(configuration.cwd ? { cwd: configuration.cwd } : {}),
      ...(configuration.envVars ? { env_vars: configuration.envVars } : {}),
      ...shared,
    };
  }
  return {
    url: configuration.url,
    ...(configuration.auth ? { auth: configuration.auth } : {}),
    ...(configuration.oauthResource
      ? { oauth_resource: configuration.oauthResource }
      : {}),
    ...(configuration.scopes ? { scopes: configuration.scopes } : {}),
    ...shared,
  };
}

function mcpOAuthCallbackUrl(publicUrl: string) {
  let published: URL;
  try {
    published = new URL(publicUrl);
  } catch {
    throw invalidMcpOAuthCallbackUrl();
  }
  if (
    published.protocol !== "https:" ||
    published.username ||
    published.password ||
    published.search ||
    published.hash ||
    (published.pathname !== "/" && published.pathname !== "")
  ) {
    throw invalidMcpOAuthCallbackUrl();
  }
  return new URL(
    `${CODEX_MCP_OAUTH_CALLBACK_BASE_PATH}/`,
    published.origin,
  ).toString();
}

function invalidMcpOAuthCallbackUrl() {
  return new HttpError(
    502,
    "sandbox0_mcp_oauth_callback_url_invalid",
    "Sandbox0 returned an unsafe MCP OAuth callback URL.",
  );
}

function safeMcpOAuthAuthorizationUrl(value: string | undefined) {
  let authorizationUrl: URL;
  try {
    authorizationUrl = new URL(value ?? "");
  } catch {
    throw invalidMcpOAuthAuthorizationUrl();
  }
  if (
    authorizationUrl.protocol !== "https:" ||
    authorizationUrl.username ||
    authorizationUrl.password
  ) {
    throw invalidMcpOAuthAuthorizationUrl();
  }
  return authorizationUrl.toString();
}

function invalidMcpOAuthAuthorizationUrl() {
  return invalidCodexResponse(
    "codex_mcp_oauth_login_failed",
    "Codex returned an invalid MCP OAuth authorization URL.",
  );
}

function mcpTransport(
  definition: Record<string, unknown>,
): CodexMcpTransport | undefined {
  if (typeof definition.command === "string") return "stdio";
  if (typeof definition.url === "string") return "streamable-http";
  return undefined;
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
  return {
    name,
    transport,
    command: objectString(definition, "command"),
    args: objectStringArray(definition.args),
    url: objectString(definition, "url"),
    enabled,
    managed,
    runtimeStatus,
    serverTitle:
      objectString(serverInfo, "title") ?? objectString(serverInfo, "name"),
    authStatus,
    tools: tools ? Object.keys(tools).sort() : [],
    resources: resources.flatMap((value) => {
      const resource = objectRecord(value);
      const name = objectString(resource, "name");
      const uri = objectString(resource, "uri");
      if (!name || !uri) return [];
      return [
        {
          name,
          ...(objectString(resource, "title")
            ? { title: objectString(resource, "title") }
            : {}),
          uri,
        },
      ];
    }),
    resourceTemplates: resourceTemplates.flatMap((value) => {
      const template = objectRecord(value);
      const name = objectString(template, "name");
      const uriTemplate = objectString(template, "uriTemplate");
      if (!name || !uriTemplate) return [];
      return [
        {
          name,
          ...(objectString(template, "title")
            ? { title: objectString(template, "title") }
            : {}),
          uriTemplate,
        },
      ];
    }),
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

function codexMemoriesSettings(
  config: Record<string, unknown>,
): CodexMemoriesSettings {
  const features = objectRecord(config.features);
  const memories = objectRecord(config.memories);
  const featureEnabled = objectBoolean(features, "memories") === true;
  if (!featureEnabled) {
    return codexMemoriesFeatureToggleSettings(false);
  }
  return {
    featureEnabled,
    useMemories: objectBoolean(memories, "use_memories") === true,
    generateMemories:
      objectBoolean(memories, "generate_memories") === true,
  };
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

function isMethodNotFoundError(error: unknown) {
  return objectRecord(error)?.code === -32_601;
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

function supervisorFailureRequiringRecovery(
  events: readonly SupervisorOutputEvent[],
  runtime: StoredEnvironmentRuntime,
) {
  let cleanExit:
    | {
        attemptId?: string;
        reason?: string;
      }
    | undefined;
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.runtimeGeneration !== runtime.runtimeGeneration) continue;
    if (event.type === "session.failed") {
      return new HttpError(
        503,
        "supervisor_not_running",
        `The Codex Supervisor exhausted its restart policy${
          event.reason ? `: ${event.reason}` : "."
        }`,
      );
    }
    if (
      event.type === "attempt.exited" &&
      event.exitCode === 0 &&
      event.attemptId === runtime.attemptId &&
      !isIntentionalSupervisorExit(event.reason)
    ) {
      cleanExit = { attemptId: event.attemptId, reason: event.reason };
      continue;
    }
    if (
      cleanExit &&
      (event.type === "session.backoff" ||
        (event.type === "attempt.started" &&
          event.attemptId !== cleanExit.attemptId))
    ) {
      cleanExit = undefined;
    }
  }
  if (!cleanExit) return undefined;
  return new HttpError(
    503,
    "supervisor_not_running",
    `The Codex process exited without a replacement attempt${
      cleanExit.reason ? `: ${cleanExit.reason}` : "."
    }`,
  );
}

function isIntentionalSupervisorExit(reason: string | undefined) {
  return (
    reason === "attempt_replaced" ||
    reason === "desired_state_stopped" ||
    reason === "session_deleted"
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
  if (isPreInputRuntimeEpochError(error)) return true;
  if (!(error instanceof HttpError)) return false;
  if (error.code === "codex_runtime_epoch_lost_after_submit") return true;
  // The runtime adapter already gives a definitive Sandbox0 resume failure
  // one bounded retry. Do not turn exhaustion into the recovery loop's
  // 130-second retry window.
  if (error.code === "sandbox0_resume_failed") return false;
  if (!error.code.startsWith("sandbox0_")) return false;
  // A missing Supervisor can be recreated from the Environment Workspace, but
  // a missing Sandbox is an ownership boundary: do not turn external resource
  // deletion into an implicit allocation or a 130-second inner retry loop.
  return (
    error.statusCode === 409 ||
    error.statusCode === 503 ||
    error.code === "sandbox0_session_not_found"
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

function sessionCreationRequestFingerprint(input: CreateSessionInput) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.environment.id,
        input.title,
        input.prompt,
        input.images,
        input.localImages ?? [],
        input.modelId ?? null,
        input.reasoningEffort ?? null,
        input.collaborationMode ?? null,
        input.serviceTier ?? null,
      ]),
    )
    .digest("hex");
}

function sessionCreationFailure(error: unknown) {
  return error instanceof HttpError
    ? error
    : new HttpError(500, "internal_error", "Internal server error.");
}

function waitForSessionCreationPoll() {
  return new Promise<void>((resolve) =>
    setTimeout(resolve, SESSION_CREATION_IDEMPOTENCY_POLL_MS),
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

function sessionRuntimeHasSubmission(
  runtime: StoredSessionRuntime,
  submission: TurnSubmissionCoordinates,
) {
  return (
    runtime.pendingTurnRequestId === submission.requestId &&
    runtime.pendingTurnClientMessageId === submission.clientMessageId &&
    runtime.pendingTurnStableInputId === submission.stableInputId &&
    runtime.pendingTurnPhase !== undefined
  );
}

function runtimeRecoveryTurnSubmissionCoordinates(
  sessionId: string,
  sourceNativeTurnId: string,
) {
  return turnSubmissionCoordinates(
    sessionId,
    `${runtimeRecoveryClientMessagePrefix(
      sessionId,
      sourceNativeTurnId,
    )}${randomUUID()}`,
  );
}

function runtimeRecoveryClientMessagePrefix(
  sessionId: string,
  sourceNativeTurnId: string,
) {
  return `${CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX}${encodeURIComponent(
    sessionId,
  )}:${encodeURIComponent(sourceNativeTurnId)}:`;
}

function nativeRuntimeRecoveryTurn(
  thread: CodexThread,
  sessionId: string,
  sourceNativeTurnId: string,
) {
  const prefix = runtimeRecoveryClientMessagePrefix(
    sessionId,
    sourceNativeTurnId,
  );
  return visibleCodexTurns(thread.turns).findLast((turn) =>
    turn.items.some(
      (item) =>
        item.type === "userMessage" && item.clientId?.startsWith(prefix),
    ),
  );
}

interface NativeTurnProjection {
  turn: CodexThread["turns"][number];
  matchedBy: "activeTurn" | "pendingTurn" | "clientMessage";
}

function nativeTurnForSessionProjection(
  thread: CodexThread,
  session: StoredSessionRuntime,
): NativeTurnProjection | undefined {
  const visibleTurns = visibleCodexTurns(thread.turns);
  if (session.activeNativeTurnId) {
    const turn = visibleTurns.find(
      (candidate) => candidate.id === session.activeNativeTurnId,
    );
    if (turn) return { turn, matchedBy: "activeTurn" };
  }
  if (session.pendingTurnNativeTurnId) {
    const turn = visibleTurns.find(
      (candidate) => candidate.id === session.pendingTurnNativeTurnId,
    );
    if (turn) return { turn, matchedBy: "pendingTurn" };
  }
  if (session.pendingTurnClientMessageId) {
    const turn = nativeTurnForClientMessage(
      thread,
      session.pendingTurnClientMessageId,
    );
    if (turn) return { turn, matchedBy: "clientMessage" };
  }
  return undefined;
}

function stabilizeAcceptedTurnStartSnapshot(
  thread: CodexThread,
  session: StoredSessionRuntime,
  runtime: StoredEnvironmentRuntime,
): CodexThread {
  const projection = nativeTurnForSessionProjection(thread, session);
  const pendingStartedAt = session.pendingTurnStartedAt?.getTime();
  const pendingAgeMs =
    pendingStartedAt === undefined ? undefined : Date.now() - pendingStartedAt;
  if (
    thread.status.type !== "idle" ||
    projection?.turn.status !== "interrupted" ||
    projection.turn.error !== null ||
    session.pendingTurnPhase !== "accepted" ||
    session.activeNativeTurnId !== projection.turn.id ||
    session.pendingTurnNativeTurnId !== projection.turn.id ||
    session.interruptRequestedNativeTurnId === projection.turn.id ||
    session.recoverySourceNativeTurnId !== undefined ||
    runtime.attemptId === undefined ||
    session.activeTurnAttemptId !== runtime.attemptId ||
    session.activeTurnRuntimeGeneration !== runtime.runtimeGeneration ||
    session.pendingTurnAttemptId !== runtime.attemptId ||
    session.pendingTurnRuntimeGeneration !== runtime.runtimeGeneration ||
    pendingAgeMs === undefined ||
    !Number.isFinite(pendingAgeMs) ||
    pendingAgeMs < 0 ||
    pendingAgeMs > ACCEPTED_TURN_SNAPSHOT_RACE_GRACE_MS
  ) {
    return thread;
  }

  // turn/start can be accepted just before thread/read returns the previous
  // idle/interrupted view. Keep the accepted Turn active until native start or
  // completion events replace that short-lived snapshot.
  return {
    ...thread,
    status: { type: "active", activeFlags: [] },
    turns: thread.turns.map((turn) =>
      turn.id === projection.turn.id
        ? {
            ...turn,
            status: "inProgress",
            error: null,
            completedAt: null,
            durationMs: null,
          }
        : turn,
    ),
  };
}

function nativeTurnForClientMessage(
  thread: CodexThread,
  clientMessageId: string,
) {
  return visibleCodexTurns(thread.turns).find((turn) =>
    turn.items.some(
      (item) =>
        item.type === "userMessage" && item.clientId === clientMessageId,
    ),
  );
}

function latestInProgressNativeTurn(thread: CodexThread) {
  return visibleCodexTurns(thread.turns).findLast(
    (turn) => turn.status === "inProgress",
  );
}

function nativeTurnBelongsToReplacedRuntime(
  session: StoredSessionRuntime,
  projection: NativeTurnProjection,
  runtime: StoredEnvironmentRuntime,
) {
  const coordinates =
    projection.matchedBy === "activeTurn"
      ? {
          attemptId: session.activeTurnAttemptId,
          runtimeGeneration: session.activeTurnRuntimeGeneration,
        }
      : {
          attemptId: session.pendingTurnAttemptId,
          runtimeGeneration: session.pendingTurnRuntimeGeneration,
        };
  return (
    coordinates.attemptId === undefined ||
    coordinates.runtimeGeneration === undefined ||
    coordinates.attemptId !== runtime.attemptId ||
    coordinates.runtimeGeneration !== runtime.runtimeGeneration
  );
}

function automationTurnNeedsRuntimeRecovery(
  session: StoredSessionRuntime,
  turn: CodexTurn,
  clientMessageId: string,
  runtime: StoredEnvironmentRuntime,
) {
  if (
    session.interruptRequestedNativeTurnId === turn.id ||
    session.recoveryAttemptCount >= AUTOMATIC_TURN_RECOVERY_MAX_ATTEMPTS
  ) {
    return false;
  }
  const projection: NativeTurnProjection | undefined =
    session.activeNativeTurnId === turn.id
      ? { turn, matchedBy: "activeTurn" }
      : session.pendingTurnNativeTurnId === turn.id
        ? { turn, matchedBy: "pendingTurn" }
        : session.pendingTurnClientMessageId === clientMessageId
          ? { turn, matchedBy: "clientMessage" }
          : undefined;
  return Boolean(
    projection &&
      nativeTurnBelongsToReplacedRuntime(session, projection, runtime),
  );
}

function nativeTurnTargetBelongsToReplacedRuntime(
  session: StoredSessionRuntime,
  nativeTurnId: string,
  runtime: StoredEnvironmentRuntime,
) {
  if (
    nativeTurnId === session.recoverySourceNativeTurnId &&
    nativeTurnId !== session.activeNativeTurnId &&
    nativeTurnId !== session.pendingTurnNativeTurnId
  ) {
    return true;
  }
  const coordinates =
    nativeTurnId === session.activeNativeTurnId
      ? {
          attemptId: session.activeTurnAttemptId,
          runtimeGeneration: session.activeTurnRuntimeGeneration,
        }
      : nativeTurnId === session.pendingTurnNativeTurnId
        ? {
            attemptId: session.pendingTurnAttemptId,
            runtimeGeneration: session.pendingTurnRuntimeGeneration,
          }
        : undefined;
  if (
    !coordinates ||
    (coordinates.attemptId === undefined &&
      coordinates.runtimeGeneration === undefined)
  ) {
    return false;
  }
  return (
    coordinates.attemptId !== runtime.attemptId ||
    coordinates.runtimeGeneration !== runtime.runtimeGeneration
  );
}

function rpcId(kind: string, sessionId: string) {
  return `${kind}:${sessionId}:${randomUUID()}`;
}

function nativeThreadCreationSource(sessionId: string) {
  return `${CODEX_THREAD_CREATION_SOURCE_PREFIX}${sessionId}`;
}

function nativeThreadCreationStableInputId(sessionId: string) {
  return `thread-creation:${sessionId}`;
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

function nativeSnapshotReadKey(
  session: StoredSessionRuntime & { nativeSessionId: string },
  runtime: StoredEnvironmentRuntime,
) {
  return [
    session.nativeSessionId,
    session.historyRevision,
    session.version,
    environmentRuntimeEpoch(runtime),
  ].join("\0");
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

function rewoundEventCursorLatest(error: unknown) {
  if (
    !(error instanceof HttpError) ||
    !error.code.startsWith("sandbox0_")
  ) {
    return undefined;
  }
  const match = error.message.match(
    /event cursor must not be greater than latest sequence (\d+)/i,
  );
  if (!match) return undefined;
  const latest = Number(match[1]);
  return Number.isSafeInteger(latest) && latest >= 0 ? latest : undefined;
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

function waitForSharedSnapshot<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  const abortReason = () =>
    signal.reason ??
    new DOMException("Codex snapshot request cancelled", "AbortError");
  if (signal.aborted) return Promise.reject(abortReason());
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortReason());
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
