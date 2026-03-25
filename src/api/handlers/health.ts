import type { Context } from 'hono';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';

export function createHealthHandlers(db?: Kysely<Database>) {
  return {
    handleHealth(c: Context) {
      return c.json({
        status: 'ok',
        service: 'mmp-aws',
        timestamp: new Date().toISOString(),
      });
    },

    handleHealthLive(c: Context) {
      return c.json({ status: 'ok' });
    },

    async handleHealthReady(c: Context) {
      if (!db) {
        return c.json({ status: 'ok', database: 'not configured' });
      }
      try {
        const result = await db.selectFrom('pricing_config').select(db.fn.count('id').as('count')).executeTakeFirst();
        return c.json({ status: 'ok', database: 'connected', check: result });
      } catch (err) {
        return c.json({ status: 'error', database: 'unreachable', error: String(err) }, 503);
      }
    },
  };
}
