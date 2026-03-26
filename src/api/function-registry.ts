import type { Kysely, Selectable } from 'kysely';

import type { Database, LambdaFunctionTable } from '../db/types.js';
import type { Config } from '../config/index.js';
import type { PricingEngine } from '../pricing/engine.js';
import { getFunction } from '../db/store-functions.js';
import { HttpError } from './errors.js';

export type LambdaFunction = Selectable<LambdaFunctionTable>;

const SAFE_FUNCTION_NAME_RE = /^[a-zA-Z0-9_-]{1,170}$/;

interface CachedFunction {
  fn: LambdaFunction;
  expiresAt: number;
}

const functionCache = new Map<string, CachedFunction>();

export function normalizeFunctionName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (!SAFE_FUNCTION_NAME_RE.test(trimmed)) return '';
  return trimmed.toLowerCase();
}

export function calculateFunctionPrice(
  pricingEngine: PricingEngine,
  fn: LambdaFunction | null,
): bigint {
  if (!fn) {
    return pricingEngine.calculateInvocationCost(128, 1000);
  }

  if (fn.custom_base_fee !== null && fn.custom_base_fee !== undefined) {
    return BigInt(fn.custom_base_fee);
  }

  return pricingEngine.calculateInvocationCost(
    fn.memory_mb,
    fn.estimated_duration_ms,
  );
}

export async function resolveFunctionForRequest(
  db: Kysely<Database> | null,
  config: Config,
  pricingEngine: PricingEngine,
  rawName: string,
  options?: { requireRegistered?: boolean },
): Promise<{ functionName: string; dbFunction: LambdaFunction | null; amount: bigint }> {
  if (!rawName) {
    throw new HttpError(400, 'function name is required');
  }

  const functionName = normalizeFunctionName(rawName);
  if (!functionName) {
    throw new HttpError(
      400,
      'Function names must contain only alphanumeric characters, hyphens, and underscores',
    );
  }

  const requireRegistered = options?.requireRegistered ?? false;

  let dbFunction: LambdaFunction | null = null;
  if (db) {
    dbFunction = getCachedFunction(functionName);
    if (!dbFunction) {
      try {
        dbFunction = await getFunction(db, functionName);
      } catch (err) {
        throw new HttpError(
          503,
          'Unable to look up function. Please try again later.',
          err instanceof Error ? err.message : String(err),
        );
      }

      if (dbFunction) {
        const ttl = config.functionCacheTTLSeconds > 0
          ? config.functionCacheTTLSeconds
          : 60;
        setCachedFunction(functionName, dbFunction, ttl);
      }
    }
  }

  if (!dbFunction && (requireRegistered || config.enforceWhitelist)) {
    throw new HttpError(
      403,
      'This function is not available for invocation. Contact the administrator to register it.',
    );
  }

  return {
    functionName,
    dbFunction,
    amount: calculateFunctionPrice(pricingEngine, dbFunction),
  };
}

export async function assertFunctionInvocationAccess(
  db: Kysely<Database> | null,
  functionName: string,
  dbFunction: LambdaFunction | null,
  payerAddress: string,
): Promise<void> {
  if (!dbFunction || dbFunction.visibility !== 'private') {
    return;
  }

  const isOwner = dbFunction.owner_address !== null &&
    dbFunction.owner_address !== undefined &&
    dbFunction.owner_address.toLowerCase() === payerAddress.toLowerCase();

  if (isOwner) {
    return;
  }

  if (!db) {
    throw new HttpError(
      403,
      'This function is private. You are not authorized to invoke it.',
    );
  }

  try {
    const accessRow = await db
      .selectFrom('function_access_list')
      .select('id')
      .where('function_name', '=', functionName)
      .where('invoker_address', '=', payerAddress.toLowerCase())
      .executeTakeFirst();

    if (!accessRow) {
      throw new HttpError(
        403,
        'This function is private. You are not authorized to invoke it.',
      );
    }
  } catch (err) {
    if (err instanceof HttpError) {
      throw err;
    }

    throw new HttpError(
      500,
      'failed to verify access authorization',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function invalidateFunctionCache(name: string): void {
  functionCache.delete(name);
}

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

function setCachedFunction(
  name: string,
  fn: LambdaFunction,
  ttlSeconds: number,
): void {
  functionCache.set(name, {
    fn,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}
