export interface TerminalEventCursor {
  earliest: number;
  latest: number;
}

export interface TerminalReplayCursor {
  after: number;
  reset: boolean;
}

/**
 * Keeps a browser cursor inside the Supervisor journal's retained window.
 * A reset tells the renderer to discard a screen that can no longer be
 * continued without a gap and rebuild it from the retained tail instead.
 */
export function reconcileTerminalReplayCursor(
  requestedAfter: number,
  cursor: TerminalEventCursor,
  forceReset = false,
): TerminalReplayCursor {
  const earliestAfter = cursor.earliest > 0 ? cursor.earliest - 1 : 0;
  const requestedIsValid =
    !forceReset &&
    Number.isSafeInteger(requestedAfter) &&
    requestedAfter >= earliestAfter &&
    requestedAfter <= cursor.latest;

  return requestedIsValid
    ? { after: requestedAfter, reset: false }
    : { after: earliestAfter, reset: true };
}
