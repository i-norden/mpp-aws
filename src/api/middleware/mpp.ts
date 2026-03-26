/**
 * MPP payment middleware for Hono.
 *
 * Uses the mppx TypeScript SDK for the 402 challenge/credential/receipt flow
 * while preserving business logic: OFAC checks, nonce tracking, budgets,
 * payer allowlists, and legacy X-PAYMENT header support.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { Challenge, Credential, Receipt } from 'mppx';
import type { MPPServer } from '../../mpp/client.js';
import type { PaymentInfo } from '../../mpp/types.js';
import {
  createPaymentReceipt,
  extractAddressFromSource,
} from '../../mpp/types.js';
import type { Config } from '../../config/index.js';
import type { OFACChecker } from '../../ofac/checker.js';
import { validateEthAddress } from '../../validation/index.js';
import * as log from '../../logging/index.js';
import * as metrics from '../../metrics/index.js';
import { HttpError } from '../errors.js';
import { jsonWithStatus } from '../response.js';

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
  mppServer: MPPServer;
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

/**
 * Builds a 402 Payment Required response using the mppx Challenge SDK.
 *
 * Serializes a proper WWW-Authenticate header per the mppx protocol
 * and also sets the legacy X-PAYMENT header for backward compatibility.
 */
function setPaymentRequiredResponse(
  c: Context,
  cfg: Config,
  amount: string,
  resource: string,
  description: string,
  errorMsg: string,
): Response {
  try {
    const challenge = Challenge.from({
      secretKey: cfg.mppSecretKey || 'mmp-aws-default-secret',
      realm: cfg.publicURL || c.req.header('host') || 'localhost',
      method: 'tempo',
      intent: 'charge',
      description,
      request: {
        amount,
        currency: cfg.usdcAddress,
        recipient: cfg.payToAddress,
      },
    });

    const wwwAuthenticate = Challenge.serialize(challenge);
    c.header('WWW-Authenticate', wwwAuthenticate);

    // Legacy X-PAYMENT header for backward compatibility
    const legacyPayload = {
      scheme: 'exact',
      network: cfg.network,
      maxAmountRequired: amount,
      resource,
      description,
      mimeType: 'application/json',
      payTo: cfg.payToAddress,
      maxTimeoutSeconds: 60,
      asset: cfg.usdcAddress,
      outputSchema: null,
    };
    c.header('X-PAYMENT', Buffer.from(JSON.stringify(legacyPayload)).toString('base64'));

    return c.json(
      {
        type: 'https://paymentauth.org/problems/payment-required',
        title: 'Payment Required',
        status: 402,
        detail: errorMsg,
        challengeId: challenge.id,
        version: 1,
        error: errorMsg,
      },
      402,
    );
  } catch (err) {
    log.error('failed to create payment challenge', { error: String(err) });
    return c.json({ error: 'internal error preparing payment requirements' }, 500);
  }
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

/**
 * Checks whether the request carries a payment credential.
 *
 * Supports:
 * 1. Standard mppx `Authorization: Payment ...` header
 * 2. Legacy `X-PAYMENT` header
 *
 * Returns 'mppx' if a Payment scheme is present in the Authorization header,
 * 'legacy' for the old X-PAYMENT header, or null if neither is present.
 */
function detectPaymentCredential(c: Context): 'mppx' | 'legacy' | null {
  const authorization = c.req.header('Authorization');
  if (authorization) {
    const paymentScheme = Credential.extractPaymentScheme(authorization);
    if (paymentScheme) return 'mppx';
  }

  const xPayment = c.req.header('X-PAYMENT');
  if (xPayment) return 'legacy';

  return null;
}

/**
 * Attempts to extract the payer address from an mppx credential.
 * Does a lightweight parse of the credential to extract the `source` DID,
 * which contains the payer's Ethereum address.
 *
 * Returns null if parsing fails or no source DID is present.
 * This is best-effort -- if it fails, we still pass the request to mppx for
 * proper verification.
 */
function tryExtractPayerAddress(c: Context): string | null {
  const authorization = c.req.header('Authorization');
  if (!authorization) return null;

  try {
    const credential = Credential.fromRequest(c.req.raw);
    return extractAddressFromSource(credential.source);
  } catch {
    return null;
  }
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
  const { mppServer, cfg, store, ofacChecker } = deps;

  /**
   * Returns a Hono MiddlewareHandler that enforces MPP payment.
   *
   * @param getAmount  - computes the required payment amount (atomic USDC) from the request context
   * @param getDescription - computes a human-readable description of the payment
   */
  function requirePayment(
    getAmount: (c: Context) => bigint | Promise<bigint>,
    getDescription: (c: Context) => string | Promise<string>,
  ): MiddlewareHandler {
    return async (c, next) => {
      let amount: bigint;
      let description: string;
      try {
        amount = await getAmount(c);
        description = await getDescription(c);
      } catch (err) {
        if (err instanceof HttpError) {
          const body: Record<string, unknown> = { error: err.message };
          if (err.details !== undefined) {
            body.details = err.details;
          }
          return jsonWithStatus(c, body, err.status);
        }

        log.error('failed to resolve payment requirements', {
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json(
          { error: 'unable to determine price for this resource' },
          500,
        );
      }

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

      // ------------------------------------------------------------------
      // 1. Budget flow: check X-Budget-Id header
      // ------------------------------------------------------------------
      const budgetId = c.req.header('X-Budget-Id');
      if (budgetId && store) {
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
      const amountStr = amount.toString();

      // ------------------------------------------------------------------
      // 4. Detect payment credential
      // ------------------------------------------------------------------
      const credentialType = detectPaymentCredential(c);

      // ------------------------------------------------------------------
      // 5. No credential -> return 402 with mppx Challenge
      // ------------------------------------------------------------------
      if (!credentialType) {
        return setPaymentRequiredResponse(c, cfg, amountStr, resource, description, 'Payment required');
      }

      // ------------------------------------------------------------------
      // 6. Legacy X-PAYMENT header is no longer supported.
      //    Clients must use the standard mppx protocol.
      // ------------------------------------------------------------------
      if (credentialType === 'legacy') {
        return setPaymentRequiredResponse(
          c,
          cfg,
          amountStr,
          resource,
          description,
          'Legacy X-PAYMENT header is deprecated. Use Authorization: Payment ... header per the mppx protocol.',
        );
      }

      // ------------------------------------------------------------------
      // 6b. Try to extract payer address from the credential's source DID
      //     for pre-settlement OFAC/allowlist checks.
      //     This is best-effort; failures do not block the flow.
      // ------------------------------------------------------------------
      const payerFromCredential = tryExtractPayerAddress(c);

      // ------------------------------------------------------------------
      // 7. OFAC check on payer address (BEFORE settlement)
      // ------------------------------------------------------------------
      if (payerFromCredential) {
        if (ofacChecker && ofacChecker.isBlocked(payerFromCredential)) {
          metrics.ofacBlockedTotal.inc({ endpoint: c.req.path });
          log.warn('OFAC blocked address rejected (payer)', {
            payer: payerFromCredential,
          });
          return c.json(
            {
              error: 'address_blocked',
              message: 'This address is not permitted to use this service',
            },
            403,
          );
        }

        // Payer allowlist check
        if (!isPayerAllowed(cfg, payerFromCredential)) {
          log.warn('payer not on allowlist', {
            payer: payerFromCredential,
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
      }

      // ------------------------------------------------------------------
      // 8. Reserve payment nonce (BEFORE settlement, AFTER OFAC check)
      //
      //    For mppx credentials the challenge ID serves as a nonce --
      //    it is HMAC-bound to the challenge parameters.
      // ------------------------------------------------------------------
      let nonce = '';
      try {
        const credential = Credential.fromRequest(c.req.raw);
        nonce = credential.challenge?.id ?? '';
      } catch {
        // If we cannot parse the credential for nonce extraction,
        // mppx will handle the error in the charge step below.
      }
      if (store && !nonce) {
        log.warn(
          'payment accepted with empty nonce -- local double-spend tracking skipped',
          { payer: payerFromCredential ?? 'unknown' },
        );
      }
      if (store && nonce) {
        const expiresAt = new Date(Date.now() + nonceExpirationMs(cfg));
        try {
          const result = await store.tryReservePaymentNonce(
            nonce,
            (payerFromCredential ?? 'unknown').toLowerCase(),
            amount,
            resource,
            expiresAt,
          );
          if (!result.reserved) {
            metrics.nonceCollisionsTotal.inc();
            return setPaymentRequiredResponse(
              c,
              cfg,
              amountStr,
              resource,
              description,
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
      // 9. Use mppx server handler for verification + settlement
      // ------------------------------------------------------------------
      let chargeResult;
      try {
        chargeResult = await mppServer.chargeRequest(
          c.req.raw,
          amountStr,
          description,
        );
      } catch (err: unknown) {
        log.error('mppx charge error', { error: String(err) });

        // Mark nonce as failed
        if (store && nonce) {
          try {
            await store.updatePaymentNonceStatus(nonce, 'failed', '');
          } catch (nonceErr: unknown) {
            log.warn(
              'nonce status update failed after charge error; nonce is burned',
              { error: String(nonceErr) },
            );
          }
        }

        return setPaymentRequiredResponse(
          c,
          cfg,
          amountStr,
          resource,
          description,
          'Payment verification/settlement failed',
        );
      }

      // ------------------------------------------------------------------
      // 10. Handle 402 result (credential was invalid or mismatched)
      // ------------------------------------------------------------------
      if (chargeResult.status === 402) {
        // Mark nonce as failed
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

        // Return the mppx-generated 402 response directly
        // (it already has the correct WWW-Authenticate header)
        if (chargeResult.challengeResponse) {
          return chargeResult.challengeResponse;
        }

        return setPaymentRequiredResponse(
          c,
          cfg,
          amountStr,
          resource,
          description,
          'Payment verification failed',
        );
      }

      // ------------------------------------------------------------------
      // 11. Payment successful -- extract receipt and payer info
      // ------------------------------------------------------------------

      // Get the receipt by calling withReceipt on a dummy response,
      // then reading the Payment-Receipt header.
      let txHash = '';
      let payer = payerFromCredential ?? '';
      try {
        const dummyResponse = new Response(null, { status: 200 });
        const receiptResponse = chargeResult.withReceipt!(dummyResponse);
        const receiptHeader = receiptResponse.headers.get('Payment-Receipt');
        if (receiptHeader) {
          const receipt = Receipt.deserialize(receiptHeader);
          txHash = receipt.reference || '';
        }
      } catch (err: unknown) {
        log.warn('failed to extract receipt from mppx response', {
          error: String(err),
        });
      }

      // ------------------------------------------------------------------
      // 12. Update nonce status to settled on success
      // ------------------------------------------------------------------
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
      // 13. Validate payer address
      // ------------------------------------------------------------------
      if (!payer) {
        log.warn('payment verified but payer address is empty');
        return c.json(
          { error: 'payment verification did not return a payer address' },
          402,
        );
      }

      payer = payer.toLowerCase();

      // Validate payer is a well-formed Ethereum address before it flows into
      // billing, credits, and refund logic.
      try {
        validateEthAddress(payer, 'payer');
      } catch {
        log.warn('payment verified but payer address is malformed', { payer });
        return c.json(
          { error: 'invalid payer address format' },
          402,
        );
      }

      // ------------------------------------------------------------------
      // 14. Set payment info in Hono context
      // ------------------------------------------------------------------
      const paymentInfo: PaymentInfo = {
        amount,
        txHash,
        payer,
      };
      c.set('paymentInfo', paymentInfo);

      // ------------------------------------------------------------------
      // 15. Set response headers
      // ------------------------------------------------------------------
      try {
        const paymentReceipt = createPaymentReceipt(txHash || 'unknown');
        c.header('Payment-Receipt', paymentReceipt);
        c.header('X-MPP-RECEIPT', paymentReceipt);

        // Legacy X-PAYMENT-RESPONSE header for backward compatibility
        const responseHeader = {
          success: true,
          txHash,
          networkId: cfg.network,
        };
        const responseJSON = JSON.stringify(responseHeader);
        const encoded = Buffer.from(responseJSON).toString('base64');
        c.header('X-PAYMENT-RESPONSE', encoded);
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
