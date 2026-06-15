# WED Verdict Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the contradictory always-green run hero with a single status header whose verdict is derived from real execution truth (the source-health payload), so the page can never say "succeeded" while source health says the build failed.

**Architecture:** A pure `deriveVerdict()` function (CommonJS, in the backend) computes one of three states — `healthy` / `flags` / `blocked` — from a source-health manifest. It's attached to the existing `GET /pipelines/wed/source-health` payload as `verdict`. The frontend renders a new `VerdictHeader` component from that payload plus the run's timing, and the old `RunHero` is removed from `RunView`.

**Tech Stack:** Node.js (CommonJS backend, Express), Node's built-in `node --test` runner (zero new dependencies), Next.js 14 / React 18 (frontend, ESM).

**This is slice 1 of 4** (verdict · source-health matrices · runs strip · coverage diff). It is self-contained and shippable on its own.

---

## File Structure

- **Create** `backend/src/domains/pipelines/verdict.js` — pure verdict derivation (one responsibility: manifest → verdict).
- **Create** `backend/src/domains/pipelines/verdict.test.js` — `node --test` unit tests for the above.
- **Modify** `backend/src/domains/pipelines/sourceHealth.js` — attach `verdict` to the served payload.
- **Modify** `backend/package.json` — add a `test` script.
- **Create** `frontend/src/components/wed/VerdictHeader.jsx` — the status header UI.
- **Modify** `frontend/src/app/globals.css` — `.verdict` styles.
- **Modify** `frontend/src/app/pipelines/wed/page.jsx` — render `VerdictHeader`.
- **Modify** `frontend/src/components/wed/RunView.jsx` — remove the old `RunHero`.

Verdict semantics (locked from the spec):
- **blocked** — a hard download/clean/combine failure aborted the build (`summary.failed > 0` **or** `gated_stage` set). Nothing published. The only release-stopping state.
- **flags** — no hard failure, but advisory `qc_flags > 0`. Build published; flags are a to-do. QC never blocks.
- **healthy** — published, no flags.

> Note: the source-health payload does not carry `qc_flags` yet (that arrives in slice 2). `deriveVerdict` reads `summary.qc_flags` defaulting to `0`, so today it resolves to `healthy`/`blocked` only, and `flags` lights up automatically once slice 2 populates the field. This is intentional forward-compatibility, not a placeholder.

---

## Task 1: Backend verdict derivation (pure, TDD)

**Files:**
- Create: `backend/src/domains/pipelines/verdict.js`
- Test: `backend/src/domains/pipelines/verdict.test.js`
- Modify: `backend/package.json`

- [ ] **Step 1: Add the test script to `backend/package.json`**

In `backend/package.json`, change the `"scripts"` block from:

```json
  "scripts": {
    "dev": "nodemon src/server.js",
    "start": "node src/server.js"
  },
```

to:

```json
  "scripts": {
    "dev": "nodemon src/server.js",
    "start": "node src/server.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/domains/pipelines/verdict.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveVerdict } = require('./verdict');

test('healthy when nothing failed, nothing gated, no flags', () => {
  const v = deriveVerdict({ summary: { total: 196, passed: 196, failed: 0 } });
  assert.equal(v.state, 'healthy');
  assert.equal(v.hard_failures, 0);
  assert.equal(v.qc_flags, 0);
  assert.equal(v.gated_stage, null);
});

test('blocked when a source hard-failed', () => {
  const v = deriveVerdict({ summary: { total: 196, passed: 195, failed: 1 } });
  assert.equal(v.state, 'blocked');
  assert.equal(v.hard_failures, 1);
});

test('blocked when a stage gated even with zero failed count', () => {
  const v = deriveVerdict({ summary: { total: 196, passed: 196, failed: 0 }, gated_stage: 'clean' });
  assert.equal(v.state, 'blocked');
  assert.equal(v.gated_stage, 'clean');
});

test('flags when no hard failure but QC raised flags', () => {
  const v = deriveVerdict({ summary: { total: 196, passed: 196, failed: 0, qc_flags: 9 } });
  assert.equal(v.state, 'flags');
  assert.equal(v.qc_flags, 9);
});

test('hard failure outranks QC flags', () => {
  const v = deriveVerdict({ summary: { total: 196, passed: 195, failed: 1, qc_flags: 9 } });
  assert.equal(v.state, 'blocked');
});

test('missing manifest is treated as blocked, not healthy', () => {
  const v = deriveVerdict(null);
  assert.equal(v.state, 'blocked');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — `Cannot find module './verdict'`.

- [ ] **Step 4: Write the minimal implementation**

Create `backend/src/domains/pipelines/verdict.js`:

```js
// Derive the single operator-facing verdict for a WED build from a source-health
// manifest. One of three states:
//   blocked  — a hard download/clean/combine failure aborted the build (a failed
//              source or a gated stage). Nothing published. The ONLY state that
//              stops a release.
//   flags    — built & published, but advisory QC raised flags to review. QC is
//              advisory and never blocks.
//   healthy  — published, no flags.
// Pure: same manifest in → same verdict out. No I/O.
function deriveVerdict(health) {
  if (!health || !health.summary) {
    return { state: 'blocked', hard_failures: 0, qc_flags: 0, gated_stage: null };
  }
  const hardFailures = Number(health.summary.failed) || 0;
  const gated = health.gated_stage || null;
  const qcFlags = Number(health.summary.qc_flags) || 0;
  let state;
  if (hardFailures > 0 || gated) state = 'blocked';
  else if (qcFlags > 0) state = 'flags';
  else state = 'healthy';
  return { state, hard_failures: hardFailures, qc_flags: qcFlags, gated_stage: gated };
}

