-- Migration 016: Financial constraints, indexes, and schema hardening
-- Adds CHECK constraints to prevent negative/zero amounts in financial tables,
-- missing indexes for common query patterns, foreign keys, NOT NULL defaults,
-- and timestamp standardization.

-- ============================================================
-- CHECK CONSTRAINTS on financial amount columns
-- ============================================================

-- Credits: amount must be positive
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_credits_amount_positive') THEN
        ALTER TABLE credits ADD CONSTRAINT chk_credits_amount_positive CHECK (amount > 0);
    END IF;
END $$;

-- Refunds: amount must be positive
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_refunds_amount_positive') THEN
        ALTER TABLE refunds ADD CONSTRAINT chk_refunds_amount_positive CHECK (amount > 0);
    END IF;
END $$;

-- Invocations: amount_paid must be non-negative (can be 0 for free-tier)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invocation_amount_non_negative') THEN
        ALTER TABLE lambda_invocations ADD CONSTRAINT chk_invocation_amount_non_negative CHECK (amount_paid >= 0);
    END IF;
END $$;

-- Earnings: amount must be positive
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_earnings_amount_positive') THEN
        ALTER TABLE earnings ADD CONSTRAINT chk_earnings_amount_positive CHECK (amount > 0);
    END IF;
END $$;

-- AWS pricing: price must be positive
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aws_pricing_price_positive') THEN
        -- Only add if table exists (lease system may not be enabled)
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'aws_pricing') THEN
            ALTER TABLE aws_pricing ADD CONSTRAINT chk_aws_pricing_price_positive CHECK (price_usd > 0);
        END IF;
    END IF;
END $$;

-- Lease amounts: must be positive
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'leases') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_lease_amount_positive') THEN
            ALTER TABLE leases ADD CONSTRAINT chk_lease_amount_positive CHECK (amount_paid > 0);
        END IF;
    END IF;
END $$;

-- Lease resource pricing: must be positive
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'lease_resources') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_lease_resource_prices_positive') THEN
            ALTER TABLE lease_resources ADD CONSTRAINT chk_lease_resource_prices_positive
                CHECK (price_1d > 0 AND price_7d > 0 AND price_30d > 0);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_lease_margin_valid') THEN
            ALTER TABLE lease_resources ADD CONSTRAINT chk_lease_margin_valid
                CHECK (margin_percent >= 0 AND margin_percent <= 100);
        END IF;
    END IF;
END $$;

-- Lease resource storage limits: min <= default <= max
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'lease_resources') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_storage_limits_ordered') THEN
            ALTER TABLE lease_resources ADD CONSTRAINT chk_storage_limits_ordered
                CHECK (min_storage_gb <= default_storage_gb AND default_storage_gb <= max_storage_gb);
        END IF;
    END IF;
END $$;

-- Lease bandwidth: must be positive
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'lease_resources') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bandwidth_limits_positive') THEN
            ALTER TABLE lease_resources ADD CONSTRAINT chk_bandwidth_limits_positive
                CHECK (egress_limit_gb > 0 AND ingress_limit_gb > 0);
        END IF;
    END IF;
END $$;

-- Lease bandwidth usage: must be non-negative
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'leases') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bandwidth_usage_non_negative') THEN
            ALTER TABLE leases ADD CONSTRAINT chk_bandwidth_usage_non_negative
                CHECK (egress_used_gb >= 0 AND ingress_used_gb >= 0);
        END IF;
    END IF;
END $$;

-- ============================================================
-- NOT NULL defaults for billing columns
-- ============================================================

