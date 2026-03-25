import type { MiddlewareHandler } from 'hono';

export function corsMiddleware(allowedOrigins: string[]): MiddlewareHandler {
  const allowAll = allowedOrigins.includes('*');
  const originSet = new Set(allowedOrigins.filter((o) => o !== '*').map((o) => o.toLowerCase()));

  return async (c, next) => {
    const origin = c.req.header('Origin') ?? '';
    let allowedOrigin = '';

    if (allowAll) {
      allowedOrigin = '*';
    } else if (origin && originSet.has(origin.toLowerCase())) {
      allowedOrigin = origin;
    }

    if (allowedOrigin) {
      c.header('Access-Control-Allow-Origin', allowedOrigin);
      c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      c.header(
        'Access-Control-Allow-Headers',
        'Origin, Content-Type, Authorization, X-PAYMENT, X-Wallet-Address, X-Wallet-Signature, X-Wallet-Message, X-Admin-Key, X-Signature, X-Message, X-Requested-With, X-Budget-Id, X-Request-Id',
      );
      c.header(
        'Access-Control-Expose-Headers',
        'X-PAYMENT-RESPONSE, X-MPP-RECEIPT, Payment-Receipt, WWW-Authenticate, X-Request-Id',
      );
      c.header('Access-Control-Max-Age', '86400');
      if (allowedOrigin !== '*') {
        c.header('Vary', 'Origin');
      }
    }

    if (c.req.method === 'OPTIONS') {
      return allowedOrigin ? c.body(null, 204) : c.body(null, 403);
    }

    await next();
  };
}