module.exports = { deriveVerdict };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS — 6 tests passing.

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/src/domains/pipelines/verdict.js backend/src/domains/pipelines/verdict.test.js
git commit -m "feat(backend): derive WED build verdict from source health"
```

---

## Task 2: Attach the verdict to the source-health payload

**Files:**
- Modify: `backend/src/domains/pipelines/sourceHealth.js`

- [ ] **Step 1: Import `deriveVerdict`**

In `backend/src/domains/pipelines/sourceHealth.js`, just below the existing requires:

```js
const { getDb } = require('../../shared/db');
const { config } = require('../../shared/config');
```

add:

```js
const { deriveVerdict } = require('./verdict');
```

- [ ] **Step 2: Compute and attach `verdict` in `getSourceHealth`**

Replace the entire `getSourceHealth` function body with this version (which resolves the manifest into a single `result`, then attaches the verdict to whichever path produced it):

```js
async function getSourceHealth() {
  let result = null;
  try {
    const db = await getDb(config.metaDb);
    const run = await db.collection('pipeline_runs').findOne(
      { source_health: { $exists: true } },
      { projection: { _id: 0, run_id: 1, source_health: 1, updated_at: 1 }, sort: { updated_at: -1 } },
    );
    if (run && run.source_health) {
      result = { representative: false, run_id: run.run_id, generated_at: run.updated_at || null, ...run.source_health };
    }
  } catch {
    // fall through to the representative manifest
  }
  if (!result) result = representativeManifest();
  result.verdict = deriveVerdict(result);
  return result;
}
```

- [ ] **Step 3: Verify the endpoint returns a verdict**

The representative manifest has `summary.failed === 1`, so its verdict must be `blocked`. Verify the wiring with a one-off Node check (no server needed):

Run:
```bash
cd backend && node -e "require('./src/domains/pipelines/sourceHealth').representativeManifest && require('./src/domains/pipelines/verdict').deriveVerdict(require('./src/domains/pipelines/sourceHealth').representativeManifest()).state" \
  && node -e "const {representativeManifest}=require('./src/domains/pipelines/sourceHealth');const {deriveVerdict}=require('./src/domains/pipelines/verdict');console.log(deriveVerdict(representativeManifest()).state)"
```
Expected: prints `blocked`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/domains/pipelines/sourceHealth.js
git commit -m "feat(backend): include derived verdict in source-health payload"
```

---

## Task 3: VerdictHeader component + styles

**Files:**
- Create: `frontend/src/components/wed/VerdictHeader.jsx`
- Modify: `frontend/src/app/globals.css`

- [ ] **Step 1: Create the component**

Create `frontend/src/components/wed/VerdictHeader.jsx`:

```jsx
'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { fmtNum, fmtDuration, fmtDateTime, relativeTime } from '@/lib/format';

// The single operator-facing verdict, reconciled to real execution truth: the
// source-health payload now carries a derived `verdict`. Replaces the old
// always-green RunHero that contradicted source health. `signal` bumps on every
// page refresh (manual button or SSE push) so this re-pulls in step with the
// rest of the page instead of polling.
const STAGE_LABEL = { download: 'Download', clean: 'Clean', combine: 'Combine' };
const STATE_META = {
  healthy: { cls: 'v-healthy', icon: 'check', badge: 'Published' },
  flags:   { cls: 'v-flags',   icon: 'alert', badge: 'Published · review flags' },
  blocked: { cls: 'v-blocked', icon: 'x',     badge: 'Failed' },
};

export default function VerdictHeader({ run, signal = 0 }) {
  const [health, setHealth] = useState(null);
  useEffect(() => {
    let alive = true;
    api.wedSourceHealth().then((d) => { if (alive) setHealth(d); }).catch(() => {});
    return () => { alive = false; };
  }, [signal]);

  if (!health) {
    return (
      <div className="verdict v-loading">
        <div className="verdict-head">
          <span className="verdict-ico"><Icon.repeat size={20} /></span>
          <div className="verdict-headline">Loading build status…</div>
        </div>
      </div>
    );
  }

  const v = health.verdict || { state: 'healthy', qc_flags: 0, gated_stage: null };
  const meta = STATE_META[v.state] || STATE_META.healthy;
  const I = Icon[meta.icon] || Icon.check;
  const s = health.summary || {};
  const version = run?.version || '—';
  const gatedLabel = STAGE_LABEL[v.gated_stage] || v.gated_stage;

  const headline =
    v.state === 'blocked'
      ? (v.gated_stage ? `Build failed — halted at ${gatedLabel}` : 'Build failed — release blocked')
      : v.state === 'flags'
        ? `Published with ${fmtNum(v.qc_flags)} QC flag${v.qc_flags === 1 ? '' : 's'} to review`
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

        <div className="vrow-k">Version</div>
        <div className="vrow-v mono">{version}{v.state === 'blocked' ? <span className="muted"> · not published</span> : null}</div>

        <div className="vrow-k">{run?.finishedAt ? 'Finished' : 'Status'}</div>
        <div className="vrow-v">{run?.finishedAt
          ? <>{fmtDateTime(run.finishedAt)} <span className="muted">· {relativeTime(run.finishedAt)}</span></>
          : 'in progress'}</div>

        <div className="vrow-k">Duration</div>
        <div className="vrow-v">{fmtDuration(run?.duration)}</div>

        <div className="vrow-k">Checks</div>
        <div className="vrow-v">{fmtNum(s.passed)} / {fmtNum(s.total)} source scripts clean · <b>{fmtNum(v.qc_flags)} QC flags</b></div>

        <div className="vrow-k">Next run</div>
        <div className="vrow-v mono">weekly · Wed 02:00</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the styles**

Append to `frontend/src/app/globals.css`:

```css
/* ── Verdict header — one reconciled build status (replaces RunHero) ── */
.verdict { border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; margin-bottom: 14px; background: var(--surface); }
.verdict.v-healthy { border-color: var(--green-line); background: var(--green-bg); }
.verdict.v-flags   { border-color: var(--amber-line); background: var(--amber-bg); }
.verdict.v-blocked { border-color: var(--red-line);   background: var(--red-bg); }
.verdict-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.verdict-ico { display: inline-flex; color: var(--text-2); }
.v-healthy .verdict-ico { color: var(--green-fg); }
.v-flags .verdict-ico   { color: var(--amber-fg); }
.v-blocked .verdict-ico { color: var(--red-fg); }
.verdict-headline { font-size: 15px; font-weight: 600; color: var(--text); }
.verdict-rows { display: grid; grid-template-columns: 120px 1fr; font-size: 12.5px; }
.verdict-rows > div { padding: 6px 0; border-top: 1px solid var(--border); }
.verdict-rows > div:nth-last-child(-n+2) { border-bottom: 1px solid var(--border); }
.verdict-rows .vrow-k { color: var(--text-3); }
.verdict-rows .vrow-v { color: var(--text); }
.verdict-rows .vrow-v .muted { color: var(--text-3); }
.vbadge { display: inline-block; background: var(--gray-bg); border-radius: 6px; padding: 2px 9px; font-size: 11px; color: var(--text-2); }
.v-healthy .vbadge { background: var(--green-bg); color: var(--green-fg); }
.v-flags .vbadge   { background: var(--amber-bg); color: var(--amber-fg); }
.v-blocked .vbadge { background: var(--red-bg);   color: var(--red-fg); }
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/wed/VerdictHeader.jsx frontend/src/app/globals.css
git commit -m "feat(frontend): VerdictHeader component + styles"
```

---

## Task 4: Wire VerdictHeader into the page; remove the old hero

**Files:**
- Modify: `frontend/src/app/pipelines/wed/page.jsx`
- Modify: `frontend/src/components/wed/RunView.jsx`

- [ ] **Step 1: Import VerdictHeader in the page**

In `frontend/src/app/pipelines/wed/page.jsx`, below the existing `RunView` import:

```jsx
import RunView from '@/components/wed/RunView';
```

add:

```jsx
import VerdictHeader from '@/components/wed/VerdictHeader';
```

- [ ] **Step 2: Render VerdictHeader above the run section**

In the same file, find this block:

```jsx
      {/* ── Workflow run — front and center ── */}
      {!realRun && (
        <div className="preview-banner">
```

Insert the header immediately before that comment, so it reads:

```jsx
      <VerdictHeader run={run} signal={tick} />

      {/* ── Workflow run — front and center ── */}
      {!realRun && (
        <div className="preview-banner">
```

- [ ] **Step 3: Remove the `<RunHero>` render from RunView**

In `frontend/src/components/wed/RunView.jsx`, find the `RunView` component's return and remove the hero line. Change:

```jsx
  return (
    <>
      <RunHero run={run} />
      <RunMetrics run={run} />
```

to:

```jsx
  return (
    <>
      <RunMetrics run={run} />
```

- [ ] **Step 4: Delete the now-unused `RunHero` function**

In the same file, delete the entire `RunHero` function definition (the whole block starting at `function RunHero({ run }) {` and ending at its closing `}` before `function RunMetrics`). This removes dead code so there is exactly one verdict on the page.

- [ ] **Step 5: Verify lint and build pass**

Run: `cd frontend && npm run lint && npm run build`
Expected: lint clean; build completes with no "RunHero is not defined" or unused-var errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/pipelines/wed/page.jsx frontend/src/components/wed/RunView.jsx
git commit -m "feat(frontend): show VerdictHeader, remove contradictory RunHero"
```

---

## Task 5: Manual end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Start backend and frontend**

Run (two terminals, from repo root):
```bash
npm run dev:backend     # http://localhost:4000  (needs backend/.env → MONGODB_URI, WED_DB)
npm run dev:frontend    # http://localhost:3000
```

If no Mongo is configured, the source-health endpoint still returns the **representative** manifest, which is enough to verify the verdict UI.

- [ ] **Step 2: Confirm the contradiction is gone**

Open `http://localhost:3000/pipelines/wed`. Confirm:
- The top shows a single **VerdictHeader**. With representative data (one illustrative failure) it renders the **red "Build failed"** state with labeled rows (Status / Version / Finished / Duration / Checks / Next run).
- The old green "Latest build succeeded" hero is **gone** (RunView now starts at the metrics row).
- The Source health card lower down still shows its failure — and now **agrees** with the header.

- [ ] **Step 3: Confirm the raw verdict over HTTP**

Run: `curl -s http://localhost:4000/api/pipelines/wed/source-health | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).verdict))"`
Expected: prints a verdict object with `state: 'blocked'` for the representative manifest.

- [ ] **Step 4: Final commit (if any verification tweaks were needed)**

```bash
git add -A && git commit -m "chore: verdict reconciliation slice verified" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage (slice 1 scope):**
- Verdict header replacing the green hero → Tasks 3, 4. ✅
- Three states (healthy/flags/blocked), labeled rows → Task 3. ✅
- Verdict reconciliation derived from real execution truth, QC non-blocking → Tasks 1, 2. ✅
- Coverage strip / runs strip / two-matrix source health → **out of scope for this slice** (slices 2–4), called out above. ✅ (intentional)

**Placeholder scan:** No TBD/TODO. The `qc_flags`-defaults-to-0 note is forward-compatibility with a real downstream task (slice 2), not a placeholder — `deriveVerdict` is fully implemented and tested for it.

**Type consistency:** `deriveVerdict` returns `{ state, hard_failures, qc_flags, gated_stage }` (Task 1), attached as `result.verdict` (Task 2), read by `VerdictHeader` as `health.verdict.{state,qc_flags,gated_stage}` (Task 3). `health.summary.{passed,total}` matches the existing manifest shape in `sourceHealth.js`. Component prop `run` uses `run.{version,finishedAt,duration}`, which match the run object from `pipelineModel.js`. Consistent.
