export interface TerminalInputQueueOptions<Message> {
  authorizeAndForward: (message: Message) => Promise<void>;
  forward: (message: Message) => Promise<void> | void;
  requiresAuthorization: (message: Message) => boolean;
  onError: (error: unknown) => void;
}

/**
 * Preserves WebSocket message order while terminal input is atomically checked
 * and queued under the same Session lock used by history operations.
 */
export class TerminalInputQueue<Message> {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: TerminalInputQueueOptions<Message>) {}

  enqueue(message: Message) {
    if (this.closed) return;
    const task = this.tail.then(async () => {
      if (this.closed) return;
      if (this.options.requiresAuthorization(message)) {
        await this.options.authorizeAndForward(message);
        return;
      }
      if (!this.closed) await this.options.forward(message);
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
