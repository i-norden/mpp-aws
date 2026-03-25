import type { Kysely, Insertable, Selectable, Updateable, SqlBool } from "kysely";
import { sql } from "kysely";

import type { Database, LambdaFunctionTable } from "./types.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A row returned from the lambda_functions table. */
export type LambdaFunction = Selectable<LambdaFunctionTable>;

/** Shape accepted when inserting a new function. */
export type InsertableLambdaFunction = Insertable<LambdaFunctionTable>;

/** Shape accepted when updating an existing function. */
export type UpdatableLambdaFunction = Updateable<LambdaFunctionTable>;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve a single function by name (enabled only).
 * Returns `null` when no matching function exists.
 */
export async function getFunction(
  db: Kysely<Database>,
  name: string,
): Promise<LambdaFunction | null> {
  const row = await db
    .selectFrom("lambda_functions")
    .selectAll()
    .where("function_name", "=", name)
    .where("enabled", "=", true)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * List functions with optional filters.
 *
 * - `enabled` filters by the `enabled` flag (default: only enabled).
 * - `visibility` filters by visibility ('public' | 'private').
 */
export async function listFunctions(
  db: Kysely<Database>,
  options?: { enabled?: boolean; visibility?: string },
): Promise<LambdaFunction[]> {
  let query = db.selectFrom("lambda_functions").selectAll();

  const enabled = options?.enabled ?? true;
  query = query.where("enabled", "=", enabled);

  if (options?.visibility !== undefined) {
    query = query.where("visibility", "=", options.visibility);
  }

  query = query.orderBy("function_name", "asc");

  return query.execute();
}

/**
 * Insert a new function row.
 */
export async function createFunction(
  db: Kysely<Database>,
  fn: InsertableLambdaFunction,
): Promise<void> {
  await db.insertInto("lambda_functions").values(fn).execute();
}

/**
 * Update an existing function identified by `function_name`.
 * Only the provided fields are updated; `updated_at` is refreshed
 * automatically.
 */
export async function updateFunction(
  db: Kysely<Database>,
  name: string,
  updates: UpdatableLambdaFunction,
): Promise<void> {
  await db
    .updateTable("lambda_functions")
    .set({
      ...updates,
      updated_at: sql`NOW()`,
    })
    .where("function_name", "=", name)
    .execute();
}

/**
 * Soft-delete a function by disabling it.
 */
export async function deleteFunction(
  db: Kysely<Database>,
  name: string,
): Promise<void> {
  await db
    .updateTable("lambda_functions")
    .set({
      enabled: false,
      updated_at: sql`NOW()`,
    })
    .where("function_name", "=", name)
    .execute();
}

/**
 * Full-text search across function names, descriptions, and tags using
 * the `search_vector` tsvector column maintained by a database trigger.
 */
export async function searchFunctions(
  db: Kysely<Database>,
  query: string,
): Promise<LambdaFunction[]> {
  return db
    .selectFrom("lambda_functions")
    .selectAll()
    .where("enabled", "=", true)
    .where("visibility", "=", "public")
    .where(
      sql<SqlBool>`search_vector @@ websearch_to_tsquery('english', ${query})`,
    )
    .orderBy(
      sql`ts_rank(search_vector, websearch_to_tsquery('english', ${query}))`,
      "desc",
    )
    .limit(20)
    .execute();
}

/**
 * Retrieve all functions owned by a specific address
 * (both public and private, enabled and disabled).
 */
export async function getFunctionsByOwner(
  db: Kysely<Database>,
  ownerAddress: string,
): Promise<LambdaFunction[]> {
  return db
    .selectFrom("lambda_functions")
    .selectAll()
    .where("owner_address", "=", ownerAddress)
    .orderBy("function_name", "asc")
    .execute();
}
