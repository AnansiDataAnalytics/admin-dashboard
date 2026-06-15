const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveVerdict } = require('./verdict');

test('healthy when nothing failed, nothing gated, no flags', () => {
  const v = deriveVerdict({ summary: { total: 196, passed: 196, failed: 0 } });
  assert.equal(v.state, 'healthy');
  assert.equal(v.hard_failures, 0);
  assert.equal(v.qc_flags, 0);
  assert.equal(v.gated_stage, null);
});

test('blocked when a source hard-failed', () => {
  const v = deriveVerdict({ summary: { total: 196, passed: 195, failed: 1 } });
  assert.equal(v.state, 'blocked');
  assert.equal(v.hard_failures, 1);
});

test('blocked when a stage gated even with zero failed count', () => {
  const v = deriveVerdict({ summary: { total: 196, passed: 196, failed: 0 }, gated_stage: 'clean' });
  assert.equal(v.state, 'blocked');
  assert.equal(v.gated_stage, 'clean');
});

test('flags when no hard failure but QC raised flags', () => {
  const v = deriveVerdict({ summary: { total: 196, passed: 196, failed: 0, qc_flags: 9 } });
  assert.equal(v.state, 'flags');
  assert.equal(v.qc_flags, 9);
});

test('hard failure outranks QC flags', () => {
  const v = deriveVerdict({ summary: { total: 196, passed: 195, failed: 1, qc_flags: 9 } });
  assert.equal(v.state, 'blocked');
});

test('missing manifest is treated as blocked, not healthy', () => {
  const v = deriveVerdict(null);
  assert.equal(v.state, 'blocked');
});
