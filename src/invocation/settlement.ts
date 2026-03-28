import type { Kysely } from 'kysely';

import type { BillingService, InvocationBilling, MeteredBillingBreakdown } from '../billing/service.js';
import type { Config } from '../config/index.js';
import { createInvocation, type InsertableInvocation } from '../db/store-invocations.js';
import type { Database } from '../db/types.js';
import type { InvocationResult } from '../lambda/invoker.js';
import * as log from '../logging/index.js';
import type { LambdaFunction } from '../api/function-registry.js';

export interface InvocationSettlementDeps {
  db: Kysely<Database>;
  config: Config;
  billingService: BillingService | null;
}

export interface InvocationSettlementPayment {
  payerAddress: string;
  txHash: string;
  amountPaid: bigint;
  refundAddress?: string;
  settlementKey?: string;
}

export interface InvocationSettlementResult {
  billingInput: InvocationBilling | null;
  invocationId: number | null;
  ownerEarning: bigint;
  actualCost: bigint;
}

export function isHTTPEndpoint(arn: string): boolean {
  return arn.startsWith('https://');
}

export async function settleInvocation(
  deps: InvocationSettlementDeps,
  functionName: string,
  dbFunction: LambdaFunction | null,
  payment: InvocationSettlementPayment,
  result: InvocationResult,
): Promise<InvocationSettlementResult> {
  const isHTTP = dbFunction !== null && isHTTPEndpoint(dbFunction.function_arn);

  if (isHTTP && deps.billingService && dbFunction && dbFunction.pricing_model === 'metered') {
    return settleMeteredHTTPInvocation(deps, functionName, dbFunction, payment, result);
  }

  if (!isHTTP && deps.billingService && dbFunction && result.billedDurationMs > 0) {
    const billingInput: InvocationBilling = {
      payerAddress: payment.payerAddress,
      sourceTxHash: payment.settlementKey ?? payment.txHash,
      amountPaid: payment.amountPaid,
      memoryMB: dbFunction.memory_mb,
      billedDurationMs: BigInt(result.billedDurationMs),
      refundAddress: payment.refundAddress,
      refundStatus: 'none',
      creditBalance: 0n,
    };

    try {
      await deps.billingService.processInvocationBilling(billingInput);
    } catch (err) {
      log.error('billing processing failed, falling back to legacy path', {
        function: functionName,
        payer: payment.payerAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      return logLegacyInvocation(deps, functionName, dbFunction, payment, result);
    }

    const invocationId = await logInvocation(deps.db, {
      function_name: functionName,
      payer_address: payment.payerAddress,
      amount_paid: payment.amountPaid,
      tx_hash: payment.txHash || null,
      status_code: result.statusCode,
      success: result.success,
      duration_ms: BigInt(result.billedDurationMs),
      billed_duration_ms: BigInt(result.billedDurationMs),
      memory_mb: dbFunction.memory_mb,
      actual_cloud_cost: billingInput.breakdown?.actualCloudCost ?? null,
      fee_amount: billingInput.breakdown?.feeAmount ?? null,
      refund_amount: billingInput.breakdown && billingInput.breakdown.grossRefund > 0n
        ? billingInput.breakdown.netRefund
        : null,
      refund_status: billingInput.refundStatus || null,
      refund_tx_hash: billingInput.refundTxHash ?? null,
    });

    const ownerEarning = await creditOwnerEarningsBilling(
      deps.db,
      deps.config,
      functionName,
      dbFunction,
      payment,
      billingInput,
    );

    return {
      billingInput,
      invocationId,
      ownerEarning,
      actualCost: billingInput.breakdown
        ? billingInput.breakdown.actualCloudCost + billingInput.breakdown.feeAmount
        : 0n,
    };
  }

  return logLegacyInvocation(deps, functionName, dbFunction, payment, result);
}

function calculateMeteredActualCost(
  dbFunction: LambdaFunction,
  result: InvocationResult,
): bigint {
  const customCostPerRequest = dbFunction.custom_base_fee;
  if (customCostPerRequest === null || customCostPerRequest === undefined) {
    throw new Error('metered HTTP billing called without custom_base_fee configured');
  }

  let actualCost = BigInt(customCostPerRequest);
  if (result.responseHeaders) {
    const costStr = result.responseHeaders['X-Actual-Cost'];
    if (costStr) {
      try {
        const parsed = BigInt(costStr);
        if (parsed >= 0n) {
          actualCost = parsed;
        }
      } catch {
        log.warn('invalid X-Actual-Cost header from upstream, charging full amount', {
          function: dbFunction.function_name,
          value: costStr,
        });
      }
    }
  }

  if (actualCost > BigInt(customCostPerRequest)) {
    actualCost = BigInt(customCostPerRequest);
  }

  return actualCost;
}

async function settleMeteredHTTPInvocation(
  deps: InvocationSettlementDeps,
  functionName: string,
  dbFunction: LambdaFunction,
  payment: InvocationSettlementPayment,
  result: InvocationResult,
): Promise<InvocationSettlementResult> {
  const actualCost = calculateMeteredActualCost(dbFunction, result);
  const marketplaceFeeBps = dbFunction.marketplace_fee_bps ?? deps.config.marketplaceFeeBps;
  const platformFee = actualCost * BigInt(marketplaceFeeBps) / 10000n;
  const ownerEarning = actualCost - platformFee;
  let grossRefund = payment.amountPaid - actualCost;
  if (grossRefund < 0n) {
    grossRefund = 0n;
  }

  const billingInput: InvocationBilling = {
    payerAddress: payment.payerAddress,
    sourceTxHash: payment.settlementKey ?? payment.txHash,
    amountPaid: payment.amountPaid,
    memoryMB: 0,
    billedDurationMs: 0n,
    refundAddress: payment.refundAddress,
    refundStatus: 'none',
    creditBalance: 0n,
  };

  const breakdown: MeteredBillingBreakdown = {
    actualCost,
    platformFee,
    ownerEarning,
    grossRefund,
  };

  try {
    await deps.billingService!.processHTTPEndpointBilling(billingInput, breakdown);
  } catch (err) {
    log.error('metered billing processing failed', {
      function: functionName,
      payer: payment.payerAddress,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await creditOwnerEarning(
    deps.db,
    dbFunction.owner_address,
    functionName,
    ownerEarning,
    payment.txHash,
  );

  const invocationId = await logInvocation(deps.db, {
    function_name: functionName,
    payer_address: payment.payerAddress,
    amount_paid: payment.amountPaid,
    tx_hash: payment.txHash || null,
    status_code: result.statusCode,
    success: result.success,
    duration_ms: 0n,
    actual_cloud_cost: billingInput.breakdown?.actualCloudCost ?? null,
    fee_amount: billingInput.breakdown?.feeAmount ?? null,
    refund_amount: billingInput.breakdown && billingInput.breakdown.grossRefund > 0n
      ? billingInput.breakdown.netRefund
      : null,
    refund_status: billingInput.refundStatus || null,
    refund_tx_hash: billingInput.refundTxHash ?? null,
  });

  return {
    billingInput,
    invocationId,
    ownerEarning,
    actualCost,
  };
}

async function logLegacyInvocation(
  deps: InvocationSettlementDeps,
  functionName: string,
  dbFunction: LambdaFunction | null,
  payment: InvocationSettlementPayment,
  result: InvocationResult,
): Promise<InvocationSettlementResult> {
  const invocationId = await logInvocation(deps.db, {
    function_name: functionName,
    payer_address: payment.payerAddress,
    amount_paid: payment.amountPaid,
    tx_hash: payment.txHash || null,
    status_code: result.statusCode,
    success: result.success,
    duration_ms: BigInt(result.billedDurationMs),
  });

  const ownerEarning = await creditOwnerEarningsLegacy(
    deps.db,
    deps.config,
    functionName,
    dbFunction,
    payment,
  );

  return {
    billingInput: null,
    invocationId,
    ownerEarning,
    actualCost: 0n,
  };
}

async function logInvocation(
  db: Kysely<Database>,
  values: InsertableInvocation,
): Promise<number | null> {
  try {
    return await createInvocation(db, values);
  } catch (err) {
    log.error('failed to log invocation', {
      function: values.function_name,
      payer: values.payer_address,
      txHash: values.tx_hash,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function creditOwnerEarningsBilling(
  db: Kysely<Database>,
  config: Config,
  functionName: string,
  dbFunction: LambdaFunction | null,
  payment: InvocationSettlementPayment,
  billingInput: InvocationBilling,
): Promise<bigint> {
  if (!dbFunction || !dbFunction.owner_address || !billingInput.breakdown) {
    return 0n;
  }

  let ownerRevenue = billingInput.breakdown.actualCloudCost + billingInput.breakdown.feeAmount;
  if (ownerRevenue > payment.amountPaid) {
    ownerRevenue = payment.amountPaid;
  }

  const marketplaceFeeBps = dbFunction.marketplace_fee_bps ?? config.marketplaceFeeBps;
  const platformFee = ownerRevenue * BigInt(marketplaceFeeBps) / 10000n;
  const ownerEarning = ownerRevenue - platformFee;
  if (ownerEarning <= 0n) {
    return 0n;
  }

  await creditOwnerEarning(db, dbFunction.owner_address, functionName, ownerEarning, payment.txHash);
  return ownerEarning;
}

async function creditOwnerEarningsLegacy(
  db: Kysely<Database>,
  config: Config,
  functionName: string,
  dbFunction: LambdaFunction | null,
  payment: InvocationSettlementPayment,
): Promise<bigint> {
  if (!dbFunction || !dbFunction.owner_address) {
    return 0n;
  }

  const marketplaceFeeBps = dbFunction.marketplace_fee_bps ?? config.marketplaceFeeBps;
  const feeAmount = payment.amountPaid * BigInt(marketplaceFeeBps) / 10000n;
  const ownerEarning = payment.amountPaid - feeAmount;
  if (ownerEarning <= 0n) {
    return 0n;
  }

  await creditOwnerEarning(db, dbFunction.owner_address, functionName, ownerEarning, payment.txHash);
  return ownerEarning;
}

async function creditOwnerEarning(
  db: Kysely<Database>,
  ownerAddress: string | null,
  functionName: string,
  amount: bigint,
  txHash: string,
): Promise<void> {
  if (!ownerAddress || amount <= 0n) {
    return;
  }

  try {
    await db.insertInto('earnings').values({
      owner_address: ownerAddress,
      function_name: functionName,
      amount,
      source_tx_hash: txHash || null,
    }).execute();
  } catch (err) {
    log.error('failed to credit earnings to function owner', {
      function: functionName,
      owner: ownerAddress,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
