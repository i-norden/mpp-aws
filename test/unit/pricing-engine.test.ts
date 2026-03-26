import { describe, expect, it } from 'vitest';

import { PricingEngine, formatUSD, type PricingEngineConfig } from '../../src/pricing/engine.js';

function defaultConfig(): PricingEngineConfig {
  return {
    baseFee: 100n,
    memoryRatePer128MB: 100n,
    durationRatePer100ms: 100n,
    feePercentage: 10n,
    minRefundThreshold: 50n,
    estimatedGasCostUSD: 10n,
  };
}

function createEngine(overrides?: Partial<PricingEngineConfig>): PricingEngine {
  return new PricingEngine({ ...defaultConfig(), ...overrides });
}

describe('PricingEngine', () => {
  // ---------------------------------------------------------------------------
  // calculateInvocationCost
  // ---------------------------------------------------------------------------

  describe('calculateInvocationCost', () => {
    it('calculates cost for 128 MB, 100 ms', () => {
      const engine = createEngine();
      // baseFee(100) + memoryUnits(1)*rate(100) + durationUnits(1)*rate(100) = 300
      const cost = engine.calculateInvocationCost(128, 100);
      expect(cost).toBe(300n);
    });

    it('calculates cost for 256 MB, 200 ms', () => {
      const engine = createEngine();
      // memoryUnits = 256/128 = 2, durationUnits = 200/100 = 2
      // baseFee(100) + 2*100 + 2*100 = 500
      const cost = engine.calculateInvocationCost(256, 200);
      expect(cost).toBe(500n);
    });

    it('calculates cost for 1024 MB, 500 ms', () => {
      const engine = createEngine();
      // memoryUnits = 1024/128 = 8, durationUnits = 500/100 = 5
      // baseFee(100) + 8*100 + 5*100 = 1400
      const cost = engine.calculateInvocationCost(1024, 500);
      expect(cost).toBe(1400n);
    });

    it('enforces minimum of 1 memory unit for small memory values', () => {
      const engine = createEngine();
      // memoryMB = 64 -> memoryUnits = 64/128 = 0 -> clamped to 1
      // durationUnits = 1
      // baseFee(100) + 1*100 + 1*100 = 300
      const cost = engine.calculateInvocationCost(64, 100);
      expect(cost).toBe(300n);
    });

    it('enforces minimum of 1 duration unit for short durations', () => {
      const engine = createEngine();
      // durationMs = 50 -> durationUnits = 50/100 = 0 -> clamped to 1
      // memoryUnits = 1
      // baseFee(100) + 1*100 + 1*100 = 300
      const cost = engine.calculateInvocationCost(128, 50);
      expect(cost).toBe(300n);
    });

    it('returns 0 for negative memory', () => {
      const engine = createEngine();
      expect(engine.calculateInvocationCost(-1, 100)).toBe(0n);
    });

    it('returns 0 for negative duration', () => {
      const engine = createEngine();
      expect(engine.calculateInvocationCost(128, -1)).toBe(0n);
    });

    it('returns capped cost for extremely large inputs', () => {
      const engine = createEngine({
        memoryRatePer128MB: 999_999_999_999_999n,
        durationRatePer100ms: 999_999_999_999_999n,
      });
      // With such large rates, multiplication should trigger overflow protection
      const cost = engine.calculateInvocationCost(10_000_000, 900_000_000);
      expect(cost).toBe(1_000_000_000_000n); // MaxCostAtomicUSDC
    });

    it('handles zero memory and duration gracefully', () => {
      const engine = createEngine();
      // memoryUnits = 0 -> clamped to 1, durationUnits = 0 -> clamped to 1
      // baseFee(100) + 1*100 + 1*100 = 300
      const cost = engine.calculateInvocationCost(0, 0);
      expect(cost).toBe(300n);
    });

    it('handles zero rates', () => {
      const engine = createEngine({ memoryRatePer128MB: 0n, durationRatePer100ms: 0n });
      // Only the base fee should be returned
      const cost = engine.calculateInvocationCost(1024, 5000);
      expect(cost).toBe(100n);
    });
  });

  // ---------------------------------------------------------------------------
  // calculateActualAWSCost
  // ---------------------------------------------------------------------------

  describe('calculateActualAWSCost', () => {
    it('calculates known AWS cost for 128 MB, 1000 ms', () => {
      const engine = createEngine();
      // cost = 128 * 1000 * 16300 / 1_000_000_000 = 2086400000 / 1e9 = 2
      const cost = engine.calculateActualAWSCost(128, 1000n);
      expect(cost).toBe(2n);
    });

    it('returns minimum cost of 1 for very small invocations', () => {
      const engine = createEngine();
      // cost = 128 * 1 * 16300 / 1e9 = 0 -> clamped to 1
      const cost = engine.calculateActualAWSCost(128, 1n);
      expect(cost).toBe(1n);
    });

    it('clamps negative duration to zero (yielding minimum cost)', () => {
      const engine = createEngine();
      // billedDurationMs < 0 -> clamped to 0 -> cost = 0 -> clamped to 1
      const cost = engine.calculateActualAWSCost(128, -5n);
      expect(cost).toBe(1n);
    });

    it('returns capped cost for overflow-triggering inputs', () => {
      const engine = createEngine();
      // mem = 10_000_000 (max), dur = 900_000_000 (max)
      // This triggers the overflow guard check
      const cost = engine.calculateActualAWSCost(10_000_000, 900_000_000n);
      expect(cost).toBeLessThanOrEqual(1_000_000_000_000n);
    });

    it('handles 0 memory (returns minimum cost)', () => {
      const engine = createEngine();
      // 0 * dur * rate / 1e9 = 0 -> clamped to 1
      const cost = engine.calculateActualAWSCost(0, 1000n);
      expect(cost).toBe(1n);
    });
  });

  // ---------------------------------------------------------------------------
  // calculateBillingBreakdown
  // ---------------------------------------------------------------------------

  describe('calculateBillingBreakdown', () => {
    it('marks refund eligible when overpayment exceeds threshold', () => {
      const engine = createEngine({
        feePercentage: 10n,
        minRefundThreshold: 50n,
        estimatedGasCostUSD: 10n,
      });
      // Pay 10000 for a tiny invocation
      const breakdown = engine.calculateBillingBreakdown(10000n, 128, 100n);

      expect(breakdown.actualCloudCost).toBeGreaterThan(0n);
      expect(breakdown.feePercentage).toBe(10n);
      expect(breakdown.grossRefund).toBeGreaterThan(0n);
      expect(breakdown.netRefund).toBeGreaterThan(0n);
      expect(breakdown.refundEligible).toBe(true);
      expect(breakdown.creditAmount).toBe(0n); // not credited when refund eligible
    });

    it('credits when gross refund is below threshold', () => {
      const engine = createEngine({
        feePercentage: 10n,
        minRefundThreshold: 1_000_000n, // very high threshold
        estimatedGasCostUSD: 10n,
      });
      // Small overpayment: net refund will be below threshold
      const breakdown = engine.calculateBillingBreakdown(100n, 128, 100n);

      // With a very high threshold the net refund is below it
      expect(breakdown.refundEligible).toBe(false);
      // creditAmount should equal grossRefund when not eligible
      if (breakdown.grossRefund > 0n) {
        expect(breakdown.creditAmount).toBe(breakdown.grossRefund);
      }
    });

    it('handles exact payment (no refund)', () => {
      const engine = createEngine();
      // Calculate exact cost then pay that amount
      const awsCost = engine.calculateActualAWSCost(128, 1000n);
      const fee = awsCost * 10n / 100n;
      const exactPayment = awsCost + fee;

      const breakdown = engine.calculateBillingBreakdown(exactPayment, 128, 1000n);
      expect(breakdown.grossRefund).toBe(0n);
      expect(breakdown.netRefund).toBe(0n);
      expect(breakdown.refundEligible).toBe(false);
      expect(breakdown.creditAmount).toBe(0n);
    });

    it('handles underpayment gracefully (no negative refund)', () => {
      const engine = createEngine();
      const breakdown = engine.calculateBillingBreakdown(1n, 1024, 10000n);
      expect(breakdown.grossRefund).toBe(0n);
      expect(breakdown.netRefund).toBe(0n);
      expect(breakdown.refundEligible).toBe(false);
    });

    it('sets fee amount based on fee percentage', () => {
      const engine = createEngine({ feePercentage: 20n });
      const breakdown = engine.calculateBillingBreakdown(100000n, 128, 1000n);
      const expectedFee = breakdown.actualCloudCost * 20n / 100n;
      expect(breakdown.feeAmount).toBe(expectedFee);
    });

    it('sets zero fee when fee percentage is zero', () => {
      const engine = createEngine({ feePercentage: 0n });
      const breakdown = engine.calculateBillingBreakdown(100000n, 128, 1000n);
      expect(breakdown.feeAmount).toBe(0n);
    });
  });

  // ---------------------------------------------------------------------------
  // calculateMaxCost
  // ---------------------------------------------------------------------------

  describe('calculateMaxCost', () => {
    it('returns a value greater than actual cost for same parameters', () => {
      const engine = createEngine();
      const maxCost = engine.calculateMaxCost(256, 30);
      const actualCost = engine.calculateActualAWSCost(256, 30000n); // 30s = 30000ms
      expect(maxCost).toBeGreaterThan(actualCost);
    });

    it('includes 10% buffer over base AWS+fee cost', () => {
      const engine = createEngine({
        baseFee: 0n,
        memoryRatePer128MB: 0n,
        durationRatePer100ms: 0n,
        feePercentage: 0n,
      });
      // With zero platform fees, the max cost should be 110% of AWS cost
      const maxCost = engine.calculateMaxCost(256, 30);
      const awsCost = engine.calculateActualAWSCost(256, 30000n);
      // totalWithBuffer = awsCost * 110 / 100
      const expectedBuffer = awsCost * 110n / 100n;
      // Max cost is the higher of totalWithBuffer vs legacyEstimate
      expect(maxCost).toBeGreaterThanOrEqual(expectedBuffer);
    });

    it('caps at MaxCostAtomicUSDC for extreme values', () => {
      const engine = createEngine({
        memoryRatePer128MB: 999_999_999_999_999n,
        durationRatePer100ms: 999_999_999_999_999n,
        feePercentage: 99n,
      });
      const maxCost = engine.calculateMaxCost(10_000_000, 900_000);
      expect(maxCost).toBe(1_000_000_000_000n);
    });
  });

  // ---------------------------------------------------------------------------
  // formatUSD
  // ---------------------------------------------------------------------------

  describe('formatUSD', () => {
    it('formats amounts under $1 with 4 decimal places', () => {
      // 5000 atomic USDC = $0.005000
      expect(formatUSD(5000n)).toBe('$0.0050');
    });

    it('formats amounts at $1+ with 2 decimal places', () => {
      // 1_500_000 atomic USDC = $1.50
      expect(formatUSD(1_500_000n)).toBe('$1.50');
    });

    it('formats zero', () => {
      expect(formatUSD(0n)).toBe('$0.0000');
    });

    it('formats exactly $1.00', () => {
      expect(formatUSD(1_000_000n)).toBe('$1.00');
    });

    it('formats large amounts', () => {
      // 100_000_000 atomic USDC = $100.00
      expect(formatUSD(100_000_000n)).toBe('$100.00');
    });

    it('is accessible via engine instance method', () => {
      const engine = createEngine();
      expect(engine.formatUSD(5000n)).toBe('$0.0050');
    });
  });

  // ---------------------------------------------------------------------------
  // getRefundConfig
  // ---------------------------------------------------------------------------

  describe('getRefundConfig', () => {
    it('returns configured refund parameters', () => {
      const engine = createEngine({
        feePercentage: 15n,
        minRefundThreshold: 200n,
        estimatedGasCostUSD: 50n,
      });
      const cfg = engine.getRefundConfig();
      expect(cfg.feePercentage).toBe(15n);
      expect(cfg.minRefundThreshold).toBe(200n);
      expect(cfg.estimatedGasCost).toBe(50n);
    });
  });
});
