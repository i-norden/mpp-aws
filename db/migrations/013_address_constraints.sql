-- Migration 013: Enforce lowercase Ethereum addresses at database level
--
-- Application code normalizes addresses to lowercase via strings.ToLower(),
-- but if any code path misses normalization, access control comparisons break.
-- These CHECK constraints act as a safety net.

-- lambda_invocations.payer_address
DO $$ BEGIN
    ALTER TABLE lambda_invocations ADD CONSTRAINT chk_invocations_payer_lower
        CHECK (payer_address = LOWER(payer_address));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- credits.payer_address
DO $$ BEGIN
    ALTER TABLE credits ADD CONSTRAINT chk_credits_payer_lower
        CHECK (payer_address = LOWER(payer_address));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- refunds.payer_address
DO $$ BEGIN
    ALTER TABLE refunds ADD CONSTRAINT chk_refunds_payer_lower
        CHECK (payer_address = LOWER(payer_address));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- voucher_redemptions.payer_address
DO $$ BEGIN
    ALTER TABLE voucher_redemptions ADD CONSTRAINT chk_voucher_payer_lower
        CHECK (payer_address = LOWER(payer_address));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- lambda_functions.owner_address (nullable, so only check when non-null)
DO $$ BEGIN
    ALTER TABLE lambda_functions ADD CONSTRAINT chk_functions_owner_lower
        CHECK (owner_address IS NULL OR owner_address = LOWER(owner_address));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- function_access_list.invoker_address and granted_by
DO $$ BEGIN
    ALTER TABLE function_access_list ADD CONSTRAINT chk_acl_invoker_lower
        CHECK (invoker_address = LOWER(invoker_address));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE function_access_list ADD CONSTRAINT chk_acl_granted_lower
        CHECK (granted_by = LOWER(granted_by));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- earnings.owner_address
DO $$ BEGIN
    ALTER TABLE earnings ADD CONSTRAINT chk_earnings_owner_lower
        CHECK (owner_address = LOWER(owner_address));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
