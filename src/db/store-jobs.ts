/**
 * Async job DB operations.
 * TypeScript port of mmp-compute/lambda-proxy/internal/db/store_jobs.go
 *
 * Manages async job lifecycle: create, get, list, update status, and cleanup.
 */

import type { Kysely, Selectable, SqlBool } from 'kysely';
import { sql } from 'kysely';

import type { Database, AsyncJobTable } from './types.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A row returned from the async_jobs table. */
export type AsyncJob = Selectable<AsyncJobTable>;

function cloneJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

function decodeJsonValue<T>(value: T): T {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return value;
  }
}

function normalizeAsyncJob(row: AsyncJob): AsyncJob {
  return {
    ...row,
    input: decodeJsonValue(row.input),
    result: row.result === null ? null : decodeJsonValue(row.result),
  };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Create a new async job and return the generated id + created_at.
 */
export async function createAsyncJob(
  db: Kysely<Database>,
  job: {
    functionName: string;
    payerAddress: string;
    txHash: string;
    input: unknown;
    amountPaid: bigint;
    expiresAt: Date | string;
  },
): Promise<{ id: string; createdAt: Date }> {
  const result = await db
    .insertInto('async_jobs')
    .values({
      function_name: job.functionName,
      payer_address: job.payerAddress,
      tx_hash: job.txHash,
      input: cloneJsonValue(job.input ?? {}),
      amount_paid: job.amountPaid,
      expires_at: job.expiresAt instanceof Date ? job.expiresAt.toISOString() : job.expiresAt,
    })
    .returning(['id', 'created_at'])
    .executeTakeFirstOrThrow();

  return {
    id: String(result.id),
    createdAt: new Date(result.created_at),
  };
}

/**
 * Retrieve an async job by ID.
 * Returns null when no matching record exists.
 */
export async function getAsyncJob(
  db: Kysely<Database>,
  jobId: string,
): Promise<AsyncJob | null> {
  const row = await db
    .selectFrom('async_jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirst();

  return row ? normalizeAsyncJob(row) : null;
}

/**
 * List async jobs for a payer address, ordered by creation time descending.
 */
export async function listAsyncJobsByAddress(
  db: Kysely<Database>,
  payerAddress: string,
  limit: number,
): Promise<AsyncJob[]> {
  return db
    .selectFrom('async_jobs')
    .selectAll()
    .where('payer_address', '=', payerAddress)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()
    .then((rows) => rows.map(normalizeAsyncJob));
}

/**
 * Atomically claim the next pending async jobs that have not expired.
 *
 * Uses `FOR UPDATE SKIP LOCKED` inside a single UPDATE statement so multiple
 * workers/processes can safely poll the same table without double-running jobs.
 */
export async function claimPendingAsyncJobs(
  db: Kysely<Database>,
  limit: number,
): Promise<AsyncJob[]> {
  if (limit <= 0) {
    return [];
  }

  const result = await sql<AsyncJob>`
    WITH claimable AS (
      SELECT id
      FROM async_jobs
      WHERE status = 'pending'
        AND expires_at > NOW()
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE async_jobs AS jobs
    SET status = 'running',
        started_at = NOW()
    FROM claimable
    WHERE jobs.id = claimable.id
    RETURNING jobs.*
  `.execute(db);

  return result.rows.map(normalizeAsyncJob);
}

/**
 * Mark expired pending async jobs as failed so they can be surfaced and later cleaned up.
 */
export async function expirePendingAsyncJobs(
  db: Kysely<Database>,
): Promise<number> {
  const result = await db
    .updateTable('async_jobs')
    .set({
      status: 'failed',
      error_message: 'job expired before execution',
      completed_at: sql`NOW()`,
    })
    .where('status', '=', 'pending')
    .where('expires_at', '<=', sql<Date>`NOW()`)
    .executeTakeFirst();

  return Number(result.numUpdatedRows ?? 0);
}

/**
 * Mark an async job as completed with its result and actual cost.
 */
export async function updateAsyncJobCompleted(
  db: Kysely<Database>,
  jobId: string,
  result: unknown,
  actualCost: bigint,
): Promise<void> {
  await db
    .updateTable('async_jobs')
    .set({
      status: 'completed',
      result: cloneJsonValue(result),
      actual_cost: actualCost,
      completed_at: sql`NOW()`,
    })
    .where('id', '=', jobId)
    .execute();
}

/**
 * Mark an async job as failed with an error message.
 */
export async function updateAsyncJobFailed(
  db: Kysely<Database>,
  jobId: string,
  errorMessage: string,
): Promise<void> {
  await db
    .updateTable('async_jobs')
    .set({
      status: 'failed',
      error_message: errorMessage,
      completed_at: sql`NOW()`,
    })
    .where('id', '=', jobId)
    .execute();
}

/**
 * Delete expired async jobs that are in terminal states ('completed' or 'failed').
 * Returns the number of rows deleted.
 */
export async function deleteExpiredAsyncJobs(
  db: Kysely<Database>,
): Promise<number> {
  const result = await db
    .deleteFrom('async_jobs')
    .where(sql<SqlBool>`expires_at < NOW()`)
    .where('status', 'in', ['completed', 'failed'])
    .executeTakeFirst();

  return Number(result.numDeletedRows);
}
