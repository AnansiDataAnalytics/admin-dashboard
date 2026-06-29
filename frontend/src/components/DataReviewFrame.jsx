'use client';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';

const FRAME_STYLE = { display: 'block', width: '100%', height: 'calc(100vh - 60px)', border: 0 };
const POLL_MS = 15000;

// Embeds the Python review app (serve.py) via the same-origin /data-review-app/
// proxy. Polls the exempt /idle endpoint to (a) detect when the server is
// down/asleep — swapping to a dashboard-native card that auto-recovers when it
// returns — and (b) show a sleep-countdown banner with a "Stay active" button.
// /idle does NOT count as activity server-side, so polling never keeps it awake.
export default function DataReviewFrame() {
  const [offline, setOffline] = useState(false);
  const [left, setLeft] = useState(null);     // seconds until sleep (null = no idle timeout configured)
  const [windowSec, setWindowSec] = useState(0);
  const timer = useRef(null);

  async function pollIdle() {
    try {
      const r = await fetch('/data-review-app/idle', { cache: 'no-store' });
      if (!r.ok) throw new Error('down');
      const j = await r.json();
      setOffline(false);
      setWindowSec(j.timeout || 0);
      setLeft(j.seconds_left);
    } catch {
      setOffline(true);
      setLeft(null);
    }
  }

  useEffect(() => {
    pollIdle();
    timer.current = setInterval(pollIdle, POLL_MS);
    return () => clearInterval(timer.current);
  }, []);

  async function stayActive() {
    // Any non-/idle request resets the server's activity timer.
    try { await fetch('/data-review-app/', { method: 'HEAD', cache: 'no-store' }); } catch {}
    pollIdle();
  }

  if (offline) {
    return (
      <main className="apage">
        <div className="stub">
          <div className="stub-inner">
            <div className="stub-ico"><Icon.inspect size={26} /></div>
            <h1>Data Review is asleep</h1>
            <p>The review service stops after a period of inactivity. Start it and it’ll load here automatically.</p>
            <div className="stub-links">
              <button type="button" className="btn btn-primary" onClick={pollIdle}>Retry</button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // Warn within the last 5 min (or half the window for short test timeouts).
  const warnAt = windowSec ? Math.min(300, windowSec / 2) : 0;
  const warn = left != null && left <= warnAt;

  return (
    <div style={{ position: 'relative' }}>
      {warn && (
        <div style={BANNER}>
          <span>⏳ No activity detected — Data Review sleeps in <b>{fmtLeft(left)}</b>.</span>
          <button type="button" onClick={stayActive} style={BANNER_BTN}>Stay active</button>
        </div>
      )}
      <iframe src="/data-review-app/" title="Data Review" style={FRAME_STYLE} />
    </div>
  );
}

function fmtLeft(s) {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m > 0 ? `~${m} min` : `${sec}s`;
}

const BANNER = {
  position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5,
  display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center',
  padding: '8px 14px', background: '#f0b653', color: '#10141b', fontSize: 14,
};
const BANNER_BTN = {
  background: '#10141b', color: '#fff', border: 0, borderRadius: 6,
  padding: '4px 12px', cursor: 'pointer', fontSize: 13,
};
