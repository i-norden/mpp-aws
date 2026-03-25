-- Down migration 020: Remove admin audit log, terminated_reason, anonymized_at

DROP TABLE IF EXISTS admin_audit_log;

ALTER TABLE leases DROP COLUMN IF EXISTS terminated_reason;
ALTER TABLE leases DROP COLUMN IF EXISTS anonymized_at;
