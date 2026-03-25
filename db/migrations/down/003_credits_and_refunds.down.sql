-- Reverse of 003_credits_and_refunds.sql
DROP VIEW IF EXISTS refund_stats;
DROP VIEW IF EXISTS credit_balances;
DROP TABLE IF EXISTS refunds CASCADE;
DROP TABLE IF EXISTS credits CASCADE;
ALTER TABLE lambda_invocations
    DROP COLUMN IF EXISTS actual_cloud_cost,
    DROP COLUMN IF EXISTS fee_amount,
    DROP COLUMN IF EXISTS refund_amount,
    DROP COLUMN IF EXISTS refund_status,
    DROP COLUMN IF EXISTS refund_tx_hash,
    DROP COLUMN IF EXISTS billed_duration_ms,
    DROP COLUMN IF EXISTS memory_mb;
