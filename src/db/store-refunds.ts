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
 * Recover refunds stuck in 'pending' status without a tx_hash for > 10 minutes.
 * Marks them as 'failed' with an auto-recovery message.
 * Returns the number of rows recovered.
 */
export async function recoverStuckRefunds(
  db: Kysely<Database>,
): Promise<number> {
  const result = await sql`
    UPDATE refunds
    SET status = 'failed',
        error_message = 'stuck in pending - auto-recovered',
        completed_at = NOW()
    WHERE status = 'pending'
      AND refund_tx_hash IS NULL
      AND created_at < NOW() - INTERVAL '10 minutes'
  `.execute(db);

  return Number(result.numAffectedRows ?? 0);
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

/**
 * List refunds for a payer address, ordered by creation time descending.
 */
export async function listRefunds(
  db: Kysely<Database>,
  payerAddress: string,
  limit: number,
  offset: number,
): Promise<Refund[]> {
  return db
    .selectFrom("refunds")
    .selectAll()
    .where("payer_address", "=", payerAddress)
    .orderBy("created_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
}

/**
 * List pending refunds that have a tx_hash (sent but not yet confirmed).
 * Used for monitoring the refund pipeline.
 */
export async function listPendingRefunds(
  db: Kysely<Database>,
  limit: number,
): Promise<Refund[]> {
  return db
    .selectFrom("refunds")
    .selectAll()
    .where("status", "=", "pending")
    .where("refund_tx_hash", "is not", null)
    .orderBy("created_at", "asc")
    .limit(limit)
    .execute();
}

/**
 * List pending refunds WITHOUT a tx_hash that are older than the given
 * threshold in minutes. These are "stuck" refunds that were never sent
 * on-chain and need recovery.
 */
export async function listStuckPendingRefunds(
  db: Kysely<Database>,
  olderThanMinutes: number,
  limit: number,
): Promise<Refund[]> {
  const rows = await sql<Refund>`
    SELECT * FROM refunds
    WHERE status = 'pending'
      AND refund_tx_hash IS NULL
      AND created_at < NOW() - MAKE_INTERVAL(mins => ${olderThanMinutes})
    ORDER BY created_at ASC
    LIMIT ${limit}
  `.execute(db);

  return rows.rows;
}

/**
 * Count pending refunds without a tx_hash (stuck refunds).
 * Used as a Prometheus gauge for alerting.
 */
export async function countStuckPendingRefunds(
  db: Kysely<Database>,
): Promise<number> {
  const row = await sql<{ count: string }>`
    SELECT COUNT(*) AS count FROM refunds
    WHERE status = 'pending' AND refund_tx_hash IS NULL
  `.execute(db);

  return Number(row.rows[0]?.count ?? 0);
}

/**
 * Find pending refunds WITH a tx_hash that are older than the given threshold.
 * These may have been sent on-chain but never confirmed in the DB.
 * The recovery worker should re-check their receipt status.
 */
export async function listSentButUnconfirmedRefunds(
  db: Kysely<Database>,
  olderThanMinutes: number,
  limit: number,
): Promise<Refund[]> {
  const rows = await sql<Refund>`
    SELECT * FROM refunds
    WHERE status = 'pending'
      AND refund_tx_hash IS NOT NULL
      AND created_at < NOW() - MAKE_INTERVAL(mins => ${olderThanMinutes})
    ORDER BY created_at ASC
    LIMIT ${limit}
  `.execute(db);

  return rows.rows;
}
