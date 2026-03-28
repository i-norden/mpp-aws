/**
 * Voucher redemption DB operations.
 * TypeScript port of mmp-compute/lambda-proxy/internal/db/store_vouchers.go
 *
 * Manages promotional voucher redemptions: check, create, update, and list.
 */

import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';

import type { Database, VoucherRedemptionTable } from './types.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A row returned from the voucher_redemptions table. */
export type VoucherRedemption = Selectable<VoucherRedemptionTable>;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a voucher has already been redeemed.
 */
export async function isVoucherRedeemed(
  db: Kysely<Database>,
  voucherId: string,
): Promise<boolean> {
  const row = await sql<{ count: string }>`
    SELECT COUNT(*) AS count FROM voucher_redemptions WHERE voucher_id = ${voucherId}
  `.execute(db);

  return Number(row.rows[0]?.count ?? 0) > 0;
}

/**
 * Create a voucher redemption record and return the auto-generated id.
 */
export async function createVoucherRedemption(
  db: Kysely<Database>,
  redemption: {
    voucherId: string;
    source: string;
    payerAddress: string;
    amount: bigint;
    issuedAt: Date | string;
    expiresAt: Date | string;
    status?: string;
  },
): Promise<bigint> {
  const result = await db
    .insertInto('voucher_redemptions')
    .values({
      voucher_id: redemption.voucherId,
      source: redemption.source,
      payer_address: redemption.payerAddress,
      amount: redemption.amount,
      issued_at: redemption.issuedAt,
      expires_at: redemption.expiresAt,
      status: redemption.status ?? 'issued',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return result.id;
}

/**
 * Atomically create a voucher redemption only if it doesn't already exist.
 * Uses `ON CONFLICT (voucher_id) DO NOTHING`.
 *
 * Returns `{ created: true, id }` when the row was inserted, or
 * `{ created: false, id: 0n }` when the voucher was already redeemed.
 */
export async function tryCreateVoucherRedemption(
  db: Kysely<Database>,
  redemption: {
    voucherId: string;
    source: string;
    payerAddress: string;
    amount: bigint;
    issuedAt: Date | string;
    expiresAt: Date | string;
    status?: string;
  },
): Promise<{ created: boolean; id: bigint }> {
  const result = await db
    .insertInto('voucher_redemptions')
    .values({
      voucher_id: redemption.voucherId,
      source: redemption.source,
      payer_address: redemption.payerAddress,
      amount: redemption.amount,
      issued_at: redemption.issuedAt,
      expires_at: redemption.expiresAt,
      status: redemption.status ?? 'issued',
    })
    .onConflict((oc) => oc.column('voucher_id').doNothing())
    .returning('id')
    .executeTakeFirst();

  if (result === undefined) {
    return { created: false, id: 0n };
  }

  return { created: true, id: result.id };
}

/**
 * Update the status and optional refund tx hash of a voucher redemption.
 */
export async function updateVoucherRedemptionStatus(
  db: Kysely<Database>,
  voucherId: string,
  status: string,
  refundTxHash?: string,
): Promise<void> {
  await db
    .updateTable('voucher_redemptions')
    .set({
      status,
      refund_tx_hash: refundTxHash || null,
      redeemed_at: status === 'success' || status === 'failed' ? sql`NOW()` : null,
    })
    .where('voucher_id', '=', voucherId)
    .execute();
}

/**
 * Atomically claim an issued voucher for a specific payer.
 * Returns the claimed row, or null when the voucher is missing, expired, or not claimable.
 */
export async function claimVoucherRedemption(
  db: Kysely<Database>,
  voucherId: string,
  payerAddress: string,
): Promise<VoucherRedemption | null> {
  const row = await db
    .updateTable('voucher_redemptions')
    .set({
      payer_address: payerAddress,
      status: 'pending',
      redeemed_at: null,
    })
    .where('voucher_id', '=', voucherId)
    .where('status', '=', 'issued')
    .where('expires_at', '>', sql<Date>`NOW()`)
    .returningAll()
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Retrieve a voucher redemption by voucher ID.
 * Returns null when not found.
 */
export async function getVoucherRedemption(
  db: Kysely<Database>,
  voucherId: string,
): Promise<VoucherRedemption | null> {
  const row = await db
    .selectFrom('voucher_redemptions')
    .selectAll()
    .where('voucher_id', '=', voucherId)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * List voucher redemptions with a given status, ordered by creation time.
 */
export async function listVoucherRedemptions(
  db: Kysely<Database>,
  status: string,
  limit: number,
): Promise<VoucherRedemption[]> {
  return db
    .selectFrom('voucher_redemptions')
    .selectAll()
    .where('status', '=', status)
    .orderBy(sql`COALESCE(redeemed_at, issued_at)`, 'desc')
    .limit(limit)
    .execute();
}

/**
 * List expired but unredeemed vouchers (for cleanup).
 */
export async function listExpiredVouchers(
  db: Kysely<Database>,
  limit: number,
): Promise<VoucherRedemption[]> {
  const rows = await sql<VoucherRedemption>`
    SELECT * FROM voucher_redemptions
    WHERE status IN ('issued', 'pending') AND expires_at < NOW()
    ORDER BY expires_at ASC
    LIMIT ${limit}
  `.execute(db);

  return rows.rows;
}

/**
 * Mark expired pending vouchers as 'failed'.
 * Returns the number of vouchers expired.
 */
export async function expireVouchers(
  db: Kysely<Database>,
): Promise<number> {
  const result = await sql`
    UPDATE voucher_redemptions
    SET status = 'failed',
        redeemed_at = NOW()
    WHERE status IN ('issued', 'pending') AND expires_at < NOW()
  `.execute(db);

  return Number(result.numAffectedRows ?? 0);
}
