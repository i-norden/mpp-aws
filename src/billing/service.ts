/**
 * Billing service — coordinates pricing, refunds, and credits.
 * TypeScript port of mmp-compute/lambda-proxy/internal/billing/service.go
 *
 * All monetary amounts are in atomic USDC (6 decimals) represented as bigint.
 */

import { PricingEngine, type BillingBreakdown } from '../pricing/engine.js';
import { RefundService, type RefundStatus } from '../refund/service.js';
import * as log from '../logging/index.js';
import * as metrics from '../metrics/index.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Database record for a refund row. */
export interface RefundRecord {
  id?: bigint;
  payerAddress: string;
  amount: bigint;
  status: string;
  sourceTxHash?: string;
  refundTxHash?: string;
  errorMessage?: string;
  gasUsed?: bigint;
}

/** Database record for a credit row. */
export interface CreditRecord {
  payerAddress: string;
  amount: bigint;
  reason: string;
  sourceTxHash?: string;
}

/** Credit balance returned by the store. */
export interface CreditBalance {
  payerAddress: string;
  availableBalance: bigint;
}

/**
 * BillingStore defines the database operations needed by the billing service.
 * Using an interface instead of a concrete class enables testing in isolation.
 */
export interface BillingStore {
  getRefundBySourceTxHash(sourceTxHash: string): Promise<RefundRecord | null>;
  createRefund(refund: RefundRecord): Promise<bigint>;
  createRefundIfNotExists(refund: RefundRecord): Promise<{ created: boolean; id: bigint }>;
  updateRefundStatus(
    refundID: bigint,
    status: string,
    txHash: string,
    errorMsg: string,
    gasUsed: bigint,
  ): Promise<void>;
  createCredit(credit: CreditRecord): Promise<void>;
  getCreditBalance(payerAddress: string): Promise<CreditBalance>;
  reserveCreditsForRedemption(payerAddress: string): Promise<bigint>;
  finalizeRedemption(payerAddress: string, txHash: string): Promise<void>;
  rollbackRedemption(payerAddress: string): Promise<void>;
  reserveEarningsForWithdrawal(ownerAddress: string): Promise<bigint>;
  finalizeEarningsWithdrawal(ownerAddress: string, txHash: string): Promise<void>;
  rollbackEarningsWithdrawal(ownerAddress: string): Promise<void>;
}

/**
 * Billing details for an invocation (input + calculated output).
 */
export interface InvocationBilling {
  // Input
  payerAddress: string;
  sourceTxHash: string;
  amountPaid: bigint;
  memoryMB: number;
  billedDurationMs: bigint;

  // Refund address override (when set, on-chain refunds go here instead of payerAddress)
  refundAddress?: string;

  // Calculated
  breakdown?: BillingBreakdown;

  // Refund result
  refundStatus: string; // 'none' | 'pending' | 'success' | 'failed' | 'credited'
  refundTxHash?: string;
  creditId?: bigint;
  creditBalance: bigint;
}

/**
 * Pre-calculated billing for metered HTTP endpoints.
 */
export interface MeteredBillingBreakdown {
  actualCost: bigint;   // Actual cost reported by upstream (capped at customCostPerRequest)
  platformFee: bigint;  // Platform's marketplace fee
  ownerEarning: bigint; // Amount credited to endpoint owner
  grossRefund: bigint;  // Amount to refund (amountPaid - actualCost)
}

/**
 * Result of a credit redemption.
 */
export interface RedeemResult {
  success: boolean;
  amountRedeemed?: bigint;
  amountSent?: bigint;
  gasCost?: bigint;
  txHash?: string;
  error?: string;
  availableBalance?: bigint;
}

/**
 * Result of an earnings withdrawal.
 */
export interface WithdrawResult {
  success: boolean;
  amountWithdrawn?: bigint;
  amountSent?: bigint;
  gasCost?: bigint;
  txHash?: string;
  error?: string;
  availableBalance?: bigint;
}

/** Configuration for constructing a BillingService. */
export interface BillingServiceConfig {
  refundEnabled: boolean;
  rpcUrl?: string;
  refundPrivateKey?: string;
  usdcAddress?: string;
  chainId?: bigint;
}

// ---------------------------------------------------------------------------
// retryWithBackoff
// ---------------------------------------------------------------------------

