/**
 * Fixed-window counters for visitor limits (docs/pages.md, "Public routes":
 * 120 calls a minute per address, 600 a minute per page). In memory: the
 * service runs as one process.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly maximumBuckets = 100_000) {}

  /** Counts one request against `key`; false when `limit` was already reached in this window. */
  take(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      if (!bucket && this.buckets.size >= this.maximumBuckets) this.prune(now, windowMs);
      if (!bucket && this.buckets.size >= this.maximumBuckets) return false;
      this.buckets.set(key, { windowStart: now, count: 1 });
      return limit >= 1;
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  }

  prune(now = Date.now(), windowMs = 60_000): void {
    for (const [key, bucket] of this.buckets) if (now - bucket.windowStart >= windowMs) this.buckets.delete(key);
  }
}
