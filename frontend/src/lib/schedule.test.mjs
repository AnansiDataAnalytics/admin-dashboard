import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mostRecentScheduledMs, nextScheduledMs, runStaleness } from './schedule.mjs';

// Wed 18 Jun 2025, 12:00 local (a real Wednesday; mid-day avoids TZ boundary flakiness).
const wedNoon = new Date(2025, 5, 18, 12, 0, 0).getTime();

test('mostRecentScheduledMs is this week\'s Wednesday 02:00', () => {
  const d = new Date(mostRecentScheduledMs(wedNoon));
  assert.equal(d.getDay(), 3);   // Wednesday
  assert.equal(d.getHours(), 2);
  assert.equal(d.getDate(), 18);
});

test('nextScheduledMs from Wed noon is next Wednesday 02:00', () => {
  const d = new Date(nextScheduledMs(wedNoon));
  assert.equal(d.getDay(), 3);
  assert.equal(d.getDate(), 25);
});

test('mostRecentScheduledMs from a Thursday is the prior Wednesday', () => {
  const thuNoon = new Date(2025, 5, 19, 12, 0, 0).getTime(); // Thu 19 Jun 2025
  const d = new Date(mostRecentScheduledMs(thuNoon));
  assert.equal(d.getDay(), 3);
  assert.equal(d.getDate(), 18); // Wed 18 Jun 2025
});

test('overdue: scheduled time passed grace and no run since', () => {
  const lastRunMs = new Date(2025, 5, 11, 3, 0, 0).getTime(); // a week earlier
  const r = runStaleness({ lastRunMs, nowMs: wedNoon, graceHours: 6 });
  assert.equal(r.overdue, true);
  assert.equal(r.ranForLatest, false);
});

test('not overdue: a run reported after the scheduled time', () => {
  const lastRunMs = new Date(2025, 5, 18, 3, 0, 0).getTime(); // after 02:00 same day
  const r = runStaleness({ lastRunMs, nowMs: wedNoon, graceHours: 6 });
  assert.equal(r.overdue, false);
  assert.equal(r.ranForLatest, true);
});

test('not overdue: still within the grace window', () => {
  const now = new Date(2025, 5, 18, 4, 0, 0).getTime(); // 04:00, grace until 08:00
  const lastRunMs = new Date(2025, 5, 11, 3, 0, 0).getTime();
  assert.equal(runStaleness({ lastRunMs, nowMs: now, graceHours: 6 }).overdue, false);
});

test('overdue: no run has ever reported and grace passed', () => {
  assert.equal(runStaleness({ lastRunMs: null, nowMs: wedNoon, graceHours: 6 }).overdue, true);
});
