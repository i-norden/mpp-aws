import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import type { Database } from "./types.js";

export type { Database } from "./types.js";

/**
 * Create a Kysely database instance backed by a pg connection pool.
 *
 * @param databaseUrl - A PostgreSQL connection string
 *                      (e.g. `postgres://user:pass@host:5432/dbname`).
 * @returns A typed Kysely<Database> instance ready for queries.
 */
export function createDatabase(databaseUrl: string): Kysely<Database> {
  const dialect = new PostgresDialect({
    pool: new Pool({
      connectionString: databaseUrl,
      max: 25,
    }),
  });

  return new Kysely<Database>({ dialect });
}
