import assert from "node:assert/strict";
import test from "node:test";

import type { Environment } from "@/lib/types";
import { HttpError } from "@/server/http-error";
import type { SandpiStore } from "@/server/store";
import {
  EnvironmentAutomationExecutor,
  type ClaimedEnvironmentAutomationRun,
  type EnvironmentAutomationPersistence,
} from "./executor";

const run: ClaimedEnvironmentAutomationRun = {
  id: "webhook-run-one",
  status: "claimed",
  prompt: "Handle the delivery",
  target: { kind: "session", sessionId: "session-one" },
  sessionId: "session-one",
  submission: {
    requestId: "request-one",
    clientMessageId: "message-one",
    stableInputId: "input-one",
  },
  leaseToken: "lease-one",
  dispatchAttemptCount: 1,
};

test("queues a Webhook run while its fixed target Session is busy", async () => {
  const calls = await executeBusyTarget("queue");
  assert.equal(calls.finished.length, 0);
  assert.equal(calls.deferred.length, 1);
  assert.match(calls.deferred[0]?.error ?? "", /active Turn/);
});

test("keeps the Schedule overlap contract as skip", async () => {
  const calls = await executeBusyTarget("skip");
  assert.equal(calls.deferred.length, 0);
  assert.deepEqual(calls.finished, [
    {
      runId: run.id,
      leaseToken: run.leaseToken,
      status: "skipped",
      error: "The target Session already has a Turn in progress.",
    },
  ]);
});

async function executeBusyTarget(overlapPolicy: "queue" | "skip") {
  const deferred: Array<
    Parameters<EnvironmentAutomationPersistence["defer"]>[0]
  > = [];
  const finished: Array<
    Parameters<EnvironmentAutomationPersistence["finish"]>[0]
  > = [];
  const executor = new EnvironmentAutomationExecutor(
    {
      async getEnvironment() {
        return { id: "environment-one" } as Environment;
      },
      async getSession() {
        return { environmentId: "environment-one", archived: false };
      },
    } as unknown as SandpiStore,
    {
      async ensureAutomationSession(input) {
        return input.sessionId;
      },
      async readAutomationTurnStatus() {
        return { status: "absent" as const };
      },
      async startTurn() {
        throw new HttpError(
          409,
          "session_turn_in_progress",
          "The target Session is busy.",
        );
      },
    },
    { warn() {} },
    { now: () => new Date("2026-08-01T00:00:00.000Z") },
  );

  await executor.execute({
    definition: {
      id: "automation-one",
      sourceKind: overlapPolicy === "queue" ? "webhook" : "schedule",
      environmentId: "environment-one",
      createdByUserId: "user-one",
      name: "Automation one",
      overlapPolicy,
    },
    run,
    persistence: {
      async markRunning() {
        throw new Error("The busy target must not become running.");
      },
      async defer(input) {
        deferred.push(input);
        return true;
      },
      async finish(input) {
        finished.push(input);
        return true;
      },
    },
  });
  return { deferred, finished };
}
