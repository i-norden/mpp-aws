import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createAdminHandlers } from '../../src/api/handlers/admin.js';

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
});
