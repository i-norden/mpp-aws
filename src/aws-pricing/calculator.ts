/**
 * Dynamic price calculator for EC2 leases.
 * Mirrors the Go implementation at mmp-compute/lambda-proxy/internal/awspricing/calculator.go
 *
 * Computes lease prices based on cached AWS prices from the database,
 * falling back to floor prices for non-critical components and to
 * static pricing when the primary EC2 compute price is unavailable.
 */

import type { Kysely } from 'kysely';

import type { Database } from '../db/types.js';
import type { LeaseAddOns, PriceBreakdown } from './types.js';
import * as log from '../logging/index.js';

// ---------------------------------------------------------------------------
// Row type aliases
// ---------------------------------------------------------------------------

type LeaseResource = {
  id: string;
  instance_type: string;
  margin_percent: number;
  default_storage_gb: number;
  egress_limit_gb: number;
  public_ip_default: boolean;
  [key: string]: unknown;
};

type AWSPrice = {
  price_usd: number;
  last_fetched_at: Date;
};

// ---------------------------------------------------------------------------
// Floor prices
// ---------------------------------------------------------------------------

/**
 * Conservative floor prices used when individual AWS price fetches fail.
 * EC2 compute has no floor -- a missing compute price triggers a full
 * fallback to static pricing.
 */
const FLOOR_PRICES: Record<string, Record<string, number>> = {
  ebs: { gp3: 0.08 },             // $0.08/GB-month
  ipv4: { public: 0.005 },        // $0.005/hour
  data_transfer: { 'out-standard': 0.09 }, // $0.09/GB
  alb: { standard: 0.0225 },      // $0.0225/hour
};

/**
 * Returns the floor price for a service/resource combination.
 * Returns 0 if no floor price is defined.
 */
