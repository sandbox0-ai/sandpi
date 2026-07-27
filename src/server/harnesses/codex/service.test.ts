import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX,
  CODEX_RUNTIME_RECOVERY_PROMPT_VERSION,
  codexRuntimeRecoveryPrompt,
  isCodexRuntimeRecoveryClientMessageId,
} from "@/harnesses/codex/runtime-recovery";
import type { CodexThread } from "@/harnesses/codex/types";
import type { CodingSession, Environment } from "@/lib/types";
import type { RuntimeAdapter } from "@/server/runtime/types";
import { HttpError } from "@/server/http-error";
import {
  WORKSPACE_RESTORE_UNAVAILABLE_SESSION_ERROR,
  type CodexControlTransition,
  type SandpiStore,
  type StoredEnvironmentRuntime,
  type StoredSessionRuntime,
} from "@/server/store";
import { CodexService, type CodexCredentialProvider } from "./service";
import type { SupervisorOutputEvent } from "./jsonl";

const logger = {
  debug() {},
  warn() {},
  error() {},
};

const credentials = {
  async credentialForEnvironment() {
    return { sourceId: "credential-test", revision: 1, authJson: "{}" };
  },
  async credentialForEnvironmentRuntime() {
    return { sourceId: "credential-test", revision: 1, authJson: "{}" };
  },
  async markCredentialMaterialized() {},
  async syncCredentialFromRuntime() {
    return undefined;
  },
} satisfies CodexCredentialProvider;

const environment: Environment = {
  id: "environment-test",
  ownerId: "user-test",
  idlePauseTimeoutSeconds: 30 * 60,
  sandboxMemoryMiB: 2 * 1024,
  workspaceBackup: { intervalSeconds: 0, retentionCount: 7 },
  name: "Development",
  description: "",
  color: "#151515",
  status: "ready",
  revision: 1,
  templateId: "coding-agent",
  rootfsSnapshotId: "",
  workspaceVolumeId: "volume-environment-test",
  sandboxId: "sandbox-environment-test",
  sandboxState: "running",
  supervisorSessionId: "supervisor-environment-test",
  workspaceRoot: "/workspace",
  credentialRevision: 1,
  codingAgent: { harness: "codex", label: "Codex", status: "connected" },
  networkPolicy: {
    mode: "allow-all",
    domainExceptions: [],
  },
};

function session(
  id: string,
  nativeSessionId: string,
  status: CodingSession["status"] = "waiting",
  archived = false,
): CodingSession {
  return {
    id,
    environmentId: environment.id,
    owner: null,
    title: id,
    status,
    unread: false,
    pinned: false,
    archived,
    harness: "codex",
    harnessLabel: "Codex",
    harnessState: {
      protocol: "codex-app-server",
      threadId: nativeSessionId,
      modelId: "gpt-test",
      harnessVersion: "test",
      protocolVersion: "v2",
      historyRevision: 0,
    },
    createdAt: 1,
    updatedAt: 1,
    environmentRevision: 1,
  };
}

function sessionRuntime(
  id: string,
  nativeSessionId: string | undefined,
): StoredSessionRuntime {
  return {
    sessionId: id,
    environmentId: environment.id,
    nativeSessionId,
    modelId: "gpt-test",
    historyRevision: 0,
    recoveryAttemptCount: 0,
    version: 1,
    sessionStatus: nativeSessionId ? "waiting" : "provisioning",
  };
}

function completedTurn(id: string): CodexThread["turns"][number] {
  return {
    id,
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1_000,
  };
}

function interruptedTurn(
  id: string,
  clientId?: string,
): CodexThread["turns"][number] {
  return {
    id,
    items: clientId
      ? [
          {
            type: "userMessage",
            id: `user-message-${id}`,
            clientId,
            content: [],
          },
        ]
      : [],
    itemsView: "full",
    status: "interrupted",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1_000,
  };
}

