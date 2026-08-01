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

test("uses one stable Automation Session owner for a source thread", async () => {
  const ensured: Array<{
    automationRunId: string;
    automationSessionKey?: string;
    sessionId: string;
  }> = [];
  const executor = new EnvironmentAutomationExecutor(
    {
      async getEnvironment() {
        return { id: "environment-one" } as Environment;
      },
    } as unknown as SandpiStore,
    {
      async ensureAutomationSession(input) {
        ensured.push(input);
        return input.sessionId;
      },
      async readAutomationTurnStatus() {
        return { status: "succeeded" as const, nativeTurnId: "turn-one" };
      },
      async startTurn() {
        throw new Error("An already completed source-thread run must not restart.");
      },
    },
    { warn() {} },
  );
  const definition = {
    id: "webhook-one",
    sourceKind: "webhook" as const,
    environmentId: "environment-one",
    createdByUserId: "user-one",
    name: "GitHub thread",
    overlapPolicy: "queue" as const,
  };
  for (const suffix of ["one", "two"]) {
    await executor.execute({
      definition,
      run: {
        id: `webhook-run-${suffix}`,
        status: "claimed",
        prompt: "Handle the GitHub event",
        target: { kind: "sourceThread" },
        sessionId: "session-source-thread",
        submission: {
          requestId: `request-${suffix}`,
          clientMessageId: `message-${suffix}`,
          stableInputId: `input-${suffix}`,
        },
        leaseToken: `lease-${suffix}`,
        dispatchAttemptCount: 1,
      },
      persistence: {
        async markRunning() {
          throw new Error("The completed run must not become running.");
        },
        async defer() {
          throw new Error("The completed run must not be deferred.");
        },
        async finish() {
          return true;
        },
      },
    });
  }

  assert.deepEqual(
    ensured.map(({ automationRunId }) => automationRunId),
    ["webhook-run-one", "webhook-run-two"],
  );
  assert.deepEqual(
    new Set(ensured.map(({ automationSessionKey }) => automationSessionKey)),
    new Set(["webhook:webhook-one:source-thread:session-source-thread"]),
  );
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
