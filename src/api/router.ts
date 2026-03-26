/**
 * Router assembly for the TypeScript service.
 *
 * This is the single source of truth for HTTP routing. Handler creation,
 * middleware wiring, and rate-limiter construction all happen here so the
 * top-level server module can call `createRouter(deps)` and get a fully
 * configured Hono app.
 */

import { Hono } from 'hono';
import type { Kysely } from 'kysely';

import type { Config } from '../config/index.js';
import { adminEnabled } from '../config/index.js';
import type { Database } from '../db/types.js';
import type { MPPServer } from '../mpp/client.js';
import type { PricingEngine } from '../pricing/engine.js';
import type { BillingService } from '../billing/service.js';
import type { LambdaInvoker } from '../lambda/invoker.js';
import type { OFACChecker } from '../ofac/checker.js';
import type { RefundService } from '../refund/service.js';
import type { PriceCalculator } from '../aws-pricing/calculator.js';

// Middleware
import { corsMiddleware } from './middleware/cors.js';
import { createPaymentMiddleware, type PaymentStore } from './middleware/mpp.js';
import { adminAuthMiddleware } from './middleware/admin-auth.js';
import { jsonSerializationMiddleware } from './middleware/json.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { requestLoggingMiddleware } from './middleware/logging.js';
import {
  rateLimitMiddleware,
  ipKeyFunc,
  addressKeyFunc,
} from '../ratelimit/middleware.js';
import { createRateLimiter } from '../ratelimit/factory.js';

// Handlers
import { createHealthHandlers } from './handlers/health.js';
import { createInvokeHandlers } from './handlers/invoke.js';
import { createBatchHandlers } from './handlers/batch.js';
import { createFunctionsHandlers } from './handlers/functions.js';
import { createRegisterHandlers } from './handlers/register.js';
import { createJobsHandlers } from './handlers/jobs.js';
import { createBudgetsHandlers } from './handlers/budgets.js';
import { createCreditsHandlers } from './handlers/credits.js';
import { createEarningsHandlers } from './handlers/earnings.js';
import { createOwnerHandlers } from './handlers/owner.js';
import { createLeaseHandlers } from './handlers/lease.js';
import { createAdminHandlers } from './handlers/admin.js';

// Metrics (for /metrics endpoint)
import { register } from '../metrics/index.js';

// ---------------------------------------------------------------------------
// Lease / EC2 types (optional dependencies)
// ---------------------------------------------------------------------------

// Re-export the EC2Manager interface from the worker module so the server
// can pass in the concrete implementation without importing worker.ts.
export type { EC2Manager } from '../lease/worker.js';

// LeaseService is only needed when leases are enabled.
import type { LeaseService } from '../lease/service.js';
export type { LeaseService } from '../lease/service.js';

// ---------------------------------------------------------------------------
// RouterDeps
// ---------------------------------------------------------------------------

export interface RouterDeps {
  config: Config;
  db: Kysely<Database>;
  mppServer: MPPServer;
  pricingEngine: PricingEngine;
  billingService: BillingService;
  lambdaInvoker: LambdaInvoker;
  paymentStore?: PaymentStore;
  leaseService?: LeaseService;
  ec2Manager?: import('../lease/worker.js').EC2Manager;
  priceCalculator?: PriceCalculator;
  ofacChecker?: OFACChecker | null;
  refundService?: RefundService | null;
  collectionService?: RefundService | null;
}

// ---------------------------------------------------------------------------
// OpenAPI stub (mirrors Go's OpenAPISpec)
// ---------------------------------------------------------------------------

