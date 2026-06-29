# Data Review — Integration Plan

**Goal:** embed the **data-review app** (a self-contained Python `serve.py` + `index.html`
+ Plotly) into the admin dashboard's **Data Review** page, as-is, then make its input source
selectable (local file / upload / cloud WED).

**Code location:** the app now lives in **`admin-dashboard/data-review/`** (the canonical
copy). It was transferred from the now-grandfathered `Global-Macro-Database-Internal/audit_dashboard/`,
which is **frozen/legacy — do not edit it**.

This is the consolidated, decided plan. It supersedes the exploratory notes.

---

## Status (2026-06-29)

- **Phase 1 (embed, local GMD data): DONE** — branch `data-review-embed` (commits `20489fe`
  feat + `0bf2aae` docs; based on `auth`; not pushed).
- **App code transferred** GMD `audit_dashboard/` → `admin-dashboard/data-review/`
  (commit `7a585af`). Code only: excludes the 32 MB GMD `vetting.jsonl` (data; moving to
  Atlas) and generated artifacts.
- **Not yet runnable from `data-review/`** — the scripts still resolve GMD-relative paths
  (`parents[1]` → `data/final`, `data/distribute`, `data/helpers`) and `index.html` hardcodes
  the GMD issues repo. Making it run from this location is the first slice of Phase 2.
- **Interim:** local dev still runs `serve.py` from the GMD `audit_dashboard/` copy until the
  Phase 2 data-root refactor lands.
- **Next:** Phase 2 — input-flexibility refactor (in `data-review/`).

---

## 0. Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | Embed method | **Same-origin Next rewrite + iframe** (Python port never exposed to the browser) |
| 2 | First target | **GMD, local files** (Phase 1) → input flexibility immediately after (Phase 2) |
| 3 | Frequency scope | **All A/Q/M** — the review unit is **(ISO3, variable, freq)** |
| 4 | Auth | **Assumed to exist** (being built in parallel); embedding unmasked data depends on it |
| 5 | Engagement scope | **Pattern A** (file-based review) now, designed **Pattern-B-ready** (release-gate later) |
| 6 | Build step | **Rides the WED pipeline** on the existing EC2 (data is already on the box) |
| 7 | Serve step | **On-demand Fargate task** in ap-southeast-1 (scale-to-zero; IAM task role). Started from a dashboard control; **idle self-stop after ~1h**. Not always-on (usage <10 h/week). |
| 8 | Vetting / ledger | **Named, durable ledger** (own Atlas collection), **reusable across data versions** — build on prior approvals, don't re-fix cleared errors. |

---

## 1. Architecture

```
PROVIDERS → EC2 (Stata pipeline: download→clean→merge→combine→output_data)
                       │  (green build)
                       ├─► build step (data-review/build_data.py + flags.py)  ← rides the run
                       │        emits data.json + flags.parquet  →  S3 review/<version>/
                       ├─► S3 wed-output-ap1  (final/, clean/, manifests/)
                       └─► MongoDB Atlas (wed_staging / wed_v0)

Browser ──► Next.js (Render)  ──proxy /data-review-app/*──►  serve.py  (Fargate, ap-se-1)
  iframe src="/data-review-app/<dataset>/"                     │  IAM role
                                                               ├─ reads data.json/flags.parquet (S3, same-region)
                                                               └─ reads/writes vetting → Atlas (own collection)
```

Two runtime jobs, deliberately separated (both are scripts in `data-review/`):

- **Build step** — `build_data.py` + `flags.py`. Heavy (pandas, tens of seconds–minutes),
  **occasional** (per release / per upload). Runs on the EC2 right after `output_data`,
  publishing `data.json` + `flags.parquet` to S3 alongside the products. No separate S3
  fetch, no egress, version-pinned for free.
- **Serve step** — `serve.py`. **On-demand** (scale-to-zero; dashboard-started, ~1h idle stop), very light (stdlib; `/regen` disabled in the
  embed, so it barely touches pandas). Pulls the prebuilt artifacts + serves the UI +
  records vetting. Hosted on Fargate/App Runner with an IAM role → free same-region S3/Atlas.

