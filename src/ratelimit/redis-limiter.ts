/**
 * Redis-backed rate limiter using a fixed-window counter algorithm.
 *
 * Uses INCR + EXPIRE for atomic, distributed rate limiting.
 * Falls back to the in-memory TokenBucketLimiter on Redis errors,
 * mirroring the Go implementation's fallback strategy.
 */

import Redis from 'ioredis';
import { warn } from '../logging/index.js';
import type { RateLimiter, RateLimitInfo, TokenBucketConfig } from './limiter.js';
import { TokenBucketLimiter } from './limiter.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RedisLimiterConfig {
  /** Tokens (requests) allowed per second. */
  rate: number;
  /** Maximum requests in a burst / per window. */
  burst: number;
  /** Redis connection URL (e.g. redis://localhost:6379). */
  redisUrl: string;
  /** Prefix for all Redis keys to avoid collisions. */
  keyPrefix: string;
}

// ---------------------------------------------------------------------------
// RedisLimiter
// ---------------------------------------------------------------------------

export class RedisLimiter implements RateLimiter {
  private readonly client: Redis;
  private readonly fallback: TokenBucketLimiter;
  private readonly burst: number;
  private readonly prefix: string;
  /** Window size in seconds, derived as burst / rate (at least 1). */
  private readonly windowSec: number;

  constructor(config: RedisLimiterConfig) {
    this.burst = config.burst;
    this.prefix = config.keyPrefix;
    this.windowSec = Math.max(1, Math.ceil(config.burst / config.rate));

    this.client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      lazyConnect: true,
    });

    // Suppress unhandled connection errors (we fall back gracefully).
    this.client.on('error', (err: Error) => {
      warn('redis_limiter_connection_error', { error: err.message });
    });

    // In-memory fallback for when Redis is unavailable.
    const fallbackConfig: TokenBucketConfig = {
      rate: config.rate,
      burst: config.burst,
      cleanupIntervalMs: 5 * 60 * 1000,
    };
    this.fallback = new TokenBucketLimiter(fallbackConfig);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async allow(key: string): Promise<boolean> {
    const info = await this.allowWithInfo(key);
    return info.allowed;
  }

  async allowWithInfo(key: string): Promise<RateLimitInfo> {
    const redisKey = `${this.prefix}${key}`;

    try {
      const pipeline = this.client.pipeline();
      pipeline.incr(redisKey);
      pipeline.ttl(redisKey);
      const results = await pipeline.exec();

      if (!results || results.length < 2) {
        warn('redis_limiter_unexpected_response', { key });
        return this.fallback.allowWithInfo(key);
      }

      const [incrErr, incrVal] = results[0];
      const [ttlErr, ttlVal] = results[1];

      if (incrErr || ttlErr) {
        warn('redis_limiter_pipeline_error', {
          key,
          incrError: incrErr?.message,
          ttlError: ttlErr?.message,
        });
        return this.fallback.allowWithInfo(key);
      }

      const count = incrVal as number;
      const ttl = ttlVal as number;

      // First request in this window -- set the expiry.
      if (count === 1 || ttl === -1) {
        await this.client.expire(redisKey, this.windowSec);
      }

      const resetMs = (ttl > 0 ? ttl : this.windowSec) * 1000;
      const remaining = Math.max(0, this.burst - count);
      const allowed = count <= this.burst;

      return {
        allowed,
        limit: this.burst,
        remaining,
        resetMs,
      };
    } catch (err) {
      warn('redis_limiter_fallback', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.fallback.allowWithInfo(key);
    }
  }

  stop(): void {
    this.fallback.stop();
    this.client.disconnect();
  }
}
