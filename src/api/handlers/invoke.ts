/**
 * Invoke handler — handles POST /invoke/:function.
 * TypeScript port of mmp-compute/lambda-proxy/internal/api/handlers_invoke.go
 *
 * Responsibilities:
 *   1. Validate and normalize function name
 *   2. Look up function in DB (whitelist enforcement + endpoint type detection)
 *   3. Check access control for private functions
 *   4. Parse request body
 *   5. Invoke Lambda or HTTP endpoint (with circuit breaker for HTTP)
 *   6. Process billing (refund if overpaid)
 *   7. Log invocation to DB
 *   8. Credit owner earnings
 *   9. Record metrics
 *  10. Return response with billing breakdown
 */

import type { Context } from 'hono';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import type { Config } from '../../config/index.js';
import type { PricingEngine } from '../../pricing/engine.js';
import type {
  BillingService,
  InvocationBilling,
} from '../../billing/service.js';
import type { LambdaInvoker, InvocationResult } from '../../lambda/invoker.js';
import { CircuitBreaker } from '../../circuit-breaker/index.js';
import { getPaymentInfo } from '../middleware/mpp.js';
import { normalizeEthAddress } from '../../validation/index.js';
import * as log from '../../logging/index.js';
import * as metrics from '../../metrics/index.js';
import type { OFACChecker } from '../../ofac/checker.js';
import { applyToRequest, decrypt } from '../../endpoint-auth/index.js';
import { readJsonBody } from '../request-body.js';
import { HttpError, errorCodeForStatus, errorResponse, ErrorCodes } from '../errors.js';
import {
  assertFunctionInvocationAccess,
  invalidateFunctionCache,
  resolveFunctionForRequest,
  type LambdaFunction,
} from '../function-registry.js';
import { isHTTPEndpoint, settleInvocation } from '../../invocation/settlement.js';

export interface InvokeDeps {
  db: Kysely<Database> | null;
  config: Config;
  pricingEngine: PricingEngine;
  billingService: BillingService | null;
  lambdaInvoker: LambdaInvoker | null;
  ofacChecker?: OFACChecker | null;
}

interface InvokeRequest {
  payload?: unknown;
  async?: boolean;
  refundAddress?: string;
}

interface InvokeResponse {
  success: boolean;
  statusCode: number;
  body?: unknown;
  error?: string;
  txHash?: string;
  cost: string;
  billing?: BillingDetails;
}

