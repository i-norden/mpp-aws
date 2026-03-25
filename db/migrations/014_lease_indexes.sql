-- 014_lease_indexes.sql
-- Additional indexes for lease query performance and data integrity

-- Prevent double-settlement: unique index on payment_tx_hash
CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_payment_tx
    ON leases(payment_tx_hash);

-- Accelerate stale-price cleanup queries on aws_pricing
CREATE INDEX IF NOT EXISTS idx_aws_pricing_fetched
    ON aws_pricing(last_fetched_at);
