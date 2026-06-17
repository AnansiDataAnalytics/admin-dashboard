'use client';
import { Icon } from '@/components/Icon';
import Spinner from '@/components/Spinner';
import { fmtDateTime, relativeTime } from '@/lib/format';

// The currently-executing build, shown front-and-center and INDEPENDENT of the
// last-finished verdict — so a new run never inherits the previous run's pass/
// fail color (the bug this separation fixes). A running build has no verdict
// yet, so the banner is deliberately neutral; its live per-stage detail is in
// <PipelineProgress> directly below. Driven by the operational run, not health.
export default function RunningHero({ run }) {
  if (!run) return null;
  const queued = run.state === 'queued';
  const nowMs = Date.now();
  const ver = run.version && run.version !== '—' ? ` — ${run.version}` : '';
  return (
    <div className="verdict v-running">
      <div className="verdict-head">
        <span className="verdict-ico">{queued ? <Icon.clock size={22} /> : <Spinner size={18} />}</span>
        <div className="verdict-headline">
          <span style={{ display: 'block', fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-3)', marginBottom: '2px' }}>Current build</span>
          {queued ? 'Build queued' : 'Build running'}{ver}
        </div>
      </div>
      <div className="verdict-rows">
        <div className="vrow-k">Status</div>
        <div className="vrow-v"><span className="vbadge">{queued ? 'Queued' : 'Running'}</span></div>

        <div className="vrow-k">Started</div>
        <div className="vrow-v">{run.startedAt
          ? <>{fmtDateTime(run.startedAt)} <span className="muted">· {relativeTime(run.startedAt, nowMs)}</span></>
          : <span className="muted">just queued</span>}</div>

        <div className="vrow-k">Trigger</div>
        <div className="vrow-v">{run.triggeredManually ? 'Manual dispatch' : 'Scheduled'}<span className="muted"> · {run.actor || 'unknown'}</span></div>

        {run.html_url ? (
          <>
            <div className="vrow-k">Workflow run</div>
            <div className="vrow-v"><a href={run.html_url} target="_blank" rel="noreferrer" style={{ color: 'var(--blue-fg)', textDecoration: 'none' }}>View on GitHub ↗</a></div>
          </>
        ) : null}
      </div>
    </div>
  );
}
