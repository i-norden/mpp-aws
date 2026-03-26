import { describe, expect, it } from 'vitest';

import { isValidEthAddress } from '../../src/validation/index.js';

describe('isValidEthAddress', () => {
  it('accepts valid checksummed address', () => {
    expect(isValidEthAddress('0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B')).toBe(true);
  });

  it('accepts valid lowercase address', () => {
    expect(isValidEthAddress('0xab5801a7d398351b8be11c439e05c5b3259aec9b')).toBe(true);
  });

  it('accepts valid uppercase address', () => {
    expect(isValidEthAddress('0xAB5801A7D398351B8BE11C439E05C5B3259AEC9B')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidEthAddress('')).toBe(false);
  });

  it('rejects address without 0x prefix', () => {
    expect(isValidEthAddress('ab5801a7d398351b8be11c439e05c5b3259aec9b')).toBe(false);
  });

  it('rejects address with wrong length', () => {
    expect(isValidEthAddress('0xab5801a7d398351b8be11c439e05c5b3259aec')).toBe(false);
    expect(isValidEthAddress('0xab5801a7d398351b8be11c439e05c5b3259aec9b00')).toBe(false);
  });

  it('rejects address with non-hex characters', () => {
    expect(isValidEthAddress('0xGb5801a7d398351b8be11c439e05c5b3259aec9b')).toBe(false);
  });

  it('rejects random string', () => {
    expect(isValidEthAddress('not-an-address')).toBe(false);
  });
});
