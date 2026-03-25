-- Add resolved_ip column for DNS-pinning (prevents DNS rebinding attacks)
-- Stores the IP resolved at registration time so invocations connect to the
-- same IP rather than re-resolving DNS.
ALTER TABLE lambda_functions ADD COLUMN IF NOT EXISTS resolved_ip TEXT;
