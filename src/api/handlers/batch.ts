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
import type { Selectable } from 'kysely';
import type { Database, LambdaFunctionTable } from '../../db/types.js';
import type { Config } from '../../config/index.js';
import type { PricingEngine } from '../../pricing/engine.js';
import type { LambdaInvoker, InvocationResult } from '../../lambda/invoker.js';
import { getPaymentInfo } from '../middleware/mpp.js';
import { getFunction } from '../../db/store-functions.js';
import { createBatchInvocation, updateBatchInvocation } from '../../db/store-batch.js';
import * as log from '../../logging/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LambdaFunction = Selectable<LambdaFunctionTable>;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Matches Go's safeFunctionNamePattern. */
const SAFE_FUNCTION_NAME_RE = /^[a-zA-Z0-9_-]{1,170}$/;

function normalizeFunctionName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (!SAFE_FUNCTION_NAME_RE.test(trimmed)) return '';
  return trimmed.toLowerCase();
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
// Function cache (shared with invoke handler pattern)
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

// ---------------------------------------------------------------------------
// createBatchHandlers
// ---------------------------------------------------------------------------

export function createBatchHandlers(deps: BatchDeps) {
  const { db, config, pricingEngine, lambdaInvoker } = deps;

  // -------------------------------------------------------------------
  // getInvokeAmountForSingleItem (mirrors Go's GetInvokeAmount)
  // -------------------------------------------------------------------

  function getInvokeAmountForSingleItem(c: Context): bigint {
    const rawName = c.req.param('function') ?? '';
    if (!rawName) {
      return pricingEngine.calculateInvocationCost(128, 1000);
    }

    const functionName = normalizeFunctionName(rawName);
    if (!functionName) {
      return pricingEngine.calculateInvocationCost(128, 1000);
    }

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

    return pricingEngine.calculateInvocationCost(128, 1000);
  }

  // -------------------------------------------------------------------
  // getBatchInvokeAmount
  // -------------------------------------------------------------------

  function getBatchInvokeAmount(c: Context): bigint {
    const perItem = getInvokeAmountForSingleItem(c);

    // Attempt to peek at the request body to count actual inputs.
    // In the Hono framework we cannot easily peek at the body synchronously
    // (it is consumed on read), so we use the X-Batch-Size header hint or
    // fall back to a 10-item estimate -- matching the Go fallback behaviour.
    const batchSizeHeader = c.req.header('X-Batch-Size');
    if (batchSizeHeader) {
      const parsed = parseInt(batchSizeHeader, 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) {
        return perItem * BigInt(parsed);
      }
    }

    // Fallback estimate: 10 items (matches Go's fallback when body parsing fails)
    return perItem * 10n;
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
    // 1. Validate and normalize function name
    const rawName = c.req.param('function') ?? '';
    if (!rawName) {
      return c.json({ error: 'function name is required' }, 400);
    }

    const functionName = normalizeFunctionName(rawName);
    if (!functionName) {
      return c.json({ error: 'invalid function name' }, 400);
    }

    // 2. Look up function in DB (whitelist enforcement)
    let dbFunction: LambdaFunction | null = null;

    if (db) {
      dbFunction = getCachedFunction(functionName);
      if (!dbFunction) {
        try {
          dbFunction = await getFunction(db, functionName);
          if (dbFunction) {
            const ttl = config.functionCacheTTLSeconds > 0 ? config.functionCacheTTLSeconds : 60;
            setCachedFunction(functionName, dbFunction, ttl);
          }
        } catch (err) {
          log.error('database error looking up function for batch', {
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
          message: 'This function is not available for invocation.',
        }, 403);
      }
    } else if (config.enforceWhitelist) {
      return c.json({
        error: 'function not registered',
        function: functionName,
        message: 'This function is not available for invocation.',
      }, 403);
    }

    // 3. Get payment info
    const paymentInfo = getPaymentInfo(c);
    if (!paymentInfo) {
      return c.json({ error: 'payment info missing' }, 500);
    }

    // 4. Parse request body
    let req: BatchInvokeRequest;
    try {
      req = await c.req.json() as BatchInvokeRequest;
    } catch {
      return c.json({ error: 'invalid request body' }, 400);
    }

    if (!req.inputs || !Array.isArray(req.inputs) || req.inputs.length === 0 || req.inputs.length > 100) {
      return c.json({ error: 'inputs must contain 1-100 items' }, 400);
    }

    // 5. Access control check for private functions
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
          log.error('failed to check access authorization for batch', {
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

    // 6. Reject insecure HTTP endpoints
    const isHTTP = dbFunction !== null && isHTTPEndpoint(dbFunction.function_arn);
    if (dbFunction && dbFunction.function_arn.startsWith('http://') && !dbFunction.function_arn.startsWith('https://')) {
      return c.json({
        error: 'insecure_endpoint',
        message: 'Plain HTTP endpoints are not supported. Use HTTPS.',
      }, 400);
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

    // Semaphore-based bounded concurrency using a simple pool
    const pool: Promise<void>[] = [];

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
            dbFunction.function_arn,
            input,
            timeoutSeconds,
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

    // Fan out with bounded concurrency
    for (let i = 0; i < req.inputs.length; i++) {
      const promise = processItem(i, req.inputs[i]);
      pool.push(promise);

      if (pool.length >= concurrency) {
        // Wait for at least one to finish before starting the next
        await Promise.race(pool);
        // Remove settled promises
        for (let j = pool.length - 1; j >= 0; j--) {
          // Check if settled by racing against an immediately-resolved promise
          const settled = await Promise.race([
            pool[j].then(() => true),
            Promise.resolve(false),
          ]);
          if (settled) {
            pool.splice(j, 1);
          }
        }
      }
    }

    // Wait for all remaining
    await Promise.allSettled(pool);

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
