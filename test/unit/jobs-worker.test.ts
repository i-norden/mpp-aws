import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AsyncJobWorker } from '../../src/jobs/worker.js';

const mocks = vi.hoisted(() => ({
  updateAsyncJobCompleted: vi.fn(),
  updateAsyncJobFailed: vi.fn(),
  getFunction: vi.fn(),
  settleInvocation: vi.fn(),
}));

vi.mock('../../src/logging/index.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../src/db/store-jobs.js', () => ({
  claimPendingAsyncJobs: vi.fn(),
  updateAsyncJobCompleted: mocks.updateAsyncJobCompleted,
  updateAsyncJobFailed: mocks.updateAsyncJobFailed,
  expirePendingAsyncJobs: vi.fn(),
  deleteExpiredAsyncJobs: vi.fn(),
}));
vi.mock('../../src/db/store-functions.js', () => ({
  getFunction: mocks.getFunction,
}));
vi.mock('../../src/invocation/settlement.js', () => ({
  settleInvocation: mocks.settleInvocation,
  isHTTPEndpoint: (arn: string) => arn.startsWith('https://'),
}));

describe('AsyncJobWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses shared settlement for completed jobs', async () => {
    mocks.getFunction.mockResolvedValueOnce({
      function_name: 'demo',
      function_arn: 'arn:aws:lambda:us-east-1:123456789012:function:demo',
      timeout_seconds: 30,
      memory_mb: 128,
    });
    mocks.settleInvocation.mockResolvedValueOnce({
      billingInput: {
        breakdown: {
          actualCloudCost: 10n,
          feeAmount: 2n,
        },
      },
      invocationId: 1,
      ownerEarning: 8n,
      actualCost: 12n,
    });

    const worker = new AsyncJobWorker({
      db: {} as any,
      lambdaInvoker: {
        invoke: vi.fn().mockResolvedValue({
          statusCode: 200,
          body: '{"ok":true}',
          success: true,
          billedDurationMs: 25,
          memoryMB: 128,
        }),
        invokeHTTPEndpoint: vi.fn(),
      } as any,
      billingService: null,
      config: {
        asyncJobMaxConcurrent: 1,
        endpointAuthKey: '',
      } as any,
    });

    await (worker as any).processJob({
      id: 'job_123',
      function_name: 'demo',
      payer_address: '0xab5801a7d398351b8be11c439e05c5b3259aec9b',
      tx_hash: '0xtx',
      input: { ok: true },
      amount_paid: 5000n,
    });

    expect(mocks.settleInvocation).toHaveBeenCalledTimes(1);
    expect(mocks.updateAsyncJobCompleted).toHaveBeenCalledWith(
      expect.anything(),
      'job_123',
      { ok: true },
      12n,
    );
    expect(mocks.updateAsyncJobFailed).not.toHaveBeenCalled();
  });
});
