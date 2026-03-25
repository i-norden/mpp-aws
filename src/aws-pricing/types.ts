/**
 * Shared types for the AWS pricing module.
 * Mirrors the Go implementation at mmp-compute/lambda-proxy/internal/awspricing/calculator.go
 */

// ---------------------------------------------------------------------------
// LeaseAddOns
// ---------------------------------------------------------------------------

/**
 * User-selected add-ons for a lease that affect pricing.
 */
export interface LeaseAddOns {
  /** EBS volume size in GB */
  storageGB: number;
  /** Whether to associate a public IPv4 address */
  publicIP: boolean;
  /** Whether to include an Application Load Balancer */
  loadBalancer: boolean;
}

// ---------------------------------------------------------------------------
// PriceBreakdown
// ---------------------------------------------------------------------------

/**
 * All cost components that make up the total lease price.
 * Returned by the calculator and stored as JSONB on the lease record.
 */
export interface PriceBreakdown {
  /** EC2 compute cost in USD */
  computeUSD: number;
  /** EBS storage cost in USD */
  storageUSD: number;
  /** Public IPv4 address cost in USD */
  ipv4USD: number;
  /** Application Load Balancer cost in USD */
  lbUSD: number;
  /** Data transfer (egress) allowance cost in USD */
  egressUSD: number;
  /** Sum of all cost components before margin */
  subtotalUSD: number;
  /** Margin percentage applied */
  marginPercent: number;
  /** Margin amount in USD */
  marginUSD: number;
  /** Final total in USD */
  totalUSD: number;
  /** Final total in atomic USDC (6 decimals) */
  totalAtomic: bigint;
  /** True when dynamic pricing was unavailable and static prices were used */
  isFallback: boolean;
  /** True when one or more floor prices were used for missing AWS prices */
  hasFloorPrices?: boolean;
}
