-- Migration 030: Pre-authorized budgets
-- Agents pre-pay a USDC budget, then spend it across multiple invocations

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY DEFAULT 'budget_' || substr(md5(random()::text), 1, 16),
  payer_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  total_amount BIGINT NOT NULL,
  remaining_amount BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  allowed_functions TEXT[],
  max_per_invocation BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_budget_amount CHECK (total_amount > 0 AND remaining_amount >= 0),
  CONSTRAINT chk_budget_remaining CHECK (remaining_amount <= total_amount),
  CONSTRAINT chk_budget_status CHECK (status IN ('active', 'exhausted', 'expired', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_budgets_payer_active
  ON budgets (payer_address) WHERE status = 'active';

-- Ledger for budget deductions (audit trail)
CREATE TABLE IF NOT EXISTS budget_transactions (
  id BIGSERIAL PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets(id),
  function_name TEXT NOT NULL,
  amount BIGINT NOT NULL,
  invocation_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_budget_tx_amount CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_budget_tx_budget ON budget_transactions (budget_id);