function supervisorOutputEvent(
  seq: number,
  messages: readonly Record<string, unknown>[],
  coordinates: { attemptId: string; runtimeGeneration: number } = {
    attemptId: "attempt-environment-test",
    runtimeGeneration: 1,
  },
): SupervisorOutputEvent {
  return {
    seq,
    ...coordinates,
    type: "output",
    stream: "stdout",
    dataBase64: Buffer.from(
      `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    ).toString("base64"),
    occurredAt: "2026-07-16T00:00:00.000Z",
  };
}

interface Fixture {
  service: CodexService;
  sessions: Map<string, CodingSession>;
  sessionRuntimes: Map<string, StoredSessionRuntime>;
  writes: Array<{
    environmentId: string;
    message: Record<string, unknown>;
  }>;
  lifecycleLocks: string[];
  recoveryLockEvents: string[];
  streamStarts: number[];
  rolloutReads: Array<{
    path: string;
    nativeSessionId: string;
  }>;
  mcpOAuthCallbacks: Array<{ port: number }>;
  exceptionalCandidateQueryCount(): number;
  lifecycleLockActive(): boolean;
  runtimeRecoveryCount(): number;
  runtimeRecoveryReplacements(): boolean[];
  environmentRuntime(): StoredEnvironmentRuntime;
  reconciledEnvironmentEpochs(): Array<{
    supervisorSessionId?: string;
    attemptId?: string;
    runtimeGeneration: number;
  }>;
  setRuntimeState(input: {
    desiredState: StoredEnvironmentRuntime["desiredState"];
    observedState: StoredEnvironmentRuntime["observedState"];
  }): void;
  setCredentialBindingCurrent(current: boolean): void;
  recoverRuntimeAs(input: {
    supervisorSessionId?: string;
    attemptId: string;
    runtimeGeneration: number;
  }): void;
  replaceAuthoritativeRuntime(input: {
    supervisorSessionId?: string;
    attemptId: string;
    runtimeGeneration: number;
  }): void;
  replaceRuntimeEpoch(input: {
    supervisorSessionId: string;
    attemptId: string;
    runtimeGeneration: number;
  }): void;
  scheduleExceptionalRepair(
    sessionId: string,
    requestId: string,
    delayMs: number,
  ): void;
  enqueue(
    messages: Record<string, unknown>[],
    coordinates?: { attemptId: string; runtimeGeneration: number },
  ): void;
  enqueueEvent(
    event: Omit<SupervisorOutputEvent, "seq" | "occurredAt">,
  ): void;
  commitEvents(events: readonly SupervisorOutputEvent[]): Promise<void>;
  disconnectStreams(): void;
  close(): Promise<void>;
}

async function eventually(check: () => boolean, message: string) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForPromiseOrAbort(
  promise: Promise<void>,
  signal?: AbortSignal,
) {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function fixture(
  input: {
    sessions?: Array<{
      id: string;
      nativeSessionId: string;
      archived?: boolean;
      status?: CodingSession["status"];
      activeNativeTurnId?: string;
      activeTurnAttemptId?: string;
      activeTurnRuntimeGeneration?: number;
      pendingTurnRequestId?: string;
      pendingTurnClientMessageId?: string;
      pendingTurnPhase?: StoredSessionRuntime["pendingTurnPhase"];
      pendingTurnNativeTurnId?: string;
      pendingTurnStartedAt?: Date;
      pendingTurnAttemptId?: string;
      pendingTurnRuntimeGeneration?: number;
      interruptRequestedNativeTurnId?: string;
      recoverySourceNativeTurnId?: string;
      recoveryPromptVersion?: number;
      recoveryAttemptCount?: number;
      runtimeErrorCode?: string;
      reasoningEffort?: string;
    }>;
    initialDecoder?: StoredEnvironmentRuntime["decoder"];
    initialEventSequence?: number;
    streamErrors?: Error[];
    rpcTimeoutMs?: number;
    rpcSubmissionTimeoutMs?: number;
    exceptionalSessionRecoveryDelayMs?: number;
    exceptionalPendingTurnGraceMs?: number;
    exceptionalSessionRetryBaseMs?: number;
    exceptionalSessionActiveRecheckMs?: number;
    exceptionalSessionRequestTimeoutMs?: number;
    exceptionalCandidateErrors?: Error[];
    environmentRecoveryDelay?: Promise<void>;
    environmentRecoveryErrors?: Error[];
    runtimeAccessLockDelay?: Promise<void>;
    lifecycleLockResults?: boolean[];
    assertScopedRecoveryLocks?: boolean;
    onRequest?: (
      message: Record<string, unknown>,
    ) => Record<string, unknown> | null | undefined;
    writeErrors?: Record<string, Error[]>;
    writeDelays?: Record<string, Promise<void>>;
    authoritativeEpochFence?: boolean;
    rollouts?: Record<string, string | Error | Promise<string>>;
    credentials?: CodexCredentialProvider;
    mcpOAuthCallbackPublicUrl?: string;
  } = {},
): Fixture {
  const initial = input.sessions ?? [
    { id: "session-one", nativeSessionId: "thread-one" },
    { id: "session-two", nativeSessionId: "thread-two" },
  ];
  const sessions = new Map(
    initial.map(({ id, nativeSessionId, archived, status }) => [
      id,
      session(id, nativeSessionId, status, archived),
    ]),
  );
  const sessionRuntimes = new Map<string, StoredSessionRuntime>(
    initial.map(
      ({
        id,
        nativeSessionId,
        activeNativeTurnId,
        activeTurnAttemptId,
        activeTurnRuntimeGeneration,
        pendingTurnRequestId,
        pendingTurnClientMessageId,
        pendingTurnPhase,
        pendingTurnNativeTurnId,
        pendingTurnStartedAt,
        pendingTurnAttemptId,
        pendingTurnRuntimeGeneration,
        interruptRequestedNativeTurnId,
        recoverySourceNativeTurnId,
        recoveryPromptVersion,
        recoveryAttemptCount,
        runtimeErrorCode,
        reasoningEffort,
        status,
      }) => {
        const runtime = sessionRuntime(id, nativeSessionId);
        return [
          id,
          {
            ...runtime,
            activeNativeTurnId,
            activeTurnAttemptId,
            activeTurnRuntimeGeneration,
            pendingTurnRequestId:
              pendingTurnRequestId ??
              (pendingTurnPhase ? `request-${id}` : undefined),
            pendingTurnClientMessageId:
              pendingTurnClientMessageId ??
              (pendingTurnPhase ? `message-${id}` : undefined),
            pendingTurnStableInputId: pendingTurnPhase
              ? `input-${id}`
              : undefined,
            pendingTurnPhase,
            pendingTurnNativeTurnId,
            pendingTurnStartedAt,
            pendingTurnAttemptId,
            pendingTurnRuntimeGeneration,
            interruptRequestedNativeTurnId,
            recoverySourceNativeTurnId,
            recoveryPromptVersion,
            recoveryAttemptCount:
              recoveryAttemptCount ?? runtime.recoveryAttemptCount,
            runtimeErrorCode,
            reasoningEffort,
            sessionStatus: status ?? runtime.sessionStatus,
          },
        ] as [string, StoredSessionRuntime];
      },
    ),
  );
  let environmentRuntime: StoredEnvironmentRuntime = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: environment.supervisorSessionId,
    terminalSessionId: undefined,
    attemptId: "attempt-environment-test",
    runtimeGeneration: 1,
    codexCredentialBindingCurrent: true,
    decoder: input.initialDecoder ?? {
      supervisorCursor: 0,
      tailBase64: "",
      attemptId: "attempt-environment-test",
      runtimeGeneration: 1,
    },
    version: 1,
    desiredState: "running",
    observedState: "running",
    lifecyclePolicyVersion: 1,
  };
  const events: Array<Record<string, unknown> & { seq: number }> = [];
  const activeStreams = new Set<{
    closed: boolean;
    wake?: () => void;
    close(): void;
  }>();
  const streamStarts: number[] = [];
  const writes: Fixture["writes"] = [];
  const lifecycleLocks: string[] = [];
  const recoveryLockEvents: string[] = [];
  const lifecycleLockResults = [...(input.lifecycleLockResults ?? [])];
  const exceptionalCandidateErrors = [
    ...(input.exceptionalCandidateErrors ?? []),
  ];
  const rolloutReads: Fixture["rolloutReads"] = [];
  const mcpOAuthCallbacks: Fixture["mcpOAuthCallbacks"] = [];
  let exceptionalCandidateQueries = 0;
  let lifecycleLockDepth = 0;
  let runtimeRecoveries = 0;
  const runtimeRecoveryReplacements: boolean[] = [];
  const environmentRecoveryErrors = [
    ...(input.environmentRecoveryErrors ?? []),
  ];
  const reconciledEnvironmentEpochs: Array<{
    supervisorSessionId?: string;
    attemptId?: string;
    runtimeGeneration: number;
  }> = [];
  let recoveryCoordinates = {
    supervisorSessionId: environment.supervisorSessionId,
    attemptId: "attempt-environment-test",
    runtimeGeneration: 1,
    sandboxRestarted: false,
  };
  let newSessionSequence = 0;
  let childSequence = 0;
  let eventSequence = input.initialEventSequence ?? 0;
  let lastStartedThreadId: string | undefined;
  let lastStartedTurnId: string | undefined;

  const enqueueEvent = (
    event: Omit<SupervisorOutputEvent, "seq" | "occurredAt">,
  ) => {
    const seq = ++eventSequence;
    events.push({
      seq,
      ...event,
      occurredAt: "2026-07-16T00:00:00.000Z",
    });
    for (const stream of activeStreams) stream.wake?.();
  };
  const enqueue = (
    messages: Record<string, unknown>[],
    coordinates?: { attemptId: string; runtimeGeneration: number },
  ) =>
    enqueueEvent({
      runtimeGeneration:
        coordinates?.runtimeGeneration ?? environmentRuntime.runtimeGeneration,
      attemptId: coordinates?.attemptId ?? environmentRuntime.attemptId,
      type: "output",
      stream: "stdout",
      dataBase64: Buffer.from(
        `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
      ).toString("base64"),
    });

  const defaultResponse = (message: Record<string, unknown>) => {
    const id = message.id;
    if (typeof id !== "string") return undefined;
    if (message.method === "initialize") return { id, result: {} };
    if (message.method === "model/list") {
      return { id, result: { data: [{ id: "gpt-test" }], nextCursor: null } };
    }
    if (message.method === "thread/fork") {
      childSequence += 1;
      return {
        id,
        result: { thread: { id: `thread-child-${childSequence}`, turns: [] } },
      };
    }
    if (message.method === "thread/start") {
      childSequence += 1;
      return {
        id,
        result: { thread: { id: `thread-new-${childSequence}`, turns: [] } },
      };
    }
    if (message.method === "thread/resume") {
      const params = message.params as { threadId: string };
      return {
        id,
        result: {
          thread: {
            id: params.threadId,
            status: { type: "idle" },
            turns: [completedTurn("turn-resumed")],
          },
        },
      };
    }
    if (message.method === "turn/start") {
      const params = message.params as { threadId: string };
      lastStartedThreadId = params.threadId;
      lastStartedTurnId = `turn-new-${childSequence || 1}`;
      return { id, result: { turn: { id: lastStartedTurnId } } };
    }
    if (message.method === "review/start") {
      return {
        id,
        result: {
          turn: { id: "turn-review", status: "inProgress", items: [] },
          reviewThreadId: "thread-one",
        },
      };
    }
    if (
      message.method === "thread/goal/get" ||
      message.method === "thread/goal/set"
    ) {
      const params = message.params as {
        objective?: string;
        status?: string;
      };
      return {
        id,
        result: {
          goal: {
            threadId: "thread-one",
            objective: params.objective ?? "Existing native goal",
            status: params.status ?? "active",
            tokenBudget: 10_000,
            tokensUsed: 250,
            timeUsedSeconds: 12,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      };
    }
    if (message.method === "thread/read") {
      const params = message.params as {
        threadId: string;
        includeTurns?: boolean;
      };
      const turns =
        params.threadId === lastStartedThreadId && lastStartedTurnId
          ? [
              {
                ...completedTurn(lastStartedTurnId),
                status: "inProgress" as const,
                completedAt: null,
                durationMs: null,
              },
            ]
          : [completedTurn("turn-one"), completedTurn("turn-two")];
      return {
        id,
        result: {
          thread: {
            id: params.threadId,
            path:
              `/workspace/.sandpi/harnesses/codex/sessions/2026/07/18/` +
              `rollout-test-${params.threadId}.jsonl`,
            status: turns.some((turn) => turn.status === "inProgress")
              ? { type: "active", activeFlags: [] }
              : { type: "idle" },
            turns: params.includeTurns === false ? [] : turns,
          },
        },
      };
    }
    return { id, result: {} };
  };

  const store = {
    async getEnvironment() {
      return environment;
    },
    async getSession(_userId: string, sessionId: string) {
      const value = sessions.get(sessionId);
      assert.ok(value, `missing Session ${sessionId}`);
      return value;
    },
    async getSessionRuntime(_userId: string, sessionId: string) {
      const value = sessionRuntimes.get(sessionId);
      assert.ok(value, `missing Session runtime ${sessionId}`);
      return value;
    },
    async sessionRuntime(sessionId: string) {
      const value = sessionRuntimes.get(sessionId);
      assert.ok(value, `missing Session runtime ${sessionId}`);
      return value;
    },
    async getEnvironmentRuntime() {
      return environmentRuntime;
    },
    async environmentRuntime() {
      return environmentRuntime;
    },
    async environmentRuntimeRecoveryCandidateIds() {
      return [environment.id];
    },
    async environmentWantsRunning() {
      return environmentRuntime.desiredState === "running";
    },
    async withEnvironmentLifecycleLock(
      environmentId: string,
      operation: (lockedStore: SandpiStore) => Promise<unknown>,
    ) {
      lifecycleLocks.push(environmentId);
      if (input.assertScopedRecoveryLocks) {
        recoveryLockEvents.push("lifecycle");
      }
      if (lifecycleLockResults.shift() === false) {
        return { acquired: false };
      }
      lifecycleLockDepth += 1;
      try {
        return {
          acquired: true,
          value: await operation(
            input.assertScopedRecoveryLocks
              ? recoveryLifecycleStore
              : rootStore,
          ),
        };
      } finally {
        lifecycleLockDepth -= 1;
      }
    },
    async withEnvironmentRuntimeAccessLock(
      _environmentId: string,
      operation: () => Promise<unknown>,
    ) {
      if (input.runtimeAccessLockDelay) {
        await input.runtimeAccessLockDelay;
      }
      return { acquired: true as const, value: await operation() };
    },
    async recordEnvironmentRuntimeAccess() {
      return environmentRuntime;
    },
    async nativeSessionRecoveryCandidatesForEnvironment(
      requestedEnvironmentId: string,
    ) {
      exceptionalCandidateQueries += 1;
      const candidateError = exceptionalCandidateErrors.shift();
      if (candidateError) throw candidateError;
      return [...sessionRuntimes.values()].filter((candidate) => {
        const candidateSession = sessions.get(candidate.sessionId);
        return (
          candidate.environmentId === requestedEnvironmentId &&
          candidateSession?.archived === false &&
          candidateSession.status !== "failed" &&
          Boolean(candidate.nativeSessionId) &&
          (Boolean(candidate.activeNativeTurnId) ||
            Boolean(candidate.pendingTurnPhase) ||
            (candidateSession.status === "running" &&
              !candidate.activeNativeTurnId &&
              !candidate.pendingTurnPhase))
        );
      });
    },
    async recordCodexEnvironmentRuntime(
      _environmentId: string,
      recovered: Awaited<
        ReturnType<RuntimeAdapter["ensureCodexEnvironmentRuntime"]>
      >,
    ) {
      environmentRuntime = {
        ...environmentRuntime,
        supervisorSessionId: recovered.supervisorSessionId,
        attemptId: recovered.attemptId,
        runtimeGeneration: recovered.runtimeGeneration,
        desiredState: "running",
        observedState: "running",
        version: environmentRuntime.version + 1,
      };
      return environmentRuntime;
    },
    async commitEnvironmentTransport(
      environmentId: string,
      supervisorSessionId: string,
      attemptId: string | undefined,
      runtimeGeneration: number,
      before: StoredEnvironmentRuntime["decoder"],
      after: StoredEnvironmentRuntime["decoder"],
      transitions: CodexControlTransition[],
    ) {
      assert.equal(environmentId, environment.id);
      assert.equal(supervisorSessionId, environmentRuntime.supervisorSessionId);
      if (
        environmentRuntime.attemptId !== attemptId ||
        environmentRuntime.runtimeGeneration !== runtimeGeneration ||
        environmentRuntime.decoder.supervisorCursor !==
          before.supervisorCursor ||
        environmentRuntime.decoder.tailBase64 !== before.tailBase64
      ) {
        return false;
      }
      environmentRuntime = {
        ...environmentRuntime,
        decoder: after,
        version: environmentRuntime.version + 1,
      };
      for (const transition of transitions) {
        const owner = [...sessionRuntimes.values()].find(
          (candidate) =>
            candidate.nativeSessionId === transition.nativeSessionId,
        );
        if (!owner) continue;
        const current = sessionRuntimes.get(owner.sessionId)!;
        const currentSession = sessions.get(owner.sessionId)!;
        if (transition.type === "turnStarted") {
          if (current.recoverySourceNativeTurnId === transition.nativeTurnId) {
            continue;
          }
          sessionRuntimes.set(owner.sessionId, {
            ...current,
            activeNativeTurnId: transition.nativeTurnId,
            activeTurnAttemptId: attemptId,
            activeTurnRuntimeGeneration: runtimeGeneration,
            pendingTurnAttemptId: current.pendingTurnPhase
              ? attemptId
              : undefined,
            pendingTurnRuntimeGeneration: current.pendingTurnPhase
              ? runtimeGeneration
              : undefined,
            sessionStatus: "running",
          });
          sessions.set(owner.sessionId, {
            ...currentSession,
            status: "running",
          });
        } else {
          if (
            current.activeNativeTurnId !== transition.nativeTurnId &&
            (current.activeNativeTurnId !== undefined ||
              current.recoverySourceNativeTurnId !== undefined)
          ) {
            continue;
          }
          sessionRuntimes.set(owner.sessionId, {
            ...current,
            activeNativeTurnId: undefined,
            activeTurnAttemptId: undefined,
            activeTurnRuntimeGeneration: undefined,
            pendingTurnRequestId: undefined,
            pendingTurnClientMessageId: undefined,
            pendingTurnStableInputId: undefined,
            pendingTurnPhase: undefined,
            pendingTurnNativeTurnId: undefined,
            pendingTurnStartedAt: undefined,
            pendingTurnAttemptId: undefined,
            pendingTurnRuntimeGeneration: undefined,
            interruptRequestedNativeTurnId: undefined,
            recoverySourceNativeTurnId: undefined,
            recoveryPromptVersion: undefined,
            recoveryAttemptCount: 0,
            sessionStatus: "waiting",
          });
          sessions.set(owner.sessionId, {
            ...currentSession,
            status: "waiting",
          });
        }
      }
      return true;
    },
    async resetEnvironmentDecoder(
      _environmentId: string,
      expectedCursor: number,
      cursor: number,
    ) {
      if (environmentRuntime.decoder.supervisorCursor !== expectedCursor) {
        return false;
      }
      environmentRuntime = {
        ...environmentRuntime,
        decoder: {
          ...environmentRuntime.decoder,
          supervisorCursor: cursor,
          tailBase64: "",
        },
      };
      return true;
    },
    async sessionIdForNativeThread(
      _environmentId: string,
      nativeSessionId: string,
    ) {
      return [...sessionRuntimes.values()].find(
        (candidate) => candidate.nativeSessionId === nativeSessionId,
      )?.sessionId;
    },
    async sessionIdsForEnvironment() {
      return [...sessions.keys()];
    },
    async createSessionMetadata(options: {
      title: string;
      modelId?: string;
      reasoningEffort?: string;
    }) {
      const id = `session-new-${++newSessionSequence}`;
      sessions.set(id, session(id, "", "paused"));
      sessions.set(id, {
        ...sessions.get(id)!,
        title: options.title,
      });
      sessionRuntimes.set(id, {
        ...sessionRuntime(id, undefined),
        modelId: options.modelId,
        reasoningEffort: options.reasoningEffort,
      });
      return id;
    },
    async ensureScheduledSessionMetadata(options: {
      sessionId: string;
      scheduleRunId: string;
      userId: string;
      environment: Environment;
      title: string;
      modelId?: string;
      reasoningEffort?: string;
    }) {
      const existing = sessions.get(options.sessionId);
      if (existing) {
        assert.equal(existing.environmentId, options.environment.id);
        assert.equal(existing.owner, null);
        return;
      }
      sessions.set(
        options.sessionId,
        {
          ...session(options.sessionId, "", "paused"),
          title: options.title,
        },
      );
      sessionRuntimes.set(options.sessionId, {
        ...sessionRuntime(options.sessionId, undefined),
        modelId: options.modelId,
        reasoningEffort: options.reasoningEffort,
      });
    },
    async createForkSessionMetadata(options: {
      source: CodingSession;
      title?: string;
      modelId?: string;
      reasoningEffort?: string;
    }) {
      const id = `session-child-${++childSequence}`;
      sessions.set(id, session(id, "", "paused"));
      sessions.set(id, {
        ...sessions.get(id)!,
        title: options.title ?? `${options.source.title} fork`,
        status: "paused",
      });
      sessionRuntimes.set(id, {
        ...sessionRuntime(id, undefined),
        modelId: options.modelId,
        reasoningEffort: options.reasoningEffort,
      });
      return id;
    },
    async markSessionNativeReady(sessionId: string, nativeSessionId: string) {
      const current = sessionRuntimes.get(sessionId)!;
      sessionRuntimes.set(sessionId, {
        ...current,
        nativeSessionId,
        sessionStatus: "waiting",
      });
      sessions.set(sessionId, {
        ...sessions.get(sessionId)!,
        status: "waiting",
      });
      return true;
    },
    async markSessionFailed(sessionId: string) {
      sessions.set(sessionId, {
        ...sessions.get(sessionId)!,
        status: "failed",
      });
    },
    async reconcileNativeSessionState(options: {
      sessionId: string;
      nativeSessionId: string;
      historyRevision: number;
      runtimeVersion: number;
      environmentId: string;
      environmentSupervisorSessionId?: string;
      environmentAttemptId?: string;
      environmentRuntimeGeneration: number;
      activeNativeTurnId?: string;
      clearPendingWhenNativeIdle?: boolean;
      clearPendingRequestId?: string;
      clearPendingStartedBefore?: Date;
      clearRecoveryState?: boolean;
      recoveryErrorCode?: string;
      requireUnarchived?: boolean;
    }) {
      reconciledEnvironmentEpochs.push({
        supervisorSessionId: options.environmentSupervisorSessionId,
        attemptId: options.environmentAttemptId,
        runtimeGeneration: options.environmentRuntimeGeneration,
      });
      const current = sessionRuntimes.get(options.sessionId)!;
      const currentSession = sessions.get(options.sessionId)!;
      if (
        current.nativeSessionId !== options.nativeSessionId ||
        current.historyRevision !== options.historyRevision ||
        current.version !== options.runtimeVersion ||
        environmentRuntime.id !== options.environmentId ||
        environmentRuntime.supervisorSessionId !==
          options.environmentSupervisorSessionId ||
        environmentRuntime.attemptId !== options.environmentAttemptId ||
        environmentRuntime.runtimeGeneration !==
          options.environmentRuntimeGeneration ||
        (options.requireUnarchived === true && currentSession.archived)
      ) {
        return false;
      }
      const pendingRecoveryEligible =
        (options.clearPendingRequestId !== undefined &&
          current.pendingTurnRequestId === options.clearPendingRequestId) ||
        (options.clearPendingStartedBefore !== undefined &&
          current.pendingTurnStartedAt !== undefined &&
          current.pendingTurnStartedAt.getTime() <=
            options.clearPendingStartedBefore.getTime());
      const clearPending =
        options.clearPendingWhenNativeIdle === true &&
        !options.activeNativeTurnId &&
        Boolean(current.pendingTurnPhase) &&
        pendingRecoveryEligible;
      const clearRecovery =
        options.clearRecoveryState === true && !options.activeNativeTurnId;
      const clearControl = clearPending || clearRecovery;
      const activeChanged =
        current.activeNativeTurnId !== options.activeNativeTurnId;
      sessionRuntimes.set(options.sessionId, {
        ...current,
        activeNativeTurnId: options.activeNativeTurnId,
        activeTurnAttemptId: options.activeNativeTurnId
          ? options.environmentAttemptId
          : undefined,
        activeTurnRuntimeGeneration: options.activeNativeTurnId
          ? options.environmentRuntimeGeneration
          : undefined,
        pendingTurnRequestId: clearControl
          ? undefined
          : current.pendingTurnRequestId,
        pendingTurnClientMessageId: clearControl
          ? undefined
          : current.pendingTurnClientMessageId,
        pendingTurnStableInputId: clearControl
          ? undefined
          : current.pendingTurnStableInputId,
        pendingTurnPhase: clearControl ? undefined : current.pendingTurnPhase,
        pendingTurnNativeTurnId: clearControl
          ? undefined
          : current.pendingTurnNativeTurnId,
        pendingTurnStartedAt: clearControl
          ? undefined
          : current.pendingTurnStartedAt,
        pendingTurnAttemptId: clearControl
          ? undefined
          : current.pendingTurnAttemptId,
        pendingTurnRuntimeGeneration: clearControl
          ? undefined
          : current.pendingTurnRuntimeGeneration,
        interruptRequestedNativeTurnId: clearControl
          ? undefined
          : current.interruptRequestedNativeTurnId,
        recoverySourceNativeTurnId: clearRecovery
          ? undefined
          : current.recoverySourceNativeTurnId,
        recoveryPromptVersion: clearRecovery
          ? undefined
          : current.recoveryPromptVersion,
        recoveryAttemptCount: clearRecovery ? 0 : current.recoveryAttemptCount,
        runtimeErrorCode: clearRecovery
          ? options.recoveryErrorCode
          : current.runtimeErrorCode,
        sessionStatus:
          options.activeNativeTurnId ||
          (!clearControl && current.pendingTurnPhase)
            ? "running"
            : "waiting",
        version: current.version + (activeChanged || clearControl ? 1 : 0),
      });
      sessions.set(options.sessionId, {
        ...sessions.get(options.sessionId)!,
        status:
          options.activeNativeTurnId ||
          (!clearControl && current.pendingTurnPhase)
            ? "running"
            : "waiting",
      });
      return true;
    },
    async beginSessionTurn(
      _userId: string,
      sessionId: string,
      modelId: string | undefined,
      submission: {
        requestId: string;
        clientMessageId: string;
        stableInputId: string;
      },
      reasoningEffort?: string,
    ) {
      const current = sessionRuntimes.get(sessionId)!;
      const currentSession = sessions.get(sessionId)!;
      if (
        currentSession.archived ||
        currentSession.status !== "waiting" ||
        !current.nativeSessionId ||
        current.activeNativeTurnId ||
        current.pendingTurnPhase
      ) {
        throw new HttpError(
          409,
          currentSession.archived
            ? "session_archived"
            : "session_turn_in_progress",
          currentSession.archived
            ? "Unarchive this Session before starting a Codex Turn."
            : "Wait for the current Codex Turn to finish.",
        );
      }
      sessionRuntimes.set(sessionId, {
        ...current,
        modelId: modelId ?? current.modelId,
        reasoningEffort: reasoningEffort ?? current.reasoningEffort,
        pendingTurnRequestId: submission.requestId,
        pendingTurnClientMessageId: submission.clientMessageId,
        pendingTurnStableInputId: submission.stableInputId,
        pendingTurnPhase: "prepared",
        pendingTurnStartedAt: new Date(),
        pendingTurnAttemptId: undefined,
        pendingTurnRuntimeGeneration: undefined,
        interruptRequestedNativeTurnId: undefined,
        recoverySourceNativeTurnId: undefined,
        recoveryPromptVersion: undefined,
        recoveryAttemptCount: 0,
        runtimeErrorCode: undefined,
        sessionStatus: "running",
        version: current.version + 1,
      });
      sessions.set(sessionId, { ...currentSession, status: "running" });
    },
    async markTurnSubmitted(
      sessionId: string,
      requestId: string,
      attemptId: string | undefined,
      runtimeGeneration: number,
    ) {
      const current = sessionRuntimes.get(sessionId)!;
      if (
        current.pendingTurnRequestId !== requestId ||
        current.pendingTurnPhase !== "prepared" ||
        current.interruptRequestedNativeTurnId !== undefined
      ) {
        return false;
      }
      sessionRuntimes.set(sessionId, {
        ...current,
        pendingTurnPhase: "submitted",
        pendingTurnAttemptId: attemptId,
        pendingTurnRuntimeGeneration: runtimeGeneration,
        version: current.version + 1,
      });
      return true;
    },
    async prepareDurableTurnReplay(options: {
      sessionId: string;
      submission: {
        requestId: string;
        clientMessageId: string;
        stableInputId: string;
      };
      environmentAttemptId?: string;
      environmentRuntimeGeneration: number;
    }) {
      const current = sessionRuntimes.get(options.sessionId)!;
      if (
        current.pendingTurnRequestId !== options.submission.requestId ||
        current.pendingTurnClientMessageId !==
          options.submission.clientMessageId ||
        current.pendingTurnStableInputId !== options.submission.stableInputId ||
        current.pendingTurnPhase !== "submitted" ||
        (current.pendingTurnAttemptId === options.environmentAttemptId &&
          current.pendingTurnRuntimeGeneration ===
            options.environmentRuntimeGeneration)
      ) {
        return false;
      }
      sessionRuntimes.set(options.sessionId, {
        ...current,
        pendingTurnPhase: "prepared",
        pendingTurnAttemptId: undefined,
        pendingTurnRuntimeGeneration: undefined,
        version: current.version + 1,
      });
      return true;
    },
    async markTurnAccepted(
      sessionId: string,
      requestId: string,
      nativeTurnId: string,
      attemptId: string | undefined,
      runtimeGeneration: number,
    ) {
      const current = sessionRuntimes.get(sessionId)!;
      if (current.pendingTurnRequestId !== requestId) return;
      sessionRuntimes.set(sessionId, {
        ...current,
        pendingTurnPhase: "accepted",
        pendingTurnNativeTurnId: nativeTurnId,
        activeNativeTurnId: nativeTurnId,
        pendingTurnAttemptId: attemptId,
        pendingTurnRuntimeGeneration: runtimeGeneration,
        activeTurnAttemptId: attemptId,
        activeTurnRuntimeGeneration: runtimeGeneration,
        version: current.version + 1,
      });
    },
    async requestTurnInterrupt(
      sessionId: string,
      preferredNativeTurnId?: string,
    ) {
      const current = sessionRuntimes.get(sessionId)!;
      const currentSession = sessions.get(sessionId)!;
      const knownTurnIds = [
        current.pendingTurnNativeTurnId,
        current.activeNativeTurnId,
        current.recoverySourceNativeTurnId,
      ];
      const nativeTurnId =
        preferredNativeTurnId && knownTurnIds.includes(preferredNativeTurnId)
          ? preferredNativeTurnId
          : knownTurnIds.find((candidate) => candidate !== undefined);
      if (
        currentSession.archived ||
        currentSession.status !== "running" ||
        nativeTurnId === undefined
      ) {
        return undefined;
      }
      sessionRuntimes.set(sessionId, {
        ...current,
        interruptRequestedNativeTurnId: nativeTurnId,
        version: current.version + 1,
      });
      return nativeTurnId;
    },
    async claimInterruptedTurnRecovery(options: {
      sessionId: string;
      nativeSessionId: string;
      historyRevision: number;
      runtimeVersion: number;
      environmentId: string;
      environmentSupervisorSessionId?: string;
      environmentAttemptId?: string;
      environmentRuntimeGeneration: number;
      sourceNativeTurnId: string;
      sourcePendingClientMessageId?: string;
      submission: {
        requestId: string;
        clientMessageId: string;
        stableInputId: string;
      };
      promptVersion: number;
    }) {
      const current = sessionRuntimes.get(options.sessionId)!;
      const currentSession = sessions.get(options.sessionId)!;
      const activeMatches =
        current.activeNativeTurnId === options.sourceNativeTurnId &&
        (current.activeTurnAttemptId !== options.environmentAttemptId ||
          current.activeTurnRuntimeGeneration !==
            options.environmentRuntimeGeneration);
      const pendingMatches =
        (current.pendingTurnNativeTurnId === options.sourceNativeTurnId ||
          (options.sourcePendingClientMessageId !== undefined &&
            current.pendingTurnClientMessageId ===
              options.sourcePendingClientMessageId)) &&
        (current.pendingTurnAttemptId !== options.environmentAttemptId ||
          current.pendingTurnRuntimeGeneration !==
            options.environmentRuntimeGeneration);
      if (
        current.nativeSessionId !== options.nativeSessionId ||
        current.historyRevision !== options.historyRevision ||
        current.version !== options.runtimeVersion ||
        current.environmentId !== options.environmentId ||
        environmentRuntime.supervisorSessionId !==
          options.environmentSupervisorSessionId ||
        environmentRuntime.attemptId !== options.environmentAttemptId ||
        environmentRuntime.runtimeGeneration !==
          options.environmentRuntimeGeneration ||
        currentSession.archived ||
        currentSession.status === "failed" ||
        current.interruptRequestedNativeTurnId === options.sourceNativeTurnId ||
        current.recoverySourceNativeTurnId !== undefined ||
        current.recoveryAttemptCount !== 0 ||
        (!activeMatches && !pendingMatches)
      ) {
        return false;
      }
      sessionRuntimes.set(options.sessionId, {
        ...current,
        activeNativeTurnId: undefined,
        activeTurnAttemptId: undefined,
        activeTurnRuntimeGeneration: undefined,
        pendingTurnRequestId: options.submission.requestId,
        pendingTurnClientMessageId: options.submission.clientMessageId,
        pendingTurnStableInputId: options.submission.stableInputId,
        pendingTurnPhase: "prepared",
        pendingTurnNativeTurnId: undefined,
        pendingTurnStartedAt: new Date(),
        pendingTurnAttemptId: undefined,
        pendingTurnRuntimeGeneration: undefined,
        interruptRequestedNativeTurnId: undefined,
        recoverySourceNativeTurnId: options.sourceNativeTurnId,
        recoveryPromptVersion: options.promptVersion,
        recoveryAttemptCount: current.recoveryAttemptCount + 1,
        runtimeErrorCode: undefined,
        sessionStatus: "running",
        version: current.version + 1,
      });
      sessions.set(options.sessionId, {
        ...currentSession,
        status: "running",
      });
      return true;
    },
    async prepareInterruptedTurnRecoveryReplay(options: {
      sessionId: string;
      nativeSessionId: string;
      runtimeVersion: number;
      requestId: string;
      environmentAttemptId?: string;
      environmentRuntimeGeneration: number;
    }) {
      const current = sessionRuntimes.get(options.sessionId)!;
      if (
        current.nativeSessionId !== options.nativeSessionId ||
        current.version !== options.runtimeVersion ||
        current.pendingTurnRequestId !== options.requestId ||
        current.pendingTurnPhase !== "submitted" ||
        !current.recoverySourceNativeTurnId ||
        (current.pendingTurnAttemptId === options.environmentAttemptId &&
          current.pendingTurnRuntimeGeneration ===
            options.environmentRuntimeGeneration)
      ) {
        return false;
      }
      sessionRuntimes.set(options.sessionId, {
        ...current,
        pendingTurnPhase: "prepared",
        pendingTurnAttemptId: undefined,
        pendingTurnRuntimeGeneration: undefined,
        version: current.version + 1,
      });
      return true;
    },
    async failInterruptedTurnRecovery(
      sessionId: string,
      requestId: string,
      errorCode: string,
    ) {
      const current = sessionRuntimes.get(sessionId)!;
      if (
        current.pendingTurnRequestId !== requestId ||
        !current.recoverySourceNativeTurnId
      ) {
        return false;
      }
      sessionRuntimes.set(sessionId, {
        ...current,
        activeNativeTurnId: undefined,
        activeTurnAttemptId: undefined,
        activeTurnRuntimeGeneration: undefined,
        pendingTurnRequestId: undefined,
        pendingTurnClientMessageId: undefined,
        pendingTurnStableInputId: undefined,
        pendingTurnPhase: undefined,
        pendingTurnNativeTurnId: undefined,
        pendingTurnStartedAt: undefined,
        pendingTurnAttemptId: undefined,
        pendingTurnRuntimeGeneration: undefined,
        interruptRequestedNativeTurnId: undefined,
        recoverySourceNativeTurnId: undefined,
        recoveryPromptVersion: undefined,
        recoveryAttemptCount: 0,
        runtimeErrorCode: errorCode,
        sessionStatus: "waiting",
        version: current.version + 1,
      });
      sessions.set(sessionId, {
        ...sessions.get(sessionId)!,
        status: "waiting",
      });
      return true;
    },
    async abandonTurn(sessionId: string, requestId: string) {
      const current = sessionRuntimes.get(sessionId)!;
      if (current.pendingTurnRequestId !== requestId) return;
      sessionRuntimes.set(sessionId, {
        ...current,
        pendingTurnRequestId: undefined,
        pendingTurnClientMessageId: undefined,
        pendingTurnStableInputId: undefined,
        pendingTurnPhase: undefined,
        pendingTurnNativeTurnId: undefined,
        pendingTurnStartedAt: undefined,
        pendingTurnAttemptId: undefined,
        pendingTurnRuntimeGeneration: undefined,
        activeNativeTurnId: undefined,
        activeTurnAttemptId: undefined,
        activeTurnRuntimeGeneration: undefined,
        interruptRequestedNativeTurnId: undefined,
        recoverySourceNativeTurnId: undefined,
        recoveryPromptVersion: undefined,
        recoveryAttemptCount: 0,
        sessionStatus: "waiting",
        version: current.version + 1,
      });
      sessions.set(sessionId, {
        ...sessions.get(sessionId)!,
        status: "waiting",
      });
    },
  } as unknown as SandpiStore;
  const rootStore = store;
  const recoveryLifecycleStore = Object.assign(
    Object.create(store) as SandpiStore,
    {
      async environmentRuntime(requestedEnvironmentId: string) {
        assert.equal(requestedEnvironmentId, environment.id);
        recoveryLockEvents.push("lifecycle-runtime-read");
        return store.environmentRuntime(requestedEnvironmentId);
      },
      async recordCodexEnvironmentRuntime(
        requestedEnvironmentId: string,
        recovered: Awaited<
          ReturnType<RuntimeAdapter["ensureCodexEnvironmentRuntime"]>
        >,
      ) {
        assert.equal(requestedEnvironmentId, environment.id);
        recoveryLockEvents.push("lifecycle-runtime-write");
        return store.recordCodexEnvironmentRuntime(
          requestedEnvironmentId,
          recovered,
        );
      },
    },
  );

  const runtime = {
    mode: "sandbox0",
    async ensureCodexEnvironmentRuntime(
      _runtime: StoredEnvironmentRuntime,
      _authJson: string,
      options?: { replaceSupervisorAttempt?: boolean },
    ) {
      runtimeRecoveries += 1;
      runtimeRecoveryReplacements.push(
        options?.replaceSupervisorAttempt === true,
      );
      const recoveryError = environmentRecoveryErrors.shift();
      if (recoveryError) throw recoveryError;
      if (input.environmentRecoveryDelay) {
        await input.environmentRecoveryDelay;
      }
      return recoveryCoordinates;
    },
    async readCodexEnvironmentCredential() {
      return "{}";
    },
    async installCodexEnvironmentCredential() {},
    async ensureEnvironmentMcpOAuthCallbackService(
      _runtime: StoredEnvironmentRuntime,
      callback: { port: number },
    ) {
      mcpOAuthCallbacks.push(callback);
      return {
        port: callback.port,
        publicUrl:
          input.mcpOAuthCallbackPublicUrl ??
          "https://oauth-callback.example.test",
      };
    },
    async writeCodexMessage(
      runtime: StoredEnvironmentRuntime,
      value: unknown,
      _stableInputId?: string,
      signal?: AbortSignal,
    ) {
      const message = value as Record<string, unknown>;
      const writeError = input.writeErrors?.[String(message.method)]?.shift();
      if (writeError) throw writeError;
      if (
        input.authoritativeEpochFence &&
        (runtime.supervisorSessionId !==
          recoveryCoordinates.supervisorSessionId ||
          runtime.attemptId !== recoveryCoordinates.attemptId ||
          runtime.runtimeGeneration !== recoveryCoordinates.runtimeGeneration)
      ) {
        throw new HttpError(
          409,
          "codex_runtime_epoch_changed",
          "The authoritative Sandbox0 runtime changed.",
        );
      }
      writes.push({ environmentId: runtime.id, message });
      const writeDelay = input.writeDelays?.[String(message.method)];
      if (writeDelay) await waitForPromiseOrAbort(writeDelay, signal);
      const configured = input.onRequest?.(message);
      const response =
        configured === undefined ? defaultResponse(message) : configured;
      if (response) enqueue([response]);
    },
    async watchCodexEvents(
      _runtime: StoredEnvironmentRuntime,
      after = 0,
      signal?: AbortSignal,
    ) {
      streamStarts.push(after);
      const streamError = input.streamErrors?.shift();
      if (streamError) throw streamError;
      const state = {
        closed: false,
        wake: undefined as (() => void) | undefined,
        close() {
          if (state.closed) return;
          state.closed = true;
          state.wake?.();
          activeStreams.delete(state);
        },
      };
      activeStreams.add(state);
      signal?.addEventListener("abort", () => state.close(), { once: true });
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            let cursor = after;
            try {
              while (!state.closed && !signal?.aborted) {
                const available = events.filter((event) => event.seq > cursor);
                if (available.length > 0) {
                  for (const event of available) {
                    if (state.closed || signal?.aborted) return;
                    cursor = event.seq;
                    yield event;
                  }
                  continue;
                }
                await new Promise<void>((resolve) => {
                  state.wake = resolve;
                  if (state.closed || signal?.aborted) resolve();
                });
                state.wake = undefined;
              }
            } finally {
              state.close();
            }
          },
        },
        close: () => state.close(),
      };
    },
    async readCodexRollout(
      _runtime: StoredEnvironmentRuntime,
      path: string,
      nativeSessionId: string,
    ) {
      rolloutReads.push({ path, nativeSessionId });
      const configured = await input.rollouts?.[nativeSessionId];
      if (configured instanceof Error) throw configured;
      return Buffer.from(
        configured ??
          `${JSON.stringify({
            timestamp: "2026-07-18T00:00:00.000Z",
            type: "session_meta",
            payload: { id: nativeSessionId, session_id: nativeSessionId },
          })}\n`,
      );
    },
  } as unknown as RuntimeAdapter;

  const service = new CodexService(
    store,
    runtime,
    logger,
    input.credentials ?? credentials,
    {
      streamReconnectDelayMs: 5,
      streamBatchDelayMs: 1,
      rpcTimeoutMs: input.rpcTimeoutMs,
      rpcSubmissionTimeoutMs: input.rpcSubmissionTimeoutMs,
      exceptionalSessionRecoveryDelayMs:
        input.exceptionalSessionRecoveryDelayMs,
      exceptionalPendingTurnGraceMs: input.exceptionalPendingTurnGraceMs,
      exceptionalSessionRetryBaseMs: input.exceptionalSessionRetryBaseMs,
      exceptionalSessionActiveRecheckMs:
        input.exceptionalSessionActiveRecheckMs,
      exceptionalSessionRequestTimeoutMs:
        input.exceptionalSessionRequestTimeoutMs,
    },
  );
  return {
    service,
    sessions,
    sessionRuntimes,
    writes,
    lifecycleLocks,
    recoveryLockEvents,
    streamStarts,
    rolloutReads,
    mcpOAuthCallbacks,
    exceptionalCandidateQueryCount: () => exceptionalCandidateQueries,
    lifecycleLockActive: () => lifecycleLockDepth > 0,
    runtimeRecoveryCount: () => runtimeRecoveries,
    runtimeRecoveryReplacements: () => [...runtimeRecoveryReplacements],
    environmentRuntime: () => environmentRuntime,
    reconciledEnvironmentEpochs: () => [...reconciledEnvironmentEpochs],
    setRuntimeState: ({ desiredState, observedState }) => {
      environmentRuntime = {
        ...environmentRuntime,
        desiredState,
        observedState,
        version: environmentRuntime.version + 1,
      };
    },
    setCredentialBindingCurrent: (current) => {
      environmentRuntime = {
        ...environmentRuntime,
        codexCredentialBindingCurrent: current,
        version: environmentRuntime.version + 1,
      };
    },
    recoverRuntimeAs: ({
      supervisorSessionId,
      attemptId,
      runtimeGeneration,
    }) => {
      recoveryCoordinates = {
        ...recoveryCoordinates,
        supervisorSessionId:
          supervisorSessionId ?? recoveryCoordinates.supervisorSessionId,
        attemptId,
        runtimeGeneration,
      };
      environmentRuntime = {
        ...environmentRuntime,
        desiredState: "running",
        observedState: "paused",
        version: environmentRuntime.version + 1,
      };
    },
    replaceAuthoritativeRuntime: ({
      supervisorSessionId,
      attemptId,
      runtimeGeneration,
    }) => {
      recoveryCoordinates = {
        ...recoveryCoordinates,
        supervisorSessionId:
          supervisorSessionId ?? recoveryCoordinates.supervisorSessionId,
        attemptId,
        runtimeGeneration,
      };
    },
    replaceRuntimeEpoch: ({
      supervisorSessionId,
      attemptId,
      runtimeGeneration,
    }) => {
      environmentRuntime = {
        ...environmentRuntime,
        supervisorSessionId,
        attemptId,
        runtimeGeneration,
        decoder: {
          supervisorCursor: 0,
          tailBase64: "",
          attemptId,
          runtimeGeneration,
        },
        version: environmentRuntime.version + 1,
      };
    },
    scheduleExceptionalRepair: (sessionId, requestId, delayMs) => {
      const schedule = (
        service as unknown as {
          scheduleExceptionalSessionReconciliation(
            runtime: StoredEnvironmentRuntime,
            options: {
              delayMs: number;
              pendingTurnRequests: ReadonlyMap<string, string>;
            },
          ): void;
        }
      ).scheduleExceptionalSessionReconciliation;
      schedule.call(service, environmentRuntime, {
        delayMs,
        pendingTurnRequests: new Map([[sessionId, requestId]]),
      });
    },
    enqueue,
    enqueueEvent,
    commitEvents: async (values) => {
      const commit = (
        service as unknown as {
          commitEnvironmentEvents(
            runtime: StoredEnvironmentRuntime,
            events: readonly SupervisorOutputEvent[],
          ): Promise<StoredEnvironmentRuntime>;
        }
      ).commitEnvironmentEvents;
      await commit.call(service, environmentRuntime, values);
    },
    disconnectStreams: () => {
      for (const stream of [...activeStreams]) stream.close();
    },
    close: () => service.close(),
  };
}

