import type { Context } from 'hono';

export function jsonWithStatus(
  c: Context,
  body: unknown,
  status: number,
): Response {
  c.status(status as never);
  return c.json(body);
}
