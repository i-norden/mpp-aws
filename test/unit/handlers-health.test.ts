import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createHealthHandlers } from '../../src/api/handlers/health.js';

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

describe('health handlers', () => {
  it('GET /health returns ok when db is null', async () => {
    const handlers = createHealthHandlers(undefined);
    const app = new Hono();
    app.get('/health', handlers.handleHealth);

    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
  });

  it('GET /health/live always returns ok', async () => {
    const handlers = createHealthHandlers(undefined);
    const app = new Hono();
    app.get('/health/live', handlers.handleHealthLive);

    const res = await app.request('/health/live');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
  });

  it('GET /health/ready returns ok when db is null', async () => {
    const handlers = createHealthHandlers(undefined);
    const app = new Hono();
    app.get('/health/ready', handlers.handleHealthReady);

    const res = await app.request('/health/ready');
    expect(res.status).toBe(200);
  });

  it('GET /health/ready returns error when db ping fails', async () => {
    const mockDb = {
      selectFrom: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockRejectedValue(new Error('connection refused')),
        }),
      }),
    };

    const handlers = createHealthHandlers(mockDb as any);
    const app = new Hono();
    app.get('/health/ready', handlers.handleHealthReady);

    const res = await app.request('/health/ready');
    expect(res.status).toBe(503);
  });
});
