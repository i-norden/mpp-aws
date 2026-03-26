import type { MiddlewareHandler } from 'hono';

import { serializeForJson } from '../json.js';

export function jsonSerializationMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const originalJson = c.json.bind(c);

    const patchedJson = ((value: unknown, ...args: unknown[]) => {
      return originalJson(
        serializeForJson(value) as never,
        ...(args as [never?, never?]),
      );
    }) as typeof c.json;

    Object.defineProperty(c, 'json', {
      configurable: true,
      enumerable: false,
      value: patchedJson,
      writable: true,
    });

    await next();
  };
}
