/**
 * Access list DB operations.
 * TypeScript port of mmp-compute/lambda-proxy/internal/db/store_access.go
 *
 * Manages the per-function access control list for private functions.
 */

import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';

import type { Database, FunctionAccessListTable } from './types.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A row returned from the function_access_list table. */
export type AccessListEntry = Selectable<FunctionAccessListTable>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when adding entries would exceed the maximum access list size. */
export class AccessListFullError extends Error {
  readonly currentCount: number;

  constructor(currentCount: number) {
    super('access list size limit exceeded');
    this.name = 'AccessListFullError';
    this.currentCount = currentCount;
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve all access list entries for a function, ordered by creation time.
 */
export async function getAccessList(
  db: Kysely<Database>,
  functionName: string,
): Promise<AccessListEntry[]> {
  return db
    .selectFrom('function_access_list')
    .selectAll()
    .where('function_name', '=', functionName)
    .orderBy('created_at', 'asc')
    .execute();
}

/**
 * Atomically check the access list size and grant access to multiple addresses
 * within a single transaction. This prevents concurrent requests from exceeding
 * maxSize.
 *
 * Uses ON CONFLICT DO NOTHING so duplicate entries are silently ignored.
 *
 * @param functionName - The function to grant access to.
 * @param addresses - Array of {invokerAddress, grantedBy} pairs.
 * @param maxSize - Maximum allowed entries in the access list.
 * @throws {AccessListFullError} If adding entries would exceed maxSize.
 */
export async function addToAccessList(
  db: Kysely<Database>,
  functionName: string,
  addresses: Array<{ invokerAddress: string; grantedBy: string }>,
  maxSize: number,
): Promise<void> {
  if (addresses.length === 0) return;

  await db.transaction().execute(async (trx) => {
    // Lock and count in one query to prevent concurrent modifications
    const countRow = await sql<{ cnt: string }>`
      SELECT COUNT(*) AS cnt FROM function_access_list
      WHERE function_name = ${functionName}
      FOR UPDATE
    `.execute(trx);

    const currentCount = Number(countRow.rows[0]?.cnt ?? '0');
    if (currentCount + addresses.length > maxSize) {
      throw new AccessListFullError(currentCount);
    }

    // Insert each entry with ON CONFLICT DO NOTHING
    for (const entry of addresses) {
      await trx
        .insertInto('function_access_list')
        .values({
          function_name: functionName,
          invoker_address: entry.invokerAddress,
          granted_by: entry.grantedBy,
        })
        .onConflict((oc) =>
          oc.columns(['function_name', 'invoker_address']).doNothing(),
        )
        .execute();
    }
  });
}

/**
 * Remove addresses from a function's access list.
 *
 * Silently ignores addresses that are not in the list.
 */
export async function removeFromAccessList(
  db: Kysely<Database>,
  functionName: string,
  addresses: string[],
): Promise<void> {
  if (addresses.length === 0) return;

  for (const addr of addresses) {
    await db
      .deleteFrom('function_access_list')
      .where('function_name', '=', functionName)
      .where('invoker_address', '=', addr)
      .execute();
  }
}

/**
 * Check if an address is authorized to invoke a private function.
 */
export async function isAddressAllowed(
  db: Kysely<Database>,
  functionName: string,
  address: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('function_access_list')
    .select('id')
    .where('function_name', '=', functionName)
    .where('invoker_address', '=', address)
    .executeTakeFirst();

  return row !== undefined;
}
