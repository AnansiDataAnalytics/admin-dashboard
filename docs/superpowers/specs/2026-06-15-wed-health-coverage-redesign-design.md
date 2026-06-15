# WED Dashboard — Health & Coverage Redesign

**Date:** 2026-06-15
**Status:** Design approved, pending implementation plan
**Scope:** The top of the WED pipeline page (`frontend/src/app/pipelines/wed/page.jsx`)
and the `SourceHealth` component, plus supporting backend data.

## Goal

Make the WED pipeline page something an operator can **walk up to and feel at ease**.
At a glance they should know:

1. **When** the last build ran (and how long it took).
2. **Whether recent runs worked** — a short history, not just the latest.
3. **The current status** — in plain words, with no internal contradiction.
4. **Whether the data passed its tests** — not merely that the pipeline executed.

This redesign also resolves a concrete bug in the current UI: the hero says
"Latest build succeeded" (green) while Source health simultaneously reports the
build never reached the combine stage. The two are driven by independent sources
that never reconcile (see *Verdict reconciliation* below).

## Background — current state

- The hero (`RunView` → `RunHero`) derives its status from a **run object**. Until
  live telemetry exists, that object comes from `buildRepresentativeRun()` in
  `frontend/src/lib/pipelineModel.js`, which is **hard-coded to `state: 'success'`**.
- `SourceHealth` independently calls `GET /pipelines/wed/source-health`, served by
  `backend/src/domains/pipelines/sourceHealth.js`, whose representative manifest
  shows a failure and a gated stage.
- Result: the green hero and the failing source health contradict each other.
- Existing release/diff data (real, live): `releases` and `changes` collections via
  `wed.service.js`. The **Release ledger** table and **"What changed"** panel already
  show **cell-level** deltas (`points_seen` ≈ cells, inserts, revisions,
  discontinuations, source changes). These stay.

## What's new vs. what already exists

| Concern | Today | This redesign |
|---|---|---|
| Cell-level diff (inserts/revisions/disc) | ✅ Ledger + "What changed" | unchanged |
| Coverage shape (variables/countries/periods/observations) | ❌ not computed | **new** — top strip + added to "What changed" |
| Per-source status | download + combine stages, pass/fail/missing | **Download · Clean · QC** per source |
| Per-variable status | combine stage only | **Combine · QC** per variable |
| Quality control | not surfaced | **new** advisory test stage (flag counts) |
| Run history | none (single latest run) | **new** clickable recent-runs strip |
| Top-level verdict | always-green representative; contradicts source health | **reconciled** to real execution truth |

## Design

The page top, in order: **Verdict header → Coverage strip → Recent-runs strip →
Source processing matrix → Combine matrix**. Then the existing live release section
(ledger, "What changed", source breakdown, change explorer) continues below.

### 1. Verdict header

Replaces the contradictory green hero. A single status block with a headline and
**labeled rows** (not a dot-separated sentence): Status · Version · Finished ·
Duration · Checks · Next run.

Three states:

- 🟢 **Published & healthy** — build ran, release published, **0 QC flags**.
- 🟡 **Published · review flags** — build ran and **published**, but QC raised one or
  more flags. **QC is advisory and never blocks a release.** Flags are a to-do.
- 🔴 **Failed (blocked)** — a hard pipeline error in download / clean / combine aborted
  the build. Nothing published. This is the only state that stops a release.

### 2. Verdict reconciliation (the bug fix)

The verdict must be derived from **real execution truth**, not an independent
always-success sample:

- **Blocked (red)** iff any download/clean/combine stage hard-failed (a script
  errored / the build aborted). Reuse the existing hard-abort + `gated_stage`
  signal from `sourceHealth.js`.
- **Review flags (amber)** iff no hard failure but QC flag count > 0.
- **Healthy (green)** otherwise.

When only representative data is available, the representative run and the
representative source-health manifest must tell the **same** story (both healthy,
or both showing the same failure) so the page never contradicts itself.

### 3. Coverage strip (top, glanceable)

A compact horizontal strip directly under the verdict: **Observations · Variables ·
Countries · Time periods · Sources**, each with a delta vs the previous release
(green = increase, red = decrease, muted = unchanged). This is the at-a-glance read;
the same dimensions also appear in the "What changed" panel (per decision C below).

These counts are **newly computed** — they are not in `change_summary` today.

### 4. Recent-runs strip

A row of ~12 most-recent weekly builds as colored ticks:

- green = published · amber = published with QC flags · red = failed (blocked)
- newest highlighted and dated; **each tick is clickable** to load that run's full
  breakdown; hover previews (date · outcome · flag count).

### 5. Source health → two matrices

The single Source health card becomes **two matrices**, because the unit of work
differs:

**Source processing** — *source by source* (fetch + clean happen per source):
- Columns: **Download · Clean · QC flags**
- Rows: sources. Aggregator vs country is a **light tag**, not a heavy hierarchy.

**Combine** — *variable by variable* (chain-linking is per variable):
- Columns: **Combine · QC flags**
- Rows: variables (CPI, nGDP, …) — a different entity set from sources.

Shared matrix behavior:

- **Failures/flags first.** By default only rows that are red (hard fail) or carry QC
  flags are shown. Clean rows fold behind a clickable **"+N more"** expander.
- **All-green collapses** to a one-line summary row (e.g. `147 ● · 0 ⚑`).
- **Section headers are clickable** to expand/collapse all underlying rows.
- **QC is a count** of deterministic flags per series (e.g. `4 ⚑`), not a single
  pass/fail mark — one series can trip several checks. QC is advisory (amber), and a
  hard download/clean/combine failure is red.

### 6. "What changed" panel — extended

Add the coverage dimensions (variables / countries / time periods, alongside the
existing observation/cell counts) into the existing "What changed" panel, so the full
breakdown lives next to the cell-level diff. (Decision C: top strip is glanceable,
full breakdown stays here.)

## Backend implications

The UI needs data that does not fully exist yet. The implementation plan must cover:

1. **Per-source / per-variable status incl. QC.** Extend the source-health payload so
   each source carries `download`, `clean`, and `qc` (flag count + which checks), and
   each variable carries `combine` and `qc`. Today `sourceHealth.js` emits only
   download + combine stages with pass/fail/missing and no QC.
2. **Run history.** A list of recent runs with status, timestamps, duration, and flag
   counts. `runs.service.js` / the `pipeline_runs` collection is the source.
3. **Per-release coverage counts + diff.** Observations, variables, countries, time
   periods per release, plus the delta vs the previous release.
4. **Verdict source.** A single derivation of blocked / review-flags / healthy from
   the real run + source-health signals, used by both the header and the history strip.

Each of these keeps the existing **representative-until-live** pattern: ship a
representative manifest so the UI shape is visible before the first live run posts
real data, clearly labeled as representative.

## Out of scope

- The lower live release section (ledger, source breakdown, change explorer) keeps its
  current behavior, except for the "What changed" coverage addition.
- Server-side enforcement of QC/promotion gates (the existing advisory gate note
  already defers this to a later phase).
- No changes to the ingestion pipeline itself; this dashboard remains read-only.

## Open questions / assumptions

- **Time periods** rendered as a span (e.g. `1960–2026`) with the delta as added
  periods; confirm preferred unit (quarters vs years) during implementation.
- Exact QC check catalogue (outlier / gap / stale / >Nσ jump …) is illustrative here;
  the live grid is generated from the pipeline's QC report, not maintained in the UI.
