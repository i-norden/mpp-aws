import { Kysely, sql } from "kysely";

import type { Database } from "./types.js";

/**
 * Store wraps a Kysely<Database> instance and provides transactional helpers.
 *
 * Domain-specific query methods live in separate modules (store-functions.ts,
 * store-nonces.ts, etc.) and accept the Kysely executor from this Store so
 * they work identically inside or outside a transaction.
 */
export class Store {
  readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  /**
   * Verify that the database connection is alive.
   * Throws if the connection is unreachable.
   */
  async ping(): Promise<void> {
    await sql`SELECT 1`.execute(this.db);
  }

  /**
   * Execute `fn` inside a database transaction.  A new `Store` backed by the
   * transactional connection is passed to `fn`.  If `fn` resolves, the
   * transaction is committed; if it rejects, the transaction is rolled back.
   *
   * All store helper functions that accept a `Kysely<Database>` can be used
   * with `txStore.db` to participate in the transaction transparently.
   */
  async withTransaction<T>(
    fn: (txStore: Store) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const txStore = new Store(trx as unknown as Kysely<Database>);
      return fn(txStore);
    });
  }
}
