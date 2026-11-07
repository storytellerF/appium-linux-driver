#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Own an X11 display and D-Bus session so tests cannot type into a user's desktop.
if [[ "${1-}" != --session ]]; then
  exec xvfb-run -a -s '-screen 0 1280x900x24' dbus-run-session -- bash scripts/run-e2e.sh --session
fi
export NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge LANG=C.UTF-8 LC_ALL=C.UTF-8
openbox > /dev/null 2>&1 &
wm_pid=$!
trap 'kill "$wm_pid" 2>/dev/null || true; wait "$wm_pid" 2>/dev/null || true' EXIT
node --test --test-concurrency=1 e2e/desktop.e2e.cjs
