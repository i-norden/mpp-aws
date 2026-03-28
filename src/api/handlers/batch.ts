/**
 * Batch invocation handler.
 * TypeScript port of mmp-compute/lambda-proxy/internal/api/handlers_batch.go
 *
 * Endpoints:
 *   POST /invoke/:function/batch - submit multiple invocations at once
 *
 * The batch handler fans out individual invocations with bounded concurrency,
 * collects results, and returns a summary.
 */

import type { Context } from 'hono';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import type { Config } from '../../config/index.js';
import type { BillingService, InvocationBilling } from '../../billing/service.js';
import type { PricingEngine } from '../../pricing/engine.js';
import type { LambdaInvoker, InvocationResult } from '../../lambda/invoker.js';
import { getPaymentInfo } from '../middleware/mpp.js';
import { createInvocation } from '../../db/store-invocations.js';
import { createBatchInvocation, updateBatchInvocation } from '../../db/store-batch.js';
import * as log from '../../logging/index.js';
import * as metrics from '../../metrics/index.js';
import { applyToRequest, decrypt } from '../../endpoint-auth/index.js';
import { HttpError, errorCodeForStatus, errorResponse, ErrorCodes } from '../errors.js';
import { readJsonBody } from '../request-body.js';
import {
  assertFunctionInvocationAccess,
  resolveFunctionForRequest,
  type LambdaFunction,
} from '../function-registry.js';
import { isHTTPEndpoint } from '../../invocation/settlement.js';

export interface BatchDeps {
  db: Kysely<Database> | null;
  config: Config;
  pricingEngine: PricingEngine;
  billingService: BillingService | null;
  lambdaInvoker: LambdaInvoker | null;
}

interface BatchInvokeRequest {
  inputs: unknown[];
  concurrency?: number;
}

interface BatchItemResult {
  index: number;
  success: boolean;
  statusCode?: number;
  body?: unknown;
  error?: string;
}

interface BatchExecutionRecord {
  result: InvocationResult;
  actualCloudCost: bigint | null;
  feeAmount: bigint | null;
  grossRefund: bigint;
  ownerEarning: bigint;
  memoryMB: number;
  billedDurationMs: bigint;
}

