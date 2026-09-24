#!/usr/bin/env bash
# Only for an owned rootless test container; no personal desktop sockets.
set -euo pipefail
test -f /run/.containerenv || test -f /.dockerenv
test "${WORKFOLD_ISOLATED_GNOME_TEST:-}" = 1
test "$(id -u)" != 0
umask 077
export XDG_RUNTIME_DIR=/tmp/workfold-runtime
mkdir -p "$XDG_RUNTIME_DIR"
if [[ "${1:-}" != --session ]]; then
  exec dbus-run-session -- bash "$0" --session
fi
export WAYLAND_DISPLAY=wayland-0
# Share only this container's settings between its test processes. A memory
# backend cannot retain the welcome-dialog preference for GNOME Shell.
export GSETTINGS_BACKEND=keyfile
export XDG_CONFIG_HOME=/tmp/workfold-gnome-config
mkdir -p "$XDG_CONFIG_HOME"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings set org.gnome.desktop.interface enable-animations false
# AT-SPI accepts the portal without physically moving this headless seat's
# initial pointer from (0, 0). Its first synthetic move can trigger GNOME's hot
# corner and consume the test click. A real person moves to the Share button.
gsettings set org.gnome.desktop.interface enable-hot-corners false
if [[ $(gnome-shell --version) == 'GNOME Shell 46.'* ]]; then
  gsettings set org.gnome.mutter experimental-features "['scale-monitor-framebuffer']"
fi
case "${WORKFOLD_NATIVE_TEST_LAYOUT:-us}" in
  us|de) gsettings set org.gnome.desktop.input-sources sources "[('xkb', '${WORKFOLD_NATIVE_TEST_LAYOUT:-us}')]";;
  *) exit 2;;
esac
case "${WORKFOLD_NATIVE_TEST_SIZE:-1280x720}" in 1280x720|2560x1440|2880x1800) ;; *) exit 2;; esac
# Shell needs a system-bus connection even without logind/UPower services. Use
# a second private bus, never the host's system bus.
export DBUS_SYSTEM_BUS_ADDRESS
DBUS_SYSTEM_BUS_ADDRESS=$(dbus-daemon --session --fork --print-address)
export XDG_SESSION_ID=workfoldtest
# GNOME creates ScreenShield only when GDM/logind exist. These services are
# simulated through upstream python-dbusmock, exclusively on this private bus.
python3 /work/scripts/linux-wayland-probe/session-services.py > /tmp/login-services.log 2>&1 &
login_services=$!
for attempt in {1..100}; do
  test -e /tmp/workfold-login-services-ready && break
  kill -0 "$login_services"
  sleep 0.1
done
test -e /tmp/workfold-login-services-ready
dbus-update-activation-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE DBUS_SYSTEM_BUS_ADDRESS
printf 'export DBUS_SESSION_BUS_ADDRESS=%q\nexport DBUS_SYSTEM_BUS_ADDRESS=%q\nexport XDG_RUNTIME_DIR=%q\nexport WAYLAND_DISPLAY=%q\nexport GSETTINGS_BACKEND=%q\nexport XDG_CONFIG_HOME=%q\n' \
  "$DBUS_SESSION_BUS_ADDRESS" "$DBUS_SYSTEM_BUS_ADDRESS" "$XDG_RUNTIME_DIR" "$WAYLAND_DISPLAY" "$GSETTINGS_BACKEND" "$XDG_CONFIG_HOME" > /tmp/workfold-session.env
pipewire > /tmp/pipewire.log 2>&1 &
pipewire_pid=$!
wireplumber > /tmp/wireplumber.log 2>&1 &
wireplumber_pid=$!
monitor_args=(--virtual-monitor "${WORKFOLD_NATIVE_TEST_SIZE:-1280x720}")
case "${WORKFOLD_NATIVE_TEST_SECOND_MONITOR:-}" in
  '') ;;
  2560x1440) monitor_args+=(--virtual-monitor 2560x1440) ;;
  *) exit 2 ;;
esac
gnome-shell --headless --wayland --no-x11 "${monitor_args[@]}" \
  --debug-control > /tmp/gnome-shell.log 2>&1 &
compositor=$!
# A full GNOME login starts this public proxy through user service activation.
# This private seat has no systemd user manager, so run the shipped proxy here.
gjs -m /usr/share/gnome-shell/org.gnome.ScreenSaver > /tmp/screensaver-proxy.log 2>&1 &
screensaver=$!
trap 'kill "$compositor" "$pipewire_pid" "$wireplumber_pid" "$login_services" "$screensaver" 2>/dev/null || true; wait || true' EXIT
wait "$compositor"
