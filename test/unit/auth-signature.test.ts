import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('viem', () => ({
  verifyMessage: vi.fn(),
}));

vi.mock('../../src/db/store-auth-nonces.js', () => ({
  tryReserveAuthNonce: vi.fn(),
}));

import { verifyMessage } from 'viem';

import { tryReserveAuthNonce } from '../../src/db/store-auth-nonces.js';
import {
  parseSignedMessage,
  verifyAddressOwnership,
  verifyAddressOwnershipWithReplay,
} from '../../src/auth/signature.js';

describe('auth/signature', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseSignedMessage', () => {
    it('parses a valid nonce-bearing message', () => {
      const now = Math.floor(Date.now() / 1000);
      const address = '0xabcdef1234567890abcdef1234567890abcdef12';
      const message = `open-compute:${address}:${now}:my-nonce-123`;

      const parsed = parseSignedMessage(message);
      expect(parsed.address).toBe(address.toLowerCase());
      expect(parsed.timestamp).toBe(now);
      expect(parsed.nonce).toBe('my-nonce-123');
    });

    it('normalizes the address to lowercase', () => {
      const now = Math.floor(Date.now() / 1000);
      const message = `open-compute:0xABCDEF1234567890ABCDEF1234567890ABCDEF12:${now}:nonce-1234`;

      expect(parseSignedMessage(message).address).toBe(
        '0xabcdef1234567890abcdef1234567890abcdef12',
      );
    });

    it('rejects messages without a nonce', () => {
      const now = Math.floor(Date.now() / 1000);
      const message = `open-compute:0x1234567890abcdef1234567890abcdef12345678:${now}`;

      expect(() => parseSignedMessage(message)).toThrow('invalid message format');
    });

    it('rejects an invalid nonce format', () => {
      const now = Math.floor(Date.now() / 1000);
      const message = `open-compute:0x1234567890abcdef1234567890abcdef12345678:${now}:bad nonce`;

      expect(() => parseSignedMessage(message)).toThrow('invalid nonce format');
    });

    it('rejects expired messages', () => {
      const expired = Math.floor(Date.now() / 1000) - 120;
      const message = `open-compute:0x1234567890abcdef1234567890abcdef12345678:${expired}:nonce-1234`;

      expect(() => parseSignedMessage(message)).toThrow('message expired');
    });
  });

  describe('verifyAddressOwnership', () => {
    it('rejects when the message address does not match the claimed address', async () => {
      const now = Math.floor(Date.now() / 1000);
      const message = `open-compute:0x1234567890abcdef1234567890abcdef12345678:${now}:nonce-1234`;

      const result = await verifyAddressOwnership(
        '0x' + 'ab'.repeat(65),
        message,
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );

      expect(result.valid).toBe(false);
      expect(result.errorMessage).toBe(
        'address in message does not match claimed address',
      );
    });

    it('rejects malformed messages before signature verification', async () => {
      const result = await verifyAddressOwnership(
        '0xdeadbeef',
        'bad-message',
        '0x1234567890abcdef1234567890abcdef12345678',
      );

      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain('invalid message');
    });

    it('verifies a valid signature', async () => {
      vi.mocked(verifyMessage).mockResolvedValue(true);

      const now = Math.floor(Date.now() / 1000);
      const address = '0x1234567890abcdef1234567890abcdef12345678';
      const message = `open-compute:${address}:${now}:nonce-1234`;

      const result = await verifyAddressOwnership('0xdeadbeef', message, address);

      expect(result.valid).toBe(true);
      expect(result.address).toBe(address);
    });
  });

  describe('verifyAddressOwnershipWithReplay', () => {
    it('reserves the nonce after a valid signature', async () => {
      vi.mocked(verifyMessage).mockResolvedValue(true);
      vi.mocked(tryReserveAuthNonce).mockResolvedValue(true);

      const now = Math.floor(Date.now() / 1000);
      const address = '0x1234567890abcdef1234567890abcdef12345678';
      const message = `open-compute:${address}:${now}:nonce-1234`;

      const result = await verifyAddressOwnershipWithReplay(
        {} as never,
        '0xdeadbeef',
        message,
        address,
      );

      expect(result.valid).toBe(true);
      expect(tryReserveAuthNonce).toHaveBeenCalledOnce();
    });

    it('rejects replayed nonces', async () => {
      vi.mocked(verifyMessage).mockResolvedValue(true);
      vi.mocked(tryReserveAuthNonce).mockResolvedValue(false);

      const now = Math.floor(Date.now() / 1000);
      const address = '0x1234567890abcdef1234567890abcdef12345678';
      const message = `open-compute:${address}:${now}:nonce-1234`;

      const result = await verifyAddressOwnershipWithReplay(
        {} as never,
        '0xdeadbeef',
        message,
        address,
      );

      expect(result.valid).toBe(false);
      expect(result.errorMessage).toBe('message nonce already used');
      expect(result.statusCode).toBe(401);
    });

    it('fails closed when nonce storage is unavailable', async () => {
      vi.mocked(verifyMessage).mockResolvedValue(true);
      vi.mocked(tryReserveAuthNonce).mockRejectedValue(new Error('db down'));

      const now = Math.floor(Date.now() / 1000);
      const address = '0x1234567890abcdef1234567890abcdef12345678';
      const message = `open-compute:${address}:${now}:nonce-1234`;

      const result = await verifyAddressOwnershipWithReplay(
        {} as never,
        '0xdeadbeef',
        message,
        address,
      );

      expect(result.valid).toBe(false);
      expect(result.errorMessage).toBe('authentication temporarily unavailable');
      expect(result.statusCode).toBe(503);
    });
  });
});
