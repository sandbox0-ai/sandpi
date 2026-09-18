import { isTerminalEventBatchMessage } from "@/lib/terminal-fast-path";
import { Buffer } from "node:buffer";

export interface BatchableTerminalEvent {
  seq: number;
  attemptId?: string;
  stream?: string;
  dataBase64?: string;
  type: string;
}

export interface BatchableTerminalMessage {
  type: "event";
  event?: BatchableTerminalEvent;
}

interface PendingBatch {
  fromSeq: number;
  toSeq: number;
  attemptId: string;
  stream: string;
  dataBuffers: Buffer[];
  byteLength: number;
  eventCount: number;
}

export interface TerminalOutputBatcherOptions {
  attemptId: string;
  send: (message: unknown) => void;
  maxPayloadBytes?: number;
  maxEvents?: number;
  schedule?: (callback: () => void) => object;
  cancel?: (handle: object) => void;
}

/**
 * Coalesces consecutive PTY output events without interpreting their bytes.
 * setImmediate is used instead of a timer: a lone event is forwarded on the
 * next event-loop turn without an artificial delay, while a burst arriving in
 * the same I/O turn is combined into one browser frame.
 */
export class TerminalOutputBatcher {
  private pending: PendingBatch | undefined;
  private scheduled: object | undefined;
  private closed = false;
  private readonly maxPayloadBytes: number;
  private readonly maxEvents: number;
  private readonly schedule: (callback: () => void) => object;
  private readonly cancel: (handle: object) => void;

  constructor(
    private readonly options: TerminalOutputBatcherOptions,
  ) {
    this.maxPayloadBytes = options.maxPayloadBytes ?? 64 * 1024;
    this.maxEvents = options.maxEvents ?? 256;
    this.schedule = options.schedule ?? setImmediate;
    this.cancel =
      options.cancel ??
      ((handle) =>
        clearImmediate(handle as ReturnType<typeof setImmediate>));
  }

  push(message: unknown): void {
    if (this.closed) return;
    const candidate = message as Partial<BatchableTerminalMessage>;
    const event = candidate.event;
    if (!event || event.type !== "output" || typeof event.seq !== "number") {
      this.flush();
      this.options.send(message);
      return;
    }

    const attemptId = event.attemptId ?? this.options.attemptId;
    const stream = event.stream ?? "pty";
    const data = Buffer.from(event.dataBase64 ?? "", "base64");
    const byteLength = data.byteLength;
    if (attemptId !== this.options.attemptId) {
      // Never blend output from different process attempts. Attempt changes are
      // also emitted as non-output messages and force an earlier flush.
      this.flush();
      this.options.send(message);
      return;
    }

    if (
      this.pending &&
      this.pending.attemptId === attemptId &&
      this.pending.stream === stream &&
      this.pending.toSeq + 1 === event.seq &&
      this.pending.byteLength + byteLength <= this.maxPayloadBytes &&
      this.pending.eventCount < this.maxEvents
    ) {
      // Buffer joining happens only at flush time and preserves split UTF-8 and
      // ANSI sequences without interpreting their bytes.
      this.pending.dataBuffers.push(data);
      this.pending.toSeq = event.seq;
      this.pending.byteLength += byteLength;
      this.pending.eventCount += 1;
    } else {
      this.flush();
      this.pending = {
        fromSeq: event.seq,
        toSeq: event.seq,
        attemptId,
        stream,
        dataBuffers: [data],
        byteLength,
        eventCount: 1,
      };
      this.scheduled = this.schedule(() => {
        this.scheduled = undefined;
        this.flush();
      });
    }

    if (
      this.pending &&
      (this.pending.byteLength >= this.maxPayloadBytes ||
        this.pending.eventCount >= this.maxEvents)
    ) {
      this.flush();
    }
  }

  flush(): void {
    if (this.scheduled !== undefined) {
      this.cancel(this.scheduled);
      this.scheduled = undefined;
    }
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    const batch = {
      type: "events",
      fromSeq: pending.fromSeq,
      toSeq: pending.toSeq,
      attemptId: pending.attemptId,
      stream: pending.stream,
      dataBase64: Buffer.concat(pending.dataBuffers).toString("base64"),
    };
    if (!isTerminalEventBatchMessage(batch)) {
      throw new Error("Terminal output batcher produced an invalid batch");
    }
    this.options.send(batch);
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }
}
