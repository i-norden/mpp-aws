import { verifyMessage } from 'viem';
import type { Hex, Address } from 'viem';

const MAX_MESSAGE_AGE_SECONDS = 60;

export interface VerifySignatureResult {
  valid: boolean;
  address: string;
  errorMessage: string;
}

export interface SignedMessage {
  address: string;
  timestamp: number;
  nonce: string;
}

export function parseSignedMessage(message: string): SignedMessage {
  const parts = message.split(':');
  if (parts.length < 3) {
    throw new Error("invalid message format: expected 'open-compute:{address}:{timestamp}' or 'open-compute:{address}:{timestamp}:{nonce}'");
  }
  if (parts[0] !== 'open-compute') {
    throw new Error("invalid message prefix: expected 'open-compute'");
  }

  const address = parts[1].toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    throw new Error('invalid address format');
  }

  const timestamp = parseInt(parts[2], 10);
  if (isNaN(timestamp)) {
    throw new Error('invalid timestamp format');
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > MAX_MESSAGE_AGE_SECONDS) {
    throw new Error('message expired (timestamp too old)');
  }
  if (timestamp - now > 30) {
    throw new Error('invalid timestamp (in the future)');
  }

  const nonce = parts.length >= 4 ? parts[3] : '';

  return { address, timestamp, nonce };
}

export async function verifyAddressSignature(
  signatureHex: string,
  message: string,
  claimedAddress: string,
): Promise<VerifySignatureResult> {
  const normalizedClaimed = claimedAddress.toLowerCase();
  const sig = (signatureHex.startsWith('0x') ? signatureHex : `0x${signatureHex}`) as Hex;

  try {
    const valid = await verifyMessage({
      address: normalizedClaimed as Address,
      message,
      signature: sig,
    });

    if (!valid) {
      return {
        valid: false,
        address: '',
        errorMessage: 'signature does not match claimed address',
      };
    }

    return {
      valid: true,
      address: normalizedClaimed,
      errorMessage: '',
    };
  } catch {
    return {
      valid: false,
      address: '',
      errorMessage: 'failed to verify signature',
    };
  }
}

export async function verifyAddressOwnership(
  signatureHex: string,
  message: string,
  claimedAddress: string,
): Promise<VerifySignatureResult> {
  let parsed: SignedMessage;
  try {
    parsed = parseSignedMessage(message);
  } catch (err) {
    return {
      valid: false,
      address: '',
      errorMessage: err instanceof Error ? err.message : 'invalid message',
    };
  }

  const claimedLower = claimedAddress.toLowerCase();
  if (parsed.address !== claimedLower) {
    return {
      valid: false,
      address: '',
      errorMessage: 'address in message does not match claimed address',
    };
  }

  return verifyAddressSignature(signatureHex, message, claimedAddress);
}
