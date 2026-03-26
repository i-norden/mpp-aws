import { verifyMessage } from 'viem';
import type { Hex, Address } from 'viem';
import type { Kysely } from 'kysely';

import type { Database } from '../db/types.js';
import { tryReserveAuthNonce } from '../db/store-auth-nonces.js';

const MAX_MESSAGE_AGE_SECONDS = 60;
const MAX_FUTURE_SKEW_SECONDS = 30;
const AUTH_NONCE_TTL_SECONDS = 10 * 60;
const NONCE_REGEX = /^[A-Za-z0-9_-]{8,128}$/;

export interface VerifySignatureResult {
  valid: boolean;
  address: string;
  errorMessage: string;
  statusCode?: number;
}

export interface SignedMessage {
  address: string;
  timestamp: number;
  nonce: string;
}

export function parseSignedMessage(message: string): SignedMessage {
  const parts = message.split(':');
  if (parts.length !== 4) {
    throw new Error("invalid message format: expected 'open-compute:{address}:{timestamp}:{nonce}'");
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
  if (timestamp - now > MAX_FUTURE_SKEW_SECONDS) {
    throw new Error('invalid timestamp (in the future)');
  }

  const nonce = parts[3] ?? '';
  if (!NONCE_REGEX.test(nonce)) {
    throw new Error('invalid nonce format');
  }

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
        statusCode: 401,
      };
    }

    return {
      valid: true,
      address: normalizedClaimed,
      errorMessage: '',
      statusCode: 200,
    };
  } catch {
    return {
      valid: false,
      address: '',
      errorMessage: 'failed to verify signature',
      statusCode: 401,
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
      statusCode: 401,
    };
  }

  const claimedLower = claimedAddress.toLowerCase();
  if (parsed.address !== claimedLower) {
    return {
      valid: false,
      address: '',
      errorMessage: 'address in message does not match claimed address',
      statusCode: 401,
    };
  }

  return verifyAddressSignature(signatureHex, message, claimedAddress);
}

export async function verifyAddressOwnershipWithReplay(
  db: Kysely<Database>,
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
      statusCode: 401,
    };
  }

  const verification = await verifyAddressOwnership(
    signatureHex,
    message,
    claimedAddress,
  );
  if (!verification.valid) {
    return verification;
  }

  try {
    const reserved = await tryReserveAuthNonce(
      db,
      verification.address,
      parsed.nonce,
      new Date(Date.now() + AUTH_NONCE_TTL_SECONDS * 1000),
    );

    if (!reserved) {
      return {
        valid: false,
        address: '',
        errorMessage: 'message nonce already used',
        statusCode: 401,
      };
    }
  } catch {
    return {
      valid: false,
      address: '',
      errorMessage: 'authentication temporarily unavailable',
      statusCode: 503,
    };
  }

  return verification;
}
