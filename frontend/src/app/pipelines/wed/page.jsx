'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Icon, StatusGlyph } from '@/components/Icon';
import RunView from '@/components/wed/RunView';
import SourceHealth from '@/components/wed/SourceHealth';
import ChangeExplorer, { ValueTransition, Delta } from '@/components/wed/ChangeExplorer';
import { buildRepresentativeRun, runFromApi } from '@/lib/pipelineModel';
import { fmtNum, fmtPct, isoDate, stateOf } from '@/lib/format';

export default function WedPage() {
  const [summary, setSummary] = useState(null);
  const [releases, setReleases] = useState(null);
  const [runs, setRuns] = useState([]);
  const [err, setErr] = useState(null);

  const [version, setVersion] = useState(null);
  const [diff, setDiff] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [sources, setSources] = useState(null);
  const [srcFilter, setSrcFilter] = useState('');
  const [runDetail, setRunDetail] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Re-fetch the operational state (summary + ledger + runs). The webhook updates
  // the BACKEND, but the page must re-poll to see it — so this drives both the
  // manual Refresh button and the auto-poll below.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [s, r, ru] = await Promise.all([
        api.wedSummary(), api.wedReleases(), api.wedRuns().catch(() => []),
      ]);
      setSummary(s); setReleases(r); setRuns(Array.isArray(ru) ? ru : []);
      // Default the inspected release on first load only — never clobber a
      // release the user has explicitly selected.
      setVersion((v) => v ?? (r && r.length ? r[0].release_version : null));
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Latest operational run's detail (jobs + steps) for the run view.
  useEffect(() => {
    if (!runs.length) { setRunDetail(null); return; }
    let alive = true;
    api.wedRun(runs[0].run_id).then((d) => { if (alive) setRunDetail(d); }).catch(() => {});
    return () => { alive = false; };
  }, [runs]);

  useEffect(() => {
    if (!version) return;
    let alive = true;
    setDiffLoading(true);
    setSrcFilter('');
    api.wedDiff(version)
      .then((d) => { if (alive) setDiff(d); })
      .catch(() => { if (alive) setDiff(null); })
      .finally(() => { if (alive) setDiffLoading(false); });
    api.wedSources(version)
      .then((d) => { if (alive) setSources(d); })
      .catch(() => { if (alive) setSources(null); });
    return () => { alive = false; };
  }, [version]);

  // Drill from a source-breakdown row into the change explorer, filtered.
  const pickSource = (src) => {
    setSrcFilter((cur) => (cur === src ? '' : src));
    requestAnimationFrame(() => {
      const el = document.getElementById('change-explorer');
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 70, behavior: 'smooth' });
    });
  };

  const selected = releases?.find((r) => r.release_version === version) || null;
  const latest = summary?.latest || releases?.[0] || null;

  // Prefer the real operational run; fall back to a representative one anchored
  // to the latest release until live telemetry exists.
  const realRun = useMemo(() => runFromApi(runDetail), [runDetail]);
  const repRun = useMemo(
    () => buildRepresentativeRun({ version: latest?.release_version, knownFrom: latest?.known_from }),
    [latest?.release_version, latest?.known_from],
  );
  const run = realRun || repRun;

  // Auto-poll so a newly-started run AND its live progress appear without a
  // manual reload. Fast (5s) while a run is active; slow (20s) when idle, which
  // is enough to catch the next run starting. The runDetail effect above re-fires
  // off `runs`, so refreshing `runs` keeps the run view + source health live.
  useEffect(() => {
    const period = realRun?.state === 'running' ? 5000 : 20000;
    const id = setInterval(() => { refresh(); }, period);
    return () => clearInterval(id);
  }, [realRun?.state, refresh]);

  return (
    <div className="shell">
      <nav className="crumb">
        <Link href="/">Home</Link><span className="sep">/</span>
        <Link href="/pipelines">Pipelines</Link><span className="sep">/</span>
        <span className="here">World Economic Database</span>
      </nav>

      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">WED</div>
          <div>
            <div className="brand-title">WED Pipeline</div>
            <div className="brand-sub">World Economic Database · cloud build</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className={`refresh-btn ${refreshing ? 'spinning' : ''}`} onClick={() => refresh()}
                  disabled={refreshing} title="Refresh now">
            <span className="ri"><Icon.repeat size={14} /></span>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <div className="nextrun"><Icon.calendar size={14} /> weekly · <span className="mono">Wed 02:00</span></div>
        </div>
      </div>

      {/* ── Workflow run — front and center ── */}
      {!realRun && (
        <div className="preview-banner">
          <span className="pb-ico"><Icon.bolt size={16} /></span>
          <div className="pb-text">
            <b>Representative run.</b> No live GitHub Actions run has reported yet, so the hero, flow, timeline and run
            details below show the shape of a completed weekly build (anchored to the current release). They bind to
            real per-job status &amp; timings the moment a run fires — the webhook + heartbeat endpoints are ready. The
            <b> release data &amp; change tracking</b> further down is <b>live</b>.
          </div>
        </div>
      )}

      <RunView run={run} />

      <Card icon="server" title="Source health"
            hint="per-source execution · finer than GH jobs &amp; steps">
        <SourceHealth live={realRun?.state === 'running'} />
      </Card>

      {/* ── Live release data & change tracking ── */}
      <div className="rsplit">
        <div className="rsplit-line" />
        <div className="rsplit-label"><span className="live-dot" /> Release data &amp; change tracking · live</div>
        <div className="rsplit-line" />
      </div>

      {err && (
        <div className="state-line err">
          <Icon.alert size={16} /> Backend unreachable: {err}
          <span className="state-hint" style={{ marginLeft: 8 }}>Is the backend running with <span className="mono">MONGODB_URI</span> → <span className="mono">wed_staging</span>?</span>
        </div>
      )}
      {!err && !releases && <div className="state-line"><Icon.repeat size={16} /> Loading release ledger…</div>}
      {!err && releases && releases.length === 0 && (
        <div className="state-line"><Icon.box size={16} /> No releases in this database yet.</div>
      )}

      {!err && selected && (
        <>
          <div className="topbar" style={{ marginBottom: 14 }}>
            <div className="brand-sub" style={{ fontSize: 13 }}>
              Inspecting release <b className="mono" style={{ color: 'var(--text)' }}>{version}</b>
              {selected.from_release ? <> · diff vs <span className="mono">{selected.from_release}</span></> : <> · baseline</>}
              {summary ? <> · {summary.total_releases} tracked</> : null}
            </div>
            <ReleasePicker releases={releases} value={version} onChange={setVersion} />
          </div>

          <Card icon="layers" title="Release ledger" hint={`${releases.length} releases · newest first · click to inspect`}>
            <LedgerTable releases={releases} value={version} onSelect={setVersion} />
          </Card>

          <Card icon="diff" title={`What changed in ${version}`}
                hint={selected.from_release ? `diff vs ${selected.from_release}` : 'baseline load'}>
            <DiffPanel release={selected} diff={diff} loading={diffLoading} />
          </Card>

          <Card icon="server" title="Source breakdown"
                hint={selected.from_release ? 'which upstream sources moved · click to drill in' : 'baseline load'}>
            <SourceBreakdown release={selected} data={sources} active={srcFilter} onPick={pickSource} />
          </Card>

          <div id="change-explorer">
            <Card icon="search" title="Change explorer"
                  hint={srcFilter ? `filtered to ${srcFilter} · click again to clear` : 'every typed change event · filter &amp; page'}>
              <ChangeExplorer version={version} source={srcFilter} onSource={setSrcFilter}
                              sources={(sources?.sources || []).map((s) => s.source)} />
            </Card>
          </div>
        </>
      )}

      <div className="foot">
        WED Pipeline · internal dashboard
        <span className="dot-sep" />
        release <span className="mono">{version || '—'}</span>
        <span className="dot-sep" />
        source <span className="mono">{releases ? 'wed_staging' : '—'}</span>
      </div>
    </div>
  );
}

