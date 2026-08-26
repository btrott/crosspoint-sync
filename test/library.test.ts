import { describe, expect, it } from 'vitest';
import { makeTestApp, registerUser } from './helpers.js';

const DOC_META = '11111111111111111111111111111111';
const DOC_BOOKMARK = '22222222222222222222222222222222';
const DOC_STATS = '33333333333333333333333333333333';
const DOC_OTHER_USER = '44444444444444444444444444444444';

describe('account library API', () => {
  it('unifies known documents, reports each linked service, and isolates users', async () => {
    const { app, db } = makeTestApp();
    const first = await registerUser(app);
    const second = await registerUser(app);
    const userId = (db.prepare('SELECT id FROM users WHERE username = ?').get(first.username) as { id: number }).id;
    const otherUserId = (db.prepare('SELECT id FROM users WHERE username = ?').get(second.username) as { id: number }).id;

    db.prepare(
      `INSERT INTO documents (user_id, document, title, author, filename, updated_at)
       VALUES (?, ?, 'Foundryside', 'Robert Jackson Bennett', 'foundryside.epub', 10)`
    ).run(userId, DOC_META);
    db.prepare(
      `INSERT INTO progress (user_id, document, device_id, percentage, progress, updated_at)
       VALUES (?, ?, 'reader', 0.42, '/body/p[1]', 20)`
    ).run(userId, DOC_META);
    db.prepare(
      `INSERT INTO bookmarks (user_id, document, id, updated_at) VALUES (?, ?, 'bookmark-1', 30)`
    ).run(userId, DOC_BOOKMARK);
    db.prepare(
      `INSERT INTO stats_device_book (user_id, device_id, document, payload, updated_at)
       VALUES (?, 'reader', ?, '{}', 40)`
    ).run(userId, DOC_STATS);
    db.prepare(
      `INSERT INTO documents (user_id, document, title, updated_at)
       VALUES (?, ?, 'Private to another user', 100)`
    ).run(otherUserId, DOC_OTHER_USER);

    const insertAccount = db.prepare(
      `INSERT INTO connector_accounts
       (user_id, connector_id, cred_enc, account_label, status, enabled, created_at, updated_at)
       VALUES (?, ?, 'test-secret', ?, 'ok', 1, 1, 1)`
    );
    insertAccount.run(userId, 'hardcover', 'reader-one');
    insertAccount.run(userId, 'bookkeep', 'reader-two');

    const insertMatch = db.prepare(
      `INSERT INTO connector_matches
       (user_id, connector_id, document, external_id, confidence, source, updated_at)
       VALUES (?, 'hardcover', ?, ?, ?, ?, 50)`
    );
    insertMatch.run(userId, DOC_META, 'hc-1', 0.98, 'auto');
    insertMatch.run(userId, DOC_BOOKMARK, null, 0, 'manual');

    const insertQueue = db.prepare(
      `INSERT INTO connector_queue
       (user_id, connector_id, document, kind, payload, status, next_try_at, created_at, updated_at, last_error)
       VALUES (?, 'bookkeep', ?, 'progress', '{}', ?, 0, 1, ?, ?)`
    );
    insertQueue.run(userId, DOC_META, 'done', 60, null);
    insertQueue.run(userId, DOC_BOOKMARK, 'pending', 70, null);
    insertQueue.run(userId, DOC_STATS, 'dead', 80, 'Remote book was deleted');

    const response = await app.request('/api/v1/library', { headers: first.headers });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.services.map((service: { id: string }) => service.id)).toEqual([
      'bookkeep',
      'hardcover',
    ]);
    expect(body.items.map((item: { document: string }) => item.document).sort()).toEqual([
      DOC_META,
      DOC_BOOKMARK,
      DOC_STATS,
    ]);
    expect(body.items.some((item: { document: string }) => item.document === DOC_OTHER_USER)).toBe(false);

    const metadata = body.items.find((item: { document: string }) => item.document === DOC_META);
    expect(metadata).toMatchObject({
      title: 'Foundryside',
      author: 'Robert Jackson Bennett',
      percentage: 0.42,
    });
    expect(metadata.services.hardcover).toMatchObject({ state: 'matched', external_id: 'hc-1' });
    expect(metadata.services.bookkeep).toMatchObject({ state: 'synced', done: 1 });

    const bookmark = body.items.find((item: { document: string }) => item.document === DOC_BOOKMARK);
    expect(bookmark.services.hardcover.state).toBe('ignored');
    expect(bookmark.services.bookkeep.state).toBe('queued');

    const stats = body.items.find((item: { document: string }) => item.document === DOC_STATS);
    expect(stats.services.bookkeep).toMatchObject({
      state: 'error',
      dead: 1,
      last_error: 'Remote book was deleted',
    });

    const otherResponse = await app.request('/api/v1/library', { headers: second.headers });
    const otherBody = await otherResponse.json();
    expect(otherBody.services).toEqual([]);
    expect(otherBody.items.map((item: { document: string }) => item.document)).toEqual([
      DOC_OTHER_USER,
    ]);
  });
});
