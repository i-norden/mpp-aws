/**
 * Credit management handlers.
 * TypeScript port of mmp-compute/lambda-proxy/internal/api/handlers_credits.go
 *
 * Endpoints:
 *   GET  /credits/:address         - get credit balance
 *   GET  /credits/:address/history - list credit records
 *   POST /credits/:address/redeem  - redeem all credits on-chain
 *
 * All endpoints require EIP-191 signature auth via X-Signature + X-Message
 * headers, verifying the caller owns the address.
 */

import type { Context } from 'hono';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import type { Config } from '../../config/index.js';
import type { BillingService } from '../../billing/service.js';
import type { OFACChecker } from '../../ofac/checker.js';
import { verifyAddressOwnership } from '../../auth/signature.js';
import { validateEthAddress } from '../../validation/index.js';
import { getCreditBalance } from '../../db/store-credits.js';
import * as log from '../../logging/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreditsDeps {
  db: Kysely<Database> | null;
  config: Config;
  billingService: BillingService | null;
  ofacChecker?: OFACChecker | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format atomic USDC (6 decimals) as a USD string.
 */
function formatUSD(atomicAmount: bigint): string {
  const dollars = Number(atomicAmount) / 1_000_000;
  if (Math.abs(dollars) < 0.01) {
    return `$${dollars.toFixed(4)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

/**
 * Verify that the request is authenticated by the address owner.
 * Returns true if valid, false if invalid (error response already sent).
 */
async function verifyOwnership(
  c: Context,
  address: string,
): Promise<boolean> {
  const signature = c.req.header('X-Signature') ?? '';
  const message = c.req.header('X-Message') ?? '';

  if (!signature || !message) {
    c.res = c.json({
      error: 'authentication required',
      message: 'X-Signature and X-Message headers are required to access credit information',
      hint: "Sign a message in format 'open-compute:{address}:{timestamp}:{nonce}' with your wallet",
    }, 401) as unknown as Response;
    return false;
  }

  const result = await verifyAddressOwnership(signature, message, address);
  if (!result.valid) {
    c.res = c.json({
      error: 'authentication failed',
      message: result.errorMessage,
    }, 401) as unknown as Response;
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// createCreditsHandlers
// ---------------------------------------------------------------------------

export function createCreditsHandlers(deps: CreditsDeps) {
  const { db, config, billingService, ofacChecker } = deps;

  // -------------------------------------------------------------------
  // handleGetCredits -- GET /credits/:address
  // -------------------------------------------------------------------

  async function handleGetCredits(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    const rawAddress = c.req.param('address') ?? '';
    if (!rawAddress) {
      return c.json({ error: 'address is required' }, 400);
    }
    try {
      validateEthAddress(rawAddress, 'address');
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const address = rawAddress.toLowerCase();

    if (!(await verifyOwnership(c, address))) {
      return c.res;
    }

    try {
      const balance = await getCreditBalance(db, address);

      return c.json({
        address,
        availableBalance: Number(balance.availableBalance),
        availableUSD: formatUSD(balance.availableBalance),
        totalCredited: Number(balance.totalCredits),
        totalRedeemed: Number(balance.totalRedeemed),
        creditCount: Number(balance.totalCredits),
      });
    } catch (err) {
      log.error('failed to get credit balance', {
        payer: address,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to get credit balance' }, 500);
    }
  }

  // -------------------------------------------------------------------
  // handleListCredits -- GET /credits/:address/history
  // -------------------------------------------------------------------

  async function handleListCredits(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    const rawAddress = c.req.param('address') ?? '';
    if (!rawAddress) {
      return c.json({ error: 'address is required' }, 400);
    }
    try {
      validateEthAddress(rawAddress, 'address');
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const address = rawAddress.toLowerCase();

    if (!(await verifyOwnership(c, address))) {
      return c.res;
    }

    const includeRedeemed = c.req.query('include_redeemed') === 'true';

    try {
      let query = db
        .selectFrom('credits')
        .selectAll()
        .where('payer_address', '=', address)
        .orderBy('created_at', 'desc')
        .limit(100);

      if (!includeRedeemed) {
        query = query.where('withdrawal_status', '=', 'available');
      }

      const credits = await query.execute();

      interface CreditEntry {
        id: number;
        amount: number;
        amountUSD: string;
        reason: string;
        sourceTxHash?: string;
        redeemed: boolean;
        redeemedAt?: string;
        createdAt: string;
      }

      const entries: CreditEntry[] = credits.map((cr) => {
        const entry: CreditEntry = {
          id: Number(cr.id),
          amount: Number(cr.amount),
          amountUSD: formatUSD(BigInt(cr.amount)),
          reason: cr.reason,
          redeemed: cr.withdrawal_status !== 'available',
          createdAt: new Date(cr.created_at).toISOString(),
        };
        if (cr.source_tx_hash) {
          entry.sourceTxHash = cr.source_tx_hash;
        }
        if (cr.withdrawal_status !== 'available' && cr.redeemed_at) {
          entry.redeemedAt = new Date(cr.redeemed_at).toISOString();
        }
        return entry;
      });

      return c.json({
        address,
        credits: entries,
        count: entries.length,
      });
    } catch (err) {
      log.error('failed to list credits', {
        payer: address,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to list credits' }, 500);
    }
  }

  // -------------------------------------------------------------------
  // handleRedeemCredits -- POST /credits/:address/redeem
  // -------------------------------------------------------------------

  async function handleRedeemCredits(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    if (!config.refundEnabled) {
      return c.json({ error: 'refunds not enabled' }, 503);
    }

    const rawAddress = c.req.param('address') ?? '';
    if (!rawAddress) {
      return c.json({ error: 'address is required' }, 400);
    }
    try {
      validateEthAddress(rawAddress, 'address');
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const address = rawAddress.toLowerCase();

    // OFAC check on credit redemption address
    if (ofacChecker && ofacChecker.isBlocked(address)) {
      return c.json({
        error: 'address_blocked',
        message: 'This address is not permitted to use this service',
      }, 403);
    }

    if (!(await verifyOwnership(c, address))) {
      return c.res;
    }

    // Get current balance
    let balance;
    try {
      balance = await getCreditBalance(db, address);
    } catch (err) {
      log.error('failed to get credit balance', {
        payer: address,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to get credit balance' }, 500);
    }

    if (balance.availableBalance <= 0n) {
      return c.json({
        error: 'no credits available',
        availableBalance: 0,
      }, 400);
    }

    // Check minimum threshold
    if (balance.availableBalance < config.minRefundThreshold) {
      return c.json({
        error: 'credit balance below minimum redemption threshold',
        availableBalance: Number(balance.availableBalance),
        availableUSD: formatUSD(balance.availableBalance),
        minimumRequired: Number(config.minRefundThreshold),
        minimumUSD: formatUSD(config.minRefundThreshold),
      }, 400);
    }

    // Check if billing service is available for redemption
    if (!billingService || !billingService.isRefundEnabled()) {
      return c.json({
        error: 'credit_redemption_unavailable',
        availableBalance: Number(balance.availableBalance),
        availableUSD: formatUSD(balance.availableBalance),
        message: 'Credit redemption service is not configured. Please contact support for manual redemption or wait for service availability.',
        configHint: 'Set REFUND_ENABLED=true and configure REFUND_PRIVATE_KEY and RPC_URL to enable automatic redemption.',
      }, 503);
    }

    // Process the redemption via billing service
    let result;
    try {
      result = await billingService.redeemCredits(address);
    } catch (err) {
      log.error('credit redemption failed', {
        payer: address,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({
        error: 'redemption_failed',
        message: 'Failed to process credit redemption',
      }, 500);
    }

    if (!result.success) {
      return c.json({
        error: 'redemption_failed',
        message: result.error,
        availableBalance: Number(result.availableBalance ?? 0n),
        availableUSD: formatUSD(result.availableBalance ?? 0n),
      }, 400);
    }

    return c.json({
      success: true,
      amountRedeemed: Number(result.amountRedeemed ?? 0n),
      amountRedeemedUSD: formatUSD(result.amountRedeemed ?? 0n),
      amountSent: Number(result.amountSent ?? 0n),
      amountSentUSD: formatUSD(result.amountSent ?? 0n),
      gasCost: Number(result.gasCost ?? 0n),
      gasCostUSD: formatUSD(result.gasCost ?? 0n),
      txHash: result.txHash,
      remainingBalance: Number(result.availableBalance ?? 0n),
    });
  }

  return {
    handleGetCredits,
    handleListCredits,
    handleRedeemCredits,
  };
}
