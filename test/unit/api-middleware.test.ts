import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { Challenge, Credential, PaymentRequest } from 'mppx';

import type { Config } from '../../src/config/index.js';
import { HttpError } from '../../src/api/errors.js';
import { jsonSerializationMiddleware } from '../../src/api/middleware/json.js';
import { createPaymentMiddleware } from '../../src/api/middleware/mpp.js';
import { requestIdMiddleware } from '../../src/api/middleware/request-id.js';
import type { MPPServer, ChargeResult } from '../../src/mpp/client.js';

function createTestConfig(): Config {
  return {
    adminAPIKey: '',
    adminAddresses: [],
    allowOpenRegister: false,
    allowedPayerAddresses: [],
    asyncJobMaxConcurrent: 1,
    asyncJobMaxTTLHours: 24,
    asyncJobWorkerInterval: 5,
    asyncJobsEnabled: false,
    awsRegion: 'us-east-1',
    baseFee: 100n,
    budgetMaxAmount: 1_000_000n,
    budgetMaxTTLHours: 24,
    cbSuccessThreshold: 2,
    chainId: 84532n,
    collectionPrivateKey: '',
    corsAllowedOrigins: ['*'],
    databaseURL: '',
    endpointAuthKey: '',
    endpointVerifyTimeout: 5,
    enforceWhitelist: false,
    trustProxyHeaders: false,
    estimatedGasCostUSD: 10n,
    durationRatePer100ms: 100n,
    feePercentage: 10n,
    functionCacheTTLSeconds: 60,
    globalRateBurst: 10,
    globalRateLimit: 10,
    grafanaURL: '',
    healthPort: '8081',
    invokeTimeout: 30,
    leaseBandwidthCheckSeconds: 60,
    leaseEnabled: false,
    leaseExpiryWarningMinutes: 30,
    leaseExpiryWebhookURL: '',
    leaseMarginPercent: 20,
    leaseMaxGlobalActive: 1,
    leaseMaxPerUser: 1,
    leaseMaxProvisionAttempts: 1,
    leasePriceMaxAgeHours: 24,
    leasePricingSyncHours: 24,
    leaseProvisioningTimeoutMinutes: 15,
    leaseRateBurst: 10,
    leaseRateLimit: 10,
    leaseSecurityGroupID: '',
    leaseSubnetIDs: [],
    leaseVPCID: '',
    marketplaceFeeBps: 0,
    maxAccessListSize: 100,
    maxCodeSizeBytes: 1024,
    maxExecuteTimeout: 60,
    maxURLLength: 2048,
    memoryRatePer128MB: 100n,
    minEarningsWithdrawal: 100n,
    minRefundThreshold: 50n,
    mppSecretKey: 'test-secret-key-for-hmac',
    network: 'base-sepolia',
    nonceExpirationHours: 24,
    ofacBlockedAddresses: '',
    ofacBlockedAddressesFile: '',
    payToAddress: '0x00000000000000000000000000000000000000aa',
    perAddressRateBurst: 10,
    perAddressRateLimit: 10,
    port: '8080',
    publicURL: 'https://mmp.example.com',
    redisURL: '',
    refundAddress: '',
    refundEnabled: false,
    refundPrivateKey: '',
    registrationFee: 1_000n,
    rpcURL: 'https://rpc.example.com',
    rpcURLFallback: '',
    treasuryAddress: '',
    usdcAddress: '0x00000000000000000000000000000000000000bb',
    invocationRetentionDays: 365,
    nonceRetentionDays: 90,
    creditRetentionDays: 365,
    voucherRetentionDays: 365,
    leaseAnonymizeDays: 90,
    retentionBatchSize: 1000,
  };
}

/**
 * Helper: builds a proper mppx Authorization header for testing.
 *
 * Uses mppx SDK serialization so the credential is in the correct wire format
 * that Credential.fromRequest / Credential.deserialize can parse.
 */
function buildMppxAuthorizationHeader(
  payer: string,
  challengeId: string,
  cfg: Config,
): string {
  // Build a Challenge in the proper format
  const challenge = Challenge.from({
    id: challengeId,
    realm: cfg.publicURL || 'localhost',
    method: 'tempo',
    intent: 'charge',
    request: PaymentRequest.from({
      amount: '100',
      currency: cfg.usdcAddress,
      recipient: cfg.payToAddress,
    }),
  });

  // Build a Credential with the challenge and a test payload
  const credential = Credential.from({
    challenge,
    payload: { hash: '0xtesthash', type: 'hash' as const },
    source: `did:pkh:eip155:84532:${payer}`,
  });

  return Credential.serialize(credential);
}

