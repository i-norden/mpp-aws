/**
 * Async job processing worker.
 * TypeScript port of mmp-compute/lambda-proxy/internal/jobs/worker.go
 *
 * Polls for pending async jobs and invokes the corresponding Lambda function
 * or HTTP endpoint, updating job status and processing billing on completion.
 */

import type { Kysely } from 'kysely';

import type { Database } from '../db/types.js';
import type { Config } from '../config/index.js';
import type { LambdaInvoker, InvocationResult } from '../lambda/invoker.js';
import type { BillingService, InvocationBilling } from '../billing/service.js';
import {
  listPendingAsyncJobs,
  updateAsyncJobRunning,
  updateAsyncJobCompleted,
  updateAsyncJobFailed,
  deleteExpiredAsyncJobs,
  type AsyncJob,
} from '../db/store-jobs.js';
import { getFunction } from '../db/store-functions.js';
import { createInvocation } from '../db/store-invocations.js';
import {
  decrypt,
  type EndpointAuth,
  AUTH_TYPE_BEARER,
  AUTH_TYPE_API_KEY,
  AUTH_TYPE_BASIC,
  AUTH_TYPE_CUSTOM_HEADER,
} from '../endpoint-auth/index.js';
import * as log from '../logging/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AsyncJobWorkerDeps {
  db: Kysely<Database>;
  lambdaInvoker: LambdaInvoker;
  billingService: BillingService | null;
  config: Config;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a function ARN is an HTTPS endpoint URL. */
function isHTTPEndpoint(arn: string): boolean {
  return arn.startsWith('https://');
}

