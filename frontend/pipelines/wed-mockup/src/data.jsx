// data.jsx — WED Pipeline run model: phases, steps, durations, scenario builders, history.
// Exported to window for the other babel scripts.

// Fixed "now" for deterministic relative timestamps.
const NOW = new Date("2026-06-05T10:24:00+10:00").getTime();

// ---- Phase metadata (executive-friendly) -----------------------------------
const PHASES = [
  {
    id: "setup",
    name: "Setup",
    plain: "Prepare the runner and authenticate to AWS",
    icon: "server",
  },
  {
    id: "configure",
    name: "Configure",
    plain: "Generate credentials and runtime configuration",
    icon: "sliders",
  },
  {
    id: "acquire",
    name: "Acquire data",
    plain: "Download source inputs from cloud storage",
    icon: "download",
  },
  {
    id: "build",
    name: "Build",
    plain: "Run the Stata pipeline — download, clean, combine",
    icon: "cpu",
  },
  {
    id: "validate",
    name: "Validate",
    plain: "Scan every Stata log for errors — the real pass / fail gate",
    icon: "shield",
  },
  {
    id: "publish",
    name: "Publish",
    plain: "Upload clean & final datasets to the output bucket",
    icon: "upload",
  },
  {
    id: "cleanup",
    name: "Cleanup",
    plain: "Remove secrets and archive logs",
    icon: "broom",
  },
];

// ---- Base step definitions (mirrors wed.yml, in order) ----------------------
// dur = seconds for a healthy run.
const STEP_DEFS = [
  { phase: "setup", name: "Checkout repo", uses: "actions/checkout@v4", dur: 8,
    note: "clean: false — preserves the gitignored data/ tree from a prior run." },
  { phase: "setup", name: "Validate version format", dur: 1,
    note: "Rejects anything that isn't YYYY_MM.", log: "Version OK: 2026_06" },
  { phase: "setup", name: "Configure AWS credentials via OIDC", uses: "aws-actions/configure-aws-credentials@v4", dur: 3,
    note: "Assumes WED_AWS_ROLE_ARN in ap-southeast-2 via OIDC — no long-lived keys." },
  { phase: "setup", name: "Runner health check", dur: 4,
    note: "infra/bootstrap/runner-healthcheck.sh", log: "disk 41% · stata-mp OK · /opt/wed-venv OK" },
  { phase: "configure", name: "Write env_vars.do from secrets", dur: 1,
    note: "Emits a Stata global only for each secret that is set. Deleted at job end.",
    log: "Wrote 3 credential global(s) to env_vars.do" },
  { phase: "configure", name: "Generate runtime_env.do", dur: 2,
    note: "Stage toggles: download + clean + combine ON; mitchell optional; rest off.",
    log: "--- runtime_env.do generated ---" },
  { phase: "acquire", name: "Pull inputs from S3 (gmd-wed-data)", dur: 372,
    condition: "if: inputs.skip_pull != true",
    note: "Syncs repo-inputs/ from s3://gmd-wed-data into data/.",
    log: "download: 1,284 objects · 18.6 GiB transferred" },
  { phase: "build", name: "Fix file permissions for Stata", dur: 5,
    note: "chmod -R u+w on data/ so Stata can rewrite the tree." },
  { phase: "build", name: "Run Stata master pipeline", dur: 8040,
    note: "stata-mp -b do code/0_master.do — download → clean → combine, 8-way parallel.",
    log: "0_master.do completed" },
  { phase: "validate", name: "Parse all Stata logs", dur: 18,
    condition: "if: always()",
    note: "Linux Stata does not reliably propagate r(NNN) exit codes, so every log is scanned for the error line. This is the authoritative build gate.",
    log: "ops/parse_stata_logs.py --strict → build_log_report.json" },
  { phase: "publish", name: "Push outputs to S3 (gmd-wed-output)", dur: 270,
    note: "Only runs when the build + log parse passed. Pushes clean/ and final/ to s3://gmd-wed-output/2026_06.",
    log: "upload: data/clean (842 obj) · data/final (1.4 GiB)" },
  { phase: "cleanup", name: "Remove generated env_vars.do", dur: 1,
    condition: "if: always()", note: "Secrets file is always shredded, pass or fail." },
  { phase: "cleanup", name: "Upload logs", uses: "actions/upload-artifact@v4", dur: 22,
    condition: "if: always()",
    note: "Bundles *.log + build_log_report.json as wed-logs-2026_06. Retained 30 days.",
    log: "artifact wed-logs-2026_06 · 64.2 MiB · retention 30d" },
];

