# WED clean & combine health — make per-item status real (live + final)

**Status:** investigated + design verified (adversarially). Implementation NOT started — decisions pending (see §6).
**Repos:** WED pipeline (`C:/Users/ASUS/Desktop/GITHUB/WED`, most changes) + admin-dashboard (1 small change, the consumer).
**Origin:** the Source-health card showed `Clean 0/164 · 164 not reached` and `Combine 0/52 · 52 not reached` on the **first full successful run** (`28033234896`), even though clean & combine actually ran. Goal: emit **real** per-source clean and per-variable combine status, **both live (heartbeat) and final (manifest)**, harmonized with how download is already tracked — so the dashboard shows the truth instead of inferring from the run outcome.

---

## 1. TL;DR

- **Download** health is real per-source (read from `download_status.csv`). **Clean** is faked (hardcoded inference, never read) and **combine** gets clobbered to empty by a two-wave bug. The heartbeat also goes stale before combine finishes.
- All the signals we need **already exist on disk** (`clean_status.csv`, `combine_status.csv`, written by the same `_run_wrapper.do` mechanism as download). The fix is mostly *reading files we already write*, not new instrumentation.
- The manifest/heartbeat **schema does not change** — the dashboard already renders clean/combine columns + all four status values; they just receive `not_reached` today.
- Fully feasible for the **~340 parallel fan-out** clean sources; **partial** for 7 in-process producers + 76 Mitchell files (they write no status row → honest `not_reached`/unknown unless we add a small Stata edit).

---

## 2. Root causes (verified against the code)

### 2.1 Clean is never read — it's inferred and discarded
- `ops/build_source_health.py:143` hardcodes `clean = "passed" if (combine_ran and download in passed/fallback) else "not_reached"`. It defines **no** `--clean-status` arg, has **no** clean reader, and `_classify()` (`:51-62`) drops `/clean/` paths.
- The real signal exists: `0_master.do:280` runs the clean fan-out with `WED_STAGE=clean`; `run_stata_parallel.sh:37,46` + `_run_wrapper.do:55-82` write `data/tempfiles/clean_status.csv` (one `status,rc,file,timestamp` row per worker, OK/ERROR) — **identical** to download/combine. `wed.yml:677` even archives it.
- The build step (`wed.yml:475-480`) is invoked with only `--download-status / --combine-status / --download-failures` — **never** `--clean-status`.
- Consequence: clean can structurally only ever be `passed`/`not_reached` (docstring `:16` even admits "no failed state"). On `28033234896` it was `not_reached` because `combine_ran` was false (see 2.2).

### 2.2 Combine is clobbered to empty on a full run
- Per-variable combine status **is** real in the builder (`build_source_health.py:157-165`, reads `combine_status.csv`). But the two-wave combine destroys the CSV:
  - `run_stata_parallel.sh:46` **unconditionally** truncates `${WED_STAGE}_status.csv` (`echo header > …`) at the start of each wave.
  - Wave 2 filter (`0_master.do:344-345`): `regexm(file,'^cgov'|'^gen_gov')` **AND NOT** `regexm('_GDP\.do$')`. **Every** `cgov*/gen_gov*` file in `code/combine/Final_vars/` ends in `_GDP.do`, so wave 2 matches **ZERO** files — but still runs the parallel runner, which truncates the CSV, and with 0 input files the read loop never executes → `combine_status.csv` ends **header-only**.
- Consequence: on a full success run, all 52 variables read `not_reached`. (NOTE: this also means `cgov*/gen_gov*` variables may not be running in wave 2 at all — possibly a separate WED logic bug; see §6.4.)
- Also: `nGDP_USDfx_CA_GDP.do` runs sequentially (`0_master.do:327`, lives at `code/combine/` top level, not `Final_vars`) and writes no row → always `not_reached` under any scheme.

### 2.3 Heartbeat goes stale before combine finishes
- `ops/report_progress.py` polls the CSVs every 30s but has **no clean counters** (clean only reports `{outputs}` = count of `data/clean/*.dta`, `:70`) and clean/combine `done` aren't in the dedup key (`:130-131`). Once download stops changing and combine is pinned at 0 (header-only CSV), the dedup key freezes → no further POST → stale beat (last beat 14:56 vs run finish 15:30).
- The reporter **does** run concurrently with the build (`wed.yml:447` backgrounds it; `:450` runs Stata in foreground; killed at `:452`) — so this is a data problem, not a lifecycle block.

