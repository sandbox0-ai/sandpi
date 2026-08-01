const TERMINAL_HOME = "/workspace";
const TERMINAL_TYPE = "xterm-256color";
const TERMINAL_BASH_INIT_VARIABLE = "SANDPI_TERMINAL_BASH_INIT";
const TERMINAL_BASH_INIT = String.raw`if [[ -r /etc/profile ]]; then
  source /etc/profile
fi

# Keep Sandpi's unconfigured prompt compact. User startup files run afterward
# and remain authoritative for Bash themes or for replacing Bash with zsh.
PS1='# '

if [[ -r "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -r "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -r "$HOME/.profile" ]]; then
  source "$HOME/.profile"
elif [[ -r "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi
`;
const TERMINAL_COMMAND = [
  "/bin/bash",
  "-c",
  `exec 3<<<"$${TERMINAL_BASH_INIT_VARIABLE}"; unset ${TERMINAL_BASH_INIT_VARIABLE}; exec /bin/bash --noprofile --rcfile /dev/fd/3 -i`,
] as const;

export function terminalSessionCommand() {
  return [...TERMINAL_COMMAND];
}

function terminalCommandNeedsUpdate(
  existing: readonly string[] | undefined,
) {
  return (
    existing?.length !== TERMINAL_COMMAND.length ||
    TERMINAL_COMMAND.some((part, index) => existing[index] !== part)
  );
}

/** Never replace a running terminal attempt merely to migrate its shell. */
export function terminalCommandUpdate(
  existing: readonly string[] | undefined,
  terminalStopped: boolean,
) {
  if (!terminalStopped || !terminalCommandNeedsUpdate(existing)) {
    return undefined;
  }
  return terminalSessionCommand();
}

/**
 * Builds the environment for Sandpi's interactive shell. Sandpi owns the
 * bootstrap variable while preserving unrelated settings. Vim's Vi-compatible
 * fallback disables escape-key decoding in Insert mode when no user vimrc
 * exists; EXINIT is only consulted in that no-config case, so this keeps arrow
 * keys usable while the user's Vim and shell configuration remains
 * authoritative.
 */
export function terminalSessionEnvironment(
  existing: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    ...existing,
    HOME: TERMINAL_HOME,
    TERM: TERMINAL_TYPE,
    EXINIT: existing.EXINIT ?? "set esckeys",
    [TERMINAL_BASH_INIT_VARIABLE]: TERMINAL_BASH_INIT,
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
