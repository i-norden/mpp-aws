/**
 * Owner self-service handlers.
 * TypeScript port of mmp-compute/lambda-proxy/internal/api/handlers_owner.go
 *
 * Endpoints:
 *   GET    /functions/:name/details         - full function spec with analytics
 *   PATCH  /functions/:name                 - update metadata, pricing, auth, etc.
 *   POST   /functions/:name/disable         - disable a function
 *   POST   /functions/:name/enable          - enable a function
 *   POST   /functions/:name/transfer        - initiate ownership transfer
 *   POST   /functions/:name/transfer/accept - accept pending transfer
 *   DELETE /functions/:name/transfer        - cancel pending transfer
 *   POST   /functions/:name/access          - grant/revoke access list entries
 *   GET    /functions/:name/access          - list access list entries
 *
 * All endpoints require EIP-191 signature auth proving the caller is the
 * function owner (except transfer/accept which verifies the new owner).
 */

import type { Context } from 'hono';
import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, LambdaFunctionTable } from '../../db/types.js';
import type { Config } from '../../config/index.js';
import type { PricingEngine } from '../../pricing/engine.js';
import type { OFACChecker } from '../../ofac/checker.js';
import { verifyAddressOwnershipWithReplay } from '../../auth/signature.js';
import { validateEthAddress } from '../../validation/index.js';
import {
  getAccessList,
  addToAccessList,
  removeFromAccessList,
  AccessListFullError,
} from '../../db/store-access.js';
import {
  validate as validateEndpointAuth,
  encrypt as encryptEndpointAuth,
  type EndpointAuth,
} from '../../endpoint-auth/index.js';
import * as log from '../../logging/index.js';
import { jsonWithStatus } from '../response.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LambdaFunction = Selectable<LambdaFunctionTable>;

export interface OwnerDeps {
  db: Kysely<Database> | null;
  config: Config;
  pricingEngine: PricingEngine;
  ofacChecker?: OFACChecker | null;
}

/** Request body for PATCH /functions/:name. All fields are optional. */
interface OwnerUpdateRequest {
  description?: string;
  tags?: string[];
  inputSchema?: unknown;
  outputSchema?: unknown;
  examples?: unknown;
  version?: string;
  author?: string;
  documentationUrl?: string;
  openApiSpecUrl?: string;
  customCostPerRequest?: number;
  pricingModel?: string;
  payToAddress?: string;
  visibility?: string;
  auth?: EndpointAuth;
  removeAuth?: boolean;
}

/** Request body for POST /functions/:name/transfer. */
interface TransferRequest {
  newOwnerAddress: string;
}

/** Request body for POST /functions/:name/access. */
interface ManageAccessRequest {
  grant?: string[];
  revoke?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Matches Go's safeFunctionNamePattern. */
const SAFE_FUNCTION_NAME_RE = /^[a-zA-Z0-9_-]{1,170}$/;

function normalizeFunctionName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (!SAFE_FUNCTION_NAME_RE.test(trimmed)) return '';
  return trimmed.toLowerCase();
}

/**
 * Format atomic USDC (6 decimals) as a USD string.
 */
