import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { DB } from '../db/db.js';
import { verifyKey } from './password.js';
import { SESSION_COOKIE, verifySession } from './session.js';

export interface AuthedUser {
  id: number;
  username: string;
}

export type AppEnv = {
  Variables: {
    user: AuthedUser;
  };
};

/** kosync-style error bodies; firmware already parses these shapes. */
export function kosyncError(c: Context, status: 401 | 402 | 403, code: number, message: string) {
  return c.json({ code, message }, status);
}

// Verifying PBKDF2 on every request is wasteful; cache successful (user, key) pairs.
const verifiedCache = new Map<string, string>(); // username -> md5Key
const VERIFIED_CACHE_MAX = 10_000;

export function invalidateAuthCache(username: string): void {
  verifiedCache.delete(username);
}

export function authMiddleware(db: DB): MiddlewareHandler<AppEnv> {
  const getUser = db.prepare('SELECT id, username, key_hash FROM users WHERE username = ?');
  return async (c, next) => {
    const username = c.req.header('x-auth-user');
    const key = c.req.header('x-auth-key');
    if (!username || !key) {
      return kosyncError(c, 401, 2001, 'Unauthorized');
    }
    const row = getUser.get(username) as
      | { id: number; username: string; key_hash: string }
      | undefined;
    if (!row) {
      return kosyncError(c, 401, 2001, 'Unauthorized');
    }
    if (verifiedCache.get(username) !== key) {
      if (!verifyKey(key, row.key_hash)) {
        return kosyncError(c, 401, 2001, 'Unauthorized');
      }
      if (verifiedCache.size >= VERIFIED_CACHE_MAX) {
        verifiedCache.clear();
      }
      verifiedCache.set(username, key);
    }
    c.set('user', { id: row.id, username: row.username });
    await next();
  };
}

/**
 * Accept EITHER a web session cookie OR the device x-auth headers. Used for the
 * /api/v1 surface so both the browser (cookie) and the firmware (headers) reach
 * the same endpoints. The cookie path is checked first and is cheap (HMAC, no
 * PBKDF2); falls through to header auth when absent.
 */
export function sessionOrKeyAuth(db: DB): MiddlewareHandler<AppEnv> {
  const headerAuth = authMiddleware(db);
  const getById = db.prepare('SELECT id, username FROM users WHERE id = ?');
  return async (c, next) => {
    const session = verifySession(getCookie(c, SESSION_COOKIE));
    if (session) {
      const row = getById.get(session.uid) as { id: number; username: string } | undefined;
      if (row) {
        c.set('user', { id: row.id, username: row.username });
        return next();
      }
    }
    return headerAuth(c, next);
  };
}

/** Minimal in-memory per-IP fixed-window rate limiter. */
export function rateLimiter(limitPerMinute: number): MiddlewareHandler {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return async (c, next) => {
    if (limitPerMinute <= 0) return next();
    const ip =
      c.req.header('cf-connecting-ip') ??
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ??
      'unknown';
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now - entry.windowStart >= 60_000) {
      if (hits.size > 50_000) hits.clear();
      hits.set(ip, { windowStart: now, count: 1 });
    } else {
      entry.count++;
      if (entry.count > limitPerMinute) {
        return c.json({ code: 2001, message: 'Too many requests' }, 429);
      }
    }
    await next();
  };
}
