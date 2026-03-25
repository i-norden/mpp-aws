import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { parseSignedMessage, verifyAddressSignature } from '../../auth/signature.js';
import * as log from '../../logging/index.js';
import { authFailuresTotal } from '../../metrics/index.js';

export function adminAuthMiddleware(
  apiKey: string,
  adminAddresses: string[],
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

      if (address && signature && timestamp) {
        if (!addrSet.has(address.toLowerCase())) {
          log.warn('admin_auth_failed', { method: 'signature', reason: 'address_not_admin', address, clientIp: getClientIp(c) });
          authFailuresTotal.inc({ auth_type: 'eip191' });
          return c.json({ error: 'unauthorized', message: 'Address is not an authorized admin' }, 401);
        }

        const message = `open-compute:${address}:${timestamp}`;
        try {
          parseSignedMessage(message);
        } catch (err) {
          log.warn('admin_auth_failed', { method: 'signature', reason: 'invalid_message', error: String(err), clientIp: getClientIp(c) });
          authFailuresTotal.inc({ auth_type: 'eip191' });
          return c.json({ error: 'unauthorized', message: err instanceof Error ? err.message : 'invalid message' }, 401);
        }

        const result = await verifyAddressSignature(signature, message, address);
        if (!result.valid) {
          log.warn('admin_auth_failed', { method: 'signature', reason: 'invalid_signature', error: result.errorMessage, clientIp: getClientIp(c) });
          authFailuresTotal.inc({ auth_type: 'eip191' });
          return c.json({ error: 'unauthorized', message: `Invalid signature: ${result.errorMessage}` }, 401);
        }

        log.info('admin_auth_success', { method: 'signature', address: result.address, clientIp: getClientIp(c), path: c.req.path });
        await next();
        return;
      }
    }

    log.warn('admin_auth_failed', { reason: 'no_credentials', clientIp: getClientIp(c), path: c.req.path, method: c.req.method });
    authFailuresTotal.inc({ auth_type: 'api_key' });
    return c.json({
      error: 'unauthorized',
      message: 'Valid admin credentials required (X-Admin-Key or X-Admin-Address/X-Admin-Signature/X-Admin-Timestamp)',
    }, 401);
  };
}

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? c.req.header('X-Real-IP') ?? 'unknown';
}
