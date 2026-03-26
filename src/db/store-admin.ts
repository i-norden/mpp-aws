/**
 * Admin-specific database operations.
 * TypeScript port of admin-facing queries from:
 *   - mmp-compute/lambda-proxy/internal/api/handlers_admin_lease.go (AdminDataStore interface)
 *   - mmp-compute/lambda-proxy/internal/db/store_admin.go
 *
 * All functions accept a Kysely<Database> executor so they work identically
 * inside or outside a Store.withTransaction() call.
 */

import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';

import type {
  Database,
  LambdaFunctionTable,
  LambdaInvocationTable,
  LeaseTable,
  LeaseResourceTable,
  RefundTable,
  CreditTable,
  EarningTable,
  AdminAuditLogTable,
} from './types.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type LambdaFunction = Selectable<LambdaFunctionTable>;
export type Lease = Selectable<LeaseTable>;
export type LeaseResource = Selectable<LeaseResourceTable>;
export type Refund = Selectable<RefundTable>;
export type Credit = Selectable<CreditTable>;
export type Earning = Selectable<EarningTable>;
export type AuditLogEntry = Selectable<AdminAuditLogTable>;

// ---------------------------------------------------------------------------
// Filter / option types
// ---------------------------------------------------------------------------

export interface ListFunctionsOptions {
  includeDisabled?: boolean;
}

export interface LeaseFilters {
  status?: string;
  payerAddress?: string;
  resourceId?: string;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
}

export interface InvocationFilters {
  functionName?: string;
  payer?: string;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
}

