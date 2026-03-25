import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Config } from '../../src/config/index.js';
import { jsonSerializationMiddleware } from '../../src/api/middleware/json.js';
import { createPaymentMiddleware } from '../../src/api/middleware/mpp.js';
import { requestIdMiddleware } from '../../src/api/middleware/request-id.js';

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
    estimatedGasCostUSD: 10n,
    durationRatePer100ms: 100n,
    facilitatorURL: 'https://facilitator.example.com',
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
  };
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

  it('advertises Payment auth and accepts Authorization: Payment', async () => {
    const cfg = createTestConfig();
    const payer = '0x00000000000000000000000000000000000000cc';
    const payload = {
      version: 1,
      scheme: 'exact',
      network: cfg.network,
      payload: {
        signature: '0xsignature',
        authorization: {
          from: payer,
          nonce: 'nonce-1',
          to: cfg.payToAddress,
          validAfter: '0',
          validBefore: '9999999999',
          value: '100',
        },
      },
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');

    const app = new Hono();
    const { requirePayment } = createPaymentMiddleware({
      cfg,
      mppClient: {
        async settle() {
          return { success: true, txHash: '0xtesthash' };
        },
        async verify() {
          return { isValid: true, payer };
        },
      } as never,
    });

    app.post(
      '/invoke/demo',
      requirePayment(() => 100n, () => 'demo charge'),
      (c) => c.json({ ok: true }),
    );

    const challengeResponse = await app.request('http://localhost/invoke/demo', {
      method: 'POST',
    });

    expect(challengeResponse.status).toBe(402);
    expect(challengeResponse.headers.get('www-authenticate')).toBe('Payment');
    expect(challengeResponse.headers.get('x-payment')).toBeTruthy();

    const paidResponse = await app.request('http://localhost/invoke/demo', {
      method: 'POST',
      headers: { Authorization: `Payment ${encodedPayload}` },
    });

    expect(paidResponse.status).toBe(200);
    expect(paidResponse.headers.get('payment-receipt')).toBeTruthy();
    await expect(paidResponse.json()).resolves.toEqual({ ok: true });
  });
});
