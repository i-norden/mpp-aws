/**
 * GDPR right-to-erasure (Article 17) operations.
 * TypeScript port of mmp-compute/lambda-proxy/internal/db/retention.go DeleteAllDataForAddress.
 *
 * Deletes all personal data associated with a payer/owner address
 * across credits, invocations, earnings, refunds, and budgets.
 * Leases are ANONYMIZED (not deleted) because lease infrastructure
 * records are needed for AWS reconciliation.
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GDPRDeletionResult {
  creditsDeleted: number;
  invocationsDeleted: number;
  earningsDeleted: number;
  refundsDeleted: number;
  budgetTransactionsDeleted: number;
  budgetsDeleted: number;
  leasesAnonymized: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Remove all personal data associated with the given Ethereum address.
 * Runs within a single transaction for atomicity.
 *
 * - Credits, invocations, earnings, refunds: DELETED
 * - Budget transactions, budgets: DELETED
 * - Leases: ANONYMIZED (payer_address set to 'anonymized', SSH keys cleared)
 */
export async function deleteAllDataForAddress(
  db: Kysely<Database>,
  address: string,
): Promise<GDPRDeletionResult> {
  const normalizedAddress = address.toLowerCase();

  return db.transaction().execute(async (trx) => {
    const result: GDPRDeletionResult = {
      creditsDeleted: 0,
      invocationsDeleted: 0,
      earningsDeleted: 0,
      refundsDeleted: 0,
      budgetTransactionsDeleted: 0,
      budgetsDeleted: 0,
      leasesAnonymized: 0,
    };

    // Delete credits
    const creditsResult = await sql`
      DELETE FROM credits WHERE payer_address = ${normalizedAddress}
    `.execute(trx);
    result.creditsDeleted = Number(creditsResult.numAffectedRows ?? 0);

    // Delete invocations
    const invocationsResult = await sql`
      DELETE FROM lambda_invocations WHERE payer_address = ${normalizedAddress}
    `.execute(trx);
    result.invocationsDeleted = Number(invocationsResult.numAffectedRows ?? 0);

    // Delete earnings
    const earningsResult = await sql`
      DELETE FROM earnings WHERE owner_address = ${normalizedAddress}
    `.execute(trx);
    result.earningsDeleted = Number(earningsResult.numAffectedRows ?? 0);

    // Delete refunds
    const refundsResult = await sql`
      DELETE FROM refunds WHERE payer_address = ${normalizedAddress}
    `.execute(trx);
    result.refundsDeleted = Number(refundsResult.numAffectedRows ?? 0);

    // Delete budget transactions for budgets owned by this address
    const btResult = await sql`
      DELETE FROM budget_transactions WHERE budget_id IN (
        SELECT id FROM budgets WHERE payer_address = ${normalizedAddress}
      )
    `.execute(trx);
    result.budgetTransactionsDeleted = Number(btResult.numAffectedRows ?? 0);

    // Delete budgets
    const budgetsResult = await sql`
      DELETE FROM budgets WHERE payer_address = ${normalizedAddress}
    `.execute(trx);
    result.budgetsDeleted = Number(budgetsResult.numAffectedRows ?? 0);

    // Anonymize leases (not deleted — needed for AWS reconciliation)
    const leasesResult = await sql`
      UPDATE leases
      SET payer_address = 'anonymized',
          ssh_public_key = '',
          encrypted_private_key = '',
          user_public_key = '',
          encryption_nonce = '',
          anonymized_at = NOW()
      WHERE payer_address = ${normalizedAddress}
        AND anonymized_at IS NULL
    `.execute(trx);
    result.leasesAnonymized = Number(leasesResult.numAffectedRows ?? 0);

    return result;
  });
}
