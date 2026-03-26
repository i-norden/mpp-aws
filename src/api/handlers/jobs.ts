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
import type { Database } from '../../db/types.js';
import type { Config } from '../../config/index.js';
import type { PricingEngine } from '../../pricing/engine.js';
import { getPaymentInfo } from '../middleware/mpp.js';
import { verifyAddressOwnershipWithReplay } from '../../auth/signature.js';
import { createAsyncJob, getAsyncJob, listAsyncJobsByAddress } from '../../db/store-jobs.js';
import * as log from '../../logging/index.js';
import { HttpError } from '../errors.js';
import { readJsonBody } from '../request-body.js';
import { jsonWithStatus } from '../response.js';
import {
  assertFunctionInvocationAccess,
  resolveFunctionForRequest,
} from '../function-registry.js';

export interface JobsDeps {
  db: Kysely<Database> | null;
  config: Config;
  pricingEngine: PricingEngine;
}

interface SubmitJobRequest {
  input?: unknown;
  ttlHours?: number;
}

function formatUSD(atomicAmount: bigint): string {
  const dollars = Number(atomicAmount) / 1_000_000;
  if (Math.abs(dollars) < 0.01) {
    return `$${dollars.toFixed(4)}`;
  }
  return `$${dollars.toFixed(2)}`;
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
  db: Kysely<Database>,
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

  const result = await verifyAddressOwnershipWithReplay(db, signature, message, address);
  if (!result.valid) {
    c.res = jsonWithStatus(c, {
      error: 'authentication failed',
      message: result.errorMessage,
    }, result.statusCode ?? 401) as unknown as Response;
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

  async function getJobAmount(c: Context): Promise<bigint> {
    const resolved = await resolveFunctionForRequest(
      db,
      config,
      pricingEngine,
      c.req.param('function') ?? '',
      { requireRegistered: true },
    );
    return resolved.amount;
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
    let functionName = '';
    let dbFunction = null;
    let amount = 0n;
    try {
      const resolved = await resolveFunctionForRequest(
        db,
        config,
        pricingEngine,
        c.req.param('function') ?? '',
        { requireRegistered: true },
      );
      functionName = resolved.functionName;
      dbFunction = resolved.dbFunction;
      amount = resolved.amount;
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonWithStatus(c, { error: err.message, details: err.details }, err.status);
      }
      throw err;
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

    try {
      await assertFunctionInvocationAccess(
        db,
        functionName,
        dbFunction,
        paymentInfo.payer,
      );
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonWithStatus(c, {
          error: err.status === 403 ? 'access denied' : 'failed to verify access authorization',
          function: functionName,
          message: err.message,
        }, err.status);
      }
      throw err;
    }

    if (paymentInfo.amount !== amount) {
      return c.json({
        error: 'payment amount mismatch',
        message: 'Async job payment amount no longer matches the exact function price.',
      }, 400);
    }

    // 4. Parse request body (tolerate empty body)
    let req: SubmitJobRequest;
    try {
      req = (await readJsonBody<SubmitJobRequest>(c, { allowEmpty: true })) ?? {};
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonWithStatus(c, { error: err.message, details: err.details }, err.status);
      }
      throw err;
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
    const verifiedAddr = await requireAddressOwnership(c, db);
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
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    const verifiedAddr = await requireAddressOwnership(c, db);
    if (!verifiedAddr) {
      return c.res;
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
