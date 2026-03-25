-- 021_production_pricing_network.sql
-- Production pricing configuration for Base mainnet (chain 8453).
-- Sets explicit pricing for mainnet deployment, validates margin targets,
-- and ensures pricing_config has a network column for multi-network support.

-- Add network column to pricing_config if it doesn't exist
ALTER TABLE pricing_config ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'base-sepolia';

-- Insert production pricing configuration for Base mainnet.
-- Pricing rationale (all amounts in atomic USDC, 1 USDC = 1,000,000 atomic):
--   BASE_FEE = 5000 ($0.005) — covers fixed overhead per invocation
--   MEMORY_RATE_PER_128MB = 1000 ($0.001) — scales with Lambda memory allocation
--   DURATION_RATE_PER_100MS = 500 ($0.0005) — scales with execution time
--   FEE_PERCENTAGE = 10% — platform margin on computed cost
--
-- These defaults align with `config.go` Load() defaults and are intended as
-- the database-persisted version for the production environment.
INSERT INTO pricing_config (
    base_fee,
    memory_rate_per_128mb,
    duration_rate_per_100ms,
    network
) VALUES (
    5000,     -- $0.005 base fee
    1000,     -- $0.001 per 128MB
    500,      -- $0.0005 per 100ms
    'base'    -- Base mainnet
)
ON CONFLICT DO NOTHING;

-- Update lease_resources margin_percent to production target (20%).
-- This ensures all seed resources carry the correct margin for mainnet.
UPDATE lease_resources SET margin_percent = 20 WHERE margin_percent IS NULL OR margin_percent < 5;

-- Add a CHECK constraint to prevent margins below the minimum (5%).
-- This mirrors the validation in config.go ValidateProductionSafety().
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name = 'lease_resources_margin_min'
    ) THEN
        ALTER TABLE lease_resources ADD CONSTRAINT lease_resources_margin_min
            CHECK (margin_percent >= 5);
    END IF;
END $$;

-- Add index for pricing lookups by network
CREATE INDEX IF NOT EXISTS idx_pricing_config_network ON pricing_config(network);
