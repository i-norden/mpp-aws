/**
 * MPP server module -- wraps the mppx SDK's Mppx.create() + tempo.charge()
 * to handle the 402 challenge/credential/receipt flow.
 *
 * Replaces the old facilitator-based MPPClient with native on-chain
 * verification via the mppx TypeScript SDK.
 */

import { Mppx, tempo, type Store } from 'mppx/server';
import { CircuitBreaker } from '../circuit-breaker/index.js';
import { recordFacilitatorCall } from '../metrics/index.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MPPServerConfig {
  /** USDC token contract address. */
  currency: string;
  /** Recipient address that receives payments. */
  recipient: string;
  /** Whether to use testnet mode. */
  testnet?: boolean;
  /** Server realm (e.g., hostname). Auto-detected if not set. */
  realm?: string;
  /** Secret key for HMAC-bound challenge IDs (stateless verification). */
  secretKey?: string;
  /** Optional mppx Store for transaction hash replay protection. */
  store?: Store.Store;
  /** Circuit breaker: failure threshold before opening. */
  failureThreshold?: number;
  /** Circuit breaker: successes needed to close from half-open. */
  successThreshold?: number;
  /** Circuit breaker: time (ms) before half-open retry after open. */
  breakerTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Result type returned by chargeRequest()
// ---------------------------------------------------------------------------

export interface ChargeResult {
  /** 402 = challenge issued (no credential or invalid), 200 = payment verified. */
  status: 402 | 200;
  /** The 402 Response with WWW-Authenticate header (only when status === 402). */
  challengeResponse?: Response;
  /**
   * Attaches the Payment-Receipt header to your application response.
   * Only available when status === 200.
   */
  withReceipt?: (response: Response) => Response;
}

// ---------------------------------------------------------------------------
// MPPServer class
// ---------------------------------------------------------------------------

export class MPPServer {
  private readonly breaker: CircuitBreaker;
  readonly mppx: ReturnType<typeof Mppx.create<
    [ReturnType<typeof tempo.charge>],
    ReturnType<typeof import('mppx/server').Transport.http>
  >>;

  constructor(config: MPPServerConfig) {
    this.breaker = new CircuitBreaker({
      failureThreshold: config.failureThreshold ?? 5,
      successThreshold: config.successThreshold ?? 2,
      timeoutMs: config.breakerTimeoutMs ?? 30_000,
      maxConcurrentInHalfOpen: 1,
    });

    this.mppx = Mppx.create({
      methods: [
        tempo.charge({
          currency: config.currency as `0x${string}`,
          recipient: config.recipient as `0x${string}`,
          testnet: config.testnet,
          store: config.store,
        }),
      ],
      realm: config.realm,
      secretKey: config.secretKey,
    }) as ReturnType<typeof Mppx.create<
      [ReturnType<typeof tempo.charge>],
      ReturnType<typeof import('mppx/server').Transport.http>
    >>;
  }

  circuitState() {
    return this.breaker.getState();
  }

  circuitStats() {
    return this.breaker.getStats();
  }

  /**
   * Processes a charge against an incoming HTTP request.
   *
   * Uses the mppx server handler internally:
   * - If no credential is present: returns a 402 with a Challenge.
   * - If a valid credential is present: verifies on-chain and returns 200 with a receipt.
   *
   * The circuit breaker wraps the entire call. Metrics are recorded
   * the same as before (via recordFacilitatorCall).
   */
  async chargeRequest(
    request: Request,
    amount: string,
    description?: string,
  ): Promise<ChargeResult> {
    if (!this.breaker.allow()) {
      throw new Error('mppx service unavailable (circuit open)');
    }

    const start = Date.now();
    try {
      const handler = this.mppx.tempo.charge({ amount, description });
      const result = await handler(request);
      const duration = (Date.now() - start) / 1000;

      if (result.status === 402) {
        recordFacilitatorCall('challenge', duration);
        this.breaker.success();
        return {
          status: 402,
          challengeResponse: result.challenge,
        };
      }

      // status === 200, payment verified & settled
      recordFacilitatorCall('settle', duration);
      this.breaker.success();
      return {
        status: 200,
        withReceipt: result.withReceipt,
      };
    } catch (error) {
      const duration = (Date.now() - start) / 1000;
      recordFacilitatorCall(
        'settle',
        duration,
        error instanceof Error ? error : new Error(String(error)),
      );
      this.breaker.failure();
      throw error;
    }
  }
}
