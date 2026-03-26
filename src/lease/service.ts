/**
 * Lease lifecycle management service.
 * Mirrors the Go implementation at mmp-compute/lambda-proxy/internal/lease/service.go
 *
 * Manages the full lifecycle of EC2 instance leases: resource listing,
 * dynamic pricing, lease creation (with SSH key generation and encryption),
 * status polling, and lease renewal.
 */

import { v4 as uuidv4 } from 'uuid';

import { Store } from '../db/store.js';
import type { LeaseResource } from '../db/store-resources.js';
import {
  listLeaseResources,
  getLeaseResource,
} from '../db/store-resources.js';
import {
  type InsertableLease,
  LeaseStatus,
  createLeaseAtomic,
  getLease as dbGetLease,
  updateLeaseExpiresAt as dbUpdateLeaseExpiresAt,
} from '../db/store-lease.js';
import { PriceCalculator } from '../aws-pricing/calculator.js';
import type { LeaseAddOns, PriceBreakdown } from '../aws-pricing/types.js';
import { generateED25519KeyPair, zeroBytes } from '../ssh-crypto/keygen.js';
import { encryptPrivateKey } from '../ssh-crypto/encrypt.js';

// ---------------------------------------------------------------------------
// Valid durations
// ---------------------------------------------------------------------------

