-- Migration 037: Persist aggregate batch billing details

ALTER TABLE batch_invocations
  ADD COLUMN IF NOT EXISTS actual_cloud_cost BIGINT;

ALTER TABLE batch_invocations
  ADD COLUMN IF NOT EXISTS fee_amount BIGINT;

ALTER TABLE batch_invocations
  ADD COLUMN IF NOT EXISTS refund_amount BIGINT;

ALTER TABLE batch_invocations
  ADD COLUMN IF NOT EXISTS refund_status TEXT;

ALTER TABLE batch_invocations
  ADD COLUMN IF NOT EXISTS refund_tx_hash TEXT;
