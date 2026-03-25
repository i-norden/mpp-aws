/**
 * SSH key generation module.
 * Mirrors the Go implementation at mmp-compute/lambda-proxy/internal/sshcrypto/keygen.go
 *
 * Generates ED25519 SSH key pairs for EC2 lease provisioning.
 */

import { generateKeyPairSync, createPublicKey } from 'node:crypto';

export interface KeyPair {
  /** OpenSSH authorized_keys format (e.g., "ssh-ed25519 AAAA...") */
  publicKey: string;
  /** PEM-encoded private key */
  privateKey: Buffer;
}

/**
 * Generates a new ED25519 SSH key pair.
 *
 * The public key is returned in OpenSSH authorized_keys format
 * suitable for appending to ~/.ssh/authorized_keys.
 *
 * The private key is PEM-encoded and should be encrypted before
 * transmission to the client (see encrypt.ts).
 */
export function generateED25519KeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  // Convert PEM public key to OpenSSH authorized_keys format.
  // Node's createPublicKey can parse PEM and export as ssh (OpenSSH format).
  const pubKeyObj = createPublicKey(publicKey);
  const sshPublicKey = pubKeyObj.export({ type: 'spki', format: 'der' });

  // Build OpenSSH authorized_keys format manually:
  // "ssh-ed25519" + base64(type_len + type + key_len + key)
  const keyType = 'ssh-ed25519';
  const keyTypeBytes = Buffer.from(keyType, 'utf-8');

  // The raw ED25519 public key is the last 32 bytes of the SPKI DER encoding.
  // SPKI for ED25519: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes>
  const rawPublicKey = sshPublicKey.subarray(sshPublicKey.length - 32);

  // Build the SSH wire format: string "ssh-ed25519" + string <raw key bytes>
  const typeLen = Buffer.alloc(4);
  typeLen.writeUInt32BE(keyTypeBytes.length, 0);

  const keyLen = Buffer.alloc(4);
  keyLen.writeUInt32BE(rawPublicKey.length, 0);

  const wireFormat = Buffer.concat([typeLen, keyTypeBytes, keyLen, rawPublicKey]);
  const authorizedKey = `${keyType} ${wireFormat.toString('base64')}`;

  return {
    publicKey: authorizedKey,
    privateKey: Buffer.from(privateKey, 'utf-8'),
  };
}

/**
 * Zeros out a buffer to clear sensitive key material from memory.
 *
 * Note: Due to JavaScript's garbage collector, this is a best-effort measure.
 * The original buffer contents may still exist in memory until GC reclaims them.
 */
export function zeroBytes(buf: Buffer): void {
  buf.fill(0);
}
