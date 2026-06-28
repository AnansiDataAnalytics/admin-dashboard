#!/usr/bin/env bash
#
# Relaunch the Data Quality Review dashboard. Use this every time you want
# the latest changes from origin.
#
#   bash ~/Downloads/GitHub/GMD-validation-nwh6s/audit_dashboard/relaunch.sh
#
# Or save an alias:
#   alias dqr="bash ~/Downloads/GitHub/GMD-validation-nwh6s/audit_dashboard/relaunch.sh"
#
# Pass a port as the first arg if 8765 is busy:
#   bash relaunch.sh 8766
#
# Notes:
#   - git reset --hard discards any local edits in this worktree, including
#     the autosync MD commits that serve.py makes on Ctrl+C. Safe here:
#     vetting state lives in audit_dashboard/vetting.jsonl which is committed.
#   - First-time setup (a fresh checkout has no comments.json / audit.db /
#     flags.parquet yet) needs migrate.py + migrate_ledger.py + flags.py
#     once. This script runs them only if their artefacts are missing.

set -eu
cd "$(dirname "$0")/.."

PORT="${1:-8765}"
# Guard against a stray non-numeric port arg (e.g. an accidental keystroke);
# fall back to 8765 rather than failing at the very end after the rebuild.
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "ignoring non-numeric port '$PORT'; using 8765"
  PORT=8765
fi

# 1. Stop anything already on this port.
if lsof -t -i :"$PORT" >/dev/null 2>&1; then
  echo "killing existing server on :$PORT"
  lsof -t -i :"$PORT" | xargs kill || true
  sleep 1
fi

# 2. Sync to origin -- network-tolerant. If the fetch fails or times out
#    (offline laptop, flaky wifi, ...) we keep going with whatever code
#    is on disk so the dashboard still launches.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "fetching latest on $BRANCH..."
if git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=8 fetch origin "$BRANCH" 2>/dev/null; then
  git reset --hard "origin/$BRANCH"
else
  echo "  (no network -- skipping fetch; using whatever's already checked out)"
fi

# 3. First-time setup if any cached file is missing.
if [ ! -f audit_dashboard/comments.json ]; then
  echo "first-run: migrating comments from MITCHELL_AUDIT_LOG.md..."
  python3 audit_dashboard/migrate.py
fi
# Always rebuild audit.db from vetting.jsonl. Cheap (~178 inserts) and
# avoids stale state when `git reset --hard` shortens the JSONL out from
# under a previously-built audit.db.
echo "rebuilding audit.db from vetting.jsonl..."
rm -f audit_dashboard/audit.db
python3 audit_dashboard/ledger.py >/dev/null
if [ ! -f audit_dashboard/flags.parquet ]; then
  echo "first-run: computing flags.parquet (~3 min)..."
  python3 audit_dashboard/flags.py
fi

# 4. Regenerate data.json so any code-level change in flags.py / build_data.py
#    or any pulled change to chainlinked_*.dta gets reflected. Always rerun;
#    it's only ~30 s and ensures the dashboard never serves stale state.
echo "regenerating data.json..."
python3 audit_dashboard/build_data.py

# 5. Launch.
echo
echo "→ http://127.0.0.1:$PORT/"
echo "  Ctrl+C to stop."
echo
exec python3 audit_dashboard/serve.py "$PORT"
