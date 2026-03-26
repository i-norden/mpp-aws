import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createLeaseHandlers } from '../../src/api/handlers/lease.js';

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

describe('lease handlers', () => {
  it('GET /lease/resources returns 500 when lease service unavailable', async () => {
    const handlers = createLeaseHandlers({
      db: {} as any,
      config: {} as any,
      // leaseService is undefined, causing listResources to fail
    });
    const app = new Hono();
    app.get('/lease/resources', handlers.listResources);

    const res = await app.request('/lease/resources');
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('internal_error');
  });

  it('GET /lease/:resourceId/:leaseId/status requires auth', async () => {
    const handlers = createLeaseHandlers({
      db: {} as any,
      config: {} as any,
    });
    const app = new Hono();
    app.get('/lease/:resourceId/:leaseId/status', handlers.getLeaseStatus);

    const res = await app.request('/lease/t3-medium/lease-123/status');
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('authentication_required');
  });
});
