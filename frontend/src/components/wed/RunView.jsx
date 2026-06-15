'use client';
import { useState } from 'react';
import { Icon, StatusGlyph } from '@/components/Icon';
import Spinner from '@/components/Spinner';
import { fmtDuration, fmtDateTime } from '@/lib/format';

// The workflow-run view (ported from the mockup): hero, metric cards, pipeline
// flow, duration gantt, grouped steps + logs, and run details. Driven by a run
// object (representative until live telemetry lands; see pipelineModel.js).

function Section({ icon, title, hint, children }) {
  const CI = Icon[icon] || Icon.box;
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title"><span className="ct-ico"><CI size={16} /></span> {title}</div>
        {hint && <div className="card-hint">{hint}</div>}
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}

function Gantt({ run }) {
  const total = run.duration || 1;
  let cursor = 0;
  return (
    <div>
      <div className="gantt">
        {run.phases.map((p) => {
          const start = cursor; cursor += p.dur;
          const st = p.status === 'partial' ? 'running' : (p.status === 'pending' ? 'skipped' : p.status);
          const PI = Icon[p.icon] || Icon.box;
          return (
            <div className="gantt-row" key={p.id}>
              <div className="gantt-label"><PI size={13} /> {p.name}</div>
              <div className="gantt-track">
                {p.dur > 0 && <div className={`gantt-bar gb-${st}`} style={{ left: `${(start / total) * 100}%`, width: `${Math.max((p.dur / total) * 100, 0.6)}%` }} />}
              </div>
              <div className="gantt-dur">{p.dur > 0 ? fmtDuration(p.dur) : '—'}</div>
            </div>
          );
        })}
      </div>
      <div className="gantt-axis"><span>00:00</span><span>start → finish · total {fmtDuration(run.duration)}</span><span>{fmtDuration(total)}</span></div>
    </div>
  );
}

function StepRow({ s }) {
  const dim = s.status === 'skipped' || s.status === 'pending';
  return (
    <div className="step">
      <span className={`step-stat ss-${s.status}`}>
        {s.status === 'running'
          ? <Spinner size={11} />
          : (s.status !== 'skipped' && s.status !== 'pending' && <StatusGlyph status={s.status} size={11} />)}
      </span>
      <div className="step-main">
        <div className={`step-name ${dim ? 'dim' : ''}`}>
          {s.name}
          {s.uses && <span className="chip">{s.uses}</span>}
          {s.condition && <span className="chip cond">{s.condition}</span>}
          {s.status === 'skipped' && <span className="chip">skipped</span>}
        </div>
        {s.note && <div className="step-note">{s.note}</div>}
        {s.log && s.status !== 'skipped' && s.status !== 'pending' && (
          <div className={`step-log ${s.status === 'failed' ? 'err' : ''}`}>
            <span className="lg-mark">{s.status === 'failed' ? <Icon.x size={12} /> : '›'}</span>{s.log}
          </div>
        )}
      </div>
      <div className="step-dur">{s.status === 'running' ? 'running' : (s.status === 'skipped' || s.status === 'pending') ? '—' : fmtDuration(s.dur)}</div>
    </div>
  );
}

function PhaseGroup({ phase, openDefault }) {
  const [open, setOpen] = useState(openDefault);
  const st = phase.status === 'partial' ? 'running' : phase.status;
  const PI = Icon[phase.icon] || Icon.box;
  return (
    <div className={`phase-group ${open ? 'open' : ''}`}>
      <button className="phase-head" onClick={() => setOpen((o) => !o)}>
        <span className="phase-chev"><Icon.chevron size={15} /></span>
        <span className={`phase-stat fs-${st === 'pending' ? 'pending' : st}`}>
          {st === 'running' ? <Spinner size={13} />
            : st !== 'pending' && st !== 'skipped' ? <StatusGlyph status={st} size={13} />
            : <PI size={13} />}
        </span>
        <span className="phase-info">
          <span className="phase-title">{phase.name}</span>
          <span className="phase-plain">{phase.plain}</span>
        </span>
        <span className="phase-meta">{phase.steps.length} {phase.steps.length > 1 ? 'steps' : 'step'}</span>
        <span className="phase-dur">{phase.status === 'pending' ? 'queued' : phase.status === 'running' ? 'running' : fmtDuration(phase.dur)}</span>
      </button>
      {open && (
        <div className="step-list">
          {phase.steps.map((s, i) => <StepRow key={i} s={s} />)}
        </div>
      )}
    </div>
  );
}

