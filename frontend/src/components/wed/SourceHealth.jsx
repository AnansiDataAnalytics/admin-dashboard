'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Icon, StatusGlyph } from '@/components/Icon';
import { fmtNum } from '@/lib/format';

// At-a-glance per-source execution health for the latest run — finer than the
// GitHub Actions jobs/steps. Each cell is one source script (download
// aggregator / country-level fetch / combine variable); colour = pass/fail/
// missing/truncated, derived from the Stata logs (build_log_report.json).
// Representative until the pipeline posts real per-source status (see backend
// sourceHealth.js LIVE PATH note).
export default function SourceHealth({ live = false }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.wedSourceHealth()
      .then((d) => { if (alive) { setData(d); setErr(null); } })
      .catch((e) => { if (alive) setErr(e.message); });
    load();
    if (!live) return () => { alive = false; };
    const id = setInterval(load, 5000); // refresh while a run is in progress
    return () => { alive = false; clearInterval(id); };
  }, [live]);

  if (err) return <div className="state-line err"><Icon.alert size={15} /> {err}</div>;
  if (!data) return <div className="state-line"><Icon.repeat size={15} /> Loading source health…</div>;

  const s = data.summary || { total: 0, passed: 0, failed: 0, missing: 0, truncated: 0 };
  const clean = (s.failed || 0) === 0 && (s.missing || 0) === 0 && (s.truncated || 0) === 0;

  const problems = [];
  (data.stages || []).forEach((st) => st.groups.forEach((g) => g.sources.forEach((src) => {
    if (src.status !== 'passed') problems.push({ ...src, group: g.label });
  })));

  return (
    <div>
      {data.representative && (
        <div className="preview-banner" style={{ marginBottom: 16 }}>
          <span className="pb-ico"><Icon.bolt size={16} /></span>
          <div className="pb-text">
            <b>Representative.</b> Real per-source status is generated from <span className="mono">build_log_report.json</span> on
            every run (each of ~196 download/combine scripts logs pass/fail). It populates here once the run posts it —
            statuses below are illustrative.
          </div>
        </div>
      )}

      <div className={`shealth-summary ${clean ? 'ok' : 'bad'}`}>
        <span className="shealth-ico"><StatusGlyph status={clean ? 'passed' : 'failed'} size={22} /></span>
        <div>
          <div className="shealth-headline">{fmtNum(s.passed)} / {fmtNum(s.total)} source scripts ran clean</div>
          <div className="brand-sub" style={{ fontSize: 12 }}>across download (aggregators + country-level) and combine</div>
        </div>
        <div className="shealth-counts">
          <span className="shealth-count ok"><b>{fmtNum(s.passed)}</b> passed</span>
          <span className="shealth-count bad"><b>{fmtNum(s.failed)}</b> failed</span>
          <span className="shealth-count warn"><b>{fmtNum(s.missing)}</b> missing</span>
          <span className="shealth-count warn"><b>{fmtNum(s.truncated)}</b> truncated</span>
        </div>
      </div>

      {problems.length > 0 && (
        <div className="shproblems">
          <span className="shp-label"><Icon.alert size={13} /> Needs attention</span>
          {problems.map((p, i) => (
            <span key={i} className={`shcell is-${p.status}`} title={`${p.group} · ${p.status}`}>{p.name}</span>
          ))}
        </div>
      )}

      {(data.stages || []).map((st) => (
        <div className="shealth-stage" key={st.id}>
          <div className="shstage-head">{st.label} <span className="plain">{st.plain}</span></div>
          {st.groups.map((g) => {
            const passed = g.sources.filter((x) => x.status === 'passed').length;
            const more = (g.total || g.sources.length) - g.sources.length;
            return (
              <div className="shealth-group" key={g.id}>
                <div className="shgroup-head">
                  <span>{g.label}</span>
                  <span className="mono">{passed}/{g.sources.length} shown clean · {fmtNum(g.total || g.sources.length)} total</span>
                </div>
                <div className="shgrid">
                  {g.sources.map((src) => (
                    <span key={src.name} className={`shcell is-${src.status}`} title={src.status}>{src.name}</span>
                  ))}
                  {more > 0 && <span className="shcell is-more">+{fmtNum(more)} more</span>}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
