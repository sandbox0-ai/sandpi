import { Buffer } from "node:buffer";

import type { RawData } from "ws";

interface RelayMessage {
  data: RawData;
  isBinary: boolean;
  isFrame: boolean;
  size: number;
}

export interface BrowserWebSocketRelayStats {
  receivedFrames: number;
  forwardedFrames: number;
  receivedFrameBytes: number;
  coalescedFrames: number;
  peakQueuedBytes: number;
}

interface BrowserWebSocketRelayOptions {
  maxQueuedBytes: number;
  send: (
    data: RawData,
    isBinary: boolean,
    callback: (error?: Error) => void,
  ) => void;
  onOverflow: () => void;
  onSendError: (error: Error) => void;
}

/**
 * Preserves every Dashboard control message while bounding screencast latency.
 * When the downstream cannot keep up, only the newest unsent `frame` event is
 * retained; RPC results, session events and errors keep their original order.
 */
export class BrowserWebSocketDownstreamRelay {
  private readonly controls: RelayMessage[] = [];
  private latestFrame: RelayMessage | undefined;
  private queuedBytes = 0;
  private sending = false;
  private sendFrameBeforeNextControl = false;
  private closed = false;
  private receivedFrames = 0;
  private forwardedFrames = 0;
  private receivedFrameBytes = 0;
  private coalescedFrames = 0;
  private peakQueuedBytes = 0;

  constructor(private readonly options: BrowserWebSocketRelayOptions) {}

  enqueue(data: RawData, isBinary: boolean) {
    if (this.closed) return;
    const message = {
      data,
      isBinary,
      isFrame: isPlaywrightDashboardFrameMessage(data, isBinary),
      size: websocketRawDataSize(data),
    };
    if (message.size > this.options.maxQueuedBytes) {
      this.overflow();
      return;
    }

    if (message.isFrame) {
      this.receivedFrames += 1;
      this.receivedFrameBytes += message.size;
      if (this.latestFrame) {
        this.queuedBytes -= this.latestFrame.size;
        this.coalescedFrames += 1;
      }
      this.latestFrame = message;
      if (this.sending && this.controls.length > 0) {
        this.sendFrameBeforeNextControl = true;
      }
    } else {
      this.controls.push(message);
    }
    this.queuedBytes += message.size;
    this.peakQueuedBytes = Math.max(
      this.peakQueuedBytes,
      this.queuedBytes,
    );
    if (this.queuedBytes > this.options.maxQueuedBytes) {
      this.overflow();
      return;
    }
    this.flush();
  }

  close() {
    this.closed = true;
    this.controls.length = 0;
    this.latestFrame = undefined;
    this.queuedBytes = 0;
  }

  stats(): BrowserWebSocketRelayStats {
    return {
      receivedFrames: this.receivedFrames,
      forwardedFrames: this.forwardedFrames,
      receivedFrameBytes: this.receivedFrameBytes,
      coalescedFrames: this.coalescedFrames,
      peakQueuedBytes: this.peakQueuedBytes,
    };
  }

  private flush() {
    if (this.closed || this.sending) return;
    let message: RelayMessage | undefined;
    if (
      this.latestFrame &&
      (this.sendFrameBeforeNextControl || this.controls.length === 0)
    ) {
      message = this.takeLatestFrame();
      this.sendFrameBeforeNextControl = false;
    } else {
      message = this.controls.shift();
      if (message && this.latestFrame) {
        this.sendFrameBeforeNextControl = true;
      }
    }
    if (!message) return;
    this.queuedBytes -= message.size;
    this.sending = true;
    try {
      this.options.send(message.data, message.isBinary, (error) => {
        this.sending = false;
        if (error) {
          this.close();
          this.options.onSendError(error);
          return;
        }
        if (message.isFrame) this.forwardedFrames += 1;
        this.flush();
      });
    } catch (error) {
      this.sending = false;
      this.close();
      this.options.onSendError(
        error instanceof Error ? error : new Error("WebSocket send failed"),
      );
    }
  }

  private takeLatestFrame() {
    const frame = this.latestFrame;
    this.latestFrame = undefined;
    return frame;
  }

  private overflow() {
    this.close();
    this.options.onOverflow();
  }
}

export function isPlaywrightDashboardFrameMessage(
  data: RawData,
  isBinary: boolean,
) {
  if (isBinary) return false;
  const prefix = websocketRawDataPrefix(data, 128);
  // Playwright's protocol serializer emits event envelopes with `method`
  // first. If that upstream shape changes, fail open and preserve the message.
  return /^\s*\{\s*"method"\s*:\s*"frame"\s*,/.test(prefix);
}

export function websocketRawDataSize(data: RawData) {
  if (Array.isArray(data)) {
    return data.reduce((size, chunk) => size + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function websocketRawDataPrefix(data: RawData, maximumBytes: number) {
  if (Array.isArray(data)) {
    let remaining = maximumBytes;
    const chunks: Buffer[] = [];
    for (const chunk of data) {
      if (remaining <= 0) break;
      const prefix = chunk.subarray(0, remaining);
      chunks.push(prefix);
      remaining -= prefix.byteLength;
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data, 0, Math.min(data.byteLength, maximumBytes)).toString(
      "utf8",
    );
  }
  return data.subarray(0, maximumBytes).toString("utf8");
}
