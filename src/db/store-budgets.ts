/**
 * Budget DB operations.
 * TypeScript port of mmp-compute/lambda-proxy/internal/db/store_budgets.go
 *
 * Manages pre-authorized spending budgets: create, get, list, deduct,
 * credit, revoke, expire, and transaction logging.
 */

import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';

import type { Database, BudgetTable, BudgetTransactionTable } from './types.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A row returned from the budgets table. */
export type Budget = Selectable<BudgetTable>;

/** A row returned from the budget_transactions table. */
export type BudgetTransaction = Selectable<BudgetTransactionTable>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a budget does not have sufficient remaining balance. */
export class InsufficientBudgetError extends Error {
  constructor() {
    super('insufficient budget balance');
    this.name = 'InsufficientBudgetError';
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Create a new budget and return the generated id, created_at, and updated_at.
 */
export async function createBudget(
  db: Kysely<Database>,
  budget: {
    payerAddress: string;
    txHash: string;
    totalAmount: bigint;
    remainingAmount: bigint;
    expiresAt: Date | string;
    allowedFunctions?: string[] | null;
    maxPerInvocation?: bigint | null;
  },
): Promise<{ id: string; createdAt: Date; updatedAt: Date }> {
  const result = await db
    .insertInto('budgets')
    .values({
      payer_address: budget.payerAddress,
      tx_hash: budget.txHash,
      total_amount: budget.totalAmount,
      remaining_amount: budget.remainingAmount,
      expires_at: budget.expiresAt instanceof Date ? budget.expiresAt.toISOString() : budget.expiresAt,
      allowed_functions: budget.allowedFunctions ?? null,
      max_per_invocation: budget.maxPerInvocation ?? null,
    })
    .returning(['id', 'created_at', 'updated_at'])
    .executeTakeFirstOrThrow();

  return {
    id: String(result.id),
    createdAt: new Date(result.created_at),
    updatedAt: new Date(result.updated_at),
  };
}

/**
 * Retrieve a budget by ID.
 * Returns null when no matching record exists.
 */
export async function getBudget(
  db: Kysely<Database>,
  budgetId: string,
): Promise<Budget | null> {
  const row = await db
    .selectFrom('budgets')
    .selectAll()
    .where('id', '=', budgetId)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * List budgets for a payer address, ordered by creation time descending.
 */
export async function listBudgetsByAddress(
  db: Kysely<Database>,
  payerAddress: string,
  limit: number,
): Promise<Budget[]> {
  return db
    .selectFrom('budgets')
    .selectAll()
    .where('payer_address', '=', payerAddress)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
}

/**
 * Atomically deduct an amount from a budget within a single transaction.
 *
 * The deduction only succeeds if:
 *   - The budget is active and not expired
 *   - The remaining_amount is sufficient
 *   - The amount does not exceed max_per_invocation (if set)
 *   - The function is in allowed_functions (if set)
 *
 * A budget_transaction record is logged within the same transaction.
 * If the budget is exhausted (remaining = 0) the status is updated to 'exhausted'.
 *
 * @returns The remaining amount after deduction.
 * @throws {InsufficientBudgetError} If constraints are violated or budget not found.
 */
export async function deductBudget(
  db: Kysely<Database>,
  budgetId: string,
  amount: bigint,
  functionName: string,
): Promise<bigint> {
  return db.transaction().execute(async (trx) => {
    // Atomically deduct and enforce all constraints via SQL WHERE clauses.
    // The conditions mirror the Go implementation:
    //   - status = 'active'
    //   - expires_at > NOW()
    //   - remaining_amount >= amount
    //   - max_per_invocation IS NULL OR amount <= max_per_invocation
    //   - allowed_functions IS NULL OR functionName = ANY(allowed_functions)
    const updateResult = await sql<{ remaining_amount: string }>`
      UPDATE budgets
      SET remaining_amount = remaining_amount - ${amount},
          updated_at = NOW()
      WHERE id = ${budgetId}
        AND status = 'active'
        AND expires_at > NOW()
        AND remaining_amount >= ${amount}
        AND (max_per_invocation IS NULL OR ${amount} <= max_per_invocation)
        AND (allowed_functions IS NULL OR ${functionName} = ANY(allowed_functions))
      RETURNING remaining_amount
    `.execute(trx);

    if (updateResult.rows.length === 0) {
      throw new InsufficientBudgetError();
    }

    const remaining = BigInt(updateResult.rows[0].remaining_amount);

    // Log the budget transaction within the same transaction
    await trx
      .insertInto('budget_transactions')
      .values({
        budget_id: budgetId,
        function_name: functionName,
        amount,
      })
      .execute();

    // If budget is now exhausted, update status
    if (remaining === 0n) {
      await sql`
        UPDATE budgets SET status = 'exhausted', updated_at = NOW()
        WHERE id = ${budgetId}
      `.execute(trx);
    }

    return remaining;
  });
}

/**
 * Credit (add back) an amount to a budget, capped at the original total_amount.
 * Used for metered refunds when actual cost is less than estimated.
 *
 * Reactivates exhausted budgets if the credit brings the balance above zero.
 */
export async function creditBudget(
  db: Kysely<Database>,
  budgetId: string,
  amount: bigint,
): Promise<void> {
  await sql`
    UPDATE budgets
    SET remaining_amount = LEAST(remaining_amount + ${amount}, total_amount),
        status = CASE
          WHEN remaining_amount + ${amount} > 0 AND status = 'exhausted'
          THEN 'active'
          ELSE status
        END,
        updated_at = NOW()
    WHERE id = ${budgetId}
      AND status IN ('active', 'exhausted')
  `.execute(db);
}

/**
 * Revoke a budget (set status to 'revoked').
 * Only active budgets can be revoked.
 *
 * Returns the revoked budget row, or null if the budget was not found or
 * already revoked/expired.
 */
export async function revokeBudget(
  db: Kysely<Database>,
  budgetId: string,
): Promise<Budget | null> {
  const result = await sql<Budget>`
    UPDATE budgets
    SET status = 'revoked', updated_at = NOW()
    WHERE id = ${budgetId} AND status = 'active'
    RETURNING *
  `.execute(db);

  return result.rows[0] ?? null;
}

/**
 * Mark expired active budgets as 'expired'.
 * Returns the number of budgets expired.
 */
export async function expireBudgets(
  db: Kysely<Database>,
): Promise<number> {
  const result = await sql`
    UPDATE budgets SET status = 'expired', updated_at = NOW()
    WHERE status = 'active' AND expires_at < NOW()
  `.execute(db);

  return Number(result.numAffectedRows ?? 0);
}

/**
 * List transactions for a budget, ordered by creation time descending.
 */
export async function listBudgetTransactions(
  db: Kysely<Database>,
  budgetId: string,
  limit: number,
): Promise<BudgetTransaction[]> {
  return db
    .selectFrom('budget_transactions')
    .selectAll()
    .where('budget_id', '=', budgetId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
}
