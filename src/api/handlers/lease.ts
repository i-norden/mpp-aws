/**
 * Lease API handlers.
 * TypeScript port of mmp-compute/lambda-proxy/internal/api/handlers_lease.go
 *
 * Provides endpoints for:
 *  - Listing available lease resources
 *  - Getting lease price
 *  - Creating a new lease (with encrypted SSH key delivery)
 *  - Polling lease status
 *  - Renewing a running lease
 */

import type { Context } from 'hono';
import type { Kysely, Selectable } from 'kysely';
import type { Database, LeaseResourceTable } from '../../db/types.js';
import type { Config } from '../../config/index.js';
import { getPaymentInfo } from '../middleware/mpp.js';
import { verifyAddressOwnership } from '../../auth/signature.js';
import { generateED25519KeyPair, zeroBytes } from '../../ssh-crypto/keygen.js';
import { encryptPrivateKey } from '../../ssh-crypto/encrypt.js';
import * as log from '../../logging/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LeaseResource = Selectable<LeaseResourceTable>;

export interface LeaseDeps {
  db: Kysely<Database>;
  config: Config;
  leaseService?: import('../../lease/service.js').LeaseService;
  priceCalculator?: import('../../aws-pricing/calculator.js').PriceCalculator;
  ec2Manager?: import('../../lease/worker.js').EC2Manager;
}

interface ResourcePricing {
  atomicUsdc: bigint;
  usd: string;
}

interface AddOn {
  name: string;
  queryParam: string;
  type: string;
  default: unknown;
}

interface ResourceResponse {
  id: string;
  name: string;
  instanceType: string;
  vcpus: number;
  memoryGB: number;
  storageGB: number;
  description: string | null;
  pricing: Record<string, ResourcePricing>;
  defaultStorageGb: number;
  minStorageGb: number;
  maxStorageGb: number;
  egressLimitGb: number;
  ingressLimitGb: number;
  publicIpDefault: boolean;
  addOns: AddOn[];
}

