export const TERMINAL_REPLAY_COMMAND_LIMIT = 3;

export interface TerminalReplayState {
  terminalSessionId?: string;
  lastSequence: number;
  commandStartSequences: number[];
}

export function emptyTerminalReplayState(): TerminalReplayState {
  return { lastSequence: 0, commandStartSequences: [] };
}

function validSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseTerminalReplayState(
  value: string | null,
): TerminalReplayState {
  if (!value) return emptyTerminalReplayState();
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const lastSequence = validSequence(parsed.lastSequence)
      ? parsed.lastSequence
      : 0;
    const commandStartSequences = Array.isArray(
      parsed.commandStartSequences,
    )
      ? parsed.commandStartSequences
          .filter(validSequence)
          .filter((sequence) => sequence <= lastSequence)
          .slice(-TERMINAL_REPLAY_COMMAND_LIMIT)
      : [];
    return {
      terminalSessionId:
        typeof parsed.terminalSessionId === "string" &&
        parsed.terminalSessionId.length > 0
          ? parsed.terminalSessionId
          : undefined,
      lastSequence,
      commandStartSequences,
    };
  } catch {
    return emptyTerminalReplayState();
  }
}

export function terminalReplayStorageKey(sessionId: string) {
  return `sandpi.terminal-replay.v1:${sessionId}`;
}

export function terminalReplayAfter(state: TerminalReplayState) {
  return state.commandStartSequences[0] ?? state.lastSequence;
}

export function advanceTerminalSequence(
  state: TerminalReplayState,
  sequence: number,
): TerminalReplayState {
  if (!validSequence(sequence) || sequence <= state.lastSequence) return state;
  return { ...state, lastSequence: sequence };
}

export function rememberTerminalCommand(
  state: TerminalReplayState,
  startSequence: number,
): TerminalReplayState {
  if (!validSequence(startSequence)) return state;
  return {
    ...state,
    lastSequence: Math.max(state.lastSequence, startSequence),
    commandStartSequences: [
      ...state.commandStartSequences,
      startSequence,
    ].slice(-TERMINAL_REPLAY_COMMAND_LIMIT),
  };
}

export function resetTerminalReplay(
  state: TerminalReplayState,
  sequence: number,
  terminalSessionId = state.terminalSessionId,
): TerminalReplayState {
  return {
    terminalSessionId,
    lastSequence: validSequence(sequence) ? sequence : 0,
    commandStartSequences: [],
  };
}
