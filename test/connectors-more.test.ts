import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { drainQueue } from '../src/connectors/runner.js';
import { claimReady } from '../src/connectors/queue.js';
import { kosyncConnector, baseUrl } from '../src/connectors/kosync.js';
import { bookfusionConnector, extractBooks } from '../src/connectors/bookfusion.js';
import { hardcoverConnector } from '../src/connectors/hardcover.js';

function fakeTransport() {
  const calls: { url: string; method: string; body?: string }[] = [];
  const handlers: { match: string; status: number; body: unknown }[] = [];
  const t: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const h = [...handlers].reverse().find((x) => url.includes(x.match) || (init.body ?? '').includes(x.match));
    const status = h?.status ?? 200;
    const body = h?.body ?? {};
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body };
  };
  return { transport: t, calls, on: (m: string, s: number, b: unknown) => handlers.push({ match: m, status: s, body: b }) };
}

const KEY = { TOKEN_ENC_KEY: 'a'.repeat(64) };
beforeEach(() => { Object.assign(process.env, KEY); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });

describe('kosync mirror connector (unit)', () => {
  it('normalizes server URLs', () => {
    expect(baseUrl('sync.koreader.rocks:443')).toBe('https://sync.koreader.rocks:443');
    expect(baseUrl('https://x.com/')).toBe('https://x.com');
  });

  it('matches by identity (no network, same document hash)', async () => {
    const fake = fakeTransport();
    const m = await kosyncConnector.match({ server: 's', username: 'u', password: 'p' }, { document: DOC, title: null, author: null, filename: null }, fake.transport);
    expect(m).toEqual({ externalId: DOC, confidence: 1 });
    expect(fake.calls).toHaveLength(0);
  });

  it('validate hits /users/auth with x-auth headers', async () => {
    const fake = fakeTransport();
    fake.on('/users/auth', 200, {});
    const v = await kosyncConnector.validate({ server: 'srv.test', username: 'u', password: 'p' }, fake.transport);
    expect(v.ok).toBe(true);
    expect(fake.calls[0].url).toContain('/users/auth');
  });

  it('push forwards progress string + position to the target', async () => {
    const fake = fakeTransport();
    fake.on('/syncs/progress', 200, {});
    const r = await kosyncConnector.push(
      { server: 'srv.test', username: 'u', password: 'p' },
      { externalId: DOC, confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.4, progress: '/body/p[1]', position: { pctQ: 400000 }, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    const body = JSON.parse(fake.calls[0].body!);
    expect(body).toMatchObject({ document: DOC, progress: '/body/p[1]', percentage: 0.4, position: { pctQ: 400000 } });
  });
});

describe('kosync mirror fan-out (end to end)', () => {
  it('a device progress push enqueues + delivers to the mirror', async () => {
    const fake = fakeTransport();
    fake.on('/users/auth', 200, {}); // validate on link
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    // Link an external kosync mirror.
    const link = await app.request('/api/v1/connectors/kosync', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { server: 'mirror.test', username: 'u', password: 'p' } }),
    });
    expect(link.status).toBe(200);
    // Device pushes progress.
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: '/body/p[2]', percentage: 0.5, device_id: 'd1' }),
    });
    expect(claimReady(db, 10).length).toBeGreaterThan(0);
    fake.on('/syncs/progress', 200, {});
    await drainQueue(db, fake.transport, 10);
    // A mirror PUT to the target server happened.
    expect(fake.calls.some((c) => c.url.includes('mirror.test') && c.url.includes('/syncs/progress') && c.method === 'PUT')).toBe(true);
    expect(claimReady(db, 10)).toHaveLength(0);
  });
});

describe('backfill / "Sync now"', () => {
  it('enqueues existing progress for a newly linked connector', async () => {
    const fake = fakeTransport();
    fake.on('/users/auth', 200, {});
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    for (const [doc, pct] of [
      ['a'.repeat(32), 0.4],
      ['b'.repeat(32), 0.99],
    ] as const) {
      await app.request('/syncs/progress', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ document: doc, progress: 'p', percentage: pct, device_id: 'd1' }),
      });
    }
    await app.request('/api/v1/connectors/kosync', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { server: 'mirror.test', username: 'u', password: 'p' } }),
    });
    expect(claimReady(db, 10)).toHaveLength(0);
    const res = await app.request('/api/v1/connectors/kosync/sync', { method: 'POST', headers });
    expect(res.status).toBe(200);
    expect((await res.json()).queued).toBe(2);
    expect(claimReady(db, 10)).toHaveLength(2);
    fake.on('/syncs/progress', 200, {});
    await drainQueue(db, fake.transport, 10);
    expect(fake.calls.filter((c) => c.url.includes('mirror.test') && c.method === 'PUT')).toHaveLength(2);
  });

  it('sync on an unlinked connector is a 400', async () => {
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const res = await app.request('/api/v1/connectors/kosync/sync', { method: 'POST', headers });
    expect(res.status).toBe(400);
  });
});

