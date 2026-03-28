import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConnInfo: vi.fn(),
}));

vi.mock('@hono/node-server/conninfo', () => ({
  getConnInfo: mocks.getConnInfo,
}));

import { getClientIp, getClientIpKey } from '../../src/http/client-ip.js';

describe('client IP helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConnInfo.mockReturnValue({ remote: { address: '127.0.0.1' } });
  });

  it('ignores proxy headers when trustProxyHeaders is false', async () => {
    const app = new Hono();
    app.get('/ip', (c) => c.json({
      ip: getClientIp(c, false),
      key: getClientIpKey(c, false),
    }));

    const res = await app.request('/ip', {
      headers: {
        'X-Forwarded-For': '203.0.113.10',
        'X-Real-IP': '203.0.113.11',
      },
    });

    await expect(res.json()).resolves.toEqual({
      ip: '127.0.0.1',
      key: '127.0.0.1',
    });
  });

  it('prefers forwarded headers when trustProxyHeaders is true', async () => {
    const app = new Hono();
    app.get('/ip', (c) => c.json({
      ip: getClientIp(c, true),
      key: getClientIpKey(c, true),
    }));

    const res = await app.request('/ip', {
      headers: {
        'X-Forwarded-For': '203.0.113.10, 10.0.0.5',
      },
    });

    await expect(res.json()).resolves.toEqual({
      ip: '203.0.113.10',
      key: '203.0.113.10',
    });
  });
});