export interface RefundFilters {
  status?: string;
  payer?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogFilters {
  action?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Summary / aggregate types
// ---------------------------------------------------------------------------

export interface LeaseSummaryStats {
  totalLeases: number;
  activeLeases: number;
  pendingLeases: number;
  terminatedLeases: number;
  failedLeases: number;
  totalRevenue: bigint;
  uniquePayers: number;
}

export interface BillingSummary {
  totalInvocations: number;
  totalRevenue: bigint;
  totalRefunds: bigint;
  totalCredits: bigint;
  totalEarnings: bigint;
  netRevenue: bigint;
  uniquePayers: number;
  uniqueFunctions: number;
}

export interface FunctionStats {
  functionName: string;
  totalInvocations: number;
  successful: number;
  failed: number;
  totalRevenue: bigint;
  avgDurationMs: number;
  uniquePayers: number;
}

export interface ResourceUtilization {
  resourceId: string;
  activeLeases: number;
  totalLeases: number;
  totalRevenue: bigint;
}

export interface InsertableAuditLogEntry {
  admin_ip: string;
  action: string;
  target_type: string;
  target_id: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Function management
// ---------------------------------------------------------------------------

/**
 * List all functions, optionally including disabled ones.
 * For admin use -- does not filter by visibility or enabled status
 * unless explicitly requested.
 */
export async function listAllFunctions(
  db: Kysely<Database>,
  options?: ListFunctionsOptions,
): Promise<LambdaFunction[]> {
  let query = db.selectFrom('lambda_functions').selectAll();

  if (!options?.includeDisabled) {
    query = query.where('enabled', '=', true);
  }

  return query.orderBy('function_name', 'asc').execute();
}

/**
 * Get invocation stats for a specific function (admin view).
 */
export async function getAdminFunctionStats(
  db: Kysely<Database>,
  functionName: string,
): Promise<FunctionStats | null> {
  const row = await db
    .selectFrom('lambda_invocations')
    .select([
      sql<bigint>`COUNT(*)`.as('total_invocations'),
      sql<bigint>`COUNT(*) FILTER (WHERE success = true)`.as('successful'),
      sql<bigint>`COUNT(*) FILTER (WHERE success = false)`.as('failed'),
      sql<bigint>`COALESCE(SUM(amount_paid), 0)`.as('total_revenue'),
      sql<number>`COALESCE(AVG(NULLIF(duration_ms, 0)), 0)`.as('avg_duration_ms'),
      sql<bigint>`COUNT(DISTINCT payer_address)`.as('unique_payers'),
    ])
    .where('function_name', '=', functionName)
    .executeTakeFirst();

  if (!row || Number(row.total_invocations) === 0) {
    return null;
  }

  return {
    functionName,
    totalInvocations: Number(row.total_invocations),
    successful: Number(row.successful),
    failed: Number(row.failed),
    totalRevenue: BigInt(row.total_revenue),
    avgDurationMs: Math.round(Number(row.avg_duration_ms)),
    uniquePayers: Number(row.unique_payers),
  };
}

// ---------------------------------------------------------------------------
// Lease management
// ---------------------------------------------------------------------------

/**
 * List all leases with optional filters.
 * Returns [leases, totalCount] for pagination.
 */
export async function listAllLeases(
  db: Kysely<Database>,
  filters?: LeaseFilters,
): Promise<[Lease[], number]> {
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  // Count query
  let countQuery = db
    .selectFrom('leases')
    .select(db.fn.count<number>('id').as('count'));

  // Data query
  let dataQuery = db.selectFrom('leases').selectAll();

  // Apply filters to both queries
  if (filters?.status) {
    countQuery = countQuery.where('status', '=', filters.status);
    dataQuery = dataQuery.where('status', '=', filters.status);
  }
  if (filters?.payerAddress) {
    countQuery = countQuery.where('payer_address', '=', filters.payerAddress.toLowerCase());
    dataQuery = dataQuery.where('payer_address', '=', filters.payerAddress.toLowerCase());
  }
  if (filters?.resourceId) {
    countQuery = countQuery.where('resource_id', '=', filters.resourceId);
    dataQuery = dataQuery.where('resource_id', '=', filters.resourceId);
  }
  if (filters?.fromDate) {
    countQuery = countQuery.where('created_at', '>=', filters.fromDate);
    dataQuery = dataQuery.where('created_at', '>=', filters.fromDate);
  }
  if (filters?.toDate) {
    countQuery = countQuery.where('created_at', '<=', filters.toDate);
    dataQuery = dataQuery.where('created_at', '<=', filters.toDate);
  }

  const [countResult, leases] = await Promise.all([
    countQuery.executeTakeFirstOrThrow(),
    dataQuery
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute(),
  ]);

  return [leases, Number(countResult.count)];
}

/**
 * Get aggregate lease summary statistics.
 */
export async function getAdminLeaseSummary(
  db: Kysely<Database>,
): Promise<LeaseSummaryStats> {
  const row = await db
    .selectFrom('leases')
    .select([
      sql<bigint>`COUNT(*)`.as('total_leases'),
      sql<bigint>`COUNT(*) FILTER (WHERE status IN ('running', 'provisioning'))`.as('active_leases'),
      sql<bigint>`COUNT(*) FILTER (WHERE status = 'pending')`.as('pending_leases'),
      sql<bigint>`COUNT(*) FILTER (WHERE status = 'terminated')`.as('terminated_leases'),
      sql<bigint>`COUNT(*) FILTER (WHERE status = 'failed')`.as('failed_leases'),
      sql<bigint>`COALESCE(SUM(amount_paid), 0)`.as('total_revenue'),
      sql<bigint>`COUNT(DISTINCT payer_address)`.as('unique_payers'),
    ])
    .executeTakeFirstOrThrow();

  return {
    totalLeases: Number(row.total_leases),
    activeLeases: Number(row.active_leases),
    pendingLeases: Number(row.pending_leases),
    terminatedLeases: Number(row.terminated_leases),
    failedLeases: Number(row.failed_leases),
    totalRevenue: BigInt(row.total_revenue),
    uniquePayers: Number(row.unique_payers),
  };
}

/**
 * Admin-terminate a lease by setting status = 'terminated' with a reason.
 * Only leases in active states (pending, provisioning, running) can be terminated.
 */
export async function adminTerminateLease(
  db: Kysely<Database>,
  leaseId: string,
  reason: string,
): Promise<void> {
  const result = await db
    .updateTable('leases')
    .set({
      status: 'terminated',
      terminated_at: sql`NOW()`,
      terminated_reason: reason,
    })
    .where('id', '=', leaseId)
    .where('status', 'in', ['pending', 'provisioning', 'running'])
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) === 0) {
    throw new Error(`lease ${leaseId} not found or already in terminal state`);
  }
}

/**
 * Admin-extend a lease by adding days to the expiration.
 * Only running leases can be extended.
 */
export async function adminExtendLease(
  db: Kysely<Database>,
  leaseId: string,
  days: number,
): Promise<void> {
  const result = await db
    .updateTable('leases')
    .set({
      expires_at: sql`expires_at + make_interval(days => ${days})`,
      duration_days: sql`duration_days + ${days}`,
    })
    .where('id', '=', leaseId)
    .where('status', '=', 'running')
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) === 0) {
    throw new Error(`lease ${leaseId} not found or not running`);
  }
}

