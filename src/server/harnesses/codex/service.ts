import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

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
import type { RuntimeAdapter } from "@/server/runtime/types";
import {
  SandpiStore,
  type CodexControlTransition,
  type SessionOperationLock,
  type StoredRuntime,
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

const INGEST_INTERVAL_MS = 500;
const MAX_INGEST_RETRY_MS = 30_000;
const RPC_TIMEOUT_MS = 30_000;
const RESOURCE_REAPER_INTERVAL_MS = 60_000;
const MAX_RPC_RESPONSES_PER_SESSION = 256;
const MAX_LIVE_NOTIFICATIONS_PER_SESSION = 1_000;
const RPC_INGEST_INTERVAL_MS = 100;
const TURN_SUBMISSION_RECOVERY_GRACE_MS = RPC_TIMEOUT_MS + 5_000;

const TRANSCRIPT_NOTIFICATION_METHODS = new Set<string>(
  CODEX_TRANSCRIPT_NOTIFICATION_METHODS,
);

interface ServiceLogger {
  debug(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

type ThreadInitialization =
  | { mode: "start" }
  | {
      mode: "resume";
      canonicalizeInterruptedTurn?: boolean;
      canonicalizeInterruptedTurnId?: string;
    }
  | {
      mode: "fork";
      sourceNativeSessionId: string;
      lastNativeTurnId?: string;
    };

interface RpcWaiter {
  promise: Promise<Record<string, unknown>>;
  resolve(response: Record<string, unknown>): void;
  reject(error: unknown): void;
}

interface RpcTransportBoundary {
  supervisorSessionId: string;
  supervisorSequence: number;
  recordIndex: number;
  attemptId?: string;
  runtimeGeneration: number;
}

interface FencedSessionOperation {
  operationId: string;
  lock: SessionOperationLock;
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

export interface CodexCredentialProvider {
  credentialForEnvironment(
    userId: string,
    environmentId: string,
  ): Promise<CodexCredentialMaterial>;
  credentialForRuntime(sessionId: string): Promise<CodexCredentialMaterial>;
  markCredentialMaterialized(
    sessionId: string,
    credential: CodexCredentialMaterial,
  ): Promise<void>;
  /**
   * Persists a native refresh as a new Environment Credential Source revision.
   * If another Sandbox already advanced the Environment source, returns the
   * authoritative revision that this Sandbox must re-materialize.
   */
  syncCredentialFromRuntime(
    sessionId: string,
    authJson: string,
  ): Promise<CodexCredentialMaterial | undefined>;
}

export interface CodexCredentialMaterial {
  sourceId: string;
  revision: number;
  authJson: string;
}

export interface CodexNativeSnapshotRead {
  snapshot: CodexNativeSnapshot;
  /**
   * Process-local live cursor at the exact JSON-RPC response boundary. Live
   * notifications after this cursor happened after Codex produced snapshot.
   */
  liveCursor: number;
}

export class CodexService {
  private readonly workers = new Map<string, AbortController>();
  private readonly workerTasks = new Map<string, Promise<void>>();
  private readonly checkpointing = new Map<string, Promise<boolean>>();
  private readonly recovering = new Map<string, Promise<StoredRuntime>>();
  /** One native-state layout migration per Session in the single Sandpi server. */
  private readonly nativeStateMigrations = new Map<
    string,
    Promise<StoredRuntime>
  >();
  /** Candidate edit/delete events stay private until the history commit. */
  private readonly mutating = new Set<string>();
  /** One decoder/CAS owner per product Session, shared by workers and RPC callers. */
  private readonly ingesting = new Map<
    string,
    Promise<DecodedCodexRecord[]>
  >();
  private readonly rpcResponses = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();
  private readonly rpcResponseAnchors = new Map<string, Map<string, number>>();
  private readonly rpcResponseTransportAnchors = new Map<
    string,
    Map<string, RpcTransportBoundary>
  >();
  private readonly latestTransportBoundaries = new Map<
    string,
    RpcTransportBoundary
  >();
  private readonly rpcWaiters = new Map<string, Set<RpcWaiter>>();
  private readonly rpcPumps = new Map<string, Promise<void>>();
  /**
   * Live notifications are an intentionally bounded process-local acceleration
   * path. Reconnect always starts from thread/read; this ring is not history.
   */
  private readonly live = new Map<string, LiveNotificationState>();
  private readonly events = new EventEmitter();
  private reaperTimer?: NodeJS.Timeout;
  private reaping?: Promise<void>;
  private nativeMigrationRecovery?: Promise<void>;
  private readonly startupRecoveries = new Set<Promise<void>>();
  private readonly closeController = new AbortController();
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
    await this.store.recoverStaleTurnCheckpointClaims();
    await this.store.recoverStaleSessionOperations();
    await this.store.recoverWaitingSessionsAfterRestart();
    const sessionIds = await this.store.activeRuntimeSessionIds();
    for (const sessionId of sessionIds) {
      // Sandbox reachability is not an API-listener dependency. Restore each
      // ephemeral credential independently and start that Session's worker
      // when it settles; one 120-second Sandbox0 timeout cannot serialize or
      // block the whole Sandpi server startup.
      const startupRecovery = this.restoreRuntimeCredential(sessionId)
        .catch((error) => {
          this.logger.warn(
            { sessionId, error: errorMessage(error) },
            "Codex runtime recovery deferred",
          );
        })
        .finally(() => {
          this.startupRecoveries.delete(startupRecovery);
          if (!this.closed) this.ensureWorker(sessionId);
        });
      this.startupRecoveries.add(startupRecovery);
    }
    // Mutation compensation, Turn delivery reconciliation, migration, and
    // resource deletion all make external calls. Run the coalesced maintenance
    // pass after startup instead of delaying the HTTP listener behind N Sessions.
    void this.reapExpiredSessions().catch((error) => {
      this.logger.warn(
        { error: errorMessage(error) },
        "Session startup recovery scan will be retried",
      );
    });
    this.reaperTimer ??= setInterval(() => {
      void this.reapExpiredSessions().catch((error) => {
        this.logger.error(
          { error: errorMessage(error) },
          "Session resource reaper failed",
        );
      });
    }, RESOURCE_REAPER_INTERVAL_MS);
    this.reaperTimer.unref();
  }

  async createSession(input: {
    userId: string;
    environment: Environment;
    title: string;
    prompt: string;
    images: EncodedCodexInputImage[];
    modelId?: string;
  }) {
    const turnInput = nativeCodexTurnInput(input.prompt, input.images);
    const submission = turnSubmissionCoordinates();
    const credential = await this.credentials.credentialForEnvironment(
      input.userId,
      input.environment.id,
    );
    const sessionId = await this.store.createSessionMetadata(input);
    let resources: Awaited<ReturnType<RuntimeAdapter["provisionSession"]>> | undefined;
    try {
      resources = await this.runtime.provisionSession({
        sessionId,
        environment: input.environment,
        codexAuthJson: credential.authJson,
        onResourcesAllocated: (allocated) =>
          this.store.recordSessionAllocation(sessionId, allocated),
      });
      await this.store.markSessionProvisioned(sessionId, resources, {
        sourceId: credential.sourceId,
        sourceRevision: credential.revision,
        harness: "codex",
      });
      await this.initializeAttempt(sessionId);
      const runtime = await this.store.decoderState(sessionId);
      const nativeSessionId = runtime.nativeSessionId;
      if (!nativeSessionId) {
        throw new Error("Codex thread/start did not return a native Session id");
      }
      if (
        !(await this.captureVolumeCheckpoint(sessionId, {
          label: "baseline",
          nativeSessionId,
        }))
      ) {
        throw new HttpError(
          502,
          "turn_checkpoint_failed",
          "The initial Session Volume checkpoint could not be created.",
        );
      }
      const baselineSnapshotId = await this.store.headVolumeSnapshotId(sessionId);
      if (!baselineSnapshotId) {
        throw new HttpError(
          502,
          "turn_checkpoint_failed",
          "The initial Volume checkpoint was not committed.",
        );
      }
      // The baseline is also the exact input of the first Turn. Codex has no
      // rollout yet at this boundary, so a later first-Turn rewrite may need
      // the documented empty-thread fallback after restoring this snapshot.
      await this.store.beginInitialTurnSubmission(
        sessionId,
        baselineSnapshotId,
        submission,
      );
      this.ensureWorker(sessionId);
      let firstTurn: Record<string, unknown>;
      try {
        firstTurn = await this.requestStagedCodexTurn(
          sessionId,
          runtime,
          {
            method: "turn/start",
            id: submission.requestId,
            params: {
              threadId: nativeSessionId,
              clientUserMessageId: submission.clientMessageId,
              input: turnInput,
            },
          },
          submission.stableInputId,
        );
      } catch (error) {
        // Once the Supervisor input is dispatched, transport failure is
        // ambiguous: Codex may still accept it. Keep the journal and input
        // snapshot; the worker/startup reconciler resolves it by request and
        // client message ids without storing the prompt in PostgreSQL.
        this.logger.warn(
          { sessionId, error: errorMessage(error) },
          "Initial Codex Turn submission will be reconciled asynchronously",
        );
        return sessionId;
      }
      const firstNativeTurnId = turnIdFromRpcResponse(firstTurn);
      if (firstTurn.error) {
        await this.abandonTurnSubmission(
          sessionId,
          submission.requestId,
          runtime,
          submission.stableInputId,
        );
        throw new HttpError(
          502,
          "codex_turn_start_failed",
          rpcErrorMessage(firstTurn.error),
        );
      }
      if (!firstNativeTurnId) {
        this.logger.warn(
          { sessionId },
          "Initial Codex Turn response had no native Turn id; reconciliation will verify acceptance",
        );
        return sessionId;
      }
      try {
        const accepted = await this.store.markTurnSubmissionAccepted(
          sessionId,
          submission.requestId,
          firstNativeTurnId,
        );
        if (accepted) {
          await this.discardTurnDeliveryOutbox(
            sessionId,
            runtime,
            submission.stableInputId,
          );
        }
      } catch (error) {
        // The native harness already returned success. A database failure here
        // is not evidence that the Turn was rejected, so retain the submission
        // journal and let startup/worker reconciliation finish the commit.
        this.logger.warn(
          { sessionId, nativeTurnId: firstNativeTurnId, error: errorMessage(error) },
          "Initial Codex Turn acceptance will be reconciled asynchronously",
        );
      }
      return sessionId;
    } catch (error) {
      const cleaned = await this.cleanupFailedSessionResources(sessionId, resources);
      await this.store.markSessionFailed(sessionId, errorMessage(error), cleaned);
      throw error;
    }
  }

  async forkSession(input: { userId: string; sessionId: string; title?: string }) {
    const source = await this.store.getSession(input.userId, input.sessionId);
    if (source.status !== "waiting") {
      throw new HttpError(
        409,
        "session_fork_not_ready",
        "Wait for the current Codex Turn to finish before forking the Session.",
      );
    }
    let sourceRuntime = await this.store.getRuntime(
      input.userId,
      input.sessionId,
    );
    if (sourceRuntime.runtimeErrorCode === "supervisor_journal_gap") {
      sourceRuntime = await this.recoverSupervisorJournalGap(
        input.sessionId,
        sourceRuntime,
      );
    }
    sourceRuntime = await this.ensureWorkspaceNativeState(
      input.sessionId,
      sourceRuntime,
    );
    const releaseOperationLock = await this.store.acquireSessionOperationLock(
      input.sessionId,
    );
    if (!releaseOperationLock) {
      throw new HttpError(
        409,
        "session_fork_conflict",
        "Another Session operation is already in progress.",
      );
    }
    let operationId: string | undefined;
    let sessionId: string | undefined;
    let resources: Awaited<ReturnType<RuntimeAdapter["forkSession"]>> | undefined;
    try {
      assertSessionOperationLock(releaseOperationLock);
      await this.store.clearAbandonedSessionOperation(input.sessionId);
      assertSessionOperationLock(releaseOperationLock);
      operationId = await this.store.reserveSessionFork(
        input.userId,
        input.sessionId,
      );
      assertSessionOperationLock(releaseOperationLock);
      await this.stopWorker(input.sessionId);
      assertSessionOperationLock(releaseOperationLock);
      if (
        !(await this.store.touchSessionOperation(
          input.sessionId,
          operationId,
        ))
      ) {
        throw sessionOperationInProgressError();
      }
      const sourceRuntime = await this.store.getRuntime(input.userId, input.sessionId);
      if (!sourceRuntime.nativeSessionId) {
        throw new HttpError(
          409,
          "codex_thread_not_ready",
          "Codex thread is not ready.",
        );
      }
      const sourceThread = await this.readForkSourceThread(
        input.sessionId,
        sourceRuntime,
        operationId,
      );
      assertSessionOperationLock(releaseOperationLock);
      const sourceWasEmpty = sourceThread.turns.length === 0;
      if (
        sourceRuntime.activeNativeTurnId ||
        sourceThread.turns.some((turn) => turn.status === "inProgress")
      ) {
        throw new HttpError(
          409,
          "session_fork_not_ready",
          "Wait for the active Codex Turn to finish before forking the Session.",
        );
      }
      const environment = await this.store.getEnvironment(
        input.userId,
        source.environmentId,
      );
      const credential = await this.credentials.credentialForEnvironment(
        input.userId,
        environment.id,
      );
      sessionId = await this.store.createForkSessionMetadata({
        userId: input.userId,
        environment,
        source,
        modelId: sourceRuntime.modelId,
        title: input.title,
      });
      assertSessionOperationLock(releaseOperationLock);
      if (
        !(await this.store.touchSessionOperation(
          input.sessionId,
          operationId,
        ))
      ) {
        throw sessionOperationInProgressError();
      }
      resources = await this.runtime.forkSession({
        sessionId,
        environment,
        source: sourceRuntime,
        codexAuthJson: credential.authJson,
        onResourcesAllocated: (allocated) =>
          this.store.recordSessionAllocation(sessionId!, allocated),
      });
      assertSessionOperationLock(releaseOperationLock);
      await this.store.markSessionProvisioned(sessionId, resources, {
        sourceId: credential.sourceId,
        sourceRevision: credential.revision,
        harness: "codex",
      });
      let initialized;
      try {
        // The child always asks Codex to copy its own complete history. The
        // source read above is only a stability/empty-history proof; Sandpi
        // neither reconstructs nor sends the transcript itself.
        initialized = await this.initializeAttempt(sessionId, {
          mode: "fork",
          sourceNativeSessionId: sourceRuntime.nativeSessionId,
        });
      } catch (error) {
        if (
          (!isMissingNativeThreadError(error) &&
            !isUnmaterializedNativeThreadError(error)) ||
          !sourceWasEmpty
        ) {
          throw error;
        }
        // Only a successful source thread/read returning exactly zero Turns
        // proves this fallback cannot discard harness-authoritative history.
        initialized = await this.initializeAttempt(sessionId, { mode: "start" });
      }
      assertSessionOperationLock(releaseOperationLock);
      const childRuntime = await this.store.decoderState(sessionId);
      if (!childRuntime.nativeSessionId) {
        throw new HttpError(
          502,
          "codex_thread_failed",
          "Codex did not return the forked native Session.",
        );
      }
      if (
        !(await this.captureVolumeCheckpoint(sessionId, {
          label: "fork-baseline",
          nativeSessionId: childRuntime.nativeSessionId,
          nativeHeadTurnId: initialized.nativeHeadTurnId,
        }))
      ) {
        throw new HttpError(
          502,
          "turn_checkpoint_failed",
          "The forked Session Volume checkpoint could not be created.",
        );
      }
      assertSessionOperationLock(releaseOperationLock);
      await this.store.markSessionReady(sessionId);
      this.ensureWorker(sessionId);
      return sessionId;
    } catch (error) {
      if (sessionId) {
        const cleaned = await this.cleanupFailedSessionResources(sessionId, resources);
        await this.store.markSessionFailed(sessionId, errorMessage(error), cleaned);
      }
      throw error;
    } finally {
      try {
        if (operationId && !releaseOperationLock.signal.aborted) {
          await this.store.releaseSessionOperation(input.sessionId, operationId);
        }
      } finally {
        try {
          await releaseOperationLock.release();
        } finally {
          this.ensureWorker(input.sessionId);
        }
      }
    }
  }

  async forkTurn(input: {
    userId: string;
    sessionId: string;
    nativeTurnId: string;
    title?: string;
  }) {
    const source = await this.store.getSession(input.userId, input.sessionId);
    const sourceRuntimeBeforeReservation = await this.store.getRuntime(
      input.userId,
      input.sessionId,
    );
    if (
      sourceRuntimeBeforeReservation.runtimeErrorCode ===
      "supervisor_journal_gap"
    ) {
      await this.recoverSupervisorJournalGap(
        input.sessionId,
        sourceRuntimeBeforeReservation,
      );
    }
    const releaseOperationLock = await this.store.acquireSessionOperationLock(
      input.sessionId,
    );
    if (!releaseOperationLock) {
      throw new HttpError(
        409,
        "turn_fork_conflict",
        "Another Session operation is already in progress.",
      );
    }
    let point:
      | Awaited<ReturnType<SandpiStore["reserveTurnFork"]>>
      | undefined;

    let childSessionId: string | undefined;
    let resources: Awaited<ReturnType<RuntimeAdapter["forkTurn"]>> | undefined;
    try {
      assertSessionOperationLock(releaseOperationLock);
      await this.store.clearAbandonedSessionOperation(input.sessionId);
      assertSessionOperationLock(releaseOperationLock);
      point = await this.store.reserveTurnFork(
        input.userId,
        input.sessionId,
        input.nativeTurnId,
      );
      assertSessionOperationLock(releaseOperationLock);
      await this.stopWorker(input.sessionId);
      assertSessionOperationLock(releaseOperationLock);
      const sourceRuntime = await this.store.getRuntime(
        input.userId,
        input.sessionId,
      );
      if (!sourceRuntime.nativeSessionId) {
        throw new HttpError(
          409,
          "codex_thread_not_ready",
          "Codex thread is not ready.",
        );
      }
      const environment = await this.store.getEnvironment(
        input.userId,
        source.environmentId,
      );
      const credential = await this.credentials.credentialForEnvironment(
        input.userId,
        environment.id,
      );
      childSessionId = await this.store.createForkSessionMetadata({
        userId: input.userId,
        environment,
        source,
        modelId: sourceRuntime.modelId,
        title: input.title,
        kind: "turn",
        sourceNativeItemId: input.nativeTurnId,
      });
      assertSessionOperationLock(releaseOperationLock);
      if (
        !(await this.store.touchSessionOperation(
          input.sessionId,
          point.operationId,
        ))
      ) {
        throw sessionOperationInProgressError();
      }
      resources = await this.runtime.forkTurn({
        sessionId: childSessionId,
        environment,
        workspaceSnapshotId: point.selectedSnapshotId,
        codexAuthJson: credential.authJson,
        onResourcesAllocated: (allocated) =>
          this.store.recordSessionAllocation(childSessionId!, allocated),
      });
      assertSessionOperationLock(releaseOperationLock);
      await this.store.markSessionProvisioned(childSessionId, resources, {
        sourceId: credential.sourceId,
        sourceRevision: credential.revision,
        harness: "codex",
      });
      await this.initializeAttempt(childSessionId, {
        mode: "fork",
        sourceNativeSessionId: sourceRuntime.nativeSessionId,
        lastNativeTurnId: point.selectedTurnId,
      });
      assertSessionOperationLock(releaseOperationLock);
      if (
        !(await this.captureVolumeCheckpoint(childSessionId, {
          label: "turn-fork-baseline",
          nativeSessionId: (await this.requireNativeRuntime(childSessionId))
            .nativeSessionId,
          nativeHeadTurnId: point.selectedTurnId,
        }))
      ) {
        throw new HttpError(
          502,
          "turn_checkpoint_failed",
          "The forked Turn Volume checkpoint could not be created.",
        );
      }
      assertSessionOperationLock(releaseOperationLock);
      await this.store.markSessionReady(childSessionId);
      this.ensureWorker(childSessionId);
      return childSessionId;
    } catch (error) {
      if (childSessionId) {
        const cleaned = await this.cleanupFailedSessionResources(
          childSessionId,
          resources,
        );
        await this.store.markSessionFailed(
          childSessionId,
          errorMessage(error),
          cleaned,
        );
      }
      throw error;
    } finally {
      try {
        if (point && !releaseOperationLock.signal.aborted) {
          await this.store.releaseSessionOperation(
            input.sessionId,
            point.operationId,
          );
        }
      } finally {
        try {
          await releaseOperationLock.release();
        } finally {
          this.ensureWorker(input.sessionId);
        }
      }
    }
  }

  async startTurn(input: {
    userId: string;
    sessionId: string;
    text: string;
    images: EncodedCodexInputImage[];
    modelId?: string;
  }) {
    const turnInput = nativeCodexTurnInput(input.text, input.images);
    const submission = turnSubmissionCoordinates();
    let current = await this.store.getRuntime(input.userId, input.sessionId);
    if (current.runtimeErrorCode === "supervisor_journal_gap") {
      current = await this.recoverSupervisorJournalGap(input.sessionId, current);
    }
    await this.ensureWorkspaceNativeState(input.sessionId, current);
    await this.store.beginSessionTurn(
      input.userId,
      input.sessionId,
      input.modelId,
      submission,
    );
    const requestId = submission.requestId;
    let runtime: Awaited<ReturnType<SandpiStore["getRuntime"]>> | undefined;
    let inputSnapshotId: string | undefined;
    let inputSnapshotRecorded = false;
    try {
      // Reserve the Session before touching its Sandbox. A Turn edit/delete/fork
      // restores the Session Volume, so credential materialization must not race
      // with a history operation on the same Session.
      runtime = await this.store.getRuntime(input.userId, input.sessionId);
      await this.ensureCurrentRuntimeCredential(input.sessionId, runtime);
      if (!runtime.nativeSessionId) {
        throw new HttpError(
          409,
          "codex_thread_not_ready",
          "Codex thread is not ready.",
        );
      }
      // Browser/terminal edits can happen between native Turns. Capture that exact
      // input state once here so a later message edit/delete restores what the
      // user actually gave this Turn, rather than the previous Turn's output.
      const inputSnapshot = await this.runtime.createVolumeCheckpoint(
        runtime,
        `sandpi-turn-input-${randomUUID().slice(0, 12)}`,
      );
      inputSnapshotId = inputSnapshot.snapshotId;
      await this.store.recordTurnSubmissionInputSnapshot(
        input.sessionId,
        requestId,
        inputSnapshotId,
      );
      inputSnapshotRecorded = true;
      let response: Record<string, unknown>;
      try {
        response = await this.requestStagedCodexTurn(
          input.sessionId,
          runtime,
          {
            method: "turn/start",
            id: requestId,
            params: {
              threadId: runtime.nativeSessionId,
              clientUserMessageId: submission.clientMessageId,
              input: turnInput,
              ...(input.modelId ? { model: input.modelId } : {}),
            },
          },
          submission.stableInputId,
        );
      } catch (error) {
        this.logger.warn(
          { sessionId: input.sessionId, error: errorMessage(error) },
          "Codex Turn submission will be reconciled asynchronously",
        );
        this.ensureWorker(input.sessionId);
        return { requestId, pending: true };
      }
      const nativeTurnId = turnIdFromRpcResponse(response);
      if (response.error) {
        throw new HttpError(
          502,
          "codex_turn_start_failed",
          rpcErrorMessage(response.error),
        );
      }
      if (!nativeTurnId) {
        this.logger.warn(
          { sessionId: input.sessionId },
          "Codex Turn response had no native Turn id; reconciliation will verify acceptance",
        );
        this.ensureWorker(input.sessionId);
        return { requestId, pending: true };
      }
      try {
        const accepted = await this.store.markTurnSubmissionAccepted(
          input.sessionId,
          requestId,
          nativeTurnId,
        );
        if (accepted) {
          await this.discardTurnDeliveryOutbox(
            input.sessionId,
            runtime,
            submission.stableInputId,
          );
        }
      } catch (error) {
        // Native success makes a persistence error ambiguous. Never clear the
        // active state or input snapshot here; the durable delivery coordinates
        // are precisely the recovery source for this crash window.
        this.logger.warn(
          { sessionId: input.sessionId, nativeTurnId, error: errorMessage(error) },
          "Codex Turn acceptance will be reconciled asynchronously",
        );
        this.ensureWorker(input.sessionId);
        return { requestId, pending: true };
      }
    } catch (error) {
      await (runtime
        ? this.abandonTurnSubmission(
            input.sessionId,
            requestId,
            runtime,
            submission.stableInputId,
          )
        : this.store.abandonTurnSubmission(input.sessionId, requestId)
      ).catch((cleanupError) => {
        this.logger.warn(
          { sessionId: input.sessionId, error: errorMessage(cleanupError) },
          "Failed Turn submission journal could not be released",
        );
      });
      const snapshotToDelete = !inputSnapshotRecorded
        ? inputSnapshotId
        : undefined;
      if (snapshotToDelete && runtime) {
        await this.runtime
          .deleteVolumeCheckpoint(runtime, snapshotToDelete)
          .catch((cleanupError) => {
            this.logger.warn(
              { sessionId: input.sessionId, error: errorMessage(cleanupError) },
              "Failed Turn input checkpoint cleanup failed",
            );
          });
      }
      throw error;
    }
    this.ensureWorker(input.sessionId);
    return { requestId };
  }

  async editTurn(input: {
    userId: string;
    sessionId: string;
    nativeTurnId: string;
    text: string;
    images: EncodedCodexInputImage[];
    modelId?: string;
  }) {
    const result = await this.mutateTurn(
      input.userId,
      input.sessionId,
      input.nativeTurnId,
      nativeCodexTurnInput(input.text, input.images),
      input.modelId,
    );
    return {
      requestId: result.requestId,
      session: await this.store.getSession(input.userId, input.sessionId),
    };
  }

  async deleteTurn(
    userId: string,
    sessionId: string,
    nativeTurnId: string,
  ) {
    await this.mutateTurn(userId, sessionId, nativeTurnId);
    return this.store.getSession(userId, sessionId);
  }

  async listModels(userId: string, sessionId: string) {
    return this.withRuntimeRecovery(userId, sessionId, async (runtime) => {
      const data: unknown[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const response = await this.requestCodex(sessionId, runtime, {
          method: "model/list",
          id: `model-list:${randomUUID()}`,
          params: { ...(cursor ? { cursor } : {}), limit: 100 },
        });
        if (response.error) {
          throw new HttpError(
            502,
            "codex_model_list_failed",
            rpcErrorMessage(response.error),
          );
        }
        const page = modelListPage(response.result);
        data.push(...page.data);
        if (!page.nextCursor) break;
        if (seenCursors.has(page.nextCursor)) {
          throw new HttpError(
            502,
            "codex_model_list_failed",
            "Codex returned a repeated model-list cursor.",
          );
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      return { data, nextCursor: null };
    });
  }

  /**
   * Reads the native Codex Thread directly. PostgreSQL contributes only
   * checkpoint capability and the active history revision; it never projects
   * or stores the transcript returned here.
   */
  async readNativeSnapshot(
    userId: string,
    sessionId: string,
  ): Promise<CodexNativeSnapshot> {
    return (await this.readNativeSnapshotWithCursor(userId, sessionId)).snapshot;
  }

  /**
   * Reads the native snapshot together with its exact live-stream boundary.
   * The boundary is captured when the matching thread/read response record is
   * decoded, rather than before the RPC begins or after reconciliation.
   */
  async readNativeSnapshotWithCursor(
    userId: string,
    sessionId: string,
  ): Promise<CodexNativeSnapshotRead> {
    return this.withRuntimeRecovery(userId, sessionId, async (runtime) => {
      const nativeSessionId = runtime.nativeSessionId;
      if (!nativeSessionId) {
        throw new HttpError(
          409,
          "codex_thread_not_ready",
          "Codex native Session is not ready.",
        );
      }
      let requestId = `thread-read:${randomUUID()}`;
      let response = await this.requestCodex(sessionId, runtime, {
        method: "thread/read",
        id: requestId,
        params: { threadId: nativeSessionId, includeTurns: true },
      });
      let liveCursor =
        this.takeRpcResponseAnchor(sessionId, requestId) ??
        this.liveCursor(sessionId);
      let forkableTurnIds: string[] | undefined;
      let rewindableTurnIds: string[] | undefined;
      let allowUnmaterializedThread = false;
      if (
        response.error &&
        (isUnmaterializedNativeThreadError(response.error) ||
          isMissingNativeThreadError(response.error))
      ) {
        const [forkable, rewindable, hasMaterializedHistory] = await Promise.all([
          this.store.forkableCheckpointTurnIds(sessionId),
          this.store.rewindableCheckpointTurnIds(sessionId),
          this.store.hasMaterializedNativeHistory(sessionId),
        ]);
        forkableTurnIds = forkable;
        rewindableTurnIds = rewindable;
        if (hasMaterializedHistory) {
          const message =
            "The active Codex native Session has no persisted rollout, but this Sandpi Session has completed Turn checkpoints. Its native conversation cannot be recovered.";
          await this.store.markNativeSessionUnrecoverable(sessionId, message);
          this.publishInvalidation(sessionId, "native-session-unrecoverable", {
            message,
            unrecoverable: true,
          });
          throw nativeSessionUnrecoverableError(message);
        }

        // A newly created product Session can briefly be visible after
        // thread/start and before its first turn/start is materialized. Codex
        // rejects includeTurns in that window, but the same native Thread can
        // still be read without a fabricated or persisted transcript.
        requestId = `thread-read-empty:${randomUUID()}`;
        response = await this.requestCodex(sessionId, runtime, {
          method: "thread/read",
          id: requestId,
          params: { threadId: nativeSessionId, includeTurns: false },
        });
        liveCursor =
          this.takeRpcResponseAnchor(sessionId, requestId) ??
          this.liveCursor(sessionId);
        allowUnmaterializedThread = true;
      }
      if (response.error) {
        throw new HttpError(
          502,
          "codex_thread_read_failed",
          rpcErrorMessage(response.error),
        );
      }
      const thread = threadFromRpcResponse(
        response,
        allowUnmaterializedThread,
      );
      if (!thread || thread.id !== nativeSessionId) {
        throw new HttpError(
          502,
          "codex_thread_read_failed",
          "Codex returned an unexpected native Session.",
        );
      }

      // thread/read is a read model, never a control-plane reconciliation
      // source. Only ordered Supervisor events and committed checkpoint state
      // may advance the active Turn or product Session status.
      const observed = await this.store.decoderState(sessionId);
      if (observed.nativeSessionId !== nativeSessionId) {
        throw new HttpError(
          409,
          "codex_thread_changed",
          "The active Codex native Session changed while its snapshot was read.",
        );
      }
      [forkableTurnIds, rewindableTurnIds] = await Promise.all([
        forkableTurnIds ?? this.store.forkableCheckpointTurnIds(sessionId),
        rewindableTurnIds ?? this.store.rewindableCheckpointTurnIds(sessionId),
      ]);
      const verified = await this.store.decoderState(sessionId);
      if (
        verified.nativeSessionId !== nativeSessionId ||
        verified.historyRevision !== observed.historyRevision
      ) {
        throw new HttpError(
          409,
          "codex_thread_changed",
          "The active Codex native Session changed while its snapshot was read.",
        );
      }
      const productSession = await this.store.getSession(userId, sessionId);
      return {
        liveCursor,
        snapshot: {
          protocol: "codex-app-server",
          nativeSessionId,
          historyRevision: verified.historyRevision,
          modelId: verified.modelId ?? "",
          sessionStatus: productSession.status,
          thread,
          forkableTurnIds,
          rewindableTurnIds,
        },
      };
    });
  }

  /** Retries a safe Session operation once after reconciling its native runtime. */
  async withRuntimeRecovery<T>(
    userId: string,
    sessionId: string,
    operation: (runtime: StoredRuntime) => Promise<T>,
  ): Promise<T> {
    let runtime = await this.store.getRuntime(userId, sessionId);
    if (runtime.exclusiveOperationId || runtime.desiredState !== "running") {
      throw sessionOperationInProgressError();
    }
    if (runtime.runtimeErrorCode === "native_session_unrecoverable") {
      throw nativeSessionUnrecoverableError(runtime.provisioningError);
    }
    if (runtime.runtimeErrorCode === "session_allocation_unrecoverable") {
      throw sessionAllocationUnrecoverableError();
    }
    if (runtime.runtimeErrorCode === "supervisor_journal_gap") {
      runtime = await this.recoverSupervisorJournalGap(sessionId, runtime);
    }
    if (runtime.provisioningError) {
      try {
        runtime = await this.recoverRuntime(sessionId, runtime);
      } catch (recoveryError) {
        try {
          return await operation(await this.store.decoderState(sessionId));
        } catch {
          throw publicRuntimeError(recoveryError);
        }
      }
    }
    try {
      return await operation(runtime);
    } catch (error) {
      let runtimeError = error;
      if (isTransientSandbox0ClientError(runtimeError)) {
        try {
          return await operation(runtime);
        } catch (retryError) {
          runtimeError = retryError;
        }
      }
      if (!isRecoverableCodexRuntimeError(runtimeError)) {
        throw publicRuntimeError(runtimeError);
      }
      const latest = await this.store.decoderState(sessionId);
      if (
        latest.exclusiveOperationId ||
        latest.desiredState !== "running"
      ) {
        throw sessionOperationInProgressError();
      }
      let recovered: StoredRuntime;
      try {
        recovered = await this.recoverRuntime(sessionId, runtime);
      } catch (recoveryError) {
        // A failed native thread resume must not keep an already-remounted
        // Workspace unavailable to the IDE. Retry the requested surface once
        // against the latest durable runtime before exposing recovery failure.
        const latest = await this.store.decoderState(sessionId);
        try {
          return await operation(latest);
        } catch {
          throw publicRuntimeError(recoveryError);
        }
      }
      try {
        return await operation(recovered);
      } catch (retryError) {
        throw publicRuntimeError(retryError);
      }
    }
  }

  async interruptActiveTurn(input: {
    userId: string;
    sessionId: string;
    turnId: string;
  }) {
    const runtime = await this.store.getRuntime(input.userId, input.sessionId);
    if (
      !runtime.nativeSessionId ||
      runtime.activeNativeTurnId !== input.turnId
    ) {
      throw new HttpError(
        409,
        "codex_turn_not_active",
        "That Codex Turn is no longer running.",
      );
    }
    const requestId = await this.sendTurnInterrupt(
      input.sessionId,
      runtime.nativeSessionId,
      input.turnId,
    );
    this.ensureWorker(input.sessionId);
    return { requestId };
  }

  ensureWorker(sessionId: string) {
    if (this.closed) return;
    if (this.workers.has(sessionId)) return;
    const controller = new AbortController();
    this.workers.set(sessionId, controller);
    const task = this.runWorker(sessionId, controller.signal).finally(() => {
      if (this.workers.get(sessionId) === controller) {
        this.workers.delete(sessionId);
      }
      this.workerTasks.delete(sessionId);
    });
    this.workerTasks.set(sessionId, task);
  }

  async stopWorker(sessionId: string) {
    this.workers.get(sessionId)?.abort();
    await this.workerTasks.get(sessionId);
    this.workers.delete(sessionId);
    this.workerTasks.delete(sessionId);
  }

  async ingestOnce(sessionId: string) {
    const active = this.ingesting.get(sessionId);
    if (active) return active;
    const ingest = this.performIngestOnce(sessionId).finally(() => {
      if (this.ingesting.get(sessionId) === ingest) {
        this.ingesting.delete(sessionId);
      }
    });
    this.ingesting.set(sessionId, ingest);
    return ingest;
  }

  private async performIngestOnce(sessionId: string) {
    const stored = await this.store.decoderState(sessionId);
    const page = await this.runtime.listCodexEvents(
      stored,
      stored.decoder.supervisorCursor,
    );
    if (
      page.cursor.earliest > 0 &&
      page.cursor.earliest > stored.decoder.supervisorCursor + 1
    ) {
      const marked = await this.store.markSupervisorJournalGap(
        sessionId,
        stored,
        page.cursor.earliest,
      );
      if (marked) {
        this.publishInvalidation(sessionId, "supervisor-journal-gap", {
          message:
            "Live execution events expired before Sandpi consumed them. Native history remains authoritative, but missing Turns will not receive fabricated rollback checkpoints.",
        });
      }
      throw new HttpError(
        409,
        "supervisor_journal_gap",
        "The Codex Supervisor event journal has a retention gap.",
      );
    }
    const events = page.events
      .map(supervisorOutputEvent)
      .filter((event): event is SupervisorOutputEvent => event !== undefined);
    if (events.length === 0) return [];

    const decoded = decodeCodexSupervisorEvents(stored.decoder, events);
    // Once a retention gap is known, retained records are not an exact history
    // boundary. Decode them only to deliver the recovery RPC response; do not
    // project control, publish live suffixes, or create checkpoints from them.
    const recoveringJournalGap =
      stored.runtimeErrorCode === "supervisor_journal_gap";
    const transitions = recoveringJournalGap
      ? []
      : controlTransitions(decoded.records);
    const committed = await this.store.commitCodexTransport(
      sessionId,
      stored.supervisorSessionId,
      stored.decoder,
      decoded.state,
      transitions,
      { transportOnly: recoveringJournalGap },
    );
    if (!committed) return [];

    if (
      !recoveringJournalGap &&
      stored.pendingTurnStableInputId &&
      transitions.some((transition) => transition.type === "turnStarted")
    ) {
      await this.discardTurnDeliveryOutbox(
        sessionId,
        stored,
        stored.pendingTurnStableInputId,
      );
    }

    for (const record of decoded.records) {
      const boundary = transportBoundary(stored.supervisorSessionId, record);
      this.latestTransportBoundaries.set(sessionId, boundary);
      this.cacheRpcRecord(sessionId, record.message, boundary);
      if (
        !recoveringJournalGap &&
        isTranscriptNotification(record.message) &&
        !this.mutating.has(sessionId)
      ) {
        this.publishLiveNotification(sessionId, record);
      }
    }
    if (recoveringJournalGap) return [];
    let completedTransitionSeen = false;
    let checkpointChanged = false;
    let completedCheckpointsReady = true;
    for (const transition of transitions) {
      if (transition.type !== "turnCompleted") continue;
      if (this.mutating.has(sessionId)) continue;
      completedTransitionSeen = true;
      const checkpointReady = await this.captureVolumeCheckpoint(sessionId, {
        label: `turn-${transition.nativeTurnId.slice(-12)}`,
        nativeSessionId: transition.nativeSessionId,
        nativeTurnId: transition.nativeTurnId,
        nativeHeadTurnId: transition.nativeTurnId,
      });
      if (checkpointReady) {
        checkpointChanged = true;
      } else {
        completedCheckpointsReady = false;
        this.logger.warn(
          { sessionId, nativeTurnId: transition.nativeTurnId },
          "Completed Codex Turn checkpoint will be retried",
        );
      }
    }
    if (completedTransitionSeen && completedCheckpointsReady) {
      const latest = await this.store.decoderState(sessionId);
      if (!latest.activeNativeTurnId) {
        await this.store.markSessionTurnCompleted(sessionId);
      }
    }
    if (checkpointChanged) {
      // Publish only after the product Session status is committed. The native
      // turn/completed event precedes the Volume checkpoint and is not itself a
      // promise that a new Turn can start.
      this.publishInvalidation(sessionId, "checkpoint-ready");
    }
    if (decoded.invalidRecords.length > 0) {
      this.logger.warn(
        { sessionId, count: decoded.invalidRecords.length },
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
    return state.updates.filter(
      (update) => update.cursor > after,
    );
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
    this.closeController.abort();
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = undefined;
    for (const controller of this.workers.values()) controller.abort();
    await Promise.allSettled(this.workerTasks.values());
    this.workers.clear();
    this.workerTasks.clear();
    await Promise.allSettled(this.startupRecoveries);
    this.startupRecoveries.clear();
    await Promise.allSettled(this.recovering.values());
    this.recovering.clear();
    await Promise.allSettled(this.nativeStateMigrations.values());
    this.nativeStateMigrations.clear();
    if (this.nativeMigrationRecovery) await this.nativeMigrationRecovery;
    await Promise.allSettled(this.ingesting.values());
    this.ingesting.clear();
    for (const waiters of this.rpcWaiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(new Error("Codex service closed"));
      }
    }
    this.rpcWaiters.clear();
    await Promise.allSettled(this.rpcPumps.values());
    this.rpcPumps.clear();
    this.rpcResponses.clear();
    this.rpcResponseAnchors.clear();
    this.rpcResponseTransportAnchors.clear();
    this.latestTransportBoundaries.clear();
    this.live.clear();
    await Promise.allSettled(this.checkpointing.values());
    if (this.reaping) await this.reaping;
  }

  reapExpiredSessions() {
    this.reaping ??= this.runExpiredSessionReaper().finally(() => {
      this.reaping = undefined;
    });
    return this.reaping;
  }

  private async runExpiredSessionReaper() {
    // Mutation compensation is idempotent and remains journaled after a
    // transient Sandbox0 failure. Retry it independently of client traffic.
    await this.recoverInterruptedTurnMutations();
    await this.recoverPendingTurnSubmissions();
    await this.store.recoverStaleSessionOperations();
    void this.recoverNativeStateMigrations().catch((error) => {
      this.logger.warn(
        { error: errorMessage(error) },
        "Native-state migration recovery scan failed",
      );
    });
    const expired = await this.store.expiredRuntimeSessions();
    for (const runtime of expired) {
      try {
        await this.runtime.deleteSessionResources(runtime);
        await this.store.markSessionExpired(runtime.id);
        const worker = this.workers.get(runtime.id);
        worker?.abort();
        this.workers.delete(runtime.id);
      } catch (error) {
        this.logger.error(
          { sessionId: runtime.id, error: errorMessage(error) },
          "Expired Session resource cleanup failed",
        );
      }
    }
    const failed = await this.store.failedRuntimeSessions();
    for (const candidate of failed) {
      const operationLock = await this.store.acquireSessionOperationLock(
        candidate.id,
      );
      if (!operationLock) continue;
      try {
        assertSessionOperationLock(operationLock);
        const runtime = await this.store.claimFailedRuntimeSession(candidate.id);
        if (!runtime) continue;
        assertSessionOperationLock(operationLock);
        await this.runtime.deleteSessionResources(runtime);
        assertSessionOperationLock(operationLock);
        await this.store.markFailedSessionResourcesCleaned(runtime.id);
      } catch (error) {
        this.logger.error(
          { sessionId: candidate.id, error: errorMessage(error) },
          "Failed Session resource cleanup will be retried",
        );
      } finally {
        await operationLock.release();
      }
    }
  }

  private async cleanupFailedSessionResources(
    sessionId: string,
    resources?: Awaited<
      | ReturnType<RuntimeAdapter["provisionSession"]>
      | ReturnType<RuntimeAdapter["forkSession"]>
      | ReturnType<RuntimeAdapter["forkTurn"]>
    >,
  ) {
    const recorded = await this.store.allocatedSessionResources(sessionId);
    const cleanup = {
      ...recorded,
      ...resources,
      sandboxId: resources?.sandboxId ?? recorded.sandboxId,
      workspaceVolumeId:
        resources?.workspaceVolumeId ?? recorded.workspaceVolumeId,
    };
    if (!cleanup.sandboxId && !cleanup.workspaceVolumeId) return true;
    try {
      await this.runtime.deleteSessionResources(cleanup);
      return true;
    } catch (cleanupError) {
      this.logger.error(
        { sessionId, error: errorMessage(cleanupError) },
        "Failed Session resources remain journaled for retry",
      );
      return false;
    }
  }

  /**
   * Resolves a Turn whose HTTP/RPC waiter disappeared after Supervisor input
   * delivery. Only native response/thread state decides acceptance; Sandpi
   * never persists or reconstructs the prompt.
   */
  private async recoverPendingTurnSubmissions() {
    const submissions = await this.store.pendingTurnSubmissions();
    for (const stored of submissions) {
      const requestId = stored.pendingTurnRequestId;
      if (!requestId) continue;
      try {
        await this.ingestOnce(stored.id);
        let current = await this.store.decoderState(stored.id);
        if (
          current.pendingTurnRequestId !== requestId ||
          !current.pendingTurnPhase
        ) {
          continue;
        }

        const startedAt = current.pendingTurnStartedAt?.getTime() ?? 0;
        const recoveryGraceElapsed =
          Date.now() - startedAt >= TURN_SUBMISSION_RECOVERY_GRACE_MS;
        if (current.pendingTurnPhase === "prepared") {
          if (recoveryGraceElapsed) {
            await this.abandonTurnSubmission(stored.id, requestId, current);
          }
          continue;
        }
        if (current.pendingTurnPhase === "snapshot_ready") {
          const stableInputId = current.pendingTurnStableInputId;
          if (
            stableInputId &&
            (await this.runtime.hasStagedCodexMessage(current, stableInputId))
          ) {
            await this.store.markTurnSubmissionStaged(stored.id, requestId);
            current = await this.store.decoderState(stored.id);
          } else {
            if (recoveryGraceElapsed) {
              await this.abandonTurnSubmission(stored.id, requestId, current);
            }
            continue;
          }
        }

        const cachedResponse = this.takeRpcResponse(stored.id, requestId);
        if (cachedResponse) {
          const nativeTurnId = turnIdFromRpcResponse(cachedResponse);
          if (cachedResponse.error) {
            await this.abandonTurnSubmission(stored.id, requestId, current);
            continue;
          }
          if (nativeTurnId) {
            await this.acceptRecoveredTurnSubmission(
              stored.id,
              requestId,
              nativeTurnId,
              current,
            );
            continue;
          }
          // A success response whose shape is newer than this parser is not a
          // rejection. Fall through to ordered active-Turn/client-message
          // reconciliation rather than discarding an accepted native Turn.
        }

        if (current.activeNativeTurnId) {
          await this.acceptRecoveredTurnSubmission(
            stored.id,
            requestId,
            current.activeNativeTurnId,
            current,
          );
          continue;
        }

        if (!recoveryGraceElapsed) continue;

        const nativeSessionId = current.nativeSessionId;
        const clientMessageId = current.pendingTurnClientMessageId;
        if (!nativeSessionId || !clientMessageId) {
          await this.abandonTurnSubmission(stored.id, requestId, current);
          continue;
        }
        const threadReadRequestId = `thread-read-submission:${randomUUID()}`;
        const response = await this.requestCodex(stored.id, current, {
          method: "thread/read",
          id: threadReadRequestId,
          params: { threadId: nativeSessionId, includeTurns: true },
        });
        const responseBoundary = this.takeRpcResponseTransportAnchor(
          stored.id,
          threadReadRequestId,
        );
        if (response.error) {
          if (
            isMissingNativeThreadError(response.error) ||
            isUnmaterializedNativeThreadError(response.error)
          ) {
            if (
              current.pendingTurnPhase === "staged" ||
              current.pendingTurnPhase === "submitted"
            ) {
              await this.replayStagedTurnSubmission(
                stored.id,
                requestId,
                current,
              );
            }
            continue;
          }
          throw new HttpError(
            502,
            "codex_thread_read_failed",
            rpcErrorMessage(response.error),
          );
        }
        const thread = threadFromRpcResponse(response);
        const observed = await this.store.decoderState(stored.id);
        if (
          !responseBoundary ||
          !sameTransportBoundary(
            this.latestTransportBoundaries.get(stored.id),
            responseBoundary,
          ) ||
          observed.supervisorSessionId !== responseBoundary.supervisorSessionId ||
          observed.decoder.supervisorCursor !==
            responseBoundary.supervisorSequence ||
          observed.decoder.attemptId !== responseBoundary.attemptId ||
          observed.decoder.runtimeGeneration !==
            responseBoundary.runtimeGeneration ||
          observed.decoder.tailBase64 !== "" ||
          observed.nativeSessionId !== nativeSessionId ||
          observed.historyRevision !== current.historyRevision ||
          observed.pendingTurnRequestId !== requestId
        ) {
          continue;
        }
        const acceptedTurn = thread?.turns.find((turn) =>
          turn.items.some(
            (item) =>
              item.type === "userMessage" && item.clientId === clientMessageId,
          ),
        );
        if (thread?.id === nativeSessionId && acceptedTurn) {
          if (acceptedTurn.status !== "inProgress") {
            // The native Turn exists but its terminal event fell outside the
            // retained Supervisor journal. Release the Session without
            // fabricating an output checkpoint at a later Workspace state.
            const abandoned = await this.abandonTurnSubmission(
              stored.id,
              requestId,
              observed,
              observed.pendingTurnStableInputId,
              turnSubmissionProof(observed),
            );
            if (abandoned) {
              this.publishInvalidation(
                stored.id,
                "turn-checkpoint-unavailable",
                {
                  message:
                    "This native Turn completed outside the retained live-event window, so rollback and fork capability was not fabricated for it.",
                },
              );
            }
            continue;
          }
          await this.acceptRecoveredTurnSubmission(
            stored.id,
            requestId,
            acceptedTurn.id,
            observed,
          );
          continue;
        }
        if (
          observed.pendingTurnPhase === "staged" ||
          observed.pendingTurnPhase === "submitted"
        ) {
          const replayed = await this.replayStagedTurnSubmission(
            stored.id,
            requestId,
            observed,
          );
          if (replayed) continue;
        }
        if (observed.pendingTurnPhase !== "accepted") {
          await this.abandonTurnSubmission(
            stored.id,
            requestId,
            observed,
            observed.pendingTurnStableInputId,
            turnSubmissionProof(observed),
          );
        }
      } catch (error) {
        this.logger.warn(
          { sessionId: stored.id, error: errorMessage(error) },
          "Pending Codex Turn submission reconciliation will be retried",
        );
      }
    }
  }

  private async acceptRecoveredTurnSubmission(
    sessionId: string,
    requestId: string,
    nativeTurnId: string,
    runtime: StoredRuntime,
  ) {
    const accepted = await this.store.markTurnSubmissionAccepted(
      sessionId,
      requestId,
      nativeTurnId,
    );
    if (accepted && runtime.pendingTurnStableInputId) {
      await this.discardTurnDeliveryOutbox(
        sessionId,
        runtime,
        runtime.pendingTurnStableInputId,
      );
    }
    return accepted;
  }

  private async replayStagedTurnSubmission(
    sessionId: string,
    requestId: string,
    runtime: StoredRuntime,
  ) {
    const stableInputId = runtime.pendingTurnStableInputId;
    if (
      !stableInputId ||
      !(await this.runtime.hasStagedCodexMessage(runtime, stableInputId))
    ) {
      return false;
    }
    await this.runtime.dispatchStagedCodexMessage(runtime, stableInputId);
    await this.store.markTurnSubmissionDispatched(sessionId, requestId);
    this.ensureWorker(sessionId);
    return true;
  }

  private async abandonTurnSubmission(
    sessionId: string,
    requestId: string,
    runtime: StoredRuntime,
    stableInputId = runtime.pendingTurnStableInputId,
    expected?: Parameters<SandpiStore["abandonTurnSubmission"]>[2],
  ) {
    const abandoned = await this.store.abandonTurnSubmission(
      sessionId,
      requestId,
      expected,
    );
    if (abandoned?.deleteSnapshot && abandoned.snapshotId) {
      await this.runtime
        .deleteVolumeCheckpoint(runtime, abandoned.snapshotId)
        .catch((error) => {
          this.logger.warn(
            { sessionId, snapshotId: abandoned.snapshotId, error: errorMessage(error) },
            "Abandoned Turn input checkpoint cleanup will be retried with Session cleanup",
          );
        });
    }
    if (abandoned && stableInputId) {
      await this.discardTurnDeliveryOutbox(
        sessionId,
        runtime,
        stableInputId,
      );
    }
    return abandoned;
  }

  private async discardTurnDeliveryOutbox(
    sessionId: string,
    runtime: StoredRuntime,
    stableInputId: string,
  ) {
    await this.runtime
      .discardStagedCodexMessage(runtime, stableInputId)
      .catch((error) => {
        this.logger.warn(
          { sessionId, error: errorMessage(error) },
          "Codex Turn delivery outbox cleanup will be retried with Session cleanup",
        );
      });
  }

  private async recoverInterruptedTurnMutations() {
    const interrupted = await this.store.interruptedTurnMutations();
    for (const operation of interrupted) {
      if (this.mutating.has(operation.runtime.id)) continue;
      const operationLock = await this.store.acquireSessionOperationLock(
        operation.runtime.id,
      );
      if (!operationLock) continue;
      this.mutating.add(operation.runtime.id);
      let recovered = false;
      try {
        await this.stopWorker(operation.runtime.id);
        assertSessionOperationLock(operationLock);
        if (operation.phase === "prepared") {
          await this.store.releasePreparedTurnMutation(
            operation.runtime.id,
            operation.mutationId,
          );
          this.publishInvalidation(operation.runtime.id, "history-recovered");
        } else {
          await this.compensateTurnMutation(
            operation.runtime.id,
            operation.mutationId,
            operation.headSnapshotId,
            operation.originalNativeSessionId,
            operationLock,
          );
        }
        assertSessionOperationLock(operationLock);
        recovered = true;
      } catch (error) {
        this.logger.error(
          { sessionId: operation.runtime.id, error: errorMessage(error) },
          "Interrupted Turn mutation compensation will be retried",
        );
      } finally {
        this.mutating.delete(operation.runtime.id);
        try {
          await operationLock.release();
        } finally {
          if (recovered) this.ensureWorker(operation.runtime.id);
        }
      }
    }
  }

  private async mutateTurn(
    userId: string,
    sessionId: string,
    nativeTurnId: string,
    replacementInput?: ReturnType<typeof nativeCodexTurnInput>,
    replacementModelId?: string,
  ) {
    const operationLock = await this.store.acquireSessionOperationLock(sessionId);
    if (!operationLock) throw sessionOperationInProgressError();
    try {
      assertSessionOperationLock(operationLock);
      return await this.mutateTurnLocked(
        userId,
        sessionId,
        nativeTurnId,
        operationLock,
        replacementInput,
        replacementModelId,
      );
    } finally {
      await operationLock.release();
    }
  }

  private async mutateTurnLocked(
    userId: string,
    sessionId: string,
    nativeTurnId: string,
    operationLock: SessionOperationLock,
    replacementInput?: ReturnType<typeof nativeCodexTurnInput>,
    replacementModelId?: string,
  ) {
    const runtimeBeforeMutation = await this.store.getRuntime(userId, sessionId);
    if (runtimeBeforeMutation.runtimeErrorCode === "supervisor_journal_gap") {
      await this.recoverSupervisorJournalGap(sessionId, runtimeBeforeMutation);
    }
    const context = await this.store.prepareTurnMutation(
      userId,
      sessionId,
      nativeTurnId,
      replacementInput ? "edit" : "delete",
    );
    this.mutating.add(sessionId);
    await this.stopWorker(sessionId);
    let restoreRequested = false;
    let finalized = false;
    let restoredNativeSessionId: string | undefined;
    let replacementNativeTurnId: string | undefined;
    let replacementInputSnapshotRecorded = false;
    let resumeWorker = false;
    try {
      assertSessionOperationLock(operationLock);
      const originalRuntime = await this.store.getRuntime(userId, sessionId);
      if (
        originalRuntime.nativeSessionId !== context.nativeSessionId ||
        originalRuntime.workspaceVolumeId !== context.workspaceVolumeId ||
        originalRuntime.historyRevision !== context.expectedHistoryRevision
      ) {
        throw new HttpError(
          409,
          "turn_mutation_conflict",
          "The native Session changed before history restore started.",
        );
      }
      await this.store.markTurnMutationRestoreRequested(sessionId, context);
      restoreRequested = true;
      assertSessionOperationLock(operationLock);
      const recovered = await this.runtime.restoreVolumeCheckpoint(
        originalRuntime,
        context.restoreSnapshotId,
      );
      assertSessionOperationLock(operationLock);
      await this.store.setRestoredRuntime(sessionId, {
        mutationId: context.mutationId,
        nativeSessionId: context.nativeSessionId,
        ...recovered,
      });
      await this.restoreRuntimeCredential(sessionId);
      restoredNativeSessionId = await this.restoreMutationNativeSession(
        sessionId,
        await this.store.getRuntime(userId, sessionId),
        context.expectedHistoryRevision,
        context.mutationId,
        context.inputNativeHeadTurnId === undefined,
      );
      assertSessionOperationLock(operationLock);

      let requestId: string | undefined;
      if (replacementInput) {
        const replacementRuntime = await this.store.decoderState(sessionId);
        requestId = `turn-start:${randomUUID()}`;
        // The restored pre-Turn snapshot becomes the edited Turn's input too.
        // Ownership is transferred to its output checkpoint when completion is
        // ingested; finalizeTurnMutation excludes it from superseded cleanup.
        await this.store.recordPendingTurnInputSnapshot(
          sessionId,
          context.restoreSnapshotId,
        );
        replacementInputSnapshotRecorded = true;
        const response = await this.requestCodex(
          sessionId,
          replacementRuntime,
          {
            method: "turn/start",
            id: requestId,
            params: {
              threadId: restoredNativeSessionId,
              clientUserMessageId: `user-message:${randomUUID()}`,
              input: replacementInput,
              ...(replacementModelId ? { model: replacementModelId } : {}),
            },
          },
          `turn-input:${randomUUID()}`,
        );
        if (response.error) {
          throw new HttpError(
            502,
            "codex_turn_start_failed",
            rpcErrorMessage(response.error),
          );
        }
        replacementNativeTurnId = turnIdFromRpcResponse(response);
        if (!replacementNativeTurnId) {
          throw new HttpError(
            502,
            "codex_turn_start_failed",
            "Codex accepted no replacement Turn.",
          );
        }
        await this.store.markTurnMutationReplacementStarted(
          sessionId,
          context.mutationId,
          replacementNativeTurnId,
        );
      }

      const invalidated = await this.finalizeTurnMutationWithRetry(
        sessionId,
        context,
        replacementInput ? "running" : "waiting",
        replacementModelId,
        { nativeTurnId: replacementNativeTurnId },
      );
      assertSessionOperationLock(operationLock);
      finalized = true;
      const restoredRuntime = await this.store.decoderState(sessionId);
      for (const snapshotId of invalidated) {
        try {
          await this.runtime.deleteVolumeCheckpoint(restoredRuntime, snapshotId);
        } catch (error) {
          this.logger.warn(
            { sessionId, snapshotId, error: errorMessage(error) },
            "Superseded Session Volume checkpoint cleanup failed",
          );
        }
      }
      this.publishInvalidation(sessionId, "history-restored");
      resumeWorker = true;
      return { requestId };
    } catch (error) {
      if (operationLock.signal.aborted) {
        // The external restore may still be finishing after its PostgreSQL
        // connection disappeared. Do not compensate or release from an owner
        // that no longer holds the cross-replica fence; the durable mutation
        // journal stays paused for the delayed recovery owner.
        throw error;
      }
      if (replacementInputSnapshotRecorded) {
        await this.store
          .clearPendingTurnInputSnapshot(sessionId, context.restoreSnapshotId)
          .catch((cleanupError) => {
            this.logger.warn(
              { sessionId, error: errorMessage(cleanupError) },
              "Failed replacement Turn input checkpoint could not be detached",
            );
          });
      }
      if (restoreRequested && !finalized) {
        try {
          if (restoredNativeSessionId && replacementNativeTurnId) {
            await this.sendTurnInterrupt(
              sessionId,
              restoredNativeSessionId,
              replacementNativeTurnId,
            ).catch((interruptError) => {
              this.logger.warn(
                { sessionId, error: errorMessage(interruptError) },
                "Replacement Turn could not be interrupted before compensation",
              );
            });
          }
          await this.compensateTurnMutation(
            sessionId,
            context.mutationId,
            context.headSnapshotId,
            context.nativeSessionId,
            operationLock,
          );
          resumeWorker = true;
        } catch (compensationError) {
          this.logger.error(
            {
              sessionId,
              error: errorMessage(error),
              compensationError: errorMessage(compensationError),
            },
            "Turn mutation compensation remains journaled for retry",
          );
        }
      } else {
        await this.store.releasePreparedTurnMutation(
          sessionId,
          context.mutationId,
        );
        resumeWorker = true;
      }
      throw error;
    } finally {
      this.mutating.delete(sessionId);
      if (resumeWorker) this.ensureWorker(sessionId);
    }
  }

  private async compensateTurnMutation(
    sessionId: string,
    mutationId: string,
    headSnapshotId: string,
    originalNativeSessionId: string,
    operationLock: SessionOperationLock,
  ) {
    assertSessionOperationLock(operationLock);
    await this.store.markTurnMutationCompensating(sessionId, mutationId);
    const current = await this.store.decoderState(sessionId);
    assertSessionOperationLock(operationLock);
    const recovered = await this.runtime.restoreVolumeCheckpoint(
      current,
      headSnapshotId,
    );
    assertSessionOperationLock(operationLock);
    await this.store.setRestoredRuntime(sessionId, {
      mutationId,
      nativeSessionId: originalNativeSessionId,
      ...recovered,
    });
    await this.restoreRuntimeCredential(sessionId);
    await this.initializeAttempt(sessionId, { mode: "resume" });
    assertSessionOperationLock(operationLock);
    await this.store.releasePreparedTurnMutation(sessionId, mutationId, {
      clearPendingInput: true,
      expectedPhase: "compensating",
    });
    this.publishInvalidation(sessionId, "history-compensated");
  }

  private async sendTurnInterrupt(
    sessionId: string,
    nativeSessionId: string,
    nativeTurnId: string,
  ) {
    const runtime = await this.store.decoderState(sessionId);
    const requestId = `turn-interrupt:${randomUUID()}`;
    const response = await this.requestCodex(sessionId, runtime, {
      method: "turn/interrupt",
      id: requestId,
      params: { threadId: nativeSessionId, turnId: nativeTurnId },
    });
    if (response.error) {
      throw new HttpError(
        502,
        "codex_turn_interrupt_failed",
        rpcErrorMessage(response.error),
      );
    }
    return requestId;
  }

  private async finalizeTurnMutationWithRetry(
    sessionId: string,
    context: Awaited<ReturnType<SandpiStore["prepareTurnMutation"]>>,
    status: "running" | "waiting",
    modelId?: string,
    replacement?: { nativeTurnId?: string },
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.store.finalizeTurnMutation(
          sessionId,
          context,
          status,
          modelId,
          replacement,
        );
      } catch (error) {
        lastError = error;
        await delay(100 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private async restoreMutationNativeSession(
    sessionId: string,
    runtime: Awaited<ReturnType<SandpiStore["getRuntime"]>>,
    expectedHistoryRevision: number,
    mutationId: string,
    allowEmptyThreadFallback: boolean,
  ) {
    if (!runtime.nativeSessionId) {
      throw new HttpError(409, "codex_thread_not_ready", "Codex thread is not ready.");
    }
    const initialized = await this.initializeProtocol(sessionId);
    let response = await this.requestCodex(sessionId, initialized, {
      method: "thread/resume",
      id: `thread-resume-history:${randomUUID()}`,
      params: {
        threadId: runtime.nativeSessionId,
        ...(runtime.modelId ? { model: runtime.modelId } : {}),
        cwd: "/workspace",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });

    // Codex does not materialize thread/start until the first Turn writes a
    // rollout. Restoring the first Turn's input therefore has no resumable
    // native id. Starting an empty thread is the only safe exception; there is
    // no earlier native conversation to branch or discard.
    if (
      response.error &&
      allowEmptyThreadFallback &&
      isMissingNativeThreadError(response.error)
    ) {
      response = await this.requestCodex(sessionId, initialized, {
        method: "thread/start",
        id: `thread-start-empty-history:${randomUUID()}`,
        params: {
          ...(runtime.modelId ? { model: runtime.modelId } : {}),
          cwd: "/workspace",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      });
    }
    if (response.error) {
      throw new HttpError(
        502,
        "codex_thread_restore_failed",
        rpcErrorMessage(response.error),
      );
    }
    const restoredNativeSessionId = threadIdFromRpcResponse(response);
    if (!restoredNativeSessionId) {
      throw new HttpError(
        502,
        "codex_thread_restore_failed",
        "Codex did not return the restored native Session.",
      );
    }
    if (
      restoredNativeSessionId !== runtime.nativeSessionId &&
      !allowEmptyThreadFallback
    ) {
      throw new HttpError(
        502,
        "codex_thread_restore_failed",
        "Codex unexpectedly changed the native Session during history restore.",
      );
    }
    await this.store.markTurnMutationNativeSessionReady(
      sessionId,
      mutationId,
      expectedHistoryRevision,
      restoredNativeSessionId,
    );
    return restoredNativeSessionId;
  }

  private async readNativeHeadTurnId(
    sessionId: string,
    runtime: StoredRuntime,
  ) {
    if (!runtime.nativeSessionId) return undefined;
    const requestId = `thread-read-head:${randomUUID()}`;
    const response = await this.requestCodex(sessionId, runtime, {
      method: "thread/read",
      id: requestId,
      params: { threadId: runtime.nativeSessionId, includeTurns: true },
    });
    if (
      response.error &&
      (isUnmaterializedNativeThreadError(response.error) ||
        isMissingNativeThreadError(response.error))
    ) {
      return undefined;
    }
    if (response.error) {
      throw new HttpError(
        502,
        "codex_thread_read_failed",
        rpcErrorMessage(response.error),
      );
    }
    const thread = threadFromRpcResponse(response);
    if (!thread || thread.id !== runtime.nativeSessionId) {
      throw new HttpError(
        502,
        "codex_thread_read_failed",
        "Codex returned an unexpected native Session.",
      );
    }
    return thread.turns.at(-1)?.id;
  }

  /**
   * Establishes a native read barrier after the source Session is reserved.
   * The result may prove an empty Thread, but is never used to synthesize or
   * persist the child conversation; `thread/fork` remains authoritative.
   */
  private async readForkSourceThread(
    sessionId: string,
    runtime: StoredRuntime,
    operationId: string,
  ) {
    if (!runtime.nativeSessionId) {
      throw new HttpError(
        409,
        "codex_thread_not_ready",
        "Codex native Session is not ready.",
      );
    }
    const requestId = `thread-read-fork-barrier:${randomUUID()}`;
    const response = await this.requestCodex(sessionId, runtime, {
      method: "thread/read",
      id: requestId,
      params: { threadId: runtime.nativeSessionId, includeTurns: true },
    });
    if (response.error) {
      throw new HttpError(
        502,
        "codex_thread_read_failed",
        rpcErrorMessage(response.error),
      );
    }
    const thread = threadFromRpcResponse(response);
    if (!thread || thread.id !== runtime.nativeSessionId) {
      throw new HttpError(
        502,
        "codex_thread_read_failed",
        "Codex returned an unexpected native Session.",
      );
    }
    const observed = await this.store.decoderState(sessionId);
    if (
      observed.nativeSessionId !== runtime.nativeSessionId ||
      observed.historyRevision !== runtime.historyRevision ||
      observed.exclusiveOperationId !== operationId ||
      observed.activeNativeTurnId
    ) {
      throw new HttpError(
        409,
        "session_fork_conflict",
        "The source Session changed while the native fork boundary was read.",
      );
    }
    return thread;
  }

  private async requireNativeRuntime(sessionId: string) {
    const runtime = await this.store.decoderState(sessionId);
    if (!runtime.nativeSessionId) {
      throw new HttpError(
        409,
        "codex_thread_not_ready",
        "Codex native Session is not ready.",
      );
    }
    return runtime as StoredRuntime & { nativeSessionId: string };
  }

  private async initializeProtocol(
    sessionId: string,
    fence?: FencedSessionOperation,
  ) {
    if (fence) assertSessionOperationLock(fence.lock);
    let runtime = await this.store.decoderState(sessionId);
    if (fence) assertSessionOperationLock(fence.lock);
    const initializeId = `initialize:${runtime.attemptId ?? randomUUID()}`;
    const initialize = await this.requestCodex(sessionId, runtime, {
      method: "initialize",
      id: initializeId,
      params: {
        clientInfo: { name: "sandpi", title: "Sandpi", version: "0.1.0" },
      },
    });
    if (fence) assertSessionOperationLock(fence.lock);
    if (initialize.error && !isAlreadyInitializedError(initialize.error)) {
      throw new HttpError(
        502,
        "codex_initialize_failed",
        rpcErrorMessage(initialize.error),
      );
    }
    runtime = await this.store.decoderState(sessionId);
    if (fence) assertSessionOperationLock(fence.lock);
    await this.runtime.writeCodexMessage(runtime, {
      method: "initialized",
      params: {},
    });
    if (fence) assertSessionOperationLock(fence.lock);
    return runtime;
  }

  private async initializeAttempt(
    sessionId: string,
    thread: ThreadInitialization = { mode: "start" },
    fence?: FencedSessionOperation,
  ) {
    const runtime = await this.initializeProtocol(sessionId, fence);
    if (fence) assertSessionOperationLock(fence.lock);

    const threadRequestId = `thread-${thread.mode}:${randomUUID()}`;
    const method =
      thread.mode === "resume"
        ? "thread/resume"
        : thread.mode === "fork"
          ? "thread/fork"
          : "thread/start";
    const response = await this.requestCodex(sessionId, runtime, {
      method,
      id: threadRequestId,
      params: {
        ...(thread.mode === "resume" && runtime.nativeSessionId
          ? { threadId: runtime.nativeSessionId }
          : {}),
        ...(thread.mode === "fork"
          ? {
              threadId: thread.sourceNativeSessionId,
              ...(thread.lastNativeTurnId
                ? { lastTurnId: thread.lastNativeTurnId }
                : {}),
            }
          : {}),
        ...(runtime.modelId ? { model: runtime.modelId } : {}),
        cwd: "/workspace",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });
    if (fence) assertSessionOperationLock(fence.lock);
    const interruptedTurnId =
      thread.mode === "resume"
        ? interruptedTurnIdFromRpcResponse(response)
        : undefined;
    if (response.error) {
      throw new HttpError(502, "codex_thread_failed", rpcErrorMessage(response.error));
    }
    let nativeSessionId = threadIdFromRpcResponse(response);
    if (!nativeSessionId) {
      throw new HttpError(
        502,
        "codex_thread_failed",
        "Codex did not return its native Session id.",
      );
    }
    let nativeHeadTurnId = threadFromRpcResponse(response)?.turns.at(-1)?.id;
    let interruptedCanonicalized = false;

    if (
      interruptedTurnId &&
      thread.mode === "resume" &&
      (thread.canonicalizeInterruptedTurn ||
        thread.canonicalizeInterruptedTurnId !== undefined) &&
      (!thread.canonicalizeInterruptedTurnId ||
        thread.canonicalizeInterruptedTurnId === interruptedTurnId)
    ) {
      const canonicalized = await this.canonicalizeInterruptedNativeTurn(
        sessionId,
        runtime,
        nativeSessionId,
        fence,
      );
      nativeSessionId = canonicalized.nativeSessionId;
      nativeHeadTurnId = canonicalized.nativeHeadTurnId;
      interruptedCanonicalized = true;
    } else {
      const switched = await this.store.setNativeSession(
        sessionId,
        nativeSessionId,
        {
          expectedNativeSessionId: runtime.nativeSessionId,
          expectedExclusiveOperationId: fence?.operationId,
        },
      );
      if (!switched) {
        throw new HttpError(
          409,
          "codex_thread_changed",
          "The active Codex native Session changed during initialization.",
        );
      }
    }
    return {
      interruptedTurnId,
      nativeSessionId,
      nativeHeadTurnId,
      interruptedCanonicalized,
    };
  }

  private async canonicalizeInterruptedNativeTurn(
    sessionId: string,
    runtime: StoredRuntime,
    nativeSessionId: string,
    fence?: FencedSessionOperation,
  ) {
    // Forking without lastTurnId makes Codex append its canonical TurnAborted
    // item to the child. Callers discovering an unjournaled interruption must
    // durably record its Turn id before entering this native history change.
    const canonicalizeId = `thread-fork-interrupted:${randomUUID()}`;
    const canonicalized = await this.requestCodex(sessionId, runtime, {
      method: "thread/fork",
      id: canonicalizeId,
      params: {
        threadId: nativeSessionId,
        ...(runtime.modelId ? { model: runtime.modelId } : {}),
        cwd: "/workspace",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });
    if (fence) assertSessionOperationLock(fence.lock);
    if (canonicalized.error) {
      throw new HttpError(
        502,
        "codex_thread_recovery_failed",
        rpcErrorMessage(canonicalized.error),
      );
    }
    const canonicalNativeSessionId = threadIdFromRpcResponse(canonicalized);
    if (!canonicalNativeSessionId) {
      throw new HttpError(
        502,
        "codex_thread_recovery_failed",
        "Codex did not return the canonical recovery branch.",
      );
    }
    const switched = await this.store.setNativeSession(
      sessionId,
      canonicalNativeSessionId,
      {
        expectedNativeSessionId: runtime.nativeSessionId,
        incrementHistoryRevision: true,
        expectedExclusiveOperationId: fence?.operationId,
      },
    );
    if (!switched) {
      throw new HttpError(
        409,
        "codex_thread_changed",
        "The active Codex native Session changed during recovery.",
      );
    }
    return {
      nativeSessionId: canonicalNativeSessionId,
      nativeHeadTurnId: threadFromRpcResponse(canonicalized)?.turns.at(-1)?.id,
    };
  }

  private async requestCodex(
    sessionId: string,
    runtime: StoredRuntime,
    message: Record<string, unknown>,
    stableInputId?: string,
  ) {
    const requestId = message.id;
    if (typeof requestId !== "string") {
      throw new Error("A Codex RPC request must have a string id");
    }
    // Register before writing. Even an immediate Supervisor response is then
    // matched in memory and can never be lost between write and await.
    // Reused stable ids (notably initialize:<attempt>) must never consume an
    // older cached answer before the new write occurs.
    this.takeRpcResponse(sessionId, requestId);
    this.takeRpcResponseAnchor(sessionId, requestId);
    this.takeRpcResponseTransportAnchor(sessionId, requestId);
    const waiter = this.registerRpcWaiter(sessionId, requestId);
    try {
      await this.runtime.writeCodexMessage(runtime, message, stableInputId);
    } catch (error) {
      waiter.reject(error);
      return waiter.promise;
    }
    this.ensureRpcPump(sessionId, requestId);
    return waiter.promise;
  }

  /**
   * Persists the exact native Turn frame in the Session rootfs before delivery.
   * The file is a short-lived transport outbox, never a PostgreSQL transcript,
   * and stable Supervisor input ids make replay after an ambiguous crash safe.
   */
  private async requestStagedCodexTurn(
    sessionId: string,
    runtime: StoredRuntime,
    message: Record<string, unknown>,
    stableInputId: string,
  ) {
    const requestId = message.id;
    if (typeof requestId !== "string") {
      throw new Error("A Codex RPC request must have a string id");
    }
    await this.runtime.stageCodexMessage(runtime, message, stableInputId);
    try {
      await this.store.markTurnSubmissionStaged(sessionId, requestId);
    } catch (error) {
      await this.discardTurnDeliveryOutbox(sessionId, runtime, stableInputId);
      throw error;
    }

    this.takeRpcResponse(sessionId, requestId);
    this.takeRpcResponseAnchor(sessionId, requestId);
    this.takeRpcResponseTransportAnchor(sessionId, requestId);
    const waiter = this.registerRpcWaiter(sessionId, requestId);
    try {
      await this.runtime.dispatchStagedCodexMessage(runtime, stableInputId);
      await this.store.markTurnSubmissionDispatched(sessionId, requestId);
    } catch (error) {
      waiter.reject(error);
      return waiter.promise;
    }
    this.ensureRpcPump(sessionId, requestId);
    return waiter.promise;
  }

  private registerRpcWaiter(sessionId: string, requestId: string): RpcWaiter {
    const cached = this.takeRpcResponse(sessionId, requestId);
    if (cached) {
      return {
        promise: Promise.resolve(cached),
        resolve() {},
        reject() {},
      };
    }

    const key = rpcKey(sessionId, requestId);
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
          `Codex did not answer ${requestId.split(":")[0]} in time.`,
        ),
      );
    }, RPC_TIMEOUT_MS);
    timer.unref();
    const waiters = this.rpcWaiters.get(key) ?? new Set<RpcWaiter>();
    waiters.add(waiter);
    this.rpcWaiters.set(key, waiters);
    return waiter;
  }

  private ensureRpcPump(sessionId: string, requestId: string) {
    const key = rpcKey(sessionId, requestId);
    if (this.rpcPumps.has(key)) return;
    const pump = (async () => {
      while (this.rpcWaiters.has(key)) {
        await this.ingestOnce(sessionId);
        if (this.rpcWaiters.has(key)) {
          await delay(RPC_INGEST_INTERVAL_MS);
        }
      }
    })()
      .catch((error) => {
        for (const waiter of this.rpcWaiters.get(key) ?? []) {
          waiter.reject(error);
        }
      })
      .finally(() => {
        if (this.rpcPumps.get(key) === pump) this.rpcPumps.delete(key);
        // A waiter can be registered while the prior pump is unwinding.
        if (this.rpcWaiters.has(key)) this.ensureRpcPump(sessionId, requestId);
      });
    this.rpcPumps.set(key, pump);
  }

  private cacheRpcRecord(
    sessionId: string,
    message: Record<string, unknown>,
    transportBoundary: RpcTransportBoundary,
  ) {
    const id = message.id;
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      (message.result === undefined && message.error === undefined)
    ) {
      return;
    }
    const requestId = String(id);
    const anchors =
      this.rpcResponseAnchors.get(sessionId) ?? new Map<string, number>();
    anchors.delete(requestId);
    anchors.set(requestId, this.liveCursor(sessionId));
    while (anchors.size > MAX_RPC_RESPONSES_PER_SESSION) {
      const oldest = anchors.keys().next().value;
      if (oldest === undefined) break;
      anchors.delete(oldest);
    }
    this.rpcResponseAnchors.set(sessionId, anchors);

    const transportAnchors =
      this.rpcResponseTransportAnchors.get(sessionId) ??
      new Map<string, RpcTransportBoundary>();
    transportAnchors.delete(requestId);
    transportAnchors.set(requestId, transportBoundary);
    while (transportAnchors.size > MAX_RPC_RESPONSES_PER_SESSION) {
      const oldest = transportAnchors.keys().next().value;
      if (oldest === undefined) break;
      transportAnchors.delete(oldest);
    }
    this.rpcResponseTransportAnchors.set(sessionId, transportAnchors);

    const responses =
      this.rpcResponses.get(sessionId) ??
      new Map<string, Record<string, unknown>>();
    responses.delete(requestId);
    responses.set(requestId, message);
    while (responses.size > MAX_RPC_RESPONSES_PER_SESSION) {
      const oldest = responses.keys().next().value;
      if (oldest === undefined) break;
      responses.delete(oldest);
    }
    this.rpcResponses.set(sessionId, responses);

    const key = rpcKey(sessionId, requestId);
    const waiters = [...(this.rpcWaiters.get(key) ?? [])];
    if (waiters.length > 0) {
      responses.delete(requestId);
      for (const waiter of waiters) waiter.resolve(message);
    }
  }

  private takeRpcResponse(sessionId: string, requestId: string) {
    const responses = this.rpcResponses.get(sessionId);
    const response = responses?.get(requestId);
    if (!response) return undefined;
    responses?.delete(requestId);
    if (responses?.size === 0) this.rpcResponses.delete(sessionId);
    return response;
  }

  private takeRpcResponseAnchor(sessionId: string, requestId: string) {
    const anchors = this.rpcResponseAnchors.get(sessionId);
    const cursor = anchors?.get(requestId);
    if (cursor === undefined) return undefined;
    anchors?.delete(requestId);
    if (anchors?.size === 0) this.rpcResponseAnchors.delete(sessionId);
    return cursor;
  }

  private takeRpcResponseTransportAnchor(
    sessionId: string,
    requestId: string,
  ) {
    const anchors = this.rpcResponseTransportAnchors.get(sessionId);
    const boundary = anchors?.get(requestId);
    if (!boundary) return undefined;
    anchors?.delete(requestId);
    if (anchors?.size === 0) {
      this.rpcResponseTransportAnchors.delete(sessionId);
    }
    return boundary;
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
    trimLiveUpdates(state.updates);
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
    // Nothing before a history reset can be safely applied to a new native
    // snapshot. Keep only the invalidation marker while preserving the cursor.
    state.updates = [
      {
        cursor: state.cursor,
        kind: "invalidation",
        reason,
        ...options,
      },
    ];
    this.live.set(sessionId, state);
    this.events.emit(sessionId);
  }

  private async runWorker(sessionId: string, signal: AbortSignal) {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const before = await this.store.decoderState(sessionId);
        if (
          before.exclusiveOperationId ||
          before.desiredState !== "running" ||
          before.runtimeErrorCode === "native_session_unrecoverable" ||
          before.runtimeErrorCode === "session_allocation_unrecoverable"
        ) {
          return;
        }
        if (before.runtimeErrorCode === "supervisor_journal_gap") {
          await this.recoverSupervisorJournalGap(sessionId, before);
          consecutiveFailures = 0;
          continue;
        }
        if (
          before.provisioningError ||
          (await this.store.recoveredTurnInterruptionClaim?.(sessionId))
        ) {
          await this.recoverRuntime(sessionId, before);
          consecutiveFailures = 0;
          continue;
        }
        const records = await this.ingestOnce(sessionId);
        const after = await this.store.decoderState(sessionId);
        consecutiveFailures = 0;
        if (after.provisioningError) {
          await this.recoverRuntime(sessionId, after);
          continue;
        }
        if (turnCompleted(records)) {
          await this.captureRuntimeCredential(sessionId, after);
          this.events.emit(`${sessionId}:turn-completed`);
        }
        await this.retryFailedTurnCheckpoint(sessionId);
      } catch (error) {
        if (isSupervisorJournalGapError(error)) {
          try {
            await this.recoverSupervisorJournalGap(sessionId);
            consecutiveFailures = 0;
            continue;
          } catch (recoveryError) {
            error = recoveryError;
          }
        }
        if (
          isMissingNativeThreadError(error) ||
          isSessionAllocationUnrecoverableError(error)
        ) {
          this.logger.error(
            { sessionId, error: errorMessage(error) },
            "Codex worker stopped because its native Session is unrecoverable",
          );
          return;
        }
        if (isRecoverableCodexRuntimeError(error)) {
          try {
            await this.recoverRuntime(sessionId);
            consecutiveFailures = 0;
            continue;
          } catch (recoveryError) {
            error = recoveryError;
          }
        }
        if (isSessionAllocationUnrecoverableError(error)) return;
        consecutiveFailures += 1;
        const fields = {
          sessionId,
          error: errorMessage(error),
          consecutiveFailures,
        };
        if (
          consecutiveFailures === 1 ||
          consecutiveFailures === 5 ||
          consecutiveFailures % 12 === 0
        ) {
          this.logger.error(fields, "Codex event ingestion failed");
        } else {
          this.logger.debug(fields, "Codex event ingestion retry deferred");
        }
      }
      const interval = this.options.ingestIntervalMs ?? INGEST_INTERVAL_MS;
      await delay(
        Math.min(interval * Math.max(consecutiveFailures, 1), MAX_INGEST_RETRY_MS),
        signal,
      );
    }
  }

  private async recoverSupervisorJournalGap(
    sessionId: string,
    _expected?: StoredRuntime,
  ) {
    void _expected;
    let current = await this.store.decoderState(sessionId);
    if (current.runtimeErrorCode !== "supervisor_journal_gap") return current;
    if (!current.nativeSessionId) {
      throw new HttpError(
        409,
        "codex_thread_not_ready",
        "Codex native Session is not ready.",
      );
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestId = `thread-read-journal-gap:${randomUUID()}`;
      const response = await this.requestCodex(sessionId, current, {
        method: "thread/read",
        id: requestId,
        params: { threadId: current.nativeSessionId, includeTurns: true },
      });
      const responseBoundary = this.takeRpcResponseTransportAnchor(
        sessionId,
        requestId,
      );
      if (response.error) {
        throw new HttpError(
          502,
          "codex_thread_read_failed",
          rpcErrorMessage(response.error),
        );
      }
      const thread = threadFromRpcResponse(response);
      if (!thread || thread.id !== current.nativeSessionId) {
        throw new HttpError(
          502,
          "codex_thread_read_failed",
          "Codex returned an unexpected native Session.",
        );
      }
      const observed = await this.store.decoderState(sessionId);
      // Gap recovery suppresses live publication, so the proof boundary must
      // use native record coordinates rather than the client live cursor. The
      // durable cursor and process-local record boundary together detect both
      // later Supervisor events and a suffix in the same output chunk.
      if (
        !responseBoundary ||
        !sameTransportBoundary(
          this.latestTransportBoundaries.get(sessionId),
          responseBoundary,
        ) ||
        observed.supervisorSessionId !== responseBoundary.supervisorSessionId ||
        observed.decoder.supervisorCursor !==
          responseBoundary.supervisorSequence ||
        observed.decoder.attemptId !== responseBoundary.attemptId ||
        observed.decoder.runtimeGeneration !==
          responseBoundary.runtimeGeneration ||
        observed.decoder.tailBase64 !== "" ||
        observed.nativeSessionId !== current.nativeSessionId ||
        observed.historyRevision !== current.historyRevision
      ) {
        current = observed;
        continue;
      }
      const activeNativeTurnId = thread.turns.find(
        (turn) => turn.status === "inProgress",
      )?.id;
      const reconciled = await this.store.reconcileSupervisorJournalGap(
        sessionId,
        {
          nativeSessionId: current.nativeSessionId,
          expectedHistoryRevision: observed.historyRevision,
          expectedVersion: observed.version,
          expectedSupervisorSessionId: responseBoundary.supervisorSessionId,
          expectedSupervisorCursor: responseBoundary.supervisorSequence,
          expectedAttemptId: responseBoundary.attemptId,
          expectedRuntimeGeneration: responseBoundary.runtimeGeneration,
          activeNativeTurnId,
          nativeHistoryMaterialized: thread.turns.length > 0,
        },
      );
      const latest = await this.store.decoderState(sessionId);
      if (reconciled) {
        this.publishInvalidation(sessionId, "supervisor-journal-reconciled", {
          message:
            "Native Codex history was reloaded after a live-event retention gap. Missing checkpoint capability was not reconstructed.",
        });
        return latest;
      }
      if (latest.runtimeErrorCode !== "supervisor_journal_gap") return latest;
      current = latest;
    }
    throw new HttpError(
      409,
      "supervisor_journal_gap_busy",
      "Codex kept changing while its retained event journal was reconciled.",
    );
  }

  private recoverRuntime(
    sessionId: string,
    expected?: StoredRuntime,
  ): Promise<StoredRuntime> {
    const active = this.recovering.get(sessionId);
    if (active) return active;
    const recovery = this.performFencedRuntimeRecovery(
      sessionId,
      expected,
    ).finally(() => {
      if (this.recovering.get(sessionId) === recovery) {
        this.recovering.delete(sessionId);
      }
    });
    this.recovering.set(sessionId, recovery);
    return recovery;
  }

  private async performFencedRuntimeRecovery(
    sessionId: string,
    expected?: StoredRuntime,
  ) {
    const operationLock = await this.store.acquireSessionOperationLock(sessionId);
    if (!operationLock) throw sessionOperationInProgressError();
    let operationId: string | undefined;
    try {
      assertSessionOperationLock(operationLock);
      const current = await this.store.decoderState(sessionId);
      assertSessionOperationLock(operationLock);
      if (
        expected &&
        current.supervisorSessionId !== expected.supervisorSessionId
      ) {
        return current;
      }
      if (current.exclusiveOperationId || current.desiredState !== "running") {
        throw sessionOperationInProgressError();
      }
      operationId = await this.store.reserveRuntimeRecovery(
        sessionId,
        current.supervisorSessionId,
      );
      assertSessionOperationLock(operationLock);
      if (!operationId) throw sessionOperationInProgressError();
      return await this.performRuntimeRecovery(sessionId, current, {
        operationId,
        lock: operationLock,
      });
    } finally {
      // Losing the connection also loses the cross-replica advisory fence. Keep
      // the durable owner in that case so takeover waits out the external-call
      // safety window instead of racing a still-running Sandbox0 request.
      try {
        if (operationId && !operationLock.signal.aborted) {
          await this.store.releaseSessionOperation(sessionId, operationId);
        }
      } finally {
        await operationLock.release();
      }
    }
  }

  private async performRuntimeRecovery(
    sessionId: string,
    expected: StoredRuntime,
    fence: FencedSessionOperation,
  ) {
    assertSessionOperationLock(fence.lock);
    let current = await this.store.decoderState(sessionId);
    assertSessionOperationLock(fence.lock);
    if (
      current.activeNativeTurnId ||
      current.pendingTurnNativeTurnId ||
      current.pendingTurnPhase ||
      current.pendingInterruptedNativeTurnId
    ) {
      // Drain the old Supervisor epoch before replacing it. A terminal event
      // already committed by Codex must win over stale active-Turn control
      // state; otherwise recovery could misclassify a completed Turn as an
      // interruption and fork the wrong native branch.
      await this.ingestOnce(sessionId).catch(() => []);
      assertSessionOperationLock(fence.lock);
      current = await this.store.decoderState(sessionId);
      assertSessionOperationLock(fence.lock);
    }
    const unresolvedTurnBeforeRecovery = Boolean(
      current.activeNativeTurnId ||
        current.pendingTurnNativeTurnId ||
        current.pendingTurnPhase ||
        current.pendingInterruptedNativeTurnId,
    );
    const projectedTurnBeforeRecovery =
      current.pendingInterruptedNativeTurnId ??
      current.activeNativeTurnId ??
      current.pendingTurnNativeTurnId;
    if (
      current.supervisorSessionId !== expected.supervisorSessionId
    ) {
      return current;
    }

    let authJson: string;
    try {
      authJson = await this.runtime.readCodexSessionCredential(current);
      assertSessionOperationLock(fence.lock);
      const authoritative = await this.credentials.syncCredentialFromRuntime(
        sessionId,
        authJson,
      );
      assertSessionOperationLock(fence.lock);
      if (authoritative) authJson = authoritative.authJson;
    } catch (error) {
      if (fence.lock.signal.aborted) throw error;
      authJson = (await this.credentials.credentialForRuntime(sessionId)).authJson;
      assertSessionOperationLock(fence.lock);
    }

    let replaced = false;
    let interruptedCanonicalized = false;
    let recoveryCoordinates:
      | { supervisorSessionId: string; attemptId: string }
      | undefined;
    try {
      if (
        !(await this.store.touchSessionOperation(
          sessionId,
          fence.operationId,
        ))
      ) {
        throw sessionOperationInProgressError();
      }
      assertSessionOperationLock(fence.lock);
      const recovered = await this.runtime.recoverCodexRuntime(current, authJson);
      assertSessionOperationLock(fence.lock);
      recoveryCoordinates = recovered;
      const runtimeReplaced =
        recovered.supervisorSessionId !== current.supervisorSessionId ||
        recovered.attemptId !== current.attemptId;
      const needsInitialization =
        Boolean(current.provisioningError) ||
        runtimeReplaced;
      replaced = await this.store.replaceRecoveredCodexRuntime(
        sessionId,
        fence.operationId,
        current.supervisorSessionId,
        recovered,
      );
      assertSessionOperationLock(fence.lock);
      if (!replaced) return this.store.decoderState(sessionId);

      let interruptedTurnId =
        await this.store.recoveredTurnInterruptionClaim(sessionId);
      if (
        !interruptedTurnId &&
        projectedTurnBeforeRecovery &&
        needsInitialization
      ) {
        interruptedTurnId = projectedTurnBeforeRecovery;
        const recorded = await this.store.recordRecoveredTurnInterruption(
          sessionId,
          fence.operationId,
          recovered.supervisorSessionId,
          recovered.attemptId,
          interruptedTurnId,
        );
        assertSessionOperationLock(fence.lock);
        if (!recorded) return this.store.decoderState(sessionId);
      }

      const materialized = await this.credentials.credentialForRuntime(sessionId);
      assertSessionOperationLock(fence.lock);
      await this.credentials.markCredentialMaterialized(sessionId, materialized);
      assertSessionOperationLock(fence.lock);
      if (needsInitialization) {
        const initialized = await this.initializeAttempt(
          sessionId,
          current.nativeSessionId
              ? {
                mode: "resume",
                canonicalizeInterruptedTurn:
                  unresolvedTurnBeforeRecovery && Boolean(interruptedTurnId),
                canonicalizeInterruptedTurnId: interruptedTurnId,
              }
            : { mode: "start" },
          fence,
        );
        if (
          initialized.interruptedTurnId &&
          interruptedTurnId &&
          initialized.interruptedTurnId !== interruptedTurnId
        ) {
          throw new HttpError(
            409,
            "codex_recovery_turn_conflict",
            "Codex resumed a different interrupted Turn than Sandpi had journaled.",
          );
        }
        if (initialized.interruptedTurnId && !interruptedTurnId) {
          interruptedTurnId = initialized.interruptedTurnId;
          const recorded = await this.store.recordRecoveredTurnInterruption(
            sessionId,
            fence.operationId,
            recovered.supervisorSessionId,
            recovered.attemptId,
            interruptedTurnId,
          );
          assertSessionOperationLock(fence.lock);
          if (!recorded) return this.store.decoderState(sessionId);
        }
        interruptedCanonicalized = initialized.interruptedCanonicalized;
        if (
          unresolvedTurnBeforeRecovery &&
          initialized.interruptedTurnId &&
          !initialized.interruptedCanonicalized
        ) {
          if (
            !(await this.store.touchSessionOperation(
              sessionId,
              fence.operationId,
            ))
          ) {
            throw sessionOperationInProgressError();
          }
          assertSessionOperationLock(fence.lock);
          const runtimeBeforeCanonicalization =
            await this.store.decoderState(sessionId);
          assertSessionOperationLock(fence.lock);
          await this.canonicalizeInterruptedNativeTurn(
            sessionId,
            runtimeBeforeCanonicalization,
            initialized.nativeSessionId,
            fence,
          );
          interruptedCanonicalized = true;
        }
      }
      if (interruptedTurnId) {
        await this.finalizeInterruptedTurnRecovery(
          sessionId,
          interruptedTurnId,
          recovered.supervisorSessionId,
          recovered.attemptId,
          fence,
        );
      }
      const markedReady = await this.store.markRecoveredCodexRuntimeReady(
        sessionId,
        fence.operationId,
        recovered.supervisorSessionId,
        recovered.attemptId,
      );
      assertSessionOperationLock(fence.lock);
      if (!markedReady) return this.store.decoderState(sessionId);
      const ready = await this.store.decoderState(sessionId);
      if (needsInitialization) {
        this.publishInvalidation(
          sessionId,
          interruptedCanonicalized
            ? "interrupted-turn-canonicalized"
            : "runtime-recovered",
        );
      }
      this.logger.debug(
        {
          sessionId,
          supervisorSessionId: ready.supervisorSessionId,
          attemptId: ready.attemptId,
          sandboxRestarted: recovered.sandboxRestarted,
        },
        "Codex runtime recovered",
      );
      return ready;
    } catch (error) {
      if (fence.lock.signal.aborted) throw error;
      if (replaced && recoveryCoordinates) {
        await this.store
          .markRecoveredCodexRuntimeFailed(
            sessionId,
            fence.operationId,
            recoveryCoordinates.supervisorSessionId,
            recoveryCoordinates.attemptId,
            errorMessage(error),
          )
          .catch(() => undefined);
      }
      const unrecoverable = isMissingNativeThreadError(error);
      const allocationLost = isMissingSessionSandboxError(error);
      if (allocationLost) {
        await this.store
          .markSessionAllocationUnrecoverable(
            sessionId,
            errorMessage(error),
            fence.operationId,
          )
          .catch(() => undefined);
      } else if (unrecoverable) {
        await this.store
          .markNativeSessionUnrecoverable(
            sessionId,
            errorMessage(error),
            fence.operationId,
          )
          .catch(() => undefined);
      }
      this.publishInvalidation(
        sessionId,
        allocationLost
          ? "session-allocation-unrecoverable"
          : unrecoverable
            ? "native-session-unrecoverable"
            : "runtime-recovery-failed",
        {
          message: allocationLost
            ? sessionAllocationUnrecoverableError().message
            : unrecoverable
              ? "The native Codex Session is no longer available."
              : "The Codex runtime could not be recovered.",
          unrecoverable: unrecoverable || allocationLost,
        },
      );
      if (allocationLost) throw sessionAllocationUnrecoverableError();
      throw error;
    }
  }

  private async finalizeInterruptedTurnRecovery(
    sessionId: string,
    turnId: string,
    supervisorSessionId: string,
    attemptId: string,
    fence: FencedSessionOperation,
  ) {
    assertSessionOperationLock(fence.lock);
    const runtime = await this.requireNativeRuntime(sessionId);
    assertSessionOperationLock(fence.lock);
    if (
      !(await this.store.touchSessionOperation(sessionId, fence.operationId))
    ) {
      throw sessionOperationInProgressError();
    }
    assertSessionOperationLock(fence.lock);
    const checkpointReady = await this.captureVolumeCheckpoint(sessionId, {
      label: `turn-interrupted-${turnId.slice(-12)}`,
      nativeSessionId: runtime.nativeSessionId,
      nativeTurnId: turnId,
      nativeHeadTurnId: turnId,
    });
    assertSessionOperationLock(fence.lock);
    if (!checkpointReady) {
      throw new HttpError(
        502,
        "interrupted_turn_checkpoint_failed",
        "The interrupted Codex Turn checkpoint could not be created.",
      );
    }
    await this.store.markRecoveredTurnInterrupted(
      sessionId,
      fence.operationId,
      supervisorSessionId,
      attemptId,
      turnId,
    );
    this.logger.warn(
      { sessionId, turnId },
      "In-flight Codex Turn was interrupted by runtime recovery",
    );
  }

  private async restoreRuntimeCredential(sessionId: string) {
    const runtime = await this.store.decoderState(sessionId);
    let authJson: string;
    try {
      authJson = await this.runtime.readCodexSessionCredential(runtime);
      const authoritative = await this.credentials.syncCredentialFromRuntime(
        sessionId,
        authJson,
      );
      if (authoritative) authJson = authoritative.authJson;
    } catch {
      const credential = await this.credentials.credentialForRuntime(sessionId);
      authJson = credential.authJson;
    }
    await this.runtime.installCodexSessionCredential(runtime, authJson);
    const materialized = await this.credentials.credentialForRuntime(sessionId);
    await this.credentials.markCredentialMaterialized(sessionId, materialized);
  }

  /**
   * Lazily upgrades a legacy rootfs-backed native Session before the next
   * state-changing operation. Historical v1 Volume snapshots cannot be made
   * rewindable after the fact, so the migration creates one verified v2 head
   * baseline and retires their checkpoint capability without copying history
   * into PostgreSQL.
   */
  private async ensureWorkspaceNativeState(
    sessionId: string,
    current: StoredRuntime,
  ) {
    if (current.harnessStateLayout === "workspace_v2") return current;

    const active = this.nativeStateMigrations.get(sessionId);
    if (active) return active;
    const migration = this.performWorkspaceNativeStateMigration(
      sessionId,
      current,
    ).finally(() => {
      if (this.nativeStateMigrations.get(sessionId) === migration) {
        this.nativeStateMigrations.delete(sessionId);
      }
    });
    this.nativeStateMigrations.set(sessionId, migration);
    return migration;
  }

  /** Periodically resumes durable `migrating` rows without delaying startup. */
  private recoverNativeStateMigrations() {
    if (this.nativeMigrationRecovery) return this.nativeMigrationRecovery;
    const recovery = this.performNativeStateMigrationRecovery().finally(() => {
      if (this.nativeMigrationRecovery === recovery) {
        this.nativeMigrationRecovery = undefined;
      }
    });
    this.nativeMigrationRecovery = recovery;
    return recovery;
  }

  private async performNativeStateMigrationRecovery() {
    const runtimes = await this.store.migratingNativeStateRuntimes();
    for (const runtime of runtimes) {
      try {
        await this.ensureWorkspaceNativeState(runtime.id, runtime);
      } catch (error) {
        this.logger.warn(
          { sessionId: runtime.id, error: errorMessage(error) },
          "Native-state migration recovery will be retried",
        );
      }
    }
  }

  private async performWorkspaceNativeStateMigration(
    sessionId: string,
    current: StoredRuntime,
  ) {
    const operationLock = await this.store.acquireSessionOperationLock(sessionId);
    if (!operationLock) {
      throw new HttpError(
        409,
        "native_state_migration_conflict",
        "Another Sandpi server is migrating this native Session.",
      );
    }
    let operationId: string | undefined;
    try {
      assertSessionOperationLock(operationLock);
      if (current.harnessStateLayout === "workspace_v2") return current;

      await this.stopWorker(sessionId);
      assertSessionOperationLock(operationLock);
      operationId = `operation_${randomUUID()}`;
      const legacy = await this.store.beginNativeStateMigration(
        sessionId,
        operationId,
      );
      assertSessionOperationLock(operationLock);
      if (!legacy) {
        operationId = undefined;
        const refreshed = await this.store.decoderState(sessionId);
        if (refreshed.harnessStateLayout === "workspace_v2") {
          this.ensureWorker(sessionId);
          return refreshed;
        }
        throw new HttpError(
          409,
          "native_state_migration_conflict",
          "The native Session state migration is already in progress.",
        );
      }

      return await this.performClaimedWorkspaceNativeStateMigration(
        sessionId,
        legacy,
        { operationId, lock: operationLock },
      );
    } finally {
      try {
        if (operationId && !operationLock.signal.aborted) {
          await this.store.releaseSessionOperation(sessionId, operationId);
        }
      } finally {
        await operationLock.release();
      }
    }
  }

  private async performClaimedWorkspaceNativeStateMigration(
    sessionId: string,
    legacy: StoredRuntime,
    fence: FencedSessionOperation,
  ) {
    let completed = false;
    try {
      assertSessionOperationLock(fence.lock);
      if (!legacy.nativeSessionId) {
        throw new HttpError(
          409,
          "native_state_migration_conflict",
          "The legacy native Session is not initialized.",
        );
      }
      const credential = await this.credentials.credentialForRuntime(sessionId);
      assertSessionOperationLock(fence.lock);
      if (
        !(await this.store.touchSessionOperation(
          sessionId,
          fence.operationId,
        ))
      ) {
        throw sessionOperationInProgressError();
      }
      assertSessionOperationLock(fence.lock);
      const migrated = await this.runtime.migrateCodexNativeState(
        legacy,
        credential.authJson,
      );
      assertSessionOperationLock(fence.lock);
      await this.store.setNativeStateMigrationRuntime(
        sessionId,
        fence.operationId,
        {
          nativeSessionId: legacy.nativeSessionId,
          workspaceVolumeId: legacy.workspaceVolumeId,
          supervisorSessionId: migrated.supervisorSessionId,
          attemptId: migrated.attemptId,
          runtimeGeneration: migrated.runtimeGeneration,
        },
      );
      assertSessionOperationLock(fence.lock);
      await this.credentials.markCredentialMaterialized(sessionId, credential);
      assertSessionOperationLock(fence.lock);

      let initialized;
      try {
        initialized = await this.initializeAttempt(
          sessionId,
          legacy.nativeSessionId ? { mode: "resume" } : { mode: "start" },
          fence,
        );
      } catch (error) {
        if (!legacy.nativeSessionId || !isMissingNativeThreadError(error)) {
          throw error;
        }
        if (migrated.sourceHadRollout || legacy.nativeHistoryMaterialized) {
          // A copied rollout that temporarily cannot be resumed is not an empty
          // Session. Starting a replacement Thread here would silently discard
          // the harness-authoritative conversation and then bless that loss in
          // the v2 baseline, so leave the durable migration retryable instead.
          throw error;
        }
        initialized = await this.initializeAttempt(
          sessionId,
          { mode: "start" },
          fence,
        );
      }
      const migratedRuntime = await this.store.decoderState(sessionId);
      assertSessionOperationLock(fence.lock);
      const nativeHeadTurnId = await this.readNativeHeadTurnId(
        sessionId,
        migratedRuntime,
      );
      assertSessionOperationLock(fence.lock);

      const baselineLabel = nativeStateMigrationSnapshotLabel(
        sessionId,
        migratedRuntime.historyRevision,
      );
      let baselineSnapshotId = migratedRuntime.nativeStateMigrationSnapshotId;
      if (!baselineSnapshotId) {
        if (
          !(await this.store.touchSessionOperation(
            sessionId,
            fence.operationId,
          ))
        ) {
          throw sessionOperationInProgressError();
        }
        assertSessionOperationLock(fence.lock);
        const discovered = await this.runtime.findVolumeCheckpoint(
          migratedRuntime,
          baselineLabel,
        );
        assertSessionOperationLock(fence.lock);
        const baseline =
          discovered ??
          (await this.runtime.createVolumeCheckpoint(
            migratedRuntime,
            baselineLabel,
          ));
        assertSessionOperationLock(fence.lock);
        baselineSnapshotId = baseline.snapshotId;
        await this.store.recordNativeStateMigrationSnapshot(
          sessionId,
          fence.operationId,
          migratedRuntime.historyRevision,
          baselineSnapshotId,
        );
        assertSessionOperationLock(fence.lock);
      }

      let supersededSnapshots: string[];
      try {
        supersededSnapshots = await this.store.completeNativeStateMigration(
          sessionId,
          fence.operationId,
          {
            nativeSessionId: initialized.nativeSessionId,
            workspaceVolumeId: migratedRuntime.workspaceVolumeId,
            expectedHistoryRevision: migratedRuntime.historyRevision,
            headSnapshotId: baselineSnapshotId,
            nativeHeadTurnId,
          },
        );
      } catch (error) {
        // A transaction can commit even if its response is lost. Confirm the
        // durable layout before retrying so a successful migration never
        // creates a second baseline or rewrites history twice.
        const committed = await this.store.decoderState(sessionId);
        if (
          committed.harnessStateLayout !== "workspace_v2" ||
          committed.headVolumeSnapshotId !== baselineSnapshotId
        ) {
          throw error;
        }
        supersededSnapshots = [];
      }
      completed = true;

      if (!fence.lock.signal.aborted) {
        await this.runtime.cleanupLegacyCodexNativeState(legacy).catch((error) => {
          this.logger.warn(
            { sessionId, error: errorMessage(error) },
            "Legacy Codex native state cleanup will be retried with Session cleanup",
          );
        });
      }
      for (const snapshotId of supersededSnapshots) {
        if (snapshotId === baselineSnapshotId || fence.lock.signal.aborted) {
          continue;
        }
        await this.runtime
          .deleteVolumeCheckpoint(migratedRuntime, snapshotId)
          .catch((error) => {
            this.logger.warn(
              { sessionId, snapshotId, error: errorMessage(error) },
              "Legacy Turn checkpoint cleanup failed",
            );
          });
      }
      this.publishInvalidation(sessionId, "native-state-migrated");
      const ready = await this.store.decoderState(sessionId);
      this.ensureWorker(sessionId);
      return ready;
    } catch (error) {
      if (!fence.lock.signal.aborted) {
        await this.store
          .failNativeStateMigration(
            sessionId,
            fence.operationId,
            errorMessage(error),
          )
          .catch(() => undefined);
      }
      throw error;
    } finally {
      if (!completed) this.workers.delete(sessionId);
    }
  }

  private async captureRuntimeCredential(
    sessionId: string,
    runtime: Awaited<ReturnType<SandpiStore["decoderState"]>>,
  ) {
    try {
      const authJson = await this.runtime.readCodexSessionCredential(runtime);
      const authoritative = await this.credentials.syncCredentialFromRuntime(
        sessionId,
        authJson,
      );
      if (authoritative) {
        await this.runtime.installCodexSessionCredential(
          runtime,
          authoritative.authJson,
        );
        await this.credentials.markCredentialMaterialized(
          sessionId,
          authoritative,
        );
      }
    } catch (error) {
      this.logger.warn(
        { sessionId, error: errorMessage(error) },
        "Codex runtime credential could not be synchronized",
      );
    }
  }

  private captureVolumeCheckpoint(
    sessionId: string,
    input: {
      label: string;
      nativeSessionId: string;
      nativeTurnId?: string;
      nativeHeadTurnId?: string;
    },
  ) {
    const key = `${sessionId}:${input.nativeSessionId}:${input.nativeTurnId ?? "baseline"}`;
    const running = this.checkpointing.get(key);
    if (running) return running;

    const checkpoint = (async () => {
      const claim = await this.store.claimTurnCheckpoint(sessionId, input);
      if (claim.state === "ready") return true;
      if (claim.state === "creating") return false;
      let snapshotId: string | undefined;
      try {
        const runtime = await this.store.decoderState(sessionId);
        const snapshot = await this.runtime.createVolumeCheckpoint(
          runtime,
          `sandpi-${input.label}-${claim.ordinal}`,
        );
        snapshotId = snapshot.snapshotId;
        await this.store.completeTurnCheckpoint(claim.id, snapshot.snapshotId);
        return true;
      } catch (error) {
        if (snapshotId) {
          // COMMIT can succeed even when PostgreSQL loses the response. Read
          // the durable checkpoint before deleting the snapshot, otherwise a
          // transient connection failure can leave a ready checkpoint pointing
          // at data that Sandpi just removed.
          const committed = await this.reconcileTurnCheckpointCommit(
            sessionId,
            claim.id,
            snapshotId,
            error,
          );
          if (committed) {
            this.logger.warn(
              { sessionId, snapshotId, error: errorMessage(error) },
              "Session Volume checkpoint commit succeeded after its response was lost",
            );
            return true;
          }
          const runtime = await this.store.decoderState(sessionId).catch(() => undefined);
          if (runtime) {
            await this.runtime
              .deleteVolumeCheckpoint(runtime, snapshotId)
              .catch((cleanupError) => {
                this.logger.warn(
                  { sessionId, snapshotId, error: errorMessage(cleanupError) },
                  "Uncommitted Session Volume checkpoint cleanup failed",
                );
              });
          }
        }
        await this.store.failTurnCheckpoint(claim.id, errorMessage(error));
        this.logger.error(
          {
            sessionId,
            nativeTurnId: input.nativeTurnId,
            error: errorMessage(error),
          },
          "Session Volume Turn checkpoint failed",
        );
        return false;
      }
    })().finally(() => {
      this.checkpointing.delete(key);
    });
    this.checkpointing.set(key, checkpoint);
    return checkpoint;
  }

  private async reconcileTurnCheckpointCommit(
    sessionId: string,
    checkpointId: string,
    snapshotId: string,
    commitError: unknown,
  ) {
    let attempts = 0;
    let lastError = commitError;
    while (!this.closed) {
      try {
        return await this.store.reconcileTurnCheckpointCommit(
          checkpointId,
          snapshotId,
        );
      } catch (error) {
        attempts += 1;
        lastError = error;
        const fields = {
          sessionId,
          snapshotId,
          commitError: errorMessage(commitError),
          verificationError: errorMessage(error),
          attempts,
        };
        if (attempts === 1 || attempts === 5 || attempts % 12 === 0) {
          this.logger.error(
            fields,
            "Session Volume checkpoint commit outcome could not be verified",
          );
        } else {
          this.logger.debug(
            fields,
            "Session Volume checkpoint commit verification retry deferred",
          );
        }
        const interval = this.options.ingestIntervalMs ?? INGEST_INTERVAL_MS;
        await delay(
          Math.min(interval * attempts, MAX_INGEST_RETRY_MS),
          this.closeController.signal,
        );
      }
    }
    throw lastError;
  }

  private async retryFailedTurnCheckpoint(sessionId: string) {
    const checkpoints = await this.store.retryableTurnCheckpoints(sessionId);
    const checkpoint = checkpoints[0];
    if (!checkpoint) return;
    const ready = await this.captureVolumeCheckpoint(sessionId, {
      label: `turn-${checkpoint.nativeTurnId.slice(-12)}`,
      nativeSessionId: checkpoint.nativeSessionId,
      nativeTurnId: checkpoint.nativeTurnId,
      nativeHeadTurnId: checkpoint.nativeHeadTurnId,
    });
    if (ready) {
      const latest = await this.store.decoderState(sessionId);
      if (!latest.activeNativeTurnId) {
        await this.store.markSessionTurnCompleted(sessionId);
      }
      this.publishInvalidation(sessionId, "checkpoint-ready");
    }
  }

  private async ensureCurrentRuntimeCredential(
    sessionId: string,
    runtime: Awaited<ReturnType<SandpiStore["getRuntime"]>>,
  ) {
    const credential = await this.credentials.credentialForRuntime(sessionId);
    await this.runtime.installCodexSessionCredential(runtime, credential.authJson);
    await this.credentials.markCredentialMaterialized(sessionId, credential);
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

function turnCompleted(records: readonly DecodedCodexRecord[]) {
  return records.some((record) => record.message.method === "turn/completed");
}

function controlTransitions(
  records: readonly DecodedCodexRecord[],
): CodexControlTransition[] {
  const transitions: CodexControlTransition[] = [];
  for (const record of records) {
    const method = record.message.method;
    const params = record.message.params;
    if (!params || typeof params !== "object") continue;
    const values = params as Record<string, unknown>;
    if (method !== "turn/started" && method !== "turn/completed") continue;
    const nativeSessionId =
      typeof values.threadId === "string" ? values.threadId : undefined;
    const turn = values.turn;
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
        supervisorSequence: record.supervisorSequence,
      });
      continue;
    }
    const status = objectString(turn, "status");
    if (
      status === "completed" ||
      status === "failed" ||
      status === "interrupted"
    ) {
      transitions.push({
        type: "turnCompleted",
        nativeSessionId,
        nativeTurnId,
        status,
        supervisorSequence: record.supervisorSequence,
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

function objectString(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function objectNumber(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
}

function rpcErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Codex returned an RPC error.";
}

function isMissingNativeThreadError(error: unknown) {
  const message = rpcErrorMessage(error).toLowerCase();
  return (
    message.includes("no rollout found for thread id") ||
    message.includes("thread not found") ||
    message.includes("thread not loaded")
  );
}

function isUnmaterializedNativeThreadError(error: unknown) {
  const message = rpcErrorMessage(error).toLowerCase();
  return (
    message.includes("not materialized yet") &&
    message.includes("includeturns")
  );
}

function nativeSessionUnrecoverableError(detail?: string) {
  const publicMessage = detail?.startsWith(
    "The active Codex native Session has no persisted rollout",
  )
    ? detail
    : "The native Codex Session is no longer available. Sandpi cannot reconstruct its conversation from a secondary transcript.";
  return new HttpError(
    409,
    "codex_native_session_unrecoverable",
    publicMessage,
  );
}

function sessionAllocationUnrecoverableError() {
  return new HttpError(
    409,
    "session_allocation_unrecoverable",
    "The Session Sandbox is no longer available. Sandpi kept its immutable allocation and did not replace the native coding-agent context.",
  );
}

function sessionOperationInProgressError() {
  return new HttpError(
    409,
    "session_operation_in_progress",
    "Wait for the current Session fork or history operation to finish.",
  );
}

function assertSessionOperationLock(lock: SessionOperationLock) {
  if (!lock.signal.aborted) return;
  throw new HttpError(
    409,
    "session_operation_fence_lost",
    "The Session operation lost its database fence and was stopped safely.",
  );
}

function nativeStateMigrationSnapshotLabel(
  sessionId: string,
  historyRevision: number,
) {
  return `sandpi-native-state-v2-${sessionId.slice(-12)}-r${historyRevision}`;
}

function isSessionAllocationUnrecoverableError(error: unknown) {
  return (
    error instanceof HttpError &&
    error.code === "session_allocation_unrecoverable"
  );
}

function isSupervisorJournalGapError(error: unknown) {
  return (
    error instanceof HttpError &&
    (error.code === "supervisor_journal_gap" ||
      error.code === "supervisor_journal_gap_busy")
  );
}

function isMissingSessionSandboxError(error: unknown) {
  if (error instanceof HttpError && error.code === "sandbox0_not_found") {
    return true;
  }
  return errorMessage(error).toLowerCase().includes("sandbox not found");
}

function isAlreadyInitializedError(error: unknown) {
  return rpcErrorMessage(error).toLowerCase().includes("already initialized");
}

function threadIdFromRpcResponse(response: Record<string, unknown>) {
  const result = response.result;
  if (!result || typeof result !== "object") return undefined;
  const thread = (result as Record<string, unknown>).thread;
  if (!thread || typeof thread !== "object") return undefined;
  const id = (thread as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function modelListPage(result: unknown) {
  if (!result || typeof result !== "object") {
    throw new HttpError(
      502,
      "codex_model_list_failed",
      "Codex returned an invalid model catalog.",
    );
  }
  const page = result as Record<string, unknown>;
  if (
    !Array.isArray(page.data) ||
    !(
      page.nextCursor === undefined ||
      page.nextCursor === null ||
      typeof page.nextCursor === "string"
    )
  ) {
    throw new HttpError(
      502,
      "codex_model_list_failed",
      "Codex returned an invalid model catalog.",
    );
  }
  return {
    data: page.data,
    nextCursor:
      typeof page.nextCursor === "string" && page.nextCursor.length > 0
        ? page.nextCursor
        : undefined,
  };
}

function threadFromRpcResponse(
  response: Record<string, unknown>,
  allowMissingTurns = false,
) {
  const result = response.result;
  if (!result || typeof result !== "object") return undefined;
  const thread = (result as Record<string, unknown>).thread;
  if (
    !thread ||
    typeof thread !== "object" ||
    typeof (thread as Record<string, unknown>).id !== "string"
  ) {
    return undefined;
  }
  const turns = (thread as Record<string, unknown>).turns;
  if (!Array.isArray(turns)) {
    return allowMissingTurns
      ? ({ ...thread, turns: [] } as unknown as CodexThread)
      : undefined;
  }
  return thread as CodexThread;
}

function interruptedTurnIdFromRpcResponse(response: Record<string, unknown>) {
  const result = response.result;
  if (!result || typeof result !== "object") return undefined;
  const thread = (result as Record<string, unknown>).thread;
  if (!thread || typeof thread !== "object") return undefined;
  const turns = (thread as Record<string, unknown>).turns;
  if (!Array.isArray(turns)) return undefined;
  const last = [...turns].reverse().find(
    (turn): turn is Record<string, unknown> => Boolean(turn && typeof turn === "object"),
  );
  return last?.status === "interrupted" && typeof last.id === "string"
    ? last.id
    : undefined;
}

function turnIdFromRpcResponse(response: Record<string, unknown>) {
  const result = response.result;
  if (!result || typeof result !== "object") return undefined;
  const turn = (result as Record<string, unknown>).turn;
  if (!turn || typeof turn !== "object") return undefined;
  const id = (turn as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function turnSubmissionCoordinates() {
  return {
    requestId: `turn-start:${randomUUID()}`,
    clientMessageId: `user-message:${randomUUID()}`,
    stableInputId: `turn-input:${randomUUID()}`,
  };
}

function turnSubmissionProof(runtime: StoredRuntime) {
  return {
    version: runtime.version,
    supervisorSessionId: runtime.supervisorSessionId,
    supervisorCursor: runtime.decoder.supervisorCursor,
    attemptId: runtime.decoder.attemptId,
    runtimeGeneration: runtime.decoder.runtimeGeneration,
  };
}

function transportBoundary(
  supervisorSessionId: string,
  record: DecodedCodexRecord,
): RpcTransportBoundary {
  return {
    supervisorSessionId,
    supervisorSequence: record.supervisorSequence,
    recordIndex: record.recordIndex,
    attemptId: record.attemptId,
    runtimeGeneration: record.runtimeGeneration,
  };
}

function sameTransportBoundary(
  left: RpcTransportBoundary | undefined,
  right: RpcTransportBoundary | undefined,
) {
  return Boolean(
    left &&
      right &&
      left.supervisorSessionId === right.supervisorSessionId &&
      left.supervisorSequence === right.supervisorSequence &&
      left.recordIndex === right.recordIndex &&
      left.attemptId === right.attemptId &&
      left.runtimeGeneration === right.runtimeGeneration,
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecoverableCodexRuntimeError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("transport endpoint is not connected")) return true;
  return (
    error instanceof HttpError &&
    (error.code === "supervisor_not_running" ||
      (error.code.startsWith("sandbox0_") &&
        [404, 409, 503].includes(error.statusCode)))
  );
}

function publicRuntimeError(error: unknown) {
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes("transport endpoint is not connected")
  ) {
    return new HttpError(
      503,
      "sandbox0_workspace_unavailable",
      "The Workspace storage connection was lost and could not be recovered.",
    );
  }
  if (isTransientSandbox0ClientError(error)) {
    return new HttpError(
      503,
      "sandbox0_temporarily_unavailable",
      "Sandbox0 is temporarily unavailable. Try again in a moment.",
    );
  }
  return error;
}

function isTransientSandbox0ClientError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    error.name === "FetchError" ||
    message.includes("fetch failed") ||
    message.includes("interceptors did not return an alternative response")
  );
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function rpcKey(sessionId: string, requestId: string) {
  return `${sessionId}\u0000${requestId}`;
}

function trimLiveUpdates(updates: CodexLiveUpdate[]) {
  if (updates.length <= MAX_LIVE_NOTIFICATIONS_PER_SESSION) return;
  updates.splice(0, updates.length - MAX_LIVE_NOTIFICATIONS_PER_SESSION);
}
