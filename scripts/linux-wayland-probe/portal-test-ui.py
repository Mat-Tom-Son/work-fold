"""Operate only the portal UI on this repository's disposable GNOME seat."""
import os
import json
import sys
import time
import gi
from importlib import import_module

fixture_kind = import_module("fixture-environment").require_isolated_session()
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, Gio, GLib

Atspi.init()


def read_node(node, method, fallback=None):
    # The editor or a chooser can exit between AT-SPI discovery and reading its
    # cached node. Retry discovery; never turn a failed action into a success.
    try:
        return getattr(node, method)() if node is not None else fallback
    except GLib.GError:
        return fallback


def walk(node, depth=0):
    assert depth < 40
    if read_node(node, "get_name") is None:
        return
    yield node
    for index in range(min(read_node(node, "get_child_count", 0), 100)):
        try:
            child = node.get_child_at_index(index)
        except GLib.GError:
            continue
        yield from walk(child, depth + 1)


def candidates(name, roles):
    desktop = Atspi.get_desktop(0)
    result = []
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        if read_node(app, "get_name", "") != "xdg-desktop-portal-gnome":
            continue
        for node in walk(app):
            if read_node(node, "get_name", "") == name and read_node(node, "get_role_name", "") in roles:
                # Recent GTK exposes both an AdwSwitchRow and its leaf switch
                # with the same label/role. Choose the concrete leaf control.
                if any(read_node(child, "get_name", "") == name and read_node(child, "get_role_name", "") in roles
                       for child in list(walk(node))[1:]):
                    continue
                node.clear_cache()
                state = node.get_state_set()
                if state.contains(Atspi.StateType.SHOWING) and state.contains(Atspi.StateType.SENSITIVE):
                    result.append(node)
    return result


def folder_chooser_nodes():
    # Do not traverse Shell's entire application grid (or stale crash reporters)
    # to find one dialog. AT-SPI reads can block for each disconnected child.
    desktop = Atspi.get_desktop(0)
    names = {"xdg-desktop-portal-gtk", "xdg-desktop-portal-gnome",
             "org.gnome.nautilus", "nautilus", "files", "work-fold", "work-fold-desktop"}
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        if read_node(app, "get_name", "").lower() not in names:
            continue
        for frame in walk(app):
            if (read_node(frame, "get_name", "") == "Choose a folder"
                    and read_node(frame, "get_role_name", "") in ("frame", "dialog", "window")):
                yield from walk(frame)


def press(name, roles, select=False, selected_state=Atspi.StateType.PRESSED, monitor_index=None):
    deadline = time.monotonic() + (75 if fixture_kind == "vm" else 15)
    while time.monotonic() < deadline:
        nodes = candidates(name, roles)
        if monitor_index is not None:
            assert monitor_index == 1 and os.environ.get("WORKFOLD_NATIVE_TEST_SECOND_MONITOR") == "2560x1440"
            if len(nodes) == 2:
                nodes = [nodes[monitor_index]]
            else:
                nodes = []
        assert len(nodes) <= 1, "Ambiguous test portal control"
        if nodes:
            if select and nodes[0].get_state_set().contains(selected_state):
                print("Isolated portal control is already selected:", name, flush=True)
                return
            action = nodes[0].get_action_iface()
            assert action.get_n_actions() == 1 and action.do_action(0)
            print("Activated isolated portal control:", name, flush=True)
            if select:
                while time.monotonic() < deadline:
                    time.sleep(0.1)
                    nodes[0].clear_cache()
                    if nodes[0].get_state_set().contains(selected_state):
                        print("Isolated portal selection confirmed:", name, flush=True)
                        return
                raise RuntimeError("Monitor selection did not settle")
            return
        time.sleep(0.1)
    raise RuntimeError("Test portal control unavailable: " + name)


if sys.argv[1:] == ["desktop-ready"]:
    # The D-Bus property exists before Shell's startup cover has gone away.
    # Changing OverviewActive during that animation can strand an invisible
    # pointer grab on GNOME 50. Wait for Shell's actual startup-complete signal
    # as recorded by its private log before operating any test window.
    if fixture_kind == "container":
        assert "GNOME Shell started at" in open("/tmp/gnome-shell.log").read(), "GNOME startup is not complete"
    # GNOME exposes this normal writable shell property. Newer Shell versions
    # no longer expose an AT-SPI Action on the Activities toggle.
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    connection.call_sync("org.gnome.Shell", "/org/gnome/Shell", "org.freedesktop.DBus.Properties", "Set",
                         GLib.Variant("(ssv)", ("org.gnome.Shell", "OverviewActive", GLib.Variant("b", False))),
                         None, Gio.DBusCallFlags.NONE, 3000, None)
    result = connection.call_sync("org.gnome.Shell", "/org/gnome/Shell", "org.freedesktop.DBus.Properties", "Get",
                                  GLib.Variant("(ss)", ("org.gnome.Shell", "OverviewActive")),
                                  None, Gio.DBusCallFlags.NONE, 3000, None)
    assert result.unpack() == (False,)
    print("Isolated GNOME workspace is visible", flush=True)
