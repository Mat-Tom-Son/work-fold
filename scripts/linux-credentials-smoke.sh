#!/bin/bash
set -euo pipefail
# Container-only, synthetic data. Each phase owns a fresh bus/keyring daemon.
test "${WORKFOLD_CONTAINER_INSTALL_TEST:-}" = 1
test -f /.dockerenv || test -f /run/.containerenv
test "$(id -u)" != 0
if test "$#" = 0; then
  workfold_keyring_fixture=$(mktemp -d /tmp/workfold-keyring-smoke.XXXXXX)
  trap 'rm -rf "$workfold_keyring_fixture"' EXIT
  phases=(seed verify corrupt reject-basic reject-missing reject-locked verify)
  asar=""
else
  test "$#" = 3
  workfold_keyring_fixture=$1
  phases=("$2")
  asar=$3
fi
case "${phases[0]}" in
  seed)
    mkdir -p "$workfold_keyring_fixture"
    test "$(realpath "$workfold_keyring_fixture")" = "$workfold_keyring_fixture"
    test -z "$(ls -A "$workfold_keyring_fixture")"
    printf '%s' work-fold.linux-credential-fixture.v1 > "$workfold_keyring_fixture/fixture"
    ;;
  verify|corrupt|reject-basic|reject-missing|reject-locked)
    test "$(realpath "$workfold_keyring_fixture")" = "$workfold_keyring_fixture"
    test ! -L "$workfold_keyring_fixture/fixture"
    test "$(cat "$workfold_keyring_fixture/fixture")" = work-fold.linux-credential-fixture.v1
    test -f "$workfold_keyring_fixture/complete"
    ;;
  *) echo 'Unknown credential fixture phase' >&2; exit 2;;
esac
export XDG_DATA_HOME="$workfold_keyring_fixture/data"
export XDG_CONFIG_HOME="$workfold_keyring_fixture/config"
export XDG_RUNTIME_DIR="$workfold_keyring_fixture/runtime"
for directory in "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR" "$workfold_keyring_fixture/electron"; do
  test ! -L "$directory"
  mkdir -p "$directory"
done
chmod 700 "$XDG_RUNTIME_DIR"
# A private bus with no service directories makes Secret Service genuinely
# unavailable. Do not change the host's service activation or personal keyring.
cat > "$workfold_keyring_fixture/no-secret-service.conf" <<'BUS'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>
BUS
for phase in "${phases[@]}"; do
  bus_options=()
  if test "$phase" = reject-missing; then
    bus_options=("--config-file=$workfold_keyring_fixture/no-secret-service.conf")
  fi
  dbus-run-session "${bus_options[@]}" -- bash -euc '
    if test "$2" = reject-locked; then
      # A real locked collection, with the unlock prompt unavailable. The bus
      # starts outside Xvfb, so its activated prompter has no display. This does
      # not simulate a person completing or cancelling an interactive dialog.
      unset DISPLAY WAYLAND_DISPLAY
      gnome-keyring-daemon --start --components=secrets >/dev/null
      locked=$(gdbus call --session --dest org.freedesktop.secrets \
        --object-path /org/freedesktop/secrets/collection/login \
        --method org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Collection Locked)
      test "$locked" = "(<true>,)"
    elif test "$2" != reject-missing; then
      printf "%s" synthetic-keyring-test-password | gnome-keyring-daemon --unlock --components=secrets >/dev/null
    fi
    timeout 30s xvfb-run -a /work/node_modules/electron/dist/electron /work/scripts/linux-credentials-electron-smoke.mjs "$1" "$2" "$3"
  ' bash "$workfold_keyring_fixture" "$phase" "$asar"
done
