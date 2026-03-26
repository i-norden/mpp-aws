import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../db/types.js';
import type { BillingService } from '../billing/service.js';
import type { Config } from '../config/index.js';
import { cleanupExpiredNonces } from '../db/store-nonces.js';
import { expireBudgets } from '../db/store-budgets.js';
import * as log from '../logging/index.js';
import * as metrics from '../metrics/index.js';

export interface BackgroundWorkerDeps {
  db: Kysely<Database>;
  billingService?: BillingService;
  config: Config;
}

export class BackgroundWorkers {
  private timers: ReturnType<typeof setInterval>[] = [];
  private deps: BackgroundWorkerDeps;

  constructor(deps: BackgroundWorkerDeps) { this.deps = deps; }

  start() {
    const { db } = this.deps;

    // 1. Nonce cleanup - every 5 minutes
    this.addWorker('nonce-cleanup', 5 * 60_000, async () => {
      const count = await cleanupExpiredNonces(db);
      if (count > 0) log.debug('Cleaned up expired nonces', { count });
    });

    // 2. Budget expiry - every 10 minutes
    this.addWorker('budget-expiry', 10 * 60_000, async () => {
      const count = await expireBudgets(db);
      if (count > 0) log.info('Expired budgets', { count });
    });

    // 3. Stuck refund recovery - every 3 minutes
    this.addWorker('stuck-refund-recovery', 3 * 60_000, async () => {
      const result = await sql`
        UPDATE refunds SET status = 'failed', error_message = 'auto-recovered: stuck in pending', completed_at = NOW()
        WHERE status = 'pending' AND refund_tx_hash IS NULL AND created_at < NOW() - INTERVAL '10 minutes'
      `.execute(db);
      const count = Number(result.numAffectedRows ?? 0);
      if (count > 0) {
        log.warn('Recovered stuck refunds', { count });
        metrics.stuckPendingRefundsRecovered.inc(count);
      }
    });

    // 4. Orphaned redemption recovery - every 5 minutes
    this.addWorker('orphaned-redemption-recovery', 5 * 60_000, async () => {
      // Roll back credits stuck in pending > 15 min
      const creditResult = await sql`
        UPDATE credits SET withdrawal_status = NULL
        WHERE withdrawal_status = 'pending' AND updated_at < NOW() - INTERVAL '15 minutes'
      `.execute(db);
      const creditCount = Number(creditResult.numAffectedRows ?? 0);
      if (creditCount > 0) log.warn('Rolled back orphaned credit redemptions', { count: creditCount });

      // Roll back earnings stuck in pending > 15 min
      const earningsResult = await sql`
        UPDATE earnings SET withdrawal_status = NULL
        WHERE withdrawal_status = 'pending' AND updated_at < NOW() - INTERVAL '15 minutes'
      `.execute(db);
      const earningsCount = Number(earningsResult.numAffectedRows ?? 0);
      if (earningsCount > 0) log.warn('Rolled back orphaned earnings withdrawals', { count: earningsCount });
    });

    // 5. Wallet balance monitor - every 5 minutes
    if (this.deps.billingService?.isRefundEnabled()) {
      this.addWorker('wallet-balance-monitor', 5 * 60_000, async () => {
        const refundService = this.deps.billingService!.getRefundService();
        if (!refundService) return;
        try {
          const usdcBal = await refundService.getBalance();
          metrics.refundWalletUSDCBalance.set(Number(usdcBal));
          const ethBal = await refundService.getETHBalance();
          metrics.refundWalletETHBalance.set(Number(ethBal));
        } catch (err) {
          log.error('Wallet balance check failed', { error: String(err) });
        }
      });
    }

    // 6. Data retention - every 24 hours (initial run after 30s)
    const retentionFn = async () => {
      const result = await sql`
        DELETE FROM lambda_invocations WHERE created_at < NOW() - INTERVAL '90 days'
      `.execute(db);
      const count = Number(result.numAffectedRows ?? 0);
      if (count > 0) log.info('Data retention: deleted old invocations', { count });

      await sql`DELETE FROM admin_audit_log WHERE created_at < NOW() - INTERVAL '365 days'`.execute(db);
    };
    setTimeout(() => {
      retentionFn().catch(e => log.error('Data retention initial run failed', { error: String(e) }));
    }, 30_000);
    this.addWorker('data-retention', 24 * 60 * 60_000, retentionFn);

    // 7. Analytics refresh - every 5 minutes
    this.addWorker('analytics-refresh', 5 * 60_000, async () => {
      try {
        await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY function_analytics_mv`.execute(db);
      } catch {
        // View may not exist yet - that's ok
      }
    });

    log.info('Background workers started', { count: this.timers.length });
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    log.info('Background workers stopped');
  }

  private addWorker(name: string, intervalMs: number, fn: () => Promise<void>) {
    const wrapped = () => {
      fn().catch(err => {
        log.error(`Background worker ${name} failed`, { error: String(err) });
        metrics.recordDBError(name);
      });
    };
    const timer = setInterval(wrapped, intervalMs);
    timer.unref();
    this.timers.push(timer);
  }
}
