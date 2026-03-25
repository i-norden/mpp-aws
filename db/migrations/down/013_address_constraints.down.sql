-- Rollback migration 013: Remove lowercase address constraints

ALTER TABLE lambda_invocations DROP CONSTRAINT IF EXISTS chk_invocations_payer_lower;
ALTER TABLE credits DROP CONSTRAINT IF EXISTS chk_credits_payer_lower;
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS chk_refunds_payer_lower;
ALTER TABLE voucher_redemptions DROP CONSTRAINT IF EXISTS chk_voucher_payer_lower;
ALTER TABLE lambda_functions DROP CONSTRAINT IF EXISTS chk_functions_owner_lower;
ALTER TABLE function_access_list DROP CONSTRAINT IF EXISTS chk_acl_invoker_lower;
ALTER TABLE function_access_list DROP CONSTRAINT IF EXISTS chk_acl_granted_lower;
ALTER TABLE earnings DROP CONSTRAINT IF EXISTS chk_earnings_owner_lower;
