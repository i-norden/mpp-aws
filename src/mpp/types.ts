export const MAX_PAYMENT_AMOUNT_ATOMIC = 1_000_000_000_000n; // $1,000,000 USDC

export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  outputSchema: unknown;
  extra?: Record<string, unknown>;
}

export interface ExactEvmPayloadAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface ExactEvmPayload {
  signature: string;
  authorization: ExactEvmPayloadAuthorization;
}

export interface PaymentPayload {
  version: number;
  scheme: string;
  network: string;
  payload: ExactEvmPayload;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  transaction?: string;
  txHash?: string;
  network?: string;
  errorReason?: string;
  error?: string;
}

export interface PaymentRequiredResponse {
  type: string;
  title: string;
  status: number;
  detail: string;
  challengeId: string;
  version: number;
  accepts: PaymentRequirements[];
  error: string;
}

export interface PaymentResponseHeader {
  success: boolean;
  txHash?: string;
  networkId?: string;
}

export interface PaymentInfo {
  amount: bigint;
  txHash: string;
  payer: string;
  requirements?: PaymentRequirements;
}

export function createPaymentRequirements(
  payTo: string,
  amount: bigint,
  resource: string,
  description: string,
  network: string,
  usdcAddress: string,
): PaymentRequirements {
  return {
    scheme: 'exact',
    network,
    maxAmountRequired: amount.toString(),
    resource,
    description,
    mimeType: 'application/json',
    payTo,
    maxTimeoutSeconds: 60,
    asset: usdcAddress,
    outputSchema: null,
  };
}

export function validatePaymentAmount(amount: bigint): string | null {
  if (amount < 0n) return 'payment amount cannot be negative';
  if (amount === 0n) return 'payment amount is less than required';
  if (amount > MAX_PAYMENT_AMOUNT_ATOMIC) return 'payment amount exceeds maximum allowed';
  return null;
}

export function decodePaymentHeader(header: string): PaymentPayload {
  const decoded = Buffer.from(header, 'base64').toString('utf-8');
  return JSON.parse(decoded) as PaymentPayload;
}
