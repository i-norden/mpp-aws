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
import type { Database, LambdaFunctionTable } from '../../db/types.js';
import type { Config } from '../../config/index.js';
import type { PricingEngine } from '../../pricing/engine.js';
import type {
  BillingService,
  InvocationBilling,
  MeteredBillingBreakdown,
} from '../../billing/service.js';
import type { LambdaInvoker, InvocationResult } from '../../lambda/invoker.js';
import { CircuitBreaker } from '../../circuit-breaker/index.js';
import { getPaymentInfo } from '../middleware/mpp.js';
import type { PaymentInfo } from '../../mpp/types.js';
import { normalizeEthAddress } from '../../validation/index.js';
import { getFunction } from '../../db/store-functions.js';
import { createInvocation } from '../../db/store-invocations.js';
import * as log from '../../logging/index.js';
import * as metrics from '../../metrics/index.js';
import type { OFACChecker } from '../../ofac/checker.js';
import type { Selectable } from 'kysely';
import {
  decrypt,
  type EndpointAuth,
  AUTH_TYPE_BEARER,
  AUTH_TYPE_API_KEY,
  AUTH_TYPE_BASIC,
  AUTH_TYPE_CUSTOM_HEADER,
} from '../../endpoint-auth/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LambdaFunction = Selectable<LambdaFunctionTable>;

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

/** Matches Go's safeFunctionNamePattern: alphanumeric, hyphens, underscores, max 170 chars. */
const SAFE_FUNCTION_NAME_RE = /^[a-zA-Z0-9_-]{1,170}$/;

function normalizeFunctionName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (!SAFE_FUNCTION_NAME_RE.test(trimmed)) return '';
  return trimmed.toLowerCase();
}

/** Check if a function ARN is an HTTPS endpoint URL. */
function isHTTPEndpoint(arn: string): boolean {
  return arn.startsWith('https://');
}

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
  try {
    const body = await c.req.json();
    return body as InvokeRequest;
  } catch {
    // Empty body or invalid JSON -- return empty request (matches Go's ShouldBindJSON tolerating EOF)
    return {};
  }
}

// ---------------------------------------------------------------------------
// Function cache (in-memory, mirrors Go's sync.Map + TTL)
// ---------------------------------------------------------------------------

interface CachedFunction {
  fn: LambdaFunction;
  expiresAt: number;
}

const functionCache = new Map<string, CachedFunction>();

function getCachedFunction(name: string): LambdaFunction | null {
  const cached = functionCache.get(name);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.fn;
  }
  if (cached) {
    functionCache.delete(name);
  }
  return null;
}

