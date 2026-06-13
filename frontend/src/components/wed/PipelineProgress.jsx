'use client';
import { Icon, StatusGlyph } from '@/components/Icon';
import Spinner from '@/components/Spinner';
import { fmtNum, relativeTime } from '@/lib/format';

// Live "where are we in the Stata build" — fed by the box heartbeat
// (ops/report_progress.py -> run.progress), which is the ONLY source of
// intra-build progress (GitHub's workflow_job webhook is blind mid-job). Shows
// the download -> clean -> combine sequence with per-source counts. Updates over
// SSE; the page's Refresh button also re-pulls it.

const STAGES = [
  { id: 'download', label: 'Download', plain: 'per-source fetch scripts' },
  { id: 'clean', label: 'Clean', plain: 'standardize raw → tidy panels' },
  { id: 'combine', label: 'Combine', plain: 'chain-link variables' },
];

function stageState(idx, curIdx) {
  if (curIdx < 0) return 'pending';
  if (idx < curIdx) return 'done';
  if (idx === curIdx) return 'active';
  return 'pending';
}

function Counts({ c }) {
  if (!c || (c.total == null && c.done == null)) return null;
  return (
    <span className="pp-counts">
      <b>{fmtNum(c.done || 0)}</b>{c.total ? <>/{fmtNum(c.total)}</> : null} done
      {(c.failed || 0) > 0 && <span className="pp-fail"> · {fmtNum(c.failed)} failed</span>}
    </span>
  );
}

export default function PipelineProgress({ run }) {
  const p = run?.progress;
  if (!p || !p.current_stage) return null;

  const curIdx = STAGES.findIndex((s) => s.id === p.current_stage);
  const counts = { download: p.download, clean: null, combine: p.combine };

  return (
    <div className="card pp-card">
      <div className="card-head">
        <div className="card-title"><span className="ct-ico"><Icon.cpu size={16} /></span> Pipeline progress</div>
        <div className="card-hint">
          live from the build box{p.reported_at ? <> · updated {relativeTime(Date.parse(p.reported_at))}</> : null}
        </div>
      </div>
      <div className="card-body">
        <div className="pp-flow">
          {STAGES.map((s, i) => {
            const st = stageState(i, curIdx);
            const c = counts[s.id];
            const failed = (c?.failed || 0) > 0;
            return (
              <div className="pp-stage-wrap" key={s.id}>
                <div className={`pp-stage pp-${st}${failed && st === 'active' ? ' pp-hasfail' : ''}`}>
                  <span className="pp-glyph">
                    {st === 'active' ? <Spinner size={16} />
                      : st === 'done' ? <StatusGlyph status="passed" size={14} />
                      : <span className="pp-dot" />}
                  </span>
                  <div className="pp-stage-main">
                    <div className="pp-stage-name">{s.label}</div>
                    <div className="pp-stage-plain">{s.plain}</div>
                    {s.id === 'clean'
                      ? <span className="pp-counts">{st === 'done' ? 'complete' : st === 'active' ? 'running' : 'queued'}</span>
                      : <Counts c={c} />}
                  </div>
                </div>
                {i < STAGES.length - 1 && <span className="pp-conn"><Icon.chevron size={16} /></span>}
              </div>
            );
          })}
        </div>

        {curIdx >= 0 && counts[STAGES[curIdx].id]?.total > 0 && (() => {
          const c = counts[STAGES[curIdx].id];
          const pct = Math.min(100, Math.round(((c.done || 0) / c.total) * 100));
          return (
            <div className="pp-bar-wrap">
              <div className="pp-bar"><div className="pp-bar-fill" style={{ width: `${pct}%` }} /></div>
              <div className="pp-bar-meta">
                {STAGES[curIdx].label}: {fmtNum(c.done || 0)} / {fmtNum(c.total)} sources
                {(c.failed || 0) > 0 && <span className="pp-fail"> · {fmtNum(c.failed)} failed (build aborts if any fail)</span>}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
