import { describe, expect, it } from 'vitest';
import {
  combineGlobalStats,
  combineHistory,
  currentStreak,
  longestStreak,
  HISTORY_BYTES,
  type GlobalStatsSnapshot,
} from '../src/models/stats.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

function historyFromDays(setBits: number[]): string {
  const buf = Buffer.alloc(HISTORY_BYTES);
  for (const bit of setBits) {
    buf[bit >> 3] |= 1 << (bit & 7);
  }
  return buf.toString('base64');
}

function snapshot(overrides: Partial<GlobalStatsSnapshot> = {}): GlobalStatsSnapshot {
  return {
    v: 5,
    sessions: 10,
    seconds: 3600,
    pages: 200,
    completed: 1,
    tod: [100, 200, 300, 400],
    dow: [1, 2, 3, 4, 5, 6, 7],
    anchor_day: 9650,
    history_b64: historyFromDays([0, 1, 2]),
    streak: 3,
    ...overrides,
  };
}

describe('stats bitmap model', () => {
  it('combines histories with re-anchoring (older device shifts)', () => {
    // Device A anchored at day 9650, read on days 9650, 9649, 9648 (bits 0,1,2).
    // Device B anchored at day 9648, read on day 9648 (bit 0) and 9645 (bit 3).
    const combined = combineHistory([
      { anchor_day: 9650, history_b64: historyFromDays([0, 1, 2]) },
      { anchor_day: 9648, history_b64: historyFromDays([0, 3]) },
    ]);
    expect(combined.anchorDay).toBe(9650);
    // Day 9648 from B lands on bit 2 (already set); day 9645 lands on bit 5.
    expect(longestStreak(combined.history)).toBe(3);
    expect(currentStreak(combined.history)).toBe(3);
    expect((combined.history[0] >> 5) & 1).toBe(1);
  });

  it('current streak skips an unset anchor day (today not read yet)', () => {
    const { history } = combineHistory([
      { anchor_day: 9650, history_b64: historyFromDays([1, 2, 3]) },
    ]);
    expect(currentStreak(history)).toBe(3);
  });

  it('longest streak found mid-window', () => {
    const { history } = combineHistory([
      { anchor_day: 9650, history_b64: historyFromDays([0, 10, 11, 12, 13, 20]) },
    ]);
    expect(longestStreak(history)).toBe(4);
  });

  it('sums scalars and buckets; streak is max of computed and device-reported', () => {
    const sum = combineGlobalStats([
      snapshot(),
      snapshot({ sessions: 5, seconds: 100, streak: 21 }),
    ]);
    expect(sum.sessions).toBe(15);
    expect(sum.seconds).toBe(3700);
    expect(sum.tod).toEqual([200, 400, 600, 800]);
    expect(sum.dow).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(sum.streak).toBe(21); // device-reported all-time streak wins
  });

  it('handles empty snapshot list', () => {
    const sum = combineGlobalStats([]);
    expect(sum.sessions).toBe(0);
    expect(sum.anchor_day).toBe(0);
    expect(sum.streak).toBe(0);
  });
});

describe('v1 stats endpoints', () => {
  const globalBody = (deviceId: string, extra: Partial<GlobalStatsSnapshot> = {}) => ({
    device_id: deviceId,
    device: 'CrossInk',
    ...snapshot(extra),
  });

  it('stores per-device global snapshots and aggregates in /stats/summary', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    for (const [id, extra] of [
      ['aaaa', {}],
      ['bbbb', { sessions: 90, streak: 21 }],
    ] as const) {
      const res = await app.request('/api/v1/stats/global', {
        method: 'PUT',
        headers,
        body: JSON.stringify(globalBody(id, extra)),
      });
      expect(res.status).toBe(200);
    }
    const summary = await (await app.request('/api/v1/stats/summary', { headers })).json();
    expect(summary.sessions).toBe(100);
    expect(summary.streak).toBe(21);
    expect(summary.devices).toHaveLength(2);
  });

  it('re-uploading a snapshot replaces it (never accumulates)', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    for (let i = 0; i < 3; i++) {
      await app.request('/api/v1/stats/global', {
        method: 'PUT',
        headers,
        body: JSON.stringify(globalBody('aaaa')),
      });
    }
    const summary = await (await app.request('/api/v1/stats/summary', { headers })).json();
    expect(summary.sessions).toBe(10);
  });

  it('per-book stats: batch PUT, per-device GET with combined totals', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const bookItem = (over: Record<string, unknown> = {}) => ({
      document: DOC,
      v: 5,
      sessions: 9,
      seconds: 8400,
      pages: 310,
      completed: false,
      avg_fwd: 12,
      pace_n: 250,
      eta: 5400,
      start_manual: false,
      finish_manual: false,
      start_date: 1751000000,
      finished_date: 0,
      tod: [0, 3000, 4000, 1400],
      dow: [0, 0, 1200, 0, 2000, 3000, 2200],
      ...over,
    });
    for (const [deviceId, over] of [
      ['aaaa', {}],
      ['bbbb', { sessions: 1, seconds: 600, completed: true, avg_fwd: 20, pace_n: 50 }],
    ] as const) {
      const res = await app.request('/api/v1/stats/books', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ device_id: deviceId, items: [bookItem(over)] }),
      });
      expect(res.status).toBe(200);
    }
    const body = await (await app.request(`/api/v1/stats/books/${DOC}`, { headers })).json();
    expect(body.devices).toHaveLength(2);
    expect(body.combined.sessions).toBe(10);
    expect(body.combined.seconds).toBe(9000);
    expect(body.combined.completed).toBe(true);
    // Weighted pace: (12*250 + 20*50) / 300 = 13.33 -> 13
    expect(body.combined.avg_fwd).toBe(13);
  });

  it('rejects malformed snapshots', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request('/api/v1/stats/global', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'aaaa', sessions: 'lots' }),
    });
    expect(res.status).toBe(403);
  });
});