function openAPISpec(cfg: Config): object {
  return {
    openapi: '3.0.3',
    info: {
      title: 'MMP AWS Compute Marketplace',
      description: 'MPP-powered AWS Lambda & EC2 compute marketplace',
      version: '0.1.0',
    },
    servers: cfg.publicURL
      ? [{ url: cfg.publicURL }]
      : [{ url: `http://localhost:${cfg.port}` }],
    paths: {
      '/health': { get: { summary: 'Health check', tags: ['Health'] } },
      '/health/live': { get: { summary: 'Liveness probe', tags: ['Health'] } },
      '/health/ready': { get: { summary: 'Readiness probe', tags: ['Health'] } },
      '/pricing': { get: { summary: 'Get pricing information', tags: ['Public'] } },
      '/functions': { get: { summary: 'List available functions', tags: ['Public'] } },
      '/functions/search': { get: { summary: 'Search functions', tags: ['Public'] } },
      '/functions/{name}/analytics': { get: { summary: 'Function analytics', tags: ['Public'] } },
      '/invoke/{function}': { post: { summary: 'Invoke a function (payment required)', tags: ['Invoke'] } },
      '/invoke/{function}/batch': { post: { summary: 'Batch invoke (payment required)', tags: ['Invoke'] } },
      '/credits/{address}': { get: { summary: 'Get credit balance', tags: ['Credits'] } },
      '/credits/{address}/history': { get: { summary: 'Credit history', tags: ['Credits'] } },
      '/credits/{address}/redeem': { post: { summary: 'Redeem credits', tags: ['Credits'] } },
      '/earnings/{address}': { get: { summary: 'Get earnings balance', tags: ['Earnings'] } },
      '/earnings/{address}/history': { get: { summary: 'Earnings history', tags: ['Earnings'] } },
      '/earnings/{address}/functions': { get: { summary: 'Earnings by function', tags: ['Earnings'] } },
      '/earnings/{address}/withdraw': { post: { summary: 'Withdraw earnings', tags: ['Earnings'] } },
      '/metrics': { get: { summary: 'Prometheus metrics', tags: ['Monitoring'] } },
    },
  };
}

// ---------------------------------------------------------------------------
// createRouter
// ---------------------------------------------------------------------------

