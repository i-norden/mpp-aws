-- Rollback migration 017: Remove lowercase constraint on leases.payer_address
ALTER TABLE leases DROP CONSTRAINT IF EXISTS chk_leases_payer_lower;
