#!/usr/bin/env bash
#
# Always-on Data Quality Review server.
#
# Runs serve.py and keeps it fresh: every DQR_POLL seconds it checks origin
# for new commits on this branch. When new code lands it gracefully restarts
# the server (SIGINT -> serve.py syncs + pushes your vetting -> exits) and
# picks up the new code, rebuilding only what changed. If the server ever
# dies on its own it is relaunched.
#
# This means you never have to pull-and-restart by hand. Install it as a
# login agent with:
#
#   bash audit_dashboard/install_macos.sh        # or: ... <port>
#
# ...or just run it in a terminal:
#
#   bash audit_dashboard/autoserve.sh 8765
#
# Env knobs:
#   DQR_POLL   seconds between origin checks (default 120)
#
# Safety: we NEVER `git reset --hard` here -- that would discard unsynced
# vetting work. We commit local vetting first, then `git pull --rebase`. If
# the rebase can't apply cleanly we keep serving the old code and log it
# rather than risk losing decisions.

set -u

cd "$(dirname "$0")/.."
REPO="$(pwd)"
PORT="${1:-8765}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then PORT=8765; fi
POLL="${DQR_POLL:-120}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# Interpreter to use. Pinned by the launchd agent via DQR_PYTHON so we don't
# depend on launchd's bare PATH; falls back to whatever python3 is on PATH.
PY="${DQR_PYTHON:-python3}"

LOG_DIR="$REPO/audit_dashboard"
SERVER_PID=""

log() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*"; }

# --- network-tolerant fetch -------------------------------------------------
fetch_origin() {
  git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=8 \
      fetch origin "$BRANCH" >/dev/null 2>&1
}

# --- rebuild derived artefacts ---------------------------------------------
# rebuild_flags=1 forces the (~3 min) flags.parquet recompute; otherwise we
# only rebuild it if it is missing.
rebuild() {
  local rebuild_flags="${1:-0}"

  if [ ! -f audit_dashboard/comments.json ]; then
    log "first-run: migrating comments..."
    "$PY" audit_dashboard/migrate.py >/dev/null 2>&1 || true
  fi

  # audit.db is a cheap, disposable cache rebuilt from the committed jsonl.
  rm -f audit_dashboard/audit.db
  "$PY" audit_dashboard/ledger.py >/dev/null 2>&1 || true

  if [ "$rebuild_flags" = "1" ] || [ ! -f audit_dashboard/flags.parquet ]; then
    log "computing flags.parquet (this takes a couple of minutes)..."
    "$PY" audit_dashboard/flags.py >/dev/null 2>&1 || log "flags.py failed; keeping old flags.parquet"
  fi

  log "regenerating data.json..."
  "$PY" audit_dashboard/build_data.py >/dev/null 2>&1 || log "build_data.py failed"
}

# --- server lifecycle -------------------------------------------------------
start_server() {
  "$PY" audit_dashboard/serve.py "$PORT" >>"$LOG_DIR/autoserve.out" 2>&1 &
  SERVER_PID=$!
  log "server up (pid $SERVER_PID) -> http://127.0.0.1:$PORT/"
}

stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    # SIGINT == Ctrl+C: serve.py backs up + commits/pushes vetting, then exits.
    log "restarting: signalling server (pid $SERVER_PID) to sync + exit..."
    kill -INT "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
}

server_alive() { [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; }

# --- main loop --------------------------------------------------------------
cleanup() { stop_server; exit 0; }
trap cleanup INT TERM

# free the port if a stray server is on it
if command -v lsof >/dev/null 2>&1 && lsof -t -i :"$PORT" >/dev/null 2>&1; then
  log "killing stray process on :$PORT"
  lsof -t -i :"$PORT" | xargs kill 2>/dev/null || true
  sleep 1
fi

log "autoserve starting on branch $BRANCH, port $PORT, poll ${POLL}s"
rebuild 0
start_server

while true; do
  sleep "$POLL"

  # 1. Relaunch if the server died on its own.
  if ! server_alive; then
    log "server not running; relaunching"
    rebuild 0
    start_server
    continue
  fi

  # 2. Check origin for new code.
  fetch_origin || { log "fetch failed (offline?); will retry"; continue; }
  LOCAL="$(git rev-parse HEAD)"
  REMOTE="$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "$LOCAL")"
  [ "$LOCAL" = "$REMOTE" ] && continue

  log "new commits on origin/$BRANCH ($LOCAL -> $REMOTE)"

  # 3. Stop server first -- it syncs (commits + pushes) our vetting.jsonl,
  #    leaving the tree clean so the rebase below applies cleanly.
  stop_server

  # 4. Belt-and-braces: commit anything still dirty rather than lose it.
  if ! git diff --quiet || ! git diff --cached --quiet; then
    git add -A >/dev/null 2>&1 || true
    git commit -q -m "dqr: autosave local vetting before pulling new code" \
      >/dev/null 2>&1 || true
  fi

  # 5. Pull the new code. Never reset --hard.
  if git pull --rebase origin "$BRANCH" >>"$LOG_DIR/autoserve.out" 2>&1; then
    NEW="$(git rev-parse HEAD)"
    if git diff --name-only "$LOCAL" "$NEW" 2>/dev/null | grep -q 'audit_dashboard/flags\.py'; then
      rebuild 1
    else
      rebuild 0
    fi
  else
    log "pull --rebase failed (conflict?); aborting rebase, serving old code"
    git rebase --abort >/dev/null 2>&1 || true
  fi

  start_server
done
