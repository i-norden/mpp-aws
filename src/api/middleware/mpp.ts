/**
 * MPP payment middleware for Hono.
 * Mirrors the Go middleware at mmp-compute/lambda-proxy/internal/api/middleware.go
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { MPPClient } from '../../mpp/client.js';
import type { PaymentInfo, PaymentRequirements } from '../../mpp/types.js';
import {
  createPaymentReceipt,
  createPaymentRequirements,
  decodePaymentHeader,
} from '../../mpp/types.js';
import type { Config } from '../../config/index.js';
import type { OFACChecker } from '../../ofac/checker.js';
import { validateEthAddress } from '../../validation/index.js';
import * as log from '../../logging/index.js';
import * as metrics from '../../metrics/index.js';

// ---------------------------------------------------------------------------
// Store interface (optional dependency for nonce tracking & budgets)
// ---------------------------------------------------------------------------

export interface PaymentStore {
  tryReservePaymentNonce(
    nonce: string,
    payerAddress: string,
    amount: bigint,
    resource: string,
    expiresAt: Date,
  ): Promise<{ id: number; reserved: boolean }>;

  updatePaymentNonceStatus(
    nonce: string,
    status: string,
    txHash: string,
  ): Promise<void>;

  deductBudget(
    budgetId: string,
    amount: bigint,
    functionName: string,
  ): Promise<bigint>;

  getBudget(
    budgetId: string,
  ): Promise<{ payerAddress: string } | null>;
}

// ---------------------------------------------------------------------------
// Middleware dependencies
// ---------------------------------------------------------------------------

export interface PaymentMiddlewareDeps {
  mppClient: MPPClient;
  cfg: Config;
  store?: PaymentStore;
  ofacChecker?: OFACChecker;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NONCE_EXPIRATION_DEFAULT_HOURS = 24;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PaymentRequiredResponseBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  challengeId: string;
  version: number;
  accepts: PaymentRequirements[];
  error: string;
}

function setPaymentRequiredResponse(
  c: Context,
  requirements: PaymentRequirements,
  errorMsg: string,
): Response {
  let reqJSON: string;
  try {
    reqJSON = JSON.stringify(requirements);
  } catch (err) {
    log.error('failed to marshal payment requirements', { error: String(err) });
    return c.json({ error: 'internal error preparing payment requirements' }, 500);
  }

  const encoded = Buffer.from(reqJSON).toString('base64');
  c.header('X-PAYMENT', encoded);
  c.header('WWW-Authenticate', 'Payment');

  const body: PaymentRequiredResponseBody = {
    type: 'https://paymentauth.org/problems/payment-required',
    title: 'Payment Required',
    status: 402,
    detail: errorMsg,
    challengeId: String(Date.now() * 1_000_000 + Math.floor(Math.random() * 1_000_000)),
    version: 1,
    accepts: [requirements],
    error: errorMsg,
  };

  return c.json(body, 402);
}

function isPayerAllowed(cfg: Config, payer: string): boolean {
  if (!cfg.allowedPayerAddresses || cfg.allowedPayerAddresses.length === 0) {
    return true;
  }
  const lowerPayer = payer.toLowerCase();
  return cfg.allowedPayerAddresses.some(
    (addr) => addr.toLowerCase() === lowerPayer,
  );
}

function nonceExpirationMs(cfg: Config): number {
  const hours =
    cfg.nonceExpirationHours > 0
      ? cfg.nonceExpirationHours
      : NONCE_EXPIRATION_DEFAULT_HOURS;
  return hours * 60 * 60 * 1000;
}

function buildResourceURL(c: Context, cfg: Config): string {
  const url = new URL(c.req.url);
  const pathAndQuery = url.pathname + url.search;

  if (cfg.publicURL) {
    return cfg.publicURL.replace(/\/+$/, '') + pathAndQuery;
  }

  const host = c.req.header('host');
  if (host) {
    const forwarded = c.req.header('x-forwarded-proto');
    const scheme =
      forwarded === 'http' || forwarded === 'https' ? forwarded : 'https';
    return `${scheme}://${host}${pathAndQuery}`;
  }

  return c.req.url;
}

function extractPaymentHeader(c: Context): string {
  const xPayment = c.req.header('X-PAYMENT');
  if (xPayment) return xPayment;

  const authorization = c.req.header('Authorization');
  if (authorization) {
    const spaceIdx = authorization.indexOf(' ');
    if (spaceIdx > 0) {
      const scheme = authorization.slice(0, spaceIdx);
      const normalizedScheme = scheme.toLowerCase();
      if (normalizedScheme === 'mpp' || normalizedScheme === 'payment') {
        return authorization.slice(spaceIdx + 1).trim();
      }
    }
  }

  return '';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a payment middleware factory bound to the given dependencies.
 *
 * Usage:
 * ```ts
 * const { requirePayment } = createPaymentMiddleware(deps);
 * app.post('/invoke/:function', requirePayment(getAmount, getDescription), handler);
 * ```
 */
