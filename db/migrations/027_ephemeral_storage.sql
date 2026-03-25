-- Migration 027: Ephemeral storage sessions
-- S3-backed temporary storage for passing data between invocations

CREATE TABLE IF NOT EXISTS storage_sessions (
  id TEXT PRIMARY KEY DEFAULT 'stor_' || substr(md5(random()::text), 1, 16),
  payer_address TEXT NOT NULL,
  bucket TEXT NOT NULL,
  prefix TEXT NOT NULL,
  max_size_bytes BIGINT NOT NULL DEFAULT 104857600,
  used_bytes BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tx_hash TEXT NOT NULL,
  CONSTRAINT chk_storage_size CHECK (used_bytes >= 0 AND used_bytes <= max_size_bytes)
);

CREATE INDEX IF NOT EXISTS idx_storage_payer ON storage_sessions (payer_address);
CREATE INDEX IF NOT EXISTS idx_storage_expires ON storage_sessions (expires_at);
