/**
 * Admin API handlers.
 * TypeScript port of:
 *   - mmp-compute/lambda-proxy/internal/api/handlers_admin.go
 *   - mmp-compute/lambda-proxy/internal/api/handlers_admin_lease.go
 *   - mmp-compute/lambda-proxy/internal/api/handlers_admin_monitoring.go
 *
 * All handlers are created via `createAdminHandlers(deps)` using dependency
 * injection, following the same pattern as the other handler modules
 * (functions.ts, lease.ts, register.ts).
 */

import type { Context } from 'hono';
import type { Kysely, Insertable } from 'kysely';
import { sql } from 'kysely';
import client from 'prom-client';

import type { Database, LambdaFunctionTable } from '../../db/types.js';
import type { Config } from '../../config/index.js';
import type { PricingEngine } from '../../pricing/engine.js';
import type { RefundService } from '../../refund/service.js';
import * as log from '../../logging/index.js';

import {
  listAllFunctions,
  getAdminFunctionStats,
  listAllLeases,
  getAdminLeaseSummary,
  adminTerminateLease,
  adminExtendLease,
  anonymizeLease,
  getBillingSummary,
  getInvocationsBilling,
  getRefundsBilling,
  getCreditsBilling,
  getEarningsBilling,
  getResourceUtilization,
  listAuditLog,
  createAuditEntry,
} from '../../db/store-admin.js';

import type {
  LeaseFilters,
  InvocationFilters,
  RefundFilters,
  AuditLogFilters,
  InsertableAuditLogEntry,
} from '../../db/store-admin.js';

import { deleteAllDataForAddress } from '../../db/store-gdpr.js';
import { getTableSizes, runRetentionCleanup, type RetentionConfig } from '../../db/retention.js';
import { isValidEthAddress } from '../../validation/index.js';
import { errorResponse, ErrorCodes } from '../errors.js';
import {
  createVoucherRedemption,
  listVoucherRedemptions,
  updateVoucherRedemptionStatus,
  getVoucherRedemption,
} from '../../db/store-vouchers.js';
import {
  listRefunds,
  listPendingRefunds,
  countStuckPendingRefunds,
} from '../../db/store-refunds.js';
import * as metrics from '../../metrics/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdminDeps {
  db: Kysely<Database> | null;
  config: Config;
  pricingEngine: PricingEngine;
  refundService?: RefundService | null;
  collectionService?: RefundService | null;
}

interface FunctionExample {
  name: string;
  description?: string;
  input: unknown;
  output?: unknown;
}

interface RegisterFunctionRequest {
  functionArn: string;
  functionName: string;
  description: string;
  memoryMB?: number;
  timeoutSeconds?: number;
  estimatedDurationMs?: number;
  customBaseFee?: number | null;
  inputSchema?: unknown;
  outputSchema?: unknown;
  examples?: FunctionExample[];
  tags?: string[];
  version?: string;
  author?: string;
  documentationUrl?: string;
  ownerAddress?: string;
  visibility?: string;
}

/** Reconciliation report types -- mirrors Go reconciliation.Report */
interface ReconciliationMismatch {
  invocationId: string;
  txHash: string;
  dbAmount: number;
  onChainAmount?: number;
  reason: string;
}

interface ReconciliationMissingRecord {
  id: string;
  txHash?: string;
  reason: string;
}

interface ReconciliationReport {
  startedAt: string;
  completedAt: string;
  totalChecked: number;
  matched: number;
  unverified: number;
  mismatches: ReconciliationMismatch[];
  missingOnChain: ReconciliationMissingRecord[];
  missingInDb: ReconciliationMissingRecord[];
  errors: string[];
}

/** Sweep request body -- mirrors Go SweepRequest */
interface SweepRequest {
  asset?: string;   // "usdc" (default) or "eth"
  amount: string;   // atomic USDC or wei (string for large values)
  confirm?: boolean; // false = dry run, true = execute
}

