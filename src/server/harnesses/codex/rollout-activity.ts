import type {
  CodexRolloutActivityFeed,
  CodexRolloutToolActivity,
} from "@/harnesses/codex/rollout-activity";

export const CODEX_ROLLOUT_MAX_RECORDS = 10_000;
export const CODEX_ROLLOUT_MAX_VALUE_STRING_LENGTH = 64 * 1_024;

const MAX_JSONL_LINE_LENGTH = 32 * 1_024 * 1_024;
const MAX_VALUE_DEPTH = 16;
const MAX_VALUE_NODES = 4_096;
const MAX_COLLECTION_ENTRIES = 512;
const MAX_CODE_MODE_TOOLS = 64;
const TRUNCATION_MARKER = "...[truncated]";
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type JsonObject = Record<string, unknown>;

interface ParserIssues {
  malformedLines: number;
  malformedRecords: number;
  unattributedCalls: number;
  missingTimestamps: number;
  orphanOutputs: number;
  recordLimitExceeded: boolean;
}

interface PendingOutput {
  outputType: string;
  payload: JsonObject;
  timestamp: number | null;
}

interface SanitizeState {
  nodes: number;
  truncated: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function nativeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nativeTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value / 1_000 : value;
  }
  if (typeof value !== "string" || value.length === 0) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? numeric / 1_000 : numeric;
  }
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? null : milliseconds / 1_000;
}

function recordTimestamp(envelope: JsonObject, payload: JsonObject) {
  return (
    nativeTimestamp(envelope.timestamp) ??
    nativeTimestamp(payload.timestamp) ??
    nativeTimestamp(payload.created_at) ??
    nativeTimestamp(payload.started_at)
  );
}

function sanitizedValue(value: unknown) {
  const state: SanitizeState = { nodes: 0, truncated: false };

  const visit = (candidate: unknown, depth: number): unknown => {
    state.nodes += 1;
    if (state.nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) {
      state.truncated = true;
      return TRUNCATION_MARKER;
    }

    if (candidate === null) return null;
    if (
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return candidate;
    }
    if (typeof candidate === "string") {
      if (candidate.length <= CODEX_ROLLOUT_MAX_VALUE_STRING_LENGTH) {
        return candidate;
      }
      state.truncated = true;
      return (
        candidate.slice(
          0,
          CODEX_ROLLOUT_MAX_VALUE_STRING_LENGTH - TRUNCATION_MARKER.length,
        ) + TRUNCATION_MARKER
      );
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_COLLECTION_ENTRIES) state.truncated = true;
      return candidate
        .slice(0, MAX_COLLECTION_ENTRIES)
        .map((entry) => visit(entry, depth + 1));
    }
    if (isObject(candidate)) {
      const entries = Object.entries(candidate);
      if (entries.length > MAX_COLLECTION_ENTRIES) state.truncated = true;
      const result: JsonObject = {};
      for (const [key, entry] of entries.slice(0, MAX_COLLECTION_ENTRIES)) {
        if (UNSAFE_OBJECT_KEYS.has(key) || key === "encrypted_content") {
          state.truncated = true;
          continue;
        }
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: visit(entry, depth + 1),
          writable: true,
        });
      }
      return result;
    }

    state.truncated = true;
    return null;
  };

  return {
    value: visit(value, 0),
    truncated: state.truncated,
  };
}

function responseItemTurnId(
  envelope: JsonObject,
  payload: JsonObject,
  currentTurnId: string | null,
) {
  const payloadPassthrough = isObject(
    payload.internal_chat_message_metadata_passthrough,
  )
    ? payload.internal_chat_message_metadata_passthrough
    : null;
  const envelopePassthrough = isObject(
    envelope.internal_chat_message_metadata_passthrough,
  )
    ? envelope.internal_chat_message_metadata_passthrough
    : null;
  const payloadMetadata = isObject(payload.metadata) ? payload.metadata : null;
  const envelopeMetadata = isObject(envelope.metadata)
    ? envelope.metadata
    : null;
  return (
    nativeString(payloadPassthrough?.turn_id) ??
    nativeString(payloadPassthrough?.turnId) ??
    nativeString(envelopePassthrough?.turn_id) ??
    nativeString(envelopePassthrough?.turnId) ??
    nativeString(payloadMetadata?.turn_id) ??
    nativeString(payloadMetadata?.turnId) ??
    nativeString(envelopeMetadata?.turn_id) ??
    nativeString(envelopeMetadata?.turnId) ??
    nativeString(payload.turn_id) ??
    nativeString(payload.turnId) ??
    currentTurnId
  );
}

function outputFamily(outputType: string) {
  if (outputType === "tool_search_output") return "tool_search";
  return outputType.endsWith("_call_output")
    ? outputType.slice(0, -"_call_output".length)
    : null;
}

