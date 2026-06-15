'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { fmtNum } from '@/lib/format';

// Two-matrix source health. "Source processing" is per-source (Download · Clean ·
// QC); "Combine" is per-variable (Combine · QC). QC is a count of advisory
// deterministic flags — it never blocks a release (see verdict.js). Rows that
// failed a stage or carry QC flags show first; all-clear rows fold behind a
// "+N more" expander, and an all-clear matrix collapses to a one-line summary.
// `signal` bumps on each page refresh so this re-pulls with the rest of the page.
const STAGE_LABEL = { download: 'Download', clean: 'Clean', combine: 'Combine' };

function StageCell({ status }) {
  if (status === 'failed') return <span className="mx-cell mx-failed"><Icon.x size={13} /></span>;
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

function Matrix({ title, sub, unit, stageKeys, rows, total }) {
  const [open, setOpen] = useState(false);
  const flagged = rows.filter((r) => attention(r, stageKeys));
  const clean = rows.filter((r) => !attention(r, stageKeys));
  const allClear = flagged.length === 0;
  const moreCount = Math.max(total - flagged.length, 0);
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
      <button className="mx-head" onClick={() => setOpen((o) => !o)}>
        <span className="mx-chev" data-open={open}><Icon.chevron size={15} /></span>
        <span className="mx-title">{title} <span className="mx-sub">{sub}</span></span>
        <span className="mx-meta">{fmtNum(total)} {unit}{allClear ? ' · all clear' : ` · ${fmtNum(flagged.length)} need attention`}</span>
      </button>

      <div className="mx-colhead" style={{ gridTemplateColumns: cols }}>
        <span />
        {stageKeys.map((k) => <span key={k} className="mx-col">{STAGE_LABEL[k]}</span>)}
        <span className="mx-col">QC flags</span>
      </div>

      {allClear ? (
        open ? clean.map(Row) : (
          <div className="mx-row mx-allclear" style={{ gridTemplateColumns: cols }}>
            <span className="mx-name muted">All {fmtNum(total)} {unit} clean</span>
            {stageKeys.map((k) => <span key={k} className="mx-cell mx-ok">●</span>)}
            <span className="mx-cell mx-ok">0</span>
          </div>
        )
      ) : (
        <>
          {flagged.map(Row)}
          {open ? clean.map(Row)
                : (moreCount > 0 && (
                    <button className="mx-more" onClick={() => setOpen(true)}>▸ +{fmtNum(moreCount)} more {unit} — all clear</button>
                  ))}
        </>
      )}
    </div>
  );
}

export default function SourceHealth({ signal = 0 }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    api.wedSourceHealth()
      .then((d) => { if (alive) { setData(d); setErr(null); } })
      .catch((e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [signal]);

  if (err) return <div className="state-line err"><Icon.alert size={15} /> {err}</div>;
  if (!data) return <div className="state-line"><Icon.repeat size={15} /> Loading source health…</div>;

  const s = data.summary || {};
  return (
    <div>
      {data.representative && (
        <div className="preview-banner" style={{ marginBottom: 16 }}>
          <span className="pb-ico"><Icon.bolt size={16} /></span>
          <div className="pb-text">
            <b>Representative.</b> Real per-source status (Download · Clean · QC) and per-variable status
            (Combine · QC) post from each run once the heartbeat secret is configured — statuses below are illustrative.
          </div>
        </div>
      )}

      <Matrix
        title="Source processing" sub="· fetch &amp; clean · source by source"
        unit="sources" stageKeys={['download', 'clean']}
        rows={data.sources || []} total={s.sources_total || (data.sources || []).length} />

      <Matrix
        title="Combine" sub="· chain-linking · variable by variable"
        unit="variables" stageKeys={['combine']}
        rows={data.variables || []} total={s.variables_total || (data.variables || []).length} />
    </div>
  );
}
