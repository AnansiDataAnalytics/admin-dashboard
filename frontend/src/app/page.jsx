'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Icon, StatusGlyph } from '@/components/Icon';
import Ticks from '@/components/Ticks';
import { fmtNum, relativeTime, stateOf, isoDate } from '@/lib/format';

const STATE_WORD = { passed: 'Operational', failed: 'Failed', running: 'Building', pending: 'Idle' };

export default function Home() {
  const [summary, setSummary] = useState(null);
  const [releases, setReleases] = useState(null);
  const [err, setErr] = useState(null);
  const [now, setNow] = useState(null);

  useEffect(() => {
    setNow(new Date());
    Promise.all([api.wedSummary(), api.wedReleases()])
      .then(([s, r]) => { setSummary(s); setReleases(r); })
      .catch((e) => setErr(e.message));
  }, []);

  const latest = summary?.latest;
  const state = latest ? stateOf(latest.status) : 'pending';
  const cs = latest?.change_summary;
  const nextWed = nextWeeklyRun(now);

  return (
    <main className="apage">
      <header className="ahero">
        <div>
          <div className="ahero-kicker">Internal console</div>
          <h1>Welcome back.</h1>
        </div>
        <div className="ahero-clock">
          {now ? <>{fmtClock(now)}<br /></> : null}
          <b>1</b> of 4 services live
        </div>
      </header>

      <section className="bento" aria-label="Services">
        {/* WED pipeline status (live, from the release ledger) */}
        <Link className={`tile t-pipe${state === 'failed' ? ' is-failed' : state === 'running' ? ' is-running' : ''}`} href="/pipelines/wed">
          <div className="tile-k">Pipeline Status · WED</div>
          <div className="t-pipe-status">
            <span className="t-pipe-glyph">
              <StatusGlyph status={state} size={32} />
            </span>
            <span className="t-pipe-word">{err ? 'Unknown' : STATE_WORD[state]}</span>
          </div>
          <div className="t-pipe-sub">
            {err ? (
              <>Backend unreachable — <b>{err}</b></>
            ) : latest ? (
              <>Release <b>{latest.release_version}</b> {latest.status} {relativeTime(latest.known_from)}
                {cs ? <> · <b>{fmtNum(cs.points_seen)}</b> cells tracked</> : null}
              </>
            ) : (
              <>Loading release ledger…</>
            )}
          </div>
          <div className="t-pipe-foot">
            {releases ? <Ticks releases={releases} /> : <div className="ticks-label">—</div>}
            <span className="t-pipe-go">Open status <Icon.arrowRight size={15} /></span>
          </div>
        </Link>

        {/* Schedule (representative cadence — no live run is queued yet) */}
        <div className="tile t-next" data-screen-label="Next build tile">
          <div className="tile-k">Weekly schedule</div>
          <div className="t-next-big">
            {nextWed ? <>{nextWed.day}<small> {nextWed.mon}</small></> : <>—</>}
          </div>
          <div className="t-next-sub">{nextWed ? `${nextWed.weekday} 02:00` : 'weekly cadence'}</div>
        </div>

        {/* Current release */}
        <div className="tile t-release" data-screen-label="Current release tile">
          <div>
            <div className="tile-k">Current release</div>
            <div className="t-release-v">{latest?.release_version || '—'}</div>
          </div>
          <div className="tile-k" style={{ textAlign: 'right' }}>
            {summary ? `${summary.total_releases} tracked` : '—'}
          </div>
        </div>

        {/* Planned services */}
        <Link className="tile t-svc" href="/clients">
          <span className="t-svc-ico"><Icon.users size={19} /></span>
          <h3>Client Management</h3>
          <p>Accounts, entitlements and contacts for every client.</p>
          <span className="t-svc-tag">Planned</span>
        </Link>
        <Link className="tile t-svc" href="/data-review">
          <span className="t-svc-ico"><Icon.inspect size={19} /></span>
          <h3>Data Review</h3>
          <p>Inspect, compare and sign off releases before they ship.</p>
          <span className="t-svc-tag">Planned</span>
        </Link>
        <Link className="tile t-svc" href="/analytics">
          <span className="t-svc-ico"><Icon.chart size={19} /></span>
          <h3>Usage Analytics</h3>
          <p>API calls, downloads and engagement across products.</p>
          <span className="t-svc-tag">Planned</span>
        </Link>
      </section>

      <footer className="afoot">
        <span>Anansi Admin · internal use only</span>
        <span className="mono">1 of 4 services live</span>
      </footer>
    </main>
  );
}

function fmtClock(d) {
  try {
    return d.toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return isoDate(d.toISOString()); }
}

// Next Wednesday 02:00 from `now` — the weekly build cadence (representative).
function nextWeeklyRun(now) {
  if (!now) return null;
  const d = new Date(now);
  const day = d.getDay();           // 0 Sun … 3 Wed
  let add = (3 - day + 7) % 7;
  if (add === 0 && d.getHours() >= 2) add = 7;
  d.setDate(d.getDate() + add);
  d.setHours(2, 0, 0, 0);
  return {
    day: d.getDate(),
    mon: d.toLocaleString(undefined, { month: 'short' }),
    weekday: d.toLocaleString(undefined, { weekday: 'short' }),
  };
}
