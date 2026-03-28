import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createCreditsHandlers } from '../../src/api/handlers/credits.js';

const mocks = vi.hoisted(() => ({
  verifyAddressOwnershipWithReplay: vi.fn(),
  getVoucherRedemption: vi.fn(),
  claimVoucherRedemption: vi.fn(),
  updateVoucherRedemptionStatus: vi.fn(),
  createCredit: vi.fn(),
}));

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));
vi.mock('../../src/auth/signature.js', () => ({
  verifyAddressOwnershipWithReplay: mocks.verifyAddressOwnershipWithReplay,
}));
vi.mock('../../src/db/store-vouchers.js', () => ({
  claimVoucherRedemption: mocks.claimVoucherRedemption,
  getVoucherRedemption: mocks.getVoucherRedemption,
  updateVoucherRedemptionStatus: mocks.updateVoucherRedemptionStatus,
}));
vi.mock('../../src/db/store-credits.js', () => ({
  getCreditBalance: vi.fn(),
  listCredits: vi.fn(),
  createCredit: mocks.createCredit,
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

  it('POST /credits/:address/voucher redeems issued vouchers', async () => {
    const address = '0xab5801a7d398351b8be11c439e05c5b3259aec9b';
    mocks.verifyAddressOwnershipWithReplay.mockResolvedValueOnce({ valid: true, address });
    mocks.getVoucherRedemption.mockResolvedValueOnce({
      voucher_id: 'promo-123',
      payer_address: '',
      amount: 5000n,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      status: 'issued',
    });
    mocks.claimVoucherRedemption.mockResolvedValueOnce({
      voucher_id: 'promo-123',
      payer_address: address,
      amount: 5000n,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      status: 'pending',
    });
    mocks.createCredit.mockResolvedValueOnce(undefined);
    mocks.updateVoucherRedemptionStatus.mockResolvedValue(undefined);

    const handlers = createCreditsHandlers({
      db: {} as any,
      config: {} as any,
      billingService: null,
    });
    const app = new Hono();
    app.post('/credits/:address/voucher', handlers.handleRedeemVoucher);

    const res = await app.request(`/credits/${address}/voucher`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': 'sig',
        'X-Message': 'msg',
      },
      body: JSON.stringify({ voucher_id: 'promo-123' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      voucherId: 'promo-123',
      amount: '5000',
    });
    expect(mocks.claimVoucherRedemption).toHaveBeenCalledWith(
      expect.anything(),
      'promo-123',
      address,
    );
    expect(mocks.updateVoucherRedemptionStatus).toHaveBeenCalledWith(
      expect.anything(),
      'promo-123',
      'success',
    );
  });
});
