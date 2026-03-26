-- Migration 029: Async jobs
-- Submit long-running invocations and poll for results

CREATE TABLE IF NOT EXISTS async_jobs (
  id TEXT PRIMARY KEY DEFAULT 'job_' || substr(md5(random()::text), 1, 16),
  function_name TEXT NOT NULL,
  payer_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input JSONB NOT NULL,
  result JSONB,
  error_message TEXT,
  amount_paid BIGINT NOT NULL,
  actual_cost BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  storage_session_id TEXT REFERENCES storage_sessions(id),
  CONSTRAINT chk_job_status CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON async_jobs (status) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_jobs_payer ON async_jobs (payer_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_expires ON async_jobs (expires_at);
