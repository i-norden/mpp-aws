import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createEarningsHandlers } from '../../src/api/handlers/earnings.js';

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

describe('earnings handlers', () => {
  it('GET /earnings/:address returns 503 when db is null', async () => {
    const handlers = createEarningsHandlers({
      db: null,
      config: {} as any,
      billingService: null,
    });
    const app = new Hono();
    app.get('/earnings/:address', handlers.handleGetEarnings);

    const res = await app.request('/earnings/0xab5801a7d398351b8be11c439e05c5b3259aec9b');
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('service_unavailable');
  });

  it('GET /earnings/:address returns 400 for invalid address', async () => {
    const handlers = createEarningsHandlers({
      db: {} as any,
      config: {} as any,
      billingService: null,
    });
    const app = new Hono();
    app.get('/earnings/:address', handlers.handleGetEarnings);

    const res = await app.request('/earnings/bad');
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
  });

  it('POST /earnings/:address/withdraw returns 503 when refunds disabled', async () => {
    const handlers = createEarningsHandlers({
      db: {} as any,
      config: { refundEnabled: false } as any,
      billingService: null,
    });
    const app = new Hono();
    app.post('/earnings/:address/withdraw', handlers.handleWithdrawEarnings);

    const res = await app.request('/earnings/0xab5801a7d398351b8be11c439e05c5b3259aec9b/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('service_unavailable');
  });
});