elif sys.argv[1:] in [["choose"], ["choose-input"]]:
    monitor = os.environ["WORKFOLD_VM_MONITOR_NAME"] if fixture_kind == "vm" else "MetaVendor"
    monitor_index = 1 if os.environ.get("WORKFOLD_NATIVE_TEST_SECOND_MONITOR") else None
    press(monitor, ["toggle button"], select=True, monitor_index=monitor_index)
    if sys.argv[1:] == ["choose-input"]:
        press("Allow Remote Interaction", ["check box", "switch"], select=True, selected_state=Atspi.StateType.CHECKED)
    press("Share", ["push button", "button"])
elif sys.argv[1:] == ["cancel"]:
    press("Cancel", ["push button", "button"])
elif sys.argv[1:] == ["wait"]:
    deadline = time.monotonic() + (75 if fixture_kind == "vm" else 15)
    while time.monotonic() < deadline:
        if candidates("Cancel", ["push button", "button"]):
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("Portal chooser did not appear")
elif sys.argv[1:] == ["closed"]:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not candidates("Cancel", ["push button", "button"]):
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("Portal chooser remained after teardown")
elif sys.argv[1:] == ["cancel-folder"]:
    # The application has just opened its native folder dialog on this private
    # seat. GTK and Nautilus portal versions use different application names.
    deadline = time.monotonic() + (75 if fixture_kind == "vm" else 15)
    while time.monotonic() < deadline:
        buttons = []
        for node in folder_chooser_nodes():
            # GNOME 50's Nautilus chooser uses a Close button to cancel.
            if read_node(node, "get_name", "") in ("Cancel", "Close") and read_node(node, "get_role_name", "") in ("push button", "button"):
                node.clear_cache()
                state = node.get_state_set()
                if state.contains(Atspi.StateType.SHOWING) and state.contains(Atspi.StateType.SENSITIVE):
                    buttons.append(node)
        assert len(buttons) <= 1, "Ambiguous private native folder dialog"
        if buttons:
            action = buttons[0].get_action_iface()
            assert action.get_n_actions() == 1 and action.do_action(0)
            print("Cancelled private native folder dialog", flush=True)
            break
        time.sleep(.1)
    else:
        raise RuntimeError("Native folder chooser did not expose Cancel")
elif sys.argv[1:] == ["dump"]:
    for node in walk(Atspi.get_desktop(0)):
        name = read_node(node, "get_name", "")
        if name:
            node.clear_cache()
            print(repr(name), read_node(node, "get_role_name", ""), "showing=" + str(node.get_state_set().contains(Atspi.StateType.SHOWING)), flush=True)
elif sys.argv[1:] == ["folder-visible"]:
    deadline = time.monotonic() + (75 if fixture_kind == "vm" else 15)
    while time.monotonic() < deadline:
        desktop = Atspi.get_desktop(0)
        found = False
        for i in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(i)
            if read_node(app, "get_name", "").lower() not in ("nautilus", "files", "org.gnome.nautilus"):
                continue
            found = any(read_node(node, "get_name", "") == "Acceptance folder" and read_node(node, "get_role_name", "") in ("frame", "window") for node in walk(app))
            if found:
                break
        if found:
            print("Native file manager shows the exact disposable Folder", flush=True)
            break
        time.sleep(.1)
    else:
        raise RuntimeError("Native file manager did not expose the disposable Folder")
elif sys.argv[1:] == ["work-fold-switcher-target"]:
    # Select the named native application. A single Alt+Tab can select a
    # first-login welcome window or another fixture application instead.
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    connection.call_sync("org.gnome.Shell", "/org/gnome/Shell", "org.freedesktop.DBus.Properties", "Set",
                         GLib.Variant("(ssv)", ("org.gnome.Shell", "OverviewActive", GLib.Variant("b", True))),
                         None, Gio.DBusCallFlags.NONE, 3000, None)
    deadline = time.monotonic() + (75 if fixture_kind == "vm" else 15)
    while time.monotonic() < deadline:
        desktop = Atspi.get_desktop(0)
        buttons = []
        for index in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(index)
            if read_node(app, "get_name", "") != "gnome-shell":
                continue
            for node in walk(app):
                if read_node(node, "get_name", "") != "work-fold" or read_node(node, "get_role_name", "") not in ("button", "push button"):
                    continue
                node.clear_cache()
                state = node.get_state_set()
                if state.contains(Atspi.StateType.SHOWING) and state.contains(Atspi.StateType.SENSITIVE):
                    buttons.append(node)
        assert len(buttons) <= 1, "Ambiguous work-fold desktop entry"
        if buttons:
            # GNOME 50 does not expose an AT-SPI Action on dash buttons.
            # Resolve its visible bounds, then let the actual portal input
            # driver click it. Never invent a fixed dock position.
            rect = buttons[0].get_component_iface().get_extents(Atspi.CoordType.SCREEN)
            assert rect.width > 0 and rect.height > 0 and rect.x >= 0 and rect.y >= 0
            print(json.dumps({"x": rect.x + rect.width // 2, "y": rect.y + rect.height // 2}), flush=True)
            break
        time.sleep(.1)
    else:
        raise RuntimeError("Native switcher did not expose work-fold")
else:
    raise RuntimeError("Expected desktop-ready, choose, choose-input, cancel, wait or closed")
