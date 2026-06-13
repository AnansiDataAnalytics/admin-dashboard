'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Icon, StatusGlyph } from '@/components/Icon';
import { fmtNum } from '@/lib/format';

const STAGE_LABEL = { download: 'Download', clean: 'Clean', combine: 'Combine' };

// At-a-glance per-source execution health for the latest run — finer than the
// GitHub Actions jobs/steps. Each cell is one source script (download aggregator
// / country-level fetch / combine variable); status comes from the Stata status
// CSVs (code/functions/_run_wrapper.do).
//
// HARD-ABORT model: the build is a strict sequence (download -> clean -> combine)
// and ANY single source failure aborts the whole run. So the backend marks the
// first failing stage as the gate and every later stage as "not reached" — this
// card leads with the blockers and dims the stages that never ran. Representative
// until the pipeline posts real status (backend sourceHealth.js LIVE PATH note).
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

  const s = data.summary || { total: 0, passed: 0, failed: 0, missing: 0, not_reached: 0, truncated: 0 };
  const gated = data.gated_stage || null;
  const gatedLabel = STAGE_LABEL[gated] || gated;

  // Failures are the blockers; "missing" = ran but no status row (unreported).
  const blockers = [];
  const unreported = [];
  (data.stages || []).forEach((st) => st.groups.forEach((g) => g.sources.forEach((src) => {
    if (src.status === 'failed') blockers.push({ ...src, group: g.label });
    else if (src.status === 'missing') unreported.push({ ...src, group: g.label });
  })));
  const isClean = (s.failed || 0) === 0 && !gated;

  return (
    <div>
      {data.representative && (
        <div className="preview-banner" style={{ marginBottom: 16 }}>
          <span className="pb-ico"><Icon.bolt size={16} /></span>
          <div className="pb-text">
            <b>Representative.</b> Real per-source status is posted from each run (every one of ~196 download/combine
            scripts records pass/fail). It populates here once a run posts it (needs the <span className="mono">DASHBOARD_URL</span> /
            heartbeat secret configured) — statuses below are illustrative.
          </div>
        </div>
      )}

      {/* Hard-abort verdict — only on real data that gated */}
      {!data.representative && gated && (
        <div className="shealth-halt" style={{ marginBottom: 16 }}>
          <span className="shh-ico"><Icon.alert size={16} /></span>
          <div>
            <b>Build halted at {gatedLabel}.</b>{' '}
            {blockers.length > 0
              ? <>{fmtNum(blockers.length)} source{blockers.length === 1 ? '' : 's'} failed. The sources are tightly
                  coupled — every one must succeed — so a single failure aborts the build and the downstream stages
                  (clean, combine) never ran. Fix all blockers below to unblock the build.</>
              : <>the stage did not complete, so the downstream stages never ran.</>}
          </div>
        </div>
      )}

      <div className={`shealth-summary ${isClean ? 'ok' : 'bad'}`}>
        <span className="shealth-ico"><StatusGlyph status={isClean ? 'passed' : 'failed'} size={22} /></span>
        <div>
          <div className="shealth-headline">{fmtNum(s.passed)} / {fmtNum(s.total)} source scripts ran clean</div>
          <div className="brand-sub" style={{ fontSize: 12 }}>
            {gated ? `${gatedLabel} stage gated the build` : 'across download (aggregators + country-level) and combine'}
          </div>
        </div>
        <div className="shealth-counts">
          <span className="shealth-count ok"><b>{fmtNum(s.passed)}</b> passed</span>
          <span className="shealth-count bad"><b>{fmtNum(s.failed)}</b> failed</span>
          <span className="shealth-count warn"><b>{fmtNum(s.missing)}</b> unreported</span>
          {(s.not_reached || 0) > 0 && <span className="shealth-count muted"><b>{fmtNum(s.not_reached)}</b> not reached</span>}
        </div>
      </div>

      {blockers.length > 0 && (
        <div className="shproblems">
          <span className="shp-label"><Icon.alert size={13} /> Blockers — fix all to unblock the build</span>
          {blockers.map((p, i) => (
            <span key={i} className="shcell is-failed" title={`${p.group}${p.rc ? ` · rc ${p.rc}` : ''}`}>
              {p.name}{p.rc ? <span className="shcell-rc">rc {p.rc}</span> : null}
            </span>
          ))}
        </div>
      )}

      {unreported.length > 0 && (
        <div className="shproblems subtle">
          <span className="shp-label"><Icon.bolt size={13} /> Unreported — ran but wrote no status row</span>
          {unreported.map((p, i) => (
            <span key={i} className="shcell is-missing" title={p.group}>{p.name}</span>
          ))}
        </div>
      )}

      {(data.stages || []).map((st) => {
        if (st.state === 'not_reached') {
          return (
            <div className="shealth-stage" key={st.id}>
              <div className="shstage-head">
                {st.label} <span className="plain">{st.plain}</span>
                <span className="shstage-badge not_reached">not reached</span>
              </div>
              <div className="shstage-skip">
                Did not run — the build halted upstream{gated ? ` at ${gatedLabel}` : ''}.
              </div>
            </div>
          );
        }
        return (
          <div className="shealth-stage" key={st.id}>
            <div className="shstage-head">
              {st.label} <span className="plain">{st.plain}</span>
              {st.state && (
                <span className={`shstage-badge ${st.state}`}>{st.state === 'failed' ? 'gated here' : 'passed'}</span>
              )}
            </div>
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
                      <span key={src.name} className={`shcell is-${src.status}`} title={src.rc ? `${src.status} · rc ${src.rc}` : src.status}>
                        {src.name}{src.rc ? <span className="shcell-rc">rc {src.rc}</span> : null}
                      </span>
                    ))}
                    {more > 0 && <span className="shcell is-more">+{fmtNum(more)} more</span>}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
