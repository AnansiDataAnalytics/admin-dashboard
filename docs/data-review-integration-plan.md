# Data Review — Integration Plan

**Goal:** embed the existing GMD/WED **data-review app** (a self-contained Python
`serve.py` + `index.html` + Plotly, in `Global-Macro-Database-Internal/audit_dashboard/`)
into the admin dashboard's **Data Review** page, as-is, then make its input source
selectable (local file / upload / cloud WED).

This is the consolidated, decided plan. It supersedes the exploratory notes.

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
| 7 | Serve step | **Fargate / App Runner in ap-southeast-1** (IAM task role, no long-lived keys) |
| 8 | Vetting store | **Own Mongo collection in Atlas**, keyed by `release_version` |

---

## 1. Architecture

```
PROVIDERS → EC2 (Stata pipeline: download→clean→merge→combine→output_data)
                       │  (green build)
                       ├─► build step (build_data.py + flags.py)  ← NEW, rides the run
                       │        emits data.json + flags.parquet  →  S3 review/<version>/
                       ├─► S3 wed-output-ap1  (final/, clean/, manifests/)
                       └─► MongoDB Atlas (wed_staging / wed_v0)

Browser ──► Next.js (Render)  ──proxy /data-review-app/*──►  serve.py  (Fargate, ap-se-1)
  iframe src="/data-review-app/<dataset>/"                     │  IAM role
                                                               ├─ reads data.json/flags.parquet (S3, same-region)
                                                               └─ reads/writes vetting → Atlas (own collection)
```

Two runtime jobs, deliberately separated:

- **Build step** — `build_data.py` + `flags.py`. Heavy (pandas, tens of seconds–minutes),
  **occasional** (per release / per upload). Runs on the EC2 right after `output_data`,
  publishing `data.json` + `flags.parquet` to S3 alongside the products. No separate S3
  fetch, no egress, version-pinned for free.
- **Serve step** — `serve.py`. **Always-on**, very light (stdlib; `/regen` disabled in the
  embed, so it barely touches pandas). Pulls the prebuilt artifacts + serves the UI +
  records vetting. Hosted on Fargate/App Runner with an IAM role → free same-region S3/Atlas.

---

## 2. Phase 1 — Embed the app (GMD, local) — ready to build

Self-contained; unblocked today (GMD's 76 `chainlinked_*.dta` + `data/distribute/GMD.dta`
exist locally). Verified facts: every `index.html` fetch is **relative**; `serve.py` sets
**no** `X-Frame-Options`/CSP/CORS; the dashboard sets none either → iframing is unblocked.

**Frontend — replace the stub** `frontend/src/app/data-review/page.jsx`:
```jsx
export const metadata = { title: "Data Review · Anansi Admin" };
export default function DataReviewPage() {
  return (
    <iframe src="/data-review-app/" title="Data Review"
      style={{ width: "100%", height: "calc(100vh - 60px)", border: 0 }} />
  );
}
```
`calc(100vh - 60px)` clears the 60px sticky `.anav`; **not** wrapped in `.apage` (its
1120px max-width would letterbox the app). Stays a server component.