test("uses one Environment app-server for multiple native Sessions", async () => {
  const context = fixture();
  try {
    assert.deepEqual(await context.service.listModels("user", "session-one"), {
      data: [{ id: "gpt-test" }],
    });
    assert.deepEqual(await context.service.listModels("user", "session-two"), {
      data: [{ id: "gpt-test" }],
    });

    assert.ok(
      context.writes.every((write) => write.environmentId === environment.id),
    );
    assert.equal(
      context.writes.filter((write) => write.message.method === "initialize")
        .length,
      1,
    );
    assert.deepEqual(
      context.writes.find(
        (write) => write.message.method === "initialize",
      )?.message.params,
      {
        clientInfo: { name: "sandpi", title: "Sandpi", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    );
    assert.equal(
      context.writes.filter((write) => write.message.method === "model/list")
        .length,
      2,
    );
    assert.equal(
      context.writes.filter((write) => write.message.method === "thread/resume")
        .length,
      0,
    );
  } finally {
    await context.close();
  }
});

test("restarts a warm app-server before publishing a replacement account credential", async () => {
  let credentialRevision = 1;
  const credentialEvents: string[] = [];
  const currentCredential = () => ({
    sourceId: `credential-${credentialRevision}`,
    revision: credentialRevision,
    authJson: `{"revision":${credentialRevision}}`,
  });
  const replacementCredentials = {
    async credentialForEnvironment() {
      return currentCredential();
    },
    async credentialForEnvironmentRuntime() {
      return currentCredential();
    },
    async markCredentialMaterialized(
      _environmentId: string,
      credential: { revision: number },
    ) {
      credentialEvents.push(`materialized-${credential.revision}`);
    },
    async syncCredentialFromRuntime() {
      return undefined;
    },
  } satisfies CodexCredentialProvider;
  const context = fixture({
    credentials: replacementCredentials,
    onRequest(message) {
      if (message.method === "initialize") {
        credentialEvents.push(`initialized-${credentialRevision}`);
      }
      return undefined;
    },
  });
  try {
    await context.service.listModels("user", "session-one");
    assert.deepEqual(context.runtimeRecoveryReplacements(), [false]);

    credentialRevision = 2;
    context.setCredentialBindingCurrent(false);
    context.replaceAuthoritativeRuntime({
      supervisorSessionId: environment.supervisorSessionId,
      attemptId: "attempt-environment-credential-two",
      runtimeGeneration: 1,
    });

    await context.service.accountRateLimitsForEnvironment(
      "user",
      environment.id,
    );

    assert.equal(context.runtimeRecoveryCount(), 2);
    assert.deepEqual(context.runtimeRecoveryReplacements(), [false, true]);
    assert.equal(
      context.environmentRuntime().attemptId,
      "attempt-environment-credential-two",
    );
    assert.deepEqual(credentialEvents, [
      "initialized-1",
      "materialized-1",
      "initialized-2",
      "materialized-2",
    ]);
  } finally {
    await context.close();
  }
});

test("lists persisted native Agent descendants across paginated tree pages", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method !== "thread/list") return undefined;
      const params = message.params as {
        ancestorThreadId?: string;
        cursor?: string;
        limit?: number;
      };
      assert.equal(params.ancestorThreadId, "thread-one");
      assert.equal(params.limit, 100);
      return params.cursor
        ? {
            id: message.id,
            result: {
              data: [
                {
                  id: "agent-child",
                  parentThreadId: "thread-one",
                  status: { type: "idle" },
                  turns: [],
                },
              ],
              nextCursor: null,
            },
          }
        : {
            id: message.id,
            result: {
              data: [
                {
                  id: "agent-grandchild",
                  parentThreadId: "agent-child",
                  agentNickname: "Scout",
                  agentRole: "explorer",
                  status: { type: "notLoaded" },
                  turns: [],
                },
              ],
              nextCursor: "agent-page-two",
            },
          };
    },
  });
  try {
    const tree = await context.service.listSessionAgentThreads({
      userId: "user",
      sessionId: "session-one",
    });

    assert.equal(tree.root.id, "thread-one");
    assert.deepEqual(
      tree.descendants.map((thread) => ({
        id: thread.id,
        parentThreadId: thread.parentThreadId,
      })),
      [
        {
          id: "agent-grandchild",
          parentThreadId: "agent-child",
        },
        {
          id: "agent-child",
          parentThreadId: "thread-one",
        },
      ],
    );
    assert.deepEqual(
      context.writes
        .filter(({ message }) => message.method === "thread/list")
        .map(({ message }) => message.params),
      [
        { ancestorThreadId: "thread-one", limit: 100 },
        {
          ancestorThreadId: "thread-one",
          limit: 100,
          cursor: "agent-page-two",
        },
      ],
    );
  } finally {
    await context.close();
  }
});

test("reads only a native Agent Thread owned by the Session tree", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method === "thread/list") {
        return {
          id: message.id,
          result: {
            data: [
              {
                id: "agent-child",
                parentThreadId: "thread-one",
                status: { type: "idle" },
                turns: [],
              },
            ],
            nextCursor: null,
          },
        };
      }
      if (
        message.method === "thread/read" &&
        (message.params as { threadId?: string }).threadId === "agent-child"
      ) {
        return {
          id: message.id,
          result: {
            thread: {
              id: "agent-child",
              parentThreadId: "thread-one",
              agentNickname: "Scout",
              status: { type: "idle" },
              turns: [completedTurn("agent-turn")],
            },
          },
        };
      }
      return undefined;
    },
  });
  try {
    const thread = await context.service.readSessionAgentThread({
      userId: "user",
      sessionId: "session-one",
      nativeThreadId: "agent-child",
    });
    assert.equal(thread.id, "agent-child");
    assert.equal(thread.agentNickname, "Scout");
    assert.deepEqual(
      context.writes.find(
        ({ message }) =>
          message.method === "thread/read" &&
          (message.params as { threadId?: string }).threadId === "agent-child",
      )?.message.params,
      { threadId: "agent-child", includeTurns: true },
    );
  } finally {
    await context.close();
  }
});

test("rejects a same-Environment Thread outside the native Agent tree", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method !== "thread/list") return undefined;
      return {
        id: message.id,
        result: { data: [], nextCursor: null },
      };
    },
  });
  try {
    await assert.rejects(
      context.service.readSessionAgentThread({
        userId: "user",
        sessionId: "session-one",
        nativeThreadId: "thread-two",
      }),
      (error: unknown) =>
        error instanceof HttpError &&
        error.code === "codex_agent_thread_not_found",
    );
    assert.equal(
      context.writes.some(
        ({ message }) =>
          message.method === "thread/read" &&
          (message.params as { threadId?: string }).threadId === "thread-two",
      ),
      false,
    );
  } finally {
    await context.close();
  }
});

test("starts the Environment app-server before listing New Session models", async () => {
  const context = fixture();
  try {
    assert.deepEqual(
      await context.service.listEnvironmentModels("user", environment.id),
      {
        data: [{ id: "gpt-test" }],
      },
    );
    assert.deepEqual(
      context.writes
        .filter(({ message }) =>
          ["initialize", "model/list"].includes(String(message.method)),
        )
        .map(({ message }) => message.method),
      ["initialize", "model/list"],
    );
  } finally {
    await context.close();
  }
});

test("reads bounded native Codex account rate limits", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method !== "account/rateLimits/read") return undefined;
      return {
        id: message.id,
        result: {
          rateLimits: {
            limitId: "codex",
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1_800_000_000,
            },
          },
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              planType: "pro",
              primary: {
                usedPercent: 42,
                windowDurationMins: 300,
                resetsAt: 1_800_000_000,
              },
              secondary: {
                usedPercent: 5,
                windowDurationMins: 10_080,
                resetsAt: 1_800_500_000,
              },
              credits: {
                hasCredits: true,
                unlimited: false,
                balance: "25",
              },
            },
            other: {
              limitId: "other",
              limitName: "x".repeat(200),
              primary: {
                usedPercent: 140,
                windowDurationMins: -1,
                resetsAt: -1,
              },
              spendControlReached: true,
            },
          },
          rateLimitResetCredits: {
            availableCount: 2,
            credits: [
              {
                id: "opaque-credit",
                status: "available",
                resetType: "codexRateLimits",
                grantedAt: 1_799_000_000,
              },
            ],
          },
        },
      };
    },
  });

  try {
    const usage = await context.service.accountRateLimitsForEnvironment(
      "user",
      environment.id,
    );

    assert.equal(typeof usage.fetchedAt, "number");
    assert.deepEqual(usage.resetCredits, { availableCount: 2 });
    assert.deepEqual(usage.limits, [
      {
        id: "codex",
        planType: "pro",
        primary: {
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
        secondary: {
          usedPercent: 5,
          windowDurationMins: 10_080,
          resetsAt: 1_800_500_000,
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: "25",
        },
        reached: false,
      },
      {
        id: "other",
        primary: { usedPercent: 100 },
        reached: true,
      },
    ]);
    const request = context.writes.find(
      ({ message }) => message.method === "account/rateLimits/read",
    )?.message;
    assert.deepEqual(request?.params, {});
  } finally {
    await context.close();
  }
});

test("consumes a native Codex account rate-limit reset credit", async () => {
  const context = fixture({
    onRequest(message) {
      if (
        message.method !== "account/rateLimitResetCredit/consume"
      ) {
        return undefined;
      }
      return {
        id: message.id,
        result: { outcome: "reset" },
      };
    },
  });

  try {
    assert.deepEqual(
      await context.service.consumeAccountRateLimitResetCredit({
        userId: "user",
        environmentId: environment.id,
        idempotencyKey: "338b8bbf-fbab-4394-a1f9-6fda7eeadc52",
      }),
      { outcome: "reset" },
    );
    const request = context.writes.find(
      ({ message }) =>
        message.method === "account/rateLimitResetCredit/consume",
    )?.message;
    assert.deepEqual(request?.params, {
      idempotencyKey: "338b8bbf-fbab-4394-a1f9-6fda7eeadc52",
    });
  } finally {
    await context.close();
  }
});

test("preserves an unavailable native reset-credit capability", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method !== "account/rateLimits/read") return undefined;
      return {
        id: message.id,
        result: {
          rateLimits: {},
          rateLimitResetCredits: { availableCount: 0 },
        },
      };
    },
  });

  try {
    const usage = await context.service.accountRateLimitsForEnvironment(
      "user",
      environment.id,
    );
    assert.deepEqual(usage.limits, []);
    assert.deepEqual(usage.resetCredits, { availableCount: 0 });
    assert.equal(typeof usage.fetchedAt, "number");
  } finally {
    await context.close();
  }
});

test("rejects an unknown Codex account rate-limit reset outcome", async () => {
  const context = fixture({
    onRequest(message) {
      if (
        message.method !== "account/rateLimitResetCredit/consume"
      ) {
        return undefined;
      }
      return {
        id: message.id,
        result: { outcome: "provider-private-state" },
      };
    },
  });

  try {
    await assert.rejects(
      context.service.consumeAccountRateLimitResetCredit({
        userId: "user",
        environmentId: environment.id,
        idempotencyKey: "338b8bbf-fbab-4394-a1f9-6fda7eeadc52",
      }),
      (error: unknown) =>
        error instanceof HttpError &&
        error.statusCode === 502 &&
        error.code === "codex_account_rate_limit_reset_failed",
    );
  } finally {
    await context.close();
  }
});

test("retries an epoch change raised inside Environment lifecycle recovery", async () => {
  const context = fixture({
    environmentRecoveryErrors: [
      new HttpError(
        409,
        "codex_runtime_epoch_changed",
        "The Sandbox changed during credential hydration.",
      ),
    ],
  });
  try {
    assert.deepEqual(await context.service.listModels("user", "session-one"), {
      data: [{ id: "gpt-test" }],
    });
    assert.equal(context.runtimeRecoveryCount(), 2);
    assert.equal(context.lifecycleLocks.length, 2);
  } finally {
    await context.close();
  }
});

test("keeps recovery ownership when initialization races a stopped attempt", async () => {
  const context = fixture({
    writeErrors: {
      initialize: [
        new HttpError(
          409,
          "sandbox0_session_not_running",
          "session is not running",
        ),
      ],
    },
  });
  try {
    assert.deepEqual(await context.service.listModels("user", "session-one"), {
      data: [{ id: "gpt-test" }],
    });
    assert.equal(context.runtimeRecoveryCount(), 2);
    assert.equal(context.lifecycleLocks.length, 2);
  } finally {
    await context.close();
  }
});

test("fails closed when the Environment Sandbox resource is missing", async () => {
  const context = fixture({
    environmentRecoveryErrors: [
      new HttpError(
        404,
        "sandbox0_not_found",
        "the Environment Sandbox does not exist",
      ),
    ],
  });
  try {
    await assert.rejects(
      context.service.listModels("user", "session-one"),
      (error: unknown) =>
        error instanceof HttpError &&
        error.code === "sandbox0_not_found",
    );
    assert.equal(context.runtimeRecoveryCount(), 1);
    assert.equal(context.lifecycleLocks.length, 1);
  } finally {
    await context.close();
  }
});

test("recovery keeps runtime reads on the lifecycle-scoped Store", async () => {
  const context = fixture({ assertScopedRecoveryLocks: true });
  try {
    await context.service.resumeWorkers();

    assert.deepEqual(context.recoveryLockEvents, [
      "lifecycle",
      "lifecycle-runtime-read",
      "lifecycle-runtime-write",
    ]);
  } finally {
    await context.close();
  }
});

test("starts the first Turn on a newly created loaded Thread without resume", async () => {
  const context = fixture();
  try {
    const sessionId = await context.service.createSession({
      userId: "user",
      environment,
      title: "New native Session",
      prompt: "Start here",
      images: [],
      modelId: "gpt-test",
      reasoningEffort: "high",
      sessionStartSource: "clear",
    });

    assert.equal(context.sessions.get(sessionId)?.title, "New native Session");
    assert.deepEqual(
      context.writes
        .filter(({ message }) =>
          ["thread/start", "thread/resume", "turn/start"].includes(
            String(message.method),
          ),
        )
        .map(({ message }) => message.method),
      ["thread/start", "turn/start"],
    );
    const threadStart = context.writes.find(
      ({ message }) => message.method === "thread/start",
    )?.message.params as Record<string, unknown> | undefined;
    const turnStart = context.writes.find(
      ({ message }) => message.method === "turn/start",
    )?.message.params as Record<string, unknown> | undefined;
    assert.deepEqual(threadStart?.config, {
      "features.apply_patch_streaming_events": true,
      model_reasoning_effort: "high",
    });
    assert.equal(threadStart?.sessionStartSource, "clear");
    assert.equal(
      threadStart?.threadSource,
      `sandpi-session:${sessionId}`,
    );
    assert.equal(turnStart?.effort, "high");
    assert.equal(
      context.sessionRuntimes.get(sessionId)?.reasoningEffort,
      "high",
    );
  } finally {
    await context.close();
  }
});

test("passes native Plan collaboration settings to a new Thread and its first Turn", async () => {
  const context = fixture();
  try {
    await context.service.createSession({
      userId: "user",
      environment,
      title: "Plan native Session",
      prompt: "Design the change",
      images: [],
      modelId: "gpt-test",
      reasoningEffort: "high",
      collaborationMode: "plan",
      serviceTier: "native-priority",
    });

    const expectedMode = {
      mode: "plan",
      settings: {
        model: "gpt-test",
        reasoning_effort: "high",
        developer_instructions: null,
      },
    };
    const threadStart = context.writes.find(
      ({ message }) => message.method === "thread/start",
    )?.message.params as Record<string, unknown>;
    const turnStart = context.writes.find(
      ({ message }) => message.method === "turn/start",
    )?.message.params as Record<string, unknown>;
    assert.deepEqual(threadStart.collaborationMode, expectedMode);
    assert.deepEqual(turnStart.collaborationMode, expectedMode);
    assert.equal(threadStart.serviceTier, "native-priority");
    assert.equal(turnStart.serviceTier, "native-priority");
  } finally {
    await context.close();
  }
});

test("reconciles a persisted native Thread when the thread/start response is lost", async () => {
  let creationSource: string | undefined;
  const context = fixture({
    rpcTimeoutMs: 5,
    onRequest(message) {
      if (message.method === "thread/start") {
        creationSource = (message.params as Record<string, unknown>)
          .threadSource as string;
        return null;
      }
      if (message.method === "thread/list") {
        return {
          id: message.id,
          result: {
            data: [
              {
                id: "thread-recovered-create",
                threadSource: creationSource,
                status: { type: "idle" },
                turns: [],
              },
            ],
            nextCursor: null,
          },
        };
      }
      return undefined;
    },
  });
  try {
    const sessionId = await context.service.createSession({
      userId: "user",
      environment,
      title: "Recovered creation",
      prompt: "Start after recovery",
      images: [],
    });

    assert.equal(
      context.sessionRuntimes.get(sessionId)?.nativeSessionId,
      "thread-recovered-create",
    );
    assert.equal(context.sessions.get(sessionId)?.status, "running");
    assert.deepEqual(
      context.writes
        .map(({ message }) => message.method)
        .filter((method) => method !== "initialize" && method !== "initialized"),
      ["thread/start", "thread/list", "thread/resume", "turn/start"],
    );
    assert.equal(
      (
        context.writes.find(
          ({ message }) => message.method === "turn/start",
        )?.message.params as Record<string, unknown>
      ).threadId,
      "thread-recovered-create",
    );
  } finally {
    await context.close();
  }
});

