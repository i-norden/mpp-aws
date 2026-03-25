-- Migration 031: Pipeline executions
-- Sequential function chaining with a single MPP payment

CREATE TABLE IF NOT EXISTS pipeline_executions (
  id TEXT PRIMARY KEY DEFAULT 'pipe_' || substr(md5(random()::text), 1, 16),
  payer_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  steps JSONB NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  step_results JSONB NOT NULL DEFAULT '[]',
  amount_paid BIGINT NOT NULL,
  actual_cost BIGINT NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_pipeline_status CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_payer ON pipeline_executions (payer_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_status ON pipeline_executions (status) WHERE status = 'running';
