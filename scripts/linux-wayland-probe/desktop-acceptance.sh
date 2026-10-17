#!/usr/bin/env bash
set -euo pipefail
test -f /run/.containerenv || test -f /.dockerenv
test "${WORKFOLD_ISOLATED_GNOME_TEST:-}" = 1
test "$(id -u)" = 1000
setsid bash /work/scripts/linux-wayland-probe/gnome-session.sh >/tmp/gnome-session.log 2>&1 &
desktop=$!
cleanup() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then
    tail -c 12000 /tmp/gnome-session.log /tmp/gnome-shell.log /tmp/login-services.log 2>/dev/null || true
  fi
  kill -- -"$desktop" 2>/dev/null || true
  for attempt in {1..50}; do
    kill -0 "$desktop" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL -- -"$desktop" 2>/dev/null || true
  wait "$desktop" 2>/dev/null || true
  exit "$result"
}
trap cleanup EXIT
ready=0
for attempt in {1..150}; do
  if ! kill -0 "$desktop" 2>/dev/null; then
    cat /tmp/gnome-session.log /tmp/gnome-shell.log /tmp/login-services.log 2>/dev/null || true
    exit 1
  fi
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
# This container lane normally finishes within a minute. Bound the whole driver
# as well as its individual waits so a stuck debugger cannot consume the CI job.
timeout --signal=TERM --kill-after=10s 5m \
  node /work/scripts/linux-wayland-probe/desktop-smoke.mjs "${1:-/work/out/linux/linux-unpacked}"
