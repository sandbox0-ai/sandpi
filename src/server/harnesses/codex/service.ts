import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  CODEX_TRANSCRIPT_NOTIFICATION_METHODS,
  type CodexEventEnvelope,
  type CodexNativeSnapshot,
  type CodexServerNotification,
  type CodexThread,
} from "@/harnesses/codex/types";
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

const INGEST_INTERVAL_MS = 400;
const RPC_INGEST_INTERVAL_MS = 80;
const RPC_TIMEOUT_MS = 30_000;
const MAX_RPC_RESPONSES_PER_ENVIRONMENT = 512;
const MAX_LIVE_NOTIFICATIONS_PER_SESSION = 1_000;
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
}

/**
 * Codex app-server is Environment-scoped and natively owns many Threads.
 * Sandpi persists only native ids and control coordinates; it never projects a
 * second conversation history into PostgreSQL.
 */
export class CodexService {
  private readonly workers = new Map<string, AbortController>();
  private readonly workerTasks = new Map<string, Promise<void>>();
  private readonly ingesting = new Map<
    string,
    Promise<DecodedCodexRecord[]>
  >();
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
  private readonly rpcPumps = new Map<string, Promise<void>>();
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
    private readonly options: { ingestIntervalMs?: number } = {},
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
    const environmentRuntime = await this.environmentRuntimeForSession(
      input.userId,
      input.sessionId,
    );
    const submission = turnSubmissionCoordinates(input.sessionId);
    await this.store.beginSessionTurn(
      input.userId,
      input.sessionId,
      input.modelId,
      submission,
    );
    try {
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

  async editTurn(input: {
    userId: string;
    sessionId: string;
    nativeTurnId: string;
    text: string;
    images: EncodedCodexInputImage[];
    modelId?: string;
  }) {
    return this.mutateNativeHistory({ ...input, kind: "edit" });
  }

  async deleteTurn(
    userId: string,
    sessionId: string,
    nativeTurnId: string,
  ) {
    return this.mutateNativeHistory({
      userId,
      sessionId,
      nativeTurnId,
      kind: "delete",
      text: "",
      images: [],
    });
  }

  private async mutateNativeHistory(input: {
    userId: string;
    sessionId: string;
    nativeTurnId: string;
    kind: "edit" | "delete";
    text: string;
    images: EncodedCodexInputImage[];
    modelId?: string;
  }) {
    const session = await this.store.getSession(input.userId, input.sessionId);
    const source = await this.requireNativeSessionRuntime(
      input.userId,
      input.sessionId,
    );
    if (session.status !== "waiting" || source.activeNativeTurnId) {
      throw new HttpError(
        409,
        "turn_mutation_not_ready",
        "Wait for the current Codex Turn to finish.",
      );
    }
    const environmentRuntime = await this.environmentRuntimeForSession(
      input.userId,
      input.sessionId,
    );
    const thread = await this.readNativeThread(
      environmentRuntime,
      source,
      input.sessionId,
    );
    const selectedIndex = thread.turns.findIndex(
      (turn) => turn.id === input.nativeTurnId,
    );
    if (selectedIndex < 0 || thread.turns[selectedIndex]?.status === "inProgress") {
      throw new HttpError(
        409,
        "turn_mutation_not_ready",
        "The selected native Turn cannot be changed.",
      );
    }
    const predecessor = thread.turns[selectedIndex - 1];
    const branchResponse = await this.requestCodex(
      source.environmentId,
      environmentRuntime,
      predecessor
        ? {
            method: "thread/fork",
            id: rpcId("history-fork", input.sessionId),
            params: {
              threadId: source.nativeSessionId,
              lastTurnId: predecessor.id,
              ...threadConfiguration(input.modelId ?? source.modelId),
            },
          }
        : {
            method: "thread/start",
            id: rpcId("history-start", input.sessionId),
            params: threadConfiguration(input.modelId ?? source.modelId),
          },
      input.sessionId,
    );
    if (branchResponse.error) {
      throw new HttpError(
        502,
        "codex_history_branch_failed",
        rpcErrorMessage(branchResponse.error),
      );
    }
    const candidateNativeSessionId = threadIdFromRpcResponse(branchResponse);
    if (!candidateNativeSessionId) {
      throw new HttpError(
        502,
        "codex_history_branch_failed",
        "Codex did not return the candidate native Session.",
      );
    }

    let candidateNativeTurnId: string | undefined;
    if (input.kind === "edit") {
      const replacement = await this.requestCodex(
        source.environmentId,
        environmentRuntime,
        {
          method: "turn/start",
          id: rpcId("history-replacement", input.sessionId),
          params: {
            threadId: candidateNativeSessionId,
            clientUserMessageId: `user-message:${randomUUID()}`,
            input: nativeCodexTurnInput(input.text, input.images),
            ...(input.modelId ? { model: input.modelId } : {}),
          },
        },
        input.sessionId,
      );
      if (replacement.error) {
        throw new HttpError(
          502,
          "codex_history_replacement_failed",
          rpcErrorMessage(replacement.error),
        );
      }
      candidateNativeTurnId = turnIdFromRpcResponse(replacement);
      if (!candidateNativeTurnId) {
        throw new HttpError(
          502,
          "codex_history_replacement_failed",
          "Codex did not return the replacement native Turn.",
        );
      }
    }

    const switched = await this.store.commitNativeBranch({
      sessionId: input.sessionId,
      expectedNativeSessionId: source.nativeSessionId,
      expectedHistoryRevision: source.historyRevision,
      candidateNativeSessionId,
      candidateNativeTurnId,
      modelId: input.modelId,
    });
    if (!switched) {
      throw new HttpError(
        409,
        "codex_history_changed",
        "The native Session changed before the history branch was committed.",
      );
    }
    this.forgetNativeOwner(source.environmentId, source.nativeSessionId);
    this.rememberNativeOwner(
      source.environmentId,
      candidateNativeSessionId,
      input.sessionId,
    );
    const candidateThread = await this.readNativeThread(
      environmentRuntime,
      {
        ...source,
        nativeSessionId: candidateNativeSessionId,
        historyRevision: source.historyRevision + 1,
      },
      input.sessionId,
    );
    const activeCandidateTurnId = candidateThread.turns.find(
      (turn) => turn.status === "inProgress",
    )?.id;
    const reconciled = await this.store.reconcileNativeSessionState({
      sessionId: input.sessionId,
      nativeSessionId: candidateNativeSessionId,
      historyRevision: source.historyRevision + 1,
      activeNativeTurnId: activeCandidateTurnId,
    });
    if (!reconciled) {
      throw new HttpError(
        409,
        "codex_history_changed",
        "The native Session changed while its branch state was reconciled.",
      );
    }
    this.publishInvalidation(input.sessionId, "native-history-branched", {
      message:
        "Conversation history changed. The Environment Workspace was intentionally left unchanged.",
    });
    return {
      nativeSessionId: candidateNativeSessionId,
      nativeTurnId: activeCandidateTurnId,
      historyRevision: source.historyRevision + 1,
    };
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
    return (await this.readNativeSnapshotWithCursor(userId, sessionId)).snapshot;
  }

  async readNativeSnapshotWithCursor(
    userId: string,
    sessionId: string,
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
    const latest = await this.store.sessionRuntime(sessionId);
    const branchableTurnIds = thread.turns
      .filter((turn) => turn.status !== "inProgress")
      .map((turn) => turn.id);
    const anchor = this.takeRpcAnchor(
      sessionRuntime.environmentId,
      requestId,
      sessionId,
    );
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
        // Keep the two product capabilities separate even though Codex
        // currently implements both with native branching. No Workspace
        // checkpoint or restore is implied.
        forkableTurnIds: branchableTurnIds,
        mutableTurnIds: branchableTurnIds,
      },
      liveCursor: anchor ?? this.liveCursor(sessionId),
    };
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
    let runtime = await this.store.getEnvironmentRuntime(userId, environmentId);
    if (!runtime.supervisorSessionId) {
      const environment = await this.store.getEnvironment(userId, environmentId);
      runtime = await this.ensureEnvironmentRuntimeForUser(userId, environment);
    }
    try {
      return await operation(runtime);
    } catch (error) {
      if (!isRecoverableRuntimeError(error)) throw error;
      runtime = await this.recoverEnvironmentRuntime(environmentId);
      return operation(runtime);
    }
  }

  ensureWorker(sessionId: string) {
    void this.store
      .sessionRuntime(sessionId)
      .then((session) => this.ensureEnvironmentWorker(session.environmentId))
      .catch(() => undefined);
  }

  private ensureEnvironmentWorker(environmentId: string) {
    if (this.closed || this.workers.has(environmentId)) return;
    const controller = new AbortController();
    this.workers.set(environmentId, controller);
    const task = this.runWorker(environmentId, controller.signal).finally(() => {
      if (this.workers.get(environmentId) === controller) {
        this.workers.delete(environmentId);
      }
      this.workerTasks.delete(environmentId);
    });
    this.workerTasks.set(environmentId, task);
  }

  async ingestOnce(sessionId: string) {
    const session = await this.store.sessionRuntime(sessionId);
    return this.ingestEnvironmentOnce(session.environmentId);
  }

  private async ingestEnvironmentOnce(environmentId: string) {
    const active = this.ingesting.get(environmentId);
    if (active) return active;
    const ingest = this.performIngestOnce(environmentId).finally(() => {
      if (this.ingesting.get(environmentId) === ingest) {
        this.ingesting.delete(environmentId);
      }
    });
    this.ingesting.set(environmentId, ingest);
    return ingest;
  }

  private async performIngestOnce(environmentId: string) {
    const stored = await this.store.environmentRuntime(environmentId);
    if (!stored.supervisorSessionId) return [];
    const page = await this.runtime.listCodexEvents(
      stored,
      stored.decoder.supervisorCursor,
    );
    if (
      page.cursor.earliest > 0 &&
      page.cursor.earliest > stored.decoder.supervisorCursor + 1
    ) {
      await this.store.resetEnvironmentDecoder(
        environmentId,
        page.cursor.earliest - 1,
      );
      await this.invalidateEnvironmentSessions(
        environmentId,
        "supervisor-journal-gap",
        "Live execution events expired; the next reconnect reloads each native Codex Session.",
      );
      return [];
    }
    const events = page.events
      .map(supervisorOutputEvent)
      .filter((event): event is SupervisorOutputEvent => event !== undefined);
    if (events.length === 0) return [];
    const decoded = decodeCodexSupervisorEvents(stored.decoder, events);
    const transitions = controlTransitions(decoded.records);
    const committed = await this.store.commitEnvironmentTransport(
      environmentId,
      stored.supervisorSessionId,
      stored.decoder,
      decoded.state,
      transitions,
    );
    if (!committed) return [];

    for (const record of decoded.records) {
      this.cacheRpcRecord(environmentId, record.message);
      if (!isTranscriptNotification(record.message)) continue;
      const nativeSessionId = notificationThreadId(record.message);
      if (!nativeSessionId) continue;
      const sessionId = await this.ownerForNativeThread(
        environmentId,
        nativeSessionId,
      );
      if (sessionId) this.publishLiveNotification(sessionId, record);
    }
    for (const transition of transitions) {
      if (transition.type !== "turnCompleted") continue;
      const sessionId = await this.ownerForNativeThread(
        environmentId,
        transition.nativeSessionId,
      );
      if (sessionId) this.events.emit(sessionId);
    }
    if (transitions.some((transition) => transition.type === "turnCompleted")) {
      await this.captureEnvironmentCredential(stored);
    }
    if (decoded.invalidRecords.length > 0) {
      this.logger.warn(
        { environmentId, count: decoded.invalidRecords.length },
        "Codex emitted invalid JSONL records",
      );
    }
    return decoded.records;
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
    await Promise.allSettled(this.ingesting.values());
    await Promise.allSettled(this.credentialSyncs.values());
    for (const waiters of this.rpcWaiters.values()) {
      for (const waiter of waiters) waiter.reject(new Error("Codex service closed"));
    }
    await Promise.allSettled(this.rpcPumps.values());
    this.workers.clear();
    this.workerTasks.clear();
    this.rpcWaiters.clear();
    this.rpcPumps.clear();
    this.rpcResponses.clear();
    this.rpcAnchors.clear();
  }

  private async ensureEnvironmentRuntimeForUser(
    userId: string,
    environment: Environment,
  ) {
    const current = await this.store.getEnvironmentRuntime(userId, environment.id);
    if (current.supervisorSessionId && current.attemptId) {
      await this.ensureProtocolInitialized(current);
      return current;
    }
    const credential = await this.credentials.credentialForEnvironment(
      userId,
      environment.id,
    );
    const recovered = await this.runtime.ensureCodexEnvironmentRuntime(
      current,
      credential.authJson,
    );
    const ready = await this.store.recordCodexEnvironmentRuntime(
      environment.id,
      recovered,
    );
    await this.credentials.markCredentialMaterialized(environment.id, credential);
    await this.ensureProtocolInitialized(ready);
    await this.resumeEnvironmentNativeSessions(ready);
    this.ensureEnvironmentWorker(environment.id);
    return ready;
  }

  private async environmentRuntimeForSession(userId: string, sessionId: string) {
    const session = await this.store.getSession(userId, sessionId);
    let environmentRuntime = await this.store.getEnvironmentRuntime(
      userId,
      session.environmentId,
    );
    if (!environmentRuntime.supervisorSessionId || !environmentRuntime.attemptId) {
      const environment = await this.store.getEnvironment(
        userId,
        session.environmentId,
      );
      environmentRuntime = await this.ensureEnvironmentRuntimeForUser(
        userId,
        environment,
      );
    } else {
      await this.ensureProtocolInitialized(environmentRuntime);
    }
    return environmentRuntime;
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
    await this.ensureProtocolInitialized(ready);
    await this.resumeEnvironmentNativeSessions(ready);
    return ready;
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
    this.ensureRpcPump(environmentId, requestId);
    return waiter.promise;
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

  private ensureRpcPump(environmentId: string, requestId: string) {
    const key = rpcKey(environmentId, requestId);
    if (this.rpcPumps.has(key)) return;
    const pump = (async () => {
      while (this.rpcWaiters.has(key)) {
        await this.ingestEnvironmentOnce(environmentId);
        if (this.rpcWaiters.has(key)) await delay(RPC_INGEST_INTERVAL_MS);
      }
    })()
      .catch((error) => {
        for (const waiter of this.rpcWaiters.get(key) ?? []) waiter.reject(error);
      })
      .finally(() => {
        if (this.rpcPumps.get(key) === pump) this.rpcPumps.delete(key);
        if (this.rpcWaiters.has(key)) {
          this.ensureRpcPump(environmentId, requestId);
        }
      });
    this.rpcPumps.set(key, pump);
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
    state.updates.push({ cursor: state.cursor, kind: "notification", event });
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
      try {
        await this.ingestEnvironmentOnce(environmentId);
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        this.logger.warn(
          { environmentId, error: errorMessage(error) },
          "Codex Environment event ingest failed",
        );
        if (isRecoverableRuntimeError(error)) {
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
      }
      const backoff = Math.min(
        30_000,
        (this.options.ingestIntervalMs ?? INGEST_INTERVAL_MS) *
          2 ** Math.min(consecutiveFailures, 6),
      );
      await delay(backoff, signal);
    }
  }
}

function supervisorOutputEvent(value: unknown): SupervisorOutputEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  if (
    typeof event.seq !== "number" ||
    typeof event.runtimeGeneration !== "number" ||
    typeof event.type !== "string" ||
    typeof event.occurredAt !== "string"
  ) {
    return undefined;
  }
  return event as unknown as SupervisorOutputEvent;
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
      transitions.push({
        type: "turnCompleted",
        nativeSessionId,
        nativeTurnId,
        status,
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

function trimMap<K, V>(map: Map<K, V>, maximum: number) {
  while (map.size > maximum) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
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
