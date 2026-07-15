import assert from "node:assert/strict";
import test from "node:test";

import type { CodexThread } from "@/harnesses/codex/types";
import type { Environment } from "@/lib/types";
import { HttpError } from "@/server/http-error";
import type { RuntimeAdapter, RuntimeSessionRecord } from "@/server/runtime/types";
import type {
  CodexControlTransition,
  SandpiStore,
  StoredRuntime,
} from "@/server/store";
import {
  CodexService,
  type CodexCredentialProvider,
} from "./service";

const logger = {
  debug() {},
  warn() {},
  error() {},
};

const credentials = {
  async credentialForEnvironment() {
    return { sourceId: "credential-test", revision: 1, authJson: "{}" };
  },
  async credentialForRuntime() {
    return { sourceId: "credential-test", revision: 1, authJson: "{}" };
  },
  async markCredentialMaterialized() {},
  async syncCredentialFromRuntime() {
    return undefined;
  },
} satisfies CodexCredentialProvider;

function storedRuntime(
  id = "session-test",
  nativeSessionId: string | undefined = "thread-test",
): StoredRuntime {
  return {
    id,
    version: 0,
    sandboxId: `sandbox-${id}`,
    workspaceVolumeId: `volume-${id}`,
    supervisorSessionId: `supervisor-${id}`,
    supervisorCursor: 0,
    attemptId: `attempt-${id}`,
    runtimeGeneration: 1,
    nativeSessionId,
    harnessStateLayout: "workspace_v2",
    modelId: "gpt-test",
    historyRevision: 0,
    nativeHistoryMaterialized: false,
    desiredState: "running",
    observedState: "running",
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      attemptId: `attempt-${id}`,
      runtimeGeneration: 1,
    },
  };
}

interface TransportFixture {
  states: Map<string, StoredRuntime>;
  store: SandpiStore;
  runtime: RuntimeAdapter;
  writes: Array<{
    sessionId: string;
    message: Record<string, unknown>;
    stableInputId?: string;
  }>;
  transitions: CodexControlTransition[][];
  enqueue(sessionId: string, messages: Record<string, unknown>[]): void;
  listCalls(): number;
}

function transportFixture(input: {
  states?: StoredRuntime[];
  onWrite?: (
    sessionId: string,
    message: Record<string, unknown>,
  ) => Promise<Record<string, unknown>[] | void> | Record<string, unknown>[] | void;
  readyTurnIds?: string[];
  hasMaterializedHistory?: boolean;
  onUnrecoverable?: (sessionId: string, message: string) => void;
  eventSequenceStart?: number;
} = {}): TransportFixture {
  const states = new Map(
    (input.states ?? [storedRuntime()]).map((state) => [state.id, state]),
  );
  const events = new Map<string, unknown[]>();
  const sequences = new Map<string, number>();
  if (input.eventSequenceStart !== undefined) {
    for (const state of input.states ?? [storedRuntime()]) {
      sequences.set(state.id, input.eventSequenceStart);
    }
  }
  const writes: TransportFixture["writes"] = [];
  const transitions: CodexControlTransition[][] = [];
  let listCalls = 0;

  const enqueue = (sessionId: string, messages: Record<string, unknown>[]) => {
    const state = states.get(sessionId);
    assert.ok(state);
    const sequence = (sequences.get(sessionId) ?? 0) + 1;
    sequences.set(sessionId, sequence);
    const data = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
    const sessionEvents = events.get(sessionId) ?? [];
    sessionEvents.push({
      seq: sequence,
      runtimeGeneration: state.runtimeGeneration,
      attemptId: state.attemptId,
      type: "output",
      stream: "stdout",
      dataBase64: Buffer.from(data).toString("base64"),
      occurredAt: "2026-07-15T00:00:00.000Z",
    });
    events.set(sessionId, sessionEvents);
  };

  const store = {
    async decoderState(sessionId: string) {
      const state = states.get(sessionId);
      assert.ok(state);
      return state;
    },
    async getRuntime(_userId: string, sessionId: string) {
      const state = states.get(sessionId);
      assert.ok(state);
      return state;
    },
    async getSession() {
      return { status: "waiting" };
    },
    async commitCodexTransport(
      sessionId: string,
      supervisorSessionId: string,
      expected: StoredRuntime["decoder"],
      next: StoredRuntime["decoder"],
      control: CodexControlTransition[],
    ) {
      const state = states.get(sessionId);
      assert.ok(state);
      assert.equal(state.supervisorSessionId, supervisorSessionId);
      if (
        state.decoder.supervisorCursor !== expected.supervisorCursor ||
        state.decoder.tailBase64 !== expected.tailBase64 ||
        state.decoder.attemptId !== expected.attemptId ||
        state.decoder.runtimeGeneration !== expected.runtimeGeneration
      ) {
        return false;
      }
      transitions.push(control);
      let activeNativeTurnId = state.activeNativeTurnId;
      for (const transition of control) {
        if (transition.type === "turnStarted") {
          activeNativeTurnId = transition.nativeTurnId;
        } else if (
          transition.type === "turnCompleted" &&
          activeNativeTurnId === transition.nativeTurnId
        ) {
          activeNativeTurnId = undefined;
        }
      }
      states.set(sessionId, {
        ...state,
        supervisorCursor: next.supervisorCursor,
        attemptId: next.attemptId,
        runtimeGeneration: next.runtimeGeneration,
        activeNativeTurnId,
        decoder: next,
      });
      return true;
    },
    async setNativeSession(
      sessionId: string,
      nativeSessionId: string,
      options: {
        expectedNativeSessionId?: string;
        incrementHistoryRevision?: boolean;
        expectedExclusiveOperationId?: string;
      } = {},
    ) {
      const state = states.get(sessionId);
      assert.ok(state);
      if (
        options.expectedNativeSessionId !== undefined &&
        state.nativeSessionId !== options.expectedNativeSessionId
      ) {
        return false;
      }
      if (
        options.expectedExclusiveOperationId !== undefined &&
        state.exclusiveOperationId !== options.expectedExclusiveOperationId
      ) {
        return false;
      }
      states.set(sessionId, {
        ...state,
        nativeSessionId,
        historyRevision:
          state.historyRevision +
          (options.incrementHistoryRevision ? 1 : 0),
      });
      return true;
    },
    async forkableCheckpointTurnIds() {
      return input.readyTurnIds ?? [];
    },
    async rewindableCheckpointTurnIds() {
      return input.readyTurnIds ?? [];
    },
    async hasMaterializedNativeHistory() {
      return (
        input.hasMaterializedHistory ?? (input.readyTurnIds?.length ?? 0) > 0
      );
    },
    async markNativeSessionUnrecoverable(sessionId: string, message: string) {
      input.onUnrecoverable?.(sessionId, message);
      const state = states.get(sessionId);
      assert.ok(state);
      states.set(sessionId, {
        ...state,
        runtimeErrorCode: "native_session_unrecoverable",
        provisioningError: message,
      });
    },
    async retryableTurnCheckpoints() {
      return [];
    },
    async markTurnSubmissionStaged(sessionId: string) {
      const state = states.get(sessionId);
      assert.ok(state);
      states.set(sessionId, { ...state, pendingTurnPhase: "staged" });
    },
    async recoveredTurnInterruptionClaim() {
      return undefined;
    },
    async acquireSessionOperationLock() {
      return {
        signal: new AbortController().signal,
        async release() {},
      };
    },
    async touchSessionOperation() {
      return true;
    },
    async clearAbandonedSessionOperation() {
      return false;
    },
    async releaseSessionOperation(sessionId: string, operationId: string) {
      const state = states.get(sessionId);
      if (!state || state.exclusiveOperationId !== operationId) return false;
      states.set(sessionId, {
        ...state,
        exclusiveOperationId: undefined,
        exclusiveOperationKind: undefined,
      });
      return true;
    },
    async allocatedSessionResources(sessionId: string) {
      const state = states.get(sessionId);
      return {
        id: sessionId,
        sandboxId: state?.sandboxId,
        workspaceVolumeId: state?.workspaceVolumeId,
        supervisorSessionId: state?.supervisorSessionId,
      };
    },
  } as unknown as SandpiStore;

  const stagedMessages = new Map<string, Record<string, unknown>>();
  const stagedKey = (sessionId: string, stableInputId: string) =>
    `${sessionId}:${stableInputId}`;
  const runtime = {
    mode: "sandbox0",
    async writeCodexMessage(
      runtimeState: RuntimeSessionRecord,
      messageValue: unknown,
      stableInputId?: string,
    ) {
      const message = messageValue as Record<string, unknown>;
      writes.push({ sessionId: runtimeState.id, message, stableInputId });
      const response = await input.onWrite?.(runtimeState.id, message);
      if (response?.length) enqueue(runtimeState.id, response);
    },
    async stageCodexMessage(
      runtimeState: RuntimeSessionRecord,
      messageValue: unknown,
      stableInputId: string,
    ) {
      stagedMessages.set(
        stagedKey(runtimeState.id, stableInputId),
        messageValue as Record<string, unknown>,
      );
    },
    async hasStagedCodexMessage(
      runtimeState: RuntimeSessionRecord,
      stableInputId: string,
    ) {
      return stagedMessages.has(stagedKey(runtimeState.id, stableInputId));
    },
    async dispatchStagedCodexMessage(
      runtimeState: RuntimeSessionRecord,
      stableInputId: string,
    ) {
      const message = stagedMessages.get(stagedKey(runtimeState.id, stableInputId));
      assert.ok(message);
      writes.push({ sessionId: runtimeState.id, message, stableInputId });
      const response = await input.onWrite?.(runtimeState.id, message);
      if (response?.length) enqueue(runtimeState.id, response);
    },
    async discardStagedCodexMessage(
      runtimeState: RuntimeSessionRecord,
      stableInputId: string,
    ) {
      stagedMessages.delete(stagedKey(runtimeState.id, stableInputId));
    },
    async listCodexEvents(runtimeState: RuntimeSessionRecord, after = 0) {
      listCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      const sessionEvents = (events.get(runtimeState.id) ?? []) as Array<{
        seq: number;
      }>;
      return {
        events: sessionEvents.filter((event) => event.seq > after),
        cursor: {
          earliest: sessionEvents[0]?.seq ?? 0,
          latest: sessionEvents.at(-1)?.seq ?? 0,
        },
      };
    },
    async readCodexSessionCredential() {
      return "{}";
    },
    async installCodexSessionCredential() {},
  } as unknown as RuntimeAdapter;

  return {
    states,
    store,
    runtime,
    writes,
    transitions,
    enqueue,
    listCalls: () => listCalls,
  };
}

function rpcResult(id: unknown, result: unknown) {
  return { id, result };
}

function nativeThread(
  id: string,
  turns: CodexThread["turns"] = [],
): CodexThread {
  return {
    id,
    status: { type: "idle" },
    turns,
  };
}

function completedTurn(id: string): CodexThread["turns"][number] {
  return {
    id,
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1_752_537_600,
    completedAt: 1_752_537_601,
    durationMs: 1_000,
  };
}

