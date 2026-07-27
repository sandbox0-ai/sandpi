import { CronExpressionParser } from "cron-parser";

export type SimpleScheduleFrequency =
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly";

export type ScheduleWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type ScheduleMonthDay = number | "last";

export interface SimpleScheduleRecurrence {
  frequency: SimpleScheduleFrequency;
  time: string;
  minute: number;
  weekdays: ScheduleWeekday[];
  monthDay: ScheduleMonthDay;
}

export const SCHEDULE_WEEKDAYS: ReadonlyArray<{
  value: ScheduleWeekday;
  shortLabel: string;
  longLabel: string;
}> = [
  { value: 1, shortLabel: "Mon", longLabel: "Monday" },
  { value: 2, shortLabel: "Tue", longLabel: "Tuesday" },
  { value: 3, shortLabel: "Wed", longLabel: "Wednesday" },
  { value: 4, shortLabel: "Thu", longLabel: "Thursday" },
  { value: 5, shortLabel: "Fri", longLabel: "Friday" },
  { value: 6, shortLabel: "Sat", longLabel: "Saturday" },
  { value: 0, shortLabel: "Sun", longLabel: "Sunday" },
];

const MAX_CRON_EXPRESSION_LENGTH = 200;

export function defaultSimpleScheduleRecurrence(): SimpleScheduleRecurrence {
  return {
    frequency: "weekdays",
    time: "09:00",
    minute: 0,
    weekdays: [1, 2, 3, 4, 5],
    monthDay: 1,
  };
}

export function compileSimpleScheduleRecurrence(
  recurrence: SimpleScheduleRecurrence,
) {
  if (recurrence.frequency === "hourly") {
    const minute = requireInteger(recurrence.minute, 0, 59, "minute");
    return `${minute} * * * *`;
  }

  const { hour, minute } = parseTimeOfDay(recurrence.time);
  if (recurrence.frequency === "daily") {
    return `${minute} ${hour} * * *`;
  }
  if (recurrence.frequency === "weekdays") {
    return `${minute} ${hour} * * 1-5`;
  }
  if (recurrence.frequency === "weekly") {
    const weekdays = orderedWeekdays(recurrence.weekdays);
    if (weekdays.length === 0) {
      throw new Error("Choose at least one weekday.");
    }
    return `${minute} ${hour} * * ${weekdays.join(",")}`;
  }

  const monthDay =
    recurrence.monthDay === "last"
      ? "L"
      : requireInteger(recurrence.monthDay, 1, 31, "day of the month");
  return `${minute} ${hour} ${monthDay} * *`;
}

export function parseSimpleScheduleRecurrence(
  expression: string,
): SimpleScheduleRecurrence | undefined {
  let normalized: string;
  try {
    normalized = normalizeScheduleCronExpression(expression);
  } catch {
    return undefined;
  }
  const [minuteField, hourField, monthDayField, monthField, weekdayField] =
    normalized.split(" ");
  if (monthField !== "*") return undefined;

  const minute = parseInteger(minuteField, 0, 59);
  if (minute === undefined) return undefined;

  if (
    hourField === "*" &&
    monthDayField === "*" &&
    weekdayField === "*"
  ) {
    return {
      ...defaultSimpleScheduleRecurrence(),
      frequency: "hourly",
      minute,
    };
  }

  const hour = parseInteger(hourField, 0, 23);
  if (hour === undefined) return undefined;
  const time = `${padTime(hour)}:${padTime(minute)}`;

  if (monthDayField === "*" && weekdayField === "*") {
    return {
      ...defaultSimpleScheduleRecurrence(),
      frequency: "daily",
      time,
    };
  }
  if (monthDayField === "*" && weekdayField === "1-5") {
    return {
      ...defaultSimpleScheduleRecurrence(),
      frequency: "weekdays",
      time,
    };
  }
  if (monthDayField === "*") {
    const weekdays = parseWeekdays(weekdayField);
    if (weekdays) {
      return {
        ...defaultSimpleScheduleRecurrence(),
        frequency: "weekly",
        time,
        weekdays,
      };
    }
    return undefined;
  }
  if (weekdayField !== "*") return undefined;

  if (monthDayField === "L") {
    return {
      ...defaultSimpleScheduleRecurrence(),
      frequency: "monthly",
      time,
      monthDay: "last",
    };
  }
  const monthDay = parseInteger(monthDayField, 1, 31);
  if (monthDay === undefined) return undefined;
  return {
    ...defaultSimpleScheduleRecurrence(),
    frequency: "monthly",
    time,
    monthDay,
  };
}

