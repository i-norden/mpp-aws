import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

function forwardedClientIp(c: Context): string {
  const forwarded = c.req.header('X-Forwarded-For');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }

  const realIp = c.req.header('X-Real-IP') ?? c.req.header('X-Real-Ip');
  if (realIp) {
    return realIp.trim();
  }

  return '';
}

function directClientIp(c: Context): string {
  try {
    const info = getConnInfo(c);
    return info.remote.address ?? '';
  } catch {
    return '';
  }
}

export function getClientIp(c: Context, trustProxyHeaders: boolean): string {
  if (trustProxyHeaders) {
    return forwardedClientIp(c) || directClientIp(c) || 'unknown';
  }

  return directClientIp(c) || 'unknown';
}

export function getClientIpKey(c: Context, trustProxyHeaders: boolean): string {
  const ip = getClientIp(c, trustProxyHeaders);
  return ip === 'unknown' ? '' : ip;
}