function formatUSD(atomicAmount: bigint): string {
  const dollars = Number(atomicAmount) / 1_000_000;
  if (Math.abs(dollars) < 0.01) {
    return `$${dollars.toFixed(4)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// createBatchHandlers
// ---------------------------------------------------------------------------

export function createBatchHandlers(deps: BatchDeps) {
  const { db, config, pricingEngine, billingService, lambdaInvoker } = deps;

  // -------------------------------------------------------------------
  // getInvokeAmountForSingleItem (mirrors Go's GetInvokeAmount)
  // -------------------------------------------------------------------

  async function getInvokeAmountForSingleItem(c: Context): Promise<bigint> {
    const resolved = await resolveFunctionForRequest(
      db,
      config,
      pricingEngine,
      c.req.param('function') ?? '',
    );
    return resolved.amount;
  }

  // -------------------------------------------------------------------
  // getBatchInvokeAmount
  // -------------------------------------------------------------------

  async function getBatchInvokeAmount(c: Context): Promise<bigint> {
    const perItem = await getInvokeAmountForSingleItem(c);
    const req = await readJsonBody<BatchInvokeRequest>(c);
    if (!Array.isArray(req.inputs) || req.inputs.length === 0 || req.inputs.length > 100) {
      throw new HttpError(400, 'inputs must contain 1-100 items');
    }
    return perItem * BigInt(req.inputs.length);
  }

  // -------------------------------------------------------------------
  // getBatchInvokeDescription
  // -------------------------------------------------------------------

  function getBatchInvokeDescription(c: Context): string {
    const functionName = c.req.param('function') ?? 'unknown';
    return `Batch invocation: ${functionName}`;
  }

  // -------------------------------------------------------------------
  // handleBatchInvoke -- POST /invoke/:function/batch
  // -------------------------------------------------------------------

  async function handleBatchInvoke(c: Context): Promise<Response> {
    let dbFunction: LambdaFunction | null = null;
    let functionName = '';
    let perItemAmount = 0n;
    try {
      const resolved = await resolveFunctionForRequest(
        db,
        config,
        pricingEngine,
        c.req.param('function') ?? '',
      );
      functionName = resolved.functionName;
      dbFunction = resolved.dbFunction;
      perItemAmount = resolved.amount;
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(c, err.status, errorCodeForStatus(err.status), err.message, err.details);
      }
      throw err;
    }

    // 3. Get payment info
    const paymentInfo = getPaymentInfo(c);
    if (!paymentInfo) {
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'payment info missing');
    }

    // 4. Parse request body
    const req = await readJsonBody<BatchInvokeRequest>(c);
    if (!Array.isArray(req.inputs) || req.inputs.length === 0 || req.inputs.length > 100) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'inputs must contain 1-100 items');
    }

    // 5. Access control check for private functions
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

    const expectedAmount = perItemAmount * BigInt(req.inputs.length);
    if (paymentInfo.amount !== expectedAmount) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'Batch payment amount no longer matches the exact request size.');
    }

    // 6. Reject insecure HTTP endpoints
    const isHTTP = dbFunction !== null && isHTTPEndpoint(dbFunction.function_arn);
    if (dbFunction && dbFunction.function_arn.startsWith('http://') && !dbFunction.function_arn.startsWith('https://')) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'Plain HTTP endpoints are not supported. Use HTTPS.');
    }

    // 7. Determine concurrency
    let concurrency = req.concurrency ?? 10;
    if (concurrency <= 0) concurrency = 10;
    if (concurrency > 50) concurrency = 50;

    // 8. Create batch record
    let batchId = '';
    if (db) {
      try {
        const batchRecord = await createBatchInvocation(db, {
          functionName,
          payerAddress: paymentInfo.payer,
          txHash: paymentInfo.txHash,
          totalItems: req.inputs.length,
          amountPaid: paymentInfo.amount,
        });
        batchId = batchRecord.id;
      } catch (err) {
        log.error('failed to create batch invocation record', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 9. Invoke with bounded concurrency
    if (!lambdaInvoker) {
      return c.json({
        success: false,
        error: 'Lambda invoker not configured',
      }, 503);
    }

    const results: BatchItemResult[] = new Array(req.inputs.length);
    const executionRecords: BatchExecutionRecord[] = new Array(req.inputs.length);
    let succeeded = 0;
    let failed = 0;

    let endpointURL = dbFunction?.function_arn ?? '';
    let endpointAuthHeaders: Record<string, string> | undefined;
    if (isHTTP && dbFunction?.endpoint_auth_encrypted && config.endpointAuthKey) {
      try {
        const auth = decrypt(dbFunction.endpoint_auth_encrypted, config.endpointAuthKey);
        const applied = applyToRequest(auth, endpointURL);
        endpointURL = applied.url;
        endpointAuthHeaders = applied.headers;
      } catch (err) {
        log.error('failed to decrypt endpoint auth for batch invocation', {
          function: functionName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const inFlight = new Set<Promise<void>>();

    async function processItem(idx: number, payload: unknown): Promise<void> {
      const input = payload ?? {};
      const invokeStarted = Date.now();
      let result: InvocationResult;

      try {
        if (isHTTP && dbFunction) {
          const timeoutSeconds = Math.min(
            Math.max(dbFunction.timeout_seconds, 1),
            300,
          );
          result = await lambdaInvoker!.invokeHTTPEndpoint(
            endpointURL,
            input,
            timeoutSeconds,
            endpointAuthHeaders,
          );
        } else {
          const lambdaTarget = dbFunction?.function_arn ?? functionName;
          result = await lambdaInvoker!.invoke(lambdaTarget, input);
        }

        executionRecords[idx] = toExecutionRecord(result);

        let responseBody: unknown;
        try {
          responseBody = JSON.parse(result.body);
        } catch {
          responseBody = result.body || undefined;
        }

        results[idx] = {
          index: idx,
          success: result.success,
          statusCode: result.statusCode,
          body: responseBody,
          error: result.error,
        };

        if (result.success) {
          succeeded++;
        } else {
          failed++;
        }
      } catch (err) {
        result = {
          statusCode: 500,
          body: '',
          success: false,
          billedDurationMs: 0,
          memoryMB: dbFunction?.memory_mb ?? 0,
          error: err instanceof Error ? err.message : 'invocation failed',
        };
        executionRecords[idx] = toExecutionRecord(result);
        results[idx] = {
          index: idx,
          success: false,
          statusCode: 500,
          error: result.error,
        };
        failed++;
      } finally {
        metrics.recordInvocation(
          functionName,
          executionRecords[idx]?.result.success ?? false,
          (Date.now() - invokeStarted) / 1000,
          perItemAmount,
        );
      }
    }

    // Fan out with bounded concurrency.
    for (let i = 0; i < req.inputs.length; i++) {
      const promise = processItem(i, req.inputs[i]).finally(() => {
        inFlight.delete(promise);
      });
      inFlight.add(promise);

      if (inFlight.size >= concurrency) {
        await Promise.race(inFlight);
      }
    }

    // Wait for all remaining
    await Promise.allSettled(Array.from(inFlight));

    let batchBillingInput: InvocationBilling | null = null;
    if (db && dbFunction) {
      if (canUsePreciseBatchBilling(dbFunction, isHTTP, executionRecords)) {
        const pricedRecords = executionRecords.map((record) =>
          priceExecutionRecord(record, dbFunction, perItemAmount, pricingEngine, config, isHTTP),
        );

        const totalActualCloudCost = sumBigInt(pricedRecords.map((record) => record.actualCloudCost ?? 0n));
        const totalFeeAmount = sumBigInt(pricedRecords.map((record) => record.feeAmount ?? 0n));
        const totalGrossRefund = sumBigInt(pricedRecords.map((record) => record.grossRefund));
        const totalOwnerEarning = sumBigInt(pricedRecords.map((record) => record.ownerEarning));

        if (billingService) {
          batchBillingInput = {
            payerAddress: paymentInfo.payer,
            sourceTxHash: paymentInfo.txHash,
            amountPaid: paymentInfo.amount,
            memoryMB: 0,
            billedDurationMs: 0n,
            refundStatus: 'none',
            creditBalance: 0n,
            breakdown: {
              actualCloudCost: totalActualCloudCost,
              feeAmount: totalFeeAmount,
              feePercentage: totalActualCloudCost > 0n
                ? totalFeeAmount * 100n / totalActualCloudCost
                : 0n,
              grossRefund: totalGrossRefund,
              gasCost: 0n,
              netRefund: 0n,
              refundEligible: false,
              creditAmount: 0n,
            },
          };

          try {
            await billingService.processCalculatedBilling(batchBillingInput);
          } catch (err) {
            log.error('batch billing processing failed', {
              function: functionName,
              payer: paymentInfo.payer,
              txHash: paymentInfo.txHash,
              error: err instanceof Error ? err.message : String(err),
            });
            batchBillingInput = null;
          }
        }

        await creditBatchOwnerEarnings(
          db,
          functionName,
          dbFunction.owner_address,
          totalOwnerEarning,
          paymentInfo.txHash,
        );

        const recordedRefundAmount = getRecordedRefundAmount(batchBillingInput);
        const refundShares = distributeAmount(
          pricedRecords.map((record) => record.grossRefund),
          recordedRefundAmount,
        );

        await Promise.allSettled(pricedRecords.map((record, idx) =>
          createInvocation(db, {
            function_name: functionName,
            payer_address: paymentInfo.payer,
            amount_paid: perItemAmount,
            tx_hash: paymentInfo.txHash || null,
            status_code: record.result.statusCode,
            success: record.result.success,
            duration_ms: record.billedDurationMs,
            billed_duration_ms: record.billedDurationMs,
            memory_mb: record.memoryMB,
            actual_cloud_cost: record.actualCloudCost,
            fee_amount: record.feeAmount,
            refund_amount: refundShares[idx] > 0n ? refundShares[idx] : null,
            refund_status: batchBillingInput?.refundStatus ?? null,
            refund_tx_hash: batchBillingInput?.refundTxHash ?? null,
          }).catch((err) => {
            log.error('failed to log batch invocation item', {
              function: functionName,
              payer: paymentInfo.payer,
              txHash: paymentInfo.txHash,
              index: idx,
              error: err instanceof Error ? err.message : String(err),
            });
          }),
        ));
      } else {
        const totalOwnerEarning = calculateLegacyBatchOwnerEarning(dbFunction, perItemAmount, req.inputs.length, config);
        await creditBatchOwnerEarnings(
          db,
          functionName,
          dbFunction.owner_address,
          totalOwnerEarning,
          paymentInfo.txHash,
        );

        await Promise.allSettled(executionRecords.map((record, idx) =>
          createInvocation(db, {
            function_name: functionName,
            payer_address: paymentInfo.payer,
            amount_paid: perItemAmount,
            tx_hash: paymentInfo.txHash || null,
            status_code: record.result.statusCode,
            success: record.result.success,
            duration_ms: record.billedDurationMs,
            billed_duration_ms: record.billedDurationMs,
            memory_mb: record.memoryMB > 0 ? record.memoryMB : dbFunction.memory_mb,
          }).catch((err) => {
            log.error('failed to log legacy batch invocation item', {
              function: functionName,
              payer: paymentInfo.payer,
              txHash: paymentInfo.txHash,
              index: idx,
              error: err instanceof Error ? err.message : String(err),
            });
          }),
        ));
      }
    }

    // 10. Update batch record
    if (db && batchId) {
      try {
        let status = 'completed';
        if (failed > 0 && succeeded > 0) {
          status = 'partial_failure';
        } else if (failed > 0) {
          status = 'partial_failure';
        }
        await updateBatchInvocation(db, batchId, {
          completed: succeeded + failed,
          failed,
          status,
          actualCloudCost: batchBillingInput?.breakdown?.actualCloudCost ?? null,
          feeAmount: batchBillingInput?.breakdown?.feeAmount ?? null,
          refundAmount: getRecordedRefundAmount(batchBillingInput) || null,
          refundStatus: batchBillingInput?.refundStatus ?? null,
          refundTxHash: batchBillingInput?.refundTxHash ?? null,
        });
      } catch (err) {
        log.error('failed to update batch invocation', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json({
      results,
      summary: {
        total: req.inputs.length,
        succeeded,
        failed,
      },
      billing: batchBillingInput
        ? {
            actualCloudCost: String(batchBillingInput.breakdown?.actualCloudCost ?? 0n),
            feeAmount: String(batchBillingInput.breakdown?.feeAmount ?? 0n),
            refundAmount: String(getRecordedRefundAmount(batchBillingInput)),
            refundStatus: batchBillingInput.refundStatus,
            refundTxHash: batchBillingInput.refundTxHash,
          }
        : undefined,
      txHash: paymentInfo.txHash,
      cost: formatUSD(paymentInfo.amount),
    }, 200);
  }

  return {
    getBatchInvokeAmount,
    getBatchInvokeDescription,
    handleBatchInvoke,
  };
}

function toExecutionRecord(result: InvocationResult): BatchExecutionRecord {
  return {
    result,
    actualCloudCost: null,
    feeAmount: null,
    grossRefund: 0n,
    ownerEarning: 0n,
    memoryMB: result.memoryMB || 0,
    billedDurationMs: BigInt(result.billedDurationMs || 0),
  };
}

function canUsePreciseBatchBilling(
  dbFunction: LambdaFunction,
  isHTTP: boolean,
  records: BatchExecutionRecord[],
): boolean {
  if (records.some((record) => record === undefined)) {
    return false;
  }

  if (isHTTP) {
    return dbFunction.pricing_model === 'metered';
  }

  return records.every((record) => record.result.billedDurationMs > 0);
}

function priceExecutionRecord(
  record: BatchExecutionRecord,
  dbFunction: LambdaFunction,
  perItemAmount: bigint,
  pricingEngine: PricingEngine,
  config: Config,
  isHTTP: boolean,
): BatchExecutionRecord {
  if (isHTTP) {
    const ceiling = BigInt(dbFunction.custom_base_fee ?? perItemAmount);
    let actualCost = ceiling;
    const costStr = record.result.responseHeaders?.['X-Actual-Cost'];
    if (costStr) {
      try {
        const parsed = BigInt(costStr);
        if (parsed >= 0n) {
          actualCost = parsed;
        }
      } catch {
        log.warn('invalid X-Actual-Cost header from upstream during batch billing', {
          function: dbFunction.function_name,
          value: costStr,
        });
      }
    }
    if (actualCost > ceiling) {
      actualCost = ceiling;
    }

    const marketplaceFeeBps = dbFunction.marketplace_fee_bps ?? config.marketplaceFeeBps;
    const feeAmount = actualCost * BigInt(marketplaceFeeBps) / 10000n;
    const ownerEarning = actualCost - feeAmount;
    const grossRefund = perItemAmount > actualCost ? perItemAmount - actualCost : 0n;

    return {
      ...record,
      actualCloudCost: actualCost,
      feeAmount,
      grossRefund,
      ownerEarning,
      memoryMB: 0,
      billedDurationMs: 0n,
    };
  }

  const breakdown = pricingEngine.calculateBillingBreakdown(
    perItemAmount,
    dbFunction.memory_mb,
    record.billedDurationMs,
  );

  const marketplaceFeeBps = dbFunction.marketplace_fee_bps ?? config.marketplaceFeeBps;
  const ownerRevenue = breakdown.actualCloudCost + breakdown.feeAmount;
  const marketplaceFee = ownerRevenue * BigInt(marketplaceFeeBps) / 10000n;
  const ownerEarning = ownerRevenue - marketplaceFee;

  return {
    ...record,
    actualCloudCost: breakdown.actualCloudCost,
    feeAmount: breakdown.feeAmount,
    grossRefund: breakdown.grossRefund,
    ownerEarning: ownerEarning > 0n ? ownerEarning : 0n,
    memoryMB: record.memoryMB > 0 ? record.memoryMB : dbFunction.memory_mb,
  };
}

function calculateLegacyBatchOwnerEarning(
  dbFunction: LambdaFunction,
  perItemAmount: bigint,
  itemCount: number,
  config: Config,
): bigint {
  if (!dbFunction.owner_address) {
    return 0n;
  }

  const totalAmount = perItemAmount * BigInt(itemCount);
  const marketplaceFeeBps = dbFunction.marketplace_fee_bps ?? config.marketplaceFeeBps;
  const marketplaceFee = totalAmount * BigInt(marketplaceFeeBps) / 10000n;
  const ownerEarning = totalAmount - marketplaceFee;
  return ownerEarning > 0n ? ownerEarning : 0n;
}

async function creditBatchOwnerEarnings(
  db: Kysely<Database>,
  functionName: string,
  ownerAddress: string | null,
  amount: bigint,
  txHash: string,
): Promise<void> {
  if (!ownerAddress || amount <= 0n) {
    return;
  }

  try {
    await db.insertInto('earnings').values({
      owner_address: ownerAddress,
      function_name: functionName,
      amount,
      source_tx_hash: txHash || null,
    }).execute();
  } catch (err) {
    log.error('failed to credit batch earnings to function owner', {
      function: functionName,
      owner: ownerAddress,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function getRecordedRefundAmount(billingInput: InvocationBilling | null): bigint {
  if (!billingInput?.breakdown || billingInput.breakdown.grossRefund <= 0n) {
    return 0n;
  }

  if (billingInput.refundStatus === 'credited' || billingInput.refundStatus === 'failed') {
    return billingInput.breakdown.grossRefund;
  }

  return billingInput.breakdown.netRefund;
}

function distributeAmount(weights: bigint[], total: bigint): bigint[] {
  if (total <= 0n) {
    return weights.map(() => 0n);
  }

  const totalWeight = sumBigInt(weights);
  if (totalWeight <= 0n) {
    return weights.map(() => 0n);
  }

  const shares = weights.map((weight) => total * weight / totalWeight);
  let assigned = sumBigInt(shares);
  if (assigned === total) {
    return shares;
  }

  const richestIndex = weights.reduce((bestIdx, weight, idx) =>
    weight > weights[bestIdx] ? idx : bestIdx, 0);
  shares[richestIndex] += total - assigned;
  assigned = sumBigInt(shares);
  if (assigned > total) {
    shares[richestIndex] -= assigned - total;
  }
  return shares;
}

function sumBigInt(values: bigint[]): bigint {
  return values.reduce((sum, value) => sum + value, 0n);
}
