import crypto from 'node:crypto';
import { decideMatch, extractTitleAuthor, normalizeText, type Candidate } from './matching.js';
import type {
  Connector,
  Credential,
  DocumentMeta,
  ExternalBook,
  HttpTransport,
  Match,
  OutboundEvent,
  PushResult,
  ValidateResult,
} from './types.js';

/**
 * Grimmory connector. CrossPoint readers can use filename document IDs (which
 * survive EPUB optimization), while Grimmory keys KOReader progress by the
 * current file hash. The Komga-compatible API bridges those identities:
 *
 *   CrossPoint metadata -> stable Grimmory book id -> current fileHash
 *
 * The book id is cached as the match. The hash is deliberately fetched before
 * every push because Grimmory changes it when the library file is replaced.
 */

interface GrimmoryCred extends Credential {
  server: string;
  kosyncUsername: string;
  kosyncPassword: string;
  opdsUsername: string;
  opdsPassword: string;
}

interface GrimmoryBook extends Candidate {
  fileHash?: string;
}

function stringField(cred: Credential, camel: string, snake: string, trim = true): string {
  const value = cred[camel] ?? cred[snake];
  return typeof value === 'string' ? (trim ? value.trim() : value) : '';
}

function parseCred(cred: Credential): GrimmoryCred | null {
  const server = stringField(cred, 'server', 'server');
  const kosyncUsername = stringField(cred, 'kosyncUsername', 'kosync_username');
  const kosyncPassword = stringField(cred, 'kosyncPassword', 'kosync_password', false);
  const opdsUsername = stringField(cred, 'opdsUsername', 'opds_username');
  const opdsPassword = stringField(cred, 'opdsPassword', 'opds_password', false);
  if (!server || !kosyncUsername || !kosyncPassword || !opdsUsername || !opdsPassword) return null;
  return { server, kosyncUsername, kosyncPassword, opdsUsername, opdsPassword };
}

/** Normalize the Grimmory root URL, accepting its KOReader URL as a convenience. */
export function baseUrl(server: string): string {
  let url = server.includes('://') ? server : `https://${server}`;
  while (url.endsWith('/')) url = url.slice(0, -1);
  return url.replace(/\/api\/koreader$/i, '');
}

function basicHeaders(c: GrimmoryCred): Record<string, string> {
  const token = Buffer.from(`${c.opdsUsername}:${c.opdsPassword}`, 'utf8').toString('base64');
  return { authorization: `Basic ${token}`, accept: 'application/json' };
}

function kosyncHeaders(c: GrimmoryCred): Record<string, string> {
  return {
    'x-auth-user': c.kosyncUsername,
    'x-auth-key': crypto.createHash('md5').update(c.kosyncPassword).digest('hex'),
    accept: 'application/vnd.koreader.v1+json',
    'content-type': 'application/json',
  };
}

async function getJson(http: HttpTransport, c: GrimmoryCred, path: string) {
  const res = await http(`${baseUrl(c.server)}${path}`, {
    method: 'GET',
    headers: basicHeaders(c),
  });
  let body: any = null;
  if (res.status >= 200 && res.status < 300) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }
  return { status: res.status, body };
}

export function bookToCandidate(raw: any): GrimmoryBook | null {
  const id = raw?.id;
  const title = raw?.metadata?.title ?? raw?.name;
  if (id == null || typeof title !== 'string' || title.trim().length === 0) return null;
  const authors = Array.isArray(raw?.metadata?.authors) ? raw.metadata.authors : [];
  const writer = authors.find((a: any) => a?.role === 'writer' && typeof a?.name === 'string');
  const first = authors.find((a: any) => typeof a?.name === 'string');
  const author = writer?.name ?? first?.name;
  return {
    externalId: String(id),
    title,
    author: typeof author === 'string' ? author : undefined,
    fileHash: typeof raw?.fileHash === 'string' ? raw.fileHash : undefined,
  };
}

function pageBooks(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.content)) return body.content;
  return [];
}

