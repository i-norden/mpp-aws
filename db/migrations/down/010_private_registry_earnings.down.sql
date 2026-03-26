-- Reverse of 010_private_registry_earnings.sql
DROP VIEW IF EXISTS earnings_balances;
DROP TABLE IF EXISTS earnings CASCADE;
DROP TABLE IF EXISTS function_access_list CASCADE;

DROP INDEX IF EXISTS idx_lambda_functions_visibility;
DROP INDEX IF EXISTS idx_lambda_functions_owner;
ALTER TABLE lambda_functions DROP CONSTRAINT IF EXISTS chk_visibility;
ALTER TABLE lambda_functions
    DROP COLUMN IF EXISTS marketplace_fee_bps,
    DROP COLUMN IF EXISTS visibility,
    DROP COLUMN IF EXISTS owner_address;