/**
 * Anonymize a lease's personal data (GDPR compliance).
 * Replaces payer_address and SSH keys with anonymized values.
 * Only terminated or failed leases can be anonymized.
 */
export async function anonymizeLease(
  db: Kysely<Database>,
  leaseId: string,
): Promise<void> {
  const result = await db
    .updateTable('leases')
    .set({
      payer_address: 'anonymized',
      ssh_public_key: 'anonymized',
      encrypted_private_key: 'anonymized',
      user_public_key: 'anonymized',
      encryption_nonce: 'anonymized',
      anonymized_at: sql`NOW()`,
    })
    .where('id', '=', leaseId)
    .where('status', 'in', ['terminated', 'failed'])
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) === 0) {
    throw new Error(`lease ${leaseId} not found or not in terminal state (cannot anonymize active leases)`);
  }
}

// ---------------------------------------------------------------------------
// Billing & financial
// ---------------------------------------------------------------------------

/**
 * Get billing summary for a date range.
 * Defaults to last 30 days if no dates provided.
 */
export async function getBillingSummary(
  db: Kysely<Database>,
  since?: Date,
): Promise<BillingSummary> {
  const from = since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const invocationStats = await db
    .selectFrom('lambda_invocations')
    .select([
      sql<bigint>`COUNT(*)`.as('total_invocations'),
      sql<bigint>`COALESCE(SUM(amount_paid), 0)`.as('total_revenue'),
      sql<bigint>`COUNT(DISTINCT payer_address)`.as('unique_payers'),
      sql<bigint>`COUNT(DISTINCT function_name)`.as('unique_functions'),
    ])
    .where('created_at', '>=', from)
    .executeTakeFirstOrThrow();

  const refundStats = await db
    .selectFrom('refunds')
    .select([
      sql<bigint>`COALESCE(SUM(amount), 0)`.as('total_refunds'),
    ])
    .where('created_at', '>=', from)
    .where('status', '=', 'success')
    .executeTakeFirstOrThrow();

  const creditStats = await db
    .selectFrom('credits')
    .select([
      sql<bigint>`COALESCE(SUM(amount), 0)`.as('total_credits'),
    ])
    .where('created_at', '>=', from)
    .executeTakeFirstOrThrow();

  const earningStats = await db
    .selectFrom('earnings')
    .select([
      sql<bigint>`COALESCE(SUM(amount), 0)`.as('total_earnings'),
    ])
    .where('created_at', '>=', from)
    .executeTakeFirstOrThrow();

  const totalRevenue = BigInt(invocationStats.total_revenue);
  const totalRefunds = BigInt(refundStats.total_refunds);
  const totalCredits = BigInt(creditStats.total_credits);
  const totalEarnings = BigInt(earningStats.total_earnings);

  return {
    totalInvocations: Number(invocationStats.total_invocations),
    totalRevenue,
    totalRefunds,
    totalCredits,
    totalEarnings,
    netRevenue: totalRevenue - totalRefunds - totalCredits,
    uniquePayers: Number(invocationStats.unique_payers),
    uniqueFunctions: Number(invocationStats.unique_functions),
  };
}

/**
 * List invocations with billing detail (admin view).
 * Returns [invocations, totalCount] for pagination.
 */
export async function getInvocationsBilling(
  db: Kysely<Database>,
  filters?: InvocationFilters,
): Promise<[Selectable<LambdaInvocationTable>[], number]> {
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  let countQuery = db
    .selectFrom('lambda_invocations')
    .select(db.fn.count<number>('id').as('count'));

  let dataQuery = db.selectFrom('lambda_invocations').selectAll();

  if (filters?.functionName) {
    countQuery = countQuery.where('function_name', '=', filters.functionName);
    dataQuery = dataQuery.where('function_name', '=', filters.functionName);
  }
  if (filters?.payer) {
    countQuery = countQuery.where('payer_address', '=', filters.payer.toLowerCase());
    dataQuery = dataQuery.where('payer_address', '=', filters.payer.toLowerCase());
  }
  if (filters?.fromDate) {
    countQuery = countQuery.where('created_at', '>=', filters.fromDate);
    dataQuery = dataQuery.where('created_at', '>=', filters.fromDate);
  }
  if (filters?.toDate) {
    countQuery = countQuery.where('created_at', '<=', filters.toDate);
    dataQuery = dataQuery.where('created_at', '<=', filters.toDate);
  }

  const [countResult, rows] = await Promise.all([
    countQuery.executeTakeFirstOrThrow(),
    dataQuery
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute(),
  ]);

  return [rows, Number(countResult.count)];
}

