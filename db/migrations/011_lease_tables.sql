-- 011_lease_tables.sql
-- EC2 instance leasing via MPP payments

CREATE TABLE IF NOT EXISTS lease_resources (
    id              TEXT PRIMARY KEY,          -- "t3-medium"
    display_name    TEXT NOT NULL,
    instance_type   TEXT NOT NULL,             -- "t3.medium"
    vcpus           INTEGER NOT NULL,
    memory_gb       NUMERIC(6,1) NOT NULL,
    storage_gb      INTEGER NOT NULL DEFAULT 30,
    ami_id          TEXT NOT NULL,
    ssh_user        TEXT NOT NULL DEFAULT 'ubuntu',
    description     TEXT,
    price_1d        BIGINT NOT NULL,           -- atomic USDC
    price_7d        BIGINT NOT NULL,
    price_30d       BIGINT NOT NULL,
    max_concurrent  INTEGER NOT NULL DEFAULT 10,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leases (
    id                    TEXT PRIMARY KEY,       -- UUID
    resource_id           TEXT NOT NULL REFERENCES lease_resources(id),
    payer_address         TEXT NOT NULL,
    amount_paid           BIGINT NOT NULL,
    payment_tx_hash       TEXT NOT NULL,
    duration_days         INTEGER NOT NULL CHECK (duration_days IN (1, 7, 30)),
    instance_id           TEXT,                   -- set after EC2 launch
    public_ip             TEXT,                   -- set when running
    ssh_public_key        TEXT NOT NULL,
    encrypted_private_key TEXT NOT NULL,           -- NaCl box ciphertext (hex)
    user_public_key       TEXT NOT NULL,           -- user's X25519 key (hex)
    encryption_nonce      TEXT NOT NULL,           -- NaCl nonce (hex)
    status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','provisioning','running','terminated','failed')),
    status_message        TEXT,
    error_message         TEXT,
    provision_attempts    INTEGER NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    provisioned_at        TIMESTAMPTZ,
    expires_at            TIMESTAMPTZ NOT NULL,
    terminated_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_leases_status ON leases(status) WHERE status NOT IN ('terminated','failed');
CREATE INDEX IF NOT EXISTS idx_leases_expires ON leases(expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_leases_payer ON leases(payer_address);
CREATE INDEX IF NOT EXISTS idx_leases_resource ON leases(resource_id);
