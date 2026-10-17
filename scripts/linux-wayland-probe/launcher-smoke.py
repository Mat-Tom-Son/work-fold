"""Resolve the installed launcher and icon through GTK on our private seat."""
from importlib import import_module
import gi

import_module("fixture-environment").require_isolated_session()
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("GioUnix", "2.0")
from gi.repository import Gdk, Gio, GioUnix, Gtk

app = GioUnix.DesktopAppInfo.new("work-fold.desktop")
assert app is not None and app.get_name() == "work-fold"
assert app.get_executable() == "/opt/work-fold/work-fold-desktop"
icon = app.get_icon()
assert isinstance(icon, Gio.ThemedIcon)
theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
assert theme.has_icon(icon.get_names()[0]), "The installed launcher icon is missing from the desktop icon theme"
for scale in (1, 2):
    paintable = theme.lookup_by_gicon(icon, 48, scale, Gtk.TextDirection.NONE, Gtk.IconLookupFlags(0))
    file = paintable.get_file()
    assert file is not None and "work-fold-desktop" in file.get_basename()
    print(f"PASS installed launcher icon at scale {scale}: {file.get_path()}", flush=True)
