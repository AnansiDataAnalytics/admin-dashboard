'use client';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { fmtNum } from '@/lib/format';
import { STAGE_LABEL } from '@/lib/pipelineModel';

// Two-matrix source health. "Source processing" is per-source (Download · Clean ·
// QC); "Combine" is per-variable (Combine · QC). QC is a count of advisory
// deterministic flags — it never blocks a release (see verdict.js). Rows that
// failed a stage or carry QC flags show first; all-clear rows fold behind a
// "+N more" expander, and an all-clear matrix collapses to a one-line summary.
// `health` is fetched once by the page and passed in as a prop — this component does not fetch.

function StageCell({ status }) {
  if (status === 'failed') return <span className="mx-cell mx-failed"><Icon.x size={13} /></span>;
  if (status === 'fallback') return <span className="mx-cell mx-fallback" title="used cached (last-good) data">◌</span>;
  if (status === 'not_reached') return <span className="mx-cell mx-skip">—</span>;
  return <span className="mx-cell mx-ok">●</span>;
}
function QcCell({ flags }) {
  if (!flags) return <span className="mx-cell mx-ok">0</span>;
  return <span className="mx-cell mx-flag">{fmtNum(flags)} ⚑</span>;
}
function attention(row, stageKeys) {
  return stageKeys.some((k) => row[k] === 'failed') || (row.qc_flags || 0) > 0;
}
// A source that fell back to last-good/cached data — shown plainly (neutral),
// never in the red "need attention" group; a normal, non-blocking outcome.
function usedFallback(row, stageKeys) {
  return stageKeys.some((k) => row[k] === 'fallback');
}

function Matrix({ title, sub, unit, stageKeys, rows, total }) {
  const [open, setOpen] = useState(false);
  const flagged = rows.filter((r) => attention(r, stageKeys));
  const fallbackRows = rows.filter((r) => !attention(r, stageKeys) && usedFallback(r, stageKeys));
  const clean = rows.filter((r) => !attention(r, stageKeys) && !usedFallback(r, stageKeys));
  const allClear = flagged.length === 0 && fallbackRows.length === 0;
  const moreCount = clean.length; // count the "+N more" expander will actually reveal (== total − flagged for live data)
  const notReached = rows.filter((r) => stageKeys.some((k) => r[k] === 'not_reached')).length;
  const cols = `1fr repeat(${stageKeys.length + 1}, 88px)`;

  const Row = (r) => (
    <div className="mx-row" style={{ gridTemplateColumns: cols }} key={r.name}>
      <span className="mx-name"><span className="mono">{r.name}</span>{r.category && <span className="mx-tag">{r.category}</span>}</span>
      {stageKeys.map((k) => <StageCell key={k} status={r[k]} />)}
      <QcCell flags={r.qc_flags} />
    </div>
  );

  return (
    <div className="mx">
      <button className="mx-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="mx-chev" data-open={open}><Icon.chevron size={15} /></span>
        <span className="mx-title">{title}{sub ? <span className="mx-sub"> {sub}</span> : null}</span>
        <span className="mx-meta">{fmtNum(total)} {unit}{flagged.length > 0 ? ` · ${fmtNum(flagged.length)} need attention` : ''}{fallbackRows.length > 0 ? ` · ${fmtNum(fallbackRows.length)} on cached data` : ''}{notReached > 0 ? ` · ${fmtNum(notReached)} not reached` : ''}{allClear && notReached === 0 ? ' · all clear' : ''}</span>
      </button>

      <div className="mx-colhead" style={{ gridTemplateColumns: cols }}>
        <span />
        {stageKeys.map((k) => <span key={k} className="mx-col">{STAGE_LABEL[k]}</span>)}
        <span className="mx-col">QC flags</span>
      </div>

      {flagged.map(Row)}
      {fallbackRows.map(Row)}
      {open ? (
        <>
          {clean.map(Row)}
          <button className="mx-more" onClick={() => setOpen(false)}>▴ Show fewer</button>
        </>
      ) : allClear ? (
        <div className="mx-row mx-allclear" style={{ gridTemplateColumns: cols }}>
          <span className="mx-name muted">All {fmtNum(total)} {unit} clean</span>
          {stageKeys.map((k) => <span key={k} className="mx-cell mx-ok">●</span>)}
          <span className="mx-cell mx-ok">0</span>
        </div>
      ) : (
        moreCount > 0 && (
          <button className="mx-more" onClick={() => setOpen(true)}>▸ +{fmtNum(moreCount)} more {unit} — all clear</button>
        )
      )}
    </div>
  );
}

export default function SourceHealth({ health, err }) {
  if (err) return <div className="state-line err"><Icon.alert size={15} /> {err}</div>;
  if (!health) return <div className="state-line"><Icon.repeat size={15} /> Loading source health…</div>;

  const s = health.summary || {};
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

      <Matrix
        title="Source processing"
        unit="sources" stageKeys={['download', 'clean']}
        rows={health.sources || []} total={s.sources_total || (health.sources || []).length} />

      <Matrix
        title="Combine"
        unit="variables" stageKeys={['combine']}
        rows={health.variables || []} total={s.variables_total || (health.variables || []).length} />
    </div>
  );
}
