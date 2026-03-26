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
import type { PricingEngine } from '../../pricing/engine.js';
import type { LambdaInvoker, InvocationResult } from '../../lambda/invoker.js';
import { getPaymentInfo } from '../middleware/mpp.js';
import { createBatchInvocation, updateBatchInvocation } from '../../db/store-batch.js';
import * as log from '../../logging/index.js';
import { applyToRequest, decrypt } from '../../endpoint-auth/index.js';
import { HttpError, errorResponse, ErrorCodes } from '../errors.js';
import { readJsonBody } from '../request-body.js';
import {
  assertFunctionInvocationAccess,
  resolveFunctionForRequest,
  type LambdaFunction,
} from '../function-registry.js';

export interface BatchDeps {
  db: Kysely<Database> | null;
  config: Config;
  pricingEngine: PricingEngine;
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

function formatUSD(atomicAmount: bigint): string {
  const dollars = Number(atomicAmount) / 1_000_000;
  if (Math.abs(dollars) < 0.01) {
    return `$${dollars.toFixed(4)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

function isHTTPEndpoint(arn: string): boolean {
  return arn.startsWith('https://');
}

// ---------------------------------------------------------------------------
// createBatchHandlers
// ---------------------------------------------------------------------------

export function createBatchHandlers(deps: BatchDeps) {
  const { db, config, pricingEngine, lambdaInvoker } = deps;

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
        return errorResponse(c, err.status, ErrorCodes.INTERNAL_ERROR, err.message, err.details);
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
        results[idx] = {
          index: idx,
          success: false,
          error: 'invocation failed',
        };
        failed++;
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

    // 10. Update batch record
    if (db && batchId) {
      try {
        let status = 'completed';
        if (failed > 0 && succeeded > 0) {
          status = 'partial_failure';
        } else if (failed > 0) {
          status = 'partial_failure';
        }
        await updateBatchInvocation(db, batchId, succeeded + failed, failed, status);
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
