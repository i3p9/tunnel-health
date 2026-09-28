import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyRows, dayKey, recordedDays, intervals, overdue } from '../../frontend/data.mjs';

const now = Date.parse('2026-09-28T00:30:00Z');
const data = {
  first_check_at: '2026-09-25T23:00:00Z',
  current: { scheduled_at: '2026-09-28T00:29:00Z', status: 'up' },
  daily: [{ day: '2026-09-26', outage_count: 2, recovered_seconds: 7200 }],
  transitions: [{ scheduled_at: '2026-09-25T23:00:00Z', status: 'up' }]
};

test('daily figures distinguish unrecorded dates from zero detected outages in Dhaka', () => {
  const rows = dailyRows(data, 7, now);
  assert.equal(dayKey(data.first_check_at), '2026-09-26');
  assert.equal(rows.find(row => row.day === '2026-09-25').outage_count, null);
  assert.equal(rows.find(row => row.day === '2026-09-26').outage_count, 2);
  assert.equal(rows.find(row => row.day === '2026-09-27').outage_count, 0);
  assert.equal(rows.at(-1).record, 'Through 06:29');
  assert.equal(recordedDays(data), 3);
});

test('no checks and dates after the last check do not become zero-outage days', () => {
  const empty = { current: null, first_check_at: null, daily: [], transitions: [] };
  assert.ok(dailyRows(empty, 7, now).every(row => row.outage_count === null));
  assert.equal(recordedDays(empty), 0);
  const stale = { ...data, current: { scheduled_at: '2026-09-26T00:00:00Z' } };
  assert.equal(dailyRows(stale, 7, now).at(-1).record, 'No checks received');
  assert.equal(recordedDays(stale), 1);
});

test('timeline preserves the state before the window and bounds a stale tail', () => {
  const result = intervals(data, 24, now);
  assert.deepEqual(result, [{ start: now - 86400000, end: now, status: 'up' }]);
  const later = now + 300000;
  assert.equal(overdue(data.current, later), true);
  const stale = intervals(data, 24, later);
  assert.equal(stale.at(-1).status, 'unknown');
  assert.equal(stale.at(-1).start, Date.parse(data.current.scheduled_at) + 60000);
});

test('timeline distinguishes time before recording and explicit monitoring gaps', () => {
  const result = intervals({ ...data, transitions: [
    ...data.transitions,
    { scheduled_at: '2026-09-27T00:00:00Z', status: 'unknown' },
    { scheduled_at: '2026-09-27T00:05:00Z', status: 'up' }
  ] }, 168, now);
  assert.deepEqual(result.map(row => row.status), ['unrecorded', 'up', 'unknown', 'up']);
  assert.equal(result[0].end, Date.parse(data.first_check_at));
});