test("fails closed when a creation key resolves to multiple native Threads", async () => {
  let creationSource: string | undefined;
  const context = fixture({
    rpcTimeoutMs: 5,
    onRequest(message) {
      if (message.method === "thread/start") {
        creationSource = (message.params as Record<string, unknown>)
          .threadSource as string;
        return null;
      }
      if (message.method === "thread/list") {
        return {
          id: message.id,
          result: {
            data: ["one", "two"].map((suffix) => ({
              id: `thread-duplicate-${suffix}`,
              threadSource: creationSource,
              status: { type: "idle" },
              turns: [],
            })),
            nextCursor: null,
          },
        };
      }
      return undefined;
    },
  });
  try {
    await assert.rejects(
      context.service.createSession({
        userId: "user",
        environment,
        title: "Ambiguous creation",
        prompt: "Do not duplicate this",
        images: [],
      }),
      (error: unknown) =>
        error instanceof HttpError &&
        error.code === "codex_thread_creation_ambiguous",
    );

    assert.equal(context.sessions.get("session-new-1")?.status, "failed");
    assert.equal(
      context.writes.some(({ message }) => message.method === "turn/start"),
      false,
    );
  } finally {
    await context.close();
  }
});

test("starts native compaction on the current Codex Thread", async () => {
  const context = fixture();
  try {
    assert.deepEqual(
      await context.service.compactSession({
        userId: "user",
        sessionId: "session-one",
      }),
      { accepted: true },
    );
    const compact = context.writes.find(
      ({ message }) => message.method === "thread/compact/start",
    )?.message;
    assert.deepEqual(compact?.params, { threadId: "thread-one" });
  } finally {
    await context.close();
  }
});

test("starts native inline reviews with Codex-owned review targets", async () => {
  const context = fixture();
  try {
    assert.deepEqual(
      await context.service.startReview({
        userId: "user",
        sessionId: "session-one",
      }),
      { nativeTurnId: "turn-review" },
    );
    assert.deepEqual(
      context.writes.find(
        ({ message }) => message.method === "review/start",
      )?.message.params,
      {
        threadId: "thread-one",
        delivery: "inline",
        target: { type: "uncommittedChanges" },
      },
    );

    await context.service.startReview({
      userId: "user",
      sessionId: "session-one",
      instructions: "Focus on persistence races",
    });
    assert.deepEqual(
      context.writes
        .filter(({ message }) => message.method === "review/start")
        .at(-1)?.message.params,
      {
        threadId: "thread-one",
        delivery: "inline",
        target: {
          type: "custom",
          instructions: "Focus on persistence races",
        },
      },
    );
  } finally {
    await context.close();
  }
});

test("reads, sets, and clears the native Codex Session goal", async () => {
  const context = fixture();
  try {
    assert.deepEqual(
      await context.service.readSessionGoal({
        userId: "user",
        sessionId: "session-one",
      }),
      {
        goal: {
          objective: "Existing native goal",
          status: "active",
          tokenBudget: 10_000,
          tokensUsed: 250,
          timeUsedSeconds: 12,
        },
      },
    );
    assert.deepEqual(
      await context.service.setSessionGoal({
        userId: "user",
        sessionId: "session-one",
        objective: "Ship the native integration",
      }),
      {
        goal: {
          objective: "Ship the native integration",
          status: "active",
          tokenBudget: 10_000,
          tokensUsed: 250,
          timeUsedSeconds: 12,
        },
      },
    );
    assert.deepEqual(
      context.writes.find(
        ({ message }) => message.method === "thread/goal/set",
      )?.message.params,
      {
        threadId: "thread-one",
        objective: "Ship the native integration",
      },
    );
    assert.equal(
      (
        await context.service.setSessionGoal({
          userId: "user",
          sessionId: "session-one",
          status: "paused",
        })
      ).goal?.status,
      "paused",
    );
    assert.deepEqual(
      context.writes
        .filter(({ message }) => message.method === "thread/goal/set")
        .at(-1)?.message.params,
      {
        threadId: "thread-one",
        status: "paused",
      },
    );
    assert.deepEqual(
      await context.service.clearSessionGoal({
        userId: "user",
        sessionId: "session-one",
      }),
      { goal: null },
    );
    assert.deepEqual(
      context.writes.find(
        ({ message }) => message.method === "thread/goal/clear",
      )?.message.params,
      { threadId: "thread-one" },
    );

  } finally {
    await context.close();
  }
});

test("projects native personality, usage, and memory settings", async () => {
  let personality = "friendly";
  let featureEnabled = true;
  let useMemories = true;
  let generateMemories = false;
  const context = fixture({
    onRequest(message) {
      if (message.method === "config/read") {
        return {
          id: message.id,
          result: {
            config: {
              personality,
              features: { memories: featureEnabled },
              memories: {
                use_memories: useMemories,
                generate_memories: generateMemories,
              },
            },
            layers: [],
          },
        };
      }
      if (message.method === "model/list") {
        return {
          id: message.id,
          result: {
            data: [{ id: "gpt-test", supportsPersonality: true }],
            nextCursor: null,
          },
        };
      }
      if (message.method === "config/value/write") {
        const params = message.params as {
          keyPath: string;
          value: string;
        };
        if (params.keyPath === "personality") personality = params.value;
        return { id: message.id, result: { status: "ok" } };
      }
      if (message.method === "config/batchWrite") {
        const edits = (message.params as {
          edits: Array<{ keyPath: string; value: boolean }>;
        }).edits;
        for (const edit of edits) {
          if (edit.keyPath === "features.memories") {
            featureEnabled = edit.value;
          } else if (edit.keyPath === "memories.use_memories") {
            useMemories = edit.value;
          } else if (edit.keyPath === "memories.generate_memories") {
            generateMemories = edit.value;
          }
        }
        return { id: message.id, result: { status: "ok" } };
      }
      if (
        message.method === "thread/settings/update" ||
        message.method === "thread/memoryMode/set" ||
        message.method === "memory/reset"
      ) {
        return { id: message.id, result: {} };
      }
      if (message.method === "account/usage/read") {
        return {
          id: message.id,
          result: {
            summary: {
              lifetimeTokens: 12_000,
              peakDailyTokens: 2_500,
              longestRunningTurnSec: 90,
              currentStreakDays: 4,
              longestStreakDays: 9,
            },
            dailyUsageBuckets: [
              { startDate: "2026-07-26", tokens: 1_200 },
              { startDate: "2026-07-27", tokens: 800 },
            ],
          },
        };
      }
      return undefined;
    },
  });
  try {
    assert.deepEqual(
      await context.service.readSessionPersonality({
        userId: "user",
        sessionId: "session-one",
      }),
      { personality: "friendly", supported: true },
    );
    assert.deepEqual(
      await context.service.setSessionPersonality({
        userId: "user",
        sessionId: "session-one",
        personality: "pragmatic",
      }),
      { personality: "pragmatic", supported: true },
    );
    assert.deepEqual(
      context.writes.find(
        ({ message }) => message.method === "thread/settings/update",
      )?.message.params,
      { threadId: "thread-one", personality: "pragmatic" },
    );

    assert.deepEqual(
      await context.service.accountTokenUsageForEnvironment(
        "user",
        environment.id,
      ),
      {
        summary: {
          lifetimeTokens: 12_000,
          peakDailyTokens: 2_500,
          longestRunningTurnSec: 90,
          currentStreakDays: 4,
          longestStreakDays: 9,
        },
        dailyUsageBuckets: [
          { startDate: "2026-07-26", tokens: 1_200 },
          { startDate: "2026-07-27", tokens: 800 },
        ],
      },
    );
    assert.equal(
      Object.hasOwn(
        context.writes.find(
          ({ message }) => message.method === "account/usage/read",
        )?.message ?? {},
        "params",
      ),
      false,
    );

    assert.deepEqual(
      await context.service.readSessionMemories({
        userId: "user",
        sessionId: "session-one",
      }),
      {
        featureEnabled: true,
        useMemories: true,
        generateMemories: false,
      },
    );
    const memorySettings = {
      featureEnabled: true,
      useMemories: false,
      generateMemories: true,
    };
    assert.deepEqual(
      await context.service.setSessionMemories({
        userId: "user",
        sessionId: "session-one",
        settings: memorySettings,
      }),
      memorySettings,
    );
    assert.deepEqual(
      context.writes.find(
        ({ message }) => message.method === "thread/memoryMode/set",
      )?.message.params,
      { threadId: "thread-one", mode: "enabled" },
    );
    assert.deepEqual(
      await context.service.setSessionMemories({
        userId: "user",
        sessionId: "session-one",
        settings: {
          featureEnabled: false,
          useMemories: true,
          generateMemories: true,
        },
      }),
      {
        featureEnabled: false,
        useMemories: false,
        generateMemories: false,
      },
    );
    assert.deepEqual(
      context.writes
        .filter(({ message }) => message.method === "config/batchWrite")
        .at(-1)?.message.params,
      {
        edits: [
          {
            keyPath: "features.memories",
            value: false,
            mergeStrategy: "replace",
          },
          {
            keyPath: "memories.use_memories",
            value: false,
            mergeStrategy: "replace",
          },
          {
            keyPath: "memories.generate_memories",
            value: false,
            mergeStrategy: "replace",
          },
        ],
        reloadUserConfig: true,
      },
    );
    assert.deepEqual(
      context.writes
        .filter(
          ({ message }) => message.method === "thread/memoryMode/set",
        )
        .at(-1)?.message.params,
      { threadId: "thread-one", mode: "disabled" },
    );
    assert.deepEqual(
      await context.service.resetEnvironmentMemories("user", environment.id),
      { reset: true },
    );
  } finally {
    await context.close();
  }
});

test("uses effective Codex configuration after native writes", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method === "config/read") {
        return {
          id: message.id,
          result: {
            config: {
              features: { memories: false },
              memories: {
                use_memories: true,
                generate_memories: true,
              },
            },
            layers: [],
          },
        };
      }
      if (message.method === "config/batchWrite") {
        return { id: message.id, result: { status: "ok" } };
      }
      if (message.method === "thread/memoryMode/set") {
        return { id: message.id, result: {} };
      }
      return undefined;
    },
  });
  try {
    assert.deepEqual(
      await context.service.setSessionMemories({
        userId: "user",
        sessionId: "session-one",
        settings: {
          featureEnabled: true,
          useMemories: true,
          generateMemories: true,
        },
      }),
      {
        featureEnabled: false,
        useMemories: false,
        generateMemories: false,
      },
    );
    assert.deepEqual(
      context.writes.find(
        ({ message }) => message.method === "thread/memoryMode/set",
      )?.message.params,
      { threadId: "thread-one", mode: "disabled" },
    );
  } finally {
    await context.close();
  }
});

test("rejects Codex configuration writes overridden by a higher layer", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method === "model/list") {
        return {
          id: message.id,
          result: {
            data: [{ id: "gpt-test", supportsPersonality: true }],
            nextCursor: null,
          },
        };
      }
      if (message.method === "config/value/write") {
        return {
          id: message.id,
          result: {
            status: "okOverridden",
            overriddenMetadata: {
              message: "overridden",
              overridingLayer: { name: { type: "system" }, version: "1" },
              effectiveValue: "friendly",
            },
          },
        };
      }
      return undefined;
    },
  });
  try {
    await assert.rejects(
      context.service.setSessionPersonality({
        userId: "user",
        sessionId: "session-one",
        personality: "pragmatic",
      }),
      (error: unknown) =>
        error instanceof HttpError &&
        error.statusCode === 409 &&
        error.code === "codex_config_overridden",
    );
    assert.equal(
      context.writes.some(
        ({ message }) => message.method === "thread/settings/update",
      ),
      false,
    );
  } finally {
    await context.close();
  }
});

test("lists and manages native hooks and background terminals", async () => {
  let trusted = false;
  const context = fixture({
    onRequest(message) {
      if (message.method === "hooks/list") {
        return {
          id: message.id,
          result: {
            data: [
              {
                cwd: "/workspace",
                hooks: [
                  {
                    key: "project-hook",
                    eventName: "preToolUse",
                    handlerType: "command",
                    matcher: "exec",
                    command: "./check.sh",
                    timeoutSec: 10,
                    statusMessage: null,
                    sourcePath: "/workspace/.codex/hooks.json",
                    source: "project",
                    pluginId: null,
                    displayOrder: -1,
                    enabled: trusted,
                    isManaged: false,
                    currentHash: "sha256:current",
                    trustStatus: trusted ? "trusted" : "untrusted",
                  },
                ],
                warnings: [],
                errors: [],
              },
            ],
          },
        };
      }
      if (message.method === "config/batchWrite") {
        trusted = true;
        return { id: message.id, result: { status: "ok" } };
      }
      if (message.method === "thread/backgroundTerminals/list") {
        return {
          id: message.id,
          result: {
            data: [
              {
                itemId: "item-shell",
                processId: "process-shell",
                command: "npm run dev",
                cwd: "/workspace",
                osPid: 42,
                cpuPercent: 3.5,
                rssKb: 1_024,
              },
            ],
            nextCursor: null,
          },
        };
      }
      if (message.method === "thread/backgroundTerminals/terminate") {
        return { id: message.id, result: { terminated: true } };
      }
      return undefined;
    },
  });
  try {
    const hooks = await context.service.listEnvironmentHooks(
      "user",
      environment.id,
    );
    assert.equal(hooks.hooks[0]?.trustStatus, "untrusted");
    assert.equal(hooks.hooks[0]?.displayOrder, -1);
    const updated = await context.service.updateEnvironmentHook({
      userId: "user",
      environmentId: environment.id,
      key: "project-hook",
      trustedHash: "sha256:current",
      enabled: true,
    });
    assert.equal(updated.hooks[0]?.trustStatus, "trusted");
    assert.deepEqual(
      context.writes.find(
        ({ message }) => message.method === "config/batchWrite",
      )?.message.params,
      {
        edits: [
          {
            keyPath: "hooks.state",
            value: {
              "project-hook": {
                enabled: true,
                trusted_hash: "sha256:current",
              },
            },
            mergeStrategy: "upsert",
          },
        ],
        reloadUserConfig: true,
      },
    );

    assert.deepEqual(
      await context.service.listSessionBackgroundTerminals({
        userId: "user",
        sessionId: "session-one",
      }),
      {
        terminals: [
          {
            itemId: "item-shell",
            processId: "process-shell",
            command: "npm run dev",
            cwd: "/workspace",
            osPid: 42,
            cpuPercent: 3.5,
            rssKb: 1_024,
          },
        ],
      },
    );
    assert.deepEqual(
      await context.service.terminateSessionBackgroundTerminal({
        userId: "user",
        sessionId: "session-one",
        processId: "process-shell",
      }),
      { terminated: true },
    );
    assert.deepEqual(
      await context.service.cleanSessionBackgroundTerminals({
        userId: "user",
        sessionId: "session-one",
      }),
      { cleaned: true },
    );
  } finally {
    await context.close();
  }
});

test("rejects native slash mutations while the Session has an active Turn", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
        activeNativeTurnId: "turn-active",
      },
    ],
  });
  try {
    await assert.rejects(
      context.service.compactSession({
        userId: "user",
        sessionId: "session-one",
      }),
      (error: unknown) =>
        error instanceof HttpError &&
        error.statusCode === 409 &&
        error.code === "codex_compact_not_ready",
    );
    await assert.rejects(
      context.service.startReview({
        userId: "user",
        sessionId: "session-one",
      }),
      (error: unknown) =>
        error instanceof HttpError &&
        error.statusCode === 409 &&
        error.code === "codex_review_not_ready",
    );
    assert.equal(
      context.writes.some(({ message }) =>
        ["thread/compact/start", "review/start"].includes(
          String(message.method),
        ),
      ),
      false,
    );
  } finally {
    await context.close();
  }
});

test("reads and parses persisted rollout Activity with the native snapshot", async () => {
  const rollout = [
    {
      timestamp: "2026-07-18T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "thread-one" },
    },
    {
      timestamp: "2026-07-18T00:00:01.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-one" },
    },
    {
      timestamp: "2026-07-18T00:00:01.500Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 24_000,
            cached_input_tokens: 2_000,
            output_tokens: 3_000,
            reasoning_output_tokens: 1_000,
            total_tokens: 28_000,
          },
          last_token_usage: {
            input_tokens: 20_000,
            cached_input_tokens: 2_000,
            output_tokens: 3_000,
            reasoning_output_tokens: 1_000,
            total_tokens: 24_000,
          },
          model_context_window: 200_000,
        },
        rate_limits: null,
      },
    },
    {
      timestamp: "2026-07-18T00:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "wait",
        arguments: '{"timeout_ms":1000}',
        call_id: "call-wait",
      },
    },
    {
      timestamp: "2026-07-18T00:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-wait",
        output: "completed",
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
  const context = fixture({ rollouts: { "thread-one": `${rollout}\n` } });

  try {
    const snapshot = await context.service.readNativeSnapshot(
      "user",
      "session-one",
    );

    assert.equal(snapshot.thread.id, "thread-one");
    assert.equal(snapshot.thread.turns.length, 2);
    assert.equal(snapshot.activity.availability, "available");
    assert.equal(snapshot.activity.error, null);
    assert.equal(snapshot.activity.records.length, 1);
    assert.equal(snapshot.tokenUsage?.last.totalTokens, 24_000);
    assert.equal(snapshot.tokenUsage?.modelContextWindow, 200_000);
    assert.deepEqual(
      {
        turnId: snapshot.activity.records[0]?.turnId,
        callId: snapshot.activity.records[0]?.callId,
        callType: snapshot.activity.records[0]?.callType,
        outputType: snapshot.activity.records[0]?.outputs[0]?.outputType,
        name: snapshot.activity.records[0]?.name,
        status: snapshot.activity.records[0]?.status,
        output: (
          snapshot.activity.records[0]?.outputs[0]?.payload as
            { output?: unknown } | undefined
        )?.output,
      },
      {
        turnId: "turn-one",
        callId: "call-wait",
        callType: "function_call",
        outputType: "function_call_output",
        name: "wait",
        status: "completed",
        output: "completed",
      },
    );
    assert.deepEqual(context.rolloutReads, [
      {
        path:
          "/workspace/.sandpi/harnesses/codex/sessions/2026/07/18/" +
          "rollout-test-thread-one.jsonl",
        nativeSessionId: "thread-one",
      },
    ]);
  } finally {
    await context.close();
  }
});

test("delivers the conversation snapshot before persisted rollout Activity", async () => {
  let releaseRollout!: (value: string) => void;
  const rollout = new Promise<string>((resolve) => {
    releaseRollout = resolve;
  });
  const context = fixture({ rollouts: { "thread-one": rollout } });

  try {
    const read = await Promise.race([
      context.service.readNativeSnapshotWithCursor("user", "session-one"),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("conversation snapshot waited for Activity")),
          250,
        ),
      ),
    ]);

    assert.equal(read.snapshot.thread.id, "thread-one");
    assert.equal(read.snapshot.activity.availability, "loading");
    releaseRollout(
      `${JSON.stringify({
        timestamp: "2026-07-18T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "thread-one" },
      })}\n`,
    );
    assert.equal((await read.supplement).activity.availability, "available");
  } finally {
    await context.close();
  }
});

test("keeps the conversation snapshot when persisted rollout Activity cannot be read", async () => {
  const context = fixture({
    rollouts: { "thread-one": new Error("volume read failed") },
  });

  try {
    const snapshot = await context.service.readNativeSnapshot(
      "user",
      "session-one",
    );

    assert.equal(snapshot.thread.id, "thread-one");
    assert.deepEqual(
      snapshot.thread.turns.map((turn) => turn.id),
      ["turn-one", "turn-two"],
    );
    assert.equal(snapshot.activity.availability, "unavailable");
    assert.deepEqual(snapshot.activity.records, []);
    assert.equal(snapshot.activity.error?.code, "codex_rollout_read_failed");
    assert.equal(snapshot.activity.error?.message, "volume read failed");
    assert.equal(context.rolloutReads.length, 1);
  } finally {
    await context.close();
  }
});

test("rejects an unmanaged native rollout path without reading it", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      const params = message.params as { threadId: string };
      return {
        id: message.id,
        result: {
          thread: {
            id: params.threadId,
            path: `/workspace/private/rollout-test-${params.threadId}.jsonl`,
            status: { type: "idle" },
            turns: [completedTurn("turn-one")],
          },
        },
      };
    },
  });

  try {
    const snapshot = await context.service.readNativeSnapshot(
      "user",
      "session-one",
    );

    assert.equal(snapshot.thread.id, "thread-one");
    assert.equal(snapshot.thread.turns.length, 1);
    assert.equal(snapshot.activity.availability, "unavailable");
    assert.deepEqual(snapshot.activity.records, []);
    assert.equal(snapshot.activity.error?.code, "codex_rollout_path_invalid");
    assert.equal(context.rolloutReads.length, 0);
  } finally {
    await context.close();
  }
});

test("scopes a non-string native rollout path to Activity", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      const params = message.params as { threadId: string };
      return {
        id: message.id,
        result: {
          thread: {
            id: params.threadId,
            path: { unexpected: "shape" },
            status: { type: "idle" },
            turns: [completedTurn("turn-one")],
          },
        },
      };
    },
  });

  try {
    const snapshot = await context.service.readNativeSnapshot(
      "user",
      "session-one",
    );

    assert.equal(snapshot.thread.id, "thread-one");
    assert.equal(snapshot.activity.availability, "unavailable");
    assert.equal(snapshot.activity.error?.code, "codex_rollout_path_invalid");
    assert.equal(context.rolloutReads.length, 0);
  } finally {
    await context.close();
  }
});

test("rejects a native snapshot returned for a different Thread", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-other",
            status: { type: "idle" },
            turns: [completedTurn("turn-other")],
          },
        },
      };
    },
  });
  try {
    await assert.rejects(
      context.service.readNativeSnapshot("user", "session-one"),
      (error: unknown) =>
        error instanceof HttpError && error.code === "codex_thread_read_failed",
    );
    assert.equal(
      context.sessionRuntimes.get("session-one")?.activeNativeTurnId,
      undefined,
    );
  } finally {
    await context.close();
  }
});

test("recovers only the Environment protocol and leaves native Sessions detached", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        reasoningEffort: "medium",
      },
      { id: "session-two", nativeSessionId: "thread-two" },
      {
        id: "session-archived",
        nativeSessionId: "thread-archived",
        archived: true,
      },
    ],
  });
  try {
    await context.service.resumeWorkers();

    assert.deepEqual(context.lifecycleLocks, [environment.id]);

    let methods = context.writes.map((write) => write.message.method);
    assert.equal(methods.filter((method) => method === "initialize").length, 1);
    assert.equal(
      methods.filter((method) => method === "thread/resume").length,
      0,
    );

    assert.equal(
      (await context.service.readNativeSnapshot("user", "session-one")).thread
        .id,
      "thread-one",
    );
    assert.equal(
      (await context.service.readNativeSnapshot("user", "session-archived"))
        .thread.id,
      "thread-archived",
    );

    methods = context.writes.map((write) => write.message.method);
    assert.equal(
      methods.filter((method) => method === "thread/read").length,
      2,
    );
    assert.equal(
      methods.filter((method) => method === "thread/resume").length,
      0,
    );
  } finally {
    await context.close();
  }
});

