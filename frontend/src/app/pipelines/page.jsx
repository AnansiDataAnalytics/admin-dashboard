'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Icon, StatusGlyph } from '@/components/Icon';
import Ticks from '@/components/Ticks';
import { fmtNum, relativeTime, stateOf, isoDate } from '@/lib/format';

const BADGE_WORD = { passed: 'Sealed', failed: 'Failed', running: 'Building', pending: 'Idle' };

export default function Pipelines() {
  const [summary, setSummary] = useState(null);
  const [releases, setReleases] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    Promise.all([api.wedSummary(), api.wedReleases()])
      .then(([s, r]) => { setSummary(s); setReleases(r); })
      .catch((e) => setErr(e.message));
  }, []);

  const latest = summary?.latest;
  const state = latest ? stateOf(latest.status) : 'pending';
  const cs = latest?.change_summary;

  return (
    <main className="apage">
      <nav className="crumb"><Link href="/">Home</Link><span className="sep">/</span><span className="here">Pipelines</span></nav>
      <header className="ahero">
        <div>
          <div className="ahero-kicker">Pipeline status</div>
          <h1>Pipelines</h1>
          <p>Scheduled data builds and their health. Each pipeline runs weekly on self-hosted runners and is tracked release-by-release.</p>
        </div>
        <div className="ahero-clock"><b>1</b> pipeline monitored<br />release ledger <b>live</b></div>
      </header>

      <div className="pipe-wrap">
        {err && (
          <div className="empty-note" style={{ borderColor: 'var(--red-line)', color: 'var(--red-fg)' }}>
            Backend error: {err}
          </div>
        )}

        <Link className="tile pipecard" href="/pipelines/wed">
          <div className="pipe-head">
            <span className="pipe-mark">WED</span>
            <div>
              <div className="pipe-name">World Economic Database</div>
              <div className="pipe-desc">
                Pulls source inputs from S3, builds with Stata (download → clean → combine), validates every log,
                publishes the clean &amp; final datasets, then ingests the release into MongoDB with full change tracking.
              </div>
            </div>
            <span className={`pipe-badge${state === 'failed' ? ' is-failed' : state === 'running' ? ' is-running' : ''}`}>
              <StatusGlyph status={state} size={13} />
              {BADGE_WORD[state]}
            </span>
          </div>

          <div className="pipe-meta">
            <div className="pipe-kv">
              <div className="k">Latest release</div>
              <div className="v">{latest ? isoDate(latest.known_from) : '—'}</div>
              <div className="sub">{latest ? `${relativeTime(latest.known_from)} · ${latest.status}` : 'loading…'}</div>
            </div>
            <div className="pipe-kv">
              <div className="k">Version</div>
              <div className="v mono">{latest?.release_version || '—'}</div>
              <div className="sub">{cs ? `${fmtNum(cs.points_seen)} cells` : 'wed_staging'}</div>
            </div>
            <div className="pipe-kv">
              <div className="k">Releases tracked</div>
              <div className="v mono">{summary ? summary.total_releases : '—'}</div>
              <div className="sub">{summary ? `${summary.completed_releases} sealed` : ''}</div>
            </div>
            <div className="pipe-kv">
              <div className="k">Last change set</div>
              <div className="v mono">{cs ? fmtNum(cs.counts?.harmonized?.revision || 0) : '—'}</div>
              <div className="sub">harmonized revisions</div>
            </div>
          </div>

          <div className="pipe-foot">
            {releases ? <Ticks releases={releases} /> : <div className="ticks-label">—</div>}
            <span className="pipe-go">View status <Icon.arrowRight size={15} /></span>
          </div>
        </Link>

        <div className="empty-note">More pipelines will appear here as they are onboarded.</div>
      </div>

      <footer className="afoot">
        <span>Anansi Admin · Pipelines</span>
        <span className="mono">1 pipeline monitored</span>
      </footer>
    </main>
  );
}
