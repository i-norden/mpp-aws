import { type Kysely, type Transaction, sql } from "kysely";

import type { Database } from "./types.js";

/** Accepts both Kysely instances and Kysely transactions. */
type KyselyExecutor<DB> = Kysely<DB> | Transaction<DB>;

/**
 * Store wraps a Kysely<Database> instance and provides transactional helpers.
 *
 * Domain-specific query methods live in separate modules (store-functions.ts,
 * store-nonces.ts, etc.) and accept the Kysely executor from this Store so
 * they work identically inside or outside a transaction.
 */
export class Store {
  readonly db: KyselyExecutor<Database>;

  constructor(db: KyselyExecutor<Database>) {
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
      const txStore = new Store(trx);
      return fn(txStore);
    });
  }
}
