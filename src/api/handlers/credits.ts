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
import { verifyAddressOwnershipWithReplay } from '../../auth/signature.js';
import { validateEthAddress } from '../../validation/index.js';
import { getCreditBalance } from '../../db/store-credits.js';
import { createCredit } from '../../db/store-credits.js';
import {
  getVoucherRedemption,
  tryCreateVoucherRedemption,
  updateVoucherRedemptionStatus,
} from '../../db/store-vouchers.js';
import * as log from '../../logging/index.js';
import { jsonWithStatus } from '../response.js';

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
  db: Kysely<Database>,
  address: string,
): Promise<boolean> {
  const signature = c.req.header('X-Signature') ?? '';
  const message = c.req.header('X-Message') ?? '';

  if (!signature || !message) {
    c.res = c.json({
      error: 'authentication required',
      message: 'X-Signature and X-Message headers are required to access credit information',
      hint: "Sign a message in format 'open-compute:{address}:{timestamp}:{nonce}' with your wallet",
    }, 401);
    return false;
  }

  const result = await verifyAddressOwnershipWithReplay(db, signature, message, address);
  if (!result.valid) {
    c.res = jsonWithStatus(c, {
      error: 'authentication failed',
      message: result.errorMessage,
    }, result.statusCode ?? 401);
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

    if (!(await verifyOwnership(c, db, address))) {
      return c.res;
    }

    try {
      const balance = await getCreditBalance(db, address);

      return c.json({
        address,
        availableBalance: balance.availableBalance,
        availableUSD: formatUSD(balance.availableBalance),
        totalCredited: balance.totalCredits,
        totalRedeemed: balance.totalRedeemed,
        creditCount: balance.creditCount,
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

    if (!(await verifyOwnership(c, db, address))) {
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
        amount: bigint;
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
          amount: BigInt(cr.amount),
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

    if (!(await verifyOwnership(c, db, address))) {
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
        availableBalance: 0n,
      }, 400);
    }

    // Check minimum threshold
    if (balance.availableBalance < config.minRefundThreshold) {
      return c.json({
        error: 'credit balance below minimum redemption threshold',
        availableBalance: balance.availableBalance,
        availableUSD: formatUSD(balance.availableBalance),
        minimumRequired: config.minRefundThreshold,
        minimumUSD: formatUSD(config.minRefundThreshold),
      }, 400);
    }

    // Check if billing service is available for redemption
    if (!billingService || !billingService.isRefundEnabled()) {
      return c.json({
        error: 'credit_redemption_unavailable',
        availableBalance: balance.availableBalance,
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
        availableBalance: result.availableBalance ?? 0n,
        availableUSD: formatUSD(result.availableBalance ?? 0n),
      }, 400);
    }

    return c.json({
      success: true,
      amountRedeemed: result.amountRedeemed ?? 0n,
      amountRedeemedUSD: formatUSD(result.amountRedeemed ?? 0n),
      amountSent: result.amountSent ?? 0n,
      amountSentUSD: formatUSD(result.amountSent ?? 0n),
      gasCost: result.gasCost ?? 0n,
      gasCostUSD: formatUSD(result.gasCost ?? 0n),
      txHash: result.txHash,
      remainingBalance: result.availableBalance ?? 0n,
    });
  }

  // -------------------------------------------------------------------
  // handleRedeemVoucher -- POST /credits/:address/voucher
  // -------------------------------------------------------------------

  async function handleRedeemVoucher(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    const address = (c.req.param('address') ?? '').toLowerCase();
    try {
      validateEthAddress(address, 'address');
    } catch {
      return c.json({ error: 'invalid address format' }, 400);
    }

    if (!(await verifyOwnership(c, db, address))) {
      return c.res;
    }

    // OFAC compliance check
    if (ofacChecker && ofacChecker.isBlocked(address)) {
      return c.json({ error: 'address is blocked by compliance policy' }, 403);
    }

    const body = await c.req.json<{
      voucher_id?: string;
    }>().catch(() => ({} as { voucher_id?: string }));

    const voucherId = body.voucher_id?.trim();
    if (!voucherId) {
      return c.json({ error: 'voucher_id is required' }, 400);
    }

    // Check if voucher was already redeemed
    const existing = await getVoucherRedemption(db, voucherId);
    if (existing) {
      if (existing.status === 'success') {
        return c.json({ error: 'voucher already redeemed' }, 409);
      }
      if (existing.status === 'pending') {
        return c.json({ error: 'voucher redemption already in progress' }, 409);
      }
    }

    // Try to atomically create the redemption
    const { created } = await tryCreateVoucherRedemption(db, {
      voucherId,
      source: 'api',
      payerAddress: address,
      amount: existing?.amount ?? 0n, // Amount from voucher system
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h default
      status: 'pending',
    });

    if (!created) {
      return c.json({ error: 'voucher already redeemed' }, 409);
    }

    // Retrieve the redemption to get the full record
    const redemption = await getVoucherRedemption(db, voucherId);
    if (!redemption) {
      return c.json({ error: 'failed to process voucher' }, 500);
    }

    // Check expiry
    if (new Date(redemption.expires_at) < new Date()) {
      await updateVoucherRedemptionStatus(db, voucherId, 'failed');
      return c.json({ error: 'voucher has expired' }, 410);
    }

    // Create a credit for the voucher amount
    try {
      await createCredit(db, {
        payer_address: address,
        amount: redemption.amount,
        reason: 'voucher_redemption',
        source_tx_hash: null,
        source_invocation_id: null,
      });
      await updateVoucherRedemptionStatus(db, voucherId, 'success');
    } catch (err) {
      log.error('failed to create credit for voucher redemption', {
        voucherId,
        payer: address,
        error: err instanceof Error ? err.message : String(err),
      });
      await updateVoucherRedemptionStatus(db, voucherId, 'failed');
      return c.json({ error: 'failed to process voucher redemption' }, 500);
    }

    return c.json({
      success: true,
      voucherId,
      amount: String(redemption.amount),
      amountUSD: formatUSD(redemption.amount),
    });
  }

  return {
    handleGetCredits,
    handleListCredits,
    handleRedeemCredits,
    handleRedeemVoucher,
  };
}