### What the build step reads today (GMD defaults)
With no input override (the CP0 run), paths derive from the repo root and read:
- **`build_data.py`** → the **variable-specific `data/final/chainlinked_<var>.dta`** files
  (all 76); for each it pulls every per-source `<SOURCE>_<var>` column + the spliced `<var>`.
- **`flags.py`** → **both**: each `data/final/chainlinked_<var>.dta` (per-variable + the new
  lvl10/break checks) **and** the merged `data/distribute/GMD.dta` (cross-variable identity
  checks), plus `data/helpers/variables.csv` and `data/helpers/country_gdp_shares.csv`.

For WED (Phase 2) the per-source input becomes `clean_data_wide.dta` and the merged input
becomes `data_final.dta` (the WED analog of `GMD.dta`) — see §3.2.

---

## 2. Phase 1 — Embed the app (GMD, local) — DONE

Self-contained; unblocked (GMD's 76 `chainlinked_*.dta` + `data/distribute/GMD.dta` exist
locally). Verified: every `index.html` fetch is **relative**; `serve.py` sets **no**
`X-Frame-Options`/CSP/CORS; the dashboard sets none either → iframing is unblocked.

**As built (5 frontend files):**
- `frontend/src/app/data-review/page.jsx` — server component that renders the client
  `<DataReviewFrame/>` (kept a server component so it can export `metadata`).
- `frontend/src/components/DataReviewFrame.jsx` — `'use client'`; renders a full-bleed iframe
  at `src="/data-review-app/"` (`height: calc(100vh - 60px)` to clear the 60px sticky
  `.anav`, **not** wrapped in `.apage`), and probes the proxy in the background — if the
  sidecar is unreachable it swaps to a dashboard-native "offline" card.
- `frontend/next.config.js` — the **loaded** config (Next ignores `next.config.mjs`). Adds
  `async rewrites()` with `/data-review-app/:path* → DATA_REVIEW_TARGET` (default
  `http://127.0.0.1:8765`) and preserves the dormant `/api → BACKEND_PROXY_TARGET` proxy.
  Sets **`skipTrailingSlashRedirect: true`** so the app's relative fetches resolve under the
  `/data-review-app/` prefix (the trailing slash must survive). Always link with the slash.
- `frontend/src/components/Nav.jsx` — `/data-review` flipped to `ready: true`.
- `frontend/src/app/page.jsx` — home tile "Planned" → "Live"; live-services counter 1 → 2.

`next.config.mjs` is **dead code** (Next loads only the first of `[next.config.js,
next.config.mjs]`); it's left untracked — delete it so it can't mislead a future maintainer.

**Run (local dev — interim, from the GMD copy until Phase 2):**
```bash
# in the GMD repo (Global-Macro-Database-Internal); data/final + data/distribute live there
python audit_dashboard/flags.py          # -> flags.parquet   (run first)
python audit_dashboard/build_data.py     # -> data.json
python audit_dashboard/serve.py 8765     # supervised; SIGTERM-with-grace, never SIGKILL
```
The Next dev server proxies `/data-review-app/*` to `DATA_REVIEW_TARGET` (default `:8765`).
Ignore `autoserve.sh` / `install_macos.sh` / the launchd plist — macOS-only.

