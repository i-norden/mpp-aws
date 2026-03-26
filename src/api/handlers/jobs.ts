/**
 * Async job handlers.
 * TypeScript port of mmp-compute/lambda-proxy/internal/api/handlers_jobs.go
 *
 * Endpoints:
 *   POST /jobs/:function  - submit an async job (MPP payment)
 *   GET  /jobs            - list jobs for a payer address (auth required)
 *   GET  /jobs/:jobId     - get job status and result (auth required)
 *
 * Job submission requires MPP payment. Listing and retrieval require
 * wallet signature authentication via X-Signature + X-Message headers
 * (or X-Wallet-Address + X-Wallet-Signature + X-Wallet-Message).
 */

import type { Context } from 'hono';
import type { Kysely } from 'kysely';
import type { Selectable } from 'kysely';
import type { Database, LambdaFunctionTable } from '../../db/types.js';
import type { Config } from '../../config/index.js';
import type { PricingEngine } from '../../pricing/engine.js';
import { getPaymentInfo } from '../middleware/mpp.js';
import { verifyAddressOwnership } from '../../auth/signature.js';
import { createAsyncJob, getAsyncJob, listAsyncJobsByAddress } from '../../db/store-jobs.js';
import * as log from '../../logging/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LambdaFunction = Selectable<LambdaFunctionTable>;

export interface JobsDeps {
  db: Kysely<Database> | null;
  config: Config;
  pricingEngine: PricingEngine;
}

interface SubmitJobRequest {
  input?: unknown;
  ttlHours?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAFE_FUNCTION_NAME_RE = /^[a-zA-Z0-9_-]{1,170}$/;

function normalizeFunctionName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (!SAFE_FUNCTION_NAME_RE.test(trimmed)) return '';
  return trimmed.toLowerCase();
}

