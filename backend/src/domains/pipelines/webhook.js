// GitHub webhook handling for the WED pipeline (Phase 8.2). HMAC-verify the raw
// body, then turn workflow_run / workflow_job events into pipeline_runs updates.
const crypto = require('crypto');
const { config } = require('../../shared/config');
const runs = require('./runs.service');

// Constant-time check of X-Hub-Signature-256 against the shared secret.
function verifySignature(rawBody, signature) {
  if (!config.githubWebhookSecret || !signature || !rawBody) return false;
  const digest = 'sha256=' + crypto
    .createHmac('sha256', config.githubWebhookSecret)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleEvent(eventType, payload) {
  if (eventType === 'workflow_run' && payload && payload.workflow_run) {
    const run_id = await runs.upsertWorkflowRun(payload.workflow_run);
    return { handled: 'workflow_run', run_id };
  }
  if (eventType === 'workflow_job' && payload && payload.workflow_job) {
    await runs.updateWorkflowJob(payload.workflow_job, payload.workflow_job.run_id);
    return { handled: 'workflow_job', run_id: String(payload.workflow_job.run_id) };
  }
  if (eventType === 'ping') return { handled: 'ping' };
  return { handled: 'ignored', event: eventType };
}

module.exports = { verifySignature, handleEvent };
