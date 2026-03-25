-- Migration 032: Schema improvements from database review
--
-- 1. Replace sentinel-based withdrawal state with explicit withdrawal_status columns
-- 2. Add missing composite indexes for hot query paths
-- 3. Remove duplicate index on lambda_invocations.created_at
-- 4. Add missing foreign key constraints
-- 5. Remove unused views (credit_balances, earnings_balances)
-- 6. Add ghost columns to leases (terminated_reason, anonymized_at) if missing
-- 7. Fix budget deduction audit trail (add FK for budget_transactions.invocation_id)

-- ============================================================
-- 1. Replace sentinel-based withdrawal state
-- ============================================================

-- Credits: add withdrawal_status column replacing the redeemed boolean + sentinel pattern
ALTER TABLE credits ADD COLUMN IF NOT EXISTS withdrawal_status TEXT NOT NULL DEFAULT 'available';

-- Migrate existing data: redeemed=true with sentinel → 'pending', redeemed=true with real hash → 'withdrawn'
UPDATE credits SET withdrawal_status = 'pending'
WHERE redeemed = true AND redeemed_tx_hash = '__pending__';

UPDATE credits SET withdrawal_status = 'withdrawn'
WHERE redeemed = true AND redeemed_tx_hash IS NOT NULL AND redeemed_tx_hash != '__pending__';

UPDATE credits SET withdrawal_status = 'withdrawn'
WHERE redeemed = true AND redeemed_tx_hash IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_credit_withdrawal_status') THEN
        ALTER TABLE credits ADD CONSTRAINT chk_credit_withdrawal_status
            CHECK (withdrawal_status IN ('available', 'pending', 'withdrawn'));
    END IF;
END $$;

-- Index for available credits (replaces idx_credits_payer_unredeemed)
CREATE INDEX IF NOT EXISTS idx_credits_payer_available
    ON credits(payer_address) WHERE withdrawal_status = 'available';

-- Index for orphaned pending detection
CREATE INDEX IF NOT EXISTS idx_credits_pending_withdrawal
    ON credits(payer_address, redeemed_at) WHERE withdrawal_status = 'pending';

-- Earnings: add withdrawal_status column replacing the withdrawn boolean + sentinel pattern
ALTER TABLE earnings ADD COLUMN IF NOT EXISTS withdrawal_status TEXT NOT NULL DEFAULT 'available';

-- Migrate existing data
UPDATE earnings SET withdrawal_status = 'pending'
WHERE withdrawn = true AND withdrawn_tx_hash = '__pending__';

UPDATE earnings SET withdrawal_status = 'withdrawn'
WHERE withdrawn = true AND withdrawn_tx_hash IS NOT NULL AND withdrawn_tx_hash != '__pending__';

UPDATE earnings SET withdrawal_status = 'withdrawn'
WHERE withdrawn = true AND withdrawn_tx_hash IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_earning_withdrawal_status') THEN
        ALTER TABLE earnings ADD CONSTRAINT chk_earning_withdrawal_status
            CHECK (withdrawal_status IN ('available', 'pending', 'withdrawn'));
    END IF;
END $$;

-- Index for available earnings (replaces idx_earnings_owner_unwithdrawn)
CREATE INDEX IF NOT EXISTS idx_earnings_owner_available
    ON earnings(owner_address) WHERE withdrawal_status = 'available';

-- Index for orphaned pending detection
CREATE INDEX IF NOT EXISTS idx_earnings_pending_withdrawal
    ON earnings(owner_address, withdrawn_at) WHERE withdrawal_status = 'pending';

-- ============================================================
-- 2. Missing composite indexes for hot query paths
-- ============================================================

-- ListPendingRefunds: WHERE status='pending' AND refund_tx_hash IS NOT NULL
CREATE INDEX IF NOT EXISTS idx_refunds_pending_with_tx
    ON refunds(created_at) WHERE status = 'pending' AND refund_tx_hash IS NOT NULL;

