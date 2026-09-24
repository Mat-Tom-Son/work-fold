#!/usr/bin/env bash
# Run as uid 1000 in the dedicated Ubuntu/Fedora GNOME image, with only the
# repository mounted. Never forward the person's session or system bus.
set -euo pipefail
test -f /run/.containerenv || test -f /.dockerenv
test "${WORKFOLD_ISOLATED_GNOME_TEST:-}" = 1
test "$(id -u)" = 1000
test ! -e /tmp/workfold-input-fixture
setsid bash /work/scripts/linux-wayland-probe/gnome-session.sh > /tmp/gnome-session.log 2>&1 &
desktop=$!
trap 'kill -- -"$desktop" 2>/dev/null || true; wait "$desktop" 2>/dev/null || true' EXIT
ready=0
for attempt in {1..150}; do
  if ! kill -0 "$desktop" 2>/dev/null; then
    cat /tmp/gnome-session.log /tmp/gnome-shell.log /tmp/login-services.log 2>/dev/null || true
    exit 1
  fi
  if test -f /tmp/workfold-session.env; then
    source /tmp/workfold-session.env
    if python3 /work/scripts/linux-wayland-probe/portal-test-ui.py desktop-ready >/tmp/desktop-ready.log 2>&1; then
      if gdbus call --session --dest org.gnome.ScreenSaver --object-path /org/gnome/ScreenSaver --method org.gnome.ScreenSaver.GetActive >/tmp/screensaver-ready.log 2>&1; then ready=1; break; fi
    fi
  fi
  sleep 0.2
done
if test "$ready" != 1; then
  cat /tmp/desktop-ready.log /tmp/screensaver-ready.log /tmp/gnome-session.log 2>/dev/null || true
  exit 1
fi
source /tmp/workfold-session.env
scales=(1 1.25)
if test "${WORKFOLD_NATIVE_TEST_SECOND_MONITOR:-}" = 2560x1440; then scales+=(2); fi
case "${WORKFOLD_NATIVE_TEST_SIZE:-}" in
  2560x1440) scales+=(2);;
  2880x1800) scales+=(1.5 2);;
esac
for scale in "${scales[@]}"; do
  python3 /work/scripts/linux-wayland-probe/configure-monitor.py "$scale"
  WORKFOLD_NATIVE_TEST_SCALE="$scale" python3 /work/scripts/linux-wayland-probe/protocol-smoke.py
  mv /tmp/workfold-input-fixture "/tmp/workfold-input-fixture-scale-$scale"
done
python3 /work/scripts/linux-wayland-probe/configure-monitor.py 1
node /work/scripts/linux-accessibility-smoke.cjs
node --import /work/node_modules/tsx/dist/loader.mjs /work/scripts/linux-wayland-probe/pi-smoke.mts
gnome-shell --version
sha256sum /work/out/included-tools/wayland-helper/work-fold-wayland
echo 'PASS private GNOME native acceptance; login services were simulated with python-dbusmock.'
