-- Add per-lease security group tracking
ALTER TABLE leases ADD COLUMN IF NOT EXISTS security_group_id TEXT;