/**
 * List refunds (admin view).
 * Returns [refunds, totalCount] for pagination.
 */
export async function getRefundsBilling(
  db: Kysely<Database>,
  filters?: RefundFilters,
): Promise<[Refund[], number]> {
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  let countQuery = db
    .selectFrom('refunds')
    .select(db.fn.count<number>('id').as('count'));

  let dataQuery = db.selectFrom('refunds').selectAll();

  if (filters?.status) {
    countQuery = countQuery.where('status', '=', filters.status);
    dataQuery = dataQuery.where('status', '=', filters.status);
  }
  if (filters?.payer) {
    countQuery = countQuery.where('payer_address', '=', filters.payer.toLowerCase());
    dataQuery = dataQuery.where('payer_address', '=', filters.payer.toLowerCase());
  }

  const [countResult, rows] = await Promise.all([
    countQuery.executeTakeFirstOrThrow(),
    dataQuery
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute(),
  ]);

  return [rows, Number(countResult.count)];
}

/**
 * List all credits (admin view).
 * Returns [credits, totalCount] for pagination.
 */
export async function getCreditsBilling(
  db: Kysely<Database>,
  limit = 50,
  offset = 0,
): Promise<[Credit[], number]> {
  const [countResult, rows] = await Promise.all([
    db
      .selectFrom('credits')
      .select(db.fn.count<number>('id').as('count'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('credits')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute(),
  ]);

  return [rows, Number(countResult.count)];
}

/**
 * List all earnings (admin view).
 * Returns [earnings, totalCount] for pagination.
 */
export async function getEarningsBilling(
  db: Kysely<Database>,
  limit = 50,
  offset = 0,
): Promise<[Earning[], number]> {
  const [countResult, rows] = await Promise.all([
    db
      .selectFrom('earnings')
      .select(db.fn.count<number>('id').as('count'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('earnings')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute(),
  ]);

  return [rows, Number(countResult.count)];
}

// ---------------------------------------------------------------------------
// Resource utilization
// ---------------------------------------------------------------------------

/**
 * Get utilization stats for a specific lease resource.
 */
export async function getResourceUtilization(
  db: Kysely<Database>,
  resourceId: string,
): Promise<ResourceUtilization> {
  const row = await db
    .selectFrom('leases')
    .select([
      sql<bigint>`COUNT(*) FILTER (WHERE status IN ('running', 'provisioning', 'pending'))`.as('active_leases'),
      sql<bigint>`COUNT(*)`.as('total_leases'),
      sql<bigint>`COALESCE(SUM(amount_paid), 0)`.as('total_revenue'),
    ])
    .where('resource_id', '=', resourceId)
    .executeTakeFirstOrThrow();

  return {
    resourceId,
    activeLeases: Number(row.active_leases),
    totalLeases: Number(row.total_leases),
    totalRevenue: BigInt(row.total_revenue),
  };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * List audit log entries with optional filters.
 */
export async function listAuditLog(
  db: Kysely<Database>,
  filters?: AuditLogFilters,
): Promise<AuditLogEntry[]> {
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  let query = db.selectFrom('admin_audit_log').selectAll();

  if (filters?.action) {
    query = query.where('action', '=', filters.action);
  }
  if (filters?.targetType) {
    query = query.where('target_type', '=', filters.targetType);
  }
  if (filters?.targetId) {
    query = query.where('target_id', '=', filters.targetId);
  }

  return query
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();
}

/**
 * Create a new audit log entry.
 * Best-effort: callers should catch and log errors rather than failing the request.
 */
export async function createAuditEntry(
  db: Kysely<Database>,
  entry: InsertableAuditLogEntry,
): Promise<void> {
  await db
    .insertInto('admin_audit_log')
    .values({
      admin_ip: entry.admin_ip,
      action: entry.action,
      target_type: entry.target_type,
      target_id: entry.target_id,
      details: entry.details ?? null,
    })
    .execute();
}
