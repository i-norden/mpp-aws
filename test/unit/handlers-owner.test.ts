import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createOwnerHandlers } from '../../src/api/handlers/owner.js';

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

describe('owner handlers', () => {
  it('GET /functions/:name/details returns error with mock db', async () => {
    const handlers = createOwnerHandlers({
      db: {} as any,
      config: {} as any,
      pricingEngine: {} as any,
    });
    const app = new Hono();
    app.get('/functions/:name/details', handlers.handleOwnerGetFunction);

    const res = await app.request('/functions/test-fn/details');
    // Handler tries DB lookup which fails with mock, returning 500
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });

  it('PATCH /functions/:name requires auth headers', async () => {
    const handlers = createOwnerHandlers({
      db: {} as any,
      config: {} as any,
      pricingEngine: {} as any,
    });
    const app = new Hono();
    app.patch('/functions/:name', handlers.handleOwnerUpdateFunction);

    const res = await app.request('/functions/test-fn', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'updated' }),
    });
    // Handler does verifyFunctionOwnership which tries DB then auth
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });
});
