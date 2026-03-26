-- Credits and Refunds System
-- Tracks user credits from failed/small refunds and refund attempts

-- User credits from overpayments that couldn't be refunded on-chain
CREATE TABLE IF NOT EXISTS credits (
    id BIGSERIAL PRIMARY KEY,
    payer_address TEXT NOT NULL,
    amount BIGINT NOT NULL,                    -- atomic USDC
    reason TEXT NOT NULL,                       -- 'failed_refund', 'below_threshold', 'manual'
    source_tx_hash TEXT,                        -- original payment transaction hash
    source_invocation_id BIGINT,                -- reference to lambda_invocations if applicable
    redeemed BOOLEAN NOT NULL DEFAULT false,
    redeemed_at TIMESTAMP WITH TIME ZONE,
    redeemed_tx_hash TEXT,                      -- redemption transaction hash
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credits_payer ON credits(payer_address);
CREATE INDEX IF NOT EXISTS idx_credits_payer_unredeemed ON credits(payer_address) WHERE redeemed = false;
CREATE INDEX IF NOT EXISTS idx_credits_created ON credits(created_at);
CREATE INDEX IF NOT EXISTS idx_credits_invocation ON credits(source_invocation_id);

-- Foreign key constraint for source_invocation_id (only if lambda_invocations table exists)
-- Note: This is added via ALTER TABLE to maintain backwards compatibility
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'lambda_invocations') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'fk_credits_invocation'
        ) THEN
            ALTER TABLE credits ADD CONSTRAINT fk_credits_invocation
                FOREIGN KEY (source_invocation_id) REFERENCES lambda_invocations(id)
                ON DELETE SET NULL;
        END IF;
    END IF;
END $$;

-- Refund attempts
CREATE TABLE IF NOT EXISTS refunds (
    id BIGSERIAL PRIMARY KEY,
    payer_address TEXT NOT NULL,
    amount BIGINT NOT NULL,                     -- atomic USDC
    status TEXT NOT NULL,                       -- 'pending', 'success', 'failed', 'credited'
    source_tx_hash TEXT,                        -- original payment transaction hash
    source_invocation_id BIGINT,                -- reference to lambda_invocations if applicable
    refund_tx_hash TEXT,                        -- refund transaction hash if successful
    error_message TEXT,                         -- error message if failed
    gas_used BIGINT,                            -- actual gas used for refund
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_refunds_payer ON refunds(payer_address);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);
CREATE INDEX IF NOT EXISTS idx_refunds_created ON refunds(created_at);
CREATE INDEX IF NOT EXISTS idx_refunds_invocation ON refunds(source_invocation_id);

-- Foreign key constraint for source_invocation_id (only if lambda_invocations table exists)
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'lambda_invocations') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'fk_refunds_invocation'
        ) THEN
            ALTER TABLE refunds ADD CONSTRAINT fk_refunds_invocation
                FOREIGN KEY (source_invocation_id) REFERENCES lambda_invocations(id)
                ON DELETE SET NULL;
        END IF;
    END IF;
END $$;

-- Add billing columns to lambda_invocations for detailed cost tracking
ALTER TABLE lambda_invocations ADD COLUMN IF NOT EXISTS actual_cloud_cost BIGINT;
ALTER TABLE lambda_invocations ADD COLUMN IF NOT EXISTS fee_amount BIGINT;
ALTER TABLE lambda_invocations ADD COLUMN IF NOT EXISTS refund_amount BIGINT;
ALTER TABLE lambda_invocations ADD COLUMN IF NOT EXISTS refund_status TEXT;
ALTER TABLE lambda_invocations ADD COLUMN IF NOT EXISTS refund_tx_hash TEXT;
ALTER TABLE lambda_invocations ADD COLUMN IF NOT EXISTS billed_duration_ms BIGINT;
ALTER TABLE lambda_invocations ADD COLUMN IF NOT EXISTS memory_mb INTEGER;

-- View for credit balances by address
CREATE OR REPLACE VIEW credit_balances AS
SELECT
    payer_address,
    SUM(CASE WHEN redeemed = false THEN amount ELSE 0 END) as available_balance,
    SUM(amount) as total_credited,
    SUM(CASE WHEN redeemed = true THEN amount ELSE 0 END) as total_redeemed,
    COUNT(*) as credit_count
FROM credits
GROUP BY payer_address;

-- View for refund statistics
CREATE OR REPLACE VIEW refund_stats AS
SELECT
    status,
    COUNT(*) as count,
    SUM(amount) as total_amount,
    AVG(amount) as avg_amount
FROM refunds
GROUP BY status;
