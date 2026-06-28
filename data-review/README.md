# Mitchell audit dashboard

Lightweight local web app for going country-by-country, variable-by-variable
through Mitchell IHS, comparing it against every other GMD source for the
same series, and leaving a written comment if there's a problem.

## Usage

```bash
cd audit_dashboard

# 1. Build data.json (only needs to rerun if MITCHELL.dta or clean_data_wide.dta change)
python3 build_data.py

# 2. Start the server
python3 serve.py            # http://127.0.0.1:8765
python3 serve.py 8766       # different port if 8765 is taken
```

Open `http://127.0.0.1:<port>/` in a browser.

## Workflow

For each (ISO3, variable) pair:

1. Look at the chart (Mitchell highlighted in red, peers thinner). Toggle log scale if magnitudes span orders of magnitude.
2. Cross-check the table below the chart — Mitchell column highlighted in yellow.
3. If Mitchell looks fine: press **A** (or click "✓ approve & next").
4. If something is off: type a comment, then press **→** (or click "next →") — the comment auto-saves.

Voice notes: dictate into the textarea using macOS Dictation (Fn-Fn). Then press → to save and advance.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `→` | save current comment + advance to next pair |
| `←` | advance to previous pair |
| `A` | mark approved + advance |
| `N` | skip to next *unreviewed* pair |
| `L` | toggle log scale |
| `Cmd/Ctrl+→` | save+next even when typing in the textarea |
| `Cmd/Ctrl+←` | prev when typing in the textarea |

## Filters

- Search box: filters by ISO3 or variable substring.
- Filter dropdown: only show unreviewed / commented / approved pairs.

Sidebar dots: ○ unreviewed · ● commented · ✓ approved · half/half = both commented and approved.

## Persistence

Comments are saved to **`comments.json`** (single source of truth). Every save also:

1. Atomically rewrites `comments.json` (temp file + rename, no partial writes possible).
2. Appends a JSONL record to **`comments.log`** (append-only safety net).
3. Every 25 saves (or every ~5 minutes), copies the current `comments.json` to **`backups/comments.YYYYMMDD-HHMMSS.json`**.
4. The browser also saves a snapshot to `localStorage` per pair, in case the server crashes.

If `comments.json` ever gets corrupted, you can rebuild from `comments.log` (each line is the latest state for one pair at one timestamp; replay them in order, last-write-wins per key).

## Always-on, auto-updating server (macOS)

So you never have to pull-and-restart by hand: install the dashboard as a
login agent. It starts on login, restarts if it crashes, and **auto-updates
itself** — every couple of minutes it checks `origin` for new commits on this
branch and, when code lands, gracefully restarts (your in-progress vetting is
synced + pushed first) and picks up the change. Then just bookmark
`http://127.0.0.1:8765/` and treat it like a web app.

### One-time install

```bash
bash audit_dashboard/install_macos.sh          # port 8765
bash audit_dashboard/install_macos.sh 8766     # or a custom port
```

That renders `com.gmd.dqr.plist.template` into
`~/Library/LaunchAgents/com.gmd.dqr.plist` (with this checkout's path baked in)
and loads it. The agent runs `audit_dashboard/autoserve.sh`, the supervisor
loop that does the fetch/rebuild/restart.

### Day-to-day management

```bash
open http://127.0.0.1:8765/                              # open it

launchctl print gui/$(id -u)/com.gmd.dqr                 # status / pid
launchctl kickstart -k gui/$(id -u)/com.gmd.dqr          # force restart now

tail -f audit_dashboard/autoserve.log                    # supervisor log
tail -f audit_dashboard/autoserve.out                    # server output

bash audit_dashboard/install_macos.sh --uninstall        # stop + remove
```

You can also run the supervisor in a terminal without installing the agent:

```bash
bash audit_dashboard/autoserve.sh 8765
DQR_POLL=300 bash audit_dashboard/autoserve.sh 8765      # check origin every 5 min
```

### Notes

- The supervisor **never `git reset --hard`** — it commits any local vetting
  first, then `git pull --rebase`. If a rebase can't apply cleanly it keeps
  serving the old code and logs it, rather than risk losing your decisions.
- A code update to `flags.py` triggers the (~3 min) `flags.parquet` recompute;
  any other update just rebuilds the cheap `data.json` + `audit.db`.
- `KeepAlive=true` resurrects the supervisor if it ever exits. To stop it for
  real, use `--uninstall` (not `kill`).
- `git commit` + `git push` work from the launchd context because macOS
  forwards SSH keys via Keychain to user-level launchd-spawned processes.
- Editing `index.html` needs no restart — it's read fresh on every request.

## Files

```
audit_dashboard/
├── build_data.py       # generates data.json from .dta files
├── serve.py            # HTTP server (stdlib only, no dependencies)
├── index.html          # the UI (loads Plotly from CDN)
├── data.json           # extracted Mitchell + peer series (rebuild as needed)
├── comments.json       # current state of all comments — DO NOT EDIT BY HAND while server is running
├── comments.log        # append-only history (one JSON line per save)
└── backups/            # periodic snapshots of comments.json
```

## Restoring from backup / log

If `comments.json` is broken, the safest recovery is:

```bash
# pick a recent backup
cp backups/comments.20260509-234130.json comments.json

# OR replay the append-log into a fresh file:
python3 -c '
import json, collections
acc = {}
for line in open("comments.log"):
    if not line.strip(): continue
    r = json.loads(line)
    k = r.pop("key")
    acc[k] = r
open("comments.json","w").write(json.dumps(acc, indent=2, sort_keys=True))
'
```

## Implementation notes

- Mitchell variables that get loaded: every `Mitchell_<var>` column in `MITCHELL.dta` whose suffix doesn't end in `_GDP`. (1,979 (ISO3, var) pairs at last build.)
- Peer columns: every column in `clean_data_wide.dta` ending in `_<var>` that has at least one observation for the given ISO3, excluding `Mitchell_*` and `_GDP`.
- Floats are rounded to 6 significant figures for compactness.
- Server uses Python stdlib only (`http.server`, `socketserver`, `json`). No Flask, no pandas at runtime — pandas is only needed for `build_data.py`.
- Plotly is loaded from `cdn.plot.ly`. If you're offline, swap to a vendored copy.
