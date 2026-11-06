"""Synthetic fullscreen target for physical-input tests on the private seat."""
import json
import os
import gi
from importlib import import_module

import_module("fixture-environment").require_isolated_session()
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, Gio

root = os.environ.get("WORKFOLD_NATIVE_INPUT_FIXTURE", "/tmp/workfold-input-fixture")
assert os.path.realpath(root).startswith("/tmp/workfold-")
os.mkdir(root, mode=0o700)
state = {"presses": [], "releases": [], "clicks": 0, "buttonReleases": 0, "scrolls": 0, "saved": False, "active": False, "mapped": False, "initialFocusSet": False, "preedit": "", "preedits": []}
application = Gtk.Application(application_id="com.workfold.NativeInputFixture", flags=Gio.ApplicationFlags.NON_UNIQUE)
application.register(None)
window = Gtk.ApplicationWindow(application=application, title="work-fold isolated Wayland input fixture")
if os.environ.get("WORKFOLD_NATIVE_TEST_SECOND_MONITOR"):
    assert os.environ["WORKFOLD_NATIVE_TEST_SECOND_MONITOR"] == "2560x1440"
    assert Gdk.Display.get_default().get_n_monitors() == 2
    window.fullscreen_on_monitor(Gdk.Screen.get_default(), 1)
else:
    window.fullscreen()
fixed = Gtk.Fixed()
window.add(fixed)
label = Gtk.Label(label="Disposable native Wayland input acceptance")
fixed.put(label, 100, 60)
entry = Gtk.Entry()
entry.set_size_request(800, 80)
entry.get_accessible().set_name("Native input test text")
fixed.put(entry, 100, 120)
button = Gtk.Button(label="Save fixture")
button.set_size_request(200, 60)
fixed.put(button, 100, 280)


def record():
    with open(root + "/events.tmp", "w") as file:
        json.dump({**state, "text": entry.get_text(), "entryFocused": entry.has_focus()}, file)
    os.replace(root + "/events.tmp", root + "/events.json")


def window_state(*_):
    state["active"] = window.is_active()
    state["mapped"] = window.get_mapped()
    if state["active"] and not state["initialFocusSet"]:
        # Typing can succeed only if the tested pointer action actually moves
        # focus into the entry; default first-widget focus is not proof.
        button.grab_focus()
        state["initialFocusSet"] = True
    record()


def save(*_):
    with open(root + "/saved.txt", "w") as file:
        file.write(entry.get_text())
    state["saved"] = True
    record()


def key(_, event, pressed):
    state["presses" if pressed else "releases"].append(int(event.hardware_keycode))
    if pressed and event.state & Gdk.ModifierType.CONTROL_MASK and event.keyval == Gdk.KEY_s:
        save()
    record()
    return False


def clicked(*_):
    state["clicks"] += 1
    record()
    return False


def scrolled(*_):
    state["scrolls"] += 1
    record()
    return True


def released(*_):
    state["buttonReleases"] += 1
    record()
    return False


def preedit(_, text):
    state["preedit"] = text
    state["preedits"].append(text)
    record()


entry.add_events(Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.SMOOTH_SCROLL_MASK)
# Observe before GtkEntry's own gesture controllers consume events. Raw
# button-press-event is not emitted consistently for GTK's emulated devices.
clicks = Gtk.GestureMultiPress.new(entry)
clicks.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
clicks.connect("pressed", clicked)
clicks.connect("released", released)
scroll = Gtk.EventControllerScroll.new(entry, Gtk.EventControllerScrollFlags.BOTH_AXES)
scroll.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
scroll.connect("scroll", scrolled)
window.connect("key-press-event", key, True)
window.connect("key-release-event", key, False)
window.connect("notify::is-active", window_state)
window.connect("map-event", window_state)
button.connect("clicked", save)
entry.connect("changed", lambda *_: record())
entry.connect("preedit-changed", preedit)
window.connect("destroy", lambda *_: application.quit())
window.show_all()
record()
application.connect("activate", lambda *_: window.present())
application.run([])
