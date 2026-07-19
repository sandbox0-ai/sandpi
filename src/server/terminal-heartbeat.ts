const TERMINAL_PING_INTERVAL_MS = 60_000;
const TERMINAL_RUNTIME_TOUCH_INTERVAL_MS = 5 * 60_000;

interface TerminalHeartbeatSocket {
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): unknown;
  off(event: "pong", listener: () => void): unknown;
}

interface TerminalHeartbeatOptions {
  pingIntervalMs?: number;
  touchIntervalMs?: number;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  onTouchError?: (error: unknown) => void;
}

/**
 * Keeps a browser-owned Terminal connection honest and extends the idle
 * deadline only after a protocol-level pong proves that the client is alive.
 */
export class TerminalHeartbeat {
  private readonly now: () => number;
  private readonly schedule: typeof setInterval;
  private readonly cancel: typeof clearInterval;
  private timer?: ReturnType<typeof setInterval>;
  private alive = true;
  private lastTouchAt: number;
  private touchInFlight?: Promise<void>;

  constructor(
    private readonly socket: TerminalHeartbeatSocket,
    private readonly touchRuntime: () => Promise<boolean>,
    private readonly options: TerminalHeartbeatOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.schedule = options.setInterval ?? setInterval;
    this.cancel = options.clearInterval ?? clearInterval;
    this.lastTouchAt = this.now();
  }

  start() {
    if (this.timer) return;
    this.socket.on("pong", this.handlePong);
    this.timer = this.schedule(
      this.tick,
      this.options.pingIntervalMs ?? TERMINAL_PING_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    this.cancel(this.timer);
    this.timer = undefined;
    this.socket.off("pong", this.handlePong);
  }

  private readonly tick = () => {
    if (!this.alive) {
      this.stop();
      this.socket.terminate();
      return;
    }
    this.alive = false;
    try {
      this.socket.ping();
    } catch {
      this.stop();
      this.socket.terminate();
    }
  };

  private readonly handlePong = () => {
    this.alive = true;
    const now = this.now();
    if (
      this.touchInFlight ||
      now - this.lastTouchAt <
        (this.options.touchIntervalMs ?? TERMINAL_RUNTIME_TOUCH_INTERVAL_MS)
    ) {
      return;
    }
    const touch = this.touchRuntime()
      .then((touched) => {
        if (touched) this.lastTouchAt = this.now();
      })
      .catch((error) => this.options.onTouchError?.(error))
      .finally(() => {
        if (this.touchInFlight === touch) this.touchInFlight = undefined;
      });
    this.touchInFlight = touch;
  };
}
