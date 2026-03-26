-- Migration 019: Audit remediation
--
-- 1.3  Partial UNIQUE index on refunds to prevent double-send race condition.
-- 2.6  Convert payment_nonces timestamps from TIMESTAMP to TIMESTAMPTZ.
-- 2.7  FK from function_access_list.function_name -> lambda_functions(function_name).
-- 3.8  CHECK constraint on leases: expires_at > created_at.

-- ============================================================
-- 1.3: Partial UNIQUE index on refunds.source_tx_hash
-- Only one success/pending refund per source transaction.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_source_tx_hash_active
    ON refunds (source_tx_hash)
    WHERE status IN ('success', 'pending');

-- ============================================================
-- 2.6: Convert payment_nonces timestamps to TIMESTAMPTZ
-- (created_at may have been converted in migration 016; expires_at was not)
-- ============================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'payment_nonces' AND column_name = 'created_at'
               AND data_type = 'timestamp without time zone') THEN
        ALTER TABLE payment_nonces ALTER COLUMN created_at TYPE TIMESTAMPTZ
            USING created_at AT TIME ZONE 'UTC';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'payment_nonces' AND column_name = 'expires_at'
               AND data_type = 'timestamp without time zone') THEN
        ALTER TABLE payment_nonces ALTER COLUMN expires_at TYPE TIMESTAMPTZ
            USING expires_at AT TIME ZONE 'UTC';
    END IF;
END $$;

-- ============================================================
-- 2.7: FK from function_access_list.function_name -> lambda_functions
-- Requires a UNIQUE constraint on lambda_functions(function_name) first.
-- ============================================================

-- Add UNIQUE constraint on lambda_functions.function_name if not present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_lambda_functions_function_name'
    ) THEN
        ALTER TABLE lambda_functions
            ADD CONSTRAINT uq_lambda_functions_function_name UNIQUE (function_name);
    END IF;
END $$;

-- Add FK from function_access_list.function_name -> lambda_functions(function_name)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_access_list_function_name'
    ) THEN
        ALTER TABLE function_access_list
            ADD CONSTRAINT fk_access_list_function_name
            FOREIGN KEY (function_name) REFERENCES lambda_functions(function_name)
            ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================
-- 3.8: CHECK constraint on leases: expires_at > created_at
-- ============================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'leases') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'chk_lease_expires_after_created'
        ) THEN
            ALTER TABLE leases
                ADD CONSTRAINT chk_lease_expires_after_created
                CHECK (expires_at > created_at);
        END IF;
    END IF;
END $$;
