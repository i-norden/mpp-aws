/**
 * Provisioning worker for EC2 lease instances.
 * TypeScript port of mmp-compute/lambda-proxy/internal/lease/worker.go
 *
 * Polls for pending leases, launches EC2 instances, and monitors
 * provisioning status until instances are running or failed.
 */

import type { Kysely, Selectable } from 'kysely';
import type { Database, LeaseTable } from '../db/types.js';
import * as log from '../logging/index.js';
import * as metrics from '../metrics/index.js';

// ---------------------------------------------------------------------------
// EC2 Manager interface (matches Go ec2.Manager)
// ---------------------------------------------------------------------------

export interface InstanceInfo {
  instanceId: string;
  publicIp: string;
  state: string; // 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated'
}

export interface LaunchParams {
  instanceType: string;
  amiId: string;
  subnetId: string;
  securityGroupId: string;
  sshPublicKey: string;
  sshUser: string;
  leaseId: string;
  resourceId: string;
  payerAddress: string;
  expiresAt: string;
  volumeSize: number;
  associatePublicIp: boolean;
}

export interface SecurityGroupParams {
  vpcId: string;
  leaseId: string;
  sshCidrs?: string[];
}

export interface EC2Manager {
  launchInstance(params: LaunchParams): Promise<InstanceInfo>;
  describeInstance(instanceId: string): Promise<InstanceInfo>;
  terminateInstance(instanceId: string): Promise<void>;
  createSecurityGroup(params: SecurityGroupParams): Promise<string>;
  deleteSecurityGroup(securityGroupId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Lease row type (selected from the leases table)
// ---------------------------------------------------------------------------

/** Lease row as returned by Kysely selectAll() / returningAll(). */
export type LeaseRow = Selectable<LeaseTable>;

// ---------------------------------------------------------------------------
// Worker config
// ---------------------------------------------------------------------------

export interface WorkerConfig {
  subnetIds: string[];
  securityGroupId: string;   // fallback shared security group
  vpcId: string;             // VPC ID for per-lease SG creation
  maxProvisionAttempts: number;
  provisioningTimeoutMs: number; // max time a lease can stay in provisioning
}

// ---------------------------------------------------------------------------
// Helper: delete per-lease security group if present
// ---------------------------------------------------------------------------

export async function deleteSGIfPresent(
  db: Kysely<Database>,
  ec2Manager: EC2Manager,
  lease: LeaseRow,
): Promise<void> {
  if (!lease.security_group_id) return;

  try {
    await ec2Manager.deleteSecurityGroup(lease.security_group_id);
  } catch (err) {
    log.warn('failed to delete per-lease SG (will retry via cleanup worker)', {
      lease_id: lease.id,
      sg_id: lease.security_group_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  try {
    await db
      .updateTable('leases')
      .set({ security_group_id: null })
      .where('id', '=', lease.id)
      .execute();
  } catch (err) {
    log.error('failed to clear security_group_id after deletion', {
      lease_id: lease.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// ProvisioningWorker
// ---------------------------------------------------------------------------

export class ProvisioningWorker {
  private readonly db: Kysely<Database>;
  private readonly ec2Manager: EC2Manager;
  private readonly config: WorkerConfig;
  private subnetIdx = 0;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(db: Kysely<Database>, ec2Manager: EC2Manager, config: WorkerConfig) {
    this.db = db;
    this.ec2Manager = ec2Manager;
    this.config = config;
  }

  /**
   * Start the provisioning worker polling loop.
   * @param intervalMs - polling interval in milliseconds
   */
  start(intervalMs: number): void {
    if (this.intervalHandle) return;
    log.info('ProvisioningWorker started', { intervalMs });
    this.intervalHandle = setInterval(() => {
      this.tick().catch((err) => {
        log.error('ProvisioningWorker tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);
  }

  /** Stop the provisioning worker. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      log.info('ProvisioningWorker stopped');
    }
  }

  private async tick(): Promise<void> {
    await this.processPending();
    await this.checkProvisioning();
  }

  // -----------------------------------------------------------------------
  // processPending: claim and launch EC2 instances for pending leases
  // -----------------------------------------------------------------------

  private async processPending(): Promise<void> {
    let leases: LeaseRow[];
    try {
      // Atomically claim pending leases (CAS-style: set status to 'provisioning'
      // for up to 10 pending leases that haven't exceeded max attempts).
      const rows = await this.db
        .updateTable('leases')
        .set({ status: 'provisioning' })
        .where('id', 'in',
          this.db
            .selectFrom('leases')
            .select('id')
            .where('status', '=', 'pending')
            .where('provision_attempts', '<', this.config.maxProvisionAttempts)
            .limit(10)
        )
        .returningAll()
        .execute();
      leases = rows;
    } catch (err) {
      log.error('failed to claim pending leases', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const lease of leases) {
      await this.launchInstance(lease);
    }
  }

  // -----------------------------------------------------------------------
  // launchInstance: attempt to launch an EC2 instance for a lease
  // -----------------------------------------------------------------------

  private async launchInstance(lease: LeaseRow): Promise<void> {
    // Get resource for AMI and instance type
    let resource;
    try {
      resource = await this.db
        .selectFrom('lease_resources')
        .selectAll()
        .where('id', '=', lease.resource_id)
        .executeTakeFirst();
    } catch (err) {
      log.error('failed to get resource for lease', {
        lease_id: lease.id,
        resource_id: lease.resource_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!resource) {
      log.error('resource not found for lease', {
        lease_id: lease.id,
        resource_id: lease.resource_id,
      });
      await this.markFailed(lease.id, 'resource not found');
      await this.creditPayer(lease);
      return;
    }

    // Select subnet (round-robin)
    if (this.config.subnetIds.length === 0) {
      log.error('no subnet IDs configured for lease provisioning');
      return;
    }
    const subnetId = this.config.subnetIds[this.subnetIdx % this.config.subnetIds.length];
    this.subnetIdx++;

    // Determine volume size
    const volumeSize = lease.storage_gb ?? 0;

    // Create per-lease security group for isolation
    let securityGroupId = this.config.securityGroupId; // fallback
    let perLeaseSGId = '';
    if (this.config.vpcId) {
      try {
        const sgId = await this.ec2Manager.createSecurityGroup({
          vpcId: this.config.vpcId,
          leaseId: lease.id,
        });
        perLeaseSGId = sgId;
        securityGroupId = sgId;

        // Persist the SG ID so cleanup paths can find it
        try {
          await this.db
            .updateTable('leases')
            .set({ security_group_id: sgId })
            .where('id', '=', lease.id)
            .execute();
        } catch (dbErr) {
          log.error('failed to store per-lease security group ID', {
            lease_id: lease.id,
            sg_id: sgId,
            error: dbErr instanceof Error ? dbErr.message : String(dbErr),
          });
        }
      } catch (sgErr) {
        log.warn('failed to create per-lease security group, using shared SG', {
          lease_id: lease.id,
          error: sgErr instanceof Error ? sgErr.message : String(sgErr),
        });
      }
    }

    const params: LaunchParams = {
      instanceType: resource.instance_type,
      amiId: resource.ami_id,
      subnetId,
      securityGroupId,
      sshPublicKey: lease.ssh_public_key,
      sshUser: resource.ssh_user,
      leaseId: lease.id,
      resourceId: lease.resource_id,
      payerAddress: lease.payer_address,
      expiresAt: new Date(lease.expires_at).toISOString(),
      volumeSize,
      associatePublicIp: lease.has_public_ip,
    };

    let info: InstanceInfo;
    try {
      info = await this.ec2Manager.launchInstance(params);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('failed to launch EC2 instance', {
        lease_id: lease.id,
        error: errMsg,
      });

      // Clean up per-lease SG if we created one
      if (perLeaseSGId) {
        try {
          await this.ec2Manager.deleteSecurityGroup(perLeaseSGId);
          await this.db
            .updateTable('leases')
            .set({ security_group_id: null })
            .where('id', '=', lease.id)
            .execute();
        } catch (cleanupErr) {
          log.warn('failed to cleanup per-lease SG after launch failure', {
            lease_id: lease.id,
            sg_id: perLeaseSGId,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }

      // Check if max attempts reached
      if (lease.provision_attempts + 1 >= this.config.maxProvisionAttempts) {
        await this.markFailed(lease.id, 'launch failed: ' + errMsg);
        await this.creditPayer(lease);
      } else {
        // Increment attempts but keep pending for retry
        try {
          await this.db
            .updateTable('leases')
            .set({
              provision_attempts: lease.provision_attempts + 1,
              status: 'pending',
            })
            .where('id', '=', lease.id)
            .execute();
        } catch (incErr) {
          log.error('failed to increment provision attempts', {
            lease_id: lease.id,
            error: incErr instanceof Error ? incErr.message : String(incErr),
          });
        }
      }
      return;
    }

    // Update lease to provisioning with instance ID
    try {
      await this.db
        .updateTable('leases')
        .set({
          instance_id: info.instanceId,
          status: 'provisioning',
        })
        .where('id', '=', lease.id)
        .execute();
    } catch (err) {
      log.error('failed to update lease to provisioning', {
        lease_id: lease.id,
        instance_id: info.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });

      // Terminate the orphaned EC2 instance to prevent resource leak
      try {
        await this.ec2Manager.terminateInstance(info.instanceId);
      } catch (termErr) {
        log.error('CRITICAL: failed to terminate orphaned EC2 instance', {
          instance_id: info.instanceId,
          lease_id: lease.id,
          error: termErr instanceof Error ? termErr.message : String(termErr),
        });
      }
      return;
    }

    log.info('EC2 instance launched for lease', {
      lease_id: lease.id,
      instance_id: info.instanceId,
    });
  }

  // -----------------------------------------------------------------------
  // checkProvisioning: check status of provisioning leases
  // -----------------------------------------------------------------------

  private async checkProvisioning(): Promise<void> {
    let leases: LeaseRow[];
    try {
      const rows = await this.db
        .selectFrom('leases')
        .selectAll()
        .where('status', '=', 'provisioning')
        .execute();
      leases = rows;
    } catch (err) {
      log.error('failed to list provisioning leases', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const lease of leases) {
      if (!lease.instance_id) continue;

      let info: InstanceInfo;
      try {
        info = await this.ec2Manager.describeInstance(lease.instance_id);
      } catch (err) {
        log.error('failed to describe instance', {
          lease_id: lease.id,
          instance_id: lease.instance_id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      switch (info.state) {
        case 'running': {
          try {
            await this.db
              .updateTable('leases')
              .set({
                status: 'running',
                public_ip: info.publicIp || null,
                provisioned_at: new Date(),
              })
              .where('id', '=', lease.id)
              .execute();
          } catch (err) {
            log.error('failed to update lease to running', {
              lease_id: lease.id,
              error: err instanceof Error ? err.message : String(err),
            });
            continue;
          }
          metrics.leaseProvisioningTotal.inc({ status: 'success' });
          log.info('Lease is now running', {
            lease_id: lease.id,
            instance_id: info.instanceId,
            public_ip: info.publicIp,
          });
          break;
        }

        case 'terminated':
        case 'shutting-down': {
          metrics.leaseProvisioningTotal.inc({ status: 'failed' });
          await this.markFailed(lease.id, 'instance terminated unexpectedly');
          await deleteSGIfPresent(this.db, this.ec2Manager, lease);
          await this.creditPayer(lease);
          break;
        }

        default: {
          // Check for provisioning timeout
          const leaseAge = Date.now() - new Date(lease.created_at).getTime();
          if (this.config.provisioningTimeoutMs > 0 && leaseAge > this.config.provisioningTimeoutMs) {
            metrics.leaseProvisioningTotal.inc({ status: 'timeout' });
            log.warn('lease provisioning timed out, terminating', {
              lease_id: lease.id,
              instance_id: lease.instance_id,
              instance_state: info.state,
              age_ms: leaseAge,
            });

            try {
              await this.ec2Manager.terminateInstance(lease.instance_id);
            } catch (err) {
              log.error('failed to terminate timed-out instance', {
                lease_id: lease.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }

            await this.markFailed(lease.id, 'provisioning timed out');
            await deleteSGIfPresent(this.db, this.ec2Manager, lease);
            await this.creditPayer(lease);
          }
          break;
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async markFailed(leaseId: string, errorMessage: string): Promise<void> {
    try {
      await this.db
        .updateTable('leases')
        .set({
          status: 'failed',
          error_message: errorMessage,
        })
        .where('id', '=', leaseId)
        .execute();
    } catch (err) {
      log.error('failed to update lease to failed', {
        lease_id: leaseId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async creditPayer(lease: LeaseRow): Promise<void> {
    try {
      await this.db
        .insertInto('credits')
        .values({
          payer_address: lease.payer_address,
          amount: lease.amount_paid,
          reason: 'lease_provisioning_failed',
          source_tx_hash: lease.payment_tx_hash,
        })
        .execute();
      log.info('Credited payer for failed lease', {
        lease_id: lease.id,
        payer: lease.payer_address,
        amount: lease.amount_paid.toString(),
      });
    } catch (err) {
      log.error('failed to credit payer for failed lease', {
        lease_id: lease.id,
        payer: lease.payer_address,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