/** Allowed lease durations in days. */
export const VALID_DURATIONS = new Set([1, 7, 30]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the static price for a resource at a given duration.
 */
function priceForDuration(resource: LeaseResource, days: number): bigint {
  switch (days) {
    case 1:
      return BigInt(resource.price_1d);
    case 7:
      return BigInt(resource.price_7d);
    case 30:
      return BigInt(resource.price_30d);
    default:
      return 0n;
  }
}

/**
 * Formats a duration in milliseconds as a human-readable string.
 */
export function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return 'expired';

  const totalHours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  return `${hours}h ${minutes}m`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the lease service. */
export interface LeaseServiceConfig {
  maxPerUser: number;
  maxProvisionAttempts: number;
  maxGlobalActive: number;
  /** Duration (ms) before expiry to show warnings. */
  expiryWarningThresholdMs: number;
}

/** Parameters for creating a new lease. */
export interface CreateLeaseParams {
  resourceId: string;
  durationDays: number;
  payerAddress: string;
  txHash: string;
  amountPaid: bigint;
  /** Base64-encoded X25519 public key from user. */
  userPublicKeyBase64: string;
  storageGB: number;
  publicIP: boolean;
  loadBalancer: boolean;
  priceBreakdown?: PriceBreakdown | null;
}

/** Result of creating a lease. */
export interface CreateLeaseOutput {
  leaseId: string;
  resourceId: string;
  status: string;
  expiresAt: Date;
  encryptedSSHKey: string;
  sshPublicKey: string;
  paymentTxHash: string;
  storageGB: number;
  hasPublicIP: boolean;
  hasLoadBalancer: boolean;
  priceBreakdown?: PriceBreakdown | null;
}

/** Parameters for renewing a lease. */
export interface RenewLeaseParams {
  resourceId: string;
  leaseId: string;
  payerAddress: string;
  durationDays: number;
  amountPaid: bigint;
  txHash: string;
}

/** Response shape for lease status polling. */
export interface LeaseStatusResponse {
  leaseId: string;
  resourceId: string;
  status: string;
  instanceId?: string;
  publicIp?: string;
  sshUser?: string;
  sshPublicKey: string;
  expiresAt: string;
  timeRemaining?: string;
  warningMessage?: string;
  provisionedAt?: string;
  errorMessage?: string;
  storageGB?: number;
  hasPublicIP: boolean;
  egressLimitGB?: number;
  egressUsedGB?: number;
  ingressLimitGB?: number;
  ingressUsedGB?: number;
  priceBreakdown?: unknown;
}

// ---------------------------------------------------------------------------
// LeaseService
// ---------------------------------------------------------------------------

/**
 * Manages the lease lifecycle: listing resources, pricing, creation,
 * status polling, and renewal.
 */
export class LeaseService {
  private readonly store: Store;
  private readonly config: LeaseServiceConfig;
  private calculator: PriceCalculator | null;

  constructor(store: Store, config: LeaseServiceConfig) {
    this.store = store;
    this.config = config;
    this.calculator = null;
  }

  /** Sets the pricing calculator for dynamic pricing. */
  setCalculator(calc: PriceCalculator): void {
    this.calculator = calc;
  }

  /** Returns the pricing calculator (may be null). */
  getCalculator(): PriceCalculator | null {
    return this.calculator;
  }

  // -----------------------------------------------------------------------
  // Resource listing
  // -----------------------------------------------------------------------

  /** Returns all enabled lease resources. */
  async listResources(): Promise<LeaseResource[]> {
    return listLeaseResources(this.store.db);
  }

  /** Returns a single resource by ID. */
  async getResource(id: string): Promise<LeaseResource | null> {
    return getLeaseResource(this.store.db, id);
  }

  // -----------------------------------------------------------------------
  // Pricing
  // -----------------------------------------------------------------------

  /**
   * Returns the static price for a resource at a given duration.
   * Used as fallback when dynamic pricing is not available.
   */
  async getPriceForResource(
    resourceId: string,
    durationDays: number,
    options?: { allowDisabled?: boolean },
  ): Promise<bigint> {
    const resource = await getLeaseResource(this.store.db, resourceId);
    if (!resource || (!resource.enabled && !options?.allowDisabled)) {
      throw new Error(`resource not found or disabled: ${resourceId}`);
    }
    const price = priceForDuration(resource, durationDays);
    if (price === 0n) {
      throw new Error(`unsupported duration: ${durationDays} days`);
    }
    return price;
  }

  /**
   * Computes the dynamic price for a lease with add-ons.
   * Returns the PriceBreakdown and total atomic USDC amount.
   * Falls back to static pricing if the calculator is null or AWS prices
   * are unavailable.
   */
  async getPriceForLease(
    resourceId: string,
    durationDays: number,
    addOns: LeaseAddOns,
    options?: { allowDisabled?: boolean },
  ): Promise<{ breakdown: PriceBreakdown; totalAtomic: bigint }> {
    const resource = await getLeaseResource(this.store.db, resourceId);
    if (!resource || (!resource.enabled && !options?.allowDisabled)) {
      throw new Error(`resource not found or disabled: ${resourceId}`);
    }

    // Try dynamic pricing
    if (this.calculator) {
      const breakdown = await this.calculator.calculateLeasePrice(
        resource,
        durationDays,
        addOns,
      );
      if (breakdown) {
        return { breakdown, totalAtomic: breakdown.totalAtomic };
      }
    }

    // Fallback to static pricing
    const staticPrice = priceForDuration(resource, durationDays);
    if (staticPrice === 0n) {
      throw new Error(`unsupported duration: ${durationDays} days`);
    }

    const breakdown: PriceBreakdown = {
      computeUSD: 0,
      storageUSD: 0,
      ipv4USD: 0,
      lbUSD: 0,
      egressUSD: 0,
      subtotalUSD: 0,
      marginPercent: 0,
      marginUSD: 0,
      totalUSD: Number(staticPrice) / 1_000_000,
      totalAtomic: staticPrice,
      isFallback: true,
    };
    return { breakdown, totalAtomic: staticPrice };
  }

  /**
   * Computes the exact renewal price for an existing running lease using the
   * lease's persisted add-ons rather than request-time guesses.
   */
  async getRenewalPrice(
    resourceId: string,
    leaseId: string,
    durationDays: number,
  ): Promise<{ breakdown: PriceBreakdown; totalAtomic: bigint }> {
    if (!VALID_DURATIONS.has(durationDays)) {
      throw new Error(
        `unsupported duration: ${durationDays} (must be 1, 7, or 30)`,
      );
    }

    const lease = await dbGetLease(this.store.db, leaseId);
    if (!lease) {
      throw new Error(`lease not found: ${leaseId}`);
    }
    if (lease.resource_id !== resourceId) {
      throw new Error(`lease not found: ${leaseId}`);
    }
    if (lease.status !== LeaseStatus.Running) {
      throw new Error(`lease is not running (status: ${lease.status})`);
    }

    const resource = await getLeaseResource(this.store.db, lease.resource_id);
    if (!resource) {
      throw new Error(`resource not found or disabled: ${lease.resource_id}`);
    }

    return this.getPriceForLease(
      resourceId,
      durationDays,
      {
        storageGB: lease.storage_gb ?? resource.default_storage_gb,
        publicIP: lease.has_public_ip,
        loadBalancer: lease.has_load_balancer,
      },
      { allowDisabled: true },
    );
  }

  // -----------------------------------------------------------------------
  // Lease creation
  // -----------------------------------------------------------------------

  /**
   * Creates a new lease after payment has been verified.
   *
   * Generates an ED25519 SSH key pair, encrypts the private key with the
   * user's X25519 public key, and atomically inserts the lease record with
   * concurrent limit checks.
   */
  async createLease(params: CreateLeaseParams): Promise<CreateLeaseOutput> {
    // Validate resource
    const resource = await getLeaseResource(this.store.db, params.resourceId);
    if (!resource || !resource.enabled) {
      throw new Error(`resource not found or disabled: ${params.resourceId}`);
    }

    // Decode user's X25519 public key
    let userPubKeyBytes: Uint8Array;
    try {
      userPubKeyBytes = new Uint8Array(
        Buffer.from(params.userPublicKeyBase64, 'base64'),
      );
    } catch {
      throw new Error('invalid public key encoding');
    }
    if (userPubKeyBytes.length !== 32) {
      throw new Error(
        `invalid public key length: expected 32 bytes, got ${userPubKeyBytes.length}`,
      );
    }

    // Generate SSH key pair
    const keyPair = generateED25519KeyPair();
    try {
      // Encrypt private key with user's public key
      const encrypted = encryptPrivateKey(keyPair.privateKey, userPubKeyBytes);

      // Determine storage
      const storageGB =
        params.storageGB > 0 ? params.storageGB : resource.default_storage_gb;
      if (
        storageGB < resource.min_storage_gb
        || storageGB > resource.max_storage_gb
      ) {
        throw new Error(
          `storageGB must be between ${resource.min_storage_gb} and ${resource.max_storage_gb}`,
        );
      }

      // Create lease record
      const leaseId = uuidv4();
      const expiresAt = new Date(
        Date.now() + params.durationDays * 24 * 60 * 60 * 1000,
      );

      const lease: InsertableLease = {
        id: leaseId,
        resource_id: params.resourceId,
        payer_address: params.payerAddress,
        amount_paid: params.amountPaid,
        payment_tx_hash: params.txHash,
        duration_days: params.durationDays,
        ssh_public_key: keyPair.publicKey.trim(),
        encrypted_private_key: encrypted.combined,
        user_public_key: Buffer.from(userPubKeyBytes).toString('hex'),
        encryption_nonce: encrypted.nonce,
        status: LeaseStatus.Pending,
        expires_at: expiresAt,
        storage_gb: storageGB,
        has_public_ip: params.publicIP,
        has_load_balancer: params.loadBalancer,
        egress_limit_gb: resource.egress_limit_gb,
        ingress_limit_gb: resource.ingress_limit_gb,
        price_breakdown: params.priceBreakdown
          ? JSON.parse(
              JSON.stringify(params.priceBreakdown, (_key, value) =>
                typeof value === 'bigint' ? value.toString() : value,
              ),
            )
          : null,
      };

      // Atomically check concurrent limits and insert the lease in a single
      // transaction to prevent TOCTOU race conditions.
      await this.store.withTransaction(async (txStore) => {
        await createLeaseAtomic(
          txStore.db,
          lease,
          resource.max_concurrent,
          this.config.maxPerUser,
          this.config.maxGlobalActive,
        );
      });

      return {
        leaseId,
        resourceId: params.resourceId,
        status: LeaseStatus.Pending,
        expiresAt,
        encryptedSSHKey: encrypted.combined,
        sshPublicKey: keyPair.publicKey.trim(),
        paymentTxHash: params.txHash,
        storageGB,
        hasPublicIP: params.publicIP,
        hasLoadBalancer: params.loadBalancer,
        priceBreakdown: params.priceBreakdown,
      };
    } finally {
      // Zero private key material after encryption
      zeroBytes(keyPair.privateKey);
    }
  }

  // -----------------------------------------------------------------------
  // Lease status
  // -----------------------------------------------------------------------

  /**
   * Returns the status of a lease with resource context.
   *
   * If payerAddress is non-empty, it is verified against the lease owner for
   * defense-in-depth against IDOR. When it does not match, null is returned
   * (indistinguishable from "not found").
   */
  async getLeaseStatus(
    resourceId: string,
    leaseId: string,
    payerAddress: string,
  ): Promise<LeaseStatusResponse | null> {
    const lease = await dbGetLease(this.store.db, leaseId);
    if (!lease) return null;

    // Verify the resource ID matches
    if (lease.resource_id !== resourceId) return null;

    // Defense-in-depth: verify the requester is the lease owner when provided
    if (
      payerAddress !== '' &&
      lease.payer_address.toLowerCase() !== payerAddress.toLowerCase()
    ) {
      return null;
    }

    // Get the resource for SSH user info
    const resource = await getLeaseResource(this.store.db, lease.resource_id);

    const resp: LeaseStatusResponse = {
      leaseId: lease.id,
      resourceId: lease.resource_id,
      status: lease.status as string,
      sshPublicKey: lease.ssh_public_key,
      expiresAt: new Date(lease.expires_at).toISOString(),
      hasPublicIP: lease.has_public_ip,
    };

    if (lease.instance_id) {
      resp.instanceId = lease.instance_id;
    }
    if (lease.public_ip) {
      resp.publicIp = lease.public_ip;
    }
    if (resource) {
      resp.sshUser = resource.ssh_user;
    }

    if (lease.status === LeaseStatus.Running) {
      const remainingMs =
        new Date(lease.expires_at).getTime() - Date.now();
      resp.timeRemaining = formatTimeRemaining(remainingMs);

      // Add expiry warning when close to expiration
      if (
        this.config.expiryWarningThresholdMs > 0 &&
        remainingMs > 0 &&
        remainingMs < this.config.expiryWarningThresholdMs
      ) {
        resp.warningMessage = `Lease expires in ${formatTimeRemaining(remainingMs)}. Renew now to avoid termination.`;
      }
    }

    if (lease.provisioned_at) {
      resp.provisionedAt = new Date(lease.provisioned_at).toISOString();
    }
    if (lease.error_message) {
      resp.errorMessage = lease.error_message;
    }
    if (lease.storage_gb !== null && lease.storage_gb !== undefined) {
      resp.storageGB = Number(lease.storage_gb);
    }
    if (lease.egress_limit_gb !== null && lease.egress_limit_gb !== undefined) {
      resp.egressLimitGB = Number(lease.egress_limit_gb);
    }
    if (
      lease.ingress_limit_gb !== null &&
      lease.ingress_limit_gb !== undefined
    ) {
      resp.ingressLimitGB = Number(lease.ingress_limit_gb);
    }
    if (lease.egress_used_gb) {
      resp.egressUsedGB = Number(lease.egress_used_gb);
    }
    if (lease.ingress_used_gb) {
      resp.ingressUsedGB = Number(lease.ingress_used_gb);
    }

    // Parse price breakdown from JSONB
    if (lease.price_breakdown) {
      try {
        resp.priceBreakdown =
          typeof lease.price_breakdown === 'string'
            ? JSON.parse(lease.price_breakdown as string)
            : lease.price_breakdown;
      } catch {
        // Ignore parse errors
      }
    }

    return resp;
  }

  // -----------------------------------------------------------------------
  // Lease renewal
  // -----------------------------------------------------------------------

  /**
   * Extends a running lease's expiration.
   *
   * Validates payer ownership, current status, and duration before
   * updating the expiration in the database.
   */
  async renewLease(params: RenewLeaseParams): Promise<void> {
    const lease = await dbGetLease(this.store.db, params.leaseId);
    if (!lease) {
      throw new Error(`lease not found: ${params.leaseId}`);
    }

    // Verify resource ID matches (prevent IDOR)
    if (lease.resource_id !== params.resourceId) {
      throw new Error(`lease not found: ${params.leaseId}`);
    }

    // Verify payer matches
    if (
      lease.payer_address.toLowerCase() !== params.payerAddress.toLowerCase()
    ) {
      throw new Error('unauthorized: payer address mismatch');
    }

    // Must be running
    if (lease.status !== LeaseStatus.Running) {
      throw new Error(`lease is not running (status: ${lease.status})`);
    }

    // Validate duration
    if (!VALID_DURATIONS.has(params.durationDays)) {
      throw new Error(
        `unsupported duration: ${params.durationDays} (must be 1, 7, or 30)`,
      );
    }

    // Compute new expiration
    const currentExpires = new Date(lease.expires_at);
    const newExpiresAt = new Date(
      currentExpires.getTime() + params.durationDays * 24 * 60 * 60 * 1000,
    );

    await dbUpdateLeaseExpiresAt(
      this.store.db,
      params.leaseId,
      newExpiresAt,
      params.amountPaid,
      params.durationDays,
    );
  }
}
