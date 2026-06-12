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

// Real source inventory (counts are exact; names are a representative sample —
// the live grid is generated wholesale from build_log_report.json each run, so
// we deliberately do NOT maintain the full 196-name list here).
const AGGREGATORS = ['IMF_IFS', 'IMF_WEO', 'IMF_GFS', 'IMF_IFS_HF', 'OECD_EO', 'OECD_MEI', 'OECD_NAAG',
  'OECD_KEI', 'OECD_HPI', 'ECB', 'EUS', 'BIS', 'WDI', 'WB_GEM', 'UN', 'AMECO', 'BCEAO', 'CEPII',
  'FRED_bonds', 'NSDP', 'Riksbank', 'SECMCA', 'Yahoo_eq_price', 'Yale_ICF_hist'];
const COUNTRY = ['AGO_1', 'ARE_1', 'AUS_6', 'AUT_3', 'CAN_4', 'CHE_3', 'CHN_2', 'CIV_1', 'COL_1',
  'CZE_1', 'DEU_7', 'DNK_2', 'ESP_1', 'EST_1', 'ETH_1', 'FIN_1', 'FRA_1', 'KEN_1', 'NGA_1', 'ZAF_1'];
const COMBINE = ['CPI', 'nGDP', 'rGDP_pop', 'CA_USD', 'HPI', 'M0', 'M1', 'M2', 'M3', 'REER',
  'cbrate', 'cons', 'exports', 'imports', 'infl', 'inv', 'ltrate', 'strate', 'unemp', 'eq_CAPE',
  'cgovdebt_GDP', 'gen_govdebt_GDP', 'bond10y', 'bond2y', 'BankingCrisis'];

const COUNTS = { aggregators: 34, country: 113, combine: 49 };

function asSources(names, fail = []) {
  return names.map((name) => ({ name, status: fail.includes(name) ? 'failed' : 'passed' }));
}

// Representative manifest — exact category counts, sampled real names, one
// illustrative failure so the at-a-glance failure signal is visible.
function representativeManifest() {
  const failName = 'ETH_1'; // illustrative only
  const total = COUNTS.aggregators + COUNTS.country + COUNTS.combine;
  return {
    representative: true,
    run_id: null,
    generated_at: null,
    summary: { total, passed: total - 1, failed: 1, missing: 0, truncated: 0 },
    stages: [
      {
        id: 'download', label: 'Download', plain: 'per-source fetch scripts',
        groups: [
          { id: 'aggregators', label: 'Aggregators', total: COUNTS.aggregators, sources: asSources(AGGREGATORS) },
          { id: 'country', label: 'Country-level (NSO / central bank / SDMX)', total: COUNTS.country, sources: asSources(COUNTRY, [failName]) },
        ],
      },
      {
        id: 'combine', label: 'Combine', plain: 'per-variable chain-linking',
        groups: [
          { id: 'vars', label: 'Final variables', total: COUNTS.combine, sources: asSources(COMBINE) },
        ],
      },
    ],
  };
}

// Serve the latest live run's source health if a run record carries it; else the
// representative manifest. (A run record gets `source_health` once the pipeline
// posts it — see the LIVE PATH note above.)
async function getSourceHealth() {
  try {
    const db = await getDb(config.metaDb);
    const run = await db.collection('pipeline_runs').findOne(
      { source_health: { $exists: true } },
      { projection: { _id: 0, run_id: 1, source_health: 1, updated_at: 1 } },
      { sort: { started_at: -1 } },
    );
    if (run && run.source_health) {
      return { representative: false, run_id: run.run_id, generated_at: run.updated_at || null, ...run.source_health };
    }
  } catch {
    // fall through to the representative manifest
  }
  return representativeManifest();
}

module.exports = { getSourceHealth, representativeManifest };
