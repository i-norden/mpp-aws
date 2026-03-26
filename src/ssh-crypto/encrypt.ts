/**
 * X25519 NaCl box encryption for SSH private keys.
 * Mirrors the Go implementation at mmp-compute/lambda-proxy/internal/sshcrypto/encrypt.go
 *
 * Uses tweetnacl's nacl.box for authenticated encryption with ECDH.
 * Each encryption generates an ephemeral X25519 key pair so that only
 * the holder of the corresponding user private key can decrypt.
 */

import * as nacl from 'tweetnacl';
import { zeroBytes } from './keygen.js';

/**
 * Result of encrypting an SSH private key.
 */
export interface EncryptedKey {
  /** hex(ephemeral_pubkey[32] || nonce[24] || ciphertext) */
  combined: string;
  /** hex-encoded 24-byte nonce (also embedded in combined) */
  nonce: string;
}

/**
 * Converts a Uint8Array to a hex string.
 */
function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Converts a hex string to a Uint8Array.
 */
function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * Encrypts an SSH private key PEM using NaCl box (authenticated encryption with ECDH).
 *
 * Generates an ephemeral X25519 key pair, performs ECDH with the user's public key,
 * and encrypts the private key material.
 *
 * The result is: hex(ephemeral_pubkey[32] || nonce[24] || ciphertext)
 *
 * @param privateKeyPEM - PEM-encoded SSH private key to encrypt
 * @param userPublicKey - 32-byte X25519 public key of the recipient
 * @returns Encrypted key with combined hex and nonce hex
 */
export function encryptPrivateKey(
  privateKeyPEM: Buffer,
  userPublicKey: Uint8Array,
): EncryptedKey {
  if (userPublicKey.length !== 32) {
    throw new Error(`userPublicKey must be 32 bytes, got ${userPublicKey.length}`);
  }

  // Generate ephemeral X25519 key pair
  const ephemeralKeyPair = nacl.box.keyPair();
  const ephemeralPub = ephemeralKeyPair.publicKey;
  const ephemeralPriv = ephemeralKeyPair.secretKey;

  try {
    // Generate random 24-byte nonce
    const nonce = nacl.randomBytes(24);

    // Encrypt using NaCl box (authenticated encryption with ECDH)
    const message = new Uint8Array(privateKeyPEM);
    const ciphertext = nacl.box(message, nonce, userPublicKey, ephemeralPriv);

    if (ciphertext === null) {
      throw new Error('NaCl box encryption failed');
    }

    // Combine: ephemeral_pubkey[32] || nonce[24] || ciphertext
    const combined = new Uint8Array(32 + 24 + ciphertext.length);
    combined.set(ephemeralPub, 0);
    combined.set(nonce, 32);
    combined.set(ciphertext, 56);

    return {
      combined: toHex(combined),
      nonce: toHex(nonce),
    };
  } finally {
    // Zero out ephemeral private key material
    zeroBytes(Buffer.from(ephemeralPriv.buffer, ephemeralPriv.byteOffset, ephemeralPriv.byteLength));
  }
}

/**
 * Decrypts an SSH private key that was encrypted with encryptPrivateKey.
 *
 * @param combinedHex - hex(ephemeral_pubkey[32] || nonce[24] || ciphertext)
 * @param userPrivateKey - 32-byte X25519 private key corresponding to the public key used for encryption
 * @returns Decrypted PEM-encoded private key
 */
export function decryptPrivateKey(
  combinedHex: string,
  userPrivateKey: Uint8Array,
): Buffer {
  if (userPrivateKey.length !== 32) {
    throw new Error(`userPrivateKey must be 32 bytes, got ${userPrivateKey.length}`);
  }

  const combined = fromHex(combinedHex);

  if (combined.length < 56) {
    throw new Error(
      `ciphertext too short: need at least 56 bytes, got ${combined.length}`,
    );
  }

  // Extract components
  const ephemeralPub = combined.slice(0, 32);
  const nonce = combined.slice(32, 56);
  const ciphertext = combined.slice(56);

  // Decrypt using NaCl box.open
  const plaintext = nacl.box.open(ciphertext, nonce, ephemeralPub, userPrivateKey);

  if (plaintext === null) {
    throw new Error('decryption failed: authentication error');
  }

  return Buffer.from(plaintext);
}
