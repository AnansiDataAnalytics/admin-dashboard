'use client';
import { useState } from 'react';
import { Icon, StatusGlyph } from '@/components/Icon';
import Spinner from '@/components/Spinner';
import { fmtDuration, fmtDateTime, relativeTime } from '@/lib/format';

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

function RunHero({ run }) {
  const st = run.state === 'failure' ? 'failed' : run.state === 'running' ? 'running' : 'passed';
  const icon = st === 'failed' ? <Icon.x size={28} sw={2.4} /> : st === 'running' ? <Spinner size={26} color="var(--blue-fg)" /> : <Icon.check size={28} sw={2.4} />;
  const title = st === 'failed' ? 'Latest build failed' : st === 'running' ? 'Build in progress' : 'Latest build succeeded';
  const sub = st === 'failed'
    ? <>Version <b className="mono">{run.version}</b> was <b>not published</b> — the log-parse gate caught a Stata error</>
    : st === 'running'
      ? <>Building <b className="mono">{run.version}</b> · running the Stata master pipeline</>
      : <>Version <b className="mono">{run.version}</b> published to <b className="mono">wed-output-ap1</b>{run.finishedAt ? <> · finished <b>{relativeTime(run.finishedAt)}</b></> : null} · ran {fmtDuration(run.duration)}</>;
  return (
    <div className={`hero h-${st}`}>
      <div className="hero-top">
        <div className={`hero-icon hi-${st}`}>{icon}</div>
        <div>
          <div className="hero-headline">{title}</div>
          <div className="hero-sub">{sub}</div>
        </div>
        <div className="hero-spacer" />
        <div className="hero-right">
          <span className={`sbadge s-${st}`}><span className="gl"><StatusGlyph status={st} size={13} /></span>{st === 'failed' ? 'Failed' : st === 'running' ? 'Running' : 'Succeeded'}</span>
          <div className="nextrun"><Icon.calendar size={14} /> weekly · <span className="mono">Wed 02:00</span></div>
        </div>
      </div>
    </div>
  );
}

function RunMetrics({ run }) {
  return (
    <div className="metrics">
      <div className="metric">
        <div className="metric-label"><Icon.tag size={13} /> Version</div>
        <div className="metric-value mono">{run.version}</div>
        <div className="metric-foot">S3 output prefix</div>
      </div>
      <div className="metric">
        <div className="metric-label"><Icon.clock size={13} /> Duration</div>
        <div className="metric-value">{fmtDuration(run.duration)}</div>
        <div className="metric-foot">across {run.steps.length} steps</div>
      </div>
      <div className="metric">
        <div className="metric-label"><Icon.repeat size={13} /> Trigger</div>
        <div className="metric-value" style={{ fontSize: 18 }}>{run.triggeredManually ? 'Manual dispatch' : 'Scheduled'}</div>
        <div className="metric-foot">{run.startedAt ? fmtDateTime(run.startedAt) : 'weekly cadence'}</div>
      </div>
      <div className="metric">
        <div className="metric-label"><Icon.calendar size={13} /> Cadence</div>
        <div className="metric-value" style={{ fontSize: 18 }}>Weekly</div>
        <div className="metric-foot">Wed 02:00 · self-hosted/wed</div>
      </div>
    </div>
  );
}

