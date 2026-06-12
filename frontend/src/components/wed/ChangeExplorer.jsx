'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { isoDate, fmtValue, fmtNum } from '@/lib/format';

const SCOPES = [
  { v: '', label: 'All scopes' },
  { v: 'harmonized', label: 'Harmonized' },
  { v: 'source', label: 'Per-source' },
];
const TYPES = [
  { v: '', label: 'All' },
  { v: 'revision', label: 'Revisions' },
  { v: 'insert', label: 'Inserts' },
  { v: 'discontinuation', label: 'Discontinued' },
  { v: 'source_change', label: 'Source Δ' },
];
const PAGE = 50;

// Self-contained change-event browser for one release. Owns its filters +
// pagination and fetches /releases/:version/changes (real Phase-7 data). The
// `source` filter is controlled by the parent (so the Source Breakdown card can
// drill into a single upstream source); `sources` feeds the dropdown.
export default function ChangeExplorer({ version, source = '', onSource, sources = [] }) {
  const [scope, setScope] = useState('');
  const [type, setType] = useState('');
  const [series, setSeries] = useState('');
  const [debounced, setDebounced] = useState('');
  const [skip, setSkip] = useState(0);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const setSrc = onSource || (() => {});

  // debounce the series-code search box
  useEffect(() => {
    const t = setTimeout(() => setDebounced(series.trim()), 300);
    return () => clearTimeout(t);
  }, [series]);

  // reset to first page whenever the release or any filter changes
  useEffect(() => { setSkip(0); }, [version, scope, type, debounced, source]);

  useEffect(() => {
    if (!version) return;
    const q = new URLSearchParams({ limit: String(PAGE), skip: String(skip) });
    if (scope) q.set('scope', scope);
    if (type) q.set('type', type);
    if (debounced) q.set('series_code', debounced);
    if (source) q.set('source', source);
    let alive = true;
    setLoading(true);
    api.wedChanges(version, `?${q.toString()}`)
      .then((d) => { if (alive) { setData(d); setErr(null); } })
      .catch((e) => { if (alive) setErr(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [version, scope, type, debounced, source, skip]);

  const items = data?.items || [];
  const total = data?.total || 0;
  const from = total === 0 ? 0 : skip + 1;
  const to = Math.min(skip + PAGE, total);

  return (
    <div>
      <div className="filters">
        <div className="fgroup">
          {SCOPES.map((s) => (
            <button key={s.v} className={`fbtn${scope === s.v ? ' active' : ''}`} onClick={() => setScope(s.v)}>{s.label}</button>
          ))}
        </div>
        <div className="fgroup">
          {TYPES.map((t) => (
            <button key={t.v} className={`fbtn${type === t.v ? ' active' : ''}`} onClick={() => setType(t.v)}>{t.label}</button>
          ))}
        </div>
        {sources.length > 0 && (
          <select className="fselect" value={source} onChange={(e) => setSrc(e.target.value)} aria-label="Filter by source">
            <option value="">All sources</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <label className="fsearch">
          <Icon.search size={14} />
          <input value={series} onChange={(e) => setSeries(e.target.value)} placeholder="filter by series code, e.g. USA_CPI_A" spellCheck={false} />
        </label>
      </div>

      {err && <div className="state-line err"><Icon.alert size={15} /> {err}</div>}
      {!err && loading && !data && <div className="state-line"><Icon.repeat size={15} /> Loading change events…</div>}
      {!err && data && items.length === 0 && (
        <div className="state-line"><Icon.search size={15} /> No change events match these filters in {version}.</div>
      )}

      {!err && items.length > 0 && (
        <>
          <div className="dtable-wrap" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .12s' }}>
            <table className="dtable">
              <thead>
                <tr>
                  <th>Type</th><th>Scope</th><th>Series</th><th>Date</th><th>Source</th>
                  <th>Change</th><th className="num">Δ</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e, i) => (
                  <tr key={i}>
                    <td><span className={`pill pill-${e.type}`}>{labelType(e.type)}</span></td>
                    <td className="muted">{e.scope}</td>
                    <td className="mono">{e.series_code}</td>
                    <td className="mono muted">{isoDate(e.date)}</td>
                    <td className="mono muted">{e.source || '—'}</td>
                    <td><ValueTransition type={e.type} oldV={e.old_value} newV={e.new_value} /></td>
                    <td className="num"><Delta pct={e.pct_change} oom={e.log10_ratio} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span>Showing <b>{fmtNum(from)}</b>–<b>{fmtNum(to)}</b> of <b>{fmtNum(total)}</b></span>
            <div className="pager-btns">
              <button disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))}>← Prev</button>
              <button disabled={to >= total} onClick={() => setSkip(skip + PAGE)}>Next →</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function labelType(t) {
  return ({ insert: 'Insert', revision: 'Revision', discontinuation: 'Discontinued',
    source_change: 'Source Δ', forecast_to_actual: 'Actualized' })[t] || t;
}

export function ValueTransition({ type, oldV, newV }) {
  if (type === 'insert') return <span className="vt"><span className="vt-new">{fmtValue(newV)}</span></span>;
  if (type === 'discontinuation') return <span className="vt"><span className="vt-old">{fmtValue(oldV)}</span><span className="vt-arr">→</span><span className="muted">removed</span></span>;
  return (
    <span className="vt">
      <span className="vt-old">{fmtValue(oldV)}</span>
      <span className="vt-arr">→</span>
      <span className="vt-new">{fmtValue(newV)}</span>
    </span>
  );
}

export function Delta({ pct, oom }) {
  // Prefer a compact percent; fall back to orders-of-magnitude for huge jumps.
  if (typeof pct === 'number' && Number.isFinite(pct)) {
    const up = pct >= 0;
    if (Math.abs(pct) >= 100000 && typeof oom === 'number') {
      return <span className={`delta ${up ? 'up' : 'down'}`}>{up ? '+' : '−'}{Math.abs(oom).toFixed(1)}&nbsp;oom</span>;
    }
    const v = Math.abs(pct) >= 1000 ? Math.round(pct).toLocaleString() : pct.toFixed(1);
    return <span className={`delta ${up ? 'up' : 'down'}`}>{up ? '+' : ''}{v}%</span>;
  }
  return <span className="delta">—</span>;
}