export function createPaymentMiddleware(deps: PaymentMiddlewareDeps) {
  const { mppClient, cfg, store, ofacChecker } = deps;

  /**
   * Returns a Hono MiddlewareHandler that enforces MPP payment.
   *
   * @param getAmount  - computes the required payment amount (atomic USDC) from the request context
   * @param getDescription - computes a human-readable description of the payment
   */
  function requirePayment(
    getAmount: (c: Context) => bigint,
    getDescription: (c: Context) => string,
  ): MiddlewareHandler {
    return async (c, next) => {
      // ------------------------------------------------------------------
      // 1. Budget flow: check X-Budget-Id header
      // ------------------------------------------------------------------
      const budgetId = c.req.header('X-Budget-Id');
      if (budgetId && store) {
        const amount = getAmount(c);
        if (amount <= 0n) {
          return c.json(
            { error: 'unable to determine price for this resource' },
            400,
          );
        }

        // Extract function name for budget constraint checking
        const functionName = c.req.param('function') ?? '';

        let budgetDeductionSucceeded = false;
        try {
          const remaining = await store.deductBudget(
            budgetId,
            amount,
            functionName,
          );
          void remaining; // logged for debugging
          budgetDeductionSucceeded = true;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // Check for "not found" or "insufficient budget" style errors
          if (
            errMsg.includes('not found') ||
            errMsg.includes('no rows') ||
            errMsg.includes('insufficient')
          ) {
            // Budget insufficient or invalid -- fall through to normal payment
            log.info('budget deduction failed, falling through to payment flow', {
              error: errMsg,
            });
          } else {
            // Unexpected error -- do NOT silently fall through to direct payment.
            // The payer intended to use their budget; charging them directly would be wrong.
            log.error('budget deduction error', { error: errMsg });
            return c.json(
              { error: 'budget processing temporarily unavailable' },
              503,
            );
          }
        }

        if (budgetDeductionSucceeded) {
          // Budget deduction succeeded -- create synthetic payment info
          let budget: { payerAddress: string } | null = null;
          try {
            budget = await store.getBudget(budgetId);
          } catch (err: unknown) {
            log.error('failed to fetch budget after successful deduction', {
              error: String(err),
            });
            return c.json(
              { error: 'budget processing temporarily unavailable' },
              503,
            );
          }

          if (!budget) {
            log.error('failed to fetch budget after successful deduction', {
              error: 'budget is null',
            });
            return c.json(
              { error: 'budget processing temporarily unavailable' },
              503,
            );
          }

          const payer = budget.payerAddress;
          if (!payer) {
            log.error('budget has empty payer address', {
              error: `budgetID=${budgetId}`,
            });
            return c.json(
              { error: 'budget processing temporarily unavailable' },
              503,
            );
          }

          // OFAC check on budget payer address
          if (ofacChecker && ofacChecker.isBlocked(payer)) {
            metrics.ofacBlockedTotal.inc({ endpoint: c.req.path });
            log.warn('OFAC blocked address rejected (budget payer)', {
              payer,
            });
            return c.json(
              {
                error: 'address_blocked',
                message:
                  'This address is not permitted to use this service',
              },
              403,
            );
          }

          // Payer allowlist check on budget payer address
          if (!isPayerAllowed(cfg, payer)) {
            log.warn('payer not on allowlist (budget payer)', { payer });
            return c.json(
              {
                error: 'access_restricted',
                message:
                  'This service is currently restricted to authorized addresses only',
              },
              403,
            );
          }

          const paymentInfo: PaymentInfo = {
            amount,
            txHash: `budget:${budgetId}`,
            payer,
          };
          c.set('paymentInfo', paymentInfo);
          await next();
          return;
        }
        // Fall through to the direct payment flow below
      }

      // ------------------------------------------------------------------
      // 2. Build resource URL
      // ------------------------------------------------------------------
      const resource = buildResourceURL(c, cfg);

      // ------------------------------------------------------------------
      // 3. Extract payment header
      // ------------------------------------------------------------------
      const paymentHeader = extractPaymentHeader(c);

      // ------------------------------------------------------------------
      // 4. Calculate amount
      // ------------------------------------------------------------------
      const amount = getAmount(c);
      if (amount <= 0n) {
        log.error(
          'payment amount is zero or negative -- refusing to create a free payment requirement',
          { error: `amount=${amount}` },
        );
        return c.json(
          { error: 'unable to determine price for this resource' },
          400,
        );
      }
      const description = getDescription(c);

      // ------------------------------------------------------------------
      // 5. Create payment requirements
      // ------------------------------------------------------------------
      const requirements = createPaymentRequirements(
        cfg.payToAddress,
        amount,
        resource,
        description,
        cfg.network,
        cfg.usdcAddress,
      );

      // ------------------------------------------------------------------
      // 6. No payment header -> return 402
      // ------------------------------------------------------------------
      if (!paymentHeader) {
        return setPaymentRequiredResponse(c, requirements, 'Payment required');
      }

      // ------------------------------------------------------------------
      // 7. Decode payment header
      // ------------------------------------------------------------------
      let payload;
      try {
        payload = decodePaymentHeader(paymentHeader);
      } catch {
        return setPaymentRequiredResponse(
          c,
          requirements,
          'Invalid payment header',
        );
      }

      // ------------------------------------------------------------------
      // 8. Verify payment FIRST (before nonce reservation)
      //    This prevents attackers from reserving many nonces with invalid
      //    signatures, which would block legitimate transactions (DoS).
      // ------------------------------------------------------------------
      let verifyResp;
      try {
        verifyResp = await mppClient.verify(payload, requirements);
      } catch (err: unknown) {
        log.error('payment verification error', { error: String(err) });
        return setPaymentRequiredResponse(
          c,
          requirements,
          'Payment verification failed',
        );
      }

      if (!verifyResp.isValid) {
        const reason = verifyResp.invalidReason ?? 'Payment verification failed';
        return setPaymentRequiredResponse(c, requirements, reason);
      }

      // ------------------------------------------------------------------
      // 9. OFAC check on payer address (BEFORE settlement/nonce reservation)
      // ------------------------------------------------------------------
      const payerFromPayload = payload.payload.authorization.from;
      if (ofacChecker && ofacChecker.isBlocked(payerFromPayload)) {
        metrics.ofacBlockedTotal.inc({ endpoint: c.req.path });
        log.warn('OFAC blocked address rejected (payer)', {
          payer: payerFromPayload.toLowerCase(),
        });
        return c.json(
          {
            error: 'address_blocked',
            message: 'This address is not permitted to use this service',
          },
          403,
        );
      }

      // ------------------------------------------------------------------
      // 10. Payer allowlist check (BEFORE settlement/nonce reservation)
      // ------------------------------------------------------------------
      if (!isPayerAllowed(cfg, payerFromPayload)) {
        log.warn('payer not on allowlist', {
          payer: payerFromPayload.toLowerCase(),
        });
        return c.json(
          {
            error: 'access_restricted',
            message:
              'This service is currently restricted to authorized addresses only',
          },
          403,
        );
      }

      // ------------------------------------------------------------------
      // 11. Reserve payment nonce (AFTER verification succeeds)
      // ------------------------------------------------------------------
      const nonce = payload.payload.authorization.nonce;
      if (store && !nonce) {
        log.warn(
          'payment accepted with empty nonce -- local double-spend tracking skipped',
          { payer: payerFromPayload.toLowerCase() },
        );
      }
      if (store && nonce) {
        const expiresAt = new Date(Date.now() + nonceExpirationMs(cfg));
        try {
          const result = await store.tryReservePaymentNonce(
            nonce,
            payerFromPayload.toLowerCase(),
            amount,
            resource,
            expiresAt,
          );
          if (!result.reserved) {
            // Nonce already used - reject as double-spend attempt
            metrics.nonceCollisionsTotal.inc();
            return setPaymentRequiredResponse(
              c,
              requirements,
              'Payment nonce already used (potential double-spend)',
            );
          }
        } catch (err: unknown) {
          log.error('failed to reserve payment nonce', {
            error: String(err),
          });
          metrics.nonceDBErrorTotal.inc();
          return c.json(
            { error: 'payment processing temporarily unavailable' },
            503,
          );
        }
      }

      // ------------------------------------------------------------------
      // 12. Settle payment (NO retries -- not idempotent)
      // ------------------------------------------------------------------
      let settleResp;
      try {
        settleResp = await mppClient.settle(payload, requirements);
      } catch (err: unknown) {
        log.error('payment settlement error', { error: String(err) });
        return setPaymentRequiredResponse(
          c,
          requirements,
          'Payment settlement failed',
        );
      }

      if (!settleResp.success) {
        // Mark nonce as failed. If this update itself fails, the nonce remains
        // in "reserved" state and is effectively burned -- the client must use
        // a new nonce. This is acceptable: the payment was not settled, so no
        // funds were transferred, and nonces are single-use by design.
        if (store && nonce) {
          try {
            await store.updatePaymentNonceStatus(nonce, 'failed', '');
          } catch (err: unknown) {
            log.warn(
              'nonce status update failed after settlement failure; nonce is burned',
              { error: String(err) },
            );
          }
        }
        const reason =
          settleResp.errorReason ??
          settleResp.error ??
          'Payment settlement failed';
        return setPaymentRequiredResponse(c, requirements, reason);
      }

      // ------------------------------------------------------------------
      // 13. Update nonce status to settled on success
      // ------------------------------------------------------------------
      const txHash = settleResp.txHash ?? settleResp.transaction ?? '';
      if (store && nonce) {
        try {
          await store.updatePaymentNonceStatus(nonce, 'settled', txHash);
        } catch (err: unknown) {
          log.error('failed to update nonce status after settlement', {
            error: String(err),
          });
        }
      }

      // ------------------------------------------------------------------
      // 14. Extract and validate payer address
      // ------------------------------------------------------------------
      let payer = '';
      if (verifyResp.payer) {
        payer = verifyResp.payer.toLowerCase();
      }

      // Reject empty payer address -- it would flow into billing records,
      // credit operations, and refund logic, all of which assume a valid address.
      if (!payer) {
        log.warn('payment verified but payer address is empty');
        return c.json(
          { error: 'payment verification did not return a payer address' },
          402,
        );
      }

      // Validate payer is a well-formed Ethereum address before it flows into
      // billing, credits, and refund logic.
      try {
        validateEthAddress(payer, 'payer');
      } catch {
        log.warn('payment verified but payer address is malformed', { payer });
        return c.json(
          { error: 'invalid payer address format from facilitator' },
          402,
        );
      }

      // ------------------------------------------------------------------
      // 15. Set payment info in Hono context
      // ------------------------------------------------------------------
      const paymentInfo: PaymentInfo = {
        amount,
        txHash,
        payer,
        requirements,
      };
      c.set('paymentInfo', paymentInfo);

      // ------------------------------------------------------------------
      // 16. Set response headers
      // ------------------------------------------------------------------
      try {
        const responseHeader = {
          success: true,
          txHash,
          networkId: cfg.network,
        };
        const responseJSON = JSON.stringify(responseHeader);
        const encoded = Buffer.from(responseJSON).toString('base64');
        const paymentReceipt = createPaymentReceipt(txHash || 'unknown');
        c.header('X-PAYMENT-RESPONSE', encoded);
        c.header('Payment-Receipt', paymentReceipt);
        c.header('X-MPP-RECEIPT', paymentReceipt);
      } catch (err: unknown) {
        // Log the marshal error -- continue without the header rather than
        // failing the request.
        log.error('failed to marshal payment response header', {
          error: String(err),
        });
      }

      await next();
    };
  }

  return { requirePayment };
}

// ---------------------------------------------------------------------------
// Helper to retrieve PaymentInfo from Hono context
// ---------------------------------------------------------------------------

export function getPaymentInfo(c: Context): PaymentInfo | undefined {
  return c.get('paymentInfo') as PaymentInfo | undefined;
}
