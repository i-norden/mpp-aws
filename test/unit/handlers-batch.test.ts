import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createBatchHandlers } from '../../src/api/handlers/batch.js';
import { PricingEngine } from '../../src/pricing/engine.js';

const mocks = vi.hoisted(() => ({
  createBatchInvocation: vi.fn(),
  updateBatchInvocation: vi.fn(),
  createInvocation: vi.fn(),
  getFunction: vi.fn(),
}));

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));
vi.mock('../../src/metrics/index.js', () => ({
  recordInvocation: vi.fn(),
}));
vi.mock('../../src/db/store-batch.js', () => ({
  createBatchInvocation: mocks.createBatchInvocation,
  updateBatchInvocation: mocks.updateBatchInvocation,
}));
vi.mock('../../src/db/store-invocations.js', () => ({
  createInvocation: mocks.createInvocation,
}));
vi.mock('../../src/db/store-functions.js', () => ({
  getFunction: mocks.getFunction,
}));

describe('batch handlers', () => {
  it('POST /invoke/:function/batch returns error without payment context', async () => {
    const handlers = createBatchHandlers({
      db: {} as any,
      config: { enforceWhitelist: false } as any,
      pricingEngine: { calculateInvocationCost: vi.fn().mockReturnValue(5000n) } as any,
      billingService: null,
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

  it('processes batch billing once and logs each item separately', async () => {
    const payer = '0xab5801a7d398351b8be11c439e05c5b3259aec9b';
    const pricingEngine = new PricingEngine({
      baseFee: 100n,
      memoryRatePer128MB: 100n,
      durationRatePer100ms: 100n,
      feePercentage: 10n,
      minRefundThreshold: 50n,
      estimatedGasCostUSD: 10n,
    });

    mocks.getFunction.mockResolvedValueOnce({
      function_name: 'demo',
      function_arn: 'arn:aws:lambda:us-east-1:123456789012:function:demo',
      memory_mb: 128,
      timeout_seconds: 30,
      estimated_duration_ms: 1000,
      custom_base_fee: 5000n,
      pricing_model: 'fixed',
      owner_address: '0x00000000000000000000000000000000000000aa',
      marketplace_fee_bps: 1000,
      visibility: 'public',
    });
    mocks.createBatchInvocation.mockResolvedValueOnce({
      id: 'batch_123',
      createdAt: new Date(),
    });
    mocks.updateBatchInvocation.mockResolvedValueOnce(undefined);
    mocks.createInvocation.mockResolvedValue(1);

    const executeMock = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn(() => ({ execute: executeMock }));
    const db = {
      insertInto: vi.fn(() => ({ values: valuesMock })),
    } as any;

    const billingService = {
      processCalculatedBilling: vi.fn(async (input: any) => {
        input.refundStatus = 'credited';
      }),
    } as any;

    const handlers = createBatchHandlers({
      db,
      config: {
        enforceWhitelist: false,
        endpointAuthKey: '',
        cbSuccessThreshold: 2,
        marketplaceFeeBps: 1000,
      } as any,
      pricingEngine,
      billingService,
      lambdaInvoker: {
        invoke: vi.fn().mockResolvedValue({
          statusCode: 200,
          body: '{"ok":true}',
          success: true,
          billedDurationMs: 200,
          memoryMB: 128,
        }),
      } as any,
    });
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as any).set('paymentInfo', {
        payer,
        txHash: '0xtx',
        amount: 10_000n,
      });
      await next();
    });
    app.post('/invoke/:function/batch', handlers.handleBatchInvoke);

    const res = await app.request('/invoke/demo/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: [{ a: 1 }, { a: 2 }] }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      summary: {
        total: 2,
        succeeded: 2,
        failed: 0,
      },
      billing: {
        refundStatus: 'credited',
      },
    });
    expect(billingService.processCalculatedBilling).toHaveBeenCalledTimes(1);
    expect(mocks.createInvocation).toHaveBeenCalledTimes(2);
    expect(mocks.updateBatchInvocation).toHaveBeenCalledWith(
      expect.anything(),
      'batch_123',
      expect.objectContaining({
        refundStatus: 'credited',
      }),
    );
  });
});
