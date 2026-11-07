import { desktopShortcutKeyLabel, desktopShortcutKeySpokenName, desktopShortcutModifierKey } from "../../lib/keyboard";
import { isMacOS } from "../../lib/platform";
import type { ShortcutGroup } from "../../types";

/**
 * The file manager layout's keys (docs/product-model.md, 2026-11-06 file
 * manager layout): Finder's keys for the list and search, and the menu bar's
 * work-fold commands. It has no tabs, command palette, or agent panel, so
 * their keys are not listed.
 */
export function fileManagerShortcutGroups(modifier: string, macOS: boolean, desktop: boolean): ShortcutGroup[] {
  return [
    {
      title: "Files",
      rows: [
        { keys: ["Arrow up"], action: "Select the item above." },
        { keys: ["Arrow down"], action: "Select the item below." },
        { keys: ["Shift", "Arrow down"], action: "Add the next item to the selection." },
        { keys: [modifier, "A"], action: "Select every item." },
        { keys: ["Space"], action: "Quick Look the selected item." },
        { keys: [modifier, "Arrow down"], action: "Open the selected item." },
        { keys: [modifier, "Arrow up"], action: "Go to the enclosing folder." },
        { keys: [modifier, "["], action: "Go back." },
        { keys: [modifier, "]"], action: "Go forward." },
        { keys: [modifier, "Shift", "G"], action: "Go to a folder by its path." },
        { keys: [modifier, "C"], action: "Copy the selected items (Finder can paste them too)." },
        { keys: [modifier, "V"], action: "Paste items copied here or in Finder." },
        { keys: [macOS ? "Option" : "Alt", modifier, "V"], action: "Move the items copied here into this folder." },
        { keys: [modifier, "D"], action: "Duplicate the selected items." },
        { keys: [modifier, "Z"], action: "Undo the last file change." },
        { keys: [modifier, "Shift", "Z"], action: "Redo it." },
        { keys: ["Enter"], action: "Rename the selected item." },
        { keys: [modifier, "Backspace"], action: macOS ? "Delete. Undo it from History, or from the Trash in a Standard Folder." : "Delete. Undo it from History." },
        { keys: ["Esc"], action: "Clear the selection." },
      ],
    },
    {
      title: "Search",
      rows: [
        { keys: [modifier, "F"], action: "Search names and contents." },
        { keys: ["Arrow down"], action: "Choose the next result." },
        { keys: ["Enter"], action: "Open the chosen result." },
        { keys: ["Esc"], action: "Clear the search." },
      ],
    },
    {
      title: "Chat",
      rows: [
        ...(desktop ? [{ keys: [modifier, "Shift", "N"], action: "Start a new Chat in this work-folder." }] : []),
        { keys: [modifier, "."], action: "Stop the Worker's reply." },
      ],
    },
    ...(desktop ? [{
      title: "work-fold",
      rows: [
        { keys: [modifier, "N"], action: "Create a new work-folder." },
        { keys: [modifier, "O"], action: "Use an existing folder." },
        { keys: [modifier, "R"], action: "Refresh the folder." },
        { keys: [modifier, "Shift", "S"], action: "Open Skills & Extensions." },
        { keys: [modifier, ","], action: "Open Settings." },
        { keys: [modifier, "/"], action: "Open Shortcut Keys." },
      ],
    }] : []),
  ];
}

export function KeyboardShortcutsPane({ layout = "classic" }: { layout?: "classic" | "file-manager" } = {}) {
  const modifier = desktopShortcutModifierKey();
  const macOS = isMacOS();
  if (layout === "file-manager") return <ShortcutGroups groups={fileManagerShortcutGroups(modifier, macOS, Boolean(window.workFoldDesktop))} />;
  const shortcutGroups: ShortcutGroup[] = [
    {
      title: "Tabs",
      rows: [
        { keys: [modifier, "T"], action: "Open a new Chat tab in the current work-folder." },
        { keys: ["Ctrl", "Tab"], action: "Move to the next tab." },
        { keys: ["Ctrl", "Shift", "Tab"], action: "Move to the previous tab." },
        { keys: [modifier, "1–9"], action: "Jump to a tab by position; 9 is the last tab." },
        { keys: macOS ? [modifier, "W"] : ["Ctrl", "W"], action: "Close the active tab." },
        ...(macOS ? [{ keys: [modifier, "Shift", "W"], action: "Close the window." }] : []),
        { keys: ["Arrow left"], action: "Move to the previous tab when focus is on the tab list." },
        { keys: ["Arrow right"], action: "Move to the next tab when focus is on the tab list." },
        { keys: ["Alt", "Shift", "Arrow left"], action: "Move the focused tab one position left; grouped tabs stay in their work-folder." },
        { keys: ["Alt", "Shift", "Arrow right"], action: "Move the focused tab one position right; grouped tabs stay in their work-folder." },
        { keys: ["Home"], action: "Move to the first tab." },
        { keys: ["End"], action: "Move to the last tab." },
      ],
    },
    {
      title: "Chat",
      rows: [
        { keys: [modifier, "."], action: "Stop the running Worker turn in the active Chat." },
      ],
    },
    {
      title: "Navigation Pane",
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
      title: "File Search",
      rows: [
        { keys: ["Esc"], action: "Clear the file search field when it has text." },
        { keys: [macOS ? "Option" : "Alt", "Drag"], action: `Drag a file out to ${macOS ? "Finder" : "File Explorer"}. Drag normally to move it inside the work-folder.` },
      ],
    },
    {
      title: "Layout",
      rows: [
        { keys: [modifier, "B"], action: "Show or hide the sidebar." },
        { keys: [modifier, "J"], action: "Open or close the work-fold agent." },
      ],
    },
    {
      title: "Help",
      rows: [
        { keys: [modifier, "K"], action: "Command palette." },
        { keys: [modifier, "/"], action: "Open Shortcut Keys." },
      ],
    },
  ];
  if (window.workFoldDesktop) {
    shortcutGroups.splice(4, 0, {
      title: "Desktop File Menu",
      rows: [
        { keys: [modifier, "N"], action: "Create a new work-folder." },
        { keys: [modifier, "O"], action: "Use an existing folder." },
        { keys: [modifier, "Shift", "N"], action: "Start a new Chat in the current work-folder." },
        { keys: [modifier, "R"], action: "Refresh the current work-folder." },
        { keys: [modifier, ","], action: "Open Settings." },
        { keys: [modifier, "Shift", "S"], action: "Open Skills & Extensions." },
      ],
    });
  }

  return <ShortcutGroups groups={shortcutGroups} />;
}

function ShortcutGroups({ groups: shortcutGroups }: { groups: ShortcutGroup[] }) {
  return (
    <section className="keyboard-shortcuts-pane">
      <h2 className="sr-only">Shortcut Keys</h2>
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
