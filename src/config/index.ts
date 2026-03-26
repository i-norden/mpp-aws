/**
 * Configuration module for the Lambda proxy service.
 * Mirrors the Go config at mmp-compute/lambda-proxy/internal/config/config.go
 */

// ---------------------------------------------------------------------------
// Network chain ID mapping
// ---------------------------------------------------------------------------

const NetworkChainIDs: Record<string, bigint> = {
  'base-sepolia': 84532n,
  'base': 8453n,
};

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface Config {
  // Server
  port: string;
  healthPort: string;

  // Derived
  chainId: bigint;

  // Database
  databaseURL: string;

  // MPP Configuration
  network: string;
  payToAddress: string;
  usdcAddress: string;
  mppSecretKey: string;

  // AWS
  awsRegion: string;

  // Pricing (atomic USDC, 6 decimals)
  baseFee: bigint;
  memoryRatePer128MB: bigint;
  durationRatePer100ms: bigint;

  // Access Control
  enforceWhitelist: boolean;
  adminAPIKey: string;
  adminAddresses: string[];

  // Registration
  registrationFee: bigint;
  allowOpenRegister: boolean;

  // Refund System
  refundEnabled: boolean;
  refundAddress: string;
  refundPrivateKey: string;
  rpcURL: string;
  feePercentage: bigint;
  minRefundThreshold: bigint;
  estimatedGasCostUSD: bigint;

  // CORS
  corsAllowedOrigins: string[];

  // Rate Limiting
  redisURL: string;
  globalRateLimit: number;
  globalRateBurst: number;
  perAddressRateLimit: number;
  perAddressRateBurst: number;

  // Endpoint Verification
  endpointVerifyTimeout: number;

  // Lambda Invocation
  invokeTimeout: number;

  // Limits
  maxCodeSizeBytes: number;
  maxExecuteTimeout: number;
  maxURLLength: number;

  // Circuit Breaker
  cbSuccessThreshold: number;

  // Public URL
  publicURL: string;

  // Private Registry & Earnings
  marketplaceFeeBps: number;
  minEarningsWithdrawal: bigint;
  maxAccessListSize: number;

  // RPC Fallback
  rpcURLFallback: string;

  // Lease Rate Limiting
  leaseRateLimit: number;
  leaseRateBurst: number;

  // EC2 Lease System
  leaseEnabled: boolean;
  leaseSubnetIDs: string[];
  leaseSecurityGroupID: string;
  leaseVPCID: string;
  leaseMaxPerUser: number;
  leaseMaxProvisionAttempts: number;
  leaseMarginPercent: number;
  leasePricingSyncHours: number;
  leaseBandwidthCheckSeconds: number;
  leaseMaxGlobalActive: number;
  leaseProvisioningTimeoutMinutes: number;
  leasePriceMaxAgeHours: number;
  leaseExpiryWarningMinutes: number;
  leaseExpiryWebhookURL: string;
  treasuryAddress: string;
  collectionPrivateKey: string;

  // Monitoring
  grafanaURL: string;

  // Endpoint Auth Encryption
  endpointAuthKey: string;

  // Async Jobs
  asyncJobsEnabled: boolean;
  asyncJobMaxTTLHours: number;
  asyncJobWorkerInterval: number;
  asyncJobMaxConcurrent: number;

  // Pre-authorized Budgets
  budgetMaxTTLHours: number;
  budgetMaxAmount: bigint;

  // OFAC Compliance
  ofacBlockedAddresses: string;
  ofacBlockedAddressesFile: string;

  // Payer Allowlist
  allowedPayerAddresses: string[];

  // Caching & Nonce TTL
  functionCacheTTLSeconds: number;
  nonceExpirationHours: number;
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function getEnv(key: string, defaultValue: string): string {
  const value = process.env[key];
  return value !== undefined && value !== '' ? value : defaultValue;
}

function getEnvOrEmpty(key: string): string {
  return process.env[key] ?? '';
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value !== undefined && value !== '') {
    return value === 'true' || value === '1' || value === 'yes';
  }
  return defaultValue;
}

function getEnvBigInt(key: string, defaultValue: bigint): bigint {
  const value = process.env[key];
  if (value !== undefined && value !== '') {
    try {
      return BigInt(value);
    } catch {
      console.warn(`WARNING: env ${key}=${JSON.stringify(value)} is not a valid integer, using default ${defaultValue}`);
    }
  }
  return defaultValue;
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value !== undefined && value !== '') {
    const parsed = parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    console.warn(`WARNING: env ${key}=${JSON.stringify(value)} is not a valid integer, using default ${defaultValue}`);
  }
  return defaultValue;
}

