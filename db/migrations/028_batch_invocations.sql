-- Migration 028: Batch invocations
-- Enables invoking the same function with multiple inputs in a single paid request

CREATE TABLE IF NOT EXISTS batch_invocations (
  id TEXT PRIMARY KEY DEFAULT 'batch_' || substr(md5(random()::text), 1, 16),
  function_name TEXT NOT NULL REFERENCES lambda_functions(function_name),
  payer_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  total_items INTEGER NOT NULL,
  completed_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  amount_paid BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_batch_status CHECK (status IN ('running', 'completed', 'partial_failure')),
  CONSTRAINT chk_batch_items CHECK (total_items > 0 AND total_items <= 100)
);

CREATE INDEX IF NOT EXISTS idx_batch_payer ON batch_invocations (payer_address, created_at DESC);
