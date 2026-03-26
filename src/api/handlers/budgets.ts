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
import { HttpError } from '../errors.js';
import { readJsonBody } from '../request-body.js';
import { jsonWithStatus } from '../response.js';

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
    c.res = c.json({
      error: 'authentication required',
      message: 'X-Wallet-Address, X-Wallet-Signature, and X-Wallet-Message headers are required',
      hint: "Sign a message in format 'open-compute:{address}:{timestamp}:{nonce}' with your wallet",
    }, 401);
    return null;
  }

  const result = await verifyAddressOwnershipWithReplay(db, signature, message, address);
  if (!result.valid) {
    c.res = jsonWithStatus(c, {
      error: 'authentication failed',
      message: result.errorMessage,
    }, result.statusCode ?? 401);
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
      return c.json({ error: 'payment info missing' }, 500);
    }

    // 2. Require database
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    // 3. Parse request body
    let req: CreateBudgetRequest;
    try {
      req = (await readJsonBody<CreateBudgetRequest>(c, { allowEmpty: true })) ?? {};
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonWithStatus(c, { error: err.message, details: err.details }, err.status);
      }
      throw err;
    }
    let requestedAmount: bigint;
    try {
      requestedAmount = parseRequestedBudgetAmount(req);
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonWithStatus(c, { error: err.message }, err.status);
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
      return c.json({
        error: 'payment amount mismatch',
        message: 'Budget payment amount no longer matches amount_atomic_usdc.',
      }, 400);
    }

    // Parse max_per_invocation
    let maxPerInvocation: bigint | null = null;
    if (req.max_per_invocation !== undefined && req.max_per_invocation !== null) {
      try {
        const parsed = BigInt(req.max_per_invocation);
        if (parsed <= 0n) {
          return c.json({
            error: 'max_per_invocation must be greater than 0',
          }, 400);
        }
        if (parsed > requestedAmount) {
          return c.json({
            error: 'max_per_invocation must not exceed amount_atomic_usdc',
          }, 400);
        }
        maxPerInvocation = parsed;
      } catch {
        return c.json({
          error: 'max_per_invocation must be a whole-number atomic USDC value',
        }, 400);
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
      return c.json({ error: 'failed to create budget' }, 500);
    }
  }

  // -------------------------------------------------------------------
  // handleGetBudget -- GET /budgets/:budgetId
  // -------------------------------------------------------------------

  async function handleGetBudget(c: Context): Promise<Response> {
    const budgetId = c.req.param('budgetId') ?? '';
    if (!budgetId) {
      return c.json({ error: 'budget ID is required' }, 400);
    }

    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
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
      return c.json({ error: 'failed to retrieve budget' }, 500);
    }

    if (!budget) {
      return c.json({ error: 'budget not found' }, 404);
    }

    // Verify ownership
    const verifiedAddr = await requireAddressOwnership(c, db);
    if (!verifiedAddr) {
      return c.res;
    }

    if (verifiedAddr !== budget.payer_address) {
      return c.json({ error: 'you do not own this budget' }, 403);
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
      return c.json({ error: 'database not configured' }, 503);
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
      return c.json({ error: 'failed to list budgets' }, 500);
    }
  }

  // -------------------------------------------------------------------
  // handleRevokeBudget -- DELETE /budgets/:budgetId
  // -------------------------------------------------------------------

  async function handleRevokeBudget(c: Context): Promise<Response> {
    const budgetId = c.req.param('budgetId') ?? '';
    if (!budgetId) {
      return c.json({ error: 'budget ID is required' }, 400);
    }

    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
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
      return c.json({ error: 'failed to retrieve budget' }, 500);
    }

    if (!existingBudget) {
      return c.json({ error: 'budget not found' }, 404);
    }

    if (verifiedAddr !== existingBudget.payer_address) {
      return c.json({ error: 'you do not own this budget' }, 403);
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
      return c.json({ error: 'failed to revoke budget' }, 500);
    }

    if (!revokedBudget) {
      return c.json({ error: 'budget not found or already revoked' }, 404);
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
