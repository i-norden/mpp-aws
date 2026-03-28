-- Reverse of 037_batch_billing_fields.sql

ALTER TABLE batch_invocations DROP COLUMN IF EXISTS refund_tx_hash;
ALTER TABLE batch_invocations DROP COLUMN IF EXISTS refund_status;
ALTER TABLE batch_invocations DROP COLUMN IF EXISTS refund_amount;
ALTER TABLE batch_invocations DROP COLUMN IF EXISTS fee_amount;
ALTER TABLE batch_invocations DROP COLUMN IF EXISTS actual_cloud_cost;