/* ─────────────────────────── release picker ───────────────────────── */
function ReleasePicker({ releases, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const cur = releases.find((r) => r.release_version === value) || releases[0];
  const curState = stateOf(cur.status);
  return (
    <div className={`runpick ${open ? 'open' : ''}`} ref={ref}>
      <button className="runpick-btn" onClick={() => setOpen((o) => !o)}>
        <span className={`flow-stat fs-${curState}`} style={{ width: 22, height: 22 }}><StatusGlyph status={curState} size={13} /></span>
        <div style={{ textAlign: 'left', lineHeight: 1.2 }}>
          <div className="rp-num">{cur.release_version}</div>
          <div className="rp-meta">{isoDate(cur.known_from)}</div>
        </div>
        <span className="runpick-chevy"><Icon.chevron size={15} /></span>
      </button>
      {open && (
        <div className="runpick-menu">
          <div className="runpick-head">
            <span>Release ledger</span>
            <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>{releases.length} releases</span>
          </div>
          <div className="runpick-list">
            {releases.map((r) => {
              const st = stateOf(r.status);
              const h = r.change_summary?.counts?.harmonized || {};
              const active = r.release_version === value;
              return (
                <button key={r.release_version} className={`runrow ${active ? 'active' : ''}`}
                        onClick={() => { onChange(r.release_version); setOpen(false); }}>
                  <span className={`flow-stat fs-${st}`} style={{ width: 20, height: 20 }}><StatusGlyph status={st} size={12} /></span>
                  <div className="runrow-main">
                    <span className="runrow-v">{r.release_version}{r === releases[0] && <span style={{ color: 'var(--text-3)', fontWeight: 500 }}> · latest</span>}</span>
                    <span className="runrow-d">{isoDate(r.known_from)}</span>
                  </div>
                  <div className="runrow-r">
                    <div className="runrow-num">{r.from_release ? `vs ${r.from_release}` : 'baseline'}</div>
                    <div className="runrow-dur">{r.from_release ? `${fmtNum(h.revision || 0)} rev` : `${fmtNum(r.change_summary?.points_seen || 0)} cells`}</div>
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

/* ─────────────────────────── ledger table ─────────────────────────── */
function LedgerTable({ releases, value, onSelect }) {
  return (
    <div className="dtable-wrap">
      <table className="dtable">
        <thead>
          <tr>
            <th>Version</th><th>Known from</th><th>Status</th><th>From</th>
            <th className="num">Cells</th><th className="num">Inserts</th>
            <th className="num">Revisions</th><th className="num">Disc.</th><th className="num">Src rev</th>
          </tr>
        </thead>
        <tbody>
          {releases.map((r) => {
            const h = r.change_summary?.counts?.harmonized || {};
            const src = r.change_summary?.counts?.source || {};
            const active = r.release_version === value;
            return (
              <tr key={r.release_version} className={`row-click${active ? ' active' : ''}`} onClick={() => onSelect(r.release_version)}>
                <td className="mono">{r.release_version}</td>
                <td>{isoDate(r.known_from)}</td>
                <td><span className={`pill pill-${r.status}`}>{r.status}</span></td>
                <td className="mono muted">{r.from_release || '—'}</td>
                <td className="num">{fmtNum(r.change_summary?.points_seen)}</td>
                <td className="num">{r.from_release ? fmtNum(h.insert) : '—'}</td>
                <td className="num">{r.from_release ? fmtNum(h.revision) : '—'}</td>
                <td className="num">{r.from_release ? fmtNum(h.discontinuation) : '—'}</td>
                <td className="num">{r.from_release ? fmtNum(src.revision) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────────────────────── diff panel ─────────────────────────── */
// Advisory gate computed client-side from the same thresholds the importer uses
// (change_events.DEFAULT_THRESHOLDS). The persisted summary doesn't store the
// verdict, so we recompute it for display. Phase 9 will enforce server-side.
const GATE = { revised: 10, oom: 3, dropped: 5 };
function evalGate(cs) {
  if (!cs) return null;
  const breaches = [];
  if (cs.revised_pct > GATE.revised) breaches.push(`revised ${cs.revised_pct.toFixed(2)}% > ${GATE.revised}%`);
  if (cs.max_abs_log10_ratio >= GATE.oom) breaches.push(`max |log10 Δ| ${cs.max_abs_log10_ratio.toFixed(2)} ≥ ${GATE.oom} (orders of magnitude)`);
  if (cs.dropped_pct > GATE.dropped) breaches.push(`dropped ${cs.dropped_pct.toFixed(2)}% > ${GATE.dropped}%`);
  return { status: breaches.length ? 'breach' : 'pass', breaches };
}

function DiffPanel({ release, diff, loading }) {
  if (!release.from_release) {
    return <div className="state-line"><Icon.box size={15} /> Baseline load — every cell is an insert; there is no prior release to diff against.</div>;
  }
  if (loading && !diff) return <div className="state-line"><Icon.repeat size={15} /> Loading diff…</div>;
  const cs = diff?.summary || release.change_summary;
  if (!cs) return <div className="state-line"><Icon.alert size={15} /> No change summary available for this release.</div>;
  const h = cs.counts?.harmonized || {};
  const src = cs.counts?.source || {};
  const gate = evalGate(cs);
  const tops = diff?.top_revisions || [];

  return (
    <div>
      {gate && (
        <div className={`gate gate-${gate.status}`}>
          <span className="gate-ico">{gate.status === 'breach' ? <Icon.alert size={18} /> : <Icon.shield size={18} />}</span>
          <div className="gate-main">
            <div className="gate-title">Validation gate: {gate.status === 'breach' ? 'breach (advisory)' : 'pass'}</div>
            {gate.breaches.length > 0 && (
              <ul className="gate-list">{gate.breaches.map((b, i) => <li key={i}>{b}</li>)}</ul>
            )}
            <div className="gate-note">
              Advisory only — these are legitimate large historical revisions over multi-week vintage gaps.
              The Phase&nbsp;9 promotion gate will enforce thresholds server-side.
            </div>
          </div>
        </div>
      )}

      <div className="diffstrip">
        <div className="diffstat is-insert"><div className="dk">Inserts</div><div className="dv">{fmtNum(h.insert)}</div><div className="ds">new cells</div></div>
        <div className="diffstat is-revision"><div className="dk">Revisions</div><div className="dv">{fmtNum(h.revision)}</div><div className="ds">{fmtPct(cs.revised_pct)} of cells</div></div>
        <div className="diffstat is-disc"><div className="dk">Discontinued</div><div className="dv">{fmtNum(h.discontinuation)}</div><div className="ds">{fmtPct(cs.dropped_pct)} of cells</div></div>
        <div className="diffstat"><div className="dk">Source changes</div><div className="dv">{fmtNum(h.source_change)}</div><div className="ds">selected-source moves</div></div>
      </div>

      <div className="subhead">Largest harmonized revisions</div>
      {tops.length === 0 ? (
        <div className="state-line"><Icon.diff size={15} /> No harmonized revisions in this release.</div>
      ) : (
        <div className="dtable-wrap">
          <table className="dtable">
            <thead><tr><th>Series</th><th>Date</th><th>Change</th><th className="num">Δ</th></tr></thead>
            <tbody>
              {tops.map((e, i) => (
                <tr key={i}>
                  <td className="mono">{e.series_code}</td>
                  <td className="mono muted">{isoDate(e.date)}</td>
                  <td><ValueTransition type="revision" oldV={e.old_value} newV={e.new_value} /></td>
                  <td className="num"><Delta pct={e.pct_change} oom={e.log10_ratio} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="state-hint" style={{ marginTop: 12 }}>
        Per-source this release: {fmtNum(src.insert)} inserts · {fmtNum(src.revision)} revisions · {fmtNum(src.discontinuation)} discontinuations.
      </div>
    </div>
  );
}

/* ─────────────────────────── source breakdown ─────────────────────────── */
// Phase 4/7 multi-source tracking, release-level: which upstream source columns
// (IMF_IFS, EUS, OECD_EO, WDI, …) drove this release's changes. Each row is a
// stacked bar (revisions / inserts / discontinuations) scaled to the busiest
// source; click to drill the change explorer down to that source's events.
function SourceBreakdown({ release, data, active, onPick }) {
  if (!release.from_release) {
    return <div className="state-line"><Icon.box size={15} /> Baseline load — per-source change events begin from the first diff (v2 onward).</div>;
  }
  if (!data) return <div className="state-line"><Icon.repeat size={15} /> Loading source breakdown…</div>;
  const rows = data.sources || [];
  if (rows.length === 0) return <div className="state-line"><Icon.server size={15} /> No per-source change events in this release.</div>;
  const max = rows[0].total || 1;
  const t = data.totals || {};

  return (
    <div>
      <div className="state-hint" style={{ marginBottom: 14 }}>
        {rows.length} sources moved this release — {fmtNum(t.revision)} revisions · {fmtNum(t.insert)} inserts · {fmtNum(t.discontinuation)} discontinuations across the per-source maps.
      </div>
      <div className="srclegend">
        <span className="lg"><span className="sw sw-rev" /> revisions</span>
        <span className="lg"><span className="sw sw-ins" /> inserts</span>
        <span className="lg"><span className="sw sw-disc" /> discontinuations</span>
      </div>
      <div className="srcbreak">
        {rows.map((s) => {
          const revW = (s.revision / max) * 100;
          const insW = (s.insert / max) * 100;
          const discW = (s.discontinuation / max) * 100;
          return (
            <button key={s.source} className={`srcrow${active === s.source ? ' active' : ''}`}
                    onClick={() => onPick(s.source)} title={`Drill into ${s.source} change events`}>
              <span className="srcrow-name"><Icon.server size={13} /> {s.source}</span>
              <span className="srcrow-bar">
                <span className="seg seg-rev" style={{ left: 0, width: `${revW}%` }} />
                <span className="seg seg-ins" style={{ left: `${revW}%`, width: `${insW}%` }} />
                <span className="seg seg-disc" style={{ left: `${revW + insW}%`, width: `${discW}%` }} />
              </span>
              <span className="srcrow-counts">
                <b>{fmtNum(s.revision)}</b> rev<span className="sep">·</span>
                <b>{fmtNum(s.insert)}</b> ins<span className="sep">·</span>
                <b>{fmtNum(s.discontinuation)}</b> disc
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────── card shell ─────────────────────────── */
function Card({ icon, title, hint, children }) {
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
