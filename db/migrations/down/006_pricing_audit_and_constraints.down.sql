-- Reverse of 006_pricing_audit_and_constraints.sql
DROP TRIGGER IF EXISTS pricing_config_audit_trigger ON pricing_config;
DROP FUNCTION IF EXISTS log_pricing_config_change();
DROP TABLE IF EXISTS pricing_config_audit CASCADE;

DROP INDEX IF EXISTS idx_credits_available;
DROP INDEX IF EXISTS idx_refunds_pending;
DROP INDEX IF EXISTS idx_lambda_invocations_function_time;
DROP INDEX IF EXISTS idx_lambda_invocations_success;
DROP INDEX IF EXISTS idx_voucher_redemptions_status;

ALTER TABLE payment_nonces DROP CONSTRAINT IF EXISTS payment_nonces_status_valid;
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_status_valid;
ALTER TABLE voucher_redemptions DROP CONSTRAINT IF EXISTS voucher_redemptions_status_valid;
ALTER TABLE pricing_config DROP CONSTRAINT IF EXISTS pricing_config_duration_rate_non_negative;
ALTER TABLE pricing_config DROP CONSTRAINT IF EXISTS pricing_config_memory_rate_non_negative;
ALTER TABLE pricing_config DROP CONSTRAINT IF EXISTS pricing_config_base_fee_non_negative;
