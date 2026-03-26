/**
 * Earnings DB operations.
 * TypeScript port of mmp-compute/lambda-proxy/internal/db/store_earnings.go
 *
 * All monetary amounts are in atomic USDC (6 decimals) represented as bigint.
 */

import type { Kysely, Insertable, Selectable } from 'kysely';
import { sql } from 'kysely';

import type { Database, EarningTable } from './types.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A row returned from the earnings table. */
export type Earning = Selectable<EarningTable>;

/** Shape accepted when inserting a new earning. */
export type InsertableEarning = Insertable<EarningTable>;

/** Aggregated earnings balance for an owner address. */
export interface EarningsBalance {
  ownerAddress: string;
  availableBalance: bigint;
  totalEarned: bigint;
  totalWithdrawn: bigint;
  earningCount: number;
}

/** Per-function earnings summary. */
export interface EarningsByFunction {
  functionName: string;
  totalEarned: bigint;
  availableBalance: bigint;
  invocationCount: number;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve the aggregated earnings balance for an owner address.
 */
export async function getEarningsBalance(
  db: Kysely<Database>,
  ownerAddress: string,
): Promise<EarningsBalance> {
  const row = await db
    .selectFrom('earnings')
    .select([
      sql<bigint>`COALESCE(SUM(CASE WHEN withdrawal_status = 'available' THEN amount ELSE 0 END), 0)`.as(
        'available_balance',
      ),
      sql<bigint>`COALESCE(SUM(amount), 0)`.as('total_earned'),
      sql<bigint>`COALESCE(SUM(CASE WHEN withdrawal_status = 'withdrawn' THEN amount ELSE 0 END), 0)`.as(
        'total_withdrawn',
      ),
      sql<bigint>`COUNT(*)`.as('earning_count'),
    ])
    .where('owner_address', '=', ownerAddress)
    .executeTakeFirstOrThrow();

  return {
    ownerAddress,
    availableBalance: BigInt(row.available_balance),
    totalEarned: BigInt(row.total_earned),
    totalWithdrawn: BigInt(row.total_withdrawn),
    earningCount: Number(row.earning_count),
  };
}

/**
 * List earnings history for an owner address.
 *
 * @param includeWithdrawn - When false, only returns earnings with withdrawal_status = 'available'.
 * @param limit - Max rows to return (default 100, max 1000).
 * @param offset - Pagination offset (default 0).
 */
export async function listEarnings(
  db: Kysely<Database>,
  ownerAddress: string,
  includeWithdrawn: boolean,
  limit = 100,
  offset = 0,
): Promise<Earning[]> {
  const clampedLimit = Math.min(Math.max(limit, 1), 1000);

  let query = db
    .selectFrom('earnings')
    .selectAll()
    .where('owner_address', '=', ownerAddress)
    .orderBy('created_at', 'desc')
    .limit(clampedLimit)
    .offset(offset);

  if (!includeWithdrawn) {
    query = query.where('withdrawal_status', '=', 'available');
  }

  return query.execute();
}

/**
 * Retrieve earnings summary grouped by function for an owner.
 */
export async function getEarningsByFunction(
  db: Kysely<Database>,
  ownerAddress: string,
): Promise<EarningsByFunction[]> {
  const rows = await db
    .selectFrom('earnings')
    .select([
      'function_name',
      sql<bigint>`SUM(amount)`.as('total_earned'),
      sql<bigint>`SUM(CASE WHEN withdrawal_status = 'available' THEN amount ELSE 0 END)`.as(
        'available_balance',
      ),
      sql<bigint>`COUNT(*)`.as('invocation_count'),
    ])
    .where('owner_address', '=', ownerAddress)
    .groupBy('function_name')
    .orderBy(sql`SUM(amount)`, 'desc')
    .execute();

  return rows.map((r) => ({
    functionName: r.function_name,
    totalEarned: BigInt(r.total_earned),
    availableBalance: BigInt(r.available_balance),
    invocationCount: Number(r.invocation_count),
  }));
}

/**
 * Create a new earnings record.
 */
export async function createEarning(
  db: Kysely<Database>,
  earning: InsertableEarning,
): Promise<void> {
  await db.insertInto('earnings').values(earning).execute();
}

/**
 * Atomically reserve all available earnings for an owner address by marking
 * them as `pending` withdrawal. Returns the total amount reserved.
 *
 * Uses a serializable-isolation transaction with `FOR UPDATE` row locking
 * to prevent concurrent double-counting.
 *
 * After a successful on-chain withdrawal call {@link finalizeEarningsWithdrawal}.
 * On failure call {@link rollbackEarningsWithdrawal}.
 *
 * NOTE: This function manages its own transaction internally. Do NOT call
 * it inside an outer transaction -- pass the root Kysely instance.
 */
export async function reserveEarningsForWithdrawal(
  db: Kysely<Database>,
  ownerAddress: string,
): Promise<bigint> {
  return db.transaction().execute(async (trx) => {
    // 1. Lock and sum available earnings
    const sumRow = await sql<{ total: string }>`
      SELECT COALESCE(SUM(amount), 0) AS total FROM (
        SELECT amount FROM earnings
        WHERE owner_address = ${ownerAddress} AND withdrawal_status = 'available'
        FOR UPDATE
      ) locked
    `.execute(trx);

    const total = BigInt(sumRow.rows[0]?.total ?? '0');
    if (total === 0n) {
      return 0n;
    }

    // 2. Mark as pending withdrawal
    await trx
      .updateTable('earnings')
      .set({
        withdrawal_status: 'pending',
        withdrawn_at: sql`NOW()`,
      })
      .where('owner_address', '=', ownerAddress)
      .where('withdrawal_status', '=', 'available')
      .execute();

    return total;
  });
}

/**
 * Finalize a pending earnings withdrawal with the on-chain transaction hash.
 * Moves all `pending` earnings for the owner to `withdrawn`.
 */
export async function finalizeEarningsWithdrawal(
  db: Kysely<Database>,
  ownerAddress: string,
  txHash: string,
): Promise<void> {
  await db
    .updateTable('earnings')
    .set({
      withdrawal_status: 'withdrawn',
      withdrawn_tx_hash: txHash,
    })
    .where('owner_address', '=', ownerAddress)
    .where('withdrawal_status', '=', 'pending')
    .execute();
}

/**
 * Find owner addresses with earnings stuck in 'pending' withdrawal status
 * for more than the given number of minutes.
 * Used by the orphaned redemption recovery worker.
 */
export async function findStuckPendingEarningsAddresses(
  db: Kysely<Database>,
  olderThanMinutes: number,
): Promise<string[]> {
  const rows = await sql<{ owner_address: string }>`
    SELECT DISTINCT owner_address
    FROM earnings
    WHERE withdrawal_status = 'pending'
      AND withdrawn_at < NOW() - MAKE_INTERVAL(mins => ${olderThanMinutes})
  `.execute(db);

  return rows.rows.map((r) => r.owner_address);
}

/**
 * Roll back a pending earnings withdrawal (e.g. the on-chain refund failed).
 * Moves `pending` earnings back to `available` and clears withdrawal metadata.
 */
export async function rollbackEarningsWithdrawal(
  db: Kysely<Database>,
  ownerAddress: string,
): Promise<void> {
  await db
    .updateTable('earnings')
    .set({
      withdrawal_status: 'available',
      withdrawn_at: null,
      withdrawn_tx_hash: null,
    })
    .where('owner_address', '=', ownerAddress)
    .where('withdrawal_status', '=', 'pending')
    .execute();
}
