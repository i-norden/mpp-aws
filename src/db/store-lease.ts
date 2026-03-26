/**
 * Lease database operations.
 * Mirrors the lease-specific queries from mmp-compute/lambda-proxy/internal/db/store_lease.go
 *
 * All functions accept a Kysely<Database> executor so they work identically
 * inside or outside a Store.withTransaction() call.
 */

import type { Kysely, Insertable, Selectable } from 'kysely';
import { sql } from 'kysely';

import type { Database, LeaseTable } from './types.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A row returned from the leases table. */
export type Lease = Selectable<LeaseTable>;

/** Shape accepted when inserting a new lease. */
export type InsertableLease = Insertable<LeaseTable>;

// ---------------------------------------------------------------------------
// Lease status constants
// ---------------------------------------------------------------------------

export const LeaseStatus = {
  Pending: 'pending',
  Provisioning: 'provisioning',
  Running: 'running',
  Terminated: 'terminated',
  Failed: 'failed',
} as const;

export type LeaseStatusType = (typeof LeaseStatus)[keyof typeof LeaseStatus];

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ResourceLimitReachedError extends Error {
  constructor() {
    super('resource has reached maximum concurrent leases');
    this.name = 'ResourceLimitReachedError';
  }
}

export class UserLimitReachedError extends Error {
  constructor() {
    super('maximum active leases per user reached');
    this.name = 'UserLimitReachedError';
  }
}

