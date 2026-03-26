-- 021_production_pricing_network.down.sql
-- Rollback: remove production pricing network config added by migration 021.
-- NOTE: Does NOT drop the 'network' column because it may have been created by
-- migration 001. Only removes the index, constraint, and row that 021 added.

DROP INDEX IF EXISTS idx_pricing_config_network;

ALTER TABLE lease_resources DROP CONSTRAINT IF EXISTS lease_resources_margin_min;

DELETE FROM pricing_config WHERE network = 'base';
