-- 022_endpoint_auth_and_metadata.down.sql
-- Rollback: remove endpoint auth, metadata, and pricing model columns.

ALTER TABLE lambda_functions DROP CONSTRAINT IF EXISTS chk_pricing_model;
ALTER TABLE lambda_functions DROP CONSTRAINT IF EXISTS chk_auth_type;

ALTER TABLE lambda_functions DROP COLUMN IF EXISTS pricing_model;
ALTER TABLE lambda_functions DROP COLUMN IF EXISTS pay_to_address;
ALTER TABLE lambda_functions DROP COLUMN IF EXISTS open_api_spec_url;
ALTER TABLE lambda_functions DROP COLUMN IF EXISTS auth_type;
ALTER TABLE lambda_functions DROP COLUMN IF EXISTS endpoint_auth_encrypted;
