"""Drive the real private stdio helper on the repository's disposable seat."""
import base64
import collections
import fcntl
import json
import os
import pathlib
import selectors
import struct
import subprocess
import time
import uuid

assert os.environ.get("WORKFOLD_ISOLATED_GNOME_TEST") == "1"
assert os.path.exists("/run/.containerenv") or os.path.exists("/.dockerenv")
assert os.environ.get("XDG_RUNTIME_DIR") == "/tmp/workfold-runtime"
root = pathlib.Path("/tmp/workfold-input-fixture")
assert not root.exists(), "Start with a new isolated input fixture"
ui = ["python3", "/work/scripts/linux-wayland-probe/portal-test-ui.py"]
binary = os.environ.get("WORKFOLD_WAYLAND_HELPER", "/work/out/included-tools/wayland-helper/work-fold-wayland")
scale = float(os.environ.get("WORKFOLD_NATIVE_TEST_SCALE", "1"))
assert scale in (1, 1.25, 1.5, 2)
size = tuple(int(value) for value in os.environ.get("WORKFOLD_NATIVE_TEST_SECOND_MONITOR", os.environ.get("WORKFOLD_NATIVE_TEST_SIZE", "1280x720")).split("x"))
assert size in ((1280, 720), (2560, 1440), (2880, 1800))
if os.environ.get("WORKFOLD_NATIVE_TEST_TRANSFORM") in ("1", "3"):
    size = tuple(reversed(size))
expected = "Wayland: y z Ä Ö Ü ä ö ü ß @ € {value} [x] \\ | ~" if os.environ.get("WORKFOLD_NATIVE_TEST_LAYOUT") == "de" else "Wayland protocol input verified."
subprocess.run(ui + ["desktop-ready"], check=True)
fixture_log = open("/tmp/workfold-gtk-protocol.log", "wb")
fixture_env = dict(os.environ)
if os.environ.get("WORKFOLD_NATIVE_TEST_WAYLAND_TRACE") == "1":
    fixture_env["WAYLAND_DEBUG"] = "client"
fixture = subprocess.Popen(["python3", "/work/scripts/linux-wayland-probe/input-fixture.py"], env=fixture_env, stderr=fixture_log)


def wait_until(predicate, seconds=5):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(.02)
    raise AssertionError("Native fixture condition did not settle")


def events():
    return json.loads((root / "events.json").read_text())


class Helper:
    def __init__(self, label):
        self.log = open(root / (label + ".log"), "wb")
        self.process = subprocess.Popen([binary, "--stdio"], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.log)
        os.set_blocking(self.process.stdout.fileno(), False)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b""

    def send(self, method, **args):
        if method == "act":
            for action in args.get("actions", []):
                for point in [action, *action.get("path", [])]:
                    for coordinate in ("x", "y"):
                        if coordinate in point:
                            point[coordinate] *= scale
        identity = str(uuid.uuid4())
        self.process.stdin.write((json.dumps({"id": identity, "command": {"method": method, **args}}) + "\n").encode())
        self.process.stdin.flush()
        return identity

    def result(self, identity, error=False):
        end = time.monotonic() + 20
        while b"\n" not in self.buffer:
            assert time.monotonic() < end, "Native helper response timed out"
            assert self.process.poll() is None, "Native helper ended before response"
            if self.selector.select(.1):
                block = os.read(self.process.stdout.fileno(), 65536)
                assert block, "Native helper closed stdout"
                self.buffer += block
                assert len(self.buffer) <= 40 * 1024 * 1024
        line, self.buffer = self.buffer.split(b"\n", 1)
        result = json.loads(line)
        assert result["id"] == identity and result["version"] == 1
        if error:
            assert result.get("error") and result["retry"] is False, result
            return result
        assert "error" not in result, result
        return result["result"]

    def call(self, method, error=False, **args):
        return self.result(self.send(method, **args), error)

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=6)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)
            raise AssertionError("Native helper failed cooperative teardown")
        self.selector.close()
        self.log.close()


