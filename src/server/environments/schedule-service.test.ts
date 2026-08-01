import assert from "node:assert/strict";
import test from "node:test";

import type { Environment, CodingSession } from "@/lib/types";
import type { SandpiStore } from "@/server/store";
import { EnvironmentScheduleService } from "./schedule-service";
import type {
  ClaimedEnvironmentScheduleRun,
  EnvironmentScheduleStore,
  StoredEnvironmentSchedule,
  StoredEnvironmentScheduleRun,
} from "./schedule-store";

const environment: Environment = {
  id: "environment-one",
  ownerId: "user-one",
  idlePauseTimeoutSeconds: 1_800,
  sandboxMemoryMiB: 2_048,
  workspaceBackup: { intervalSeconds: 0, retentionCount: 7 },
  name: "Automation",
  description: "",
  color: "#151515",
  status: "ready",
  revision: 1,
  templateId: "coding-agent",
  rootfsSnapshotId: "rootfs-one",
  workspaceVolumeId: "volume-one",
  sandboxId: "sandbox-one",
  sandboxState: "running",
  supervisorSessionId: "supervisor-one",
  workspaceRoot: "/workspace",
  credentialRevision: 1,
  codingAgent: {
    harness: "codex",
    label: "Codex",
    status: "connected",
  },
  networkPolicy: { mode: "allow-all", domainExceptions: [] },
};

const session: CodingSession = {
  id: "session-one",
  environmentId: environment.id,
  owner: {
    id: "user-one",
    name: "Admin",
    email: "admin@example.com",
    avatarInitials: "AD",
  },
  title: "Daily work",
  status: "waiting",
  unread: false,
  pinned: false,
  completed: false,
  archived: false,
  harness: "codex",
  harnessLabel: "Codex",
  harnessState: {},
  createdAt: Date.now(),
  updatedAt: Date.now(),
  environmentRevision: 1,
  origin: { kind: "environment", label: environment.name },
};

