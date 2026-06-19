// GitHub webhook handling for the WED pipeline (Phase 8.2). HMAC-verify the raw
// body, then turn workflow_run / workflow_job events into pipeline_runs updates.
const crypto = require('crypto');
const { config } = require('../../shared/config');
const runs = require('./runs.service');

// Constant-time string compare. Returns false on any missing value or length
// mismatch (crypto.timingSafeEqual throws on unequal-length buffers), so callers
// get a plain boolean and never leak timing about where two secrets diverge.
// Shared by the webhook HMAC check and the heartbeat shared-secret check.
function safeEqual(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Constant-time check of X-Hub-Signature-256 against the shared secret.
function verifySignature(rawBody, signature) {
  if (!config.githubWebhookSecret || !signature || !rawBody) return false;
  const digest = 'sha256=' + crypto
    .createHmac('sha256', config.githubWebhookSecret)
    .update(rawBody)
    .digest('hex');
  return safeEqual(digest, signature);
}

async function handleEvent(eventType, payload) {
  // Only the WED data build is the dashboard's concern. The repo also fires
  // webhooks for CodeQL ("Code Quality") and other workflows; drop those at the
  // door so they never enter pipeline_runs. workflow_run carries `name`;
  // workflow_job carries `workflow_name`.
  if (eventType === 'workflow_run' && payload && payload.workflow_run) {
    if (payload.workflow_run.name !== config.wedWorkflow) {
      return { handled: 'ignored', reason: 'non-WED workflow', workflow: payload.workflow_run.name };
    }
    const run_id = await runs.upsertWorkflowRun(payload.workflow_run);
    return { handled: 'workflow_run', run_id };
  }
  if (eventType === 'workflow_job' && payload && payload.workflow_job) {
    if (payload.workflow_job.workflow_name !== config.wedWorkflow) {
      return { handled: 'ignored', reason: 'non-WED workflow', workflow: payload.workflow_job.workflow_name };
    }
    await runs.updateWorkflowJob(payload.workflow_job, payload.workflow_job.run_id);
    return { handled: 'workflow_job', run_id: String(payload.workflow_job.run_id) };
  }
  if (eventType === 'ping') return { handled: 'ping' };
  return { handled: 'ignored', event: eventType };
}

module.exports = { safeEqual, verifySignature, handleEvent };
