import { decideMatch, extractTitleAuthor, type Candidate } from './matching.js';
import type {
  Connector,
  Credential,
  DocumentMeta,
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
  return {
    externalId: decision.best.externalId,
    confidence: decision.best.score,
    queryUsed: q,
  };
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

async function push(
  cred: Credential,
  m: Match,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<PushResult> {
  const token = tokenOf(cred);
  const bookId = Number(m.externalId);
  const finished = ev.kind === 'finished' || (ev.percentage ?? 0) >= 0.999;
  const status = finished ? STATUS_READ : STATUS_READING;

  // GATE: confirm the upsert mutation name/args. Hardcover uses an
  // insert_user_book / update_user_book pattern keyed by book + status.
  const mutation = `
    mutation SetStatus($bookId: Int!, $status: Int!) {
      insert_user_book(object: { book_id: $bookId, status_id: $status }) {
        id
      }
    }`;
  const r = await gql(http, token, mutation, { bookId, status });

  if (r.status === 401 || r.status === 403) {
    return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  }
  if (r.status === 429) {
    return { ok: false, retryable: true, error: 'rate limited' };
  }
  if (r.errors?.length) {
    // GraphQL validation errors won't fix themselves on retry.
    return { ok: false, retryable: false, error: r.errors[0].message };
  }
  if (r.status >= 500) {
    return { ok: false, retryable: true, error: `server ${r.status}` };
  }
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
};
