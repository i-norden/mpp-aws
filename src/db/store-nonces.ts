import type { Kysely, Insertable, Selectable } from "kysely";
import { sql } from "kysely";

import type { Database, PaymentNonceTable } from "./types.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A row returned from the payment_nonces table. */
export type PaymentNonce = Selectable<PaymentNonceTable>;

/** Shape accepted when inserting a new payment nonce. */
export type InsertablePaymentNonce = Insertable<PaymentNonceTable>;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Atomically reserve a payment nonce.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING so that a nonce can only ever be
 * reserved once (double-spend prevention).
 *
 * Returns `{ id, reserved: true }` when the nonce was freshly inserted, or
 * `{ id: 0, reserved: false }` when a row with the same nonce already exists.
 */
export async function tryReservePaymentNonce(
  db: Kysely<Database>,
  nonce: InsertablePaymentNonce,
): Promise<{ id: number; reserved: boolean }> {
  // We use a raw CTE so the atomicity guarantee mirrors the Go implementation:
  // a single round-trip INSERT ... ON CONFLICT DO NOTHING ... RETURNING id,
  // then a COALESCE+EXISTS check to report whether the row was actually
  // inserted.
  const result = await sql<{ id: string; reserved: boolean }>`
    WITH ins AS (
      INSERT INTO payment_nonces (nonce, payer_address, amount, resource, status, expires_at)
      VALUES (${nonce.nonce}, ${nonce.payer_address}, ${nonce.amount}, ${nonce.resource}, 'pending', ${nonce.expires_at})
      ON CONFLICT (nonce) DO NOTHING
      RETURNING id
    )
    SELECT COALESCE((SELECT id FROM ins), 0) AS id,
           EXISTS(SELECT 1 FROM ins)        AS reserved
  `.execute(db);

  const row = result.rows[0];
  return {
    id: Number(row?.id ?? 0),
    reserved: row?.reserved ?? false,
  };
}

/**
 * Update the status and optional tx_hash of a payment nonce.
 */
export async function updatePaymentNonceStatus(
  db: Kysely<Database>,
  nonce: string,
  status: string,
  txHash: string,
): Promise<void> {
  await db
    .updateTable("payment_nonces")
    .set({
      status,
      tx_hash: txHash || null,
    })
    .where("nonce", "=", nonce)
    .execute();
}

/**
 * Delete expired payment nonces and return the number of rows removed.
 *
 * Should be called periodically to keep the table from growing indefinitely.
 * Reserved-but-never-settled nonces (from crashes or network failures) are
 * safely cleaned up after their expiration window.
 */
export async function cleanupExpiredNonces(
  db: Kysely<Database>,
): Promise<number> {
  const result = await db
    .deleteFrom("payment_nonces")
    .where("expires_at", "<", sql<Date>`NOW()`)
    .executeTakeFirst();

  return Number(result.numDeletedRows);
}
