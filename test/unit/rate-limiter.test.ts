import { describe, expect, it, vi, afterEach } from 'vitest';

import { TokenBucketLimiter } from '../../src/ratelimit/limiter.js';

describe('TokenBucketLimiter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createLimiter(overrides?: { rate?: number; burst?: number }) {
    const limiter = new TokenBucketLimiter({
      rate: overrides?.rate ?? 10,
      burst: overrides?.burst ?? 5,
      cleanupIntervalMs: 60_000, // long interval to avoid interference
    });
    return limiter;
  }

  it('allows requests up to burst size', () => {
    const limiter = createLimiter({ burst: 3 });

    // First request creates a new bucket with burst - 1 = 2 remaining tokens
    expect(limiter.allow('key1')).toBe(true);
    // Second request consumes another token (1 remaining)
    expect(limiter.allow('key1')).toBe(true);
    // Third request consumes the last token (0 remaining)
    expect(limiter.allow('key1')).toBe(true);

    limiter.stop();
  });

  it('rejects after burst is exceeded', () => {
    const limiter = createLimiter({ burst: 2, rate: 0.001 }); // very slow refill

    expect(limiter.allow('key1')).toBe(true); // first: creates bucket with 1 remaining
    expect(limiter.allow('key1')).toBe(true); // second: consumes last token

    // Third request should be rejected (no tokens left, rate too slow to refill)
    expect(limiter.allow('key1')).toBe(false);

    limiter.stop();
  });

  it('refills tokens over time', () => {
    const limiter = createLimiter({ burst: 2, rate: 10 }); // 10 tokens per second

    // Exhaust the burst
    expect(limiter.allow('key1')).toBe(true);
    expect(limiter.allow('key1')).toBe(true);
    expect(limiter.allow('key1')).toBe(false);

    // Advance time by 500ms -> should refill 5 tokens (rate=10/s), capped at burst=2
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 500);

    expect(limiter.allow('key1')).toBe(true);

    limiter.stop();
  });

  it('maintains independent buckets per key', () => {
    const limiter = createLimiter({ burst: 2, rate: 0.001 });

    // Exhaust key1
    expect(limiter.allow('key1')).toBe(true);
    expect(limiter.allow('key1')).toBe(true);
    expect(limiter.allow('key1')).toBe(false);

    // key2 should be fully available
    expect(limiter.allow('key2')).toBe(true);
    expect(limiter.allow('key2')).toBe(true);
    expect(limiter.allow('key2')).toBe(false);

    limiter.stop();
  });

  it('returns rate limit info with correct fields', () => {
    const limiter = createLimiter({ burst: 5, rate: 10 });

    const info = limiter.allowWithInfo('key1');

    expect(info.allowed).toBe(true);
    expect(info.limit).toBe(5);
    expect(info.remaining).toBe(4); // burst(5) - 1 consumed = 4
    expect(info.resetMs).toBe(100); // ceil(1000 / 10) = 100

    limiter.stop();
  });

  it('returns remaining=0 when rejected', () => {
    const limiter = createLimiter({ burst: 1, rate: 0.001 });

    limiter.allow('key1'); // consume the only token
    const info = limiter.allowWithInfo('key1');

    expect(info.allowed).toBe(false);
    expect(info.remaining).toBe(0);

    limiter.stop();
  });

  it('tracks bucket count', () => {
    const limiter = createLimiter();

    expect(limiter.bucketCount()).toBe(0);

    limiter.allow('key1');
    expect(limiter.bucketCount()).toBe(1);

    limiter.allow('key2');
    expect(limiter.bucketCount()).toBe(2);

    limiter.stop();
  });

  it('resets all state', () => {
    const limiter = createLimiter();

    limiter.allow('key1');
    limiter.allow('key2');
    expect(limiter.bucketCount()).toBe(2);

    limiter.reset();
    expect(limiter.bucketCount()).toBe(0);

    limiter.stop();
  });

  it('returns diagnostic stats', () => {
    const limiter = createLimiter({ burst: 5, rate: 10 });

    limiter.allow('key1');
    const stats = limiter.stats();

    expect(stats.activeBuckets).toBe(1);
    expect(stats.rate).toBe(10);
    expect(stats.burst).toBe(5);

    limiter.stop();
  });

  it('stop is idempotent', () => {
    const limiter = createLimiter();
    limiter.stop();
    limiter.stop(); // should not throw
  });
});
