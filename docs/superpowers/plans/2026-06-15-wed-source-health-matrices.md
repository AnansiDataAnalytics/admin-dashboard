# WED Source Health — Two-Matrix Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the single Source health card with two matrices — **Source processing** (per-source: Download · Clean · QC) and **Combine** (per-variable: Combine · QC) — where rows that failed a stage or carry QC flags show first, all-clear rows fold behind a "+N more" expander, and an all-clear matrix collapses to a one-liner.

**Architecture:** The backend reshapes the source-health payload from the old `stages[].groups[].sources[]` tree into flat `sources[]` (each with `download`/`clean`/`qc_flags`/`category`) and `variables[]` (each with `combine`/`qc_flags`), plus a `summary` exposing `failed` (hard failures), `qc_flags` (advisory total), and `gated_stage`. `deriveVerdict` (slice 1) already reads those summary fields, so the verdict header reacts automatically. The frontend `SourceHealth` component is rewritten to render the two matrices from the new shape.

**Tech Stack:** Node CommonJS + `node --test` (backend), Next 14 / React 18 (frontend).

**This is slice 2 of 4.** QC flags are advisory and NEVER block a release (only `summary.failed > 0` or a `gated_stage` is `blocked`).

> **Verification note:** Do NOT run `npm run build` — a local Next dev server is running on the same `.next` dir and a production build corrupts it. Verify via the dev server's own recompile (it rebuilds on save; check its log for errors) and `node --test` for the backend.

---

## New data contract (source-health payload)

```jsonc
{
  "representative": true,
  "run_id": null,
  "generated_at": null,
  "gated_stage": null,                  // 'download'|'clean'|'combine'|null (read by deriveVerdict)
  "counts": { "aggregators": 34, "country": 113, "combine": 49 },
  "summary": {
    "sources_total": 147,               // aggregators + country
    "variables_total": 49,
    "failed": 0,                        // hard download/clean/combine failures (blocks when > 0)
    "qc_flags": 9,                      // advisory QC flags total (never blocks)
    "gated_stage": null
  },
  "sources":   [ { "name": "BRA_2", "category": "country", "download": "passed", "clean": "passed", "qc_flags": 4 }, ... ],
  "variables": [ { "name": "REER", "combine": "passed", "qc_flags": 1 }, ... ],
  "verdict": { ... }                    // attached by getSourceHealth via deriveVerdict (unchanged)
}
```

Stage status values: `'passed' | 'failed' | 'not_reached'`. A row is "needs attention" iff any stage is `'failed'` OR `qc_flags > 0`.

---

## Task 1: Reshape the backend source-health manifest (TDD)

**Files:**
- Modify: `backend/src/domains/pipelines/sourceHealth.js`
- Create: `backend/src/domains/pipelines/sourceHealth.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/src/domains/pipelines/sourceHealth.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { representativeManifest } = require('./sourceHealth');
const { deriveVerdict } = require('./verdict');

test('manifest exposes flat sources[] and variables[] with the new fields', () => {
  const m = representativeManifest();
  assert.ok(Array.isArray(m.sources) && m.sources.length > 0);
  assert.ok(Array.isArray(m.variables) && m.variables.length > 0);
  const s = m.sources[0];
  assert.ok('download' in s && 'clean' in s && 'qc_flags' in s && 'category' in s);
  const v = m.variables[0];
  assert.ok('combine' in v && 'qc_flags' in v);
});

test('summary totals and qc_flags are consistent with the rows', () => {
  const m = representativeManifest();
  assert.equal(m.summary.sources_total, m.counts.aggregators + m.counts.country);
  assert.equal(m.summary.variables_total, m.counts.combine);
  const flagSum =
    m.sources.reduce((a, s) => a + s.qc_flags, 0) +
    m.variables.reduce((a, v) => a + v.qc_flags, 0);
  assert.equal(m.summary.qc_flags, flagSum);
});

test('representative case is advisory-only: no hard failure, so verdict is flags', () => {
  const m = representativeManifest();
  assert.equal(m.summary.failed, 0);
  assert.ok(m.summary.qc_flags > 0);
  assert.equal(deriveVerdict(m).state, 'flags');
});

test('verdict is blocked when a hard failure is present', () => {
  const m = representativeManifest();
  m.summary.failed = 1;
  assert.equal(deriveVerdict(m).state, 'blocked');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — the current `representativeManifest` has `stages`, not `sources`/`variables`, so the new assertions fail.

- [ ] **Step 3: Rewrite the manifest**

In `backend/src/domains/pipelines/sourceHealth.js`, replace the block from the `AGGREGATORS`/`COUNTRY`/`COMBINE` constants through the end of `representativeManifest()` (i.e. the constants, `COUNTS`, `asSources`, and the old `representativeManifest`) with this. **Leave `getSourceHealth` and `module.exports` unchanged**, and keep the file's top requires (including `const { deriveVerdict } = require('./verdict');` added in slice 1).

```js
// Exact category counts; names are a representative sample (the live grid is
// generated wholesale from build_log_report.json each run, so we deliberately do
// NOT maintain the full 196-name list here).
const COUNTS = { aggregators: 34, country: 113, combine: 49 };

