// Pricing engine for Lambda invocations.
// TypeScript port of the Go pricing engine using bigint for all atomic USDC amounts (6 decimals).

// AWS Lambda pricing (us-east-1, as of 2024)
// Converted to atomic USDC (6 decimals)
const AWSLambdaMBMsRate = 16300n; // Divide by 1e9 to get atomic USDC per MB-ms

// Maximum allowed values to prevent overflow
const MaxMemoryMB = 10_000_000n; // 10 TB
const MaxDurationMs = 900_000_000n; // ~10 days in ms
const MaxCostAtomicUSDC = 1_000_000_000_000n; // $1,000,000 in atomic USDC

/**
 * Configuration for constructing a PricingEngine.
 */
export interface PricingEngineConfig {
  baseFee: bigint;
  memoryRatePer128MB: bigint;
  durationRatePer100ms: bigint;
  feePercentage: bigint;
  minRefundThreshold: bigint;
  estimatedGasCostUSD: bigint;
}

/**
 * Full billing breakdown for an invocation.
 */
export interface BillingBreakdown {
  actualCloudCost: bigint;
  feeAmount: bigint;
  feePercentage: bigint;
  grossRefund: bigint;
  gasCost: bigint;
  netRefund: bigint;
  refundEligible: boolean;
  creditAmount: bigint;
}

/**
 * Refund configuration returned by getRefundConfig.
 */
export interface RefundConfig {
  feePercentage: bigint;
  minRefundThreshold: bigint;
  estimatedGasCost: bigint;
}

// Overflow-safe guard: BigInt equivalent of (1 << 62) for int64-style overflow checks.
// In the Go code, int64 max is ~9.2e18; (1<<62) = 4611686018427387904.
// We replicate the same guard constant so the formulas match exactly.
const OVERFLOW_GUARD = 1n << 62n;

/**
 * PricingEngine calculates costs for Lambda invocations.
 * All monetary amounts are in atomic USDC (6 decimal places).
 */
export class PricingEngine {
  private readonly baseFee: bigint;
  private readonly memoryRatePer128MB: bigint;
  private readonly durationRatePer100ms: bigint;
  private readonly feePercentage: bigint;
  private readonly minRefundThreshold: bigint;
  private readonly estimatedGasCostUSD: bigint;

  constructor(config: PricingEngineConfig) {
    this.baseFee = config.baseFee;
    this.memoryRatePer128MB = config.memoryRatePer128MB;
    this.durationRatePer100ms = config.durationRatePer100ms;
    this.feePercentage = config.feePercentage;
    this.minRefundThreshold = config.minRefundThreshold;
    this.estimatedGasCostUSD = config.estimatedGasCostUSD;
  }

  /**
   * Calculates the cost for a Lambda invocation.
   *
   * Formula: cost = baseFee + (memoryMB / 128 * memoryRate) + (durationMs / 100 * durationRate)
   *
   * Each of memoryUnits and durationUnits has a minimum of 1.
   * Includes overflow protection — returns MaxCostAtomicUSDC if calculation would overflow.
   *
   * @param memoryMB - Memory size in MB (e.g. 128, 256, 512, 1024)
   * @param estimatedDurationMs - Estimated execution time in milliseconds
   * @returns Cost in atomic USDC (6 decimals)
   */
  calculateInvocationCost(memoryMB: number, estimatedDurationMs: number): bigint {
    // Input bounds checking: reject negative values
    if (memoryMB < 0) {
      return 0n;
    }
    if (estimatedDurationMs < 0) {
      return 0n;
    }

    let memMB = BigInt(Math.min(memoryMB, Number(MaxMemoryMB)));
    let durMs = BigInt(Math.min(estimatedDurationMs, Number(MaxDurationMs)));

    // Base fee
    let cost = this.baseFee;

    // Memory cost: rate per 128MB
    let memoryUnits = memMB / 128n;
    if (memoryUnits < 1n) {
      memoryUnits = 1n;
    }

    // Check for overflow before multiplication
    const memoryCost = memoryUnits * this.memoryRatePer128MB;
    if (this.memoryRatePer128MB !== 0n && memoryCost / this.memoryRatePer128MB !== memoryUnits) {
      return MaxCostAtomicUSDC;
    }
    cost += memoryCost;

    // Check for overflow after addition
    if (cost < this.baseFee) {
      return MaxCostAtomicUSDC;
    }

    // Duration cost: rate per 100ms
    let durationUnits = durMs / 100n;
    if (durationUnits < 1n) {
      durationUnits = 1n;
    }

    // Check for overflow before multiplication
    const durationCost = durationUnits * this.durationRatePer100ms;
    if (this.durationRatePer100ms !== 0n && durationCost / this.durationRatePer100ms !== durationUnits) {
      return MaxCostAtomicUSDC;
    }

    // Check for overflow after addition
    const prevCost = cost;
    cost += durationCost;
    if (cost < prevCost) {
      return MaxCostAtomicUSDC;
    }

    // Cap at maximum allowed cost
    if (cost > MaxCostAtomicUSDC) {
      return MaxCostAtomicUSDC;
    }

    return cost;
  }