describe('hardcover progress push', () => {
  it('sets status and writes a read session with pages = floor(pct * edition.pages)', async () => {
    const fake = fakeTransport();
    fake.on('user_books', 200, {
      data: {
        me: [{ user_books: [{ id: 10, edition: { id: 5, pages: 400 }, user_book_reads: [] }] }],
        books_by_pk: { default_ebook_edition: { id: 5, pages: 400 }, default_physical_edition: null },
        editions: [],
      },
    });
    fake.on('insert_user_book', 200, { data: { insert_user_book: { user_book: { id: 10 } } } });
    fake.on('insert_user_book_read', 200, {
      data: { insert_user_book_read: { error: null, user_book_read: { id: 99 } } },
    });

    const r = await hardcoverConnector.push(
      { token: 't' },
      { externalId: '42', confidence: 1 },
      { kind: 'progress', document: 'd', percentage: 0.5, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    const readCall = fake.calls.find((c) => c.body?.includes('insert_user_book_read'));
    expect(readCall).toBeTruthy();
    expect(readCall!.body).toContain('"pages":200');
    expect(readCall!.body).toContain('"editionId":5');
  });

  it('updates the existing read session when one exists', async () => {
    const fake = fakeTransport();
    fake.on('user_books', 200, {
      data: {
        me: [{ user_books: [{ id: 10, edition: { id: 5, pages: 300 }, user_book_reads: [{ id: 77, edition: { id: 5, pages: 300 } }] }] }],
        books_by_pk: {},
        editions: [],
      },
    });
    fake.on('insert_user_book', 200, { data: { insert_user_book: { user_book: { id: 10 } } } });
    fake.on('update_user_book_read', 200, { data: { update_user_book_read: { error: null, user_book_read: { id: 77 } } } });

    const r = await hardcoverConnector.push(
      { token: 't' },
      { externalId: '42', confidence: 1 },
      { kind: 'progress', document: 'd', percentage: 1, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    const upd = fake.calls.find((c) => c.body?.includes('update_user_book_read'));
    expect(upd!.body).toContain('"id":77');
    expect(upd!.body).toContain('"pages":300'); // 100% of 300
  });

  it('still succeeds (status only) when no edition has a page count', async () => {
    const fake = fakeTransport();
    fake.on('user_books', 200, { data: { me: [{ user_books: [] }], books_by_pk: {}, editions: [] } });
    fake.on('insert_user_book', 200, { data: { insert_user_book: { user_book: { id: 10 } } } });
    const r = await hardcoverConnector.push(
      { token: 't' },
      { externalId: '42', confidence: 1 },
      { kind: 'progress', document: 'd', percentage: 0.5, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    expect(
      fake.calls.some(
        (c) => c.body?.includes('insert_user_book_read') || c.body?.includes('update_user_book_read')
      )
    ).toBe(false);
  });
});

describe('bookfusion connector', () => {
  it('extractBooks handles the search payload', () => {
    const hits = extractBooks({ books: [{ id: 7, title: 'Foundryside', authors: [{ name: 'Robert Jackson Bennett' }] }] });
    expect(hits).toEqual([{ externalId: '7', title: 'Foundryside', author: 'Robert Jackson Bennett' }]);
  });

  it('device-code begin + poll yields a credential', async () => {
    const fake = fakeTransport();
    fake.on('/api/user/auth/device', 200, { device_code: 'DC', user_code: 'WXYZ', verification_uri: 'https://bookfusion.com/link', interval: 1, expires_in: 900 });
    const start = await bookfusionConnector.beginLink!(fake.transport);
    expect(start).toMatchObject({ deviceCode: 'DC', userCode: 'WXYZ' });

    fake.on('/api/user/auth/token', 200, { error: 'authorization_pending' });
    expect((await bookfusionConnector.pollLink!('DC', fake.transport)).status).toBe('pending');
    fake.on('/api/user/auth/token', 200, { access_token: 'BF-TOKEN' });
    const done = await bookfusionConnector.pollLink!('DC', fake.transport);
    expect(done.status).toBe('ok');
    expect(done.credential).toEqual({ access_token: 'BF-TOKEN' });
  });

  it('link/begin + link/poll endpoints link the account', async () => {
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    fake.on('/api/user/auth/device', 200, { device_code: 'DC', user_code: 'WXYZ', verification_uri: 'https://bookfusion.com/link' });
    const begin = await app.request('/api/v1/connectors/bookfusion/link/begin', { method: 'POST', headers });
    expect(begin.status).toBe(200);
    const { device_code } = await begin.json();

    fake.on('/api/user/auth/token', 200, { access_token: 'BF-TOKEN' });
    fake.on('/api/user/books/search', 200, {}); // validate
    const poll = await app.request('/api/v1/connectors/bookfusion/link/poll', {
      method: 'POST',
      headers,
      body: JSON.stringify({ device_code }),
    });
    expect(poll.status).toBe(200);
    expect((await poll.json()).linked).toBe(true);

    const list = await (await app.request('/api/v1/connectors', { headers })).json();
    expect(list.connectors.find((c: { id: string }) => c.id === 'bookfusion').linked).toBe(true);
  });

  it('push maps 0..1 to 0..100 reading_position', async () => {
    const fake = fakeTransport();
    fake.on('/reading_position', 200, {});
    const r = await bookfusionConnector.push(
      { access_token: 't' },
      { externalId: '7', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.25, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    expect(JSON.parse(fake.calls[0].body!).percentage).toBe(25);
  });
});