function formatUSD(atomicAmount: bigint): string {
  const dollars = Number(atomicAmount) / 1_000_000;
  if (Math.abs(dollars) < 0.01) {
    return `$${dollars.toFixed(4)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Function cache
// ---------------------------------------------------------------------------

interface CachedFunction {
  fn: LambdaFunction;
  expiresAt: number;
}

const functionCache = new Map<string, CachedFunction>();

function getCachedFunction(name: string): LambdaFunction | null {
  const cached = functionCache.get(name);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.fn;
  }
  if (cached) {
    functionCache.delete(name);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auth helper (mirrors Go's requireAddressOwnership)
// ---------------------------------------------------------------------------

/**
 * Verify that the request is authenticated by the address owner using
 * wallet signature headers. Returns the verified lowercase address on
 * success, or null on failure (error response written to context).
 */
async function requireAddressOwnership(
  c: Context,
): Promise<string | null> {
  // Support both header naming conventions:
  //   1. X-Wallet-Address / X-Wallet-Signature / X-Wallet-Message (Go convention)
  //   2. X-Signature / X-Message with address in X-Wallet-Address (TS convention)
  const address = c.req.header('X-Wallet-Address') ?? '';
  const signature = c.req.header('X-Wallet-Signature') ?? c.req.header('X-Signature') ?? '';
  const message = c.req.header('X-Wallet-Message') ?? c.req.header('X-Message') ?? '';

  if (!address || !signature || !message) {
    c.res = c.json({
      error: 'authentication required',
      message: 'X-Wallet-Address, X-Wallet-Signature, and X-Wallet-Message headers are required',
      hint: "Sign a message in format 'open-compute:{address}:{timestamp}:{nonce}' with your wallet",
    }, 401) as unknown as Response;
    return null;
  }

  const result = await verifyAddressOwnership(signature, message, address);
  if (!result.valid) {
    c.res = c.json({
      error: 'authentication failed',
      message: result.errorMessage,
    }, 401) as unknown as Response;
    return null;
  }

  return result.address;
}

// ---------------------------------------------------------------------------
// createJobsHandlers
// ---------------------------------------------------------------------------

export function createJobsHandlers(deps: JobsDeps) {
  const { db, config, pricingEngine } = deps;

  // -------------------------------------------------------------------
  // getJobAmount
  // -------------------------------------------------------------------

  function getJobAmount(c: Context): bigint {
    // Job cost equals a single invocation cost (mirrors Go's GetJobAmount
    // which delegates to GetInvokeAmount).
    const rawName = c.req.param('function') ?? '';
    if (!rawName) {
      return pricingEngine.calculateInvocationCost(128, 1000);
    }

    const functionName = normalizeFunctionName(rawName);
    if (!functionName) {
      return pricingEngine.calculateInvocationCost(128, 1000);
    }

    const cached = getCachedFunction(functionName);
    if (cached) {
      if (cached.custom_base_fee !== null && cached.custom_base_fee !== undefined) {
        return BigInt(cached.custom_base_fee);
      }
      return pricingEngine.calculateInvocationCost(
        cached.memory_mb,
        cached.estimated_duration_ms,
      );
    }

    return pricingEngine.calculateInvocationCost(128, 1000);
  }

  // -------------------------------------------------------------------
  // getJobDescription
  // -------------------------------------------------------------------

  function getJobDescription(c: Context): string {
    const functionName = c.req.param('function') ?? 'unknown';
    return `Async job: ${functionName}`;
  }

  // -------------------------------------------------------------------
  // handleSubmitJob -- POST /jobs/:function
  // -------------------------------------------------------------------

  async function handleSubmitJob(c: Context): Promise<Response> {
    // 1. Validate function name
    const rawName = c.req.param('function') ?? '';
    if (!rawName) {
      return c.json({ error: 'function name is required' }, 400);
    }

    const functionName = normalizeFunctionName(rawName);
    if (!functionName) {
      return c.json({ error: 'invalid function name' }, 400);
    }

    // 2. Require payment info
    const paymentInfo = getPaymentInfo(c);
    if (!paymentInfo) {
      return c.json({ error: 'payment info missing' }, 500);
    }

    // 3. Require database
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    // 4. Parse request body (tolerate empty body)
    let req: SubmitJobRequest = {};
    try {
      req = await c.req.json() as SubmitJobRequest;
    } catch {
      // Empty body or invalid JSON -- use defaults
    }

    const input = req.input ?? {};

    let ttlHours = req.ttlHours ?? 24;
    if (ttlHours <= 0) {
      ttlHours = 24;
    }
    const maxTTL = config.asyncJobMaxTTLHours;
    if (maxTTL > 0 && ttlHours > maxTTL) {
      ttlHours = maxTTL;
    }

    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    // 5. Create the job
    try {
      const jobRecord = await createAsyncJob(db, {
        functionName,
        payerAddress: paymentInfo.payer,
        txHash: paymentInfo.txHash,
        input,
        amountPaid: paymentInfo.amount,
        expiresAt,
      });

      return c.json({
        jobId: jobRecord.id,
        status: 'pending',
        expiresAt: expiresAt.toISOString(),
        txHash: paymentInfo.txHash,
        cost: formatUSD(paymentInfo.amount),
      }, 202);
    } catch (err) {
      log.error('failed to create async job', {
        function: functionName,
        payer: paymentInfo.payer,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to create job' }, 500);
    }
  }

  // -------------------------------------------------------------------
  // handleGetJob -- GET /jobs/:jobId
  // -------------------------------------------------------------------

  async function handleGetJob(c: Context): Promise<Response> {
    const jobId = c.req.param('jobId') ?? '';
    if (!jobId) {
      return c.json({ error: 'job ID is required' }, 400);
    }

    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    // Retrieve the job
    let job;
    try {
      job = await getAsyncJob(db, jobId);
    } catch (err) {
      log.error('failed to get async job', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to retrieve job' }, 500);
    }

    if (!job) {
      return c.json({ error: 'job not found' }, 404);
    }

    // Verify ownership
    const verifiedAddr = await requireAddressOwnership(c);
    if (!verifiedAddr) {
      return c.res;
    }

    if (verifiedAddr !== job.payer_address) {
      return c.json({ error: 'you do not own this job' }, 403);
    }

    return c.json(job, 200);
  }

  // -------------------------------------------------------------------
  // handleListJobs -- GET /jobs
  // -------------------------------------------------------------------

  async function handleListJobs(c: Context): Promise<Response> {
    // Verify ownership first (like the Go handler)
    const verifiedAddr = await requireAddressOwnership(c);
    if (!verifiedAddr) {
      return c.res;
    }

    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    let limit = 50;
    const limitStr = c.req.query('limit');
    if (limitStr) {
      const parsed = parseInt(limitStr, 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) {
        limit = parsed;
      }
    }

    try {
      const jobs = await listAsyncJobsByAddress(db, verifiedAddr, limit);
      return c.json({
        jobs,
        total: jobs.length,
      }, 200);
    } catch (err) {
      log.error('failed to list async jobs', {
        payer: verifiedAddr,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to list jobs' }, 500);
    }
  }

  return {
    getJobAmount,
    getJobDescription,
    handleSubmitJob,
    handleListJobs,
    handleGetJob,
  };
}
