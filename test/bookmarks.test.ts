import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';

const BM = {
  id: '9f86d081884c7d65',
  xpath: '/body/DocFragment[3]/body/p[12]/text().0',
  percentage: 0.35,
  summary: 'It was the best of times, it was the worst of',
  si: 3,
  pc: 120,
  pp: 42,
};

describe('v1 bookmarks sync', () => {
  it('round-trips a batch upsert', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const put = await app.request(`/api/v1/bookmarks/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [BM] }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).accepted).toBe(1);

    const res = await app.request(`/api/v1/bookmarks/${DOC}`, { headers });
    const body = await res.json();
    expect(body.more).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ ...BM, deleted: 0 });
  });

  it('re-upserting the same id is idempotent (LWW)', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request(`/api/v1/bookmarks/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [BM] }),
    });
    await app.request(`/api/v1/bookmarks/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ ...BM, summary: 'updated' }] }),
    });
    const body = await (await app.request(`/api/v1/bookmarks/${DOC}`, { headers })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].summary).toBe('updated');
  });

  it('tombstones delete and still appear in delta responses', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request(`/api/v1/bookmarks/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [BM] }),
    });
    await app.request(`/api/v1/bookmarks/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ id: BM.id, deleted: 1 }] }),
    });
    const body = await (await app.request(`/api/v1/bookmarks/${DOC}`, { headers })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].deleted).toBe(1);
  });

  it('paginates with since/limit and the more flag', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    const items = Array.from({ length: 5 }, (_, i) => ({
      ...BM,
      id: `bm${i}`,
      percentage: i / 10,
    }));
    await app.request(`/api/v1/bookmarks/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items }),
    });
    // Spread updated_at so the cursor has distinct values to page over.
    for (let i = 0; i < 5; i++) {
      db.prepare('UPDATE bookmarks SET updated_at = updated_at + ? WHERE id = ?').run(i, `bm${i}`);
    }
    const page1 = await (
      await app.request(`/api/v1/bookmarks/${DOC}?limit=2`, { headers })
    ).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.more).toBe(true);
    const page2 = await (
      await app.request(`/api/v1/bookmarks/${DOC}?since=${page1.until}&limit=100`, { headers })
    ).json();
    expect(page2.more).toBe(false);
    const seen = [...page1.items, ...page2.items].map((i: { id: string }) => i.id);
    expect(new Set(seen).size).toBe(5);
  });

  it('rejects invalid items', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    for (const bad of [
      { items: [] },
      { items: [{ xpath: 'x', percentage: 0.5 }] }, // no id
      { items: [{ id: 'a', xpath: 'x', percentage: 2 }] },
    ]) {
      const res = await app.request(`/api/v1/bookmarks/${DOC}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(403);
    }
  });
});