test("explicitly opening an archived Session repairs only stale scalar state", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-archived",
        nativeSessionId: "thread-archived",
        archived: true,
        status: "running",
        pendingTurnPhase: "submitted",
        pendingTurnStartedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
    ],
    exceptionalPendingTurnGraceMs: 500,
  });
  try {
    await context.service.readNativeSnapshot("user", "session-archived");

    assert.equal(
      context.sessionRuntimes.get("session-archived")?.pendingTurnPhase,
      undefined,
    );
    assert.equal(context.sessions.get("session-archived")?.status, "waiting");
    assert.equal(context.exceptionalCandidateQueryCount(), 0);
    const reads = context.writes.filter(
      ({ message }) => message.method === "thread/read",
    );
    assert.equal(reads.length, 1);
    assert.equal(
      (reads[0]?.message.params as { includeTurns?: boolean }).includeTurns,
      true,
    );
  } finally {
    await context.close();
  }
});

test("does not start a Turn in an archived Session", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-archived",
        nativeSessionId: "thread-archived",
        archived: true,
      },
    ],
  });
  try {
    await assert.rejects(
      context.service.startTurn({
        userId: "user",
        sessionId: "session-archived",
        text: "Do not run hidden work",
        images: [],
      }),
      (error: unknown) =>
        error instanceof HttpError && error.code === "session_archived",
    );
    assert.equal(
      context.writes.some(
        ({ message }) =>
          message.method === "thread/resume" || message.method === "turn/start",
      ),
      false,
    );
  } finally {
    await context.close();
  }
});

test("reports a Session whose native state was removed by Workspace restore", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-after-backup",
        nativeSessionId: "thread-after-backup",
      },
    ],
  });
  context.sessionRuntimes.set("session-after-backup", {
    ...context.sessionRuntimes.get("session-after-backup")!,
    runtimeErrorCode: WORKSPACE_RESTORE_UNAVAILABLE_SESSION_ERROR,
  });
  try {
    await assert.rejects(
      context.service.startTurn({
        userId: "user",
        sessionId: "session-after-backup",
        text: "This native Thread no longer exists",
        images: [],
      }),
      (error: unknown) =>
        error instanceof HttpError &&
        error.code === "codex_session_unavailable_after_workspace_restore",
    );
    assert.equal(context.writes.length, 0);
  } finally {
    await context.close();
  }
});

test("repairs only exceptional non-archived Session state without blocking Environment recovery", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-stale",
        nativeSessionId: "thread-stale",
        status: "running",
        pendingTurnPhase: "submitted",
        pendingTurnStartedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
      {
        id: "session-archived",
        nativeSessionId: "thread-archived",
        archived: true,
        status: "running",
        pendingTurnPhase: "submitted",
        pendingTurnStartedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
      {
        id: "session-waiting",
        nativeSessionId: "thread-waiting",
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    onRequest(message) {
      if (message.method === "thread/read") return null;
      return undefined;
    },
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () =>
        context.writes.filter(({ message }) => message.method === "thread/read")
          .length === 1,
      "exceptional reconciliation did not start after Environment recovery",
    );

    assert.equal(context.exceptionalCandidateQueryCount(), 1);
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/resume")
        .length,
      0,
    );
    const read = context.writes.find(
      ({ message }) => message.method === "thread/read",
    )?.message;
    assert.equal(
      (read?.params as { threadId?: string } | undefined)?.threadId,
      "thread-stale",
    );
    assert.equal(
      (read?.params as { includeTurns?: boolean } | undefined)?.includeTurns,
      true,
    );
    assert.equal(
      context.lifecycleLockActive(),
      false,
      "the lifecycle lock must be released before waiting for thread/read",
    );
    context.enqueue([
      {
        id: read?.id,
        result: {
          thread: {
            id: "thread-stale",
            status: { type: "idle" },
            turns: [],
          },
        },
      },
    ]);
    await eventually(
      () =>
        context.sessionRuntimes.get("session-stale")?.pendingTurnPhase ===
        undefined,
      "idle native Thread did not clear stale pending delivery state",
    );

    assert.equal(context.sessions.get("session-stale")?.status, "waiting");
    assert.equal(
      context.service
        .listLiveNotifications("session-stale")
        .some(
          (update) =>
            update.kind === "invalidation" &&
            update.reason === "native-session-state-reconciled",
        ),
      true,
    );
    assert.equal(
      context.sessionRuntimes.get("session-archived")?.pendingTurnPhase,
      "submitted",
    );
    assert.equal(context.sessions.get("session-waiting")?.status, "waiting");
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/read")
        .length,
      1,
    );
  } finally {
    await context.close();
  }
});

test("defers fresh pending Turn repair across replicas until its grace expires", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-fresh",
        nativeSessionId: "thread-fresh",
        status: "running",
        pendingTurnPhase: "prepared",
        pendingTurnStartedAt: new Date(),
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    exceptionalPendingTurnGraceMs: 500,
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () => context.exceptionalCandidateQueryCount() === 1,
      "fresh pending Turn was not considered for deferred repair",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/read")
        .length,
      0,
    );
    assert.equal(
      context.sessionRuntimes.get("session-fresh")?.pendingTurnPhase,
      "prepared",
    );

    await eventually(
      () =>
        context.writes.filter(({ message }) => message.method === "thread/read")
          .length === 1,
      "pending Turn was not repaired after its distributed grace",
    );
    await eventually(
      () =>
        context.sessionRuntimes.get("session-fresh")?.pendingTurnPhase ===
        undefined,
      "eligible pending Turn state was not cleared from an idle native Thread",
    );
    assert.ok(context.exceptionalCandidateQueryCount() >= 2);
  } finally {
    await context.close();
  }
});

test("an explicit control repair wakes an existing distributed grace timer", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-fresh",
        nativeSessionId: "thread-fresh",
        status: "running",
        pendingTurnPhase: "prepared",
        pendingTurnStartedAt: new Date(),
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    exceptionalPendingTurnGraceMs: 5_000,
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () => context.exceptionalCandidateQueryCount() === 1,
      "fresh pending Turn did not enter its grace timer",
    );

    await context.service.scheduleSessionControlStateRepair("session-fresh");
    await eventually(
      () => context.exceptionalCandidateQueryCount() >= 2,
      "explicit repair did not wake the existing grace timer",
    );
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/read")
        .length,
      0,
    );
  } finally {
    await context.close();
  }
});

test("retries exceptional candidate discovery after a transient failure", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-stale",
        nativeSessionId: "thread-stale",
        status: "running",
        pendingTurnPhase: "submitted",
        pendingTurnStartedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    exceptionalSessionRetryBaseMs: 5,
    exceptionalCandidateErrors: [new Error("temporary database failure")],
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () => context.exceptionalCandidateQueryCount() >= 2,
      "failed candidate discovery was not retried",
    );
    await eventually(
      () =>
        context.sessionRuntimes.get("session-stale")?.pendingTurnPhase ===
        undefined,
      "retried reconciliation did not clear stale control state",
    );
  } finally {
    await context.close();
  }
});

test("rechecks an active native Thread until missed completion state is repaired", async () => {
  let reads = 0;
  const context = fixture({
    sessions: [
      {
        id: "session-active",
        nativeSessionId: "thread-active",
        status: "running",
        activeNativeTurnId: "turn-active",
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    exceptionalSessionActiveRecheckMs: 5,
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      reads += 1;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-active",
            status:
              reads === 1
                ? { type: "active", activeFlags: [] }
                : { type: "idle" },
            turns: [],
          },
        },
      };
    },
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () => reads >= 2,
      "active native Thread was not rechecked",
    );
    await eventually(
      () =>
        context.sessionRuntimes.get("session-active")?.activeNativeTurnId ===
        undefined,
      "missed native completion was not repaired",
    );
    assert.equal(context.sessions.get("session-active")?.status, "waiting");
  } finally {
    await context.close();
  }
});

test("settles exceptional Session state on a native Thread system error", async () => {
  let reads = 0;
  const context = fixture({
    sessions: [
      {
        id: "session-system-error",
        nativeSessionId: "thread-system-error",
        status: "running",
        activeNativeTurnId: "turn-system-error",
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    exceptionalSessionRetryBaseMs: 5,
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      reads += 1;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-system-error",
            status: { type: "systemError" },
            turns: [],
          },
        },
      };
    },
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () => context.sessions.get("session-system-error")?.status === "waiting",
      "native Thread system error did not settle the Session projection",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(reads, 1);
    assert.equal(
      context.sessionRuntimes.get("session-system-error")?.activeNativeTurnId,
      undefined,
    );
    assert.equal(
      context.service
        .listLiveNotifications("session-system-error")
        .some(
          (update) =>
            update.kind === "invalidation" &&
            update.reason === "native-session-state-reconciled",
        ),
      true,
    );
  } finally {
    await context.close();
  }
});

test("full native repair preserves an active native Thread", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-active",
        nativeSessionId: "thread-active",
        status: "running",
        activeNativeTurnId: "turn-active",
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-active",
            status: { type: "active", activeFlags: [] },
            turns: [],
          },
        },
      };
    },
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () =>
        context.writes.some(({ message }) => message.method === "thread/read"),
      "active native Thread was not checked",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    const read = context.writes.find(
      ({ message }) => message.method === "thread/read",
    )?.message;
    assert.equal(
      (read?.params as { includeTurns?: boolean } | undefined)?.includeTurns,
      true,
    );
    assert.equal(
      context.sessionRuntimes.get("session-active")?.activeNativeTurnId,
      "turn-active",
    );
    assert.equal(context.sessions.get("session-active")?.status, "running");
    assert.deepEqual(
      context.service.listLiveNotifications("session-active"),
      [],
    );
  } finally {
    await context.close();
  }
});

test("starts one conservative recovery Turn after the Sandbox runtime epoch is replaced", async () => {
  let recoveryClientMessageId: string | undefined;
  let recoveryInputText: string | undefined;
  let nativeReads = 0;
  const context = fixture({
    sessions: [
      {
        id: "session-interrupted",
        nativeSessionId: "thread-interrupted",
        status: "running",
        activeNativeTurnId: "turn-original",
        activeTurnAttemptId: "attempt-environment-test",
        activeTurnRuntimeGeneration: 1,
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    exceptionalSessionActiveRecheckMs: 1_000,
    onRequest(message) {
      if (message.method === "thread/read") {
        nativeReads += 1;
        const recoveryTurn = recoveryClientMessageId
          ? {
              ...interruptedTurn("turn-recovery", recoveryClientMessageId),
              status: "inProgress" as const,
              completedAt: null,
              durationMs: null,
            }
          : undefined;
        return {
          id: message.id,
          result: {
            thread: {
              id: "thread-interrupted",
              status: recoveryTurn
                ? { type: "active", activeFlags: [] }
                : { type: "idle" },
              turns: recoveryTurn
                ? [interruptedTurn("turn-original"), recoveryTurn]
                : [interruptedTurn("turn-original")],
            },
          },
        };
      }
      if (message.method === "turn/start") {
        const params = message.params as {
          clientUserMessageId?: string;
          input?: Array<{ type?: string; text?: string }>;
        };
        recoveryClientMessageId = params.clientUserMessageId;
        recoveryInputText = params.input?.find(
          (item) => item.type === "text",
        )?.text;
      }
      return undefined;
    },
  });
  context.recoverRuntimeAs({
    supervisorSessionId: "supervisor-environment-next",
    attemptId: "attempt-environment-next",
    runtimeGeneration: 2,
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () =>
        context.sessionRuntimes.get("session-interrupted")?.pendingTurnPhase ===
        "accepted",
      "automatic recovery Turn was not accepted",
    );

    assert.equal(
      isCodexRuntimeRecoveryClientMessageId(recoveryClientMessageId),
      true,
    );
    assert.equal(
      recoveryInputText,
      codexRuntimeRecoveryPrompt(CODEX_RUNTIME_RECOVERY_PROMPT_VERSION),
    );
    assert.equal(
      context.sessionRuntimes.get("session-interrupted")
        ?.recoverySourceNativeTurnId,
      "turn-original",
    );
    assert.equal(
      context.sessionRuntimes.get("session-interrupted")?.recoveryAttemptCount,
      1,
    );
    assert.equal(
      context.sessionRuntimes.get("session-interrupted")?.activeTurnAttemptId,
      "attempt-environment-next",
    );
    assert.equal(
      context.writes.filter(({ message }) => message.method === "turn/start")
        .length,
      1,
    );

    await context.service.scheduleSessionControlStateRepair(
      "session-interrupted",
    );
    await eventually(
      () => nativeReads >= 2,
      "accepted recovery Turn was not reconciled after another repair pass",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      context.writes.filter(({ message }) => message.method === "turn/start")
        .length,
      1,
      "native recovery state must suppress a duplicate recovery Turn",
    );
  } finally {
    await context.close();
  }
});

test("settles a user-interrupted native Turn without submitting another Turn", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-user-interrupted",
        nativeSessionId: "thread-user-interrupted",
        status: "running",
        activeNativeTurnId: "turn-user-interrupted",
        activeTurnAttemptId: "attempt-environment-test",
        activeTurnRuntimeGeneration: 1,
        interruptRequestedNativeTurnId: "turn-user-interrupted",
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-user-interrupted",
            status: { type: "idle" },
            turns: [interruptedTurn("turn-user-interrupted")],
          },
        },
      };
    },
  });
  context.recoverRuntimeAs({
    attemptId: "attempt-environment-next",
    runtimeGeneration: 2,
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () =>
        context.sessions.get("session-user-interrupted")?.status === "waiting",
      "explicit user interrupt did not settle",
    );

    assert.equal(
      context.writes.some(({ message }) => message.method === "turn/start"),
      false,
    );
  } finally {
    await context.close();
  }
});

test("settles a current-epoch interrupted Turn without submitting another Turn", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-current-epoch",
        nativeSessionId: "thread-current-epoch",
        status: "running",
        activeNativeTurnId: "turn-current-epoch",
        activeTurnAttemptId: "attempt-environment-test",
        activeTurnRuntimeGeneration: 1,
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-current-epoch",
            status: { type: "idle" },
            turns: [interruptedTurn("turn-current-epoch")],
          },
        },
      };
    },
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () => context.sessions.get("session-current-epoch")?.status === "waiting",
      "current-epoch interrupt did not settle",
    );

    assert.equal(
      context.writes.some(({ message }) => message.method === "turn/start"),
      false,
    );
  } finally {
    await context.close();
  }
});

test("delivers a durably claimed recovery Turn after Sandpi restarts", async () => {
  const recoveryClientMessageId =
    `${CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX}session-claimed:persisted`;
  const context = fixture({
    sessions: [
      {
        id: "session-claimed",
        nativeSessionId: "thread-claimed",
        status: "running",
        pendingTurnRequestId: "turn-recovery:session-claimed:persisted",
        pendingTurnClientMessageId: recoveryClientMessageId,
        pendingTurnPhase: "prepared",
        recoverySourceNativeTurnId: "turn-original",
        recoveryPromptVersion: CODEX_RUNTIME_RECOVERY_PROMPT_VERSION,
        recoveryAttemptCount: 1,
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-claimed",
            status: { type: "idle" },
            turns: [interruptedTurn("turn-original")],
          },
        },
      };
    },
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () =>
        context.sessionRuntimes.get("session-claimed")?.pendingTurnPhase ===
        "accepted",
      "persisted recovery claim was not delivered",
    );

    const starts = context.writes.filter(
      ({ message }) => message.method === "turn/start",
    );
    assert.equal(starts.length, 1);
    assert.equal(
      (
        starts[0]?.message.params as
          | { clientUserMessageId?: string }
          | undefined
      )?.clientUserMessageId,
      recoveryClientMessageId,
    );
  } finally {
    await context.close();
  }
});

test("redelivers an absent recovery only after its submitted runtime epoch is gone", async () => {
  const recoveryClientMessageId =
    `${CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX}session-old-submit:persisted`;
  const context = fixture({
    sessions: [
      {
        id: "session-old-submit",
        nativeSessionId: "thread-old-submit",
        status: "running",
        pendingTurnRequestId: "turn-recovery:session-old-submit:persisted",
        pendingTurnClientMessageId: recoveryClientMessageId,
        pendingTurnPhase: "submitted",
        pendingTurnAttemptId: "attempt-before-restart",
        pendingTurnRuntimeGeneration: 1,
        recoverySourceNativeTurnId: "turn-original",
        recoveryPromptVersion: CODEX_RUNTIME_RECOVERY_PROMPT_VERSION,
        recoveryAttemptCount: 1,
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-old-submit",
            status: { type: "idle" },
            turns: [interruptedTurn("turn-original")],
          },
        },
      };
    },
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () =>
        context.sessionRuntimes.get("session-old-submit")?.pendingTurnPhase ===
        "accepted",
      "old-epoch recovery submission was not safely redelivered",
    );

    assert.equal(
      context.writes.filter(({ message }) => message.method === "turn/start")
        .length,
      1,
    );
    assert.equal(
      context.sessionRuntimes.get("session-old-submit")?.pendingTurnAttemptId,
      "attempt-environment-test",
    );
  } finally {
    await context.close();
  }
});

test("does not replay an ambiguously submitted recovery in the current runtime epoch", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-current-submit",
        nativeSessionId: "thread-current-submit",
        status: "running",
        pendingTurnRequestId:
          "turn-recovery:session-current-submit:persisted",
        pendingTurnClientMessageId:
          `${CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX}` +
          "session-current-submit:persisted",
        pendingTurnPhase: "submitted",
        pendingTurnStartedAt: new Date("2026-07-15T00:00:00.000Z"),
        pendingTurnAttemptId: "attempt-environment-test",
        pendingTurnRuntimeGeneration: 1,
        recoverySourceNativeTurnId: "turn-original",
        recoveryPromptVersion: CODEX_RUNTIME_RECOVERY_PROMPT_VERSION,
        recoveryAttemptCount: 1,
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    exceptionalPendingTurnGraceMs: 0,
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-current-submit",
            status: { type: "idle" },
            turns: [interruptedTurn("turn-original")],
          },
        },
      };
    },
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () =>
        context.sessions.get("session-current-submit")?.status === "waiting",
      "ambiguous current-epoch recovery did not stop after its grace",
    );

    assert.equal(
      context.writes.some(({ message }) => message.method === "turn/start"),
      false,
    );
    assert.equal(
      context.sessionRuntimes.get("session-current-submit")?.runtimeErrorCode,
      "automatic_turn_recovery_timeout",
    );
  } finally {
    await context.close();
  }
});

test("never chains another automatic Turn when recovery is interrupted", async () => {
  const recoveryClientMessageId =
    `${CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX}session-exhausted:persisted`;
  const context = fixture({
    sessions: [
      {
        id: "session-exhausted",
        nativeSessionId: "thread-exhausted",
        status: "running",
        activeNativeTurnId: "turn-recovery",
        activeTurnAttemptId: "attempt-environment-test",
        activeTurnRuntimeGeneration: 1,
        pendingTurnRequestId: "turn-recovery:session-exhausted:persisted",
        pendingTurnClientMessageId: recoveryClientMessageId,
        pendingTurnPhase: "accepted",
        pendingTurnNativeTurnId: "turn-recovery",
        pendingTurnAttemptId: "attempt-environment-test",
        pendingTurnRuntimeGeneration: 1,
        recoverySourceNativeTurnId: "turn-original",
        recoveryPromptVersion: CODEX_RUNTIME_RECOVERY_PROMPT_VERSION,
        recoveryAttemptCount: 1,
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-exhausted",
            status: { type: "idle" },
            turns: [
              interruptedTurn("turn-original"),
              interruptedTurn("turn-recovery", recoveryClientMessageId),
            ],
          },
        },
      };
    },
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () => context.sessions.get("session-exhausted")?.status === "waiting",
      "interrupted recovery Turn did not settle",
    );

    assert.equal(
      context.writes.some(({ message }) => message.method === "turn/start"),
      false,
    );
    assert.equal(
      context.sessionRuntimes.get("session-exhausted")?.runtimeErrorCode,
      "automatic_turn_recovery_exhausted",
    );
    assert.equal(
      context.sessionRuntimes.get("session-exhausted")
        ?.recoverySourceNativeTurnId,
      undefined,
    );
  } finally {
    await context.close();
  }
});

test("defers exceptional Session reads when the Environment lifecycle lock is busy", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-stale",
        nativeSessionId: "thread-stale",
        status: "running",
        pendingTurnPhase: "submitted",
        pendingTurnStartedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
    ],
    exceptionalSessionRecoveryDelayMs: 50,
    lifecycleLockResults: [true, false],
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () => context.lifecycleLocks.length === 2,
      "exceptional reconciliation did not try the lifecycle lock",
    );

    assert.equal(context.exceptionalCandidateQueryCount(), 1);
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/read")
        .length,
      0,
    );
    assert.equal(context.lifecycleLockActive(), false);
    context.service.suspendEnvironmentWorker(environment.id);
  } finally {
    await context.close();
  }
});

test("does not submit exceptional Session reads after the Environment is paused", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-stale",
        nativeSessionId: "thread-stale",
        status: "running",
        pendingTurnPhase: "submitted",
        pendingTurnStartedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
    ],
    exceptionalSessionRecoveryDelayMs: 25,
  });
  try {
    await context.service.resumeWorkers();
    context.setRuntimeState({
      desiredState: "paused",
      observedState: "paused",
    });
    await eventually(
      () => context.exceptionalCandidateQueryCount() === 1,
      "exceptional reconciliation did not inspect its candidates",
    );

    assert.equal(context.lifecycleLocks.length, 2);
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/read")
        .length,
      0,
    );
    assert.equal(
      context.sessionRuntimes.get("session-stale")?.pendingTurnPhase,
      "submitted",
    );
  } finally {
    await context.close();
  }
});

test("a submitted exceptional Session read cannot wake a subsequently paused Environment", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-stale",
        nativeSessionId: "thread-stale",
        status: "running",
        pendingTurnPhase: "submitted",
        pendingTurnStartedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    onRequest(message) {
      if (message.method === "thread/read") return null;
      return undefined;
    },
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () =>
        context.writes.some(({ message }) => message.method === "thread/read"),
      "exceptional reconciliation did not submit thread/read",
    );
    const read = context.writes.find(
      ({ message }) => message.method === "thread/read",
    )?.message;
    assert.equal(context.lifecycleLockActive(), false);

    context.setRuntimeState({
      desiredState: "paused",
      observedState: "paused",
    });
    context.enqueue([
      {
        id: read?.id,
        result: {
          thread: {
            id: "thread-stale",
            status: { type: "idle" },
            turns: [],
          },
        },
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(context.runtimeRecoveryCount(), 1);
    assert.equal(
      context.sessionRuntimes.get("session-stale")?.pendingTurnPhase,
      "submitted",
    );
    assert.equal(
      context.service
        .listLiveNotifications("session-stale")
        .some(
          (update) =>
            update.kind === "invalidation" &&
            update.reason === "native-session-state-reconciled",
        ),
      false,
    );
  } finally {
    await context.close();
  }
});