function src(name, category, qc_flags = 0, over = {}) {
  return { name, category, download: 'passed', clean: 'passed', qc_flags, ...over };
}
function vbl(name, qc_flags = 0, over = {}) {
  return { name, combine: 'passed', qc_flags, ...over };
}

// Representative manifest in the two-matrix shape. Illustrates the common
// "published with advisory QC flags" case: no hard download/clean/combine
// failure (so the release ships), but a handful of deterministic QC flags to
// review. QC is advisory and never blocks (see verdict.js). A few clean sample
// rows are included so expanding "+N more" reveals real rows in the demo.
function representativeManifest() {
  const sources = [
    src('BRA_2', 'country', 4),
    src('OECD_EO', 'aggregator', 3),
    src('NGA_1', 'country', 1),
    src('IMF_IFS', 'aggregator'),
    src('IMF_WEO', 'aggregator'),
    src('AUS_6', 'country'),
    src('DEU_7', 'country'),
    src('FRA_1', 'country'),
  ];
  const variables = [
    vbl('REER', 1),
    vbl('CPI'),
    vbl('nGDP'),
    vbl('unemp'),
  ];
  const sources_total = COUNTS.aggregators + COUNTS.country;
  const variables_total = COUNTS.combine;
  const qc_flags =
    sources.reduce((a, s) => a + s.qc_flags, 0) +
    variables.reduce((a, v) => a + v.qc_flags, 0);
  return {
    representative: true,
    run_id: null,
    generated_at: null,
    gated_stage: null,
    counts: COUNTS,
    summary: { sources_total, variables_total, failed: 0, qc_flags, gated_stage: null },
    sources,
    variables,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npm test`
Expected: PASS — the verdict tests (8) plus the 4 new source-health tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/domains/pipelines/sourceHealth.js backend/src/domains/pipelines/sourceHealth.test.js
git commit -m "feat(backend): reshape source-health to per-source/per-variable matrices"
```

---

## Task 2: Rewrite SourceHealth into two matrices + styles + verdict Checks line

**Files:**
- Rewrite: `frontend/src/components/wed/SourceHealth.jsx`
- Modify: `frontend/src/app/globals.css` (append matrix styles)
- Modify: `frontend/src/components/wed/VerdictHeader.jsx` (Checks row → new summary fields)

- [ ] **Step 1: Rewrite the component**

Replace the ENTIRE contents of `frontend/src/components/wed/SourceHealth.jsx` with:

```jsx
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
```

- [ ] **Step 2: Append the matrix styles to `frontend/src/app/globals.css`**

```css
/* ── Source-health matrices (Source processing · Combine) ── */
.mx { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); margin-bottom: 12px; overflow: hidden; }
.mx:last-child { margin-bottom: 0; }
.mx-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 14px; background: none; border: none; color: var(--text); font-family: var(--font-ui); cursor: pointer; text-align: left; }
.mx-head:hover { background: var(--surface-2); }
.mx-chev { display: inline-grid; place-items: center; color: var(--text-3); transition: transform .14s; }
.mx-chev[data-open="true"] { transform: rotate(90deg); }
.mx-title { font-size: 13px; font-weight: 700; flex: 1; min-width: 0; }
.mx-sub { font-weight: 400; color: var(--text-3); }
.mx-meta { font-size: 11.5px; color: var(--text-3); font-family: var(--font-mono); white-space: nowrap; }
.mx-colhead { display: grid; gap: 8px; padding: 4px 14px 6px; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-3); border-top: 1px solid var(--border); }
.mx-col { text-align: center; }
.mx-row { display: grid; gap: 8px; align-items: center; padding: 8px 14px; border-top: 1px solid var(--border); font-size: 12.5px; }
.mx-name { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--text); }
.mx-name.muted { color: var(--text-3); }
.mx-tag { font-size: 10px; color: var(--text-3); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; white-space: nowrap; }
.mx-cell { text-align: center; font-size: 12px; font-family: var(--font-mono); }
.mx-ok { color: var(--green-fg); }
.mx-failed { color: var(--red-fg); display: inline-grid; place-items: center; }
.mx-flag { color: var(--amber-fg); }
.mx-skip { color: var(--text-3); }
.mx-more { width: 100%; text-align: center; border: none; border-top: 1px solid var(--border); background: var(--surface-inset); color: var(--text-2); font-size: 11.5px; padding: 9px; cursor: pointer; font-family: var(--font-ui); }
.mx-more:hover { background: var(--surface-2); }
```

- [ ] **Step 3: Update the VerdictHeader "Checks" row** to the new summary fields.

In `frontend/src/components/wed/VerdictHeader.jsx`, find:

```jsx
        <div className="vrow-k">Checks</div>
        <div className="vrow-v">{fmtNum(s.passed)} / {fmtNum(s.total)} source scripts clean · <b>{fmtNum(v.qc_flags)} QC flags</b></div>
```

Replace with:

```jsx
        <div className="vrow-k">Checks</div>
        <div className="vrow-v">{fmtNum(s.sources_total)} sources · {fmtNum(s.variables_total)} variables · <b>{fmtNum(v.qc_flags)} QC flags</b></div>
```

- [ ] **Step 4: Verify via the running dev server (do NOT run `npm run build`)**

The dev server recompiles on save. Confirm a clean compile and a 200:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/pipelines/wed
```
Expected: `200`. Then check the dev server's log file for the most recent `✓ Compiled /pipelines/wed` with no error lines. If the dev server isn't running, start it: `cd frontend && PORT=3000 npx next dev` (background) and re-check.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/wed/SourceHealth.jsx frontend/src/app/globals.css frontend/src/components/wed/VerdictHeader.jsx
git commit -m "feat(frontend): source-health two-matrix redesign (Download/Clean/QC + Combine/QC)"
```

---

## Task 3: End-to-end verification

**Files:** none.

- [ ] **Step 1: Backend payload check**

With the backend running (`http://localhost:4000`), run:
```bash
curl -s http://localhost:4000/api/pipelines/wed/source-health | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('verdict:',j.verdict.state);console.log('sources:',j.sources.length,'variables:',j.variables.length);console.log('summary:',JSON.stringify(j.summary));})"
```
Expected: `verdict: flags`, a non-empty `sources`/`variables`, and a summary with `failed: 0`, `qc_flags: 9`.

- [ ] **Step 2: Visual check (user)**

Open `http://localhost:3000/pipelines/wed`. Confirm:
- The verdict header shows the amber **"Published with 9 QC flags to review"** state (advisory, not red).
- The **Source processing** matrix lists the 3 flagged sources (BRA_2 · OECD_EO · NGA_1) first with their QC flag counts, columns Download · Clean · QC flags, a "+N more — all clear" expander, and aggregator/country tags.
- The **Combine** matrix lists REER (1 flag) with columns Combine · QC flags and a "+N more" expander.
- Clicking a matrix header expands all rows; clicking "+N more" reveals the clean rows.

---

## Self-Review

**Spec coverage (slice 2):** two matrices source-by-source / variable-by-variable (Task 2); Download·Clean·QC and Combine·QC columns (Task 1 shape + Task 2 render); QC as a flag count, advisory/non-blocking (Task 1 `summary.failed=0` → verdict `flags`; Task 2 `QcCell`); failures/flags-first with "+N more" and all-clear collapse and clickable headers (Task 2 `Matrix`); aggregator/country as a light tag (Task 2 `mx-tag`). ✅ Coverage diff / runs strip are slices 3–4 (out of scope). ✅

**Placeholder scan:** none. The representative sample (8 sources / 4 variables vs. totals 147/49) is intentional — live runs post the full set; the "+N more" count comes from `summary.*_total`.

**Type consistency:** backend rows `{ name, category, download, clean, qc_flags }` / `{ name, combine, qc_flags }` (Task 1) are exactly what `Matrix` reads via `stageKeys` + `qc_flags` (Task 2). `summary.{sources_total,variables_total,failed,qc_flags,gated_stage}` (Task 1) match `VerdictHeader` (Task 2 Step 3) and `deriveVerdict` (slice 1). `gated_stage` is at top level for `deriveVerdict`. Consistent.
