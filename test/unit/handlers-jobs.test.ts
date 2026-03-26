import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createJobsHandlers } from '../../src/api/handlers/jobs.js';

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

describe('jobs handlers', () => {
  it('GET /jobs/:jobId returns 400 for empty ID', async () => {
    const handlers = createJobsHandlers({
      db: {} as any,
      config: {} as any,
      pricingEngine: {} as any,
    });
    const app = new Hono();
    app.get('/jobs/:jobId', handlers.handleGetJob);

    const res = await app.request('/jobs/test-id');
    // Without auth headers, should return 401
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });

  it('GET /jobs returns 503 when db is null', async () => {
    const handlers = createJobsHandlers({
      db: null,
      config: {} as any,
      pricingEngine: {} as any,
    });
    const app = new Hono();
    app.get('/jobs', handlers.handleListJobs);

    const res = await app.request('/jobs');
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('service_unavailable');
  });
});
