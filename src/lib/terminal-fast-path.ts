export const TERMINAL_FAST_PATH_PROTOCOL = "terminal-fast-v1";

const BINARY_MAGIC = 0x5f_30; // "_0"
const BINARY_VERSION = 1;
const BINARY_MAX_PAYLOAD_BYTES = 1_000_000;

export const TerminalBinaryOpcode = {
  Output: 1,
  Input: 2,
} as const;

export interface TerminalBinaryOutputFrame {
  opcode: typeof TerminalBinaryOpcode.Output;
  fromSeq: number;
  toSeq: number;
  payload: Uint8Array;
}

export interface TerminalBinaryInputFrame {
  opcode: typeof TerminalBinaryOpcode.Input;
  sequence: number;
  payload: Uint8Array;
}

export type TerminalBinaryFrame =
  | TerminalBinaryOutputFrame
  | TerminalBinaryInputFrame;

export interface TerminalEventBatchMessage {
  type: "events";
  fromSeq: number;
  toSeq: number;
  attemptId: string;
  stream: string;
  dataBase64: string;
}

export function isTerminalEventBatchMessage(
  value: unknown,
): value is TerminalEventBatchMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TerminalEventBatchMessage>;
  return (
    candidate.type === "events" &&
    typeof candidate.fromSeq === "number" &&
    typeof candidate.toSeq === "number" &&
    typeof candidate.attemptId === "string" &&
    typeof candidate.stream === "string" &&
    typeof candidate.dataBase64 === "string"
  );
}

function writeHeader(target: Uint8Array, opcode: 1 | 2) {
  target[0] = (BINARY_MAGIC >> 8) & 0xff;
  target[1] = BINARY_MAGIC & 0xff;
  target[2] = BINARY_VERSION;
  target[3] = opcode;
  target[4] = 0;
}

function safeBigUint64(value: number) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError("Terminal sequence must be a safe non-negative integer");
  }
  return BigInt(value);
}

export function encodeTerminalBinaryOutput(
  fromSeq: number,
  toSeq: number,
  payload: Uint8Array,
) {
  if (payload.byteLength > BINARY_MAX_PAYLOAD_BYTES) {
    throw new RangeError("Terminal output frame is too large");
  }
  const frame = new Uint8Array(25 + payload.byteLength);
  const view = new DataView(frame.buffer);
  writeHeader(frame, TerminalBinaryOpcode.Output);
  view.setBigUint64(5, safeBigUint64(fromSeq), false);
  view.setBigUint64(13, safeBigUint64(toSeq), false);
  view.setUint32(21, payload.byteLength, false);
  frame.set(payload, 25);
  return frame;
}

export function encodeTerminalBinaryInput(
  sequence: number,
  payload: Uint8Array,
) {
  if (payload.byteLength > BINARY_MAX_PAYLOAD_BYTES) {
    throw new RangeError("Terminal input frame is too large");
  }
  const frame = new Uint8Array(17 + payload.byteLength);
  const view = new DataView(frame.buffer);
  writeHeader(frame, TerminalBinaryOpcode.Input);
  view.setBigUint64(5, safeBigUint64(sequence), false);
  view.setUint32(13, payload.byteLength, false);
  frame.set(payload, 17);
  return frame;
}

function frameNumber(value: bigint) {
  const decoded = Number(value);
  if (!Number.isSafeInteger(decoded) || decoded < 0) return undefined;
  return decoded;
}

export function decodeTerminalBinaryFrame(
  data: ArrayBuffer | Uint8Array,
): TerminalBinaryFrame | undefined {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (
    bytes.length < 5 ||
    ((bytes[0] << 8) | bytes[1]) !== BINARY_MAGIC ||
    bytes[2] !== BINARY_VERSION ||
    bytes[4] !== 0
  ) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[3] === TerminalBinaryOpcode.Output) {
    if (bytes.length < 25) return undefined;
    const payloadLength = view.getUint32(21, false);
    if (25 + payloadLength !== bytes.length) return undefined;
    const fromSeq = frameNumber(view.getBigUint64(5, false));
    const toSeq = frameNumber(view.getBigUint64(13, false));
    if (fromSeq === undefined || toSeq === undefined || toSeq < fromSeq) {
      return undefined;
    }
    return {
      opcode: TerminalBinaryOpcode.Output,
      fromSeq,
      toSeq,
      payload: bytes.slice(25),
    };
  }
  if (bytes[3] === TerminalBinaryOpcode.Input) {
    if (bytes.length < 17) return undefined;
    const payloadLength = view.getUint32(13, false);
    if (17 + payloadLength !== bytes.length) return undefined;
    const sequence = frameNumber(view.getBigUint64(5, false));
    if (sequence === undefined) return undefined;
    return {
      opcode: TerminalBinaryOpcode.Input,
      sequence,
      payload: bytes.slice(17),
    };
  }
  return undefined;
}