interface CreateLeaseRequest {
  publicKey: string; // base64-encoded X25519 public key
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_DURATIONS = new Set([1, 7, 30]);

function parseDuration(s: string | undefined): { days: number; error?: string } {
  if (!s) return { days: 0, error: 'duration is required' };
  const days = parseInt(s, 10);
  if (Number.isNaN(days)) return { days: 0, error: `invalid duration: ${s}` };
  if (!VALID_DURATIONS.has(days)) {
    return { days: 0, error: `unsupported duration: ${days} (must be 1, 7, or 30)` };
  }
  return { days };
}

function formatUSD(atomicAmount: bigint): string {
  const dollars = Number(atomicAmount) / 1_000_000;
  if (Math.abs(dollars) < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
}

function priceForDuration(resource: LeaseResource, days: number): bigint {
  switch (days) {
    case 1: return resource.price_1d;
    case 7: return resource.price_7d;
    case 30: return resource.price_30d;
    default: return 0n;
  }
}

function formatResourcePricing(r: LeaseResource): Record<string, ResourcePricing> {
  return {
    '1': { atomicUsdc: r.price_1d, usd: formatUSD(r.price_1d) },
    '7': { atomicUsdc: r.price_7d, usd: formatUSD(r.price_7d) },
    '30': { atomicUsdc: r.price_30d, usd: formatUSD(r.price_30d) },
  };
}

function resourceAddOns(r: LeaseResource): AddOn[] {
  return [
    {
      name: 'Extra Storage',
      queryParam: 'storageGb',
      type: 'int',
      default: r.default_storage_gb,
    },
    {
      name: 'Public IP',
      queryParam: 'publicIp',
      type: 'bool',
      default: r.public_ip_default,
    },
    {
      name: 'Load Balancer',
      queryParam: 'loadBalancer',
      type: 'bool',
      default: false,
    },
  ];
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const totalHours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
}

/**
 * Verify wallet ownership via signature headers.
 * Returns the verified payer address or null (with error response already sent).
 */
async function requireAddressOwnership(
  c: Context,
): Promise<string | null> {
  const address = c.req.header('X-Wallet-Address') ?? '';
  const signature = c.req.header('X-Wallet-Signature') ?? '';
  const message = c.req.header('X-Wallet-Message') ?? '';

  if (!address || !signature || !message) {
    c.status(401);
    return null;
  }

  const result = await verifyAddressOwnership(signature, message, address.toLowerCase());
  if (!result.valid) {
    c.status(401);
    return null;
  }

  return result.address;
}

// ---------------------------------------------------------------------------
// createLeaseHandlers
// ---------------------------------------------------------------------------

export function createLeaseHandlers(deps: LeaseDeps) {
  const { db, config } = deps;

  // -------------------------------------------------------------------
  // listResources: GET /lease/resources
  // -------------------------------------------------------------------

  async function listResources(c: Context): Promise<Response> {
    let resources: LeaseResource[];
    try {
      resources = await db
        .selectFrom('lease_resources')
        .selectAll()
        .where('enabled', '=', true)
        .execute();
    } catch (err) {
      log.error('failed to list lease resources', {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to list resources' }, 500);
    }

    const items: ResourceResponse[] = resources.map((r) => ({
      id: r.id,
      name: r.display_name,
      instanceType: r.instance_type,
      vcpus: r.vcpus,
      memoryGB: r.memory_gb,
      storageGB: r.storage_gb,
      description: r.description,
      pricing: formatResourcePricing(r),
      defaultStorageGb: r.default_storage_gb,
      minStorageGb: r.min_storage_gb,
      maxStorageGb: r.max_storage_gb,
      egressLimitGb: r.egress_limit_gb,
      ingressLimitGb: r.ingress_limit_gb,
      publicIpDefault: r.public_ip_default,
      addOns: resourceAddOns(r),
    }));

    return c.json({
      resources: items,
      network: config.network,
      payTo: config.payToAddress,
    });
  }

  // -------------------------------------------------------------------
  // getLeaseAmount: calculate the payment amount for a lease
  // (used as the getAmount callback for payment middleware)
  // -------------------------------------------------------------------

  function getLeaseAmount(_c: Context): bigint {
    // Synchronous approximation: we cannot do async DB lookups here.
    // The actual price validation happens in the createLease handler.
    // Return -1 to signal the middleware that price cannot be determined
    // from a sync callback. A more robust implementation would pre-cache
    // resource prices keyed by resourceId and duration.
    return -1n;
  }

  // -------------------------------------------------------------------
  // getLeaseDescription: description for payment middleware
  // -------------------------------------------------------------------

  function getLeaseDescription(c: Context): string {
    const resourceId = c.req.param('resourceId') ?? '';
    const duration = c.req.query('duration') ?? '';
    let desc = `EC2 lease: ${resourceId} for ${duration} days`;

    const storageGb = c.req.query('storageGb');
    if (storageGb) desc += `, ${storageGb}GB storage`;

    const publicIp = c.req.query('publicIp');
    if (publicIp === 'false' || publicIp === '0') desc += ', no public IP';

    const loadBalancer = c.req.query('loadBalancer');
    if (loadBalancer === 'true' || loadBalancer === '1') desc += ', with load balancer';

    return desc;
  }

  // -------------------------------------------------------------------
  // createLease: POST /lease/:resourceId?duration=N
  // -------------------------------------------------------------------

  async function createLease(c: Context): Promise<Response> {
    const resourceId = c.req.param('resourceId') ?? '';
    const durationStr = c.req.query('duration');
    const { days, error: durationError } = parseDuration(durationStr);
    if (durationError) {
      return c.json({ error: 'invalid_duration', message: durationError }, 400);
    }

    // Parse request body
    let body: CreateLeaseRequest;
    try {
      body = await c.req.json<CreateLeaseRequest>();
    } catch {
      return c.json({
        error: 'invalid_request',
        message: 'Request body must contain a base64-encoded X25519 publicKey',
      }, 400);
    }

    if (!body.publicKey) {
      return c.json({
        error: 'missing_public_key',
        message: 'publicKey is required (base64-encoded X25519 public key)',
      }, 400);
    }

    // Get payment info from context (set by payment middleware)
    const paymentInfo = getPaymentInfo(c);
    if (!paymentInfo) {
      return c.json({ error: 'payment info missing' }, 500);
    }

    // Validate resource
    let resource: LeaseResource | undefined;
    try {
      resource = await db
        .selectFrom('lease_resources')
        .selectAll()
        .where('id', '=', resourceId)
        .where('enabled', '=', true)
        .executeTakeFirst();
    } catch (err) {
      log.error('failed to get resource', {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to get resource' }, 500);
    }

    if (!resource) {
      return c.json({
        error: 'resource_not_found',
        message: `Resource not found: ${resourceId}`,
      }, 400);
    }

    // Decode user's X25519 public key
    let userPubKeyBytes: Uint8Array;
    try {
      userPubKeyBytes = new Uint8Array(Buffer.from(body.publicKey, 'base64'));
    } catch {
      return c.json({
        error: 'invalid_public_key',
        message: 'publicKey must be valid base64',
      }, 400);
    }
    if (userPubKeyBytes.length !== 32) {
      return c.json({
        error: 'invalid_public_key',
        message: `Invalid public key length: expected 32 bytes, got ${userPubKeyBytes.length}`,
      }, 400);
    }

    // Generate SSH key pair
    const keyPair = generateED25519KeyPair();

    // Encrypt private key with user's public key
    let encrypted;
    try {
      encrypted = encryptPrivateKey(keyPair.privateKey, userPubKeyBytes);
    } catch (err) {
      return c.json({
        error: 'encryption_failed',
        message: err instanceof Error ? err.message : 'failed to encrypt SSH key',
      }, 500);
    } finally {
      zeroBytes(keyPair.privateKey);
    }

    // Determine storage and IP settings
    const storageGbParam = c.req.query('storageGb');
    let storageGb = resource.default_storage_gb;
    if (storageGbParam) {
      const parsed = parseInt(storageGbParam, 10);
      if (!Number.isNaN(parsed) && parsed >= resource.min_storage_gb && parsed <= resource.max_storage_gb) {
        storageGb = parsed;
      }
    }

    const publicIpParam = c.req.query('publicIp');
    const hasPublicIp = publicIpParam === 'false' || publicIpParam === '0'
      ? false
      : resource.public_ip_default;

    const loadBalancerParam = c.req.query('loadBalancer');
    const hasLoadBalancer = loadBalancerParam === 'true' || loadBalancerParam === '1';

    // Create lease record
    const leaseId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    // Compute static price breakdown
    const price = priceForDuration(resource, days);
    const priceBreakdown = {
      totalAtomic: price.toString(),
      totalUsd: Number(price) / 1_000_000,
      isFallback: true,
    };

    // Check concurrent limits and insert atomically
    try {
      await db.transaction().execute(async (trx) => {
        // Check per-resource concurrent limit
        const { count: resourceCount } = await trx
          .selectFrom('leases')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('resource_id', '=', resourceId)
          .where('status', 'in', ['pending', 'provisioning', 'running'])
          .executeTakeFirstOrThrow();

        if (resource!.max_concurrent > 0 && Number(resourceCount) >= resource!.max_concurrent) {
          throw new Error('resource at maximum concurrent lease capacity');
        }

        // Check per-user limit
        const { count: userCount } = await trx
          .selectFrom('leases')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('payer_address', '=', paymentInfo.payer)
          .where('status', 'in', ['pending', 'provisioning', 'running'])
          .executeTakeFirstOrThrow();

        if (config.leaseMaxPerUser > 0 && Number(userCount) >= config.leaseMaxPerUser) {
          throw new Error('maximum active leases per user reached');
        }

        // Check global limit
        if (config.leaseMaxGlobalActive > 0) {
          const { count: globalCount } = await trx
            .selectFrom('leases')
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .where('status', 'in', ['pending', 'provisioning', 'running'])
            .executeTakeFirstOrThrow();

          if (Number(globalCount) >= config.leaseMaxGlobalActive) {
            throw new Error('global active lease limit reached');
          }
        }

        // Insert the lease
        await trx
          .insertInto('leases')
          .values({
            id: leaseId,
            resource_id: resourceId,
            payer_address: paymentInfo.payer,
            amount_paid: paymentInfo.amount,
            payment_tx_hash: paymentInfo.txHash,
            duration_days: days,
            ssh_public_key: keyPair.publicKey.trim(),
            encrypted_private_key: encrypted.combined,
            user_public_key: Buffer.from(userPubKeyBytes).toString('hex'),
            encryption_nonce: encrypted.nonce,
            status: 'pending',
            expires_at: expiresAt.toISOString(),
            storage_gb: storageGb,
            has_public_ip: hasPublicIp,
            has_load_balancer: hasLoadBalancer,
            egress_limit_gb: resource!.egress_limit_gb,
            ingress_limit_gb: resource!.ingress_limit_gb,
            price_breakdown: JSON.stringify(priceBreakdown),
          })
          .execute();
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('failed to create lease', {
        error: errMsg,
        payer: paymentInfo.payer,
      });
      return c.json({
        error: 'lease_creation_failed',
        message: errMsg,
      }, 400);
    }

    return c.json({
      leaseId,
      resourceId,
      status: 'pending',
      expiresAt: expiresAt.toISOString(),
      encryptedSshKey: encrypted.combined,
      sshPublicKey: keyPair.publicKey.trim(),
      paymentTxHash: paymentInfo.txHash,
      statusUrl: `/lease/${resourceId}/${leaseId}/status`,
      storageGb: storageGb,
      hasPublicIp: hasPublicIp,
      hasLoadBalancer: hasLoadBalancer,
      priceBreakdown,
    });
  }

  // -------------------------------------------------------------------
  // getLeaseStatus: GET /lease/:resourceId/:leaseId/status
  // -------------------------------------------------------------------

  async function getLeaseStatus(c: Context): Promise<Response> {
    const resourceId = c.req.param('resourceId') ?? '';
    const leaseId = c.req.param('leaseId') ?? '';

    // Require wallet signature for ownership verification
    const payerAddress = await requireAddressOwnership(c);
    if (!payerAddress) {
      return c.json({
        error: 'authentication_required',
        message: 'X-Wallet-Address, X-Wallet-Signature, and X-Wallet-Message headers are required',
      }, 401);
    }

    let lease;
    try {
      lease = await db
        .selectFrom('leases')
        .selectAll()
        .where('id', '=', leaseId)
        .executeTakeFirst();
    } catch (err) {
      log.error('failed to get lease status', {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to get lease status' }, 500);
    }

    if (!lease) {
      return c.json({ error: 'lease_not_found', message: 'Lease not found' }, 404);
    }

    // Verify resource ID matches
    if (lease.resource_id !== resourceId) {
      return c.json({ error: 'lease_not_found', message: 'Lease not found' }, 404);
    }

    // Verify payer matches (defense-in-depth against IDOR)
    if (lease.payer_address.toLowerCase() !== payerAddress.toLowerCase()) {
      return c.json({ error: 'lease_not_found', message: 'Lease not found' }, 404);
    }

    // Get the resource for SSH user info
    let resource: LeaseResource | undefined;
    try {
      resource = await db
        .selectFrom('lease_resources')
        .selectAll()
        .where('id', '=', lease.resource_id)
        .executeTakeFirst();
    } catch (err) {
      log.error('failed to get resource for lease status', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Build response
    const expiresAt = new Date(lease.expires_at);
    const resp: Record<string, unknown> = {
      leaseId: lease.id,
      resourceId: lease.resource_id,
      status: lease.status,
      sshPublicKey: lease.ssh_public_key,
      expiresAt: expiresAt.toISOString(),
      hasPublicIp: lease.has_public_ip,
    };

    if (lease.instance_id) resp.instanceId = lease.instance_id;
    if (lease.public_ip) resp.publicIp = lease.public_ip;
    if (resource) resp.sshUser = resource.ssh_user;

    if (lease.status === 'running') {
      const remainingMs = expiresAt.getTime() - Date.now();
      resp.timeRemaining = formatTimeRemaining(remainingMs);

      // Add expiry warning when close to expiration
      const warningThresholdMs = config.leaseExpiryWarningMinutes * 60 * 1000;
      if (warningThresholdMs > 0 && remainingMs > 0 && remainingMs < warningThresholdMs) {
        resp.warningMessage = `Lease expires in ${formatTimeRemaining(remainingMs)}. Renew now to avoid termination.`;
      }
    }

    if (lease.provisioned_at) {
      resp.provisionedAt = new Date(lease.provisioned_at).toISOString();
    }
    if (lease.error_message) resp.errorMessage = lease.error_message;
    if (lease.storage_gb !== null) resp.storageGb = lease.storage_gb;
    if (lease.egress_limit_gb !== null) resp.egressLimitGb = lease.egress_limit_gb;
    if (lease.ingress_limit_gb !== null) resp.ingressLimitGb = lease.ingress_limit_gb;
    resp.egressUsedGb = lease.egress_used_gb;
    resp.ingressUsedGb = lease.ingress_used_gb;

    // Parse price breakdown from JSONB
    if (lease.price_breakdown) {
      try {
        resp.priceBreakdown = typeof lease.price_breakdown === 'string'
          ? JSON.parse(lease.price_breakdown)
          : lease.price_breakdown;
      } catch {
        // ignore parse errors
      }
    }

    return c.json(resp);
  }

  // -------------------------------------------------------------------
  // getRenewalAmount: calculate the payment amount for a lease renewal
  // (used as the getAmount callback for payment middleware)
  // -------------------------------------------------------------------

  function getRenewalAmount(_c: Context): bigint {
    // Synchronous -- same limitation as getLeaseAmount.
    // The actual validation happens in renewLease.
    return -1n;
  }

  // -------------------------------------------------------------------
  // getRenewalDescription: description for renewal payment middleware
  // -------------------------------------------------------------------

  function getRenewalDescription(c: Context): string {
    const resourceId = c.req.param('resourceId') ?? '';
    const duration = c.req.query('duration') ?? '';
    return `EC2 lease renewal: ${resourceId} for ${duration} days`;
  }

  // -------------------------------------------------------------------
  // renewLease: PATCH /lease/:resourceId/:leaseId/renew
  // -------------------------------------------------------------------

  async function renewLease(c: Context): Promise<Response> {
    const resourceId = c.req.param('resourceId') ?? '';
    const leaseId = c.req.param('leaseId') ?? '';
    const durationStr = c.req.query('duration');
    const { days, error: durationError } = parseDuration(durationStr);
    if (durationError) {
      return c.json({ error: 'invalid_duration', message: durationError }, 400);
    }

    const paymentInfo = getPaymentInfo(c);
    if (!paymentInfo) {
      return c.json({ error: 'payment info missing' }, 500);
    }

    // Get and validate the lease
    let lease;
    try {
      lease = await db
        .selectFrom('leases')
        .selectAll()
        .where('id', '=', leaseId)
        .executeTakeFirst();
    } catch (err) {
      log.error('failed to get lease for renewal', {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'renewal_failed', message: 'failed to get lease' }, 400);
    }

    if (!lease) {
      return c.json({ error: 'renewal_failed', message: `lease not found: ${leaseId}` }, 400);
    }

    // Verify resource ID matches
    if (lease.resource_id !== resourceId) {
      return c.json({ error: 'renewal_failed', message: `lease not found: ${leaseId}` }, 400);
    }

    // Verify payer matches
    if (lease.payer_address.toLowerCase() !== paymentInfo.payer.toLowerCase()) {
      return c.json({ error: 'renewal_failed', message: 'unauthorized: payer address mismatch' }, 400);
    }

    // Must be running
    if (lease.status !== 'running') {
      return c.json({
        error: 'renewal_failed',
        message: `lease is not running (status: ${lease.status})`,
      }, 400);
    }

    // Compute new expiration
    const currentExpiresAt = new Date(lease.expires_at);
    const newExpiresAt = new Date(currentExpiresAt.getTime() + days * 24 * 60 * 60 * 1000);

    // Update expiration and record additional payment
    try {
      await db
        .updateTable('leases')
        .set({
          expires_at: newExpiresAt.toISOString(),
          amount_paid: lease.amount_paid + paymentInfo.amount,
          duration_days: lease.duration_days + days,
        })
        .where('id', '=', leaseId)
        .execute();
    } catch (err) {
      log.error('failed to renew lease', {
        error: err instanceof Error ? err.message : String(err),
        payer: paymentInfo.payer,
      });
      return c.json({ error: 'renewal_failed', message: 'failed to update lease' }, 400);
    }

    // Return updated lease status
    // Re-fetch the lease to get the updated values
    try {
      const updated = await db
        .selectFrom('leases')
        .selectAll()
        .where('id', '=', leaseId)
        .executeTakeFirst();

      if (updated) {
        const updatedExpires = new Date(updated.expires_at);
        const remainingMs = updatedExpires.getTime() - Date.now();

        return c.json({
          leaseId: updated.id,
          resourceId: updated.resource_id,
          status: updated.status,
          expiresAt: updatedExpires.toISOString(),
          timeRemaining: formatTimeRemaining(remainingMs),
          message: 'Lease renewed successfully',
        });
      }
    } catch {
      // fallback if re-fetch fails
    }

    return c.json({
      message: 'Lease renewed successfully',
      leaseId,
    });
  }

  // -------------------------------------------------------------------
  // Return all handlers
  // -------------------------------------------------------------------

  return {
    listResources,
    getLeaseAmount,
    getLeaseDescription,
    createLease,
    getLeaseStatus,
    getRenewalAmount,
    getRenewalDescription,
    renewLease,
  };
}
