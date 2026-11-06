"""Operate the real Qt portal only on an explicitly provisioned private seat."""
import os
import sys
import time
from importlib import import_module
import gi

import_module("fixture-environment").require_isolated_session()
assert os.environ.get("WORKFOLD_ISOLATED_KDE_TEST") == "1"
assert os.environ.get("XDG_CURRENT_DESKTOP") == "KDE"
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, Gio, GLib

Atspi.init()
Atspi.set_timeout(1000, 1000)


def walk(node, depth=0):
    assert depth < 30
    try:
        node.clear_cache()
        yield node
        for index in range(min(node.get_child_count(), 100)):
            yield from walk(node.get_child_at_index(index), depth + 1)
    except GLib.GError:
        return


def buttons(name):
    desktop = Atspi.get_desktop(0)
    result = []
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        if app.get_name() != "xdg-desktop-portal-kde":
            continue
        for node in walk(app):
            try:
                state = node.get_state_set()
                if (node.get_role_name() == "button" and node.get_name() == name
                        and state.contains(Atspi.StateType.SHOWING)
                        and state.contains(Atspi.StateType.SENSITIVE)):
                    result.append(node)
            except GLib.GError:
                continue
    assert len(result) <= 1, "Ambiguous private KDE chooser"
    return result


command = sys.argv[1:]
if command == ["desktop-ready"]:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    active = bus.call_sync("org.freedesktop.ScreenSaver", "/ScreenSaver", "org.freedesktop.ScreenSaver", "GetActive",
                           None, None, Gio.DBusCallFlags.NONE, 3000, None)
    assert active.unpack() == (False,)
    info = bus.call_sync("org.kde.KWin", "/KWin", "org.kde.KWin", "supportInformation",
                         None, None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
    assert "Compositing Type: OpenGL" in info, "QPainter does not qualify KDE capture"
    print("Private KDE OpenGL desktop and native lock service ready", flush=True)
elif command in [["choose-input"], ["cancel"], ["wait"], ["closed"]]:
    name = "Approve" if command == ["choose-input"] else "Deny"
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        found = buttons(name)
        if command == ["closed"] and not found:
            break
        if found and command != ["closed"]:
            if command != ["wait"]:
                action = found[0].get_action_iface()
                indices = [i for i in range(action.get_n_actions()) if action.get_action_name(i) == "Press"]
                assert len(indices) == 1 and action.do_action(indices[0])
            break
        time.sleep(.05)
    else:
        raise RuntimeError("Private KDE portal did not settle: " + command[0])
    print("Private KDE portal:", command[0], flush=True)
else:
    raise ValueError("Unknown fixture UI command")
