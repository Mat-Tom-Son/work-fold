#!/usr/bin/env bash
# Full real-compositor test, scoped to a newly created disposable container.
set -euo pipefail
test -f /run/.containerenv || test -f /.dockerenv
test "${WORKFOLD_ISOLATED_GNOME_TEST:-}" = 1
test "$(id -u)" != 0
source /tmp/workfold-session.env
test "$XDG_RUNTIME_DIR" = /tmp/workfold-runtime
test ! -e /tmp/workfold-input-fixture
ui=(python3 /work/scripts/linux-wayland-probe/portal-test-ui.py)
probe=/work/out/linux-wayland-probe-target/debug/work-fold-wayland-probe
evidence=$(mktemp -d /tmp/workfold-native-evidence.XXXXXX)
fixture= probe_pid=
cleanup() {
  test -z "$probe_pid" || kill "$probe_pid" 2>/dev/null || true
  test -z "$fixture" || kill "$fixture" 2>/dev/null || true
  wait || true
}
trap cleanup EXIT
for attempt in {1..100}; do
  if "${ui[@]}" desktop-ready >"$evidence/desktop.log" 2>&1; then break; fi
  sleep 0.1
done
"${ui[@]}" desktop-ready
python3 /work/scripts/linux-wayland-probe/input-fixture.py >"$evidence/fixture.log" 2>&1 &
fixture=$!
for attempt in {1..100}; do
  test -f /tmp/workfold-input-fixture/events.json && break
  kill -0 "$fixture"
  sleep 0.1
done
test -f /tmp/workfold-input-fixture/events.json
python3 - <<'PY'
import json, time
for _ in range(100):
    state = json.load(open('/tmp/workfold-input-fixture/events.json'))
    # A headless seat has no keyboard focus until the granted EIS keyboard is
    # created. Require a mapped target here; the input probe waits for focus.
    if state['mapped']:
        break
    time.sleep(.1)
else:
    raise RuntimeError('Synthetic native window did not map')
PY
run_capture() {
  # A media library can block inside a synchronous state transition. The outer
  # process deadline is independent of the async portal deadline.
  timeout --signal=INT --kill-after=5 75 "$probe" "$2" >"$evidence/$1.json" 2>"$evidence/$1.log" &
  probe_pid=$!
  "${ui[@]}" "$3"
  wait "$probe_pid"
  probe_pid=
  "${ui[@]}" closed
}
run_capture capture-only --capture choose
run_capture native-input --isolated-input-test choose-input
python3 - "$evidence" <<'PY'
import json, pathlib, sys
from collections import Counter
root = pathlib.Path(sys.argv[1])
capture = json.loads((root / 'capture-only.json').read_text())['result']
control = json.loads((root / 'native-input.json').read_text())['result']
assert capture['devicesGranted'] == 0 and not capture['inputSent'] and not capture['eisNegotiated']
assert capture['sessionClosed'] and capture['desktopCaptured']
assert control['devicesGranted'] == 3 and control['eisNegotiated'] and control['sessionClosed']
assert control['uniqueInputRegionMatched'] and control['inputSent']
assert (control['frame']['width'], control['frame']['height']) == (1280,720)
fixture = pathlib.Path('/tmp/workfold-input-fixture')
events = json.loads((fixture / 'events.json').read_text())
assert events['text'] == 'Wayland native input verified.' and events['saved']
assert (fixture / 'saved.txt').read_text() == events['text']
assert events['clicks'] == 1 and events['scrolls'] >= 1
assert len(events['presses']) >= 30 and Counter(events['presses']) == Counter(events['releases'])
print('PASS real Wayland: granted frame, capture-only permission, mapped click, compositor-keymap text, scrolling, Ctrl+s, exact saved bytes and released keys')
PY
run_cancel() {
  "$probe" --capture >"$evidence/$1.json" 2>"$evidence/$1.log" &
  probe_pid=$!
  "${ui[@]}" wait
  case "$1" in
    denied) "${ui[@]}" cancel ;;
    stopped) kill -INT "$probe_pid" ;;
    timeout) ;; # Exercise the actual bounded portal deadline.
  esac
  if wait "$probe_pid"; then echo "Expected $1 to refuse capture" >&2; exit 1; fi
  probe_pid=
  "${ui[@]}" closed
  grep -q 'Portal session close: confirmed' "$evidence/$1.log"
  test ! -s "$evidence/$1.json"
  echo "PASS real Wayland portal $1: failed without capture and chooser closed"
}
run_cancel denied
run_cancel stopped
run_cancel timeout
gnome-shell --version
sha256sum "$probe"
echo "Native acceptance evidence retained in $evidence and /tmp/workfold-input-fixture"
