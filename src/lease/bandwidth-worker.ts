/**
 * Bandwidth monitoring worker for EC2 leases.
 * TypeScript port of mmp-compute/lambda-proxy/internal/lease/bandwidth_worker.go
 *
 * Periodically polls CloudWatch for network metrics on running lease instances,
 * updates bandwidth usage in the database, and terminates leases that exceed
 * their bandwidth limits. Sends webhook warnings at 80% threshold.
 */

import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  type GetMetricStatisticsCommandInput,
} from '@aws-sdk/client-cloudwatch';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { EC2Manager, LeaseRow } from './worker.js';
import * as log from '../logging/index.js';
import * as metrics from '../metrics/index.js';

// ---------------------------------------------------------------------------
// Constants (matching Go implementation)
// ---------------------------------------------------------------------------

/**
 * Fraction of the stated bandwidth limit at which enforcement triggers.
 * Set to 90% to account for CloudWatch monitoring lag (~5min delay).
 */
const BANDWIDTH_ENFORCEMENT_RATIO = 0.9;

/**
 * Fraction of the bandwidth limit at which a warning notification is sent.
 * Gives users notice before hard termination.
 */
const BANDWIDTH_WARNING_RATIO = 0.8;

// ---------------------------------------------------------------------------
// Bandwidth notifier interface
// ---------------------------------------------------------------------------

