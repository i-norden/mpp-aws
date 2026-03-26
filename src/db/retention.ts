/**
 * Data retention engine — batched cleanup of old records.
 * TypeScript port of mmp-compute/lambda-proxy/internal/db/retention.go
 *
 * Processes each table independently so partial failures don't block
 * cleanup of other tables. Uses batched deletes (via ctid subquery)
 * to avoid long-running locks.
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetentionConfig {
  invocationRetentionDays: number;
  nonceRetentionDays: number;
  creditRetentionDays: number;
  voucherRetentionDays: number;
  leaseAnonymizeDays: number;
  batchSize: number;
}

export interface RetentionResult {
  invocationsDeleted: number;
  noncesDeleted: number;
  creditsDeleted: number;
  vouchersDeleted: number;
  leasesAnonymized: number;
}

export function defaultRetentionConfig(): RetentionConfig {
  return {
    invocationRetentionDays: 365,
    nonceRetentionDays: 90,
    creditRetentionDays: 365,
    voucherRetentionDays: 365,
    leaseAnonymizeDays: 90,
    batchSize: 1000,
  };
}

// ---------------------------------------------------------------------------
// Allowlists — prevent SQL injection in dynamic table/column names
// ---------------------------------------------------------------------------

const ALLOWED_TABLES = new Set([
  'lambda_invocations',
  'payment_nonces',
  'credits',
  'voucher_redemptions',
  'admin_audit_log',
]);

const ALLOWED_COLUMNS = new Set([
  'created_at',
  'redeemed_at',
]);

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

/**
 * Run all retention cleanup tasks.
 * Each table is processed independently so partial failures don't
 * prevent other tables from being cleaned.
 */
export async function runRetentionCleanup(
  db: Kysely<Database>,
  cfg: RetentionConfig,
): Promise<RetentionResult> {
  const result: RetentionResult = {
    invocationsDeleted: 0,
    noncesDeleted: 0,
    creditsDeleted: 0,
    vouchersDeleted: 0,
    leasesAnonymized: 0,
  };

  // Clean up old invocation records
  if (cfg.invocationRetentionDays > 0) {
    const cutoff = daysAgo(cfg.invocationRetentionDays);
    result.invocationsDeleted = await deleteOldRecords(
      db, 'lambda_invocations', 'created_at', cutoff, cfg.batchSize,
    );
  }

  // Clean up old payment nonces
  if (cfg.nonceRetentionDays > 0) {
    const cutoff = daysAgo(cfg.nonceRetentionDays);
    result.noncesDeleted = await deleteOldRecords(
      db, 'payment_nonces', 'created_at', cutoff, cfg.batchSize,
    );
  }

  // Clean up old REDEEMED credits only (unredeemed credits are never cleaned)
  if (cfg.creditRetentionDays > 0) {
    const cutoff = daysAgo(cfg.creditRetentionDays);
    result.creditsDeleted = await deleteOldRedeemedCredits(db, cutoff, cfg.batchSize);
  }

  // Clean up old voucher redemptions
  if (cfg.voucherRetentionDays > 0) {
    const cutoff = daysAgo(cfg.voucherRetentionDays);
    result.vouchersDeleted = await deleteOldRecords(
      db, 'voucher_redemptions', 'redeemed_at', cutoff, cfg.batchSize,
    );
  }

  // Anonymize old terminated leases (GDPR: clear PII after retention period)
  if (cfg.leaseAnonymizeDays > 0) {
    result.leasesAnonymized = await anonymizeTerminatedLeases(db, cfg.leaseAnonymizeDays);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * Batched deletion of records older than `cutoff` from `table` using
 * `column` for the timestamp comparison. Loops in batches to avoid
 * long-running locks.
 */
async function deleteOldRecords(
  db: Kysely<Database>,
  table: string,
  column: string,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`invalid table name: ${table}`);
  }
  if (!ALLOWED_COLUMNS.has(column)) {
    throw new Error(`invalid column name: ${column}`);
  }

  let totalDeleted = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await sql`
      DELETE FROM ${sql.table(table)}
      WHERE ctid IN (
        SELECT ctid FROM ${sql.table(table)}
        WHERE ${sql.ref(column)} < ${cutoff}
        LIMIT ${batchSize}
      )
    `.execute(db);

    const rowsAffected = Number(result.numAffectedRows ?? 0);
    totalDeleted += rowsAffected;

    if (rowsAffected < batchSize) break;
  }

  return totalDeleted;
}

/**
 * Delete only REDEEMED credits older than cutoff.
 * Unredeemed credits are never cleaned up regardless of age.
 */
async function deleteOldRedeemedCredits(
  db: Kysely<Database>,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  let totalDeleted = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await sql`
      DELETE FROM credits WHERE ctid IN (
        SELECT ctid FROM credits
        WHERE withdrawal_status = 'withdrawn' AND created_at < ${cutoff}
        LIMIT ${batchSize}
      )
    `.execute(db);

    const rowsAffected = Number(result.numAffectedRows ?? 0);
    totalDeleted += rowsAffected;

    if (rowsAffected < batchSize) break;
  }

  return totalDeleted;
}

/**
 * Anonymize terminated/failed leases older than the retention period.
 * Clears PII (payer_address, SSH keys, encryption data) and sets
 * `anonymized_at` so they aren't processed again.
 */
export async function anonymizeTerminatedLeases(
  db: Kysely<Database>,
  retentionDays: number,
): Promise<number> {
  const cutoff = daysAgo(retentionDays);

  const result = await sql`
    UPDATE leases
    SET payer_address = 'anonymized',
        ssh_public_key = '',
        encrypted_private_key = '',
        user_public_key = '',
        encryption_nonce = '',
        anonymized_at = NOW()
    WHERE status IN ('terminated', 'failed')
      AND anonymized_at IS NULL
      AND terminated_at IS NOT NULL
      AND terminated_at < ${cutoff}
  `.execute(db);

  return Number(result.numAffectedRows ?? 0);
}

// ---------------------------------------------------------------------------
// Table size monitoring
// ---------------------------------------------------------------------------

export interface TableSize {
  estimatedRows: number;
  totalBytes: number;
}

/**
 * Get approximate row count and disk size for key tables.
 * Uses PostgreSQL catalog statistics (fast, no table scan).
 */
export async function getTableSizes(
  db: Kysely<Database>,
): Promise<Record<string, TableSize>> {
  const tables = [
    'lambda_invocations', 'payment_nonces', 'credits',
    'voucher_redemptions', 'lambda_functions', 'leases',
    'earnings', 'refunds',
  ];

  const sizes: Record<string, TableSize> = {};

  for (const table of tables) {
    try {
      const rowResult = await sql<{ estimate: string }>`
        SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = ${table}
      `.execute(db);

      const sizeResult = await sql<{ total: string }>`
        SELECT pg_total_relation_size(${table}) AS total
      `.execute(db);

      sizes[table] = {
        estimatedRows: Number(rowResult.rows[0]?.estimate ?? -1),
        totalBytes: Number(sizeResult.rows[0]?.total ?? -1),
      };
    } catch {
      sizes[table] = { estimatedRows: -1, totalBytes: -1 };
    }
  }

  return sizes;
}