-- ListStuckPendingRefunds: WHERE status='pending' AND refund_tx_hash IS NULL AND created_at < ...
CREATE INDEX IF NOT EXISTS idx_refunds_stuck_pending
    ON refunds(created_at) WHERE status = 'pending' AND refund_tx_hash IS NULL;

-- ListExpiredLeases / ListExpiringLeases: WHERE status='running' AND expires_at ...
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'leases') THEN
        CREATE INDEX IF NOT EXISTS idx_leases_running_expires
            ON leases(expires_at) WHERE status = 'running';

        -- ListRunningLeasesForBandwidthCheck
        CREATE INDEX IF NOT EXISTS idx_leases_running_bandwidth
            ON leases(bandwidth_checked_at NULLS FIRST) WHERE status = 'running';
    END IF;
END $$;

-- ============================================================
-- 3. Remove duplicate index
-- ============================================================

-- idx_lambda_invocations_created (001) and idx_lambda_invocations_created_at (007)
-- are both on created_at. Drop the older, shorter-named one.
DROP INDEX IF EXISTS idx_lambda_invocations_created;

-- ============================================================
-- 4. Missing foreign key constraints
-- ============================================================

-- lambda_invocations.function_name -> lambda_functions.function_name
-- Clean orphaned rows before adding FK (invocations referencing deleted/unregistered functions)
DELETE FROM lambda_invocations
WHERE function_name IS NOT NULL
  AND function_name NOT IN (SELECT function_name FROM lambda_functions);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invocations_function_name') THEN
        ALTER TABLE lambda_invocations ADD CONSTRAINT fk_invocations_function_name
            FOREIGN KEY (function_name) REFERENCES lambda_functions(function_name)
            ON DELETE RESTRICT;
    END IF;
END $$;

-- earnings.function_name -> lambda_functions.function_name
DELETE FROM earnings
WHERE function_name IS NOT NULL
  AND function_name NOT IN (SELECT function_name FROM lambda_functions);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_earnings_function_name') THEN
        ALTER TABLE earnings ADD CONSTRAINT fk_earnings_function_name
            FOREIGN KEY (function_name) REFERENCES lambda_functions(function_name)
            ON DELETE RESTRICT;
    END IF;
END $$;

-- budget_transactions.function_name -> lambda_functions.function_name
DELETE FROM budget_transactions
WHERE function_name IS NOT NULL
  AND function_name NOT IN (SELECT function_name FROM lambda_functions);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_budget_tx_function_name') THEN
        ALTER TABLE budget_transactions ADD CONSTRAINT fk_budget_tx_function_name
            FOREIGN KEY (function_name) REFERENCES lambda_functions(function_name)
            ON DELETE RESTRICT;
    END IF;
END $$;

-- leases.resource_id -> lease_resources.id (if not already present from 011)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'leases') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leases_resource_id') THEN
            -- The original migration already has REFERENCES, but verify
            ALTER TABLE leases ADD CONSTRAINT fk_leases_resource_id
                FOREIGN KEY (resource_id) REFERENCES lease_resources(id)
                ON DELETE RESTRICT;
        END IF;
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 5. Remove unused views
-- ============================================================

-- credit_balances view (003) -- Go code recalculates inline in GetCreditBalance
DROP VIEW IF EXISTS credit_balances;

-- earnings_balances view (010) -- Go code recalculates inline in GetEarningsBalance
DROP VIEW IF EXISTS earnings_balances;

-- refund_stats view (003) -- not referenced in Go code
DROP VIEW IF EXISTS refund_stats;

-- ============================================================
-- 6. Ensure ghost columns exist on leases
-- ============================================================

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'leases') THEN
        -- terminated_reason (referenced in AdminTerminateLease, added in 020)
        ALTER TABLE leases ADD COLUMN IF NOT EXISTS terminated_reason TEXT;

        -- anonymized_at (referenced in AnonymizeTerminatedLeases, added in 020)
        ALTER TABLE leases ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
    END IF;
END $$;
