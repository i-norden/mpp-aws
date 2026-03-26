import { describe, expect, it } from 'vitest';
import * as nacl from 'tweetnacl';

import { generateED25519KeyPair, zeroBytes } from '../../src/ssh-crypto/keygen.js';
import { encryptPrivateKey, decryptPrivateKey } from '../../src/ssh-crypto/encrypt.js';

describe('ssh-crypto', () => {
  // ---------------------------------------------------------------------------
  // Key generation
  // ---------------------------------------------------------------------------

  describe('generateED25519KeyPair', () => {
    it('produces a public key in ssh-ed25519 format', () => {
      const kp = generateED25519KeyPair();

      expect(kp.publicKey).toMatch(/^ssh-ed25519 /);
      // The base64 portion should be valid
      const parts = kp.publicKey.split(' ');
      expect(parts).toHaveLength(2);
      const decoded = Buffer.from(parts[1], 'base64');
      // Should contain the key type string "ssh-ed25519" in the wire format
      expect(decoded.toString('utf-8', 4, 4 + 11)).toBe('ssh-ed25519');
    });

    it('produces a non-empty PEM private key', () => {
      const kp = generateED25519KeyPair();
      expect(kp.privateKey.length).toBeGreaterThan(0);
      expect(kp.privateKey.toString('utf-8')).toContain('BEGIN PRIVATE KEY');
    });

    it('generates unique key pairs each time', () => {
      const kp1 = generateED25519KeyPair();
      const kp2 = generateED25519KeyPair();
      expect(kp1.publicKey).not.toBe(kp2.publicKey);
    });
  });

  // ---------------------------------------------------------------------------
  // zeroBytes
  // ---------------------------------------------------------------------------

  describe('zeroBytes', () => {
    it('fills buffer with zeros', () => {
      const buf = Buffer.from([1, 2, 3, 4, 5]);
      zeroBytes(buf);
      expect(buf.every((b) => b === 0)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Encrypt / Decrypt roundtrip
  // ---------------------------------------------------------------------------

  describe('encryptPrivateKey / decryptPrivateKey', () => {
    it('roundtrips: encrypt then decrypt yields original plaintext', () => {
      // Generate a user key pair for the encryption envelope
      const userKeyPair = nacl.box.keyPair();

      const originalPEM = Buffer.from('-----BEGIN PRIVATE KEY-----\ntest data\n-----END PRIVATE KEY-----');

      const encrypted = encryptPrivateKey(originalPEM, userKeyPair.publicKey);
      expect(encrypted.combined).toBeTruthy();
      expect(encrypted.nonce).toBeTruthy();

      // Decrypt with the user's private key
      const decrypted = decryptPrivateKey(encrypted.combined, userKeyPair.secretKey);
      expect(decrypted.toString('utf-8')).toBe(originalPEM.toString('utf-8'));
    });

    it('decrypt with wrong key fails', () => {
      const userKeyPair = nacl.box.keyPair();
      const wrongKeyPair = nacl.box.keyPair();

      const originalPEM = Buffer.from('secret key material');

      const encrypted = encryptPrivateKey(originalPEM, userKeyPair.publicKey);

      // Decrypting with the wrong private key should throw
      expect(() => decryptPrivateKey(encrypted.combined, wrongKeyPair.secretKey)).toThrow(
        'decryption failed',
      );
    });

    it('rejects user public key of wrong length', () => {
      const shortKey = new Uint8Array(16);
      const pem = Buffer.from('test');

      expect(() => encryptPrivateKey(pem, shortKey)).toThrow('userPublicKey must be 32 bytes');
    });

    it('rejects user private key of wrong length', () => {
      const shortKey = new Uint8Array(16);

      expect(() => decryptPrivateKey('aabbccdd', shortKey)).toThrow(
        'userPrivateKey must be 32 bytes',
      );
    });

    it('rejects ciphertext that is too short', () => {
      const userKeyPair = nacl.box.keyPair();
      // Less than 56 bytes (32 ephemeral pub + 24 nonce)
      const shortHex = 'aa'.repeat(30); // 30 bytes

      expect(() => decryptPrivateKey(shortHex, userKeyPair.secretKey)).toThrow(
        'ciphertext too short',
      );
    });

    it('produces different ciphertexts for same plaintext (ephemeral key randomness)', () => {
      const userKeyPair = nacl.box.keyPair();
      const pem = Buffer.from('same plaintext for both');

      const enc1 = encryptPrivateKey(pem, userKeyPair.publicKey);
      const enc2 = encryptPrivateKey(pem, userKeyPair.publicKey);

      // Ciphertexts should differ due to random ephemeral key and nonce
      expect(enc1.combined).not.toBe(enc2.combined);

      // But both should decrypt to the same plaintext
      const dec1 = decryptPrivateKey(enc1.combined, userKeyPair.secretKey);
      const dec2 = decryptPrivateKey(enc2.combined, userKeyPair.secretKey);
      expect(dec1.toString()).toBe(dec2.toString());
    });
  });
});
