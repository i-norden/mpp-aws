/**
 * Server module -- wires up all dependencies and starts the HTTP server.
 *
 * Mirrors the Go main() in mmp-compute/lambda-proxy/cmd/proxy/main.go:
 *   1. Create MPP client
 *   2. Create pricing engine
 *   3. Create billing service (with optional refund service)
 *   4. Create Lambda invoker
 *   5. Create OFAC checker
 *   6. If lease enabled: create EC2 manager, lease workers
 *   7. Build router with all deps
 *   8. Start main server + health server on separate port
 *   9. Handle graceful shutdown
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Kysely } from 'kysely';
import type { ServerType } from '@hono/node-server';

import type { Config } from './config/index.js';
import type { Database } from './db/types.js';
import { register } from './metrics/index.js';
import { logger } from './logging/index.js';

import { MPPClient } from './mpp/client.js';
import { PricingEngine } from './pricing/engine.js';
import { BillingService, type BillingStore } from './billing/service.js';
import { LambdaInvoker } from './lambda/invoker.js';
import { createOFACChecker } from './ofac/checker.js';
import type { PaymentStore } from './api/middleware/mpp.js';

import { createRouter, type RouterDeps } from './api/router.js';
import { createHealthHandlers } from './api/handlers/health.js';

// Lease imports (lazily constructed when lease is enabled)
import { EC2Manager as EC2ManagerImpl } from './ec2/manager.js';
import { ProvisioningWorker, type WorkerConfig } from './lease/worker.js';
import { ExpiryWorker, WebhookNotifier } from './lease/expiry-worker.js';
import {
  BandwidthWorker,
  CloudWatchAdapter,
  WebhookBandwidthNotifier,
} from './lease/bandwidth-worker.js';
import { PriceCalculator } from './aws-pricing/calculator.js';

// DB store functions needed for building adapters
import {
  tryReservePaymentNonce,
  updatePaymentNonceStatus,
} from './db/store-nonces.js';
import {
  deductBudget,
  getBudget,
} from './db/store-budgets.js';
import {
  getRefundBySourceTxHash,
  createRefund,
  createRefundIfNotExists,
  updateRefundStatus,
} from './db/store-refunds.js';
import {
  createCredit,
  getCreditBalance,
  reserveCreditsForRedemption,
  finalizeRedemption,
  rollbackRedemption,
} from './db/store-credits.js';
import {
  reserveEarningsForWithdrawal,
  finalizeEarningsWithdrawal,
  rollbackEarningsWithdrawal,
} from './db/store-earnings.js';

// ---------------------------------------------------------------------------
// PaymentStore adapter -- bridges the per-function DB helpers to the
// interface expected by the MPP payment middleware.
// ---------------------------------------------------------------------------

function buildPaymentStore(db: Kysely<Database>, _cfg: Config): PaymentStore {
  return {
    async tryReservePaymentNonce(
      nonce: string,
      payerAddress: string,
      amount: bigint,
      resource: string,
      expiresAt: Date,
    ) {
      return tryReservePaymentNonce(db, {
        nonce,
        payer_address: payerAddress,
        amount,
        resource,
        status: 'pending',
        expires_at: expiresAt,
      });
    },

    async updatePaymentNonceStatus(nonce: string, status: string, txHash: string) {
      await updatePaymentNonceStatus(db, nonce, status, txHash);
    },

    async deductBudget(budgetId: string, amount: bigint, functionName: string) {
      return deductBudget(db, budgetId, amount, functionName);
    },

    async getBudget(budgetId: string) {
      const budget = await getBudget(db, budgetId);
      if (!budget) return null;
      return { payerAddress: budget.payer_address };
    },
  };
}

// ---------------------------------------------------------------------------
// BillingStore adapter -- bridges per-function DB helpers to the interface
// expected by BillingService.
// ---------------------------------------------------------------------------

function buildBillingStore(db: Kysely<Database>): BillingStore {
  return {
    async getRefundBySourceTxHash(sourceTxHash: string) {
      const row = await getRefundBySourceTxHash(db, sourceTxHash);
      if (!row) return null;
      return {
        id: BigInt(row.id),
        payerAddress: row.payer_address,
        amount: BigInt(row.amount),
        status: row.status,
        sourceTxHash: row.source_tx_hash ?? undefined,
        refundTxHash: row.refund_tx_hash ?? undefined,
        errorMessage: row.error_message ?? undefined,
        gasUsed: row.gas_used ? BigInt(row.gas_used) : undefined,
      };
    },

    async createRefund(refund) {
      const id = await createRefund(db, {
        payer_address: refund.payerAddress,
        amount: refund.amount,
        status: refund.status,
        source_tx_hash: refund.sourceTxHash ?? null,
        refund_tx_hash: refund.refundTxHash ?? null,
        error_message: refund.errorMessage ?? null,
        gas_used: refund.gasUsed ?? null,
      });
      return BigInt(id);
    },

    async createRefundIfNotExists(refund) {
      const result = await createRefundIfNotExists(db, {
        payer_address: refund.payerAddress,
        amount: refund.amount,
        status: refund.status,
        source_tx_hash: refund.sourceTxHash ?? null,
        refund_tx_hash: refund.refundTxHash ?? null,
        error_message: refund.errorMessage ?? null,
        gas_used: refund.gasUsed ?? null,
      });
      return { created: result.created, id: BigInt(result.id) };
    },

    async updateRefundStatus(
      refundID: bigint,
      status: string,
      txHash: string,
      errorMsg: string,
      gasUsed: bigint,
    ) {
      await updateRefundStatus(db, Number(refundID), status, txHash, errorMsg, gasUsed);
    },

    async createCredit(credit) {
      await createCredit(db, {
        payer_address: credit.payerAddress,
        amount: credit.amount,
        reason: credit.reason,
        source_tx_hash: credit.sourceTxHash ?? null,
      });
    },

    async getCreditBalance(payerAddress: string) {
      const balance = await getCreditBalance(db, payerAddress);
      return {
        payerAddress,
        availableBalance: balance.availableBalance,
      };
    },

    async reserveCreditsForRedemption(payerAddress: string) {
      return reserveCreditsForRedemption(db, payerAddress);
    },

    async finalizeRedemption(payerAddress: string, txHash: string) {
      await finalizeRedemption(db, payerAddress, txHash);
    },

    async rollbackRedemption(payerAddress: string) {
      await rollbackRedemption(db, payerAddress);
    },

    async reserveEarningsForWithdrawal(ownerAddress: string) {
      return reserveEarningsForWithdrawal(db, ownerAddress);
    },

    async finalizeEarningsWithdrawal(ownerAddress: string, txHash: string) {
      await finalizeEarningsWithdrawal(db, ownerAddress, txHash);
    },

    async rollbackEarningsWithdrawal(ownerAddress: string) {
      await rollbackEarningsWithdrawal(db, ownerAddress);
    },
  };
}

// ---------------------------------------------------------------------------
// Stoppable workers container
// ---------------------------------------------------------------------------

interface Workers {
  provisioningWorker?: ProvisioningWorker;
  expiryWorker?: ExpiryWorker;
  bandwidthWorker?: BandwidthWorker;
}

// ---------------------------------------------------------------------------
// ServerDeps
// ---------------------------------------------------------------------------

export interface ServerDeps {
  config: Config;
  db?: Kysely<Database>;
}

// ---------------------------------------------------------------------------
// createApp -- build the full Hono app with all routes and middleware
// ---------------------------------------------------------------------------

export function createApp(deps: ServerDeps): { app: Hono; workers: Workers; billingService?: BillingService } {
  const { config: cfg, db } = deps;
  const workers: Workers = {};

  // -----------------------------------------------------------------------
  // 1. MPP Client
  // -----------------------------------------------------------------------
  const mppClient = new MPPClient({
    facilitatorURL: cfg.facilitatorURL,
    successThreshold: cfg.cbSuccessThreshold,
  });

  // -----------------------------------------------------------------------
  // 2. Pricing Engine
  // -----------------------------------------------------------------------
  const pricingEngine = new PricingEngine({
    baseFee: cfg.baseFee,
    memoryRatePer128MB: cfg.memoryRatePer128MB,
    durationRatePer100ms: cfg.durationRatePer100ms,
    feePercentage: cfg.feePercentage,
    minRefundThreshold: cfg.minRefundThreshold,
    estimatedGasCostUSD: cfg.estimatedGasCostUSD,
  });

  // -----------------------------------------------------------------------
  // 3. Billing Service (with optional refund service)
  // -----------------------------------------------------------------------
  const billingStore = db ? buildBillingStore(db) : null;
  const billingService = BillingService.create(pricingEngine, billingStore, {
    refundEnabled: cfg.refundEnabled,
    rpcUrl: cfg.rpcURL,
    refundPrivateKey: cfg.refundPrivateKey,
    usdcAddress: cfg.usdcAddress,
    chainId: cfg.chainId,
  });

  // -----------------------------------------------------------------------
  // 4. Lambda Invoker
  // -----------------------------------------------------------------------
  const lambdaInvoker = new LambdaInvoker(cfg.awsRegion, cfg.invokeTimeout);

  // -----------------------------------------------------------------------
  // 5. OFAC Checker
  // -----------------------------------------------------------------------
  const ofacChecker = createOFACChecker(
    cfg.ofacBlockedAddresses,
    cfg.ofacBlockedAddressesFile,
  );
  if (ofacChecker) {
    logger.info({ count: ofacChecker.count() }, 'OFAC checker loaded');
    ofacChecker.startPeriodicReload(60 * 60 * 1000, (count) => {
      logger.info({ count }, 'OFAC blocked addresses reloaded');
    });
  }

  // -----------------------------------------------------------------------
  // 6. Payment Store (nonce tracking + budget deductions)
  // -----------------------------------------------------------------------
  const paymentStore = db ? buildPaymentStore(db, cfg) : undefined;

  // -----------------------------------------------------------------------
  // 7. EC2 Manager, Lease Service, Workers (if lease enabled)
  // -----------------------------------------------------------------------
  let ec2Manager: EC2ManagerImpl | undefined;

  if (cfg.leaseEnabled && db) {
    ec2Manager = new EC2ManagerImpl({
      region: cfg.awsRegion,
      subnetIds: cfg.leaseSubnetIDs,
      securityGroupId: cfg.leaseSecurityGroupID,
      vpcId: cfg.leaseVPCID,
    });

    // Price calculator for dynamic pricing sync (used by lease handler)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const priceCalculator = new PriceCalculator(
      db,
      cfg.awsRegion,
      cfg.leasePriceMaxAgeHours * 60 * 60 * 1000,
    );
    void priceCalculator; // Will be wired to lease handler via router deps

    // Provisioning worker
    const workerConfig: WorkerConfig = {
      subnetIds: cfg.leaseSubnetIDs,
      securityGroupId: cfg.leaseSecurityGroupID,
      vpcId: cfg.leaseVPCID,
      maxProvisionAttempts: cfg.leaseMaxProvisionAttempts,
      provisioningTimeoutMs: cfg.leaseProvisioningTimeoutMinutes * 60 * 1000,
    };
    const provisioningWorker = new ProvisioningWorker(db, ec2Manager, workerConfig);
    provisioningWorker.start(10_000); // 10s polling
    workers.provisioningWorker = provisioningWorker;

    // Expiry worker
    const expiryWorker = new ExpiryWorker(db, ec2Manager);
    if (cfg.leaseExpiryWebhookURL) {
      const notifier = new WebhookNotifier(cfg.leaseExpiryWebhookURL);
      expiryWorker.setNotifier(notifier, cfg.leaseExpiryWarningMinutes * 60 * 1000);
    }
    expiryWorker.start(30_000); // 30s polling
    workers.expiryWorker = expiryWorker;

    // Bandwidth worker
    const cloudWatch = new CloudWatchAdapter(cfg.awsRegion);
    const bandwidthWorker = new BandwidthWorker(
      db,
      cloudWatch,
      ec2Manager,
      cfg.leaseBandwidthCheckSeconds * 1000,
    );
    if (cfg.leaseExpiryWebhookURL) {
      bandwidthWorker.setNotifier(new WebhookBandwidthNotifier(cfg.leaseExpiryWebhookURL));
    }
    bandwidthWorker.start();
    workers.bandwidthWorker = bandwidthWorker;

    logger.info('EC2 lease system initialized with provisioning, expiry, and bandwidth workers');
  }

  // -----------------------------------------------------------------------
  // 8. Build router with all deps
  // -----------------------------------------------------------------------
  const routerDeps: RouterDeps = {
    config: cfg,
    db: db!,
    mppClient,
    pricingEngine,
    billingService,
    lambdaInvoker,
    paymentStore,
    ec2Manager,
    ofacChecker,
  };

  const app = createRouter(routerDeps);

  return { app, workers, billingService };
}

// ---------------------------------------------------------------------------
// startServer -- starts main + health servers, wires up graceful shutdown
// ---------------------------------------------------------------------------

export function startServer(
  app: Hono,
  config: Config,
  opts?: {
    workers?: Workers;
    billingService?: BillingService;
    db?: Kysely<Database>;
  },
) {
  const port = parseInt(config.port, 10);
  const healthPort = parseInt(config.healthPort, 10);

  // Main server
  const mainServer = serve({
    fetch: app.fetch,
    port,
  });
  logger.info({ port }, `Main server listening on port ${port}`);

  // Health server on a separate port (for k8s probes behind a service mesh)
  let healthServer: ServerType | undefined;
  if (healthPort && healthPort !== port) {
    const healthApp = new Hono();
    const healthHandlers = createHealthHandlers(opts?.db);
    healthApp.get('/health', healthHandlers.handleHealth);
    healthApp.get('/health/live', healthHandlers.handleHealthLive);
    healthApp.get('/health/ready', healthHandlers.handleHealthReady);
    healthApp.get('/metrics', async (c) => {
      const metrics = await register.metrics();
      return c.text(metrics, 200, { 'Content-Type': register.contentType });
    });

    healthServer = serve({
      fetch: healthApp.fetch,
      port: healthPort,
    });
    logger.info({ port: healthPort }, `Health server listening on port ${healthPort}`);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal, draining...');

    // Stop lease workers first
    if (opts?.workers) {
      opts.workers.provisioningWorker?.stop();
      opts.workers.expiryWorker?.stop();
      opts.workers.bandwidthWorker?.stop();
      logger.info('Lease workers stopped');
    }

    // Close billing service (stops refund service)
    if (opts?.billingService) {
      opts.billingService.close();
      logger.info('Billing service closed');
    }

    // Close servers
    mainServer.close(() => {
      logger.info('Main server closed');
    });
    if (healthServer) {
      healthServer.close(() => {
        logger.info('Health server closed');
      });
    }

    // Close database
    if (opts?.db) {
      try {
        await opts.db.destroy();
        logger.info('Database connection pool closed');
      } catch (err) {
        logger.error({ error: err }, 'Error closing database connection');
      }
    }

    // Give connections time to drain
    setTimeout(() => {
      logger.info('Shutdown complete');
      process.exit(0);
    }, 5_000);

    // Force exit after 30s
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30_000);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return mainServer;
}
