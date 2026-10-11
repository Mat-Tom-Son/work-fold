# work-fold 0.4.51

October 11, 2026

- The work-fold agent now has a panel on the right side of the main window. Open it with the work-fold mark at the top right or ⌘J. **Chats** and **New Chat** sit beside the mark. The panel shows the agent's thinking and tool steps while it works, the same way a Worker's chat does. **Ask the work-fold agent** in Checks and Automations puts the draft in this panel. The menu-bar popover still works.
- A button next to the macOS window controls hides the sidebar, and ⌘B does the same. Clicking it again, or any rail destination such as Files, Chats, or History, brings the sidebar back.
- A sort button next to Files search orders files by name, date modified, size, or kind. Folders stay first, and this computer remembers the choice.
- Code, the `work-fold` CLI, local API routes, and saved data now use the interface's words. In the CLI that means `work-folders`, `agent`, `automations`, `recently-deleted`, and `--work-folder`. Scripts that call the old verbs need updating. The first launch migrates saved data once and keeps the originals under `vocabulary-migration-backup/` in app data. It never rewrites your files, conversation logs, or History.
- Agents are no longer cut off at small sizes. Delegated results, questions, and answers reach the work-fold agent whole. The CLI no longer truncates its output. Automations, model Checks, and agent-built apps get much larger working limits. The text-review Check changed, so any text-review Check that was on must be turned on again.
- The rest of the retired Library is gone: the `work-fold library` commands and `/api/resources` routes. An existing `resources/` folder in app data is left untouched.
- Copy buttons, including copying a shared page link, now work reliably when a native window takes focus.
- In the browser on work-fold.com, chat has a cleaner layout and **Shared pages** replaces Files.

The [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest) records publication; source notes alone do not establish availability.