function formatUSD(atomicAmount: bigint): string {
  const dollars = Number(atomicAmount) / 1_000_000;
  if (Math.abs(dollars) < 0.01) {
    return `$${dollars.toFixed(4)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

/**
 * Verify that the request is authenticated by the given address.
 * Returns true if valid, false if invalid (error response already set on c).
 */
async function verifyOwnership(
  c: Context,
  db: Kysely<Database>,
  address: string,
): Promise<boolean> {
  const signature = c.req.header('X-Signature') ?? '';
  const message = c.req.header('X-Message') ?? '';

  if (!signature || !message) {
    c.res = c.json({
      error: 'authentication required',
      message: 'X-Signature and X-Message headers are required',
      hint: "Sign a message in format 'open-compute:{address}:{timestamp}:{nonce}' with your wallet",
    }, 401);
    return false;
  }

  const result = await verifyAddressOwnershipWithReplay(db, signature, message, address);
  if (!result.valid) {
    c.res = jsonWithStatus(c, {
      error: 'authentication failed',
      message: result.errorMessage,
    }, result.statusCode ?? 401);
    return false;
  }

  return true;
}

/**
 * Look up a function by name (including disabled), verify the caller is the
 * owner via EIP-191 signature.
 * Returns the function on success, null on failure (response already sent).
 */
async function verifyFunctionOwnership(
  c: Context,
  db: Kysely<Database>,
): Promise<LambdaFunction | null> {
  const rawName = c.req.param('name') ?? '';
  const functionName = normalizeFunctionName(rawName);
  if (!functionName) {
    c.res = c.json({ error: 'function name is required' }, 400);
    return null;
  }

  let fn: LambdaFunction | undefined;
  try {
    fn = await db
      .selectFrom('lambda_functions')
      .selectAll()
      .where('function_name', '=', functionName)
      .executeTakeFirst();
  } catch (err) {
    log.error('failed to get function by name', {
      function: functionName,
      error: err instanceof Error ? err.message : String(err),
    });
    c.res = c.json({ error: 'failed to look up function' }, 500);
    return null;
  }

  if (!fn) {
    c.res = c.json({ error: 'function not found' }, 404);
    return null;
  }

  if (!fn.owner_address) {
    c.res = c.json({ error: 'function has no owner' }, 403);
    return null;
  }

  if (!(await verifyOwnership(c, db, fn.owner_address))) {
    return null;
  }

  return fn;
}

/**
 * Convert a database function record to a simple spec for the response.
 */
function dbFunctionToSpec(fn: LambdaFunction, pricingEngine: PricingEngine) {
  let cost = pricingEngine.calculateInvocationCost(fn.memory_mb, fn.estimated_duration_ms);
  if (fn.custom_base_fee !== null && fn.custom_base_fee !== undefined) {
    cost = BigInt(fn.custom_base_fee);
  }

  const pricingModel = fn.pricing_model || 'fixed';

  const spec: Record<string, unknown> = {
    name: fn.function_name,
    arn: fn.function_arn,
    memoryMB: fn.memory_mb,
    timeoutSeconds: fn.timeout_seconds,
    tags: fn.tags?.length ? fn.tags : undefined,
    pricingModel,
    description: fn.description ?? '',
    cost: {
      estimated: formatUSD(cost),
      atomicUsdc: Number(cost),
      paymentAsset: 'USDC',
      paymentMethod: 'mpp',
      pricingModel,
    },
  };

  if (fn.version) spec.version = fn.version;
  if (fn.author) spec.author = fn.author;
  if (fn.documentation_url) spec.documentationUrl = fn.documentation_url;
  if (fn.open_api_spec_url) spec.openApiSpecUrl = fn.open_api_spec_url;
  if (fn.owner_address) spec.ownerAddress = fn.owner_address;
  if (fn.visibility) spec.visibility = fn.visibility;
  if (fn.pay_to_address) spec.payToAddress = fn.pay_to_address;
  if (fn.endpoint_auth_encrypted) spec.hasAuth = true;
  if (fn.auth_type) spec.authType = fn.auth_type;
  if (fn.input_schema) spec.inputSchema = fn.input_schema;
  if (fn.output_schema) spec.outputSchema = fn.output_schema;
  if (fn.examples) {
    try {
      const examples = typeof fn.examples === 'string'
        ? JSON.parse(fn.examples as string)
        : fn.examples;
      if (Array.isArray(examples) && examples.length > 0) {
        spec.examples = examples;
      }
    } catch {
      // Ignore malformed examples
    }
  }

  return spec;
}

// ---------------------------------------------------------------------------
// createOwnerHandlers
// ---------------------------------------------------------------------------

export function createOwnerHandlers(deps: OwnerDeps) {
  const { db, config, pricingEngine, ofacChecker } = deps;

  // -------------------------------------------------------------------
  // handleOwnerGetFunction -- GET /functions/:name/details
  // -------------------------------------------------------------------

  async function handleOwnerGetFunction(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    const fn = await verifyFunctionOwnership(c, db);
    if (!fn) {
      return c.res;
    }

    const spec = dbFunctionToSpec(fn, pricingEngine);

    const resp: Record<string, unknown> = {
      function: spec,
      enabled: fn.enabled,
      createdAt: new Date(fn.created_at).toISOString(),
      updatedAt: new Date(fn.updated_at).toISOString(),
    };

    // Include analytics (best-effort)
    try {
      const stats = await db
        .selectFrom('lambda_invocations')
        .select([
          sql<bigint>`COUNT(*)`.as('total_invocations'),
          sql<bigint>`COUNT(*) FILTER (WHERE success = true)`.as('successful'),
          sql<bigint>`COUNT(*) FILTER (WHERE success = false)`.as('failed'),
          sql<bigint>`COALESCE(SUM(amount_paid), 0)`.as('total_revenue'),
          sql<number>`COALESCE(AVG(NULLIF(duration_ms, 0)), 0)`.as('avg_duration_ms'),
          sql<bigint>`COUNT(DISTINCT payer_address)`.as('unique_payers'),
        ])
        .where('function_name', '=', fn.function_name)
        .executeTakeFirst();

      if (stats && Number(stats.total_invocations) > 0) {
        resp.analytics = {
          totalInvocations: Number(stats.total_invocations),
          successful: Number(stats.successful),
          failed: Number(stats.failed),
          totalRevenue: Number(stats.total_revenue),
          totalRevenueUSD: formatUSD(BigInt(stats.total_revenue)),
          avgDurationMs: Math.round(Number(stats.avg_duration_ms)),
          uniquePayers: Number(stats.unique_payers),
        };
      }
    } catch (err) {
      log.warn('failed to get function analytics for owner view', {
        function: fn.function_name,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return c.json(resp);
  }

  // -------------------------------------------------------------------
  // handleOwnerUpdateFunction -- PATCH /functions/:name
  // -------------------------------------------------------------------

  async function handleOwnerUpdateFunction(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    const fn = await verifyFunctionOwnership(c, db);
    if (!fn) {
      return c.res;
    }

    let req: OwnerUpdateRequest;
    try {
      req = await c.req.json() as OwnerUpdateRequest;
    } catch {
      return c.json({ error: 'invalid request body' }, 400);
    }

    // Build dynamic SET clause
    const updates: Record<string, unknown> = {};
    const changedFields: string[] = [];

    if (req.description !== undefined) {
      if (!req.description.trim()) {
        return c.json({ error: 'description cannot be empty' }, 400);
      }
      updates.description = req.description;
      changedFields.push('description');
    }

    if (req.tags !== undefined) {
      updates.tags = req.tags;
      changedFields.push('tags');
    }

    if (req.inputSchema !== undefined) {
      updates.input_schema = req.inputSchema;
      changedFields.push('inputSchema');
    }

    if (req.outputSchema !== undefined) {
      updates.output_schema = req.outputSchema;
      changedFields.push('outputSchema');
    }

    if (req.examples !== undefined) {
      updates.examples = req.examples;
      changedFields.push('examples');
    }

    if (req.version !== undefined) {
      updates.version = req.version;
      changedFields.push('version');
    }

    if (req.author !== undefined) {
      updates.author = req.author;
      changedFields.push('author');
    }

    if (req.documentationUrl !== undefined) {
      updates.documentation_url = req.documentationUrl;
      changedFields.push('documentationUrl');
    }

    if (req.openApiSpecUrl !== undefined) {
      updates.open_api_spec_url = req.openApiSpecUrl;
      changedFields.push('openApiSpecUrl');
    }

    if (req.pricingModel !== undefined) {
      if (req.pricingModel !== 'fixed' && req.pricingModel !== 'metered') {
        return c.json({
          error: 'invalid pricing model',
          message: "pricingModel must be 'fixed' or 'metered'",
        }, 400);
      }
      updates.pricing_model = req.pricingModel;
      changedFields.push('pricingModel');
    }

    if (req.customCostPerRequest !== undefined) {
      const baseFee = pricingEngine.calculateInvocationCost(0, 0);
      const customCost = BigInt(req.customCostPerRequest);
      if (customCost < baseFee) {
        return c.json({
          error: 'custom cost too low',
          message: `customCostPerRequest must be >= ${baseFee} (base fee)`,
        }, 400);
      }
      const maxBaseFee = baseFee * 1000n;
      if (customCost > maxBaseFee) {
        return c.json({
          error: 'custom cost too high',
          message: `customCostPerRequest must be <= ${maxBaseFee} (1000x base fee)`,
        }, 400);
      }
      updates.custom_base_fee = customCost;
      changedFields.push('customCostPerRequest');
    }

    if (req.payToAddress !== undefined) {
      try {
        validateEthAddress(req.payToAddress, 'payToAddress');
      } catch (err) {
        return c.json({
          error: 'invalid payToAddress',
          message: err instanceof Error ? err.message : String(err),
        }, 400);
      }
      if (ofacChecker && ofacChecker.isBlocked(req.payToAddress)) {
        return c.json({
          error: 'address_blocked',
          message: 'This address is not permitted to use this service',
        }, 403);
      }
      updates.pay_to_address = req.payToAddress.toLowerCase();
      changedFields.push('payToAddress');
    }

    if (req.visibility !== undefined) {
      if (req.visibility !== 'public' && req.visibility !== 'private') {
        return c.json({
          error: 'invalid visibility',
          message: "visibility must be 'public' or 'private'",
        }, 400);
      }
      updates.visibility = req.visibility;
      changedFields.push('visibility');
    }

    // Handle auth update (mirrors Go HandleOwnerUpdateFunction auth handling)
    if (req.removeAuth) {
      updates.endpoint_auth_encrypted = null;
      updates.auth_type = null;
      changedFields.push('removeAuth');
    } else if (req.auth !== undefined) {
      if (!config.endpointAuthKey) {
        return c.json({
          error: 'endpoint auth encryption not configured',
          message: 'ENDPOINT_AUTH_KEY must be set to update endpoint authentication',
        }, 400);
      }
      try {
        validateEndpointAuth(req.auth);
      } catch (err) {
        return c.json({
          error: 'invalid auth configuration',
          message: err instanceof Error ? err.message : String(err),
        }, 400);
      }
      try {
        const encrypted = encryptEndpointAuth(req.auth, config.endpointAuthKey);
        updates.endpoint_auth_encrypted = encrypted;
        updates.auth_type = req.auth.type;
        changedFields.push('auth');
      } catch (err) {
        log.error('failed to encrypt endpoint auth', {
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: 'failed to encrypt auth credentials' }, 500);
      }
    }

    if (changedFields.length === 0) {
      return c.json({ error: 'no fields to update' }, 400);
    }

    // Always update the timestamp
    updates.updated_at = sql`NOW()`;

    try {
      await db
        .updateTable('lambda_functions')
        .set(updates)
        .where('function_name', '=', fn.function_name)
        .execute();
    } catch (err) {
      log.error('failed to update function', {
        function: fn.function_name,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to update function' }, 500);
    }

    return c.json({
      message: 'function updated',
      functionName: fn.function_name,
      changedFields,
    });
  }

  // -------------------------------------------------------------------
  // handleOwnerDisableFunction -- POST /functions/:name/disable
  // -------------------------------------------------------------------

  async function handleOwnerDisableFunction(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    const fn = await verifyFunctionOwnership(c, db);
    if (!fn) {
      return c.res;
    }

    if (!fn.enabled) {
      return c.json({ error: 'function is already disabled' }, 400);
    }

    try {
      await db
        .updateTable('lambda_functions')
        .set({ enabled: false, updated_at: sql`NOW()` })
        .where('function_name', '=', fn.function_name)
        .execute();
    } catch (err) {
      log.error('failed to disable function', {
        function: fn.function_name,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to disable function' }, 500);
    }

    return c.json({
      message: 'function disabled',
      functionName: fn.function_name,
    });
  }

  // -------------------------------------------------------------------
  // handleOwnerEnableFunction -- POST /functions/:name/enable
  // -------------------------------------------------------------------

  async function handleOwnerEnableFunction(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    const fn = await verifyFunctionOwnership(c, db);
    if (!fn) {
      return c.res;
    }

    if (fn.enabled) {
      return c.json({ error: 'function is already enabled' }, 400);
    }

    try {
      await db
        .updateTable('lambda_functions')
        .set({ enabled: true, updated_at: sql`NOW()` })
        .where('function_name', '=', fn.function_name)
        .execute();
    } catch (err) {
      log.error('failed to enable function', {
        function: fn.function_name,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to enable function' }, 500);
    }

    return c.json({
      message: 'function enabled',
      functionName: fn.function_name,
    });
  }

  // -------------------------------------------------------------------
  // handleOwnerTransferRequest -- POST /functions/:name/transfer
  // -------------------------------------------------------------------

  async function handleOwnerTransferRequest(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    const fn = await verifyFunctionOwnership(c, db);
    if (!fn) {
      return c.res;
    }

    let req: TransferRequest;
    try {
      req = await c.req.json() as TransferRequest;
    } catch {
      return c.json({ error: 'newOwnerAddress is required' }, 400);
    }

    if (!req.newOwnerAddress) {
      return c.json({ error: 'newOwnerAddress is required' }, 400);
    }

    try {
      validateEthAddress(req.newOwnerAddress, 'newOwnerAddress');
    } catch (err) {
      return c.json({
        error: 'invalid newOwnerAddress',
        message: err instanceof Error ? err.message : String(err),
      }, 400);
    }

    const newOwner = req.newOwnerAddress.toLowerCase();

    // Cannot transfer to self
    if (newOwner === fn.owner_address!.toLowerCase()) {
      return c.json({ error: 'cannot transfer to yourself' }, 400);
    }

    // OFAC check on new owner
    if (ofacChecker && ofacChecker.isBlocked(newOwner)) {
      return c.json({
        error: 'address_blocked',
        message: 'This address is not permitted to use this service',
      }, 403);
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    try {
      // Cancel any existing pending transfer, then insert new one
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('ownership_transfer_requests')
          .set({ status: 'cancelled', updated_at: sql`NOW()` })
          .where('function_name', '=', fn.function_name)
          .where('status', '=', 'pending')
          .execute();

        await trx
          .insertInto('ownership_transfer_requests')
          .values({
            function_name: fn.function_name,
            current_owner: fn.owner_address!,
            new_owner: newOwner,
            status: 'pending',
            expires_at: expiresAt.toISOString(),
          })
          .execute();
      });
    } catch (err) {
      log.error('failed to create transfer request', {
        function: fn.function_name,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to create transfer request' }, 500);
    }

    return c.json({
      message: 'transfer request created',
      functionName: fn.function_name,
      newOwner,
      expiresAt: expiresAt.toISOString(),
    });
  }

  // -------------------------------------------------------------------
  // handleOwnerTransferAccept -- POST /functions/:name/transfer/accept
  // -------------------------------------------------------------------

  async function handleOwnerTransferAccept(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    const rawName = c.req.param('name') ?? '';
    const functionName = normalizeFunctionName(rawName);
    if (!functionName) {
      return c.json({ error: 'function name is required' }, 400);
    }

    // Look up pending transfer
    let transfer;
    try {
      transfer = await db
        .selectFrom('ownership_transfer_requests')
        .selectAll()
        .where('function_name', '=', functionName)
        .where('status', '=', 'pending')
        .where('expires_at', '>', sql<Date>`NOW()`)
        .executeTakeFirst();
    } catch (err) {
      log.error('failed to get transfer request', {
        function: functionName,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to look up transfer request' }, 500);
    }

    if (!transfer) {
      return c.json({ error: 'no pending transfer request found' }, 404);
    }

    // Check expiry
    if (new Date() > new Date(transfer.expires_at)) {
      return c.json({ error: 'transfer request has expired' }, 410);
    }

    // Verify caller is the new owner
    if (!(await verifyOwnership(c, db, transfer.new_owner))) {
      return c.res;
    }

    // OFAC re-check on new owner
    if (ofacChecker && ofacChecker.isBlocked(transfer.new_owner)) {
      return c.json({
        error: 'address_blocked',
        message: 'This address is not permitted to use this service',
      }, 403);
    }

    // Execute the transfer atomically
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('lambda_functions')
          .set({ owner_address: transfer.new_owner, updated_at: sql`NOW()` })
          .where('function_name', '=', functionName)
          .execute();

        await trx
          .updateTable('ownership_transfer_requests')
          .set({ status: 'accepted', updated_at: sql`NOW()` })
          .where('function_name', '=', functionName)
          .where('status', '=', 'pending')
          .execute();
      });
    } catch (err) {
      log.error('failed to execute ownership transfer', {
        function: functionName,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to execute transfer' }, 500);
    }

    return c.json({
      message: 'ownership transferred',
      functionName,
      previousOwner: transfer.current_owner,
      newOwner: transfer.new_owner,
    });
  }

  // -------------------------------------------------------------------
  // handleOwnerCancelTransfer -- DELETE /functions/:name/transfer
  // -------------------------------------------------------------------

  async function handleOwnerCancelTransfer(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    const fn = await verifyFunctionOwnership(c, db);
    if (!fn) {
      return c.res;
    }

    try {
      await db
        .updateTable('ownership_transfer_requests')
        .set({ status: 'cancelled', updated_at: sql`NOW()` })
        .where('function_name', '=', fn.function_name)
        .where('status', '=', 'pending')
        .execute();
    } catch (err) {
      log.error('failed to cancel transfer request', {
        function: fn.function_name,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to cancel transfer request' }, 500);
    }

    return c.json({
      message: 'transfer request cancelled',
      functionName: fn.function_name,
    });
  }

  // -------------------------------------------------------------------
  // handleManageAccess -- POST /functions/:name/access
  // -------------------------------------------------------------------

  async function handleManageAccess(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    const rawName = c.req.param('name') ?? '';
    const functionName = normalizeFunctionName(rawName);
    if (!functionName) {
      return c.json({ error: 'function name is required' }, 400);
    }

    // Get the function to verify ownership
    let fn: LambdaFunction | undefined;
    try {
      fn = await db
        .selectFrom('lambda_functions')
        .selectAll()
        .where('function_name', '=', functionName)
        .executeTakeFirst();
    } catch {
      return c.json({ error: 'function not found' }, 404);
    }

    if (!fn) {
      return c.json({ error: 'function not found' }, 404);
    }

    if (!fn.owner_address) {
      return c.json({ error: 'function has no owner' }, 403);
    }

    // Verify caller is owner
    if (!(await verifyOwnership(c, db, fn.owner_address))) {
      return c.res;
    }

    let req: ManageAccessRequest;
    try {
      req = await c.req.json() as ManageAccessRequest;
    } catch {
      return c.json({ error: 'invalid request body' }, 400);
    }

    // Process grants atomically (count check + insert in a single transaction)
    if (req.grant && req.grant.length > 0) {
      const entries: Array<{ invokerAddress: string; grantedBy: string }> = [];
      for (const addr of req.grant) {
        const trimmed = addr.trim().toLowerCase();
        if (!trimmed) continue;
        entries.push({
          invokerAddress: trimmed,
          grantedBy: fn.owner_address,
        });
      }

      if (entries.length > 0) {
        try {
          await addToAccessList(db, functionName, entries, config.maxAccessListSize);
        } catch (err) {
          if (err instanceof AccessListFullError) {
            return c.json({
              error: 'access list too large',
              message: `maximum ${config.maxAccessListSize} addresses allowed (currently ${err.currentCount})`,
            }, 400);
          }
          log.error('failed to grant access batch', {
            function: functionName,
            error: err instanceof Error ? err.message : String(err),
          });
          return c.json({ error: 'failed to grant access' }, 500);
        }
      }
    }

    // Process revocations
    if (req.revoke && req.revoke.length > 0) {
      const addresses = req.revoke
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a !== '');

      try {
        await removeFromAccessList(db, functionName, addresses);
      } catch (err) {
        log.warn('failed to revoke access', {
          function: functionName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Return updated access list
    try {
      const entries = await getAccessList(db, functionName);

      const apiEntries = entries.map((e) => ({
        invokerAddress: e.invoker_address,
        grantedBy: e.granted_by,
        createdAt: new Date(e.created_at).toISOString(),
      }));

      return c.json({
        functionName,
        entries: apiEntries,
        count: apiEntries.length,
      });
    } catch (err) {
      log.error('failed to list access list', {
        function: functionName,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to list access list' }, 500);
    }
  }

  // -------------------------------------------------------------------
  // handleGetAccess -- GET /functions/:name/access
  // -------------------------------------------------------------------

  async function handleGetAccess(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    const rawName = c.req.param('name') ?? '';
    const functionName = normalizeFunctionName(rawName);
    if (!functionName) {
      return c.json({ error: 'function name is required' }, 400);
    }

    // Get the function to verify ownership
    let fn: LambdaFunction | undefined;
    try {
      fn = await db
        .selectFrom('lambda_functions')
        .selectAll()
        .where('function_name', '=', functionName)
        .executeTakeFirst();
    } catch {
      return c.json({ error: 'function not found' }, 404);
    }

    if (!fn) {
      return c.json({ error: 'function not found' }, 404);
    }

    if (!fn.owner_address) {
      return c.json({ error: 'function has no owner' }, 403);
    }

    // Verify caller is owner
    if (!(await verifyOwnership(c, db, fn.owner_address))) {
      return c.res;
    }

    try {
      const entries = await getAccessList(db, functionName);

      const apiEntries = entries.map((e) => ({
        invokerAddress: e.invoker_address,
        grantedBy: e.granted_by,
        createdAt: new Date(e.created_at).toISOString(),
      }));

      return c.json({
        functionName,
        entries: apiEntries,
        count: apiEntries.length,
      });
    } catch (err) {
      log.error('failed to list access list', {
        function: functionName,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to list access list' }, 500);
    }
  }

  return {
    handleOwnerGetFunction,
    handleOwnerUpdateFunction,
    handleOwnerDisableFunction,
    handleOwnerEnableFunction,
    handleOwnerTransferRequest,
    handleOwnerTransferAccept,
    handleOwnerCancelTransfer,
    handleManageAccess,
    handleGetAccess,
  };
}
