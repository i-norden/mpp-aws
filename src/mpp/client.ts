import { CircuitBreaker } from '../circuit-breaker/index.js';
import { recordFacilitatorCall } from '../metrics/index.js';
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
} from './types.js';
import { validatePaymentAmount, MAX_PAYMENT_AMOUNT_ATOMIC } from './types.js';

export interface MPPClientConfig {
  facilitatorURL: string;
  timeoutMs?: number;
  maxRetries?: number;
  failureThreshold?: number;
  successThreshold?: number;
  breakerTimeoutMs?: number;
}

export class MPPClient {
  private readonly facilitatorURL: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly breaker: CircuitBreaker;

  constructor(config: MPPClientConfig) {
    this.facilitatorURL = config.facilitatorURL;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.breaker = new CircuitBreaker({
      failureThreshold: config.failureThreshold ?? 5,
      successThreshold: config.successThreshold ?? 2,
      timeoutMs: config.breakerTimeoutMs ?? 30_000,
      maxConcurrentInHalfOpen: 1,
    });
  }

  circuitState() {
    return this.breaker.getState();
  }

  circuitStats() {
    return this.breaker.getStats();
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    // Pre-validate
    const err = validatePaymentFields(payload, requirements);
    if (err) {
      return { isValid: false, invalidReason: err };
    }

    return this.doWithRetry(async () => {
      const enriched = { ...payload };
      if (!enriched.scheme) enriched.scheme = requirements.scheme;
      if (!enriched.network) enriched.network = requirements.network;

      const start = Date.now();
      const resp = await fetch(`${this.facilitatorURL}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          paymentPayload: enriched,
          paymentRequirements: requirements,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const duration = (Date.now() - start) / 1000;
      recordFacilitatorCall('verify', duration);

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`facilitator verify returned status ${resp.status}: ${body}`);
      }

      return (await resp.json()) as VerifyResponse;
    });
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    // Pre-validate
    const err = validatePaymentFields(payload, requirements);
    if (err) {
      return { success: false, errorReason: err };
    }

    // NO retries for settle — not idempotent
    return this.doOnce(async () => {
      const enriched = { ...payload };
      if (!enriched.scheme) enriched.scheme = requirements.scheme;
      if (!enriched.network) enriched.network = requirements.network;

      const start = Date.now();
      const resp = await fetch(`${this.facilitatorURL}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          paymentPayload: enriched,
          paymentRequirements: requirements,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const duration = (Date.now() - start) / 1000;
      recordFacilitatorCall('settle', duration);

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`facilitator settle returned status ${resp.status}: ${body}`);
      }

      return (await resp.json()) as SettleResponse;
    });
  }

  private async doOnce<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.breaker.allow()) {
      throw new Error('facilitator service unavailable (circuit open)');
    }
    try {
      const result = await fn();
      this.breaker.success();
      return result;
    } catch (err) {
      this.breaker.failure();
      throw err;
    }
  }

  private async doWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (!this.breaker.allow()) {
        throw new Error('facilitator service unavailable (circuit open)');
      }
      try {
        const result = await fn();
        this.breaker.success();
        return result;
      } catch (err) {
        this.breaker.failure();
        lastErr = err instanceof Error ? err : new Error(String(err));

        if (attempt < this.maxRetries) {
          const backoff = 100 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }
    throw lastErr;
  }
}

function validatePaymentFields(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): string | null {
  if (!payload?.payload?.authorization?.from) return 'missing required payment information';
  if (!payload.payload.authorization.value) return 'missing required payment information';
  if (!requirements?.maxAmountRequired) return 'missing required payment information';

  let paymentAmount: bigint;
  try {
    paymentAmount = BigInt(payload.payload.authorization.value);
  } catch {
    return 'invalid payment amount';
  }

  const amountErr = validatePaymentAmount(paymentAmount);
  if (amountErr) return amountErr;

  let requiredAmount: bigint;
  try {
    requiredAmount = BigInt(requirements.maxAmountRequired);
  } catch {
    return 'invalid payment amount';
  }

  if (requiredAmount <= 0n) return 'invalid payment amount';
  if (requiredAmount > MAX_PAYMENT_AMOUNT_ATOMIC) return 'payment amount exceeds maximum allowed';
  if (paymentAmount < requiredAmount) return 'payment amount is less than required';

  if (
    payload.payload.authorization.to &&
    payload.payload.authorization.to !== requirements.payTo
  ) {
    return 'payment recipient does not match requirements';
  }

  return null;
}
