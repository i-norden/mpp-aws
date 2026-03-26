-- Migration 006: Pricing Audit Trail and Additional Constraints
-- Adds audit trail for pricing changes, missing indexes, and CHECK constraints

-- 4.1: Missing index on voucher_redemptions.status
CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_status ON voucher_redemptions(status);

-- 4.2: Add CHECK constraints to pricing_config to ensure non-negative values
-- Using DO block for idempotent constraint addition
DO $$
BEGIN
    -- Check constraint for base_fee >= 0
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pricing_config_base_fee_non_negative'
    ) THEN
        ALTER TABLE pricing_config ADD CONSTRAINT pricing_config_base_fee_non_negative
            CHECK (base_fee >= 0);
    END IF;

    -- Check constraint for memory_rate_per_128mb >= 0
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pricing_config_memory_rate_non_negative'
    ) THEN
        ALTER TABLE pricing_config ADD CONSTRAINT pricing_config_memory_rate_non_negative
            CHECK (memory_rate_per_128mb >= 0);
    END IF;

    -- Check constraint for duration_rate_per_100ms >= 0
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pricing_config_duration_rate_non_negative'
    ) THEN
        ALTER TABLE pricing_config ADD CONSTRAINT pricing_config_duration_rate_non_negative
            CHECK (duration_rate_per_100ms >= 0);
    END IF;
END $$;

-- 4.3: Pricing Configuration Audit Trail
-- Tracks all changes to pricing configuration for compliance and debugging
CREATE TABLE IF NOT EXISTS pricing_config_audit (
    id BIGSERIAL PRIMARY KEY,
    pricing_config_id BIGINT NOT NULL,
    operation TEXT NOT NULL,               -- 'INSERT', 'UPDATE', 'DELETE'
    old_base_fee BIGINT,
    old_memory_rate BIGINT,
    old_duration_rate BIGINT,
    new_base_fee BIGINT,
    new_memory_rate BIGINT,
    new_duration_rate BIGINT,
    changed_by TEXT,                        -- Admin address or system identifier
    change_reason TEXT,                     -- Optional reason for the change
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pricing_audit_config_id ON pricing_config_audit(pricing_config_id);
CREATE INDEX IF NOT EXISTS idx_pricing_audit_changed_at ON pricing_config_audit(changed_at);
CREATE INDEX IF NOT EXISTS idx_pricing_audit_operation ON pricing_config_audit(operation);

COMMENT ON TABLE pricing_config_audit IS 'Audit trail for all pricing configuration changes';
COMMENT ON COLUMN pricing_config_audit.operation IS 'Type of operation: INSERT, UPDATE, or DELETE';
COMMENT ON COLUMN pricing_config_audit.changed_by IS 'Admin address or system identifier that made the change';
COMMENT ON COLUMN pricing_config_audit.change_reason IS 'Optional reason for the pricing change';

-- Trigger function to automatically log pricing changes
CREATE OR REPLACE FUNCTION log_pricing_config_change()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO pricing_config_audit (
            pricing_config_id, operation,
            new_base_fee, new_memory_rate, new_duration_rate,
            changed_at
        ) VALUES (
            NEW.id, 'INSERT',
            NEW.base_fee, NEW.memory_rate_per_128mb, NEW.duration_rate_per_100ms,
            NOW()
        );
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO pricing_config_audit (
            pricing_config_id, operation,
            old_base_fee, old_memory_rate, old_duration_rate,
            new_base_fee, new_memory_rate, new_duration_rate,
            changed_at
        ) VALUES (
            NEW.id, 'UPDATE',
            OLD.base_fee, OLD.memory_rate_per_128mb, OLD.duration_rate_per_100ms,
            NEW.base_fee, NEW.memory_rate_per_128mb, NEW.duration_rate_per_100ms,
            NOW()
        );
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO pricing_config_audit (
            pricing_config_id, operation,
            old_base_fee, old_memory_rate, old_duration_rate,
            changed_at
        ) VALUES (
            OLD.id, 'DELETE',
            OLD.base_fee, OLD.memory_rate_per_128mb, OLD.duration_rate_per_100ms,
            NOW()
        );
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for pricing_config changes (if not exists)
DROP TRIGGER IF EXISTS pricing_config_audit_trigger ON pricing_config;
CREATE TRIGGER pricing_config_audit_trigger
    AFTER INSERT OR UPDATE OR DELETE ON pricing_config
    FOR EACH ROW
    EXECUTE FUNCTION log_pricing_config_change();

-- Additional missing indexes for better query performance
-- Index for lambda_invocations by success status (for analytics)
CREATE INDEX IF NOT EXISTS idx_lambda_invocations_success ON lambda_invocations(success);

-- Index for lambda_invocations by function_name and created_at (for function analytics)
CREATE INDEX IF NOT EXISTS idx_lambda_invocations_function_time
    ON lambda_invocations(function_name, created_at);

-- Index for refunds pending status (for processing queue)
CREATE INDEX IF NOT EXISTS idx_refunds_pending
    ON refunds(created_at)
    WHERE status = 'pending';

-- Index for credits that are available for redemption
CREATE INDEX IF NOT EXISTS idx_credits_available
    ON credits(payer_address, created_at)
    WHERE redeemed = false;

-- Constraint to ensure voucher status is valid
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'voucher_redemptions_status_valid'
    ) THEN
        ALTER TABLE voucher_redemptions ADD CONSTRAINT voucher_redemptions_status_valid
            CHECK (status IN ('pending', 'success', 'failed'));
    END IF;
END $$;

-- Constraint to ensure refund status is valid
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'refunds_status_valid'
    ) THEN
        ALTER TABLE refunds ADD CONSTRAINT refunds_status_valid
            CHECK (status IN ('pending', 'success', 'failed', 'credited'));
    END IF;
END $$;

-- Constraint to ensure payment_nonces status is valid
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'payment_nonces_status_valid'
    ) THEN
        ALTER TABLE payment_nonces ADD CONSTRAINT payment_nonces_status_valid
            CHECK (status IN ('pending', 'settled', 'failed'));
    END IF;
END $$;