/**
 * Executes fn with exponential backoff retry.
 * Retries up to maxRetries times with delays of baseDelayMs, 2*baseDelayMs, 4*baseDelayMs, etc.
 * Returns on the first successful attempt, or throws the last error after all retries are exhausted.
 */
async function retryWithBackoff(
  maxRetries: number,
  baseDelayMs: number,
  fn: () => Promise<void>,
): Promise<void> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }

    // Exponential backoff before next attempt
    if (attempt < maxRetries) {
      const backoff = baseDelayMs * (1 << attempt);
      await new Promise<void>((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Helper: effectiveRefundAddress
// ---------------------------------------------------------------------------

function effectiveRefundAddress(input: InvocationBilling): string {
  if (input.refundAddress && input.refundAddress !== '') {
    return input.refundAddress;
  }
  return input.payerAddress;
}

// ---------------------------------------------------------------------------
// BillingService
// ---------------------------------------------------------------------------

/**
 * BillingService coordinates billing operations: pricing, refunds, and credits.
 */
export class BillingService {
  private readonly pricingEngine: PricingEngine;
  private readonly refundService: RefundService | null;
  private readonly store: BillingStore | null;
  private readonly cfg: BillingServiceConfig;

  private constructor(
    pricingEngine: PricingEngine,
    refundService: RefundService | null,
    store: BillingStore | null,
    cfg: BillingServiceConfig,
  ) {
    this.pricingEngine = pricingEngine;
    this.refundService = refundService;
    this.store = store;
    this.cfg = cfg;
  }

  /**
   * Creates a new BillingService.
   * Initializes the RefundService if refunds are enabled.
   */
  static create(
    pricingEngine: PricingEngine,
    store: BillingStore | null,
    cfg: BillingServiceConfig,
  ): BillingService {
    let refundService: RefundService | null = null;

    if (cfg.refundEnabled) {
      if (!cfg.rpcUrl || !cfg.refundPrivateKey || !cfg.usdcAddress || cfg.chainId === undefined) {
        throw new Error(
          'failed to initialize refund service: rpcUrl, refundPrivateKey, usdcAddress, and chainId are required when refunds are enabled',
        );
      }
      refundService = new RefundService({
        rpcUrl: cfg.rpcUrl,
        privateKey: cfg.refundPrivateKey,
        usdcAddress: cfg.usdcAddress,
        chainId: cfg.chainId,
      });
    }

    return new BillingService(pricingEngine, refundService, store, cfg);
  }

  // -----------------------------------------------------------------------
  // processInvocationBilling
  // -----------------------------------------------------------------------

  /**
   * Processes billing after an invocation completes.
   * Calculates costs, issues refunds, and tracks credits.
   */
  async processInvocationBilling(input: InvocationBilling): Promise<void> {
    // Calculate billing breakdown
    input.breakdown = this.pricingEngine.calculateBillingBreakdown(
      input.amountPaid,
      input.memoryMB,
      input.billedDurationMs,
    );

    await this.processCalculatedBilling(input);
  }

  /**
   * Processes refund and credit side effects for a pre-calculated billing breakdown.
   * Callers are responsible for populating `input.breakdown` before invoking this path.
   */
  async processCalculatedBilling(input: InvocationBilling): Promise<void> {
    if (!input.breakdown) {
      throw new Error('breakdown must be calculated before processing billing');
    }

    // If refunds not enabled or no refund due, we're done
    if (!this.cfg.refundEnabled || input.breakdown.grossRefund <= 0n) {
      input.refundStatus = 'none';
      return;
    }

    // Check if eligible for on-chain refund
    if (input.breakdown.refundEligible && this.refundService !== null) {
      // Delegate to the shared refund flow (atomic claim, on-chain send, credit fallback).
      return this.processRefund(input);
    }

    // Below threshold - credit the user
    input.refundStatus = 'credited';
    await this.creditUser(input, input.breakdown.creditAmount, 'below_threshold', '');

    // Get updated credit balance
    if (this.store !== null) {
      const balance = await this.store.getCreditBalance(input.payerAddress);
      input.creditBalance = balance.availableBalance;
    }
  }

  // -----------------------------------------------------------------------
  // processHTTPEndpointBilling
  // -----------------------------------------------------------------------

  /**
   * Processes billing for a metered HTTP endpoint invocation.
   * Accepts a pre-calculated breakdown and handles the refund/credit logic.
   */
  async processHTTPEndpointBilling(
    input: InvocationBilling,
    breakdown: MeteredBillingBreakdown,
  ): Promise<void> {
    // Build a synthetic BillingBreakdown for compatibility with the response format
    input.breakdown = {
      actualCloudCost: breakdown.actualCost,
      feeAmount: breakdown.platformFee,
      feePercentage: breakdown.actualCost > 0n ? (breakdown.platformFee * 100n / breakdown.actualCost) : 0n,
      grossRefund: breakdown.grossRefund,
      gasCost: 0n,
      netRefund: 0n,
      refundEligible: false,
      creditAmount: 0n,
    };

    // Calculate net refund after gas.
    const refundConfig = this.pricingEngine.getRefundConfig();
    const gasCost = refundConfig.estimatedGasCost;
    const minThreshold = refundConfig.minRefundThreshold;
    const netRefund = breakdown.grossRefund > gasCost
      ? breakdown.grossRefund - gasCost
      : 0n;

    input.breakdown.gasCost = gasCost;
    input.breakdown.netRefund = netRefund;
    input.breakdown.refundEligible = netRefund >= minThreshold;
    input.breakdown.creditAmount = breakdown.grossRefund > 0n ? breakdown.grossRefund : 0n;

    await this.processCalculatedBilling(input);
  }

  // -----------------------------------------------------------------------
  // processRefund
  // -----------------------------------------------------------------------

  /**
   * Handles the refund flow: atomic claim, on-chain send, credit fallback.
   * Extracted from processInvocationBilling for reuse by processHTTPEndpointBilling.
   */
  async processRefund(input: InvocationBilling): Promise<void> {
    if (!input.breakdown) {
      throw new Error('breakdown must be calculated before processing refund');
    }

    let preClaimedRefundID = 0n;
    if (this.store !== null && input.sourceTxHash !== '') {
      const pendingRecord: RefundRecord = {
        payerAddress: input.payerAddress,
        amount: input.breakdown.netRefund,
        status: 'pending',
        sourceTxHash: input.sourceTxHash,
      };
      const { created, id } = await this.store.createRefundIfNotExists(pendingRecord);
      if (!created) {
        try {
          const existing = await this.store.getRefundBySourceTxHash(input.sourceTxHash);
          if (existing !== null) {
            input.refundStatus = existing.status;
            if (existing.refundTxHash) {
              input.refundTxHash = existing.refundTxHash;
            }
          } else {
            input.refundStatus = 'pending';
          }
        } catch {
          input.refundStatus = 'pending';
        }
        return;
      }
      preClaimedRefundID = id;
    }

    input.refundStatus = 'pending';

    let result;
    try {
      result = await this.refundService!.sendRefund(
        effectiveRefundAddress(input),
        input.breakdown.netRefund,
      );
    } catch (err) {
      input.refundStatus = 'failed';
      if (preClaimedRefundID > 0n) {
        const errMsg = err instanceof Error ? err.message : String(err);
        try {
          await retryWithBackoff(3, 100, () =>
            this.store!.updateRefundStatus(preClaimedRefundID, 'failed', '', errMsg, 0n),
          );
        } catch (retryErr) {
          log.error('CRITICAL AUDIT: Failed to update refund status to \'failed\'', {
            payer: input.payerAddress,
            txHash: input.sourceTxHash,
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
          metrics.refundStatusUpdateFailures.inc();
        }
      }
      const refundErrMsg = err instanceof Error ? err.message : String(err);
      await this.creditUser(input, input.breakdown.grossRefund, 'failed_refund', refundErrMsg);
      return;
    }

    switch (result.status as RefundStatus) {
      case 'success': {
        input.refundStatus = 'success';
        input.refundTxHash = result.txHash;
        if (this.store !== null) {
          if (preClaimedRefundID > 0n) {
            try {
              await retryWithBackoff(3, 100, () =>
                this.store!.updateRefundStatus(
                  preClaimedRefundID,
                  'success',
                  result.txHash!,
                  '',
                  result.gasUsed ?? 0n,
                ),
              );
            } catch (updateErr) {
              log.error('CRITICAL AUDIT: Failed to finalize successful refund record', {
                txHash: result.txHash,
                payer: input.payerAddress,
                error: updateErr instanceof Error ? updateErr.message : String(updateErr),
              });
              metrics.refundStatusUpdateFailures.inc();
            }
          } else {
            const refundRecord: RefundRecord = {
              payerAddress: input.payerAddress,
              amount: input.breakdown.netRefund,
              status: 'success',
              sourceTxHash: input.sourceTxHash !== '' ? input.sourceTxHash : undefined,
              refundTxHash: result.txHash,
              gasUsed: result.gasUsed && result.gasUsed > 0n ? result.gasUsed : undefined,
            };
            try {
              await this.store.createRefund(refundRecord);
            } catch (createErr) {
              log.error('CRITICAL AUDIT: Failed to log successful refund', {
                txHash: result.txHash,
                payer: input.payerAddress,
                error: createErr instanceof Error ? createErr.message : String(createErr),
              });
              metrics.refundStatusUpdateFailures.inc();
            }
          }
        }
        break;
      }

      case 'pending': {
        input.refundStatus = 'pending';
        input.refundTxHash = result.txHash;
        if (this.store !== null) {
          if (preClaimedRefundID > 0n) {
            try {
              await retryWithBackoff(3, 100, () =>
                this.store!.updateRefundStatus(
                  preClaimedRefundID,
                  'pending',
                  result.txHash!,
                  '',
                  0n,
                ),
              );
            } catch (updateErr) {
              log.warn('AUDIT: Failed to update pending refund with tx hash', {
                txHash: result.txHash,
                payer: input.payerAddress,
                error: updateErr instanceof Error ? updateErr.message : String(updateErr),
              });
            }
          } else {
            // No pre-claim (e.g. empty source_tx_hash) -- create a new record for audit trail
            const refundRecord: RefundRecord = {
              payerAddress: input.payerAddress,
              amount: input.breakdown.netRefund,
              status: 'pending',
              sourceTxHash: input.sourceTxHash !== '' ? input.sourceTxHash : undefined,
              refundTxHash: result.txHash,
            };
            try {
              await this.store.createRefund(refundRecord);
            } catch (createErr) {
              log.warn('AUDIT: Failed to log pending refund - requires manual reconciliation', {
                txHash: result.txHash,
                payer: input.payerAddress,
                error: createErr instanceof Error ? createErr.message : String(createErr),
              });
            }
          }
        }
        break;
      }

      case 'failed': {
        input.refundStatus = 'failed';
        const errMsg = result.error ? result.error.message : '';
        if (preClaimedRefundID > 0n) {
          try {
            await retryWithBackoff(3, 100, () =>
              this.store!.updateRefundStatus(preClaimedRefundID, 'failed', '', errMsg, 0n),
            );
          } catch (retryErr) {
            log.error('CRITICAL AUDIT: Failed to update refund status to \'failed\'', {
              payer: input.payerAddress,
              txHash: input.sourceTxHash,
              error: retryErr instanceof Error ? retryErr.message : String(retryErr),
            });
            metrics.refundStatusUpdateFailures.inc();
          }
        }
        await this.creditUser(input, input.breakdown.grossRefund, 'failed_refund', errMsg);
        break;
      }
    }

    // Get updated credit balance
    if (this.store !== null) {
      const balance = await this.store.getCreditBalance(input.payerAddress);
      input.creditBalance = balance.availableBalance;
    }
  }

  // -----------------------------------------------------------------------
  // creditUser
  // -----------------------------------------------------------------------

  /**
   * Creates a credit record for the user.
   */
  private async creditUser(
    input: InvocationBilling,
    amount: bigint,
    reason: string,
    errMsg: string,
  ): Promise<void> {
    if (this.store === null || amount <= 0n) {
      return;
    }

    const credit: CreditRecord = {
      payerAddress: input.payerAddress,
      amount,
      reason,
      sourceTxHash: input.sourceTxHash !== '' ? input.sourceTxHash : undefined,
    };

    await this.store.createCredit(credit);

    // Also log the failed refund
    if (reason === 'failed_refund' && errMsg !== '') {
      const refundRecord: RefundRecord = {
        payerAddress: input.payerAddress,
        amount: input.breakdown?.netRefund ?? 0n,
        status: 'credited',
        sourceTxHash: input.sourceTxHash !== '' ? input.sourceTxHash : undefined,
        errorMessage: errMsg,
      };
      try {
        await this.store.createRefund(refundRecord);
      } catch (err) {
        // Log error for audit trail - don't fail the credit operation
        log.warn('AUDIT: Failed to log credited refund record', {
          payer: input.payerAddress,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // redeemCredits
  // -----------------------------------------------------------------------

  /**
   * Redeems all available credits for an address.
   * Uses atomic reservation to prevent concurrent double-spend: credits are marked
   * as redeemed BEFORE the on-chain refund is sent, and rolled back on failure.
   */
  async redeemCredits(payerAddress: string): Promise<RedeemResult> {
    if (this.store === null) {
      return { success: false, error: 'database not configured' };
    }

    if (this.refundService === null) {
      return { success: false, error: 'refund service not configured' };
    }

    // Atomically reserve credits (marks withdrawal_status = 'pending').
    // This prevents concurrent requests from seeing the same balance.
    let reservedAmount: bigint;
    try {
      reservedAmount = await this.store.reserveCreditsForRedemption(payerAddress);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (reservedAmount <= 0n) {
      return { success: false, error: 'no credits available' };
    }

    // Check minimum threshold
    const refundConfig = this.pricingEngine.getRefundConfig();
    const gasCost = refundConfig.estimatedGasCost;
    const minThreshold = refundConfig.minRefundThreshold;

    const netAmount = reservedAmount - gasCost;
    if (netAmount < minThreshold) {
      // Roll back the reservation
      try {
        await this.store.rollbackRedemption(payerAddress);
      } catch (rbErr) {
        log.error('failed to rollback credit reservation', {
          payer: payerAddress,
          error: rbErr instanceof Error ? rbErr.message : String(rbErr),
        });
      }
      // Format threshold as dollars (6 decimal USDC)
      const thresholdDollars = (Number(minThreshold) / 1e6).toFixed(4);
      return {
        success: false,
        error: `credit balance below minimum redemption threshold ($${thresholdDollars} required)`,
        availableBalance: reservedAmount,
      };
    }

    // Send the refund
    let result;
    try {
      result = await this.refundService.sendRefund(payerAddress, netAmount);
    } catch (err) {
      // Roll back the reservation so credits become available again
      try {
        await this.store.rollbackRedemption(payerAddress);
      } catch (rbErr) {
        log.error('failed to rollback credit reservation after refund error', {
          payer: payerAddress,
          error: rbErr instanceof Error ? rbErr.message : String(rbErr),
        });
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        availableBalance: reservedAmount,
      };
    }

    // Check result status
    if (result.status === 'failed') {
      const errMsg = result.error ? result.error.message : 'refund transaction failed';
      // Roll back the reservation
      try {
        await this.store.rollbackRedemption(payerAddress);
      } catch (rbErr) {
        log.error('failed to rollback credit reservation after failed refund', {
          payer: payerAddress,
          error: rbErr instanceof Error ? rbErr.message : String(rbErr),
        });
      }
      return {
        success: false,
        error: errMsg,
        availableBalance: reservedAmount,
      };
    }

    // Handle pending status - transaction sent but not confirmed
    if (result.status === 'pending') {
      // Finalize with the pending tx hash (credits stay redeemed)
      try {
        await this.store.finalizeRedemption(payerAddress, result.txHash!);
      } catch (fErr) {
        log.warn('failed to finalize pending redemption', {
          payer: payerAddress,
          txHash: result.txHash,
          error: fErr instanceof Error ? fErr.message : String(fErr),
        });
      }
      return {
        success: false,
        error: 'refund transaction sent but not confirmed - please check transaction status',
        txHash: result.txHash,
        availableBalance: 0n,
      };
    }

    // Finalize: set withdrawal_status = 'withdrawn' with the real tx hash
    try {
      await this.store.finalizeRedemption(payerAddress, result.txHash!);
    } catch (fErr) {
      log.error('failed to finalize credit redemption', {
        payer: payerAddress,
        txHash: result.txHash,
        error: fErr instanceof Error ? fErr.message : String(fErr),
      });
    }

    return {
      success: true,
      amountRedeemed: reservedAmount,
      amountSent: netAmount,
      gasCost,
      txHash: result.txHash,
      availableBalance: 0n,
    };
  }

  // -----------------------------------------------------------------------
  // withdrawEarnings
  // -----------------------------------------------------------------------

  /**
   * Withdraws all available earnings for an owner address.
   * Uses atomic reservation to prevent concurrent double-spend, mirroring redeemCredits.
   */
  async withdrawEarnings(ownerAddress: string, minWithdrawal: bigint): Promise<WithdrawResult> {
    if (this.store === null) {
      return { success: false, error: 'database not configured' };
    }

    if (this.refundService === null) {
      return { success: false, error: 'refund service not configured' };
    }

    // Atomically reserve earnings (marks withdrawal_status = 'pending')
    let reservedAmount: bigint;
    try {
      reservedAmount = await this.store.reserveEarningsForWithdrawal(ownerAddress);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (reservedAmount <= 0n) {
      return { success: false, error: 'no earnings available' };
    }

    // Check minimum threshold
    const refundConfig = this.pricingEngine.getRefundConfig();
    const gasCost = refundConfig.estimatedGasCost;

    const netAmount = reservedAmount - gasCost;
    if (netAmount < minWithdrawal) {
      // Roll back the reservation
      try {
        await this.store.rollbackEarningsWithdrawal(ownerAddress);
      } catch (rbErr) {
        log.error('failed to rollback earnings reservation', {
          payer: ownerAddress,
          error: rbErr instanceof Error ? rbErr.message : String(rbErr),
        });
      }
      const thresholdDollars = (Number(minWithdrawal) / 1e6).toFixed(4);
      return {
        success: false,
        error: `earnings balance below minimum withdrawal threshold ($${thresholdDollars} required)`,
        availableBalance: reservedAmount,
      };
    }

    // Send the refund
    let result;
    try {
      result = await this.refundService.sendRefund(ownerAddress, netAmount);
    } catch (err) {
      try {
        await this.store.rollbackEarningsWithdrawal(ownerAddress);
      } catch (rbErr) {
        log.error('failed to rollback earnings reservation after refund error', {
          payer: ownerAddress,
          error: rbErr instanceof Error ? rbErr.message : String(rbErr),
        });
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        availableBalance: reservedAmount,
      };
    }

    // Check result status
    if (result.status === 'failed') {
      const errMsg = result.error ? result.error.message : 'withdrawal transaction failed';
      try {
        await this.store.rollbackEarningsWithdrawal(ownerAddress);
      } catch (rbErr) {
        log.error('failed to rollback earnings reservation after failed withdrawal', {
          payer: ownerAddress,
          error: rbErr instanceof Error ? rbErr.message : String(rbErr),
        });
      }
      return {
        success: false,
        error: errMsg,
        availableBalance: reservedAmount,
      };
    }

    // Handle pending status
    if (result.status === 'pending') {
      try {
        await this.store.finalizeEarningsWithdrawal(ownerAddress, result.txHash!);
      } catch (fErr) {
        log.warn('failed to finalize pending earnings withdrawal', {
          payer: ownerAddress,
          txHash: result.txHash,
          error: fErr instanceof Error ? fErr.message : String(fErr),
        });
      }
      return {
        success: false,
        error: 'withdrawal transaction sent but not confirmed - please check transaction status',
        txHash: result.txHash,
        availableBalance: 0n,
      };
    }

    // Finalize: set withdrawal_status = 'withdrawn' with the real tx hash
    try {
      await this.store.finalizeEarningsWithdrawal(ownerAddress, result.txHash!);
    } catch (fErr) {
      log.error('failed to finalize earnings withdrawal', {
        payer: ownerAddress,
        txHash: result.txHash,
        error: fErr instanceof Error ? fErr.message : String(fErr),
      });
    }

    return {
      success: true,
      amountWithdrawn: reservedAmount,
      amountSent: netAmount,
      gasCost,
      txHash: result.txHash,
      availableBalance: 0n,
    };
  }

  // -----------------------------------------------------------------------
  // Accessors & lifecycle
  // -----------------------------------------------------------------------

  /** Returns the credit balance for a payer address. */
  async getCreditBalance(payerAddress: string): Promise<CreditBalance> {
    if (this.store === null) {
      return { payerAddress, availableBalance: 0n };
    }
    return this.store.getCreditBalance(payerAddress);
  }

  /** Returns whether refunds are enabled. */
  isRefundEnabled(): boolean {
    return this.cfg.refundEnabled && this.refundService !== null;
  }

  /** Returns the underlying refund service (for pending refund monitoring). */
  getRefundService(): RefundService | null {
    return this.refundService;
  }

  /** Closes the billing service. */
  close(): void {
    if (this.refundService !== null) {
      this.refundService.close();
    }
  }
}