export function describeScheduleCronExpression(expression: string) {
  const recurrence = parseSimpleScheduleRecurrence(expression);
  if (!recurrence) {
    try {
      return `Cron: ${normalizeScheduleCronExpression(expression)}`;
    } catch {
      return "Custom cron";
    }
  }
  return describeSimpleScheduleRecurrence(recurrence);
}

export function describeSimpleScheduleRecurrence(
  recurrence: SimpleScheduleRecurrence,
) {
  if (recurrence.frequency === "hourly") {
    const minute = requireInteger(recurrence.minute, 0, 59, "minute");
    return minute === 0
      ? "Every hour"
      : `Every hour at minute ${padTime(minute)}`;
  }
  const time = normalizedTimeOfDay(recurrence.time);
  if (recurrence.frequency === "daily") return `Every day at ${time}`;
  if (recurrence.frequency === "weekdays") {
    return `Every weekday at ${time}`;
  }
  if (recurrence.frequency === "weekly") {
    const weekdays = orderedWeekdays(recurrence.weekdays);
    if (weekdays.length === 0) {
      throw new Error("Choose at least one weekday.");
    }
    const labels = weekdays.map(
      (weekday) =>
        SCHEDULE_WEEKDAYS.find((candidate) => candidate.value === weekday)
          ?.shortLabel ?? "",
    );
    return `Every ${humanList(labels)} at ${time}`;
  }
  return recurrence.monthDay === "last"
    ? `Last day of every month at ${time}`
    : `Day ${requireInteger(
        recurrence.monthDay,
        1,
        31,
        "day of the month",
      )} of every month at ${time}`;
}

export function normalizeScheduleCronExpression(expression: string) {
  const normalized = expression.trim().replace(/\s+/g, " ");
  if (
    normalized.length === 0 ||
    normalized.length > MAX_CRON_EXPRESSION_LENGTH ||
    normalized.split(" ").length !== 5 ||
    normalized.startsWith("@") ||
    normalized.includes("H")
  ) {
    throw new Error("Enter a valid five-field cron expression.");
  }
  return normalized;
}

export function nextScheduleCronOccurrences(
  expression: string,
  timeZone: string,
  after = new Date(),
  count = 3,
) {
  const normalized = normalizeScheduleCronExpression(expression);
  requireTimeZone(timeZone);
  const occurrenceCount = requireInteger(count, 1, 10, "preview count");
  try {
    const cron = CronExpressionParser.parse(normalized, {
      currentDate: after,
      tz: timeZone,
    });
    return Array.from({ length: occurrenceCount }, () =>
      cron.next().toDate(),
    );
  } catch {
    throw new Error("Enter a valid five-field cron expression.");
  }
}

function parseTimeOfDay(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Choose a valid time.");
  return {
    hour: requireInteger(Number(match[1]), 0, 23, "hour"),
    minute: requireInteger(Number(match[2]), 0, 59, "minute"),
  };
}

function normalizedTimeOfDay(value: string) {
  const { hour, minute } = parseTimeOfDay(value);
  return `${padTime(hour)}:${padTime(minute)}`;
}

function parseInteger(value: string, minimum: number, maximum: number) {
  if (!/^\d{1,2}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}

function requireInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Choose a valid ${label}.`);
  }
  return value;
}

function parseWeekdays(value: string): ScheduleWeekday[] | undefined {
  if (!/^[0-7](?:,[0-7])*$/.test(value)) return undefined;
  const weekdays = value.split(",").map((part) => {
    const weekday = Number(part);
    return (weekday === 7 ? 0 : weekday) as ScheduleWeekday;
  });
  return new Set(weekdays).size === weekdays.length
    ? orderedWeekdays(weekdays)
    : undefined;
}

function orderedWeekdays(weekdays: ScheduleWeekday[]) {
  const selected = new Set(weekdays);
  return SCHEDULE_WEEKDAYS.map(({ value }) => value).filter((weekday) =>
    selected.has(weekday),
  );
}

function requireTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
  } catch {
    throw new Error("Choose a valid IANA time zone.");
  }
}

function humanList(values: string[]) {
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function padTime(value: number) {
  return String(value).padStart(2, "0");
}
