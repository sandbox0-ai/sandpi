export interface TerminalReplayChunk {
  fromSeq: number;
  toSeq: number;
  data: Uint8Array;
}

export interface TerminalReplayCacheSnapshot {
  sessionId: string;
  completeScreen: boolean;
  chunks: readonly TerminalReplayChunk[];
}

const MAX_REPLAY_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_REPLAY_CACHE_ENTRIES = 4;

/**
 * A page-lifetime cache of a journal tail that was itself used to rebuild an
 * empty xterm screen. It is not authoritative and never replaces procd's
 * replay journal; it only avoids redownloading the same bytes when the user
 * moves between in-app routes.
 */
export class TerminalReplayMemoryCache {
  private readonly entries = new Map<
    string,
    TerminalReplayCacheSnapshot & { byteLength: number }
  >();

  reset(key: string, sessionId: string, completeScreen: boolean) {
    this.entries.set(key, {
      sessionId,
      completeScreen,
      chunks: [],
      byteLength: 0,
    });
    this.prune();
  }

  markCompleteScreen(key: string, sessionId: string) {
    const entry = this.entries.get(key);
    if (!entry || entry.sessionId !== sessionId) return;
    entry.completeScreen = true;
  }

  append(
    key: string,
    sessionId: string,
    chunk: TerminalReplayChunk,
  ) {
    const entry = this.entries.get(key);
    if (!entry || entry.sessionId !== sessionId) return;
    const last = entry.chunks.at(-1);
    // Lifecycle events can occupy sequence numbers without producing PTY bytes.
    // Those gaps are safe for screen reconstruction; reversing or overlapping
    // output is not.
    if (last && chunk.fromSeq <= last.toSeq) return;
    const mutableEntry = entry as TerminalReplayCacheSnapshot & {
      byteLength: number;
    };
    mutableEntry.chunks = [...entry.chunks, chunk];
    mutableEntry.byteLength += chunk.data.byteLength;

    while (
      mutableEntry.byteLength > MAX_REPLAY_CACHE_BYTES &&
      mutableEntry.chunks.length > 1
    ) {
      const removed = mutableEntry.chunks[0];
      mutableEntry.chunks = mutableEntry.chunks.slice(1);
      mutableEntry.byteLength -= removed.data.byteLength;
      // Once the cache no longer starts at the point from which xterm was
      // rebuilt, it cannot safely restore an empty screen by itself.
      mutableEntry.completeScreen = false;
    }
    if (mutableEntry.byteLength > MAX_REPLAY_CACHE_BYTES) {
      mutableEntry.chunks = [];
      mutableEntry.byteLength = 0;
      mutableEntry.completeScreen = false;
    }
  }

  usable(key: string, sessionId: string, throughSeq: number) {
    const entry = this.entries.get(key);
    if (
      !entry ||
      entry.sessionId !== sessionId ||
      !entry.completeScreen ||
      entry.chunks.length === 0
    ) {
      return undefined;
    }
    const last = entry.chunks.at(-1);
    if (last?.toSeq !== throughSeq) return undefined;
    return entry.chunks;
  }

  delete(key: string) {
    this.entries.delete(key);
  }

  private prune() {
    while (this.entries.size > MAX_REPLAY_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

const globalCache = new TerminalReplayMemoryCache();

export function terminalReplayMemoryCache() {
  return globalCache;
}
