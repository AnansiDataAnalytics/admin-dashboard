# WED Liveness & Fail-Loud Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the WED status trustworthy: representative/degraded data must be unmistakable and must never masquerade as healthy, a backend/DB outage must fail loud (not silently fall back to a reassuring representative state), and a scheduled run that doesn't arrive must be flagged as overdue.

**Architecture:** A pure `schedule` module computes the weekly cadence and a `runStaleness()` verdict (overdue detection) — unit-tested with `node --test`. The backend stops swallowing DB errors into the representative manifest (only falls back when Mongo is unconfigured or has no run yet). The `VerdictHeader` gains three liveness states — `awaiting` (representative, no live run), `overdue` (live but a scheduled run is missing), and the existing `unavailable` (fetch error) — and always shows a "Data as of" freshness row.

**Tech Stack:** Node CommonJS + `node --test` (backend), Next 14 / React 18 (frontend, ESM; pure schedule logic in a `.mjs` so `node --test` can run it).

**This is the "trust/liveness" slice (item #1 of the production-readiness list).**

> **Verification:** Do NOT run `npm run build` (a dev server shares `.next`). Verify frontend via the dev server (`curl` → 200) and `node --test` for the pure modules.

---

## Decisions (locked)
- Cadence: weekly, **Wednesday 02:00 local**. Grace before "overdue": **6 hours**.
- Representative fallback is served **only** when `config.mongoUri` is empty (dev/demo) or Mongo is reachable but no run carries `source_health`. A thrown DB error when Mongo IS configured propagates (HTTP 500 → frontend "unavailable").
- When `health.representative` is true, the header shows **awaiting** (neutral), not a healthy/flags/blocked verdict.
- Freshness source: `health.generated_at` (the run's `updated_at`).

---

## Task 1: Pure schedule + staleness module (TDD)

**Files:**
- Create: `frontend/src/lib/schedule.mjs`
- Create: `frontend/src/lib/schedule.test.mjs`
- Modify: `frontend/package.json` (add `"test": "node --test"`)

- [ ] **Step 1: Add the test script** to `frontend/package.json` scripts:

```json
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing tests** — create `frontend/src/lib/schedule.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mostRecentScheduledMs, nextScheduledMs, runStaleness } from './schedule.mjs';

// Wed 18 Jun 2026, 12:00 local (mid-day to avoid TZ boundary flakiness).
const wedNoon = new Date(2026, 5, 18, 12, 0, 0).getTime();

test('mostRecentScheduledMs is this week\'s Wednesday 02:00', () => {
  const d = new Date(mostRecentScheduledMs(wedNoon));
  assert.equal(d.getDay(), 3);   // Wednesday
  assert.equal(d.getHours(), 2);
  assert.equal(d.getDate(), 18);
});

test('nextScheduledMs from Wed noon is next Wednesday 02:00', () => {
  const d = new Date(nextScheduledMs(wedNoon));
  assert.equal(d.getDay(), 3);
  assert.equal(d.getDate(), 25);
});

test('overdue: scheduled time passed grace and no run since', () => {
  const lastRunMs = new Date(2026, 5, 11, 3, 0, 0).getTime(); // a week earlier
  const r = runStaleness({ lastRunMs, nowMs: wedNoon, graceHours: 6 });
  assert.equal(r.overdue, true);
  assert.equal(r.ranForLatest, false);
});

test('not overdue: a run reported after the scheduled time', () => {
  const lastRunMs = new Date(2026, 5, 18, 3, 0, 0).getTime(); // after 02:00 same day
  const r = runStaleness({ lastRunMs, nowMs: wedNoon, graceHours: 6 });
  assert.equal(r.overdue, false);
  assert.equal(r.ranForLatest, true);
});

test('not overdue: still within the grace window', () => {
  const now = new Date(2026, 5, 18, 4, 0, 0).getTime(); // 04:00, grace until 08:00
  const lastRunMs = new Date(2026, 5, 11, 3, 0, 0).getTime();
  assert.equal(runStaleness({ lastRunMs, nowMs: now, graceHours: 6 }).overdue, false);
});

test('overdue: no run has ever reported and grace passed', () => {
  assert.equal(runStaleness({ lastRunMs: null, nowMs: wedNoon, graceHours: 6 }).overdue, true);
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `cd frontend && npm test`
Expected: FAIL — `Cannot find module './schedule.mjs'`.

- [ ] **Step 4: Implement** — create `frontend/src/lib/schedule.mjs`:

```js
// Weekly build cadence: every Wednesday at 02:00 local time. Pure helpers — inject
// `now` so they're deterministic and unit-testable (no reliance on the wall clock).
const RUN_DOW = 3;   // Wednesday (0 = Sunday)
const RUN_HOUR = 2;

// The most recent scheduled run time at or before `nowMs`.
export function mostRecentScheduledMs(nowMs) {
  const d = new Date(nowMs);
  d.setHours(RUN_HOUR, 0, 0, 0);
  let back = (d.getDay() - RUN_DOW + 7) % 7;
  if (back === 0 && nowMs < d.getTime()) back = 7; // Wed but before 02:00 → last week
  d.setDate(d.getDate() - back);
  return d.getTime();
}

// The next scheduled run time strictly after (or at) `nowMs`.
export function nextScheduledMs(nowMs) {
  const d = new Date(nowMs);
  d.setHours(RUN_HOUR, 0, 0, 0);
  let add = (RUN_DOW - d.getDay() + 7) % 7;
  if (add === 0 && nowMs >= d.getTime()) add = 7; // past 02:00 today → next week
  d.setDate(d.getDate() + add);
  return d.getTime();
}

// Display label for the next scheduled run — concrete date, no weekday (the
// cadence already lives in the page topbar).
export function nextScheduledRunLabel(now = new Date()) {
  const d = new Date(nextScheduledMs(now.getTime()));
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · 02:00`;
}

// Is a scheduled run overdue? Overdue when the most-recent scheduled time has
// passed by more than `graceHours` and no run has reported at/after it.
export function runStaleness({ lastRunMs, nowMs, graceHours = 6 }) {
  const scheduledMs = mostRecentScheduledMs(nowMs);
  const ranForLatest = lastRunMs != null && lastRunMs >= scheduledMs;
  const overdue = nowMs >= scheduledMs + graceHours * 3600 * 1000 && !ranForLatest;
  return { overdue, scheduledMs, lastRunMs: lastRunMs ?? null, ranForLatest };
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cd frontend && npm test`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/src/lib/schedule.mjs frontend/src/lib/schedule.test.mjs
git commit -m "feat(frontend): pure weekly-cadence + run-staleness helpers (TDD)"
```

---

## Task 2: Backend — fail loud on real DB errors

**Files:**
- Modify: `backend/src/domains/pipelines/sourceHealth.js`

- [ ] **Step 1: Replace `getSourceHealth`** with the version below (remove the error-swallowing catch; only fall back to representative when Mongo is unconfigured or has no run). Keep the `NB:` sort comment.

```js
async function getSourceHealth() {
  let result = null;
  // Serve representative data ONLY when Mongo is unconfigured (local/dev) or it is
  // reachable but no run has posted source health yet. A thrown DB error when
  // Mongo IS configured is a real outage — let it propagate so the dashboard fails
  // loud ("status unavailable") instead of showing a reassuring representative state.
  if (config.mongoUri) {
    const db = await getDb(config.metaDb);
    // NB: findOne takes (filter, options) — projection AND sort must live in the
    // SAME options object. Passing sort as a 3rd arg silently drops it, returning
    // an arbitrary run. Sort by updated_at (the heartbeat always stamps it) so the
    // most-recent run that carries source_health wins.
    const run = await db.collection('pipeline_runs').findOne(
      { source_health: { $exists: true } },
      { projection: { _id: 0, run_id: 1, source_health: 1, updated_at: 1 }, sort: { updated_at: -1 } },
    );
    if (run && run.source_health) {
      result = { representative: false, run_id: run.run_id, generated_at: run.updated_at || null, ...run.source_health };
    }
  }
  if (!result) result = representativeManifest();
  result.verdict = deriveVerdict(result);
  return result;
}
```

- [ ] **Step 2: Verify backend tests still pass**

Run: `cd backend && npm test`
Expected: PASS — 11 tests (unchanged; this function isn't unit-tested directly).

- [ ] **Step 3: Verify the dev/no-Mongo path still serves representative**

Run: `cd backend && node -e "require('./src/domains/pipelines/sourceHealth').getSourceHealth().then(d=>console.log(d.representative, d.verdict.state)).catch(e=>console.log('THREW',e.message))"`
Expected: prints `true flags` (no `MONGODB_URI` in this shell → representative path; does not throw).

- [ ] **Step 4: Commit**

```bash
git add backend/src/domains/pipelines/sourceHealth.js
git commit -m "fix(backend): fail loud on DB errors instead of masking as representative"
```

---

## Task 3: VerdictHeader liveness states + freshness + styles

**Files:**
- Rewrite: `frontend/src/components/wed/VerdictHeader.jsx`
- Modify: `frontend/src/app/globals.css` (append two state styles)

- [ ] **Step 1: Replace the ENTIRE contents** of `frontend/src/components/wed/VerdictHeader.jsx` with:

```jsx
'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { fmtNum, fmtDuration, fmtDateTime, relativeTime, toMs } from '@/lib/format';
import { nextScheduledRunLabel, runStaleness } from '@/lib/schedule.mjs';

// The single operator-facing status, reconciled to real execution truth AND to
// liveness. Trust rules:
//   • a fetch error is an OUTAGE → red "unavailable" (never a green fallback);
//   • representative data (no live run yet) → neutral "awaiting", NOT a confident
//     healthy/flags/blocked verdict;
//   • live data whose latest scheduled run never arrived → amber "overdue".
// `signal` bumps on every page refresh so this re-pulls with the rest of the page.
const STAGE_LABEL = { download: 'Download', clean: 'Clean', combine: 'Combine' };
const STATE_META = {
  healthy:  { cls: 'v-healthy',  icon: 'check', badge: 'Published' },
  flags:    { cls: 'v-flags',    icon: 'alert', badge: 'Published · review flags' },
  blocked:  { cls: 'v-blocked',  icon: 'x',     badge: 'Failed' },
  awaiting: { cls: 'v-awaiting', icon: 'clock', badge: 'No live run' },
  overdue:  { cls: 'v-overdue',  icon: 'alert', badge: 'Run overdue' },
};

export default function VerdictHeader({ run, signal = 0 }) {
  const [health, setHealth] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    api.wedSourceHealth()
      .then((d) => { if (alive) { setHealth(d); setErr(null); } })
      .catch((e) => { if (alive) setErr(e?.message || 'Failed to load build status'); });
    return () => { alive = false; };
  }, [signal]);

  // Fail loud: an error fetching status is an outage, not a healthy state.
  if (err) {
    return (
      <div className="verdict v-blocked">
        <div className="verdict-head">
          <span className="verdict-ico"><Icon.alert size={20} /></span>
          <div className="verdict-headline">Status unavailable — backend unreachable</div>
        </div>
        <div className="verdict-rows">
          <div className="vrow-k">Error</div><div className="vrow-v">{err}</div>
          <div className="vrow-k">Next run</div><div className="vrow-v mono">{nextScheduledRunLabel()}</div>
        </div>
      </div>
    );
  }
  if (!health) {
    return (
      <div className="verdict">
        <div className="verdict-head">
          <span className="verdict-ico"><Icon.repeat size={20} /></span>
          <div className="verdict-headline">Loading build status…</div>
        </div>
      </div>
    );
  }

  const live = !health.representative;
  const v = health.verdict || { state: 'blocked', qc_flags: 0, gated_stage: null };
  const s = health.summary || {};
  const version = run?.version || '—';
  const gatedLabel = STAGE_LABEL[v.gated_stage] || v.gated_stage;
  const lastRunMs = toMs(health.generated_at);
  const stale = live ? runStaleness({ lastRunMs, nowMs: Date.now() }) : null;

  const stateKey = !live ? 'awaiting' : (stale?.overdue ? 'overdue' : v.state);
  const meta = STATE_META[stateKey] || STATE_META.blocked;
  const I = Icon[meta.icon] || Icon.check;

  const headline =
    !live ? 'Awaiting live run data — no run has reported yet'
    : stale?.overdue ? `Run overdue — last update ${lastRunMs ? relativeTime(lastRunMs) : 'never'}`
    : v.state === 'blocked' ? (v.gated_stage ? `Build failed — halted at ${gatedLabel}` : 'Build failed — release blocked')
    : v.state === 'flags' ? `Published with ${fmtNum(v.qc_flags)} QC flag${v.qc_flags === 1 ? '' : 's'} to review`
    : `Published & healthy — ${version} is live`;

  return (
    <div className={`verdict ${meta.cls}`}>
      <div className="verdict-head">
        <span className="verdict-ico"><I size={22} /></span>
        <div className="verdict-headline">{headline}</div>
      </div>
      <div className="verdict-rows">
        <div className="vrow-k">Status</div>
        <div className="vrow-v"><span className="vbadge">{meta.badge}</span></div>

        {live ? (
          <>
            <div className="vrow-k">Version</div>
            <div className="vrow-v mono">{version}{v.state === 'blocked' ? <span className="muted"> · not published</span> : null}</div>

            <div className="vrow-k">{run?.finishedAt ? 'Finished' : 'Status'}</div>
            <div className="vrow-v">{run?.finishedAt
              ? <>{fmtDateTime(run.finishedAt)} <span className="muted">· {relativeTime(run.finishedAt)}</span></>
              : 'in progress'}</div>

            <div className="vrow-k">Duration</div>
            <div className="vrow-v">{fmtDuration(run?.duration)}</div>

            <div className="vrow-k">Trigger</div>
            <div className="vrow-v">{run?.triggeredManually ? 'Manual dispatch' : 'Scheduled'}<span className="muted"> · {run?.actor || (run?.triggeredManually ? 'j.okafor' : 'github-actions[bot]')}</span></div>

            <div className="vrow-k">Runner</div>
            <div className="vrow-v">self-hosted · wed <span className="muted">· ap-southeast-1</span></div>

            {run?.html_url ? (
              <>
                <div className="vrow-k">Workflow run</div>
                <div className="vrow-v"><a href={run.html_url} target="_blank" rel="noreferrer" style={{ color: 'var(--blue-fg)', textDecoration: 'none' }}>View on GitHub ↗</a></div>
              </>
            ) : null}

            <div className="vrow-k">Checks</div>
            <div className="vrow-v">{fmtNum(s.sources_total)} sources · {fmtNum(s.variables_total)} variables · <b>{fmtNum(v.qc_flags)} QC flags</b></div>

            <div className="vrow-k">Data as of</div>
            <div className="vrow-v">{lastRunMs ? <>{fmtDateTime(lastRunMs)} <span className="muted">· {relativeTime(lastRunMs)}</span></> : <span className="muted">unknown</span>}</div>
          </>
        ) : (
          <>
            <div className="vrow-k">Live data</div>
            <div className="vrow-v"><span className="muted">none yet — the breakdown below is a representative example</span></div>
          </>
        )}

        <div className="vrow-k">Next run</div>
        <div className="vrow-v mono">{nextScheduledRunLabel()}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append the two new state styles** to `frontend/src/app/globals.css`:

```css
/* verdict liveness states */
.verdict.v-awaiting { border-color: var(--border-strong); background: var(--surface-2); }
.v-awaiting .verdict-ico { color: var(--text-2); }
.v-awaiting .vbadge { background: var(--gray-bg); color: var(--text-2); }
.verdict.v-overdue { border-color: var(--amber-line); background: var(--amber-bg); }
.v-overdue .verdict-ico { color: var(--amber-fg); }
.v-overdue .vbadge { background: var(--amber-bg); color: var(--amber-fg); }
```

- [ ] **Step 3: Verify via the dev server**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/pipelines/wed`
Expected: `200`. (With no Mongo, the backend serves representative → the header shows the **awaiting** state.)

If the import `@/lib/schedule.mjs` fails to resolve, retry with `@/lib/schedule` (drop the extension); confirm 200 either way.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/wed/VerdictHeader.jsx frontend/src/app/globals.css
git commit -m "feat(frontend): liveness-aware VerdictHeader (awaiting/overdue/unavailable + freshness)"
```

---

## Task 4: End-to-end verification

**Files:** none.

- [ ] **Step 1: Pure modules green**

Run: `cd frontend && npm test` (6 pass) and `cd ../backend && npm test` (11 pass).

- [ ] **Step 2: Representative path is honest**

With the backend running (no Mongo), `curl -s http://localhost:4000/api/pipelines/wed/source-health` returns `representative: true`. Confirm the page header shows **"Awaiting live run data"** (neutral), and the Source-health matrices still render the representative example below.

- [ ] **Step 3: Fail-loud check (manual reasoning ok)**

Confirm by reading `getSourceHealth`: when `config.mongoUri` is set and `getDb`/`findOne` throws, the error propagates out of the route's async wrapper (`h()` in router.js) → Express returns 500 → the frontend fetch rejects → `VerdictHeader` renders the red **"Status unavailable — backend unreachable"** state. (No live Mongo is available to exercise this end-to-end here.)

---

## Self-Review

**Spec coverage:** DB errors fail loud (Task 2 + Task 3 err branch); representative shown as distinct non-verdict `awaiting` (Task 3); overdue detection via pure `runStaleness` (Task 1) surfaced in the header (Task 3); freshness "Data as of" row (Task 3). ✅

**Placeholder scan:** none. The `j.okafor`/`github-actions[bot]` actor fallbacks and `self-hosted · wed` runner are existing representative values carried over from the prior header, not new placeholders.

**Type consistency:** `runStaleness({ lastRunMs, nowMs, graceHours })` → `{ overdue, scheduledMs, lastRunMs, ranForLatest }` (Task 1) is consumed as `stale?.overdue` (Task 3). `toMs(health.generated_at)` uses the existing `format.js` export. `nextScheduledRunLabel()` moves from VerdictHeader into `schedule.mjs` (Task 1) and is imported in Task 3. `health.representative`/`health.generated_at`/`health.summary` match the backend payload.