**Guardrails (mandatory):** deny `/data-review-app/{sync,regen,resuppress}` (or run `serve.py`
with no git credentials on a throwaway branch). Those endpoints run live `git push` /
`fetch/rebase` and spawn a ~30-min `flags.py` subprocess; they must not be reachable from the
embed. (Phase 1 local note: simply don't click Sync/Regenerate.)

**Result:** Data Review page renders the app full-bleed under the dashboard chrome; nav
promoted; graceful offline state; frontend is deploy-ready via the `DATA_REVIEW_TARGET` env.

---

## 3. Phase 2 — Input flexibility (next) + cloud WED + A/Q/M

All work happens in **`admin-dashboard/data-review/`**. The cloud refactor is a **path-swap,
not a parser rewrite** — the cloud `.dta` schema is identical to local (handoff §9). All
three input sources converge on "land `.dta` in a per-dataset scratch dir → run the build
step → serve."

### 3.1 Dataset registry + input resolvers
A small config lists named datasets; each resolves to a local scratch dir of `.dta` via one of:
- **local path** (GMD today),
- **upload** (user-supplied file, see §3.5),
- **S3** — the user supplies an S3 location holding the `chainlinked_*.dta` + `GMD.dta`;
  `aws s3 cp` / boto3 → scratch dir, then build. Optionally version-pin via a manifest
  `VersionId`; record `version`/`git_sha` on each decision for reproducibility.

### 3.2 Canonical inputs — UNMASKED (critical)
The app's purpose is per-source comparison, so it must read the **unmasked** artifacts:
- **Per-source review:** the **unmasked `chainlinked_<var>.dta`** (the existing ingestion —
  NOT the `*_masked.dta` twins). `clean_data_wide.dta` is an optional later consolidation,
  not required (see §6).
- **Cross-variable checks:** `GMD.dta` / `data_final.dta` (merged, unprefixed canonical names).
- **Never** use Mongo or the `*_masked.dta` twins — they collapse proprietary sources to
  `"Anansi estimate"` and would gut the cross-source review. (This is why embedding depends
  on dashboard auth being enforced — see §5.)

### 3.3 Refactor `data-review/build_data.py` + `data-review/flags.py`
- Replace the hardcoded `REPO = parents[1]` path derivation with a **data-root / dataset
  config** (input root, merged-file name, output + state location).
- **De-couple from GMD:** also fix `index.html`'s hardcoded `GH_REPO` (issue links) and the
  GMD-relative output paths in `build_audit_log.py` / `scrape_gdp_shares.py`.
- **A/Q/M dimension:** WED keys rows by a **string `yearmonth`** (`"2020"`, `"2020-Q1"`,
  `"2020-01"`) + **`freq` ∈ {A,Q,M}**, with the three frequencies as **independent rows**.
  The review unit becomes **(ISO3, variable, freq)**; the flag engine, the chart/table, and
  the value-keyed suppression key all gain `freq`. Parse `yearmonth` per frequency.
- Likely **standardize per-source extraction on `clean_data_wide.dta`** (one file, all
  vars × sources) rather than 76 per-variable files — matches the handoff recommendation and
  WED precedent. (Verify whether WED `chainlinked_<var>.dta` even carries per-source columns;
  see §6.)
- Filter out published `.keep` markers; respect Linux case-sensitivity on source/column names.

### 3.4 Serve step — on-demand Fargate task (scale-to-zero), NOT always-on
Usage is <10 h/week, so an always-on server is overkill. Instead:
- Containerize `data-review/serve.py`; **IAM task role** (S3 read, Atlas access) — no
  long-lived keys, same posture as the GH Actions OIDC. Bind host is an env var
  (`127.0.0.1` local, `0.0.0.0` in the container).
- **On-demand start:** a dashboard control hits the Express backend, which starts the
  Fargate task (ECS `run_task` / set `desiredCount=1`). It sits behind a **stable ALB / Cloud
  Map URL** so `DATA_REVIEW_TARGET` never changes; the dashboard polls readiness, then loads
  the iframe.
- **Idle self-stop:** `serve.py` tracks last-request time; after **~1h idle** the task stops
  (scale-to-zero → no compute cost). Configurable via `DATA_REVIEW_IDLE_TIMEOUT`.
- **Already isolated:** `EMBED_MODE` (shipped in Phase 2a) disables `/sync`, `/regen`,
  `/resuppress`, the audit-log/findings subprocesses, and the SIGINT git-commit — so the old
  always-on git/heavy behavior is gone regardless.
- **Dataset-scoped:** serve under `/<dataset>/…`; each dataset has its own built artifacts +
  ledger scope.

### 3.5 Vetting → a named, durable ledger (Atlas)
- Move vetting off local `vetting.jsonl` + SQLite into a **named, durable ledger** (our own
  Atlas collection), **reusable across data versions**: apply a named ledger to any review
  run so prior approvals suppress already-cleared flags — *build on* the ledger, don't re-fix
  approved errors. Built artifacts (`flags.parquet`/`data.json`) + ledger snapshots persist to
  S3/Atlas, not local disk. **Never** write `series` / `seriesdatas`.
- Keep records **idempotent + version-pinned** (carry `release_version`/`git_sha` + the
  flagged cell value) — preserves the existing value-keyed re-surfacing and is exactly the
  shape a future promotion-gate reads.
- **Reviewer identity:** the app's single global `reviewer.json` (seeded from git email) is
  wrong for a multi-user authed dashboard. Drive `POST /reviewer` per session from the
  dashboard's authenticated user so vetting is attributed correctly.

### 3.6 Selector + upload UI (dashboard shell)
- A dataset dropdown in the React shell above the iframe; switching it points the iframe at
  `/data-review-app/<dataset>/`.
- **Upload:** an Express multipart endpoint stores the file to a per-dataset input location,
  then triggers the build step for that dataset (Express → Python subprocess/job), then the
  serve step picks it up.

**Exit criteria:** a reviewer can pick GMD / WED / an uploaded dataset; WED loads unmasked
A/Q/M data from S3 (version-pinned); vetting persists to Atlas, attributed to the logged-in
user, isolated per dataset; the GMD `audit_dashboard/` copy can then be deleted.

---

## 4. Phase 3 — Pattern-B readiness (named, not built now)

The handoff (§7) invites a service at the **staging→prod promotion seam**: consume the
existing `changes` collection + `diff_report.json` `gate` block, score the release with our
checks/vetting, and feed the gate. We don't build this now, but Phase 2's choices keep it
cheap later: vetting in its own Atlas collection, keyed by `release_version`, idempotent and
version-pinned. Reuse `ops/mongo/change_events.py` (pure, portable) rather than
reimplementing delta primitives.

---

## 5. Security & guardrails

- **Embed exposes UNMASKED proprietary source names** → it must sit behind the dashboard's
  auth (assumed in-progress). Auth enforcement is a **hard release gate** before any WED
  unmasked data is served beyond localhost.
- **Same-origin only:** the browser talks to Next (`/data-review-app/*`); the Fargate serve
  URL and the Python port are never browser-reachable directly.
- **Disable git-mutating + heavy endpoints** in the embed (`/sync`, `/regen`, `/resuppress`).
- **No writes to `series`/`seriesdatas`;** vetting lives in our own collection.
- **Stateless + idempotent + version-pinned** reads (handoff §8).

---

## 6. Verification items (resolve during implementation)

- Does WED `chainlinked_<var>.dta` carry per-source `<SOURCE>_<var>` columns, or only the
  spliced series + `source`? Determines whether we read `chainlinked` or standardize on
  `clean_data_wide.dta` (lean: `clean_data_wide`).
- Column-name parity: confirm `data_final.dta` unprefixed canonical names match what
  `flags.py` cross-variable checks expect from `GMD.dta`.
- Exact S3 key for `clean_data_wide.dta` (`final/` vs `clean/` — handoff is slightly
  ambiguous) and the manifest's `outputs.*` key list.
- `data.json` size with A/Q/M (larger than GMD-annual) → confirm load time / consider
  per-(dataset,freq) splitting if needed.
- Trigger for the build step (post-ingest hook vs scheduled) — coordinate with the data team.

---

## Deferred / known to-dos

- **Sleep-countdown banner UX** (`DataReviewFrame`): the asleep-card + auto-recover are done
  and the `/idle` backend is verified, but the "sleeps in X" banner + Stay-active keepalive
  are deferred/unverified — the 15s poll is too coarse to show within a short test window
  (fine at the 1h prod timeout). Revisit the banner cadence/threshold during UI polish.

---

## 7. Sequencing

1. **Phase 1** — embed GMD local (page + rewrite + nav + fallback + guardrails). ✅ DONE.
2. **App transfer** — GMD `audit_dashboard/` → `admin-dashboard/data-review/`. ✅ DONE.
3. **Phase 2a** — refactor `data-review/build_data.py`/`flags.py` for data-root config +
   **A/Q/M**; de-couple GMD paths/`GH_REPO`. Makes the app runnable from `data-review/`.
4. **Phase 2b** — S3 input resolver + version pinning; build step on the EC2 → S3.
5. **Phase 2c** — Fargate serve + IAM role; Next rewrite → Fargate; dataset-scoped routes.
6. **Phase 2d** — vetting → Atlas collection + per-session reviewer identity.
7. **Phase 2e** — selector + upload UI.
8. **Cleanup** — delete the GMD `audit_dashboard/` copy once `data-review/` is validated.
9. **Phase 3** — (later) wire the promotion gate.
