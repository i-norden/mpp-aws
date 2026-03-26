-- Down migration for 016: Remove financial constraints and indexes

-- Remove CHECK constraints
ALTER TABLE credits DROP CONSTRAINT IF EXISTS chk_credits_amount_positive;
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS chk_refunds_amount_positive;
ALTER TABLE lambda_invocations DROP CONSTRAINT IF EXISTS chk_invocation_amount_non_negative;
ALTER TABLE earnings DROP CONSTRAINT IF EXISTS chk_earnings_amount_positive;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'aws_pricing') THEN
        ALTER TABLE aws_pricing DROP CONSTRAINT IF EXISTS chk_aws_pricing_price_positive;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'leases') THEN
        ALTER TABLE leases DROP CONSTRAINT IF EXISTS chk_lease_amount_positive;
        ALTER TABLE leases DROP CONSTRAINT IF EXISTS chk_bandwidth_usage_non_negative;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'lease_resources') THEN
        ALTER TABLE lease_resources DROP CONSTRAINT IF EXISTS chk_lease_resource_prices_positive;
        ALTER TABLE lease_resources DROP CONSTRAINT IF EXISTS chk_lease_margin_valid;
        ALTER TABLE lease_resources DROP CONSTRAINT IF EXISTS chk_storage_limits_ordered;
        ALTER TABLE lease_resources DROP CONSTRAINT IF EXISTS chk_bandwidth_limits_positive;
    END IF;
END $$;

-- Remove indexes
DROP INDEX IF EXISTS idx_earnings_function_name;
DROP INDEX IF EXISTS idx_credits_payer_redeemed;
DROP INDEX IF EXISTS idx_refunds_pending_created;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'leases') THEN
        DROP INDEX IF EXISTS idx_leases_payer_status;
    END IF;
END $$;

-- Remove FK
ALTER TABLE earnings DROP CONSTRAINT IF EXISTS fk_earnings_invocation;

-- Note: NOT NULL and default changes are not reversed to avoid data loss.
-- Reverting these would require making columns nullable again, which is
-- generally not recommended in production.
