import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';

export const REQUEST_ID_HEADER = 'X-Request-Id';
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const incomingRequestId = c.req.header(REQUEST_ID_HEADER) ?? '';
    const requestId = REQUEST_ID_RE.test(incomingRequestId)
      ? incomingRequestId
      : randomUUID();

    c.set('requestId', requestId);
    c.header(REQUEST_ID_HEADER, requestId);

    await next();

    c.header(REQUEST_ID_HEADER, requestId);
  };
}

export function getRequestId(c: Context): string | undefined {
  return c.get('requestId') as string | undefined;
}
