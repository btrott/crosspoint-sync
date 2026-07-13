import { describe, expect, it } from 'vitest';
import { hashKey, verifyKey } from '../src/auth/password.js';
import { makeTestApp, md5 } from './helpers.js';

describe('password hashing', () => {
  it('hashes and verifies the md5 auth key', () => {
    const key = md5('hunter2');
    const stored = hashKey(key);
    expect(stored.startsWith('pbkdf2$10000$')).toBe(true);
    expect(verifyKey(key, stored)).toBe(true);
    expect(verifyKey(md5('wrong'), stored)).toBe(false);
  });

  it('rejects malformed stored hashes without throwing', () => {
    expect(verifyKey('abc', 'garbage')).toBe(false);
    expect(verifyKey('abc', 'pbkdf2$notanumber$aa$bb')).toBe(false);
  });
});

describe('registration validation', () => {
  it('rejects bad usernames and empty passwords', async () => {
    const { app } = makeTestApp();
    for (const body of [
      { username: 'has spaces', password: md5('x') },
      { username: '', password: md5('x') },
      { username: 'ok', password: '' },
      { username: 'ok' },
      {},
    ]) {
      const res = await app.request('/users/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    }
  });

  it('healthz is unauthenticated', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });
});
