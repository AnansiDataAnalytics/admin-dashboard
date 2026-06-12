// app.jsx — WED Pipeline status dashboard

const { useState, useEffect, useRef, useCallback } = React;
const I = window.Icon;
const { WED_PHASES, WED_NEXT_RUN, buildHistory, fmtDuration, fmtDurationLong,
        relativeTime, fmtDate, WED_NOW } = window;

/* ---------------- Status badge ---------------- */
function StatusBadge({ status, label }) {
  const map = {
    passed: ["s-passed", "Succeeded"],
    failed: ["s-failed", "Failed"],
    running: ["s-running", "Running"],
    pending: ["s-pending", "Queued"],
    skipped: ["s-skipped", "Skipped"],
    partial: ["s-partial", "Partial"],
  };
  const [cls, txt] = map[status] || map.pending;
  return (
    <span className={`sbadge ${cls}`}>
      <span className={`gl ${status === "running" ? "pulse" : ""}`}>
        <window.StatusGlyph status={status} size={13} />
      </span>
      {label || txt}
    </span>
  );
}

/* ---------------- Run picker ---------------- */
function RunPicker({ runs, selected, onSelect }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const run = runs[selected];
  return (
    <div className={`runpick ${open ? "open" : ""}`} ref={ref}>
      <button className="runpick-btn" onClick={() => setOpen((o) => !o)}>
        <window.StatusGlyph status={run.state === "running" ? "running" : run.state === "failure" ? "failed" : "passed"} size={14} />
        <div style={{ textAlign: "left", lineHeight: 1.2 }}>
          <div className="rp-num mono">#{run.number} · {run.version}</div>
          <div className="rp-meta">{selected === 0 ? "Latest run" : relativeTime(run.startedAt)}</div>
        </div>
        <span className="runpick-chevy"><I.chevron size={15} /></span>
      </button>
      {open && (
        <div className="runpick-menu">
          <div className="runpick-head"><span>Run history</span><span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>weekly · Wed 02:00</span></div>
          <div className="runpick-list">
            {runs.map((r, i) => {
              const st = r.state === "running" ? "running" : r.state === "failure" ? "failed" : "passed";
              return (
                <button key={i} className={`runrow ${i === selected ? "active" : ""}`}
                        onClick={() => { onSelect(i); setOpen(false); }}>
                  <span className={`flow-stat fs-${st}`} style={{ width: 20, height: 20 }}>
                    <window.StatusGlyph status={st} size={12} />
                  </span>
                  <div className="runrow-main">
                    <span className="runrow-v">{r.version} {i === 0 && <span style={{ color: "var(--text-3)", fontWeight: 500 }}>· latest</span>}</span>
                    <span className="runrow-d">{fmtDate(r.startedAt)}</span>
                  </div>
                  <div className="runrow-r">
                    <div className="runrow-num">#{r.number}</div>
                    <div className="runrow-dur">{r.state === "running" ? "running" : fmtDuration(r.duration)}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Hero ---------------- */
function Hero({ run, nowTick }) {
  const st = run.state;
  const completed = run.phases.filter((p) => p.status === "passed").length;
  const total = run.phases.length;
  const pct = Math.round((completed / total) * 100);
  let icon, title, sub, sCls;
  if (st === "running") {
    sCls = "running"; icon = <span className="pulse"><I.repeat size={26} /></span>;
    title = "Build in progress";
    const elapsed = Math.floor((nowTick - run.startedAt) / 1000);
    sub = (<>Building <b className="mono">{run.version}</b> · running the Stata master pipeline · <b className="mono">{fmtDurationLong(elapsed)}</b> elapsed</>);
  } else if (st === "failure") {
    sCls = "failed"; icon = <I.x size={28} sw={2.4} />;
    title = "Latest build failed";
    sub = (<>Version <b className="mono">{run.version}</b> was <b>not published</b> — the log-parse gate caught a Stata error · failed <b>{relativeTime(run.finishedAt)}</b> · ran {fmtDuration(run.duration)}</>);
  } else {
    sCls = "passed"; icon = <I.check size={28} sw={2.4} />;
    title = "Latest build succeeded";
    sub = (<>Version <b className="mono">{run.version}</b> published to <b className="mono">gmd-wed-output</b> · finished <b>{relativeTime(run.finishedAt)}</b> · ran {fmtDuration(run.duration)}</>);
  }
  return (
    <div className={`hero h-${sCls}`}>
      <div className="hero-top">
        <div className={`hero-icon hi-${sCls}`}>{icon}</div>
        <div>
          <div className="hero-headline">{title}</div>
          <div className="hero-sub">{sub}</div>
        </div>
        <div className="hero-spacer" />
        <div className="hero-right">
          <StatusBadge status={st === "running" ? "running" : st === "failure" ? "failed" : "passed"} />
          {st === "running" ? (
            <div className="nextrun"><I.bolt size={14} /> running now</div>
          ) : (
            <div className="nextrun"><I.calendar size={14} /> Next run <span className="mono">{relativeTime(WED_NEXT_RUN)}</span></div>
          )}
        </div>
      </div>
      {st === "running" && (
        <div className="hero-progress">
          <div className="progbar"><div className="progfill" style={{ width: `${Math.max(8, pct)}%` }} /></div>
          <div className="proglabel"><span>{completed} of {total} phases complete</span><span>Stata pipeline · clean stage</span></div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Metric cards ---------------- */
function Metrics({ run, nowTick }) {
  const trig = run.triggeredManually ? "Manual dispatch" : "Scheduled";
  const elapsed = run.state === "running" ? Math.floor((nowTick - run.startedAt) / 1000) : run.duration;
  return (
    <div className="metrics">
      <div className="metric">
        <div className="metric-label"><I.tag size={13} /> Version</div>
        <div className="metric-value mono">{run.version}</div>
        <div className="metric-foot">S3 output prefix</div>
      </div>
      <div className="metric">
        <div className="metric-label"><I.clock size={13} /> {run.state === "running" ? "Elapsed" : "Duration"}</div>
        <div className="metric-value">{fmtDuration(elapsed)}</div>
        <div className="metric-foot">across {run.steps.length} steps</div>
      </div>
      <div className="metric">
        <div className="metric-label">{run.triggeredManually ? <I.hand size={13} /> : <I.repeat size={13} />} Trigger</div>
        <div className="metric-value" style={{ fontSize: 18 }}>{trig}</div>
        <div className="metric-foot">{fmtDate(run.startedAt)}</div>
      </div>
      <div className="metric">
        <div className="metric-label"><I.calendar size={13} /> Next run</div>
        <div className="metric-value" style={{ fontSize: 18 }}>{relativeTime(WED_NEXT_RUN)}</div>
        <div className="metric-foot">{fmtDate(WED_NEXT_RUN)}</div>
      </div>
    </div>
  );
}

/* ---------------- Flow diagram ---------------- */
function Flow({ run, onJump }) {
  return (
    <div className="flow">
      {run.phases.map((p) => {
        const st = p.status === "partial" ? "running" : p.status;
        const Ico = I[p.icon] || I.box;
        return (
          <div className="flow-node" key={p.id}>
            <div className={`flow-card fc-${st}`} onClick={() => onJump(p.id)} title={p.plain}>
              <div className="flow-ico-row">
                <span className="flow-phase-ico"><Ico size={17} /></span>
                <span className={`flow-stat fs-${st} ${st === "running" ? "pulse" : ""}`}>
                  <window.StatusGlyph status={st === "pending" ? "pending" : st} size={12} />
                </span>
              </div>
              <div className="flow-name">{p.name}</div>
              <div className="flow-dur">{p.status === "pending" ? "queued" : p.status === "running" ? "running" : fmtDuration(p.dur)}</div>
            </div>
            <div className="flow-conn"><I.chevron size={18} /></div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Duration timeline ---------------- */
function Gantt({ run, nowTick }) {
  const total = run.state === "running"
    ? Math.max(run.duration, Math.floor((nowTick - run.startedAt) / 1000))
    : run.duration || 1;
  let cursor = 0;
  return (
    <div>
      <div className="gantt">
        {run.phases.map((p) => {
          const start = cursor; cursor += p.dur;
          const st = p.status === "partial" ? "running" : (p.status === "pending" ? "skipped" : p.status);
          const left = (start / total) * 100;
          const width = (p.dur / total) * 100;
          const Ico = I[p.icon] || I.box;
          return (
            <div className="gantt-row" key={p.id}>
              <div className="gantt-label"><Ico size={13} /> {p.name}</div>
              <div className="gantt-track">
                {p.dur > 0 && <div className={`gantt-bar gb-${st}`} style={{ left: `${left}%`, width: `${Math.max(width, 0.6)}%` }} />}
              </div>
              <div className="gantt-dur">{p.dur > 0 ? fmtDuration(p.dur) : "—"}</div>
            </div>
          );
        })}
      </div>
      <div className="gantt-axis"><span>00:00</span><span>start → finish · total {fmtDuration(run.duration)}</span><span>{fmtDuration(total)}</span></div>
    </div>
  );
}

/* ---------------- Step row ---------------- */
function StepRow({ s }) {
  const dim = s.status === "skipped" || s.status === "pending";
  return (
    <div className="step">
      <span className={`step-stat ss-${s.status} ${s.status === "running" ? "pulse" : ""}`}>
        {s.status !== "skipped" && s.status !== "pending" && <window.StatusGlyph status={s.status} size={11} />}
      </span>
      <div className="step-main">
        <div className={`step-name ${dim ? "dim" : ""}`}>
          {s.name}
          {s.uses && <span className="chip">{s.uses}</span>}
          {s.condition && <span className="chip cond">{s.condition}</span>}
          {s.status === "skipped" && <span className="chip">skipped</span>}
          {s.status === "running" && <span className="chip" style={{ color: "var(--blue-fg)", borderColor: "var(--blue-line)", background: "var(--blue-bg)" }}>in progress</span>}
        </div>
        {s.note && <div className="step-note">{s.note}</div>}
        {s.log && s.status !== "skipped" && s.status !== "pending" && (
          <div className={`step-log ${s.status === "failed" ? "err" : ""}`}>
            <span className="lg-mark">{s.status === "failed" ? <I.x size={12} /> : "›"}</span>{s.log}
          </div>
        )}
      </div>
      <div className="step-dur">{s.status === "running" ? "running" : s.status === "skipped" || s.status === "pending" ? "—" : fmtDuration(s.dur)}</div>
    </div>
  );
}

/* ---------------- Phase group (expandable) ---------------- */
function PhaseGroup({ phase, openDefault, registerRef }) {
  const [open, setOpen] = useState(openDefault);
  const wrapRef = useRef(null);
  const innerRef = useRef(null);
  const [h, setH] = useState(openDefault ? "auto" : 0);
  useEffect(() => {
    if (open) {
      const target = innerRef.current.scrollHeight;
      setH(target);
      const t = setTimeout(() => setH("auto"), 240);
      return () => clearTimeout(t);
    } else {
      setH(innerRef.current.scrollHeight);
      requestAnimationFrame(() => requestAnimationFrame(() => setH(0)));
    }
  }, [open]);
  const st = phase.status === "partial" ? "running" : phase.status;
  const Ico = I[phase.icon] || I.box;
  return (
    <div className={`phase-group ${open ? "open" : ""}`} ref={(el) => registerRef(phase.id, el, setOpen)}>
      <button className="phase-head" onClick={() => setOpen((o) => !o)}>
        <span className="phase-chev"><I.chevron size={15} /></span>
        <span className={`phase-stat fs-${st === "pending" ? "pending" : st} ${st === "running" ? "pulse" : ""}`}>
          {st !== "pending" && st !== "skipped" && <window.StatusGlyph status={st} size={13} />}
          {(st === "pending" || st === "skipped") && <Ico size={13} />}
        </span>
        <span className="phase-info">
          <span className="phase-title">{phase.name}</span>
          <span className="phase-plain">{phase.plain}</span>
        </span>
        <span className="phase-meta">{`${phase.steps.length} ${phase.steps.length > 1 ? "steps" : "step"}`}</span>
        <span className="phase-dur">{phase.status === "pending" ? "queued" : phase.status === "running" ? "running" : fmtDuration(phase.dur)}</span>
      </button>
      <div className="steps-wrap" ref={wrapRef} style={{ height: h }}>
        <div className="step-list" ref={innerRef}>
          {phase.steps.map((s, i) => <StepRow key={i} s={s} />)}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Raw (ungrouped) step list ---------------- */
function RawSteps({ run }) {
  return (
    <div className="phase-group open" style={{ marginBottom: 0 }}>
      <div className="step-list" style={{ borderTop: "none" }}>
        {run.steps.map((s, i) => <StepRow key={i} s={s} />)}
      </div>
    </div>
  );
}

/* ---------------- Run details ---------------- */
function RunDetails({ run }) {
  const failed = run.state === "failure";
  return (
    <div className="two-col">
      <div>
        <div className="subhead">Execution</div>
        <div className="detail-grid">
          <div className="detail-row">
            <span className="detail-ico"><I.bolt size={16} /></span>
            <div><div className="detail-k">Trigger</div><div className="detail-v">{run.triggeredManually ? "Manual dispatch" : "Scheduled (weekly)"}</div></div>
          </div>
          <div className="detail-row">
            <span className="detail-ico"><I.user size={16} /></span>
            <div><div className="detail-k">Actor</div><div className="detail-v">{run.triggeredManually ? "j.okafor" : "github-actions[bot]"}</div></div>
          </div>
          <div className="detail-row">
            <span className="detail-ico"><I.calendar size={16} /></span>
            <div><div className="detail-k">Started</div><div className="detail-v mono" style={{ fontSize: 13 }}>{fmtDate(run.startedAt)}</div></div>
          </div>
          <div className="detail-row">
            <span className="detail-ico"><I.clock size={16} /></span>
            <div><div className="detail-k">{run.state === "running" ? "Status" : "Finished"}</div><div className="detail-v mono" style={{ fontSize: 13 }}>{run.finishedAt ? fmtDate(run.finishedAt) : "running…"}</div></div>
          </div>
          <div className="detail-row full">
            <span className="detail-ico"><I.server size={16} /></span>
            <div><div className="detail-k">Runner</div><div className="detail-v"><span className="mono" style={{ fontSize: 12.5 }}>self-hosted · linux · wed</span> <span className="detail-v muted" style={{ display: "inline" }}>· ap-southeast-2</span></div></div>
          </div>
          <div className="detail-row full">
            <span className="detail-ico"><I.repeat size={16} /></span>
            <div><div className="detail-k">Run options</div>
              <div className="detail-v" style={{ marginTop: 6 }}>
                <span className={`opt-pill ${run.options.run_mitchell ? "on" : "off"}`}>run_mitchell: {String(run.options.run_mitchell)}</span>
                <span className={`opt-pill ${run.options.skip_pull ? "on" : "off"}`}>skip_pull: {String(run.options.skip_pull)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div>
        <div className="subhead">Outputs &amp; artifacts</div>
        {failed ? (
          <div className="artifact" style={{ borderColor: "var(--red-line)", background: "var(--red-bg)" }}>
            <span className="artifact-ico" style={{ color: "var(--red-fg)" }}><I.x size={16} /></span>
            <div className="artifact-main">
              <div className="artifact-name" style={{ color: "var(--red-fg)" }}>No data published</div>
              <div className="artifact-sub">Push to gmd-wed-output was skipped — build gate failed</div>
            </div>
          </div>
        ) : (
          <>
            <div className="artifact">
              <span className="artifact-ico"><I.cloud size={17} /></span>
              <div className="artifact-main">
                <div className="artifact-name">s3://gmd-wed-output/{run.version}/clean</div>
                <div className="artifact-sub">{run.state === "running" ? "pending publish" : "842 objects · cleaned datasets"}</div>
              </div>
              <span className="artifact-go"><I.external size={15} /></span>
            </div>
            <div className="artifact">
              <span className="artifact-ico"><I.cloud size={17} /></span>
              <div className="artifact-main">
                <div className="artifact-name">s3://gmd-wed-output/{run.version}/final</div>
                <div className="artifact-sub">{run.state === "running" ? "pending publish" : "1.4 GiB · final WED release"}</div>
              </div>
              <span className="artifact-go"><I.external size={15} /></span>
            </div>
          </>
        )}
        <div className="artifact">
          <span className="artifact-ico"><I.file size={16} /></span>
          <div className="artifact-main">
            <div className="artifact-name">wed-logs-{run.version}</div>
            <div className="artifact-sub">{run.state === "running" ? "uploaded at job end" : "64.2 MiB · *.log + build_log_report.json · 30-day retention"}</div>
          </div>
          <span className="artifact-go"><I.external size={15} /></span>
        </div>
        <div style={{ marginTop: 14 }} className="subhead">Data flow</div>
        <div className="artifact" style={{ background: "var(--surface)", flexDirection: "column", alignItems: "stretch", gap: 9 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", flexWrap: "wrap", gap: 6 }}>
            <span className="mono" style={{ fontSize: 11.5 }}>gmd-wed-data</span>
            <I.arrowRight size={15} />
            <span>download</span><I.arrowRight size={14} /><span>clean</span><I.arrowRight size={14} /><span>combine</span>
            <I.arrowRight size={15} />
            <span className="mono" style={{ fontSize: 11.5 }}>gmd-wed-output</span>
          </div>
        </div>
      </div>
    </div>
  );
}

window.WEDComponents = { StatusBadge, RunPicker, Hero, Metrics, Flow, Gantt, PhaseGroup, RawSteps, RunDetails };
