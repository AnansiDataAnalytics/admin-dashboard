// /api/pipelines/* — one router per pipeline domain. WED is the first pipeline;
// add others as sibling route groups (no refactor — additive).
const express = require('express');
const wed = require('./wed.service');     // ledger reads (real data now)
const runs = require('./runs.service');   // operational runs (meta DB)
const sourceHealth = require('./sourceHealth'); // per-source run execution health
const webhook = require('./webhook');     // GitHub webhook ingest
const events = require('./events');       // SSE event bus (push, not poll)
const { config } = require('../../shared/config');

const router = express.Router();

// Async wrapper so a throw becomes a clean error (not a hung request).
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- WED ledger (serves real data from the Phase 7 collections) ------------
router.get('/wed/summary', h(async (req, res) => res.json(await wed.getSummary())));

router.get('/wed/releases', h(async (req, res) => res.json(await wed.listReleases())));

router.get('/wed/releases/:version', h(async (req, res) => {
  const r = await wed.getRelease(req.params.version);
  if (!r) return res.status(404).json({ error: `release '${req.params.version}' not found` });
  res.json(r);
}));

router.get('/wed/releases/:version/diff', h(async (req, res) => {
  const d = await wed.getDiff(req.params.version);
  if (!d) return res.status(404).json({ error: `release '${req.params.version}' not found` });
  res.json(d);
}));

router.get('/wed/releases/:version/changes', h(async (req, res) => {
  res.json(await wed.listChanges(req.params.version, req.query));
}));

router.get('/wed/releases/:version/sources', h(async (req, res) => {
  res.json(await wed.sourceBreakdown(req.params.version));
}));

// ---- Source-level execution health (per-source pass/fail under the Stata step)
router.get('/wed/source-health', h(async (req, res) => res.json(await sourceHealth.getSourceHealth())));

// ---- Live updates over SSE (push, replaces frontend polling) ---------------
// The dashboard opens one EventSource here; the webhook + heartbeat handlers
// below broadcast a `run` event after each Mongo write, which arrives here and
// is forwarded to every connected client. No request body, so CORS is a simple
// GET (the global cors() covers it).
router.get('/wed/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering so events flush immediately
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write('retry: 5000\n\n');      // client auto-reconnect backoff
  res.write(': connected\n\n');

  const onEvent = (evt) => {
    res.write(`event: ${evt.type}\n`);
    res.write(`data: ${JSON.stringify(evt.data)}\n\n`);
  };
  events.bus.on('event', onEvent);
  const keepAlive = setInterval(() => res.write(': ka\n\n'), 25000); // hold the connection
  req.on('close', () => { clearInterval(keepAlive); events.bus.off('event', onEvent); });
});

// ---- WED operational runs (populated by the webhook + heartbeats) ----------
router.get('/wed/runs', h(async (req, res) => res.json(await runs.listRuns({ limit: req.query.limit }))));

router.get('/wed/runs/:runId', h(async (req, res) => {
  const r = await runs.getRun(req.params.runId);
  if (!r) return res.status(404).json({ error: `run '${req.params.runId}' not found` });
  res.json(r);
}));

// ---- Ingest: GitHub webhook (HMAC) + EC2 heartbeat (shared secret) ----------
router.post('/wed/github/webhook', h(async (req, res) => {
  if (!webhook.verifySignature(req.rawBody, req.get('X-Hub-Signature-256'))) {
    return res.status(401).json({ error: 'invalid or missing signature' });
  }
  const result = await webhook.handleEvent(req.get('X-GitHub-Event'), req.body);
  if (result.run_id) events.broadcast('run', { run_id: result.run_id, via: result.handled });
  res.json({ ok: true, ...result });
}));

router.post('/wed/heartbeat', h(async (req, res) => {
  if (!config.heartbeatSecret || !webhook.safeEqual(req.get('X-Heartbeat-Secret'), config.heartbeatSecret)) {
    return res.status(401).json({ error: 'invalid or missing heartbeat secret' });
  }
  await runs.mergeHeartbeat(req.body || {});
  if (req.body && req.body.run_id) events.broadcast('run', { run_id: String(req.body.run_id), via: 'heartbeat' });
  res.json({ ok: true });
}));

module.exports = router;
