import { desktopPlatform, type DesktopPlatform } from "./platform";

function desktopShortcutModifierKey(platform: DesktopPlatform = desktopPlatform()): string {
  return platform === "darwin" ? "Command" : "Ctrl";
}

const macKeyGlyphs: Record<string, string> = {
  Command: "⌘",
  Ctrl: "⌃",
  Option: "⌥",
  Shift: "⇧",
  Enter: "↩",
  Esc: "⎋",
  "Arrow left": "←",
  "Arrow right": "→",
};

function desktopShortcutKeyLabel(key: string, platform: DesktopPlatform = desktopPlatform()): string {
  if (platform !== "darwin") return key;
  return macKeyGlyphs[key] ?? key;
}

const spokenKeyNames: Record<string, string> = {
  Ctrl: "Control",
  Esc: "Escape",
};

/** Full-word key name for assistive technology, whatever the visible glyph. */
function desktopShortcutKeySpokenName(key: string): string {
  return spokenKeyNames[key] ?? key;
}

export { desktopShortcutKeyLabel, desktopShortcutKeySpokenName, desktopShortcutModifierKey };
