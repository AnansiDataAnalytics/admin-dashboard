'use client';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { fmtNum, fmtDuration, fmtDateTime, relativeTime, toMs } from '@/lib/format';
import { nextScheduledRunLabel, runStaleness } from '@/lib/schedule.mjs';
import { deriveHeroVerdict, phaseName } from '@/lib/pipelineModel';

// Operator-facing summary of the LAST finished build — RUN-centric: it describes
// the run (a build only "loads into staging" when it reaches the final ingest
// step), not the data/release. Driven by `run` (the last finished run, with
// phase-tagged steps) reconciled with `health` (source-health, for the QC-flag
// count on a successful run). `err` is a backend outage → fail loud.
//
// Visual hierarchy: the headline is the focal point; Build / when / duration are
// the primary facts; trigger / checks / freshness / schedule are secondary. A
// running build is shown separately (RunningHero); here we only describe finished.
const STATE_META = {
  healthy:  { cls: 'v-healthy',  icon: 'check',  badge: 'Finished' },
  flags:    { cls: 'v-flags',    icon: 'alert',  badge: 'Finished · flags' },
  blocked:  { cls: 'v-blocked',  icon: 'x',      badge: 'Build failed' },
  awaiting: { cls: 'v-awaiting', icon: 'clock',  badge: 'No build yet' },
  overdue:  { cls: 'v-overdue',  icon: 'alert',  badge: 'Overdue' },
  running:  { cls: 'v-running',  icon: 'repeat', badge: 'Running' },
};

export default function VerdictHeader({ run, health, err, collapsible = false, label }) {
  // When `collapsible` (a build is running and shown separately) this last-finished
  // summary starts collapsed to its headline. The page remounts on active-state
  // flip (via key) so the default is right, while letting the user toggle.
  const [open, setOpen] = useState(!collapsible);

  // Fail loud: a fetch error is an outage, not a healthy state.
  if (err) {
    return (
      <div className="verdict v-blocked">
        <div className="verdict-head">
          <span className="verdict-ico"><Icon.alert size={22} /></span>
          <div className="verdict-headline">Status unavailable — backend unreachable</div>
        </div>
        <div className="verdict-secondary">
          <div className="vrow-k">Error</div><div className="vrow-v">{err}</div>
          <div className="vrow-k">Next run</div><div className="vrow-v mono">{nextScheduledRunLabel()}</div>
        </div>
      </div>
    );
  }

  const live = !!run && !run.representative;        // a real finished run to describe
  const s = health?.summary || {};
  const fallback = Number(health?.verdict?.fallback ?? s.fallback) || 0;
  const nowMs = Date.now();
  const lastRunMs = run?.finishedAt || toMs(health?.generated_at);
  const overdue = live ? !!runStaleness({ lastRunMs, nowMs }).overdue : false;

  const verdict = deriveHeroVerdict(run, health, { overdue });
  const meta = STATE_META[verdict.state] || STATE_META.blocked;
  const I = Icon[meta.icon] || Icon.check;
  const badge = verdict.state === 'blocked' && verdict.phase ? `Stopped at ${phaseName(verdict.phase)}` : meta.badge;
  const showRows = !collapsible || open;

  const version = run?.version || '—';
  const phases = run?.phases || [];
  const qcFlags = verdict.qc_flags || Number(s.qc_flags) || 0;

  return (
    <div className={`verdict ${meta.cls}`}>
      <div className="verdict-head">
        {collapsible && (
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Toggle build details"
                  style={{ background: 'none', border: 'none', padding: 0, marginRight: '2px', cursor: 'pointer', color: 'var(--text-3)', display: 'inline-flex' }}>
            <span style={{ display: 'inline-flex', transition: 'transform .18s', transform: open ? 'rotate(90deg)' : 'none' }}><Icon.chevron size={15} /></span>
          </button>
        )}
        <span className="verdict-ico"><I size={24} /></span>
        <div className="verdict-headline">
          {label ? <span className="verdict-eyebrow">{label}</span> : null}
          {verdict.headline}
        </div>
        <span className="vbadge">{badge}</span>
      </div>

      {showRows && live && (
        <>
          {/* the parts: each phase of the run at a glance, halt highlighted */}
          {phases.length > 0 && (
            <div className="phase-strip">
              {phases.map((p) => (
                <span key={p.id} className={`phase-pip pp-${p.status}`} title={p.plain || p.name}>{p.name}</span>
              ))}
            </div>
          )}

          {/* primary facts */}
          <div className="verdict-primary">
            <div className="vp-item">
              <span className="vp-k">Build</span>
              <span className="vp-v mono">{run?.html_url
                ? <a href={run.html_url} target="_blank" rel="noreferrer">{version} <span className="vp-ext">↗</span></a>
                : version}</span>
            </div>
            <div className="vp-item">
              <span className="vp-k">{run?.finishedAt ? 'Finished' : 'Started'}</span>
              <span className="vp-v">{run?.finishedAt
                ? <>{fmtDateTime(run.finishedAt)} <span className="muted">· {relativeTime(run.finishedAt, nowMs)}</span></>
                : (run?.startedAt ? <>{fmtDateTime(run.startedAt)} <span className="muted">· running</span></> : 'in progress')}</span>
            </div>
            <div className="vp-item">
              <span className="vp-k">Duration</span>
              <span className="vp-v">{fmtDuration(run?.duration)}</span>
            </div>
          </div>

          {/* secondary facts */}
          <div className="verdict-secondary">
            <div className="vrow-k">Trigger</div>
            <div className="vrow-v">{run?.triggeredManually ? 'Manual dispatch' : 'Scheduled'}<span className="muted"> · {run?.actor || 'unknown'}</span></div>

            <div className="vrow-k">Checks</div>
            <div className="vrow-v">{s.sources_total ? <>{fmtNum(s.sources_total)} sources · </> : null}{fmtNum(s.variables_total)} variables · <b>{fmtNum(qcFlags)} QC flags</b>{fallback > 0 ? <> · <span className="muted">{fmtNum(fallback)} on cached data</span></> : null}</div>

            <div className="vrow-k">Source data as of</div>
            <div className="vrow-v">{toMs(health?.generated_at) ? <>{fmtDateTime(health.generated_at)} <span className="muted">· {relativeTime(health.generated_at, nowMs)}</span></> : <span className="muted">not reported</span>}</div>

            <div className="vrow-k">Next run</div>
            <div className="vrow-v mono">{nextScheduledRunLabel()}{overdue ? <span className="muted"> · overdue</span> : null}</div>
          </div>
        </>
      )}

      {showRows && !live && (
        <div className="verdict-secondary">
          <div className="vrow-k">Live data</div>
          <div className="vrow-v"><span className="muted">none yet — the breakdown below is a representative example</span></div>
          <div className="vrow-k">Next run</div>
          <div className="vrow-v mono">{nextScheduledRunLabel()}</div>
        </div>
      )}
    </div>
  );
}
