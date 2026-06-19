'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, streamUrl } from '@/lib/api';
import { Icon, StatusGlyph } from '@/components/Icon';
import RunView from '@/components/wed/RunView';
import VerdictHeader from '@/components/wed/VerdictHeader';
import RunningHero from '@/components/wed/RunningHero';
import PipelineProgress from '@/components/wed/PipelineProgress';
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
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [health, setHealth] = useState(null);
  const [healthErr, setHealthErr] = useState(null);

  // Re-fetch the operational state (summary + ledger + runs). Called once on
  // mount and again on each SSE `run` event; there is no manual refresh, so the
  // page updates automatically as the pipeline reports progress.
  const refresh = useCallback(async () => {
    // Source health drives the verdict header (fail-loud) — fetch and error-handle
    // it independently so a source-health outage doesn't blank the release section,
    // and so the header and the Source-health card share ONE request.
    api.wedSourceHealth()
      .then((h) => { setHealth(h); setHealthErr(null); })
      .catch((e) => { setHealthErr(e.message || 'Failed to load build status'); });
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
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Live updates via SSE — no polling. The backend broadcasts a `run` event after
  // every webhook/heartbeat write; we quietly re-pull on each. One idle
  // connection (auto-reconnecting), so nothing fires when nothing is happening.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    const es = new EventSource(streamUrl);
    es.addEventListener('run', () => { refresh(); });
    // onerror is non-fatal: EventSource reconnects automatically (retry: 5000).
    return () => es.close();
  }, [refresh]);

  // ── run selection ──────────────────────────────────────────────────────────
  // Split the run list into the currently-running build (if any) and the most
  // recent FINISHED build. The hero verdict reflects the last finished build; a
  // running build is shown separately (front-and-center) so it never inherits the
  // previous run's pass/fail color. Older builds are reachable via the run picker.
  const { activeRun, lastFinishedRun } = useMemo(() => {
    const isFinished = (r) => r.status === 'success' || r.status === 'failed' || !!r.finished_at;
    return {
      activeRun: runs.find((r) => !isFinished(r)) || null,
      lastFinishedRun: runs.find(isFinished) || null,
    };
  }, [runs]);

  // Default the inspected run to the last finished build (else the active one);
  // never clobber an explicit user pick.
  useEffect(() => {
    setSelectedRunId((cur) => cur ?? lastFinishedRun?.run_id ?? activeRun?.run_id ?? null);
  }, [lastFinishedRun, activeRun]);

  // Detail (jobs + steps + release join) for the run selected in the picker.
  // Re-pulls on each SSE refresh so a selected in-flight run stays current.
  useEffect(() => {
    if (!selectedRunId) { setRunDetail(null); return; }
    let alive = true;
    api.wedRun(selectedRunId).then((d) => { if (alive) setRunDetail(d); }).catch(() => {});
    return () => { alive = false; };
  }, [selectedRunId, runs]);

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

  // RunView-shaped objects. The heroes derive from the run-list items (live on
  // every SSE refresh); the detail view uses the picker-selected run's full
  // document. Fall back to a representative run anchored to the latest release
  // until live telemetry exists.
  const activeRunView = useMemo(() => runFromApi(activeRun), [activeRun]);
  const lastFinishedView = useMemo(() => runFromApi(lastFinishedRun), [lastFinishedRun]);
  const selectedRunView = useMemo(() => runFromApi(runDetail), [runDetail]);
  const repRun = useMemo(
    () => buildRepresentativeRun({ version: latest?.release_version, knownFrom: latest?.known_from }),
    [latest?.release_version, latest?.known_from],
  );
  const heroRun = lastFinishedView || repRun;   // last recorded state → verdict banner
  const detailRun = selectedRunView || repRun;  // picker-controlled detail view
  const hasRuns = runs.length > 0;

  // Source-health for the picker-selected run (per-run): each run doc carries its
  // own source_health, so the picker drives this section too. Fall back to the
  // global last-finished manifest when no run is selected (representative/no runs).
  const cardHealth = useMemo(
    () => (runDetail?.source_health ? { ...runDetail.source_health, representative: false } : health),
    [runDetail, health],
  );

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
          <div className="nextrun"><Icon.calendar size={14} /> weekly · <span className="mono">Wed 02:00</span></div>
        </div>
      </div>

      {/* Last recorded state. When a build is running this collapses to its
          one-line headline; the running build (below) is the front-and-center
          hero. Remount on active-state flip so the default collapse is correct. */}
      <VerdictHeader key={activeRunView ? 'collapsed' : 'full'} run={heroRun} health={health} err={healthErr}
                     collapsible={!!activeRunView} label={activeRunView ? 'Last completed build' : null} />

      {/* Currently-executing build, shown separately so it never borrows the last
          build's color. Live intra-build progress sits directly under it. */}
      {activeRunView && <RunningHero run={activeRunView} />}
      {activeRunView && <PipelineProgress run={activeRunView} />}

      {/* ── Run inspection zone — the picker drives the source-health + run views below ── */}
      {!hasRuns && (
        <div className="preview-banner">
          <span className="pb-ico"><Icon.bolt size={16} /></span>
          <div className="pb-text">
            <b>Representative run.</b> No live run has reported yet — the source health &amp; timeline below show the shape of a weekly build. Release data &amp; change tracking further down is <b>live</b>.
          </div>
        </div>
      )}

      {hasRuns && (
        <div className="topbar" style={{ marginBottom: 14 }}>
          <div className="brand-sub" style={{ fontSize: 13 }}>
            Inspecting run{detailRun?.version && detailRun.version !== '—' ? <> · <span className="mono" style={{ color: 'var(--text)' }}>{detailRun.version}</span></> : null}
          </div>
          <RunPicker runs={runs} value={selectedRunId} onChange={setSelectedRunId} activeId={activeRun?.run_id} />
        </div>
      )}

      <Card icon="server" title="Source health"
            hint={runDetail && detailRun?.version && detailRun.version !== '—' ? detailRun.version : null}>
        <SourceHealth health={cardHealth} err={healthErr} />
      </Card>

      <RunView run={detailRun} db={summary?.db} />

      {/* ── Live release data & change tracking ── */}
      <div className="rsplit">
        <div className="rsplit-line" />
        <div className="rsplit-label"><span className="live-dot" /> Release data &amp; change tracking · live</div>
        <div className="rsplit-line" />
      </div>

      {err && (
        <div className="state-line err">
          <Icon.alert size={16} /> Backend unreachable: {err}
          <span className="state-hint" style={{ marginLeft: 8 }}>Is the backend running with <span className="mono">MONGODB_URI</span> → <span className="mono">{summary?.db || 'the configured WED DB'}</span>?</span>
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

          <Card icon="layers" title="Release ledger" hint={`${releases.length} releases`}>
            <LedgerTable releases={releases} value={version} onSelect={setVersion} />
          </Card>

          <Card icon="diff" title={`What changed in ${version}`}
                hint={selected.from_release ? `diff vs ${selected.from_release}` : 'baseline load'}>
            <DiffPanel release={selected} diff={diff} loading={diffLoading} />
          </Card>

          <Card icon="server" title="Source breakdown"
                hint={selected.from_release ? null : 'baseline load'}>
            <SourceBreakdown release={selected} data={sources} active={srcFilter} onPick={pickSource} />
          </Card>

          <div id="change-explorer">
            <Card icon="search" title="Change explorer"
                  hint={srcFilter ? `filtered to ${srcFilter}` : null}>
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
        source <span className="mono">{summary?.db || '—'}</span>
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

/* ─────────────────────────── run picker ─────────────────────────── */
// Mirrors ReleasePicker: switches the run-detail view to any historical run.
// Controls ONLY the detail RunView below — not the hero verdict or Source-health
// card, which stay pinned to the last-recorded / currently-running system state.
function RunPicker({ runs, value, onChange, activeId }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const label = (r) => r.release_version || (r.git_sha ? r.git_sha.slice(0, 7) : r.run_id);
  const cur = runs.find((r) => r.run_id === value) || runs[0];
  if (!cur) return null;
  const curState = stateOf(cur.status);
  return (
    <div className={`runpick ${open ? 'open' : ''}`} ref={ref}>
      <button className="runpick-btn" onClick={() => setOpen((o) => !o)}>
        <span className={`flow-stat fs-${curState}`} style={{ width: 22, height: 22 }}><StatusGlyph status={curState} size={13} /></span>
        <div style={{ textAlign: 'left', lineHeight: 1.2 }}>
          <div className="rp-num">{label(cur)}</div>
          <div className="rp-meta">{cur.run_id === activeId ? 'running now' : isoDate(cur.started_at)}</div>
        </div>
        <span className="runpick-chevy"><Icon.chevron size={15} /></span>
      </button>
      {open && (
        <div className="runpick-menu">
          <div className="runpick-head">
            <span>Workflow runs</span>
            <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>{runs.length} runs</span>
          </div>
          <div className="runpick-list">
            {runs.map((r) => {
              const st = stateOf(r.status);
              const active = r.run_id === value;
              const tag = r.run_id === activeId ? 'running' : (r === runs[0] ? 'latest' : null);
              return (
                <button key={r.run_id} className={`runrow ${active ? 'active' : ''}`}
                        onClick={() => { onChange(r.run_id); setOpen(false); }}>
                  <span className={`flow-stat fs-${st}`} style={{ width: 20, height: 20 }}><StatusGlyph status={st} size={12} /></span>
                  <div className="runrow-main">
                    <span className="runrow-v">{label(r)}{tag && <span style={{ color: 'var(--text-3)', fontWeight: 500 }}> · {tag}</span>}</span>
                    <span className="runrow-d">{isoDate(r.started_at)}</span>
                  </div>
                  <div className="runrow-r">
                    <div className="runrow-num">{r.status}</div>
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
