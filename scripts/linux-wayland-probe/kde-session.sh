#!/usr/bin/env bash
# Only inside an owned container. Software GL needs a guest-created VGEM node;
# never pass a physical host GPU, session bus, home or input device.
set -euo pipefail
test -f /run/.containerenv || test -f /.dockerenv
test "${WORKFOLD_ISOLATED_KDE_TEST:-}" = 1
test "$(id -u)" = 1000
umask 077
export XDG_RUNTIME_DIR=/tmp/workfold-runtime
export XDG_CONFIG_HOME=/tmp/workfold-kde-config XDG_DATA_HOME=/tmp/workfold-kde-data
export WAYLAND_DISPLAY=wayland-0
export XDG_CURRENT_DESKTOP=KDE KDE_SESSION_VERSION=6 XDG_SESSION_TYPE=wayland
export LIBGL_ALWAYS_SOFTWARE=1 KWIN_COMPOSE=O2 QT_ACCESSIBILITY=1 NO_AT_BRIDGE=0
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
if test "${1:-}" != --session; then exec dbus-run-session -- bash "$0" --session; fi
case "${WORKFOLD_KDE_TEST_SCALE:-1}" in 1|1.25|1.5|2) ;; *) exit 2 ;; esac
case "${WORKFOLD_KDE_TEST_OUTPUTS:-1}" in 1|2) ;; *) exit 2 ;; esac
export DBUS_SYSTEM_BUS_ADDRESS
DBUS_SYSTEM_BUS_ADDRESS=$(dbus-daemon --session --fork --print-address)
printf 'export DBUS_SESSION_BUS_ADDRESS=%q\nexport DBUS_SYSTEM_BUS_ADDRESS=%q\nexport XDG_RUNTIME_DIR=%q\nexport WAYLAND_DISPLAY=%q\nexport XDG_CONFIG_HOME=%q\nexport XDG_DATA_HOME=%q\nexport XDG_CURRENT_DESKTOP=KDE\nexport KDE_SESSION_VERSION=6\nexport XDG_SESSION_TYPE=wayland\nexport QT_ACCESSIBILITY=1\n' \
  "$DBUS_SESSION_BUS_ADDRESS" "$DBUS_SYSTEM_BUS_ADDRESS" "$XDG_RUNTIME_DIR" "$WAYLAND_DISPLAY" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" > /tmp/workfold-session.env
dbus-update-activation-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP KDE_SESSION_VERSION XDG_SESSION_TYPE DBUS_SYSTEM_BUS_ADDRESS QT_ACCESSIBILITY XDG_CONFIG_HOME XDG_DATA_HOME
gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.freedesktop.DBus.Properties.Set org.a11y.Status IsEnabled '<true>'
gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.freedesktop.DBus.Properties.Set org.a11y.Status ScreenReaderEnabled '<true>'
pipewire >/tmp/pipewire.log 2>&1 &
wireplumber >/tmp/wireplumber.log 2>&1 &
# Native screen locking deliberately stays enabled.
exec kwin_wayland --virtual --width 1280 --height 800 --no-kactivities \
  --scale "${WORKFOLD_KDE_TEST_SCALE:-1}" --output-count "${WORKFOLD_KDE_TEST_OUTPUTS:-1}"
