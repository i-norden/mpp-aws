/**
 * Lease API handlers.
 *
 * Keeps HTTP concerns in this module and delegates lease lifecycle logic to
 * LeaseService so pricing, creation, status, and renewal follow one path.
 */

import type { Context } from 'hono';
import type { Kysely, Selectable } from 'kysely';

import { verifyAddressOwnershipWithReplay } from '../../auth/signature.js';
import type { LeaseAddOns } from '../../aws-pricing/types.js';
import type { Config } from '../../config/index.js';
import type { Database, LeaseResourceTable } from '../../db/types.js';
import {
  GlobalLimitReachedError,
  ResourceLimitReachedError,
  UserLimitReachedError,
} from '../../db/store-lease.js';
import { HttpError, errorResponse, ErrorCodes } from '../errors.js';
import { getPaymentInfo } from '../middleware/mpp.js';
import { readJsonBody } from '../request-body.js';
import * as log from '../../logging/index.js';

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
  publicKey?: string;
}

const VALID_DURATIONS = new Set([1, 7, 30]);

function parseDuration(raw: string | undefined): number {
  if (!raw) {
    throw new HttpError(400, 'duration is required');
  }

  const days = parseInt(raw, 10);
  if (Number.isNaN(days) || !VALID_DURATIONS.has(days)) {
    throw new HttpError(400, 'duration must be one of 1, 7, or 30 days');
  }

  return days;
}

