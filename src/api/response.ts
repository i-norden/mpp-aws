import type { Context } from 'hono';
import type { StatusCode } from 'hono/utils/http-status';

export function jsonWithStatus(
  c: Context,
  body: unknown,
  status: number,
): Response {
  c.status(status as StatusCode);
  return c.json(body);
}