/** Read the accessible Grimmory catalog, following its Komga pagination. */
async function catalog(http: HttpTransport, c: GrimmoryCred): Promise<GrimmoryBook[]> {
  const out: GrimmoryBook[] = [];
  for (let page = 0; page < 100; page += 1) {
    const r = await getJson(http, c, `/komga/api/v1/books?page=${page}&size=100&clean=true`);
    if (r.status === 401 || r.status === 403) throw new Error('invalid OPDS credentials');
    if (r.status === 404) throw new Error('Grimmory Komga API is unavailable or disabled');
    if (r.status < 200 || r.status >= 300) throw new Error(`Grimmory catalog returned ${r.status}`);
    const rows = pageBooks(r.body);
    for (const raw of rows) {
      const book = bookToCandidate(raw);
      if (book) out.push(book);
    }
    const totalPages = typeof r.body?.totalPages === 'number' ? r.body.totalPages : null;
    if (r.body?.last === true || (totalPages != null && page + 1 >= totalPages) || rows.length < 100) break;
  }
  return out;
}

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  const c = parseCred(cred);
  if (!c) {
    return {
      ok: false,
      error: 'server, KOReader username/password, and OPDS username/password are required',
    };
  }
  try {
    const ko = await http(`${baseUrl(c.server)}/api/koreader/users/auth`, {
      method: 'GET',
      headers: kosyncHeaders(c),
    });
    if (ko.status === 401 || ko.status === 403) return { ok: false, error: 'invalid KOReader credentials' };
    if (ko.status < 200 || ko.status >= 300) {
      return { ok: false, error: `Grimmory KOReader API returned ${ko.status}` };
    }

    const opds = await getJson(http, c, '/komga/api/v2/users/me');
    if (opds.status === 401 || opds.status === 403) return { ok: false, error: 'invalid OPDS credentials' };
    if (opds.status === 404) return { ok: false, error: 'Grimmory Komga API is unavailable or disabled' };
    if (opds.status < 200 || opds.status >= 300) {
      return { ok: false, error: `Grimmory Komga API returned ${opds.status}` };
    }
    const label = typeof opds.body?.email === 'string' ? opds.body.email.split('@')[0] : c.opdsUsername;
    return { ok: true, accountLabel: `${label} @ ${new URL(baseUrl(c.server)).host}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function match(cred: Credential, doc: DocumentMeta, http: HttpTransport): Promise<Match | null> {
  const c = parseCred(cred);
  const ta = extractTitleAuthor(doc);
  if (!c || !ta) return null;
  const books = await catalog(http, c);
  const decision = decideMatch(ta.title, ta.author, books);
  if (!decision.accepted || !decision.best) return null;
  const chosen = books.find((b) => b.externalId === decision.best!.externalId);
  return {
    externalId: decision.best.externalId,
    confidence: decision.best.score,
    queryUsed: ta.title,
    title: chosen?.title ?? null,
    author: chosen?.author ?? null,
  };
}

async function search(cred: Credential, query: string, http: HttpTransport): Promise<ExternalBook[]> {
  const c = parseCred(cred);
  if (!c) return [];
  const q = normalizeText(query);
  if (!q) return [];
  const books = await catalog(http, c);
  return books
    .filter((b) => normalizeText(`${b.title} ${b.author ?? ''}`).includes(q))
    .slice(0, 50)
    .map(({ externalId, title, author }) => ({ externalId, title, author: author ?? null }));
}

async function push(
  cred: Credential,
  m: Match,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<PushResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, retryable: false, needsReauth: true, error: 'bad credential' };
  try {
    const book = await getJson(
      http,
      c,
      `/komga/api/v1/books/${encodeURIComponent(m.externalId)}?clean=true`
    );
    if (book.status === 401 || book.status === 403) {
      return { ok: false, retryable: false, needsReauth: true, error: 'OPDS authentication failed' };
    }
    if (book.status === 404) return { ok: false, retryable: false, error: 'matched Grimmory book no longer exists' };
    if (book.status === 429 || book.status >= 500) {
      return { ok: false, retryable: true, error: `Grimmory book lookup returned ${book.status}` };
    }
    if (book.status < 200 || book.status >= 300) {
      return { ok: false, retryable: false, error: `Grimmory book lookup returned ${book.status}` };
    }
    const candidate = bookToCandidate(book.body);
    const hash = candidate?.fileHash;
    if (!hash) return { ok: false, retryable: false, error: 'matched Grimmory book has no fileHash' };

    const percentage = Math.max(0, Math.min(1, ev.percentage ?? 0));
    const res = await http(`${baseUrl(c.server)}/api/koreader/syncs/progress`, {
      method: 'PUT',
      headers: kosyncHeaders(c),
      body: JSON.stringify({
        document: hash,
        progress: ev.progress && ev.progress.length > 0 ? ev.progress : String(percentage),
        percentage,
        device: 'CrossPoint Sync',
        device_id: 'crosspoint-sync-grimmory',
      }),
    });
    if (res.status === 200 || res.status === 202) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, retryable: false, needsReauth: true, error: 'KOReader authentication failed' };
    }
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, retryable: true, error: `Grimmory progress update returned ${res.status}` };
    }
    return { ok: false, retryable: false, error: `Grimmory progress update returned ${res.status}` };
  } catch (err) {
    return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
  }
}

export const grimmoryConnector: Connector = {
  id: 'grimmory',
  displayName: 'Grimmory',
  tier: 1,
  capabilities: { read: false, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'grimmory',
  experimental: false,
  matchBy: 'metadata',
  validate,
  match,
  push,
  search,
};
