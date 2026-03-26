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
import { verifyAddressOwnership } from '../../auth/signature.js';
import {
  createBudget,
  getBudget,
  listBudgetsByAddress,
  revokeBudget,
} from '../../db/store-budgets.js';
import * as log from '../../logging/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BudgetsDeps {
  db: Kysely<Database> | null;
  config: Config;
}

interface CreateBudgetRequest {
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
): Promise<string | null> {
  const address = c.req.header('X-Wallet-Address') ?? '';
  const signature = c.req.header('X-Wallet-Signature') ?? c.req.header('X-Signature') ?? '';
  const message = c.req.header('X-Wallet-Message') ?? c.req.header('X-Message') ?? '';

  if (!address || !signature || !message) {
    c.res = c.json({
      error: 'authentication required',
      message: 'X-Wallet-Address, X-Wallet-Signature, and X-Wallet-Message headers are required',
      hint: "Sign a message in format 'open-compute:{address}:{timestamp}:{nonce}' with your wallet",
    }, 401) as unknown as Response;
    return null;
  }

  const result = await verifyAddressOwnership(signature, message, address);
  if (!result.valid) {
    c.res = c.json({
      error: 'authentication failed',
      message: result.errorMessage,
    }, 401) as unknown as Response;
    return null;
  }

  return result.address;
}

// ---------------------------------------------------------------------------
// createBudgetsHandlers
// ---------------------------------------------------------------------------

export function createBudgetsHandlers(deps: BudgetsDeps) {
  const { db, config } = deps;

  // -------------------------------------------------------------------
  // getBudgetAmount
  // -------------------------------------------------------------------

  function getBudgetAmount(_c: Context): bigint {
    // Minimum budget: $0.10 (100_000 atomic USDC)
    // The actual budget balance is whatever the caller pays.
    return 100_000n;
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

    // 3. Parse request body (tolerate empty body)
    let req: CreateBudgetRequest = {};
    try {
      req = await c.req.json() as CreateBudgetRequest;
    } catch {
      // Empty body or invalid JSON -- use defaults
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

    // Parse max_per_invocation
    let maxPerInvocation: bigint | null = null;
    if (req.max_per_invocation !== undefined && req.max_per_invocation !== null) {
      try {
        const parsed = BigInt(req.max_per_invocation);
        if (parsed > 0n) {
          maxPerInvocation = parsed;
        }
      } catch {
        // Ignore invalid max_per_invocation
      }
    }

    // 4. Create the budget
    try {
      const budgetRecord = await createBudget(db, {
        payerAddress: paymentInfo.payer,
        txHash: paymentInfo.txHash,
        totalAmount: paymentInfo.amount,
        remainingAmount: paymentInfo.amount,
        expiresAt,
        allowedFunctions: req.allowed_functions?.length ? req.allowed_functions : null,
        maxPerInvocation,
      });

      return c.json({
        budgetId: budgetRecord.id,
        totalAmount: Number(paymentInfo.amount),
        remainingAmount: Number(paymentInfo.amount),
        expiresAt: expiresAt.toISOString(),
        allowedFunctions: req.allowed_functions ?? null,
        totalUSD: formatUSD(paymentInfo.amount),
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
    const verifiedAddr = await requireAddressOwnership(c);
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
    // Verify ownership first (like the Go handler)
    const verifiedAddr = await requireAddressOwnership(c);
    if (!verifiedAddr) {
      return c.res;
    }

    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
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
    const verifiedAddr = await requireAddressOwnership(c);
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
      remainingAmount: Number(revokedBudget.remaining_amount),
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