export class GlobalLimitReachedError extends Error {
  constructor() {
    super('platform has reached maximum total active leases');
    this.name = 'GlobalLimitReachedError';
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Returns the count of active (non-terminal) leases for a resource.
 */
export async function countActiveLeasesByResource(
  db: Kysely<Database>,
  resourceId: string,
): Promise<number> {
  const result = await db
    .selectFrom('leases')
    .select(db.fn.count<number>('id').as('count'))
    .where('resource_id', '=', resourceId)
    .where('status', 'not in', ['terminated', 'failed'])
    .executeTakeFirstOrThrow();

  return Number(result.count);
}

/**
 * Returns the count of active (non-terminal) leases for a payer address.
 */
export async function countActiveLeasesByPayer(
  db: Kysely<Database>,
  payerAddress: string,
): Promise<number> {
  const result = await db
    .selectFrom('leases')
    .select(db.fn.count<number>('id').as('count'))
    .where('payer_address', '=', payerAddress)
    .where('status', 'not in', ['terminated', 'failed'])
    .executeTakeFirstOrThrow();

  return Number(result.count);
}

/**
 * Returns the count of all active (non-terminal) leases.
 */
export async function countActiveLeases(
  db: Kysely<Database>,
): Promise<number> {
  const result = await db
    .selectFrom('leases')
    .select(db.fn.count<number>('id').as('count'))
    .where('status', 'not in', ['terminated', 'failed'])
    .executeTakeFirstOrThrow();

  return Number(result.count);
}

/**
 * Atomically checks concurrent lease limits and inserts a new lease
 * within a serializable transaction. This prevents TOCTOU race conditions
 * where two concurrent requests could both pass the limit check.
 *
 * @param maxConcurrent - Maximum active leases for the resource
 * @param maxPerUser    - Maximum active leases per user (payer address)
 * @param maxGlobal     - Maximum total active leases (0 = no limit)
 */
export async function createLeaseAtomic(
  db: Kysely<Database>,
  lease: InsertableLease,
  maxConcurrent: number,
  maxPerUser: number,
  maxGlobal: number,
): Promise<void> {
  // Use a raw SQL transaction with SERIALIZABLE isolation to match the Go
  // implementation's TOCTOU protection.
  await sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`.execute(db);

  // Check global active lease limit
  if (maxGlobal > 0) {
    const globalResult = await sql<{ count: string }>`
      SELECT COUNT(*) AS count FROM leases
      WHERE status NOT IN ('terminated', 'failed')
    `.execute(db);
    const globalCount = Number(globalResult.rows[0]?.count ?? 0);
    if (globalCount >= maxGlobal) {
      throw new GlobalLimitReachedError();
    }
  }

  // Lock and count active leases for this resource
  const resourceResult = await sql<{ count: string }>`
    SELECT COUNT(*) AS count FROM leases
    WHERE resource_id = ${lease.resource_id} AND status NOT IN ('terminated', 'failed')
    FOR UPDATE
  `.execute(db);
  const resourceCount = Number(resourceResult.rows[0]?.count ?? 0);
  if (resourceCount >= maxConcurrent) {
    throw new ResourceLimitReachedError();
  }

  // Lock and count active leases for this payer
  const userResult = await sql<{ count: string }>`
    SELECT COUNT(*) AS count FROM leases
    WHERE payer_address = ${lease.payer_address} AND status NOT IN ('terminated', 'failed')
    FOR UPDATE
  `.execute(db);
  const userCount = Number(userResult.rows[0]?.count ?? 0);
  if (userCount >= maxPerUser) {
    throw new UserLimitReachedError();
  }

  // Insert the lease within the same transaction
  await db.insertInto('leases').values(lease).execute();
}

/**
 * Returns a lease by ID. Returns null if not found.
 */
export async function getLease(
  db: Kysely<Database>,
  leaseId: string,
): Promise<Lease | null> {
  const row = await db
    .selectFrom('leases')
    .selectAll()
    .where('id', '=', leaseId)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Updates the status of a lease.
 */
export async function updateLeaseStatus(
  db: Kysely<Database>,
  leaseId: string,
  status: LeaseStatusType,
  opts?: {
    instanceId?: string;
    publicIp?: string;
    errorMessage?: string;
    terminatedReason?: string;
  },
): Promise<void> {
  const updates: Record<string, unknown> = { status };

  if (status === LeaseStatus.Provisioning) {
    if (opts?.instanceId) {
      updates.instance_id = opts.instanceId;
    }
    updates.provision_attempts = sql`provision_attempts + 1`;
  }

  if (status === LeaseStatus.Running && opts?.publicIp) {
    updates.public_ip = opts.publicIp;
    updates.provisioned_at = sql`NOW()`;
  }

  if (status === LeaseStatus.Failed && opts?.errorMessage) {
    updates.error_message = opts.errorMessage;
    updates.provision_attempts = sql`provision_attempts + 1`;
  }

  if (status === LeaseStatus.Terminated) {
    updates.terminated_at = sql`NOW()`;
    if (opts?.terminatedReason) {
      updates.terminated_reason = opts.terminatedReason;
    }
  }

  await db
    .updateTable('leases')
    .set(updates)
    .where('id', '=', leaseId)
    .execute();
}

/**
 * Extends a running lease's expiration and records additional payment.
 * Only updates leases with status = 'running'.
 *
 * @throws Error if the lease is not running (0 rows affected).
 */
export async function updateLeaseExpiresAt(
  db: Kysely<Database>,
  leaseId: string,
  newExpiresAt: Date,
  additionalPayment: bigint,
  additionalDays: number,
): Promise<void> {
  const result = await db
    .updateTable('leases')
    .set({
      expires_at: newExpiresAt,
      amount_paid: sql`amount_paid + ${additionalPayment}`,
      duration_days: sql`duration_days + ${additionalDays}`,
    })
    .where('id', '=', leaseId)
    .where('status', '=', 'running')
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) === 0) {
    throw new Error(`lease ${leaseId} is not running`);
  }
}

/**
 * Returns pending leases eligible for provisioning.
 */
export async function listPendingLeases(
  db: Kysely<Database>,
  maxAttempts: number,
): Promise<Lease[]> {
  return db
    .selectFrom('leases')
    .selectAll()
    .where('status', '=', 'pending')
    .where('provision_attempts', '<', maxAttempts)
    .orderBy('created_at', 'asc')
    .limit(10)
    .execute();
}

/**
 * Returns running leases whose expiration time has passed.
 */
export async function listExpiredLeases(
  db: Kysely<Database>,
): Promise<Lease[]> {
  return db
    .selectFrom('leases')
    .selectAll()
    .where('status', '=', 'running')
    .where('expires_at', '<', sql<Date>`NOW()`)
    .orderBy('expires_at', 'asc')
    .execute();
}

/**
 * Updates provision info (instance ID and public IP) on a lease.
 */
export async function updateLeaseProvisionInfo(
  db: Kysely<Database>,
  leaseId: string,
  instanceId: string,
  publicIp: string,
): Promise<void> {
  await db
    .updateTable('leases')
    .set({
      instance_id: instanceId,
      public_ip: publicIp,
      status: 'running',
      provisioned_at: sql`NOW()`,
    })
    .where('id', '=', leaseId)
    .execute();
}

/**
 * Updates the bandwidth usage counters for a lease.
 */
export async function updateLeaseBandwidth(
  db: Kysely<Database>,
  leaseId: string,
  egressUsedGB: number,
  ingressUsedGB: number,
): Promise<void> {
  await db
    .updateTable('leases')
    .set({
      egress_used_gb: egressUsedGB,
      ingress_used_gb: ingressUsedGB,
      bandwidth_checked_at: sql`NOW()`,
    })
    .where('id', '=', leaseId)
    .execute();
}

/**
 * Upserts a row in the aws_pricing table (used by the price fetcher).
 */
export async function upsertAWSPrice(
  db: Kysely<Database>,
  service: string,
  resourceKey: string,
  region: string,
  unit: string,
  priceUSD: number,
): Promise<void> {
  await db
    .insertInto('aws_pricing')
    .values({
      service,
      resource_key: resourceKey,
      region,
      unit,
      price_usd: priceUSD,
      last_fetched_at: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(['service', 'resource_key', 'region']).doUpdateSet({
        price_usd: priceUSD,
        unit,
        last_fetched_at: sql`NOW()`,
      }),
    )
    .execute();
}

/**
 * Returns the cached price for a service/resource/region combination.
 * Returns null if no matching row exists.
 */
export async function getAWSPrice(
  db: Kysely<Database>,
  service: string,
  resourceKey: string,
  region: string,
): Promise<{ priceUSD: number; lastFetchedAt: Date } | null> {
  const row = await db
    .selectFrom('aws_pricing')
    .select(['price_usd', 'last_fetched_at'])
    .where('service', '=', service)
    .where('resource_key', '=', resourceKey)
    .where('region', '=', region)
    .executeTakeFirst();

  if (!row) return null;
  return {
    priceUSD: Number(row.price_usd),
    lastFetchedAt: row.last_fetched_at instanceof Date
      ? row.last_fetched_at
      : new Date(String(row.last_fetched_at)),
  };
}
