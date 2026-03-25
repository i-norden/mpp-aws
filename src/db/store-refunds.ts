import type { Kysely, Insertable, Selectable } from "kysely";
import { sql } from "kysely";

import type { Database, RefundTable } from "./types.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A row returned from the refunds table. */
export type Refund = Selectable<RefundTable>;

/** Shape accepted when inserting a new refund. */
export type InsertableRefund = Insertable<RefundTable>;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Create a new refund record and return the auto-generated id.
 */
export async function createRefund(
  db: Kysely<Database>,
  refund: InsertableRefund,
): Promise<number> {
  const result = await db
    .insertInto("refunds")
    .values(refund)
    .returning("id")
    .executeTakeFirstOrThrow();

  return Number(result.id);
}

/**
 * Atomically insert a refund only if no success/pending refund already exists
 * for the same `source_tx_hash`.  Relies on the partial UNIQUE index
 * `refunds(source_tx_hash) WHERE status IN ('success','pending')`.
 *
 * Returns `{ created: true, id }` when a new row was inserted, or
 * `{ created: false, id: 0 }` when skipped due to conflict.
 */
export async function createRefundIfNotExists(
  db: Kysely<Database>,
  refund: InsertableRefund,
): Promise<{ created: boolean; id: number }> {
  // ON CONFLICT ... DO NOTHING means RETURNING yields no rows when the
  // conflict fires.  executeTakeFirst() returns undefined in that case.
  const result = await db
    .insertInto("refunds")
    .values(refund)
    .onConflict((oc) =>
      oc
        .column("source_tx_hash")
        .where("status", "in", ["success", "pending"])
        .doNothing(),
    )
    .returning("id")
    .executeTakeFirst();

  if (result === undefined) {
    return { created: false, id: 0 };
  }

  return { created: true, id: Number(result.id) };
}

/**
 * Update the status, tx hash, error message, and gas used for a refund.
 * Sets `completed_at` to the current time.
 */
export async function updateRefundStatus(
  db: Kysely<Database>,
  refundId: number,
  status: string,
  txHash: string,
  errorMsg: string,
  gasUsed: bigint,
): Promise<void> {
  await db
    .updateTable("refunds")
    .set({
      status,
      refund_tx_hash: txHash || null,
      error_message: errorMsg || null,
      gas_used: gasUsed > 0n ? gasUsed : null,
      completed_at: sql`NOW()`,
    })
    .where("id", "=", BigInt(refundId))
    .execute();
}

/**
 * Retrieve a successful or pending refund by its source transaction hash.
 * Used for idempotency: if a refund already exists for this source tx, skip
 * re-sending.
 *
 * Returns `null` when no matching refund exists.
 */
export async function getRefundBySourceTxHash(
  db: Kysely<Database>,
  sourceTxHash: string,
): Promise<Refund | null> {
  const row = await db
    .selectFrom("refunds")
    .selectAll()
    .where("source_tx_hash", "=", sourceTxHash)
    .where("status", "in", ["success", "pending"])
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();

  return row ?? null;
}