/** Build HTTP headers from a decrypted EndpointAuth. */
function buildAuthHeaders(auth: EndpointAuth): Record<string, string> {
  const headers: Record<string, string> = {};
  switch (auth.type) {
    case AUTH_TYPE_BEARER:
      if (auth.token) {
        headers['Authorization'] = `Bearer ${auth.token}`;
      }
      break;
    case AUTH_TYPE_API_KEY:
      if (auth.keyName && auth.keyValue && auth.keyLocation === 'header') {
        headers[auth.keyName] = auth.keyValue;
      }
      break;
    case AUTH_TYPE_BASIC:
      if (auth.username && auth.password) {
        const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
        headers['Authorization'] = `Basic ${encoded}`;
      }
      break;
    case AUTH_TYPE_CUSTOM_HEADER:
      if (auth.headerName && auth.headerValue) {
        headers[auth.headerName] = auth.headerValue;
      }
      break;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// AsyncJobWorker
// ---------------------------------------------------------------------------

/**
 * Background worker that polls for pending async jobs, invokes them,
 * and updates their status in the database.
 */
export class AsyncJobWorker {
  private readonly db: Kysely<Database>;
  private readonly lambdaInvoker: LambdaInvoker;
  private readonly billingService: BillingService | null;
  private readonly config: Config;
  private readonly maxConcurrent: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(deps: AsyncJobWorkerDeps) {
    this.db = deps.db;
    this.lambdaInvoker = deps.lambdaInvoker;
    this.billingService = deps.billingService;
    this.config = deps.config;
    this.maxConcurrent = deps.config.asyncJobMaxConcurrent > 0
      ? deps.config.asyncJobMaxConcurrent
      : 10;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start the polling loop.
   * @param intervalMs  Polling interval in milliseconds (default: 5000).
   */
  start(intervalMs = 5000): void {
    if (this.timer) return;
    log.info('async job worker started', { intervalMs, maxConcurrent: this.maxConcurrent });
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Run an initial tick immediately
    void this.tick();
  }

  /** Stop the polling loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('async job worker stopped');
    }
  }

  // -----------------------------------------------------------------------
  // Core loop
  // -----------------------------------------------------------------------

  private async tick(): Promise<void> {
    // Prevent overlapping ticks
    if (this.processing) return;
    this.processing = true;

    try {
      await this.processPending();
      await this.cleanupExpired();
    } catch (err) {
      log.error('async job worker tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.processing = false;
    }
  }

  // -----------------------------------------------------------------------
  // processPending -- mirrors Go Worker.processPending
  // -----------------------------------------------------------------------

  private async processPending(): Promise<void> {
    let jobs: AsyncJob[];
    try {
      jobs = await listPendingAsyncJobs(this.db, this.maxConcurrent);
    } catch (err) {
      log.error('failed to list pending async jobs', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (jobs.length === 0) return;

    log.debug('processing pending async jobs', { count: jobs.length });

    // Process jobs concurrently up to maxConcurrent
    const promises = jobs.map((job) => this.processJob(job));
    await Promise.allSettled(promises);
  }

  // -----------------------------------------------------------------------
  // processJob -- mirrors Go Worker.processJob
  // -----------------------------------------------------------------------

  private async processJob(job: AsyncJob): Promise<void> {
    const jobId = String(job.id);

    // 1. Mark as running
    try {
      await updateAsyncJobRunning(this.db, jobId);
    } catch (err) {
      log.error('failed to mark async job as running', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // 2. Look up the function in the database
    let dbFunction;
    try {
      dbFunction = await getFunction(this.db, job.function_name);
    } catch (err) {
      const errMsg = `failed to look up function: ${err instanceof Error ? err.message : String(err)}`;
      log.error(errMsg, { jobId, functionName: job.function_name });
      await this.failJob(jobId, errMsg);
      return;
    }

    if (!dbFunction) {
      const errMsg = `function not found or disabled: ${job.function_name}`;
      log.error(errMsg, { jobId });
      await this.failJob(jobId, errMsg);
      return;
    }

    // 3. Invoke Lambda or HTTP endpoint
    let result: InvocationResult;
    try {
      if (isHTTPEndpoint(dbFunction.function_arn)) {
        // Build auth headers if configured
        let authHeaders: Record<string, string> | undefined;
        if (dbFunction.endpoint_auth_encrypted && this.config.endpointAuthKey) {
          try {
            const auth = decrypt(dbFunction.endpoint_auth_encrypted, this.config.endpointAuthKey);
            authHeaders = buildAuthHeaders(auth);
          } catch (err) {
            log.error('failed to decrypt endpoint auth for async job', {
              jobId,
              functionName: job.function_name,
              error: err instanceof Error ? err.message : String(err),
            });
            // Continue without auth headers
          }
        }

        result = await this.lambdaInvoker.invokeHTTPEndpoint(
          dbFunction.function_arn,
          job.input,
          dbFunction.timeout_seconds,
          authHeaders,
        );
      } else {
        result = await this.lambdaInvoker.invoke(dbFunction.function_arn, job.input);
      }
    } catch (err) {
      const errMsg = `invocation failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error(errMsg, { jobId, functionName: job.function_name });
      await this.failJob(jobId, errMsg);
      return;
    }

    // 4. Handle invocation result
    if (!result.success) {
      const errMsg = result.error || 'invocation returned non-success status';
      log.warn('async job invocation failed', {
        jobId,
        functionName: job.function_name,
        error: errMsg,
        statusCode: result.statusCode,
      });
      await this.failJob(jobId, errMsg);
      return;
    }

    // 5. Process billing (if billing service and duration data are available)
    let actualCost = 0n;
    if (this.billingService && !isHTTPEndpoint(dbFunction.function_arn) && result.billedDurationMs > 0) {
      try {
        const billingInput: InvocationBilling = {
          payerAddress: job.payer_address,
          sourceTxHash: job.tx_hash,
          amountPaid: BigInt(job.amount_paid),
          memoryMB: result.memoryMB || dbFunction.memory_mb,
          billedDurationMs: BigInt(result.billedDurationMs),
          refundStatus: 'none',
          creditBalance: 0n,
        };

        await this.billingService.processInvocationBilling(billingInput);

        if (billingInput.breakdown) {
          actualCost = billingInput.breakdown.actualCloudCost + billingInput.breakdown.feeAmount;
        }
      } catch (err) {
        log.error('billing processing failed for async job', {
          jobId,
          functionName: job.function_name,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue -- billing failure should not fail the job
      }
    }

    // 6. Log the invocation
    try {
      await createInvocation(this.db, {
        function_name: job.function_name,
        payer_address: job.payer_address,
        amount_paid: BigInt(job.amount_paid),
        tx_hash: job.tx_hash || null,
        status_code: result.statusCode,
        success: result.success,
        duration_ms: BigInt(result.billedDurationMs || 0),
        billed_duration_ms: BigInt(result.billedDurationMs || 0),
        memory_mb: result.memoryMB || dbFunction.memory_mb,
        actual_cloud_cost: actualCost > 0n ? actualCost : null,
      });
    } catch (err) {
      log.error('failed to log invocation for async job', {
        jobId,
        functionName: job.function_name,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue -- logging failure should not fail the job
    }

    // 7. Mark as completed
    let resultPayload: unknown;
    try {
      resultPayload = result.body ? JSON.parse(result.body) : null;
    } catch {
      resultPayload = result.body;
    }

    try {
      await updateAsyncJobCompleted(this.db, jobId, resultPayload, actualCost);
      log.info('async job completed', {
        jobId,
        functionName: job.function_name,
        billedDurationMs: result.billedDurationMs,
        memoryMB: result.memoryMB,
      });
    } catch (err) {
      log.error('failed to mark async job as completed', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -----------------------------------------------------------------------
  // failJob -- helper to mark a job as failed
  // -----------------------------------------------------------------------

  private async failJob(jobId: string, errorMessage: string): Promise<void> {
    try {
      await updateAsyncJobFailed(this.db, jobId, errorMessage);
    } catch (err) {
      log.error('failed to mark async job as failed', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -----------------------------------------------------------------------
  // cleanupExpired -- mirrors Go Worker.CleanupExpired
  // -----------------------------------------------------------------------

  private async cleanupExpired(): Promise<void> {
    try {
      const count = await deleteExpiredAsyncJobs(this.db);
      if (count > 0) {
        log.info('cleaned up expired async jobs', { count });
      }
    } catch (err) {
      log.error('failed to cleanup expired async jobs', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
