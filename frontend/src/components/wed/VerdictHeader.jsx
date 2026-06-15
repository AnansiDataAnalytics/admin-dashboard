'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { fmtNum, fmtDuration, fmtDateTime, relativeTime, toMs } from '@/lib/format';
import { nextScheduledRunLabel, runStaleness } from '@/lib/schedule.mjs';

// The single operator-facing status, reconciled to real execution truth AND to
// liveness. Trust rules:
//   • a fetch error is an OUTAGE → red "unavailable" (never a green fallback);
//   • representative data (no live run yet) → neutral "awaiting", NOT a confident
//     healthy/flags/blocked verdict;
//   • live data whose latest scheduled run never arrived → amber "overdue".
// `signal` bumps on every page refresh so this re-pulls with the rest of the page.
const STAGE_LABEL = { download: 'Download', clean: 'Clean', combine: 'Combine' };
const STATE_META = {
  healthy:  { cls: 'v-healthy',  icon: 'check', badge: 'Published' },
  flags:    { cls: 'v-flags',    icon: 'alert', badge: 'Published · review flags' },
  blocked:  { cls: 'v-blocked',  icon: 'x',     badge: 'Failed' },
  awaiting: { cls: 'v-awaiting', icon: 'clock', badge: 'No live run' },
  overdue:  { cls: 'v-overdue',  icon: 'alert', badge: 'Run overdue' },
};

export default function VerdictHeader({ run, signal = 0 }) {
  const [health, setHealth] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    api.wedSourceHealth()
      .then((d) => { if (alive) { setHealth(d); setErr(null); } })
      .catch((e) => { if (alive) setErr(e?.message || 'Failed to load build status'); });
    return () => { alive = false; };
  }, [signal]);

  // Fail loud: an error fetching status is an outage, not a healthy state.
  if (err) {
    return (
      <div className="verdict v-blocked">
        <div className="verdict-head">
          <span className="verdict-ico"><Icon.alert size={20} /></span>
          <div className="verdict-headline">Status unavailable — backend unreachable</div>
        </div>
        <div className="verdict-rows">
          <div className="vrow-k">Error</div><div className="vrow-v">{err}</div>
          <div className="vrow-k">Next run</div><div className="vrow-v mono">{nextScheduledRunLabel()}</div>
        </div>
      </div>
    );
  }
  if (!health) {
    return (
      <div className="verdict">
        <div className="verdict-head">
          <span className="verdict-ico"><Icon.repeat size={20} /></span>
          <div className="verdict-headline">Loading build status…</div>
        </div>
      </div>
    );
  }

  const live = !health.representative;
  const v = health.verdict || { state: 'blocked', qc_flags: 0, gated_stage: null };
  const s = health.summary || {};
  const version = run?.version || '—';
  const gatedLabel = STAGE_LABEL[v.gated_stage] || v.gated_stage;
  const lastRunMs = toMs(health.generated_at);
  const stale = live ? runStaleness({ lastRunMs, nowMs: Date.now() }) : null;

  const stateKey = !live ? 'awaiting' : (stale?.overdue ? 'overdue' : v.state);
  const meta = STATE_META[stateKey] || STATE_META.blocked;
  const I = Icon[meta.icon] || Icon.check;

  const headline =
    !live ? 'Awaiting live run data — no run has reported yet'
    : stale?.overdue ? `Run overdue — last update ${lastRunMs ? relativeTime(lastRunMs) : 'never'}`
    : v.state === 'blocked' ? (v.gated_stage ? `Build failed — halted at ${gatedLabel}` : 'Build failed — release blocked')
    : v.state === 'flags' ? `Published with ${fmtNum(v.qc_flags)} QC flag${v.qc_flags === 1 ? '' : 's'} to review`
    : `Published & healthy — ${version} is live`;

  return (
    <div className={`verdict ${meta.cls}`}>
      <div className="verdict-head">
        <span className="verdict-ico"><I size={22} /></span>
        <div className="verdict-headline">{headline}</div>
      </div>
      <div className="verdict-rows">
        <div className="vrow-k">Status</div>
        <div className="vrow-v"><span className="vbadge">{meta.badge}</span></div>

        {live ? (
          <>
            <div className="vrow-k">Version</div>
            <div className="vrow-v mono">{version}{v.state === 'blocked' ? <span className="muted"> · not published</span> : null}</div>

            <div className="vrow-k">{run?.finishedAt ? 'Finished' : 'Status'}</div>
            <div className="vrow-v">{run?.finishedAt
              ? <>{fmtDateTime(run.finishedAt)} <span className="muted">· {relativeTime(run.finishedAt)}</span></>
              : 'in progress'}</div>

            <div className="vrow-k">Duration</div>
            <div className="vrow-v">{fmtDuration(run?.duration)}</div>

            <div className="vrow-k">Trigger</div>
            <div className="vrow-v">{run?.triggeredManually ? 'Manual dispatch' : 'Scheduled'}<span className="muted"> · {run?.actor || (run?.triggeredManually ? 'j.okafor' : 'github-actions[bot]')}</span></div>

            <div className="vrow-k">Runner</div>
            <div className="vrow-v">self-hosted · wed <span className="muted">· ap-southeast-1</span></div>

            {run?.html_url ? (
              <>
                <div className="vrow-k">Workflow run</div>
                <div className="vrow-v"><a href={run.html_url} target="_blank" rel="noreferrer" style={{ color: 'var(--blue-fg)', textDecoration: 'none' }}>View on GitHub ↗</a></div>
              </>
            ) : null}

            <div className="vrow-k">Checks</div>
            <div className="vrow-v">{fmtNum(s.sources_total)} sources · {fmtNum(s.variables_total)} variables · <b>{fmtNum(v.qc_flags)} QC flags</b></div>

            <div className="vrow-k">Data as of</div>
            <div className="vrow-v">{lastRunMs ? <>{fmtDateTime(lastRunMs)} <span className="muted">· {relativeTime(lastRunMs)}</span></> : <span className="muted">unknown</span>}</div>
          </>
        ) : (
          <>
            <div className="vrow-k">Live data</div>
            <div className="vrow-v"><span className="muted">none yet — the breakdown below is a representative example</span></div>
          </>
        )}

        <div className="vrow-k">Next run</div>
        <div className="vrow-v mono">{nextScheduledRunLabel()}</div>
      </div>
    </div>
  );
}
