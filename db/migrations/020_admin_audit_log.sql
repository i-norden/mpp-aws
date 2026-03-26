-- Migration 020: Admin audit log, lease terminated_reason, lease anonymization
--
-- 1. admin_audit_log table for tracking all admin actions
-- 2. terminated_reason column on leases (bandwidth, admin, expired, etc.)
-- 3. anonymized_at column on leases for GDPR retention

-- ============================================================
-- 1. Admin audit log
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    admin_ip    TEXT NOT NULL,
    action      TEXT NOT NULL,         -- 'lease.terminate', 'resource.create', etc.
    target_type TEXT NOT NULL,         -- 'lease', 'resource', 'function'
    target_id   TEXT NOT NULL,
    details     JSONB,                 -- Request body / change diff
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_action ON admin_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON admin_audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON admin_audit_log(target_type, target_id);

-- ============================================================
-- 2. Add terminated_reason to leases
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'leases' AND column_name = 'terminated_reason'
    ) THEN
        ALTER TABLE leases ADD COLUMN terminated_reason TEXT;
    END IF;
END $$;

-- ============================================================
-- 3. Add anonymized_at to leases for GDPR retention
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'leases' AND column_name = 'anonymized_at'
    ) THEN
        ALTER TABLE leases ADD COLUMN anonymized_at TIMESTAMPTZ;
    END IF;
END $$;