test("cancelling an exceptional Session read while submission is pending is handled", async () => {
  let releaseWrite: (() => void) | undefined;
  const blockedWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const context = fixture({
    sessions: [
      {
        id: "session-stale",
        nativeSessionId: "thread-stale",
        status: "running",
        pendingTurnPhase: "submitted",
        pendingTurnStartedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    writeDelays: { "thread/read": blockedWrite },
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () =>
        context.writes.some(({ message }) => message.method === "thread/read"),
      "exceptional reconciliation did not begin its native submission",
    );
    assert.equal(context.lifecycleLockActive(), true);

    context.service.suspendEnvironmentWorker(environment.id);
    await eventually(
      () => !context.lifecycleLockActive(),
      "cancelled native submission did not abort and release the lifecycle lock",
    );
    assert.equal(
      context.sessionRuntimes.get("session-stale")?.pendingTurnPhase,
      "submitted",
    );
  } finally {
    releaseWrite?.();
    await context.close();
  }
});

test("close aborts a blocked background submission and releases its lifecycle lock", async () => {
  let releaseWrite: (() => void) | undefined;
  const blockedWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const context = fixture({
    sessions: [
      {
        id: "session-stale",
        nativeSessionId: "thread-stale",
        status: "running",
        pendingTurnPhase: "submitted",
        pendingTurnStartedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    exceptionalSessionRequestTimeoutMs: 5_000,
    writeDelays: { "thread/read": blockedWrite },
  });
  await context.service.resumeWorkers();
  await eventually(
    () => context.lifecycleLockActive(),
    "background native submission did not acquire the lifecycle lock",
  );

  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = await Promise.race([
      context.close().then(() => true),
      new Promise<false>((resolve) => {
        closeTimer = setTimeout(() => resolve(false), 250);
      }),
    ]);
    assert.equal(closed, true);
    assert.equal(context.lifecycleLockActive(), false);
  } finally {
    releaseWrite?.();
    if (closeTimer) clearTimeout(closeTimer);
  }
});

test("interactive requests still reconcile an Environment paused after submission", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method === "model/list") return null;
      return undefined;
    },
  });
  try {
    const listing = context.service.listModels("user", "session-one");
    await eventually(
      () =>
        context.writes.some(({ message }) => message.method === "model/list"),
      "interactive model/list was not submitted",
    );
    const request = context.writes.find(
      ({ message }) => message.method === "model/list",
    )?.message;
    context.setRuntimeState({
      desiredState: "paused",
      observedState: "paused",
    });
    context.enqueue([
      {
        id: request?.id,
        result: {
          data: [{ id: "gpt-test" }],
          nextCursor: null,
        },
      },
    ]);

    assert.deepEqual(await listing, { data: [{ id: "gpt-test" }] });
    // The first recovery establishes this process's protocol-ready lease; the
    // second reconciles the pause that won after input submission.
    assert.equal(context.runtimeRecoveryCount(), 2);
  } finally {
    await context.close();
  }
});

test("recovers a Sandbox0 epoch changed outside Sandpi before submitting once", async () => {
  const context = fixture({ authoritativeEpochFence: true });
  try {
    await context.service.resumeWorkers();
    assert.equal(context.runtimeRecoveryCount(), 1);
    context.replaceAuthoritativeRuntime({
      attemptId: "attempt-environment-external",
      runtimeGeneration: 2,
    });

    assert.deepEqual(await context.service.listModels("user", "session-one"), {
      data: [{ id: "gpt-test" }],
    });
    assert.equal(context.runtimeRecoveryCount(), 2);
    assert.equal(
      context.writes.filter(({ message }) => message.method === "model/list")
        .length,
      1,
    );
  } finally {
    await context.close();
  }
});

test("a recovery-owned worker reconnects without waiting on its own recovery", async () => {
  const context = fixture({
    streamErrors: [
      new HttpError(
        503,
        "sandbox0_unavailable",
        "The Supervisor stream is not ready yet.",
      ),
    ],
    rpcTimeoutMs: 250,
  });
  try {
    await context.service.resumeWorkers();
    assert.equal(context.runtimeRecoveryCount(), 1);

    assert.deepEqual(await context.service.listModels("user", "session-one"), {
      data: [{ id: "gpt-test" }],
    });
    assert.equal(context.runtimeRecoveryCount(), 1);
    assert.ok(context.streamStarts.length >= 2);
  } finally {
    await context.close();
  }
});

test("actively recovers after the Supervisor exhausts process restarts", async () => {
  const context = fixture();
  try {
    await context.service.resumeWorkers();
    assert.equal(context.runtimeRecoveryCount(), 1);
    context.recoverRuntimeAs({
      attemptId: "attempt-after-restart-limit",
      runtimeGeneration: 1,
    });

    context.enqueueEvent({
      attemptId: "attempt-environment-test",
      runtimeGeneration: 1,
      type: "session.failed",
      reason: "restart_limit_exceeded",
    });

    await eventually(
      () => context.runtimeRecoveryCount() === 2,
      "Supervisor restart exhaustion did not trigger runtime recovery",
    );
    assert.equal(
      context.environmentRuntime().attemptId,
      "attempt-after-restart-limit",
    );
  } finally {
    await context.close();
  }
});

test("actively recovers a clean Codex exit left without a replacement attempt", async () => {
  const context = fixture();
  try {
    await context.service.resumeWorkers();
    context.recoverRuntimeAs({
      attemptId: "attempt-after-clean-exit",
      runtimeGeneration: 1,
    });

    context.enqueueEvent({
      attemptId: "attempt-environment-test",
      runtimeGeneration: 1,
      type: "attempt.exited",
      exitCode: 0,
      reason: "exited",
    });

    await eventually(
      () => context.runtimeRecoveryCount() === 2,
      "clean Codex exit did not trigger runtime recovery",
    );
    assert.equal(
      context.environmentRuntime().attemptId,
      "attempt-after-clean-exit",
    );
  } finally {
    await context.close();
  }
});

test("lets the Supervisor own a clean-exit backoff before intervening", async () => {
  const context = fixture();
  try {
    await context.service.resumeWorkers();
    context.enqueueEvent({
      attemptId: "attempt-environment-test",
      runtimeGeneration: 1,
      type: "attempt.exited",
      exitCode: 0,
      reason: "exited",
    });
    context.enqueueEvent({
      attemptId: "attempt-environment-test",
      runtimeGeneration: 1,
      type: "session.backoff",
      reason: "500ms",
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(
      context.runtimeRecoveryCount(),
      1,
      "Sandpi must not race the Supervisor's scheduled replacement attempt",
    );
  } finally {
    await context.close();
  }
});

test("does not replay a Turn after its submitted runtime epoch is lost", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method === "turn/start") return null;
      return undefined;
    },
    exceptionalSessionRecoveryDelayMs: 0,
  });
  try {
    await context.service.resumeWorkers();
    const started = context.service.startTurn({
      userId: "user",
      sessionId: "session-one",
      text: "Run once",
      images: [],
    });
    await eventually(
      () =>
        context.writes.some(({ message }) => message.method === "turn/start"),
      "turn/start was not submitted",
    );

    context.replaceAuthoritativeRuntime({
      attemptId: "attempt-environment-next",
      runtimeGeneration: 2,
    });
    context.enqueue(
      [
        {
          method: "runtime/restarted",
          params: {},
        },
      ],
      {
        attemptId: "attempt-environment-next",
        runtimeGeneration: 2,
      },
    );

    const result = await started;
    assert.equal(typeof result.requestId, "string");
    assert.equal(result.nativeTurnId, undefined);
    assert.equal(
      context.writes.filter(({ message }) => message.method === "turn/start")
        .length,
      1,
    );
    await eventually(
      () =>
        context.writes.some(({ message }) => message.method === "thread/read"),
      "ambiguous Turn delivery did not schedule native reconciliation",
    );
  } finally {
    await context.close();
  }
});

test("does not replay a durable Turn while its ambiguous submission epoch is current", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
        pendingTurnPhase: "submitted",
        pendingTurnAttemptId: "attempt-environment-test",
        pendingTurnRuntimeGeneration: 1,
      },
    ],
  });
  try {
    const result = await context.service.startTurn({
      userId: "user",
      sessionId: "session-one",
      text: "Run exactly once",
      images: [],
      durableSubmission: {
        requestId: "request-session-one",
        clientMessageId: "message-session-one",
        stableInputId: "input-session-one",
      },
    });

    assert.equal(result.nativeTurnId, undefined);
    assert.equal(
      context.writes.filter(({ message }) => message.method === "turn/start")
        .length,
      0,
    );
    assert.equal(
      context.sessionRuntimes.get("session-one")?.pendingTurnPhase,
      "submitted",
    );
  } finally {
    await context.close();
  }
});

test("replays one absent durable Turn after its submission epoch is replaced", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
        pendingTurnPhase: "submitted",
        pendingTurnAttemptId: "attempt-before-restart",
        pendingTurnRuntimeGeneration: 0,
      },
    ],
  });
  try {
    const result = await context.service.startTurn({
      userId: "user",
      sessionId: "session-one",
      text: "Run exactly once",
      images: [],
      durableSubmission: {
        requestId: "request-session-one",
        clientMessageId: "message-session-one",
        stableInputId: "input-session-one",
      },
    });

    assert.equal(result.nativeTurnId, "turn-new-1");
    const starts = context.writes.filter(
      ({ message }) => message.method === "turn/start",
    );
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0]?.message.params, {
      threadId: "thread-one",
      clientUserMessageId: "message-session-one",
      input: [
        {
          type: "text",
          text: "Run exactly once",
          text_elements: [],
        },
      ],
    });
    assert.equal(starts[0]?.message.id, "request-session-one");
  } finally {
    await context.close();
  }
});

test("reconciles a durable Turn by client message id without replaying it", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
        pendingTurnPhase: "submitted",
        pendingTurnAttemptId: "attempt-before-restart",
        pendingTurnRuntimeGeneration: 0,
      },
    ],
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-one",
            status: { type: "idle" },
            turns: [
              {
                ...completedTurn("turn-scheduled"),
                items: [
                  {
                    type: "userMessage",
                    id: "user-message-scheduled",
                    clientId: "message-session-one",
                    content: [],
                  },
                ],
              },
            ],
          },
        },
      };
    },
  });
  try {
    const result = await context.service.startTurn({
      userId: "user",
      sessionId: "session-one",
      text: "Run exactly once",
      images: [],
      durableSubmission: {
        requestId: "request-session-one",
        clientMessageId: "message-session-one",
        stableInputId: "input-session-one",
      },
    });

    assert.equal(result.nativeTurnId, "turn-scheduled");
    assert.equal(result.nativeTurnStatus, "completed");
    assert.equal(
      context.writes.filter(({ message }) => message.method === "turn/start")
        .length,
      0,
    );
  } finally {
    await context.close();
  }
});

test("creates one deterministic native Session for a scheduled run retry", async () => {
  const context = fixture({ sessions: [] });
  try {
    const input = {
      userId: "user",
      environment,
      sessionId: "session-scheduled",
      scheduleRunId: "run-scheduled",
      title: "Nightly maintenance",
      modelId: "gpt-test",
    };
    assert.equal(
      await context.service.ensureScheduledSession(input),
      "session-scheduled",
    );
    assert.equal(
      await context.service.ensureScheduledSession(input),
      "session-scheduled",
    );
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/start")
        .length,
      1,
    );
    assert.equal(
      context.sessions.get("session-scheduled")?.title,
      "Nightly maintenance",
    );
    assert.equal(
      context.sessionRuntimes.get("session-scheduled")?.nativeSessionId,
      "thread-new-1",
    );
  } finally {
    await context.close();
  }
});

test("treats an unmaterialized empty scheduled Thread as having no delivered Turn", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        error: {
          code: -32602,
          message:
            "thread thread-one is not materialized yet; includeTurns is unavailable before first user message",
        },
      };
    },
  });
  try {
    assert.deepEqual(
      await context.service.readScheduledTurnStatus({
        userId: "user",
        sessionId: "session-one",
        clientMessageId: "sandpi-schedule:run-empty",
      }),
      { status: "absent" },
    );
    const submitted = await context.service.startTurn({
      userId: "user",
      sessionId: "session-one",
      text: "Materialize this scheduled Thread",
      images: [],
      durableSubmission: {
        requestId: "schedule-turn:run-empty",
        clientMessageId: "sandpi-schedule:run-empty",
        stableInputId: "schedule-turn-input:run-empty",
      },
    });
    assert.equal(submitted.nativeTurnId, "turn-new-1");
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/resume")
        .length,
      0,
    );
  } finally {
    await context.close();
  }
});

test("keeps a scheduled run active while an old-epoch interruption enters native recovery", async () => {
  const scheduledClientMessageId = "sandpi-schedule:run-interrupted";
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
        activeNativeTurnId: "turn-scheduled",
        activeTurnAttemptId: "attempt-before-restart",
        activeTurnRuntimeGeneration: 0,
        pendingTurnClientMessageId: scheduledClientMessageId,
        pendingTurnPhase: "accepted",
        pendingTurnNativeTurnId: "turn-scheduled",
        pendingTurnAttemptId: "attempt-before-restart",
        pendingTurnRuntimeGeneration: 0,
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-one",
            status: { type: "idle" },
            turns: [
              interruptedTurn("turn-scheduled", scheduledClientMessageId),
            ],
          },
        },
      };
    },
  });
  try {
    const result = await context.service.readScheduledTurnStatus({
      userId: "user",
      sessionId: "session-one",
      clientMessageId: scheduledClientMessageId,
    });
    assert.deepEqual(result, {
      status: "running",
      nativeTurnId: "turn-scheduled",
    });
  } finally {
    await context.close();
  }
});

test("adopts the completed recovery Turn for an interrupted scheduled run", async () => {
  const scheduledClientMessageId = "sandpi-schedule:run-recovered";
  const recoveryClientMessageId =
    `${CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX}` +
    `${encodeURIComponent("session-one")}:` +
    `${encodeURIComponent("turn-scheduled")}:persisted`;
  const context = fixture({
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-one",
            status: { type: "idle" },
            turns: [
              interruptedTurn("turn-scheduled", scheduledClientMessageId),
              {
                ...completedTurn("turn-recovery"),
                items: [
                  {
                    type: "userMessage",
                    id: "user-message-recovery",
                    clientId: recoveryClientMessageId,
                    content: [],
                  },
                ],
              },
            ],
          },
        },
      };
    },
  });
  try {
    const result = await context.service.readScheduledTurnStatus({
      userId: "user",
      sessionId: "session-one",
      clientMessageId: scheduledClientMessageId,
    });
    assert.deepEqual(result, {
      status: "succeeded",
      nativeTurnId: "turn-recovery",
    });
  } finally {
    await context.close();
  }
});

test("filters stale records when one Supervisor batch returns to the current epoch", async () => {
  const context = fixture();
  try {
    await context.commitEvents([
      supervisorOutputEvent(
        1,
        [
          {
            method: "turn/started",
            params: {
              threadId: "thread-one",
              turn: { id: "turn-stale" },
            },
          },
        ],
        { attemptId: "attempt-stale", runtimeGeneration: 0 },
      ),
      supervisorOutputEvent(2, [
        {
          method: "turn/started",
          params: {
            threadId: "thread-two",
            turn: { id: "turn-current" },
          },
        },
      ]),
    ]);

    assert.equal(
      context.sessionRuntimes.get("session-one")?.activeNativeTurnId,
      undefined,
    );
    assert.equal(
      context.sessionRuntimes.get("session-two")?.activeNativeTurnId,
      "turn-current",
    );
  } finally {
    await context.close();
  }
});

test("uses the runtime that actually submitted a recovered native snapshot", async () => {
  const context = fixture({ authoritativeEpochFence: true });
  try {
    await context.service.resumeWorkers();
    context.replaceAuthoritativeRuntime({
      attemptId: "attempt-environment-next",
      runtimeGeneration: 2,
    });

    await context.service.readNativeSnapshot("user", "session-one");

    assert.deepEqual(context.reconciledEnvironmentEpochs().at(-1), {
      supervisorSessionId: environment.supervisorSessionId,
      attemptId: "attempt-environment-next",
      runtimeGeneration: 2,
    });
  } finally {
    await context.close();
  }
});

test("starts the Codex RPC timeout only after input submission", async () => {
  let releaseWrite: (() => void) | undefined;
  const blockedWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const context = fixture({
    rpcTimeoutMs: 5,
    writeDelays: { "model/list": blockedWrite },
  });
  try {
    await context.service.resumeWorkers();
    const listing = context.service.listModels("user", "session-one");
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseWrite?.();

    assert.deepEqual(await listing, { data: [{ id: "gpt-test" }] });
  } finally {
    releaseWrite?.();
    await context.close();
  }
});

test("bounds input delivery without replaying an ambiguously submitted Turn", async () => {
  const blockedWrite = new Promise<void>(() => undefined);
  const context = fixture({
    rpcSubmissionTimeoutMs: 5,
    writeDelays: { "turn/start": blockedWrite },
    exceptionalSessionRecoveryDelayMs: 0,
  });
  try {
    await context.service.resumeWorkers();
    const result = await context.service.startTurn({
      userId: "user",
      sessionId: "session-one",
      text: "Do not replay",
      images: [],
    });

    assert.equal(typeof result.requestId, "string");
    assert.equal(result.nativeTurnId, undefined);
    assert.equal(
      context.writes.filter(({ message }) => message.method === "turn/start")
        .length,
      1,
    );
    await eventually(
      () =>
        context.writes.some(({ message }) => message.method === "thread/read"),
      "timed-out input delivery did not enter native reconciliation",
    );
  } finally {
    await context.close();
  }
});

test("closes promptly while exceptional native reconciliation is waiting", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-stale",
        nativeSessionId: "thread-stale",
        status: "running",
        activeNativeTurnId: "turn-stale",
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    onRequest(message) {
      if (message.method === "thread/read") return null;
      return undefined;
    },
  });

  await context.service.resumeWorkers();
  await eventually(
    () =>
      context.writes.some(({ message }) => message.method === "thread/read"),
    "exceptional reconciliation did not begin",
  );
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = await Promise.race([
      context.close().then(() => true),
      new Promise<false>((resolve) => {
        closeTimer = setTimeout(() => resolve(false), 250);
      }),
    ]);
    assert.equal(closed, true);
  } finally {
    if (closeTimer) clearTimeout(closeTimer);
  }
});

test("closes promptly while startup initialization is waiting", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method === "initialize") return null;
      return undefined;
    },
  });

  const recovery = context.service.resumeWorkers();
  await eventually(
    () => context.writes.some(({ message }) => message.method === "initialize"),
    "Environment startup did not reach protocol initialization",
  );
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = await Promise.race([
      context.close().then(() => true),
      new Promise<false>((resolve) => {
        closeTimer = setTimeout(() => resolve(false), 250);
      }),
    ]);
    assert.equal(closed, true);
    await recovery;
  } finally {
    if (closeTimer) clearTimeout(closeTimer);
  }
});

test("closing during slow Environment recovery prevents a new initialize waiter", async () => {
  let releaseRecovery: (() => void) | undefined;
  const recoveryDelay = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const context = fixture({ environmentRecoveryDelay: recoveryDelay });
  const startup = context.service.resumeWorkers();
  await eventually(
    () => context.runtimeRecoveryCount() === 1,
    "Environment recovery did not begin",
  );

  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closing = context.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseRecovery?.();
    const closed = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => {
        closeTimer = setTimeout(() => resolve(false), 250);
      }),
    ]);

    assert.equal(closed, true);
    await startup;
    assert.equal(
      context.writes.filter(({ message }) => message.method === "initialize")
        .length,
      0,
    );
  } finally {
    releaseRecovery?.();
    if (closeTimer) clearTimeout(closeTimer);
  }
});

test("suspending an Environment cancels delayed Session reconciliation", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-stale",
        nativeSessionId: "thread-stale",
        status: "running",
        pendingTurnPhase: "submitted",
      },
    ],
    exceptionalSessionRecoveryDelayMs: 25,
  });
  try {
    await context.service.resumeWorkers();
    context.service.suspendEnvironmentWorker(environment.id);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(context.exceptionalCandidateQueryCount(), 0);
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/read")
        .length,
      0,
    );
    assert.equal(
      context.sessionRuntimes.get("session-stale")?.pendingTurnPhase,
      "submitted",
    );
  } finally {
    await context.close();
  }
});

