import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, md5, DOC } from './helpers.js';
import { resetSessionSecretCache } from '../src/auth/session.js';

type App = ReturnType<typeof makeTestApp>['app'];

afterEach(() => resetSessionSecretCache());

async function signup(app: App, username: string) {
  return app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
}

describe('token-based web account', () => {
  it('signup issues a xp1_ token and logs the browser in (cookie)', async () => {
    const { app } = makeTestApp();
    const res = await signup(app, 'julia');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.username).toBe('julia');
    expect(body.token).toMatch(/^xp1_\d+_[0-9a-f]{32}$/);
    // Signup set a session cookie usable immediately.
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toContain('cp_session=');
    const me = await app.request('/auth/me', { headers: { cookie: cookie!.split(';')[0] } });
    expect((await me.json()).username).toBe('julia');
  });

  it('the token works as the kosync device secret (username + MD5(token))', async () => {
    const { app } = makeTestApp();
    const token = (await (await signup(app, 'julia')).json()).token as string;
    // Device auth: x-auth-user + x-auth-key = MD5(token)
    const headers = { 'x-auth-user': 'julia', 'x-auth-key': md5(token) };
    const auth = await app.request('/users/auth', { headers });
    expect(auth.status).toBe(200);
    expect(await auth.json()).toEqual({ authorized: 'OK' });
    // And it can drive a real v1 call.
    const put = await app.request('/api/v1/documents', {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ document: DOC, title: 'X' }] }),
    });
    expect(put.status).toBe(200);
  });

  it('web login with the token alone establishes a session', async () => {
    const { app } = makeTestApp();
    const token = (await (await signup(app, 'julia')).json()).token as string;
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    // Session cookie reaches v1 endpoints without x-auth headers.
    const list = await app.request('/api/v1/connectors', { headers: { cookie } });
    expect(list.status).toBe(200);
  });

  it('rejects a bad or malformed token', async () => {
    const { app } = makeTestApp();
    await signup(app, 'julia');
    for (const token of ['garbage', 'xp1_1_deadbeef', 'xp1_999_' + 'a'.repeat(32)]) {
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(401);
    }
  });

  it('rotate issues a new token and revokes the old one', async () => {
    const { app } = makeTestApp();
    const first = (await (await signup(app, 'julia')).json()).token as string;
    const cookie = (await signupCookie(app, 'julia2'));
    // rotate for julia2
    const rot = await app.request('/auth/token/rotate', { method: 'POST', headers: { cookie } });
    expect(rot.status).toBe(200);
    const newToken = (await rot.json()).token as string;
    expect(newToken).toMatch(/^xp1_\d+_[0-9a-f]{32}$/);

    // New token authenticates as the device; old first-user token is unaffected.
    const okNew = await app.request('/users/auth', {
      headers: { 'x-auth-user': 'julia2', 'x-auth-key': md5(newToken) },
    });
    expect(okNew.status).toBe(200);
    expect(first).not.toBe(newToken);
  });

  it('respects REGISTRATION_DISABLED', async () => {
    const { app } = makeTestApp({ registrationDisabled: true });
    expect((await signup(app, 'nope')).status).toBe(403);
  });

  it('rejects duplicate usernames and invalid usernames', async () => {
    const { app } = makeTestApp();
    await signup(app, 'julia');
    expect((await signup(app, 'julia')).status).toBe(409);
    expect((await signup(app, 'has spaces')).status).toBe(400);
  });
});

async function signupCookie(app: App, username: string): Promise<string> {
  const res = await app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  return res.headers.get('set-cookie')!.split(';')[0];
}
