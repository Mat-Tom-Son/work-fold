#!/usr/bin/env bash
set -euo pipefail
test -f /run/.containerenv || test -f /.dockerenv
test "${WORKFOLD_ISOLATED_KDE_TEST:-}" = 1
test "$(id -u)" = 1000
test ! -e /tmp/workfold-input-fixture
setsid bash /work/scripts/linux-wayland-probe/kde-session.sh >/tmp/kde-session.log 2>&1 &
desktop=$!
trap 'kill -- -"$desktop" 2>/dev/null || true; wait "$desktop" 2>/dev/null || true' EXIT
ready=0
for attempt in {1..100}; do
  if ! kill -0 "$desktop" 2>/dev/null; then cat /tmp/kde-session.log; exit 1; fi
  if test -f /tmp/workfold-session.env; then
    source /tmp/workfold-session.env
    if python3 /work/scripts/linux-wayland-probe/kde-portal-test-ui.py desktop-ready >/tmp/desktop-ready.log 2>&1; then ready=1; break; fi
  fi
  sleep .2
done
if test "$ready" != 1; then cat /tmp/desktop-ready.log /tmp/kde-session.log; exit 1; fi
node /work/scripts/linux-wayland-probe/kde-native-smoke.mjs
kwin_wayland --version
sha256sum /work/out/included-tools/wayland-helper/work-fold-wayland
echo 'PASS private KDE native acceptance; software graphics and no installed-app qualification.'