test("registers an in-memory RPC waiter before writing to Codex", async () => {
  const context: { service?: CodexService } = {};
  let waiterWasRegistered = false;
  const fixture = transportFixture({
    onWrite(_sessionId, message) {
      if (message.method !== "model/list") return;
      assert.ok(context.service);
      const internals = context.service as unknown as {
        rpcWaiters: Map<string, Set<unknown>>;
      };
      waiterWasRegistered = [...internals.rpcWaiters.values()].some(
        (waiters) => waiters.size === 1,
      );
      return [rpcResult(message.id, { data: [{ id: "gpt-test" }] })];
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );
  context.service = service;

  try {
    const models = await service.listModels("user-test", "session-test");
    assert.equal(waiterWasRegistered, true);
    assert.deepEqual(models, {
      data: [{ id: "gpt-test" }],
      nextCursor: null,
    });
  } finally {
    await service.close();
  }
});

test("reads every page from the native Codex model catalog", async () => {
  const requestedCursors: Array<string | undefined> = [];
  const fixture = transportFixture({
    onWrite(_sessionId, message) {
      if (message.method !== "model/list") return;
      const params = message.params as { cursor?: string };
      requestedCursors.push(params.cursor);
      return [
        rpcResult(
          message.id,
          params.cursor
            ? { data: [{ id: "gpt-page-two" }], nextCursor: null }
            : { data: [{ id: "gpt-page-one" }], nextCursor: "page-two" },
        ),
      ];
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );

  try {
    assert.deepEqual(await service.listModels("user-test", "session-test"), {
      data: [{ id: "gpt-page-one" }, { id: "gpt-page-two" }],
      nextCursor: null,
    });
    assert.deepEqual(requestedCursors, [undefined, "page-two"]);
  } finally {
    await service.close();
  }
});

test("journals native Turn delivery coordinates before dispatch", async () => {
  const fixture = transportFixture({
    onWrite(_sessionId, message) {
      if (message.method !== "turn/start") return;
      return [rpcResult(message.id, { turn: completedTurn("turn-submitted") })];
    },
  });
  const operations: string[] = [];
  Object.assign(fixture.store as object, {
    async beginSessionTurn(
      _userId: string,
      sessionId: string,
      _modelId: string | undefined,
      submission: {
        requestId: string;
        clientMessageId: string;
        stableInputId: string;
      },
    ) {
      operations.push("prepared");
      const state = fixture.states.get(sessionId)!;
      fixture.states.set(sessionId, {
        ...state,
        pendingTurnRequestId: submission.requestId,
        pendingTurnClientMessageId: submission.clientMessageId,
        pendingTurnStableInputId: submission.stableInputId,
        pendingTurnPhase: "prepared",
        pendingTurnStartedAt: new Date(),
      });
    },
    async recordTurnSubmissionInputSnapshot(
      sessionId: string,
      requestId: string,
      snapshotId: string,
    ) {
      operations.push("snapshot-ready");
      const state = fixture.states.get(sessionId)!;
      assert.equal(requestId, state.pendingTurnRequestId);
      fixture.states.set(sessionId, {
        ...state,
        pendingTurnPhase: "snapshot_ready",
        headVolumeSnapshotId: state.headVolumeSnapshotId,
      });
      assert.equal(snapshotId, "snapshot-input");
    },
    async markTurnSubmissionDispatched(sessionId: string, requestId: string) {
      operations.push("submitted");
      const state = fixture.states.get(sessionId)!;
      assert.equal(requestId, state.pendingTurnRequestId);
      fixture.states.set(sessionId, {
        ...state,
        pendingTurnPhase: "submitted",
        pendingTurnSubmittedAt: new Date(),
      });
    },
    async markTurnSubmissionAccepted(
      sessionId: string,
      requestId: string,
      nativeTurnId: string,
    ) {
      operations.push("accepted");
      const state = fixture.states.get(sessionId)!;
      assert.equal(requestId, state.pendingTurnRequestId);
      fixture.states.set(sessionId, {
        ...state,
        pendingTurnPhase: "accepted",
        pendingTurnNativeTurnId: nativeTurnId,
      });
      return true;
    },
  });
  Object.assign(fixture.runtime as object, {
    async createVolumeCheckpoint() {
      operations.push("snapshot-created");
      return { snapshotId: "snapshot-input" };
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );

  try {
    const result = await service.startTurn({
      userId: "user-test",
      sessionId: "session-test",
      text: "persist coordinates, not this prompt",
      images: [],
    });
    assert.match(result.requestId, /^turn-start:/);
    assert.deepEqual(operations, [
      "prepared",
      "snapshot-created",
      "snapshot-ready",
      "submitted",
      "accepted",
    ]);
    const write = fixture.writes.find(
      ({ message }) => message.method === "turn/start",
    );
    assert.ok(write);
    const params = write.message.params as Record<string, unknown>;
    assert.equal(
      params.clientUserMessageId,
      fixture.states.get("session-test")?.pendingTurnClientMessageId,
    );
    assert.equal(
      write.stableInputId,
      fixture.states.get("session-test")?.pendingTurnStableInputId,
    );
    assert.equal(
      fixture.states.get("session-test")?.pendingTurnNativeTurnId,
      "turn-submitted",
    );
  } finally {
    await service.close();
  }
});

test("keeps the input snapshot when native Turn acceptance is ambiguous", async () => {
  const fixture = transportFixture({
    onWrite(_sessionId, message) {
      if (message.method === "turn/start") {
        throw new Error("Supervisor acknowledgement was lost");
      }
    },
  });
  let abandoned = false;
  Object.assign(fixture.store as object, {
    async beginSessionTurn(
      _userId: string,
      sessionId: string,
      _modelId: string | undefined,
      submission: {
        requestId: string;
        clientMessageId: string;
        stableInputId: string;
      },
    ) {
      const state = fixture.states.get(sessionId)!;
      fixture.states.set(sessionId, {
        ...state,
        pendingTurnRequestId: submission.requestId,
        pendingTurnClientMessageId: submission.clientMessageId,
        pendingTurnStableInputId: submission.stableInputId,
        pendingTurnPhase: "prepared",
        pendingTurnStartedAt: new Date(),
      });
    },
    async recordTurnSubmissionInputSnapshot(sessionId: string) {
      const state = fixture.states.get(sessionId)!;
      fixture.states.set(sessionId, {
        ...state,
        pendingTurnPhase: "snapshot_ready",
      });
    },
    async markTurnSubmissionDispatched(sessionId: string) {
      const state = fixture.states.get(sessionId)!;
      fixture.states.set(sessionId, {
        ...state,
        pendingTurnPhase: "submitted",
        pendingTurnSubmittedAt: new Date(),
      });
    },
    async abandonTurnSubmission() {
      abandoned = true;
    },
  });
  Object.assign(fixture.runtime as object, {
    async createVolumeCheckpoint() {
      return { snapshotId: "snapshot-input" };
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );

  try {
    const result = await service.startTurn({
      userId: "user-test",
      sessionId: "session-test",
      text: "ambiguous delivery",
      images: [],
    });
    assert.equal(result.pending, true);
    assert.equal(abandoned, false);
    assert.equal(
      fixture.states.get("session-test")?.pendingTurnPhase,
      "staged",
    );
  } finally {
    await service.close();
  }
});

test("keeps the submission journal when native success cannot be persisted", async () => {
  const fixture = transportFixture({
    onWrite(_sessionId, message) {
      if (message.method !== "turn/start") return;
      return [rpcResult(message.id, { turn: completedTurn("turn-accepted") })];
    },
  });
  let abandoned = false;
  Object.assign(fixture.store as object, {
    async beginSessionTurn(
      _userId: string,
      sessionId: string,
      _modelId: string | undefined,
      submission: {
        requestId: string;
        clientMessageId: string;
        stableInputId: string;
      },
    ) {
      const state = fixture.states.get(sessionId)!;
      fixture.states.set(sessionId, {
        ...state,
        pendingTurnRequestId: submission.requestId,
        pendingTurnClientMessageId: submission.clientMessageId,
        pendingTurnStableInputId: submission.stableInputId,
        pendingTurnPhase: "prepared",
        pendingTurnStartedAt: new Date(),
      });
    },
    async recordTurnSubmissionInputSnapshot(sessionId: string) {
      const state = fixture.states.get(sessionId)!;
      fixture.states.set(sessionId, {
        ...state,
        pendingTurnPhase: "snapshot_ready",
      });
    },
    async markTurnSubmissionDispatched(sessionId: string) {
      const state = fixture.states.get(sessionId)!;
      fixture.states.set(sessionId, {
        ...state,
        pendingTurnPhase: "submitted",
      });
    },
    async markTurnSubmissionAccepted() {
      throw new Error("database unavailable after native acceptance");
    },
    async abandonTurnSubmission() {
      abandoned = true;
    },
  });
  Object.assign(fixture.runtime as object, {
    async createVolumeCheckpoint() {
      return { snapshotId: "snapshot-input" };
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );

  try {
    const result = await service.startTurn({
      userId: "user-test",
      sessionId: "session-test",
      text: "native accepts before PostgreSQL fails",
      images: [],
    });
    assert.equal(result.pending, true);
    assert.equal(abandoned, false);
    assert.equal(
      fixture.states.get("session-test")?.pendingTurnPhase,
      "submitted",
    );
  } finally {
    await service.close();
  }
});

test("recovers an accepted Turn by its native client message id after restart", async () => {
  const pending = storedRuntime();
  pending.pendingTurnRequestId = "turn-start:crashed";
  pending.pendingTurnClientMessageId = "user-message:crashed";
  pending.pendingTurnStableInputId = "turn-input:crashed";
  pending.pendingTurnPhase = "submitted";
  pending.pendingTurnStartedAt = new Date(0);
  pending.pendingTurnSubmittedAt = new Date(0);
  const accepted = completedTurn("turn-recovered");
  accepted.status = "inProgress";
  accepted.completedAt = null;
  accepted.items = [
    {
      type: "userMessage",
      id: "item-user-recovered",
      clientId: "user-message:crashed",
      content: [{ type: "text", text: "native only", text_elements: [] }],
    },
  ];
  const fixture = transportFixture({
    states: [pending],
    onWrite(_sessionId, message) {
      if (message.method === "thread/read") {
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-test", [accepted]),
          }),
        ];
      }
    },
  });
  Object.assign(fixture.store as object, {
    async interruptedTurnMutations() {
      return [];
    },
    async pendingTurnSubmissions() {
      return [fixture.states.get("session-test")!];
    },
    async markTurnSubmissionAccepted(
      sessionId: string,
      requestId: string,
      nativeTurnId: string,
    ) {
      assert.equal(requestId, "turn-start:crashed");
      assert.equal(nativeTurnId, "turn-recovered");
      const state = fixture.states.get(sessionId)!;
      fixture.states.set(sessionId, {
        ...state,
        pendingTurnPhase: "accepted",
        pendingTurnNativeTurnId: nativeTurnId,
      });
      return true;
    },
    async recoverStaleSessionOperations() {
      return [];
    },
    async expiredRuntimeSessions() {
      return [];
    },
    async failedRuntimeSessions() {
      return [];
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );

  try {
    await service.reapExpiredSessions();
    assert.equal(
      fixture.states.get("session-test")?.pendingTurnNativeTurnId,
      "turn-recovered",
    );
  } finally {
    await service.close();
  }
});

test("replays a staged Turn frame after native state proves it was not accepted", async () => {
  const pending = storedRuntime();
  pending.pendingTurnRequestId = "turn-start:staged";
  pending.pendingTurnClientMessageId = "user-message:staged";
  pending.pendingTurnStableInputId = "turn-input:staged";
  pending.pendingTurnPhase = "staged";
  pending.pendingTurnStartedAt = new Date(0);
  const fixture = transportFixture({
    states: [pending],
    onWrite(_sessionId, message) {
      if (message.method === "thread/read") {
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-test", []),
          }),
        ];
      }
    },
  });
  Object.assign(fixture.store as object, {
    async interruptedTurnMutations() {
      return [];
    },
    async pendingTurnSubmissions() {
      return [fixture.states.get("session-test")!];
    },
    async markTurnSubmissionDispatched(sessionId: string) {
      const state = fixture.states.get(sessionId)!;
      fixture.states.set(sessionId, {
        ...state,
        pendingTurnPhase: "submitted",
      });
    },
    async recoverStaleSessionOperations() {
      return [];
    },
    async expiredRuntimeSessions() {
      return [];
    },
    async failedRuntimeSessions() {
      return [];
    },
  });
  await fixture.runtime.stageCodexMessage(
    pending,
    {
      method: "turn/start",
      id: pending.pendingTurnRequestId,
      params: {
        threadId: pending.nativeSessionId,
        clientUserMessageId: pending.pendingTurnClientMessageId,
        input: [{ type: "text", text: "rootfs outbox only" }],
      },
    },
    pending.pendingTurnStableInputId,
  );
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );

  try {
    await service.reapExpiredSessions();
    assert.equal(
      fixture.states.get("session-test")?.pendingTurnPhase,
      "submitted",
    );
    assert.equal(
      fixture.writes.filter((write) => write.message.method === "turn/start")
        .length,
      1,
    );
  } finally {
    await service.close();
  }
});

test("coalesces concurrent ingest and publishes only transcript notifications", async () => {
  const fixture = transportFixture();
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );
  fixture.enqueue("session-test", [
    {
      method: "turn/started",
      params: {
        threadId: "thread-test",
        turn: {
          ...completedTurn("turn-live"),
          status: "inProgress",
          completedAt: null,
        },
      },
    },
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-test",
        turnId: "turn-live",
        itemId: "item-agent",
        delta: "hello",
      },
    },
    {
      method: "thread/tokenUsage/updated",
      params: { threadId: "thread-test" },
    },
    rpcResult("rpc-unclaimed", { ok: true }),
  ]);

  try {
    await Promise.all([
      service.ingestOnce("session-test"),
      service.ingestOnce("session-test"),
      service.ingestOnce("session-test"),
    ]);
    assert.equal(fixture.listCalls(), 1);
    assert.equal(fixture.transitions.length, 1);
    assert.deepEqual(fixture.transitions[0], [
      {
        type: "turnStarted",
        nativeSessionId: "thread-test",
        nativeTurnId: "turn-live",
        startedAt: new Date("2025-07-15T00:00:00.000Z"),
        supervisorSequence: 1,
      },
    ]);
    const updates = service.listLiveNotifications("session-test", 0);
    assert.deepEqual(
      updates.map((update) =>
        update.kind === "notification" ? update.event.notification.method : update.kind,
      ),
      ["turn/started", "item/agentMessage/delta"],
    );
    assert.equal(service.liveCursor("session-test"), 2);
  } finally {
    await service.close();
  }
});

test("stops normal decoding and explicitly reconciles a Supervisor retention gap", async () => {
  const state = storedRuntime();
  const fixture = transportFixture({
    states: [state],
    eventSequenceStart: 8,
    onWrite: (() => {
      let reads = 0;
      return (_sessionId, message) => {
        if (message.method !== "thread/read") return;
        reads += 1;
        if (reads === 1) {
          return [
            rpcResult(message.id, {
              thread: nativeThread("thread-test", []),
            }),
            {
              method: "turn/started",
              params: {
                threadId: "thread-test",
                turn: {
                  ...completedTurn("turn-after-response"),
                  status: "inProgress",
                  completedAt: null,
                },
              },
            },
          ];
        }
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-test", [
              {
                ...completedTurn("turn-after-response"),
                status: "inProgress",
                completedAt: null,
              },
            ]),
          }),
        ];
      };
    })(),
  });
  let reconciled = false;
  Object.assign(fixture.store as object, {
    async markSupervisorJournalGap(
      sessionId: string,
      expected: StoredRuntime,
      earliest: number,
    ) {
      assert.equal(earliest, 9);
      const current = fixture.states.get(sessionId)!;
      assert.equal(expected.decoder.supervisorCursor, 0);
      fixture.states.set(sessionId, {
        ...current,
        supervisorCursor: earliest - 1,
        runtimeErrorCode: "supervisor_journal_gap",
        decoder: {
          ...current.decoder,
          supervisorCursor: earliest - 1,
          tailBase64: "",
        },
      });
      return true;
    },
    async reconcileSupervisorJournalGap(
      sessionId: string,
      input: {
        nativeSessionId: string;
        activeNativeTurnId?: string;
        nativeHistoryMaterialized: boolean;
      },
    ) {
      assert.equal(input.nativeSessionId, "thread-test");
      assert.equal(input.activeNativeTurnId, "turn-after-response");
      assert.equal(input.nativeHistoryMaterialized, true);
      const current = fixture.states.get(sessionId)!;
      fixture.states.set(sessionId, {
        ...current,
        runtimeErrorCode: undefined,
        activeNativeTurnId: input.activeNativeTurnId,
      });
      reconciled = true;
      return true;
    },
  });
  fixture.enqueue("session-test", [
    {
      method: "turn/completed",
      params: {
        threadId: "thread-test",
        turn: completedTurn("turn-expired-boundary"),
      },
    },
  ]);
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );

  try {
    await assert.rejects(
      service.ingestOnce("session-test"),
      (error: unknown) =>
        error instanceof HttpError && error.code === "supervisor_journal_gap",
    );
    assert.equal(fixture.transitions.length, 0);
    const internals = service as unknown as {
      recoverSupervisorJournalGap(sessionId: string): Promise<StoredRuntime>;
    };
    await internals.recoverSupervisorJournalGap("session-test");
    assert.equal(reconciled, true);
    assert.deepEqual(fixture.transitions.flat(), []);
    assert.deepEqual(service.listLiveNotifications("session-test", 1), [
      {
        cursor: 2,
        kind: "invalidation",
        reason: "supervisor-journal-reconciled",
        message:
          "Native Codex history was reloaded after a live-event retention gap. Missing checkpoint capability was not reconstructed.",
      },
    ]);
    assert.equal(
      fixture.states.get("session-test")?.runtimeErrorCode,
      undefined,
    );
  } finally {
    await service.close();
  }
});

