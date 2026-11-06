"""Refuse desktop interaction outside an explicitly provisioned private fixture."""
import json
import os
import pathlib
import shlex
import stat
import subprocess
import uuid


def require_isolated_session():
    assert (os.environ.get("WORKFOLD_ISOLATED_GNOME_TEST") == "1") != (os.environ.get("WORKFOLD_ISOLATED_KDE_TEST") == "1")
    vm_id = os.environ.get("WORKFOLD_ISOLATED_VM_TEST")
    if vm_id:
        assert str(uuid.UUID(vm_id)) == vm_id
        marker = pathlib.Path("/etc/workfold-disposable-vm.json")
        info = marker.lstat()
        assert stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o022 == 0
        record = json.loads(marker.read_text())
        assert record["schema"] == "work-fold.disposable-vm.v1" and record["fixtureId"] == vm_id
        assert record["machineId"] == pathlib.Path("/etc/machine-id").read_text().strip()
        assert record["userUid"] == os.getuid() and os.getuid() != 0
        # systemd names QEMU's CPU-emulated and KVM-accelerated machines
        # differently. Both still require this provisioned guest's identity.
        assert subprocess.check_output(["systemd-detect-virt", "--vm"], text=True, timeout=5).strip() in {"qemu", "kvm"}
        assert pathlib.Path("/sys/class/dmi/id/sys_vendor").read_text().strip() == "QEMU"
        runtime = pathlib.Path(f"/run/user/{os.getuid()}")
        assert os.environ.get("XDG_RUNTIME_DIR") == str(runtime)
        assert os.environ.get("DBUS_SESSION_BUS_ADDRESS") == f"unix:path={runtime}/bus"
        assert not os.environ.get("DBUS_SYSTEM_BUS_ADDRESS")
        assert os.environ.get("XDG_SESSION_TYPE") == "wayland"
        assert runtime.stat().st_uid == os.getuid() and runtime.stat().st_mode & 0o077 == 0
        display = os.environ["WAYLAND_DISPLAY"]
        assert display.startswith("wayland-") and "/" not in display
        assert stat.S_ISSOCK((runtime / display).stat().st_mode)
        return "vm"
    assert pathlib.Path("/run/.containerenv").exists() or pathlib.Path("/.dockerenv").exists()
    assert os.environ.get("XDG_RUNTIME_DIR") == "/tmp/workfold-runtime"
    recorded = dict(shlex.split(line)[1].split("=", 1) for line in open("/tmp/workfold-session.env"))
    assert os.environ["DBUS_SESSION_BUS_ADDRESS"] == recorded["DBUS_SESSION_BUS_ADDRESS"]
    return "container"


if __name__ == "__main__":
    print(require_isolated_session())
