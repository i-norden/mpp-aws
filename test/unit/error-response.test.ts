import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { HttpError, ErrorCodes, errorResponse } from '../../src/api/errors.js';

describe('ErrorCodes', () => {
  it('has all expected error codes', () => {
    expect(ErrorCodes.AUTHENTICATION_REQUIRED).toBe('authentication_required');
    expect(ErrorCodes.AUTHENTICATION_FAILED).toBe('authentication_failed');
    expect(ErrorCodes.ADDRESS_BLOCKED).toBe('address_blocked');
    expect(ErrorCodes.INVALID_REQUEST).toBe('invalid_request');
    expect(ErrorCodes.NOT_FOUND).toBe('not_found');
    expect(ErrorCodes.RATE_LIMITED).toBe('rate_limited');
    expect(ErrorCodes.PAYMENT_REQUIRED).toBe('payment_required');
    expect(ErrorCodes.INTERNAL_ERROR).toBe('internal_error');
    expect(ErrorCodes.SERVICE_UNAVAILABLE).toBe('service_unavailable');
    expect(ErrorCodes.INSUFFICIENT_BALANCE).toBe('insufficient_balance');
    expect(ErrorCodes.CONFLICT).toBe('conflict');
    expect(ErrorCodes.FORBIDDEN).toBe('forbidden');
  });
});

describe('HttpError', () => {
  it('creates error with status and message', () => {
    const err = new HttpError(400, 'bad request');
    expect(err.status).toBe(400);
    expect(err.message).toBe('bad request');
    expect(err.details).toBeUndefined();
    expect(err.name).toBe('HttpError');
  });

  it('creates error with details', () => {
    const err = new HttpError(422, 'validation failed', { field: 'name' });
    expect(err.status).toBe(422);
    expect(err.details).toEqual({ field: 'name' });
  });

  it('extends Error', () => {
    const err = new HttpError(500, 'internal error');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpError);
  });
});

describe('errorResponse', () => {
  it('returns JSON with error and message fields', async () => {
    const app = new Hono();
    app.get('/test', (c) => {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'bad input');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
    expect(body.message).toBe('bad input');
  });

  it('includes requestId when X-Request-Id header is present', async () => {
    const app = new Hono();
    app.get('/test', (c) => {
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'oops');
    });

    const res = await app.request('/test', {
      headers: { 'X-Request-Id': 'req-123' },
    });
    const body = await res.json() as Record<string, unknown>;
    expect(body.requestId).toBe('req-123');
  });

  it('omits requestId when header is absent', async () => {
    const app = new Hono();
    app.get('/test', (c) => {
      return errorResponse(c, 404, ErrorCodes.NOT_FOUND, 'not found');
    });

    const res = await app.request('/test');
    const body = await res.json() as Record<string, unknown>;
    expect(body.requestId).toBeUndefined();
  });

  it('includes details when provided', async () => {
    const app = new Hono();
    app.get('/test', (c) => {
      return errorResponse(c, 422, ErrorCodes.INVALID_REQUEST, 'bad field', {
        field: 'email',
        constraint: 'format',
      });
    });

    const res = await app.request('/test');
    const body = await res.json() as Record<string, unknown>;
    expect(body.details).toEqual({ field: 'email', constraint: 'format' });
  });

  it('omits details when not provided', async () => {
    const app = new Hono();
    app.get('/test', (c) => {
      return errorResponse(c, 403, ErrorCodes.FORBIDDEN, 'no access');
    });

    const res = await app.request('/test');
    const body = await res.json() as Record<string, unknown>;
    expect(body.details).toBeUndefined();
  });
});
