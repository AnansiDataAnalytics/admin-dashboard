// Admin dashboard API — one Express app; domains mount as route groups.
// Read-only over the Mongo pipeline ledger; writes only its own pipeline_runs.
const express = require('express');
const cors = require('cors');
const { config } = require('./shared/config');

const pipelinesRouter = require('./domains/pipelines/router');

const app = express();
app.use(cors({ origin: config.corsOrigin }));

// Capture the raw body so the GitHub webhook can HMAC-verify the exact bytes
// (express.json() otherwise discards it). Applies to all JSON requests; cheap.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/health', (req, res) => res.json({
  ok: true, service: 'admin-dashboard-backend', wedDb: config.wedDb, metaDb: config.metaDb,
}));

app.use('/api/pipelines', pipelinesRouter);
// Future domains (additive — no refactor):
// app.use('/api/analytics', require('./domains/analytics/router'));
// app.use('/api/clients', require('./domains/clients/router'));

// 404 + error handlers.
app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(config.port, () => {
  console.log(`admin-dashboard backend on :${config.port} (read WED_DB=${config.wedDb}, write ADMIN_DB=${config.metaDb})`);
});
