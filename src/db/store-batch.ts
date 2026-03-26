/**
 * Batch invocation DB operations.
 * TypeScript port of mmp-compute/lambda-proxy/internal/db/store_batch.go
 *
 * Manages batch invocation records (create, update progress, retrieve).
 */

import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';

import type { Database, BatchInvocationTable } from './types.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A row returned from the batch_invocations table. */
export type BatchInvocation = Selectable<BatchInvocationTable>;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Create a new batch invocation record and return the generated id + created_at.
 *
 * Mutates the `batch` object in-place to set `id` and `createdAt` from the
 * RETURNING clause, mirroring the Go Store.CreateBatchInvocation behaviour.
 */
export async function createBatchInvocation(
  db: Kysely<Database>,
  batch: {
    functionName: string;
    payerAddress: string;
    txHash: string;
    totalItems: number;
    amountPaid: bigint;
  },
): Promise<{ id: string; createdAt: Date }> {
  const result = await db
    .insertInto('batch_invocations')
    .values({
      function_name: batch.functionName,
      payer_address: batch.payerAddress,
      tx_hash: batch.txHash,
      total_items: batch.totalItems,
      amount_paid: batch.amountPaid,
    })
    .returning(['id', 'created_at'])
    .executeTakeFirstOrThrow();

  return {
    id: String(result.id),
    createdAt: new Date(result.created_at),
  };
}

/**
 * Update the progress and status of a batch invocation.
 *
 * When status is 'completed' or 'partial_failure', the completed_at timestamp
 * is set to NOW().
 */
export async function updateBatchInvocation(
  db: Kysely<Database>,
  batchId: string,
  completed: number,
  failed: number,
  status: string,
): Promise<void> {
  const isTerminal = status === 'completed' || status === 'partial_failure';

  await db
    .updateTable('batch_invocations')
    .set({
      completed_items: completed,
      failed_items: failed,
      status,
      ...(isTerminal ? { completed_at: sql`NOW()` } : {}),
    })
    .where('id', '=', batchId)
    .execute();
}

/**
 * Retrieve a batch invocation by ID.
 * Returns null when no matching record exists.
 */
export async function getBatchInvocation(
  db: Kysely<Database>,
  batchId: string,
): Promise<BatchInvocation | null> {
  const row = await db
    .selectFrom('batch_invocations')
    .selectAll()
    .where('id', '=', batchId)
    .executeTakeFirst();

  return row ?? null;
}