export function getFloorPrice(service: string, resourceKey: string): number {
  return FLOOR_PRICES[service]?.[resourceKey] ?? 0;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum age for cached prices (36 hours = 1.5x sync interval). */
const DEFAULT_MAX_PRICE_AGE_MS = 36 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a USD amount to atomic USDC (6 decimals), rounding up.
 */
export function usdToAtomicUSDC(usd: number): bigint {
  return BigInt(Math.ceil(usd * 1_000_000));
}

/**
 * Returns the cached price if available, otherwise falls back to the floor price.
 * Sets `usedFloor.value` to true if the floor price was used.
 */
function priceOrFloor(
  cached: AWSPrice | null,
  service: string,
  resourceKey: string,
  usedFloor: { value: boolean },
): number {
  if (cached !== null) {
    return cached.price_usd;
  }
  const floor = getFloorPrice(service, resourceKey);
  if (floor > 0) {
    usedFloor.value = true;
    log.warn('using floor price for missing AWS price', {
      service,
      resourceKey,
      floorPrice: floor,
    });
  }
  return floor;
}

// ---------------------------------------------------------------------------
// PriceCalculator
// ---------------------------------------------------------------------------

/**
 * Computes dynamic lease prices based on cached AWS prices in the database.
 */
export class PriceCalculator {
  private readonly db: Kysely<Database>;
  private readonly region: string;
  private readonly maxPriceAgeMs: number;

  constructor(db: Kysely<Database>, region: string, maxPriceAgeMs?: number) {
    this.db = db;
    this.region = region;
    this.maxPriceAgeMs = maxPriceAgeMs ?? DEFAULT_MAX_PRICE_AGE_MS;
  }

  /**
   * Fetches a cached AWS price from the aws_pricing table.
   * Returns null if no matching row exists.
   */
  private async getAWSPrice(
    service: string,
    resourceKey: string,
  ): Promise<AWSPrice | null> {
    const row = await this.db
      .selectFrom('aws_pricing')
      .select(['price_usd', 'last_fetched_at'])
      .where('service', '=', service)
      .where('resource_key', '=', resourceKey)
      .where('region', '=', this.region)
      .executeTakeFirst();

    if (!row) return null;
    return {
      price_usd: Number(row.price_usd),
      last_fetched_at: new Date(row.last_fetched_at as unknown as string),
    };
  }

  /**
   * Computes the total price for a lease including all cost components.
   *
   * Returns a PriceBreakdown with all cost components, or null if the
   * primary EC2 compute price is unavailable (caller should use static fallback).
   */
  async calculateLeasePrice(
    resource: LeaseResource,
    durationDays: number,
    addOns: LeaseAddOns,
  ): Promise<PriceBreakdown | null> {
    const hours = durationDays * 24;
    const usedFloor = { value: false };

    // Fetch compute price -- required
    const ec2Price = await this.getAWSPrice('ec2', resource.instance_type);
    if (ec2Price === null) {
      // No cached price -- caller should use static fallback
      return null;
    }

    // Stale price detection
    if (this.maxPriceAgeMs > 0) {
      const ageMs = Date.now() - ec2Price.last_fetched_at.getTime();
      if (ageMs > this.maxPriceAgeMs) {
        log.warn('EC2 price is stale, falling back to static pricing', {
          instanceType: resource.instance_type,
          lastFetchedAt: ec2Price.last_fetched_at.toISOString(),
          maxAgeMs: this.maxPriceAgeMs,
        });
        return null;
      }
    }

    const compute = ec2Price.price_usd * hours;

    // EBS storage (use floor if unavailable)
    let storageUSD = 0;
    let ebsPrice: AWSPrice | null = null;
    try {
      ebsPrice = await this.getAWSPrice('ebs', 'gp3');
    } catch (err) {
      log.error('failed to get EBS price', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const ebsRate = priceOrFloor(ebsPrice, 'ebs', 'gp3', usedFloor);
    storageUSD = ebsRate * addOns.storageGB * durationDays / 30;

    // IPv4 cost (use floor if unavailable)
    let ipv4USD = 0;
    if (addOns.publicIP) {
      let ipv4Price: AWSPrice | null = null;
      try {
        ipv4Price = await this.getAWSPrice('ipv4', 'public');
      } catch (err) {
        log.error('failed to get IPv4 price', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const ipv4Rate = priceOrFloor(ipv4Price, 'ipv4', 'public', usedFloor);
      ipv4USD = ipv4Rate * hours;
    }

    // Egress allowance cost (use floor if unavailable)
    let egressUSD = 0;
    let dtPrice: AWSPrice | null = null;
    try {
      dtPrice = await this.getAWSPrice('data_transfer', 'out-standard');
    } catch (err) {
      log.error('failed to get data transfer price', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const dtRate = priceOrFloor(dtPrice, 'data_transfer', 'out-standard', usedFloor);
    egressUSD = dtRate * resource.egress_limit_gb;

    // Load balancer cost (use floor if unavailable)
    let lbUSD = 0;
    if (addOns.loadBalancer) {
      let albPrice: AWSPrice | null = null;
      try {
        albPrice = await this.getAWSPrice('alb', 'standard');
      } catch (err) {
        log.error('failed to get ALB price', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const albRate = priceOrFloor(albPrice, 'alb', 'standard', usedFloor);
      lbUSD = albRate * hours;
    }

    const subtotal = compute + storageUSD + ipv4USD + egressUSD + lbUSD;
    const marginPercent = resource.margin_percent;
    const marginUSD = subtotal * marginPercent / 100;
    const totalUSD = subtotal + marginUSD;

    return {
      computeUSD: compute,
      storageUSD,
      ipv4USD,
      lbUSD,
      egressUSD,
      subtotalUSD: subtotal,
      marginPercent,
      marginUSD,
      totalUSD,
      totalAtomic: usdToAtomicUSDC(totalUSD),
      isFallback: false,
      hasFloorPrices: usedFloor.value || undefined,
    };
  }

  /**
   * Computes the price for a specific duration with default add-ons.
   * Used for the /lease/resources listing.
   */
  async calculatePriceForDuration(
    resource: LeaseResource,
    durationDays: number,
  ): Promise<PriceBreakdown | null> {
    const addOns: LeaseAddOns = {
      storageGB: resource.default_storage_gb,
      publicIP: resource.public_ip_default,
      loadBalancer: false,
    };
    return this.calculateLeasePrice(resource, durationDays, addOns);
  }
}
