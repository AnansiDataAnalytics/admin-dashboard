// Source-level execution health for a WED run — finer than the GitHub Actions
// jobs/steps. The Stata master pipeline (code/0_master.do) runs ~196 source
// scripts (download aggregators + country-level + combine variables); each
// emits its own log, and ops/parse_stata_logs.py records pass/fail/missing/
// truncated per log into build_log_report.json.
//
// LIVE PATH (to wire): the EC2 run posts a per-source summary (derived from
// build_log_report.json, labelled by source + stage) onto the run record in
// admin_meta — via the heartbeat (intra-run, live) and/or a final upload. This
// module serves that when present, and a representative manifest otherwise so
// the UI shape is visible before the first live run.
const { getDb } = require('../../shared/db');
const { config } = require('../../shared/config');
const { deriveVerdict } = require('./verdict');

// Exact category counts; names are a representative sample (the live grid is
// generated wholesale from build_log_report.json each run, so we deliberately do
// NOT maintain the full 196-name list here).
const COUNTS = { aggregators: 34, country: 113, combine: 49 };

function src(name, category, qc_flags = 0, over = {}) {
  return { name, category, download: 'passed', clean: 'passed', qc_flags, ...over };
}
function vbl(name, qc_flags = 0, over = {}) {
  return { name, combine: 'passed', qc_flags, ...over };
}

// Representative manifest in the two-matrix shape. Illustrates the common
// "published with advisory QC flags" case: no hard download/clean/combine
// failure (so the release ships), but a handful of deterministic QC flags to
// review. QC is advisory and never blocks (see verdict.js). A few clean sample
// rows are included so expanding "+N more" reveals real rows in the demo.
function representativeManifest() {
  const sources = [
    src('BRA_2', 'country', 4),
    src('OECD_EO', 'aggregator', 3),
    src('NGA_1', 'country', 1),
    src('IMF_IFS', 'aggregator'),
    src('IMF_WEO', 'aggregator'),
    src('AUS_6', 'country'),
    src('DEU_7', 'country', 0, { download: 'fallback' }),
    src('FRA_1', 'country'),
  ];
  const variables = [
    vbl('REER', 1),
    vbl('CPI'),
    vbl('nGDP'),
    vbl('unemp'),
  ];
  const sources_total = COUNTS.aggregators + COUNTS.country;
  const variables_total = COUNTS.combine;
  const qc_flags =
    sources.reduce((a, s) => a + s.qc_flags, 0) +
    variables.reduce((a, v) => a + v.qc_flags, 0);
  const fallback = sources.filter((s) => s.download === 'fallback').length;
  return {
    representative: true,
    run_id: null,
    generated_at: null,
    gated_stage: null,
    counts: COUNTS,
    summary: { sources_total, variables_total, failed: 0, fallback, qc_flags, systemic: false, gated_stage: null },
    sources,
    variables,
  };
}

async function getSourceHealth() {
  let result = null;
  // Serve representative data ONLY when Mongo is unconfigured (local/dev) or it is
  // reachable but no run has posted source health yet. A thrown DB error when
  // Mongo IS configured is a real outage — let it propagate so the dashboard fails
  // loud ("status unavailable") instead of showing a reassuring representative state.
  if (config.mongoUri) {
    const db = await getDb(config.metaDb);
    // NB: findOne takes (filter, options) — projection AND sort must live in the
    // SAME options object. Passing sort as a 3rd arg silently drops it, returning
    // an arbitrary run. Sort by updated_at (the heartbeat always stamps it) so the
    // most-recent run that carries source_health wins.
    const run = await db.collection('pipeline_runs').findOne(
      { source_health: { $exists: true } },
      { projection: { _id: 0, run_id: 1, source_health: 1, updated_at: 1 }, sort: { updated_at: -1 } },
    );
    if (run && run.source_health) {
      result = { ...run.source_health, representative: false, run_id: run.run_id, generated_at: run.updated_at || null };
    }
  }
  if (!result) result = representativeManifest();
  result.verdict = deriveVerdict(result);
  return result;
}

module.exports = { getSourceHealth, representativeManifest };
