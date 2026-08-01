import { useRef } from "react";
import { desktopShortcutKeyLabel, desktopShortcutModifierKey } from "../../lib/keyboard";
import { isMacOS } from "../../lib/platform";
import { useModalDialog } from "../../hooks/useModalDialog";
import type { ShortcutGroup } from "../../types";

function KeyboardShortcutsModal({ onClose }: { onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useModalDialog({ onClose, initialFocusRef: closeButtonRef });
  const modifier = desktopShortcutModifierKey();
  const macOS = isMacOS();
  const shortcutGroups: ShortcutGroup[] = [
    {
      title: "Open surfaces",
      rows: [
        { keys: ["Arrow left"], action: "Move to the previous surface tab when focus is on the tab list." },
        { keys: ["Arrow right"], action: "Move to the next surface tab when focus is on the tab list." },
        { keys: ["Home"], action: "Move to the first surface tab." },
        { keys: ["End"], action: "Move to the last surface tab." },
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
        { keys: [macOS ? "Option" : "Alt", "Drag"], action: `Drag a file out to ${macOS ? "Finder" : "File Explorer"}. Drag normally to move it inside the Space.` },
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
    shortcutGroups.splice(3, 0, {
      title: "Desktop File menu",
      rows: [
        { keys: [modifier, "N"], action: "Create a new Space." },
        { keys: [modifier, "O"], action: "Turn an existing folder into a Space." },
        { keys: [modifier, "Shift", "N"], action: "Start a new Chat in the current Space." },
        { keys: [modifier, "R"], action: "Refresh the current Space." },
        { keys: [modifier, ","], action: "Open Settings." },
        { keys: [modifier, "Shift", "S"], action: "Open Assistant tools." },
      ],
    });
  }

  return (
    <div className="modal-backdrop keyboard-shortcuts-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="keyboard-shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-title keyboard-shortcuts-title">
          <div>
            <h2 id="keyboard-shortcuts-title">Keyboard shortcuts</h2>
          </div>
          <button ref={closeButtonRef} className="ghost-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="keyboard-shortcuts-grid">
          {shortcutGroups.map((group) => (
            <section className="keyboard-shortcuts-group" key={group.title}>
              <h3>{group.title}</h3>
              <div className="keyboard-shortcuts-list">
                {group.rows.map((row) => (
                  <div className="keyboard-shortcut-row" key={`${group.title}:${row.keys.join("+")}:${row.action}`}>
                    <span className="keyboard-shortcut-keys" aria-label={row.keys.join(" plus ")}>
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
    </div>
  );
}

export { KeyboardShortcutsModal };
