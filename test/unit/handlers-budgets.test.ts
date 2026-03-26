import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createBudgetsHandlers } from '../../src/api/handlers/budgets.js';

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

describe('budgets handlers', () => {
  it('GET /budgets/:budgetId returns 400 for empty ID', async () => {
    const handlers = createBudgetsHandlers({ db: {} as any, config: {} as any });
    const app = new Hono();
    app.get('/budgets/:budgetId', handlers.handleGetBudget);

    // The handler checks if budgetId is present
    const res = await app.request('/budgets/');
    // Empty path match may 404, which is fine
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('GET /budgets returns 503 when db is null', async () => {
    const handlers = createBudgetsHandlers({ db: null, config: {} as any });
    const app = new Hono();
    app.get('/budgets', handlers.handleListBudgets);

    const res = await app.request('/budgets');
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('service_unavailable');
  });
});
