#!/usr/bin/env bash
set -euo pipefail
test -f /run/.containerenv || test -f /.dockerenv
test "${WORKFOLD_ISOLATED_GNOME_TEST:-}" = 1
test "$(id -u)" = 1000
setsid bash /work/scripts/linux-wayland-probe/gnome-session.sh >/tmp/gnome-session.log 2>&1 &
desktop=$!
trap 'kill -- -"$desktop" 2>/dev/null || true; wait "$desktop" 2>/dev/null || true' EXIT
ready=0
for attempt in {1..150}; do
  kill -0 "$desktop"
  if test -f /tmp/workfold-session.env; then
    source /tmp/workfold-session.env
    if python3 /work/scripts/linux-wayland-probe/portal-test-ui.py desktop-ready >/tmp/desktop-ready.log 2>&1; then ready=1; break; fi
  fi
  sleep 0.2
done
test "$ready" = 1
# Match an unlocked desktop login using only this fixture's keyring. Starting
# Secret Service on first use otherwise presents an interactive creation prompt.
printf '%s' disposable-desktop-test-password | gnome-keyring-daemon --unlock --components=secrets >/tmp/keyring-start.log
node /work/scripts/linux-wayland-probe/desktop-smoke.mjs "${1:-/work/out/linux/linux-unpacked}"
