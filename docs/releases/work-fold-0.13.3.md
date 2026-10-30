# work-fold 0.13.3

October 30, 2026

Clearer file previews, native Mac menus, and more reliable History and background work.

- **Copy a file's contents.** Text previews have a labeled Copy button that reads the whole current file, including empty files and content beyond the preview limit. Markdown copies both formatted text and plain Markdown. Switching tabs cancels an unfinished copy.
- **A simpler file toolbar.** Copy, Attach to Chat, Share, and Open sit together, with less frequent actions in a named More menu.
- **Native Mac Chat and tab menus.** Right-click a Chat or tab for its actions, including Rename, Make a Copy, Snooze, Archive, and closing other tabs.
- **Clearer restore points.** History shows one list of changed files with inline comparisons and a Restore button at the top. History requests wait in order within each work-folder, while other work-folders stay independent. Replaced comparisons finish safely or are skipped before they start.
- **Distinct starting colors.** Newly created work-folders choose a less-used color, while existing identities and saved choices keep their appearance.
- **Smoother Chats and tabs.** Opening a past Chat avoids flashing the new-Chat greeting. Grouped tabs use colored work-folder icons, and hiding the sidebar squares the adjacent corners. Typing `/compact` compacts the current Chat instead of sending a model message.
- **Reliability fixes.** Improves toast timing, Stop shortcuts, work-fold agent scrolling, cancelled file reads, ignore-rule writes, background-job settlement, and desktop bridge reconnection. Bridge server fixes are included in the source and require a separate bridge deployment.

The [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest)
records publication; source notes alone do not establish availability.
