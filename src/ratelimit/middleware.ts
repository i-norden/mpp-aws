/**
 * Hono middleware for rate limiting.
 *
 * Mirrors the Go middleware in mmp-compute/lambda-proxy/internal/ratelimit/middleware.go,
 * adapted from Gin to Hono. Sets IETF-standard RateLimit-* response headers and
 * returns 429 Too Many Requests when the limit is exceeded.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { RateLimiter, RateLimitInfo } from './limiter.js';
import type { PaymentInfo } from '../mpp/types.js';
import { getClientIpKey } from '../http/client-ip.js';

// ---------------------------------------------------------------------------
// Key extractor type
// ---------------------------------------------------------------------------

/** Extracts a string key from the Hono request context for rate limiting. */
export type KeyExtractor = (c: Context) => string;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Creates a Hono middleware that enforces rate limiting.
 *
 * @param limiter  - The rate limiter implementation (in-memory or Redis).
 * @param keyFn    - Function to extract the rate-limit key from the request.
 *                   Falls back to IP-based limiting when keyFn returns "".
 */
export function rateLimitMiddleware(
  limiter: RateLimiter,
  keyFn: KeyExtractor,
  fallbackKeyFn: KeyExtractor = () => '',
): MiddlewareHandler {
  return async (c, next) => {
    let key = keyFn(c);

    // Primary key unavailable -- fall back to IP-based rate limiting.
    if (!key) {
      key = fallbackKeyFn(c);
      if (!key) {
        await next();
        return;
      }
    }

    const info = await Promise.resolve(limiter.allowWithInfo(key));
    setRateLimitHeaders(c, info);

    if (!info.allowed) {
      const retryAfterSec = Math.ceil(info.resetMs / 1000);
      c.header('Retry-After', String(retryAfterSec));
      return c.json(
        { error: 'Rate limit exceeded', retry_after: `${retryAfterSec}s` },
        429,
      );
    }

    await next();
  };
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/** Sets IETF-standard rate limit response headers. */
function setRateLimitHeaders(c: Context, info: RateLimitInfo): void {
  c.header('RateLimit-Limit', String(info.limit));
  c.header('RateLimit-Remaining', String(info.remaining));
  c.header('RateLimit-Reset', String(Math.ceil(info.resetMs / 1000)));
}

// ---------------------------------------------------------------------------
// Key extractors
// ---------------------------------------------------------------------------

/**
 * Extracts the client IP address from the request.
 * Checks common proxy headers before falling back to the remote address.
 */
export function ipKeyFunc(trustProxyHeaders: boolean): KeyExtractor {
  return (c: Context): string => getClientIpKey(c, trustProxyHeaders);
}

/**
 * Extracts the payer wallet address from PaymentInfo set by the MPP middleware.
 * Returns a normalised (lower-case) address for consistent bucketing.
 */
export function walletKeyFunc(c: Context): string {
  const paymentInfo = c.get('paymentInfo') as PaymentInfo | undefined;
  if (paymentInfo?.payer) {
    return paymentInfo.payer.toLowerCase();
  }

  // Fallback: X-Wallet-Address header.
  const header = c.req.header('X-Wallet-Address');
  if (header) return header.toLowerCase();

  return '';
}

/**
 * Extracts an `:address` URL parameter (e.g. `/credits/:address`).
 * Returns lower-case for consistent bucketing.
 */
export function addressKeyFunc(c: Context): string {
  const addr = c.req.param('address');
  return addr ? addr.toLowerCase() : '';
}

/** Extracts a `:function` URL parameter. */
export function functionKeyFunc(c: Context): string {
  return c.req.param('function') ?? '';
}

/**
 * Combines multiple key extractors into a single colon-separated key.
 * Empty segments are omitted.
 *
 * Example: compositeKeyFunc(walletKeyFunc, functionKeyFunc)
 *   -> "0xabc...def:myFunction"
 */
export function compositeKeyFunc(...fns: KeyExtractor[]): KeyExtractor {
  return (c: Context): string => {
    const parts: string[] = [];
    for (const fn of fns) {
      const v = fn(c);
      if (v) parts.push(v);
    }
    return parts.join(':');
  };
}
