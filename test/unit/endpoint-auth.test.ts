import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  validate,
  encrypt,
  decrypt,
  AUTH_TYPE_BEARER,
  AUTH_TYPE_API_KEY,
  AUTH_TYPE_BASIC,
  AUTH_TYPE_CUSTOM_HEADER,
  type EndpointAuth,
} from '../../src/endpoint-auth/index.js';

/** Generate a random 32-byte hex key for AES-256. */
function randomKeyHex(): string {
  return randomBytes(32).toString('hex');
}

describe('endpoint-auth', () => {
  // ---------------------------------------------------------------------------
  // validate
  // ---------------------------------------------------------------------------

  describe('validate', () => {
    it('validates bearer: requires token', () => {
      expect(() => validate({ type: AUTH_TYPE_BEARER })).toThrow('bearer auth requires a token');
      expect(() => validate({ type: AUTH_TYPE_BEARER, token: 'my-token' })).not.toThrow();
    });

    it('validates api_key: requires keyName and keyValue', () => {
      expect(() => validate({ type: AUTH_TYPE_API_KEY })).toThrow('api_key auth requires keyName');
      expect(() => validate({ type: AUTH_TYPE_API_KEY, keyName: 'X-API-Key' })).toThrow(
        'api_key auth requires keyValue',
      );

      const valid: EndpointAuth = {
        type: AUTH_TYPE_API_KEY,
        keyName: 'X-API-Key',
        keyValue: 'secret123',
      };
      expect(() => validate(valid)).not.toThrow();
      // Defaults keyLocation to 'header'
      expect(valid.keyLocation).toBe('header');
    });

    it('validates api_key: keyLocation must be header or query', () => {
      expect(() =>
        validate({
          type: AUTH_TYPE_API_KEY,
          keyName: 'X-API-Key',
          keyValue: 'secret',
          keyLocation: 'body' as 'header',
        }),
      ).toThrow("api_key keyLocation must be 'header' or 'query'");
    });

    it('validates basic: requires username and password', () => {
      expect(() => validate({ type: AUTH_TYPE_BASIC })).toThrow('basic auth requires username');
      expect(() => validate({ type: AUTH_TYPE_BASIC, username: 'user' })).toThrow(
        'basic auth requires password',
      );
      expect(() =>
        validate({ type: AUTH_TYPE_BASIC, username: 'user', password: 'pass' }),
      ).not.toThrow();
    });

    it('validates custom_header: requires headerName and headerValue', () => {
      expect(() => validate({ type: AUTH_TYPE_CUSTOM_HEADER })).toThrow(
        'custom_header auth requires headerName',
      );
      expect(() =>
        validate({ type: AUTH_TYPE_CUSTOM_HEADER, headerName: 'X-Custom' }),
      ).toThrow('custom_header auth requires headerValue');
      expect(() =>
        validate({
          type: AUTH_TYPE_CUSTOM_HEADER,
          headerName: 'X-Custom',
          headerValue: 'value',
        }),
      ).not.toThrow();
    });

    it('rejects unsupported auth type', () => {
      expect(() => validate({ type: 'oauth' as 'bearer' })).toThrow('unsupported auth type');
    });
  });

  // ---------------------------------------------------------------------------
  // encrypt / decrypt
  // ---------------------------------------------------------------------------

  describe('encrypt / decrypt', () => {
    it('roundtrips bearer auth', () => {
      const key = randomKeyHex();
      const auth: EndpointAuth = { type: AUTH_TYPE_BEARER, token: 'my-secret-token' };

      const cipherHex = encrypt(auth, key);
      expect(cipherHex).toBeTruthy();
      expect(typeof cipherHex).toBe('string');

      const decrypted = decrypt(cipherHex, key);
      expect(decrypted.type).toBe(AUTH_TYPE_BEARER);
      expect(decrypted.token).toBe('my-secret-token');
    });

    it('roundtrips api_key auth', () => {
      const key = randomKeyHex();
      const auth: EndpointAuth = {
        type: AUTH_TYPE_API_KEY,
        keyName: 'X-API-Key',
        keyValue: 'super-secret',
        keyLocation: 'header',
      };

      const cipherHex = encrypt(auth, key);
      const decrypted = decrypt(cipherHex, key);

      expect(decrypted.type).toBe(AUTH_TYPE_API_KEY);
      expect(decrypted.keyName).toBe('X-API-Key');
      expect(decrypted.keyValue).toBe('super-secret');
      expect(decrypted.keyLocation).toBe('header');
    });

    it('roundtrips basic auth', () => {
      const key = randomKeyHex();
      const auth: EndpointAuth = {
        type: AUTH_TYPE_BASIC,
        username: 'admin',
        password: 'hunter2',
      };

      const cipherHex = encrypt(auth, key);
      const decrypted = decrypt(cipherHex, key);

      expect(decrypted.type).toBe(AUTH_TYPE_BASIC);
      expect(decrypted.username).toBe('admin');
      expect(decrypted.password).toBe('hunter2');
    });

    it('decrypt with wrong key fails', () => {
      const key1 = randomKeyHex();
      const key2 = randomKeyHex();
      const auth: EndpointAuth = { type: AUTH_TYPE_BEARER, token: 'secret' };

      const cipherHex = encrypt(auth, key1);

      expect(() => decrypt(cipherHex, key2)).toThrow();
    });

    it('rejects key of wrong length', () => {
      const shortKey = 'aabb'; // 2 bytes, not 32
      const auth: EndpointAuth = { type: AUTH_TYPE_BEARER, token: 'test' };

      expect(() => encrypt(auth, shortKey)).toThrow('encryption key must be 32 bytes');
      expect(() => decrypt('aabbccdd', shortKey)).toThrow('encryption key must be 32 bytes');
    });

    it('rejects ciphertext that is too short', () => {
      const key = randomKeyHex();
      // Needs at least 12 (nonce) + 16 (tag) = 28 bytes
      const shortCipher = 'aa'.repeat(10); // 10 bytes

      expect(() => decrypt(shortCipher, key)).toThrow('ciphertext too short');
    });

    it('produces different ciphertext for same input (random nonce)', () => {
      const key = randomKeyHex();
      const auth: EndpointAuth = { type: AUTH_TYPE_BEARER, token: 'same' };

      const c1 = encrypt(auth, key);
      const c2 = encrypt(auth, key);

      expect(c1).not.toBe(c2);
    });
  });
});