/**
 * Decodes canonical base64 without Uint8Array.from's per-character callback.
 * Large terminal replays regularly exceed a megabyte, so this path avoids both
 * an extra allocation and callback dispatch for every byte.
 */
export function decodeTerminalBase64(value: string) {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

export interface TerminalOutputMetricSample {
  toSeq: number;
  bytes: number;
  receivedAt: number;
  decodeCompletedAt: number;
  writeQueuedAt: number;
  writeCompletedAt?: number;
}

export interface TerminalInputMetricSample {
  requestId: string;
  binary: boolean;
  sentAt: number;
  acknowledgedAt?: number;
}

export interface TerminalFastPathMetricsSnapshot {
  renderer: string;
  outputSamples: number;
  inputSamples: number;
  outputBytes: number;
  medianOutputWriteMs: number | undefined;
  p95OutputWriteMs: number | undefined;
  medianInputAckMs: number | undefined;
  p95InputAckMs: number | undefined;
}

const MAX_METRIC_SAMPLES = 128;

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1,
  );
  return sorted[Math.max(0, index)];
}

function now() {
  return typeof performance === "object" ? performance.now() : Date.now();
}

/** Bounded in-memory diagnostics for the terminal fast path. */
export class TerminalFastPathMetrics {
  private rendererName = "dom";
  private readonly output = new Map<number, TerminalOutputMetricSample>();
  private readonly outputOrder: number[] = [];
  private readonly inputs = new Map<string, TerminalInputMetricSample>();
  private readonly inputOrder: string[] = [];

  setRenderer(renderer: string) {
    this.rendererName = renderer;
  }

  recordOutputReceived(toSeq: number, bytes: number) {
    const receivedAt = now();
    const sample: TerminalOutputMetricSample = {
      toSeq,
      bytes,
      receivedAt,
      decodeCompletedAt: receivedAt,
      writeQueuedAt: receivedAt,
    };
    this.output.set(toSeq, sample);
    this.outputOrder.push(toSeq);
    while (this.outputOrder.length > MAX_METRIC_SAMPLES) {
      const oldest = this.outputOrder.shift();
      if (oldest !== undefined) this.output.delete(oldest);
    }
  }

  markOutputDecoded(toSeq: number) {
    const sample = this.output.get(toSeq);
    if (sample) sample.decodeCompletedAt = now();
  }

  markOutputWriteQueued(toSeq: number) {
    const sample = this.output.get(toSeq);
    if (sample) sample.writeQueuedAt = now();
  }

  markOutputWriteComplete(toSeq: number) {
    const sample = this.output.get(toSeq);
    if (sample) sample.writeCompletedAt = now();
  }

  recordInputSent(requestId: string, binary: boolean) {
    this.inputs.set(requestId, {
      requestId,
      binary,
      sentAt: now(),
    });
    this.inputOrder.push(requestId);
    while (this.inputOrder.length > MAX_METRIC_SAMPLES) {
      const oldest = this.inputOrder.shift();
      if (oldest !== undefined) this.inputs.delete(oldest);
    }
  }

  markInputAcknowledged(requestId: string) {
    const sample = this.inputs.get(requestId);
    if (sample) sample.acknowledgedAt = now();
  }

  snapshot(): TerminalFastPathMetricsSnapshot {
    const outputSamples = this.outputOrder
      .map((seq) => this.output.get(seq))
      .filter((sample): sample is TerminalOutputMetricSample => Boolean(sample));
    const outputDurations = outputSamples
      .filter((sample) => sample.writeCompletedAt !== undefined)
      .map(
        (sample) =>
          (sample.writeCompletedAt as number) - sample.writeQueuedAt,
      );
    const inputSamples = this.inputOrder
      .map((requestId) => this.inputs.get(requestId))
      .filter((sample): sample is TerminalInputMetricSample => Boolean(sample));
    const inputDurations = inputSamples
      .filter((sample) => sample.acknowledgedAt !== undefined)
      .map((sample) => (sample.acknowledgedAt as number) - sample.sentAt);
    return {
      renderer: this.rendererName,
      outputSamples: outputSamples.length,
      inputSamples: inputSamples.length,
      outputBytes: outputSamples.reduce((total, sample) => total + sample.bytes, 0),
      medianOutputWriteMs: percentile(outputDurations, 0.5),
      p95OutputWriteMs: percentile(outputDurations, 0.95),
      medianInputAckMs: percentile(inputDurations, 0.5),
      p95InputAckMs: percentile(inputDurations, 0.95),
    };
  }
}
