#!/usr/bin/env bash
#
# Install the Data Quality Review server as an always-on macOS login agent.
# After this runs once, the dashboard is always live at http://127.0.0.1:<port>/
# and auto-updates itself when new code is pushed -- no more pull-and-restart.
#
#   bash audit_dashboard/install_macos.sh          # port 8765
#   bash audit_dashboard/install_macos.sh 8766     # custom port
#
# To stop / remove it later:
#   bash audit_dashboard/install_macos.sh --uninstall
#
# What it does: renders com.gmd.dqr.plist.template into
# ~/Library/LaunchAgents/com.gmd.dqr.plist and loads it with launchctl.
# launchd then runs audit_dashboard/autoserve.sh, restarting it on crash
# and at every login.

set -eu

cd "$(dirname "$0")/.."
REPO="$(pwd)"
LABEL="com.gmd.dqr"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL (server stopped, will not start at login)"
  exit 0
fi

PORT="${1:-8765}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "ignoring non-numeric port '$PORT'; using 8765"; PORT=8765
fi

# macOS TCC blocks launchd agents from ~/Downloads, ~/Documents and ~/Desktop.
# An agent there can't even exec autoserve.sh (exit 126, "Operation not
# permitted") and KeepAlive loops forever. Refuse rather than install a broken
# agent.
case "$REPO/" in
  "$HOME"/Downloads/*|"$HOME"/Documents/*|"$HOME"/Desktop/*)
    echo "ERROR: this checkout is under a macOS privacy-protected folder:" >&2
    echo "  $REPO" >&2
    echo "launchd cannot run an agent from Downloads/Documents/Desktop." >&2
    echo "Move the repo to e.g. ~/GitHub and reinstall:" >&2
    echo "  mkdir -p ~/GitHub && mv \"$REPO\" ~/GitHub/" >&2
    echo "  cd ~/GitHub/$(basename "$REPO") && bash audit_dashboard/install_macos.sh" >&2
    exit 1 ;;
esac

mkdir -p "$HOME/Library/LaunchAgents"

# launchd starts with a bare PATH, so bake in the SAME python3 + git the
# interactive shell uses. Otherwise serve.py never launches and nothing binds.
PYBIN="$(command -v python3 || true)"
if [ -z "$PYBIN" ]; then
  echo "ERROR: python3 not found on PATH. Install it or 'brew install python', then re-run." >&2
  exit 1
fi
PYDIR="$(dirname "$PYBIN")"
GITDIR="$(dirname "$(command -v git || echo /usr/bin/git)")"
# Put the discovered python + git dirs first, then the usual suspects.
LAUNCH_PATH="$PYDIR:$GITDIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "using python3: $PYBIN"

# Render the template with this checkout's path + chosen port + python/PATH.
sed -e "s#__REPO__#$REPO#g" -e "s#__PORT__#$PORT#g" \
    -e "s#__PYBIN__#$PYBIN#g" -e "s#__PATH__#$LAUNCH_PATH#g" \
  "$REPO/audit_dashboard/com.gmd.dqr.plist.template" > "$PLIST"

# Reload (bootout old, bootstrap new). Fall back to legacy load/unload on
# older macOS where bootstrap/bootout aren't available.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if ! launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
fi
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true

echo "installed $LABEL"
echo "  dashboard : http://127.0.0.1:$PORT/"
echo "  agent     : $PLIST"
echo "  logs      : audit_dashboard/autoserve.log  (supervisor)"
echo "              audit_dashboard/autoserve.out  (server output)"
echo
echo "It is running now and will relaunch at every login + auto-update on new pushes."
echo "Stop/remove with: bash audit_dashboard/install_macos.sh --uninstall"
