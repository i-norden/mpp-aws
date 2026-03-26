/**
 * Budget handlers.
 * TypeScript port of mmp-compute/lambda-proxy/internal/api/handlers_budgets.go
 *
 * Endpoints:
 *   POST   /budgets             - create a pre-authorized spending budget (MPP payment)
 *   GET    /budgets             - list budgets for a payer address (auth required)
 *   GET    /budgets/:budgetId   - get budget details (auth required)
 *   DELETE /budgets/:budgetId   - revoke a budget (auth required)
 *
 * Budget creation requires MPP payment (the payment amount becomes the budget
 * balance). All other endpoints require wallet signature authentication.
 */

import type { Context } from 'hono';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import type { Config } from '../../config/index.js';
import { getPaymentInfo } from '../middleware/mpp.js';
import { verifyAddressOwnershipWithReplay } from '../../auth/signature.js';
import {
  createBudget,
  getBudget,
  listBudgetsByAddress,
  revokeBudget,
} from '../../db/store-budgets.js';
import * as log from '../../logging/index.js';
import { HttpError, errorResponse, ErrorCodes } from '../errors.js';
import { readJsonBody } from '../request-body.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BudgetsDeps {
  db: Kysely<Database> | null;
  config: Config;
}

interface CreateBudgetRequest {
  amount_atomic_usdc?: number | string;
  expires_in_hours?: number;
  allowed_functions?: string[];
  max_per_invocation?: number | string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUSD(atomicAmount: bigint): string {
  const dollars = Number(atomicAmount) / 1_000_000;
  if (Math.abs(dollars) < 0.01) {
    return `$${dollars.toFixed(4)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Auth helper (mirrors Go's requireAddressOwnership)
// ---------------------------------------------------------------------------

/**
 * Verify that the request is authenticated by the address owner using
 * wallet signature headers. Returns the verified lowercase address on
 * success, or null on failure (error response written to context).
 */
async function requireAddressOwnership(
  c: Context,
  db: Kysely<Database>,
): Promise<string | null> {
  const address = c.req.header('X-Wallet-Address') ?? '';
  const signature = c.req.header('X-Wallet-Signature') ?? c.req.header('X-Signature') ?? '';
  const message = c.req.header('X-Wallet-Message') ?? c.req.header('X-Message') ?? '';

  if (!address || !signature || !message) {
    c.res = errorResponse(c, 401, ErrorCodes.AUTHENTICATION_REQUIRED, 'X-Wallet-Address, X-Wallet-Signature, and X-Wallet-Message headers are required', "Sign a message in format 'open-compute:{address}:{timestamp}:{nonce}' with your wallet");
    return null;
  }

  const result = await verifyAddressOwnershipWithReplay(db, signature, message, address);
  if (!result.valid) {
    c.res = errorResponse(c, result.statusCode ?? 401, ErrorCodes.AUTHENTICATION_FAILED, result.errorMessage ?? 'authentication failed');
    return null;
  }

  return result.address;
}

// ---------------------------------------------------------------------------
// createBudgetsHandlers
// ---------------------------------------------------------------------------

export function createBudgetsHandlers(deps: BudgetsDeps) {
  const { db, config } = deps;
  const minimumBudgetAmount = 100_000n;

  function parseRequestedBudgetAmount(req: CreateBudgetRequest): bigint {
    if (req.amount_atomic_usdc === undefined || req.amount_atomic_usdc === null) {
      throw new HttpError(400, 'amount_atomic_usdc is required');
    }

    let parsed: bigint;
    try {
      parsed = BigInt(req.amount_atomic_usdc);
    } catch {
      throw new HttpError(400, 'amount_atomic_usdc must be a whole-number atomic USDC value');
    }

    if (parsed < minimumBudgetAmount) {
      throw new HttpError(
        400,
        `amount_atomic_usdc must be at least ${minimumBudgetAmount.toString()}`,
      );
    }

    if (parsed > config.budgetMaxAmount) {
      throw new HttpError(
        400,
        `amount_atomic_usdc must not exceed ${config.budgetMaxAmount.toString()}`,
      );
    }

    return parsed;
  }

  // -------------------------------------------------------------------
  // getBudgetAmount
  // -------------------------------------------------------------------

  async function getBudgetAmount(c: Context): Promise<bigint> {
    const req = await readJsonBody<CreateBudgetRequest>(c);
    return parseRequestedBudgetAmount(req);
  }

  // -------------------------------------------------------------------
  // getBudgetDescription
  // -------------------------------------------------------------------

  function getBudgetDescription(_c: Context): string {
    return 'Pre-authorized compute budget';
  }

  // -------------------------------------------------------------------
  // handleCreateBudget -- POST /budgets
  // -------------------------------------------------------------------

  async function handleCreateBudget(c: Context): Promise<Response> {
    // 1. Require payment info
    const paymentInfo = getPaymentInfo(c);
    if (!paymentInfo) {
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'payment info missing');
    }

    // 2. Require database
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    // 3. Parse request body
    let req: CreateBudgetRequest;
    try {
      req = (await readJsonBody<CreateBudgetRequest>(c, { allowEmpty: true })) ?? {};
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(c, err.status, ErrorCodes.INVALID_REQUEST, err.message, err.details);
      }
      throw err;
    }
    let requestedAmount: bigint;
    try {
      requestedAmount = parseRequestedBudgetAmount(req);
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(c, err.status, ErrorCodes.INVALID_REQUEST, err.message);
      }
      throw err;
    }

    let expiresInHours = req.expires_in_hours ?? 24;
    if (expiresInHours <= 0) {
      expiresInHours = 24;
    }
    const maxTTL = config.budgetMaxTTLHours;
    if (maxTTL > 0 && expiresInHours > maxTTL) {
      expiresInHours = maxTTL;
    }

    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    if (paymentInfo.amount !== requestedAmount) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'Budget payment amount no longer matches amount_atomic_usdc.');
    }

    // Parse max_per_invocation
    let maxPerInvocation: bigint | null = null;
    if (req.max_per_invocation !== undefined && req.max_per_invocation !== null) {
      try {
        const parsed = BigInt(req.max_per_invocation);
        if (parsed <= 0n) {
          return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'max_per_invocation must be greater than 0');
        }
        if (parsed > requestedAmount) {
          return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'max_per_invocation must not exceed amount_atomic_usdc');
        }
        maxPerInvocation = parsed;
      } catch {
        return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'max_per_invocation must be a whole-number atomic USDC value');
      }
    }

    // 4. Create the budget
    try {
      const budgetRecord = await createBudget(db, {
        payerAddress: paymentInfo.payer,
        txHash: paymentInfo.txHash,
        totalAmount: requestedAmount,
        remainingAmount: requestedAmount,
        expiresAt,
        allowedFunctions: req.allowed_functions?.length ? req.allowed_functions : null,
        maxPerInvocation,
      });

      return c.json({
        budgetId: budgetRecord.id,
        totalAmount: requestedAmount,
        remainingAmount: requestedAmount,
        expiresAt: expiresAt.toISOString(),
        allowedFunctions: req.allowed_functions ?? null,
        totalUSD: formatUSD(requestedAmount),
      }, 201);
    } catch (err) {
      log.error('failed to create budget', {
        payer: paymentInfo.payer,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to create budget');
    }
  }

  // -------------------------------------------------------------------
  // handleGetBudget -- GET /budgets/:budgetId
  // -------------------------------------------------------------------

  async function handleGetBudget(c: Context): Promise<Response> {
    const budgetId = c.req.param('budgetId') ?? '';
    if (!budgetId) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'budget ID is required');
    }

    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    // Retrieve the budget
    let budget;
    try {
      budget = await getBudget(db, budgetId);
    } catch (err) {
      log.error('failed to get budget', {
        budgetId,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to retrieve budget');
    }

    if (!budget) {
      return errorResponse(c, 404, ErrorCodes.NOT_FOUND, 'budget not found');
    }

    // Verify ownership
    const verifiedAddr = await requireAddressOwnership(c, db);
    if (!verifiedAddr) {
      return c.res;
    }

    if (verifiedAddr !== budget.payer_address) {
      return errorResponse(c, 403, ErrorCodes.FORBIDDEN, 'you do not own this budget');
    }

    return c.json({
      budget,
      remainingUSD: formatUSD(BigInt(budget.remaining_amount)),
    }, 200);
  }

  // -------------------------------------------------------------------
  // handleListBudgets -- GET /budgets
  // -------------------------------------------------------------------

  async function handleListBudgets(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    const verifiedAddr = await requireAddressOwnership(c, db);
    if (!verifiedAddr) {
      return c.res;
    }

    let limit = 50;
    const limitStr = c.req.query('limit');
    if (limitStr) {
      const parsed = parseInt(limitStr, 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) {
        limit = parsed;
      }
    }

    try {
      const budgets = await listBudgetsByAddress(db, verifiedAddr, limit);
      return c.json({
        budgets,
        total: budgets.length,
      }, 200);
    } catch (err) {
      log.error('failed to list budgets', {
        payer: verifiedAddr,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list budgets');
    }
  }

  // -------------------------------------------------------------------
  // handleRevokeBudget -- DELETE /budgets/:budgetId
  // -------------------------------------------------------------------

  async function handleRevokeBudget(c: Context): Promise<Response> {
    const budgetId = c.req.param('budgetId') ?? '';
    if (!budgetId) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'budget ID is required');
    }

    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    // Verify ownership before revoking
    const verifiedAddr = await requireAddressOwnership(c, db);
    if (!verifiedAddr) {
      return c.res;
    }

    // Fetch budget to check ownership
    let existingBudget;
    try {
      existingBudget = await getBudget(db, budgetId);
    } catch (err) {
      log.error('failed to get budget for revocation', {
        budgetId,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to retrieve budget');
    }

    if (!existingBudget) {
      return errorResponse(c, 404, ErrorCodes.NOT_FOUND, 'budget not found');
    }

    if (verifiedAddr !== existingBudget.payer_address) {
      return errorResponse(c, 403, ErrorCodes.FORBIDDEN, 'you do not own this budget');
    }

    // Revoke the budget
    let revokedBudget;
    try {
      revokedBudget = await revokeBudget(db, budgetId);
    } catch (err) {
      log.error('failed to revoke budget', {
        budgetId,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to revoke budget');
    }

    if (!revokedBudget) {
      return errorResponse(c, 404, ErrorCodes.NOT_FOUND, 'budget not found or already revoked');
    }

    return c.json({
      revoked: true,
      remainingAmount: BigInt(revokedBudget.remaining_amount),
      remainingUSD: formatUSD(BigInt(revokedBudget.remaining_amount)),
    }, 200);
  }

  return {
    getBudgetAmount,
    getBudgetDescription,
    handleCreateBudget,
    handleListBudgets,
    handleGetBudget,
    handleRevokeBudget,
  };
}
