// Centralized env/config. One place so domains never read process.env directly.
require('dotenv').config();

const config = {
  port: Number(process.env.PORT) || 4000,

  // Mongo: one cluster, two logical DBs.
  mongoUri: process.env.MONGODB_URI || '',
  wedDb: process.env.WED_DB || 'wed_v0',            // READ: the pipeline ledger (releases/changes)
  metaDb: process.env.ADMIN_DB || 'admin_meta',     // WRITE: the dashboard's own pipeline_runs

  // Which GitHub workflow IS the WED data build. The repo fires webhooks for
  // other workflows too (CodeQL "Code Quality", etc.); only runs of this workflow
  // are ingested and surfaced on the dashboard, so the rest never pollute it.
  wedWorkflow: process.env.WED_WORKFLOW_NAME || 'WED Pipeline',

  // Ingest auth.
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '', // HMAC for /github/webhook
  heartbeatSecret: process.env.HEARTBEAT_SECRET || '',          // shared secret for /heartbeat

  corsOrigin: process.env.CORS_ORIGIN || '*',
};

if (!config.mongoUri) {
  console.warn('[config] MONGODB_URI is not set — pipeline endpoints will error until it is.');
}

module.exports = { config };
