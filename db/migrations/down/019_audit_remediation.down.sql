-- Revert migration 019: Audit remediation

-- 3.8: Drop CHECK constraint on leases
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_lease_expires_after_created') THEN
        ALTER TABLE leases DROP CONSTRAINT chk_lease_expires_after_created;
    END IF;
END $$;

-- 2.7: Drop FK and UNIQUE constraint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_access_list_function_name') THEN
        ALTER TABLE function_access_list DROP CONSTRAINT fk_access_list_function_name;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_lambda_functions_function_name') THEN
        ALTER TABLE lambda_functions DROP CONSTRAINT uq_lambda_functions_function_name;
    END IF;
END $$;

-- 2.6: Revert TIMESTAMPTZ back to TIMESTAMP (lossy but reversible)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'payment_nonces' AND column_name = 'expires_at'
               AND data_type = 'timestamp with time zone') THEN
        ALTER TABLE payment_nonces ALTER COLUMN expires_at TYPE TIMESTAMP
            USING expires_at AT TIME ZONE 'UTC';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'payment_nonces' AND column_name = 'created_at'
               AND data_type = 'timestamp with time zone') THEN
        ALTER TABLE payment_nonces ALTER COLUMN created_at TYPE TIMESTAMP
            USING created_at AT TIME ZONE 'UTC';
    END IF;
END $$;

-- 1.3: Drop the partial unique index on refunds
DROP INDEX IF EXISTS idx_refunds_source_tx_hash_active;
