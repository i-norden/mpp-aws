/**
 * In-memory token bucket rate limiter.
 *
 * Mirrors the Go implementation in mmp-compute/lambda-proxy/internal/ratelimit/limiter.go.
 * Each unique key gets its own bucket that refills at `rate` tokens per second
 * up to a maximum of `burst` tokens. A background cleanup interval evicts stale
 * buckets to prevent memory leaks.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Rate limit check result with header information. */
export interface RateLimitInfo {
  /** Whether the request was allowed. */
  allowed: boolean;
  /** Maximum number of requests (burst size). */
  limit: number;
  /** Number of remaining requests in the current window. */
  remaining: number;
  /** Milliseconds until the next token is available. */
  resetMs: number;
}

/** Common interface implemented by both in-memory and Redis-backed limiters. */
export interface RateLimiter {
  /** Returns true if the request identified by `key` should be allowed. */
  allow(key: string): boolean | Promise<boolean>;
  /** Returns full rate limit info for setting response headers. */
  allowWithInfo(key: string): RateLimitInfo | Promise<RateLimitInfo>;
  /** Stops background cleanup / releases resources. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TokenBucketConfig {
  /** Tokens added per second. */
  rate: number;
  /** Maximum tokens (also the initial token count for a new key). */
  burst: number;
  /** How often (ms) to scan for and remove stale buckets. */
  cleanupIntervalMs: number;
}

export function defaultTokenBucketConfig(): TokenBucketConfig {
  return {
    rate: 10,
    burst: 20,
    cleanupIntervalMs: 5 * 60 * 1000, // 5 minutes
  };
}

// ---------------------------------------------------------------------------
// Internal bucket
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number;
  lastCheckMs: number; // Date.now() at last access
}

// ---------------------------------------------------------------------------
// TokenBucketLimiter
// ---------------------------------------------------------------------------

export class TokenBucketLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly rate: number;
  private readonly burst: number;
  private readonly cleanupIntervalMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: TokenBucketConfig) {
    this.rate = config.rate;
    this.burst = config.burst;
    this.cleanupIntervalMs = config.cleanupIntervalMs;

    // Start periodic cleanup
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    // Allow the Node process to exit even if the timer is still active.
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  allow(key: string): boolean {
    return this.allowWithInfo(key).allowed;
  }

  allowWithInfo(key: string): RateLimitInfo {
    const now = Date.now();
    const resetMs = Math.ceil(1000 / this.rate);

    let b = this.buckets.get(key);
    if (!b) {
      // New key starts with full bucket minus one consumed token.
      b = { tokens: this.burst - 1, lastCheckMs: now };
      this.buckets.set(key, b);
      return {
        allowed: true,
        limit: this.burst,
        remaining: this.burst - 1,
        resetMs,
      };
    }

    // Refill tokens based on elapsed time.
    const elapsedSec = (now - b.lastCheckMs) / 1000;
    b.tokens = Math.min(this.burst, b.tokens + elapsedSec * this.rate);
    b.lastCheckMs = now;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return {
        allowed: true,
        limit: this.burst,
        remaining: Math.floor(b.tokens),
        resetMs,
      };
    }

    return {
      allowed: false,
      limit: this.burst,
      remaining: 0,
      resetMs,
    };
  }

  stop(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Remove buckets that have not been accessed within the cleanup interval. */
  private cleanup(): void {
    const threshold = Date.now() - this.cleanupIntervalMs;
    for (const [key, b] of this.buckets) {
      if (b.lastCheckMs < threshold) {
        this.buckets.delete(key);
      }
    }
  }

  /** Returns the number of active buckets (useful for monitoring). */
  bucketCount(): number {
    return this.buckets.size;
  }

  /** Clears all rate-limit state. */
  reset(): void {
    this.buckets.clear();
  }

  /** Returns diagnostic stats. */
  stats(): Record<string, unknown> {
    return {
      activeBuckets: this.buckets.size,
      rate: this.rate,
      burst: this.burst,
    };
  }
}
