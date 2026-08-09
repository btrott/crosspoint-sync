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

/**
 * Hardcover connector (Tier 1). Public GraphQL API, per-user bearer token.
 * Carries reading progress + shelf status.
 *
 * !!! LIVE-VERIFY GATE !!!
 * Hardcover's API is beta. The GraphQL operations below (field names, the
 * `me`/search shapes, and the user_book mutation names/status ids) are modeled
 * from the documented schema but MUST be checked against the live GraphQL
 * explorer at https://hardcover.app/account/api before enabling in production.
 * Every network call is funneled through gql() so the exact queries live in one
 * place and are covered by fixture tests. Search the file for GATE to find each
 * spot that needs confirmation.
 */

const ENDPOINT = 'https://api.hardcover.app/v1/graphql';

// GATE: confirm Hardcover's user_book status ids (want-to-read/reading/read).
const STATUS_READING = 2;
const STATUS_READ = 3;

interface HardcoverCred extends Credential {
  token: string;
}

function tokenOf(cred: Credential): string {
  const t = (cred as HardcoverCred).token;
  if (typeof t !== 'string' || t.length === 0) throw new Error('missing hardcover token');
  return t;
}

async function gql(
  http: HttpTransport,
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<{ data?: any; errors?: { message: string }[]; status: number }> {
  const res = await http(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403) {
    return { status: res.status, errors: [{ message: 'unauthorized' }] };
  }
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, data: body.data, errors: body.errors };
}

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  try {
    const token = tokenOf(cred);
    // GATE: confirm the `me` query shape.
    const r = await gql(http, token, `query { me { username } }`, {});
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'invalid token' };
    if (r.errors?.length) return { ok: false, error: r.errors[0].message };
    const username = r.data?.me?.[0]?.username ?? r.data?.me?.username;
    return { ok: true, accountLabel: username ?? undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function match(
  cred: Credential,
  doc: DocumentMeta,
  http: HttpTransport
): Promise<Match | null> {
  const ta = extractTitleAuthor(doc);
  if (!ta) return null;
  const token = tokenOf(cred);
  const q = `${ta.title} ${ta.author}`.trim();
  // GATE: confirm Hardcover's search query name and result shape.
  const r = await gql(
    http,
    token,
    `query Search($q: String!) {
       search(query: $q, query_type: "Book", per_page: 10) {
         results
       }
     }`,
    { q }
  );
  if (r.errors?.length || !r.data) return null;
  const hits = extractSearchHits(r.data);
  if (hits.length === 0) return null;
  const decision = decideMatch(ta.title, ta.author, hits);
  if (!decision.accepted || !decision.best) return null;
  const chosen = hits.find((h) => h.externalId === decision.best!.externalId);
  return {
    externalId: decision.best.externalId,
    confidence: decision.best.score,
    queryUsed: q,
    title: chosen?.title ?? null,
    author: chosen?.author ?? null,
  };
}

/** The user's "Currently Reading" shelf (status_id 2). */
async function listCurrentlyReading(cred: Credential, http: HttpTransport): Promise<ExternalBook[]> {
  const token = tokenOf(cred);
  // GATE: confirm user_books/status_id shape.
  const r = await gql(
    http,
    token,
    `query CurrentlyReading {
       me {
         user_books(where: { status_id: { _eq: 2 } }, limit: 100) {
           book { id title contributions { author { name } } }
         }
       }
     }`,
    {}
  );
  const ubs = r.data?.me?.[0]?.user_books ?? r.data?.me?.user_books ?? [];
  const out: ExternalBook[] = [];
  for (const ub of Array.isArray(ubs) ? ubs : []) {
    const b = ub?.book;
    if (b?.id == null || typeof b?.title !== 'string') continue;
    out.push({
      externalId: String(b.id),
      title: b.title,
      author: b?.contributions?.[0]?.author?.name ?? null,
    });
  }
  return out;
}

/** Free-text catalog search (for the manual-match picker). */
async function search(cred: Credential, query: string, http: HttpTransport): Promise<ExternalBook[]> {
  const token = tokenOf(cred);
  const r = await gql(
    http,
    token,
    `query Search($q: String!) { search(query: $q, query_type: "Book", per_page: 10) { results } }`,
    { q: query }
  );
  if (r.errors?.length || !r.data) return [];
  return extractSearchHits(r.data).map((h) => ({
    externalId: h.externalId,
    title: h.title,
    author: h.author ?? null,
  }));
}

/** GATE: adapt to the real search payload. Handles a couple of plausible shapes. */
export function extractSearchHits(data: any): Candidate[] {
  const raw =
    data?.search?.results?.hits ??
    data?.search?.results ??
    data?.search ??
    [];
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.hits) ? raw.hits : [];
  const out: Candidate[] = [];
  for (const h of arr) {
    const doc = h?.document ?? h;
    const id = doc?.id ?? doc?.book_id;
    const title = doc?.title;
    if (id == null || typeof title !== 'string') continue;
    const author =
      doc?.author_names?.[0] ??
      doc?.contributions?.[0]?.author?.name ??
      doc?.author ??
      undefined;
    out.push({
      externalId: String(id),
      title,
      author,
      popularity: typeof doc?.users_count === 'number' ? doc.users_count : undefined,
    });
  }
  return out;
}