function getEnvFloat(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value !== undefined && value !== '') {
    const parsed = parseFloat(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    console.warn(`WARNING: env ${key}=${JSON.stringify(value)} is not a valid float, using default ${defaultValue}`);
  }
  return defaultValue;
}

function getEnvStringSlice(key: string, defaultValue: string[]): string[] {
  const value = process.env[key];
  if (value !== undefined && value !== '') {
    const parts = value.split(',')
      .map(p => p.trim())
      .filter(p => p !== '');
    if (parts.length > 0) {
      return parts;
    }
  }
  return defaultValue;
}

// ---------------------------------------------------------------------------
// Ethereum address validation (mirrors isValidEthAddress in Go)
// ---------------------------------------------------------------------------

function isValidEthAddress(addr: string): boolean {
  if (addr.length !== 42) return false;
  if (addr.slice(0, 2) !== '0x' && addr.slice(0, 2) !== '0X') return false;

  const hexPart = addr.slice(2);
  // Validate all characters are hex
  if (!/^[0-9a-fA-F]{40}$/.test(hexPart)) return false;

  // If mixed case, we skip EIP-55 checksum validation here (no keccak dep).
  // All-lowercase and all-uppercase are always accepted.
  return true;
}

// ---------------------------------------------------------------------------
// Validation error messages (mirrors errors.go)
// ---------------------------------------------------------------------------

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

