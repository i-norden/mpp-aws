import { describe, expect, it, vi } from 'vitest';

import { OFACChecker, createOFACChecker } from '../../src/ofac/checker.js';

// Mock the logging module to prevent console output in tests
vi.mock('../../src/logging/index.js', () => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

describe('OFACChecker', () => {
  describe('isBlocked', () => {
    it('blocks listed addresses', () => {
      const checker = new OFACChecker(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        '',
      );

      expect(checker.isBlocked('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
      expect(checker.isBlocked('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toBe(true);
    });

    it('blocks addresses case-insensitively', () => {
      const checker = new OFACChecker(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '',
      );

      expect(checker.isBlocked('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
      expect(checker.isBlocked('0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa')).toBe(true);
    });

    it('allows non-listed addresses', () => {
      const checker = new OFACChecker(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '',
      );

      expect(checker.isBlocked('0xcccccccccccccccccccccccccccccccccccccccc')).toBe(false);
    });

    it('handles whitespace in comma-separated list', () => {
      const checker = new OFACChecker(
        '  0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa , 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  ',
        '',
      );

      expect(checker.isBlocked('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
      expect(checker.isBlocked('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toBe(true);
    });

    it('reports correct count', () => {
      const checker = new OFACChecker(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        '',
      );

      expect(checker.count()).toBe(2);
    });
  });

  describe('createOFACChecker factory', () => {
    it('returns null when no addresses are configured', () => {
      const checker = createOFACChecker('', '');
      expect(checker).toBeNull();
    });

    it('returns a checker when addresses are provided', () => {
      const checker = createOFACChecker(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '',
      );
      expect(checker).not.toBeNull();
      expect(checker!.count()).toBe(1);
    });

    it('returns null for empty/whitespace-only input', () => {
      const checker = createOFACChecker('  ,  , ', '');
      // Empty strings after trim are skipped, so count should be 0 -> returns null
      expect(checker).toBeNull();
    });
  });

  describe('reload', () => {
    it('reloads addresses from comma-separated string', () => {
      const checker = new OFACChecker(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '',
      );
      expect(checker.count()).toBe(1);

      // Reload uses the stored commaSeparated value, so count stays the same
      const count = checker.reload();
      expect(count).toBe(1);
    });
  });

  describe('file loading errors', () => {
    it('handles non-existent file gracefully', () => {
      // Should not throw, just log a warning
      const checker = new OFACChecker(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '/nonexistent/path/to/file.txt',
      );
      // The comma-separated address should still be loaded
      expect(checker.count()).toBe(1);
      expect(checker.isBlocked('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    });
  });
});
