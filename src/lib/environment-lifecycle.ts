/** Default idle window for newly created Environment Sandboxes. */
export const DEFAULT_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS = 15 * 60;

/** Product validation bound for an Environment's configurable idle-pause timer. */
export const MAX_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS =
  30 * 24 * 60 * 60;

/** Converts the editable minutes field into the persisted seconds contract. */
export function idlePauseTimeoutSecondsFromMinutesInput(
  value: string,
): number | undefined {
  if (value.trim() === "") return undefined;
  const minutes = Number(value);
  if (
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes > MAX_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS / 60
  ) {
    return undefined;
  }
  return minutes * 60;
}
