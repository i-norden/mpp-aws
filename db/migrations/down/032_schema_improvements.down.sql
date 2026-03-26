-- Down migration for 032: Revert schema improvements
-- NOTE: Data migration for withdrawal_status -> redeemed/withdrawn booleans is lossy

-- Restore views
CREATE OR REPLACE VIEW credit_balances AS
SELECT
    payer_address,
    SUM(CASE WHEN redeemed = false THEN amount ELSE 0 END) as available_balance,
    SUM(amount) as total_credited,
    SUM(CASE WHEN redeemed = true THEN amount ELSE 0 END) as total_redeemed,
    COUNT(*) as credit_count
FROM credits
GROUP BY payer_address;

CREATE OR REPLACE VIEW earnings_balances AS
SELECT
    owner_address,
    SUM(CASE WHEN withdrawn = false THEN amount ELSE 0 END) as available_balance,
    SUM(amount) as total_earned,
    SUM(CASE WHEN withdrawn = true THEN amount ELSE 0 END) as total_withdrawn,
    COUNT(*) as earning_count
FROM earnings
GROUP BY owner_address;

CREATE OR REPLACE VIEW refund_stats AS
SELECT
    status,
    COUNT(*) as count,
    SUM(amount) as total_amount,
    AVG(amount) as avg_amount
FROM refunds
GROUP BY status;

-- Remove new indexes
DROP INDEX IF EXISTS idx_credits_payer_available;
DROP INDEX IF EXISTS idx_credits_pending_withdrawal;
DROP INDEX IF EXISTS idx_earnings_owner_available;
DROP INDEX IF EXISTS idx_earnings_pending_withdrawal;
DROP INDEX IF EXISTS idx_refunds_pending_with_tx;
DROP INDEX IF EXISTS idx_refunds_stuck_pending;
DROP INDEX IF EXISTS idx_leases_running_expires;
DROP INDEX IF EXISTS idx_leases_running_bandwidth;

-- Restore duplicate index
CREATE INDEX IF NOT EXISTS idx_lambda_invocations_created ON lambda_invocations(created_at);

-- Remove foreign keys
ALTER TABLE lambda_invocations DROP CONSTRAINT IF EXISTS fk_invocations_function_name;
ALTER TABLE earnings DROP CONSTRAINT IF EXISTS fk_earnings_function_name;
ALTER TABLE budget_transactions DROP CONSTRAINT IF EXISTS fk_budget_tx_function_name;
ALTER TABLE leases DROP CONSTRAINT IF EXISTS fk_leases_resource_id;

-- Revert withdrawal_status: migrate back to boolean + sentinel
UPDATE credits SET redeemed = false WHERE withdrawal_status = 'available';
UPDATE credits SET redeemed = true, redeemed_tx_hash = '__pending__' WHERE withdrawal_status = 'pending';
UPDATE credits SET redeemed = true WHERE withdrawal_status = 'withdrawn';
ALTER TABLE credits DROP CONSTRAINT IF EXISTS chk_credit_withdrawal_status;
ALTER TABLE credits DROP COLUMN IF EXISTS withdrawal_status;

UPDATE earnings SET withdrawn = false WHERE withdrawal_status = 'available';
UPDATE earnings SET withdrawn = true, withdrawn_tx_hash = '__pending__' WHERE withdrawal_status = 'pending';
UPDATE earnings SET withdrawn = true WHERE withdrawal_status = 'withdrawn';
ALTER TABLE earnings DROP CONSTRAINT IF EXISTS chk_earning_withdrawal_status;
ALTER TABLE earnings DROP COLUMN IF EXISTS withdrawal_status;
