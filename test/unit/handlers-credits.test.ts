import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createCreditsHandlers } from '../../src/api/handlers/credits.js';

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

describe('credits handlers', () => {
  it('GET /credits/:address returns 503 when db is null', async () => {
    const handlers = createCreditsHandlers({
      db: null,
      config: {} as any,
      billingService: null,
    });
    const app = new Hono();
    app.get('/credits/:address', handlers.handleGetCredits);

    const res = await app.request('/credits/0xab5801a7d398351b8be11c439e05c5b3259aec9b');
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('service_unavailable');
  });

  it('GET /credits/:address returns 400 for invalid address', async () => {
    const handlers = createCreditsHandlers({
      db: {} as any,
      config: {} as any,
      billingService: null,
    });
    const app = new Hono();
    app.get('/credits/:address', handlers.handleGetCredits);

    const res = await app.request('/credits/not-an-address');
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
  });

  it('POST /credits/:address/voucher returns 503 when db is null', async () => {
    const handlers = createCreditsHandlers({
      db: null,
      config: {} as any,
      billingService: null,
    });
    const app = new Hono();
    app.post('/credits/:address/voucher', handlers.handleRedeemVoucher);

    const res = await app.request('/credits/0xab5801a7d398351b8be11c439e05c5b3259aec9b/voucher', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(503);
  });

  it('POST /credits/:address/redeem returns 503 when refunds disabled', async () => {
    const handlers = createCreditsHandlers({
      db: {} as any,
      config: { refundEnabled: false } as any,
      billingService: null,
    });
    const app = new Hono();
    app.post('/credits/:address/redeem', handlers.handleRedeemCredits);

    const res = await app.request('/credits/0xab5801a7d398351b8be11c439e05c5b3259aec9b/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('service_unavailable');
  });
});
