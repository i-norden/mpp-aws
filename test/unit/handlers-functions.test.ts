import { Hono } from 'hono';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { createFunctionsHandlers } from '../../src/api/handlers/functions.js';
import type { PricingEngine } from '../../src/pricing/engine.js';

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));
vi.mock('../../src/metrics/index.js', () => ({}));

function mockPricingEngine(): PricingEngine {
  return {
    calculateInvocationCost: vi.fn().mockReturnValue(5000n),
  } as unknown as PricingEngine;
}

function mockDb() {
  const rows = [
    {
      id: 1n,
      function_name: 'test-fn',
      function_arn: 'arn:aws:lambda:us-east-1:123:function:test-fn',
      description: 'Test function',
      memory_mb: 128,
      timeout_seconds: 30,
      estimated_duration_ms: 1000,
      custom_base_fee: null,
      enabled: true,
      visibility: 'public',
      tags: ['test'],
      version: '1.0',
      author: null,
      documentation_url: null,
      open_api_spec_url: null,
      owner_address: null,
      marketplace_fee_bps: null,
      endpoint_auth_encrypted: null,
      auth_type: null,
      pay_to_address: null,
      pricing_model: 'fixed',
      input_schema: null,
      output_schema: null,
      examples: '[]',
      resolved_ip: null,
      search_vector: null,
      gpu_type: null,
      gpu_memory_mb: null,
      created_at: new Date(),
      updated_at: new Date(),
    },
  ];

  return {
    selectFrom: vi.fn().mockReturnValue({
      selectAll: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      }),
    }),
  } as unknown;
}

describe('functions handlers', () => {
  let app: Hono;

  beforeEach(() => {
    const handlers = createFunctionsHandlers({
      db: mockDb() as any,
      config: { enforceWhitelist: false } as any,
      pricingEngine: mockPricingEngine(),
    });

    app = new Hono();
    app.get('/functions', handlers.handleListFunctions);
    app.get('/functions/search', handlers.handleSearchFunctions);
  });

  it('GET /functions returns function list with null db', async () => {
    // Test with null db (returns empty list)
    const handlers = createFunctionsHandlers({
      db: null,
      config: { enforceWhitelist: false } as any,
      pricingEngine: mockPricingEngine(),
    });
    const emptyApp = new Hono();
    emptyApp.get('/functions', handlers.handleListFunctions);

    const res = await emptyApp.request('/functions');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('functions');
  });

  it('GET /functions/search without q returns 400', async () => {
    const res = await app.request('/functions/search');
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
  });
});
