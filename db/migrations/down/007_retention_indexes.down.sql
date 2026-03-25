-- Reverse of 007_retention_indexes.sql
DROP INDEX IF EXISTS idx_payment_nonces_created_at;
DROP INDEX IF EXISTS idx_voucher_redemptions_redeemed_at;
DROP INDEX IF EXISTS idx_lambda_invocations_created_at;