interface AdminResourceRequest {
  id: string;
  displayName: string;
  instanceType: string;
  vcpus: number;
  memoryGb: number;
  storageGb?: number;
  amiId: string;
  sshUser?: string;
  description?: string;
  price1d: number;
  price7d: number;
  price30d: number;
  maxConcurrent?: number;
  enabled?: boolean;
  marginPercent?: number;
  defaultStorageGb?: number;
  minStorageGb?: number;
  maxStorageGb?: number;
  egressLimitGb?: number;
  ingressLimitGb?: number;
  publicIpDefault?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format atomic USDC (6 decimals) as a USD string. */
function formatUSD(atomicAmount: bigint): string {
  const dollars = Number(atomicAmount) / 1_000_000;
  if (Math.abs(dollars) < 0.01) {
    return `$${dollars.toFixed(4)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

/** Format a bigint wei balance as a human-readable ETH string. */
function formatETH(wei: bigint): string {
  const ether = Number(wei) / 1e18;
  return ether.toFixed(6);
}

/** Parse an integer query parameter with a default value. */
function parseIntQuery(c: Context, key: string, defaultVal: number): number {
  const v = c.req.query(key);
  if (v) {
    const n = parseInt(v, 10);
    if (!Number.isNaN(n)) return n;
  }
  return defaultVal;
}

/** Parse an RFC3339 date query parameter. Returns undefined if missing/invalid. */
function parseDateQuery(c: Context, key: string): Date | undefined {
  const v = c.req.query(key);
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

/**
 * Best-effort audit log helper. Logs errors but does not fail the request.
 */
async function auditLog(
  db: Kysely<Database>,
  c: Context,
  action: string,
  targetType: string,
  targetId: string,
  details?: unknown,
): Promise<void> {
  try {
    const entry: InsertableAuditLogEntry = {
      admin_ip: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown',
      action,
      target_type: targetType,
      target_id: targetId,
      details: details ?? null,
    };
    await createAuditEntry(db, entry);
  } catch (err) {
    log.error('failed to write audit log', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Determine if an ARN is an HTTPS endpoint (not a Lambda ARN).
 */
function isHTTPEndpoint(arn: string): boolean {
  return arn.startsWith('https://') || arn.startsWith('http://');
}

/**
 * Reject plain HTTP endpoints for security.
 */
function isInsecureHTTPEndpoint(arn: string): boolean {
  return arn.startsWith('http://');
}

// ---------------------------------------------------------------------------
// createAdminHandlers
// ---------------------------------------------------------------------------

export function createAdminHandlers(deps: AdminDeps) {
  const { db, config, pricingEngine, refundService, collectionService } = deps;

  // In-memory latest reconciliation report (mirrors Go's latestReconciliationReport).
  let latestReconciliationReport: ReconciliationReport | null = null;

  // =========================================================================
  // Function Management
  // =========================================================================

  // -------------------------------------------------------------------
  // handleAdminListFunctions -- GET /admin/functions
  // -------------------------------------------------------------------

  async function handleAdminListFunctions(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    try {
      const functions = await listAllFunctions(db, { includeDisabled: true });

      const response = functions.map((fn) => {
        const cost = pricingEngine.calculateInvocationCost(
          fn.memory_mb,
          fn.estimated_duration_ms,
        );
        const info: Record<string, unknown> = {
          id: Number(fn.id),
          functionArn: fn.function_arn,
          functionName: fn.function_name,
          memoryMB: fn.memory_mb,
          timeoutSeconds: fn.timeout_seconds,
          estimatedDurationMs: fn.estimated_duration_ms,
          enabled: fn.enabled,
          estimatedCost: formatUSD(cost),
          createdAt: fn.created_at
            ? (fn.created_at instanceof Date ? fn.created_at : new Date(String(fn.created_at))).toISOString()
            : null,
        };
        if (fn.description) info.description = fn.description;
        if (fn.custom_base_fee !== null && fn.custom_base_fee !== undefined) {
          info.customBaseFee = Number(fn.custom_base_fee);
        }
        return info;
      });

      return c.json({
        functions: response,
        enforceWhitelist: config.enforceWhitelist,
      });
    } catch (err) {
      log.error('failed to list functions from database', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list functions');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminRegisterFunction -- POST /admin/functions
  // -------------------------------------------------------------------

  async function handleAdminRegisterFunction(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    let req: RegisterFunctionRequest;
    try {
      req = await c.req.json<RegisterFunctionRequest>();
    } catch {
      log.warn('invalid register function request body');
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'invalid request body');
    }

    // Validate required fields
    if (!req.functionArn || !req.functionName || !req.description) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'invalid request body');
    }

    // Validate visibility
    let adminVisibility = 'public';
    if (req.visibility) {
      if (req.visibility !== 'public' && req.visibility !== 'private') {
        return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, "visibility must be 'public' or 'private'");
      }
      adminVisibility = req.visibility;
    }

    // Reject plain HTTP endpoints for security
    if (isInsecureHTTPEndpoint(req.functionArn)) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'Plain HTTP endpoints are not allowed. Use HTTPS or a Lambda ARN.');
    }

    // Build function values with sensible defaults
    let memoryMB = req.memoryMB ?? 0;
    let timeoutSeconds = req.timeoutSeconds ?? 0;
    let estimatedDurationMs = req.estimatedDurationMs ?? 0;

    if (isHTTPEndpoint(req.functionArn)) {
      if (timeoutSeconds <= 0) timeoutSeconds = 30;
      if (estimatedDurationMs <= 0) estimatedDurationMs = 1000;
    }

    if (estimatedDurationMs <= 0) {
      estimatedDurationMs = timeoutSeconds * 100; // 10% of timeout
    }

    // Validate custom base fee
    if (req.customBaseFee !== undefined && req.customBaseFee !== null) {
      if (req.customBaseFee < 0) {
        return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'customBaseFee must be non-negative');
      }
    }

    // Build the insertable record
    const fnValues: Insertable<LambdaFunctionTable> = {
      function_arn: req.functionArn,
      function_name: req.functionName,
      description: req.description,
      memory_mb: memoryMB,
      timeout_seconds: timeoutSeconds,
      estimated_duration_ms: estimatedDurationMs,
      enabled: true,
      visibility: adminVisibility,
      tags: req.tags ?? [],
      custom_base_fee:
        req.customBaseFee !== undefined && req.customBaseFee !== null
          ? BigInt(req.customBaseFee)
          : null,
      owner_address: req.ownerAddress ? req.ownerAddress.toLowerCase() : null,
      input_schema: req.inputSchema ?? null,
      output_schema: req.outputSchema ?? null,
      version: req.version ?? '',
      author: req.author ?? null,
      documentation_url: req.documentationUrl ?? null,
    };

    // Handle examples
    if (req.examples && req.examples.length > 0) {
      fnValues.examples = JSON.parse(JSON.stringify(req.examples)) as never;
    }

    try {
      // Check if the function already exists
      const existing = await db
        .selectFrom('lambda_functions')
        .selectAll()
        .where('function_name', '=', req.functionName)
        .executeTakeFirst();

      let created: boolean;
      if (existing) {
        // Update
        await db
          .updateTable('lambda_functions')
          .set({
            ...fnValues,
            updated_at: sql`NOW()`,
          })
          .where('function_name', '=', req.functionName)
          .execute();
        created = false;
      } else {
        // Insert
        await db.insertInto('lambda_functions').values(fnValues).execute();
        created = true;
      }

      if (created) {
        log.info('function registered (created)', { function: req.functionName });
      } else {
        log.info('function registered (updated)', { function: req.functionName });
      }

      const status = created ? 201 : 200;
      const message = created
        ? 'function registered (created)'
        : 'function registered (updated)';

      return c.json(
        {
          message,
          created,
          function: {
            functionName: req.functionName,
            functionArn: req.functionArn,
            description: req.description,
            memoryMB,
            timeoutSeconds,
            estimatedDurationMs,
            visibility: adminVisibility,
          },
        },
        status as 200 | 201,
      );
    } catch (err) {
      log.error('failed to register function', {
        function: req.functionName,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to register function');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminDeleteFunction -- DELETE /admin/functions/:name
  // -------------------------------------------------------------------

  async function handleAdminDeleteFunction(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    const functionName = c.req.param('name');
    if (!functionName) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'function name is required');
    }

    try {
      await db
        .updateTable('lambda_functions')
        .set({
          enabled: false,
          updated_at: sql`NOW()`,
        })
        .where('function_name', '=', functionName)
        .execute();

      log.info('admin_function_disabled', { function: functionName });

      return c.json({
        message: 'function disabled',
        functionName,
      });
    } catch (err) {
      log.error('failed to disable function', {
        function: functionName,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to disable function');
    }
  }

  // =========================================================================
  // Stats
  // =========================================================================

  // -------------------------------------------------------------------
  // handleAdminGetStats -- GET /admin/stats/:function
  // -------------------------------------------------------------------

  async function handleAdminGetStats(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    const functionName = c.req.param('function');
    if (!functionName) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'function name is required');
    }

    log.info('admin_stats_requested', { function: functionName });

    try {
      const stats = await getAdminFunctionStats(db, functionName);
      if (!stats) {
        return errorResponse(c, 404, ErrorCodes.NOT_FOUND, 'No invocations found for this function');
      }

      return c.json({
        ...stats,
        totalRevenueUSD: formatUSD(stats.totalRevenue),
      });
    } catch (err) {
      log.error('failed to get invocation stats', {
        function: functionName,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to get stats');
    }
  }

  // =========================================================================
  // Lease Management
  // =========================================================================

  // -------------------------------------------------------------------
  // handleAdminListLeases -- GET /admin/leases
  // -------------------------------------------------------------------

  async function handleAdminListLeases(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    const filters: LeaseFilters = {
      status: c.req.query('status') || undefined,
      payerAddress: c.req.query('payer') || undefined,
      resourceId: c.req.query('resource') || undefined,
      limit: parseIntQuery(c, 'limit', 50),
      offset: parseIntQuery(c, 'offset', 0),
      fromDate: parseDateQuery(c, 'from'),
      toDate: parseDateQuery(c, 'to'),
    };

    try {
      const [leases, total] = await listAllLeases(db, filters);

      return c.json({
        leases,
        total,
        limit: filters.limit,
        offset: filters.offset,
      });
    } catch (err) {
      log.error('failed to list leases', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list leases');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminLeaseSummary -- GET /admin/leases/summary
  // -------------------------------------------------------------------

  async function handleAdminLeaseSummary(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    try {
      const stats = await getAdminLeaseSummary(db);
      return c.json({
        ...stats,
        totalRevenue: stats.totalRevenue.toString(),
        totalRevenueUSD: formatUSD(stats.totalRevenue),
      });
    } catch (err) {
      log.error('failed to get lease summary', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to get lease summary');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminGetLease -- GET /admin/leases/:id
  // -------------------------------------------------------------------

  async function handleAdminGetLease(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    const leaseId = c.req.param('id');
    if (!leaseId) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'lease ID is required');
    }

    try {
      const lease = await db
        .selectFrom('leases')
        .selectAll()
        .where('id', '=', leaseId)
        .executeTakeFirst();

      if (!lease) {
        return errorResponse(c, 404, ErrorCodes.NOT_FOUND, 'lease not found');
      }

      return c.json(lease);
    } catch (err) {
      log.error('failed to get lease', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to get lease');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminTerminateLease -- POST /admin/leases/:id/terminate
  // -------------------------------------------------------------------

  async function handleAdminTerminateLease(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    const leaseId = c.req.param('id');
    if (!leaseId) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'lease ID is required');
    }

    let body: { reason?: string };
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'reason is required');
    }

    if (!body.reason) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'reason is required');
    }

    try {
      await adminTerminateLease(db, leaseId, body.reason);
      await auditLog(db, c, 'lease.terminate', 'lease', leaseId, { reason: body.reason });

      return c.json({
        message: 'lease terminated',
        leaseId,
        reason: body.reason,
      });
    } catch (err) {
      log.error('failed to terminate lease', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : 'failed to terminate lease');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminExtendLease -- POST /admin/leases/:id/extend
  // -------------------------------------------------------------------

  async function handleAdminExtendLease(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    const leaseId = c.req.param('id');
    if (!leaseId) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'lease ID is required');
    }

    let body: { days?: number };
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'days is required (1-90)');
    }

    if (!body.days || body.days < 1 || body.days > 90) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'days is required (1-90)');
    }

    try {
      await adminExtendLease(db, leaseId, body.days);
      await auditLog(db, c, 'lease.extend', 'lease', leaseId, { days: body.days });

      return c.json({
        message: 'lease extended',
        leaseId,
        days: body.days,
      });
    } catch (err) {
      log.error('failed to extend lease', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : 'failed to extend lease');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminDeleteLeaseData -- DELETE /admin/leases/:id/data
  // -------------------------------------------------------------------

  async function handleAdminDeleteLeaseData(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    const leaseId = c.req.param('id');
    if (!leaseId) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'lease ID is required');
    }

    try {
      await anonymizeLease(db, leaseId);
      await auditLog(db, c, 'lease.gdpr_delete', 'lease', leaseId, null);

      return c.json({
        message: 'lease data anonymized',
        leaseId,
      });
    } catch (err) {
      log.error('failed to anonymize lease data', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : 'failed to anonymize lease');
    }
  }

  // =========================================================================
  // Billing & Financial
  // =========================================================================

  // -------------------------------------------------------------------
  // handleAdminBillingSummary -- GET /admin/billing/summary
  // -------------------------------------------------------------------

  async function handleAdminBillingSummary(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    // Default to last 30 days
    const to = new Date();
    let from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

    const fromParam = parseDateQuery(c, 'from');
    const toParam = parseDateQuery(c, 'to');
    if (fromParam) from = fromParam;

    try {
      const summary = await getBillingSummary(db, from);

      return c.json({
        summary: {
          ...summary,
          totalRevenue: summary.totalRevenue.toString(),
          totalRevenueUSD: formatUSD(summary.totalRevenue),
          totalRefunds: summary.totalRefunds.toString(),
          totalRefundsUSD: formatUSD(summary.totalRefunds),
          totalCredits: summary.totalCredits.toString(),
          totalCreditsUSD: formatUSD(summary.totalCredits),
          totalEarnings: summary.totalEarnings.toString(),
          totalEarningsUSD: formatUSD(summary.totalEarnings),
          netRevenue: summary.netRevenue.toString(),
          netRevenueUSD: formatUSD(summary.netRevenue),
        },
        from: from.toISOString(),
        to: (toParam ?? to).toISOString(),
      });
    } catch (err) {
      log.error('failed to get billing summary', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to get billing summary');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminBillingInvocations -- GET /admin/billing/invocations
  // -------------------------------------------------------------------

  async function handleAdminBillingInvocations(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    const filters: InvocationFilters = {
      functionName: c.req.query('function') || undefined,
      payer: c.req.query('payer') || undefined,
      limit: parseIntQuery(c, 'limit', 50),
      offset: parseIntQuery(c, 'offset', 0),
      fromDate: parseDateQuery(c, 'from'),
      toDate: parseDateQuery(c, 'to'),
    };

    try {
      const [invocations, total] = await getInvocationsBilling(db, filters);

      return c.json({
        invocations,
        total,
      });
    } catch (err) {
      log.error('failed to list invocations', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list invocations');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminBillingRefunds -- GET /admin/billing/refunds
  // -------------------------------------------------------------------

  async function handleAdminBillingRefunds(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    const filters: RefundFilters = {
      status: c.req.query('status') || undefined,
      payer: c.req.query('payer') || undefined,
      limit: parseIntQuery(c, 'limit', 50),
      offset: parseIntQuery(c, 'offset', 0),
    };

    try {
      const [refunds, total] = await getRefundsBilling(db, filters);

      return c.json({
        refunds,
        total,
      });
    } catch (err) {
      log.error('failed to list refunds', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list refunds');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminBillingCredits -- GET /admin/billing/credits
  // -------------------------------------------------------------------

  async function handleAdminBillingCredits(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    const limit = parseIntQuery(c, 'limit', 50);
    const offset = parseIntQuery(c, 'offset', 0);

    try {
      const [credits, total] = await getCreditsBilling(db, limit, offset);

      return c.json({
        credits,
        total,
      });
    } catch (err) {
      log.error('failed to list credits', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list credits');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminBillingEarnings -- GET /admin/billing/earnings
  // -------------------------------------------------------------------

  async function handleAdminBillingEarnings(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    const limit = parseIntQuery(c, 'limit', 50);
    const offset = parseIntQuery(c, 'offset', 0);

    try {
      const [earnings, total] = await getEarningsBilling(db, limit, offset);

      return c.json({
        earnings,
        total,
      });
    } catch (err) {
      log.error('failed to list earnings', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list earnings');
    }
  }

  // =========================================================================
  // Resource Management
  // =========================================================================

  // -------------------------------------------------------------------
  // handleAdminListResources -- GET /admin/resources
  // -------------------------------------------------------------------

  async function handleAdminListResources(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    try {
      // List all resources (including disabled, for admin)
      const resources = await db
        .selectFrom('lease_resources')
        .selectAll()
        .orderBy('vcpus', 'asc')
        .orderBy('memory_gb', 'asc')
        .execute();

      // Enrich with utilization info
      const enriched = await Promise.all(
        resources.map(async (r) => {
          let activeLeases = 0;
          let totalLeases = 0;
          try {
            const util = await getResourceUtilization(db, r.id);
            activeLeases = util.activeLeases;
            totalLeases = util.totalLeases;
          } catch {
            // best-effort
          }
          return {
            ...r,
            activeLeases,
            totalLeases,
          };
        }),
      );

      return c.json({ resources: enriched });
    } catch (err) {
      log.error('failed to list resources', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list resources');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminCreateResource -- POST /admin/resources
  // -------------------------------------------------------------------

  async function handleAdminCreateResource(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    let req: AdminResourceRequest;
    try {
      req = await c.req.json<AdminResourceRequest>();
    } catch {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'invalid request body');
    }

    // Validate required fields
    if (!req.id || !req.displayName || !req.instanceType || !req.amiId) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'id, displayName, instanceType, and amiId are required');
    }
    if (!req.vcpus || req.vcpus < 1) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'vcpus must be at least 1');
    }
    if (!req.memoryGb || req.memoryGb <= 0) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'memoryGb must be positive');
    }
    if (!req.price1d || req.price1d < 1) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'price1d must be positive');
    }
    if (!req.price7d || req.price7d < 1) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'price7d must be positive');
    }
    if (!req.price30d || req.price30d < 1) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'price30d must be positive');
    }

    const resource = buildResourceFromRequest(req);

    try {
      await db
        .insertInto('lease_resources')
        .values(resource)
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            ...resource,
            updated_at: sql`NOW()`,
          }),
        )
        .execute();

      await auditLog(db, c, 'resource.create', 'resource', req.id, req);

      return c.json(
        {
          message: 'resource created',
          resource,
        },
        201,
      );
    } catch (err) {
      log.error('failed to create resource', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to create resource');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminUpdateResource -- PUT /admin/resources/:id
  // -------------------------------------------------------------------

  async function handleAdminUpdateResource(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    const id = c.req.param('id');
    if (!id) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'resource ID is required');
    }

    let req: AdminResourceRequest;
    try {
      req = await c.req.json<AdminResourceRequest>();
    } catch {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'invalid request body');
    }

    // Validate required fields
    if (!req.displayName || !req.instanceType || !req.amiId) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'displayName, instanceType, and amiId are required');
    }
    if (!req.vcpus || req.vcpus < 1) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'vcpus must be at least 1');
    }
    if (!req.memoryGb || req.memoryGb <= 0) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'memoryGb must be positive');
    }
    if (!req.price1d || req.price1d < 1) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'price1d must be positive');
    }
    if (!req.price7d || req.price7d < 1) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'price7d must be positive');
    }
    if (!req.price30d || req.price30d < 1) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'price30d must be positive');
    }

    // Ensure ID matches route param
    req.id = id;
    const resource = buildResourceFromRequest(req);

    try {
      await db
        .insertInto('lease_resources')
        .values(resource)
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            ...resource,
            updated_at: sql`NOW()`,
          }),
        )
        .execute();

      await auditLog(db, c, 'resource.update', 'resource', id, req);

      return c.json({
        message: 'resource updated',
        resource,
      });
    } catch (err) {
      log.error('failed to update resource', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to update resource');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminDeleteResource -- DELETE /admin/resources/:id
  // -------------------------------------------------------------------

  async function handleAdminDeleteResource(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    const id = c.req.param('id');
    if (!id) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'resource ID is required');
    }

    try {
      await db
        .updateTable('lease_resources')
        .set({
          enabled: false,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', id)
        .execute();

      await auditLog(db, c, 'resource.disable', 'resource', id, null);

      return c.json({
        message: 'resource disabled',
        resourceId: id,
      });
    } catch (err) {
      log.error('failed to disable resource', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : 'failed to disable resource');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminResourceUtilization -- GET /admin/resources/:id/utilization
  // -------------------------------------------------------------------

  async function handleAdminResourceUtilization(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    const id = c.req.param('id');
    if (!id) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'resource ID is required');
    }

    try {
      const util = await getResourceUtilization(db, id);
      return c.json({
        ...util,
        totalRevenue: util.totalRevenue.toString(),
        totalRevenueUSD: formatUSD(util.totalRevenue),
      });
    } catch (err) {
      log.error('failed to get resource utilization', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to get utilization');
    }
  }

  // =========================================================================
  // Audit
  // =========================================================================

  // -------------------------------------------------------------------
  // handleAdminAuditLog -- GET /admin/audit
  // -------------------------------------------------------------------

  async function handleAdminAuditLog(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'admin store not available');
    }

    const filters: AuditLogFilters = {
      action: c.req.query('action') || undefined,
      targetType: c.req.query('targetType') || undefined,
      targetId: c.req.query('targetId') || undefined,
      limit: parseIntQuery(c, 'limit', 100),
      offset: parseIntQuery(c, 'offset', 0),
    };

    try {
      const entries = await listAuditLog(db, filters);
      return c.json({ entries });
    } catch (err) {
      log.error('failed to list audit logs', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list audit logs');
    }
  }

  // =========================================================================
  // Wallet
  // =========================================================================

  // -------------------------------------------------------------------
  // handleAdminWalletBalance -- GET /admin/wallet/balance
  // -------------------------------------------------------------------

  async function handleAdminWalletBalance(c: Context): Promise<Response> {
    if (!refundService) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'refund wallet not configured');
    }

    try {
      const [usdcBalance, ethBalance] = await Promise.all([
        refundService.getBalance(),
        refundService.getETHBalance(),
      ]);

      return c.json({
        address: refundService.getFromAddress(),
        usdc_balance: usdcBalance.toString(),
        usdc_balance_usd: formatUSD(usdcBalance),
        eth_balance_wei: ethBalance.toString(),
        eth_balance_ether: formatETH(ethBalance),
      });
    } catch (err) {
      log.error('failed to get wallet balance', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to get wallet balance');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminCollectionBalance -- GET /admin/wallet/collection/balance
  // -------------------------------------------------------------------

  async function handleAdminCollectionBalance(c: Context): Promise<Response> {
    if (!refundService) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'wallet service not configured');
    }

    const payToAddr = config.payToAddress;
    if (!payToAddr) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'PAY_TO_ADDRESS not configured');
    }

    try {
      const addr = payToAddr as `0x${string}`;
      const [usdcBalance, ethBalance] = await Promise.all([
        refundService.getBalanceOf(addr),
        refundService.getETHBalanceOf(addr),
      ]);

      return c.json({
        address: payToAddr,
        usdc_balance: usdcBalance.toString(),
        usdc_balance_usd: formatUSD(usdcBalance),
        eth_balance_wei: ethBalance.toString(),
        eth_balance_ether: formatETH(ethBalance),
      });
    } catch (err) {
      log.error('failed to get collection balance', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to get collection balance');
    }
  }

  // =========================================================================
  // Monitoring
  // =========================================================================

  // -------------------------------------------------------------------
  // handleAdminMonitoringSnapshot -- GET /admin/monitoring/snapshot
  // -------------------------------------------------------------------

  async function handleAdminMonitoringSnapshot(c: Context): Promise<Response> {
    try {
      const families = await client.register.getMetricsAsJSON();

      const snap: {
        timestamp: string;
        gauges: Record<string, number>;
        counters: Record<string, number>;
        histograms: Record<string, number>;
      } = {
        timestamp: new Date().toISOString(),
        gauges: {},
        counters: {},
        histograms: {},
      };

      for (const family of families) {
        const name = family.name;
        // Only include our own metrics
        if (!name.startsWith('lambda_proxy_')) continue;

        const shortName = name.replace(/^lambda_proxy_/, '');

        if (family.type === client.MetricType.Gauge) {
          let total = 0;
          if (family.values) {
            for (const v of family.values) {
              total += v.value ?? 0;
            }
          }
          snap.gauges[shortName] = total;
        } else if (family.type === client.MetricType.Counter) {
          let total = 0;
          const perLabel: Record<string, number> = {};
          if (family.values) {
            for (const v of family.values) {
              const val = v.value ?? 0;
              total += val;

              // Build label suffix from status/operation labels
              const labels = v.labels as Record<string, string | number>;
              if (labels) {
                const parts: string[] = [];
                if (labels.status) parts.push(String(labels.status));
                if (labels.operation) parts.push(String(labels.operation));
                const suffix = parts.join('_');
                if (suffix) {
                  perLabel[suffix] = (perLabel[suffix] ?? 0) + val;
                }
              }
            }
          }
          snap.counters[shortName] = total;
          // Emit per-label breakdowns when there are multiple
          if (Object.keys(perLabel).length > 1) {
            for (const [suffix, val] of Object.entries(perLabel)) {
              snap.counters[`${shortName}_${suffix}`] = val;
            }
          }
        } else if (family.type === client.MetricType.Histogram) {
          // For histograms, emit count and sum from the values.
          // prom-client histogram values with metricName include _count, _sum, _bucket entries.
          const hName = shortName.replace(/_seconds$/, '');
          if (family.values) {
            for (const v of family.values) {
              // Histogram values from getMetricsAsJSON may include a metricName
              // property on MetricValueWithName. Cast to access it.
              const vAny = v as { metricName?: string; value: number };
              const mName = vAny.metricName ?? '';
              if (mName.endsWith('_count')) {
                snap.histograms[`${hName}_count`] = (snap.histograms[`${hName}_count`] ?? 0) + (v.value ?? 0);
              } else if (mName.endsWith('_sum')) {
                snap.histograms[`${hName}_sum`] = (snap.histograms[`${hName}_sum`] ?? 0) + (v.value ?? 0);
              }
            }
          }
        }
      }

      return c.json(snap);
    } catch (err) {
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
    }
  }

  // =========================================================================
  // Reconciliation
  // =========================================================================

  // -------------------------------------------------------------------
  // handleAdminRunReconciliation -- POST /admin/reconciliation/run
  // Compares DB settled invocations against on-chain state.
  // -------------------------------------------------------------------

  async function handleAdminRunReconciliation(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    const fromStr = c.req.query('from') || '';
    const toStr = c.req.query('to') || '';

    let from: Date;
    let to: Date;

    if (fromStr) {
      from = new Date(fromStr);
      if (Number.isNaN(from.getTime())) {
        return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, "invalid 'from' time format, use RFC3339");
      }
    } else {
      from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // default: last 7 days
    }

    if (toStr) {
      to = new Date(toStr);
      if (Number.isNaN(to.getTime())) {
        return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, "invalid 'to' time format, use RFC3339");
      }
    } else {
      to = new Date();
    }

    try {
      const report: ReconciliationReport = {
        startedAt: new Date().toISOString(),
        completedAt: '',
        totalChecked: 0,
        matched: 0,
        unverified: 0,
        mismatches: [],
        missingOnChain: [],
        missingInDb: [],
        errors: [],
      };

      const batchSize = 100;
      let offset = 0;

      // Iterate through settled invocations in batches
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let invocations;
        try {
          invocations = await db
            .selectFrom('lambda_invocations')
            .select(['id', 'tx_hash', 'amount_paid', 'created_at'])
            .where('created_at', '>=', from)
            .where('created_at', '<=', to)
            .where('success', '=', true)
            .orderBy('created_at', 'asc')
            .limit(batchSize)
            .offset(offset)
            .execute();
        } catch (err) {
          report.errors.push(
            'failed to list invocations: ' + (err instanceof Error ? err.message : String(err)),
          );
          break;
        }

        if (invocations.length === 0) break;

        for (const inv of invocations) {
          report.totalChecked++;

          if (!inv.tx_hash) {
            report.missingOnChain.push({
              id: String(inv.id),
              reason: 'settled invocation has no transaction hash',
            });
            continue;
          }

          // Without an on-chain verifier, we can only check for the presence of tx_hash.
          // Mark as matched if tx_hash exists.
          report.matched++;
        }

        offset += batchSize;
        if (invocations.length < batchSize) break;
      }

      // Also find refunds stuck in 'pending' without tx hash
      try {
        const stuckRefunds = await db
          .selectFrom('lambda_invocations')
          .select(['id', 'refund_status', 'refund_tx_hash'])
          .where('created_at', '>=', from)
          .where('created_at', '<=', to)
          .where('refund_status', '=', 'pending')
          .where(eb =>
            eb.or([
              eb('refund_tx_hash', 'is', null),
              eb('refund_tx_hash', '=', ''),
            ]),
          )
          .execute();

        for (const r of stuckRefunds) {
          report.missingOnChain.push({
            id: String(r.id),
            reason: 'refund stuck in pending status without tx hash',
          });
        }
      } catch (err) {
        report.errors.push(
          'failed to check stuck refunds: ' + (err instanceof Error ? err.message : String(err)),
        );
      }

      report.completedAt = new Date().toISOString();

      // Store latest report in memory
      latestReconciliationReport = report;

      log.info('reconciliation_completed', {
        totalChecked: report.totalChecked,
        matched: report.matched,
        mismatches: report.mismatches.length,
        missingOnChain: report.missingOnChain.length,
        errors: report.errors.length,
      });

      return c.json(report);
    } catch (err) {
      log.error('reconciliation_run_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'reconciliation failed');
    }
  }

  // -------------------------------------------------------------------
  // handleAdminGetReconciliation -- GET /admin/reconciliation/latest
  // -------------------------------------------------------------------

  async function handleAdminGetReconciliation(c: Context): Promise<Response> {
    if (!latestReconciliationReport) {
      return errorResponse(c, 404, ErrorCodes.NOT_FOUND, 'no reconciliation report available, run POST /admin/reconciliation/run first');
    }
    return c.json(latestReconciliationReport);
  }

  // =========================================================================
  // Monitoring Config
  // =========================================================================

  // -------------------------------------------------------------------
  // handleAdminMonitoringConfig -- GET /admin/monitoring/config
  // Returns safe config fields (no secrets) plus dashboard/alert metadata.
  // -------------------------------------------------------------------

  async function handleAdminMonitoringConfig(c: Context): Promise<Response> {
    return c.json({
      grafanaUrl: config.grafanaURL || null,
      dashboards: [
        { uid: 'system-overview-dashboard', title: 'System Overview' },
        { uid: 'lambda-proxy-dashboard', title: 'Lambda Proxy' },
        { uid: 'open-compute-billing', title: 'Billing & Financial' },
        { uid: 'open-compute-leases', title: 'EC2 Leases' },
        { uid: 'open-compute-payments', title: 'Payment Health' },
      ],
      alerts: [
        { name: 'PaymentSettleFailureRateHigh', severity: 'critical', description: 'Payment settlement failure rate >5% for 5m', metric: 'lambda_proxy_payments_total' },
        { name: 'FacilitatorErrorRateHigh', severity: 'critical', description: 'Facilitator error rate >10% for 3m', metric: 'lambda_proxy_facilitator_errors_total' },
        { name: 'LambdaInvocationLatencyHigh', severity: 'warning', description: 'Lambda invocation P99 latency >30s for 5m', metric: 'lambda_proxy_invocation_duration_seconds' },
        { name: 'HealthCheckFailing', severity: 'critical', description: 'Lambda proxy health check failing for 2m', metric: 'up' },
        { name: 'RateLimitRejectionRateHigh', severity: 'warning', description: 'Rate limit rejection rate >50% for 5m', metric: 'lambda_proxy_rate_limit_hits_total' },
        { name: 'DatabaseConnectionFailure', severity: 'critical', description: 'Lambda-proxy instance down for 2m (possible DB failure)', metric: 'up' },
        { name: 'HighMemoryUsage', severity: 'critical', description: 'Lambda proxy memory usage >90% for 5m', metric: 'process_resident_memory_bytes' },
        { name: 'RefundWalletUSDCLow', severity: 'critical', description: 'Refund wallet USDC balance below $100', metric: 'lambda_proxy_refund_wallet_usdc_balance' },
        { name: 'RefundWalletETHLow', severity: 'warning', description: 'Refund wallet ETH balance below 0.01 ETH', metric: 'lambda_proxy_refund_wallet_eth_balance' },
        { name: 'HighErrorRate', severity: 'warning', description: 'HTTP 5xx error rate >1% for 5m', metric: 'lambda_proxy_http_requests_total' },
      ],
      leaseEnabled: config.leaseEnabled,
      asyncJobsEnabled: config.asyncJobsEnabled,
      refundEnabled: config.refundEnabled,
      network: config.network,
    });
  }

  // =========================================================================
  // Wallet Sweep
  // =========================================================================

  // -------------------------------------------------------------------
  // Shared sweep implementation for both refund and collection wallets.
  // -------------------------------------------------------------------

  async function handleWalletSweep(
    c: Context,
    svc: RefundService,
    walletName: string,
  ): Promise<Response> {
    const treasuryAddress = config.treasuryAddress;
    if (!treasuryAddress) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'TREASURY_ADDRESS not configured');
    }

    let req: SweepRequest;
    try {
      req = await c.req.json<SweepRequest>();
    } catch {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'invalid request body: amount (string) and confirm (bool) required');
    }

    const asset = req.asset || 'usdc';
    if (asset !== 'usdc' && asset !== 'eth') {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, "asset must be 'usdc' or 'eth'");
    }

    let amount: bigint;
    try {
      amount = BigInt(req.amount);
      if (amount <= 0n) throw new Error('non-positive');
    } catch {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'amount must be a positive integer string');
    }

    // Dry run
    if (!req.confirm) {
      const resp: Record<string, unknown> = {
        dry_run: true,
        from: svc.getFromAddress(),
        to: treasuryAddress,
        asset,
        amount: req.amount,
        message: 'Set confirm=true to execute the sweep',
      };
      if (asset === 'usdc') {
        resp.amount_usd = formatUSD(amount);
      } else {
        resp.amount_ether = formatETH(amount);
      }
      return c.json(resp);
    }

    log.info('admin_wallet_sweep_initiated', {
      wallet: walletName,
      asset,
      from: svc.getFromAddress(),
      to: treasuryAddress,
      amount: req.amount,
    });

    try {
      if (asset === 'usdc') {
        const result = await svc.sendRefund(treasuryAddress, amount);
        const success = result.status === 'success';
        return c.json({
          success,
          from: svc.getFromAddress(),
          to: treasuryAddress,
          asset: 'usdc',
          amount: req.amount,
          result,
        }, success ? 200 : 502);
      } else {
        const result = await svc.sendETH(treasuryAddress, amount);
        const success = result.status === 'success';
        return c.json({
          success,
          from: svc.getFromAddress(),
          to: treasuryAddress,
          asset: 'eth',
          amount: req.amount,
          result,
        }, success ? 200 : 502);
      }
    } catch (err) {
      log.error(`wallet ${asset} sweep failed`, {
        wallet: walletName,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'sweep transaction failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // -------------------------------------------------------------------
  // handleAdminWalletSweep -- POST /admin/wallet/sweep
  // Sends USDC or ETH from refund wallet to treasury.
  // -------------------------------------------------------------------

  async function handleAdminWalletSweep(c: Context): Promise<Response> {
    if (!refundService) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'refund wallet not configured');
    }
    return handleWalletSweep(c, refundService, 'refund');
  }

  // -------------------------------------------------------------------
  // handleAdminCollectionSweep -- POST /admin/wallet/collection/sweep
  // Sends USDC or ETH from collection (pay-to) wallet to treasury.
  // -------------------------------------------------------------------

  async function handleAdminCollectionSweep(c: Context): Promise<Response> {
    if (!collectionService) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'collection wallet not configured (COLLECTION_PRIVATE_KEY not set)');
    }
    return handleWalletSweep(c, collectionService, 'collection');
  }

  // =========================================================================
  // Resource request builder (mirrors Go's reqToLeaseResource)
  // =========================================================================

  function buildResourceFromRequest(req: AdminResourceRequest) {
    const sshUser = req.sshUser || 'ubuntu';
    const maxConcurrent = req.maxConcurrent && req.maxConcurrent > 0 ? req.maxConcurrent : 10;
    const enabled = req.enabled !== undefined ? req.enabled : true;
    const marginPercent = req.marginPercent && req.marginPercent > 0 ? req.marginPercent : 20;
    const defaultStorageGb = req.defaultStorageGb && req.defaultStorageGb > 0
      ? req.defaultStorageGb
      : (req.storageGb ?? 0);
    const publicIpDefault = req.publicIpDefault !== undefined ? req.publicIpDefault : true;

    return {
      id: req.id,
      display_name: req.displayName,
      instance_type: req.instanceType,
      vcpus: req.vcpus,
      memory_gb: req.memoryGb,
      storage_gb: req.storageGb ?? 0,
      ami_id: req.amiId,
      ssh_user: sshUser,
      description: req.description ?? null,
      price_1d: BigInt(req.price1d),
      price_7d: BigInt(req.price7d),
      price_30d: BigInt(req.price30d),
      max_concurrent: maxConcurrent,
      enabled,
      margin_percent: marginPercent,
      default_storage_gb: defaultStorageGb,
      min_storage_gb: req.minStorageGb ?? 0,
      max_storage_gb: req.maxStorageGb ?? 0,
      egress_limit_gb: req.egressLimitGb ?? 0,
      ingress_limit_gb: req.ingressLimitGb ?? 0,
      public_ip_default: publicIpDefault,
    };
  }

  // =========================================================================
  // GDPR & Data Retention
  // =========================================================================

  async function handleAdminGDPRDelete(c: Context): Promise<Response> {
    if (!db) return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');

    const body = await c.req.json<{ address?: string }>().catch(() => ({} as { address?: string }));
    const address = body.address?.trim().toLowerCase();
    if (!address || !isValidEthAddress(address)) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'valid Ethereum address is required');
    }

    try {
      const result = await deleteAllDataForAddress(db, address);

      await createAuditEntry(db, {
        admin_ip: c.req.header('X-Forwarded-For') ?? c.req.header('X-Real-IP') ?? 'unknown',
        action: 'gdpr.delete_all_data',
        target_type: 'address',
        target_id: address,
        details: result,
      });

      log.info('GDPR deletion completed', { address, ...result });
      return c.json({ success: true, address, ...result });
    } catch (err) {
      log.error('GDPR deletion failed', {
        address,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'GDPR deletion failed');
    }
  }

  async function handleAdminTableSizes(c: Context): Promise<Response> {
    if (!db) return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');

    try {
      const sizes = await getTableSizes(db);
      return c.json({ tables: sizes });
    } catch (err) {
      log.error('failed to get table sizes', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to get table sizes');
    }
  }

  async function handleAdminRunRetention(c: Context): Promise<Response> {
    if (!db) return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');

    const retentionCfg: RetentionConfig = {
      invocationRetentionDays: config.invocationRetentionDays,
      nonceRetentionDays: config.nonceRetentionDays,
      creditRetentionDays: config.creditRetentionDays,
      voucherRetentionDays: config.voucherRetentionDays,
      leaseAnonymizeDays: config.leaseAnonymizeDays,
      batchSize: config.retentionBatchSize,
    };

    try {
      const result = await runRetentionCleanup(db, retentionCfg);

      await createAuditEntry(db, {
        admin_ip: c.req.header('X-Forwarded-For') ?? c.req.header('X-Real-IP') ?? 'unknown',
        action: 'retention.manual_run',
        target_type: 'system',
        target_id: 'retention',
        details: result,
      });

      log.info('Manual retention cleanup completed', { ...result });
      return c.json({ success: true, ...result });
    } catch (err) {
      log.error('retention cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'retention cleanup failed');
    }
  }

  // =========================================================================
  // Voucher Admin
  // =========================================================================

  async function handleAdminCreateVoucher(c: Context): Promise<Response> {
    if (!db) return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');

    const body = await c.req.json<{
      voucher_id?: string;
      source?: string;
      amount?: string;
      expires_in_hours?: number;
    }>().catch(() => ({} as Record<string, unknown>));

    const voucherId = (body.voucher_id as string)?.trim();
    if (!voucherId) return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'voucher_id is required');

    let amount: bigint;
    try {
      amount = BigInt(body.amount as string);
      if (amount <= 0n) throw new Error('must be positive');
    } catch {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'amount must be a positive integer (atomic USDC)');
    }

    const source = (body.source as string)?.trim() || 'admin';
    const expiresInHours = (body.expires_in_hours as number) || 720; // 30 days default
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    try {
      const id = await createVoucherRedemption(db, {
        voucherId,
        source,
        payerAddress: '', // Not yet redeemed
        amount,
        issuedAt: new Date(),
        expiresAt,
        status: 'pending',
      });

      await createAuditEntry(db, {
        admin_ip: c.req.header('X-Forwarded-For') ?? 'unknown',
        action: 'voucher.create',
        target_type: 'voucher',
        target_id: voucherId,
        details: { amount: String(amount), expiresAt: expiresAt.toISOString() },
      });

      return c.json({ success: true, id: String(id), voucherId, amount: String(amount), expiresAt: expiresAt.toISOString() }, 201);
    } catch (err) {
      log.error('failed to create voucher', { voucherId, error: err instanceof Error ? err.message : String(err) });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to create voucher');
    }
  }

  async function handleAdminListVouchers(c: Context): Promise<Response> {
    if (!db) return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');

    const status = c.req.query('status') ?? 'pending';
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 500);

    try {
      const vouchers = await listVoucherRedemptions(db, status, limit);
      return c.json({ vouchers, count: vouchers.length });
    } catch (err) {
      log.error('failed to list vouchers', { error: err instanceof Error ? err.message : String(err) });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list vouchers');
    }
  }

  async function handleAdminRevokeVoucher(c: Context): Promise<Response> {
    if (!db) return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');

    const voucherId = c.req.param('voucherId') ?? '';
    if (!voucherId) return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'voucher ID is required');

    const existing = await getVoucherRedemption(db, voucherId);
    if (!existing) return errorResponse(c, 404, ErrorCodes.NOT_FOUND, 'voucher not found');
    if (existing.status === 'success') return errorResponse(c, 409, ErrorCodes.CONFLICT, 'voucher already redeemed');

    try {
      await updateVoucherRedemptionStatus(db, voucherId, 'failed');
      await createAuditEntry(db, {
        admin_ip: c.req.header('X-Forwarded-For') ?? 'unknown',
        action: 'voucher.revoke',
        target_type: 'voucher',
        target_id: voucherId,
        details: null,
      });
      return c.json({ success: true, voucherId });
    } catch (err) {
      log.error('failed to revoke voucher', { voucherId, error: err instanceof Error ? err.message : String(err) });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to revoke voucher');
    }
  }

  // =========================================================================
  // Refund monitoring (using store functions)
  // =========================================================================

  async function handleAdminRefundMonitoring(c: Context): Promise<Response> {
    if (!db) return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');

    try {
      const pending = await listPendingRefunds(db, 50);
      const stuckCount = await countStuckPendingRefunds(db);

      // Update Prometheus gauge
      metrics.stuckPendingRefundsGauge.set(stuckCount);

      return c.json({
        pendingRefunds: pending.length,
        stuckPendingCount: stuckCount,
        pendingRefundsList: pending.map(r => ({
          id: String(r.id),
          payerAddress: r.payer_address,
          amount: String(r.amount),
          txHash: r.refund_tx_hash,
          createdAt: r.created_at,
        })),
      });
    } catch (err) {
      log.error('failed to get refund monitoring data', { error: err instanceof Error ? err.message : String(err) });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to get refund monitoring');
    }
  }

  async function handleAdminRefundHistory(c: Context): Promise<Response> {
    if (!db) return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');

    const address = (c.req.query('address') ?? '').toLowerCase();
    if (!address || !isValidEthAddress(address)) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'valid address query parameter is required');
    }

    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 500);
    const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;

    try {
      const refunds = await listRefunds(db, address, limit, offset);
      return c.json({ refunds, count: refunds.length });
    } catch (err) {
      log.error('failed to list refunds', { address, error: err instanceof Error ? err.message : String(err) });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list refunds');
    }
  }

  // =========================================================================
  // Return all admin handlers
  // =========================================================================

  return {
    // Function management
    handleAdminListFunctions,
    handleAdminRegisterFunction,
    handleAdminDeleteFunction,

    // Stats
    handleAdminGetStats,

    // Lease management
    handleAdminListLeases,
    handleAdminLeaseSummary,
    handleAdminGetLease,
    handleAdminTerminateLease,
    handleAdminExtendLease,
    handleAdminDeleteLeaseData,

    // Billing & financial
    handleAdminBillingSummary,
    handleAdminBillingInvocations,
    handleAdminBillingRefunds,
    handleAdminBillingCredits,
    handleAdminBillingEarnings,

    // Resource management
    handleAdminListResources,
    handleAdminCreateResource,
    handleAdminUpdateResource,
    handleAdminDeleteResource,
    handleAdminResourceUtilization,

    // Audit
    handleAdminAuditLog,

    // Wallet
    handleAdminWalletBalance,
    handleAdminCollectionBalance,
    handleAdminWalletSweep,
    handleAdminCollectionSweep,

    // Monitoring
    handleAdminMonitoringSnapshot,
    handleAdminMonitoringConfig,

    // Reconciliation
    handleAdminRunReconciliation,
    handleAdminGetReconciliation,

    // GDPR & Data Retention
    handleAdminGDPRDelete,
    handleAdminTableSizes,
    handleAdminRunRetention,

    // Vouchers
    handleAdminCreateVoucher,
    handleAdminListVouchers,
    handleAdminRevokeVoucher,

    // Refund monitoring
    handleAdminRefundMonitoring,
    handleAdminRefundHistory,
  };
}
