import { Receipt } from 'mppx';

export const MAX_PAYMENT_AMOUNT_ATOMIC = 1_000_000_000_000n; // $1,000,000 USDC

/**
 * Payment information extracted after a successful payment or budget deduction.
 * Set on the Hono context by the payment middleware.
 */
export interface PaymentInfo {
  amount: bigint;
  txHash: string;
  payer: string;
}

export function validatePaymentAmount(amount: bigint): string | null {
  if (amount < 0n) return 'payment amount cannot be negative';
  if (amount === 0n) return 'payment amount is less than required';
  if (amount > MAX_PAYMENT_AMOUNT_ATOMIC) return 'payment amount exceeds maximum allowed';
  return null;
}

/**
 * Creates a serialized Payment-Receipt header value using the mppx SDK.
 */
export function createPaymentReceipt(reference: string): string {
  return Receipt.serialize(Receipt.from({
    method: 'tempo',
    reference,
    status: 'success',
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Extracts the Ethereum address from a `did:pkh:eip155:<chainId>:<address>` DID source string.
 * Returns null if the source doesn't match the expected format.
 */
export function extractAddressFromSource(source: string | undefined): string | null {
  if (!source) return null;
  // did:pkh:eip155:<chainId>:<address>
  const parts = source.split(':');
  if (parts.length >= 5 && parts[0] === 'did' && parts[1] === 'pkh' && parts[2] === 'eip155') {
    return parts[4]!.toLowerCase();
  }
  return null;
}
