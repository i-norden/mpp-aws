import { describe, expect, it } from 'vitest';

import { defaultRetentionConfig } from '../../src/db/retention.js';

describe('defaultRetentionConfig', () => {
  it('returns sensible defaults', () => {
    const cfg = defaultRetentionConfig();
    expect(cfg.invocationRetentionDays).toBe(365);
    expect(cfg.nonceRetentionDays).toBe(90);
    expect(cfg.creditRetentionDays).toBe(365);
    expect(cfg.voucherRetentionDays).toBe(365);
    expect(cfg.leaseAnonymizeDays).toBe(90);
    expect(cfg.batchSize).toBe(1000);
  });

  it('all retention periods are positive', () => {
    const cfg = defaultRetentionConfig();
    expect(cfg.invocationRetentionDays).toBeGreaterThan(0);
    expect(cfg.nonceRetentionDays).toBeGreaterThan(0);
    expect(cfg.creditRetentionDays).toBeGreaterThan(0);
    expect(cfg.voucherRetentionDays).toBeGreaterThan(0);
    expect(cfg.leaseAnonymizeDays).toBeGreaterThan(0);
  });

  it('batch size is reasonable', () => {
    const cfg = defaultRetentionConfig();
    expect(cfg.batchSize).toBeGreaterThanOrEqual(100);
    expect(cfg.batchSize).toBeLessThanOrEqual(10000);
  });
});
