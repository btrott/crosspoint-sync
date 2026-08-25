import crypto from 'node:crypto';
import { decideMatch, extractTitleAuthor, type Candidate } from './matching.js';
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

interface BookkeepCred extends Credential {
  baseUrl: string;
  token: string;
}

interface BookkeepCandidate extends Candidate {
  confidence?: number;
}

function parseCred(cred: Credential): BookkeepCred | null {
  const rawUrl = cred.baseUrl ?? cred.server;
  const rawToken = cred.token;
  if (typeof rawUrl !== 'string' || typeof rawToken !== 'string') return null;
  const token = rawToken.trim();
  if (!token) return null;
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const baseUrl = url.toString().replace(/\/+$/, '');
    return { baseUrl, token };
  } catch {
    return null;
  }
}

/** Normalize a configured Bookkeep URL. Throws when it is not HTTP(S). */
export function baseUrl(server: string): string {
  const parsed = parseCred({ baseUrl: server, token: '_' });
  if (!parsed) throw new Error('Bookkeep server URL must be a valid HTTP or HTTPS URL');
  return parsed.baseUrl;
}

function headers(c: BookkeepCred, jsonBody = false): Record<string, string> {
  return {
    authorization: `Bearer ${c.token}`,
    accept: 'application/json',
    ...(jsonBody ? { 'content-type': 'application/json' } : {}),
  };
}

async function responseJson(res: Awaited<ReturnType<HttpTransport>>): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function candidatesFrom(body: any): BookkeepCandidate[] {
  const rows = Array.isArray(body?.candidates) ? body.candidates : [];
  const out: BookkeepCandidate[] = [];
  for (const row of rows) {
    if (row?.book_id == null || typeof row?.title !== 'string') continue;
    out.push({
      externalId: String(row.book_id),
      title: row.title,
      author: typeof row.author === 'string' ? row.author : undefined,
      confidence: typeof row.confidence === 'number' ? row.confidence : undefined,
    });
  }
  return out;
}

function booksFrom(body: any): ExternalBook[] {
  if (!Array.isArray(body)) return [];
  const out: ExternalBook[] = [];
  for (const row of body) {
    if (row?.id == null || typeof row?.title !== 'string') continue;
    out.push({
      externalId: String(row.id),
      title: row.title,
      author: typeof row.author === 'string' ? row.author : null,
    });
  }
  return out;
}

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, error: 'server URL and API token are required' };
  try {
    const res = await http(`${c.baseUrl}/api/v1/me`, {
      method: 'GET',
      headers: headers(c),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'invalid API token' };
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `Bookkeep returned ${res.status}` };
    }
    const body = await responseJson(res);
    const label =
      typeof body?.display_name === 'string' && body.display_name.trim()
        ? body.display_name
        : typeof body?.login === 'string'
          ? body.login
          : undefined;
    return { ok: true, accountLabel: label };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function searchCandidates(
  c: BookkeepCred,
  payload: Record<string, unknown>,
  http: HttpTransport
): Promise<BookkeepCandidate[]> {
  const res = await http(`${c.baseUrl}/api/v1/integrations/crosspoint/books/search`, {
    method: 'POST',
    headers: headers(c, true),
    body: JSON.stringify(payload),
  });
  if (res.status === 401 || res.status === 403) throw new Error('Bookkeep authentication failed');
  if (res.status < 200 || res.status >= 300) throw new Error(`Bookkeep search returned ${res.status}`);
  return candidatesFrom(await responseJson(res));
}

async function match(
  cred: Credential,
  doc: DocumentMeta,
  http: HttpTransport
): Promise<Match | null> {
  const c = parseCred(cred);
  const ta = extractTitleAuthor(doc);
  if (!c || !ta) return null;
  const candidates = await searchCandidates(
    c,
    { title: doc.title, author: doc.author, isbn: null, filename: doc.filename },
    http
  );
  const decision = decideMatch(ta.title, ta.author, candidates);
  if (!decision.accepted || !decision.best) return null;
  const chosen = candidates.find((candidate) => candidate.externalId === decision.best!.externalId);
  return {
    externalId: decision.best.externalId,
    confidence: decision.best.score,
    queryUsed: `${ta.title} ${ta.author}`.trim(),
    title: chosen?.title ?? null,
    author: chosen?.author ?? null,
  };
}

async function listCurrentlyReading(
  cred: Credential,
  http: HttpTransport
): Promise<ExternalBook[]> {
  const c = parseCred(cred);
  if (!c) return [];
  const res = await http(`${c.baseUrl}/api/v1/books/in-progress`, {
    method: 'GET',
    headers: headers(c),
  });
  if (res.status === 401 || res.status === 403) throw new Error('Bookkeep authentication failed');
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Bookkeep in-progress list returned ${res.status}`);
  }
  return booksFrom(await responseJson(res));
}

async function search(
  cred: Credential,
  query: string,
  http: HttpTransport
): Promise<ExternalBook[]> {
  const c = parseCred(cred);
  const title = query.trim();
  if (!c || !title) return [];
  const candidates = await searchCandidates(c, { title }, http);
  return candidates.map(({ externalId, title: bookTitle, author }) => ({
    externalId,
    title: bookTitle,
    author: author ?? null,
  }));
}

/** Stable across retries, matching Bookkeep ADR 08's prescribed property order. */
export function eventId(ev: OutboundEvent, percentage: number): string {
  const canonical = JSON.stringify({
    document: ev.document,
    kind: ev.kind,
    percentage,
    timestamp: ev.timestamp,
  });
  return `cps_${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

async function push(
  cred: Credential,
  m: Match,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<PushResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, retryable: false, needsReauth: true, error: 'bad credential' };
  const percentage = Math.max(0, Math.min(1, ev.percentage ?? (ev.kind === 'finished' ? 1 : 0)));
  try {
    const res = await http(
      `${c.baseUrl}/api/v1/integrations/crosspoint/books/${encodeURIComponent(m.externalId)}/progress`,
      {
        method: 'PUT',
        headers: headers(c, true),
        body: JSON.stringify({
          event_id: eventId(ev, percentage),
          document: ev.document,
          kind: ev.kind,
          percentage,
          occurred_at: new Date(ev.timestamp * 1000).toISOString(),
        }),
      }
    );
    if (res.status >= 200 && res.status < 300) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, retryable: false, needsReauth: true, error: 'Bookkeep authentication failed' };
    }
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, retryable: true, error: `Bookkeep progress update returned ${res.status}` };
    }
    if (res.status === 404) {
      return { ok: false, retryable: false, error: 'matched Bookkeep book is not in this user library' };
    }
    return { ok: false, retryable: false, error: `Bookkeep progress update returned ${res.status}` };
  } catch (err) {
    return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
  }
}

export const bookkeepConnector: Connector = {
  id: 'bookkeep',
  displayName: 'Bookkeep',
  tier: 1,
  capabilities: { read: false, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'bookkeep',
  experimental: false,
  matchBy: 'metadata',
  validate,
  match,
  push,
  listCurrentlyReading,
  search,
};