interface BillingDetails {
  paid: bigint;
  paidUSD: string;
  actualCloudCost: bigint;
  actualCloudCostUSD: string;
  fee: bigint;
  feeUSD: string;
  feePercentage: bigint;
  grossRefund: bigint;
  gasCost: bigint;
  netRefund: bigint;
  netRefundUSD: string;
  refundStatus: string;
  refundTxHash?: string;
  creditBalance: bigint;
  creditBalanceUSD: string;
  refundAddress?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format atomic USDC (6 decimals) as a USD string.
 * Mirrors Go's pricing.FormatUSD.
 */
function formatUSD(atomicAmount: bigint): string {
  const dollars = Number(atomicAmount) / 1_000_000;
  if (Math.abs(dollars) < 0.01) {
    return `$${dollars.toFixed(4)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

/** Parse a JSON body; tolerate empty body by returning empty object. */
async function parseInvokeBody(c: Context): Promise<InvokeRequest> {
  return (await readJsonBody<InvokeRequest>(c, { allowEmpty: true })) ?? {};
}

// ---------------------------------------------------------------------------
// Per-endpoint circuit breakers (mirrors Go's sync.Map of breakers)
// ---------------------------------------------------------------------------

const endpointBreakers = new Map<string, CircuitBreaker>();

function getEndpointBreaker(endpointURL: string, successThreshold: number): CircuitBreaker {
  let cb = endpointBreakers.get(endpointURL);
  if (cb) return cb;
  cb = new CircuitBreaker({
    failureThreshold: 5,
    successThreshold,
    timeoutMs: 30_000,
  });
  endpointBreakers.set(endpointURL, cb);
  return cb;
}

// ---------------------------------------------------------------------------
// billingDetailsFromBreakdown (mirrors Go helper)
// ---------------------------------------------------------------------------

function billingDetailsFromBreakdown(
  billing: InvocationBilling,
): BillingDetails | null {
  if (!billing.breakdown) return null;
  return {
    paid: billing.amountPaid,
    paidUSD: formatUSD(billing.amountPaid),
    actualCloudCost: billing.breakdown.actualCloudCost,
    actualCloudCostUSD: formatUSD(billing.breakdown.actualCloudCost),
    fee: billing.breakdown.feeAmount,
    feeUSD: formatUSD(billing.breakdown.feeAmount),
    feePercentage: billing.breakdown.feePercentage,
    grossRefund: billing.breakdown.grossRefund,
    gasCost: billing.breakdown.gasCost,
    netRefund: billing.breakdown.netRefund,
    netRefundUSD: formatUSD(billing.breakdown.netRefund),
    refundStatus: billing.refundStatus,
    refundTxHash: billing.refundTxHash,
    creditBalance: billing.creditBalance,
    creditBalanceUSD: formatUSD(billing.creditBalance),
  };
}

// ---------------------------------------------------------------------------
// createInvokeHandlers
// ---------------------------------------------------------------------------

export function createInvokeHandlers(deps: InvokeDeps) {
  const { db, config, pricingEngine, lambdaInvoker, ofacChecker } = deps;

  // -------------------------------------------------------------------
  // getInvokeAmount — calculate required payment for a function invocation
  // -------------------------------------------------------------------

  async function getInvokeAmount(c: Context): Promise<bigint> {
    const resolved = await resolveFunctionForRequest(
      db,
      config,
      pricingEngine,
      c.req.param('function') ?? '',
    );
    return resolved.amount;
  }

  // -------------------------------------------------------------------
  // getInvokeDescription
  // -------------------------------------------------------------------

  function getInvokeDescription(c: Context): string {
    const functionName = c.req.param('function') ?? 'unknown';
    const memoryStr = c.req.query('memory');
    let memoryMB = 128;
    if (memoryStr) {
      const parsed = parseInt(memoryStr, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        memoryMB = parsed;
      }
    }
    return `Lambda invocation: ${functionName} (${memoryMB}MB)`;
  }

  // -------------------------------------------------------------------
  // handleInvoke — main handler for POST /invoke/:function
  // -------------------------------------------------------------------

  async function handleInvoke(c: Context): Promise<Response> {
    let dbFunction: LambdaFunction | null = null;
    let functionName = '';
    let exactAmount = 0n;

    try {
      const resolved = await resolveFunctionForRequest(
        db,
        config,
        pricingEngine,
        c.req.param('function') ?? '',
      );
      functionName = resolved.functionName;
      dbFunction = resolved.dbFunction;
      exactAmount = resolved.amount;
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(c, err.status, errorCodeForStatus(err.status), err.message, err.details);
      }
      throw err;
    }

    // 3. Get payment info from context
    const paymentInfo = getPaymentInfo(c);
    if (!paymentInfo) {
      log.error('payment info missing in handler', { function: functionName });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'payment info missing - payment middleware may not have run');
    }

    // 4. Access control check for private functions
    try {
      await assertFunctionInvocationAccess(
        db,
        functionName,
        dbFunction,
        paymentInfo.payer,
      );
    } catch (err) {
      if (err instanceof HttpError) {
        const code = err.status === 403 ? ErrorCodes.FORBIDDEN : ErrorCodes.INTERNAL_ERROR;
        return errorResponse(c, err.status, code, err.message, { function: functionName });
      }
      throw err;
    }

    if (paymentInfo.amount !== exactAmount) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'Invocation payment amount no longer matches the exact function price.');
    }

    // 5. Parse request body
    let req: InvokeRequest;
    try {
      req = await parseInvokeBody(c);
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(c, err.status, errorCodeForStatus(err.status), err.message, err.details);
      }
      throw err;
    }

    // Validate refund address if provided
    let refundAddress = '';
    if (req.refundAddress) {
      try {
        refundAddress = normalizeEthAddress(req.refundAddress);
        // OFAC check on refund address
        if (ofacChecker && ofacChecker.isBlocked(refundAddress)) {
          metrics.ofacBlockedTotal.inc({ endpoint: c.req.path });
          log.warn('OFAC blocked address rejected (refund)', { payer: refundAddress });
          return errorResponse(c, 403, ErrorCodes.FORBIDDEN, 'This address is not permitted to use this service');
        }
      } catch (err) {
        return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err));
      }
    }

    const payload = req.payload ?? {};

    // 6. Invoke Lambda or HTTP endpoint
    let result: InvocationResult;
    const invokeStart = Date.now();

    if (dbFunction && isHTTPEndpoint(dbFunction.function_arn)) {
      // HTTP endpoint invocation with circuit breaker
      const cb = getEndpointBreaker(dbFunction.function_arn, config.cbSuccessThreshold);
      if (!cb.allow()) {
        return c.json({
          success: false,
          error: 'endpoint temporarily unavailable (circuit breaker open)',
          cost: formatUSD(paymentInfo.amount),
        } satisfies Partial<InvokeResponse>, 503);
      }

      const timeoutSeconds = Math.min(
        Math.max(dbFunction.timeout_seconds, 1),
        300,
      );

      if (!lambdaInvoker) {
        return c.json({
          success: false,
          error: 'Lambda invoker not configured',
        }, 503);
      }

      // Decrypt endpoint auth and apply it to the outbound request if configured
      let endpointURL = dbFunction.function_arn;
      let endpointAuthHeaders: Record<string, string> | undefined;
      if (dbFunction.endpoint_auth_encrypted && config.endpointAuthKey) {
        try {
          const auth = decrypt(dbFunction.endpoint_auth_encrypted, config.endpointAuthKey);
          const applied = applyToRequest(auth, endpointURL);
          endpointURL = applied.url;
          endpointAuthHeaders = applied.headers;
        } catch (err) {
          log.error('failed to decrypt endpoint auth', {
            function: functionName,
            error: err instanceof Error ? err.message : String(err),
          });
          // Continue without auth headers rather than failing the request
        }
      }

      result = await lambdaInvoker.invokeHTTPEndpoint(
        endpointURL,
        payload,
        timeoutSeconds,
        endpointAuthHeaders,
      );

      if (result.success) {
        cb.success();
      } else {
        cb.failure();
      }
    } else {
      // Lambda invocation (default path)
      if (!lambdaInvoker) {
        return c.json({
          success: false,
          error: 'Lambda invoker not configured',
        } satisfies Partial<InvokeResponse>, 503);
      }

      const lambdaTarget = dbFunction?.function_arn ?? functionName;
      result = await lambdaInvoker.invoke(lambdaTarget, payload);
    }

    const invokeDurationSeconds = (Date.now() - invokeStart) / 1000;

    // 7. Record metrics
    metrics.recordInvocation(functionName, result.success, invokeDurationSeconds, paymentInfo.amount);

    // 8. Process billing and log invocation (best-effort, don't fail the request)
    let billingDetails: BillingDetails | null = null;
    if (db) {
      const settlement = await settleInvocation(
        {
          db,
          config,
          billingService: deps.billingService,
        },
        functionName,
        dbFunction,
        {
          payerAddress: paymentInfo.payer,
          txHash: paymentInfo.txHash,
          amountPaid: paymentInfo.amount,
          refundAddress,
        },
        result,
      );
      if (settlement.billingInput) {
        billingDetails = billingDetailsFromBreakdown(settlement.billingInput);
        if (billingDetails && refundAddress) {
          billingDetails.refundAddress = refundAddress;
        }
      }
    }

    // 9. Build response body
    // Parse result body: try to parse as JSON, fall back to raw string
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(result.body);
    } catch {
      responseBody = result.body || undefined;
    }

    const response: InvokeResponse = {
      success: result.success,
      statusCode: result.statusCode,
      body: responseBody,
      error: result.error,
      txHash: paymentInfo.txHash,
      cost: formatUSD(paymentInfo.amount),
      billing: billingDetails ?? undefined,
    };

    return c.json(response, 200);
  }

  return {
    getInvokeAmount,
    getInvokeDescription,
    handleInvoke,
    /** Exposed for external cache invalidation (e.g., after registration). */
    invalidateFunctionCache,
  };
}