test("defers exceptional reconciliation until interactive Turn admission finishes", async () => {
  const context = fixture({
    sessions: [
      { id: "session-one", nativeSessionId: "thread-one" },
      { id: "session-two", nativeSessionId: "thread-two" },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    exceptionalPendingTurnGraceMs: 0,
    onRequest(message) {
      if (message.method === "thread/resume") return null;
      return undefined;
    },
  });
  context.recoverRuntimeAs({
    attemptId: "attempt-environment-test-2",
    runtimeGeneration: 2,
  });
  try {
    const starting = context.service.startTurn({
      userId: "user",
      sessionId: "session-one",
      text: "Recover and start",
      images: [],
    });
    await eventually(
      () =>
        context.writes.filter(
          ({ message }) => message.method === "thread/resume",
        ).length === 1,
      "Turn admission did not reach lazy attachment",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(context.exceptionalCandidateQueryCount(), 0);
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/read")
        .length,
      0,
    );

    const resume = context.writes.find(
      ({ message }) => message.method === "thread/resume",
    )?.message;
    context.enqueue([
      {
        id: resume?.id,
        result: {
          thread: {
            id: "thread-one",
            status: { type: "idle" },
            turns: [completedTurn("turn-before-start")],
          },
        },
      },
    ]);
    await starting;
    await eventually(
      () => context.exceptionalCandidateQueryCount() === 1,
      "exceptional reconciliation did not resume after Turn admission",
    );
    await eventually(
      () =>
        context.writes.filter(({ message }) => message.method === "thread/read")
          .length === 1,
      "active Session was not authoritatively checked after recovery",
    );
    assert.equal(
      context.sessionRuntimes.get("session-one")?.pendingTurnPhase,
      "accepted",
    );
    assert.equal(context.sessions.get("session-one")?.status, "running");
  } finally {
    await context.close();
  }
});

test("interactive Turn admission preempts and then reschedules a background Session read", async () => {
  const context = fixture({
    sessions: [
      { id: "session-one", nativeSessionId: "thread-one" },
      {
        id: "session-two",
        nativeSessionId: "thread-two",
        status: "running",
        activeNativeTurnId: "turn-stale",
      },
    ],
    exceptionalSessionRecoveryDelayMs: 0,
    onRequest(message) {
      if (
        message.method === "thread/read" &&
        (message.params as { threadId?: string }).threadId === "thread-two"
      ) {
        return null;
      }
      return undefined;
    },
  });
  try {
    await context.service.resumeWorkers();
    await eventually(
      () =>
        context.writes.some(
          ({ message }) =>
            message.method === "thread/read" &&
            (message.params as { threadId?: string }).threadId === "thread-two",
        ),
      "background reconciliation did not reach the stale Session",
    );

    await context.service.startTurn({
      userId: "user",
      sessionId: "session-one",
      text: "Interactive work takes priority",
      images: [],
    });
    assert.equal(
      context.writes.filter(({ message }) => message.method === "turn/start")
        .length,
      1,
    );
    await eventually(
      () => context.exceptionalCandidateQueryCount() >= 2,
      "preempted exceptional reconciliation was not rescheduled",
    );
    await eventually(
      () =>
        context.writes.filter(
          ({ message }) =>
            message.method === "thread/read" &&
            (message.params as { threadId?: string }).threadId === "thread-two",
        ).length >= 2,
      "rescheduled reconciliation did not revisit the stale Session",
    );
  } finally {
    await context.close();
  }
});

test("repairs only the selected Session projection from its native snapshot", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
        activeNativeTurnId: "turn-stale-one",
      },
      {
        id: "session-two",
        nativeSessionId: "thread-two",
        status: "running",
        activeNativeTurnId: "turn-stale-two",
      },
    ],
  });
  try {
    const snapshot = await context.service.readNativeSnapshot(
      "user",
      "session-one",
    );

    assert.equal(snapshot.sessionStatus, "waiting");
    assert.equal(
      context.sessionRuntimes.get("session-one")?.activeNativeTurnId,
      undefined,
    );
    assert.equal(
      context.sessionRuntimes.get("session-two")?.activeNativeTurnId,
      "turn-stale-two",
    );
    assert.equal(context.sessions.get("session-two")?.status, "running");
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/resume")
        .length,
      0,
    );
  } finally {
    await context.close();
  }
});

test("repairs the active projection to the newest in-progress native Turn", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
        activeNativeTurnId: "turn-stale-active",
        pendingTurnPhase: "accepted",
        pendingTurnNativeTurnId: "turn-current",
      },
    ],
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      const inProgress = (id: string) => ({
        ...completedTurn(id),
        status: "inProgress" as const,
        completedAt: null,
        durationMs: null,
      });
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-one",
            status: { type: "active", activeFlags: [] },
            turns: [
              inProgress("turn-stale-active"),
              inProgress("turn-current"),
            ],
          },
        },
      };
    },
  });
  try {
    await context.service.readNativeSnapshot("user", "session-one");

    assert.equal(
      context.sessionRuntimes.get("session-one")?.activeNativeTurnId,
      "turn-current",
    );
  } finally {
    await context.close();
  }
});

test("repairs an inline review without adopting its interrupted delegate", async () => {
  const review = "One real review finding.";
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
        activeNativeTurnId: "turn-review-delegate",
      },
    ],
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-one",
            status: { type: "idle" },
            turns: [
              {
                ...completedTurn("turn-review"),
                startedAt: null,
                items: [
                  {
                    type: "enteredReviewMode",
                    id: "review-entered",
                    review: "current changes",
                  },
                  {
                    type: "exitedReviewMode",
                    id: "review-exited",
                    review,
                  },
                ],
              },
              {
                ...interruptedTurn("turn-review-delegate"),
                completedAt: null,
                durationMs: null,
                items: [
                  {
                    type: "userMessage",
                    id: "review-prompt",
                    clientId: null,
                    content: [],
                  },
                  {
                    type: "agentMessage",
                    id: "review-result",
                    text: review,
                    phase: null,
                    memoryCitation: null,
                  },
                ],
              },
            ],
          },
        },
      };
    },
  });
  try {
    const snapshot = await context.service.readNativeSnapshot(
      "user",
      "session-one",
    );

    assert.equal(snapshot.thread.turns.length, 2);
    assert.equal(snapshot.sessionStatus, "waiting");
    assert.equal(
      context.sessionRuntimes.get("session-one")?.activeNativeTurnId,
      undefined,
    );
    assert.equal(
      context.writes.filter(({ message }) => message.method === "turn/start")
        .length,
      0,
    );
  } finally {
    await context.close();
  }
});

test("repairs a stale running Session from a native Thread system error", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-system-error",
        nativeSessionId: "thread-system-error",
        status: "running",
        activeNativeTurnId: "turn-system-error",
      },
    ],
    onRequest(message) {
      if (message.method !== "thread/read") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-system-error",
            status: { type: "systemError" },
            turns: [completedTurn("turn-system-error")],
          },
        },
      };
    },
  });
  try {
    const snapshot = await context.service.readNativeSnapshot(
      "user",
      "session-system-error",
    );

    assert.equal(snapshot.thread.status.type, "systemError");
    assert.equal(snapshot.sessionStatus, "waiting");
    assert.equal(
      context.sessionRuntimes.get("session-system-error")?.activeNativeTurnId,
      undefined,
    );
    assert.equal(
      context.service
        .listLiveNotifications("session-system-error")
        .some(
          (update) =>
            update.kind === "invalidation" &&
            update.reason === "native-session-state-reconciled",
        ),
      true,
    );
  } finally {
    await context.close();
  }
});

test("lazily attaches only the native Session that starts a Turn", async () => {
  const context = fixture({
    sessions: [
      { id: "session-one", nativeSessionId: "thread-one" },
      { id: "session-two", nativeSessionId: "thread-two" },
      {
        id: "session-archived",
        nativeSessionId: "thread-archived",
        archived: true,
      },
    ],
  });
  try {
    await context.service.resumeWorkers();
    const started = await context.service.startTurn({
      userId: "user",
      sessionId: "session-one",
      text: "Continue",
      images: [],
      modelId: "gpt-next",
      reasoningEffort: "high",
      clientMessageId: "user-message:browser-e2e",
    });

    assert.match(started.nativeTurnId ?? "", /^turn-new-/);
    assert.equal(started.clientMessageId, "user-message:browser-e2e");
    const nativeMethods = context.writes.filter(({ message }) =>
      ["thread/resume", "turn/start"].includes(String(message.method)),
    );
    assert.deepEqual(
      nativeMethods.map(({ message }) => message.method),
      ["thread/resume", "turn/start"],
    );
    const resumeParams = nativeMethods[0]?.message.params as
      Record<string, unknown> | undefined;
    assert.equal(resumeParams?.threadId, "thread-one");
    assert.equal(resumeParams?.model, "gpt-next");
    assert.deepEqual(resumeParams?.config, {
      "features.apply_patch_streaming_events": true,
      model_reasoning_effort: "high",
    });
    assert.equal("excludeTurns" in (resumeParams ?? {}), false);
    const turnParams = nativeMethods[1]?.message.params as
      Record<string, unknown> | undefined;
    assert.equal(turnParams?.model, "gpt-next");
    assert.equal(turnParams?.effort, "high");
    assert.equal(turnParams?.clientUserMessageId, "user-message:browser-e2e");
    assert.equal(
      context.sessionRuntimes.get("session-one")?.modelId,
      "gpt-next",
    );
    assert.equal(
      context.sessionRuntimes.get("session-one")?.reasoningEffort,
      "high",
    );
    assert.equal(
      context.writes.some(
        ({ message }) =>
          message.method === "thread/resume" &&
          ["thread-two", "thread-archived"].includes(
            String((message.params as { threadId?: string }).threadId),
          ),
      ),
      false,
    );
    await context.service.interruptActiveTurn({
      userId: "user",
      sessionId: "session-one",
      turnId: started.nativeTurnId!,
    });
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/resume")
        .length,
      1,
    );
  } finally {
    await context.close();
  }
});

test("treats an interrupt that reaches an already settled Session as idempotent", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "waiting",
      },
    ],
  });
  try {
    const result = await context.service.interruptActiveTurn({
      userId: "user",
      sessionId: "session-one",
      turnId: "turn-browser-stale",
    });

    assert.deepEqual(result, { status: "settled" });
    assert.equal(
      context.writes.some(({ message }) => message.method === "turn/interrupt"),
      false,
    );
  } finally {
    await context.close();
  }
});

test("still rejects a running Session without an interrupt target", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
      },
    ],
  });
  try {
    await assert.rejects(
      context.service.interruptActiveTurn({
        userId: "user",
        sessionId: "session-one",
      }),
      (error: unknown) =>
        error instanceof HttpError &&
        error.statusCode === 409 &&
        error.code === "codex_turn_not_interruptible",
    );
  } finally {
    await context.close();
  }
});

test("interrupts from the durable active Turn when the browser has no native snapshot", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
        activeNativeTurnId: "turn-active",
        activeTurnAttemptId: "attempt-environment-test",
        activeTurnRuntimeGeneration: 1,
      },
    ],
  });
  try {
    const result = await context.service.interruptActiveTurn({
      userId: "user",
      sessionId: "session-one",
    });

    assert.deepEqual(result, {
      turnId: "turn-active",
      status: "interrupting",
    });
    const interrupt = context.writes.find(
      ({ message }) => message.method === "turn/interrupt",
    )?.message;
    assert.deepEqual(interrupt?.params, {
      threadId: "thread-one",
      turnId: "turn-active",
    });
    assert.equal(
      context.sessionRuntimes.get("session-one")
        ?.interruptRequestedNativeTurnId,
      "turn-active",
    );
  } finally {
    await context.close();
  }
});

test("interrupts the accepted Turn when the active projection still names an older Turn", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
        activeNativeTurnId: "turn-stale-active",
        activeTurnAttemptId: "attempt-environment-test",
        activeTurnRuntimeGeneration: 1,
        pendingTurnPhase: "accepted",
        pendingTurnNativeTurnId: "turn-current",
        pendingTurnAttemptId: "attempt-environment-test",
        pendingTurnRuntimeGeneration: 1,
      },
    ],
  });
  try {
    const result = await context.service.interruptActiveTurn({
      userId: "user",
      sessionId: "session-one",
      turnId: "turn-current",
    });

    assert.deepEqual(result, {
      turnId: "turn-current",
      status: "interrupting",
    });
    const interrupt = context.writes.find(
      ({ message }) => message.method === "turn/interrupt",
    )?.message;
    assert.deepEqual(interrupt?.params, {
      threadId: "thread-one",
      turnId: "turn-current",
    });
    assert.equal(
      context.sessionRuntimes.get("session-one")
        ?.interruptRequestedNativeTurnId,
      "turn-current",
    );
  } finally {
    await context.close();
  }
});

test("retargets a stale browser interrupt to the newest accepted Turn", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
        activeNativeTurnId: "turn-previous",
        activeTurnAttemptId: "attempt-environment-test",
        activeTurnRuntimeGeneration: 1,
        pendingTurnPhase: "accepted",
        pendingTurnNativeTurnId: "turn-current",
        pendingTurnAttemptId: "attempt-environment-test",
        pendingTurnRuntimeGeneration: 1,
      },
    ],
  });
  try {
    const result = await context.service.interruptActiveTurn({
      userId: "user",
      sessionId: "session-one",
      turnId: "turn-browser-stale",
    });

    assert.equal(result.turnId, "turn-current");
    const interrupt = context.writes.find(
      ({ message }) => message.method === "turn/interrupt",
    )?.message;
    assert.deepEqual(interrupt?.params, {
      threadId: "thread-one",
      turnId: "turn-current",
    });
  } finally {
    await context.close();
  }
});

test("does not send a stale Turn interrupt to the replacement runtime", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
        activeNativeTurnId: "turn-from-replaced-runtime",
        activeTurnAttemptId: "attempt-replaced",
        activeTurnRuntimeGeneration: 0,
      },
    ],
    exceptionalSessionRecoveryDelayMs: 60_000,
  });
  try {
    const result = await context.service.interruptActiveTurn({
      userId: "user",
      sessionId: "session-one",
    });

    assert.deepEqual(result, {
      turnId: "turn-from-replaced-runtime",
      status: "interrupting",
    });
    assert.equal(
      context.writes.some(({ message }) => message.method === "turn/interrupt"),
      false,
    );
    assert.equal(
      context.sessionRuntimes.get("session-one")
        ?.interruptRequestedNativeTurnId,
      "turn-from-replaced-runtime",
    );
  } finally {
    await context.close();
  }
});

test("deduplicates concurrent lazy attachment within one app-server attempt", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-one",
        nativeSessionId: "thread-one",
        status: "running",
        activeNativeTurnId: "turn-active",
      },
    ],
    onRequest(message) {
      if (message.method === "thread/resume") return null;
      return undefined;
    },
  });
  try {
    const first = context.service.interruptActiveTurn({
      userId: "user",
      sessionId: "session-one",
      turnId: "turn-active",
    });
    const second = context.service.interruptActiveTurn({
      userId: "user",
      sessionId: "session-one",
      turnId: "turn-active",
    });
    await eventually(
      () =>
        context.writes.filter(
          ({ message }) => message.method === "thread/resume",
        ).length === 1,
      "concurrent interrupts did not share one native attachment",
    );
    const resume = context.writes.find(
      ({ message }) => message.method === "thread/resume",
    )?.message;
    assert.equal(typeof resume?.id, "string");
    context.enqueue([
      {
        id: resume?.id,
        result: {
          thread: {
            id: "thread-one",
            status: { type: "active" },
            turns: [
              {
                ...completedTurn("turn-active"),
                status: "inProgress",
                completedAt: null,
                durationMs: null,
              },
            ],
          },
        },
      },
    ]);

    await Promise.all([first, second]);
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/resume")
        .length,
      1,
    );
    assert.equal(
      context.writes.filter(
        ({ message }) => message.method === "turn/interrupt",
      ).length,
      2,
    );
  } finally {
    await context.close();
  }
});

test("invalidates a lazy attachment when app-server epoch coordinates change", async () => {
  const context = fixture();
  try {
    const started = await context.service.startTurn({
      userId: "user",
      sessionId: "session-one",
      text: "Start",
      images: [],
    });
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/resume")
        .length,
      1,
    );

    context.recoverRuntimeAs({
      attemptId: "attempt-environment-test-2",
      runtimeGeneration: 1,
    });
    await context.service.interruptActiveTurn({
      userId: "user",
      sessionId: "session-one",
      turnId: started.nativeTurnId!,
    });
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/resume")
        .length,
      2,
    );

    context.recoverRuntimeAs({
      attemptId: "attempt-environment-test-2",
      runtimeGeneration: 2,
    });
    await context.service.interruptActiveTurn({
      userId: "user",
      sessionId: "session-one",
      turnId: started.nativeTurnId!,
    });
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/resume")
        .length,
      3,
    );

    context.recoverRuntimeAs({
      supervisorSessionId: "supervisor-environment-test-2",
      attemptId: "attempt-environment-test-2",
      runtimeGeneration: 2,
    });
    await context.service.interruptActiveTurn({
      userId: "user",
      sessionId: "session-one",
      turnId: started.nativeTurnId!,
    });
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/resume")
        .length,
      4,
    );
  } finally {
    await context.close();
  }
});

test("retries a failed lazy attachment without delivering the Turn early", async () => {
  let resumes = 0;
  const context = fixture({
    onRequest(message) {
      if (message.method !== "thread/resume") return undefined;
      resumes += 1;
      if (resumes === 1) {
        return {
          id: message.id,
          error: { code: -32602, message: "thread is closing; retry" },
        };
      }
      return undefined;
    },
  });
  try {
    await assert.rejects(
      context.service.startTurn({
        userId: "user",
        sessionId: "session-one",
        text: "First attempt",
        images: [],
      }),
      (error: unknown) =>
        error instanceof HttpError &&
        error.code === "codex_native_session_attach_failed",
    );
    assert.equal(
      context.writes.filter(({ message }) => message.method === "turn/start")
        .length,
      0,
    );
    assert.equal(
      context.sessionRuntimes.get("session-one")?.pendingTurnPhase,
      undefined,
    );
    assert.equal(context.sessions.get("session-one")?.status, "waiting");

    await context.service.startTurn({
      userId: "user",
      sessionId: "session-one",
      text: "Second attempt",
      images: [],
    });
    assert.equal(resumes, 2);
    assert.equal(
      context.writes.filter(({ message }) => message.method === "turn/start")
        .length,
      1,
    );
  } finally {
    await context.close();
  }
});

test("rejects a lazy attachment returned for a different Thread", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method !== "thread/resume") return undefined;
      return {
        id: message.id,
        result: {
          thread: {
            id: "thread-other",
            status: { type: "idle" },
            turns: [],
          },
        },
      };
    },
  });
  try {
    await assert.rejects(
      context.service.startTurn({
        userId: "user",
        sessionId: "session-one",
        text: "Do not deliver to another Thread",
        images: [],
      }),
      (error: unknown) =>
        error instanceof HttpError &&
        error.code === "codex_thread_resume_failed",
    );
    assert.equal(
      context.writes.filter(({ message }) => message.method === "turn/start")
        .length,
      0,
    );
    assert.equal(context.sessions.get("session-one")?.status, "waiting");
  } finally {
    await context.close();
  }
});

test("abandons pending Turn admission when lazy attachment times out", async () => {
  const context = fixture({
    rpcTimeoutMs: 10,
    onRequest(message) {
      if (message.method === "thread/resume") return null;
      return undefined;
    },
  });
  try {
    await assert.rejects(
      context.service.startTurn({
        userId: "user",
        sessionId: "session-one",
        text: "Do not deliver this early",
        images: [],
      }),
      (error: unknown) =>
        error instanceof HttpError && error.code === "codex_rpc_timeout",
    );
    assert.equal(
      context.writes.filter(({ message }) => message.method === "turn/start")
        .length,
      0,
    );
    assert.equal(
      context.sessionRuntimes.get("session-one")?.pendingTurnPhase,
      undefined,
    );
    assert.equal(context.sessions.get("session-one")?.status, "waiting");
  } finally {
    await context.close();
  }
});

test("reconciles ambiguous Turn delivery lazily after its RPC timeout", async () => {
  const context = fixture({
    rpcTimeoutMs: 10,
    exceptionalSessionRecoveryDelayMs: 0,
    onRequest(message) {
      if (message.method === "turn/start") return null;
      return undefined;
    },
  });
  try {
    const result = await context.service.startTurn({
      userId: "user",
      sessionId: "session-one",
      text: "The delivery response may be lost",
      images: [],
    });

    assert.equal(result.nativeTurnId, undefined);
    await eventually(
      () =>
        context.writes.filter(({ message }) => message.method === "thread/read")
          .length === 1,
      "ambiguous Turn delivery did not schedule a native state read",
    );
    await eventually(
      () =>
        context.sessionRuntimes.get("session-one")?.pendingTurnPhase ===
        undefined,
      "idle native Thread did not release ambiguous Turn delivery state",
    );
    assert.equal(context.sessions.get("session-one")?.status, "waiting");
    assert.equal(
      context.service
        .listLiveNotifications("session-one")
        .some(
          (update) =>
            update.kind === "invalidation" &&
            update.reason === "native-session-state-reconciled",
        ),
      true,
    );
    assert.equal(
      context.writes.filter(({ message }) => message.method === "thread/resume")
        .length,
      1,
    );
  } finally {
    await context.close();
  }
});

test("interactive preemption preserves another Session's exact timeout repair", async () => {
  let sessionOneReads = 0;
  const context = fixture({
    rpcTimeoutMs: 30,
    exceptionalSessionRecoveryDelayMs: 0,
    exceptionalPendingTurnGraceMs: 5_000,
    exceptionalSessionRetryBaseMs: 5,
    onRequest(message) {
      if (
        message.method === "turn/start" &&
        (message.params as { threadId?: string }).threadId === "thread-one"
      ) {
        return null;
      }
      if (
        message.method === "thread/read" &&
        (message.params as { threadId?: string }).threadId === "thread-one"
      ) {
        sessionOneReads += 1;
        if (sessionOneReads === 1) return null;
      }
      return undefined;
    },
  });
  try {
    await context.service.startTurn({
      userId: "user",
      sessionId: "session-one",
      text: "Response may be lost",
      images: [],
    });
    await eventually(
      () => sessionOneReads === 1,
      "exact timeout repair did not begin",
    );

    await context.service.startTurn({
      userId: "user",
      sessionId: "session-two",
      text: "Preempt the background repair",
      images: [],
    });
    await eventually(
      () => sessionOneReads >= 2,
      "preempted exact timeout repair was not rescheduled",
    );
    await eventually(
      () =>
        context.sessionRuntimes.get("session-one")?.pendingTurnPhase ===
        undefined,
      "exact timeout ownership was lost to the ordinary pending grace",
    );
    assert.ok(
      sessionOneReads >= 2,
      "the exact request must remain targeted across interactive preemption",
    );
  } finally {
    await context.close();
  }
});

test("hands an exact timeout repair to a newer app-server epoch", async () => {
  const context = fixture({
    sessions: [
      {
        id: "session-fresh",
        nativeSessionId: "thread-fresh",
        status: "running",
        pendingTurnPhase: "submitted",
        pendingTurnStartedAt: new Date(),
      },
    ],
    exceptionalPendingTurnGraceMs: 5_000,
  });
  try {
    context.scheduleExceptionalRepair(
      "session-fresh",
      "request-session-fresh",
      25,
    );
    context.replaceRuntimeEpoch({
      supervisorSessionId: "supervisor-environment-next",
      attemptId: "attempt-environment-next",
      runtimeGeneration: 2,
    });

    await eventually(
      () =>
        context.writes.some(({ message }) => message.method === "thread/read"),
      "new app-server epoch did not inherit the exact repair",
    );
    await eventually(
      () =>
        context.sessionRuntimes.get("session-fresh")?.pendingTurnPhase ===
        undefined,
      "epoch handoff lost the exact request to ordinary pending grace",
    );
    assert.ok(context.exceptionalCandidateQueryCount() >= 2);
  } finally {
    await context.close();
  }
});

