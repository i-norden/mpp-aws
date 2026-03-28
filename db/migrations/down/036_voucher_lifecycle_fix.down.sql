-- Reverse of 036_voucher_lifecycle_fix.sql

UPDATE voucher_redemptions
SET status = 'pending'
WHERE status = 'issued';

UPDATE voucher_redemptions
SET redeemed_at = COALESCE(redeemed_at, NOW())
WHERE status = 'pending';

ALTER TABLE voucher_redemptions
  ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE voucher_redemptions
  DROP CONSTRAINT IF EXISTS voucher_redemptions_status_valid;

ALTER TABLE voucher_redemptions
  ADD CONSTRAINT voucher_redemptions_status_valid
  CHECK (status IN ('pending', 'success', 'failed'));

ALTER TABLE voucher_redemptions
  ALTER COLUMN redeemed_at SET DEFAULT NOW();
