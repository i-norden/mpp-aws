import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createAdminHandlers } from '../../src/api/handlers/admin.js';

const mocks = vi.hoisted(() => ({
  createVoucherRedemption: vi.fn(),
  createAuditEntry: vi.fn(),
}));

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));
vi.mock('../../src/metrics/index.js', () => ({
  stuckPendingRefundsGauge: { set: vi.fn() },
}));
vi.mock('prom-client', () => ({
  default: {
    register: { getMetricsAsJSON: vi.fn().mockResolvedValue([]) },
    MetricType: { Gauge: 'gauge', Counter: 'counter', Histogram: 'histogram' },
  },
}));
vi.mock('../../src/db/store-vouchers.js', () => ({
  createVoucherRedemption: mocks.createVoucherRedemption,
  getVoucherRedemption: vi.fn(),
  listVoucherRedemptions: vi.fn(),
  updateVoucherRedemptionStatus: vi.fn(),
}));
vi.mock('../../src/db/store-admin.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db/store-admin.js')>('../../src/db/store-admin.js');
  return {
    ...actual,
    createAuditEntry: mocks.createAuditEntry,
  };
});

describe('admin handlers', () => {
  it('GET /admin/billing/summary returns 503 when db is null', async () => {
    const handlers = createAdminHandlers({
      db: null,
      config: {} as any,
      pricingEngine: {} as any,
    });
    const app = new Hono();
    app.get('/admin/billing/summary', handlers.handleAdminBillingSummary);

    const res = await app.request('/admin/billing/summary');
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('service_unavailable');
  });

  it('POST /admin/gdpr/delete returns 400 for invalid address', async () => {
    const handlers = createAdminHandlers({
      db: {} as any,
      config: {} as any,
      pricingEngine: {} as any,
    });
    const app = new Hono();
    app.post('/admin/gdpr/delete', handlers.handleAdminGDPRDelete);

    const res = await app.request('/admin/gdpr/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'not-an-address' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
  });

  it('GET /admin/monitoring/table-sizes returns 503 when db is null', async () => {
    const handlers = createAdminHandlers({
      db: null,
      config: {} as any,
      pricingEngine: {} as any,
    });
    const app = new Hono();
    app.get('/admin/monitoring/table-sizes', handlers.handleAdminTableSizes);

    const res = await app.request('/admin/monitoring/table-sizes');
    expect(res.status).toBe(503);
  });

  it('POST /admin/vouchers returns 400 when voucher_id missing', async () => {
    const handlers = createAdminHandlers({
      db: {} as any,
      config: {} as any,
      pricingEngine: {} as any,
    });
    const app = new Hono();
    app.post('/admin/vouchers', handlers.handleAdminCreateVoucher);

    const res = await app.request('/admin/vouchers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
  });

  it('POST /admin/vouchers creates vouchers in issued state', async () => {
    mocks.createVoucherRedemption.mockResolvedValueOnce(1n);
    mocks.createAuditEntry.mockResolvedValueOnce(undefined);

    const handlers = createAdminHandlers({
      db: {} as any,
      config: { trustProxyHeaders: false } as any,
      pricingEngine: {} as any,
    });
    const app = new Hono();
    app.post('/admin/vouchers', handlers.handleAdminCreateVoucher);

    const res = await app.request('/admin/vouchers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voucher_id: 'promo-123',
        amount: '5000',
      }),
    });

    expect(res.status).toBe(201);
    expect(mocks.createVoucherRedemption).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        voucherId: 'promo-123',
        status: 'issued',
      }),
    );
  });
});
