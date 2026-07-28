export class BoundedLruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }
  }

  get(key: K) {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V) {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: K) {
    return this.entries.delete(key);
  }

  get size() {
    return this.entries.size;
  }
}