export interface BandwidthNotifier {
  sendBandwidthWarning(
    leaseId: string,
    resourceId: string,
    payerAddress: string,
    instanceIp: string,
    metricType: string,
    usedGb: number,
    limitGb: number,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Webhook-based bandwidth notifier (mirrors Go Notifier.SendBandwidthWarning)
// ---------------------------------------------------------------------------

export class WebhookBandwidthNotifier implements BandwidthNotifier {
  private readonly webhookUrl: string;
  private readonly timeoutMs: number;

  constructor(webhookUrl: string, timeoutMs = 10_000) {
    this.webhookUrl = webhookUrl;
    this.timeoutMs = timeoutMs;
  }

  async sendBandwidthWarning(
    leaseId: string,
    resourceId: string,
    payerAddress: string,
    instanceIp: string,
    metricType: string,
    usedGb: number,
    limitGb: number,
  ): Promise<void> {
    const percentage = (usedGb / limitGb) * 100;
    const payload = {
      lease_id: leaseId,
      resource_id: resourceId,
      payer_address: payerAddress,
      instance_ip: instanceIp || undefined,
      metric_type: metricType,
      used_gb: usedGb,
      limit_gb: limitGb,
      percentage,
      event_type: 'lease.bandwidth_warning',
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

// ---------------------------------------------------------------------------
// CloudWatch client interface (for testing / dependency injection)
// ---------------------------------------------------------------------------

export interface CloudWatchAPI {
  getMetricStatistics(
    input: GetMetricStatisticsCommandInput,
  ): Promise<{ Datapoints?: Array<{ Sum?: number }> }>;
}

/**
 * Adapter that wraps the real @aws-sdk/client-cloudwatch client to conform
 * to the CloudWatchAPI interface used by BandwidthWorker.
 */
export class CloudWatchAdapter implements CloudWatchAPI {
  private readonly client: CloudWatchClient;

  constructor(region: string) {
    this.client = new CloudWatchClient({ region });
  }

  async getMetricStatistics(
    input: GetMetricStatisticsCommandInput,
  ): Promise<{ Datapoints?: Array<{ Sum?: number }> }> {
    const cmd = new GetMetricStatisticsCommand(input);
    return this.client.send(cmd);
  }
}

// ---------------------------------------------------------------------------
// BandwidthWorker
// ---------------------------------------------------------------------------

export class BandwidthWorker {
  private readonly db: Kysely<Database>;
  private readonly cw: CloudWatchAPI;
  private readonly ec2Manager: EC2Manager;
  private readonly checkIntervalMs: number;
  private notifier: BandwidthNotifier | null = null;
  private readonly warningsSent = new Map<string, boolean>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: Kysely<Database>,
    cw: CloudWatchAPI,
    ec2Manager: EC2Manager,
    checkIntervalMs: number,
  ) {
    this.db = db;
    this.cw = cw;
    this.ec2Manager = ec2Manager;
    this.checkIntervalMs = checkIntervalMs;
  }

  /** Configure the bandwidth warning webhook notifier. */
  setNotifier(notifier: BandwidthNotifier): void {
    this.notifier = notifier;
  }

  /**
   * Start the bandwidth monitoring loop.
   * Uses the configured checkIntervalMs as the polling interval.
   */
  start(): void {
    if (this.intervalHandle) return;
    log.info('BandwidthWorker started', { intervalMs: this.checkIntervalMs });
    this.intervalHandle = setInterval(() => {
      void this.checkBandwidth();
    }, this.checkIntervalMs);
  }

  /** Stop the bandwidth worker. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      log.info('BandwidthWorker stopped');
    }
  }

  // -----------------------------------------------------------------------
  // checkBandwidth: poll CloudWatch and enforce limits
  // -----------------------------------------------------------------------

  private async checkBandwidth(): Promise<void> {
    let leases: LeaseRow[];
    try {
      // List running leases that haven't been checked recently
      const checkCutoff = new Date(Date.now() - this.checkIntervalMs);
      const rows = await this.db
        .selectFrom('leases')
        .selectAll()
        .where('status', '=', 'running')
        .where((eb) =>
          eb.or([
            eb('bandwidth_checked_at', 'is', null),
            eb('bandwidth_checked_at', '<=', checkCutoff),
          ]),
        )
        .execute();
      leases = rows;
    } catch (err) {
      log.error('failed to list leases for bandwidth check', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const lease of leases) {
      if (!lease.instance_id) continue;
      await this.checkLease(lease);
    }

    // Prune warningsSent entries for leases no longer in the active set
    const activeKeys = new Set<string>();
    for (const lease of leases) {
      activeKeys.add(lease.id + ':egress');
      activeKeys.add(lease.id + ':ingress');
    }
    for (const key of this.warningsSent.keys()) {
      if (!activeKeys.has(key)) {
        this.warningsSent.delete(key);
      }
    }
  }

  // -----------------------------------------------------------------------
  // checkLease: check bandwidth for a single lease
  // -----------------------------------------------------------------------

  private async checkLease(lease: LeaseRow): Promise<void> {
    const now = new Date();
    const startTime = new Date(lease.created_at);

    // Get network out (egress) bytes
    let egressBytes: number;
    try {
      egressBytes = await this.getNetworkMetric(
        lease.instance_id!,
        'NetworkOut',
        startTime,
        now,
      );
    } catch (err) {
      log.error('failed to get NetworkOut metric', {
        lease_id: lease.id,
        instance_id: lease.instance_id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Update checked_at anyway to prevent tight retry loops
      await this.updateBandwidthCheckedAt(lease.id, lease.egress_used_gb, lease.ingress_used_gb);
      return;
    }

    // Get network in (ingress) bytes
    let ingressBytes: number;
    try {
      ingressBytes = await this.getNetworkMetric(
        lease.instance_id!,
        'NetworkIn',
        startTime,
        now,
      );
    } catch (err) {
      log.error('failed to get NetworkIn metric', {
        lease_id: lease.id,
        instance_id: lease.instance_id,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.updateBandwidthCheckedAt(lease.id, lease.egress_used_gb, lease.ingress_used_gb);
      return;
    }

    const egressGb = egressBytes / (1024 * 1024 * 1024);
    const ingressGb = ingressBytes / (1024 * 1024 * 1024);

    // Update usage in database
    try {
      await this.updateBandwidthCheckedAt(lease.id, egressGb, ingressGb);
    } catch (err) {
      log.error('failed to update bandwidth usage', {
        lease_id: lease.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const instanceIp = lease.public_ip ?? '';

    // Check egress: warning at 80%, termination at 90%
    if (lease.egress_limit_gb !== null && lease.egress_limit_gb > 0) {
      const limit = lease.egress_limit_gb;
      const warningKey = lease.id + ':egress';

      if (egressGb > limit * BANDWIDTH_ENFORCEMENT_RATIO) {
        log.warn('lease exceeded egress limit (90% threshold), terminating', {
          lease_id: lease.id,
          egress_gb: egressGb,
          limit_gb: limit,
        });
        await this.terminateForBandwidth(lease, 'egress limit exceeded');
        return;
      } else if (egressGb > limit * BANDWIDTH_WARNING_RATIO && !this.warningsSent.get(warningKey)) {
        this.warningsSent.set(warningKey, true);
        if (this.notifier) {
          try {
            await this.notifier.sendBandwidthWarning(
              lease.id,
              lease.resource_id,
              lease.payer_address,
              instanceIp,
              'egress',
              egressGb,
              limit,
            );
          } catch (err) {
            log.error('failed to send bandwidth warning webhook', {
              lease_id: lease.id,
              metric_type: 'egress',
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          metrics.leaseBandwidthWarningsTotal.inc();
          log.warn('lease approaching egress limit (80% threshold)', {
            lease_id: lease.id,
            egress_gb: egressGb,
            limit_gb: limit,
          });
        }
      }
    }

    // Check ingress: warning at 80%, termination at 90%
    if (lease.ingress_limit_gb !== null && lease.ingress_limit_gb > 0) {
      const limit = lease.ingress_limit_gb;
      const warningKey = lease.id + ':ingress';

      if (ingressGb > limit * BANDWIDTH_ENFORCEMENT_RATIO) {
        log.warn('lease exceeded ingress limit (90% threshold), terminating', {
          lease_id: lease.id,
          ingress_gb: ingressGb,
          limit_gb: limit,
        });
        await this.terminateForBandwidth(lease, 'ingress limit exceeded');
        return;
      } else if (ingressGb > limit * BANDWIDTH_WARNING_RATIO && !this.warningsSent.get(warningKey)) {
        this.warningsSent.set(warningKey, true);
        if (this.notifier) {
          try {
            await this.notifier.sendBandwidthWarning(
              lease.id,
              lease.resource_id,
              lease.payer_address,
              instanceIp,
              'ingress',
              ingressGb,
              limit,
            );
          } catch (err) {
            log.error('failed to send bandwidth warning webhook', {
              lease_id: lease.id,
              metric_type: 'ingress',
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          metrics.leaseBandwidthWarningsTotal.inc();
          log.warn('lease approaching ingress limit (80% threshold)', {
            lease_id: lease.id,
            ingress_gb: ingressGb,
            limit_gb: limit,
          });
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // terminateForBandwidth: terminate a lease that exceeded bandwidth
  // -----------------------------------------------------------------------

  private async terminateForBandwidth(
    lease: LeaseRow,
    reason: string,
  ): Promise<void> {
    metrics.leaseBandwidthTerminationsTotal.inc();

    // Terminate the EC2 instance
    if (lease.instance_id) {
      try {
        await this.ec2Manager.terminateInstance(lease.instance_id);
      } catch (err) {
        log.error('failed to terminate instance for bandwidth exceeded', {
          lease_id: lease.id,
          instance_id: lease.instance_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Mark lease as failed
    try {
      await this.db
        .updateTable('leases')
        .set({
          status: 'failed',
          error_message: reason,
        })
        .where('id', '=', lease.id)
        .execute();
    } catch (err) {
      log.error('failed to update lease to failed for bandwidth exceeded', {
        lease_id: lease.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Prune from warningsSent
    this.warningsSent.delete(lease.id + ':egress');
    this.warningsSent.delete(lease.id + ':ingress');

    // Credit payer proportionally for remaining time
    await this.creditProportional(lease);

    // Attempt to delete per-lease security group
    if (lease.security_group_id) {
      try {
        await this.ec2Manager.deleteSecurityGroup(lease.security_group_id);
        await this.db
          .updateTable('leases')
          .set({ security_group_id: null })
          .where('id', '=', lease.id)
          .execute();
      } catch (err) {
        log.warn('failed to delete per-lease SG after bandwidth termination (will retry via cleanup worker)', {
          lease_id: lease.id,
          sg_id: lease.security_group_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // creditProportional: credit payer for remaining unused lease time
  // -----------------------------------------------------------------------

  private async creditProportional(lease: LeaseRow): Promise<void> {
    const now = Date.now();
    const createdAt = new Date(lease.created_at).getTime();
    const expiresAt = new Date(lease.expires_at).getTime();
    const totalDuration = expiresAt - createdAt;
    const remaining = expiresAt - now;

    if (totalDuration <= 0 || remaining <= 0 || lease.amount_paid <= 0n) {
      return;
    }

    // Calculate proportional refund: (remaining / total) * amountPaid
    let fraction = remaining / totalDuration;
    if (fraction > 1.0) fraction = 1.0;

    const creditAmount = BigInt(Math.floor(fraction * Number(lease.amount_paid)));
    if (creditAmount <= 0n) return;

    try {
      await this.db
        .insertInto('credits')
        .values({
          payer_address: lease.payer_address,
          amount: creditAmount,
          reason: 'bandwidth_overage_proportional_credit',
          source_tx_hash: lease.payment_tx_hash,
        })
        .execute();
      log.info('Credited payer proportionally for bandwidth overage termination', {
        lease_id: lease.id,
        payer: lease.payer_address,
        credit_amount: creditAmount.toString(),
        original_amount: lease.amount_paid.toString(),
        remaining_fraction: fraction,
      });
    } catch (err) {
      log.error('failed to credit payer for bandwidth overage', {
        lease_id: lease.id,
        payer: lease.payer_address,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -----------------------------------------------------------------------
  // getNetworkMetric: retrieve total network bytes from CloudWatch
  // -----------------------------------------------------------------------

  private async getNetworkMetric(
    instanceId: string,
    metricName: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    const input: GetMetricStatisticsCommandInput = {
      Namespace: 'AWS/EC2',
      MetricName: metricName,
      Dimensions: [
        {
          Name: 'InstanceId',
          Value: instanceId,
        },
      ],
      StartTime: start,
      EndTime: end,
      Period: 300, // 5 minutes
      Statistics: ['Sum'],
    };

    const result = await this.cw.getMetricStatistics(input);

    // Sum all data points to get total bytes
    let totalBytes = 0;
    if (result.Datapoints) {
      for (const dp of result.Datapoints) {
        if (dp.Sum !== undefined) {
          totalBytes += dp.Sum;
        }
      }
    }

    return totalBytes;
  }

  // -----------------------------------------------------------------------
  // updateBandwidthCheckedAt: update usage and checked_at timestamp
  // -----------------------------------------------------------------------

  private async updateBandwidthCheckedAt(
    leaseId: string,
    egressGb: number,
    ingressGb: number,
  ): Promise<void> {
    await this.db
      .updateTable('leases')
      .set({
        egress_used_gb: egressGb,
        ingress_used_gb: ingressGb,
        bandwidth_checked_at: new Date(),
      })
      .where('id', '=', leaseId)
      .execute();
  }
}
