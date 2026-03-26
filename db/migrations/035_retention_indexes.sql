-- Partial index on credits for retention cleanup queries.
-- Only indexes withdrawn credits by created_at, which is the exact
-- query pattern used by deleteOldRedeemedCredits().
CREATE INDEX IF NOT EXISTS idx_credits_withdrawn_created
  ON credits (created_at)
  WHERE withdrawal_status = 'withdrawn';

-- Index for stuck refund recovery queries
CREATE INDEX IF NOT EXISTS idx_refunds_pending_no_txhash
  ON refunds (created_at)
  WHERE status = 'pending' AND refund_tx_hash IS NULL;

-- Index for sent-but-unconfirmed refund recovery queries
CREATE INDEX IF NOT EXISTS idx_refunds_pending_with_txhash
  ON refunds (created_at)
  WHERE status = 'pending' AND refund_tx_hash IS NOT NULL;

-- Index for lease anonymization queries
CREATE INDEX IF NOT EXISTS idx_leases_terminated_not_anonymized
  ON leases (terminated_at)
  WHERE status IN ('terminated', 'failed') AND anonymized_at IS NULL;