/** Turn a GraphQL/HTTP response into a retry decision, or null if it's fine. */
function classify(r: { status: number; errors?: { message: string }[] }): PushResult | null {
  if (r.status === 401 || r.status === 403) {
    return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  }
  if (r.status === 429) return { ok: false, retryable: true, error: 'rate limited' };
  if (r.status >= 500) return { ok: false, retryable: true, error: `server ${r.status}` };
  if (r.errors?.length) return { ok: false, retryable: false, error: r.errors[0].message };
  return null;
}

interface Edition {
  id: number;
  pages: number;
}

/** Pick an edition with a page count, following the plugin's priority order. */
function pickEdition(meUb: any, data: any): Edition | null {
  const candidates = [
    meUb?.user_book_reads?.[0]?.edition,
    meUb?.edition,
    data?.books_by_pk?.default_ebook_edition,
    data?.books_by_pk?.default_physical_edition,
    data?.editions?.[0],
  ];
  for (const e of candidates) {
    if (e && e.id != null && typeof e.pages === 'number' && e.pages > 0) {
      return { id: Number(e.id), pages: Number(e.pages) };
    }
  }
  return null;
}

/**
 * Progress on Hardcover is page-based and lives on a user_book_read (read
 * session), derived as progress_pages / edition.pages. So: set shelf status,
 * resolve an edition + page count, convert our percentage to pages, then
 * insert/update the read session. Modeled on Billiam/hardcoverapp.koplugin.
 */
async function push(
  cred: Credential,
  m: Match,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<PushResult> {
  const token = tokenOf(cred);
  const bookId = Number(m.externalId);
  if (!Number.isFinite(bookId)) return { ok: false, retryable: false, error: 'bad book id' };
  const pct = Math.max(0, Math.min(1, ev.percentage ?? 0));
  const finished = ev.kind === 'finished' || pct >= 0.999;
  const statusId = finished ? STATUS_READ : STATUS_READING;

  // 1) Set the shelf status (Currently Reading / Read). Best-effort: even if
  //    this errors because the row already exists, we can still set progress.
  const ubRes = await gql(
    http,
    token,
    `mutation SetStatus($bookId: Int!, $statusId: Int!) {
       insert_user_book(object: { book_id: $bookId, status_id: $statusId }) {
         user_book { id }
       }
     }`,
    { bookId, statusId }
  );
  const ubAuth = classify(ubRes);
  if (ubAuth && !ubAuth.ok && ubAuth.needsReauth) return ubAuth;
  let userBookId: number | undefined = ubRes.data?.insert_user_book?.user_book?.id;

  // 2) Resolve the existing read session + an edition with a page count.
  const ctx = await gql(
    http,
    token,
    `query Ctx($bookId: Int!) {
       me {
         user_books(where: { book_id: { _eq: $bookId } }, limit: 1) {
           id
           edition { id pages }
           user_book_reads(order_by: { id: desc }, limit: 1) { id edition { id pages } }
         }
       }
       books_by_pk(id: $bookId) {
         default_ebook_edition { id pages }
         default_physical_edition { id pages }
       }
       editions(where: { book_id: { _eq: $bookId } }, order_by: { users_count: desc_nulls_last }, limit: 1) {
         id pages
       }
     }`,
    { bookId }
  );
  const ctxAuth = classify(ctx);
  if (ctxAuth && !ctxAuth.ok && ctxAuth.needsReauth) return ctxAuth;

  const meUb = ctx.data?.me?.[0]?.user_books?.[0];
  if (!userBookId) userBookId = meUb?.id;
  const latestReadId: number | undefined = meUb?.user_book_reads?.[0]?.id;
  const edition = pickEdition(meUb, ctx.data);

  if (!edition) {
    // Shelf status is synced, but no edition with a known page count exists, so
    // Hardcover has no denominator for a percentage. Nothing more we can do.
    return { ok: true };
  }
  const progressPages = Math.max(0, Math.min(edition.pages, Math.floor(pct * edition.pages)));

  // 3) Write the read session (update the latest, or create one).
  let res;
  if (latestReadId) {
    res = await gql(
      http,
      token,
      `mutation UpdRead($id: Int!, $pages: Int!, $editionId: Int!) {
         update_user_book_read(id: $id, object: { progress_pages: $pages, edition_id: $editionId }) {
           error
           user_book_read { id }
         }
       }`,
      { id: latestReadId, pages: progressPages, editionId: edition.id }
    );
  } else {
    if (!userBookId) return { ok: false, retryable: true, error: 'no user_book to attach a read to' };
    res = await gql(
      http,
      token,
      `mutation InsRead($id: Int!, $pages: Int!, $editionId: Int!) {
         insert_user_book_read(user_book_id: $id, user_book_read: { progress_pages: $pages, edition_id: $editionId }) {
           error
           user_book_read { id }
         }
       }`,
      { id: userBookId, pages: progressPages, editionId: edition.id }
    );
  }
  const readAuth = classify(res);
  if (readAuth) return readAuth;
  const opError =
    res.data?.update_user_book_read?.error ?? res.data?.insert_user_book_read?.error;
  if (opError) return { ok: false, retryable: false, error: String(opError) };
  return { ok: true };
}

export const hardcoverConnector: Connector = {
  id: 'hardcover',
  displayName: 'Hardcover',
  tier: 1,
  capabilities: { read: false, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'token',
  experimental: false,
  validate,
  match,
  push,
  listCurrentlyReading,
  search,
};
