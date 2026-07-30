const DEFAULT_PING_INTERVAL_MS = 60_000;
const DEFAULT_ACTIVITY_TOUCH_INTERVAL_MS = 30_000;

interface RuntimeWebSocketHeartbeatSocket {
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): unknown;
  off(event: "pong", listener: () => void): unknown;
}

export interface RuntimeWebSocketHeartbeatOptions {
  pingIntervalMs?: number;
  activityTouchIntervalMs?: number;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  onActivityTouchError?: (error: unknown) => void;
}

/**
 * Keeps a client-owned live runtime connection honest. Protocol pongs only
 * prove transport health; callers must explicitly report semantic activity
 * before the Environment idle deadline is extended.
 */
export class RuntimeWebSocketHeartbeat {
  private readonly now: () => number;
  private readonly schedule: typeof setInterval;
  private readonly cancel: typeof clearInterval;
  private timer?: ReturnType<typeof setInterval>;
  private alive = true;
  private lastActivityTouchAt?: number;
  private activityTouchInFlight?: Promise<void>;

  constructor(
    private readonly socket: RuntimeWebSocketHeartbeatSocket,
    private readonly touchRuntimeActivity: () => Promise<boolean>,
    private readonly options: RuntimeWebSocketHeartbeatOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.schedule = options.setInterval ?? setInterval;
    this.cancel = options.clearInterval ?? clearInterval;
  }

  start() {
    if (this.timer) return;
    this.socket.on("pong", this.handlePong);
    this.timer = this.schedule(
      this.tick,
      this.options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
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
  };

  markActivity() {
    const now = this.now();
    if (
      this.activityTouchInFlight ||
      (this.lastActivityTouchAt !== undefined &&
        now - this.lastActivityTouchAt <
          (this.options.activityTouchIntervalMs ??
            DEFAULT_ACTIVITY_TOUCH_INTERVAL_MS))
    ) {
      return;
    }
    const touch = this.touchRuntimeActivity()
      .then((touched) => {
        if (touched) this.lastActivityTouchAt = this.now();
      })
      .catch((error) => this.options.onActivityTouchError?.(error))
      .finally(() => {
        if (this.activityTouchInFlight === touch) {
          this.activityTouchInFlight = undefined;
        }
      });
    this.activityTouchInFlight = touch;
  }
}
