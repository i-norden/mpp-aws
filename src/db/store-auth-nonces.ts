import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from './types.js';

export async function tryReserveAuthNonce(
  db: Kysely<Database>,
  signerAddress: string,
  nonce: string,
  expiresAt: Date,
): Promise<boolean> {
  const result = await sql<{ inserted: boolean }>`
    WITH ins AS (
      INSERT INTO auth_nonces (signer_address, nonce, expires_at)
      VALUES (${signerAddress}, ${nonce}, ${expiresAt})
      ON CONFLICT (signer_address, nonce) DO NOTHING
      RETURNING 1
    )
    SELECT EXISTS(SELECT 1 FROM ins) AS inserted
  `.execute(db);

  return result.rows[0]?.inserted ?? false;
}

export async function cleanupExpiredAuthNonces(
  db: Kysely<Database>,
): Promise<number> {
  const result = await db
    .deleteFrom('auth_nonces')
    .where('expires_at', '<', sql<Date>`NOW()`)
    .executeTakeFirst();

  return Number(result.numDeletedRows);
}
