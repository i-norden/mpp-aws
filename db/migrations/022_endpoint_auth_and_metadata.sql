-- 022_endpoint_auth_and_metadata.sql
-- Adds endpoint authentication, metadata, and pricing model columns to lambda_functions.

-- Encrypted auth credentials (AES-256-GCM, hex-encoded)
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS endpoint_auth_encrypted TEXT;

-- Auth type for display (never contains secrets): bearer, api_key, basic, custom_header
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS auth_type TEXT;

-- OpenAPI spec URL for agent discovery
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS open_api_spec_url TEXT;

-- Registerer's USDC address for earnings withdrawal (overrides default payer address)
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS pay_to_address TEXT;

-- Pricing model: 'fixed' (exact price, no refund) or 'metered' (max price, refund based on X-Actual-Cost)
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS pricing_model TEXT NOT NULL DEFAULT 'fixed';

-- Constraints (idempotent: check before adding)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_auth_type') THEN
        ALTER TABLE lambda_functions ADD CONSTRAINT chk_auth_type
            CHECK (auth_type IS NULL OR auth_type IN ('bearer', 'api_key', 'basic', 'custom_header'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_pricing_model') THEN
        ALTER TABLE lambda_functions ADD CONSTRAINT chk_pricing_model
            CHECK (pricing_model IN ('fixed', 'metered'));
    END IF;
END $$;
