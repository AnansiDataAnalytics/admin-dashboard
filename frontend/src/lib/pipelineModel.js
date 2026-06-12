// pipelineModel.js — the WED weekly build's workflow shape, mirroring the phases
// and steps of .github/workflows/wed.yml, with representative timings.
//
// Until the operational-runs path is live (GitHub webhook -> pipeline_runs,
// /runs endpoints), buildRepresentativeRun() produces a realistic *sample* run
// so the workflow view (hero, flow, gantt, steps, run details) has substance.
// It is anchored to the real latest release version so it reads as "the run that
// produced the current release". When /runs returns real data, the same view
// binds to it (a real run's jobs map onto these phases).

export const WED_PHASES = [
  { id: 'setup', name: 'Setup', plain: 'Prepare the runner and authenticate to AWS', icon: 'server' },
  { id: 'configure', name: 'Configure', plain: 'Generate credentials and runtime configuration', icon: 'sliders' },
  { id: 'acquire', name: 'Acquire data', plain: 'Download source inputs from cloud storage', icon: 'download' },
  { id: 'build', name: 'Build', plain: 'Run the Stata pipeline — download, clean, combine', icon: 'cpu' },
  { id: 'validate', name: 'Validate', plain: 'Scan every Stata log for errors — the real pass / fail gate', icon: 'shield' },
  { id: 'publish', name: 'Publish', plain: 'Upload clean & final datasets to the output bucket', icon: 'upload' },
  { id: 'ingest', name: 'Ingest', plain: 'Load the masked release into MongoDB + emit change events', icon: 'layers' },
  { id: 'cleanup', name: 'Cleanup', plain: 'Remove secrets and archive logs', icon: 'broom' },
];

// Mirrors wed.yml, in order. dur = seconds for a healthy run.
export const WED_STEPS = [
  { phase: 'setup', name: 'Checkout repo', uses: 'actions/checkout@v4', dur: 8,
    note: 'clean: false — preserves the gitignored data/ tree from a prior run.' },
  { phase: 'setup', name: 'Validate version format', dur: 1,
    note: 'Rejects anything that is not YYYY_MM.', log: 'Version OK: 2026_06' },
  { phase: 'setup', name: 'Configure AWS credentials via OIDC', uses: 'aws-actions/configure-aws-credentials@v4', dur: 3,
    note: 'Assumes the WED role in ap-southeast-1 via OIDC — no long-lived keys.' },
  { phase: 'setup', name: 'Runner health check', dur: 4,
    note: 'infra/bootstrap/runner-healthcheck.sh', log: 'disk 41% · stata-mp OK · /opt/wed-venv OK' },
  { phase: 'configure', name: 'Write env_vars.do from secrets', dur: 1,
    note: 'Emits a Stata global per set secret. Always shredded at job end.',
    log: 'Wrote 3 credential global(s) to env_vars.do' },
  { phase: 'configure', name: 'Generate runtime_env.do', dur: 2,
    note: 'Stage toggles: download + clean + combine ON; rest off.',
    log: '--- runtime_env.do generated ---' },
  { phase: 'configure', name: 'Ensure data directories', uses: 'ops/ensure-dirs.sh', dur: 2,
    note: 'Creates the data/ skeleton so a clean checkout has the expected tree.' },
  { phase: 'acquire', name: 'Pull inputs from S3', dur: 372, condition: 'if: skip_pull != true',
    note: 'Syncs repo-inputs/ from s3://gmd-wed-data-ap1 into data/.',
    log: 'download: 1,284 objects · 18.6 GiB transferred' },
  { phase: 'build', name: 'Fix file permissions for Stata', dur: 5,
    note: 'chmod -R u+w on data/ so Stata can rewrite the tree.' },
  { phase: 'build', name: 'Run Stata master pipeline', dur: 8040,
    note: 'stata-mp -b do code/0_master.do — download → clean → combine, parallel.',
    log: '0_master.do completed' },
  { phase: 'validate', name: 'Parse all Stata logs', dur: 18, condition: 'if: always()',
    note: 'Linux Stata does not reliably propagate r(NNN) exit codes, so every log is scanned for the error line. The authoritative build gate.',
    log: 'ops/parse_stata_logs.py --strict → build_log_report.json' },
  { phase: 'publish', name: 'Push outputs to S3', dur: 270, condition: 'if: success()',
    note: 'Pushes clean/ and final/ to s3://wed-output-ap1/2026_06.',
    log: 'upload: data/clean (842 obj) · data/final (1.4 GiB)' },
  { phase: 'publish', name: 'Archive build (clean_data_wide + metadata)', dur: 60, condition: 'if: success()',
    note: 'Per-version backup to s3://wed-archive-ap1/2026_06.',
    log: 'archived clean_data_wide.dta + run_report.json' },
  { phase: 'ingest', name: 'Ingest to MongoDB staging', dur: 300, condition: 'if: success()',
    note: 'bulk_import_sequential.py --masked → wed_staging; seals the release ledger + change events.',
    log: 'sealed release 2026_06 · +3,922 cells · 142,837 revised' },
  { phase: 'cleanup', name: 'Remove generated env_vars.do', dur: 1, condition: 'if: always()',
    note: 'Secrets file is always shredded, pass or fail.' },
  { phase: 'cleanup', name: 'Upload logs', uses: 'actions/upload-artifact@v4', dur: 22, condition: 'if: always()',
    note: 'Bundles *.log + reports to s3://wed-logs-ap1 (180-day retention).',
    log: 'wed-logs-2026_06 · 64.2 MiB' },
];

// Roll steps up into phases with an aggregate status + duration.
export function rollup(steps) {
  return WED_PHASES.map((p) => {
    const ps = steps.filter((s) => s.phase === p.id);
    const dur = ps.reduce((a, s) => a + (s.dur || 0), 0);
    let status = 'passed';
    if (ps.some((s) => s.status === 'failed')) status = 'failed';
    else if (ps.some((s) => s.status === 'running')) status = 'running';
    else if (ps.length && ps.every((s) => s.status === 'pending')) status = 'pending';
    else if (ps.some((s) => s.status === 'pending')) status = 'partial';
    else if (ps.length && ps.every((s) => s.status === 'skipped')) status = 'skipped';
    return { ...p, steps: ps, dur, status };
  });
}

// A representative successful run, anchored to the real latest release.
// version / knownFrom come from the live ledger; timings are representative.
export function buildRepresentativeRun({ version, knownFrom } = {}) {
  const steps = WED_STEPS.map((d) => ({ ...d, status: 'passed' }));
  const phases = rollup(steps);
  const duration = steps.reduce((a, s) => a + (s.dur || 0), 0);
  const startedAt = knownFrom ? Date.parse(knownFrom) : null;
  return {
    version: version || '—',
    state: 'success',
    representative: true,
    startedAt,
    finishedAt: startedAt != null ? startedAt + duration * 1000 : null,
    duration,
    steps,
    phases,
    triggeredManually: false,
    options: { run_mitchell: false, skip_pull: false },
  };
}

export function phasesWithSteps() {
  return WED_PHASES.map((p) => ({ ...p, steps: WED_STEPS.filter((s) => s.phase === p.id) }));
}
