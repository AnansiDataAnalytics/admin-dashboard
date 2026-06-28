'use client';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';

const FRAME_STYLE = { display: 'block', width: '100%', height: 'calc(100vh - 60px)', border: 0 };

// Embeds the Python review app (serve.py) via the same-origin /data-review-app/
// proxy (next.config.js). Renders the iframe optimistically (no flash in the
// common, online case) and probes the proxy in the background; if the sidecar
// is unreachable, swaps to a dashboard-native "offline" message instead of
// letting the browser show its raw connection error inside the frame.
export default function DataReviewFrame() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/data-review-app/', { method: 'HEAD', cache: 'no-store' })
      .then((r) => { if (!cancelled && !r.ok) setOffline(true); })
      .catch(() => { if (!cancelled) setOffline(true); });
    return () => { cancelled = true; };
  }, []);

  if (!offline) {
    return <iframe src="/data-review-app/" title="Data Review" style={FRAME_STYLE} />;
  }

  return (
    <main className="apage">
      <div className="stub">
        <div className="stub-inner">
          <div className="stub-ico"><Icon.inspect size={26} /></div>
          <h1>Data Review is offline</h1>
          <p>The review service isn’t reachable right now. Once it’s running, reload this page.</p>
        </div>
      </div>
    </main>
  );
}
