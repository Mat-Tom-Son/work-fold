"""Confirm only this disposable container's Store-install test dialog."""
import os
import time
import gi

assert os.environ.get("WORKFOLD_CONTAINER_CHROME_TEST") == "1"
assert os.environ.get("WORKFOLD_CHROME_STORE_UI") == "1"
assert os.path.exists("/run/.containerenv") or os.path.exists("/.dockerenv")
assert os.getuid() != 0
assert os.environ["DBUS_SESSION_BUS_ADDRESS"].startswith("unix:path=/tmp/")
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi
Atspi.init()

def walk(node, depth=0):
    assert depth < 40
    yield node
    for index in range(min(node.get_child_count(), 200)):
        yield from walk(node.get_child_at_index(index), depth + 1)

deadline = time.monotonic() + 20
while time.monotonic() < deadline:
    matches = []
    for node in walk(Atspi.get_desktop(0)):
        if node.get_name() == "Add extension" and node.get_role_name() in ("button", "push button"):
            node.clear_cache()
            state = node.get_state_set()
            if state.contains(Atspi.StateType.SHOWING) and state.contains(Atspi.StateType.SENSITIVE):
                matches.append(node)
    matches = list(dict.fromkeys(matches))
    if len(matches) > 1:
        # Chromium can expose one native dialog under two accessibility paths.
        # Collapse only aliases of the exact same visible screen rectangle.
        rectangles = {tuple(node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)) for node in matches}
        assert len(rectangles) == 1, "Ambiguous private Chrome install dialog"
        matches = matches[:1]
    if matches:
        bounds = matches[0].get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        assert bounds.width > 0 and bounds.height > 0
        assert Atspi.generate_mouse_event(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, "b1c")
        print("Confirmed Add extension in the private Chrome profile", flush=True)
        break
    time.sleep(.1)
else:
    from PIL import ImageGrab
    ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).save("/tmp/workfold-chrome-install-dialog.png")
    for node in walk(Atspi.get_desktop(0)):
        if node.get_name() and node.get_state_set().contains(Atspi.StateType.SHOWING):
            print(repr(node.get_name()), node.get_role_name(), flush=True)
    raise RuntimeError("Native Chrome extension confirmation was unavailable")
