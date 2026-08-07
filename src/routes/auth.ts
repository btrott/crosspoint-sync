import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { DB } from '../db/db.js';
import type { Config } from '../config.js';
import type { AppEnv } from '../auth/middleware.js';
import { hashKey, verifyKey } from '../auth/password.js';
import { rateLimiter } from '../auth/middleware.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  signSession,
  verifySession,
} from '../auth/session.js';
import { nowSeconds } from '../models/sync.js';
import { USERNAME_RE } from './kosync.js';

/**
 * Token-based web accounts. There are no passwords: signup issues a generated
 * token (shown once) that IS the credential. The device sends it as the kosync
 * secret (username + token, MD5'd by the client); the web pastes the token to
 * establish a session cookie. We store PBKDF2(MD5(token)) in users.key_hash —
 * the exact shape device auth already verifies — so one secret works for both.
 *
 * Token format: xp1_<userId>_<hex>. The embedded id lets the web log in from
 * the token alone (no username needed); security is the random secret + hash.
 */

const TOKEN_RE = /^xp1_(\d+)_[0-9a-f]{32}$/;

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

function makeToken(userId: number): string {
  return `xp1_${userId}_${crypto.randomBytes(16).toString('hex')}`;
}

function setSessionCookie(c: Context<AppEnv>, userId: number) {
  const proto = c.req.header('x-forwarded-proto');
  const secure = proto ? proto.split(',')[0].trim() === 'https' : false;
  setCookie(c, SESSION_COOKIE, signSession(userId), {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function authRoutes(db: DB, config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Create an account: pick a username, receive a token (shown once).
  app.post('/signup', rateLimiter(config.authRateLimitPerMinute), async (c) => {
    if (config.registrationDisabled) {
      return c.json({ error: 'Registration is disabled' }, 403);
    }
    let username: string | null = null;
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      username = typeof body.username === 'string' ? body.username.trim() : null;
    } catch {
      /* fall through to validation error */
    }
    if (!username || !USERNAME_RE.test(username)) {
      return c.json({ error: 'Invalid username' }, 400);
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return c.json({ error: 'Username is already registered' }, 409);
    }
    // Insert to get the id, then bake it into the token and store its hash.
    const token = crypto.randomBytes(16).toString('hex');
    const info = db
      .prepare('INSERT INTO users (username, key_hash, created_at) VALUES (?, ?, ?)')
      .run(username, '', nowSeconds());
    const userId = Number(info.lastInsertRowid);
    const fullToken = `xp1_${userId}_${token}`;
    db.prepare('UPDATE users SET key_hash = ? WHERE id = ?').run(hashKey(md5(fullToken)), userId);
    setSessionCookie(c, userId);
    return c.json({ username, token: fullToken });
  });

  // Web login: paste the token, get a session cookie.
  app.post('/login', rateLimiter(config.authRateLimitPerMinute), async (c) => {
    let token: string | null = null;
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      token = typeof body.token === 'string' ? body.token.trim() : null;
    } catch {
      /* fall through */
    }
    const parsed = token?.match(TOKEN_RE);
    if (!token || !parsed) return c.json({ error: 'Invalid token' }, 401);
    const userId = Number(parsed[1]);
    const row = db
      .prepare('SELECT key_hash FROM users WHERE id = ?')
      .get(userId) as { key_hash: string } | undefined;
    if (!row || !verifyKey(md5(token), row.key_hash)) {
      return c.json({ error: 'Invalid token' }, 401);
    }
    setSessionCookie(c, userId);
    return c.json({ ok: true });
  });

  app.post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/me', (c) => {
    const session = verifySession(getCookie(c, SESSION_COOKIE));
    if (!session) return c.json({ error: 'Not signed in' }, 401);
    const row = db
      .prepare('SELECT username FROM users WHERE id = ?')
      .get(session.uid) as { username: string } | undefined;
    if (!row) return c.json({ error: 'Not signed in' }, 401);
    return c.json({ username: row.username });
  });

  // Rotate the token (revokes the old one — the device must be updated).
  // Requires an active web session.
  app.post('/token/rotate', (c) => {
    const session = verifySession(getCookie(c, SESSION_COOKIE));
    if (!session) return c.json({ error: 'Not signed in' }, 401);
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(session.uid);
    if (!exists) return c.json({ error: 'Not signed in' }, 401);
    const fullToken = makeToken(session.uid);
    db.prepare('UPDATE users SET key_hash = ? WHERE id = ?').run(
      hashKey(md5(fullToken)),
      session.uid
    );
    return c.json({ token: fullToken });
  });

  return app;
}
