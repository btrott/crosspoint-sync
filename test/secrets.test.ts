import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  getEncryptionKey,
  resetEncryptionKeyCache,
  secretsEnabled,
} from '../src/crypto/secrets.js';

const KEY_HEX = 'a'.repeat(64);

afterEach(() => resetEncryptionKeyCache());

describe('secret vault', () => {
  it('round-trips a token', () => {
    const env = { TOKEN_ENC_KEY: KEY_HEX } as NodeJS.ProcessEnv;
    const enc = encryptSecret('hardcover-token-xyz', env);
    expect(enc).not.toContain('hardcover-token-xyz');
    expect(decryptSecret(enc, env)).toBe('hardcover-token-xyz');
  });

  it('produces different ciphertext each call (random IV)', () => {
    const env = { TOKEN_ENC_KEY: KEY_HEX } as NodeJS.ProcessEnv;
    expect(encryptSecret('same', env)).not.toBe(encryptSecret('same', env));
  });

  it('detects tampering via the auth tag', () => {
    const env = { TOKEN_ENC_KEY: KEY_HEX } as NodeJS.ProcessEnv;
    const enc = encryptSecret('secret', env);
    const buf = Buffer.from(enc, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => decryptSecret(buf.toString('base64'), env)).toThrow();
  });

  it('accepts a base64 32-byte key and a passphrase', () => {
    const b64 = { TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64') } as NodeJS.ProcessEnv;
    expect(decryptSecret(encryptSecret('x', b64), b64)).toBe('x');
    resetEncryptionKeyCache();
    const phrase = { TOKEN_ENC_KEY: 'this is a long enough passphrase!!' } as NodeJS.ProcessEnv;
    expect(decryptSecret(encryptSecret('y', phrase), phrase)).toBe('y');
  });

  it('is disabled when the key is unset', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(secretsEnabled(env)).toBe(false);
    expect(getEncryptionKey(env)).toBeNull();
    expect(() => encryptSecret('x', env)).toThrow(/TOKEN_ENC_KEY/);
  });

  it('rejects an obviously too-short key', () => {
    const env = { TOKEN_ENC_KEY: 'short' } as NodeJS.ProcessEnv;
    expect(() => getEncryptionKey(env)).toThrow();
  });
});
