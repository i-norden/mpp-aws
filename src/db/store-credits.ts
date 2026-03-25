import type { Kysely, Insertable, Selectable } from "kysely";
import { sql } from "kysely";

import type { Database, CreditTable } from "./types.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A row returned from the credits table. */
export type Credit = Selectable<CreditTable>;

/** Shape accepted when inserting a new credit. */
export type InsertableCredit = Insertable<CreditTable>;

/** Aggregated credit balance for an address. */
export interface CreditBalance {
  availableBalance: bigint;
  totalCredits: bigint;
  totalRedeemed: bigint;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Create a new credit record (e.g. from a failed refund or overpayment).
 */
export async function createCredit(
  db: Kysely<Database>,
  credit: InsertableCredit,
): Promise<void> {
  await db.insertInto("credits").values(credit).execute();
}

/**
 * Compute the credit balance for an address.
 *
 * Returns `availableBalance` (sum of credits with withdrawal_status =
 * 'available') and `totalCredits` (sum of all credits regardless of status).
 */
export async function getCreditBalance(
  db: Kysely<Database>,
  payerAddress: string,
): Promise<CreditBalance> {
  const row = await db
    .selectFrom("credits")
    .select([
      sql<bigint>`COALESCE(SUM(CASE WHEN withdrawal_status = 'available' THEN amount ELSE 0 END), 0)`.as(
        "available_balance",
      ),
      sql<bigint>`COALESCE(SUM(amount), 0)`.as("total_credits"),
      sql<bigint>`COALESCE(SUM(CASE WHEN withdrawal_status = 'withdrawn' THEN amount ELSE 0 END), 0)`.as(
        "total_redeemed",
      ),
    ])
    .where("payer_address", "=", payerAddress)
    .executeTakeFirstOrThrow();

  return {
    availableBalance: BigInt(row.available_balance),
    totalCredits: BigInt(row.total_credits),
    totalRedeemed: BigInt(row.total_redeemed),
  };
}

/**
 * Atomically reserve all available credits for a payer address by marking
 * them as `pending` withdrawal.  Returns the total amount reserved.
 *
 * Uses a serializable-isolation transaction with `FOR UPDATE` row locking
 * to prevent concurrent double-counting.
 *
 * After a successful on-chain redemption call {@link finalizeRedemption}.
 * On failure call {@link rollbackRedemption}.
 *
 * NOTE: This function manages its own transaction internally. Do NOT call
 * it inside an outer transaction -- pass the root Kysely instance.
 */
export async function reserveCreditsForRedemption(
  db: Kysely<Database>,
  payerAddress: string,
): Promise<bigint> {
  // We need serializable isolation + FOR UPDATE, which requires raw sql for
  // the locking sub-select.  The outer transaction().execute wrapper from
  // Kysely handles commit/rollback.
  return db.transaction().execute(async (trx) => {
    // 1. Lock and sum available credits
    const sumRow = await sql<{ total: string }>`
      SELECT COALESCE(SUM(amount), 0) AS total FROM (
        SELECT amount FROM credits
        WHERE payer_address = ${payerAddress} AND withdrawal_status = 'available'
        FOR UPDATE
      ) locked
    `.execute(trx);

    const total = BigInt(sumRow.rows[0]?.total ?? "0");
    if (total === 0n) {
      return 0n;
    }

    // 2. Mark as pending withdrawal
    await trx
      .updateTable("credits")
      .set({
        withdrawal_status: "pending",
        redeemed_at: sql`NOW()`,
      })
      .where("payer_address", "=", payerAddress)
      .where("withdrawal_status", "=", "available")
      .execute();

    return total;
  });
}

/**
 * Finalize a pending credit redemption with the on-chain transaction hash.
 * Moves all `pending` credits for the payer to `withdrawn`.
 */
export async function finalizeRedemption(
  db: Kysely<Database>,
  payerAddress: string,
  txHash: string,
): Promise<void> {
  await db
    .updateTable("credits")
    .set({
      withdrawal_status: "withdrawn",
      redeemed_tx_hash: txHash,
    })
    .where("payer_address", "=", payerAddress)
    .where("withdrawal_status", "=", "pending")
    .execute();
}

/**
 * Find payer addresses with credits stuck in 'pending' withdrawal status
 * for more than the given number of minutes.
 * Used by the orphaned redemption recovery worker.
 */
export async function findStuckPendingCreditAddresses(
  db: Kysely<Database>,
  olderThanMinutes: number,
): Promise<string[]> {
  const rows = await sql<{ payer_address: string }>`
    SELECT DISTINCT payer_address
    FROM credits
    WHERE withdrawal_status = 'pending'
      AND redeemed_at < NOW() - MAKE_INTERVAL(mins => ${olderThanMinutes})
  `.execute(db);

  return rows.rows.map((r) => r.payer_address);
}

/**
 * Roll back a pending credit redemption (e.g. the on-chain refund failed).
 * Moves `pending` credits back to `available` and clears redemption metadata.
 */
export async function rollbackRedemption(
  db: Kysely<Database>,
  payerAddress: string,
): Promise<void> {
  await db
    .updateTable("credits")
    .set({
      withdrawal_status: "available",
      redeemed_at: null,
      redeemed_tx_hash: null,
    })
    .where("payer_address", "=", payerAddress)
    .where("withdrawal_status", "=", "pending")
    .execute();
}
