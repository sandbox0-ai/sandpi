export interface TerminalInputQueueOptions<Message> {
  authorize: () => Promise<void>;
  forward: (message: Message) => void;
  requiresAuthorization: (message: Message) => boolean;
  onError: (error: unknown) => void;
  authorizationLeaseMs: number;
  initiallyAuthorized?: boolean;
  now?: () => number;
}

/**
 * Preserves WebSocket message order across asynchronous access checks.
 * Successful checks are leased briefly so normal typing never performs one
 * PostgreSQL round trip per key while a locked Session is noticed promptly.
 */
export class TerminalInputQueue<Message> {
  private readonly now: () => number;
  private tail: Promise<void> = Promise.resolve();
  private authorizedUntil = 0;
  private closed = false;

  constructor(private readonly options: TerminalInputQueueOptions<Message>) {
    if (!Number.isFinite(options.authorizationLeaseMs)) {
      throw new Error("authorizationLeaseMs must be finite");
    }
    this.now = options.now ?? Date.now;
    if (options.initiallyAuthorized) {
      this.authorizedUntil =
        this.now() + Math.max(0, options.authorizationLeaseMs);
    }
  }

  enqueue(message: Message) {
    if (this.closed) return;
    const task = this.tail.then(async () => {
      if (this.closed) return;
      if (
        this.options.requiresAuthorization(message) &&
        this.now() >= this.authorizedUntil
      ) {
        await this.options.authorize();
        this.authorizedUntil =
          this.now() + Math.max(0, this.options.authorizationLeaseMs);
      }
      if (!this.closed) this.options.forward(message);
    });
    this.tail = task.catch((error) => {
      if (this.closed) return;
      this.closed = true;
      this.options.onError(error);
    });
  }

  close() {
    this.closed = true;
  }

  /** Waits for queued work in tests and graceful connection teardown. */
  async drain() {
    await this.tail;
  }
}
