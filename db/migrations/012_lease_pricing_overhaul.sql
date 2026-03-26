-- 012_lease_pricing_overhaul.sql
-- Dynamic pricing from AWS, configurable add-ons, bandwidth enforcement

-- AWS pricing cache (refreshed daily from AWS Pricing API)
CREATE TABLE IF NOT EXISTS aws_pricing (
    id              SERIAL PRIMARY KEY,
    service         TEXT NOT NULL,            -- 'ec2', 'ebs', 'ipv4', 'data_transfer', 'alb'
    resource_key    TEXT NOT NULL,            -- 't3.medium', 'gp3', 'out-1-10tb', etc.
    region          TEXT NOT NULL,            -- 'us-east-1'
    unit            TEXT NOT NULL,            -- 'per_hour', 'per_gb_month', 'per_gb'
    price_usd       NUMERIC(20,10) NOT NULL,
    last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (service, resource_key, region)
);

-- Extend lease_resources with margin and limits
ALTER TABLE lease_resources
    ADD COLUMN IF NOT EXISTS margin_percent    INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN IF NOT EXISTS default_storage_gb INTEGER NOT NULL DEFAULT 30,
    ADD COLUMN IF NOT EXISTS min_storage_gb     INTEGER NOT NULL DEFAULT 8,
    ADD COLUMN IF NOT EXISTS max_storage_gb     INTEGER NOT NULL DEFAULT 1000,
    ADD COLUMN IF NOT EXISTS egress_limit_gb    INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN IF NOT EXISTS ingress_limit_gb   INTEGER NOT NULL DEFAULT 500,
    ADD COLUMN IF NOT EXISTS public_ip_default  BOOLEAN NOT NULL DEFAULT true;
-- NOTE: price_1d/7d/30d remain as manual fallback when aws_pricing is empty.

-- Extend leases with add-on selections and bandwidth tracking
ALTER TABLE leases
    ADD COLUMN IF NOT EXISTS storage_gb           INTEGER,
    ADD COLUMN IF NOT EXISTS has_public_ip         BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS has_load_balancer     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS egress_limit_gb       INTEGER,
    ADD COLUMN IF NOT EXISTS ingress_limit_gb      INTEGER,
    ADD COLUMN IF NOT EXISTS egress_used_gb        NUMERIC(12,3) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ingress_used_gb       NUMERIC(12,3) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS bandwidth_checked_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS price_breakdown       JSONB;

CREATE INDEX IF NOT EXISTS idx_aws_pricing_lookup
    ON aws_pricing(service, resource_key, region);
CREATE INDEX IF NOT EXISTS idx_leases_bandwidth_check
    ON leases(status, bandwidth_checked_at) WHERE status = 'running';
