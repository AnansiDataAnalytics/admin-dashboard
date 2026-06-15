const { test } = require('node:test');
const assert = require('node:assert/strict');
const { representativeManifest } = require('./sourceHealth');
const { deriveVerdict } = require('./verdict');

test('manifest exposes flat sources[] and variables[] with the new fields', () => {
  const m = representativeManifest();
  assert.ok(Array.isArray(m.sources) && m.sources.length > 0);
  assert.ok(Array.isArray(m.variables) && m.variables.length > 0);
  const s = m.sources[0];
  assert.ok('download' in s && 'clean' in s && 'qc_flags' in s && 'category' in s);
  const v = m.variables[0];
  assert.ok('combine' in v && 'qc_flags' in v);
});

test('summary totals and qc_flags are consistent with the rows', () => {
  const m = representativeManifest();
  assert.equal(m.summary.sources_total, m.counts.aggregators + m.counts.country);
  assert.equal(m.summary.variables_total, m.counts.combine);
  const flagSum =
    m.sources.reduce((a, s) => a + s.qc_flags, 0) +
    m.variables.reduce((a, v) => a + v.qc_flags, 0);
  assert.equal(m.summary.qc_flags, flagSum);
});

test('representative case is advisory-only: no hard failure, so verdict is flags', () => {
  const m = representativeManifest();
  assert.equal(m.summary.failed, 0);
  assert.ok(m.summary.qc_flags > 0);
  assert.equal(deriveVerdict(m).state, 'flags');
});

test('verdict is blocked when a hard failure is present', () => {
  const m = representativeManifest();
  m.summary.failed = 1;
  assert.equal(deriveVerdict(m).state, 'blocked');
});
