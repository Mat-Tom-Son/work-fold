"""Set one disposable GNOME monitor's scale through Mutter's native API."""
import os
import pathlib
import sys
import gi
from gi.repository import Gio, GLib

assert os.environ.get("WORKFOLD_ISOLATED_GNOME_TEST") == "1"
assert pathlib.Path("/run/.containerenv").exists() or pathlib.Path("/.dockerenv").exists()
assert os.environ.get("XDG_RUNTIME_DIR") == "/tmp/workfold-runtime"
scale = float(sys.argv[1])
assert scale in (1, 1.25, 1.5, 2)
transform = int(os.environ.get("WORKFOLD_NATIVE_TEST_TRANSFORM", "0"))
assert transform in (0, 1, 2, 3)
assert not (transform and os.environ.get("WORKFOLD_NATIVE_TEST_SECOND_MONITOR"))
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(method, arguments=None):
    return bus.call_sync("org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig",
                         "org.gnome.Mutter.DisplayConfig", method, arguments,
                         None, Gio.DBusCallFlags.NONE, 5000, None).unpack()


serial, monitors, logical, _ = call("GetCurrentState")
if os.environ.get("WORKFOLD_NATIVE_TEST_SECOND_MONITOR"):
    assert os.environ["WORKFOLD_NATIVE_TEST_SECOND_MONITOR"] == "2560x1440"
    assert len(monitors) == 2
    rows = []
    for index, (identity, modes, _) in enumerate(sorted(monitors, key=lambda monitor: monitor[0][0])):
        assert identity[0] == f"Meta-{index}" and identity[1] == "MetaVendor"
        mode = next(mode for mode in modes if mode[-1].get("is-current"))
        assert tuple(mode[1:3]) == ((1280, 720) if index == 0 else (2560, 1440))
        selected_scale = 1.0 if index == 0 else scale
        assert selected_scale in mode[5]
        rows.append((0 if index == 0 else 1280, 0, selected_scale, 0, index == 0, [(identity[0], mode[0], {})]))
    call("ApplyMonitorsConfig", GLib.Variant("(uua(iiduba(ssa{sv}))a{sv})", (
        serial, 1, rows, {"layout-mode": GLib.Variant("u", 1)})))
    configured = sorted(call("GetCurrentState")[2], key=lambda monitor: monitor[0])
    assert [(monitor[0], monitor[1], monitor[2]) for monitor in configured] == [(0, 0, 1.0), (1280, 0, scale)]
    print("Configured private second monitor at (1280, 0), scale:", scale)
    sys.exit(0)
assert len(monitors) == 1 and len(logical) == 1
identity, modes, _ = monitors[0]
assert identity[0] == "Meta-0" and identity[1] == "MetaVendor"
mode = next(mode for mode in modes if mode[-1].get("is-current"))
assert scale in mode[5], "Scale not supported by this virtual monitor"
call("ApplyMonitorsConfig", GLib.Variant("(uua(iiduba(ssa{sv}))a{sv})", (
    serial, 1, [(0, 0, scale, transform, True, [(identity[0], mode[0], {})])], {"layout-mode": GLib.Variant("u", 1)})))
assert call("GetCurrentState")[2][0][2] == scale
assert call("GetCurrentState")[2][0][3] == transform
print("Configured private GNOME monitor scale:", scale, "transform:", transform)
