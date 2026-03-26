/**
 * Factory for creating the appropriate RateLimiter implementation.
 *
 * Returns a Redis-backed limiter when a Redis URL is provided,
 * otherwise falls back to the in-memory token bucket limiter.
 * Mirrors the Go factory in mmp-compute/lambda-proxy/internal/ratelimit/factory.go.
 */

import { info, warn } from '../logging/index.js';
import type { RateLimiter, TokenBucketConfig } from './limiter.js';
import { TokenBucketLimiter } from './limiter.js';
import { RedisLimiter } from './redis-limiter.js';

/**
 * Creates a RateLimiter backed by Redis if `redisUrl` is set,
 * otherwise returns a local in-memory TokenBucketLimiter.
 */
export function createRateLimiter(
  config: TokenBucketConfig,
  redisUrl: string,
  keyPrefix: string,
): RateLimiter {
  if (!redisUrl) {
    info('rate_limiter_using_in_memory', { rate: config.rate, burst: config.burst });
    return new TokenBucketLimiter(config);
  }

  try {
    // Basic URL validation -- the Redis client will perform the real check,
    // but we catch clearly invalid strings early.
    new URL(redisUrl);
  } catch {
    warn('redis_url_parse_failed_using_local', { url: redisUrl });
    return new TokenBucketLimiter(config);
  }

  info('rate_limiter_using_redis', { prefix: keyPrefix });
  return new RedisLimiter({
    rate: config.rate,
    burst: config.burst,
    redisUrl,
    keyPrefix,
  });
}
