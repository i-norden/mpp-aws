import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createBatchHandlers } from '../../src/api/handlers/batch.js';

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));
vi.mock('../../src/metrics/index.js', () => ({
  recordInvocation: vi.fn(),
}));

describe('batch handlers', () => {
  it('POST /invoke/:function/batch returns error without payment context', async () => {
    const handlers = createBatchHandlers({
      db: {} as any,
      config: { enforceWhitelist: false } as any,
      pricingEngine: { calculateInvocationCost: vi.fn().mockReturnValue(5000n) } as any,
      lambdaInvoker: {} as any,
    });
    const app = new Hono();
    app.post('/invoke/:function/batch', handlers.handleBatchInvoke);

    const res = await app.request('/invoke/test-fn/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: [{}] }),
    });
    // Will fail because no payment middleware ran
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });
});
