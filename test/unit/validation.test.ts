import { describe, expect, it } from 'vitest';

import {
  validateFunctionName,
  validateEthAddress,
  normalizeEthAddress,
  normalizeEthAddressOrEmpty,
  validateHexString,
  sanitizeString,
  ValidationError,
} from '../../src/validation/index.js';

describe('validation', () => {
  // ---------------------------------------------------------------------------
  // validateFunctionName
  // ---------------------------------------------------------------------------

  describe('validateFunctionName', () => {
    it('accepts valid function names', () => {
      expect(() => validateFunctionName('myFunction')).not.toThrow();
      expect(() => validateFunctionName('my_function')).not.toThrow();
      expect(() => validateFunctionName('my-function:v1')).not.toThrow();
      expect(() => validateFunctionName('fn123')).not.toThrow();
      expect(() => validateFunctionName('a')).not.toThrow();
    });

    it('rejects empty name', () => {
      expect(() => validateFunctionName('')).toThrow(ValidationError);
      expect(() => validateFunctionName('')).toThrow('function name is required');
    });

    it('rejects names with invalid characters', () => {
      expect(() => validateFunctionName('my function')).toThrow('invalid function name format');
      expect(() => validateFunctionName('my/function')).toThrow('invalid function name format');
      expect(() => validateFunctionName('fn@special')).toThrow('invalid function name format');
      expect(() => validateFunctionName('fn.name')).toThrow('invalid function name format');
    });

    it('rejects names longer than 170 characters', () => {
      const longName = 'a'.repeat(171);
      expect(() => validateFunctionName(longName)).toThrow('function name too long');
    });

    it('accepts names exactly 170 characters', () => {
      const exactName = 'a'.repeat(170);
      expect(() => validateFunctionName(exactName)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // validateEthAddress
  // ---------------------------------------------------------------------------

  describe('validateEthAddress', () => {
    it('accepts valid Ethereum addresses', () => {
      expect(() =>
        validateEthAddress('0x1234567890abcdef1234567890abcdef12345678', 'address'),
      ).not.toThrow();

      expect(() =>
        validateEthAddress('0xABCDEF1234567890ABCDEF1234567890ABCDEF12', 'address'),
      ).not.toThrow();
    });

    it('rejects empty address', () => {
      expect(() => validateEthAddress('', 'address')).toThrow(ValidationError);
      expect(() => validateEthAddress('', 'address')).toThrow('address is required');
    });

    it('rejects addresses without 0x prefix', () => {
      expect(() =>
        validateEthAddress('1234567890abcdef1234567890abcdef12345678', 'address'),
      ).toThrow('invalid address format');
    });

    it('rejects addresses with wrong length', () => {
      expect(() => validateEthAddress('0x1234', 'address')).toThrow('invalid address format');
      expect(() =>
        validateEthAddress('0x1234567890abcdef1234567890abcdef1234567890', 'address'),
      ).toThrow('invalid address format');
    });

    it('rejects addresses with non-hex characters', () => {
      expect(() =>
        validateEthAddress('0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG', 'address'),
      ).toThrow('invalid address format');
    });

    it('uses field name in error message', () => {
      expect(() => validateEthAddress('', 'payer')).toThrow('payer is required');
    });
  });

  // ---------------------------------------------------------------------------
  // normalizeEthAddress
  // ---------------------------------------------------------------------------

  describe('normalizeEthAddress', () => {
    it('lowercases valid addresses', () => {
      const result = normalizeEthAddress('0xABCDEF1234567890ABCDEF1234567890ABCDEF12');
      expect(result).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    });

    it('throws on empty address', () => {
      expect(() => normalizeEthAddress('')).toThrow('address is required');
    });

    it('throws on invalid address', () => {
      expect(() => normalizeEthAddress('invalid')).toThrow('invalid address format');
    });
  });

  // ---------------------------------------------------------------------------
  // normalizeEthAddressOrEmpty
  // ---------------------------------------------------------------------------

  describe('normalizeEthAddressOrEmpty', () => {
    it('returns empty string for empty input', () => {
      expect(normalizeEthAddressOrEmpty('')).toBe('');
    });

    it('returns empty string for invalid address', () => {
      expect(normalizeEthAddressOrEmpty('not-an-address')).toBe('');
    });

    it('normalizes valid addresses', () => {
      const result = normalizeEthAddressOrEmpty('0xABCDEF1234567890ABCDEF1234567890ABCDEF12');
      expect(result).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    });
  });

  // ---------------------------------------------------------------------------
  // validateHexString
  // ---------------------------------------------------------------------------

  describe('validateHexString', () => {
    it('accepts valid hex strings', () => {
      expect(() => validateHexString('0xdeadbeef', 'hash')).not.toThrow();
      expect(() => validateHexString('0x1234567890abcdef', 'hash')).not.toThrow();
    });

    it('rejects empty string', () => {
      expect(() => validateHexString('', 'hash')).toThrow('hash is required');
    });

    it('rejects non-hex strings', () => {
      expect(() => validateHexString('not-hex', 'hash')).toThrow('must be hex');
      expect(() => validateHexString('0xGGGG', 'hash')).toThrow('must be hex');
    });
  });

  // ---------------------------------------------------------------------------
  // sanitizeString
  // ---------------------------------------------------------------------------

  describe('sanitizeString', () => {
    it('passes through normal strings unchanged', () => {
      expect(sanitizeString('hello world', 100)).toBe('hello world');
    });

    it('strips control characters', () => {
      expect(sanitizeString('hello\x00world', 100)).toBe('helloworld');
      expect(sanitizeString('hello\x01world', 100)).toBe('helloworld');
      expect(sanitizeString('hello\x1fworld', 100)).toBe('helloworld');
      expect(sanitizeString('hello\x7fworld', 100)).toBe('helloworld');
    });

    it('preserves space characters (code 32)', () => {
      expect(sanitizeString('hello world', 100)).toBe('hello world');
    });

    it('truncates to maxLen', () => {
      expect(sanitizeString('hello world', 5)).toBe('hello');
    });

    it('trims trailing whitespace after truncation', () => {
      expect(sanitizeString('hello   world', 8)).toBe('hello');
    });

    it('handles empty string', () => {
      expect(sanitizeString('', 100)).toBe('');
    });

    it('handles string with only control characters', () => {
      expect(sanitizeString('\x00\x01\x02', 100)).toBe('');
    });

    it('handles unicode characters', () => {
      // Characters with code > 32 and != 127 should be preserved
      expect(sanitizeString('cafe\u0301', 100)).toBe('cafe\u0301');
    });
  });

  // ---------------------------------------------------------------------------
  // ValidationError
  // ---------------------------------------------------------------------------

  describe('ValidationError', () => {
    it('has correct name and field properties', () => {
      const err = new ValidationError('myField', 'is bad');
      expect(err.name).toBe('ValidationError');
      expect(err.field).toBe('myField');
      // The `public readonly message` parameter shadows Error.message,
      // so err.message holds the raw constructor arg, not the super() string.
      expect(err.message).toBe('is bad');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
