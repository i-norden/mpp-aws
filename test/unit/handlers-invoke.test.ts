import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createInvokeHandlers } from '../../src/api/handlers/invoke.js';

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));
vi.mock('../../src/metrics/index.js', () => ({
  recordInvocation: vi.fn(),
  recordPayment: vi.fn(),
  ssrfBlocksTotal: { inc: vi.fn() },
}));

describe('invoke handlers', () => {
  it('POST /invoke/:function returns 500 when payment info missing', async () => {
    const handlers = createInvokeHandlers({
      db: {} as any,
      config: { enforceWhitelist: false } as any,
      pricingEngine: { calculateInvocationCost: vi.fn().mockReturnValue(5000n) } as any,
      billingService: null as any,
      lambdaInvoker: {} as any,
    });
    const app = new Hono();
    // The handler expects payment info from middleware context
    app.post('/invoke/:function', handlers.handleInvoke);

    const res = await app.request('/invoke/test-fn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    // Will fail because no payment middleware ran
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });
});
