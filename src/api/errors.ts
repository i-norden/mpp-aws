import type { Context } from 'hono';
import type { StatusCode } from 'hono/utils/http-status';
import { getRequestId } from './middleware/request-id.js';

// ---------------------------------------------------------------------------
// HttpError
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Error codes — machine-readable strings clients can switch on
// ---------------------------------------------------------------------------

export const ErrorCodes = {
  AUTHENTICATION_REQUIRED: 'authentication_required',
  AUTHENTICATION_FAILED: 'authentication_failed',
  ADDRESS_BLOCKED: 'address_blocked',
  INVALID_REQUEST: 'invalid_request',
  NOT_FOUND: 'not_found',
  RATE_LIMITED: 'rate_limited',
  PAYMENT_REQUIRED: 'payment_required',
  INTERNAL_ERROR: 'internal_error',
  SERVICE_UNAVAILABLE: 'service_unavailable',
  INSUFFICIENT_BALANCE: 'insufficient_balance',
  CONFLICT: 'conflict',
  FORBIDDEN: 'forbidden',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

export function errorCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 410:
    case 422:
      return ErrorCodes.INVALID_REQUEST;
    case 401:
      return ErrorCodes.AUTHENTICATION_FAILED;
    case 403:
      return ErrorCodes.FORBIDDEN;
    case 404:
      return ErrorCodes.NOT_FOUND;
    case 409:
      return ErrorCodes.CONFLICT;
    case 429:
      return ErrorCodes.RATE_LIMITED;
    case 503:
      return ErrorCodes.SERVICE_UNAVAILABLE;
    default:
      return ErrorCodes.INTERNAL_ERROR;
  }
}

// ---------------------------------------------------------------------------
// errorResponse — standardised JSON error helper
// ---------------------------------------------------------------------------

/**
 * Send a JSON error response with a consistent shape:
 *   { error: string, message: string, requestId?: string, details?: unknown }
 */
export function errorResponse(
  c: Context,
  status: number,
  error: string,
  message: string,
  details?: unknown,
): Response {
  const requestId = getRequestId(c) ?? c.req.header('X-Request-Id') ?? '';
  const body: Record<string, unknown> = { error, message };
  if (requestId) body.requestId = requestId;
  if (details !== undefined) body.details = details;
  c.status(status as StatusCode);
  return c.json(body);
}
