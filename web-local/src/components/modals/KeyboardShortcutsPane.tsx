import { desktopShortcutKeyLabel, desktopShortcutKeySpokenName, desktopShortcutModifierKey } from "../../lib/keyboard";
import { isMacOS } from "../../lib/platform";
import type { ShortcutGroup } from "../../types";

export function KeyboardShortcutsPane() {
  const modifier = desktopShortcutModifierKey();
  const macOS = isMacOS();
  const shortcutGroups: ShortcutGroup[] = [
    {
      title: "Open surfaces",
      rows: [
        { keys: [modifier, "T"], action: "Open a new Chat tab in the current work-folder." },
        { keys: ["Ctrl", "Tab"], action: "Move to the next surface tab." },
        { keys: ["Ctrl", "Shift", "Tab"], action: "Move to the previous surface tab." },
        { keys: [modifier, "1–9"], action: "Jump to a surface tab by position; 9 is the last tab." },
        { keys: macOS ? [modifier, "W"] : ["Ctrl", "W"], action: "Close the active surface tab." },
        ...(macOS ? [{ keys: [modifier, "Shift", "W"], action: "Close the window." }] : []),
        { keys: ["Arrow left"], action: "Move to the previous surface tab when focus is on the tab list." },
        { keys: ["Arrow right"], action: "Move to the next surface tab when focus is on the tab list." },
        { keys: ["Alt", "Shift", "Arrow left"], action: "Move the focused tab one position left; grouped tabs stay in their work-folder." },
        { keys: ["Alt", "Shift", "Arrow right"], action: "Move the focused tab one position right; grouped tabs stay in their work-folder." },
        { keys: ["Home"], action: "Move to the first surface tab." },
        { keys: ["End"], action: "Move to the last surface tab." },
      ],
    },
    {
      title: "Chat",
      rows: [
        { keys: [modifier, "."], action: "Stop the running Worker turn in the active Chat." },
      ],
    },
    {
      title: "Navigation pane",
      rows: [
        { keys: ["Arrow left"], action: "Narrow the navigation pane when focus is on the separator." },
        { keys: ["Arrow right"], action: "Widen the navigation pane when focus is on the separator." },
        { keys: ["Shift", "Arrow left"], action: "Narrow the navigation pane by a larger step." },
        { keys: ["Shift", "Arrow right"], action: "Widen the navigation pane by a larger step." },
        { keys: ["Home"], action: "Move the separator to its minimum width." },
        { keys: ["End"], action: "Move the separator to its maximum width." },
        { keys: ["Enter"], action: "Reset the navigation pane width." },
      ],
    },
    {
      title: "File search",
      rows: [
        { keys: ["Esc"], action: "Clear the file search field when it has text." },
        { keys: [macOS ? "Option" : "Alt", "Drag"], action: `Drag a file out to ${macOS ? "Finder" : "File Explorer"}. Drag normally to move it inside the work-folder.` },
      ],
    },
    {
      title: "Help",
      rows: [
        { keys: [modifier, "K"], action: "Command palette." },
        { keys: [modifier, "/"], action: "Open keyboard shortcuts." },
      ],
    },
  ];
  if (window.workFoldDesktop) {
    shortcutGroups.splice(4, 0, {
      title: "Desktop File menu",
      rows: [
        { keys: [modifier, "N"], action: "Create a new work-folder." },
        { keys: [modifier, "O"], action: "Add an existing folder." },
        { keys: [modifier, "Shift", "N"], action: "Start a new Chat in the current work-folder." },
        { keys: [modifier, "R"], action: "Refresh the current work-folder." },
        { keys: [modifier, ","], action: "Open Settings." },
        { keys: [modifier, "Shift", "S"], action: "Open Skills & Extensions." },
      ],
    });
  }

  return (
    <section className="keyboard-shortcuts-pane">
      <h2>Keyboard Shortcuts</h2>
        <div className="keyboard-shortcuts-grid">
          {shortcutGroups.map((group) => (
            <section className="keyboard-shortcuts-group" key={group.title}>
              <h3>{group.title}</h3>
              <div className="keyboard-shortcuts-list">
                {group.rows.map((row) => (
                  <div className="keyboard-shortcut-row" key={`${group.title}:${row.keys.join("+")}:${row.action}`}>
                    <span className="keyboard-shortcut-keys" aria-label={row.keys.map(desktopShortcutKeySpokenName).join(" plus ")}>
                      {row.keys.map((key) => <kbd key={key}>{desktopShortcutKeyLabel(key)}</kbd>)}
                    </span>
                    <span>{row.action}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
    </section>
  );
}