  /**
   * Calculates the actual AWS Lambda cost based on billed duration.
   *
   * AWS Lambda bills in 1ms increments.
   * Formula: cost = memoryMB * billedDurationMs * 16300 / 1_000_000_000
   *
   * Includes overflow protection — returns MaxCostAtomicUSDC if intermediate
   * multiplication would exceed safe range.
   *
   * @param memoryMB - Memory size in MB
   * @param billedDurationMs - Actual billed duration from Lambda response
   * @returns Cost in atomic USDC (6 decimals)
   */
  calculateActualAWSCost(memoryMB: number, billedDurationMs: bigint): bigint {
    // Clamp inputs to sane bounds
    let memMB = BigInt(Math.max(0, Math.min(memoryMB, Number(MaxMemoryMB))));
    let durMs = billedDurationMs;
    if (durMs < 0n) {
      durMs = 0n;
    }
    if (durMs > MaxDurationMs) {
      durMs = MaxDurationMs;
    }

    // Overflow check: mem * billedDurationMs
    if (memMB !== 0n && durMs > OVERFLOW_GUARD / memMB) {
      return MaxCostAtomicUSDC;
    }
    const step1 = memMB * durMs;

    // Overflow check: step1 * AWSLambdaMBMsRate
    if (step1 !== 0n && AWSLambdaMBMsRate > OVERFLOW_GUARD / step1) {
      return MaxCostAtomicUSDC;
    }
    let cost = step1 * AWSLambdaMBMsRate / 1_000_000_000n;

    // Minimum cost of 1 atomic USDC to avoid zero costs
    if (cost < 1n) {
      cost = 1n;
    }

    // Cap at maximum
    if (cost > MaxCostAtomicUSDC) {
      return MaxCostAtomicUSDC;
    }

    return cost;
  }

  /**
   * Calculates the full billing breakdown after execution.
   *
   * @param amountPaid - Amount paid upfront in atomic USDC
   * @param memoryMB - Memory size in MB
   * @param billedDurationMs - Actual billed duration from Lambda response
   * @returns Full billing breakdown
   */
  calculateBillingBreakdown(amountPaid: bigint, memoryMB: number, billedDurationMs: bigint): BillingBreakdown {
    // Calculate actual cloud cost
    const actualCloudCost = this.calculateActualAWSCost(memoryMB, billedDurationMs);

    // Calculate our fee as percentage of cloud cost
    let feeAmount = 0n;
    if (this.feePercentage > 0n && actualCloudCost > 0n) {
      if (actualCloudCost > OVERFLOW_GUARD / this.feePercentage) {
        // Would overflow — cap at max cost
        feeAmount = MaxCostAtomicUSDC;
      } else {
        feeAmount = actualCloudCost * this.feePercentage / 100n;
      }
    }

    // Calculate gross refund
    let totalCost = actualCloudCost + feeAmount;
    // Check for overflow in addition
    if (totalCost < actualCloudCost) {
      totalCost = MaxCostAtomicUSDC;
    }
    let grossRefund = amountPaid - totalCost;
    if (grossRefund < 0n) {
      grossRefund = 0n;
    }

    // Calculate net refund (after gas)
    let netRefund = grossRefund - this.estimatedGasCostUSD;
    if (netRefund < 0n) {
      netRefund = 0n;
    }

    // Determine if eligible for on-chain refund
    const refundEligible = netRefund >= this.minRefundThreshold;

    // Calculate credit amount (if not refunding on-chain)
    let creditAmount = 0n;
    if (!refundEligible && grossRefund > 0n) {
      creditAmount = grossRefund;
    }

    return {
      actualCloudCost,
      feeAmount,
      feePercentage: this.feePercentage,
      grossRefund,
      gasCost: this.estimatedGasCostUSD,
      netRefund,
      refundEligible,
      creditAmount,
    };
  }

