import { Hono } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { isValidDocument } from '../kosync.js';
import { isItemId, nowSeconds, parseListParams } from '../../models/sync.js';
import { fanOutHighlight } from '../../connectors/fanout.js';
import { documentMeta } from '../../connectors/store.js';

const MAX_BATCH = 50;
const MAX_TEXT = 2048; // matches the firmware's My Clippings.txt export cap
const MAX_NOTE = 4096;
const MAX_CHAPTER = 64;

interface ClippingRow {
  id: string;
  spine_index: number;
  start_page: number;
  end_page: number;
  page_count: number;
  start_word: number;
  end_word: number;
  word_count: number;
  paragraph_index: number | null;
  chapter_title: string;
  text: string;
  note: string | null;
  color: string | null;
  created_at: number;
  deleted: number;
  updated_at: number;
}

function uint(v: unknown, fallback?: number): number | undefined {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff) return v;
  return undefined;
}

export function clippingRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/clippings/:document', (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    const { since, limit } = parseListParams(c);
    const rows = db
      .prepare(
        `SELECT id, spine_index, start_page, end_page, page_count, start_word, end_word, word_count,
                paragraph_index, chapter_title, text, note, color, created_at, deleted, updated_at
         FROM clippings WHERE user_id = ? AND document = ? AND updated_at > ?
         ORDER BY updated_at, id LIMIT ?`
      )
      .all(user.id, document, since, limit + 1) as unknown as ClippingRow[];
    const more = rows.length > limit;
    const items = more ? rows.slice(0, limit) : rows;
    const until = more ? items[items.length - 1].updated_at : nowSeconds();
    return c.json({
      document,
      until,
      more,
      items: items.map((r) => ({
        id: r.id,
        spine: r.spine_index,
        start_page: r.start_page,
        end_page: r.end_page,
        pages: r.page_count,
        start_word: r.start_word,
        end_word: r.end_word,
        words: r.word_count,
        para: r.paragraph_index,
        chapter: r.chapter_title,
        text: r.text,
        note: r.note,
        color: r.color,
        created_at: r.created_at,
        deleted: r.deleted,
        updated_at: r.updated_at,
      })),
    });
  });

  app.put('/clippings/:document', async (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const items = (body as Record<string, unknown> | null)?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const now = nowSeconds();

    const upsert = db.prepare(
      `INSERT INTO clippings (user_id, document, id, spine_index, start_page, end_page, page_count,
                              start_word, end_word, word_count, paragraph_index, chapter_title, text,
                              note, color, created_at, deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(user_id, document, id) DO UPDATE SET
         spine_index = excluded.spine_index,
         start_page = excluded.start_page,
         end_page = excluded.end_page,
         page_count = excluded.page_count,
         start_word = excluded.start_word,
         end_word = excluded.end_word,
         word_count = excluded.word_count,
         paragraph_index = excluded.paragraph_index,
         chapter_title = excluded.chapter_title,
         text = excluded.text,
         note = excluded.note,
         color = excluded.color,
         created_at = excluded.created_at,
         deleted = 0,
         updated_at = excluded.updated_at`
    );
    const tombstone = db.prepare(
      `INSERT INTO clippings (user_id, document, id, deleted, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(user_id, document, id) DO UPDATE SET
         deleted = 1,
         updated_at = excluded.updated_at`
    );

    type Op = () => void;
    const ops: Op[] = [];
    type Highlight = { id: string; text: string; note: string | null; chapter: string; createdAt: number };
    const highlights: Highlight[] = [];
    for (const raw of items) {
      const o = raw as Record<string, unknown>;
      if (!isItemId(o.id)) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      const id = o.id;
      if (o.deleted === 1 || o.deleted === true) {
        ops.push(() => tombstone.run(user.id, document, id, now));
        continue;
      }
      const spine = uint(o.spine);
      const startPage = uint(o.start_page, 0);
      const endPage = uint(o.end_page, 0);
      const pages = uint(o.pages, 1);
      const startWord = uint(o.start_word, 0);
      const endWord = uint(o.end_word, 0);
      const words = uint(o.words, 0);
      const createdAt = uint(o.created_at, 0);
      const para = o.para === undefined || o.para === null ? null : uint(o.para);
      if (
        spine === undefined ||
        startPage === undefined ||
        endPage === undefined ||
        pages === undefined ||
        startWord === undefined ||
        endWord === undefined ||
        words === undefined ||
        createdAt === undefined ||
        para === undefined ||
        typeof o.text !== 'string' ||
        o.text.length === 0 ||
        Buffer.byteLength(o.text) > MAX_TEXT
      ) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      const chapter = typeof o.chapter === 'string' ? o.chapter.slice(0, MAX_CHAPTER) : '';
      const note =
        typeof o.note === 'string' && Buffer.byteLength(o.note) <= MAX_NOTE ? o.note : null;
      const color = typeof o.color === 'string' ? o.color.slice(0, 32) : null;
      const text = o.text;
      ops.push(() =>
        upsert.run(
          user.id, document, id, spine, startPage, endPage, pages,
          startWord, endWord, words, para, chapter, text,
          note, color, createdAt, now
        )
      );
      highlights.push({ id, text, note, chapter, createdAt });
    }
    withTransaction(db, () => {
      for (const op of ops) op();
    });
    // Fan out highlights to connectors that carry them (e.g. Readwise). Best
    // effort; the document's title/author (if synced) become the Readwise book.
    if (highlights.length > 0) {
      const meta = documentMeta(db, user.id, document);
      for (const h of highlights) {
        fanOutHighlight(
          db,
          user.id,
          document,
          h.id,
          {
            text: h.text,
            note: h.note,
            title: meta.title,
            author: meta.author,
            highlightedAt: h.createdAt > 0 ? h.createdAt : null,
          },
          now
        );
      }
    }
    return c.json({ until: now, accepted: ops.length });
  });

  return app;
}
