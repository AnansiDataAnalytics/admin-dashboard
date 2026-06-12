# admin-dashboard

Anansi's internal operations dashboard. One app, many **services** — the first is
**Pipelines** (build status, the release ledger, and cell-level change tracking),
starting with the **WED** pipeline. Usage analytics and client management come later.

Read-only over the data: it reviews the Mongo pipeline ledger; it never writes to
the dataset. Anomalies are fixed in the pipeline code → new release → re-ingest.

## Structure

Monorepo, **tier-first** (`backend` + `frontend` at the root), each organized
**by domain** so new services are additive — add a domain folder, mount a router,
add a nav entry. No refactor.

```
admin-dashboard/
├─ package.json            # npm workspaces: backend, frontend
├─ backend/                # Express API (read-only over Mongo)
│  └─ src/
│     ├─ server.js         # one app; mounts domain routers
│     ├─ shared/           # db (one Atlas client), config
│     └─ domains/
│        └─ pipelines/     # /api/pipelines/wed/* (releases, changes, runs)
└─ frontend/               # Next.js (app router)
   └─ src/
      ├─ app/              # Home → /pipelines → /pipelines/wed
      ├─ components/       # Shell (sidebar nav)
      └─ lib/api.js        # backend client
```

> `frontend/pipelines/wed-mockup/src/` holds the original design **mockup** (a no-build
> React prototype). It's kept as a visual reference; its run/phase/gantt UI will be
> ported onto `frontend/src/app/pipelines/wed/` and then removed.

## Run (local)

```bash
npm install                      # installs both workspaces

# backend — copy env, set MONGODB_URI + WED_DB
cp backend/.env.example backend/.env   # then edit
npm run dev:backend              # http://localhost:4000

# frontend
npm run dev:frontend             # http://localhost:3000
```

Point `WED_DB` at `wed_staging` to view the v1..v6 backfill ledger before the prod
swap, or `wed_v0` for production. The frontend reads the backend at
`NEXT_PUBLIC_API_BASE` (default `http://localhost:4000/api`).

## Status

Scaffold: structure + the Home → Pipelines → WED path, with the WED page wired to
the real release ledger. Next: port the rich run/phase detail from the mockup, add
the per-release change drill-down, and (Phase 8) the GitHub webhook + EC2 heartbeat
feeds for live run status.