  /**
   * Calculates the maximum possible cost for pre-payment.
   * Uses the full timeout duration as worst-case estimate with a 10% buffer.
   * Includes overflow protection — caps at MaxCostAtomicUSDC.
   *
   * @param memoryMB - Memory size in MB
   * @param timeoutSeconds - Function timeout in seconds
   * @returns Maximum cost in atomic USDC (6 decimals)
   */
  calculateMaxCost(memoryMB: number, timeoutSeconds: number): bigint {
    // Use full timeout as worst case
    const maxDurationMs = BigInt(timeoutSeconds) * 1000n;

    // Calculate max AWS cost (already overflow-safe)
    const maxAWSCost = this.calculateActualAWSCost(memoryMB, maxDurationMs);

    // Add max fee (overflow-safe)
    let maxFee = 0n;
    if (this.feePercentage > 0n && maxAWSCost > 0n) {
      if (maxAWSCost > OVERFLOW_GUARD / this.feePercentage) {
        return MaxCostAtomicUSDC;
      }
      maxFee = maxAWSCost * this.feePercentage / 100n;
    }

    // Add buffer for safety (10%) — overflow-safe
    let total = maxAWSCost + maxFee;
    if (total < maxAWSCost) { // overflow check
      return MaxCostAtomicUSDC;
    }
    let totalWithBuffer = total * 110n / 100n;
    if (totalWithBuffer < total) { // overflow check
      return MaxCostAtomicUSDC;
    }

    // Use the higher of: calculated max or legacy estimate
    const legacyEstimate = this.calculateInvocationCost(memoryMB, Number(maxDurationMs));

    if (totalWithBuffer > legacyEstimate) {
      if (totalWithBuffer > MaxCostAtomicUSDC) {
        return MaxCostAtomicUSDC;
      }
      return totalWithBuffer;
    }
    return legacyEstimate;
  }

  /**
   * Converts an atomic USDC amount to a human-readable USD string.
   *
   * @param atomicUSDC - Amount in atomic USDC (6 decimals)
   * @returns Formatted USD string (e.g., "$0.005000" or "$1.50")
   */
  formatUSD(atomicUSDC: bigint): string {
    return formatUSD(atomicUSDC);
  }

  /**
   * Returns refund-related configuration.
   */
  getRefundConfig(): RefundConfig {
    return {
      feePercentage: this.feePercentage,
      minRefundThreshold: this.minRefundThreshold,
      estimatedGasCost: this.estimatedGasCostUSD,
    };
  }
}

/**
 * Converts an atomic USDC amount to a human-readable USD string.
 * Uses 4 decimal places for amounts under $1 and 2 decimal places for $1+.
 *
 * @param atomicUSDC - Amount in atomic USDC (6 decimals)
 * @returns Formatted USD string (e.g., "$0.005000" or "$1.50")
 */
export function formatUSD(atomicUSDC: bigint): string {
  const dollars = Number(atomicUSDC) / 1_000_000;
  if (dollars >= 1) {
    return `$${dollars.toFixed(2)}`;
  }
  return `$${dollars.toFixed(4)}`;
}
