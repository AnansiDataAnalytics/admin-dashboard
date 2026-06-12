// Operational pipeline runs — the dashboard's OWN collection (admin_meta), the
// only thing it writes. Populated by the GitHub webhook (8.2) + EC2 heartbeats
// (8.3). Joins to the data outcome (releases) by run_id. Empty until a live run.
const { getDb } = require('../../shared/db');
const { config } = require('../../shared/config');

async function runsColl() {
  return (await getDb(config.metaDb)).collection('pipeline_runs');
}
async function releasesColl() {
  return (await getDb(config.wedDb)).collection('releases');
}

function slug(s) {
  return String(s || 'job').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

async function listRuns({ limit = 50 } = {}) {
  const c = await runsColl();
  return c.find({}, { projection: { _id: 0 } })
    .sort({ started_at: -1 })
    .limit(Math.min(Number(limit) || 50, 200))
    .toArray();
}

// One run + the release it produced (joined by run_id) — operational ⨝ outcome.
async function getRun(runId) {
  const run = await (await runsColl()).findOne({ run_id: String(runId) }, { projection: { _id: 0 } });
  if (!run) return null;
  const release = await (await releasesColl()).findOne({ run_id: String(runId) }, { projection: { _id: 0 } });
  return { ...run, release: release || null };
}

// From a GitHub `workflow_run` event. Idempotent (upsert keyed on run_id).
async function upsertWorkflowRun(wr) {
  const run_id = String(wr.id);
  const status = wr.status === 'completed'
    ? (wr.conclusion === 'success' ? 'success' : 'failed')
    : (wr.status === 'in_progress' ? 'in_progress' : 'queued');
  const set = {
    run_id,
    name: wr.name,
    trigger: wr.event === 'schedule' ? 'scheduled' : wr.event === 'workflow_dispatch' ? 'manual' : wr.event,
    actor: (wr.triggering_actor && wr.triggering_actor.login) || (wr.actor && wr.actor.login) || null,
    git_sha: wr.head_sha,
    run_attempt: wr.run_attempt,
    html_url: wr.html_url,
    status,
    conclusion: wr.conclusion || null,
    finished_at: wr.status === 'completed' && wr.updated_at ? new Date(wr.updated_at) : null,
    updated_at: new Date(),
  };
  if (wr.run_started_at) set.started_at = new Date(wr.run_started_at);
  await (await runsColl()).updateOne({ run_id }, { $set: set }, { upsert: true });
  return run_id;
}

// From a GitHub `workflow_job` event — per-job (controller / wed build / stop) status.
async function updateWorkflowJob(job, runId) {
  const run_id = String(runId);
  await (await runsColl()).updateOne(
    { run_id },
    {
      $set: {
        [`jobs.${slug(job.name)}`]: {
          name: job.name,
          status: job.status,
          conclusion: job.conclusion || null,
          started_at: job.started_at ? new Date(job.started_at) : null,
          completed_at: job.completed_at ? new Date(job.completed_at) : null,
        },
        updated_at: new Date(),
      },
      $setOnInsert: { run_id },
    },
    { upsert: true },
  );
}

// From an EC2 heartbeat — intra-build progress (per-stage / per-source from 4.6).
// `source_health` is stored at the top level of the run record (it's a structured
// summary the Source-health card reads), not under progress.* like scalar fields.
async function mergeHeartbeat(body) {
  const { run_id, stage, progress, source_health, ...rest } = body || {};
  if (!run_id) throw new Error('heartbeat requires run_id');
  const set = { updated_at: new Date() };
  if (stage) set['progress.current_stage'] = stage;
  if (progress !== undefined) set['progress.detail'] = progress;
  if (source_health !== undefined) set.source_health = source_health;
  for (const [k, v] of Object.entries(rest)) set[`progress.${k}`] = v;
  await (await runsColl()).updateOne(
    { run_id: String(run_id) },
    { $set: set, $setOnInsert: { run_id: String(run_id) } },
    { upsert: true },
  );
}

module.exports = { listRuns, getRun, upsertWorkflowRun, updateWorkflowJob, mergeHeartbeat };
