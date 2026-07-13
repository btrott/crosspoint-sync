import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, md5, registerUser } from './helpers.js';

/**
 * Byte-precise replay of what the CrossPoint/CrossInk firmware's
 * KOReaderSyncClient sends (see lib/KOReaderSync/KOReaderSyncClient.cpp) and
 * what stock KOReader expects back. This suite is the compatibility gate.
 */
describe('kosync protocol compatibility', () => {
  it('registers a user: POST /users/create -> 201 {username}', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/users/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'justin', password: md5('hunter2') }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ username: 'justin' });
  });

  it('rejects a duplicate username with 402 / code 2002', async () => {
    const { app } = makeTestApp();
    const body = JSON.stringify({ username: 'justin', password: md5('hunter2') });
    await app.request('/users/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const res = await app.request('/users/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 2002, message: 'Username is already registered.' });
  });

  it('rejects registration when disabled', async () => {
    const { app } = makeTestApp({ registrationDisabled: true });
    const res = await app.request('/users/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'justin', password: md5('hunter2') }),
    });
    expect(res.status).toBe(403);
  });

  it('GET /users/auth -> 200 {authorized:"OK"} with firmware headers', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request('/users/auth', { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: 'OK' });
  });

  it('GET /users/auth -> 401 / code 2001 on wrong key and missing headers', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const bad = await app.request('/users/auth', {
      headers: { ...headers, 'x-auth-key': md5('wrong password') },
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ code: 2001, message: 'Unauthorized' });

    const missing = await app.request('/users/auth');
    expect(missing.status).toBe(401);
  });

  it('PUT /syncs/progress replays the exact firmware body -> {document, timestamp:int}', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document: DOC,
        progress: '/body/DocFragment[8]/body/div[2]/p[4]/text()[1].96',
        percentage: 0.4867,
        device: 'CrossPoint',
        device_id: 'crossink-device',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document).toBe(DOC);
    expect(Number.isInteger(body.timestamp)).toBe(true);
  });

  it('GET /syncs/progress/:document returns all kosync fields', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document: DOC,
        progress: '/body/DocFragment[8]/body/div[2]/p[4]/text()[1].96',
        percentage: 0.4867,
        device: 'CrossPoint',
        device_id: 'crossink-device',
      }),
    });
    const res = await app.request(`/syncs/progress/${DOC}`, { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      document: DOC,
      progress: '/body/DocFragment[8]/body/div[2]/p[4]/text()[1].96',
      percentage: 0.4867,
      device: 'CrossPoint',
      device_id: 'crossink-device',
      timestamp: body.timestamp,
    });
    expect(Number.isInteger(body.timestamp)).toBe(true);
  });

  it('GET with no stored progress returns 200 with {} (stock kosync quirk)', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request(`/syncs/progress/${'0'.repeat(32)}`, { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('newest device wins across devices (multi-device ping-pong fix)', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document: DOC,
        progress: 'old',
        percentage: 0.1,
        device: 'reader-a',
        device_id: 'aaaa',
      }),
    });
    // Backdate device A so device B's write is strictly newer within the same second.
    db.prepare('UPDATE progress SET updated_at = updated_at - 100 WHERE device_id = ?').run('aaaa');
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document: DOC,
        progress: 'new',
        percentage: 0.6,
        device: 'reader-b',
        device_id: 'bbbb',
      }),
    });
    const res = await app.request(`/syncs/progress/${DOC}`, { headers });
    const body = await res.json();
    expect(body.progress).toBe('new');
    expect(body.device_id).toBe('bbbb');
  });

  it('PUT without device_id falls back to device name (KOReader configs vary)', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: 'p', percentage: 0.2, device: 'boox' }),
    });
    expect(res.status).toBe(200);
    const got = await (await app.request(`/syncs/progress/${DOC}`, { headers })).json();
    expect(got.device_id).toBe('boox');
  });

  it('rejects malformed progress bodies with 403', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    for (const bad of [
      {},
      { document: DOC },
      { document: DOC, progress: 'p', percentage: 1.5 },
      { document: 'not/a/hash!', progress: 'p', percentage: 0.5 },
    ]) {
      const res = await app.request('/syncs/progress', {
        method: 'PUT',
        headers,
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(403);
    }
  });

  it('requires auth on sync endpoints', async () => {
    const { app } = makeTestApp();
    const res = await app.request(`/syncs/progress/${DOC}`);
    expect(res.status).toBe(401);
  });
});
