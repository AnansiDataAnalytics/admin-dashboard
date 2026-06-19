const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeEqual, handleEvent } = require('./webhook');

// ── safeEqual (constant-time compare) ────────────────────────────────────────
test('safeEqual: equal true; mismatch/length/empty/null false (no throw)', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'ab'), false);   // unequal length must not throw
  assert.equal(safeEqual('', ''), false);        // empty never authenticates
  assert.equal(safeEqual(null, 'x'), false);
  assert.equal(safeEqual('x', undefined), false);
});

// ── handleEvent workflow filtering ───────────────────────────────────────────
// The ignore branches return before any Mongo access, so they're safe to unit
// test without a DB. (The WED-workflow path writes to Mongo and is exercised by
// integration, not here.)
test('handleEvent ignores a non-WED workflow_run (e.g. CodeQL) without writing', async () => {
  const r = await handleEvent('workflow_run', { workflow_run: { name: 'Code Quality: PR #104', id: 123 } });
  assert.equal(r.handled, 'ignored');
  assert.equal(r.reason, 'non-WED workflow');
  assert.equal(r.workflow, 'Code Quality: PR #104');
});

test('handleEvent ignores a non-WED workflow_job without writing', async () => {
  const r = await handleEvent('workflow_job', { workflow_job: { workflow_name: 'Code Quality: Scheduled', run_id: 123 } });
  assert.equal(r.handled, 'ignored');
  assert.equal(r.reason, 'non-WED workflow');
});

test('handleEvent acks ping and ignores unknown event types', async () => {
  assert.equal((await handleEvent('ping', {})).handled, 'ping');
  assert.equal((await handleEvent('issues', {})).handled, 'ignored');
});
