/**
 * Earnings management handlers.
 * TypeScript port of mmp-compute/lambda-proxy/internal/api/handlers_earnings.go
 *
 * Endpoints:
 *   GET  /earnings/:address           - get earnings balance
 *   GET  /earnings/:address/history   - list earning records
 *   GET  /earnings/:address/functions - per-function earnings breakdown
 *   POST /earnings/:address/withdraw  - withdraw all earnings on-chain
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
import {
  getEarningsBalance,
  listEarnings,
  getEarningsByFunction,
} from '../../db/store-earnings.js';
import * as log from '../../logging/index.js';
import { jsonWithStatus } from '../response.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EarningsDeps {
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
      message: 'X-Signature and X-Message headers are required to access earnings information',
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
// createEarningsHandlers
// ---------------------------------------------------------------------------

export function createEarningsHandlers(deps: EarningsDeps) {
  const { db, config, billingService, ofacChecker } = deps;

  // -------------------------------------------------------------------
  // handleGetEarnings -- GET /earnings/:address
  // -------------------------------------------------------------------

  async function handleGetEarnings(c: Context): Promise<Response> {
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
      const balance = await getEarningsBalance(db, address);

      return c.json({
        address,
        availableBalance: balance.availableBalance,
        availableUSD: formatUSD(balance.availableBalance),
        totalEarned: balance.totalEarned,
        totalWithdrawn: balance.totalWithdrawn,
        earningCount: balance.earningCount,
      });
    } catch (err) {
      log.error('failed to get earnings balance', {
        payer: address,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to get earnings balance' }, 500);
    }
  }

  // -------------------------------------------------------------------
  // handleListEarnings -- GET /earnings/:address/history
  // -------------------------------------------------------------------

  async function handleListEarnings(c: Context): Promise<Response> {
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

    const includeWithdrawn = c.req.query('include_withdrawn') === 'true';

    try {
      const earnings = await listEarnings(db, address, includeWithdrawn);

      interface EarningEntry {
        id: number;
        functionName: string;
        amount: bigint;
        amountUSD: string;
        sourceTxHash?: string;
        withdrawn: boolean;
        withdrawnAt?: string;
        withdrawnTxHash?: string;
        createdAt: string;
      }

      const entries: EarningEntry[] = earnings.map((e) => {
        const entry: EarningEntry = {
          id: Number(e.id),
          functionName: e.function_name,
          amount: BigInt(e.amount),
          amountUSD: formatUSD(BigInt(e.amount)),
          withdrawn: e.withdrawal_status !== 'available',
          createdAt: new Date(e.created_at).toISOString(),
        };
        if (e.source_tx_hash) {
          entry.sourceTxHash = e.source_tx_hash;
        }
        if (e.withdrawal_status !== 'available' && e.withdrawn_at) {
          entry.withdrawnAt = new Date(e.withdrawn_at).toISOString();
        }
        if (e.withdrawn_tx_hash) {
          entry.withdrawnTxHash = e.withdrawn_tx_hash;
        }
        return entry;
      });

      return c.json({
        address,
        earnings: entries,
        count: entries.length,
      });
    } catch (err) {
      log.error('failed to list earnings', {
        payer: address,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to list earnings' }, 500);
    }
  }

  // -------------------------------------------------------------------
  // handleGetEarningsByFunction -- GET /earnings/:address/functions
  // -------------------------------------------------------------------

  async function handleGetEarningsByFunction(c: Context): Promise<Response> {
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
      const results = await getEarningsByFunction(db, address);

      const entries = results.map((r) => ({
        functionName: r.functionName,
        totalEarned: r.totalEarned,
        totalEarnedUSD: formatUSD(r.totalEarned),
        availableBalance: r.availableBalance,
        availableUSD: formatUSD(r.availableBalance),
        invocationCount: r.invocationCount,
      }));

      return c.json({
        address,
        functions: entries,
        count: entries.length,
      });
    } catch (err) {
      log.error('failed to get earnings by function', {
        payer: address,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to get earnings by function' }, 500);
    }
  }

  // -------------------------------------------------------------------
  // handleWithdrawEarnings -- POST /earnings/:address/withdraw
  // -------------------------------------------------------------------

  async function handleWithdrawEarnings(c: Context): Promise<Response> {
    if (!db) {
      return c.json({ error: 'database not configured' }, 503);
    }

    if (!config.refundEnabled) {
      return c.json({ error: 'withdrawals not enabled' }, 503);
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

    // OFAC check on earnings withdrawal address
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
      balance = await getEarningsBalance(db, address);
    } catch (err) {
      log.error('failed to get earnings balance', {
        payer: address,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'failed to get earnings balance' }, 500);
    }

    if (balance.availableBalance <= 0n) {
      return c.json({
        error: 'no earnings available',
        availableBalance: 0n,
      }, 400);
    }

    // Check minimum threshold
    if (balance.availableBalance < config.minEarningsWithdrawal) {
      return c.json({
        error: 'earnings balance below minimum withdrawal threshold',
        availableBalance: balance.availableBalance,
        availableUSD: formatUSD(balance.availableBalance),
        minimumRequired: config.minEarningsWithdrawal,
        minimumUSD: formatUSD(config.minEarningsWithdrawal),
      }, 400);
    }

    // Check if billing service is available
    if (!billingService || !billingService.isRefundEnabled()) {
      return c.json({
        error: 'withdrawal_unavailable',
        availableBalance: balance.availableBalance,
        availableUSD: formatUSD(balance.availableBalance),
        message: 'Withdrawal service is not configured.',
      }, 503);
    }

    // Process the withdrawal via billing service
    let result;
    try {
      result = await billingService.withdrawEarnings(address, config.minEarningsWithdrawal);
    } catch (err) {
      log.error('earnings withdrawal failed', {
        payer: address,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({
        error: 'withdrawal_failed',
        message: 'Failed to process earnings withdrawal',
      }, 500);
    }

    if (!result.success) {
      return c.json({
        error: 'withdrawal_failed',
        message: result.error,
        availableBalance: result.availableBalance ?? 0n,
        availableUSD: formatUSD(result.availableBalance ?? 0n),
      }, 400);
    }

    return c.json({
      success: true,
      amountWithdrawn: result.amountWithdrawn ?? 0n,
      amountWithdrawnUSD: formatUSD(result.amountWithdrawn ?? 0n),
      amountSent: result.amountSent ?? 0n,
      amountSentUSD: formatUSD(result.amountSent ?? 0n),
      gasCost: result.gasCost ?? 0n,
      gasCostUSD: formatUSD(result.gasCost ?? 0n),
      txHash: result.txHash,
      remainingBalance: result.availableBalance ?? 0n,
    });
  }

  return {
    handleGetEarnings,
    handleListEarnings,
    handleGetEarningsByFunction,
    handleWithdrawEarnings,
  };
}
