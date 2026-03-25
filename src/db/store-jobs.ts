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
      input: JSON.stringify(job.input ?? {}),
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

  return row ?? null;
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
    .execute();
}

/**
 * List pending async jobs waiting to be processed, ordered by creation time.
 */
export async function listPendingAsyncJobs(
  db: Kysely<Database>,
  limit: number,
): Promise<AsyncJob[]> {
  return db
    .selectFrom('async_jobs')
    .selectAll()
    .where('status', '=', 'pending')
    .orderBy('created_at', 'asc')
    .limit(limit)
    .execute();
}

/**
 * Mark an async job as running.
 */
export async function updateAsyncJobRunning(
  db: Kysely<Database>,
  jobId: string,
): Promise<void> {
  await db
    .updateTable('async_jobs')
    .set({
      status: 'running',
      started_at: sql`NOW()`,
    })
    .where('id', '=', jobId)
    .execute();
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
      result: JSON.stringify(result),
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
