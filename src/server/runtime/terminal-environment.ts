const TERMINAL_HOME = "/workspace";
const TERMINAL_TYPE = "xterm-256color";

/**
 * Builds the environment for Sandpi's interactive shell without replacing
 * user-provided settings. Vim's Vi-compatible fallback disables escape-key
 * decoding in Insert mode when no user vimrc exists; EXINIT is only consulted
 * in that no-config case, so this keeps arrow keys usable while a user's own
 * Vim configuration remains authoritative.
 */
export function terminalSessionEnvironment(
  existing: Readonly<Record<string, string>> = {},
) {
  return {
    ...existing,
    HOME: TERMINAL_HOME,
    TERM: TERMINAL_TYPE,
    EXINIT: existing.EXINIT ?? "set esckeys",
  };
}

export function terminalEnvironmentNeedsUpdate(
  existing: Readonly<Record<string, string>> | undefined,
) {
  const desired = terminalSessionEnvironment(existing);
  return Object.entries(desired).some(
    ([name, value]) => existing?.[name] !== value,
  );
}

/** Never replace a running terminal attempt merely to migrate its defaults. */
export function terminalEnvironmentUpdate(
  existing: Readonly<Record<string, string>> | undefined,
  terminalStopped: boolean,
) {
  if (!terminalStopped || !terminalEnvironmentNeedsUpdate(existing)) {
    return undefined;
  }
  return terminalSessionEnvironment(existing);
}
