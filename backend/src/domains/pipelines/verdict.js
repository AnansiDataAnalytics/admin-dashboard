// Derive the single operator-facing verdict for a WED build from a source-health
// manifest. One of three states:
//   blocked  — a hard download/clean/combine failure aborted the build (a failed
//              source or a gated stage). Nothing published. The ONLY state that
//              stops a release.
//   flags    — built & published, but advisory QC raised flags to review. QC is
//              advisory and never blocks.
//   healthy  — published, no flags.
// Pure: same manifest in → same verdict out. No I/O.
function deriveVerdict(health) {
  if (!health || !health.summary) {
    return { state: 'blocked', hard_failures: 0, qc_flags: 0, fallback: 0, gated_stage: null };
  }
  // summary.failed counts HARD failures only (combine errors + a systemic
  // download abort). Individual download sources that fell back to last-good
  // data are in summary.fallback, NOT summary.failed, so they never block.
  const hardFailures = Number(health.summary.failed) || 0;
  const gated = health.gated_stage || health.summary.gated_stage || null;
  const qcFlags = Number(health.summary.qc_flags) || 0;
  const fallback = Number(health.summary.fallback) || 0;
  let state;
  if (hardFailures > 0 || gated) state = 'blocked';
  else if (qcFlags > 0) state = 'flags';
  else state = 'healthy';
  return { state, hard_failures: hardFailures, qc_flags: qcFlags, fallback, gated_stage: gated };
}

module.exports = { deriveVerdict };
