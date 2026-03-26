-- Migration 034: durable auth replay protection and async job claim performance

CREATE TABLE IF NOT EXISTS auth_nonces (
  id BIGSERIAL PRIMARY KEY,
  signer_address VARCHAR(42) NOT NULL,
  nonce VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT chk_auth_nonce_not_empty CHECK (char_length(nonce) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_nonces_signer_nonce
  ON auth_nonces (signer_address, nonce);

CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires_at
  ON auth_nonces (expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_nonces_signer_address
  ON auth_nonces (signer_address);

COMMENT ON TABLE auth_nonces IS 'Tracks signed request nonces to provide durable replay protection for wallet/admin authentication';
COMMENT ON COLUMN auth_nonces.signer_address IS 'Lowercase Ethereum address that produced the signed message';
COMMENT ON COLUMN auth_nonces.nonce IS 'Client-generated nonce from the signed message';
COMMENT ON COLUMN auth_nonces.expires_at IS 'When this replay-protection record can be garbage-collected';

CREATE INDEX IF NOT EXISTS idx_jobs_claimable
  ON async_jobs (created_at, expires_at)
  WHERE status = 'pending';
