# Anansi Admin — WED Pipeline Status

Internal admin console (Bento aesthetic, light + dark). Static front-end: HTML + CSS,
with the WED status page built as a React + Babel prototype (no build step).

## File map

```
Admin Home.html            ← start here (Home / service grid)
Pipelines.html             ← pipelines index
Clients.html               ← planned-service stub
Data Review.html           ← planned-service stub
Usage Analytics.html       ← planned-service stub
WED Pipeline Status.html   ← the WED dashboard (React)

admin/
  admin.css                ← shared design tokens (light+dark) + nav + chrome
  theme.js                 ← cross-page light/dark persistence + toggle wiring

src/                       ← WED dashboard (loaded only by WED Pipeline Status.html)
  styles.css               ← dashboard component styles (consumes admin.css tokens)
  data.jsx                 ← run model: phases, steps, durations, scenarios, history
  icons.jsx                ← inline SVG icon set
  app.jsx                  ← dashboard components (hero, metrics, flow, gantt, steps…)
  main.jsx                 ← app shell + Tweaks wiring + live ticker

tweaks-panel.jsx           ← Tweaks panel shell (used by the WED page)
```

Page link graph: every page's nav points at the others; Home + Pipelines link into
`WED Pipeline Status.html`; the WED breadcrumb links back to Pipelines.

## Running locally

The HTML pages load the React/Babel JSX via `<script src>`, which browsers block over
`file://`. Serve the folder over HTTP instead:

```bash
# from inside this folder
python3 -m http.server 8000
# then open http://localhost:8000/Admin%20Home.html
```

(Any static server works — `npx serve`, VS Code Live Server, etc.)

An internet connection is needed on first load: React, ReactDOM, Babel and the Google
Fonts (Hanken Grotesk + JetBrains Mono) are pulled from CDNs.

## Theme

Light/dark is controlled by the sun/moon button in the nav and persisted in
`localStorage` under `anansi-admin-theme` (default: dark). It applies on every page.

## Notes

- The WED dashboard is a high-fidelity mock with realistic data — it is not wired to the
  GitHub Actions API. The run model lives in `src/data.jsx`.
- "Tweaks" on the WED page (Scenario: Success/Failure/Running, Step display: Phases/Raw)
  appear when Tweaks mode is enabled by the host viewer; they are not part of the shipped UI.
- Placeholders to wire up later: the "Welcome back, Joy." greeting and the `JO` avatar.