export function createRouter(deps: RouterDeps): Hono {
  const { config: cfg } = deps;

  const app = new Hono();

  // =========================================================================
  // Global middleware
  // =========================================================================

  app.use('*', requestIdMiddleware());
  app.use('*', jsonSerializationMiddleware());
  app.use('*', requestLoggingMiddleware());
  app.use('*', corsMiddleware(cfg.corsAllowedOrigins));

  // =========================================================================
  // Rate limiters
  // =========================================================================

  const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

  const globalLimiter = createRateLimiter(
    { rate: cfg.globalRateLimit, burst: cfg.globalRateBurst, cleanupIntervalMs: CLEANUP_INTERVAL_MS },
    cfg.redisURL,
    'rl:global:',
  );

  const perAddressLimiter = createRateLimiter(
    { rate: cfg.perAddressRateLimit, burst: cfg.perAddressRateBurst, cleanupIntervalMs: CLEANUP_INTERVAL_MS },
    cfg.redisURL,
    'rl:addr:',
  );

  const publicRateLimit = rateLimitMiddleware(globalLimiter, ipKeyFunc);
  const creditRateLimit = rateLimitMiddleware(perAddressLimiter, addressKeyFunc);
  const ownerRateLimit = rateLimitMiddleware(perAddressLimiter, addressKeyFunc);

  // =========================================================================
  // Payment middleware
  // =========================================================================

  const { requirePayment } = createPaymentMiddleware({
    mppServer: deps.mppServer,
    cfg,
    store: deps.paymentStore,
    ofacChecker: deps.ofacChecker ?? undefined,
  });

  // =========================================================================
  // Handler modules
  // =========================================================================

  const healthHandlers = createHealthHandlers(deps.db);
  const invokeHandlers = createInvokeHandlers({
    db: deps.db,
    config: cfg,
    pricingEngine: deps.pricingEngine,
    billingService: deps.billingService,
    lambdaInvoker: deps.lambdaInvoker,
    ofacChecker: deps.ofacChecker ?? undefined,
  });
  const batchHandlers = createBatchHandlers({
    db: deps.db,
    config: cfg,
    pricingEngine: deps.pricingEngine,
    lambdaInvoker: deps.lambdaInvoker,
  });
  const functionsHandlers = createFunctionsHandlers({
    db: deps.db,
    config: cfg,
    pricingEngine: deps.pricingEngine,
  });
  const registerHandlers = createRegisterHandlers({
    db: deps.db,
    config: cfg,
    pricingEngine: deps.pricingEngine,
    ofacChecker: deps.ofacChecker ?? undefined,
  });
  const jobsHandlers = createJobsHandlers({
    db: deps.db,
    config: cfg,
    pricingEngine: deps.pricingEngine,
  });
  const budgetsHandlers = createBudgetsHandlers({
    db: deps.db,
    config: cfg,
  });
  const creditsHandlers = createCreditsHandlers({
    db: deps.db,
    config: cfg,
    billingService: deps.billingService,
    ofacChecker: deps.ofacChecker ?? undefined,
  });
  const earningsHandlers = createEarningsHandlers({
    db: deps.db,
    config: cfg,
    billingService: deps.billingService,
    ofacChecker: deps.ofacChecker ?? undefined,
  });
  const ownerHandlers = createOwnerHandlers({
    db: deps.db,
    config: cfg,
    pricingEngine: deps.pricingEngine,
    ofacChecker: deps.ofacChecker ?? undefined,
  });

  // =========================================================================
  // Root endpoint -- OpenAPI specification (self-describing API)
  // Also available at /spec.json for compatibility
  // =========================================================================

  const openAPIHandler = (c: import('hono').Context) => c.json(openAPISpec(cfg));
  app.get('/', openAPIHandler);
  app.get('/spec.json', openAPIHandler);

  // =========================================================================
  // Public endpoints (no payment required)
  // Note: /health and /functions are NOT rate limited -- informational
  // endpoints that should always be available.
  // =========================================================================

  app.get('/health', healthHandlers.handleHealth);
  app.get('/health/live', healthHandlers.handleHealthLive);
  app.get('/health/ready', healthHandlers.handleHealthReady);
  app.get('/pricing', publicRateLimit, (c) => {
    return c.json({
      baseFee: String(cfg.baseFee),
      memoryRatePer128MB: String(cfg.memoryRatePer128MB),
      durationRatePer100ms: String(cfg.durationRatePer100ms),
      feePercentage: String(cfg.feePercentage),
      paymentAsset: 'USDC',
      paymentMethod: 'MPP',
      network: cfg.network,
    });
  });
  app.get('/functions', functionsHandlers.handleListFunctions);
  app.get('/metrics', async (c) => {
    const metrics = await register.metrics();
    return c.text(metrics, 200, { 'Content-Type': register.contentType });
  });

  // Public search and analytics endpoints
  app.get('/functions/search', publicRateLimit, functionsHandlers.handleSearchFunctions);
  app.get('/functions/:name/analytics', publicRateLimit, functionsHandlers.handleGetFunctionAnalytics);

  // =========================================================================
  // Protected endpoints (payment required) -- /invoke
  // =========================================================================

  app.post(
    '/invoke/:function',
    requirePayment(invokeHandlers.getInvokeAmount, invokeHandlers.getInvokeDescription),
    invokeHandlers.handleInvoke,
  );
  app.post(
    '/invoke/:function/batch',
    requirePayment(batchHandlers.getBatchInvokeAmount, batchHandlers.getBatchInvokeDescription),
    batchHandlers.handleBatchInvoke,
  );

  // =========================================================================
  // Pay-to-register endpoint (requires payment)
  // =========================================================================

  if (cfg.allowOpenRegister) {
    app.post(
      '/register',
      requirePayment(registerHandlers.getRegistrationFee, registerHandlers.getRegistrationDescription),
      registerHandlers.handlePublicRegister,
    );
  }

  // =========================================================================
  // Async job endpoints (requires payment for submission)
  // =========================================================================

  if (cfg.asyncJobsEnabled) {
    app.post(
      '/jobs/:function',
      requirePayment(jobsHandlers.getJobAmount, jobsHandlers.getJobDescription),
      jobsHandlers.handleSubmitJob,
    );
    app.get('/jobs', jobsHandlers.handleListJobs);
    app.get('/jobs/:jobId', jobsHandlers.handleGetJob);
  }

  // =========================================================================
  // Pre-authorized budget endpoints
  // =========================================================================

  app.post(
    '/budgets',
    requirePayment(budgetsHandlers.getBudgetAmount, budgetsHandlers.getBudgetDescription),
    budgetsHandlers.handleCreateBudget,
  );
  app.get('/budgets', budgetsHandlers.handleListBudgets);
  app.get('/budgets/:budgetId', budgetsHandlers.handleGetBudget);
  app.delete('/budgets/:budgetId', budgetsHandlers.handleRevokeBudget);

  // =========================================================================
  // Credit management endpoints (authenticated, address-based)
  // Rate limited per-address to prevent enumeration attacks
  // =========================================================================

  app.get('/credits/:address', creditRateLimit, creditsHandlers.handleGetCredits);
  app.get('/credits/:address/history', creditRateLimit, creditsHandlers.handleListCredits);
  app.post('/credits/:address/redeem', creditRateLimit, creditsHandlers.handleRedeemCredits);

  // =========================================================================
  // Function access management (owner-authenticated)
  // =========================================================================

  app.post('/functions/:name/access', ownerHandlers.handleManageAccess);
  app.get('/functions/:name/access', ownerHandlers.handleGetAccess);

  // =========================================================================
  // Owner self-service (EIP-191 signature authenticated, rate-limited per address)
  // =========================================================================

  app.get('/functions/:name/details', ownerRateLimit, ownerHandlers.handleOwnerGetFunction);
  app.patch('/functions/:name', ownerRateLimit, ownerHandlers.handleOwnerUpdateFunction);
  app.post('/functions/:name/disable', ownerRateLimit, ownerHandlers.handleOwnerDisableFunction);
  app.post('/functions/:name/enable', ownerRateLimit, ownerHandlers.handleOwnerEnableFunction);
  app.post('/functions/:name/transfer', ownerRateLimit, ownerHandlers.handleOwnerTransferRequest);
  app.post('/functions/:name/transfer/accept', ownerRateLimit, ownerHandlers.handleOwnerTransferAccept);
  app.delete('/functions/:name/transfer', ownerRateLimit, ownerHandlers.handleOwnerCancelTransfer);

  // =========================================================================
  // Earnings management (address-authenticated, rate-limited)
  // =========================================================================

  app.get('/earnings/:address', creditRateLimit, earningsHandlers.handleGetEarnings);
  app.get('/earnings/:address/history', creditRateLimit, earningsHandlers.handleListEarnings);
  app.get('/earnings/:address/functions', creditRateLimit, earningsHandlers.handleGetEarningsByFunction);
  app.post('/earnings/:address/withdraw', creditRateLimit, earningsHandlers.handleWithdrawEarnings);

  // =========================================================================
  // EC2 Lease endpoints (with dedicated rate limiter)
  // =========================================================================

  if (cfg.leaseEnabled) {
    const leaseHandlers = createLeaseHandlers({
      db: deps.db,
      config: cfg,
      leaseService: deps.leaseService,
      priceCalculator: deps.priceCalculator,
      ec2Manager: deps.ec2Manager,
    });

    const leaseLimiter = createRateLimiter(
      { rate: cfg.leaseRateLimit, burst: cfg.leaseRateBurst, cleanupIntervalMs: CLEANUP_INTERVAL_MS },
      cfg.redisURL,
      'rl:lease:',
    );
    const leaseRateLimit = rateLimitMiddleware(leaseLimiter, ipKeyFunc);

    app.get('/lease/resources', leaseRateLimit, leaseHandlers.listResources);
    app.post(
      '/lease/:resourceId',
      leaseRateLimit,
      requirePayment(leaseHandlers.getLeaseAmount, leaseHandlers.getLeaseDescription),
      leaseHandlers.createLease,
    );
    app.get('/lease/:resourceId/:leaseId/status', leaseRateLimit, leaseHandlers.getLeaseStatus);
    app.patch(
      '/lease/:resourceId/:leaseId/renew',
      leaseRateLimit,
      requirePayment(leaseHandlers.getRenewalAmount, leaseHandlers.getRenewalDescription),
      leaseHandlers.renewLease,
    );
  }

  // =========================================================================
  // Admin endpoints (API key or EIP-191 signature required)
  // =========================================================================

  if (adminEnabled(cfg)) {
    const adminLimiter = createRateLimiter(
      { rate: 5, burst: 10, cleanupIntervalMs: CLEANUP_INTERVAL_MS },
      cfg.redisURL,
      'rl:admin:',
    );

    const adminHandlers = createAdminHandlers({
      db: deps.db,
      config: cfg,
      pricingEngine: deps.pricingEngine,
      refundService: deps.refundService ?? null,
      collectionService: deps.collectionService ?? null,
    });

    const adminRateLimit = rateLimitMiddleware(adminLimiter, ipKeyFunc);
    const adminAuth = adminAuthMiddleware(cfg.adminAPIKey, cfg.adminAddresses, deps.db);

    // Function management
    app.get('/admin/functions', adminRateLimit, adminAuth, adminHandlers.handleAdminListFunctions);
    app.post('/admin/functions', adminRateLimit, adminAuth, adminHandlers.handleAdminRegisterFunction);
    app.delete('/admin/functions/:name', adminRateLimit, adminAuth, adminHandlers.handleAdminDeleteFunction);
    app.get('/admin/stats/:function', adminRateLimit, adminAuth, adminHandlers.handleAdminGetStats);

    // Lease management
    app.get('/admin/leases', adminRateLimit, adminAuth, adminHandlers.handleAdminListLeases);
    app.get('/admin/leases/summary', adminRateLimit, adminAuth, adminHandlers.handleAdminLeaseSummary);
    app.get('/admin/leases/:id', adminRateLimit, adminAuth, adminHandlers.handleAdminGetLease);
    app.post('/admin/leases/:id/terminate', adminRateLimit, adminAuth, adminHandlers.handleAdminTerminateLease);
    app.post('/admin/leases/:id/extend', adminRateLimit, adminAuth, adminHandlers.handleAdminExtendLease);
    app.delete('/admin/leases/:id/data', adminRateLimit, adminAuth, adminHandlers.handleAdminDeleteLeaseData);

    // Billing & financial reporting
    app.get('/admin/billing/summary', adminRateLimit, adminAuth, adminHandlers.handleAdminBillingSummary);
    app.get('/admin/billing/invocations', adminRateLimit, adminAuth, adminHandlers.handleAdminBillingInvocations);
    app.get('/admin/billing/refunds', adminRateLimit, adminAuth, adminHandlers.handleAdminBillingRefunds);
    app.get('/admin/billing/credits', adminRateLimit, adminAuth, adminHandlers.handleAdminBillingCredits);
    app.get('/admin/billing/earnings', adminRateLimit, adminAuth, adminHandlers.handleAdminBillingEarnings);

    // Resource management
    app.get('/admin/resources', adminRateLimit, adminAuth, adminHandlers.handleAdminListResources);
    app.post('/admin/resources', adminRateLimit, adminAuth, adminHandlers.handleAdminCreateResource);
    app.put('/admin/resources/:id', adminRateLimit, adminAuth, adminHandlers.handleAdminUpdateResource);
    app.delete('/admin/resources/:id', adminRateLimit, adminAuth, adminHandlers.handleAdminDeleteResource);
    app.get('/admin/resources/:id/utilization', adminRateLimit, adminAuth, adminHandlers.handleAdminResourceUtilization);

    // Audit log
    app.get('/admin/audit', adminRateLimit, adminAuth, adminHandlers.handleAdminAuditLog);

    // Reconciliation
    app.post('/admin/reconciliation/run', adminRateLimit, adminAuth, adminHandlers.handleAdminRunReconciliation);
    app.get('/admin/reconciliation/latest', adminRateLimit, adminAuth, adminHandlers.handleAdminGetReconciliation);

    // Monitoring
    app.get('/admin/monitoring/snapshot', adminRateLimit, adminAuth, adminHandlers.handleAdminMonitoringSnapshot);
    app.get('/admin/monitoring/config', adminRateLimit, adminAuth, adminHandlers.handleAdminMonitoringConfig);

    // Wallet operations
    app.get('/admin/wallet/balance', adminRateLimit, adminAuth, adminHandlers.handleAdminWalletBalance);
    app.get('/admin/wallet/collection/balance', adminRateLimit, adminAuth, adminHandlers.handleAdminCollectionBalance);
    app.post('/admin/wallet/sweep', adminRateLimit, adminAuth, adminHandlers.handleAdminWalletSweep);
    app.post('/admin/wallet/collection/sweep', adminRateLimit, adminAuth, adminHandlers.handleAdminCollectionSweep);
  }

  return app;
}
