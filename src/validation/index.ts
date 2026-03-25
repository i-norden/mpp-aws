const FUNCTION_NAME_REGEX = /^[a-zA-Z0-9_:-]+$/;
const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const HEX_STRING_REGEX = /^0x[0-9a-fA-F]+$/;

export class ValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = 'ValidationError';
  }
}

export function validateFunctionName(name: string): void {
  if (!name) {
    throw new ValidationError('function', 'function name is required');
  }
  if (name.length > 170) {
    throw new ValidationError('function', 'function name too long (max 170 characters)');
  }
  if (!FUNCTION_NAME_REGEX.test(name)) {
    throw new ValidationError('function', 'invalid function name format');
  }
}

export function validateEthAddress(address: string, field: string): void {
  if (!address) {
    throw new ValidationError(field, `${field} is required`);
  }
  if (!ETH_ADDRESS_REGEX.test(address)) {
    throw new ValidationError(field, `invalid ${field} format`);
  }
}

export function normalizeEthAddress(address: string): string {
  if (!address) {
    throw new ValidationError('address', 'address is required');
  }
  if (!ETH_ADDRESS_REGEX.test(address)) {
    throw new ValidationError('address', 'invalid address format');
  }
  return address.toLowerCase();
}

export function normalizeEthAddressOrEmpty(address: string): string {
  if (!address) return '';
  try {
    return normalizeEthAddress(address);
  } catch {
    return '';
  }
}

export function validateHexString(value: string, field: string): void {
  if (!value) {
    throw new ValidationError(field, `${field} is required`);
  }
  if (!HEX_STRING_REGEX.test(value)) {
    throw new ValidationError(field, `invalid ${field} format (must be hex)`);
  }
}

export function validatePayload(payload: Buffer | Uint8Array, maxSize: number): void {
  if (payload.length > maxSize) {
    throw new ValidationError('payload', `payload too large (max ${maxSize} bytes)`);
  }
  if (payload.length > 0) {
    try {
      JSON.parse(Buffer.from(payload).toString('utf-8'));
    } catch {
      throw new ValidationError('payload', 'invalid JSON payload');
    }
  }
}

export function sanitizeString(s: string, maxLen: number): string {
  let result = '';
  for (const char of s) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) {
      result += char;
    }
  }
  if (result.length > maxLen) {
    result = result.slice(0, maxLen);
  }
  return result.trim();
}
