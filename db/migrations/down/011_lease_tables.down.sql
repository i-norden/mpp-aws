-- Reverse of 011_lease_tables.sql
DROP INDEX IF EXISTS idx_leases_resource;
DROP INDEX IF EXISTS idx_leases_payer;
DROP INDEX IF EXISTS idx_leases_expires;
DROP INDEX IF EXISTS idx_leases_status;
DROP TABLE IF EXISTS leases CASCADE;
DROP TABLE IF EXISTS lease_resources CASCADE;
