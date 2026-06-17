import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferPhase, ghState, pickBuildJob, runFromApi, WED_STEPS } from './pipelineModel.js';

// ── inferPhase ──────────────────────────────────────────────────────────────
// Regression table: every real workflow step name (mirrored from wed.yml in
// WED_STEPS) must infer back to its declared phase. This is the guard that keeps
// the keyword rules' ordering correct as they're edited.
test('inferPhase maps every WED step name to its declared phase', () => {
  for (const s of WED_STEPS) {
    assert.equal(inferPhase(s.name), s.phase, `"${s.name}" should infer phase "${s.phase}"`);
  }
});

// The two collisions that the rule reordering fixed — pin them explicitly so a
// future tidy of PHASE_RULES can't silently reintroduce them.
test('inferPhase: the log-scan gate is validate, not build (despite "Stata")', () => {
  assert.equal(inferPhase('Parse all Stata logs'), 'validate');
});
test('inferPhase: "Upload logs" is cleanup, not validate (despite "logs")', () => {
  assert.equal(inferPhase('Upload logs'), 'cleanup');
});
test('inferPhase: "Remove generated env_vars.do" is cleanup, not configure', () => {
  assert.equal(inferPhase('Remove generated env_vars.do'), 'cleanup');
});

test('inferPhase handles GitHub auto-added steps', () => {
  assert.equal(inferPhase('Set up job'), 'setup');
  assert.equal(inferPhase('Post Run Stata master pipeline'), 'cleanup');
  assert.equal(inferPhase('Complete job'), 'cleanup');
});

test('inferPhase falls back to cleanup for unknown names', () => {
  assert.equal(inferPhase('Some unrecognized step'), 'cleanup');
  assert.equal(inferPhase(''), 'cleanup');
  assert.equal(inferPhase(undefined), 'cleanup');
});

// ── ghState ─────────────────────────────────────────────────────────────────
test('ghState maps conclusion before status', () => {
  assert.equal(ghState({ conclusion: 'success' }), 'passed');
  assert.equal(ghState({ conclusion: 'failure' }), 'failed');
  assert.equal(ghState({ conclusion: 'cancelled' }), 'failed');
  assert.equal(ghState({ conclusion: 'timed_out' }), 'failed');
  assert.equal(ghState({ conclusion: 'skipped' }), 'skipped');
});
test('ghState falls back to status when conclusion is absent', () => {
  assert.equal(ghState({ status: 'in_progress' }), 'running');
  assert.equal(ghState({ status: 'completed' }), 'passed');
  assert.equal(ghState({ status: 'queued' }), 'pending');
  assert.equal(ghState({}), 'pending');
});

// ── pickBuildJob ────────────────────────────────────────────────────────────
test('pickBuildJob prefers the build job even with zero steps', () => {
  const jobs = {
    ctrl: { name: 'controller', steps: [1, 2, 3] },
    b: { name: 'WED build', steps: [] },
  };
  assert.equal(pickBuildJob(jobs).name, 'WED build');
});
test('pickBuildJob excludes infra boxes when there is no build job', () => {
  const jobs = {
    box: { name: 'runner box', steps: [1, 2] },
    j: { name: 'Ingest job', steps: [1] },
  };
  assert.equal(pickBuildJob(jobs).name, 'Ingest job');
});
test('pickBuildJob falls back to the most-steps job when all look like infra', () => {
  const jobs = {
    a: { name: 'controller', steps: [1, 2] },
    b: { name: 'stop box', steps: [1, 2, 3] },
  };
  assert.equal(pickBuildJob(jobs).name, 'stop box');
});
test('pickBuildJob returns null for no jobs', () => {
  assert.equal(pickBuildJob({}), null);
  assert.equal(pickBuildJob(null), null);
});

// ── runFromApi (end-to-end mapping) ──────────────────────────────────────────
test('runFromApi returns null for a missing run', () => {
  assert.equal(runFromApi(null), null);
});

test('runFromApi maps a completed run, threading inferPhase/ghState/durSecs', () => {
  const run = {
    run_id: '42', status: 'success',
    started_at: '2026-06-17T02:00:00Z', finished_at: '2026-06-17T04:30:00Z',
    release: { release_version: '2026_06' },
    jobs: { build: { name: 'WED build', steps: [
      { name: 'Parse all Stata logs', status: 'completed', conclusion: 'success',
        started_at: '2026-06-17T03:00:00Z', completed_at: '2026-06-17T03:00:18Z' },
    ] } },
  };
  const r = runFromApi(run);
  assert.equal(r.state, 'success');
  assert.equal(r.version, '2026_06');
  assert.equal(r.run_id, '42');
  assert.equal(r.representative, false);
  assert.equal(r.steps[0].phase, 'validate'); // gate maps correctly end-to-end
  assert.equal(r.steps[0].status, 'passed');
  assert.equal(r.steps[0].dur, 18);
  assert.equal(r.duration, 9000); // 2.5h between started/finished
});

test('runFromApi maps an in-progress run to running with no finishedAt/phases', () => {
  const r = runFromApi({ run_id: '7', status: 'in_progress', started_at: '2026-06-17T02:00:00Z', finished_at: null, jobs: {} });
  assert.equal(r.state, 'running');
  assert.equal(r.finishedAt, null);
  assert.equal(r.phases.length, 0);
});

test('runFromApi version falls back to a short git sha', () => {
  const r = runFromApi({ run_id: '9', status: 'queued', git_sha: 'abcdef1234567' });
  assert.equal(r.state, 'queued');
  assert.equal(r.version, 'abcdef1');
});

test('runFromApi reads the manual-dispatch trigger', () => {
  assert.equal(runFromApi({ run_id: '1', status: 'success', trigger: 'manual' }).triggeredManually, true);
  assert.equal(runFromApi({ run_id: '1', status: 'success', trigger: 'scheduled' }).triggeredManually, false);
});
