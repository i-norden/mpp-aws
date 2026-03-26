-- Migration: voucher_redemptions
-- Tracks redeemed vouchers to prevent double-spending

CREATE TABLE IF NOT EXISTS voucher_redemptions (
    id BIGSERIAL PRIMARY KEY,
    voucher_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    payer_address TEXT NOT NULL,
    amount BIGINT NOT NULL,
    issued_at TIMESTAMP WITH TIME ZONE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    redeemed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    refund_tx_hash TEXT,
    status TEXT NOT NULL DEFAULT 'pending'  -- 'pending', 'success', 'failed'
);

-- Index for looking up vouchers by ID
CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_voucher_id ON voucher_redemptions(voucher_id);

-- Index for looking up by payer address
CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_payer_address ON voucher_redemptions(payer_address);
