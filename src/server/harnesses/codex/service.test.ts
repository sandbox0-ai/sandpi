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
    allowedDomains: [],
    logDeniedRequests: false,
  },
  functions: [],
};

function session(
  id: string,
  nativeSessionId: string,
  status: CodingSession["status"] = "waiting",
): CodingSession {
  return {
    id,
    environmentId: environment.id,
    title: id,
    status,
    unread: false,
    pinned: false,
    archived: false,
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

interface Fixture {
  service: CodexService;
  sessions: Map<string, CodingSession>;
  sessionRuntimes: Map<string, StoredSessionRuntime>;
  writes: Array<{
    environmentId: string;
    message: Record<string, unknown>;
  }>;
  lifecycleLocks: string[];
  streamStarts: number[];
  rolloutReads: Array<{
    path: string;
    nativeSessionId: string;
  }>;
  enqueue(messages: Record<string, unknown>[]): void;
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

function fixture(input: {
  sessions?: Array<{ id: string; nativeSessionId: string }>;
  streamErrors?: Error[];
  onRequest?: (
    message: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
  rollouts?: Record<string, string | Error | Promise<string>>;
} = {}): Fixture {
  const initial = input.sessions ?? [
    { id: "session-one", nativeSessionId: "thread-one" },
    { id: "session-two", nativeSessionId: "thread-two" },
  ];
  const sessions = new Map(
    initial.map(({ id, nativeSessionId }) => [id, session(id, nativeSessionId)]),
  );
  const sessionRuntimes = new Map(
    initial.map(({ id, nativeSessionId }) => [
      id,
      sessionRuntime(id, nativeSessionId),
    ]),
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
  const rolloutReads: Fixture["rolloutReads"] = [];
  let childSequence = 0;
  let lastStartedThreadId: string | undefined;
  let lastStartedTurnId: string | undefined;

  const enqueue = (messages: Record<string, unknown>[]) => {
    const seq = events.length + 1;
    events.push({
      seq,
      runtimeGeneration: 1,
      attemptId: "attempt-environment-test",
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
      const params = message.params as { threadId: string };
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
            status: { type: "idle" },
            turns,
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
    async activeEnvironmentRuntimeIds() {
      return [environment.id];
    },
    async environmentWantsRunning() {
      return environmentRuntime.desiredState === "running";
    },
    async withEnvironmentLifecycleLock(
      environmentId: string,
      operation: () => Promise<unknown>,
    ) {
      lifecycleLocks.push(environmentId);
      return { acquired: true, value: await operation() };
    },
    async sessionRuntimesForEnvironment() {
      return [...sessionRuntimes.values()].filter(
        (candidate) => candidate.nativeSessionId,
      );
    },
    async recordCodexEnvironmentRuntime() {
      return environmentRuntime;
    },
    async commitEnvironmentTransport(
      environmentId: string,
      supervisorSessionId: string,
      before: StoredEnvironmentRuntime["decoder"],
      after: StoredEnvironmentRuntime["decoder"],
      transitions: CodexControlTransition[],
    ) {
      assert.equal(environmentId, environment.id);
      assert.equal(supervisorSessionId, environment.supervisorSessionId);
      if (
        environmentRuntime.decoder.supervisorCursor !==
          before.supervisorCursor ||
        environmentRuntime.decoder.tailBase64 !== before.tailBase64
      ) {
        return false;
      }
      environmentRuntime = {
        ...environmentRuntime,
        decoder: after,
        attemptId: after.attemptId,
        runtimeGeneration: after.runtimeGeneration,
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
    async createForkSessionMetadata(options: {
      source: CodingSession;
      title?: string;
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
      sessionRuntimes.set(id, sessionRuntime(id, undefined));
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
      activeNativeTurnId?: string;
    }) {
      const current = sessionRuntimes.get(options.sessionId)!;
      if (
        current.nativeSessionId !== options.nativeSessionId ||
        current.historyRevision !== options.historyRevision
      ) {
        return false;
      }
      sessionRuntimes.set(options.sessionId, {
        ...current,
        activeNativeTurnId: options.activeNativeTurnId,
        sessionStatus: options.activeNativeTurnId ? "running" : "waiting",
      });
      sessions.set(options.sessionId, {
        ...sessions.get(options.sessionId)!,
        status: options.activeNativeTurnId ? "running" : "waiting",
      });
      return true;
    },
  } as unknown as SandpiStore;

  const runtime = {
    mode: "sandbox0",
    async ensureCodexEnvironmentRuntime() {
      return {
        supervisorSessionId: environment.supervisorSessionId,
        attemptId: "attempt-environment-test",
        runtimeGeneration: 1,
        sandboxRestarted: false,
      };
    },
    async readCodexEnvironmentCredential() {
      return "{}";
    },
    async installCodexEnvironmentCredential() {},
    async writeCodexMessage(
      runtime: StoredEnvironmentRuntime,
      value: unknown,
    ) {
      const message = value as Record<string, unknown>;
      writes.push({ environmentId: runtime.id, message });
      const response = input.onRequest?.(message) ?? defaultResponse(message);
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
    credentials,
    { streamReconnectDelayMs: 5, streamBatchDelayMs: 1 },
  );
  return {
    service,
    sessions,
    sessionRuntimes,
    writes,
    lifecycleLocks,
    streamStarts,
    rolloutReads,
    enqueue,
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

test("reattaches every native Session when the Environment runtime recovers", async () => {
  const context = fixture();
  try {
    await context.service.resumeWorkers();

    assert.deepEqual(context.lifecycleLocks, [environment.id]);

    const methods = context.writes.map((write) => write.message.method);
    assert.equal(methods.filter((method) => method === "initialize").length, 1);
    assert.equal(methods.filter((method) => method === "thread/resume").length, 2);
    assert.deepEqual(
      context.writes
        .filter((write) => write.message.method === "thread/resume")
        .map(
          (write) =>
            (write.message.params as { threadId: string }).threadId,
        )
        .sort(),
      ["thread-one", "thread-two"],
    );
    assert.ok(
      [...context.sessionRuntimes.values()].every(
        (runtime) => runtime.sessionStatus === "waiting",
      ),
    );
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

test("creates an Environment MCP server and reloads every native Thread", async () => {
  let configured = false;
  const definition = {
    url: "https://docs.example.test/mcp",
    enabled: true,
    required: false,
    default_tools_approval_mode: "prompt",
  };
  const context = fixture({
    onRequest(message) {
      if (message.method === "config/read") {
        const mcpServers = configured ? { docs: definition } : {};
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
        configured = true;
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
            data: configured
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
  } finally {
    await context.close();
  }
});
