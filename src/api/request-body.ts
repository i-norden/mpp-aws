import type { Context } from 'hono';

import { HttpError } from './errors.js';

const EMPTY_BODY = Symbol('empty-json-body');
const jsonBodyCache = new WeakMap<Request, Promise<unknown | typeof EMPTY_BODY>>();

export function readJsonBody<T>(
  c: Context,
  options: { allowEmpty: true },
): Promise<T | undefined>;
export function readJsonBody<T>(
  c: Context,
  options?: { allowEmpty?: false },
): Promise<T>;
export async function readJsonBody<T>(
  c: Context,
  options?: { allowEmpty?: boolean },
): Promise<T | undefined> {
  let cached = jsonBodyCache.get(c.req.raw);
  if (!cached) {
    cached = (async () => {
      const text = await c.req.raw.clone().text();
      if (text.trim() === '') {
        return EMPTY_BODY;
      }

      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new HttpError(400, 'invalid request body');
      }
    })();
    jsonBodyCache.set(c.req.raw, cached);
  }

  const parsed = await cached;
  if (parsed === EMPTY_BODY) {
    if (options?.allowEmpty) {
      return undefined;
    }
    throw new HttpError(400, 'request body is required');
  }

  return parsed as T;
}