**Rewrite — `frontend/next.config.js`** (the *loaded* config — `next.config.mjs` is
**dead code**, Next loads only the first of `[next.config.js, next.config.mjs]`; **merge or
delete `.mjs`** so it can't mislead a future maintainer):
```js
const PY = process.env.DATA_REVIEW_TARGET || "http://127.0.0.1:8765";
module.exports = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: "/data-review-app/:path*", destination: `${PY}/:path*` }];
  },
};
```
All app fetches are relative → they resolve under `/data-review-app/` with **zero edits to
the app**.

**Nav** — flip the `/data-review` entry in `frontend/src/components/Nav.jsx` `LINKS` from
`ready:false` → `ready:true` (and the "Planned" home-page tile).

**Fallback** — add `frontend/src/app/data-review/error.jsx` so a down sidecar shows
"Data Review is offline," not a blank frame (the route has no error/loading boundary today).

**Run (local dev):**
```bash
python audit_dashboard/build_data.py     # -> data.json    (build outputs are NOT on disk yet)
python audit_dashboard/flags.py          # -> flags.parquet
python audit_dashboard/serve.py 8765     # supervised; SIGTERM-with-grace, never SIGKILL
```
Ignore `autoserve.sh` / `install_macos.sh` / the launchd plist — macOS-only.

**Guardrails (mandatory):** deny `/data-review-app/{sync,regen,resuppress}` at the rewrite
(or run `serve.py` with no git credentials on a throwaway branch). These endpoints run live
`git push` / `fetch/rebase` and spawn a ~30-min `flags.py` subprocess; they must not be
reachable from the embed.

**Exit criteria:** Data Review page renders the GMD app full-bleed under the dashboard
chrome; review/approve/comment works; the dangerous endpoints are unreachable.

---

## 3. Phase 2 — Input flexibility (immediately after) + cloud WED + A/Q/M

The cloud refactor is a **path-swap, not a parser rewrite** — the cloud `.dta` schema is
identical to local (handoff §9). All three input sources converge on "land `.dta` in a
per-dataset scratch dir → run the build step → serve."

### 3.1 Dataset registry + input resolvers
A small config lists named datasets; each resolves to a local scratch dir of `.dta` via one of:
- **local path** (GMD today),
- **upload** (user-supplied file, see §3.5),
- **S3** — `aws s3 cp` / boto3 from `wed-output-ap1`, **version-pinned** via
  `manifests/<version>.json` (fetch each key at its `VersionId`). Record `version`/`git_sha`.

### 3.2 Canonical inputs — UNMASKED (critical)
The app's purpose is per-source comparison, so it must read the **unmasked** artifacts:
- **Per-source review:** `clean_data_wide.dta` (all variables × all sources, source-prefixed;
  the handoff's recommended per-source input, and what WED's own prior dashboard used).
- **Cross-variable checks:** `data_final.dta` (merged, unprefixed canonical names) — this is
  WED's analog of GMD's `data/distribute/GMD.dta`.
- **Never** use Mongo or the `*_masked.dta` twins — they collapse proprietary sources to
  `"Anansi estimate"` and would gut the cross-source review. (This is why embedding depends
  on dashboard auth being enforced — see §5.)

### 3.3 Refactor `build_data.py` + `flags.py`
- Replace the hardcoded `REPO = parents[1]` path derivation with a **data-root / dataset
  config** (input root, merged-file name, output + state location).
- **A/Q/M dimension:** WED keys rows by a **string `yearmonth`** (`"2020"`, `"2020-Q1"`,
  `"2020-01"`) + **`freq` ∈ {A,Q,M}**, with the three frequencies as **independent rows**.
  The review unit becomes **(ISO3, variable, freq)**; the flag engine, the chart/table, and
  the value-keyed suppression key all gain `freq`. Parse `yearmonth` per frequency.
- Likely **standardize per-source extraction on `clean_data_wide.dta`** (one file, all
  vars × sources) rather than 76 per-variable files — matches the handoff recommendation and
  WED precedent. (Verify whether WED `chainlinked_<var>.dta` even carries per-source columns;
  see §6.)
- Filter out published `.keep` markers; respect Linux case-sensitivity on source/column names.

### 3.4 Serve step on Fargate/App Runner (ap-southeast-1)
- Containerize `serve.py`; attach an **IAM task role** (S3 read on `wed-output-ap1`, Atlas
  access) — no long-lived keys, same posture as the GH Actions OIDC.
- **Dataset-scoped:** serve under `/<dataset>/…` so the Next rewrite can target
  `/data-review-app/<dataset>/*`; each dataset has its own built artifacts + vetting scope.
- `/regen` stays disabled (build rides the pipeline); `/sync` removed (vetting goes to Mongo,
  not git).

### 3.5 Vetting → own Mongo collection (Atlas)
- Move vetting off local `vetting.jsonl` + SQLite into **our own collection** in the same
  Atlas cluster, keyed by `release_version`. **Never** write `series` / `seriesdatas`.
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
user, isolated per dataset.

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

## 7. Sequencing

1. **Phase 1** — embed GMD local (page + rewrite + nav + fallback + guardrails). Smallest,
   unblocked.
2. **Phase 2a** — refactor `build_data.py`/`flags.py` for data-root config + **A/Q/M**.
3. **Phase 2b** — S3 input resolver + version pinning; build step on the EC2 → S3.
4. **Phase 2c** — Fargate serve + IAM role; Next rewrite → Fargate; dataset-scoped routes.
5. **Phase 2d** — vetting → Atlas collection + per-session reviewer identity.
6. **Phase 2e** — selector + upload UI.
7. **Phase 3** — (later) wire the promotion gate.
