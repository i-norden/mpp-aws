-- Lambda Functions Registry
-- Stores registered Lambda functions with their pricing configuration
CREATE TABLE IF NOT EXISTS lambda_functions (
    id BIGSERIAL PRIMARY KEY,
    function_arn TEXT NOT NULL UNIQUE,
    function_name TEXT NOT NULL,
    description TEXT,
    memory_mb INTEGER NOT NULL DEFAULT 128,
    timeout_seconds INTEGER NOT NULL DEFAULT 30,
    estimated_duration_ms INTEGER NOT NULL DEFAULT 1000,
    custom_base_fee BIGINT,  -- Override base fee for specific functions (atomic USDC)
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lambda_functions_name ON lambda_functions(function_name);
CREATE INDEX IF NOT EXISTS idx_lambda_functions_enabled ON lambda_functions(enabled) WHERE enabled = true;

-- Lambda Invocations Log
-- Records all paid Lambda invocations for analytics and auditing
CREATE TABLE IF NOT EXISTS lambda_invocations (
    id BIGSERIAL PRIMARY KEY,
    function_name TEXT NOT NULL,
    payer_address TEXT NOT NULL,  -- Ethereum address of the payer
    amount_paid BIGINT NOT NULL,  -- Amount in atomic USDC (6 decimals)
    tx_hash TEXT,                 -- Settlement transaction hash
    status_code INTEGER NOT NULL,
    success BOOLEAN NOT NULL,
    duration_ms BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lambda_invocations_function ON lambda_invocations(function_name);
CREATE INDEX IF NOT EXISTS idx_lambda_invocations_payer ON lambda_invocations(payer_address);
CREATE INDEX IF NOT EXISTS idx_lambda_invocations_created ON lambda_invocations(created_at);
CREATE INDEX IF NOT EXISTS idx_lambda_invocations_tx_hash ON lambda_invocations(tx_hash) WHERE tx_hash IS NOT NULL;

-- Pricing Configuration History
-- Tracks pricing changes over time
CREATE TABLE IF NOT EXISTS pricing_config (
    id BIGSERIAL PRIMARY KEY,
    base_fee BIGINT NOT NULL,            -- Base fee per invocation (atomic USDC)
    memory_rate_per_128mb BIGINT NOT NULL,  -- Rate per 128MB of memory
    duration_rate_per_100ms BIGINT NOT NULL, -- Rate per 100ms of execution
    network TEXT NOT NULL DEFAULT 'base-sepolia',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default pricing configuration
INSERT INTO pricing_config (base_fee, memory_rate_per_128mb, duration_rate_per_100ms, network)
VALUES (5000, 1000, 500, 'base-sepolia')
ON CONFLICT DO NOTHING;

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for lambda_functions
DROP TRIGGER IF EXISTS update_lambda_functions_updated_at ON lambda_functions;
CREATE TRIGGER update_lambda_functions_updated_at
    BEFORE UPDATE ON lambda_functions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
