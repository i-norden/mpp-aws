/**
 * Comprehensive OpenAPI 3.0.3 specification for the MMP AWS Compute Marketplace.
 * Dynamically builds paths based on feature flags (leaseEnabled, asyncJobsEnabled, etc.).
 */

import type { Config } from '../config/index.js';

const errorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string', description: 'Machine-readable error code' },
    message: { type: 'string', description: 'Human-readable error description' },
    requestId: { type: 'string', description: 'Correlation ID from X-Request-Id header' },
    details: { description: 'Optional structured error details' },
  },
  required: ['error', 'message'],
};

const addressParam = {
  name: 'address',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
  description: 'Ethereum address (checksummed or lowercase)',
};

const paginationParams = [
  { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 }, description: 'Max results to return' },
  { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 }, description: 'Number of results to skip' },
];

const authHeaders = [
  { name: 'X-Signature', in: 'header', required: true, schema: { type: 'string' }, description: 'EIP-191 signature' },
  { name: 'X-Message', in: 'header', required: true, schema: { type: 'string' }, description: "Signed message: 'open-compute:{address}:{timestamp}:{nonce}'" },
];

const paymentResponses = {
  '402': {
    description: 'Payment Required - returns MPP challenge in WWW-Authenticate header',
    content: { 'application/json': { schema: { type: 'object', properties: {
      error: { type: 'string', enum: ['payment_required'] },
      message: { type: 'string' },
      amount: { type: 'string', description: 'Required payment in atomic USDC' },
    }}}},
  },
};

