-- Payment nonce tracking for double-spend prevention
-- This table ensures that each payment nonce can only be used once

CREATE TABLE IF NOT EXISTS payment_nonces (
    id BIGSERIAL PRIMARY KEY,
    nonce VARCHAR(128) NOT NULL UNIQUE,
    payer_address VARCHAR(42) NOT NULL,
    amount BIGINT NOT NULL,
    resource VARCHAR(512) NOT NULL,
    tx_hash VARCHAR(66),
    status VARCHAR(32) NOT NULL DEFAULT 'pending', -- 'pending', 'settled', 'failed'
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL
);

-- Index for fast lookups by nonce
CREATE INDEX IF NOT EXISTS idx_payment_nonces_nonce ON payment_nonces(nonce);

-- Index for cleanup of expired nonces
CREATE INDEX IF NOT EXISTS idx_payment_nonces_expires_at ON payment_nonces(expires_at);

-- Index for lookups by payer address
CREATE INDEX IF NOT EXISTS idx_payment_nonces_payer_address ON payment_nonces(payer_address);

-- Add comments
COMMENT ON TABLE payment_nonces IS 'Tracks payment nonces to prevent double-spending';
COMMENT ON COLUMN payment_nonces.nonce IS 'Unique nonce from the payment authorization';
COMMENT ON COLUMN payment_nonces.payer_address IS 'Address of the payer (lowercase)';
COMMENT ON COLUMN payment_nonces.amount IS 'Payment amount in atomic USDC';
COMMENT ON COLUMN payment_nonces.resource IS 'The resource being paid for (URL path)';
COMMENT ON COLUMN payment_nonces.tx_hash IS 'Transaction hash after settlement';
COMMENT ON COLUMN payment_nonces.status IS 'Status: pending, settled, or failed';
COMMENT ON COLUMN payment_nonces.expires_at IS 'When this nonce record can be cleaned up';

-- Function to clean up expired nonces
-- Should be called periodically (e.g., via pg_cron or application scheduler)
CREATE OR REPLACE FUNCTION cleanup_expired_payment_nonces()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM payment_nonces WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_expired_payment_nonces() IS 'Deletes expired payment nonces. Call periodically to prevent table bloat.';

-- If pg_cron extension is available, set up automatic cleanup every hour
-- This is commented out because pg_cron may not be available in all environments
-- To enable, run: CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('cleanup-payment-nonces', '0 * * * *', 'SELECT cleanup_expired_payment_nonces()');

-- Note: idx_payment_nonces_expires_at (above) already covers cleanup queries.
-- A partial index with WHERE expires_at < NOW() is invalid because NOW() is
-- not IMMUTABLE, and it would only capture rows expired at index-creation time.
