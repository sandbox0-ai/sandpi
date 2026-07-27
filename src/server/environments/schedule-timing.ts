import { CronExpressionParser } from "cron-parser";

import { HttpError } from "@/server/http-error";

export type EnvironmentScheduleTiming =
  | {
      kind: "once";
      runAt: Date;
    }
  | {
      kind: "cron";
      expression: string;
      timeZone: string;
    };

export interface DueScheduleOccurrence {
  scheduledFor: Date;
  nextRunAt?: Date;
}

const MAX_CRON_EXPRESSION_LENGTH = 200;

export function normalizeEnvironmentScheduleTiming(
  timing: EnvironmentScheduleTiming,
  now = new Date(),
): EnvironmentScheduleTiming {
  if (timing.kind === "once") {
    if (
      !Number.isFinite(timing.runAt.getTime()) ||
      timing.runAt.getTime() <= now.getTime()
    ) {
      throw new HttpError(
        400,
        "environment_schedule_time_invalid",
        "A one-time Schedule must run in the future.",
      );
    }
    return { kind: "once", runAt: new Date(timing.runAt) };
  }

  const expression = timing.expression.trim().replace(/\s+/g, " ");
  if (
    expression.length === 0 ||
    expression.length > MAX_CRON_EXPRESSION_LENGTH ||
    expression.split(" ").length !== 5 ||
    expression.startsWith("@") ||
    expression.includes("H")
  ) {
    throw invalidCron();
  }
  const timeZone = timing.timeZone.trim();
  requireTimeZone(timeZone);
  try {
    CronExpressionParser.parse(expression, {
      currentDate: now,
      tz: timeZone,
    }).next();
  } catch {
    throw invalidCron();
  }
  return {
    kind: "cron",
    expression,
    timeZone,
  };
}

export function firstEnvironmentScheduleRunAt(
  timing: EnvironmentScheduleTiming,
  now = new Date(),
) {
  if (timing.kind === "once") return new Date(timing.runAt);
  return nextCronOccurrence(timing, now);
}

/**
 * Coalesces a recurring Schedule backlog into its latest missed occurrence.
 * This prevents a Sandpi outage from producing an unbounded replay storm.
 */
export function dueEnvironmentScheduleOccurrence(
  timing: EnvironmentScheduleTiming,
  persistedDueAt: Date,
  now = new Date(),
): DueScheduleOccurrence {
  if (persistedDueAt.getTime() > now.getTime()) {
    throw new Error("The Environment Schedule is not due.");
  }
  if (timing.kind === "once") {
    return { scheduledFor: new Date(persistedDueAt) };
  }

  const latest = CronExpressionParser.parse(timing.expression, {
    currentDate: new Date(now.getTime() + 1),
    tz: timing.timeZone,
  })
    .prev()
    .toDate();
  return {
    scheduledFor:
      latest.getTime() >= persistedDueAt.getTime()
        ? latest
        : new Date(persistedDueAt),
    nextRunAt: nextCronOccurrence(timing, now),
  };
}

function nextCronOccurrence(
  timing: Extract<EnvironmentScheduleTiming, { kind: "cron" }>,
  after: Date,
) {
  return CronExpressionParser.parse(timing.expression, {
    currentDate: after,
    tz: timing.timeZone,
  })
    .next()
    .toDate();
}

function requireTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
  } catch {
    throw new HttpError(
      400,
      "environment_schedule_timezone_invalid",
      "The Schedule time zone is invalid.",
    );
  }
}

function invalidCron() {
  return new HttpError(
    400,
    "environment_schedule_cron_invalid",
    "Use a deterministic five-field cron expression.",
  );
}