export function buildOpenAPISpec(cfg: Config): object {
  const paths: Record<string, object> = {};

  // Health
  paths['/health'] = { get: { summary: 'Health check', tags: ['Health'], responses: { '200': { description: 'Service healthy' } } } };
  paths['/health/live'] = { get: { summary: 'Liveness probe', tags: ['Health'], responses: { '200': { description: 'Process alive' } } } };
  paths['/health/ready'] = { get: { summary: 'Readiness probe', tags: ['Health'], responses: { '200': { description: 'Ready to serve' }, '503': { description: 'Not ready' } } } };

  // Public discovery
  paths['/pricing'] = { get: { summary: 'Get current pricing rates', tags: ['Discovery'], responses: { '200': { description: 'Pricing information' } } } };
  paths['/functions'] = { get: {
    summary: 'List available functions', tags: ['Discovery'],
    parameters: [
      { name: 'tags', in: 'query', schema: { type: 'string' }, description: 'Comma-separated tags to filter by' },
      { name: 'format', in: 'query', schema: { type: 'string', enum: ['full', 'simple', 'anthropic', 'openai'] }, description: 'Response format' },
    ],
    responses: { '200': { description: 'Function listing' } },
  }};
  paths['/functions/search'] = { get: {
    summary: 'Full-text search functions', tags: ['Discovery'],
    parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' }],
    responses: { '200': { description: 'Search results' } },
  }};
  paths['/functions/{name}/analytics'] = { get: { summary: 'Function usage analytics', tags: ['Discovery'], parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Analytics data' } } } };
  paths['/metrics'] = { get: { summary: 'Prometheus metrics', tags: ['Monitoring'], responses: { '200': { description: 'Prometheus text format' } } } };

  // Invocation (payment required)
  paths['/invoke/{function}'] = { post: {
    summary: 'Invoke a Lambda function or HTTP endpoint', tags: ['Compute'],
    description: 'Requires MPP payment. Send request without auth to get 402 challenge, then retry with payment credential.',
    parameters: [{ name: 'function', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: { content: { 'application/json': { schema: { type: 'object', description: 'Function-specific input payload' } } } },
    responses: { '200': { description: 'Invocation result with billing details' }, ...paymentResponses, '404': { description: 'Function not found' } },
  }};
  paths['/invoke/{function}/batch'] = { post: {
    summary: 'Batch invoke a function', tags: ['Compute'],
    parameters: [{ name: 'function', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { inputs: { type: 'array', items: { type: 'object' } }, concurrency: { type: 'integer' } } } } } },
    responses: { '200': { description: 'Batch results' }, ...paymentResponses },
  }};

  // Registration
  if (cfg.allowOpenRegister) {
    paths['/register'] = { post: {
      summary: 'Register an HTTPS endpoint (payment required)', tags: ['Registration'],
      requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['endpoint', 'description'], properties: {
        endpoint: { type: 'string', format: 'uri' },
        description: { type: 'string' },
        visibility: { type: 'string', enum: ['public', 'private'] },
        pricingModel: { type: 'string', enum: ['fixed', 'metered'] },
        customCostPerRequest: { type: 'string' },
      }}}}},
      responses: { '200': { description: 'Registration result' }, ...paymentResponses },
    }};
  }

  // Credits
  paths['/credits/{address}'] = { get: { summary: 'Get credit balance', tags: ['Credits'], parameters: [addressParam, ...authHeaders], responses: { '200': { description: 'Credit balance' }, '401': { description: 'Authentication required' } } } };
  paths['/credits/{address}/history'] = { get: { summary: 'Credit transaction history', tags: ['Credits'], parameters: [addressParam, ...authHeaders, ...paginationParams, { name: 'cursor', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Cursor for keyset pagination' }], responses: { '200': { description: 'Credit history' } } } };
  paths['/credits/{address}/redeem'] = { post: { summary: 'Redeem credits on-chain', tags: ['Credits'], parameters: [addressParam, ...authHeaders], responses: { '200': { description: 'Redemption result with tx hash' } } } };
  paths['/credits/{address}/voucher'] = { post: { summary: 'Redeem a voucher code', tags: ['Credits'], parameters: [addressParam, ...authHeaders], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['voucher_id'], properties: { voucher_id: { type: 'string' } } } } } }, responses: { '200': { description: 'Voucher redeemed' }, '409': { description: 'Already redeemed' } } } };

  // Earnings
  paths['/earnings/{address}'] = { get: { summary: 'Get earnings balance', tags: ['Earnings'], parameters: [addressParam, ...authHeaders], responses: { '200': { description: 'Earnings balance' } } } };
  paths['/earnings/{address}/history'] = { get: { summary: 'Earnings transaction history', tags: ['Earnings'], parameters: [addressParam, ...authHeaders], responses: { '200': { description: 'Earnings history' } } } };
  paths['/earnings/{address}/functions'] = { get: { summary: 'Earnings breakdown by function', tags: ['Earnings'], parameters: [addressParam, ...authHeaders], responses: { '200': { description: 'Per-function earnings' } } } };
  paths['/earnings/{address}/withdraw'] = { post: { summary: 'Withdraw earnings on-chain', tags: ['Earnings'], parameters: [addressParam, ...authHeaders], responses: { '200': { description: 'Withdrawal result' } } } };

  // Budgets
  paths['/budgets'] = { post: {
    summary: 'Create pre-authorized spending budget (payment required)', tags: ['Budgets'],
    requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['amount_atomic_usdc'], properties: {
      amount_atomic_usdc: { type: 'string' }, expires_in_hours: { type: 'integer' },
      allowed_functions: { type: 'array', items: { type: 'string' } },
      max_per_invocation: { type: 'string' },
    }}}}},
    responses: { '201': { description: 'Budget created' }, ...paymentResponses },
  }, get: { summary: 'List budgets', tags: ['Budgets'], parameters: authHeaders, responses: { '200': { description: 'Budget list' } } } };
  paths['/budgets/{budgetId}'] = { get: { summary: 'Get budget details', tags: ['Budgets'], parameters: [{ name: 'budgetId', in: 'path', required: true, schema: { type: 'string' } }, ...authHeaders], responses: { '200': { description: 'Budget details' } } }, delete: { summary: 'Revoke budget', tags: ['Budgets'], responses: { '200': { description: 'Budget revoked' } } } };

  // Owner self-service
  paths['/functions/{name}/details'] = { get: { summary: 'Get function details (owner)', tags: ['Owner'], parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }, ...authHeaders], responses: { '200': { description: 'Function details' } } } };
  paths['/functions/{name}'] = { patch: { summary: 'Update function metadata (owner)', tags: ['Owner'], responses: { '200': { description: 'Updated' } } } };
  paths['/functions/{name}/disable'] = { post: { summary: 'Disable function', tags: ['Owner'], responses: { '200': { description: 'Disabled' } } } };
  paths['/functions/{name}/enable'] = { post: { summary: 'Enable function', tags: ['Owner'], responses: { '200': { description: 'Enabled' } } } };
  paths['/functions/{name}/transfer'] = { post: { summary: 'Initiate ownership transfer', tags: ['Owner'], responses: { '200': { description: 'Transfer initiated' } } } };
  paths['/functions/{name}/transfer/accept'] = { post: { summary: 'Accept ownership transfer', tags: ['Owner'], responses: { '200': { description: 'Transfer accepted' } } } };
  paths['/functions/{name}/access'] = {
    post: { summary: 'Grant/revoke access list entry', tags: ['Owner'], responses: { '200': { description: 'Access updated' } } },
    get: { summary: 'List access list entries', tags: ['Owner'], responses: { '200': { description: 'Access list' } } },
  };

  // Async jobs
  if (cfg.asyncJobsEnabled) {
    paths['/jobs/{function}'] = { post: { summary: 'Submit async job (payment required)', tags: ['Jobs'], responses: { '202': { description: 'Job submitted' }, ...paymentResponses } } };
    paths['/jobs'] = { get: { summary: 'List your jobs', tags: ['Jobs'], responses: { '200': { description: 'Job list' } } } };
    paths['/jobs/{jobId}'] = { get: { summary: 'Get job status and result', tags: ['Jobs'], responses: { '200': { description: 'Job details' } } } };
  }

  // EC2 Leases
  if (cfg.leaseEnabled) {
    paths['/lease/resources'] = { get: { summary: 'List available EC2 instance types', tags: ['Lease'], responses: { '200': { description: 'Resource listing with pricing' } } } };
    paths['/lease/{resourceId}'] = { post: { summary: 'Lease an EC2 instance (payment required)', tags: ['Lease'], responses: { '201': { description: 'Lease created with SSH credentials' }, ...paymentResponses } } };
    paths['/lease/{resourceId}/{leaseId}/status'] = { get: { summary: 'Get lease provisioning status', tags: ['Lease'], responses: { '200': { description: 'Lease status' } } } };
    paths['/lease/{resourceId}/{leaseId}/renew'] = { patch: { summary: 'Renew lease (payment required)', tags: ['Lease'], responses: { '200': { description: 'Lease renewed' }, ...paymentResponses } } };
  }

  // Admin (only documented if enabled)
  paths['/admin/functions'] = { get: { summary: 'List all functions', tags: ['Admin'], security: [{ AdminApiKey: [] }] }, post: { summary: 'Register function', tags: ['Admin'] } };
  paths['/admin/leases'] = { get: { summary: 'List all leases', tags: ['Admin'] } };
  paths['/admin/billing/summary'] = { get: { summary: 'Billing summary', tags: ['Admin'] } };
  paths['/admin/vouchers'] = { post: { summary: 'Create voucher', tags: ['Admin'] }, get: { summary: 'List vouchers', tags: ['Admin'] } };
  paths['/admin/vouchers/{voucherId}'] = { delete: { summary: 'Revoke voucher', tags: ['Admin'] } };
  paths['/admin/gdpr/delete'] = { post: { summary: 'GDPR right-to-erasure', tags: ['Admin'] } };
  paths['/admin/retention/run'] = { post: { summary: 'Run data retention cleanup', tags: ['Admin'] } };
  paths['/admin/monitoring/snapshot'] = { get: { summary: 'Metrics snapshot', tags: ['Admin'] } };
  paths['/admin/monitoring/table-sizes'] = { get: { summary: 'Database table sizes', tags: ['Admin'] } };
  paths['/admin/refunds/monitoring'] = { get: { summary: 'Pending/stuck refund monitoring', tags: ['Admin'] } };
  paths['/admin/refunds/history'] = { get: { summary: 'Refund history by address', tags: ['Admin'] } };
  paths['/admin/reconciliation/run'] = { post: { summary: 'Run on-chain reconciliation', tags: ['Admin'] } };
  paths['/admin/reconciliation/latest'] = { get: { summary: 'Latest reconciliation report', tags: ['Admin'] } };
  paths['/admin/wallet/balance'] = { get: { summary: 'Refund wallet balance', tags: ['Admin'] } };
  paths['/admin/wallet/sweep'] = { post: { summary: 'Sweep wallet to treasury', tags: ['Admin'] } };

  return {
    openapi: '3.0.3',
    info: {
      title: 'MMP AWS Compute Marketplace',
      description: 'Pay-per-use AWS Lambda & EC2 compute marketplace powered by the Machine Payments Protocol (MPP). Payments are made in USDC on Base via the HTTP 402 challenge/credential/receipt flow.',
      version: '0.1.0',
    },
    servers: cfg.publicURL
      ? [{ url: cfg.publicURL }]
      : [{ url: `http://localhost:${cfg.port}` }],
    tags: [
      { name: 'Health', description: 'Liveness and readiness probes' },
      { name: 'Discovery', description: 'Function discovery and pricing' },
      { name: 'Compute', description: 'Lambda and HTTP endpoint invocation' },
      { name: 'Credits', description: 'Credit balance and redemption' },
      { name: 'Earnings', description: 'Function owner earnings' },
      { name: 'Budgets', description: 'Pre-authorized spending budgets' },
      { name: 'Owner', description: 'Function owner self-service' },
      { name: 'Jobs', description: 'Async job submission and polling' },
      { name: 'Lease', description: 'EC2 instance leasing' },
      { name: 'Registration', description: 'Public endpoint registration' },
      { name: 'Admin', description: 'Administrative endpoints (API key required)' },
      { name: 'Monitoring', description: 'Metrics and observability' },
    ],
    paths,
    components: {
      schemas: {
        ErrorResponse: errorSchema,
      },
      securitySchemes: {
        MppPayment: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          description: 'MPP payment credential: Authorization: Payment <credential>',
        },
        EIP191Signature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Signature',
          description: 'EIP-191 personal_sign of message: open-compute:{address}:{timestamp}:{nonce}',
        },
        AdminApiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Admin API key passed as Bearer token',
        },
      },
    },
  };
}
