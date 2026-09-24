#!/usr/bin/env bash
# Run inside an owned test container; never change a personal Chrome policy.
set -euo pipefail
test -f /run/.containerenv || test -f /.dockerenv
test "${WORKFOLD_CONTAINER_CHROME_TEST:-}" = 1
test "$(id -u)" = 0
mkdir -p /etc/opt/chrome/policies/managed
if [[ "${WORKFOLD_CHROME_STORE_UI:-}" != 1 && -z "${WORKFOLD_CHROME_CANDIDATE_ZIP:-}" ]]; then
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const { storeId } = JSON.parse(readFileSync('/work/src/shared/chrome-distribution.json', 'utf8'));
writeFileSync('/etc/opt/chrome/policies/managed/workfold-test.json', JSON.stringify({
  ExtensionInstallForcelist: [`${storeId};https://clients2.google.com/service/update2/crx`],
  BrowserSignin: 0, SyncDisabled: true, RestoreOnStartup: 1, DeveloperToolsAvailability: 1,
}), { mode: 0o644 });
JS
fi
if [[ "${WORKFOLD_CHROME_WAYLAND:-}" = 1 ]]; then
  export WORKFOLD_ISOLATED_GNOME_TEST=1
  runuser -u ubuntu -- bash /work/scripts/linux-wayland-probe/gnome-session.sh &
  seat=$!
  trap 'kill "$seat" 2>/dev/null || true' EXIT
  ready=0
  for attempt in {1..150}; do
    kill -0 "$seat"
    if test -f /tmp/workfold-session.env && runuser -u ubuntu -- bash -c 'source /tmp/workfold-session.env; python3 /work/scripts/linux-wayland-probe/portal-test-ui.py desktop-ready' >/tmp/chrome-desktop-ready.log 2>&1; then ready=1; break; fi
    sleep 0.2
  done
  test "$ready" = 1
  runuser -u ubuntu -- bash -c 'source /tmp/workfold-session.env; python3 /work/scripts/linux-wayland-probe/portal-test-ui.py desktop-ready; node /work/scripts/linux-chrome-store-smoke.mjs /work/out/linux/linux-unpacked'
else
  runuser -u ubuntu -- xvfb-run -a -s '-screen 0 1920x1080x24' dbus-run-session -- bash -c \
    'openbox >/tmp/workfold-openbox.log 2>&1 & manager=$!; trap "kill $manager 2>/dev/null || true" EXIT; node /work/scripts/linux-chrome-store-smoke.mjs /work/out/linux/linux-unpacked'
fi