// ---- Scenario builders ------------------------------------------------------
// Returns array of steps with { ...def, status, dur } for a given scenario.
// status ∈ passed | failed | skipped | running | pending
function buildSteps(scenario, scale = 1) {
  return STEP_DEFS.map((d) => {
    const base = { ...d, dur: Math.max(1, Math.round(d.dur * scale)) };
    if (scenario === "success") return { ...base, status: "passed" };

    if (scenario === "failure") {
      // The Stata step itself "passes" (Linux Stata doesn't propagate exit
      // codes) — the log parser is what catches the error.
      if (d.name === "Parse all Stata logs") {
        return {
          ...base, status: "failed", dur: 12,
          log: "ERROR r(459) in combine_log/merge_wide.log:3812 — push gate failed",
        };
      }
      if (d.name === "Run Stata master pipeline") {
        return { ...base, status: "passed", dur: Math.round(5870 * scale),
          log: "0_master.do completed (exit 0) — note: log scan still pending" };
      }
      if (d.name === "Push outputs to S3 (gmd-wed-output)") {
        return { ...base, status: "skipped", dur: 0,
          note: "Skipped — build gate failed, so no outputs were published." };
      }
      // Cleanup steps are if: always() → still run.
      return { ...base, status: "passed" };
    }

    if (scenario === "running") {
      const order = STEP_DEFS.indexOf(d);
      const runningIdx = STEP_DEFS.findIndex((s) => s.name === "Run Stata master pipeline");
      if (order < runningIdx) return { ...base, status: "passed" };
      if (order === runningIdx) return { ...base, status: "running", dur: 2820,
        log: "clean: 61 / 88 source files merged …" };
      return { ...base, status: "pending", dur: 0 };
    }
    return { ...base, status: "passed" };
  });
}

// Roll steps up into phases with aggregate status + duration.
function rollup(steps) {
  return PHASES.map((p) => {
    const ps = steps.filter((s) => s.phase === p.id);
    const dur = ps.reduce((a, s) => a + (s.dur || 0), 0);
    let status = "passed";
    if (ps.some((s) => s.status === "failed")) status = "failed";
    else if (ps.some((s) => s.status === "running")) status = "running";
    else if (ps.every((s) => s.status === "pending")) status = "pending";
    else if (ps.some((s) => s.status === "pending")) status = "partial";
    else if (ps.every((s) => s.status === "skipped")) status = "skipped";
    return { ...p, steps: ps, dur, status };
  });
}

// ---- Run history ------------------------------------------------------------
// One run per week (Wednesdays 02:00 AEST). Latest first.
const WEEK = 7 * 24 * 3600 * 1000;
const LATEST_START = new Date("2026-06-03T02:00:00+10:00").getTime();

const HISTORY_SEED = [
  { state: "success", scale: 1.00, version: "2026_06" },
  { state: "success", scale: 0.97, version: "2026_05" },
  { state: "success", scale: 1.04, version: "2026_05" },
  { state: "failure", scale: 0.71, version: "2026_05" },
  { state: "success", scale: 0.99, version: "2026_05" },
  { state: "success", scale: 1.02, version: "2026_04" },
  { state: "success", scale: 0.95, version: "2026_04" },
  { state: "success", scale: 1.18, version: "2026_04" },
  { state: "success", scale: 1.01, version: "2026_04" },
  { state: "success", scale: 0.98, version: "2026_04" },
  { state: "success", scale: 1.06, version: "2026_03" },
  { state: "success", scale: 0.93, version: "2026_03" },
];

// runNumber counts up; latest has the highest.
const TOTAL_RUNS = 148;

function buildRun(seed, idx, scenarioOverride) {
  const state = idx === 0 && scenarioOverride ? scenarioOverride : seed.state;
  const startedAt = LATEST_START - idx * WEEK;
  const steps = buildSteps(state, seed.scale);
  const phases = rollup(steps);
  const totalDur = steps.reduce((a, s) => a + (s.dur || 0), 0);
  const triggeredManually = idx === 0 && scenarioOverride === "running" ? true : (idx % 5 === 3);
  return {
    idx,
    number: TOTAL_RUNS - idx,
    version: seed.version,
    state,
    startedAt,
    finishedAt: state === "running" ? null : startedAt + totalDur * 1000,
    duration: totalDur,
    steps,
    phases,
    triggeredManually,
    options: { run_mitchell: false, skip_pull: false },
  };
}

function buildHistory(scenarioOverride) {
  return HISTORY_SEED.map((s, i) => buildRun(s, i, scenarioOverride));
}

// ---- Formatting helpers -----------------------------------------------------
function fmtDuration(sec) {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
function fmtDurationLong(sec) {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !h) parts.push(`${s}s`);
  return parts.join(" ");
}

function relativeTime(ts, now = NOW) {
  if (ts == null) return "in progress";
  const diff = ts - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hrs = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  let phrase;
  if (mins < 1) phrase = "just now";
  else if (mins < 60) phrase = `${mins} min`;
  else if (hrs < 24) phrase = `${hrs} hour${hrs > 1 ? "s" : ""}`;
  else phrase = `${days} day${days > 1 ? "s" : ""}`;
  if (phrase === "just now") return phrase;
  return diff < 0 ? `${phrase} ago` : `in ${phrase}`;
}

function fmtDate(ts, now = NOW) {
  const d = new Date(ts);
  return d.toLocaleString("en-AU", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: "Australia/Sydney",
  });
}

const NEXT_RUN = LATEST_START + WEEK; // following Wednesday

Object.assign(window, {
  WED_NOW: NOW,
  WED_NEXT_RUN: NEXT_RUN,
  WED_PHASES: PHASES,
  buildHistory,
  buildRun,
  rollup,
  fmtDuration,
  fmtDurationLong,
  relativeTime,
  fmtDate,
});
