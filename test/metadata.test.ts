import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';

const PUT_BODY = {
  document: DOC,
  progress: '/body/DocFragment[16]/body/div[1]/p[143]',
  percentage: 0.2853,
  device: 'CrossPoint',
  device_id: 'crosspoint-reader',
};

const METADATA = {
  filename: 'Foundryside - Robert Jackson Bennett.epub',
  title: 'Foundryside',
  authors: 'Robert Jackson Bennett',
};

describe('document metadata capture (KOReader PR #15306 shape)', () => {
  it('kosync PUT with metadata populates the documents table', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...PUT_BODY, metadata: METADATA }),
    });
    expect(res.status).toBe(200);
    const docs = await (await app.request('/api/v1/documents', { headers })).json();
    expect(docs.items).toHaveLength(1);
    expect(docs.items[0]).toMatchObject({
      document: DOC,
      title: 'Foundryside',
      author: 'Robert Jackson Bennett',
      filename: METADATA.filename,
    });
  });

  it('a later PUT without metadata keeps stored metadata', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...PUT_BODY, metadata: METADATA }),
    });
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...PUT_BODY, percentage: 0.31 }),
    });
    const docs = await (await app.request('/api/v1/documents', { headers })).json();
    expect(docs.items[0].title).toBe('Foundryside');
  });

  it('partial metadata does not null out other fields', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...PUT_BODY, metadata: METADATA }),
    });
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...PUT_BODY, metadata: { filename: 'renamed.epub' } }),
    });
    const docs = await (await app.request('/api/v1/documents', { headers })).json();
    expect(docs.items[0].filename).toBe('renamed.epub');
    expect(docs.items[0].title).toBe('Foundryside');
    expect(docs.items[0].author).toBe('Robert Jackson Bennett');
  });

  it('invalid metadata is ignored, not fatal', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...PUT_BODY, metadata: 'not-an-object' }),
    });
    expect(res.status).toBe(200);
    const docs = await (await app.request('/api/v1/documents', { headers })).json();
    expect(docs.items).toHaveLength(0);
  });
});

describe('GET /api/v1/progress (document list)', () => {
  it('lists newest progress per document joined with metadata', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    const doc2 = 'b'.repeat(32);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...PUT_BODY, metadata: METADATA }),
    });
    // Second book from two devices; device bbbb is newer.
    for (const [deviceId, pct] of [
      ['aaaa', 0.5],
      ['bbbb', 0.7],
    ] as const) {
      await app.request('/syncs/progress', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ document: doc2, progress: 'p', percentage: pct, device_id: deviceId }),
      });
    }
    db.prepare('UPDATE progress SET updated_at = updated_at - 100 WHERE device_id = ?').run('aaaa');
    db.prepare('UPDATE progress SET updated_at = updated_at - 50 WHERE document = ?').run(DOC);

    const res = await app.request('/api/v1/progress', { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    // Newest overall first
    expect(body.items[0]).toMatchObject({ document: doc2, percentage: 0.7, device_id: 'bbbb' });
    expect(body.items[1]).toMatchObject({
      document: DOC,
      title: 'Foundryside',
      filename: METADATA.filename,
    });
    expect(body.items[0].title).toBeNull();
  });

  it('requires auth', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/api/v1/progress');
    expect(res.status).toBe(401);
  });
});
