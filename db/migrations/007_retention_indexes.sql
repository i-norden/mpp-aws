-- Migration 007: Add indexes for data retention cleanup queries
-- These indexes support efficient time-range deletion for retention policies.

-- Index for lambda_invocations retention cleanup (delete old invocation records)
CREATE INDEX IF NOT EXISTS idx_lambda_invocations_created_at
    ON lambda_invocations(created_at);

-- Index for voucher_redemptions retention cleanup
CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_redeemed_at
    ON voucher_redemptions(redeemed_at);

-- Partial index for settled/expired payment nonces older than retention window
-- This helps the retention cleanup query find records to delete efficiently
CREATE INDEX IF NOT EXISTS idx_payment_nonces_created_at
    ON payment_nonces(created_at);

-- Comments
COMMENT ON INDEX idx_lambda_invocations_created_at IS 'Supports retention cleanup of old invocation records';
COMMENT ON INDEX idx_voucher_redemptions_redeemed_at IS 'Supports retention cleanup of old voucher redemption records';
COMMENT ON INDEX idx_payment_nonces_created_at IS 'Supports retention cleanup of old payment nonce records';
