import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { collect, liveStatus } from '../src/worker.js';

const tunnel = '11111111-1111-1111-1111-111111111111';
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_observations.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_transitions.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0003_drop_observations.sql', import.meta.url), 'utf8'));
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), TUNNEL_ID: tunnel,
    CLOUDFLARE_API_TOKEN: 'test-secret',
    DB: { prepare(sql) { return { bind(...args) {
      const statement = db.prepare(sql);
      return {
        async run() { return statement.run(...args); },
        async first() { return statement.get(...args) ?? null; },
        async all() { return { results: statement.all(...args) }; }
      };
    } }; } }
  };
  return { db, env };
}
const event = minute => ({ scheduledTime: Date.UTC(2026, 8, 17, 0, minute) });
const reply = status => async () => Response.json({ success: true, result: {
  id: tunnel, status, conns_inactive_at: '2026-09-16T23:59:00Z'
} });

test('stores transitions only and keeps one current row', async () => {
  const { db, env } = setup();
  for (const [i, status] of ['healthy','healthy','degraded','down','down','healthy'].entries()) {
    await collect(event(i), env, reply(status));
  }
  assert.deepEqual(db.prepare('SELECT status FROM transitions ORDER BY scheduled_at').all().map(r => r.status), ['up','down','up']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tunnel_state').get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'observations'").get().n, 0);
  assert.equal(db.prepare('SELECT outcome FROM outages').get().outcome, 'recovered');
  db.close();
});

test('duplicate and stale invocations do not alter state or history', async () => {
  const { db, env } = setup();
  await collect(event(2), env, reply('healthy'));
  await collect(event(2), env, reply('down'));
  await collect(event(1), env, reply('down'));
  assert.equal(db.prepare('SELECT status FROM tunnel_state').get().status, 'up');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transitions').get().n, 1);
  db.close();
});

test('API failures are unknown, repeated failures do not grow history', async () => {
  const { db, env } = setup();
  const failures = [
    async () => new Response('', { status: 429 }),
    async () => new Response('not JSON'),
    async () => { throw new DOMException('timeout', 'TimeoutError'); },
    async () => Response.json({ success: false }), reply('unexpected'),
    async () => Response.json({ success: true, result: { id: 'wrong', status: 'down' } })
  ];
  for (const [i, fetcher] of failures.entries()) await collect(event(i), env, fetcher);
  assert.equal(db.prepare('SELECT status FROM transitions').get().status, 'unknown');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transitions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outages').get().n, 0);
  db.close();
});

test('missed checks break outage continuity even when status is unchanged', async () => {
  const { db, env } = setup();
  await collect(event(0), env, reply('down'));
  await collect(event(2), env, reply('down'));
  assert.deepEqual(db.prepare('SELECT status FROM transitions ORDER BY scheduled_at').all().map(r => r.status), ['down','unknown','down']);
  assert.deepEqual(db.prepare('SELECT outcome FROM outages ORDER BY first_down_at').all().map(r => r.outcome).sort(), ['open','uncertain']);
  await collect(event(3), env, reply('degraded'));
  assert.deepEqual(db.prepare('SELECT outcome FROM outages').all().map(r => r.outcome).sort(), ['recovered','uncertain']);
  db.close();
});

test('migration reconstructs transitions and gaps before dropping old observations', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_observations.sql', import.meta.url), 'utf8'));
  const insert = db.prepare('INSERT INTO observations (tunnel_id, scheduled_at, observed_at, status) VALUES (?, ?, ?, ?)');
  for (const [i, status] of [[0,'healthy'],[1,'degraded'],[2,'down'],[4,'down'],[5,'healthy']]) {
    const t = new Date(event(i).scheduledTime).toISOString();
    insert.run(tunnel, t, t, status);
  }
  db.exec(readFileSync(new URL('../migrations/0002_transitions.sql', import.meta.url), 'utf8'));
  assert.deepEqual(db.prepare('SELECT status FROM transitions ORDER BY scheduled_at').all().map(r => r.status), ['up','down','unknown','down','up']);
  db.exec(readFileSync(new URL('../migrations/0003_drop_observations.sql', import.meta.url), 'utf8'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'observations'").get().n, 0);
  assert.equal(db.prepare('SELECT status FROM tunnel_state').get().status, 'up');
  db.close();
});

test('configuration and database failures fail the invocation', async () => {
  const { db, env } = setup();
  await assert.rejects(collect(event(0), { ...env, TUNNEL_ID: '' }, reply('down')), /Configure/);
  db.close();
  await assert.rejects(collect(event(0), env, reply('down')));
});

test('dashboard API reads current state, history, and outages after cleanup', async () => {
  const { db, env } = setup();
  await collect(event(0), env, reply('down'));
  await collect(event(1), env, reply('healthy'));
  const response = await worker.fetch(new Request('https://example.test/api/dashboard'), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.current.status, 'up');
  assert.deepEqual(result.transitions.map(row => row.status), ['down', 'up']);
  assert.equal(result.outages[0].outcome, 'recovered');
  assert.equal(result.totals.outage_count, 1);
  assert.equal(result.totals.recovered_count, 1);
  assert.equal(result.daily.reduce((sum, day) => sum + day.outage_count, 0), 1);
  db.close();
});

test('live API reports fresh state and refuses to treat an overdue check as current', async () => {
  const { db, env } = setup();
  assert.deepEqual(await liveStatus(env, new Date(event(0).scheduledTime)), {
    success: true,
    result: { status: 'unknown', conns_active_at: null, conns_inactive_at: null },
    status: 'unknown', is_up: null, checked_at: null
  });
  await collect(event(0), env, async () => Response.json({ success: true, result: {
    id: tunnel, status: 'healthy', conns_active_at: '2026-09-17T00:00:00Z'
  } }));
  assert.equal((await liveStatus(env, new Date(event(1).scheduledTime))).is_up, true);
  assert.equal((await liveStatus(env, new Date(event(1).scheduledTime))).result.status, 'healthy');
  assert.equal((await liveStatus(env, new Date(event(5).scheduledTime))).status, 'unknown');
  await collect(event(5), env, reply('down'));
  assert.equal((await liveStatus(env, new Date(event(5).scheduledTime))).is_up, false);
  env.STATUS_REQUEST_KEY = 'test-request-key';
  const unauthorized = await worker.fetch(new Request('https://example.test/api/live'), env);
  assert.equal(unauthorized.status, 401);
  const response = await worker.fetch(new Request('https://example.test/api/live', {
    headers: { 'X-API-Key': 'test-request-key' }
  }), env);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'X-API-Key, Content-Type');
  assert.equal((await response.json()).status, 'unknown');
  const preflight = await worker.fetch(new Request('https://example.test/api/live', { method: 'OPTIONS' }), env);
  assert.equal(preflight.status, 204);
  db.close();
});
