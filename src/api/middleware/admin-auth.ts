import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import { verifyAddressOwnershipWithReplay } from '../../auth/signature.js';
import type { Database } from '../../db/types.js';
import * as log from '../../logging/index.js';
import { authFailuresTotal } from '../../metrics/index.js';
import { errorResponse, ErrorCodes } from '../errors.js';

export function adminAuthMiddleware(
  apiKey: string,
  adminAddresses: string[],
  db?: Kysely<Database>,
): MiddlewareHandler {
  const addrSet = new Set(adminAddresses.map((a) => a.toLowerCase()));

  return async (c, next) => {
    // Fast path: API key authentication
    if (apiKey) {
      const key = c.req.header('X-Admin-Key');
      if (key) {
        const keyBuf = Buffer.from(key);
        const expectedBuf = Buffer.from(apiKey);
        if (keyBuf.length === expectedBuf.length && timingSafeEqual(keyBuf, expectedBuf)) {
          log.info('admin_auth_success', { method: 'api_key', clientIp: getClientIp(c), path: c.req.path });
          await next();
          return;
        }
      }
    }

    // Signature path: EIP-191 authentication
    if (addrSet.size > 0) {
      const address = c.req.header('X-Admin-Address');
      const signature = c.req.header('X-Admin-Signature');
      const timestamp = c.req.header('X-Admin-Timestamp');
      const nonce = c.req.header('X-Admin-Nonce');

      if (address && signature && timestamp && nonce) {
        if (!addrSet.has(address.toLowerCase())) {
          log.warn('admin_auth_failed', { method: 'signature', reason: 'address_not_admin', address, clientIp: getClientIp(c) });
          authFailuresTotal.inc({ auth_type: 'eip191' });
          return errorResponse(c, 401, ErrorCodes.AUTHENTICATION_FAILED, 'Address is not an authorized admin');
        }

        if (!db) {
          log.error('admin_auth_failed', { method: 'signature', reason: 'db_unavailable', clientIp: getClientIp(c) });
          authFailuresTotal.inc({ auth_type: 'eip191' });
          return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'Admin signature auth requires database-backed replay protection');
        }

        const message = `open-compute:${address}:${timestamp}:${nonce}`;
        const result = await verifyAddressOwnershipWithReplay(db, signature, message, address);
        if (!result.valid) {
          log.warn('admin_auth_failed', { method: 'signature', reason: 'invalid_signature', error: result.errorMessage, clientIp: getClientIp(c) });
          authFailuresTotal.inc({ auth_type: 'eip191' });
          return errorResponse(c, result.statusCode ?? 401, ErrorCodes.AUTHENTICATION_FAILED, `Invalid signature: ${result.errorMessage}`);
        }

        log.info('admin_auth_success', { method: 'signature', address: result.address, clientIp: getClientIp(c), path: c.req.path });
        await next();
        return;
      }
    }

    log.warn('admin_auth_failed', { reason: 'no_credentials', clientIp: getClientIp(c), path: c.req.path, method: c.req.method });
    authFailuresTotal.inc({ auth_type: 'api_key' });
    return errorResponse(c, 401, ErrorCodes.AUTHENTICATION_REQUIRED, 'Valid admin credentials required (X-Admin-Key or X-Admin-Address/X-Admin-Signature/X-Admin-Timestamp/X-Admin-Nonce)');
  };
}

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? c.req.header('X-Real-IP') ?? 'unknown';
}
