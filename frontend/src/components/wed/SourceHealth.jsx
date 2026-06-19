'use client';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { fmtNum } from '@/lib/format';
import { STAGE_LABEL } from '@/lib/pipelineModel';

// Per-run source health (driven by the run picker — the page passes the SELECTED
// run's manifest). "Source processing" is per-source (Download · Clean); "Combine"
// is per-variable. QC is advisory and never blocks. The stage-counts strip is a
// per-stage rollup of the manifest's own rows (how many download/clean/combine
// passed), so it's the static truth for a finished run — the live, mid-build view
// is the separate PipelineProgress card. "Clean" is the name of a STAGE here, so
// the all-good summary says "passed", never "clean".

function StageCell({ status }) {
  if (status === 'failed') return <span className="mx-cell mx-failed"><Icon.x size={13} /></span>;
  if (status === 'fallback') return <span className="mx-cell mx-fallback" title="used cached (last-good) data">◌</span>;
  if (status === 'not_reached') return <span className="mx-cell mx-skip" title="stage not reached — build halted earlier">—</span>;
  return <span className="mx-cell mx-ok">●</span>;
}
function QcCell({ flags }) {
  if (!flags) return <span className="mx-cell mx-ok">0</span>;
  return <span className="mx-cell mx-flag">{fmtNum(flags)} ⚑</span>;
}
const isAttention = (row, keys) => keys.some((k) => row[k] === 'failed') || (row.qc_flags || 0) > 0;
const isFallback = (row, keys) => keys.some((k) => row[k] === 'fallback');
const isNotReached = (row, keys) => keys.some((k) => row[k] === 'not_reached');

