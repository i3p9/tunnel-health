import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { collect } from '../src/worker.js';

const tunnel = '11111111-1111-1111-1111-111111111111';
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_observations.sql', import.meta.url), 'utf8'));
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), TUNNEL_ID: tunnel,
    CLOUDFLARE_API_TOKEN: 'test-secret',
    DB: { prepare(sql) { return { bind(...args) {
      return { async run() { return db.prepare(sql).run(...args); } };
    } }; } }
  };
  return { db, env };
}
const event = minute => ({ scheduledTime: Date.UTC(2026, 8, 17, 0, minute) });
const reply = status => async () => Response.json({ success: true, result: {
  id: tunnel, status, conns_inactive_at: '2026-09-16T23:59:00Z'
} });

test('records valid statuses and timestamps; repeated invocations are idempotent', async () => {
  const { db, env } = setup();
  for (const [minute, status] of ['healthy', 'degraded', 'down', 'inactive'].entries()) {
    await collect(event(minute), env, reply(status));
  }
  await collect(event(2), env, reply('down'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 4);
  assert.equal(db.prepare("SELECT conns_inactive_at AS t FROM observations WHERE status='down'").get().t,
    '2026-09-16T23:59:00.000Z');
  db.close();
});

test('API failures, invalid JSON and unexpected results remain unknown', async () => {
  const { db, env } = setup();
  const failures = [
    async () => new Response('', { status: 429 }),
    async () => new Response('not JSON'),
    async () => { throw new DOMException('timeout', 'TimeoutError'); },
    async () => Response.json({ success: false }),
    reply('unexpected'),
    async () => Response.json({ success: true, result: { id: 'wrong', status: 'down' } })
  ];
  for (const [i, fetcher] of failures.entries()) await collect(event(i), env, fetcher);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observations WHERE status='unknown' AND error IS NOT NULL").get().n, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outages').get().n, 0);
  db.close();
});

test('outages handle recovery, degraded service, unknown checks, missed minutes and initial downtime', async () => {
  const { db } = setup();
  const insert = db.prepare('INSERT INTO observations (tunnel_id, scheduled_at, observed_at, status) VALUES (?, ?, ?, ?)');
  const samples = [[0,'down'], [1,'down'], [2,'degraded'], [3,'healthy'],
    [4,'down'], [5,'unknown'], [6,'down'], [8,'down'], [9,'healthy'], [10,'down']];
  // Insert out of order to exercise chronological derivation.
  for (const [minute, status] of samples.reverse()) {
    const time = new Date(event(minute).scheduledTime).toISOString();
    insert.run(tunnel, time, time, status);
  }
  const rows = db.prepare('SELECT * FROM outages ORDER BY first_down_at').all();
  assert.deepEqual(rows.map(r => r.outcome), ['recovered', 'uncertain', 'uncertain', 'recovered', 'open']);
  assert.equal(rows[0].down_samples, 2);
  assert.equal(rows[0].recovered_at, new Date(event(2).scheduledTime).toISOString());
  assert.equal(rows[1].recovered_at, null);
  db.close();
});

test('configuration and database failures fail the invocation', async () => {
  const { db, env } = setup();
  await assert.rejects(collect(event(0), { ...env, TUNNEL_ID: '' }, reply('down')), /Configure/);
  db.close();
  await assert.rejects(collect(event(0), env, reply('down')));
});
