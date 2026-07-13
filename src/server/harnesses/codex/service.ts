import { EventEmitter, once } from "node:events";
import { randomUUID } from "node:crypto";

import type { Environment } from "@/lib/types";
import { HttpError } from "@/server/http-error";
import type { RuntimeAdapter } from "@/server/runtime/types";
import { SandpiStore } from "@/server/store";
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
const RPC_TIMEOUT_MS = 30_000;
const RESOURCE_REAPER_INTERVAL_MS = 60_000;

interface ServiceLogger {
  debug(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

type ThreadInitialization =
  | { mode: "start" }
  | { mode: "resume" }
  | {
      mode: "fork";
      sourceThreadId: string;
      sourceThreadPath?: string;
      lastTurnId?: string;
    };

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

export class CodexService {
  private readonly workers = new Map<string, AbortController>();
  private readonly workerTasks = new Map<string, Promise<void>>();
  private readonly checkpointing = new Map<string, Promise<boolean>>();
  private readonly events = new EventEmitter();
  private reaperTimer?: NodeJS.Timeout;
  private reaping?: Promise<void>;

  constructor(
    private readonly store: SandpiStore,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: ServiceLogger,
    private readonly credentials: CodexCredentialProvider,
  ) {
    this.events.setMaxListeners(0);
  }

  async resumeWorkers() {
    await this.reapExpiredSessions();
    await this.store.recoverStaleTurnCheckpointClaims();
    await this.recoverInterruptedTurnMutations();
    const sessionIds = await this.store.activeRuntimeSessionIds();
    for (const sessionId of sessionIds) {
      await this.store.reconcileSessionStatus(sessionId);
      await this.restoreRuntimeCredential(sessionId);
      this.ensureWorker(sessionId);
    }
    this.reaperTimer ??= setInterval(() => {
      void this.reapExpiredSessions();
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
      if (!(await this.captureWorkspaceCheckpoint(sessionId, { label: "baseline" }))) {
        throw new HttpError(
          502,
          "turn_checkpoint_failed",
          "The initial Workspace checkpoint could not be created.",
        );
      }
      this.ensureWorker(sessionId);
      const runtime = await this.store.decoderState(sessionId);
      const threadId = runtime.threadId;
      if (!threadId) {
        throw new Error("Codex thread/start did not return a thread id");
      }
      await this.runtime.writeCodexMessage(
        runtime,
        {
          method: "turn/start",
          id: `turn-start:${randomUUID()}`,
          params: {
            threadId,
            clientUserMessageId: `user-message:${randomUUID()}`,
            input: turnInput,
          },
        },
        `turn-input:${randomUUID()}`,
      );
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
    await this.store.reserveSessionFork(input.userId, input.sessionId);
    await this.stopWorker(input.sessionId);
    let sessionId: string | undefined;
    let resources: Awaited<ReturnType<RuntimeAdapter["forkSession"]>> | undefined;
    try {
      const sourceRuntime = await this.store.getRuntime(input.userId, input.sessionId);
      if (!sourceRuntime.threadId) {
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
      sessionId = await this.store.createForkSessionMetadata({
        userId: input.userId,
        environment,
        source,
        modelId: sourceRuntime.modelId,
        title: input.title,
      });
      resources = await this.runtime.forkSession({
        sessionId,
        environment,
        source: sourceRuntime,
        codexAuthJson: credential.authJson,
        onResourcesAllocated: (allocated) =>
          this.store.recordSessionAllocation(sessionId!, allocated),
      });
      await this.store.markSessionProvisioned(sessionId, resources, {
        sourceId: credential.sourceId,
        sourceRevision: credential.revision,
        harness: "codex",
      });
      await this.store.copyVisibleHarnessHistory(input.sessionId, sessionId);
      await this.initializeAttempt(sessionId, {
        mode: "fork",
        sourceThreadId: sourceRuntime.threadId,
      });
      if (
        !(await this.captureWorkspaceCheckpoint(sessionId, {
          label: "fork-baseline",
          nativeHeadTurnId: await this.store.latestCompletedTurnId(input.sessionId),
        }))
      ) {
        throw new HttpError(
          502,
          "turn_checkpoint_failed",
          "The forked Session Workspace checkpoint could not be created.",
        );
      }
      await this.store.releaseSessionTurn(sessionId);
      this.ensureWorker(sessionId);
      return sessionId;
    } catch (error) {
      if (sessionId) {
        const cleaned = await this.cleanupFailedSessionResources(sessionId, resources);
        await this.store.markSessionFailed(sessionId, errorMessage(error), cleaned);
      }
      throw error;
    } finally {
      await this.store.releaseTurnFork(input.sessionId);
      this.ensureWorker(input.sessionId);
    }
  }

  async forkTurn(input: {
    userId: string;
    sessionId: string;
    userMessageItemId: string;
    title?: string;
  }) {
    const source = await this.store.getSession(input.userId, input.sessionId);
    const point = await this.store.reserveTurnFork(
      input.userId,
      input.sessionId,
      input.userMessageItemId,
    );
    await this.stopWorker(input.sessionId);

    let childSessionId: string | undefined;
    let resources: Awaited<ReturnType<RuntimeAdapter["forkTurn"]>> | undefined;
    try {
      const sourceRuntime = await this.store.getRuntime(
        input.userId,
        input.sessionId,
      );
      if (!sourceRuntime.threadId) {
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
      const sourceThreadPath = await this.readNativeThreadPath(
        input.sessionId,
        sourceRuntime,
      );
      childSessionId = await this.store.createForkSessionMetadata({
        userId: input.userId,
        environment,
        source,
        modelId: sourceRuntime.modelId,
        title: input.title,
        kind: "turn",
        sourceNativeItemId: input.userMessageItemId,
      });
      resources = await this.runtime.forkTurn({
        sessionId: childSessionId,
        environment,
        source: sourceRuntime,
        sourceThreadPath,
        workspaceSnapshotId: point.selectedSnapshotId,
        codexAuthJson: credential.authJson,
        onResourcesAllocated: (allocated) =>
          this.store.recordSessionAllocation(childSessionId!, allocated),
      });
      await this.store.markSessionProvisioned(childSessionId, resources, {
        sourceId: credential.sourceId,
        sourceRevision: credential.revision,
        harness: "codex",
      });
      await this.store.copyVisibleHarnessHistory(
        input.sessionId,
        childSessionId,
        point.upperSequence,
      );
      await this.initializeAttempt(childSessionId, {
        mode: "fork",
        sourceThreadId: sourceRuntime.threadId,
        sourceThreadPath: resources.nativeThreadImportPath,
        lastTurnId: point.selectedTurnId,
      });
      await this.runtime
        .deleteCodexThreadImport(
          await this.store.decoderState(childSessionId),
          resources.nativeThreadImportPath,
        )
        .catch((error) => {
          this.logger.warn(
            { sessionId: childSessionId, error: errorMessage(error) },
            "Temporary Codex Turn-fork rollout cleanup failed",
          );
        });
      if (
        !(await this.captureWorkspaceCheckpoint(childSessionId, {
          label: "turn-fork-baseline",
          nativeHeadTurnId: point.selectedTurnId,
        }))
      ) {
        throw new HttpError(
          502,
          "turn_checkpoint_failed",
          "The forked Turn Workspace checkpoint could not be created.",
        );
      }
      await this.store.releaseSessionTurn(childSessionId);
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
      await this.store.releaseTurnFork(input.sessionId);
      this.ensureWorker(input.sessionId);
    }
  }

  async startTurn(input: {
    userId: string;
    sessionId: string;
    text: string;
    images: EncodedCodexInputImage[];
  }) {
    const turnInput = nativeCodexTurnInput(input.text, input.images);
    await this.store.beginSessionTurn(input.userId, input.sessionId);
    const requestId = `turn-start:${randomUUID()}`;
    try {
      // Reserve the Session before touching its Sandbox. A Turn edit/delete/fork
      // restores Workspace state, so even credential materialization must not race
      // with a history operation on the same Session.
      const runtime = await this.store.getRuntime(input.userId, input.sessionId);
      await this.ensureCurrentRuntimeCredential(input.sessionId, runtime);
      if (!runtime.threadId) {
        throw new HttpError(
          409,
          "codex_thread_not_ready",
          "Codex thread is not ready.",
        );
      }
      await this.runtime.writeCodexMessage(
        runtime,
        {
          method: "turn/start",
          id: requestId,
          params: {
            threadId: runtime.threadId,
            clientUserMessageId: `user-message:${randomUUID()}`,
            input: turnInput,
          },
        },
        `turn-input:${randomUUID()}`,
      );
    } catch (error) {
      await this.store.releaseSessionTurn(input.sessionId);
      throw error;
    }
    this.ensureWorker(input.sessionId);
    return { requestId };
  }

  async editTurn(input: {
    userId: string;
    sessionId: string;
    userMessageItemId: string;
    text: string;
    images: EncodedCodexInputImage[];
  }) {
    const result = await this.mutateTurn(
      input.userId,
      input.sessionId,
      input.userMessageItemId,
      nativeCodexTurnInput(input.text, input.images),
    );
    return {
      requestId: result.requestId,
      session: await this.store.getSession(input.userId, input.sessionId),
    };
  }

  async deleteTurn(
    userId: string,
    sessionId: string,
    userMessageItemId: string,
  ) {
    await this.mutateTurn(userId, sessionId, userMessageItemId);
    return this.store.getSession(userId, sessionId);
  }

  async listModels(userId: string, sessionId: string) {
    const runtime = await this.store.getRuntime(userId, sessionId);
    const requestId = `model-list:${randomUUID()}`;
    await this.runtime.writeCodexMessage(runtime, {
      method: "model/list",
      id: requestId,
      params: {},
    });
    const response = await this.waitForResponse(sessionId, requestId);
    if (response.error) {
      throw new HttpError(502, "codex_model_list_failed", rpcErrorMessage(response.error));
    }
    return response.result;
  }

  ensureWorker(sessionId: string) {
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
    const stored = await this.store.decoderState(sessionId);
    const page = await this.runtime.listCodexEvents(
      stored,
      stored.decoder.supervisorCursor,
    );
    const events = page.events
      .map(supervisorOutputEvent)
      .filter((event): event is SupervisorOutputEvent => event !== undefined);
    if (events.length === 0) return [];

    const decoded = decodeCodexSupervisorEvents(stored.decoder, events);
    await this.store.persistDecodedRecords(sessionId, decoded.state, decoded.records);
    for (const turnId of completedTurnIds(decoded.records)) {
      const userMessageItemId = await this.store.completedTurnUserItem(
        sessionId,
        turnId,
      );
      if (!userMessageItemId) {
        this.logger.warn(
          { sessionId, turnId },
          "Completed Codex Turn has no persisted user message item",
        );
        continue;
      }
      const checkpointReady = await this.captureWorkspaceCheckpoint(sessionId, {
        label: `turn-${turnId.slice(-12)}`,
        turnId,
        userMessageItemId,
        nativeHeadTurnId: turnId,
      });
      if (checkpointReady) {
        await this.store.markSessionTurnCompleted(sessionId);
      }
    }
    if (decoded.invalidRecords.length > 0) {
      this.logger.warn(
        { sessionId, count: decoded.invalidRecords.length },
        "Codex emitted invalid JSONL records",
      );
    }
    if (decoded.records.length > 0) {
      this.events.emit(sessionId);
    }
    return decoded.records;
  }

  async waitForSessionUpdate(sessionId: string, signal?: AbortSignal) {
    if (signal?.aborted) return;
    const update = once(this.events, sessionId, signal ? { signal } : undefined);
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      timer.unref();
    });
    try {
      await Promise.race([update, timeout]);
    } catch (error) {
      // Closing an SSE client aborts the EventEmitter wait. That is normal
      // transport lifecycle, not a server failure Fastify should log at error.
      if (!signal?.aborted) throw error;
    }
  }

  async close() {
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = undefined;
    for (const controller of this.workers.values()) controller.abort();
    await Promise.allSettled(this.workerTasks.values());
    this.workers.clear();
    this.workerTasks.clear();
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
    for (const runtime of failed) {
      try {
        await this.runtime.deleteSessionResources(runtime);
        await this.store.markFailedSessionResourcesCleaned(runtime.id);
      } catch (error) {
        this.logger.error(
          { sessionId: runtime.id, error: errorMessage(error) },
          "Failed Session resource cleanup will be retried",
        );
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

  private async recoverInterruptedTurnMutations() {
    const interrupted = await this.store.interruptedTurnMutations();
    for (const operation of interrupted) {
      try {
        const recovered = await this.runtime.restoreWorkspaceCheckpoint(
          operation.runtime,
          operation.headSnapshotId,
        );
        await this.store.setRestoredRuntime(operation.runtime.id, {
          threadId: operation.originalThreadId,
          ...recovered,
        });
        await this.restoreRuntimeCredential(operation.runtime.id);
        await this.initializeAttempt(operation.runtime.id, { mode: "resume" });
        await this.store.releasePreparedTurnMutation(operation.runtime.id);
      } catch (error) {
        await this.store.abortTurnMutation(
          operation.runtime.id,
          `Interrupted Turn mutation recovery failed: ${errorMessage(error)}`,
        );
        this.logger.error(
          { sessionId: operation.runtime.id, error: errorMessage(error) },
          "Interrupted Turn mutation could not be compensated",
        );
      }
    }
  }

  private async mutateTurn(
    userId: string,
    sessionId: string,
    userMessageItemId: string,
    replacementInput?: ReturnType<typeof nativeCodexTurnInput>,
  ) {
    const context = await this.store.prepareTurnMutation(
      userId,
      sessionId,
      userMessageItemId,
    );
    await this.stopWorker(sessionId);
    let restoreStarted = false;
    let finalized = false;
    let originalThreadId: string | undefined;
    let replacementThreadId: string | undefined;
    let replacementTurnId: string | undefined;
    try {
      const originalRuntime = await this.store.getRuntime(userId, sessionId);
      originalThreadId = originalRuntime.threadId;
      if (!originalThreadId) {
        throw new HttpError(
          409,
          "codex_thread_not_ready",
          "Codex thread is not ready.",
        );
      }
      restoreStarted = true;
      const recovered = await this.runtime.restoreWorkspaceCheckpoint(
        originalRuntime,
        context.restoreSnapshotId,
      );
      await this.store.setRestoredRuntime(sessionId, {
        threadId: originalThreadId,
        ...recovered,
      });
      await this.restoreRuntimeCredential(sessionId);
      await this.initializeAttempt(sessionId, { mode: "resume" });
      const rewoundRuntime = await this.store.decoderState(sessionId);
      const threadId = await this.branchNativeThread(
        sessionId,
        rewoundRuntime,
        context.branchThroughTurnId,
      );
      replacementThreadId = threadId;
      await this.store.setRuntimeThread(sessionId, threadId);

      let requestId: string | undefined;
      if (replacementInput) {
        const replacementRuntime = await this.store.decoderState(sessionId);
        requestId = `turn-start:${randomUUID()}`;
        await this.runtime.writeCodexMessage(
          replacementRuntime,
          {
            method: "turn/start",
            id: requestId,
            params: {
              threadId,
              clientUserMessageId: `user-message:${randomUUID()}`,
              input: replacementInput,
            },
          },
          `turn-input:${randomUUID()}`,
        );
        const response = await this.waitForResponse(sessionId, requestId);
        if (response.error) {
          throw new HttpError(
            502,
            "codex_turn_start_failed",
            rpcErrorMessage(response.error),
          );
        }
        replacementTurnId = turnIdFromRpcResponse(response);
        if (!replacementTurnId) {
          throw new HttpError(
            502,
            "codex_turn_start_failed",
            "Codex accepted no replacement Turn.",
          );
        }
      }

      const invalidated = await this.finalizeTurnMutationWithRetry(
        sessionId,
        context,
        replacementInput ? "running" : "waiting",
      );
      finalized = true;
      const restoredRuntime = await this.store.decoderState(sessionId);
      for (const snapshotId of invalidated) {
        try {
          await this.runtime.deleteWorkspaceCheckpoint(restoredRuntime, snapshotId);
        } catch (error) {
          this.logger.warn(
            { sessionId, snapshotId, error: errorMessage(error) },
            "Superseded Workspace checkpoint cleanup failed",
          );
        }
      }
      this.events.emit(sessionId);
      this.ensureWorker(sessionId);
      return { requestId };
    } catch (error) {
      if (restoreStarted && !finalized && originalThreadId) {
        try {
          if (replacementThreadId && replacementTurnId) {
            await this.interruptTurn(
              sessionId,
              replacementThreadId,
              replacementTurnId,
            ).catch((interruptError) => {
              this.logger.warn(
                { sessionId, error: errorMessage(interruptError) },
                "Replacement Turn could not be interrupted before compensation",
              );
            });
          }
          await this.compensateTurnMutation(
            sessionId,
            context.headSnapshotId,
            originalThreadId,
          );
        } catch (compensationError) {
          await this.store.abortTurnMutation(
            sessionId,
            `${errorMessage(error)} Compensation failed: ${errorMessage(compensationError)}`,
          );
        }
      } else {
        await this.store.releasePreparedTurnMutation(sessionId);
      }
      this.ensureWorker(sessionId);
      throw error;
    }
  }

  private async compensateTurnMutation(
    sessionId: string,
    headSnapshotId: string,
    originalThreadId: string,
  ) {
    const current = await this.store.decoderState(sessionId);
    const recovered = await this.runtime.restoreWorkspaceCheckpoint(
      current,
      headSnapshotId,
    );
    await this.store.setRestoredRuntime(sessionId, {
      threadId: originalThreadId,
      ...recovered,
    });
    await this.restoreRuntimeCredential(sessionId);
    await this.initializeAttempt(sessionId, { mode: "resume" });
    await this.store.releasePreparedTurnMutation(sessionId);
  }

  private async interruptTurn(
    sessionId: string,
    threadId: string,
    turnId: string,
  ) {
    const runtime = await this.store.decoderState(sessionId);
    const requestId = `turn-interrupt:${randomUUID()}`;
    await this.runtime.writeCodexMessage(runtime, {
      method: "turn/interrupt",
      id: requestId,
      params: { threadId, turnId },
    });
    await this.waitForResponse(sessionId, requestId);
  }

  private async finalizeTurnMutationWithRetry(
    sessionId: string,
    context: Awaited<ReturnType<SandpiStore["prepareTurnMutation"]>>,
    status: "running" | "waiting",
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.store.finalizeTurnMutation(sessionId, context, status);
      } catch (error) {
        lastError = error;
        await delay(100 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private async branchNativeThread(
    sessionId: string,
    runtime: Awaited<ReturnType<SandpiStore["getRuntime"]>>,
    lastTurnId?: string,
  ) {
    if (!runtime.threadId) {
      throw new HttpError(409, "codex_thread_not_ready", "Codex thread is not ready.");
    }
    const requestId = `thread-rewind:${randomUUID()}`;
    await this.runtime.writeCodexMessage(runtime, {
      method: lastTurnId ? "thread/fork" : "thread/start",
      id: requestId,
      params: {
        ...(lastTurnId
          ? { threadId: runtime.threadId, lastTurnId }
          : {}),
        ...(runtime.modelId ? { model: runtime.modelId } : {}),
        cwd: "/workspace",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });
    const response = await this.waitForResponse(sessionId, requestId);
    if (response.error) {
      throw new HttpError(
        502,
        "codex_thread_rewind_failed",
        rpcErrorMessage(response.error),
      );
    }
    const threadId = threadIdFromRpcResponse(response);
    if (!threadId) {
      throw new HttpError(
        502,
        "codex_thread_rewind_failed",
        "Codex did not return the branched thread.",
      );
    }
    return threadId;
  }

  private async readNativeThreadPath(
    sessionId: string,
    runtime: Awaited<ReturnType<SandpiStore["getRuntime"]>>,
  ) {
    if (!runtime.threadId) {
      throw new HttpError(409, "codex_thread_not_ready", "Codex thread is not ready.");
    }
    const requestId = `thread-read:${randomUUID()}`;
    await this.runtime.writeCodexMessage(runtime, {
      method: "thread/read",
      id: requestId,
      params: { threadId: runtime.threadId, includeTurns: false },
    });
    const response = await this.waitForResponse(sessionId, requestId);
    if (response.error) {
      throw new HttpError(
        502,
        "codex_thread_read_failed",
        rpcErrorMessage(response.error),
      );
    }
    const threadPath = threadPathFromRpcResponse(response);
    if (!threadPath) {
      throw new HttpError(
        502,
        "codex_thread_read_failed",
        "Codex did not return its native rollout path.",
      );
    }
    return threadPath;
  }

  private async initializeAttempt(
    sessionId: string,
    thread: ThreadInitialization = { mode: "start" },
  ) {
    let runtime = await this.store.decoderState(sessionId);
    const initializeId = `initialize:${runtime.attemptId ?? randomUUID()}`;
    await this.runtime.writeCodexMessage(runtime, {
      method: "initialize",
      id: initializeId,
      params: {
        clientInfo: { name: "sandpi", title: "Sandpi", version: "0.1.0" },
        ...(thread.mode === "fork" && thread.sourceThreadPath
          ? { capabilities: { experimentalApi: true } }
          : {}),
      },
    });
    const initialize = await this.waitForResponse(sessionId, initializeId);
    if (initialize.error) {
      throw new HttpError(
        502,
        "codex_initialize_failed",
        rpcErrorMessage(initialize.error),
      );
    }
    runtime = await this.store.decoderState(sessionId);
    await this.runtime.writeCodexMessage(runtime, {
      method: "initialized",
      params: {},
    });

    const threadRequestId = `thread-${thread.mode}:${randomUUID()}`;
    const method =
      thread.mode === "resume"
        ? "thread/resume"
        : thread.mode === "fork"
          ? "thread/fork"
          : "thread/start";
    await this.runtime.writeCodexMessage(runtime, {
      method,
      id: threadRequestId,
      params: {
        ...(thread.mode === "resume" && runtime.threadId
          ? { threadId: runtime.threadId }
          : {}),
        ...(thread.mode === "fork"
          ? {
              threadId: thread.sourceThreadId,
              ...(thread.sourceThreadPath ? { path: thread.sourceThreadPath } : {}),
              ...(thread.lastTurnId ? { lastTurnId: thread.lastTurnId } : {}),
            }
          : {}),
        ...(runtime.modelId ? { model: runtime.modelId } : {}),
        cwd: "/workspace",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });
    let response = await this.waitForResponse(sessionId, threadRequestId);
    if (response.error && thread.mode === "fork" && thread.sourceThreadPath) {
      // Current Codex supports explicit rollout paths behind its experimental
      // capability. Keep a stable threadId fallback because Sandpi controls the
      // coding-agent template and imports the rollout into the native sessions
      // tree as well.
      const fallbackRequestId = `thread-fork-fallback:${randomUUID()}`;
      await this.runtime.writeCodexMessage(runtime, {
        method: "thread/fork",
        id: fallbackRequestId,
        params: {
          threadId: thread.sourceThreadId,
          ...(thread.lastTurnId ? { lastTurnId: thread.lastTurnId } : {}),
          ...(runtime.modelId ? { model: runtime.modelId } : {}),
          cwd: "/workspace",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      });
      response = await this.waitForResponse(sessionId, fallbackRequestId);
    }
    if (response.error) {
      throw new HttpError(502, "codex_thread_failed", rpcErrorMessage(response.error));
    }
  }

  private async waitForResponse(
    sessionId: string,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + RPC_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const persisted = await this.store.getRpcResponse(sessionId, requestId);
      if (persisted) return persisted;
      const records = await this.ingestOnce(sessionId);
      const response = records.find((record) => record.message.id === requestId);
      if (response) return response.message;
      await delay(200);
    }
    throw new HttpError(
      504,
      "codex_rpc_timeout",
      `Codex did not answer ${requestId.split(":")[0]} in time.`,
    );
  }

  private async runWorker(sessionId: string, signal: AbortSignal) {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const before = await this.store.decoderState(sessionId);
        const records = await this.ingestOnce(sessionId);
        const after = await this.store.decoderState(sessionId);
        consecutiveFailures = 0;
        if (
          before.attemptId &&
          after.attemptId &&
          before.attemptId !== after.attemptId
        ) {
          await this.restoreRuntimeCredential(sessionId);
          await this.initializeAttempt(
            sessionId,
            after.threadId ? { mode: "resume" } : { mode: "start" },
          );
        }
        if (turnCompleted(records)) {
          await this.captureRuntimeCredential(sessionId, after);
          this.events.emit(`${sessionId}:turn-completed`);
        }
        await this.retryFailedTurnCheckpoint(sessionId);
      } catch (error) {
        consecutiveFailures += 1;
        this.logger.error(
          { sessionId, error: errorMessage(error), consecutiveFailures },
          "Codex event ingestion failed",
        );
        if (consecutiveFailures >= 10) return;
      }
      await delay(Math.min(INGEST_INTERVAL_MS * Math.max(consecutiveFailures, 1), 5_000));
    }
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

  private captureWorkspaceCheckpoint(
    sessionId: string,
    input: {
      label: string;
      turnId?: string;
      userMessageItemId?: string;
      nativeHeadTurnId?: string;
    },
  ) {
    const key = `${sessionId}:${input.turnId ?? "baseline"}`;
    const running = this.checkpointing.get(key);
    if (running) return running;

    const checkpoint = (async () => {
      const claim = await this.store.claimTurnCheckpoint(sessionId, input);
      if (claim.state === "ready") return true;
      if (claim.state === "creating") return false;
      let snapshotId: string | undefined;
      try {
        const runtime = await this.store.decoderState(sessionId);
        const snapshot = await this.runtime.createWorkspaceCheckpoint(
          runtime,
          `sandpi-${input.label}-${claim.ordinal}`,
        );
        snapshotId = snapshot.snapshotId;
        await this.store.completeTurnCheckpoint(claim.id, snapshot.snapshotId);
        return true;
      } catch (error) {
        if (snapshotId) {
          const runtime = await this.store.decoderState(sessionId).catch(() => undefined);
          if (runtime) {
            await this.runtime
              .deleteWorkspaceCheckpoint(runtime, snapshotId)
              .catch((cleanupError) => {
                this.logger.warn(
                  { sessionId, snapshotId, error: errorMessage(cleanupError) },
                  "Uncommitted Workspace checkpoint cleanup failed",
                );
              });
          }
        }
        await this.store.failTurnCheckpoint(claim.id, errorMessage(error));
        this.logger.error(
          { sessionId, turnId: input.turnId, error: errorMessage(error) },
          "Workspace Turn checkpoint failed",
        );
        return false;
      }
    })().finally(() => {
      this.checkpointing.delete(key);
    });
    this.checkpointing.set(key, checkpoint);
    return checkpoint;
  }

  private async retryFailedTurnCheckpoint(sessionId: string) {
    const checkpoints = await this.store.retryableTurnCheckpoints(sessionId);
    const checkpoint = checkpoints[0];
    if (!checkpoint) return;
    const ready = await this.captureWorkspaceCheckpoint(sessionId, {
      label: `turn-${checkpoint.turnId.slice(-12)}`,
      turnId: checkpoint.turnId,
      userMessageItemId: checkpoint.userMessageItemId,
      nativeHeadTurnId: checkpoint.nativeHeadTurnId,
    });
    if (ready) {
      await this.store.markSessionTurnCompleted(sessionId);
      this.events.emit(sessionId);
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

function completedTurnIds(records: readonly DecodedCodexRecord[]) {
  const turnIds = new Set<string>();
  for (const record of records) {
    if (record.message.method !== "turn/completed") continue;
    const params = record.message.params;
    if (!params || typeof params !== "object") continue;
    const turn = (params as Record<string, unknown>).turn;
    if (!turn || typeof turn !== "object") continue;
    const id = (turn as Record<string, unknown>).id;
    if (typeof id === "string") turnIds.add(id);
  }
  return [...turnIds];
}

function rpcErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Codex returned an RPC error.";
}

function threadIdFromRpcResponse(response: Record<string, unknown>) {
  const result = response.result;
  if (!result || typeof result !== "object") return undefined;
  const thread = (result as Record<string, unknown>).thread;
  if (!thread || typeof thread !== "object") return undefined;
  const id = (thread as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function threadPathFromRpcResponse(response: Record<string, unknown>) {
  const result = response.result;
  if (!result || typeof result !== "object") return undefined;
  const thread = (result as Record<string, unknown>).thread;
  if (!thread || typeof thread !== "object") return undefined;
  const threadPath = (thread as Record<string, unknown>).path;
  return typeof threadPath === "string" && threadPath.length > 0
    ? threadPath
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