function setCachedFunction(name: string, fn: LambdaFunction, ttlSeconds: number): void {
  functionCache.set(name, {
    fn,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

function invalidateFunctionCache(name: string): void {
  functionCache.delete(name);
}

// ---------------------------------------------------------------------------
// Endpoint auth helpers
// ---------------------------------------------------------------------------

/**
 * Build HTTP headers from a decrypted EndpointAuth.
 * Mirrors Go's endpointauth.ApplyAuth behaviour.
 */
function buildAuthHeaders(auth: EndpointAuth): Record<string, string> {
  const headers: Record<string, string> = {};
  switch (auth.type) {
    case AUTH_TYPE_BEARER:
      if (auth.token) {
        headers['Authorization'] = `Bearer ${auth.token}`;
      }
      break;
    case AUTH_TYPE_API_KEY:
      if (auth.keyName && auth.keyValue && auth.keyLocation === 'header') {
        headers[auth.keyName] = auth.keyValue;
      }
      break;
    case AUTH_TYPE_BASIC:
      if (auth.username && auth.password) {
        const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
        headers['Authorization'] = `Basic ${encoded}`;
      }
      break;
    case AUTH_TYPE_CUSTOM_HEADER:
      if (auth.headerName && auth.headerValue) {
        headers[auth.headerName] = auth.headerValue;
      }
      break;
  }
  return headers;
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

  function getInvokeAmount(c: Context): bigint {
    const rawName = c.req.param('function') ?? '';
    if (!rawName) {
      return pricingEngine.calculateInvocationCost(128, 1000);
    }

    const functionName = normalizeFunctionName(rawName);
    if (!functionName) {
      return pricingEngine.calculateInvocationCost(128, 1000);
    }

    // Check cache first
    const cached = getCachedFunction(functionName);
    if (cached) {
      if (cached.custom_base_fee !== null && cached.custom_base_fee !== undefined) {
        return BigInt(cached.custom_base_fee);
      }
      return pricingEngine.calculateInvocationCost(
        cached.memory_mb,
        cached.estimated_duration_ms,
      );
    }

    // Note: We cannot do async DB lookups in a synchronous getAmount callback.
    // The middleware calls getAmount synchronously. In the Go code this is also sync
    // (it does a blocking DB call). For the TS port we rely on cached data or defaults.
    // The handleInvoke handler does the full async DB lookup before invocation.
    return pricingEngine.calculateInvocationCost(128, 1000);
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
    // 1. Extract and validate function name
    const rawName = c.req.param('function') ?? '';
    if (!rawName) {
      return c.json({ error: 'function name is required' }, 400);
    }

    const functionName = normalizeFunctionName(rawName);
    if (!functionName) {
      return c.json({
        error: 'invalid function name',
        message: 'Function names must contain only alphanumeric characters, hyphens, and underscores',
      }, 400);
    }

    // 2. Look up function in DB (whitelist enforcement + endpoint type detection)
    let dbFunction: LambdaFunction | null = null;

    if (db) {
      // Check cache first
      dbFunction = getCachedFunction(functionName);

      if (!dbFunction) {
        try {
          dbFunction = await getFunction(db, functionName);
          if (dbFunction) {
            const ttl = config.functionCacheTTLSeconds > 0 ? config.functionCacheTTLSeconds : 60;
            setCachedFunction(functionName, dbFunction, ttl);
          }
        } catch (err) {
          log.error('database error looking up function', {
            function: functionName,
            error: err instanceof Error ? err.message : String(err),
          });
          return c.json({
            error: 'service temporarily unavailable',
            message: 'Unable to look up function. Please try again later.',
          }, 503);
        }
      }

      if (!dbFunction && config.enforceWhitelist) {
        return c.json({
          error: 'function not registered',
          function: functionName,
          message: 'This function is not available for invocation. Contact the administrator to register it.',
        }, 403);
      }
    } else if (config.enforceWhitelist) {
      return c.json({
        error: 'function not registered',
        function: functionName,
        message: 'This function is not available for invocation. Contact the administrator to register it.',
      }, 403);
    }

    // 3. Get payment info from context
    const paymentInfo = getPaymentInfo(c);
    if (!paymentInfo) {
      log.error('payment info missing in handler', { function: functionName });
      return c.json({ error: 'payment info missing - payment middleware may not have run' }, 500);
    }

    // 4. Access control check for private functions
    if (dbFunction && dbFunction.visibility === 'private') {
      const payerAddr = paymentInfo.payer;
      const isOwner = dbFunction.owner_address !== null &&
        dbFunction.owner_address !== undefined &&
        dbFunction.owner_address.toLowerCase() === payerAddr.toLowerCase();

      if (!isOwner && db) {
        try {
          const accessRow = await db
            .selectFrom('function_access_list')
            .select('id')
            .where('function_name', '=', functionName)
            .where('invoker_address', '=', payerAddr.toLowerCase())
            .executeTakeFirst();

          if (!accessRow) {
            return c.json({
              error: 'access denied',
              function: functionName,
              message: 'This function is private. You are not authorized to invoke it.',
            }, 403);
          }
        } catch (err) {
          log.error('failed to check access authorization', {
            function: functionName,
            payer: payerAddr,
            error: err instanceof Error ? err.message : String(err),
          });
          return c.json({ error: 'failed to verify access authorization' }, 500);
        }
      } else if (!isOwner) {
        return c.json({
          error: 'access denied',
          function: functionName,
          message: 'This function is private. You are not authorized to invoke it.',
        }, 403);
      }
    }

    // 5. Parse request body
    const req = await parseInvokeBody(c);

    // Validate refund address if provided
    let refundAddress = '';
    if (req.refundAddress) {
      try {
        refundAddress = normalizeEthAddress(req.refundAddress);
        // OFAC check on refund address
        if (ofacChecker && ofacChecker.isBlocked(refundAddress)) {
          metrics.ofacBlockedTotal.inc({ endpoint: c.req.path });
          log.warn('OFAC blocked address rejected (refund)', { payer: refundAddress });
          return c.json({
            error: 'address_blocked',
            message: 'This address is not permitted to use this service',
          }, 403);
        }
      } catch (err) {
        return c.json({
          error: 'invalid refund address',
          message: err instanceof Error ? err.message : String(err),
        }, 400);
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

      // Decrypt endpoint auth and build auth headers if configured
      let endpointAuthHeaders: Record<string, string> | undefined;
      if (dbFunction.endpoint_auth_encrypted && config.endpointAuthKey) {
        try {
          const auth = decrypt(dbFunction.endpoint_auth_encrypted, config.endpointAuthKey);
          endpointAuthHeaders = buildAuthHeaders(auth);
        } catch (err) {
          log.error('failed to decrypt endpoint auth', {
            function: functionName,
            error: err instanceof Error ? err.message : String(err),
          });
          // Continue without auth headers rather than failing the request
        }
      }

      result = await lambdaInvoker.invokeHTTPEndpoint(
        dbFunction.function_arn,
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
      const isHTTP = dbFunction !== null && isHTTPEndpoint(dbFunction.function_arn);
      billingDetails = await processInvocationBilling(
        deps,
        functionName,
        dbFunction,
        paymentInfo,
        result,
        isHTTP,
        refundAddress,
      );
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

// ---------------------------------------------------------------------------
// processInvocationBilling (mirrors Go's Handler.processInvocationBilling)
// ---------------------------------------------------------------------------

async function processInvocationBilling(
  deps: InvokeDeps,
  functionName: string,
  dbFunction: LambdaFunction | null,
  paymentInfo: PaymentInfo,
  result: InvocationResult,
  isHTTP: boolean,
  refundAddress: string,
): Promise<BillingDetails | null> {
  const { db, config, billingService } = deps;
  if (!db) return null;

  // Metered HTTP billing path
  if (isHTTP && billingService && dbFunction && dbFunction.pricing_model === 'metered') {
    return processMeteredHTTPBilling(
      deps,
      functionName,
      dbFunction,
      paymentInfo,
      result,
      refundAddress,
    );
  }

  // Full billing path: Lambda + billing enabled + duration data available
  if (!isHTTP && billingService && dbFunction && result.billedDurationMs > 0) {
    const billingInput: InvocationBilling = {
      payerAddress: paymentInfo.payer,
      sourceTxHash: paymentInfo.txHash,
      amountPaid: paymentInfo.amount,
      memoryMB: dbFunction.memory_mb,
      billedDurationMs: BigInt(result.billedDurationMs),
      refundAddress,
      refundStatus: 'none',
      creditBalance: 0n,
    };

    try {
      await billingService.processInvocationBilling(billingInput);
    } catch (err) {
      log.error('billing processing failed, falling back to legacy path', {
        function: functionName,
        payer: paymentInfo.payer,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through to legacy path below
      return logLegacyInvocation(
        db,
        deps,
        functionName,
        dbFunction,
        paymentInfo,
        result,
      );
    }

    // Log invocation with billing details
    try {
      const invId = await createInvocation(db, {
        function_name: functionName,
        payer_address: paymentInfo.payer,
        amount_paid: paymentInfo.amount,
        tx_hash: paymentInfo.txHash || null,
        status_code: result.statusCode,
        success: result.success,
        duration_ms: BigInt(result.billedDurationMs),
        billed_duration_ms: BigInt(result.billedDurationMs),
        memory_mb: dbFunction.memory_mb,
        actual_cloud_cost: billingInput.breakdown?.actualCloudCost ?? null,
        fee_amount: billingInput.breakdown?.feeAmount ?? null,
        refund_amount: billingInput.breakdown && billingInput.breakdown.grossRefund > 0n
          ? billingInput.breakdown.netRefund
          : null,
        refund_status: billingInput.refundStatus || null,
        refund_tx_hash: billingInput.refundTxHash ?? null,
      });
      void invId; // logged for debugging

      // Credit owner earnings based on actual revenue kept
      await creditOwnerEarningsBilling(
        db,
        config,
        functionName,
        dbFunction,
        paymentInfo,
        billingInput,
      );
    } catch (err) {
      log.error('failed to log invocation with billing', {
        function: functionName,
        payer: paymentInfo.payer,
        txHash: paymentInfo.txHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const bd = billingDetailsFromBreakdown(billingInput);
    if (bd && refundAddress) {
      bd.refundAddress = refundAddress;
    }
    return bd;
  }

  // Legacy path: no billing data
  return logLegacyInvocation(db, deps, functionName, dbFunction, paymentInfo, result);
}

// ---------------------------------------------------------------------------
// processMeteredHTTPBilling
// ---------------------------------------------------------------------------

async function processMeteredHTTPBilling(
  deps: InvokeDeps,
  functionName: string,
  dbFunction: LambdaFunction,
  paymentInfo: PaymentInfo,
  result: InvocationResult,
  refundAddress: string,
): Promise<BillingDetails | null> {
  const { db, config, billingService } = deps;
  if (!db || !billingService) return null;

  const customCostPerRequest = dbFunction.custom_base_fee;
  if (customCostPerRequest === null || customCostPerRequest === undefined) {
    log.warn('metered HTTP billing called without custom_base_fee configured', {
      function: functionName,
    });
    return null;
  }

  // Parse X-Actual-Cost from upstream response
  let actualCost = BigInt(customCostPerRequest);
  let costParsed = false;

  if (result.responseHeaders) {
    const costStr = result.responseHeaders['X-Actual-Cost'];
    if (costStr) {
      try {
        const parsed = BigInt(costStr);
        if (parsed >= 0n) {
          actualCost = parsed;
          costParsed = true;
        }
      } catch {
        log.warn('invalid X-Actual-Cost header from upstream, charging full amount', {
          function: functionName,
          value: costStr,
        });
      }
    }
  }

  if (!costParsed) {
    actualCost = BigInt(customCostPerRequest);
  }

  // Cap at the price ceiling
  if (actualCost > BigInt(customCostPerRequest)) {
    actualCost = BigInt(customCostPerRequest);
  }

  // Calculate billing breakdown
  const marketplaceFeeBps = dbFunction.marketplace_fee_bps ?? config.marketplaceFeeBps;
  const platformFee = actualCost * BigInt(marketplaceFeeBps) / 10000n;
  const ownerEarning = actualCost - platformFee;
  let grossRefund = paymentInfo.amount - actualCost;
  if (grossRefund < 0n) {
    grossRefund = 0n;
  }

  const billingInput: InvocationBilling = {
    payerAddress: paymentInfo.payer,
    sourceTxHash: paymentInfo.txHash,
    amountPaid: paymentInfo.amount,
    memoryMB: 0,
    billedDurationMs: 0n,
    refundAddress,
    refundStatus: 'none',
    creditBalance: 0n,
  };

  const breakdown: MeteredBillingBreakdown = {
    actualCost,
    platformFee,
    ownerEarning,
    grossRefund,
  };

  try {
    await billingService.processHTTPEndpointBilling(billingInput, breakdown);
  } catch (err) {
    log.error('metered billing processing failed', {
      function: functionName,
      payer: paymentInfo.payer,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Credit owner earnings
  if (ownerEarning > 0n && dbFunction.owner_address) {
    try {
      await db.insertInto('earnings').values({
        owner_address: dbFunction.owner_address,
        function_name: functionName,
        amount: ownerEarning,
        source_tx_hash: paymentInfo.txHash || null,
      }).execute();
    } catch (err) {
      log.error('failed to credit metered earnings to function owner', {
        function: functionName,
        owner: dbFunction.owner_address,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Log invocation with billing details
  try {
    await createInvocation(db, {
      function_name: functionName,
      payer_address: paymentInfo.payer,
      amount_paid: paymentInfo.amount,
      tx_hash: paymentInfo.txHash || null,
      status_code: result.statusCode,
      success: result.success,
      duration_ms: 0n,
      actual_cloud_cost: billingInput.breakdown?.actualCloudCost ?? null,
      fee_amount: billingInput.breakdown?.feeAmount ?? null,
      refund_amount: billingInput.breakdown && billingInput.breakdown.grossRefund > 0n
        ? billingInput.breakdown.netRefund
        : null,
      refund_status: billingInput.refundStatus || null,
      refund_tx_hash: billingInput.refundTxHash ?? null,
    });
  } catch (err) {
    log.error('failed to log metered invocation with billing', {
      function: functionName,
      payer: paymentInfo.payer,
      txHash: paymentInfo.txHash,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const bd = billingDetailsFromBreakdown(billingInput);
  if (bd && refundAddress) {
    bd.refundAddress = refundAddress;
  }
  return bd;
}

// ---------------------------------------------------------------------------
// creditOwnerEarningsBilling (billing-aware path)
// ---------------------------------------------------------------------------

async function creditOwnerEarningsBilling(
  db: Kysely<Database>,
  config: Config,
  functionName: string,
  dbFunction: LambdaFunction | null,
  paymentInfo: PaymentInfo,
  billingInput: InvocationBilling,
): Promise<void> {
  if (!dbFunction || !dbFunction.owner_address || !billingInput.breakdown) {
    return;
  }

  let ownerRevenue = billingInput.breakdown.actualCloudCost + billingInput.breakdown.feeAmount;
  if (ownerRevenue > paymentInfo.amount) {
    ownerRevenue = paymentInfo.amount; // safety cap
  }

  const marketplaceFeeBps = dbFunction.marketplace_fee_bps ?? config.marketplaceFeeBps;
  const platformFee = ownerRevenue * BigInt(marketplaceFeeBps) / 10000n;
  const ownerEarning = ownerRevenue - platformFee;
  if (ownerEarning <= 0n) {
    return;
  }

  try {
    await db.insertInto('earnings').values({
      owner_address: dbFunction.owner_address,
      function_name: functionName,
      amount: ownerEarning,
      source_tx_hash: paymentInfo.txHash || null,
    }).execute();
  } catch (err) {
    log.error('failed to credit earnings to function owner', {
      function: functionName,
      owner: dbFunction.owner_address,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// logLegacyInvocation (no billing data)
// ---------------------------------------------------------------------------

async function logLegacyInvocation(
  db: Kysely<Database>,
  deps: InvokeDeps,
  functionName: string,
  dbFunction: LambdaFunction | null,
  paymentInfo: PaymentInfo,
  result: InvocationResult,
): Promise<null> {
  try {
    await createInvocation(db, {
      function_name: functionName,
      payer_address: paymentInfo.payer,
      amount_paid: paymentInfo.amount,
      tx_hash: paymentInfo.txHash || null,
      status_code: result.statusCode,
      success: result.success,
      duration_ms: BigInt(result.billedDurationMs),
    });
  } catch (err) {
    log.error('failed to log invocation', {
      function: functionName,
      payer: paymentInfo.payer,
      txHash: paymentInfo.txHash,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Credit earnings based on full payment amount (legacy behavior)
  await creditOwnerEarningsLegacy(
    db,
    deps.config,
    functionName,
    dbFunction,
    paymentInfo,
    result,
  );

  return null;
}

// ---------------------------------------------------------------------------
// creditOwnerEarningsLegacy (no billing data — uses full payment amount)
// ---------------------------------------------------------------------------

async function creditOwnerEarningsLegacy(
  db: Kysely<Database>,
  config: Config,
  functionName: string,
  dbFunction: LambdaFunction | null,
  paymentInfo: PaymentInfo,
  _result: InvocationResult,
): Promise<void> {
  if (!dbFunction || !dbFunction.owner_address) {
    return;
  }

  const marketplaceFeeBps = dbFunction.marketplace_fee_bps ?? config.marketplaceFeeBps;
  const feeAmount = paymentInfo.amount * BigInt(marketplaceFeeBps) / 10000n;
  const ownerEarning = paymentInfo.amount - feeAmount;
  if (ownerEarning <= 0n) {
    return;
  }

  try {
    await db.insertInto('earnings').values({
      owner_address: dbFunction.owner_address,
      function_name: functionName,
      amount: ownerEarning,
      source_tx_hash: paymentInfo.txHash || null,
    }).execute();
  } catch (err) {
    log.error('failed to credit earnings to function owner', {
      function: functionName,
      owner: dbFunction.owner_address,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