function callFamily(callType: string) {
  return callType.endsWith("_call")
    ? callType.slice(0, -"_call".length)
    : null;
}

function activityKey(turnId: string, family: string, callId: string) {
  return JSON.stringify([turnId, family, callId]);
}

function statusFromNative(
  nativeStatus: string | null,
  hasCompletedOutput: boolean,
): CodexRolloutToolActivity["status"] {
  const status = nativeStatus?.toLowerCase();
  if (
    status === "failed" ||
    status === "error" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "incomplete"
  ) {
    return "failed";
  }
  if (hasCompletedOutput) return "completed";
  if (
    status === "completed" ||
    status === "success" ||
    status === "succeeded" ||
    status === "done"
  ) {
    return "completed";
  }
  return "running";
}

function defaultCallName(callType: string) {
  return callType.endsWith("_call")
    ? callType.slice(0, -"_call".length)
    : callType;
}

function collectCodeModeTools(...values: unknown[]) {
  const names = new Set<string>();
  const callPattern = /\btools\.([A-Za-z_$][A-Za-z0-9_$.-]*)\s*\(/g;
  const recipientPattern =
    /["']?(?:recipient_name|recipientName)["']?\s*:\s*["']([A-Za-z_$][A-Za-z0-9_$.-]*)["']/g;
  let visited = 0;

  const collectMatches = (pattern: RegExp, candidate: string) => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while (
      names.size < MAX_CODE_MODE_TOOLS &&
      (match = pattern.exec(candidate)) !== null
    ) {
      names.add(match[1]);
    }
  };

  const visit = (value: unknown) => {
    if (names.size >= MAX_CODE_MODE_TOOLS || visited >= MAX_VALUE_NODES) return;
    visited += 1;
    if (typeof value === "string") {
      const candidate = value.slice(0, CODEX_ROLLOUT_MAX_VALUE_STRING_LENGTH);
      collectMatches(callPattern, candidate);
      collectMatches(recipientPattern, candidate);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, MAX_COLLECTION_ENTRIES)) visit(entry);
      return;
    }
    if (isObject(value)) {
      const recipientName =
        nativeString(value.recipient_name) ??
        nativeString(value.recipientName);
      if (
        recipientName &&
        /^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(recipientName)
      ) {
        names.add(recipientName);
      }
      for (const entry of Object.values(value).slice(
        0,
        MAX_COLLECTION_ENTRIES,
      )) {
        visit(entry);
      }
    }
  };

  for (const value of values) visit(value);
  return [...names];
}

function mergeCodeModeTools(current: string[], incoming: string[]) {
  return [...new Set([...current, ...incoming])].slice(0, MAX_CODE_MODE_TOOLS);
}

function partialError(issues: ParserIssues) {
  const messages: string[] = [];
  if (issues.malformedLines > 0) {
    messages.push(
      `${issues.malformedLines} complete JSONL ${
        issues.malformedLines === 1 ? "line is" : "lines are"
      } malformed`,
    );
  }
  if (issues.malformedRecords > 0) {
    messages.push(
      `${issues.malformedRecords} ${
        issues.malformedRecords === 1 ? "record has" : "records have"
      } an invalid rollout shape`,
    );
  }
  if (issues.unattributedCalls > 0) {
    messages.push(
      `${issues.unattributedCalls} tool ${
        issues.unattributedCalls === 1 ? "item has" : "items have"
      } no Codex turn id`,
    );
  }
  if (issues.missingTimestamps > 0) {
    messages.push(
      `${issues.missingTimestamps} tool ${
        issues.missingTimestamps === 1 ? "item has" : "items have"
      } no native timestamp`,
    );
  }
  if (issues.orphanOutputs > 0) {
    messages.push(
      `${issues.orphanOutputs} tool ${
        issues.orphanOutputs === 1 ? "output has" : "outputs have"
      } no matching call in the same turn`,
    );
  }
  if (issues.recordLimitExceeded) {
    messages.push(
      `activity exceeds the ${CODEX_ROLLOUT_MAX_RECORDS} record safety limit`,
    );
  }
  if (messages.length === 0) return null;

  const malformed =
    issues.malformedLines > 0 || issues.malformedRecords > 0;
  return {
    code: malformed
      ? "codex_rollout_parse_partial"
      : issues.recordLimitExceeded
        ? "codex_rollout_activity_limit"
        : "codex_rollout_activity_partial",
    message: `Codex rollout activity is partial: ${messages.join("; ")}.`,
  };
}

/**
 * Reconstructs Codex-native tool activity from one persisted rollout. The
 * parser intentionally keeps Codex response-item shapes opaque instead of
 * projecting them into Sandpi's shared Session model.
 */
