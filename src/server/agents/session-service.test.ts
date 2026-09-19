import assert from "node:assert/strict";
import test from "node:test";
import { NativeAgentSessionService } from "./session-service";
import type { SandpiStore } from "@/server/store";
import type { RuntimeAdapter } from "@/server/runtime/types";

const id = "12345678-1234-4234-8234-123456789abc";
const requestId = "aaaaaaaa-1234-4234-8234-123456789abc";
function fixture(state = "running") {
  const calls: string[] = [];
  let launchId = "";
  let sessions = [
    { id, title: "Test", updatedAt: 1, resumePath: "/workspace/history.jsonl" },
  ];
  const index = () => ({
    sessions,
    partial: false,
    syncedAt: 1,
    launchId,
    openedSessionId: null,
  });
  const store = {
    async getEnvironment() {
      calls.push("authorize");
      return { status: "ready", codingAgent: { harness: "codex" } };
    },
    async getEnvironmentRuntime() {
      return { sandboxId: "sandbox", agentLaunchId: launchId };
    },
    async getNativeSessionIndex() {
      return index();
    },
    async withEnvironmentLifecycleLock(
      _id: string,
      fn: (s: unknown) => Promise<unknown>,
    ) {
      calls.push("lock");
      return { acquired: true, value: await fn(store) };
    },
    async saveNativeSessionIndex() {
      calls.push("save");
    },
    async selectNativeSession(_id: string, _expected: string, next: string) {
      calls.push("select");
      launchId = next;
    },
  };
  const runtime = {
    async getEnvironmentSandboxState() {
      return state;
    },
    async discoverNativeSessions() {
      calls.push("scan");
      return { sessions, partial: false };
    },
    async stopAgentTerminal() {
      calls.push("stop");
    },
  };
  return {
    service: new NativeAgentSessionService(
      store as unknown as SandpiStore,
      runtime as unknown as RuntimeAdapter,
    ),
    calls,
    removeHistory() {
      sessions = [];
    },
    setLaunch(value: string) {
      launchId = value;
    },
  };
}
const input = {
  sessionId: id,
  expectedLaunchId: "",
  requestId,
  confirmReplace: true as const,
};
test("paused history refresh never touches guest files or wakes runtime", async () => {
  const f = fixture("paused");
  await f.service.refresh("user", "env");
  assert.ok(!f.calls.includes("scan"));
});
test("missing native history leaves current Agent untouched", async () => {
  const f = fixture();
  f.removeHistory();
  await assert.rejects(
    f.service.open("user", "env", input),
    /no longer available/,
  );
  assert.ok(!f.calls.includes("stop"));
});
test("switch verifies history, stops old process, then publishes; retry is idempotent", async () => {
  const f = fixture();
  await f.service.open("user", "env", input);
  await f.service.open("user", "env", input);
  assert.deepEqual(
    f.calls.filter((c) => ["scan", "stop", "select"].includes(c)),
    ["scan", "stop", "select"],
  );
});
test("stale device selection cannot stop a newer Agent", async () => {
  const f = fixture();
  f.setLaunch("another");
  await assert.rejects(f.service.open("user", "env", input), /Another device/);
  assert.ok(!f.calls.includes("stop"));
});
test("paused selection does not silently wake or stop the Agent", async () => {
  const f = fixture("paused");
  await assert.rejects(
    f.service.open("user", "env", input),
    /Open the Environment/,
  );
  assert.ok(!f.calls.includes("scan"));
  assert.ok(!f.calls.includes("stop"));
});
