import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookkeepConnector, baseUrl, eventId } from '../src/connectors/bookkeep.js';
import type { HttpTransport, OutboundEvent } from '../src/connectors/types.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { drainQueue } from '../src/connectors/runner.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

function fakeTransport() {
  const calls: { url: string; method: string; headers?: Record<string, string>; body?: string }[] = [];
  const handlers: { match: string; status: number; body: unknown }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const handler = [...handlers].reverse().find((item) => url.includes(item.match));
    const status = handler?.status ?? 200;
    const body = handler?.body ?? {};
    return {
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    };
  };
  return {
    transport,
    calls,
    on: (match: string, status: number, body: unknown) => handlers.push({ match, status, body }),
  };
}

const CRED = { baseUrl: 'https://bookkeep.example.com/', token: 'bkp_secret' };

beforeEach(() => {
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64);
  resetEncryptionKeyCache();
});

afterEach(() => {
  delete process.env.TOKEN_ENC_KEY;
  resetEncryptionKeyCache();
});

describe('Bookkeep connector', () => {
  it('requires HTTP(S) and removes the trailing slash', () => {
    expect(baseUrl('https://bookkeep.example.com/')).toBe('https://bookkeep.example.com');
    expect(baseUrl('http://localhost:8000///')).toBe('http://localhost:8000');
    expect(() => baseUrl('bookkeep.example.com')).toThrow(/HTTP or HTTPS/);
    expect(() => baseUrl('ftp://bookkeep.example.com')).toThrow(/HTTP or HTTPS/);
  });

  it('validates the bearer token and uses display_name as the label', async () => {
    const fake = fakeTransport();
    fake.on('/api/v1/me', 200, { id: 1, login: 'reader@example.com', display_name: 'Reader' });
    const result = await bookkeepConnector.validate(CRED, fake.transport);
    expect(result).toEqual({ ok: true, accountLabel: 'Reader' });
    expect(fake.calls[0]).toMatchObject({
      url: 'https://bookkeep.example.com/api/v1/me',
      method: 'GET',
      headers: { authorization: 'Bearer bkp_secret', accept: 'application/json' },
    });
  });

  it('searches user-scoped candidates and applies the shared ambiguity rules', async () => {
    const fake = fakeTransport();
    fake.on('/books/search', 200, {
      candidates: [
        {
          book_id: 42,
          title: 'The Left Hand of Darkness',
          author: 'Ursula K. Le Guin',
          confidence: 1,
          library_status: 'want_to_read',
          match_reason: 'metadata',
        },
      ],
    });
    const match = await bookkeepConnector.match(
      CRED,
      {
        document: DOC,
        title: 'The Left Hand of Darkness',
        author: 'Ursula K. Le Guin',
        filename: 'The Left Hand of Darkness.epub',
      },
      fake.transport
    );
    expect(match).toMatchObject({ externalId: '42', confidence: 1 });
    const request = JSON.parse(fake.calls[0].body!);
    expect(request).toEqual({
      title: 'The Left Hand of Darkness',
      author: 'Ursula K. Le Guin',
      isbn: null,
      filename: 'The Left Hand of Darkness.epub',
    });
  });

  it('maps in-progress books and manual title search to ExternalBook values', async () => {
    const fake = fakeTransport();
    fake.on('/books/in-progress', 200, [
      { id: 7, title: 'Foundryside', author: 'Robert Jackson Bennett', library_status: 'reading' },
    ]);
    expect(await bookkeepConnector.listCurrentlyReading!(CRED, fake.transport)).toEqual([
      { externalId: '7', title: 'Foundryside', author: 'Robert Jackson Bennett' },
    ]);

    fake.on('/books/search', 200, {
      candidates: [{ book_id: 8, title: 'Shorefall', author: 'Robert Jackson Bennett', confidence: 1 }],
    });
    expect(await bookkeepConnector.search!(CRED, ' Shorefall ', fake.transport)).toEqual([
      { externalId: '8', title: 'Shorefall', author: 'Robert Jackson Bennett' },
    ]);
    expect(JSON.parse(fake.calls[1].body!)).toEqual({ title: 'Shorefall' });
  });

  it('pushes the exact progress contract with a deterministic retry-safe event ID', async () => {
    const fake = fakeTransport();
    fake.on('/books/42/progress', 200, { event_id: 'ok' });
    const ev: OutboundEvent = {
      kind: 'progress',
      document: DOC,
      percentage: 0.42,
      timestamp: 1787680800,
    };
    const result = await bookkeepConnector.push(CRED, { externalId: '42', confidence: 1 }, ev, fake.transport);
    expect(result).toEqual({ ok: true });
    const expectedId = `cps_${crypto
      .createHash('sha256')
      .update(JSON.stringify({ document: DOC, kind: 'progress', percentage: 0.42, timestamp: 1787680800 }))
      .digest('hex')}`;
    expect(eventId(ev, 0.42)).toBe(expectedId);
    expect(JSON.parse(fake.calls[0].body!)).toEqual({
      event_id: expectedId,
      document: DOC,
      kind: 'progress',
      percentage: 0.42,
      occurred_at: new Date(1787680800 * 1000).toISOString(),
    });
  });

  it.each([
    [401, false, true],
    [403, false, true],
    [404, false, false],
    [409, false, false],
    [422, false, false],
    [429, true, false],
    [503, true, false],
  ])('classifies status %i correctly', async (status, retryable, needsReauth) => {
    const fake = fakeTransport();
    fake.on('/progress', status, {});
    const result = await bookkeepConnector.push(
      CRED,
      { externalId: '42', confidence: 1 },
      { kind: 'finished', document: DOC, percentage: 1, timestamp: 1787680800 },
      fake.transport
    );
    expect(result).toMatchObject({ ok: false, retryable });
    if (!result.ok) expect(!!result.needsReauth).toBe(needsReauth);
  });

  it('links, matches, and delivers progress end to end', async () => {
    const fake = fakeTransport();
    fake.on('/api/v1/me', 200, { login: 'reader@example.com' });
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const linked = await app.request('/api/v1/connectors/bookkeep', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: CRED }),
    });
    expect(linked.status).toBe(200);

    await app.request('/api/v1/documents', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        items: [{ document: DOC, title: 'Foundryside', author: 'Robert Jackson Bennett' }],
      }),
    });
    fake.on('/books/search', 200, {
      candidates: [{ book_id: 7, title: 'Foundryside', author: 'Robert Jackson Bennett', confidence: 1 }],
    });
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: '/body/p[3]', percentage: 0.5, device_id: 'reader' }),
    });
    fake.on('/books/7/progress', 200, {});
    await drainQueue(db, fake.transport, 10);

    const pushed = fake.calls.find((call) => call.method === 'PUT' && call.url.includes('/books/7/progress'));
    expect(pushed).toBeDefined();
    expect(JSON.parse(pushed!.body!)).toMatchObject({ document: DOC, kind: 'progress', percentage: 0.5 });
  });
});
