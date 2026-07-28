import assert from "node:assert/strict";
import test from "node:test";

import {
  canInterruptCodexSession,
  codexComposerSubmissionTarget,
  codexTurnCapabilitySets,
  shouldRefreshSettledCodexProjection,
} from "./capabilities";
import type { CodexNativeSnapshot } from "./types";

const snapshot = {
  forkableTurnIds: ["turn-one", "turn-two"],
} as CodexNativeSnapshot;

test("projects Codex Turn fork capabilities", () => {
  const capabilities = codexTurnCapabilitySets(snapshot);

  assert.equal(capabilities.forkableTurnIds.has("turn-one"), true);
  assert.equal(capabilities.forkableTurnIds.has("turn-two"), true);
});

test("starts with no fork capability before the native snapshot", () => {
  const capabilities = codexTurnCapabilitySets(null);
  assert.equal(capabilities.forkableTurnIds.size, 0);
});

test("starts a new Turn only from a ready waiting Session", () => {
  assert.deepEqual(
    codexComposerSubmissionTarget({
      nativeReady: true,
      turnRunning: false,
      sessionStatus: "waiting",
    }),
    { kind: "start" },
  );
  assert.equal(
    codexComposerSubmissionTarget({
      nativeReady: false,
      turnRunning: false,
      sessionStatus: "waiting",
    }),
    undefined,
  );
  assert.equal(
    codexComposerSubmissionTarget({
      nativeReady: true,
      turnRunning: false,
      sessionStatus: "failed",
    }),
    undefined,
  );
});

test("steers a running Turn only with its native active id", () => {
  assert.deepEqual(
    codexComposerSubmissionTarget({
      nativeReady: true,
      turnRunning: true,
      activeTurnId: "turn-active",
      sessionStatus: "running",
    }),
    { kind: "steer", turnId: "turn-active" },
  );
  assert.equal(
    codexComposerSubmissionTarget({
      nativeReady: true,
      turnRunning: true,
      sessionStatus: "running",
    }),
    undefined,
  );
  assert.equal(
    codexComposerSubmissionTarget({
      nativeReady: false,
      turnRunning: true,
      activeTurnId: "turn-active",
      sessionStatus: "running",
    }),
    undefined,
  );
});

test("keeps server-running Sessions interruptible before a native snapshot arrives", () => {
  assert.equal(
    canInterruptCodexSession({
      nativeActiveTurnId: "turn-active",
      sessionRunning: true,
      localTurnPending: true,
    }),
    true,
  );
  assert.equal(
    canInterruptCodexSession({
      sessionRunning: true,
      localTurnPending: false,
    }),
    true,
  );
  assert.equal(
    canInterruptCodexSession({
      sessionRunning: true,
      localTurnPending: true,
    }),
    false,
  );
  assert.equal(
    canInterruptCodexSession({
      sessionRunning: false,
      localTurnPending: false,
    }),
    false,
  );
  assert.equal(
    canInterruptCodexSession({
      nativeActiveTurnId: "turn-stale",
      sessionRunning: false,
      localTurnPending: false,
    }),
    false,
  );
});

test("refreshes a stale active projection after the Session settles", () => {
  assert.equal(
    shouldRefreshSettledCodexProjection({
      nativeActiveTurnId: "turn-stale",
      sessionRunning: false,
      localTurnPending: false,
    }),
    true,
  );
  assert.equal(
    shouldRefreshSettledCodexProjection({
      nativeActiveTurnId: "turn-active",
      sessionRunning: true,
      localTurnPending: false,
    }),
    false,
  );
  assert.equal(
    shouldRefreshSettledCodexProjection({
      nativeActiveTurnId: "turn-pending",
      sessionRunning: false,
      localTurnPending: true,
    }),
    false,
  );
  assert.equal(
    shouldRefreshSettledCodexProjection({
      sessionRunning: false,
      localTurnPending: false,
    }),
    false,
  );
});
