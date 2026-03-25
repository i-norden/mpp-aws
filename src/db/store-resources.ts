/**
 * Lease resource database operations.
 * Mirrors the resource-specific queries from mmp-compute/lambda-proxy/internal/db/store_lease.go
 */

import type { Kysely, Insertable, Selectable, Updateable } from 'kysely';
import { sql } from 'kysely';

import type { Database, LeaseResourceTable } from './types.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A row returned from the lease_resources table. */
export type LeaseResource = Selectable<LeaseResourceTable>;

/** Shape accepted when inserting a new resource. */
export type InsertableLeaseResource = Insertable<LeaseResourceTable>;

/** Shape accepted when updating an existing resource. */
export type UpdatableLeaseResource = Updateable<LeaseResourceTable>;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Returns all enabled lease resources, ordered by vcpus and memory.
 */
export async function listLeaseResources(
  db: Kysely<Database>,
): Promise<LeaseResource[]> {
  return db
    .selectFrom('lease_resources')
    .selectAll()
    .where('enabled', '=', true)
    .orderBy('vcpus', 'asc')
    .orderBy('memory_gb', 'asc')
    .execute();
}

/**
 * Returns a single lease resource by ID.
 * Returns null when no matching resource exists.
 */
export async function getLeaseResource(
  db: Kysely<Database>,
  id: string,
): Promise<LeaseResource | null> {
  const row = await db
    .selectFrom('lease_resources')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Inserts a new lease resource.
 */
export async function createLeaseResource(
  db: Kysely<Database>,
  resource: InsertableLeaseResource,
): Promise<void> {
  await db.insertInto('lease_resources').values(resource).execute();
}

/**
 * Updates an existing lease resource identified by ID.
 * Only the provided fields are updated; `updated_at` is refreshed automatically.
 */
export async function updateLeaseResource(
  db: Kysely<Database>,
  id: string,
  updates: UpdatableLeaseResource,
): Promise<void> {
  await db
    .updateTable('lease_resources')
    .set({
      ...updates,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', id)
    .execute();
}

/**
 * Soft-deletes a lease resource by disabling it.
 */
export async function deleteLeaseResource(
  db: Kysely<Database>,
  id: string,
): Promise<void> {
  await db
    .updateTable('lease_resources')
    .set({
      enabled: false,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', id)
    .execute();
}
