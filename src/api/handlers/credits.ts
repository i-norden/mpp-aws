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
import { getCreditBalance, listCredits, createCredit } from '../../db/store-credits.js';
import {
  claimVoucherRedemption,
  getVoucherRedemption,
  updateVoucherRedemptionStatus,
} from '../../db/store-vouchers.js';
import * as log from '../../logging/index.js';
import { errorResponse, ErrorCodes } from '../errors.js';

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
    c.res = errorResponse(c, 401, ErrorCodes.AUTHENTICATION_REQUIRED, 'X-Signature and X-Message headers are required to access credit information', "Sign a message in format 'open-compute:{address}:{timestamp}:{nonce}' with your wallet");
    return false;
  }

  const result = await verifyAddressOwnershipWithReplay(db, signature, message, address);
  if (!result.valid) {
    c.res = errorResponse(c, result.statusCode ?? 401, ErrorCodes.AUTHENTICATION_FAILED, result.errorMessage ?? 'authentication failed');
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
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    const rawAddress = c.req.param('address') ?? '';
    if (!rawAddress) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'address is required');
    }
    try {
      validateEthAddress(rawAddress, 'address');
    } catch (err) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err));
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
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to get credit balance');
    }
  }

  // -------------------------------------------------------------------
  // handleListCredits -- GET /credits/:address/history
  // -------------------------------------------------------------------

  async function handleListCredits(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    const rawAddress = c.req.param('address') ?? '';
    if (!rawAddress) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'address is required');
    }
    try {
      validateEthAddress(rawAddress, 'address');
    } catch (err) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err));
    }

    const address = rawAddress.toLowerCase();

    if (!(await verifyOwnership(c, db, address))) {
      return c.res;
    }

    const includeRedeemed = c.req.query('include_redeemed') === 'true';
    const cursorParam = c.req.query('cursor');
    const cursor = cursorParam ? new Date(cursorParam) : undefined;
    const limitParam = c.req.query('limit');
    const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 100), 500) : 100;

    try {
      const credits = await listCredits(db, address, {
        limit,
        cursor,
        includeRedeemed,
      });

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
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list credits');
    }
  }

  // -------------------------------------------------------------------
  // handleRedeemCredits -- POST /credits/:address/redeem
  // -------------------------------------------------------------------

  async function handleRedeemCredits(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    if (!config.refundEnabled) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'refunds not enabled');
    }

    const rawAddress = c.req.param('address') ?? '';
    if (!rawAddress) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'address is required');
    }
    try {
      validateEthAddress(rawAddress, 'address');
    } catch (err) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err));
    }

    const address = rawAddress.toLowerCase();

    // OFAC check on credit redemption address
    if (ofacChecker && ofacChecker.isBlocked(address)) {
      return errorResponse(c, 403, ErrorCodes.ADDRESS_BLOCKED, 'This address is not permitted to use this service');
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
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to get credit balance');
    }

    if (balance.availableBalance <= 0n) {
      return errorResponse(c, 400, ErrorCodes.INSUFFICIENT_BALANCE, 'no credits available');
    }

    // Check minimum threshold
    if (balance.availableBalance < config.minRefundThreshold) {
      return errorResponse(c, 400, ErrorCodes.INSUFFICIENT_BALANCE, 'credit balance below minimum redemption threshold', {
        availableBalance: balance.availableBalance,
        availableUSD: formatUSD(balance.availableBalance),
        minimumRequired: config.minRefundThreshold,
        minimumUSD: formatUSD(config.minRefundThreshold),
      });
    }

    // Check if billing service is available for redemption
    if (!billingService || !billingService.isRefundEnabled()) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'Credit redemption service is not configured. Please contact support for manual redemption or wait for service availability.', {
        availableBalance: balance.availableBalance,
        availableUSD: formatUSD(balance.availableBalance),
        configHint: 'Set REFUND_ENABLED=true and configure REFUND_PRIVATE_KEY and RPC_URL to enable automatic redemption.',
      });
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
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'Failed to process credit redemption');
    }

    if (!result.success) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, result.error ?? 'redemption failed', {
        availableBalance: result.availableBalance ?? 0n,
        availableUSD: formatUSD(result.availableBalance ?? 0n),
      });
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
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    const address = (c.req.param('address') ?? '').toLowerCase();
    try {
      validateEthAddress(address, 'address');
    } catch {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'invalid address format');
    }

    if (!(await verifyOwnership(c, db, address))) {
      return c.res;
    }

    // OFAC compliance check
    if (ofacChecker && ofacChecker.isBlocked(address)) {
      return errorResponse(c, 403, ErrorCodes.ADDRESS_BLOCKED, 'address is blocked by compliance policy');
    }

    const body = await c.req.json<{
      voucher_id?: string;
    }>().catch(() => ({} as { voucher_id?: string }));

    const voucherId = body.voucher_id?.trim();
    if (!voucherId) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'voucher_id is required');
    }

    const existing = await getVoucherRedemption(db, voucherId);
    if (existing) {
      if (existing.status === 'success') {
        return errorResponse(c, 409, ErrorCodes.CONFLICT, 'voucher already redeemed');
      }
      if (existing.status === 'pending') {
        return errorResponse(c, 409, ErrorCodes.CONFLICT, 'voucher redemption already in progress');
      }
      if (existing.status === 'failed') {
        if (new Date(existing.expires_at) < new Date()) {
          return errorResponse(c, 410, ErrorCodes.INVALID_REQUEST, 'voucher has expired');
        }
        return errorResponse(c, 409, ErrorCodes.CONFLICT, 'voucher is no longer redeemable');
      }
    }

    const redemption = await claimVoucherRedemption(db, voucherId, address);
    if (!redemption) {
      const current = await getVoucherRedemption(db, voucherId);
      if (!current) {
        return errorResponse(c, 404, ErrorCodes.NOT_FOUND, 'voucher not found');
      }
      if (current.status === 'success') {
        return errorResponse(c, 409, ErrorCodes.CONFLICT, 'voucher already redeemed');
      }
      if (current.status === 'pending') {
        return errorResponse(c, 409, ErrorCodes.CONFLICT, 'voucher redemption already in progress');
      }
      if (new Date(current.expires_at) < new Date()) {
        await updateVoucherRedemptionStatus(db, voucherId, 'failed');
        return errorResponse(c, 410, ErrorCodes.INVALID_REQUEST, 'voucher has expired');
      }
      return errorResponse(c, 409, ErrorCodes.CONFLICT, 'voucher is no longer redeemable');
    }

    // Check expiry
    if (new Date(redemption.expires_at) < new Date()) {
      await updateVoucherRedemptionStatus(db, voucherId, 'failed');
      return errorResponse(c, 410, ErrorCodes.INVALID_REQUEST, 'voucher has expired');
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
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to process voucher redemption');
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
