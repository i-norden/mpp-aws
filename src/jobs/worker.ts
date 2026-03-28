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
import type { BillingService } from '../billing/service.js';
import {
  claimPendingAsyncJobs,
  updateAsyncJobCompleted,
  updateAsyncJobFailed,
  expirePendingAsyncJobs,
  deleteExpiredAsyncJobs,
  type AsyncJob,
} from '../db/store-jobs.js';
import { getFunction } from '../db/store-functions.js';
import {
  applyToRequest,
  decrypt,
} from '../endpoint-auth/index.js';
import { settleInvocation, isHTTPEndpoint } from '../invocation/settlement.js';
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
      jobs = await claimPendingAsyncJobs(this.db, this.maxConcurrent);
    } catch (err) {
      log.error('failed to claim pending async jobs', {
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

    // 1. Look up the function in the database
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

    // 2. Invoke Lambda or HTTP endpoint
    let result: InvocationResult;
    try {
      if (isHTTPEndpoint(dbFunction.function_arn)) {
        // Build auth headers if configured
        let endpointURL = dbFunction.function_arn;
        let authHeaders: Record<string, string> | undefined;
        if (dbFunction.endpoint_auth_encrypted && this.config.endpointAuthKey) {
          try {
            const auth = decrypt(dbFunction.endpoint_auth_encrypted, this.config.endpointAuthKey);
            const applied = applyToRequest(auth, endpointURL);
            endpointURL = applied.url;
            authHeaders = applied.headers;
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
          endpointURL,
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

    // 3. Handle invocation result
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

    // 4. Process billing, log the invocation, and credit owner earnings.
    let actualCost = 0n;
    try {
      const settlement = await settleInvocation(
        {
          db: this.db,
          config: this.config,
          billingService: this.billingService,
        },
        job.function_name,
        dbFunction,
        {
          payerAddress: job.payer_address,
          txHash: job.tx_hash,
          amountPaid: BigInt(job.amount_paid),
        },
        result,
      );
      actualCost = settlement.actualCost;
    } catch (err) {
      log.error('settlement failed for async job', {
        jobId,
        functionName: job.function_name,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 5. Mark as completed
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
      const expiredPending = await expirePendingAsyncJobs(this.db);
      if (expiredPending > 0) {
        log.info('marked expired pending async jobs as failed', {
          count: expiredPending,
        });
      }

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
