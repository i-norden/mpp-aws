-- Migration 017: Enforce lowercase payer_address on leases table
--
-- Without this constraint, users can bypass per-user lease limits by
-- varying the case of their Ethereum address (e.g., 0xABC vs 0xabc).

-- Backfill: normalize existing addresses to lowercase
UPDATE leases SET payer_address = LOWER(payer_address)
  WHERE payer_address != LOWER(payer_address);

-- Add CHECK constraint to prevent future case-variant bypass
DO $$ BEGIN
    ALTER TABLE leases ADD CONSTRAINT chk_leases_payer_lower
        CHECK (payer_address = LOWER(payer_address));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