test("routes a shared Supervisor journal by native thread id", async () => {
  const context = fixture();
  context.enqueue([
    {
      method: "turn/started",
      params: {
        threadId: "thread-one",
        turn: { ...completedTurn("turn-one-live"), status: "inProgress" },
      },
    },
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-two",
        turnId: "turn-two-live",
        itemId: "item-two",
        delta: "hello",
      },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-one",
        turnId: "turn-one-live",
        tokenUsage: {
          total: {
            inputTokens: 24_000,
            cachedInputTokens: 2_000,
            cacheWriteInputTokens: 0,
            outputTokens: 3_000,
            reasoningOutputTokens: 1_000,
            totalTokens: 28_000,
          },
          last: {
            inputTokens: 20_000,
            cachedInputTokens: 2_000,
            cacheWriteInputTokens: 0,
            outputTokens: 3_000,
            reasoningOutputTokens: 1_000,
            totalTokens: 24_000,
          },
          modelContextWindow: 200_000,
        },
      },
    },
  ]);

  try {
    context.service.ensureWorker("session-one");
    await eventually(
      () =>
        context.service.listLiveNotifications("session-one").length > 0 &&
        context.service.listLiveNotifications("session-two").length > 0,
      "shared Supervisor events were not streamed",
    );
    const one = context.service.listLiveNotifications("session-one");
    const two = context.service.listLiveNotifications("session-two");
    assert.deepEqual(
      one.map((update) =>
        update.kind === "notification" ? update.event.notification.method : "",
      ),
      ["turn/started", "thread/tokenUsage/updated"],
    );
    assert.deepEqual(
      two.map((update) =>
        update.kind === "notification" ? update.event.notification.method : "",
      ),
      ["item/agentMessage/delta"],
    );
    assert.equal(
      context.sessionRuntimes.get("session-one")?.activeNativeTurnId,
      "turn-one-live",
    );
    assert.equal(
      context.sessionRuntimes.get("session-two")?.activeNativeTurnId,
      undefined,
    );
  } finally {
    await context.close();
  }
});

test("keeps an inline review wrapper as the Session control Turn", async () => {
  const context = fixture();
  try {
    await context.commitEvents([
      supervisorOutputEvent(1, [
        {
          method: "item/started",
          params: {
            threadId: "thread-one",
            turnId: "turn-review",
            item: {
              type: "enteredReviewMode",
              id: "review-entered",
              review: "current changes",
            },
          },
        },
      ]),
    ]);
    assert.equal(
      context.sessionRuntimes.get("session-one")?.activeNativeTurnId,
      "turn-review",
    );

    await context.commitEvents([
      supervisorOutputEvent(2, [
        {
          method: "turn/started",
          params: {
            threadId: "thread-one",
            turn: {
              ...completedTurn("turn-review-delegate"),
              status: "inProgress",
              completedAt: null,
              durationMs: null,
            },
          },
        },
      ]),
    ]);
    assert.equal(
      context.sessionRuntimes.get("session-one")?.activeNativeTurnId,
      "turn-review",
    );

    await context.commitEvents([
      supervisorOutputEvent(3, [
        {
          method: "turn/completed",
          params: {
            threadId: "thread-one",
            turn: completedTurn("turn-review"),
          },
        },
      ]),
    ]);
    assert.equal(
      context.sessionRuntimes.get("session-one")?.activeNativeTurnId,
      undefined,
    );
    assert.equal(context.sessions.get("session-one")?.status, "waiting");
  } finally {
    await context.close();
  }
});

test("marks completed Turns for persisted Activity refresh", async () => {
  const context = fixture();
  context.enqueue([
    {
      method: "turn/started",
      params: {
        threadId: "thread-one",
        turn: { ...completedTurn("turn-refresh"), status: "inProgress" },
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId: "thread-one",
        turn: completedTurn("turn-refresh"),
      },
    },
  ]);

  try {
    context.service.ensureWorker("session-one");
    await eventually(
      () => context.service.listLiveNotifications("session-one").length === 2,
      "completed Turn notifications were not streamed",
    );
    const updates = context.service.listLiveNotifications("session-one");
    assert.deepEqual(
      updates.map((update) =>
        update.kind === "notification"
          ? update.refreshPersistedActivity
          : undefined,
      ),
      [false, true],
    );
  } finally {
    await context.close();
  }
});

test("streams native Thread status and Turn error notifications", async () => {
  const context = fixture();
  context.enqueue([
    {
      method: "thread/status/changed",
      params: {
        threadId: "thread-one",
        status: { type: "systemError" },
      },
    },
    {
      method: "error",
      params: {
        threadId: "thread-one",
        turnId: "turn-system-error",
        willRetry: false,
        error: {
          message: "simulated failure",
          codexErrorInfo: null,
          additionalDetails: null,
        },
      },
    },
  ]);

  try {
    context.service.ensureWorker("session-one");
    await eventually(
      () => context.service.listLiveNotifications("session-one").length === 2,
      "native error state notifications were not streamed",
    );
    assert.deepEqual(
      context.service
        .listLiveNotifications("session-one")
        .map((update) =>
          update.kind === "notification"
            ? update.event.notification.method
            : "",
        ),
      ["thread/status/changed", "error"],
    );
  } finally {
    await context.close();
  }
});

test("keeps one idle Supervisor event stream per Environment", async () => {
  const context = fixture();
  try {
    context.service.ensureWorker("session-one");
    context.service.ensureWorker("session-two");
    await eventually(
      () => context.streamStarts.length === 1,
      "Environment event stream did not start",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(context.streamStarts, [0]);
  } finally {
    await context.close();
  }
});

test("publishes a running tool before Codex completes it", async () => {
  const context = fixture();
  try {
    context.service.ensureWorker("session-one");
    context.enqueue([
      {
        method: "item/started",
        params: {
          threadId: "thread-one",
          turnId: "turn-tool-live",
          item: {
            type: "commandExecution",
            id: "command-tool-live",
            command: "npm install",
            cwd: "/workspace",
            status: "inProgress",
          },
        },
      },
    ]);

    await eventually(
      () => context.service.listLiveNotifications("session-one").length === 1,
      "running tool notification was not published",
    );
    const notifications = context.service
      .listLiveNotifications("session-one")
      .flatMap((update) =>
        update.kind === "notification" ? [update.event.notification] : [],
      );
    assert.deepEqual(
      notifications.map((notification) => notification.method),
      ["item/started"],
    );
    assert.equal(
      notifications.some(
        (notification) => notification.method === "item/completed",
      ),
      false,
    );
  } finally {
    await context.close();
  }
});

test("publishes an incremental file edit before Codex starts the completed item", async () => {
  const context = fixture();
  try {
    context.service.ensureWorker("session-one");
    context.enqueue([
      {
        method: "item/fileChange/patchUpdated",
        params: {
          threadId: "thread-one",
          turnId: "turn-file-live",
          itemId: "file-tool-live",
          changes: [
            {
              path: "/workspace/app/page.tsx",
              kind: { type: "update", move_path: null },
              diff: "-old\n+new",
            },
          ],
        },
      },
    ]);

    await eventually(
      () => context.service.listLiveNotifications("session-one").length === 1,
      "incremental file edit notification was not published",
    );
    const notifications = context.service
      .listLiveNotifications("session-one")
      .flatMap((update) =>
        update.kind === "notification" ? [update.event.notification] : [],
      );
    assert.deepEqual(
      notifications.map((notification) => notification.method),
      ["item/fileChange/patchUpdated"],
    );
    assert.equal(
      notifications.some(
        (notification) => notification.method === "item/started",
      ),
      false,
    );
  } finally {
    await context.close();
  }
});

test("reconnects the Supervisor stream from the committed cursor", async () => {
  const context = fixture();
  try {
    context.service.ensureWorker("session-one");
    await eventually(
      () => context.streamStarts.length === 1,
      "initial Environment event stream did not start",
    );
    context.enqueue([
      {
        method: "turn/started",
        params: {
          threadId: "thread-one",
          turn: { ...completedTurn("turn-stream-one"), status: "inProgress" },
        },
      },
    ]);
    await eventually(
      () => context.service.listLiveNotifications("session-one").length === 1,
      "first streamed notification was not committed",
    );

    context.disconnectStreams();
    context.enqueue([
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-one",
          turnId: "turn-stream-one",
          itemId: "message-stream-one",
          delta: "still live",
        },
      },
    ]);
    await eventually(
      () => context.streamStarts.length >= 2,
      "Environment event stream did not reconnect",
    );
    await eventually(
      () => context.service.listLiveNotifications("session-one").length === 2,
      "retained event was not replayed after reconnect",
    );

    assert.deepEqual(context.streamStarts.slice(0, 2), [0, 1]);
    assert.deepEqual(
      context.service
        .listLiveNotifications("session-one")
        .map((update) =>
          update.kind === "notification"
            ? update.event.notification.method
            : "",
        ),
      ["turn/started", "item/agentMessage/delta"],
    );
  } finally {
    await context.close();
  }
});

test("recovers an expired Supervisor cursor before reconnecting", async () => {
  const context = fixture({
    streamErrors: [
      new HttpError(
        410,
        "sandbox0_event_cursor_expired",
        "event cursor expired; earliest available sequence is 5",
      ),
    ],
  });
  try {
    context.service.ensureWorker("session-one");
    await eventually(
      () => context.streamStarts.length >= 2,
      "expired event stream did not reconnect",
    );

    assert.deepEqual(context.streamStarts.slice(0, 2), [0, 4]);
    const invalidation = context.service
      .listLiveNotifications("session-one")
      .find((update) => update.kind === "invalidation");
    assert.equal(
      invalidation?.kind === "invalidation" ? invalidation.reason : undefined,
      "supervisor-journal-gap",
    );
  } finally {
    await context.close();
  }
});

test("recovers when the Supervisor journal restarts behind the committed cursor", async () => {
  const context = fixture({
    initialDecoder: {
      supervisorCursor: 3_333,
      tailBase64: "",
      attemptId: "attempt-before-journal-restart",
      runtimeGeneration: 17,
    },
    initialEventSequence: 2_277,
    streamErrors: [
      new HttpError(
        500,
        "sandbox0_stream_session_events_failed",
        "event cursor must not be greater than latest sequence 2277",
      ),
    ],
    rpcTimeoutMs: 250,
    onRequest(message) {
      if (message.method !== "initialize") return undefined;
      return {
        id: message.id,
        error: { code: -32600, message: "Already initialized" },
      };
    },
  });
  try {
    assert.deepEqual(await context.service.listModels("user", "session-one"), {
      data: [{ id: "gpt-test" }],
    });
    await eventually(
      () => context.streamStarts.length >= 2,
      "rewound event stream did not reconnect",
    );

    assert.deepEqual(context.streamStarts.slice(0, 2), [3_333, 2_277]);
    assert.equal(
      context
        .service
        .listLiveNotifications("session-one")
        .some(
          (update) =>
            update.kind === "invalidation" &&
            update.reason === "supervisor-journal-rewound",
        ),
      true,
    );
    assert.equal(
      context.environmentRuntime().decoder.runtimeGeneration,
      context.environmentRuntime().runtimeGeneration,
    );
    assert.equal(
      context.environmentRuntime().decoder.attemptId,
      context.environmentRuntime().attemptId,
    );
  } finally {
    await context.close();
  }
});

test("forks a product Session only through Codex thread/fork", async () => {
  const context = fixture();
  try {
    const childId = await context.service.forkSession({
      userId: "user",
      sessionId: "session-one",
      title: "Native child",
    });
    const child = context.sessionRuntimes.get(childId);

    assert.equal(child?.environmentId, environment.id);
    assert.match(child?.nativeSessionId ?? "", /^thread-child-/);
    assert.equal(context.sessions.get(childId)?.title, "Native child");
    assert.equal(
      context.writes.filter((write) => write.message.method === "thread/fork")
        .length,
      1,
    );
    const forkParams = context.writes.find(
      (write) => write.message.method === "thread/fork",
    )?.message.params as Record<string, unknown> | undefined;
    assert.deepEqual(forkParams?.config, {
      "features.apply_patch_streaming_events": true,
    });
    assert.equal(
      forkParams?.threadSource,
      `sandpi-session:${childId}`,
    );
    await context.service.startTurn({
      userId: "user",
      sessionId: childId,
      text: "Continue the fork",
      images: [],
    });
    assert.equal(
      context.writes.filter((write) => write.message.method === "thread/resume")
        .length,
      0,
    );
    assert.ok(
      context.writes.every(
        (write) => !String(write.message.method).includes("snapshot"),
      ),
    );
  } finally {
    await context.close();
  }
});

test("reconciles a persisted native fork when the thread/fork response is lost", async () => {
  let creationSource: string | undefined;
  const context = fixture({
    rpcTimeoutMs: 5,
    onRequest(message) {
      if (message.method === "thread/fork") {
        creationSource = (message.params as Record<string, unknown>)
          .threadSource as string;
        return null;
      }
      if (message.method === "thread/list") {
        return {
          id: message.id,
          result: {
            data: [
              {
                id: "thread-recovered-fork",
                threadSource: creationSource,
                status: { type: "idle" },
                turns: [],
              },
            ],
            nextCursor: null,
          },
        };
      }
      return undefined;
    },
  });
  try {
    const childId = await context.service.forkSession({
      userId: "user",
      sessionId: "session-one",
      title: "Recovered fork",
    });

    assert.equal(
      context.sessionRuntimes.get(childId)?.nativeSessionId,
      "thread-recovered-fork",
    );
    assert.equal(context.sessions.get(childId)?.status, "waiting");
    assert.deepEqual(
      context.writes
        .map(({ message }) => message.method)
        .filter((method) => method !== "initialize" && method !== "initialized"),
      ["thread/fork", "thread/list"],
    );
  } finally {
    await context.close();
  }
});

test("lists and toggles Environment skills through Codex native RPCs", async () => {
  const skillPath = "/workspace/.agents/skills/release/SKILL.md";
  const context = fixture({
    onRequest(message) {
      if (message.method === "skills/list") {
        return {
          id: message.id,
          result: {
            data: [
              {
                cwd: "/workspace",
                skills: [
                  {
                    name: "release",
                    description: "Prepare a release.",
                    path: skillPath,
                    scope: "repo",
                    enabled: true,
                    interface: { displayName: "Release" },
                    dependencies: {
                      tools: [{ type: "mcp", value: "github" }],
                    },
                  },
                ],
                errors: [],
              },
            ],
          },
        };
      }
      if (message.method === "skills/config/write") {
        return {
          id: message.id,
          result: { effectiveEnabled: false },
        };
      }
      return undefined;
    },
  });
  try {
    const inventory = await context.service.listEnvironmentSkills(
      "user",
      environment.id,
    );
    assert.equal(inventory.skills[0]?.displayName, "Release");
    assert.deepEqual(inventory.skills[0]?.dependencies, [
      { type: "mcp", value: "github" },
    ]);

    const updated = await context.service.setEnvironmentSkillEnabled({
      userId: "user",
      environmentId: environment.id,
      path: skillPath,
      enabled: false,
    });
    assert.deepEqual(updated, { path: skillPath, enabled: false });
    const write = context.writes.find(
      ({ message }) => message.method === "skills/config/write",
    );
    assert.deepEqual(write?.message.params, {
      path: skillPath,
      enabled: false,
    });
  } finally {
    await context.close();
  }
});

test("lists native MCP definitions and toggles only the user layer", async () => {
  let docsEnabled = true;
  const context = fixture({
    onRequest(message) {
      if (message.method === "config/read") {
        const docs = {
          url: "https://docs.example.test/mcp",
          enabled: docsEnabled,
        };
        const admin = {
          command: "admin-mcp",
          args: ["--stdio"],
          enabled: true,
        };
        return {
          id: message.id,
          result: {
            config: { mcp_servers: { admin, docs } },
            layers: [
              {
                name: { type: "user", profile: null },
                config: { mcp_servers: { docs } },
              },
              {
                name: { type: "admin", profile: null },
                config: { mcp_servers: { admin } },
              },
            ],
          },
        };
      }
      if (message.method === "mcpServerStatus/list") {
        return {
          id: message.id,
          result: {
            data: [
              {
                name: "docs",
                serverInfo: {
                  name: "docs",
                  title: "Documentation",
                  version: "1.0.0",
                },
                tools: { search: { name: "search" } },
                resources: [
                  {
                    name: "guide",
                    title: "Guide",
                    uri: "docs://guide",
                  },
                ],
                resourceTemplates: [
                  {
                    name: "topic",
                    title: "Topic",
                    uriTemplate: "docs://topics/{topic}",
                  },
                ],
                authStatus: "unsupported",
              },
            ],
            nextCursor: null,
          },
        };
      }
      if (message.method === "config/value/write") {
        docsEnabled = false;
        return { id: message.id, result: { status: "ok" } };
      }
      if (message.method === "config/mcpServer/reload") {
        return { id: message.id, result: {} };
      }
      return undefined;
    },
  });
  try {
    const inventory = await context.service.listEnvironmentMcpServers(
      "user",
      environment.id,
    );
    assert.deepEqual(
      inventory.servers.map((server) => ({
        name: server.name,
        transport: server.transport,
        managed: server.managed,
        runtimeStatus: server.runtimeStatus,
        toolCount: server.toolCount,
        resourceCount: server.resourceCount,
      })),
      [
        {
          name: "admin",
          transport: "stdio",
          managed: false,
          runtimeStatus: "unavailable",
          toolCount: 0,
          resourceCount: 0,
        },
        {
          name: "docs",
          transport: "streamable-http",
          managed: true,
          runtimeStatus: "connected",
          toolCount: 1,
          resourceCount: 2,
        },
      ],
    );
    const verboseInventory =
      await context.service.listEnvironmentMcpServers(
        "user",
        environment.id,
        "full",
      );
    const verboseDocs = verboseInventory.servers.find(
      (server) => server.name === "docs",
    );
    assert.deepEqual(verboseDocs?.tools, ["search"]);
    assert.deepEqual(verboseDocs?.resources, [
      { name: "guide", title: "Guide", uri: "docs://guide" },
    ]);
    assert.deepEqual(verboseDocs?.resourceTemplates, [
      {
        name: "topic",
        title: "Topic",
        uriTemplate: "docs://topics/{topic}",
      },
    ]);
    assert.deepEqual(
      context.writes
        .filter(({ message }) => message.method === "mcpServerStatus/list")
        .slice(0, 2)
        .map(({ message }) => (message.params as { detail: string }).detail),
      ["toolsAndAuthOnly", "full"],
    );

    const updated = await context.service.setEnvironmentMcpServerEnabled({
      userId: "user",
      environmentId: environment.id,
      name: "docs",
      enabled: false,
    });
    assert.equal(
      updated.servers.find((server) => server.name === "docs")?.runtimeStatus,
      "disabled",
    );
    const write = context.writes.find(
      ({ message }) => message.method === "config/value/write",
    );
    assert.deepEqual(write?.message.params, {
      keyPath: "mcp_servers.docs.enabled",
      value: false,
      mergeStrategy: "replace",
    });

    await assert.rejects(
      context.service.setEnvironmentMcpServerEnabled({
        userId: "user",
        environmentId: environment.id,
        name: "admin",
        enabled: false,
      }),
      (error) =>
        error instanceof HttpError &&
        error.code === "codex_mcp_server_not_managed",
    );
  } finally {
    await context.close();
  }
});

test("starts native MCP OAuth with a constrained remote callback", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method === "config/read") {
        const linear = {
          url: "https://mcp.linear.app/mcp",
          enabled: true,
        };
        return {
          id: message.id,
          result: {
            config: { mcp_servers: { linear } },
            layers: [
              {
                name: { type: "user", profile: null },
                config: { mcp_servers: { linear } },
              },
            ],
          },
        };
      }
      if (message.method === "mcpServerStatus/list") {
        return {
          id: message.id,
          result: {
            data: [
              {
                name: "linear",
                serverInfo: null,
                tools: {},
                resources: [],
                resourceTemplates: [],
                authStatus: "notLoggedIn",
              },
            ],
            nextCursor: null,
          },
        };
      }
      if (message.method === "config/batchWrite") {
        return { id: message.id, result: { status: "ok" } };
      }
      if (message.method === "mcpServer/oauth/login") {
        return {
          id: message.id,
          result: {
            authorizationUrl:
              "https://linear.example.test/oauth/authorize?state=test",
          },
        };
      }
      return undefined;
    },
  });
  try {
    const startedAt = Date.now() / 1_000;
    const login = await context.service.startEnvironmentMcpServerOAuthLogin({
      userId: "user",
      environmentId: environment.id,
      name: "linear",
    });

    assert.equal(login.name, "linear");
    assert.equal(
      login.authorizationUrl,
      "https://linear.example.test/oauth/authorize?state=test",
    );
    assert.ok(login.expiresAt >= startedAt + 299);
    assert.ok(login.expiresAt <= startedAt + 301);
    assert.deepEqual(context.mcpOAuthCallbacks, [{ port: 43_419 }]);

    const configWrite = context.writes.find(
      ({ message }) => message.method === "config/batchWrite",
    );
    assert.deepEqual(configWrite?.message.params, {
      edits: [
        {
          keyPath: "mcp_oauth_credentials_store",
          value: "file",
          mergeStrategy: "replace",
        },
        {
          keyPath: "mcp_oauth_callback_port",
          value: 43_419,
          mergeStrategy: "replace",
        },
        {
          keyPath: "mcp_oauth_callback_url",
          value: "https://oauth-callback.example.test/callback/",
          mergeStrategy: "replace",
        },
      ],
      reloadUserConfig: true,
    });
    const loginWrite = context.writes.find(
      ({ message }) => message.method === "mcpServer/oauth/login",
    );
    assert.deepEqual(loginWrite?.message.params, {
      name: "linear",
      timeoutSecs: 300,
    });
  } finally {
    await context.close();
  }
});

test("rejects an unsafe Sandbox0 MCP OAuth callback URL", async () => {
  const context = fixture({
    mcpOAuthCallbackPublicUrl: "http://oauth.example.test",
    onRequest(message) {
      if (message.method === "config/read") {
        const linear = {
          url: "https://mcp.linear.app/mcp",
          enabled: true,
        };
        return {
          id: message.id,
          result: {
            config: { mcp_servers: { linear } },
            layers: [
              {
                name: { type: "user", profile: null },
                config: { mcp_servers: { linear } },
              },
            ],
          },
        };
      }
      if (message.method === "mcpServerStatus/list") {
        return {
          id: message.id,
          result: {
            data: [
              {
                name: "linear",
                serverInfo: null,
                tools: {},
                resources: [],
                resourceTemplates: [],
                authStatus: "notLoggedIn",
              },
            ],
            nextCursor: null,
          },
        };
      }
      return undefined;
    },
  });
  try {
    await assert.rejects(
      context.service.startEnvironmentMcpServerOAuthLogin({
        userId: "user",
        environmentId: environment.id,
        name: "linear",
      }),
      (error) =>
        error instanceof HttpError &&
        error.code === "sandbox0_mcp_oauth_callback_url_invalid",
    );
    assert.equal(
      context.writes.some(
        ({ message }) => message.method === "config/batchWrite",
      ),
      false,
    );
  } finally {
    await context.close();
  }
});

test("reloads native MCP servers after OAuth completes", async () => {
  const context = fixture();
  try {
    context.enqueue([
      {
        method: "mcpServer/oauthLogin/completed",
        params: {
          name: "linear",
          threadId: null,
          success: true,
        },
      },
    ]);
    context.service.ensureWorker("session-one");
    await eventually(
      () =>
        context.writes.some(
          ({ message }) => message.method === "config/mcpServer/reload",
        ),
      "successful MCP OAuth did not reload native servers",
    );
  } finally {
    await context.close();
  }
});
