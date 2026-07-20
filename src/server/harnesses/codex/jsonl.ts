export interface SupervisorOutputEvent {
  seq: number;
  runtimeGeneration: number;
  attemptId?: string;
  type: string;
  stream?: string;
  dataBase64?: string;
  occurredAt: string;
}

export interface CodexDecoderState {
  attemptId?: string;
  runtimeGeneration: number;
  /** Unfinished UTF-8 JSONL bytes. Base64 keeps split multibyte code points intact. */
  tailBase64: string;
  supervisorCursor: number;
}

export interface CodexNativeEventIdentity {
  supervisorSequence: number;
  recordIndex: number;
  runtimeGeneration: number;
  attemptId?: string;
}

export interface DecodedCodexRecord extends CodexNativeEventIdentity {
  receivedAt: string;
  message: Record<string, unknown>;
}

export function codexNativeEventIdentity(
  record: DecodedCodexRecord,
): CodexNativeEventIdentity {
  return {
    supervisorSequence: record.supervisorSequence,
    recordIndex: record.recordIndex,
    runtimeGeneration: record.runtimeGeneration,
    ...(record.attemptId ? { attemptId: record.attemptId } : {}),
  };
}

export interface DecodeResult {
  state: CodexDecoderState;
  records: DecodedCodexRecord[];
  invalidRecords: Array<{
    supervisorSequence: number;
    recordIndex: number;
    text: string;
  }>;
}

export const EMPTY_CODEX_DECODER_STATE: CodexDecoderState = {
  runtimeGeneration: 0,
  tailBase64: "",
  supervisorCursor: 0,
};

/**
 * Decodes Codex stdout without assuming Supervisor event boundaries align to
 * JSONL records. Stderr and lifecycle records remain available in Sandbox0's
 * Supervisor journal but are never interpreted as native Codex protocol.
 */
export function decodeCodexSupervisorEvents(
  initial: CodexDecoderState,
  events: readonly SupervisorOutputEvent[],
): DecodeResult {
  const state = { ...initial };
  const records: DecodedCodexRecord[] = [];
  const invalidRecords: DecodeResult["invalidRecords"] = [];

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.seq <= state.supervisorCursor) continue;

    const attemptChanged =
      event.attemptId !== undefined &&
      (state.attemptId !== event.attemptId ||
        state.runtimeGeneration !== event.runtimeGeneration);
    if (attemptChanged) {
      state.tailBase64 = "";
      state.attemptId = event.attemptId;
      state.runtimeGeneration = event.runtimeGeneration;
    }

    if (event.stream === "stdout" && event.dataBase64) {
      const existing = state.tailBase64
        ? Buffer.from(state.tailBase64, "base64")
        : Buffer.alloc(0);
      const incoming = Buffer.from(event.dataBase64, "base64");
      const bytes = Buffer.concat([existing, incoming]);
      let start = 0;
      let recordIndex = 0;

      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 0x0a) continue;
        const text = bytes.subarray(start, index).toString("utf8").trimEnd();
        start = index + 1;
        if (!text) continue;
        try {
          const value = JSON.parse(text) as unknown;
          if (!isObject(value)) throw new Error("Codex record is not an object");
          records.push({
            supervisorSequence: event.seq,
            recordIndex,
            runtimeGeneration: event.runtimeGeneration,
            attemptId: event.attemptId,
            receivedAt: event.occurredAt,
            message: value,
          });
        } catch {
          invalidRecords.push({
            supervisorSequence: event.seq,
            recordIndex,
            text,
          });
        }
        recordIndex += 1;
      }

      state.tailBase64 = bytes.subarray(start).toString("base64");
    }

    state.supervisorCursor = event.seq;
    state.runtimeGeneration = event.runtimeGeneration;
    state.attemptId = event.attemptId ?? state.attemptId;
  }

  return { state, records, invalidRecords };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