export function parseCodexRolloutActivity(
  text: string,
  expectedThreadId: string,
): CodexRolloutActivityFeed {
  if (expectedThreadId.length === 0) {
    return {
      source: "codex-rollout",
      availability: "unavailable",
      records: [],
      error: {
        code: "codex_rollout_thread_id_missing",
        message: "A native Codex thread id is required to validate the rollout.",
      },
    };
  }

  const issues: ParserIssues = {
    malformedLines: 0,
    malformedRecords: 0,
    unattributedCalls: 0,
    missingTimestamps: 0,
    orphanOutputs: 0,
    recordLimitExceeded: false,
  };
  const records: CodexRolloutToolActivity[] = [];
  const recordIndexes = new Map<string, number>();
  const pendingOutputs = new Map<string, PendingOutput[]>();
  const ignoredActivityKeys = new Set<string>();
  let sessionMetaSeen = false;
  let invalidSessionPreamble = false;
  let threadMismatch = false;
  let currentTurnId: string | null = null;
  let lineNumber = 0;

  const applyOutput = (
    record: CodexRolloutToolActivity,
    output: PendingOutput,
  ) => {
    const sanitized = sanitizedValue(output.payload);
    record.outputs.push({
      outputType: output.outputType,
      createdAt: output.timestamp,
      nativeStatus: nativeString(output.payload.status),
      payload: sanitized.value,
    });
    record.payloadTruncated ||= sanitized.truncated;
    record.nativeStatus =
      nativeString(output.payload.status) ?? record.nativeStatus;
    record.status = statusFromNative(record.nativeStatus, true);
    if (output.timestamp !== null) {
      record.completedAt = output.timestamp;
      record.durationMs = Math.max(
        0,
        Math.round((output.timestamp - record.createdAt) * 1_000),
      );
    }
  };

  const processEnvelope = (candidate: unknown) => {
    if (!isObject(candidate)) {
      issues.malformedRecords += 1;
      if (!sessionMetaSeen) invalidSessionPreamble = true;
      return;
    }
    const envelope = candidate;
    const envelopeType = nativeString(envelope.type);
    const payload = isObject(envelope.payload) ? envelope.payload : null;
    if (!envelopeType || !payload) {
      issues.malformedRecords += 1;
      if (!sessionMetaSeen) invalidSessionPreamble = true;
      return;
    }

    if (!sessionMetaSeen) {
      if (envelopeType !== "session_meta") {
        invalidSessionPreamble = true;
        return;
      }
      // Forked/resumed rollouts may embed ancestor history, including its
      // session_meta. The first valid metadata record identifies this file.
      const nativeThreadId = nativeString(payload.id);
      if (!nativeThreadId) {
        invalidSessionPreamble = true;
      } else if (nativeThreadId !== expectedThreadId) {
        threadMismatch = true;
      } else {
        sessionMetaSeen = true;
      }
      return;
    }
    if (envelopeType === "session_meta") return;

    if (envelopeType === "turn_context") {
      currentTurnId =
        nativeString(payload.turn_id) ??
        nativeString(payload.turnId) ??
        currentTurnId;
      return;
    }
    if (
      envelopeType === "event_msg" &&
      nativeString(payload.type) === "task_started"
    ) {
      currentTurnId =
        nativeString(payload.turn_id) ??
        nativeString(payload.turnId) ??
        currentTurnId;
      return;
    }
    if (envelopeType !== "response_item") return;

    const itemType = nativeString(payload.type);
    if (!itemType) {
      issues.malformedRecords += 1;
      return;
    }
    if (itemType === "reasoning" || itemType === "encrypted_content") return;

    const familyForOutput = outputFamily(itemType);
    if (familyForOutput) {
      const turnId = responseItemTurnId(envelope, payload, currentTurnId);
      const callId =
        nativeString(payload.call_id) ?? nativeString(payload.callId);
      if (!turnId || !callId) {
        issues.unattributedCalls += 1;
        return;
      }
      const key = activityKey(turnId, familyForOutput, callId);
      if (ignoredActivityKeys.has(key)) return;

      const timestamp = recordTimestamp(envelope, payload);
      if (timestamp === null) issues.missingTimestamps += 1;
      const output: PendingOutput = {
        outputType: itemType,
        payload,
        timestamp,
      };
      const recordIndex = recordIndexes.get(key);
      if (recordIndex === undefined) {
        const outputs = pendingOutputs.get(key) ?? [];
        outputs.push(output);
        pendingOutputs.set(key, outputs);
      } else {
        applyOutput(records[recordIndex], output);
      }
      return;
    }

    const familyForCall = callFamily(itemType);
    if (!familyForCall) return;

    const turnId = responseItemTurnId(envelope, payload, currentTurnId);
    if (!turnId) {
      issues.unattributedCalls += 1;
      return;
    }
    const callId =
      nativeString(payload.call_id) ??
      nativeString(payload.callId) ??
      nativeString(payload.id) ??
      `${itemType}:${lineNumber}`;
    const key = activityKey(turnId, familyForCall, callId);
    const timestamp = recordTimestamp(envelope, payload);
    if (timestamp === null) issues.missingTimestamps += 1;

    const callPayload = sanitizedValue(payload);
    const hasEmbeddedOutput =
      hasOwn(payload, "output") || hasOwn(payload, "result");
    const nativeStatus = nativeString(payload.status);
    const status = statusFromNative(nativeStatus, hasEmbeddedOutput);
    const codeModeTools = collectCodeModeTools(callPayload.value);

    const existingIndex = recordIndexes.get(key);
    if (existingIndex !== undefined) {
      const existing = records[existingIndex];
      existing.name = nativeString(payload.name) ?? existing.name;
      existing.namespace =
        nativeString(payload.namespace) ?? existing.namespace;
      existing.nativeStatus = nativeStatus ?? existing.nativeStatus;
      existing.callPayload = callPayload.value;
      existing.codeModeTools = mergeCodeModeTools(
        existing.codeModeTools,
        codeModeTools,
      );
      existing.payloadTruncated ||= callPayload.truncated;
      existing.status = statusFromNative(
        existing.nativeStatus,
        hasEmbeddedOutput || existing.outputs.length > 0,
      );
      if (existing.status !== "running" && timestamp !== null) {
        existing.completedAt = timestamp;
        existing.durationMs = Math.max(
          0,
          Math.round((timestamp - existing.createdAt) * 1_000),
        );
      }
      return;
    }

    if (records.length >= CODEX_ROLLOUT_MAX_RECORDS) {
      issues.recordLimitExceeded = true;
      ignoredActivityKeys.add(key);
      pendingOutputs.delete(key);
      return;
    }

    const createdAt = timestamp ?? 0;
    const record: CodexRolloutToolActivity = {
      kind: "rolloutToolCall",
      id: `${turnId}:${familyForCall}:${callId}`,
      turnId,
      createdAt,
      completedAt: status === "running" ? null : createdAt,
      durationMs: status === "running" ? null : 0,
      status,
      callId,
      callType: itemType,
      name: nativeString(payload.name) ?? defaultCallName(itemType),
      namespace: nativeString(payload.namespace),
      nativeStatus,
      callPayload: callPayload.value,
      outputs: [],
      codeModeTools,
      payloadTruncated: callPayload.truncated,
    };
    const recordIndex = records.push(record) - 1;
    recordIndexes.set(key, recordIndex);

    const outputs = pendingOutputs.get(key);
    if (outputs) {
      for (const output of outputs) applyOutput(record, output);
      pendingOutputs.delete(key);
    }
  };

  let offset = 0;
  while (offset < text.length && !threadMismatch) {
    lineNumber += 1;
    const newline = text.indexOf("\n", offset);
    const isTail = newline === -1;
    const end = isTail ? text.length : newline;
    let line = text.slice(offset, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (lineNumber === 1 && line.charCodeAt(0) === 0xfeff) {
      line = line.slice(1);
    }

    if (line.trim().length > 0) {
      if (line.length > MAX_JSONL_LINE_LENGTH) {
        if (!isTail) {
          issues.malformedLines += 1;
          if (!sessionMetaSeen) invalidSessionPreamble = true;
        }
      } else {
        try {
          processEnvelope(JSON.parse(line));
        } catch {
          // A non-newline-terminated malformed tail may still be in flight.
          if (!isTail) {
            issues.malformedLines += 1;
            if (!sessionMetaSeen) invalidSessionPreamble = true;
          }
        }
      }
    }
    if (isTail) break;
    offset = newline + 1;
  }

  if (threadMismatch) {
    return {
      source: "codex-rollout",
      availability: "unavailable",
      records: [],
      error: {
        code: "codex_rollout_thread_mismatch",
        message:
          "The Codex rollout session id does not match the requested native thread.",
      },
    };
  }
  if (invalidSessionPreamble) {
    return {
      source: "codex-rollout",
      availability: "unavailable",
      records: [],
      error: {
        code: "codex_rollout_session_meta_invalid",
        message:
          "The Codex rollout does not begin with matching session metadata.",
      },
    };
  }
  if (!sessionMetaSeen) {
    return {
      source: "codex-rollout",
      availability: "unavailable",
      records: [],
      error: {
        code: "codex_rollout_session_meta_missing",
        message:
          "The Codex rollout does not contain matching session metadata.",
      },
    };
  }

  issues.orphanOutputs = [...pendingOutputs.entries()]
    .filter(([key]) => !ignoredActivityKeys.has(key))
    .reduce((total, [, outputs]) => total + outputs.length, 0);
  const error = partialError(issues);
  return {
    source: "codex-rollout",
    availability: error ? "partial" : "available",
    records,
    error,
  };
}