-- Set defaults for billing columns that were added without NOT NULL
DO $$
BEGIN
    -- actual_cloud_cost
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'lambda_invocations' AND column_name = 'actual_cloud_cost'
               AND is_nullable = 'YES') THEN
        ALTER TABLE lambda_invocations ALTER COLUMN actual_cloud_cost SET DEFAULT 0;
        UPDATE lambda_invocations SET actual_cloud_cost = 0 WHERE actual_cloud_cost IS NULL;
        ALTER TABLE lambda_invocations ALTER COLUMN actual_cloud_cost SET NOT NULL;
    END IF;

    -- fee_amount
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'lambda_invocations' AND column_name = 'fee_amount'
               AND is_nullable = 'YES') THEN
        ALTER TABLE lambda_invocations ALTER COLUMN fee_amount SET DEFAULT 0;
        UPDATE lambda_invocations SET fee_amount = 0 WHERE fee_amount IS NULL;
        ALTER TABLE lambda_invocations ALTER COLUMN fee_amount SET NOT NULL;
    END IF;

    -- refund_amount
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'lambda_invocations' AND column_name = 'refund_amount'
               AND is_nullable = 'YES') THEN
        ALTER TABLE lambda_invocations ALTER COLUMN refund_amount SET DEFAULT 0;
        UPDATE lambda_invocations SET refund_amount = 0 WHERE refund_amount IS NULL;
        ALTER TABLE lambda_invocations ALTER COLUMN refund_amount SET NOT NULL;
    END IF;

    -- refund_status
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'lambda_invocations' AND column_name = 'refund_status'
               AND is_nullable = 'YES') THEN
        ALTER TABLE lambda_invocations ALTER COLUMN refund_status SET DEFAULT 'none';
        UPDATE lambda_invocations SET refund_status = 'none' WHERE refund_status IS NULL;
        ALTER TABLE lambda_invocations ALTER COLUMN refund_status SET NOT NULL;
    END IF;

    -- billed_duration_ms
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'lambda_invocations' AND column_name = 'billed_duration_ms'
               AND is_nullable = 'YES') THEN
        ALTER TABLE lambda_invocations ALTER COLUMN billed_duration_ms SET DEFAULT 0;
        UPDATE lambda_invocations SET billed_duration_ms = 0 WHERE billed_duration_ms IS NULL;
        ALTER TABLE lambda_invocations ALTER COLUMN billed_duration_ms SET NOT NULL;
    END IF;

    -- memory_mb on invocations
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'lambda_invocations' AND column_name = 'memory_mb'
               AND is_nullable = 'YES') THEN
        ALTER TABLE lambda_invocations ALTER COLUMN memory_mb SET DEFAULT 0;
        UPDATE lambda_invocations SET memory_mb = 0 WHERE memory_mb IS NULL;
        ALTER TABLE lambda_invocations ALTER COLUMN memory_mb SET NOT NULL;
    END IF;
END $$;

-- ============================================================
-- Missing indexes for common query patterns
-- ============================================================

-- Earnings by function name (used in GetEarningsByFunction)
CREATE INDEX IF NOT EXISTS idx_earnings_function_name ON earnings(function_name);

-- Leases by payer + status (common query pattern)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'leases') THEN
        CREATE INDEX IF NOT EXISTS idx_leases_payer_status ON leases(payer_address, status);
    END IF;
END $$;

-- Credits by payer + redeemed (used in RedeemCredits)
CREATE INDEX IF NOT EXISTS idx_credits_payer_redeemed ON credits(payer_address, redeemed);

-- Refunds: pending status with created_at for efficient cleanup queries
CREATE INDEX IF NOT EXISTS idx_refunds_pending_created ON refunds(created_at) WHERE status = 'pending';

-- ============================================================
-- Foreign key: earnings -> invocations
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_earnings_invocation') THEN
        -- Only add FK if invocation_id column exists
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'earnings' AND column_name = 'invocation_id') THEN
            ALTER TABLE earnings ADD CONSTRAINT fk_earnings_invocation
                FOREIGN KEY (invocation_id) REFERENCES lambda_invocations(id) ON DELETE SET NULL;
        END IF;
    END IF;
END $$;

-- ============================================================
-- Default status values for consistency
-- ============================================================

DO $$
BEGIN
    -- credits.redeemed should default to false
    ALTER TABLE credits ALTER COLUMN redeemed SET DEFAULT false;

    -- refunds.status should default to 'pending'
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'refunds' AND column_name = 'status') THEN
        ALTER TABLE refunds ALTER COLUMN status SET DEFAULT 'pending';
    END IF;

    -- voucher_redemptions.status should default to 'pending'
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'voucher_redemptions' AND column_name = 'status') THEN
        ALTER TABLE voucher_redemptions ALTER COLUMN status SET DEFAULT 'pending';
    END IF;
END $$;

-- ============================================================
-- Timestamp standardization: ensure all timestamps use TIMESTAMPTZ
-- ============================================================

DO $$
BEGIN
    -- payment_nonces.created_at may be TIMESTAMP without TZ
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'payment_nonces' AND column_name = 'created_at'
               AND data_type = 'timestamp without time zone') THEN
        ALTER TABLE payment_nonces ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
    END IF;
END $$;