function formatUSD(atomicAmount: bigint): string {
  const dollars = Number(atomicAmount) / 1_000_000;
  if (Math.abs(dollars) < 0.01) {
    return `$${dollars.toFixed(4)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

function formatResourcePricing(resource: LeaseResource): Record<string, ResourcePricing> {
  return {
    '1': { atomicUsdc: resource.price_1d, usd: formatUSD(resource.price_1d) },
    '7': { atomicUsdc: resource.price_7d, usd: formatUSD(resource.price_7d) },
    '30': { atomicUsdc: resource.price_30d, usd: formatUSD(resource.price_30d) },
  };
}

function resourceAddOns(resource: LeaseResource): AddOn[] {
  return [
    {
      name: 'Extra Storage',
      queryParam: 'storageGb',
      type: 'int',
      default: resource.default_storage_gb,
    },
    {
      name: 'Public IP',
      queryParam: 'publicIp',
      type: 'bool',
      default: resource.public_ip_default,
    },
    {
      name: 'Load Balancer',
      queryParam: 'loadBalancer',
      type: 'bool',
      default: false,
    },
  ];
}

function parseBooleanQuery(
  raw: string | undefined,
  defaultValue: boolean,
  fieldName: string,
): boolean {
  if (raw === undefined) {
    return defaultValue;
  }

  if (raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === '0') {
    return false;
  }

  throw new HttpError(400, `${fieldName} must be true, false, 1, or 0`);
}

function parseLeaseAddOns(resource: LeaseResource, c: Context): LeaseAddOns {
  let storageGB = resource.default_storage_gb;
  const storageParam = c.req.query('storageGb');
  if (storageParam !== undefined) {
    const parsed = parseInt(storageParam, 10);
    if (Number.isNaN(parsed)) {
      throw new HttpError(400, 'storageGb must be an integer');
    }
    if (parsed < resource.min_storage_gb || parsed > resource.max_storage_gb) {
      throw new HttpError(
        400,
        `storageGb must be between ${resource.min_storage_gb} and ${resource.max_storage_gb}`,
      );
    }
    storageGB = parsed;
  }

  return {
    storageGB,
    publicIP: parseBooleanQuery(c.req.query('publicIp'), resource.public_ip_default, 'publicIp'),
    loadBalancer: parseBooleanQuery(c.req.query('loadBalancer'), false, 'loadBalancer'),
  };
}

function leaseErrorToHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  if (
    error instanceof ResourceLimitReachedError
    || error instanceof UserLimitReachedError
    || error instanceof GlobalLimitReachedError
  ) {
    return new HttpError(409, error.message);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('resource not found') || message.startsWith('lease not found')) {
    return new HttpError(404, message);
  }
  if (message.startsWith('unauthorized')) {
    return new HttpError(403, message);
  }
  if (message.includes('not running') || message.includes('maximum')) {
    return new HttpError(409, message);
  }
  if (
    message.includes('invalid public key')
    || message.includes('unsupported duration')
    || message.includes('storage')
  ) {
    return new HttpError(400, message);
  }

  return new HttpError(500, 'lease operation failed', message);
}

async function requireAddressOwnership(
  c: Context,
  db: Kysely<Database>,
): Promise<string | null> {
  const address = c.req.header('X-Wallet-Address') ?? '';
  const signature = c.req.header('X-Wallet-Signature') ?? c.req.header('X-Signature') ?? '';
  const message = c.req.header('X-Wallet-Message') ?? c.req.header('X-Message') ?? '';

  if (!address || !signature || !message) {
    c.res = errorResponse(c, 401, ErrorCodes.AUTHENTICATION_REQUIRED, 'X-Wallet-Address, X-Wallet-Signature, and X-Wallet-Message headers are required', "Sign a message in format 'open-compute:{address}:{timestamp}:{nonce}' with your wallet");
    return null;
  }

  const result = await verifyAddressOwnershipWithReplay(
    db,
    signature,
    message,
    address,
  );
  if (!result.valid) {
    c.res = errorResponse(c, result.statusCode ?? 401, ErrorCodes.AUTHENTICATION_FAILED, result.errorMessage ?? 'authentication failed');
    return null;
  }

  return result.address;
}

export function createLeaseHandlers(deps: LeaseDeps) {
  const { db, config, leaseService } = deps;

  function getLeaseService() {
    if (!leaseService) {
      throw new HttpError(503, 'lease service not configured');
    }
    return leaseService;
  }

  async function quoteLeaseRequest(c: Context) {
    const service = getLeaseService();
    const resourceId = c.req.param('resourceId') ?? '';
    if (!resourceId) {
      throw new HttpError(400, 'resource ID is required');
    }

    const days = parseDuration(c.req.query('duration'));
    const resource = await service.getResource(resourceId);
    if (!resource || !resource.enabled) {
      throw new HttpError(404, `resource not found: ${resourceId}`);
    }

    const addOns = parseLeaseAddOns(resource, c);
    try {
      const quote = await service.getPriceForLease(resourceId, days, addOns);
      return { resourceId, days, resource, addOns, quote };
    } catch (error) {
      throw leaseErrorToHttpError(error);
    }
  }

  async function quoteRenewalRequest(c: Context) {
    const service = getLeaseService();
    const resourceId = c.req.param('resourceId') ?? '';
    const leaseId = c.req.param('leaseId') ?? '';
    if (!resourceId || !leaseId) {
      throw new HttpError(400, 'resource ID and lease ID are required');
    }

    const days = parseDuration(c.req.query('duration'));
    try {
      const quote = await service.getRenewalPrice(resourceId, leaseId, days);
      return { resourceId, leaseId, days, quote };
    } catch (error) {
      throw leaseErrorToHttpError(error);
    }
  }

  async function listResources(c: Context): Promise<Response> {
    let resources: LeaseResource[];
    try {
      resources = await getLeaseService().listResources() as LeaseResource[];
    } catch (error) {
      log.error('failed to list lease resources', {
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list resources');
    }

    const items: ResourceResponse[] = resources.map((resource) => ({
      id: resource.id,
      name: resource.display_name,
      instanceType: resource.instance_type,
      vcpus: resource.vcpus,
      memoryGB: resource.memory_gb,
      storageGB: resource.storage_gb,
      description: resource.description,
      pricing: formatResourcePricing(resource),
      defaultStorageGb: resource.default_storage_gb,
      minStorageGb: resource.min_storage_gb,
      maxStorageGb: resource.max_storage_gb,
      egressLimitGb: resource.egress_limit_gb,
      ingressLimitGb: resource.ingress_limit_gb,
      publicIpDefault: resource.public_ip_default,
      addOns: resourceAddOns(resource),
    }));

    return c.json({
      resources: items,
      network: config.network,
      payTo: config.payToAddress,
    });
  }

  async function getLeaseAmount(c: Context): Promise<bigint> {
    const { quote } = await quoteLeaseRequest(c);
    return quote.totalAtomic;
  }

  function getLeaseDescription(c: Context): string {
    const resourceId = c.req.param('resourceId') ?? '';
    const duration = c.req.query('duration') ?? '';
    let description = `EC2 lease: ${resourceId} for ${duration} days`;

    const storageGb = c.req.query('storageGb');
    if (storageGb) {
      description += `, ${storageGb}GB storage`;
    }

    const publicIp = c.req.query('publicIp');
    if (publicIp === 'false' || publicIp === '0') {
      description += ', no public IP';
    }

    const loadBalancer = c.req.query('loadBalancer');
    if (loadBalancer === 'true' || loadBalancer === '1') {
      description += ', with load balancer';
    }

    return description;
  }

  async function createLease(c: Context): Promise<Response> {
    let body: CreateLeaseRequest;
    let quoted: Awaited<ReturnType<typeof quoteLeaseRequest>>;

    try {
      body = await readJsonBody<CreateLeaseRequest>(c);
      quoted = await quoteLeaseRequest(c);
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(c, error.status, ErrorCodes.INTERNAL_ERROR, error.message, error.details);
      }
      throw error;
    }

    if (!body.publicKey) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'publicKey is required (base64-encoded X25519 public key)');
    }

    const paymentInfo = getPaymentInfo(c);
    if (!paymentInfo) {
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'payment info missing');
    }

    if (paymentInfo.amount !== quoted.quote.totalAtomic) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'Lease payment amount no longer matches the exact quoted price.');
    }

    try {
      const created = await getLeaseService().createLease({
        resourceId: quoted.resourceId,
        durationDays: quoted.days,
        payerAddress: paymentInfo.payer,
        txHash: paymentInfo.txHash,
        amountPaid: paymentInfo.amount,
        userPublicKeyBase64: body.publicKey,
        storageGB: quoted.addOns.storageGB,
        publicIP: quoted.addOns.publicIP,
        loadBalancer: quoted.addOns.loadBalancer,
        priceBreakdown: quoted.quote.breakdown,
      });

      return c.json({
        leaseId: created.leaseId,
        resourceId: created.resourceId,
        status: created.status,
        expiresAt: created.expiresAt.toISOString(),
        encryptedSshKey: created.encryptedSSHKey,
        sshPublicKey: created.sshPublicKey,
        paymentTxHash: created.paymentTxHash,
        statusUrl: `/lease/${created.resourceId}/${created.leaseId}/status`,
        storageGb: created.storageGB,
        hasPublicIp: created.hasPublicIP,
        hasLoadBalancer: created.hasLoadBalancer,
        priceBreakdown: created.priceBreakdown ?? quoted.quote.breakdown,
      });
    } catch (error) {
      const httpError = leaseErrorToHttpError(error);
      return errorResponse(c, httpError.status, ErrorCodes.INTERNAL_ERROR, httpError.message, httpError.details);
    }
  }

  async function getLeaseStatus(c: Context): Promise<Response> {
    const resourceId = c.req.param('resourceId') ?? '';
    const leaseId = c.req.param('leaseId') ?? '';
    if (!resourceId || !leaseId) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'resource ID and lease ID are required');
    }

    const payerAddress = await requireAddressOwnership(c, db);
    if (!payerAddress) {
      return c.res;
    }

    try {
      const status = await getLeaseService().getLeaseStatus(
        resourceId,
        leaseId,
        payerAddress,
      );
      if (!status) {
        return errorResponse(c, 404, ErrorCodes.NOT_FOUND, 'Lease not found');
      }

      return c.json(status);
    } catch (error) {
      log.error('failed to get lease status', {
        leaseId,
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to get lease status');
    }
  }

  async function getRenewalAmount(c: Context): Promise<bigint> {
    const { quote } = await quoteRenewalRequest(c);
    return quote.totalAtomic;
  }

  function getRenewalDescription(c: Context): string {
    const resourceId = c.req.param('resourceId') ?? '';
    const duration = c.req.query('duration') ?? '';
    return `EC2 lease renewal: ${resourceId} for ${duration} days`;
  }

  async function renewLease(c: Context): Promise<Response> {
    let quoted: Awaited<ReturnType<typeof quoteRenewalRequest>>;
    try {
      quoted = await quoteRenewalRequest(c);
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(c, error.status, ErrorCodes.INTERNAL_ERROR, error.message, error.details);
      }
      throw error;
    }

    const paymentInfo = getPaymentInfo(c);
    if (!paymentInfo) {
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'payment info missing');
    }

    if (paymentInfo.amount !== quoted.quote.totalAtomic) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'Lease renewal payment amount no longer matches the exact quoted price.');
    }

    try {
      await getLeaseService().renewLease({
        resourceId: quoted.resourceId,
        leaseId: quoted.leaseId,
        payerAddress: paymentInfo.payer,
        durationDays: quoted.days,
        amountPaid: paymentInfo.amount,
        txHash: paymentInfo.txHash,
      });
    } catch (error) {
      const httpError = leaseErrorToHttpError(error);
      return errorResponse(c, httpError.status, ErrorCodes.INTERNAL_ERROR, httpError.message, httpError.details);
    }

    const status = await getLeaseService().getLeaseStatus(
      quoted.resourceId,
      quoted.leaseId,
      paymentInfo.payer,
    );
    if (!status) {
      return c.json({
        message: 'Lease renewed successfully',
        leaseId: quoted.leaseId,
      });
    }

    return c.json({
      ...status,
      message: 'Lease renewed successfully',
    });
  }

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
