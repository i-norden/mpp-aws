-- Migration 010: Private registry, permissioned invoke, and registerer earnings
--
-- Adds:
-- 1. Owner/visibility fields to lambda_functions (private functions + ownership)
-- 2. function_access_list table (address-based access control for private functions)
-- 3. earnings table + view (track registerer earnings from invocation fees)

-- 1a. Extend lambda_functions with ownership and visibility
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS owner_address TEXT;
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS marketplace_fee_bps INTEGER;

-- Constraint: visibility must be 'public' or 'private'
DO $$ BEGIN
    ALTER TABLE lambda_functions ADD CONSTRAINT chk_visibility
        CHECK (visibility IN ('public', 'private'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_lambda_functions_owner
    ON lambda_functions(owner_address) WHERE owner_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lambda_functions_visibility
    ON lambda_functions(visibility) WHERE enabled = true;

-- 1b. Access list table
CREATE TABLE IF NOT EXISTS function_access_list (
    id              BIGSERIAL PRIMARY KEY,
    function_name   TEXT NOT NULL,
    invoker_address TEXT NOT NULL,
    granted_by      TEXT NOT NULL,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(function_name, invoker_address)
);
CREATE INDEX IF NOT EXISTS idx_access_list_function ON function_access_list(function_name);
CREATE INDEX IF NOT EXISTS idx_access_list_invoker ON function_access_list(invoker_address);

-- 1c. Earnings table
CREATE TABLE IF NOT EXISTS earnings (
    id                BIGSERIAL PRIMARY KEY,
    owner_address     TEXT NOT NULL,
    function_name     TEXT NOT NULL,
    amount            BIGINT NOT NULL,
    invocation_id     BIGINT,
    source_tx_hash    TEXT,
    withdrawn         BOOLEAN NOT NULL DEFAULT false,
    withdrawn_at      TIMESTAMP WITH TIME ZONE,
    withdrawn_tx_hash TEXT,
    created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_earnings_owner ON earnings(owner_address);
CREATE INDEX IF NOT EXISTS idx_earnings_owner_unwithdrawn ON earnings(owner_address) WHERE withdrawn = false;
CREATE INDEX IF NOT EXISTS idx_earnings_function ON earnings(function_name);

-- 1d. Earnings balance view
CREATE OR REPLACE VIEW earnings_balances AS
SELECT
    owner_address,
    SUM(CASE WHEN withdrawn = false THEN amount ELSE 0 END) as available_balance,
    SUM(amount) as total_earned,
    SUM(CASE WHEN withdrawn = true THEN amount ELSE 0 END) as total_withdrawn,
    COUNT(*) as earning_count
FROM earnings
GROUP BY owner_address;
