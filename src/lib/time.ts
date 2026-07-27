/** Unix time in seconds. Fractional values preserve source millisecond precision. */
export type UnixTimestamp = number;

export function toUnixTimestamp(value: Date): UnixTimestamp {
  return value.getTime() / 1_000;
}

/** Parse legacy persisted ISO values while keeping the public contract numeric. */
export function parseUnixTimestamp(value: unknown): UnixTimestamp | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const date = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value)
      : null;
  return date && !Number.isNaN(date.getTime())
    ? toUnixTimestamp(date)
    : undefined;
}

export function dateFromUnixTimestamp(value: UnixTimestamp) {
  return new Date(value * 1_000);
}

export function unixTimestampToIso(value: UnixTimestamp) {
  return dateFromUnixTimestamp(value).toISOString();
}

export function resolveTimeZone(timeZone: string) {
  if (timeZone && timeZone !== "auto") return timeZone;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function formatUnixTimestamp(
  value: UnixTimestamp,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
) {
  const configuredOptions = {
    ...options,
    ...(timeZone === "auto" ? {} : { timeZone }),
  };
  try {
    return new Intl.DateTimeFormat(locale, configuredOptions).format(
      dateFromUnixTimestamp(value),
    );
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(
      dateFromUnixTimestamp(value),
    );
  }
}