helpers = []
try:
    wait_until(lambda: (root / "events.json").exists() and events()["mapped"])
    helper = Helper("protocol")
    helpers.append(helper)
    helper.call("status", error=True)
    starting = helper.send("start")
    subprocess.run(ui + ["choose-input"], check=True)
    state = helper.result(starting)
    assert state["kind"] == "shared_screen" and state["devicesGranted"] == 3
    subprocess.run(ui + ["closed"], check=True)
    lease = helper.call("begin", turn=str(uuid.uuid4()))["lease"]
    helper.call("begin", error=True, turn=str(uuid.uuid4()))
    helper.call("observe", error=True, lease=str(uuid.uuid4()))
    with open("/tmp/workfold-runtime/work-fold-wayland-seat.lock", "r+") as seat:
        try:
            fcntl.flock(seat, fcntl.LOCK_EX | fcntl.LOCK_NB)
            raise AssertionError("A second process acquired the owned seat")
        except BlockingIOError:
            pass
    observed = helper.call("observe", lease=lease)
    image = base64.b64decode(observed["image"]["data"], validate=True)
    assert image[:8] == b"\x89PNG\r\n\x1a\n" and struct.unpack(">II", image[16:24]) == size
    assert observed["inputAvailable"] and observed["kind"] == "shared_screen"
    (root / "protocol-capture.png").write_bytes(image)
    # A whole invalid batch is rejected before its otherwise-valid first click.
    helper.call("act", error=True, lease=lease, observation=observed["observationId"], actions=[
        {"action": "click", "x": 500, "y": 160}, {"action": "moveMouse", "x": -1, "y": 160}])
    assert events()["clicks"] == 0
    observed = helper.call("observe", lease=lease)
    old = observed["observationId"]
    wait_until(lambda: events()["active"])
    actions = [
        {"action": "click", "x": 500, "y": 160},
        {"action": "typeText", "text": expected},
        {"action": "scroll", "x": 500, "y": 160, "scrollX": 0, "scrollY": 120},
        {"action": "keypress", "keys": ["Ctrl", "s"]},
    ]
    result = helper.call("act", lease=lease, observation=old, actions=actions)
    assert result["inputSent"] and result["actionCount"] == len(actions)
    (root / "protocol-successor.png").write_bytes(base64.b64decode(result["image"]["data"], validate=True))
    wait_until(lambda: events()["saved"])
    assert (root / "saved.txt").read_text() == expected
    helper.call("act", error=True, lease=lease, observation=old,
                actions=[{"action": "click", "x": 500, "y": 160}])
    assert events()["clicks"] == 1
    result = helper.call("act", lease=lease, observation=result["observationId"], actions=[
        {"action": "moveMouse", "x": 300, "y": 160},
        {"action": "drag", "path": [{"x": 300, "y": 160}, {"x": 400, "y": 160}, {"x": 500, "y": 160}]},
        {"action": "keypress", "keys": ["Escape"]},
    ])
    wait_until(lambda: events()["clicks"] == 2 and events()["buttonReleases"] == 2)
    assert events()["scrolls"] >= 1
    assert collections.Counter(events()["presses"]) == collections.Counter(events()["releases"])
    helper.call("end", lease=lease)
    helper.call("observe", error=True, lease=lease)
    with open("/tmp/workfold-runtime/work-fold-wayland-seat.lock", "r+") as seat:
        fcntl.flock(seat, fcntl.LOCK_EX | fcntl.LOCK_NB)
    new_lease = helper.call("begin", turn=str(uuid.uuid4()))["lease"]
    assert new_lease != lease
    helper.call("act", error=True, lease=new_lease, observation=result["observationId"],
                actions=[{"action": "click", "x": 500, "y": 160}])
    subprocess.run(["gdbus", "call", "--session", "--dest", "org.gnome.ScreenSaver", "--object-path", "/org/gnome/ScreenSaver",
                    "--method", "org.gnome.ScreenSaver.SetActive", "true"], check=True, stdout=subprocess.DEVNULL)
    wait_until(lambda: helper.process.poll() is not None, seconds=6)
    helper.stop()
    subprocess.run(["gdbus", "call", "--session", "--dest", "org.gnome.ScreenSaver", "--object-path", "/org/gnome/ScreenSaver",
                    "--method", "org.gnome.ScreenSaver.SetActive", "false"], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(ui + ["closed"], check=True)
    print("PASS real native protocol: PNG, exclusive OS seat lease, wrong-owner/stale-state rejection, preflight, click/type/scroll/shortcut/drag, exact saved bytes, balanced input and screen-lock revocation", flush=True)

    pending = Helper("pending-stop")
    helpers.append(pending)
    pending.send("start")
    subprocess.run(ui + ["wait"], check=True)
    pending.stop()
    subprocess.run(ui + ["closed"], check=True)
    assert "Portal session close: confirmed" in (root / "pending-stop.log").read_text()
    print("PASS native protocol Stop closes the pending desktop chooser", flush=True)
finally:
    for helper in helpers:
        helper.stop()
    fixture.terminate()
    fixture.wait(timeout=5)
    fixture_log.close()
