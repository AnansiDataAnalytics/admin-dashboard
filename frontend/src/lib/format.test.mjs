import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMs, isoDate, fmtNum, fmtPct, fmtDuration, relativeTime, fmtValue, stateOf,
} from './format.js';

// ── toMs ────────────────────────────────────────────────────────────────────
test('toMs accepts numbers, Dates, ISO strings; null otherwise', () => {
  assert.equal(toMs(1000), 1000);
  const d = new Date('2026-06-17T00:00:00Z');
  assert.equal(toMs(d), d.getTime());
  assert.equal(toMs('2026-06-17T00:00:00Z'), Date.parse('2026-06-17T00:00:00Z'));
  assert.equal(toMs(null), null);
  assert.equal(toMs('not a date'), null);
});

// ── isoDate ─────────────────────────────────────────────────────────────────
test('isoDate slices the leading YYYY-MM-DD', () => {
  assert.equal(isoDate('2026-06-17T12:34:56Z'), '2026-06-17');
  assert.equal(isoDate(null), '—');
  assert.equal(isoDate('short'), 'short');
});

// ── fmtNum / fmtPct ─────────────────────────────────────────────────────────
test('fmtNum formats finite numbers and falls back to em dash', () => {
  assert.equal(fmtNum(42), '42');
  assert.equal(fmtNum(0), '0');
  assert.equal(fmtNum(NaN), '—');
  assert.equal(fmtNum(undefined), '—');
  assert.equal(fmtNum('x'), '—');
});
test('fmtPct respects the digits argument', () => {
  assert.equal(fmtPct(12.345), '12.35%');
  assert.equal(fmtPct(50, 0), '50%');
  assert.equal(fmtPct(null), '—');
});

// ── fmtDuration ─────────────────────────────────────────────────────────────
test('fmtDuration uses s / m s / h m units and em-dashes non-positive', () => {
  assert.equal(fmtDuration(0), '—');
  assert.equal(fmtDuration(-5), '—');
  assert.equal(fmtDuration(45), '45s');
  assert.equal(fmtDuration(90), '1m 30s');
  assert.equal(fmtDuration(3700), '1h 1m');
});

// ── relativeTime (now injected for determinism) ──────────────────────────────
const now = Date.parse('2026-06-17T12:00:00Z');
test('relativeTime: in progress / just now / past / future buckets', () => {
  assert.equal(relativeTime(null, now), 'in progress');
  assert.equal(relativeTime(now - 10_000, now), 'just now');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 min ago');
  assert.equal(relativeTime(now - 2 * 3_600_000, now), '2 hours ago');
  assert.equal(relativeTime(now - 3 * 86_400_000, now), '3 days ago');
  assert.equal(relativeTime(now + 3 * 3_600_000, now), 'in 3 hours');
  assert.equal(relativeTime(now + 1 * 3_600_000, now), 'in 1 hour'); // singular
});

// ── fmtValue ────────────────────────────────────────────────────────────────
test('fmtValue: zero, null, string passthrough, and exponential extremes', () => {
  assert.equal(fmtValue(0), '0');
  assert.equal(fmtValue(null), '—');
  assert.equal(fmtValue('n/a'), 'n/a');
  assert.equal(fmtValue(1_500_000), '1.50e+6'); // abs >= 1e6
  assert.equal(fmtValue(0.0005), '5.00e-4');    // abs < 1e-3
});

// ── stateOf ─────────────────────────────────────────────────────────────────
test('stateOf collapses statuses into the visual vocabulary', () => {
  for (const s of ['completed', 'success', 'passed']) assert.equal(stateOf(s), 'passed');
  for (const s of ['failed', 'failure']) assert.equal(stateOf(s), 'failed');
  for (const s of ['in_progress', 'running', 'queued']) assert.equal(stateOf(s), 'running');
  assert.equal(stateOf('whatever'), 'pending');
});
