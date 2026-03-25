import type { Kysely, Insertable, Selectable } from "kysely";

import type { Database, LambdaInvocationTable } from "./types.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A row returned from the lambda_invocations table. */
export type Invocation = Selectable<LambdaInvocationTable>;

/** Shape accepted when inserting a new invocation. */
export type InsertableInvocation = Insertable<LambdaInvocationTable>;

/** Fields that can be updated after the invocation is initially logged. */
export interface BillingUpdate {
  actual_cloud_cost?: bigint | null;
  fee_amount?: bigint | null;
  refund_amount?: bigint | null;
  refund_status?: string | null;
  refund_tx_hash?: string | null;
  billed_duration_ms?: bigint | null;
  memory_mb?: number | null;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Log a new Lambda invocation and return the auto-generated id.
 */
export async function createInvocation(
  db: Kysely<Database>,
  inv: InsertableInvocation,
): Promise<number> {
  const result = await db
    .insertInto("lambda_invocations")
    .values(inv)
    .returning("id")
    .executeTakeFirstOrThrow();

  return Number(result.id);
}

/**
 * Update the billing-related columns of an existing invocation.
 *
 * Typically called after the Lambda response is received and
 * actual cost / refund amounts have been computed.
 */
export async function updateInvocationBilling(
  db: Kysely<Database>,
  id: number,
  updates: BillingUpdate,
): Promise<void> {
  await db
    .updateTable("lambda_invocations")
    .set(updates)
    .where("id", "=", BigInt(id))
    .execute();
}
