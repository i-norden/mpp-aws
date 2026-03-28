-- Migration 036: Fix voucher issuance/redemption lifecycle
--
-- Separates issued vouchers from in-progress redemptions and makes redeemed_at
-- reflect terminal completion instead of issuance.

ALTER TABLE voucher_redemptions
  ALTER COLUMN redeemed_at DROP DEFAULT;

UPDATE voucher_redemptions
SET status = 'issued',
    redeemed_at = NULL
WHERE status = 'pending'
  AND payer_address = '';

UPDATE voucher_redemptions
SET redeemed_at = NULL
WHERE status IN ('issued', 'pending');

ALTER TABLE voucher_redemptions
  ALTER COLUMN status SET DEFAULT 'issued';

ALTER TABLE voucher_redemptions
  DROP CONSTRAINT IF EXISTS voucher_redemptions_status_valid;

ALTER TABLE voucher_redemptions
  ADD CONSTRAINT voucher_redemptions_status_valid
  CHECK (status IN ('issued', 'pending', 'success', 'failed'));
