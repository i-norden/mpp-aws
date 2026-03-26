/**
 * Expiry monitoring worker for EC2 leases.
 * TypeScript port of the ExpirationWorker from
 * mmp-compute/lambda-proxy/internal/lease/worker.go
 *
 * Periodically checks for expired and near-expiry leases:
 *  - Terminates expired leases (EC2 + DB update + SG cleanup)
 *  - Sends webhook notifications for leases approaching expiry
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { EC2Manager, LeaseRow } from './worker.js';
import { deleteSGIfPresent } from './worker.js';
import * as log from '../logging/index.js';
import * as metrics from '../metrics/index.js';

// ---------------------------------------------------------------------------
// Notifier interface for webhook notifications
// ---------------------------------------------------------------------------

export interface LeaseNotifier {
  sendExpiryWarning(
    leaseId: string,
    resourceId: string,
    payerAddress: string,
    instanceIp: string,
    expiresAt: Date,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Simple webhook notifier implementation (mirrors Go Notifier)
// ---------------------------------------------------------------------------

export class WebhookNotifier implements LeaseNotifier {
  private readonly webhookUrl: string;
  private readonly timeoutMs: number;

  constructor(webhookUrl: string, timeoutMs = 10_000) {
    this.webhookUrl = webhookUrl;
    this.timeoutMs = timeoutMs;
  }

  async sendExpiryWarning(
    leaseId: string,
    resourceId: string,
    payerAddress: string,
    instanceIp: string,
    expiresAt: Date,
  ): Promise<void> {
    const remainingMs = expiresAt.getTime() - Date.now();
    const remainingStr = formatDuration(remainingMs);

    const payload = {
      lease_id: leaseId,
      resource_id: resourceId,
      payer_address: payerAddress,
      instance_ip: instanceIp || undefined,
      expires_at: expiresAt.toISOString(),
      time_remaining: remainingStr,
      event_type: 'lease.expiry_warning',
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`webhook returned status ${resp.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Formats a duration in ms as a human-readable string. */
function formatDuration(ms: number): string {
  if (ms <= 0) return 'expired';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m${seconds}s`;
  }
  return `${minutes}m${seconds}s`;
}

// ---------------------------------------------------------------------------
// ExpiryWorker
// ---------------------------------------------------------------------------

export class ExpiryWorker {
  private readonly db: Kysely<Database>;
  private readonly ec2Manager: EC2Manager;
  private notifier: LeaseNotifier | null = null;
  private warningThresholdMs = 0;
  private readonly warningsSent = new Map<string, boolean>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(db: Kysely<Database>, ec2Manager: EC2Manager) {
    this.db = db;
    this.ec2Manager = ec2Manager;
  }

  /**
   * Configure the expiry notification webhook.
   * @param notifier  - webhook notifier instance
   * @param warningThresholdMs - how far before expiry to send warnings (e.g. 30 * 60 * 1000 for 30 min)
   */
  setNotifier(notifier: LeaseNotifier, warningThresholdMs: number): void {
    this.notifier = notifier;
    this.warningThresholdMs = warningThresholdMs;
  }

  /**
   * Start the expiry worker polling loop.
   * @param intervalMs - polling interval in milliseconds
   */
  start(intervalMs: number): void {
    if (this.intervalHandle) return;
    log.info('ExpiryWorker started', { intervalMs });
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  /** Stop the expiry worker. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      log.info('ExpiryWorker stopped');
    }
  }

  private async tick(): Promise<void> {
    await this.sendExpiryWarnings();
    await this.processExpired();
  }

  // -----------------------------------------------------------------------
  // sendExpiryWarnings: notify for leases approaching expiry
  // -----------------------------------------------------------------------

  private async sendExpiryWarnings(): Promise<void> {
    if (!this.notifier || this.warningThresholdMs <= 0) return;

    const warningCutoff = new Date(Date.now() + this.warningThresholdMs);

    let leases: LeaseRow[];
    try {
      const rows = await this.db
        .selectFrom('leases')
        .selectAll()
        .where('status', '=', 'running')
        .where('expires_at', '<=', warningCutoff)
        .where('expires_at', '>', new Date())
        .execute();
      leases = rows;
    } catch (err) {
      log.error('failed to list expiring leases for warnings', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const lease of leases) {
      if (this.warningsSent.get(lease.id)) continue;

      const instanceIp = lease.public_ip ?? '';
      try {
        await this.notifier.sendExpiryWarning(
          lease.id,
          lease.resource_id,
          lease.payer_address,
          instanceIp,
          new Date(lease.expires_at),
        );
        metrics.leaseExpiryWarningsSentTotal.inc();
        this.warningsSent.set(lease.id, true);
      } catch (err) {
        log.error('failed to send lease expiry warning webhook', {
          lease_id: lease.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // processExpired: terminate expired lease instances
  // -----------------------------------------------------------------------

  private async processExpired(): Promise<void> {
    let leases: LeaseRow[];
    try {
      const rows = await this.db
        .selectFrom('leases')
        .selectAll()
        .where('status', 'in', ['running', 'provisioning'])
        .where('expires_at', '<=', new Date())
        .execute();
      leases = rows;
    } catch (err) {
      log.error('failed to list expired leases', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const lease of leases) {
      // Terminate EC2 instance if present
      if (lease.instance_id) {
        try {
          await this.ec2Manager.terminateInstance(lease.instance_id);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // If instance is already gone, proceed with DB update
          if (!errMsg.includes('InvalidInstanceID.NotFound')) {
            log.error('failed to terminate instance', {
              lease_id: lease.id,
              instance_id: lease.instance_id,
              error: errMsg,
            });
            continue;
          }
        }
      }

      // Update lease to terminated
      try {
        await this.db
          .updateTable('leases')
          .set({
            status: 'terminated',
            terminated_at: new Date(),
          })
          .where('id', '=', lease.id)
          .execute();
      } catch (err) {
        log.error('failed to update lease to terminated', {
          lease_id: lease.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Attempt to delete per-lease security group
      await deleteSGIfPresent(this.db, this.ec2Manager, lease);

      // Prune from warningsSent to prevent unbounded map growth
      this.warningsSent.delete(lease.id);

      log.info('Expired lease terminated', {
        lease_id: lease.id,
        instance_id: lease.instance_id ?? '',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// SGCleanupWorker: retries deletion of orphaned security groups
// ---------------------------------------------------------------------------

export class SGCleanupWorker {
  private readonly db: Kysely<Database>;
  private readonly ec2Manager: EC2Manager;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(db: Kysely<Database>, ec2Manager: EC2Manager) {
    this.db = db;
    this.ec2Manager = ec2Manager;
  }

  start(intervalMs: number): void {
    if (this.intervalHandle) return;
    log.info('SGCleanupWorker started', { intervalMs });
    this.intervalHandle = setInterval(() => {
      void this.cleanup();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      log.info('SGCleanupWorker stopped');
    }
  }

  private async cleanup(): Promise<void> {
    let leases: LeaseRow[];
    try {
      const rows = await this.db
        .selectFrom('leases')
        .selectAll()
        .where('status', 'in', ['terminated', 'failed'])
        .where('security_group_id', 'is not', null)
        .execute();
      leases = rows;
    } catch (err) {
      log.error('failed to list leases with orphaned SGs', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const lease of leases) {
      if (!lease.security_group_id) continue;

      try {
        await this.ec2Manager.deleteSecurityGroup(lease.security_group_id);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // DependencyViolation means the instance hasn't fully terminated yet
        if (errMsg.includes('DependencyViolation')) {
          log.debug('SG still in use, will retry', {
            lease_id: lease.id,
            sg_id: lease.security_group_id,
          });
          continue;
        }
        log.error('failed to delete orphaned SG', {
          lease_id: lease.id,
          sg_id: lease.security_group_id,
          error: errMsg,
        });
        continue;
      }

      try {
        await this.db
          .updateTable('leases')
          .set({ security_group_id: null })
          .where('id', '=', lease.id)
          .execute();
      } catch (err) {
        log.error('failed to clear security_group_id after orphaned SG deletion', {
          lease_id: lease.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      log.info('Cleaned up orphaned security group', {
        lease_id: lease.id,
        sg_id: lease.security_group_id,
      });
    }
  }
}
