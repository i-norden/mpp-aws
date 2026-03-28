import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../db/types.js';
import type { BillingService } from '../billing/service.js';
import type { Config } from '../config/index.js';
import { cleanupExpiredAuthNonces } from '../db/store-auth-nonces.js';
import { cleanupExpiredNonces } from '../db/store-nonces.js';
import { expireBudgets } from '../db/store-budgets.js';
import { expireVouchers } from '../db/store-vouchers.js';
import { listSentButUnconfirmedRefunds } from '../db/store-refunds.js';
import { updateRefundStatus } from '../db/store-refunds.js';
import type { RefundService } from '../refund/service.js';
import { runRetentionCleanup, type RetentionConfig } from '../db/retention.js';
import * as log from '../logging/index.js';
import * as metrics from '../metrics/index.js';

export interface BackgroundWorkerDeps {
  db: Kysely<Database>;
  billingService?: BillingService;
  refundService?: RefundService | null;
  config: Config;
}

export class BackgroundWorkers {
  private timers: ReturnType<typeof setInterval>[] = [];
  private timeouts: ReturnType<typeof setTimeout>[] = [];
  private deps: BackgroundWorkerDeps;

  constructor(deps: BackgroundWorkerDeps) { this.deps = deps; }

  start() {
    const { db } = this.deps;

    // 1. Nonce cleanup - every 5 minutes
    this.addWorker('nonce-cleanup', 5 * 60_000, async () => {
      const count = await cleanupExpiredNonces(db);
      if (count > 0) log.debug('Cleaned up expired nonces', { count });
    });

    // 2. Auth nonce cleanup - every 5 minutes
    this.addWorker('auth-nonce-cleanup', 5 * 60_000, async () => {
      const count = await cleanupExpiredAuthNonces(db);
      if (count > 0) log.debug('Cleaned up expired auth nonces', { count });
    });

    // 3. Budget expiry - every 10 minutes
    this.addWorker('budget-expiry', 10 * 60_000, async () => {
      const count = await expireBudgets(db);
      if (count > 0) log.info('Expired budgets', { count });
    });

    // 4. Stuck refund recovery - every 3 minutes
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

    // 4b. Sent-but-unconfirmed refund recovery - every 5 minutes
    // Checks refunds that have a tx_hash but are still pending after 10 min.
    // Re-verifies the on-chain receipt and updates the DB accordingly.
    if (this.deps.refundService) {
      const refundSvc = this.deps.refundService;
      this.addWorker('unconfirmed-refund-recovery', 5 * 60_000, async () => {
        const stuckRefunds = await listSentButUnconfirmedRefunds(db, 10, 20);
        for (const refund of stuckRefunds) {
          if (!refund.refund_tx_hash) continue;
          try {
            const receipt = await refundSvc.checkReceipt(refund.refund_tx_hash);
            if (receipt.confirmed) {
              await updateRefundStatus(
                db,
                Number(refund.id),
                'success',
                refund.refund_tx_hash,
                '',
                receipt.gasUsed ?? 0n,
              );
              log.info('Recovered unconfirmed refund as success', {
                refundId: String(refund.id),
                txHash: refund.refund_tx_hash,
              });
            } else if (receipt.failed) {
              await updateRefundStatus(
                db,
                Number(refund.id),
                'failed',
                refund.refund_tx_hash,
                'transaction reverted on-chain',
                receipt.gasUsed ?? 0n,
              );
              log.warn('Recovered unconfirmed refund as failed', {
                refundId: String(refund.id),
                txHash: refund.refund_tx_hash,
              });
            }
            // If neither confirmed nor failed, tx is still pending on-chain; skip
          } catch (err) {
            log.warn('Failed to check receipt for unconfirmed refund', {
              refundId: String(refund.id),
              txHash: refund.refund_tx_hash,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      });
    }

    // 5. Orphaned redemption recovery - every 5 minutes
    this.addWorker('orphaned-redemption-recovery', 5 * 60_000, async () => {
      // Roll back credits stuck in pending > 15 min
      const creditResult = await sql`
        UPDATE credits
        SET withdrawal_status = 'available',
            redeemed_at = NULL,
            redeemed_tx_hash = NULL
        WHERE withdrawal_status = 'pending' AND updated_at < NOW() - INTERVAL '15 minutes'
      `.execute(db);
      const creditCount = Number(creditResult.numAffectedRows ?? 0);
      if (creditCount > 0) log.warn('Rolled back orphaned credit redemptions', { count: creditCount });

      // Roll back earnings stuck in pending > 15 min
      const earningsResult = await sql`
        UPDATE earnings
        SET withdrawal_status = 'available',
            withdrawn_at = NULL,
            withdrawn_tx_hash = NULL
        WHERE withdrawal_status = 'pending' AND updated_at < NOW() - INTERVAL '15 minutes'
      `.execute(db);
      const earningsCount = Number(earningsResult.numAffectedRows ?? 0);
      if (earningsCount > 0) log.warn('Rolled back orphaned earnings withdrawals', { count: earningsCount });
    });

    // 6. Wallet balance monitor - every 5 minutes
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

    // 7. Expired voucher cleanup - every 10 minutes
    this.addWorker('voucher-expiry', 10 * 60_000, async () => {
      const count = await expireVouchers(db);
      if (count > 0) log.info('Expired pending vouchers', { count });
    });

    // 8. Data retention - every 24 hours (initial run after 30s)
    const { config: cfg } = this.deps;
    const retentionCfg: RetentionConfig = {
      invocationRetentionDays: cfg.invocationRetentionDays,
      nonceRetentionDays: cfg.nonceRetentionDays,
      creditRetentionDays: cfg.creditRetentionDays,
      voucherRetentionDays: cfg.voucherRetentionDays,
      leaseAnonymizeDays: cfg.leaseAnonymizeDays,
      batchSize: cfg.retentionBatchSize,
    };
    const retentionFn = async () => {
      const result = await runRetentionCleanup(db, retentionCfg);
      const total = result.invocationsDeleted + result.noncesDeleted +
        result.creditsDeleted + result.vouchersDeleted + result.leasesAnonymized;
      if (total > 0) {
        log.info('Data retention cleanup completed', {
          invocationsDeleted: result.invocationsDeleted,
          noncesDeleted: result.noncesDeleted,
          creditsDeleted: result.creditsDeleted,
          vouchersDeleted: result.vouchersDeleted,
          leasesAnonymized: result.leasesAnonymized,
        });
      }

      // Also clean up old audit logs (not covered by retention engine)
      await sql`DELETE FROM admin_audit_log WHERE created_at < NOW() - INTERVAL '365 days'`.execute(db);
    };
    const initialRetentionRun = setTimeout(() => {
      retentionFn().catch(e => log.error('Data retention initial run failed', { error: String(e) }));
    }, 30_000);
    if (typeof initialRetentionRun === 'object' && 'unref' in initialRetentionRun) {
      initialRetentionRun.unref();
    }
    this.timeouts.push(initialRetentionRun);
    this.addWorker('data-retention', 24 * 60 * 60_000, retentionFn);

    // 9. Analytics refresh - every 5 minutes
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
    for (const t of this.timeouts) clearTimeout(t);
    this.timeouts = [];
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
