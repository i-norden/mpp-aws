-- Migration 033: Owner self-service API
-- Adds ownership transfer request table for 2-step ownership transfer.

CREATE TABLE IF NOT EXISTS ownership_transfer_requests (
    id              BIGSERIAL PRIMARY KEY,
    function_name   TEXT NOT NULL REFERENCES lambda_functions(function_name) ON DELETE CASCADE,
    current_owner   TEXT NOT NULL,
    new_owner       TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'cancelled', 'expired')),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one pending transfer per function
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_pending_function
    ON ownership_transfer_requests(function_name) WHERE status = 'pending';

-- Look up pending transfers by new owner
CREATE INDEX IF NOT EXISTS idx_transfer_new_owner
    ON ownership_transfer_requests(new_owner) WHERE status = 'pending';