function Flow({ run, onJump }) {
  return (
    <div className="flow">
      {run.phases.map((p) => {
        const st = p.status === 'partial' ? 'running' : p.status;
        const PI = Icon[p.icon] || Icon.box;
        return (
          <div className="flow-node" key={p.id}>
            <div className={`flow-card fc-${st}`} onClick={() => onJump(p.id)} title={p.plain}>
              <div className="flow-ico-row">
                <span className="flow-phase-ico"><PI size={17} /></span>
                <span className={`flow-stat fs-${st}`}>
                  {st === 'running'
                    ? <Spinner size={12} />
                    : <StatusGlyph status={st === 'pending' ? 'pending' : st} size={12} />}
                </span>
              </div>
              <div className="flow-name">{p.name}</div>
              <div className="flow-dur">{p.status === 'pending' ? 'queued' : p.status === 'running' ? 'running' : fmtDuration(p.dur)}</div>
            </div>
            <div className="flow-conn"><Icon.chevron size={18} /></div>
          </div>
        );
      })}
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

function PhaseGroup({ phase, openDefault, registerRef }) {
  const [open, setOpen] = useState(openDefault);
  const st = phase.status === 'partial' ? 'running' : phase.status;
  const PI = Icon[phase.icon] || Icon.box;
  return (
    <div className={`phase-group ${open ? 'open' : ''}`} ref={(el) => registerRef && registerRef(phase.id, el, setOpen)}>
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
    <div className="two-col">
      <div>
        <div className="subhead">Execution</div>
        <div className="detail-grid">
          <div className="detail-row">
            <span className="detail-ico"><Icon.bolt size={16} /></span>
            <div><div className="detail-k">Trigger</div><div className="detail-v">{run.triggeredManually ? 'Manual dispatch' : 'Scheduled (weekly)'}</div></div>
          </div>
          <div className="detail-row">
            <span className="detail-ico"><Icon.user size={16} /></span>
            <div><div className="detail-k">Actor</div><div className="detail-v">{run.actor || (run.triggeredManually ? 'j.okafor' : 'github-actions[bot]')}</div></div>
          </div>
          <div className="detail-row">
            <span className="detail-ico"><Icon.calendar size={16} /></span>
            <div><div className="detail-k">Started</div><div className="detail-v mono" style={{ fontSize: 13 }}>{run.startedAt ? fmtDateTime(run.startedAt) : '—'}</div></div>
          </div>
          <div className="detail-row">
            <span className="detail-ico"><Icon.clock size={16} /></span>
            <div><div className="detail-k">{run.state === 'running' ? 'Status' : 'Finished'}</div><div className="detail-v mono" style={{ fontSize: 13 }}>{run.finishedAt ? fmtDateTime(run.finishedAt) : 'running…'}</div></div>
          </div>
          <div className="detail-row full">
            <span className="detail-ico"><Icon.server size={16} /></span>
            <div><div className="detail-k">Runner</div><div className="detail-v"><span className="mono" style={{ fontSize: 12.5 }}>self-hosted · linux · wed</span> <span className="detail-v muted" style={{ display: 'inline' }}>· ap-southeast-1</span></div></div>
          </div>
          <div className="detail-row full">
            <span className="detail-ico"><Icon.repeat size={16} /></span>
            <div><div className="detail-k">Run options</div>
              <div className="detail-v" style={{ marginTop: 6 }}>
                <span className={`opt-pill ${run.options.run_mitchell ? 'on' : 'off'}`}>run_mitchell: {String(run.options.run_mitchell)}</span>
                <span className={`opt-pill ${run.options.skip_pull ? 'on' : 'off'}`}>skip_pull: {String(run.options.skip_pull)}</span>
              </div>
            </div>
          </div>
          {run.html_url && (
            <div className="detail-row full">
              <span className="detail-ico"><Icon.external size={16} /></span>
              <div><div className="detail-k">Workflow run</div>
                <div className="detail-v"><a href={run.html_url} target="_blank" rel="noreferrer" style={{ color: 'var(--blue-fg)', textDecoration: 'none' }}>View on GitHub ↗</a></div>
              </div>
            </div>
          )}
        </div>
      </div>
      <div>
        <div className="subhead">Outputs &amp; artifacts</div>
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
              <span className="artifact-go"><Icon.external size={15} /></span>
            </div>
            <div className="artifact">
              <span className="artifact-ico"><Icon.cloud size={17} /></span>
              <div className="artifact-main">
                <div className="artifact-name">s3://wed-archive-ap1/{run.version}</div>
                <div className="artifact-sub">clean_data_wide.dta + run_report.json · vintage backup</div>
              </div>
              <span className="artifact-go"><Icon.external size={15} /></span>
            </div>
            <div className="artifact">
              <span className="artifact-ico"><Icon.layers size={16} /></span>
              <div className="artifact-main">
                <div className="artifact-name">wed_staging · {run.version}</div>
                <div className="artifact-sub">release sealed · change events emitted</div>
              </div>
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
    </div>
  );
}

export default function RunView({ run }) {
  // Smooth-scroll + flash a phase group when its flow card is clicked.
  const refs = useState(() => ({}))[0];
  const registerRef = (id, el, setOpen) => { refs[id] = { el, setOpen }; };
  const jump = (id) => {
    const r = refs[id];
    if (!r || !r.el) return;
    r.setOpen(true);
    const y = r.el.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top: y, behavior: 'smooth' });
  };

  const hasPhases = (run.phases || []).length > 0;
  return (
    <>
      <RunHero run={run} />
      <RunMetrics run={run} />

      {hasPhases ? (
        <>
          <Section icon="layers" title="Pipeline flow" hint={`${run.phases.length} phases · click a phase to jump to its steps`}>
            <Flow run={run} onJump={jump} />
          </Section>

          <Section icon="clock" title="Where the time goes" hint="the Stata build dominates total runtime">
            <Gantt run={run} />
          </Section>

          <Section icon="cpu" title="Steps &amp; logs" hint="grouped by phase · expand for detail">
            {run.phases.map((p) => (
              <PhaseGroup key={p.id} phase={p}
                openDefault={p.status === 'failed' || p.status === 'running'}
                registerRef={registerRef} />
            ))}
          </Section>
        </>
      ) : (
        // Real run whose per-step telemetry hasn't arrived yet (early in-progress,
        // or only the workflow_run event seen so far).
        <Section icon="cpu" title="Pipeline steps" hint="awaiting per-step telemetry">
          <div className="state-line"><Icon.repeat size={15} /> Per-step status will appear as the workflow_job events arrive.</div>
        </Section>
      )}

      <Section icon="file" title="Run details" hint={run.representative ? 'representative' : (run.run_id ? `run ${run.run_id}` : '')}>
        <RunDetails run={run} />
      </Section>
    </>
  );
}
