import type { Context } from 'hono';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export interface ListParams {
  since: number;
  limit: number;
}

/** Parses ?since= and ?limit= for delta-sync list endpoints. */
export function parseListParams(c: Context): ListParams {
  const sinceRaw = Number(c.req.query('since') ?? 0);
  const limitRaw = Number(c.req.query('limit') ?? DEFAULT_LIMIT);
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_LIMIT) : DEFAULT_LIMIT;
  return { since, limit };
}

export function isDocumentHash(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-fA-F]{32}$/.test(v);
}

export function isItemId(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 64 && /^[\x21-\x7e]+$/.test(v);
}