---

## 3. The fix (read the CSVs we already write)

| File | Change |
|---|---|
| `WED ops/build_source_health.py` | Add `--clean-status` arg; add `/clean/` branch to `_classify()` (category = country if `/country_level/` else aggregator); read `clean_status.csv` via existing `_read_status()`; replace the inferred clean at `:143` with a real per-source lookup (OK→passed, ERROR→failed, no row→not_reached). **UNION** download + clean names so clean-only sources get rows (see §5). Update stale docstring (`:16,33-36`). |
| `WED .github/workflows/wed.yml` | Pass `--clean-status data/tempfiles/clean_status.csv` to the Build-source-health step (`~:475-480`). |
| `WED ops/report_progress.py` | In `snapshot()`: read `clean_status.csv` → emit `clean:{total,done,ok,failed}` (keep `{outputs}` for back-compat); fix stage inference (`:75-82`) so a populated clean CSV ⇒ `stage='clean'`; add `clean.done/clean.failed` to the dedup key (`:130-131`); align `clean.total` with the fan-out list that actually writes rows (not the raw `*.do` glob — see §5). |
| `WED code/parallel/run_stata_parallel.sh` | Gate the truncate+header of `${WED_STAGE}_status.csv` (`:46`) on a `WED_STATUS_RESET` env flag: reset (`>`) only on first wave, else append (`>>`). Single-stage clean/download keep reset-on-start. |
| `WED code/0_master.do` | Set `WED_STATUS_RESET=1` for the **first** combine wave only (`~:355-373`), unset/0 for the second, so `combine_status.csv` accumulates across both waves. (Ensure `scrub-run-state.sh` still deletes it pre-run so wave 1 starts clean.) |
| `dashboard frontend/src/components/wed/PipelineProgress.jsx` | Stop hardcoding `clean: null` (`:40`) → `clean: p.clean`. Replace the special-cased clean word branch (`:67-69`) with the shared `<Counts c={c}/>` (keep the word only as a fallback when `p.clean` lacks total/done). The progress-bar block (`:78-90`) already keys off the current stage, so the clean bar renders automatically. Make the "build aborts if any fail" copy (`:86`) **stage-aware** (clean is not gated in v1 — see §6.3). |

**No change needed** (verified): `SourceHealth.jsx` (StageCell/StageCounts/Matrix already handle all 4 statuses + roll up clean/combine), `sourceHealth.js`, `verdict.js`, `runs.service.js` `mergeHeartbeat` (already routes `download/clean/combine/reported_at` → `progress.*` and `source_health` → top-level; `finished_at` gate already prevents a partial in-progress manifest from flipping the verdict).

---

## 4. Data contract (unchanged shape — only the data goes from inferred → real)

**Manifest** (`source_health.json` → `post_source_health.py` → `/heartbeat`):
```
summary:   { sources_total, variables_total, failed, fallback, qc_flags, systemic, gated_stage }
counts:    { aggregator, country, combine }
sources:   [ { name, category, download, clean, qc_flags[, rc] } ]
variables: [ { name, combine, qc_flags[, rc] } ]
gated_stage
```
Status vocabulary (already all rendered by `SourceHealth.jsx`):
- `download ∈ {passed, failed, fallback, not_reached}`
- `clean ∈ {passed, failed, not_reached}` — **`failed` becomes reachable for the first time**. `fallback` left out of v1 (no `clean_failures.csv` / tolerate-last-good model yet).
- `combine ∈ {passed, failed, not_reached}` — unchanged; just now reliably populated across both waves.

**Heartbeat** (live progress), additive only:
```
{ current_stage, download:{total,done,ok,failed}, clean:{total,done,ok,failed,outputs}, combine:{total,done,ok,failed}, reported_at }
```
`clean` gains `{total,done,ok,failed}` (keep `outputs` for back-compat).

---

## 5. Feasibility & honest limits (from adversarial verify — design was `sound: false` until these are handled)