// Per-stage rollup of the manifest rows → the at-a-glance counts strip.
function rollup(rows, key) {
  const m = { passed: 0, failed: 0, fallback: 0, not_reached: 0, total: (rows || []).length };
  for (const r of rows || []) if (m[r[key]] != null) m[r[key]] += 1;
  return m;
}
function StageCounts({ sources, variables }) {
  if (!(sources && sources.length) && !(variables && variables.length)) return null;
  const cells = [
    ['Download', rollup(sources, 'download')],
    ['Clean', rollup(sources, 'clean')],
    ['Combine', rollup(variables, 'combine')],
  ];
  return (
    <div className="stagecounts">
      {cells.map(([label, m]) => (
        <span className="sc-item" key={label}>
          <span className="sc-k">{label}</span>
          <span className="sc-v">{m.total ? `${fmtNum(m.passed)} / ${fmtNum(m.total)}` : '—'}</span>
          {m.total && (m.failed || m.fallback || m.not_reached) ? (
            <span className="sc-sub">
              {m.failed ? <span className="sc-fail">{fmtNum(m.failed)} failed</span> : null}
              {m.fallback ? <>{m.failed ? ' · ' : ''}{fmtNum(m.fallback)} cached</> : null}
              {m.not_reached ? <>{(m.failed || m.fallback) ? ' · ' : ''}{fmtNum(m.not_reached)} not reached</> : null}
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function Matrix({ title, unit, stageKeys, rows, total, expectedNote }) {
  const [open, setOpen] = useState(false);
  const flagged = rows.filter((r) => isAttention(r, stageKeys));
  const fallbackRows = rows.filter((r) => !isAttention(r, stageKeys) && isFallback(r, stageKeys));
  const rest = rows.filter((r) => !isAttention(r, stageKeys) && !isFallback(r, stageKeys));
  const notReachedRows = rest.filter((r) => isNotReached(r, stageKeys));
  const passedRows = rest.filter((r) => !isNotReached(r, stageKeys));
  const cols = `1fr repeat(${stageKeys.length + 1}, 88px)`;

  const Row = (r) => (
    <div className="mx-row" style={{ gridTemplateColumns: cols }} key={r.name}>
      <span className="mx-name"><span className="mono">{r.name}</span>{r.category && <span className="mx-tag">{r.category}</span>}</span>
      {stageKeys.map((k) => <StageCell key={k} status={r[k]} />)}
      <QcCell flags={r.qc_flags} />
    </div>
  );

  const metaBits = [];
  if (flagged.length) metaBits.push(`${fmtNum(flagged.length)} need attention`);
  if (fallbackRows.length) metaBits.push(`${fmtNum(fallbackRows.length)} on cached data`);
  if (notReachedRows.length) metaBits.push(`${fmtNum(notReachedRows.length)} not reached`);
  if (rows.length > 0 && !flagged.length && !fallbackRows.length && !notReachedRows.length) metaBits.push('all passed');
  const restLabel = [
    passedRows.length ? `${fmtNum(passedRows.length)} passed` : null,
    notReachedRows.length ? `${fmtNum(notReachedRows.length)} not reached` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="mx">
      <button className="mx-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="mx-chev" data-open={open}><Icon.chevron size={15} /></span>
        <span className="mx-title">{title}</span>
        <span className="mx-meta">{fmtNum(total)} {unit}{metaBits.length ? ` · ${metaBits.join(' · ')}` : ''}</span>
      </button>

      {rows.length === 0 ? (
        <div className="mx-empty">
          <Icon.alert size={14} /> No per-source results were posted for this run.
          {expectedNote ? <span className="muted"> {expectedNote}</span> : null}
        </div>
      ) : (
        <>
          <div className="mx-colhead" style={{ gridTemplateColumns: cols }}>
            <span />
            {stageKeys.map((k) => <span key={k} className="mx-col">{STAGE_LABEL[k]}</span>)}
            <span className="mx-col">QC flags</span>
          </div>

          {flagged.map(Row)}
          {fallbackRows.map(Row)}

          {open ? (
            <>
              {notReachedRows.map(Row)}
              {passedRows.map(Row)}
              {rest.length > 0 && <button className="mx-more" onClick={() => setOpen(false)}>▴ Show fewer</button>}
            </>
          ) : (!flagged.length && !fallbackRows.length && !notReachedRows.length && passedRows.length > 0) ? (
            <div className="mx-row mx-allclear" style={{ gridTemplateColumns: cols }}>
              <span className="mx-name muted">All {fmtNum(total)} {unit} passed</span>
              {stageKeys.map((k) => <span key={k} className="mx-cell mx-ok">●</span>)}
              <span className="mx-cell mx-ok">0</span>
            </div>
          ) : rest.length > 0 ? (
            <button className="mx-more" onClick={() => setOpen(true)}>▸ {restLabel} — show all</button>
          ) : null}
        </>
      )}
    </div>
  );
}

export default function SourceHealth({ health, err, progress }) {
  if (err) return <div className="state-line err"><Icon.alert size={15} /> {err}</div>;
  if (!health) return <div className="state-line"><Icon.repeat size={15} /> Loading source health…</div>;

  const s = health.summary || {};
  // Honest discrepancy hint: the box's heartbeat reported sources to download but
  // the manifest carries no per-source rows (an upstream source-health gap).
  const expected = progress?.download?.total;
  const sourceNote = expected ? `(the box reported ${fmtNum(expected)} sources to download)` : null;

  return (
    <div>
      {health.representative && (
        <div className="preview-banner" style={{ marginBottom: 16 }}>
          <span className="pb-ico"><Icon.bolt size={16} /></span>
          <div className="pb-text">
            <b>Representative.</b> Illustrative statuses until a live run posts real per-source results.
          </div>
        </div>
      )}

      <StageCounts sources={health.sources} variables={health.variables} />

      <Matrix title="Source processing" unit="sources" stageKeys={['download', 'clean']}
              rows={health.sources || []} total={s.sources_total || (health.sources || []).length}
              expectedNote={sourceNote} />

      <Matrix title="Combine" unit="variables" stageKeys={['combine']}
              rows={health.variables || []} total={s.variables_total || (health.variables || []).length} />
    </div>
  );
}
