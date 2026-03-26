import { describe, expect, it, vi, afterEach } from 'vitest';

import { parseSignedMessage, verifyAddressOwnership } from '../../src/auth/signature.js';

describe('auth/signature', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // parseSignedMessage
  // ---------------------------------------------------------------------------

  describe('parseSignedMessage', () => {
    it('parses a valid message with address and timestamp', () => {
      const now = Math.floor(Date.now() / 1000);
      const address = '0x1234567890abcdef1234567890abcdef12345678';
      const message = `open-compute:${address}:${now}`;

      const parsed = parseSignedMessage(message);
      expect(parsed.address).toBe(address.toLowerCase());
      expect(parsed.timestamp).toBe(now);
      expect(parsed.nonce).toBe('');
    });

    it('parses a valid message with nonce', () => {
      const now = Math.floor(Date.now() / 1000);
      const address = '0xabcdef1234567890abcdef1234567890abcdef12';
      const message = `open-compute:${address}:${now}:my-nonce-123`;

      const parsed = parseSignedMessage(message);
      expect(parsed.address).toBe(address.toLowerCase());
      expect(parsed.timestamp).toBe(now);
      expect(parsed.nonce).toBe('my-nonce-123');
    });

    it('normalizes address to lowercase', () => {
      const now = Math.floor(Date.now() / 1000);
      const address = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
      const message = `open-compute:${address}:${now}`;

      const parsed = parseSignedMessage(message);
      expect(parsed.address).toBe(address.toLowerCase());
    });

    it('throws on invalid prefix', () => {
      const now = Math.floor(Date.now() / 1000);
      const message = `wrong-prefix:0x1234567890abcdef1234567890abcdef12345678:${now}`;

      expect(() => parseSignedMessage(message)).toThrow("invalid message prefix: expected 'open-compute'");
    });

    it('throws on too few parts', () => {
      expect(() => parseSignedMessage('open-compute:0x1234')).toThrow('invalid message format');
    });

    it('throws on invalid address format', () => {
      const now = Math.floor(Date.now() / 1000);
      const message = `open-compute:not-an-address:${now}`;

      expect(() => parseSignedMessage(message)).toThrow('invalid address format');
    });

    it('throws on invalid timestamp format', () => {
      const message = 'open-compute:0x1234567890abcdef1234567890abcdef12345678:not-a-number';

      expect(() => parseSignedMessage(message)).toThrow('invalid timestamp format');
    });

    it('throws on expired timestamp', () => {
      const expired = Math.floor(Date.now() / 1000) - 120; // 2 minutes ago (max is 60s)
      const message = `open-compute:0x1234567890abcdef1234567890abcdef12345678:${expired}`;

      expect(() => parseSignedMessage(message)).toThrow('message expired');
    });

    it('throws on future timestamp (more than 30s ahead)', () => {
      const future = Math.floor(Date.now() / 1000) + 60; // 60s in the future (max is 30)
      const message = `open-compute:0x1234567890abcdef1234567890abcdef12345678:${future}`;

      expect(() => parseSignedMessage(message)).toThrow('invalid timestamp (in the future)');
    });

    it('accepts timestamp within tolerance window (small future)', () => {
      const nearFuture = Math.floor(Date.now() / 1000) + 10; // 10s in the future (within 30s tolerance)
      const address = '0x1234567890abcdef1234567890abcdef12345678';
      const message = `open-compute:${address}:${nearFuture}`;

      const parsed = parseSignedMessage(message);
      expect(parsed.timestamp).toBe(nearFuture);
    });
  });

  // ---------------------------------------------------------------------------
  // verifyAddressOwnership
  // ---------------------------------------------------------------------------

  describe('verifyAddressOwnership', () => {
    it('returns invalid when address in message does not match claimed address', async () => {
      const now = Math.floor(Date.now() / 1000);
      const messageAddress = '0x1234567890abcdef1234567890abcdef12345678';
      const claimedAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const message = `open-compute:${messageAddress}:${now}`;

      const result = await verifyAddressOwnership('0x' + 'ab'.repeat(65), message, claimedAddress);

      expect(result.valid).toBe(false);
      expect(result.errorMessage).toBe('address in message does not match claimed address');
    });

    it('returns invalid for malformed message', async () => {
      const result = await verifyAddressOwnership('0xdeadbeef', 'bad-message', '0x1234567890abcdef1234567890abcdef12345678');

      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain('invalid message');
    });

    it('returns invalid for expired message', async () => {
      const expired = Math.floor(Date.now() / 1000) - 120;
      const address = '0x1234567890abcdef1234567890abcdef12345678';
      const message = `open-compute:${address}:${expired}`;

      const result = await verifyAddressOwnership('0xdeadbeef', message, address);

      expect(result.valid).toBe(false);
      expect(result.errorMessage).toBe('message expired (timestamp too old)');
    });
  });
});