describe('API middleware', () => {
  it('serializes bigint responses and propagates request ids', async () => {
    const app = new Hono();
    app.use('*', requestIdMiddleware());
    app.use('*', jsonSerializationMiddleware());
    app.get('/value', (c) =>
      c.json({
        amount: 123n,
        nested: { total: 456n },
        values: [789n],
      }),
    );

    const response = await app.request('http://localhost/value', {
      headers: { 'X-Request-Id': 'req-test-123' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req-test-123');
    await expect(response.json()).resolves.toEqual({
      amount: '123',
      nested: { total: '456' },
      values: ['789'],
    });
  });

  it('returns 402 with WWW-Authenticate when no credential is present', async () => {
    const cfg = createTestConfig();

    // Mock MPPServer -- should not be called when there's no credential
    const mockMppServer = {
      async chargeRequest(): Promise<ChargeResult> {
        throw new Error('should not be called');
      },
    } as unknown as MPPServer;

    const app = new Hono();
    const { requirePayment } = createPaymentMiddleware({
      cfg,
      mppServer: mockMppServer,
    });

    app.post(
      '/invoke/demo',
      requirePayment(() => 100n, () => 'demo charge'),
      (c) => c.json({ ok: true }),
    );

    const challengeResponse = await app.request('http://localhost/invoke/demo', {
      method: 'POST',
    });

    // No credential -> 402 with WWW-Authenticate
    expect(challengeResponse.status).toBe(402);
    expect(challengeResponse.headers.get('www-authenticate')).toBeTruthy();
    // Should also have legacy X-PAYMENT header for backward compat
    expect(challengeResponse.headers.get('x-payment')).toBeTruthy();
  });

  it('supports async payment requirement callbacks and propagates HttpError responses', async () => {
    const cfg = createTestConfig();
    const mockMppServer = {
      async chargeRequest(): Promise<ChargeResult> {
        throw new Error('should not be called');
      },
    } as unknown as MPPServer;

    const app = new Hono();
    const { requirePayment } = createPaymentMiddleware({
      cfg,
      mppServer: mockMppServer,
    });

    app.post(
      '/invoke/demo',
      requirePayment(
        async () => {
          throw new HttpError(409, 'resource unavailable');
        },
        async () => 'demo charge',
      ),
      (c) => c.json({ ok: true }),
    );

    const response = await app.request('http://localhost/invoke/demo', {
      method: 'POST',
    });

    expect(response.status).toBe(409);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
    expect(body.message).toBe('resource unavailable');
  });

  it('returns 200 with Payment-Receipt when mppx verifies successfully', async () => {
    const cfg = createTestConfig();
    const payer = '0x00000000000000000000000000000000000000cc';

    // Mock MPPServer that returns 200 with receipt
    const mockMppServer = {
      async chargeRequest(): Promise<ChargeResult> {
        return {
          status: 200,
          withReceipt: (response: Response) => {
            const headers = new Headers(response.headers);
            // Simulate mppx adding the Payment-Receipt header with a proper receipt
            const receipt = {
              method: 'tempo',
              reference: '0xtesthash',
              status: 'success',
              timestamp: '2025-01-01T00:00:00.000Z',
            };
            const encoded = Buffer.from(JSON.stringify(receipt)).toString('base64url');
            headers.set('Payment-Receipt', encoded);
            return new Response(response.body, {
              status: response.status,
              headers,
            });
          },
        };
      },
    } as unknown as MPPServer;

    const app = new Hono();
    const { requirePayment } = createPaymentMiddleware({
      cfg,
      mppServer: mockMppServer,
    });

    app.post(
      '/invoke/demo',
      requirePayment(() => 100n, () => 'demo charge'),
      (c) => c.json({ ok: true }),
    );

    // Build a properly formatted mppx credential
    const authHeader = buildMppxAuthorizationHeader(payer, 'test-challenge-id', cfg);

    const paidResponse = await app.request('http://localhost/invoke/demo', {
      method: 'POST',
      headers: { Authorization: authHeader },
    });

    expect(paidResponse.status).toBe(200);
    expect(paidResponse.headers.get('payment-receipt')).toBeTruthy();
    await expect(paidResponse.json()).resolves.toEqual({ ok: true });
  });
});