function RunDetails({ run }) {
  const failed = run.state === 'failure';
  return (
    <div>
      {failed ? (
          <div className="artifact" style={{ borderColor: 'var(--red-line)', background: 'var(--red-bg)' }}>
            <span className="artifact-ico" style={{ color: 'var(--red-fg)' }}><Icon.x size={16} /></span>
            <div className="artifact-main">
              <div className="artifact-name" style={{ color: 'var(--red-fg)' }}>No data published</div>
              <div className="artifact-sub">Push to wed-output-ap1 was skipped — build gate failed</div>
            </div>
          </div>
        ) : (
          <>
            <div className="artifact">
              <span className="artifact-ico"><Icon.cloud size={17} /></span>
              <div className="artifact-main">
                <div className="artifact-name">s3://wed-output-ap1/{run.version}/final</div>
                <div className="artifact-sub">1.4 GiB · final WED release</div>
              </div>
              <div className="artifact-when">{run.finishedAt ? fmtDateTime(run.finishedAt) : '—'}</div>
              <span className="artifact-go"><Icon.external size={15} /></span>
            </div>
            <div className="artifact">
              <span className="artifact-ico"><Icon.cloud size={17} /></span>
              <div className="artifact-main">
                <div className="artifact-name">s3://wed-archive-ap1/{run.version}</div>
                <div className="artifact-sub">clean_data_wide.dta + run_report.json · vintage backup</div>
              </div>
              <div className="artifact-when">{run.finishedAt ? fmtDateTime(run.finishedAt) : '—'}</div>
              <span className="artifact-go"><Icon.external size={15} /></span>
            </div>
            <div className="artifact">
              <span className="artifact-ico"><Icon.layers size={16} /></span>
              <div className="artifact-main">
                <div className="artifact-name">wed_staging · {run.version}</div>
                <div className="artifact-sub">release sealed · change events emitted</div>
              </div>
              <div className="artifact-when">{run.finishedAt ? fmtDateTime(run.finishedAt) : '—'}</div>
              <span className="artifact-go"><Icon.external size={15} /></span>
            </div>
          </>
        )}
      <div style={{ marginTop: 14 }} className="subhead">Data flow</div>
      <div className="artifact" style={{ background: 'var(--surface)', flexDirection: 'column', alignItems: 'stretch', gap: 9 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)', flexWrap: 'wrap', gap: 6 }}>
          <span className="mono" style={{ fontSize: 11.5 }}>gmd-wed-data-ap1</span>
          <Icon.arrowRight size={14} /><span>build</span>
          <Icon.arrowRight size={14} /><span className="mono" style={{ fontSize: 11.5 }}>wed-output-ap1</span>
          <Icon.arrowRight size={14} /><span>ingest</span>
          <Icon.arrowRight size={14} /><span className="mono" style={{ fontSize: 11.5 }}>wed_staging</span>
        </div>
      </div>
    </div>
  );
}

export default function RunView({ run }) {
  const hasPhases = (run.phases || []).length > 0;
  return (
    <>
      <Section icon="cloud" title="Outputs &amp; artifacts">
        <RunDetails run={run} />
      </Section>

      {hasPhases ? (
        <>
          <Section icon="cpu" title="Steps &amp; logs">
            {run.phases.map((p) => (
              <PhaseGroup key={p.id} phase={p}
                openDefault={p.status === 'failed' || p.status === 'running'} />
            ))}
          </Section>

          <Section icon="clock" title="Where the time goes">
            <Gantt run={run} />
          </Section>
        </>
      ) : (
        // Real run whose per-step telemetry hasn't arrived yet (early in-progress,
        // or only the workflow_run event seen so far).
        <Section icon="cpu" title="Pipeline steps">
          <div className="state-line"><Icon.repeat size={15} /> Per-step status will appear as the workflow_job events arrive.</div>
        </Section>
      )}
    </>
  );
}
