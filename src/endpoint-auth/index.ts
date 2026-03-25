/**
 * Endpoint authentication module.
 * TypeScript port of mmp-compute/lambda-proxy/internal/endpointauth/endpointauth.go
 *
 * Supports encrypting auth credentials at rest (AES-256-GCM) and applying them
 * to outbound requests. Auth types: bearer, api_key, basic, custom_header.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AUTH_TYPE_BEARER = 'bearer' as const;
export const AUTH_TYPE_API_KEY = 'api_key' as const;
export const AUTH_TYPE_BASIC = 'basic' as const;
export const AUTH_TYPE_CUSTOM_HEADER = 'custom_header' as const;

const VALID_AUTH_TYPES = [
  AUTH_TYPE_BEARER,
  AUTH_TYPE_API_KEY,
  AUTH_TYPE_BASIC,
  AUTH_TYPE_CUSTOM_HEADER,
] as const;

export type AuthType = (typeof VALID_AUTH_TYPES)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Plaintext auth configuration for a registered endpoint. */
export interface EndpointAuth {
  type: AuthType;

  // Bearer auth
  token?: string;

  // API key auth
  keyName?: string;
  keyValue?: string;
  keyLocation?: 'header' | 'query';

  // Basic auth
  username?: string;
  password?: string;

  // Custom header auth
  headerName?: string;
  headerValue?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate that required fields are present for the given auth type. */
export function validate(auth: EndpointAuth): void {
  if (!auth) {
    throw new Error('auth config is nil');
  }

  switch (auth.type) {
    case AUTH_TYPE_BEARER:
      if (!auth.token) {
        throw new Error('bearer auth requires a token');
      }
      break;

    case AUTH_TYPE_API_KEY:
      if (!auth.keyName) {
        throw new Error('api_key auth requires keyName');
      }
      if (!auth.keyValue) {
        throw new Error('api_key auth requires keyValue');
      }
      if (!auth.keyLocation) {
        auth.keyLocation = 'header'; // default to header
      }
      if (auth.keyLocation !== 'header' && auth.keyLocation !== 'query') {
        throw new Error("api_key keyLocation must be 'header' or 'query'");
      }
      break;

    case AUTH_TYPE_BASIC:
      if (!auth.username) {
        throw new Error('basic auth requires username');
      }
      if (!auth.password) {
        throw new Error('basic auth requires password');
      }
      break;

    case AUTH_TYPE_CUSTOM_HEADER:
      if (!auth.headerName) {
        throw new Error('custom_header auth requires headerName');
      }
      if (!auth.headerValue) {
        throw new Error('custom_header auth requires headerValue');
      }
      break;

    default:
      throw new Error(
        `unsupported auth type: "${auth.type}" (must be bearer, api_key, basic, or custom_header)`,
      );
  }
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt (AES-256-GCM)
// ---------------------------------------------------------------------------

/**
 * Encrypt an EndpointAuth struct using AES-256-GCM.
 * @param auth   - The plaintext auth configuration.
 * @param keyHex - 64-character hex string (32 bytes).
 * @returns Hex-encoded ciphertext (nonce || ciphertext || tag).
 */
export function encrypt(auth: EndpointAuth, keyHex: string): string {
  if (!auth) {
    throw new Error('auth config is nil');
  }

  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(`encryption key must be 32 bytes, got ${key.length}`);
  }

  const plaintext = Buffer.from(JSON.stringify(auth), 'utf8');

  // AES-256-GCM uses a 12-byte nonce (same as Go's cipher.NewGCM default)
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Match Go's gcm.Seal output: nonce || ciphertext || tag
  const result = Buffer.concat([nonce, encrypted, tag]);
  return result.toString('hex');
}

/**
 * Decrypt a hex-encoded ciphertext back into an EndpointAuth struct.
 * @param cipherHex - Hex-encoded ciphertext from encrypt().
 * @param keyHex    - 64-character hex string (32 bytes).
 * @returns The decrypted EndpointAuth.
 */
export function decrypt(cipherHex: string, keyHex: string): EndpointAuth {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(`encryption key must be 32 bytes, got ${key.length}`);
  }

  const data = Buffer.from(cipherHex, 'hex');

  // GCM nonce is 12 bytes, auth tag is 16 bytes
  const nonceSize = 12;
  const tagSize = 16;
  if (data.length < nonceSize + tagSize) {
    throw new Error('ciphertext too short');
  }

  const nonce = data.subarray(0, nonceSize);
  const ciphertext = data.subarray(nonceSize, data.length - tagSize);
  const tag = data.subarray(data.length - tagSize);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return JSON.parse(plaintext.toString('utf8')) as EndpointAuth;
}
