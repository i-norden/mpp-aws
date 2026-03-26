-- 015_seed_lease_resources.sql
-- Seed lease_resources with initial EC2 instance types for POC.
-- Static prices (price_1d/7d/30d) are fallbacks when AWS Pricing API data is unavailable.
-- When running, the pricing fetcher populates aws_pricing and the calculator uses dynamic prices.
--
-- Static prices include ~20% margin over AWS on-demand rates (us-east-1, Feb 2025):
--   t3.medium  = $0.0416/hr → ~$1.00/day  → fallback: $1.20/day
--   t3.large   = $0.0832/hr → ~$2.00/day  → fallback: $2.40/day
--   t3.xlarge  = $0.1664/hr → ~$3.99/day  → fallback: $4.80/day
--   m6i.large  = $0.096/hr  → ~$2.30/day  → fallback: $2.80/day
--   m6i.xlarge = $0.192/hr  → ~$4.61/day  → fallback: $5.60/day
--   c6i.large  = $0.085/hr  → ~$2.04/day  → fallback: $2.50/day
--
-- AMI: Ubuntu 24.04 LTS (us-east-1) — ami-0136735c2bb5cf5bf

INSERT INTO lease_resources (
    id, display_name, instance_type, vcpus, memory_gb, storage_gb,
    ami_id, ssh_user, description,
    price_1d, price_7d, price_30d,
    max_concurrent, enabled,
    margin_percent, default_storage_gb, min_storage_gb, max_storage_gb,
    egress_limit_gb, ingress_limit_gb, public_ip_default
) VALUES
-- General Purpose (burstable) -------------------------------------------------
(
    't3-medium', 'T3 Medium', 't3.medium', 2, 4.0, 30,
    'ami-0136735c2bb5cf5bf', 'ubuntu',
    '2 vCPUs, 4 GB RAM — Good for dev/test workloads and light services',
    1200000, 7800000, 30000000,
    10, true,
    20, 30, 8, 500,
    100, 500, true
),
(
    't3-large', 'T3 Large', 't3.large', 2, 8.0, 30,
    'ami-0136735c2bb5cf5bf', 'ubuntu',
    '2 vCPUs, 8 GB RAM — Good for medium workloads, caching, and small databases',
    2400000, 15600000, 60000000,
    10, true,
    20, 30, 8, 500,
    100, 500, true
),
(
    't3-xlarge', 'T3 XLarge', 't3.xlarge', 4, 16.0, 50,
    'ami-0136735c2bb5cf5bf', 'ubuntu',
    '4 vCPUs, 16 GB RAM — Good for larger workloads, CI/CD runners, and applications',
    4800000, 31200000, 120000000,
    5, true,
    20, 50, 8, 1000,
    200, 500, true
),
-- General Purpose (fixed performance) -----------------------------------------
(
    'm6i-large', 'M6i Large', 'm6i.large', 2, 8.0, 30,
    'ami-0136735c2bb5cf5bf', 'ubuntu',
    '2 vCPUs, 8 GB RAM (fixed perf) — Consistent performance for steady-state workloads',
    2800000, 18200000, 70000000,
    5, true,
    20, 30, 8, 500,
    100, 500, true
),
(
    'm6i-xlarge', 'M6i XLarge', 'm6i.xlarge', 4, 16.0, 50,
    'ami-0136735c2bb5cf5bf', 'ubuntu',
    '4 vCPUs, 16 GB RAM (fixed perf) — Production workloads, databases, and APIs',
    5600000, 36400000, 140000000,
    5, true,
    20, 50, 8, 1000,
    200, 500, true
),
-- Compute Optimized -----------------------------------------------------------
(
    'c6i-large', 'C6i Large', 'c6i.large', 2, 4.0, 30,
    'ami-0136735c2bb5cf5bf', 'ubuntu',
    '2 vCPUs, 4 GB RAM (compute opt) — High-performance computing, batch processing',
    2500000, 16200000, 62000000,
    5, true,
    20, 30, 8, 500,
    100, 500, true
)
ON CONFLICT (id) DO UPDATE SET
    display_name      = EXCLUDED.display_name,
    instance_type     = EXCLUDED.instance_type,
    vcpus             = EXCLUDED.vcpus,
    memory_gb         = EXCLUDED.memory_gb,
    storage_gb        = EXCLUDED.storage_gb,
    ami_id            = EXCLUDED.ami_id,
    description       = EXCLUDED.description,
    price_1d          = EXCLUDED.price_1d,
    price_7d          = EXCLUDED.price_7d,
    price_30d         = EXCLUDED.price_30d,
    max_concurrent    = EXCLUDED.max_concurrent,
    margin_percent    = EXCLUDED.margin_percent,
    default_storage_gb= EXCLUDED.default_storage_gb,
    min_storage_gb    = EXCLUDED.min_storage_gb,
    max_storage_gb    = EXCLUDED.max_storage_gb,
    egress_limit_gb   = EXCLUDED.egress_limit_gb,
    ingress_limit_gb  = EXCLUDED.ingress_limit_gb,
    public_ip_default = EXCLUDED.public_ip_default,
    updated_at        = NOW();
