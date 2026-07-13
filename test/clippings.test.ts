import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';

// Mirrors CrossInk's Clipping struct (src/ClippingStore.h)
const CLIP = {
  id: 'c0ffee0011223344',
  spine: 7,
  start_page: 12,
  end_page: 13,
  pages: 40,
  start_word: 5,
  end_word: 22,
  words: 30,
  para: 96,
  chapter: 'Chapter 8',
  text: 'So we beat on, boats against the current, borne back ceaselessly into the past.',
  created_at: 1752300000,
};

describe('v1 clippings sync', () => {
  it('round-trips a clipping with all CrossInk fields', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const put = await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [CLIP] }),
    });
    expect(put.status).toBe(200);
    const body = await (await app.request(`/api/v1/clippings/${DOC}`, { headers })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ ...CLIP, deleted: 0, note: null, color: null });
  });

  it('para is optional (CrossInk uses UINT16_MAX for unavailable)', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const { para: _para, ...noPara } = CLIP;
    await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [noPara] }),
    });
    const body = await (await app.request(`/api/v1/clippings/${DOC}`, { headers })).json();
    expect(body.items[0].para).toBeNull();
  });

  it('supports notes and colors (server-side extension fields)', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ ...CLIP, note: 'my note', color: 'yellow' }] }),
    });
    const body = await (await app.request(`/api/v1/clippings/${DOC}`, { headers })).json();
    expect(body.items[0].note).toBe('my note');
    expect(body.items[0].color).toBe('yellow');
  });

  it('tombstones delete a clipping', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [CLIP] }),
    });
    await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ id: CLIP.id, deleted: 1 }] }),
    });
    const body = await (await app.request(`/api/v1/clippings/${DOC}`, { headers })).json();
    expect(body.items[0].deleted).toBe(1);
  });

  it('rejects oversized text', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ ...CLIP, text: 'x'.repeat(3000) }] }),
    });
    expect(res.status).toBe(403);
  });
});