- **Per-source merge must UNION, not loop download-only.** `build()` currently loops `for name in sorted(dl)` (164 download sources). Clean has **~348** do-files (123 aggregators + 225 country); only ~126 overlap download → a download-keyed edit silently drops **222** clean-only sources (incl. 4 of the 7 producers, which aren't in the download CSV at all). Builder must union download+clean names and emit clean-only rows. **This is a granularity decision — see §6.1.**
- **Clean is only fully derivable for the ~340 parallel fan-out files** (order==2, non-producer). NOT derivable from a status row for:
  - **7 in-process producers** (WDI, IMF_WEO, BIS_USDfx, Tena_USDfx, NBS, ARG_3, EUS) — run via `cap do` (`0_master.do:262-264`), no wrapper, no row.
  - **76 Mitchell order==1 files** (`0_master.do:215-218`, `qui do`), no row.
  - The earlier "check `data/clean/<cat>/<NAME>/<NAME>.dta` exists" fallback is **wrong** for 5 of 7 producers (their `global output` targets are heterogeneous, e.g. WDI→`…/WB/WDI/WDI`, ARG_3→flat `country_level/ARG_3.dta`). **Don't fabricate `passed`** — show `not_reached`/unknown, or do the small Stata edit (see §6.2).
- **`clean.total` must match what writes rows.** A raw `code/clean/{aggregators,country_level}/*.do` glob = 348, but only ~340 write status rows (producers run in-process) → `clean.done` caps below `clean.total` → live bar stuck <100%. Align total to the fan-out list / count producers separately.
- **Confirmed-correct (don't re-verify):** `clean_status.csv` is written; the reporter runs concurrently with the build; the dashboard schema is backward-compatible (`verdict.js` blocks only on `summary.failed>0 || gated_stage`, and `verdict.test.js` already asserts `gated_stage:'clean'`); `PipelineProgress.jsx` really does hardcode `clean:null`; heartbeat routing is intact; no basename collisions within clean or across clean/combine, so keying `_read_status` by basename is safe.

---

## 6. Open decisions (resolve before implementing)

1. **Clean source granularity.** Download=164 units, clean=~348 units, ~126 overlap. Represent clean as: **(a)** union into the source list (clean-only rows show download `not_reached`; source count grows toward ~348) — *recommended*; **(b)** keep 164 download-keyed rows, clean only where overlapping (incomplete); or **(c)** a separate Clean matrix at its own granularity. *Needs domain input on how clean maps to "sources".*
2. **Producers (7) + Mitchell (76).** v1 **honest `not_reached`/unknown** (no Stata edit) — *recommended* — or teach those producers to append a `clean_status.csv` row (small Stata edit, fully accurate).
3. **Clean gating policy.** **Report-only** (clean failures show in the row + per-stage counts but don't add to `summary.failed`/`gated_stage`; keeps `deriveVerdict` stable) — *recommended for v1* — or a **strict gate** (clean ERROR → `gated_stage='clean'` + `summary.failed++`; dashboard already supports it). Also soften the live "build aborts if any fail" copy to be stage-aware.
4. **Combine wave-2 filter (likely a separate WED bug).** All `cgov*/gen_gov*` files end in `_GDP.do`, so the wave-2 filter (`0_master.do:344`) matches zero — those variables may not run in wave 2 at all. The CSV-survival fix surfaces wave-1 results regardless, but whether `cgov*/gen_gov*` combine is *computed correctly* is a pipeline-logic question to confirm before changing the wave logic.

**Recommended v1 defaults:** 6.1(a) union · 6.2 honest-unknown · 6.3 report-only · 6.4 flag only (don't change wave logic yet).

---

## 7. Suggested implementation order

1. WED `build_source_health.py` (read clean + union) + Python test fixtures (status CSVs in / manifest out).
2. WED `wed.yml` `--clean-status` arg.
3. WED `report_progress.py` live clean counters + dedup + total alignment.
4. WED combine CSV survival (`run_stata_parallel.sh` + `0_master.do` reset flag) — test carefully against `scrub-run-state.sh`.
5. dashboard `PipelineProgress.jsx` (pair with the heartbeat change so live clean lights up).
6. (optional) `sourceHealth.js representativeManifest()` — add a `clean:'failed'` sample row so the representative demo showcases the now-reachable glyph.

Investigation artifact (full agent output): workflow `wf_c7870ed2-1c5`.