function storedSchedule(
  overrides: Partial<StoredEnvironmentSchedule> = {},
): StoredEnvironmentSchedule {
  const createdAt = new Date("2026-07-27T09:00:00.000Z");
  return {
    id: "schedule-one",
    environmentId: environment.id,
    createdByUserId: "user-one",
    name: "Review repository",
    prompt: "Inspect the repository and report unfinished work.",
    timing: {
      kind: "cron",
      expression: "*/5 * * * *",
      timeZone: "UTC",
    },
    target: { kind: "session", sessionId: session.id },
    overlapPolicy: "skip",
    enabled: true,
    nextRunAt: new Date("2026-07-27T10:05:00.000Z"),
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function storedRun(
  overrides: Partial<StoredEnvironmentScheduleRun> = {},
): StoredEnvironmentScheduleRun {
  const createdAt = new Date("2026-07-27T09:55:00.000Z");
  return {
    id: "schedule_run_active",
    scheduleId: "schedule-one",
    scheduleRevision: 1,
    scheduledFor: createdAt,
    status: "running",
    prompt: "Long running task",
    target: { kind: "session", sessionId: session.id },
    sessionId: session.id,
    submission: {
      requestId: "schedule-turn:schedule_run_active",
      clientMessageId: "sandpi-schedule:schedule_run_active",
      stableInputId: "schedule-turn-input:schedule_run_active",
    },
    dispatchAttemptCount: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

class FakeScheduleStore {
  due: StoredEnvironmentSchedule[] = [];
  runs = new Map<string, StoredEnvironmentScheduleRun>();
  claimedOccurrences: Array<{
    scheduledFor: Date;
    nextRunAt?: Date;
    kind: "claimed" | "skipped";
  }> = [];

  async dueSchedules() {
    return [...this.due];
  }

  async activeRunIds(now: Date) {
    return [...this.runs.values()]
      .filter(
        (run) =>
          ["claimed", "running"].includes(run.status) &&
          (!run.leaseExpiresAt ||
            run.leaseExpiresAt.getTime() <= now.getTime()),
      )
      .map((run) => run.id);
  }

  async claimRunLease(
    runId: string,
    leaseToken: string,
    leaseExpiresAt: Date,
    now: Date,
  ): Promise<ClaimedEnvironmentScheduleRun | undefined> {
    const run = this.runs.get(runId);
    if (
      !run ||
      !["claimed", "running"].includes(run.status) ||
      (run.leaseExpiresAt && run.leaseExpiresAt.getTime() > now.getTime())
    ) {
      return undefined;
    }
    const claimed = {
      ...run,
      leaseToken,
      leaseExpiresAt,
      dispatchAttemptCount: run.dispatchAttemptCount + 1,
    };
    this.runs.set(runId, claimed);
    return {
      schedule: storedSchedule(),
      run: claimed,
    };
  }

  async claimOccurrence(
    input: Parameters<EnvironmentScheduleStore["claimOccurrence"]>[0],
  ): ReturnType<EnvironmentScheduleStore["claimOccurrence"]> {
    this.due = this.due.filter(
      (schedule) => schedule.id !== input.schedule.id,
    );
    const active = [...this.runs.values()].some(
      (run) =>
        run.scheduleId === input.schedule.id &&
        ["claimed", "running"].includes(run.status),
    );
    const now = new Date("2026-07-27T10:00:00.000Z");
    const run: StoredEnvironmentScheduleRun = {
      id: input.runId,
      scheduleId: input.schedule.id,
      scheduleRevision: input.schedule.revision,
      scheduledFor: input.scheduledFor,
      status: active ? "skipped" : "claimed",
      prompt: input.schedule.prompt,
      target: input.schedule.target,
      sessionId:
        input.schedule.target.kind === "session"
          ? input.schedule.target.sessionId
          : input.sessionId,
      submission: input.submission,
      ...(active
        ? {
            error: "The previous Schedule run is still active.",
            finishedAt: now,
          }
        : {
            leaseToken: input.leaseToken,
            leaseExpiresAt: input.leaseExpiresAt,
          }),
      dispatchAttemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    this.claimedOccurrences.push({
      scheduledFor: input.scheduledFor,
      ...(input.nextRunAt ? { nextRunAt: input.nextRunAt } : {}),
      kind: active ? "skipped" : "claimed",
    });
    return active
      ? Promise.resolve({ kind: "skipped", run })
      : Promise.resolve({ kind: "claimed", run });
  }

  async markRunRunning(
    input: Parameters<EnvironmentScheduleStore["markRunRunning"]>[0],
  ) {
    const run = this.runs.get(input.runId);
    if (!run || run.leaseToken !== input.leaseToken) return false;
    this.runs.set(run.id, {
      ...run,
      status: "running",
      nativeTurnId: input.nativeTurnId,
      leaseToken: undefined,
      leaseExpiresAt: input.retryAt,
      startedAt: run.startedAt ?? new Date(),
    });
    return true;
  }

  async deferRun(
    input: Parameters<EnvironmentScheduleStore["deferRun"]>[0],
  ) {
    const run = this.runs.get(input.runId);
    if (!run || run.leaseToken !== input.leaseToken) return false;
    this.runs.set(run.id, {
      ...run,
      leaseToken: undefined,
      leaseExpiresAt: input.retryAt,
      error: input.error,
    });
    return true;
  }

  async finishRun(
    input: Parameters<EnvironmentScheduleStore["finishRun"]>[0],
  ) {
    const run = this.runs.get(input.runId);
    if (!run || run.leaseToken !== input.leaseToken) return false;
    this.runs.set(run.id, {
      ...run,
      status: input.status,
      nativeTurnId: input.nativeTurnId ?? run.nativeTurnId,
      error: input.error,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      finishedAt: new Date(),
    });
    return true;
  }
}

function productStore() {
  return {
    async getEnvironment(userId: string, environmentId: string) {
      assert.equal(userId, "user-one");
      assert.equal(environmentId, environment.id);
      return environment;
    },
    async getSession(userId: string, sessionId: string) {
      assert.equal(userId, "user-one");
      assert.equal(sessionId, session.id);
      return session;
    },
  } as unknown as SandpiStore;
}

function logger() {
  return {
    info() {},
    warn() {},
  };
}

test("coalesces a recurring backlog after server downtime", async () => {
  const schedules = new FakeScheduleStore();
  schedules.due.push(storedSchedule());
  const starts: unknown[] = [];
  const service = new EnvironmentScheduleService(
    schedules as unknown as EnvironmentScheduleStore,
    productStore(),
    {
      async ensureAutomationSession() {
        throw new Error("not used");
      },
      async readAutomationTurnStatus() {
        return { status: "absent" as const };
      },
      async startTurn(input) {
        starts.push(input);
        return {
          requestId: input.durableSubmission!.requestId,
          clientMessageId: input.durableSubmission!.clientMessageId,
          nativeTurnId: "turn-one",
        };
      },
    },
    logger(),
    { now: () => new Date("2026-07-27T10:23:12.000Z") },
  );

  await service.reconcileOnce();

  assert.equal(schedules.claimedOccurrences.length, 1);
  assert.equal(
    schedules.claimedOccurrences[0]?.scheduledFor.toISOString(),
    "2026-07-27T10:20:00.000Z",
  );
  assert.equal(
    schedules.claimedOccurrences[0]?.nextRunAt?.toISOString(),
    "2026-07-27T10:25:00.000Z",
  );
  assert.equal(starts.length, 1);
});

test("skips a due interval while the previous Schedule Turn is still running", async () => {
  const schedules = new FakeScheduleStore();
  schedules.runs.set(
    "schedule_run_active",
    storedRun({ leaseExpiresAt: new Date("2026-07-27T09:59:00.000Z") }),
  );
  schedules.due.push(
    storedSchedule({
      nextRunAt: new Date("2026-07-27T10:00:00.000Z"),
    }),
  );
  let starts = 0;
  const service = new EnvironmentScheduleService(
    schedules as unknown as EnvironmentScheduleStore,
    productStore(),
    {
      async ensureAutomationSession() {
        throw new Error("not used");
      },
      async readAutomationTurnStatus() {
        return {
          status: "running" as const,
          nativeTurnId: "turn-active",
        };
      },
      async startTurn() {
        starts += 1;
        throw new Error("must not submit an overlapping Turn");
      },
    },
    logger(),
    { now: () => new Date("2026-07-27T10:00:00.000Z") },
  );

  await service.reconcileOnce();

  assert.equal(starts, 0);
  assert.equal(schedules.claimedOccurrences[0]?.kind, "skipped");
  const skipped = [...schedules.runs.values()].find(
    (run) => run.status === "skipped",
  );
  assert.equal(
    skipped?.error,
    "The previous Schedule run is still active.",
  );
});

test("a restarted server reconciles an ambiguous accepted Turn without replay", async () => {
  let now = new Date("2026-07-27T10:00:00.000Z");
  const schedules = new FakeScheduleStore();
  schedules.due.push(
    storedSchedule({
      timing: { kind: "once", runAt: now },
      nextRunAt: now,
    }),
  );
  let starts = 0;
  let nativeAccepted = false;
  const codex = {
    async ensureAutomationSession() {
      throw new Error("not used");
    },
    async readAutomationTurnStatus() {
      return nativeAccepted
        ? {
            status: "succeeded" as const,
            nativeTurnId: "turn-accepted-before-crash",
          }
        : { status: "absent" as const };
    },
    async startTurn(input: {
      durableSubmission?: { requestId: string; clientMessageId: string };
    }) {
      starts += 1;
      nativeAccepted = true;
      return {
        requestId: input.durableSubmission!.requestId,
        clientMessageId: input.durableSubmission!.clientMessageId,
      };
    },
  };
  const firstServer = new EnvironmentScheduleService(
    schedules as unknown as EnvironmentScheduleStore,
    productStore(),
    codex,
    logger(),
    { now: () => now, runningRecheckMs: 1_000 },
  );
  await firstServer.reconcileOnce();
  assert.equal(starts, 1);
  const active = [...schedules.runs.values()].find(
    (run) => run.status === "claimed",
  );
  assert.ok(active);

  now = new Date("2026-07-27T10:00:02.000Z");
  const restartedServer = new EnvironmentScheduleService(
    schedules as unknown as EnvironmentScheduleStore,
    productStore(),
    codex,
    logger(),
    { now: () => now, runningRecheckMs: 1_000 },
  );
  await restartedServer.reconcileOnce();

  assert.equal(starts, 1);
  assert.equal(schedules.runs.get(active.id)?.status, "succeeded");
  assert.equal(
    schedules.runs.get(active.id)?.nativeTurnId,
    "turn-accepted-before-crash",
  );
});

test("reserves a new deterministic Session for a new-Session run", async () => {
  const now = new Date("2026-07-27T10:00:00.000Z");
  const schedules = new FakeScheduleStore();
  schedules.due.push(
    storedSchedule({
      timing: { kind: "once", runAt: now },
      target: { kind: "newSession" },
      nextRunAt: now,
    }),
  );
  const ensured: Array<{ sessionId: string; automationRunId: string }> = [];
  const service = new EnvironmentScheduleService(
    schedules as unknown as EnvironmentScheduleStore,
    productStore(),
    {
      async ensureAutomationSession(input) {
        ensured.push({
          sessionId: input.sessionId,
          automationRunId: input.automationRunId,
        });
        return input.sessionId;
      },
      async readAutomationTurnStatus() {
        return { status: "absent" as const };
      },
      async startTurn(input) {
        return {
          requestId: input.durableSubmission!.requestId,
          clientMessageId: input.durableSubmission!.clientMessageId,
          nativeTurnId: "turn-new-session",
        };
      },
    },
    logger(),
    { now: () => now },
  );

  await service.reconcileOnce();

  assert.equal(ensured.length, 1);
  assert.match(ensured[0]!.sessionId, /^session_/);
  assert.match(ensured[0]!.automationRunId, /^schedule_run_/);
  const run = [...schedules.runs.values()][0]!;
  assert.equal(run.sessionId, ensured[0]!.sessionId);
  assert.equal(
    run.submission.clientMessageId,
    `sandpi-schedule:${run.id}`,
  );
});
