import crypto from 'node:crypto';

/**
 * Symmetric encryption for connector credentials (third-party tokens and session
 * cookie bundles) at rest. AES-256-GCM with a random per-record IV; the auth tag
 * detects tampering. The key comes from TOKEN_ENC_KEY — if it's unset, all
 * connectors are disabled rather than storing secrets in the clear.
 *
 * Wire format (base64 of): [1-byte version][12-byte iv][16-byte tag][ciphertext]
 */

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null | undefined;

/** Resolves the 32-byte key from TOKEN_ENC_KEY (hex, base64, or raw >=32 chars), or null. */
export function getEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = env.TOKEN_ENC_KEY;
  if (!raw) {
    cachedKey = null;
    return null;
  }
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) {
      key = b64;
    } else if (Buffer.byteLength(raw) >= 32) {
      // Derive a stable 32-byte key from an arbitrary passphrase.
      key = crypto.createHash('sha256').update(raw).digest();
    }
  }
  if (!key || key.length !== 32) {
    throw new Error('TOKEN_ENC_KEY must be 32 bytes (64 hex chars, base64, or a >=32 char passphrase)');
  }
  cachedKey = key;
  return cachedKey;
}

/** Test seam: forget the cached key so a changed env is picked up. */
export function resetEncryptionKeyCache(): void {
  cachedKey = undefined;
}

export function secretsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getEncryptionKey(env) !== null;
}

export function encryptSecret(plaintext: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = getEncryptionKey(env);
  if (!key) throw new Error('TOKEN_ENC_KEY not configured; connector credentials cannot be stored');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, enc]).toString('base64');
}

export function decryptSecret(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = getEncryptionKey(env);
  if (!key) throw new Error('TOKEN_ENC_KEY not configured; cannot decrypt connector credentials');
  const buf = Buffer.from(stored, 'base64');
  if (buf.length < 1 + IV_LEN + TAG_LEN) throw new Error('Malformed encrypted secret');
  if (buf[0] !== VERSION) throw new Error(`Unsupported secret version ${buf[0]}`);
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const enc = buf.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
