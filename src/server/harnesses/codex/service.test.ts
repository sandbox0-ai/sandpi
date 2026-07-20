import assert from "node:assert/strict";
import test from "node:test";

import type { CodexThread } from "@/harnesses/codex/types";
import type { CodingSession, Environment } from "@/lib/types";
import type { RuntimeAdapter } from "@/server/runtime/types";
import { HttpError } from "@/server/http-error";
import type {
  CodexControlTransition,
  SandpiStore,
  StoredEnvironmentRuntime,
  StoredSessionRuntime,
} from "@/server/store";
import {
  CodexService,
  type CodexCredentialProvider,
} from "./service";
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
  async mcpOAuthCredentialForEnvironmentRuntime() {
    return undefined;
  },
  async markMcpOAuthCredentialMaterialized() {},
  async syncMcpOAuthCredentialFromRuntime() {
    return undefined;
  },
} satisfies CodexCredentialProvider;

const environment: Environment = {
  id: "environment-test",
  teamId: "team-test",
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
  mcpLogoutNames: string[];
  exceptionalCandidateQueryCount(): number;
  lifecycleLockActive(): boolean;
  runtimeRecoveryCount(): number;
  environmentRuntime(): StoredEnvironmentRuntime;
  setMcpOauthCredentialsJson(value: string | undefined): void;
  reconciledEnvironmentEpochs(): Array<{
    supervisorSessionId?: string;
    attemptId?: string;
    runtimeGeneration: number;
  }>;
  setRuntimeState(input: {
    desiredState: StoredEnvironmentRuntime["desiredState"];
    observedState: StoredEnvironmentRuntime["observedState"];
  }): void;
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

function fixture(input: {
  sessions?: Array<{
    id: string;
    nativeSessionId: string;
    archived?: boolean;
    status?: CodingSession["status"];
    activeNativeTurnId?: string;
    pendingTurnPhase?: StoredSessionRuntime["pendingTurnPhase"];
    pendingTurnStartedAt?: Date;
    reasoningEffort?: string;
  }>;
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
  writeDelays?: Record<string, Promise<void>>;
  authoritativeEpochFence?: boolean;
  rollouts?: Record<string, string | Error | Promise<string>>;
  credentials?: CodexCredentialProvider;
  mcpOauthCredentialsJson?: string;
} = {}): Fixture {
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
    initial.map(({
      id,
      nativeSessionId,
      activeNativeTurnId,
      pendingTurnPhase,
      pendingTurnStartedAt,
      reasoningEffort,
      status,
    }) => {
      const runtime = sessionRuntime(id, nativeSessionId);
      return [
        id,
        {
          ...runtime,
          activeNativeTurnId,
          pendingTurnRequestId: pendingTurnPhase
            ? `request-${id}`
            : undefined,
          pendingTurnClientMessageId: pendingTurnPhase
            ? `message-${id}`
            : undefined,
          pendingTurnStableInputId: pendingTurnPhase
            ? `input-${id}`
            : undefined,
          pendingTurnPhase,
          pendingTurnStartedAt,
          reasoningEffort,
          sessionStatus: status ?? runtime.sessionStatus,
        },
      ] as [string, StoredSessionRuntime];
    }),
  );
  let environmentRuntime: StoredEnvironmentRuntime = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: environment.supervisorSessionId,
    terminalSessionId: undefined,
    attemptId: "attempt-environment-test",
    runtimeGeneration: 1,
    decoder: {
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
  const mcpLogoutNames: string[] = [];
  let mcpOauthCredentialsJson = input.mcpOauthCredentialsJson;
  let exceptionalCandidateQueries = 0;
  let lifecycleLockDepth = 0;
  let runtimeRecoveries = 0;
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
  let lastStartedThreadId: string | undefined;
  let lastStartedTurnId: string | undefined;

  const enqueue = (
    messages: Record<string, unknown>[],
    coordinates?: { attemptId: string; runtimeGeneration: number },
  ) => {
    const seq = events.length + 1;
    events.push({
      seq,
      runtimeGeneration:
        coordinates?.runtimeGeneration ?? environmentRuntime.runtimeGeneration,
      attemptId: coordinates?.attemptId ?? environmentRuntime.attemptId,
      type: "output",
      stream: "stdout",
      dataBase64: Buffer.from(
        `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
      ).toString("base64"),
      occurredAt: "2026-07-16T00:00:00.000Z",
    });
    for (const stream of activeStreams) stream.wake?.();
  };

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
    async withEnvironmentMcpOAuthCredentialLock(
      _environmentId: string,
      operation: (lockedStore: SandpiStore) => Promise<unknown>,
    ) {
      if (input.assertScopedRecoveryLocks) {
        assert.fail(
          "credential lock must be acquired through the lifecycle-scoped Store",
        );
      }
      return operation(rootStore);
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
          sessionRuntimes.set(owner.sessionId, {
            ...current,
            activeNativeTurnId: transition.nativeTurnId,
            sessionStatus: "running",
          });
          sessions.set(owner.sessionId, { ...currentSession, status: "running" });
        } else {
          sessionRuntimes.set(owner.sessionId, {
            ...current,
            activeNativeTurnId: undefined,
            sessionStatus: "waiting",
          });
          sessions.set(owner.sessionId, { ...currentSession, status: "waiting" });
        }
      }
      return true;
    },
    async resetEnvironmentDecoder(_environmentId: string, cursor: number) {
      environmentRuntime = {
        ...environmentRuntime,
        decoder: {
          ...environmentRuntime.decoder,
          supervisorCursor: cursor,
          tailBase64: "",
        },
      };
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
    async createForkSessionMetadata(options: {
      source: CodingSession;
      title?: string;
      modelId?: string;
      reasoningEffort?: string;
    }) {
      const id = `session-child-${++childSequence}`;
      sessions.set(
        id,
        session(id, "", "paused"),
      );
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
      sessions.set(sessionId, { ...sessions.get(sessionId)!, status: "failed" });
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
      const activeChanged =
        current.activeNativeTurnId !== options.activeNativeTurnId;
      sessionRuntimes.set(options.sessionId, {
        ...current,
        activeNativeTurnId: options.activeNativeTurnId,
        pendingTurnRequestId: clearPending
          ? undefined
          : current.pendingTurnRequestId,
        pendingTurnClientMessageId: clearPending
          ? undefined
          : current.pendingTurnClientMessageId,
        pendingTurnStableInputId: clearPending
          ? undefined
          : current.pendingTurnStableInputId,
        pendingTurnPhase: clearPending
          ? undefined
          : current.pendingTurnPhase,
        pendingTurnNativeTurnId: clearPending
          ? undefined
          : current.pendingTurnNativeTurnId,
        pendingTurnStartedAt: clearPending
          ? undefined
          : current.pendingTurnStartedAt,
        sessionStatus:
          options.activeNativeTurnId ||
          (!clearPending && current.pendingTurnPhase)
            ? "running"
            : "waiting",
        version: current.version + (activeChanged || clearPending ? 1 : 0),
      });
      sessions.set(options.sessionId, {
        ...sessions.get(options.sessionId)!,
        status:
          options.activeNativeTurnId ||
          (!clearPending && current.pendingTurnPhase)
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
        sessionStatus: "running",
        version: current.version + 1,
      });
      sessions.set(sessionId, { ...currentSession, status: "running" });
    },
    async markTurnSubmitted(sessionId: string, requestId: string) {
      const current = sessionRuntimes.get(sessionId)!;
      if (
        current.pendingTurnRequestId !== requestId ||
        current.pendingTurnPhase !== "prepared"
      ) {
        return;
      }
      sessionRuntimes.set(sessionId, {
        ...current,
        pendingTurnPhase: "submitted",
        version: current.version + 1,
      });
    },
    async markTurnAccepted(
      sessionId: string,
      requestId: string,
      nativeTurnId: string,
    ) {
      const current = sessionRuntimes.get(sessionId)!;
      if (current.pendingTurnRequestId !== requestId) return;
      sessionRuntimes.set(sessionId, {
        ...current,
        pendingTurnPhase: "accepted",
        pendingTurnNativeTurnId: nativeTurnId,
        activeNativeTurnId: current.activeNativeTurnId ?? nativeTurnId,
        version: current.version + 1,
      });
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
        activeNativeTurnId: undefined,
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
  const recoveryCredentialStore = Object.assign(
    Object.create(store) as SandpiStore,
    {
      async environmentRuntime() {
        assert.fail(
          "runtime reconciliation must retain the outer lifecycle-scoped Store",
        );
      },
      async recordCodexEnvironmentRuntime() {
        assert.fail(
          "runtime reconciliation must retain the outer lifecycle-scoped Store",
        );
      },
    },
  );
  const recoveryLifecycleStore = Object.assign(
    Object.create(store) as SandpiStore,
    {
      async withEnvironmentMcpOAuthCredentialLock<T>(
        requestedEnvironmentId: string,
        operation: (lockedStore: SandpiStore) => Promise<T>,
      ) {
        assert.equal(requestedEnvironmentId, environment.id);
        assert.equal(lifecycleLockDepth, 1);
        recoveryLockEvents.push("credential");
        return operation(recoveryCredentialStore);
      },
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
    async ensureCodexEnvironmentRuntime() {
      runtimeRecoveries += 1;
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
    async readCodexMcpOauthCredentials() {
      return mcpOauthCredentialsJson;
    },
    async installCodexMcpOauthCredentials() {},
    async logoutEnvironmentMcpServer(
      _runtime: StoredEnvironmentRuntime,
      name: string,
    ) {
      mcpLogoutNames.push(name);
      mcpOauthCredentialsJson = undefined;
    },
    async writeCodexMessage(
      runtime: StoredEnvironmentRuntime,
      value: unknown,
      _stableInputId?: string,
      signal?: AbortSignal,
    ) {
      const message = value as Record<string, unknown>;
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
      exceptionalPendingTurnGraceMs:
        input.exceptionalPendingTurnGraceMs,
      exceptionalSessionRetryBaseMs:
        input.exceptionalSessionRetryBaseMs,
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
    mcpLogoutNames,
    exceptionalCandidateQueryCount: () => exceptionalCandidateQueries,
    lifecycleLockActive: () => lifecycleLockDepth > 0,
    runtimeRecoveryCount: () => runtimeRecoveries,
    environmentRuntime: () => environmentRuntime,
    setMcpOauthCredentialsJson: (value) => {
      mcpOauthCredentialsJson = value;
    },
    reconciledEnvironmentEpochs: () => [...reconciledEnvironmentEpochs],
    setRuntimeState: ({ desiredState, observedState }) => {
      environmentRuntime = {
        ...environmentRuntime,
        desiredState,
        observedState,
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
      context.writes.every(
        (write) => write.environmentId === environment.id,
      ),
    );
    assert.equal(
      context.writes.filter((write) => write.message.method === "initialize")
        .length,
      1,
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

test("recovery nests credential locking through the lifecycle-scoped Store", async () => {
  const context = fixture({ assertScopedRecoveryLocks: true });
  try {
    await context.service.resumeWorkers();

    assert.deepEqual(context.recoveryLockEvents, [
      "lifecycle",
      "credential",
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
      model_reasoning_effort: "high",
    });
    assert.equal(turnStart?.effort, "high");
    assert.equal(
      context.sessionRuntimes.get(sessionId)?.reasoningEffort,
      "high",
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
      timestamp: "2026-07-18T00:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "wait",
        arguments: "{\"timeout_ms\":1000}",
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
            | { output?: unknown }
            | undefined
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
    assert.equal((await read.activity).availability, "available");
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
    assert.equal(
      snapshot.activity.error?.code,
      "codex_rollout_read_failed",
    );
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
    assert.equal(
      snapshot.activity.error?.code,
      "codex_rollout_path_invalid",
    );
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
    assert.equal(
      snapshot.activity.error?.code,
      "codex_rollout_path_invalid",
    );
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
        error instanceof HttpError &&
        error.code === "codex_thread_read_failed",
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
    assert.equal(methods.filter((method) => method === "thread/resume").length, 0);

    assert.equal(
      (
        await context.service.readNativeSnapshot("user", "session-one")
      ).thread.id,
      "thread-one",
    );
    assert.equal(
      (
        await context.service.readNativeSnapshot("user", "session-archived")
      ).thread.id,
      "thread-archived",
    );

    methods = context.writes.map((write) => write.message.method);
    assert.equal(methods.filter((method) => method === "thread/read").length, 2);
    assert.equal(methods.filter((method) => method === "thread/resume").length, 0);
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
          message.method === "thread/resume" ||
          message.method === "turn/start",
      ),
      false,
    );
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
        context.writes.filter(
          ({ message }) => message.method === "thread/read",
        ).length === 1,
      "exceptional reconciliation did not start after Environment recovery",
    );

    assert.equal(context.exceptionalCandidateQueryCount(), 1);
    assert.equal(
      context.writes.filter(
        ({ message }) => message.method === "thread/resume",
      ).length,
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
      false,
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
      context.writes.filter(
        ({ message }) => message.method === "thread/read",
      ).length,
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
      context.writes.filter(
        ({ message }) => message.method === "thread/read",
      ).length,
      0,
    );
    assert.equal(
      context.sessionRuntimes.get("session-fresh")?.pendingTurnPhase,
      "prepared",
    );

    await eventually(
      () =>
        context.writes.filter(
          ({ message }) => message.method === "thread/read",
        ).length === 1,
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
      context.writes.filter(
        ({ message }) => message.method === "thread/read",
      ).length,
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

test("metadata-only repair preserves an active native Thread without loading replies", async () => {
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
        context.writes.some(
          ({ message }) => message.method === "thread/read",
        ),
      "active native Thread was not checked",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    const read = context.writes.find(
      ({ message }) => message.method === "thread/read",
    )?.message;
    assert.equal(
      (read?.params as { includeTurns?: boolean } | undefined)?.includeTurns,
      false,
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
      context.writes.filter(
        ({ message }) => message.method === "thread/read",
      ).length,
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
      context.writes.filter(
        ({ message }) => message.method === "thread/read",
      ).length,
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
        context.writes.some(
          ({ message }) => message.method === "thread/read",
        ),
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
        context.writes.some(
          ({ message }) => message.method === "thread/read",
        ),
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
        context.writes.some(
          ({ message }) => message.method === "model/list",
        ),
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

    assert.deepEqual(
      await context.service.listModels("user", "session-one"),
      { data: [{ id: "gpt-test" }] },
    );
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

    assert.deepEqual(
      await context.service.listModels("user", "session-one"),
      { data: [{ id: "gpt-test" }] },
    );
    assert.equal(context.runtimeRecoveryCount(), 1);
    assert.ok(context.streamStarts.length >= 2);
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
        context.writes.some(
          ({ message }) => message.method === "turn/start",
        ),
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
      context.writes.filter(
        ({ message }) => message.method === "turn/start",
      ).length,
      1,
    );
    await eventually(
      () =>
        context.writes.some(
          ({ message }) => message.method === "thread/read",
        ),
      "ambiguous Turn delivery did not schedule native reconciliation",
    );
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

test("replays MCP lifecycle notifications when their handler fails before cursor commit", async () => {
  const context = fixture();
  const handlerError = new Error("durable MCP transition failed");
  const handledAtCursors: number[] = [];
  const handledEvents: Array<{
    supervisorSequence: number;
    recordIndex: number;
    runtimeGeneration: number;
    attemptId?: string;
    occurredAt: string;
  }> = [];
  let attempts = 0;
  const responseId = "mcp-response-before-lifecycle";
  const takeRpcResponse = (
    context.service as unknown as {
      takeRpcResponse(
        environmentId: string,
        requestId: string,
      ): Record<string, unknown> | undefined;
    }
  ).takeRpcResponse;
  context.service.setMcpNotificationHandler({
    async handleCodexMcpNotification(
      _environmentId,
      _runtime,
      _message,
      event,
    ) {
      attempts += 1;
      handledEvents.push(event);
      handledAtCursors.push(
        context.environmentRuntime().decoder.supervisorCursor,
      );
      assert.deepEqual(
        takeRpcResponse.call(context.service, environment.id, responseId),
        { id: responseId, result: { accepted: true } },
      );
      if (attempts === 1) throw handlerError;
    },
  });
  const batch = [
    supervisorOutputEvent(1, [
      {
        method: "mcpServer/oauthLogin/completed",
        params: { name: "github_remote", success: true },
      },
      { id: responseId, result: { accepted: true } },
    ]),
  ];
  try {
    await assert.rejects(
      context.commitEvents(batch),
      (error: unknown) => error === handlerError,
    );
    assert.equal(context.environmentRuntime().decoder.supervisorCursor, 0);

    await context.commitEvents(batch);

    assert.equal(attempts, 2);
    assert.deepEqual(handledAtCursors, [0, 0]);
    assert.deepEqual(handledEvents, [
      {
        supervisorSequence: 1,
        recordIndex: 0,
        runtimeGeneration: 1,
        attemptId: "attempt-environment-test",
        occurredAt: "2026-07-16T00:00:00.000Z",
      },
      {
        supervisorSequence: 1,
        recordIndex: 0,
        runtimeGeneration: 1,
        attemptId: "attempt-environment-test",
        occurredAt: "2026-07-16T00:00:00.000Z",
      },
    ]);
    assert.equal(context.environmentRuntime().decoder.supervisorCursor, 1);
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
      context.writes.filter(
        ({ message }) => message.method === "turn/start",
      ).length,
      1,
    );
    await eventually(
      () =>
        context.writes.some(
          ({ message }) => message.method === "thread/read",
        ),
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
      context.writes.some(
        ({ message }) => message.method === "thread/read",
    ),
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
    () =>
      context.writes.some(
        ({ message }) => message.method === "initialize",
      ),
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
      context.writes.filter(
        ({ message }) => message.method === "initialize",
      ).length,
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
      context.writes.filter(
        ({ message }) => message.method === "thread/read",
      ).length,
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
      context.writes.filter(
        ({ message }) => message.method === "thread/read",
      ).length,
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
        context.writes.filter(
          ({ message }) => message.method === "thread/read",
        ).length === 1,
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
            (message.params as { threadId?: string }).threadId ===
              "thread-two",
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
      context.writes.filter(
        ({ message }) => message.method === "turn/start",
      ).length,
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
            (message.params as { threadId?: string }).threadId ===
              "thread-two",
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
      context.writes.filter(
        ({ message }) => message.method === "thread/resume",
      ).length,
      0,
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
    });

    assert.match(started.nativeTurnId ?? "", /^turn-new-/);
    const nativeMethods = context.writes.filter(({ message }) =>
      ["thread/resume", "turn/start"].includes(String(message.method)),
    );
    assert.deepEqual(
      nativeMethods.map(({ message }) => message.method),
      ["thread/resume", "turn/start"],
    );
    const resumeParams = nativeMethods[0]?.message.params as
      | Record<string, unknown>
      | undefined;
    assert.equal(resumeParams?.threadId, "thread-one");
    assert.equal(resumeParams?.model, "gpt-next");
    assert.deepEqual(resumeParams?.config, {
      model_reasoning_effort: "high",
    });
    assert.equal("excludeTurns" in (resumeParams ?? {}), false);
    const turnParams = nativeMethods[1]?.message.params as
      | Record<string, unknown>
      | undefined;
    assert.equal(turnParams?.model, "gpt-next");
    assert.equal(turnParams?.effort, "high");
    assert.equal(context.sessionRuntimes.get("session-one")?.modelId, "gpt-next");
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
      context.writes.filter(
        ({ message }) => message.method === "thread/resume",
      ).length,
      1,
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
      context.writes.filter(
        ({ message }) => message.method === "thread/resume",
      ).length,
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
      context.writes.filter(
        ({ message }) => message.method === "thread/resume",
      ).length,
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
      context.writes.filter(
        ({ message }) => message.method === "thread/resume",
      ).length,
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
      context.writes.filter(
        ({ message }) => message.method === "thread/resume",
      ).length,
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
      context.writes.filter(
        ({ message }) => message.method === "thread/resume",
      ).length,
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
      context.writes.filter(
        ({ message }) => message.method === "turn/start",
      ).length,
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
      context.writes.filter(
        ({ message }) => message.method === "turn/start",
      ).length,
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
      context.writes.filter(
        ({ message }) => message.method === "turn/start",
      ).length,
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
      context.writes.filter(
        ({ message }) => message.method === "turn/start",
      ).length,
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
        context.writes.filter(
          ({ message }) => message.method === "thread/read",
        ).length === 1,
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
      context.writes.filter(
        ({ message }) => message.method === "thread/resume",
      ).length,
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
        context.writes.some(
          ({ message }) => message.method === "thread/read",
        ),
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
      ["turn/started"],
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
    assert.equal(context.sessionRuntimes.get("session-two")?.activeNativeTurnId, undefined);
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
      notifications.some((notification) => notification.method === "item/completed"),
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
          update.kind === "notification" ? update.event.notification.method : "",
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
    await context.service.startTurn({
      userId: "user",
      sessionId: childId,
      text: "Continue the fork",
      images: [],
    });
    assert.equal(
      context.writes.filter(
        (write) => write.message.method === "thread/resume",
      ).length,
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
    assert.deepEqual(write?.message.params, { path: skillPath, enabled: false });
  } finally {
    await context.close();
  }
});

test("correlates an MCP OAuth login with an isolated ephemeral Thread", async () => {
  const context = fixture({
    onRequest(message) {
      if (message.method === "mcpServer/oauth/login") {
        return {
          id: message.id,
          result: {
            authorizationUrl:
              "https://identity.example/authorize?state=test-only",
          },
        };
      }
      return undefined;
    },
  });
  try {
    const correlation =
      await context.service.createEnvironmentMcpOAuthCorrelationThread({
        userId: "user",
        environmentId: environment.id,
      });
    const login = await context.service.beginEnvironmentMcpOAuthLogin({
      environmentId: environment.id,
      name: "github_remote",
      nativeThreadId: correlation.nativeThreadId,
      runtime: correlation.runtime,
      scopes: ["repo"],
      timeoutSecs: 600,
    });

    assert.equal(
      login.authorizationUrl,
      "https://identity.example/authorize?state=test-only",
    );
    const threadStart = context.writes.find(
      ({ message }) =>
        message.method === "thread/start" &&
        (message.params as { ephemeral?: boolean }).ephemeral === true,
    );
    assert.ok(threadStart);
    const oauthLogin = context.writes.find(
      ({ message }) => message.method === "mcpServer/oauth/login",
    );
    assert.equal(
      (oauthLogin?.message.params as { threadId?: string }).threadId,
      correlation.nativeThreadId,
    );
    await context.service.releaseEnvironmentMcpOAuthCorrelationThread(
      correlation.runtime,
      correlation.nativeThreadId,
    );
    assert.equal(
      (
        context.writes.find(
          ({ message }) => message.method === "thread/unsubscribe",
        )?.message.params as { threadId?: string }
      ).threadId,
      correlation.nativeThreadId,
    );
  } finally {
    await context.close();
  }
});

test("MCP logout persists an absent native token store instead of reviving it", async () => {
  const synchronized: Array<{
    environmentId: string;
    credentialsJson: string | undefined;
  }> = [];
  const credentialProvider = {
    ...credentials,
    async syncMcpOAuthCredentialFromRuntime(
      environmentId: string,
      credentialsJson: string | undefined,
    ) {
      synchronized.push({ environmentId, credentialsJson });
      return undefined;
    },
  } satisfies CodexCredentialProvider;
  const context = fixture({
    credentials: credentialProvider,
    onRequest(message) {
      if (message.method === "mcpServerStatus/list") {
        return {
          id: message.id,
          result: { data: [], nextCursor: null },
        };
      }
      if (message.method === "config/read") {
        return {
          id: message.id,
          result: {
            config: { mcp_servers: {} },
            origins: {},
            layers: [],
          },
        };
      }
      return undefined;
    },
  });
  try {
    await context.service.logoutEnvironmentMcpServer({
      userId: "user",
      environmentId: environment.id,
      name: "github_remote",
    });

    assert.deepEqual(context.mcpLogoutNames, ["github_remote"]);
    assert.deepEqual(synchronized, [
      {
        environmentId: environment.id,
        credentialsJson: undefined,
      },
    ]);
  } finally {
    await context.close();
  }
});

test("MCP logout waits for an older persist and then reads native credentials again", async () => {
  const oldCredentials = JSON.stringify({
    github_remote: { access_token: "old-token" },
  });
  const synchronized: Array<string | undefined> = [];
  let markFirstSyncStarted!: () => void;
  const firstSyncStarted = new Promise<void>((resolve) => {
    markFirstSyncStarted = resolve;
  });
  let releaseFirstSync: (() => void) | undefined;
  const firstSyncBlocked = new Promise<void>((resolve) => {
    releaseFirstSync = resolve;
  });
  const credentialProvider = {
    ...credentials,
    async syncMcpOAuthCredentialFromRuntime(
      _environmentId: string,
      credentialsJson: string | undefined,
    ) {
      synchronized.push(credentialsJson);
      if (synchronized.length === 1) {
        markFirstSyncStarted();
        await firstSyncBlocked;
      }
      return undefined;
    },
  } satisfies CodexCredentialProvider;
  const context = fixture({
    credentials: credentialProvider,
    mcpOauthCredentialsJson: oldCredentials,
    onRequest(message) {
      if (message.method === "mcpServerStatus/list") {
        return {
          id: message.id,
          result: { data: [], nextCursor: null },
        };
      }
      if (message.method === "config/read") {
        return {
          id: message.id,
          result: {
            config: { mcp_servers: {} },
            origins: {},
            layers: [],
          },
        };
      }
      return undefined;
    },
  });
  try {
    const backgroundPersist =
      context.service.persistEnvironmentMcpOAuthCredential(
      context.environmentRuntime(),
    );
    await firstSyncStarted;

    let logoutSettled = false;
    const logout = context.service
      .logoutEnvironmentMcpServer({
        userId: "user",
        environmentId: environment.id,
        name: "github_remote",
      })
      .finally(() => {
        logoutSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(logoutSettled, false);
    assert.deepEqual(context.mcpLogoutNames, []);

    releaseFirstSync?.();
    await Promise.all([backgroundPersist, logout]);
    assert.deepEqual(context.mcpLogoutNames, ["github_remote"]);
    assert.deepEqual(synchronized, [oldCredentials, undefined]);
  } finally {
    releaseFirstSync?.();
    await context.close();
  }
});

test("MCP logout fails when the durable OAuth revocation fails", async () => {
  const revokeError = new Error("durable MCP OAuth revoke failed");
  const credentialProvider = {
    ...credentials,
    async syncMcpOAuthCredentialFromRuntime(
      _environmentId: string,
      credentialsJson: string | undefined,
    ) {
      assert.equal(credentialsJson, undefined);
      throw revokeError;
    },
  } satisfies CodexCredentialProvider;
  const context = fixture({ credentials: credentialProvider });
  try {
    await assert.rejects(
      context.service.logoutEnvironmentMcpServer({
        userId: "user",
        environmentId: environment.id,
        name: "github_remote",
      }),
      (error: unknown) => error === revokeError,
    );
    assert.deepEqual(context.mcpLogoutNames, ["github_remote"]);
    assert.equal(
      context.writes.some(
        ({ message }) => message.method === "config/mcpServer/reload",
      ),
      false,
    );
  } finally {
    await context.close();
  }
});

test("credential flush queues a fresh MCP OAuth read behind an older persist", async () => {
  const synchronized: Array<string | undefined> = [];
  let markFirstSyncStarted!: () => void;
  const firstSyncStarted = new Promise<void>((resolve) => {
    markFirstSyncStarted = resolve;
  });
  let releaseFirstSync: (() => void) | undefined;
  const firstSyncBlocked = new Promise<void>((resolve) => {
    releaseFirstSync = resolve;
  });
  const credentialProvider = {
    ...credentials,
    async syncMcpOAuthCredentialFromRuntime(
      _environmentId: string,
      credentialsJson: string | undefined,
    ) {
      synchronized.push(credentialsJson);
      if (synchronized.length === 1) {
        markFirstSyncStarted();
        await firstSyncBlocked;
      }
      return undefined;
    },
  } satisfies CodexCredentialProvider;
  const context = fixture({
    credentials: credentialProvider,
    mcpOauthCredentialsJson: '{"github_remote":{"access_token":"old-token"}}',
  });
  try {
    const backgroundPersist =
      context.service.persistEnvironmentMcpOAuthCredential(
      context.environmentRuntime(),
    );
    await firstSyncStarted;
    context.setMcpOauthCredentialsJson(undefined);

    const flush = context.service.flushEnvironmentCredentials(environment.id);
    releaseFirstSync?.();
    await Promise.all([backgroundPersist, flush]);
    assert.deepEqual(synchronized, [
      '{"github_remote":{"access_token":"old-token"}}',
      undefined,
    ]);
  } finally {
    releaseFirstSync?.();
    await context.close();
  }
});

test("MCP RPC failures do not expose provider-controlled error details", async () => {
  const secret = "provider-error-secret";
  const context = fixture({
    onRequest(message) {
      if (message.method === "config/read") {
        return {
          id: message.id,
          error: { message: `Authorization failed for ${secret}` },
        };
      }
      return undefined;
    },
  });
  try {
    await assert.rejects(
      context.service.listEnvironmentMcpServers("user", environment.id),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.code, "codex_config_read_failed");
        assert.equal(error.message, "Codex could not read the Environment configuration.");
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  } finally {
    await context.close();
  }
});

test("creates remote and local Environment MCP servers and reloads every native Thread", async () => {
  let configured = 0;
  const definition = {
    url: "https://docs.example.test/mcp",
    enabled: true,
    required: false,
    default_tools_approval_mode: "prompt",
  };
  const localDefinition = {
    command: "npx",
    args: [
      "-y",
      "@playwright/mcp@latest",
      "--headless",
      "--no-sandbox",
    ],
    enabled: true,
    required: false,
    startup_timeout_sec: 120,
    default_tools_approval_mode: "prompt",
  };
  const context = fixture({
    onRequest(message) {
      if (message.method === "config/read") {
        const mcpServers =
          configured === 0
            ? {}
            : configured === 1
              ? { docs: definition }
              : { docs: definition, playwright: localDefinition };
        return {
          id: message.id,
          result: {
            config: { mcp_servers: mcpServers },
            origins: {},
            layers: [
              {
                name: {
                  type: "user",
                  file: "/workspace/.sandpi/harnesses/codex/config.toml",
                  profile: null,
                },
                version: "one",
                config: { mcp_servers: mcpServers },
              },
            ],
          },
        };
      }
      if (message.method === "config/batchWrite") {
        configured += 1;
        return {
          id: message.id,
          result: {
            status: "ok",
            version: "two",
            filePath: "/workspace/.sandpi/harnesses/codex/config.toml",
            overriddenMetadata: null,
          },
        };
      }
      if (message.method === "config/mcpServer/reload") {
        return { id: message.id, result: {} };
      }
      if (message.method === "mcpServerStatus/list") {
        return {
          id: message.id,
          result: {
            data: configured > 0
              ? [
                  {
                    name: "docs",
                    serverInfo: {
                      name: "docs-server",
                      title: "Docs",
                      version: "1.0.0",
                    },
                    tools: { search: { name: "search" } },
                    resources: [],
                    resourceTemplates: [],
                    authStatus: "unsupported",
                  },
                  ...(configured > 1
                    ? [
                        {
                          name: "playwright",
                          serverInfo: {
                            name: "playwright",
                            title: "Playwright",
                            version: "1.0.0",
                          },
                          tools: {},
                          resources: [],
                          resourceTemplates: [],
                          authStatus: "unsupported",
                        },
                      ]
                    : []),
                ]
              : [],
            nextCursor: null,
          },
        };
      }
      return undefined;
    },
  });
  try {
    const inventory = await context.service.createEnvironmentMcpServer({
      userId: "user",
      environmentId: environment.id,
      name: "docs",
      server: {
        transport: "streamable-http",
        url: definition.url,
        args: [],
        enabled: true,
        required: false,
        defaultToolsApprovalMode: "prompt",
        enabledTools: [],
        disabledTools: [],
      },
    });
    assert.equal(inventory.servers[0]?.runtimeStatus, "connected");
    assert.equal(inventory.servers[0]?.managed, true);
    assert.equal(inventory.servers[0]?.toolCount, 1);

    const batch = context.writes.find(
      ({ message }) => message.method === "config/batchWrite",
    );
    const edits = (batch?.message.params as { edits: Array<Record<string, unknown>> })
      .edits;
    assert.ok(
      edits.some(
        (edit) =>
          edit.keyPath === "mcp_servers.docs.url" &&
          edit.value === definition.url,
      ),
    );
    assert.ok(
      edits.some(
        (edit) => edit.keyPath === "mcp_servers.docs.command" && edit.value === null,
      ),
    );
    assert.equal(
      context.writes.some(
        ({ message }) => message.method === "config/mcpServer/reload",
      ),
      true,
    );

    const localInventory = await context.service.createEnvironmentMcpServer({
      userId: "user",
      environmentId: environment.id,
      name: "playwright",
      server: {
        transport: "stdio",
        command: localDefinition.command,
        args: localDefinition.args,
        enabled: true,
        required: false,
        startupTimeoutSec: 120,
        defaultToolsApprovalMode: "prompt",
        enabledTools: [],
        disabledTools: [],
      },
    });
    const local = localInventory.servers.find(
      (server) => server.name === "playwright",
    );
    assert.equal(local?.transport, "stdio");
    assert.equal(local?.command, "npx");
    assert.deepEqual(local?.args, localDefinition.args);

    const batches = context.writes.filter(
      ({ message }) => message.method === "config/batchWrite",
    );
    const localEdits = (
      batches[1]?.message.params as { edits: Array<Record<string, unknown>> }
    ).edits;
    assert.ok(
      localEdits.some(
        (edit) =>
          edit.keyPath === "mcp_servers.playwright.command" &&
          edit.value === "npx",
      ),
    );
    assert.ok(
      localEdits.some(
        (edit) =>
          edit.keyPath === "mcp_servers.playwright.args" &&
          Array.isArray(edit.value) &&
          edit.value.join("\n") === localDefinition.args.join("\n"),
      ),
    );
    assert.ok(
      localEdits.some(
        (edit) =>
          edit.keyPath === "mcp_servers.playwright.url" && edit.value === null,
      ),
    );
    assert.ok(
      localEdits.some(
        (edit) =>
          edit.keyPath === "mcp_servers.playwright.startup_timeout_sec" &&
          edit.value === 120,
      ),
    );
    assert.equal(
      context.writes.filter(
        ({ message }) => message.method === "config/mcpServer/reload",
      ).length,
      2,
    );
  } finally {
    await context.close();
  }
});
