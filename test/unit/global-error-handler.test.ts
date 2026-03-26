import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { HttpError, ErrorCodes, errorResponse } from '../../src/api/errors.js';

describe('Global onError handler', () => {
  function createApp() {
    const app = new Hono();

    // Mimic the global error handler from router.ts
    app.onError((err, c) => {
      if (err instanceof HttpError) {
        return errorResponse(c, err.status, ErrorCodes.INVALID_REQUEST, err.message, err.details);
      }
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'An internal error occurred');
    });

    return app;
  }

  it('catches HttpError and returns structured response', async () => {
    const app = createApp();
    app.get('/test', () => {
      throw new HttpError(422, 'validation failed', { field: 'name' });
    });

    const res = await app.request('/test');
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
    expect(body.message).toBe('validation failed');
    expect(body.details).toEqual({ field: 'name' });
  });

  it('catches generic Error and returns 500 with no stack trace', async () => {
    const app = createApp();
    app.get('/test', () => {
      throw new Error('unexpected database failure');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('internal_error');
    expect(body.message).toBe('An internal error occurred');
    // Should NOT leak the internal error message
    expect(body.message).not.toContain('database');
  });

  it('includes requestId from X-Request-Id header in error response', async () => {
    const app = createApp();
    app.get('/test', () => {
      throw new Error('boom');
    });

    const res = await app.request('/test', {
      headers: { 'X-Request-Id': 'test-req-id' },
    });
    const body = await res.json() as Record<string, unknown>;
    expect(body.requestId).toBe('test-req-id');
  });
});
