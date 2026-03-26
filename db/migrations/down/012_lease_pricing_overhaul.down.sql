-- Reverse of 012_lease_pricing_overhaul.sql

-- Drop indexes added in 012
DROP INDEX IF EXISTS idx_leases_bandwidth_check;
DROP INDEX IF EXISTS idx_aws_pricing_lookup;

-- Remove columns added to leases
ALTER TABLE leases
    DROP COLUMN IF EXISTS price_breakdown,
    DROP COLUMN IF EXISTS bandwidth_checked_at,
    DROP COLUMN IF EXISTS ingress_used_gb,
    DROP COLUMN IF EXISTS egress_used_gb,
    DROP COLUMN IF EXISTS ingress_limit_gb,
    DROP COLUMN IF EXISTS egress_limit_gb,
    DROP COLUMN IF EXISTS has_load_balancer,
    DROP COLUMN IF EXISTS has_public_ip,
    DROP COLUMN IF EXISTS storage_gb;

-- Remove columns added to lease_resources
ALTER TABLE lease_resources
    DROP COLUMN IF EXISTS public_ip_default,
    DROP COLUMN IF EXISTS ingress_limit_gb,
    DROP COLUMN IF EXISTS egress_limit_gb,
    DROP COLUMN IF EXISTS max_storage_gb,
    DROP COLUMN IF EXISTS min_storage_gb,
    DROP COLUMN IF EXISTS default_storage_gb,
    DROP COLUMN IF EXISTS margin_percent;

-- Drop the aws_pricing table
DROP TABLE IF EXISTS aws_pricing CASCADE;
