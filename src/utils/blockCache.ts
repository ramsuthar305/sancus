/**
 * Per-worker memory of who is blocked and until when, so a caller who was just rejected is
 * answered again without a Redis round trip. Rejected requests are never counted, so skipping
 * Redis for them changes no limit; it only takes attack traffic off Redis.
 * ponytail: insertion-order Map capped at `max` entries (oldest dropped first). Swap for an LRU
 * only if an attack churns through more distinct keys than `max` within one block period.
 */
export class BlockCache<T extends { until: number }> {
  private readonly map = new Map<string, T>();

  constructor(private readonly max = 10_000) {}

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.until <= now) {
      this.map.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, entry: T): void {
    this.map.delete(key); // re-insert so a renewed block counts as newest
    this.map.set(key, entry);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
