/** Token-bucket rate limiter keyed by string. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private refillPerSec: number) {}
  take(key: string, cost = 1): boolean {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, at: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    if (this.buckets.size > 50_000) this.sweep(now);
    return true;
  }
  private sweep(now: number) {
    for (const [k, b] of this.buckets) if (now - b.at > 3_600_000) this.buckets.delete(k);
  }
}
