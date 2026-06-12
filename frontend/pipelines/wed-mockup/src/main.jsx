// main.jsx — App shell, tweaks wiring, live ticker.
const { useState: uS, useEffect: uE, useRef: uR } = React;
const C = window.WEDComponents;
const II = window.Icon;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "scenario": "success",
  "grouping": "grouped"
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  const [selected, setSelected] = uS(0);
  const [nowTick, setNowTick] = uS(window.WED_NOW);
  const phaseRefs = uR({});

  // theme is owned by the global nav toggle (admin/theme.js → <html data-theme>)

  // rebuild history whenever scenario changes (scenario overrides latest run)
  const runs = React.useMemo(() => window.buildHistory(
    t.scenario === "success" ? null : (t.scenario === "failure" ? "failure" : "running")
  ), [t.scenario]);

  // when scenario changes, snap back to latest so the change is visible
  uE(() => { setSelected(0); }, [t.scenario]);

  const run = runs[Math.min(selected, runs.length - 1)];

  // live ticker for running scenario (elapsed timer + striped bars)
  uE(() => {
    if (run.state !== "running") { setNowTick(window.WED_NOW); return; }
    const base = run.startedAt + 47 * 60 * 1000; // ~47 min in
    setNowTick(base);
    const id = setInterval(() => setNowTick((n) => n + 1000), 1000);
    return () => clearInterval(id);
  }, [run.state, run.startedAt]);

  const registerRef = (id, el, setOpen) => { phaseRefs.current[id] = { el, setOpen }; };
  const jumpToPhase = (id) => {
    const r = phaseRefs.current[id];
    if (r) {
      r.setOpen(true);
      const y = r.el.getBoundingClientRect().top + window.scrollY - 90;
      window.scrollTo({ top: y, behavior: "smooth" });
      r.el.animate(
        [{ boxShadow: "0 0 0 0 var(--blue)" }, { boxShadow: "0 0 0 3px color-mix(in srgb, var(--blue) 40%, transparent)" }, { boxShadow: "0 0 0 0 transparent" }],
        { duration: 1100, easing: "ease-out" }
      );
    }
  };

  return (
    <div className="shell">
      <div className="crumb">
        <a href="Pipelines.html">Pipelines</a>
        <span className="sep">/</span>
        <span className="here">World Economic Database</span>
      </div>
      {/* top bar */}
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">WED</div>
          <div>
            <div className="brand-title">WED Pipeline</div>
            <div className="brand-sub">World Economic Database · cloud build</div>
          </div>
        </div>
        <C.RunPicker runs={runs} selected={selected} onSelect={setSelected} />
      </div>

      <C.Hero run={run} nowTick={nowTick} />
      <C.Metrics run={run} nowTick={nowTick} />

      {/* pipeline flow */}
      <div className="card">
        <div className="card-head">
          <div className="card-title"><span className="ct-ico"><II.layers size={16} /></span> Pipeline flow</div>
          <div className="card-hint">7 phases · click a phase to jump to its steps</div>
        </div>
        <div className="card-body"><C.Flow run={run} onJump={jumpToPhase} /></div>
      </div>

      {/* duration timeline */}
      <div className="card">
        <div className="card-head">
          <div className="card-title"><span className="ct-ico"><II.clock size={16} /></span> Where the time goes</div>
          <div className="card-hint">the Stata build dominates total runtime</div>
        </div>
        <div className="card-body"><C.Gantt run={run} nowTick={nowTick} /></div>
      </div>

      {/* steps */}
      <div className="card">
        <div className="card-head">
          <div className="card-title"><span className="ct-ico"><II.cpu size={16} /></span> Steps &amp; logs</div>
          <div className="card-hint">{t.grouping === "grouped" ? "grouped by phase · expand for detail" : "raw workflow order · all steps"}</div>
        </div>
        <div className="card-body">
          {t.grouping === "grouped"
            ? run.phases.map((p) => (
                <C.PhaseGroup key={p.id} phase={p}
                  openDefault={p.status === "failed" || p.status === "running"}
                  registerRef={registerRef} />
              ))
            : <C.RawSteps run={run} />}
        </div>
      </div>

      {/* run details */}
      <div className="card">
        <div className="card-head">
          <div className="card-title"><span className="ct-ico"><II.file size={16} /></span> Run details</div>
          <div className="card-hint mono">#{run.number}</div>
        </div>
        <div className="card-body"><C.RunDetails run={run} /></div>
      </div>

      <div className="foot">
        WED Pipeline status · internal dashboard
        <span className="dot-sep" />
        data reflects run <span className="mono">#{run.number}</span>
        <span className="dot-sep" />
        <span>as of {window.relativeTime ? "5 Jun 2026" : ""}</span>
      </div>

      {/* Tweaks */}
      <window.TweaksPanel>
        <window.TweakSection label="Latest run state" />
        <window.TweakRadio label="Scenario" value={t.scenario}
          options={[{ value: "success", label: "Success" }, { value: "failure", label: "Failure" }, { value: "running", label: "Running" }]}
          onChange={(v) => setTweak("scenario", v)} />
        <window.TweakSection label="Steps" />
        <window.TweakRadio label="Step display" value={t.grouping}
          options={[{ value: "grouped", label: "Phases" }, { value: "raw", label: "Raw steps" }]}
          onChange={(v) => setTweak("grouping", v)} />
      </window.TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
