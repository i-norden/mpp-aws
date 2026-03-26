-- Revert per-lease security group tracking
ALTER TABLE leases DROP COLUMN IF EXISTS security_group_id;