export function loadConfig(): Config {
  const network = getEnv('NETWORK', 'base-sepolia');

  const chainId = NetworkChainIDs[network] ?? 84532n; // Default to Base Sepolia

  const cfg: Config = {
    // Server
    port: getEnv('PORT', '8080'),
    healthPort: getEnv('HEALTH_PORT', '8081'),

    // Derived
    chainId,

    // Database
    databaseURL: getEnvOrEmpty('DATABASE_URL'),

    // MPP Configuration
    network,
    payToAddress: getEnvOrEmpty('PAY_TO_ADDRESS'),
    usdcAddress: getEnv('USDC_ADDRESS', '0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
    mppSecretKey: getEnvOrEmpty('MPP_SECRET_KEY'),

    // AWS
    awsRegion: getEnv('AWS_REGION', 'us-east-1'),

    // Pricing (atomic USDC, 6 decimals)
    baseFee: getEnvBigInt('BASE_FEE', 5000n),                 // $0.005
    memoryRatePer128MB: getEnvBigInt('MEMORY_RATE_PER_128MB', 1000n),   // $0.001
    durationRatePer100ms: getEnvBigInt('DURATION_RATE_PER_100MS', 500n), // $0.0005

    // Access Control
    enforceWhitelist: getEnvBool('ENFORCE_WHITELIST', false),
    adminAPIKey: getEnvOrEmpty('ADMIN_API_KEY'),
    adminAddresses: getEnvStringSlice('ADMIN_ADDRESSES', []),

    // Registration
    registrationFee: getEnvBigInt('REGISTRATION_FEE', 1_000_000n), // $1 default
    allowOpenRegister: getEnvBool('ALLOW_OPEN_REGISTER', false),

    // Refund System
    refundEnabled: getEnvBool('REFUND_ENABLED', false),
    refundAddress: getEnvOrEmpty('REFUND_ADDRESS'),
    refundPrivateKey: getEnvOrEmpty('REFUND_PRIVATE_KEY'),
    rpcURL: getEnv('RPC_URL', 'https://sepolia.base.org'),
    feePercentage: getEnvBigInt('FEE_PERCENTAGE', 10n),              // 10% default
    minRefundThreshold: getEnvBigInt('MIN_REFUND_THRESHOLD', 50_000n),    // $0.05 default
    estimatedGasCostUSD: getEnvBigInt('ESTIMATED_GAS_COST_USD', 10_000n), // $0.01 default

    // CORS
    corsAllowedOrigins: getEnvStringSlice('CORS_ALLOWED_ORIGINS', []),

    // Rate Limiting
    redisURL: getEnvOrEmpty('REDIS_URL'),
    globalRateLimit: getEnvFloat('GLOBAL_RATE_LIMIT', 100),
    globalRateBurst: getEnvInt('GLOBAL_RATE_BURST', 200),
    perAddressRateLimit: getEnvFloat('PER_ADDRESS_RATE_LIMIT', 10),
    perAddressRateBurst: getEnvInt('PER_ADDRESS_RATE_BURST', 20),

    // Endpoint verification
    endpointVerifyTimeout: getEnvInt('ENDPOINT_VERIFY_TIMEOUT', 5),

    // Lambda invocation timeout
    invokeTimeout: getEnvInt('INVOKE_TIMEOUT', 300),

    // Configurable limits
    maxCodeSizeBytes: getEnvInt('MAX_CODE_SIZE_BYTES', 1024 * 1024), // 1MB
    maxExecuteTimeout: getEnvInt('MAX_EXECUTE_TIMEOUT', 60),          // 60 seconds
    maxURLLength: getEnvInt('MAX_URL_LENGTH', 2048),                  // 2048 chars

    // Circuit breaker
    cbSuccessThreshold: getEnvInt('CB_SUCCESS_THRESHOLD', 3),

    // Public URL
    publicURL: getEnvOrEmpty('PUBLIC_URL'),

    // Private Registry & Earnings
    marketplaceFeeBps: getEnvInt('MARKETPLACE_FEE_BPS', 0),
    minEarningsWithdrawal: getEnvBigInt('MIN_EARNINGS_WITHDRAWAL', 50_000n), // $0.05 default
    maxAccessListSize: getEnvInt('MAX_ACCESS_LIST_SIZE', 1000),

    // RPC Fallback
    rpcURLFallback: getEnvOrEmpty('RPC_URL_FALLBACK'),

    // Lease Rate Limiting
    leaseRateLimit: getEnvFloat('LEASE_RATE_LIMIT', 20),
    leaseRateBurst: getEnvInt('LEASE_RATE_BURST', 40),

    // EC2 Lease System
    leaseEnabled: getEnvBool('LEASE_ENABLED', false),
    leaseSubnetIDs: getEnvStringSlice('LEASE_SUBNET_IDS', []),
    leaseSecurityGroupID: getEnvOrEmpty('LEASE_SECURITY_GROUP_ID'),
    leaseVPCID: getEnvOrEmpty('LEASE_VPC_ID'),
    leaseMaxPerUser: getEnvInt('LEASE_MAX_PER_USER', 5),
    leaseMaxProvisionAttempts: getEnvInt('LEASE_MAX_PROVISION_ATTEMPTS', 3),
    leaseMarginPercent: getEnvInt('LEASE_MARGIN_PERCENT', 20),
    leasePricingSyncHours: getEnvInt('LEASE_PRICING_SYNC_HOURS', 24),
    leaseBandwidthCheckSeconds: getEnvInt('LEASE_BANDWIDTH_CHECK_SECONDS', 120),
    leaseMaxGlobalActive: getEnvInt('LEASE_MAX_GLOBAL_ACTIVE', 0),
    leaseProvisioningTimeoutMinutes: getEnvInt('LEASE_PROVISIONING_TIMEOUT_MINUTES', 15),
    leasePriceMaxAgeHours: getEnvInt('LEASE_PRICE_MAX_AGE_HOURS', 48),
    leaseExpiryWarningMinutes: getEnvInt('LEASE_EXPIRY_WARNING_MINUTES', 30),
    leaseExpiryWebhookURL: getEnvOrEmpty('LEASE_EXPIRY_WEBHOOK_URL'),
    treasuryAddress: getEnvOrEmpty('TREASURY_ADDRESS'),
    collectionPrivateKey: getEnvOrEmpty('COLLECTION_PRIVATE_KEY'),

    // Monitoring
    grafanaURL: getEnvOrEmpty('GRAFANA_URL'),

    // Endpoint Auth Encryption
    endpointAuthKey: getEnvOrEmpty('ENDPOINT_AUTH_KEY'),

    // Async Jobs
    asyncJobsEnabled: getEnvBool('ASYNC_JOBS_ENABLED', false),
    asyncJobMaxTTLHours: getEnvInt('ASYNC_JOB_MAX_TTL_HOURS', 24),
    asyncJobWorkerInterval: getEnvInt('ASYNC_JOB_WORKER_INTERVAL', 5),
    asyncJobMaxConcurrent: getEnvInt('ASYNC_JOB_MAX_CONCURRENT', 10),

    // Pre-authorized Budgets
    budgetMaxTTLHours: getEnvInt('BUDGET_MAX_TTL_HOURS', 168),            // 7 days default
    budgetMaxAmount: getEnvBigInt('BUDGET_MAX_AMOUNT', 100_000_000n),     // $100 default

    // OFAC Compliance
    ofacBlockedAddresses: getEnvOrEmpty('OFAC_BLOCKED_ADDRESSES'),
    ofacBlockedAddressesFile: getEnvOrEmpty('OFAC_BLOCKED_ADDRESSES_FILE'),

    // Payer Allowlist
    allowedPayerAddresses: getEnvStringSlice('ALLOWED_PAYER_ADDRESSES', []),

    // Caching & Nonce TTL
    functionCacheTTLSeconds: getEnvInt('FUNCTION_CACHE_TTL_SECONDS', 60),
    nonceExpirationHours: getEnvInt('NONCE_EXPIRATION_HOURS', 24),
  };

  return cfg;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

export function validate(cfg: Config): void {
  if (cfg.payToAddress === '') {
    throw new ConfigValidationError('PAY_TO_ADDRESS environment variable is required');
  }

  // Validate pricing rates are non-negative
  if (cfg.baseFee < 0n) {
    throw new ConfigValidationError('BASE_FEE must be non-negative');
  }
  if (cfg.memoryRatePer128MB < 0n) {
    throw new ConfigValidationError('MEMORY_RATE_PER_128MB must be non-negative');
  }
  if (cfg.durationRatePer100ms < 0n) {
    throw new ConfigValidationError('DURATION_RATE_PER_100MS must be non-negative');
  }
  if (cfg.feePercentage < 0n) {
    throw new ConfigValidationError('FEE_PERCENTAGE must be non-negative');
  }
  if (cfg.feePercentage > 100n) {
    throw new ConfigValidationError('FEE_PERCENTAGE must not exceed 100');
  }
  if (cfg.minRefundThreshold < 0n) {
    throw new ConfigValidationError('MIN_REFUND_THRESHOLD must be non-negative');
  }

  // Validate rate limits are positive
  if (cfg.globalRateLimit <= 0) {
    throw new ConfigValidationError('GLOBAL_RATE_LIMIT must be positive');
  }
  if (cfg.globalRateBurst <= 0) {
    throw new ConfigValidationError('GLOBAL_RATE_BURST must be positive');
  }

  // Validate refund configuration
  if (cfg.refundEnabled) {
    if (cfg.refundPrivateKey === '') {
      throw new ConfigValidationError('REFUND_PRIVATE_KEY is required when REFUND_ENABLED=true');
    }
    if (cfg.rpcURL === '') {
      throw new ConfigValidationError('RPC_URL is required when REFUND_ENABLED=true');
    }
    if (cfg.databaseURL === '') {
      throw new ConfigValidationError('DATABASE_URL is required when REFUND_ENABLED=true (for credit tracking)');
    }
    // Default refundAddress to payToAddress if not set
    if (cfg.refundAddress === '') {
      cfg.refundAddress = cfg.payToAddress;
    }
  }

  // Validate endpoint auth key if set (must be 64 hex chars = 32 bytes)
  if (cfg.endpointAuthKey !== '') {
    if (cfg.endpointAuthKey.length !== 64) {
      throw new ConfigValidationError('ENDPOINT_AUTH_KEY must be exactly 64 hex characters (32 bytes)');
    }
    if (!/^[0-9a-fA-F]{64}$/.test(cfg.endpointAuthKey)) {
      throw new ConfigValidationError('ENDPOINT_AUTH_KEY must be valid hexadecimal');
    }
  }

  // Validate nonce expiration when explicitly configured (0 = use default 24h)
  if (cfg.nonceExpirationHours !== 0 && (cfg.nonceExpirationHours < 1 || cfg.nonceExpirationHours > 24)) {
    throw new ConfigValidationError('NONCE_EXPIRATION_HOURS must be between 1 and 24');
  }

  // Validate function cache TTL when explicitly configured (0 = use default 60s)
  if (cfg.functionCacheTTLSeconds < 0) {
    throw new ConfigValidationError('FUNCTION_CACHE_TTL_SECONDS must not be negative');
  }

  // Validate lease configuration
  if (cfg.leaseEnabled) {
    if (cfg.leaseSubnetIDs.length === 0) {
      throw new ConfigValidationError('LEASE_SUBNET_IDS is required when LEASE_ENABLED=true');
    }
    if (cfg.leaseSecurityGroupID === '') {
      throw new ConfigValidationError('LEASE_SECURITY_GROUP_ID is required when LEASE_ENABLED=true');
    }
    if (cfg.leaseVPCID === '') {
      throw new ConfigValidationError('LEASE_VPC_ID is required when LEASE_ENABLED=true (for per-lease security group creation)');
    }
    if (cfg.databaseURL === '') {
      throw new ConfigValidationError('DATABASE_URL is required when LEASE_ENABLED=true');
    }
    if (cfg.leaseMaxPerUser < 1) {
      throw new ConfigValidationError('LEASE_MAX_PER_USER must be at least 1 when leases are enabled');
    }
    if (cfg.leaseMarginPercent < 5) {
      throw new ConfigValidationError('LEASE_MARGIN_PERCENT must be at least 5 to ensure profitability');
    }
    if (cfg.leaseMaxGlobalActive < 1) {
      throw new ConfigValidationError('LEASE_MAX_GLOBAL_ACTIVE must be set to a positive value when LEASE_ENABLED=true (controls maximum total AWS spend)');
    }
  }
}

// ---------------------------------------------------------------------------
// validateProductionSafety
// ---------------------------------------------------------------------------

export interface ProductionSafetyResult {
  warnings: string[];
}

export function validateProductionSafety(cfg: Config): ProductionSafetyResult {
  const warnings: string[] = [];
  const isMainnet = cfg.network === 'base';

  // Hard error: RPC_URL contains "sepolia" on mainnet
  if (isMainnet && cfg.rpcURL.toLowerCase().includes('sepolia')) {
    throw new ConfigValidationError(
      "RPC_URL contains 'sepolia' but NETWORK=base (mainnet) — use a Base mainnet RPC endpoint",
    );
  }

  // Hard error: PAY_TO_ADDRESS must be valid Ethereum address format
  if (cfg.payToAddress !== '' && !isValidEthAddress(cfg.payToAddress)) {
    throw new ConfigValidationError(
      'PAY_TO_ADDRESS must be a valid Ethereum address (0x followed by 40 hex characters)',
    );
  }

  // Hard error: REFUND_PRIVATE_KEY required on mainnet when refunds enabled
  if (isMainnet && cfg.refundEnabled && cfg.refundPrivateKey === '') {
    throw new ConfigValidationError(
      'REFUND_PRIVATE_KEY is required when REFUND_ENABLED=true on mainnet (network=base)',
    );
  }

  // Hard error: CORS wildcard not allowed on mainnet
  if (isMainnet) {
    for (const origin of cfg.corsAllowedOrigins) {
      if (origin === '*') {
        throw new ConfigValidationError(
          'CORS_ALLOWED_ORIGINS=* is not allowed on mainnet (network=base) — specify allowed origins explicitly',
        );
      }
    }
  }

  // Loud warning: ENFORCE_WHITELIST=false exposes all Lambda functions
  if (!cfg.enforceWhitelist) {
    warnings.push(
      'SECURITY WARNING: ENFORCE_WHITELIST=false — all Lambda functions in the AWS account are invocable. Set ENFORCE_WHITELIST=true and register functions via admin API for production use.',
    );
  }

  return { warnings };
}

// ---------------------------------------------------------------------------
// Convenience helpers (mirrors Go methods)
// ---------------------------------------------------------------------------

/** Returns true if at least one admin auth method is configured. */
export function adminEnabled(cfg: Config): boolean {
  return cfg.adminAPIKey !== '' || cfg.adminAddresses.length > 0;
}

/** Returns true if the config targets Base mainnet. */
export function isMainnet(cfg: Config): boolean {
  return cfg.network === 'base';
}

/** Returns any security warnings related to CORS configuration. */
export function corsWarnings(cfg: Config): string[] {
  const warnings: string[] = [];

  if (cfg.corsAllowedOrigins.length === 0) {
    warnings.push('CORS not configured: No origins will be allowed. Set CORS_ALLOWED_ORIGINS for cross-origin requests.');
  }

  for (const origin of cfg.corsAllowedOrigins) {
    if (origin === '*') {
      warnings.push('SECURITY WARNING: CORS is configured with wildcard (*). All origins will be allowed. This is NOT recommended for production.');
      break;
    }
  }

  return warnings;
}
