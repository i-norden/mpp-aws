import client from 'prom-client';

// Collect default Node.js metrics (GC, event loop, memory, etc.)
client.collectDefaultMetrics();

// --- Lambda Invocation Metrics ---

export const invocationsTotal = new client.Counter({
  name: 'lambda_proxy_invocations_total',
  help: 'Total number of Lambda invocations',
  labelNames: ['function', 'status'] as const,
});

export const invocationDuration = new client.Histogram({
  name: 'lambda_proxy_invocation_duration_seconds',
  help: 'Lambda invocation duration in seconds',
  labelNames: ['function'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// --- Payment Metrics ---

export const paymentsTotal = new client.Counter({
  name: 'lambda_proxy_payments_total',
  help: 'Total number of payment operations',
  labelNames: ['operation', 'status'] as const,
});

export const paymentAmount = new client.Histogram({
  name: 'lambda_proxy_payment_amount_usdc',
  help: 'Payment amounts in atomic USDC (6 decimals)',
  labelNames: ['function'] as const,
  buckets: [1000, 5000, 10000, 50000, 100000, 500000, 1000000],
});

export const revenueTotal = new client.Counter({
  name: 'lambda_proxy_revenue_total_usdc',
  help: 'Total revenue in atomic USDC (6 decimals)',
  labelNames: ['function'] as const,
});

// --- Rate Limiting ---

export const rateLimitHits = new client.Counter({
  name: 'lambda_proxy_rate_limit_hits_total',
  help: 'Total number of rate limit rejections',
  labelNames: ['limiter'] as const,
});

// --- Connections ---

export const activeConnections = new client.Gauge({
  name: 'lambda_proxy_active_connections',
  help: 'Number of active connections',
});

// --- Facilitator / MPP Metrics ---

export const facilitatorLatency = new client.Histogram({
  name: 'lambda_proxy_facilitator_latency_seconds',
  help: 'Facilitator API latency in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

export const facilitatorErrors = new client.Counter({
  name: 'lambda_proxy_facilitator_errors_total',
  help: 'Total number of facilitator API errors',
  labelNames: ['operation', 'error_type'] as const,
});

// --- HTTP Request Metrics ---

export const requestsTotal = new client.Counter({
  name: 'lambda_proxy_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'] as const,
});

export const requestDuration = new client.Histogram({
  name: 'lambda_proxy_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// --- EC2 Lease Metrics ---

export const leaseAWSPricingSyncTotal = new client.Counter({
  name: 'lambda_proxy_lease_aws_pricing_sync_total',
  help: 'Total number of AWS pricing sync operations',
  labelNames: ['status'] as const,
});

export const leaseActiveLeasesGauge = new client.Gauge({
  name: 'lambda_proxy_lease_active_leases',
  help: 'Current number of active (non-terminal) leases',
});

export const leaseBandwidthTerminationsTotal = new client.Counter({
  name: 'lambda_proxy_lease_bandwidth_terminations_total',
  help: 'Total number of lease terminations due to bandwidth limit exceeded',
});

export const leaseProvisioningTotal = new client.Counter({
  name: 'lambda_proxy_lease_provisioning_total',
  help: 'Total number of lease provisioning outcomes',
  labelNames: ['status'] as const,
});

export const leaseExpiryWarningsSentTotal = new client.Counter({
  name: 'lambda_proxy_lease_expiry_warnings_sent_total',
  help: 'Total number of lease expiry warning notifications sent',
});

export const leaseBandwidthWarningsTotal = new client.Counter({
  name: 'lambda_proxy_lease_bandwidth_warnings_total',
  help: 'Total number of lease bandwidth usage warnings sent (80% threshold)',
});

// --- Refund & Nonce Metrics ---

export const refundStatusUpdateFailures = new client.Counter({
  name: 'lambda_proxy_refund_status_update_failures_total',
  help: 'Total number of failed refund status DB updates (CRITICAL)',
});

export const nonceDBErrorTotal = new client.Counter({
  name: 'lambda_proxy_nonce_db_errors_total',
  help: 'Total number of nonce DB check failures (each one causes a 503)',
});

export const nonceCollisionsTotal = new client.Counter({
  name: 'lambda_proxy_nonce_collisions_total',
  help: 'Total number of payment nonces rejected as duplicates',
});

export const stuckPendingRefundsGauge = new client.Gauge({
  name: 'lambda_proxy_stuck_pending_refunds',
  help: 'Current count of refunds stuck in pending without a tx hash',
});

export const stuckPendingRefundsRecovered = new client.Counter({
  name: 'lambda_proxy_stuck_pending_refunds_recovered_total',
  help: 'Total number of stuck pending refunds auto-recovered',
});

// --- Database Metrics ---

export const dbErrorsTotal = new client.Counter({
  name: 'lambda_proxy_db_errors_total',
  help: 'Total number of database errors',
  labelNames: ['operation'] as const,
});

// --- Wallet Metrics ---

export const refundWalletUSDCBalance = new client.Gauge({
  name: 'lambda_proxy_refund_wallet_usdc_balance',
  help: 'Current USDC balance of the refund wallet (atomic USDC)',
});

export const refundWalletETHBalance = new client.Gauge({
  name: 'lambda_proxy_refund_wallet_eth_balance',
  help: 'Current ETH balance of the refund wallet (wei)',
});

// --- Security Metrics ---

export const ofacBlockedTotal = new client.Counter({
  name: 'lambda_proxy_ofac_blocks_total',
  help: 'Total requests blocked due to OFAC sanctioned addresses',
  labelNames: ['endpoint'] as const,
});

export const ssrfBlocksTotal = new client.Counter({
  name: 'lambda_proxy_ssrf_blocks_total',
  help: 'Total requests blocked by SSRF URL validation',
});

export const authFailuresTotal = new client.Counter({
  name: 'lambda_proxy_auth_failures_total',
  help: 'Total authentication failures',
  labelNames: ['auth_type'] as const,
});

// --- Helper functions matching Go's metrics package ---

export function recordInvocation(fn: string, success: boolean, durationSeconds: number, amountPaid: bigint) {
  const status = success ? 'success' : 'failure';
  invocationsTotal.inc({ function: fn, status });
  invocationDuration.observe({ function: fn }, durationSeconds);
  if (amountPaid > 0n) {
    paymentAmount.observe({ function: fn }, Number(amountPaid));
    revenueTotal.inc({ function: fn }, Number(amountPaid));
  }
}

export function recordPayment(operation: string, success: boolean) {
  paymentsTotal.inc({ operation, status: success ? 'success' : 'failure' });
}

export function recordFacilitatorCall(operation: string, durationSeconds: number, err?: Error) {
  facilitatorLatency.observe({ operation }, durationSeconds);
  if (err) {
    facilitatorErrors.inc({ operation, error_type: 'request_error' });
  }
}

export function recordDBError(operation: string) {
  dbErrorsTotal.inc({ operation });
}

export function recordRateLimit(limiterName: string) {
  rateLimitHits.inc({ limiter: limiterName });
}

// Export the registry for the /metrics endpoint
export const register = client.register;