test("invalidates a client whose live cursor fell behind the bounded ring", async () => {
  const fixture = transportFixture();
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );
  fixture.enqueue(
    "session-test",
    Array.from({ length: 1_001 }, (_, index) => ({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-test",
        turnId: "turn-live",
        itemId: "item-agent",
        delta: String(index),
      },
    })),
  );

  try {
    await service.ingestOnce("session-test");
    assert.deepEqual(service.listLiveNotifications("session-test", 0), [
      {
        cursor: 1,
        kind: "invalidation",
        reason: "live-window-expired",
        message:
          "The live Codex update window expired; reload the native snapshot.",
      },
    ]);
    assert.equal(service.liveCursor("session-test"), 1_001);
  } finally {
    await service.close();
  }
});

test("reads the exact native Thread without reconciling control state", async () => {
  const thread = nativeThread("thread-test", [completedTurn("turn-1")]);
  const state = storedRuntime();
  state.historyRevision = 4;
  state.activeNativeTurnId = "turn-control";
  const fixture = transportFixture({
    states: [state],
    readyTurnIds: ["turn-1"],
    onWrite(_sessionId, message) {
      if (message.method === "thread/read") {
        assert.deepEqual(message.params, {
          threadId: "thread-test",
          includeTurns: true,
        });
        return [rpcResult(message.id, { thread })];
      }
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );

  try {
    assert.deepEqual(
      await service.readNativeSnapshot("user-test", "session-test"),
      {
        protocol: "codex-app-server",
        nativeSessionId: "thread-test",
        historyRevision: 4,
        modelId: "gpt-test",
        sessionStatus: "waiting",
        thread,
        forkableTurnIds: ["turn-1"],
        rewindableTurnIds: ["turn-1"],
      },
    );
    assert.equal(
      fixture.states.get("session-test")?.activeNativeTurnId,
      "turn-control",
    );
    assert.equal(service.liveCursor("session-test"), 0);
  } finally {
    await service.close();
  }
});

test("anchors a native snapshot at its exact response record", async () => {
  const thread = nativeThread("thread-test", [completedTurn("turn-1")]);
  const fixture = transportFixture({
    onWrite(_sessionId, message) {
      if (message.method !== "thread/read") return;
      const notification = (delta: string) => ({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-test",
          turnId: "turn-1",
          itemId: "item-agent",
          delta,
        },
      });
      return [
        notification("before-response"),
        rpcResult(message.id, { thread }),
        notification("after-response"),
      ];
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );

  try {
    const read = await service.readNativeSnapshotWithCursor(
      "user-test",
      "session-test",
    );
    assert.deepEqual(read.snapshot.thread, thread);
    assert.equal(read.liveCursor, 1);
    assert.equal(service.liveCursor("session-test"), 2);
    assert.deepEqual(
      service.listLiveNotifications("session-test", read.liveCursor).map(
        (update) =>
          update.kind === "notification"
            ? update.event.notification.params
            : update,
      ),
      [
        {
          threadId: "thread-test",
          turnId: "turn-1",
          itemId: "item-agent",
          delta: "after-response",
        },
      ],
    );
  } finally {
    await service.close();
  }
});

test("reads an unmaterialized first native Thread without inventing history", async () => {
  const fixture = transportFixture({
    onWrite(_sessionId, message) {
      if (message.method !== "thread/read") return;
      const params = message.params as { includeTurns?: boolean };
      return params.includeTurns
        ? [
            {
              id: message.id,
              error: {
                message:
                  "thread thread-test is not materialized yet; includeTurns is unavailable before first user message",
              },
            },
          ]
        : [
            rpcResult(message.id, {
              thread: { id: "thread-test", status: { type: "idle" } },
            }),
          ];
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );

  try {
    const read = await service.readNativeSnapshotWithCursor(
      "user-test",
      "session-test",
    );
    assert.deepEqual(read.snapshot.thread.turns, []);
    assert.deepEqual(
      fixture.writes
        .filter(({ message }) => message.method === "thread/read")
        .map(({ message }) => message.params),
      [
        { threadId: "thread-test", includeTurns: true },
        { threadId: "thread-test", includeTurns: false },
      ],
    );
  } finally {
    await service.close();
  }
});

test("marks an empty native Thread unrecoverable when completed checkpoints exist", async () => {
  const marked: Array<[string, string]> = [];
  const fixture = transportFixture({
    readyTurnIds: ["turn-old"],
    onUnrecoverable(sessionId, message) {
      marked.push([sessionId, message]);
    },
    onWrite(_sessionId, message) {
      if (message.method !== "thread/read") return;
      return [
        {
          id: message.id,
          error: {
            message:
              "thread thread-test is not materialized yet; includeTurns is unavailable before first user message",
          },
        },
      ];
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );

  try {
    await assert.rejects(
      service.readNativeSnapshotWithCursor("user-test", "session-test"),
      (error: unknown) =>
        error instanceof HttpError &&
        error.code === "codex_native_session_unrecoverable",
    );
    assert.equal(marked.length, 1);
    assert.equal(marked[0]?.[0], "session-test");
    assert.deepEqual(service.listLiveNotifications("session-test", 0), [
      {
        cursor: 1,
        kind: "invalidation",
        reason: "native-session-unrecoverable",
        message: marked[0]?.[1],
        unrecoverable: true,
      },
    ]);
  } finally {
    await service.close();
  }
});

test("treats an ordinal-zero native head as materialized history", async () => {
  const fixture = transportFixture({
    hasMaterializedHistory: true,
    onWrite(_sessionId, message) {
      if (message.method !== "thread/read") return;
      return [
        {
          id: message.id,
          error: {
            message:
              "thread thread-test is not materialized yet; includeTurns is unavailable before first user message",
          },
        },
      ];
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );

  try {
    await assert.rejects(
      service.readNativeSnapshotWithCursor("user-test", "session-test"),
      (error: unknown) =>
        error instanceof HttpError &&
        error.code === "codex_native_session_unrecoverable",
    );
    assert.deepEqual(
      fixture.writes
        .filter(({ message }) => message.method === "thread/read")
        .map(({ message }) => message.params),
      [{ threadId: "thread-test", includeTurns: true }],
    );
  } finally {
    await service.close();
  }
});

test("does not replace a missing native resume with thread/start", async () => {
  const fixture = transportFixture({
    onWrite(_sessionId, message) {
      if (message.method === "initialize") return [rpcResult(message.id, {})];
      if (message.method === "thread/resume") {
        return [
          {
            id: message.id,
            error: { message: "no rollout found for thread id thread-test" },
          },
        ];
      }
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );
  const internals = service as unknown as {
    initializeAttempt(
      sessionId: string,
      thread: { mode: "resume" },
    ): Promise<unknown>;
  };

  try {
    await assert.rejects(
      internals.initializeAttempt("session-test", { mode: "resume" }),
      /no rollout found/i,
    );
    assert.deepEqual(
      fixture.writes.map(({ message }) => message.method),
      ["initialize", "initialized", "thread/resume"],
    );
  } finally {
    await service.close();
  }
});

test("canonicalizes a recovered interrupted Turn on a child native Session", async () => {
  const interrupted = {
    ...completedTurn("turn-interrupted"),
    status: "interrupted" as const,
  };
  const fixture = transportFixture({
    onWrite(_sessionId, message) {
      if (message.method === "initialize") return [rpcResult(message.id, {})];
      if (message.method === "thread/resume") {
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-test", [interrupted]),
          }),
        ];
      }
      if (message.method === "thread/fork") {
        assert.equal(
          (message.params as Record<string, unknown>).lastTurnId,
          undefined,
        );
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-canonical", [interrupted]),
          }),
        ];
      }
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );
  const internals = service as unknown as {
    initializeAttempt(
      sessionId: string,
      thread: {
        mode: "resume";
        canonicalizeInterruptedTurnId: string;
      },
    ): Promise<{
      nativeSessionId: string;
      interruptedCanonicalized: boolean;
    }>;
  };

  try {
    const result = await internals.initializeAttempt("session-test", {
      mode: "resume",
      canonicalizeInterruptedTurnId: "turn-interrupted",
    });
    assert.deepEqual(result, {
      interruptedTurnId: "turn-interrupted",
      nativeSessionId: "thread-canonical",
      nativeHeadTurnId: "turn-interrupted",
      interruptedCanonicalized: true,
    });
    assert.equal(
      fixture.states.get("session-test")?.nativeSessionId,
      "thread-canonical",
    );
    assert.equal(
      fixture.states.get("session-test")?.historyRevision,
      1,
    );
  } finally {
    await service.close();
  }
});

test("fences runtime recovery with one durable Session operation", async () => {
  const fixture = transportFixture();
  const calls: string[] = [];
  Object.assign(fixture.store as object, {
    async reserveRuntimeRecovery(
      sessionId: string,
      expectedSupervisorSessionId: string,
    ) {
      const state = fixture.states.get(sessionId);
      assert.ok(state);
      assert.equal(expectedSupervisorSessionId, state.supervisorSessionId);
      fixture.states.set(sessionId, {
        ...state,
        exclusiveOperationId: "operation-recovery",
        exclusiveOperationKind: "runtime_recovery",
      });
      calls.push("reserve");
      return "operation-recovery";
    },
    async touchSessionOperation(_sessionId: string, operationId: string) {
      assert.equal(operationId, "operation-recovery");
      calls.push("touch");
      return true;
    },
    async replaceRecoveredCodexRuntime(
      sessionId: string,
      operationId: string,
      expectedSupervisorSessionId: string,
    ) {
      const state = fixture.states.get(sessionId);
      assert.ok(state);
      assert.equal(operationId, state.exclusiveOperationId);
      assert.equal(expectedSupervisorSessionId, state.supervisorSessionId);
      calls.push("replace");
      return true;
    },
    async markRecoveredCodexRuntimeReady(
      sessionId: string,
      operationId: string,
    ) {
      const state = fixture.states.get(sessionId);
      assert.ok(state);
      assert.equal(operationId, state.exclusiveOperationId);
      calls.push("ready");
      return true;
    },
    async releaseSessionOperation(sessionId: string, operationId: string) {
      const state = fixture.states.get(sessionId);
      assert.ok(state);
      assert.equal(operationId, state.exclusiveOperationId);
      fixture.states.set(sessionId, {
        ...state,
        exclusiveOperationId: undefined,
        exclusiveOperationKind: undefined,
      });
      calls.push("release");
      return true;
    },
  });
  Object.assign(fixture.runtime as object, {
    async recoverCodexRuntime(runtime: RuntimeSessionRecord) {
      assert.equal(
        fixture.states.get(runtime.id)?.exclusiveOperationId,
        "operation-recovery",
      );
      calls.push("recover");
      return {
        supervisorSessionId: runtime.supervisorSessionId,
        attemptId: runtime.attemptId!,
        runtimeGeneration: runtime.runtimeGeneration!,
        sandboxRestarted: false,
      };
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );
  const internals = service as unknown as {
    recoverRuntime(sessionId: string, expected: StoredRuntime): Promise<StoredRuntime>;
  };

  try {
    const expected = fixture.states.get("session-test")!;
    const recovered = await internals.recoverRuntime("session-test", expected);
    assert.equal(recovered.supervisorSessionId, expected.supervisorSessionId);
    assert.equal(
      fixture.states.get("session-test")?.exclusiveOperationId,
      undefined,
    );
    assert.deepEqual(calls, [
      "reserve",
      "touch",
      "recover",
      "replace",
      "ready",
      "release",
    ]);
  } finally {
    await service.close();
  }
});

test("keeps the durable recovery owner when its advisory fence is lost", async () => {
  const fixture = transportFixture();
  const controller = new AbortController();
  let released = false;
  let replaced = false;
  Object.assign(fixture.store as object, {
    async acquireSessionOperationLock() {
      return {
        signal: controller.signal,
        async release() {},
      };
    },
    async reserveRuntimeRecovery(sessionId: string) {
      const state = fixture.states.get(sessionId)!;
      fixture.states.set(sessionId, {
        ...state,
        exclusiveOperationId: "operation-recovery",
        exclusiveOperationKind: "runtime_recovery",
      });
      return "operation-recovery";
    },
    async releaseSessionOperation() {
      released = true;
      return true;
    },
    async replaceRecoveredCodexRuntime() {
      replaced = true;
      return true;
    },
  });
  Object.assign(fixture.runtime as object, {
    async recoverCodexRuntime(runtime: RuntimeSessionRecord) {
      controller.abort();
      return {
        supervisorSessionId: runtime.supervisorSessionId,
        attemptId: runtime.attemptId!,
        runtimeGeneration: runtime.runtimeGeneration!,
        sandboxRestarted: false,
      };
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );
  const internals = service as unknown as {
    recoverRuntime(sessionId: string, expected: StoredRuntime): Promise<StoredRuntime>;
  };

  try {
    const expected = fixture.states.get("session-test")!;
    await assert.rejects(
      internals.recoverRuntime("session-test", expected),
      (error: unknown) =>
        error instanceof HttpError &&
        error.code === "session_operation_fence_lost",
    );
    assert.equal(replaced, false);
    assert.equal(released, false);
    assert.equal(
      fixture.states.get("session-test")?.exclusiveOperationId,
      "operation-recovery",
    );
  } finally {
    await service.close();
  }
});

test("recovers a native Turn accepted before turn-start projection", async () => {
  const current = storedRuntime();
  current.pendingTurnRequestId = "turn-start:request";
  current.pendingTurnClientMessageId = "client-message";
  current.pendingTurnStableInputId = "turn-input:logical";
  current.pendingTurnPhase = "submitted";
  current.provisioningError = "The previous Codex attempt exited.";
  const interrupted = {
    ...completedTurn("turn-unprojected"),
    status: "interrupted" as const,
  };
  const nativeOrder: string[] = [];
  const fixture = transportFixture({
    states: [current],
    onWrite(_sessionId, message) {
      if (message.method === "initialize") return [rpcResult(message.id, {})];
      if (message.method === "thread/resume") {
        nativeOrder.push("resume");
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-test", [interrupted]),
          }),
        ];
      }
      if (message.method === "thread/fork") {
        nativeOrder.push("fork");
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-canonical", [interrupted]),
          }),
        ];
      }
    },
  });
  const finalized: string[] = [];
  Object.assign(fixture.store as object, {
    async reserveRuntimeRecovery(sessionId: string) {
      const state = fixture.states.get(sessionId)!;
      fixture.states.set(sessionId, {
        ...state,
        exclusiveOperationId: "operation-recovery",
        exclusiveOperationKind: "runtime_recovery",
      });
      return "operation-recovery";
    },
    async replaceRecoveredCodexRuntime(
      sessionId: string,
      operationId: string,
      _expectedSupervisorSessionId: string,
      recovered: {
        supervisorSessionId: string;
        attemptId: string;
        runtimeGeneration: number;
      },
    ) {
      const state = fixture.states.get(sessionId)!;
      assert.equal(operationId, state.exclusiveOperationId);
      fixture.states.set(sessionId, {
        ...state,
        supervisorSessionId: recovered.supervisorSessionId,
        attemptId: recovered.attemptId,
        runtimeGeneration: recovered.runtimeGeneration,
        decoder: {
          supervisorCursor: 0,
          tailBase64: "",
          attemptId: recovered.attemptId,
          runtimeGeneration: recovered.runtimeGeneration,
        },
      });
      return true;
    },
    async recoveredTurnInterruptionClaim(sessionId: string) {
      return fixture.states.get(sessionId)?.pendingInterruptedNativeTurnId;
    },
    async recordRecoveredTurnInterruption(
      sessionId: string,
      operationId: string,
      _supervisorSessionId: string,
      _attemptId: string,
      turnId: string,
    ) {
      const state = fixture.states.get(sessionId)!;
      assert.equal(operationId, state.exclusiveOperationId);
      assert.equal(turnId, "turn-unprojected");
      fixture.states.set(sessionId, {
        ...state,
        pendingInterruptedNativeTurnId: turnId,
      });
      nativeOrder.push("journal");
      finalized.push("journal");
      return true;
    },
    async claimTurnCheckpoint(
      _sessionId: string,
      input: { nativeTurnId?: string },
    ) {
      assert.equal(input.nativeTurnId, "turn-unprojected");
      return { state: "claimed", id: "checkpoint-interrupted", ordinal: 1 };
    },
    async completeTurnCheckpoint() {
      const state = fixture.states.get("session-test")!;
      fixture.states.set("session-test", {
        ...state,
        pendingTurnRequestId: undefined,
        pendingTurnClientMessageId: undefined,
        pendingTurnStableInputId: undefined,
        pendingTurnPhase: undefined,
        pendingTurnNativeTurnId: undefined,
      });
      finalized.push("checkpoint");
    },
    async failTurnCheckpoint() {
      assert.fail("the interrupted checkpoint must complete");
    },
    async markRecoveredTurnInterrupted(
      sessionId: string,
      operationId: string,
      _supervisorSessionId: string,
      _attemptId: string,
      turnId: string,
    ) {
      const state = fixture.states.get(sessionId)!;
      assert.equal(operationId, state.exclusiveOperationId);
      assert.equal(turnId, "turn-unprojected");
      fixture.states.set(sessionId, {
        ...state,
        pendingInterruptedNativeTurnId: undefined,
        activeNativeTurnId: undefined,
      });
      finalized.push("finalize");
      return true;
    },
    async markRecoveredCodexRuntimeReady() {
      return true;
    },
  });
  Object.assign(fixture.runtime as object, {
    async recoverCodexRuntime() {
      return {
        supervisorSessionId: "supervisor-recovered",
        attemptId: "attempt-recovered",
        runtimeGeneration: 2,
        sandboxRestarted: false,
      };
    },
    async createVolumeCheckpoint() {
      return { snapshotId: "snapshot-interrupted" };
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );
  const internals = service as unknown as {
    recoverRuntime(sessionId: string, expected: StoredRuntime): Promise<StoredRuntime>;
  };

  try {
    await internals.recoverRuntime("session-test", current);
    const recovered = fixture.states.get("session-test")!;
    assert.equal(recovered.nativeSessionId, "thread-canonical");
    assert.equal(recovered.pendingTurnPhase, undefined);
    assert.equal(recovered.pendingInterruptedNativeTurnId, undefined);
    assert.deepEqual(nativeOrder, ["resume", "journal", "fork"]);
    assert.deepEqual(finalized, ["journal", "checkpoint", "finalize"]);
  } finally {
    await service.close();
  }
});

test("keeps a committed Volume checkpoint when its COMMIT response is lost", async () => {
  const fixture = transportFixture();
  let deleted = false;
  let failed = false;
  Object.assign(fixture.store as object, {
    async claimTurnCheckpoint() {
      return { state: "claimed", id: "checkpoint-one", ordinal: 1 };
    },
    async completeTurnCheckpoint() {
      throw new Error("connection lost after COMMIT");
    },
    async reconcileTurnCheckpointCommit(
      checkpointId: string,
      snapshotId: string,
    ) {
      assert.equal(checkpointId, "checkpoint-one");
      assert.equal(snapshotId, "snapshot-one");
      return true;
    },
    async failTurnCheckpoint() {
      failed = true;
    },
  });
  Object.assign(fixture.runtime as object, {
    async createVolumeCheckpoint() {
      return { snapshotId: "snapshot-one" };
    },
    async deleteVolumeCheckpoint() {
      deleted = true;
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );
  const internals = service as unknown as {
    captureVolumeCheckpoint(
      sessionId: string,
      input: {
        label: string;
        nativeSessionId: string;
        nativeTurnId: string;
      },
    ): Promise<boolean>;
  };

  try {
    assert.equal(
      await internals.captureVolumeCheckpoint("session-test", {
        label: "turn-one",
        nativeSessionId: "thread-test",
        nativeTurnId: "turn-one",
      }),
      true,
    );
    assert.equal(deleted, false);
    assert.equal(failed, false);
  } finally {
    await service.close();
  }
});

test("retries an ambiguous Volume checkpoint until its commit is verified", async () => {
  const fixture = transportFixture();
  let deleted = false;
  let failed = false;
  let verificationAttempts = 0;
  Object.assign(fixture.store as object, {
    async claimTurnCheckpoint() {
      return { state: "claimed", id: "checkpoint-one", ordinal: 1 };
    },
    async completeTurnCheckpoint() {
      throw new Error("connection lost after COMMIT");
    },
    async reconcileTurnCheckpointCommit() {
      verificationAttempts += 1;
      if (verificationAttempts === 1) {
        throw new Error("database unavailable");
      }
      return true;
    },
    async failTurnCheckpoint() {
      failed = true;
    },
  });
  Object.assign(fixture.runtime as object, {
    async createVolumeCheckpoint() {
      return { snapshotId: "snapshot-one" };
    },
    async deleteVolumeCheckpoint() {
      deleted = true;
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );
  const internals = service as unknown as {
    captureVolumeCheckpoint(
      sessionId: string,
      input: {
        label: string;
        nativeSessionId: string;
        nativeTurnId: string;
      },
    ): Promise<boolean>;
  };

  try {
    assert.equal(
      await internals.captureVolumeCheckpoint("session-test", {
        label: "turn-one",
        nativeSessionId: "thread-test",
        nativeTurnId: "turn-one",
      }),
      true,
    );
    assert.equal(verificationAttempts, 2);
    assert.equal(deleted, false);
    assert.equal(failed, false);
  } finally {
    await service.close();
  }
});

test("deletes only a Volume checkpoint proven not to have committed", async () => {
  const fixture = transportFixture();
  const deleted: string[] = [];
  const failed: string[] = [];
  Object.assign(fixture.store as object, {
    async claimTurnCheckpoint() {
      return { state: "claimed", id: "checkpoint-one", ordinal: 1 };
    },
    async completeTurnCheckpoint() {
      throw new Error("transaction rolled back");
    },
    async reconcileTurnCheckpointCommit() {
      return false;
    },
    async failTurnCheckpoint(checkpointId: string) {
      failed.push(checkpointId);
    },
  });
  Object.assign(fixture.runtime as object, {
    async createVolumeCheckpoint() {
      return { snapshotId: "snapshot-one" };
    },
    async deleteVolumeCheckpoint(
      _runtime: RuntimeSessionRecord,
      snapshotId: string,
    ) {
      deleted.push(snapshotId);
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );
  const internals = service as unknown as {
    captureVolumeCheckpoint(
      sessionId: string,
      input: {
        label: string;
        nativeSessionId: string;
        nativeTurnId: string;
      },
    ): Promise<boolean>;
  };

  try {
    assert.equal(
      await internals.captureVolumeCheckpoint("session-test", {
        label: "turn-one",
        nativeSessionId: "thread-test",
        nativeTurnId: "turn-one",
      }),
      false,
    );
    assert.deepEqual(deleted, ["snapshot-one"]);
    assert.deepEqual(failed, ["checkpoint-one"]);
  } finally {
    await service.close();
  }
});

test("lazily migrates legacy Codex state and commits one v2 Volume baseline", async () => {
  const legacy = storedRuntime();
  legacy.harnessStateLayout = "rootfs_v1";
  legacy.historyRevision = 3;
  legacy.headVolumeSnapshotId = "snapshot-legacy-head";
  const calls: string[] = [];
  const fixture = transportFixture({
    states: [legacy],
    onWrite(_sessionId, message) {
      if (message.method === "initialize") return [rpcResult(message.id, {})];
      if (message.method === "thread/resume" || message.method === "thread/read") {
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-test", [completedTurn("turn-head")]),
          }),
        ];
      }
    },
  });
  Object.assign(fixture.store as object, {
    async beginNativeStateMigration(sessionId: string, operationId: string) {
      const state = fixture.states.get(sessionId);
      assert.ok(state);
      const claimed = { ...state };
      fixture.states.set(sessionId, {
        ...state,
        harnessStateLayout: "migrating",
        exclusiveOperationId: operationId,
        exclusiveOperationKind: "native_state_migration",
      });
      calls.push("begin");
      return claimed;
    },
    async setNativeStateMigrationRuntime(
      sessionId: string,
      operationId: string,
      input: {
        supervisorSessionId: string;
        attemptId: string;
        runtimeGeneration: number;
      },
    ) {
      const state = fixture.states.get(sessionId);
      assert.ok(state);
      assert.equal(operationId, state.exclusiveOperationId);
      fixture.states.set(sessionId, {
        ...state,
        supervisorSessionId: input.supervisorSessionId,
        attemptId: input.attemptId,
        runtimeGeneration: input.runtimeGeneration,
        decoder: {
          supervisorCursor: 0,
          tailBase64: "",
          attemptId: input.attemptId,
          runtimeGeneration: input.runtimeGeneration,
        },
      });
      calls.push("runtime");
    },
    async recordNativeStateMigrationSnapshot(
      sessionId: string,
      operationId: string,
      expectedHistoryRevision: number,
      snapshotId: string,
    ) {
      const state = fixture.states.get(sessionId);
      assert.ok(state);
      assert.equal(operationId, state.exclusiveOperationId);
      assert.equal(expectedHistoryRevision, 3);
      assert.equal(snapshotId, "snapshot-v2-head");
      fixture.states.set(sessionId, {
        ...state,
        nativeStateMigrationSnapshotId: snapshotId,
      });
      calls.push("record-snapshot");
    },
    async completeNativeStateMigration(
      sessionId: string,
      operationId: string,
      input: {
        nativeSessionId: string;
        expectedHistoryRevision: number;
        headSnapshotId: string;
        nativeHeadTurnId?: string;
      },
    ) {
      assert.equal(
        operationId,
        fixture.states.get(sessionId)?.exclusiveOperationId,
      );
      assert.deepEqual(input, {
        nativeSessionId: "thread-test",
        workspaceVolumeId: "volume-session-test",
        expectedHistoryRevision: 3,
        headSnapshotId: "snapshot-v2-head",
        nativeHeadTurnId: "turn-head",
      });
      const state = fixture.states.get(sessionId);
      assert.ok(state);
      fixture.states.set(sessionId, {
        ...state,
        harnessStateLayout: "workspace_v2",
        historyRevision: 4,
        headVolumeSnapshotId: input.headSnapshotId,
        nativeStateMigrationSnapshotId: undefined,
      });
      calls.push("commit");
      return ["snapshot-legacy-head"];
    },
    async failNativeStateMigration() {
      assert.fail("migration must not fail");
    },
  });
  Object.assign(fixture.runtime as object, {
    async migrateCodexNativeState(runtime: RuntimeSessionRecord, authJson: string) {
      assert.equal(runtime.harnessStateLayout, "rootfs_v1");
      assert.equal(authJson, "{}");
      calls.push("copy");
      return {
        supervisorSessionId: "supervisor-v2",
        attemptId: "attempt-v2",
        runtimeGeneration: 2,
        sandboxRestarted: false,
        harnessStateLayout: "workspace_v2",
        sourceHadRollout: true,
      };
    },
    async findVolumeCheckpoint(
      _runtime: RuntimeSessionRecord,
      label: string,
    ) {
      assert.equal(label, "sandpi-native-state-v2-session-test-r3");
      calls.push("find-snapshot");
      return undefined;
    },
    async createVolumeCheckpoint() {
      calls.push("snapshot");
      return { snapshotId: "snapshot-v2-head" };
    },
    async cleanupLegacyCodexNativeState() {
      calls.push("cleanup-rootfs");
    },
    async deleteVolumeCheckpoint(
      _runtime: RuntimeSessionRecord,
      snapshotId: string,
    ) {
      assert.equal(snapshotId, "snapshot-legacy-head");
      calls.push("cleanup-snapshot");
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );
  const internals = service as unknown as {
    ensureWorkspaceNativeState(
      sessionId: string,
      runtime: StoredRuntime,
    ): Promise<StoredRuntime>;
  };

  try {
    const [migrated, coalesced] = await Promise.all([
      internals.ensureWorkspaceNativeState("session-test", legacy),
      internals.ensureWorkspaceNativeState("session-test", legacy),
    ]);
    assert.equal(migrated.harnessStateLayout, "workspace_v2");
    assert.equal(migrated.historyRevision, 4);
    assert.equal(coalesced.harnessStateLayout, "workspace_v2");
    assert.equal(coalesced.historyRevision, 4);
    assert.deepEqual(calls, [
      "begin",
      "copy",
      "runtime",
      "find-snapshot",
      "snapshot",
      "record-snapshot",
      "commit",
      "cleanup-rootfs",
      "cleanup-snapshot",
    ]);
  } finally {
    await service.close();
  }
});

test("reuses a journaled native-state migration baseline after restart", async () => {
  const legacy = storedRuntime();
  legacy.harnessStateLayout = "migrating";
  legacy.desiredState = "paused";
  legacy.observedState = "failed";
  legacy.historyRevision = 4;
  legacy.nativeStateMigrationSnapshotId = "snapshot-v2-existing";
  const calls: string[] = [];
  const fixture = transportFixture({
    states: [legacy],
    onWrite(_sessionId, message) {
      if (message.method === "initialize") return [rpcResult(message.id, {})];
      if (message.method === "thread/resume" || message.method === "thread/read") {
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-test", [completedTurn("turn-head")]),
          }),
        ];
      }
    },
  });
  Object.assign(fixture.store as object, {
    async beginNativeStateMigration(sessionId: string, operationId: string) {
      const state = fixture.states.get(sessionId)!;
      fixture.states.set(sessionId, {
        ...state,
        exclusiveOperationId: operationId,
        exclusiveOperationKind: "native_state_migration",
      });
      calls.push("begin");
      return { ...state };
    },
    async setNativeStateMigrationRuntime(
      sessionId: string,
      operationId: string,
      input: {
        supervisorSessionId: string;
        attemptId: string;
        runtimeGeneration: number;
      },
    ) {
      const state = fixture.states.get(sessionId)!;
      assert.equal(operationId, state.exclusiveOperationId);
      fixture.states.set(sessionId, {
        ...state,
        supervisorSessionId: input.supervisorSessionId,
        attemptId: input.attemptId,
        runtimeGeneration: input.runtimeGeneration,
        decoder: {
          supervisorCursor: 0,
          tailBase64: "",
          attemptId: input.attemptId,
          runtimeGeneration: input.runtimeGeneration,
        },
      });
    },
    async recordNativeStateMigrationSnapshot() {
      assert.fail("the durable migration baseline must be reused");
    },
    async completeNativeStateMigration(
      sessionId: string,
      operationId: string,
      input: { headSnapshotId: string },
    ) {
      const state = fixture.states.get(sessionId)!;
      assert.equal(operationId, state.exclusiveOperationId);
      assert.equal(input.headSnapshotId, "snapshot-v2-existing");
      fixture.states.set(sessionId, {
        ...state,
        harnessStateLayout: "workspace_v2",
        desiredState: "running",
        observedState: "running",
        historyRevision: 5,
        headVolumeSnapshotId: input.headSnapshotId,
        nativeStateMigrationSnapshotId: undefined,
      });
      calls.push("commit");
      return [];
    },
    async failNativeStateMigration() {
      assert.fail("migration retry must not fail");
    },
  });
  Object.assign(fixture.runtime as object, {
    async migrateCodexNativeState() {
      calls.push("migrate");
      return {
        supervisorSessionId: "supervisor-v2",
        attemptId: "attempt-v2",
        runtimeGeneration: 2,
        sandboxRestarted: false,
        harnessStateLayout: "workspace_v2",
        sourceHadRollout: true,
      };
    },
    async findVolumeCheckpoint() {
      assert.fail("a journaled snapshot needs no discovery");
    },
    async createVolumeCheckpoint() {
      assert.fail("a journaled snapshot must not be recreated");
    },
    async cleanupLegacyCodexNativeState() {},
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );
  const internals = service as unknown as {
    ensureWorkspaceNativeState(
      sessionId: string,
      runtime: StoredRuntime,
    ): Promise<StoredRuntime>;
  };

  try {
    const migrated = await internals.ensureWorkspaceNativeState(
      "session-test",
      legacy,
    );
    assert.equal(migrated.harnessStateLayout, "workspace_v2");
    assert.equal(migrated.headVolumeSnapshotId, "snapshot-v2-existing");
    assert.deepEqual(calls, ["begin", "migrate", "commit"]);
  } finally {
    await service.close();
  }
});

test("claims a discovered migration baseline instead of creating it twice", async () => {
  const legacy = storedRuntime();
  legacy.harnessStateLayout = "migrating";
  legacy.historyRevision = 6;
  legacy.exclusiveOperationId = "operation-migration";
  legacy.exclusiveOperationKind = "native_state_migration";
  let state = { ...legacy };
  const calls: string[] = [];
  const store = {
    async touchSessionOperation() {
      return true;
    },
    async setNativeStateMigrationRuntime() {},
    async decoderState() {
      return state;
    },
    async recordNativeStateMigrationSnapshot(
      _sessionId: string,
      operationId: string,
      expectedHistoryRevision: number,
      snapshotId: string,
    ) {
      assert.equal(operationId, "operation-migration");
      assert.equal(expectedHistoryRevision, 6);
      assert.equal(snapshotId, "snapshot-discovered");
      state = { ...state, nativeStateMigrationSnapshotId: snapshotId };
      calls.push("record");
    },
    async completeNativeStateMigration(
      _sessionId: string,
      operationId: string,
      input: { headSnapshotId: string },
    ) {
      assert.equal(operationId, "operation-migration");
      assert.equal(input.headSnapshotId, "snapshot-discovered");
      state = {
        ...state,
        harnessStateLayout: "workspace_v2",
        historyRevision: 7,
        headVolumeSnapshotId: input.headSnapshotId,
        nativeStateMigrationSnapshotId: undefined,
      };
      calls.push("commit");
      return [];
    },
    async failNativeStateMigration() {
      assert.fail("discovered migration baseline must commit");
    },
  } as unknown as SandpiStore;
  const runtime = {
    async migrateCodexNativeState() {
      return {
        supervisorSessionId: "supervisor-v2",
        attemptId: "attempt-v2",
        runtimeGeneration: 2,
        sandboxRestarted: false,
        harnessStateLayout: "workspace_v2",
        sourceHadRollout: true,
      };
    },
    async findVolumeCheckpoint(
      _runtime: RuntimeSessionRecord,
      label: string,
    ) {
      assert.equal(label, "sandpi-native-state-v2-session-test-r6");
      calls.push("find");
      return { snapshotId: "snapshot-discovered" };
    },
    async createVolumeCheckpoint() {
      assert.fail("the existing baseline must not be recreated");
    },
    async cleanupLegacyCodexNativeState() {},
  } as unknown as RuntimeAdapter;
  const service = new CodexService(store, runtime, logger, credentials);
  Object.assign(service as object, {
    async initializeAttempt() {
      return {
        nativeSessionId: "thread-test",
        nativeHeadTurnId: "turn-head",
        interruptedCanonicalized: false,
      };
    },
    async readNativeHeadTurnId() {
      return "turn-head";
    },
    ensureWorker() {},
  });
  const internals = service as unknown as {
    performClaimedWorkspaceNativeStateMigration(
      sessionId: string,
      runtime: StoredRuntime,
      fence: {
        operationId: string;
        lock: { signal: AbortSignal; release(): Promise<void> };
      },
    ): Promise<StoredRuntime>;
  };

  try {
    const migrated = await internals.performClaimedWorkspaceNativeStateMigration(
      "session-test",
      legacy,
      {
        operationId: "operation-migration",
        lock: {
          signal: new AbortController().signal,
          async release() {},
        },
      },
    );
    assert.equal(migrated.harnessStateLayout, "workspace_v2");
    assert.deepEqual(calls, ["find", "record", "commit"]);
  } finally {
    await service.close();
  }
});

test("does not erase proven legacy history when copied rollout lookup is empty", async () => {
  const legacy = storedRuntime();
  legacy.harnessStateLayout = "rootfs_v1";
  legacy.nativeHistoryMaterialized = true;
  const calls: string[] = [];
  const fixture = transportFixture({
    states: [legacy],
    onWrite(_sessionId, message) {
      if (message.method === "initialize") return [rpcResult(message.id, {})];
      if (message.method === "thread/resume") {
        return [{
          id: message.id,
          error: { message: "no rollout found for thread id thread-test" },
        }];
      }
      if (message.method === "thread/start") {
        assert.fail("database history proof forbids an empty replacement Thread");
      }
    },
  });
  Object.assign(fixture.store as object, {
    async beginNativeStateMigration(sessionId: string, operationId: string) {
      const current = fixture.states.get(sessionId);
      assert.ok(current);
      fixture.states.set(sessionId, {
        ...current,
        harnessStateLayout: "migrating",
        exclusiveOperationId: operationId,
        exclusiveOperationKind: "native_state_migration",
      });
      return { ...current };
    },
    async setNativeStateMigrationRuntime(
      sessionId: string,
      operationId: string,
      input: {
        supervisorSessionId: string;
        attemptId: string;
        runtimeGeneration: number;
      },
    ) {
      const current = fixture.states.get(sessionId);
      assert.ok(current);
      assert.equal(operationId, current.exclusiveOperationId);
      fixture.states.set(sessionId, {
        ...current,
        supervisorSessionId: input.supervisorSessionId,
        attemptId: input.attemptId,
        runtimeGeneration: input.runtimeGeneration,
        decoder: {
          supervisorCursor: 0,
          tailBase64: "",
          attemptId: input.attemptId,
          runtimeGeneration: input.runtimeGeneration,
        },
      });
    },
    async failNativeStateMigration() {
      calls.push("failed-retryable");
    },
  });
  Object.assign(fixture.runtime as object, {
    async migrateCodexNativeState() {
      return {
        supervisorSessionId: "supervisor-v2",
        attemptId: "attempt-v2",
        runtimeGeneration: 2,
        sandboxRestarted: false,
        harnessStateLayout: "workspace_v2",
        sourceHadRollout: false,
      };
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );
  const internals = service as unknown as {
    ensureWorkspaceNativeState(
      sessionId: string,
      runtime: StoredRuntime,
    ): Promise<StoredRuntime>;
  };

  try {
    await assert.rejects(
      internals.ensureWorkspaceNativeState("session-test", legacy),
      /no rollout found/i,
    );
    assert.deepEqual(calls, ["failed-retryable"]);
    assert.equal(
      fixture.writes.some(({ message }) => message.method === "thread/start"),
      false,
    );
  } finally {
    await service.close();
  }
});


test("rejects a Turn mutation before prepare when another replica owns the Session", async () => {
  const fixture = transportFixture();
  let prepared = false;
  Object.assign(fixture.store as object, {
    async acquireSessionOperationLock() {
      return undefined;
    },
    async prepareTurnMutation() {
      prepared = true;
      assert.fail("an unfenced mutation must never be prepared");
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
  );

  try {
    await assert.rejects(
      service.deleteTurn("user-test", "session-test", "turn-test"),
      (error: unknown) =>
        error instanceof HttpError &&
        error.code === "session_operation_in_progress",
    );
    assert.equal(prepared, false);
  } finally {
    await service.close();
  }
});

test("edits by restoring the Session Volume and resuming the same native Session", async () => {
  const calls: string[] = [];
  const fixture = transportFixture({
    onWrite(_sessionId, message) {
      if (message.method === "initialize") return [rpcResult(message.id, {})];
      if (message.method === "thread/resume") {
        assert.deepEqual(message.params, {
          threadId: "thread-test",
          model: "gpt-test",
          cwd: "/workspace",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        });
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-test", [completedTurn("turn-previous")]),
          }),
        ];
      }
      if (message.method === "turn/start") {
        return [rpcResult(message.id, { turn: { id: "turn-replacement" } })];
      }
    },
  });
  Object.assign(fixture.store as object, {
    async prepareTurnMutation(
      _userId: string,
      _sessionId: string,
      nativeTurnId: string,
      kind: string,
    ) {
      calls.push(`prepare:${nativeTurnId}:${kind}`);
      return {
        mutationId: "mutation-test",
        selectedTurnId: nativeTurnId,
        selectedOrdinal: 2,
        inputNativeHeadTurnId: "turn-previous",
        nativeSessionId: "thread-test",
        workspaceVolumeId: "volume-session-test",
        expectedHistoryRevision: 0,
        restoreSnapshotId: "snapshot-input",
        headSnapshotId: "snapshot-head",
      };
    },
    async markTurnMutationRestoreRequested() {
      calls.push("restore-requested");
    },
    async setRestoredRuntime(
      sessionId: string,
      restored: {
        nativeSessionId: string;
        attemptId: string;
        runtimeGeneration: number;
      },
    ) {
      const state = fixture.states.get(sessionId);
      assert.ok(state);
      fixture.states.set(sessionId, {
        ...state,
        ...restored,
        decoder: {
          ...state.decoder,
          attemptId: restored.attemptId,
          runtimeGeneration: restored.runtimeGeneration,
          tailBase64: "",
        },
      });
    },
    async recordPendingTurnInputSnapshot() {
      calls.push("pending-input");
    },
    async markTurnMutationNativeSessionReady(
      _sessionId: string,
      mutationId: string,
      expectedHistoryRevision: number,
      resultNativeSessionId: string,
    ) {
      assert.equal(mutationId, "mutation-test");
      assert.equal(expectedHistoryRevision, 0);
      assert.equal(resultNativeSessionId, "thread-test");
      calls.push("native-session-ready");
    },
    async markTurnMutationReplacementStarted(
      _sessionId: string,
      mutationId: string,
      nativeTurnId: string,
    ) {
      assert.equal(mutationId, "mutation-test");
      assert.equal(nativeTurnId, "turn-replacement");
      calls.push("replacement-started");
    },
    async finalizeTurnMutation(
      sessionId: string,
      _context: unknown,
      status: string,
      _modelId: string | undefined,
      replacement: { nativeTurnId?: string },
    ) {
      const state = fixture.states.get(sessionId);
      assert.ok(state);
      assert.equal(state.nativeSessionId, "thread-test");
      assert.equal(status, "running");
      assert.deepEqual(replacement, { nativeTurnId: "turn-replacement" });
      fixture.states.set(sessionId, {
        ...state,
        historyRevision: state.historyRevision + 1,
        activeNativeTurnId: replacement.nativeTurnId,
      });
      calls.push("finalize");
      return [];
    },
    async getSession() {
      return { id: "session-test", status: "running" };
    },
    async markSessionTurnCompleted() {},
  });
  Object.assign(fixture.runtime as object, {
    async restoreVolumeCheckpoint(
      _runtime: RuntimeSessionRecord,
      snapshotId: string,
    ) {
      assert.equal(snapshotId, "snapshot-input");
      return { attemptId: "attempt-restored", runtimeGeneration: 2 };
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );

  try {
    const result = await service.editTurn({
      userId: "user-test",
      sessionId: "session-test",
      nativeTurnId: "turn-selected",
      text: "edited prompt",
      images: [],
    });
    assert.match(result.requestId ?? "", /^turn-start:/);
    assert.deepEqual(calls, [
      "prepare:turn-selected:edit",
      "restore-requested",
      "native-session-ready",
      "pending-input",
      "replacement-started",
      "finalize",
    ]);
    assert.equal(
      fixture.states.get("session-test")?.nativeSessionId,
      "thread-test",
    );
    assert.deepEqual(
      fixture.writes.map(({ message }) => message.method),
      ["initialize", "initialized", "thread/resume", "turn/start"],
    );
    assert.equal(
      fixture.writes.some(({ message }) => message.method === "thread/fork"),
      false,
    );
  } finally {
    await service.close();
  }
});

test("deleting the first Turn starts a new empty native Session after restore", async () => {
  const calls: string[] = [];
  let resultNativeSessionId: string | undefined;
  const fixture = transportFixture({
    onWrite(_sessionId, message) {
      if (message.method === "initialize") return [rpcResult(message.id, {})];
      if (message.method === "thread/resume") {
        return [
          {
            id: message.id,
            error: {
              code: -32600,
              message: "no rollout found for thread id thread-test",
            },
          },
        ];
      }
      if (message.method === "thread/start") {
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-empty-replacement"),
          }),
        ];
      }
    },
  });
  Object.assign(fixture.store as object, {
    async prepareTurnMutation() {
      return {
        mutationId: "mutation-test",
        selectedTurnId: "turn-first",
        selectedOrdinal: 1,
        inputNativeHeadTurnId: undefined,
        nativeSessionId: "thread-test",
        workspaceVolumeId: "volume-session-test",
        expectedHistoryRevision: 0,
        restoreSnapshotId: "snapshot-baseline",
        headSnapshotId: "snapshot-head",
      };
    },
    async markTurnMutationRestoreRequested() {
      calls.push("restore-requested");
    },
    async setRestoredRuntime(
      sessionId: string,
      restored: {
        nativeSessionId: string;
        attemptId: string;
        runtimeGeneration: number;
      },
    ) {
      const state = fixture.states.get(sessionId);
      assert.ok(state);
      fixture.states.set(sessionId, {
        ...state,
        attemptId: restored.attemptId,
        runtimeGeneration: restored.runtimeGeneration,
        decoder: {
          ...state.decoder,
          attemptId: restored.attemptId,
          runtimeGeneration: restored.runtimeGeneration,
          tailBase64: "",
        },
      });
    },
    async markTurnMutationNativeSessionReady(
      _sessionId: string,
      mutationId: string,
      _expectedHistoryRevision: number,
      nativeSessionId: string,
    ) {
      assert.equal(mutationId, "mutation-test");
      resultNativeSessionId = nativeSessionId;
      calls.push(`native:${nativeSessionId}`);
    },
    async finalizeTurnMutation(
      sessionId: string,
      _context: unknown,
      status: string,
      _modelId: string | undefined,
      replacement: { nativeTurnId?: string },
    ) {
      assert.equal(status, "waiting");
      assert.deepEqual(replacement, { nativeTurnId: undefined });
      assert.equal(resultNativeSessionId, "thread-empty-replacement");
      const state = fixture.states.get(sessionId);
      assert.ok(state);
      fixture.states.set(sessionId, {
        ...state,
        nativeSessionId: resultNativeSessionId,
        historyRevision: state.historyRevision + 1,
      });
      calls.push("finalize");
      return [];
    },
    async getSession() {
      return { id: "session-test", status: "waiting" };
    },
    async markSessionTurnCompleted() {},
  });
  Object.assign(fixture.runtime as object, {
    async restoreVolumeCheckpoint(
      _runtime: RuntimeSessionRecord,
      snapshotId: string,
    ) {
      assert.equal(snapshotId, "snapshot-baseline");
      return { attemptId: "attempt-restored", runtimeGeneration: 2 };
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );

  try {
    await service.deleteTurn("user-test", "session-test", "turn-first");
    assert.deepEqual(calls, [
      "restore-requested",
      "native:thread-empty-replacement",
      "finalize",
    ]);
    assert.equal(
      fixture.states.get("session-test")?.nativeSessionId,
      "thread-empty-replacement",
    );
    assert.deepEqual(
      fixture.writes.map(({ message }) => message.method),
      ["initialize", "initialized", "thread/resume", "thread/start"],
    );
  } finally {
    await service.close();
  }
});

test("does not treat an ordinal-one fork baseline as empty native history", async () => {
  let resumeCalls = 0;
  let releasedWith:
    | {
        clearPendingInput?: boolean;
        expectedPhase?: "prepared" | "compensating";
      }
    | undefined;
  const restoredSnapshots: string[] = [];
  const fixture = transportFixture({
    onWrite(_sessionId, message) {
      if (message.method === "initialize") return [rpcResult(message.id, {})];
      if (message.method === "thread/resume") {
        resumeCalls += 1;
        return resumeCalls === 1
          ? [
              {
                id: message.id,
                error: {
                  code: -32600,
                  message: "no rollout found for thread id thread-test",
                },
              },
            ]
          : [
              rpcResult(message.id, {
                thread: nativeThread("thread-test", [
                  completedTurn("turn-inherited"),
                ]),
              }),
            ];
      }
      if (message.method === "thread/start") {
        assert.fail("A fork baseline with a native head must never become empty");
      }
    },
  });
  Object.assign(fixture.store as object, {
    async prepareTurnMutation() {
      return {
        mutationId: "mutation-test",
        selectedTurnId: "turn-first-local",
        selectedOrdinal: 1,
        inputNativeHeadTurnId: "turn-inherited",
        nativeSessionId: "thread-test",
        workspaceVolumeId: "volume-session-test",
        expectedHistoryRevision: 0,
        restoreSnapshotId: "snapshot-fork-baseline",
        headSnapshotId: "snapshot-head",
      };
    },
    async markTurnMutationRestoreRequested() {},
    async setRestoredRuntime(
      sessionId: string,
      restored: {
        nativeSessionId: string;
        attemptId: string;
        runtimeGeneration: number;
      },
    ) {
      const state = fixture.states.get(sessionId);
      assert.ok(state);
      fixture.states.set(sessionId, {
        ...state,
        ...restored,
        decoder: {
          ...state.decoder,
          attemptId: restored.attemptId,
          runtimeGeneration: restored.runtimeGeneration,
          tailBase64: "",
        },
      });
    },
    async markTurnMutationCompensating() {},
    async releasePreparedTurnMutation(
      _sessionId: string,
      mutationId: string,
      options: {
        clearPendingInput?: boolean;
        expectedPhase?: "prepared" | "compensating";
      },
    ) {
      assert.equal(mutationId, "mutation-test");
      releasedWith = options;
    },
  });
  Object.assign(fixture.runtime as object, {
    async restoreVolumeCheckpoint(
      _runtime: RuntimeSessionRecord,
      snapshotId: string,
    ) {
      restoredSnapshots.push(snapshotId);
      return {
        attemptId: `attempt-restored-${restoredSnapshots.length}`,
        runtimeGeneration: restoredSnapshots.length + 1,
      };
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );

  try {
    await assert.rejects(
      service.deleteTurn(
        "user-test",
        "session-test",
        "turn-first-local",
      ),
      (error: unknown) =>
        error instanceof HttpError && error.code === "codex_thread_restore_failed",
    );
    assert.deepEqual(restoredSnapshots, [
      "snapshot-fork-baseline",
      "snapshot-head",
    ]);
    assert.equal(
      fixture.writes.some(({ message }) => message.method === "thread/start"),
      false,
    );
    assert.deepEqual(releasedWith, {
      clearPendingInput: true,
      expectedPhase: "compensating",
    });
  } finally {
    await service.close();
  }
});

test("forks a complete Session after a native source read barrier", async () => {
  const source = storedRuntime("session-source", "thread-source");
  const fixture = transportFixture({
    states: [source],
    onWrite(sessionId, message) {
      if (message.method === "initialize") return [rpcResult(message.id, {})];
      if (message.method === "thread/read") {
        assert.equal(sessionId, "session-source");
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-source", [completedTurn("turn-source")]),
          }),
        ];
      }
      if (message.method === "thread/fork") {
        assert.equal(sessionId, "session-child");
        const params = message.params as Record<string, unknown>;
        assert.equal(params.threadId, "thread-source");
        assert.equal(params.lastTurnId, undefined);
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-child", [completedTurn("turn-source")]),
          }),
        ];
      }
    },
  });
  let checkpointInput: Record<string, unknown> | undefined;
  Object.assign(fixture.store as object, {
    async getSession() {
      return {
        id: "session-source",
        status: "waiting",
        environmentId: "environment-test",
      };
    },
    async reserveSessionFork() {
      fixture.states.set("session-source", {
        ...fixture.states.get("session-source")!,
        exclusiveOperationId: "operation-source",
        exclusiveOperationKind: "session_fork",
      });
      return "operation-source";
    },
    async acquireSessionOperationLock() {
      return {
        signal: new AbortController().signal,
        async release() {},
      };
    },
    async clearAbandonedSessionOperation() {
      return false;
    },
    async releaseSessionOperation(_sessionId: string, operationId: string) {
      assert.equal(operationId, "operation-source");
      fixture.states.set("session-source", {
        ...fixture.states.get("session-source")!,
        exclusiveOperationId: undefined,
        exclusiveOperationKind: undefined,
      });
      return true;
    },
    async getEnvironment() {
      return { id: "environment-test" } as Environment;
    },
    async createForkSessionMetadata() {
      fixture.states.set("session-child", storedRuntime("session-child", undefined));
      return "session-child";
    },
    async recordSessionAllocation() {},
    async markSessionProvisioned() {},
    async markSessionReady() {},
    async claimTurnCheckpoint(
      _sessionId: string,
      input: Record<string, unknown>,
    ) {
      checkpointInput = input;
      return { state: "claimed", id: "checkpoint-child", ordinal: 0 };
    },
    async completeTurnCheckpoint() {},
    async failTurnCheckpoint() {},
    async markSessionTurnCompleted() {},
  });
  Object.assign(fixture.runtime as object, {
    async forkSession(input: { source: StoredRuntime }) {
      assert.equal(input.source.nativeSessionId, "thread-source");
      return {
        sandboxId: "sandbox-child",
        workspaceVolumeId: "volume-child",
        supervisorSessionId: "supervisor-session-child",
        attemptId: "attempt-session-child",
        runtimeGeneration: 1,
        nativeCredentialTargetPath: "/dev/shm/auth.json",
        harnessStateLayout: "workspace_v2",
      };
    },
    async createVolumeCheckpoint() {
      return { snapshotId: "snapshot-child" };
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );

  try {
    assert.equal(
      await service.forkSession({
        userId: "user-test",
        sessionId: "session-source",
      }),
      "session-child",
    );
    assert.deepEqual(checkpointInput, {
      label: "fork-baseline",
      nativeSessionId: "thread-child",
      nativeHeadTurnId: "turn-source",
    });
    assert.equal(
      fixture.states.get("session-child")?.nativeSessionId,
      "thread-child",
    );
  } finally {
    await service.close();
  }
});

test("forks by native Turn id without copying a Sandpi transcript", async () => {
  const source = storedRuntime("session-source", "thread-source");
  const fixture = transportFixture({
    states: [source],
    onWrite(sessionId, message) {
      if (message.method === "initialize") return [rpcResult(message.id, {})];
      if (message.method === "thread/fork") {
        assert.equal(sessionId, "session-child");
        return [
          rpcResult(message.id, {
            thread: nativeThread("thread-child", [completedTurn("turn-selected")]),
          }),
        ];
      }
    },
  });
  let checkpointInput: Record<string, unknown> | undefined;
  Object.assign(fixture.store as object, {
    async getSession() {
      return {
        id: "session-source",
        status: "waiting",
        environmentId: "environment-test",
      };
    },
    async reserveTurnFork(
      _userId: string,
      _sessionId: string,
      nativeTurnId: string,
    ) {
      assert.equal(nativeTurnId, "turn-selected");
      return {
        operationId: "operation-source",
        selectedTurnId: nativeTurnId,
        selectedOrdinal: 1,
        selectedSnapshotId: "snapshot-selected",
      };
    },
    async getEnvironment() {
      return { id: "environment-test" } as Environment;
    },
    async createForkSessionMetadata() {
      fixture.states.set("session-child", storedRuntime("session-child", undefined));
      return "session-child";
    },
    async recordSessionAllocation() {},
    async markSessionProvisioned() {},
    async markSessionReady() {},
    async claimTurnCheckpoint(
      _sessionId: string,
      input: Record<string, unknown>,
    ) {
      checkpointInput = input;
      return { state: "claimed", id: "checkpoint-child", ordinal: 0 };
    },
    async completeTurnCheckpoint() {},
    async failTurnCheckpoint() {},
    async acquireSessionOperationLock() {
      return {
        signal: new AbortController().signal,
        async release() {},
      };
    },
    async clearAbandonedSessionOperation() {
      return false;
    },
    async releaseSessionOperation(_sessionId: string, operationId: string) {
      assert.equal(operationId, "operation-source");
      return true;
    },
    async markSessionTurnCompleted() {},
  });
  Object.assign(fixture.runtime as object, {
    async forkTurn(input: { workspaceSnapshotId: string }) {
      assert.equal(input.workspaceSnapshotId, "snapshot-selected");
      return {
        sandboxId: "sandbox-child",
        workspaceVolumeId: "volume-child",
        supervisorSessionId: "supervisor-session-child",
        attemptId: "attempt-session-child",
        runtimeGeneration: 1,
        nativeCredentialTargetPath: "/dev/shm/auth.json",
        harnessStateLayout: "workspace_v2",
      };
    },
    async createVolumeCheckpoint() {
      return { snapshotId: "snapshot-child" };
    },
  });
  const service = new CodexService(
    fixture.store,
    fixture.runtime,
    logger,
    credentials,
    { ingestIntervalMs: 1 },
  );

  try {
    assert.equal(
      await service.forkTurn({
        userId: "user-test",
        sessionId: "session-source",
        nativeTurnId: "turn-selected",
      }),
      "session-child",
    );
    assert.deepEqual(checkpointInput, {
      label: "turn-fork-baseline",
      nativeSessionId: "thread-child",
      nativeHeadTurnId: "turn-selected",
    });
    assert.equal(
      fixture.states.get("session-child")?.nativeSessionId,
      "thread-child",
    );
  } finally {
    await service.close();
  }
});

test("hard-TTL reaper deletes runtime resources before marking expiration", async () => {
  const operations: string[] = [];
  const runtimeRecord = storedRuntime();
  const store = {
    async interruptedTurnMutations() {
      return [];
    },
    async pendingTurnSubmissions() {
      return [];
    },
    async recoverStaleSessionOperations() {
      return [];
    },
    async expiredRuntimeSessions() {
      return [runtimeRecord];
    },
    async markSessionExpired(sessionId: string) {
      operations.push(`mark:${sessionId}`);
    },
    async failedRuntimeSessions() {
      return [];
    },
  } as unknown as SandpiStore;
  const runtime = {
    async deleteSessionResources() {
      operations.push("delete");
    },
  } as unknown as RuntimeAdapter;
  const service = new CodexService(store, runtime, logger, credentials);

  await service.reapExpiredSessions();
  assert.deepEqual(operations, ["delete", `mark:${runtimeRecord.id}`]);
});

test("failed provisioning cleanup fences allocation callbacks before deletion", async () => {
  const operations: string[] = [];
  const store = {
    async interruptedTurnMutations() {
      return [];
    },
    async pendingTurnSubmissions() {
      return [];
    },
    async recoverStaleSessionOperations() {
      return [];
    },
    async expiredRuntimeSessions() {
      return [];
    },
    async failedRuntimeSessions() {
      return [{ id: "session-failed", sandboxId: "sandbox-stale" }];
    },
    async acquireSessionOperationLock() {
      operations.push("lock");
      return {
        signal: new AbortController().signal,
        async release() {
          operations.push("unlock");
        },
      };
    },
    async claimFailedRuntimeSession() {
      operations.push("claim");
      return {
        id: "session-failed",
        sandboxId: "sandbox-late",
        workspaceVolumeId: "volume-late",
      };
    },
    async markFailedSessionResourcesCleaned() {
      operations.push("mark");
    },
  } as unknown as SandpiStore;
  const runtime = {
    async deleteSessionResources(resources: RuntimeSessionRecord) {
      assert.equal(resources.sandboxId, "sandbox-late");
      assert.equal(resources.workspaceVolumeId, "volume-late");
      operations.push("delete");
    },
  } as unknown as RuntimeAdapter;
  const service = new CodexService(store, runtime, logger, credentials);

  await service.reapExpiredSessions();

  assert.deepEqual(operations, ["lock", "claim", "delete", "mark", "unlock"]);
});

test("server worker resume does not wait for a slow Sandbox credential restore", async () => {
  let releaseInstall!: () => void;
  const installGate = new Promise<void>((resolve) => {
    releaseInstall = resolve;
  });
  let installStarted = false;
  const state = storedRuntime();
  const store = {
    async recoverStaleTurnCheckpointClaims() {},
    async recoverStaleSessionOperations() {
      return [];
    },
    async recoverWaitingSessionsAfterRestart() {},
    async activeRuntimeSessionIds() {
      return [state.id];
    },
    async decoderState() {
      return state;
    },
    async interruptedTurnMutations() {
      return [];
    },
    async pendingTurnSubmissions() {
      return [];
    },
    async expiredRuntimeSessions() {
      return [];
    },
    async failedRuntimeSessions() {
      return [];
    },
    async interruptedNativeStateMigrations() {
      return [];
    },
  } as unknown as SandpiStore;
  const runtime = {
    async readCodexSessionCredential() {
      return "{}";
    },
    async installCodexSessionCredential() {
      installStarted = true;
      await installGate;
    },
  } as unknown as RuntimeAdapter;
  const service = new CodexService(store, runtime, logger, credentials);

  await service.resumeWorkers();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(installStarted, true);

  const closing = service.close();
  releaseInstall();
  await closing;
});
