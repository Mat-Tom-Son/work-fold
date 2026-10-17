"""Simulated login services for a real, private GNOME Shell lock-screen test.

The compositor, ScreenShield, portal, PipeWire and libei are real. GDM/logind are
python-dbusmock fixtures: this does not qualify physical suspend or user login.
"""
import os
import pathlib
import dbus
import dbus.service
import dbus.mainloop.glib
from dbusmock import DBusMockObject
from gi.repository import GLib

assert os.environ.get("WORKFOLD_ISOLATED_GNOME_TEST") == "1"
assert pathlib.Path("/run/.containerenv").exists() or pathlib.Path("/.dockerenv").exists()
assert os.environ.get("XDG_RUNTIME_DIR") == "/tmp/workfold-runtime"
assert os.environ["DBUS_SYSTEM_BUS_ADDRESS"].startswith("unix:")
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SystemBus()
gdm_name = dbus.service.BusName("org.gnome.DisplayManager", bus=bus)
gdm = DBusMockObject(gdm_name, "/org/gnome/DisplayManager/Manager",
                    "org.gnome.DisplayManager.Manager", {"Version": "50.0"})
gdm.AddMethods("org.gnome.DisplayManager.Manager", [("RegisterSession", "", "", ""),
                                                  ("RegisterDisplay", "a{sv}", "", "")])
login_name = dbus.service.BusName("org.freedesktop.login1", bus=bus)
login = DBusMockObject(login_name, "/org/freedesktop/login1", "org.freedesktop.login1.Manager", {})
login.AddTemplate("logind", {})
# python-dbusmock 0.38's template concatenates the UInt32 argument to a str.
# Use its public method-definition API to supply the same typed object path.
login.AddMethod("org.freedesktop.login1.Manager", "GetUser", "u", "o",
                'ret = "/org/freedesktop/login1/user/" + str(args[0])')
login.AddSession("workfoldtest", "seat0", dbus.UInt32(os.getuid()), "workfold-test", True)
pathlib.Path("/tmp/workfold-login-services-ready").touch()
GLib.MainLoop().run()
