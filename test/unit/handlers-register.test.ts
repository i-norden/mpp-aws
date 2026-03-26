import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createRegisterHandlers } from '../../src/api/handlers/register.js';

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

describe('register handlers', () => {
  it('POST /register returns 503 when db is null', async () => {
    const handlers = createRegisterHandlers({
      db: null,
      config: { allowOpenRegister: true } as any,
      pricingEngine: { calculateInvocationCost: vi.fn().mockReturnValue(5000n) } as any,
    });
    const app = new Hono();
    app.post('/register', handlers.handlePublicRegister);

    const res = await app.request('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://example.com/api' }),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('service_unavailable');
  });

  it('POST /register returns 400 for empty body', async () => {
    const handlers = createRegisterHandlers({
      db: {} as any,
      config: { allowOpenRegister: true } as any,
      pricingEngine: { calculateInvocationCost: vi.fn().mockReturnValue(5000n) } as any,
    });
    const app = new Hono();
    app.post('/register', handlers.handlePublicRegister);

    const res = await app.request('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
  });
});
