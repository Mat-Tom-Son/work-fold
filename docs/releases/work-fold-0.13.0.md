# work-fold 0.13.0

October 23, 2026

work-fold now has a browser shared by you, the work-fold agent, and every Worker.

- **Browse beside your work.** Open websites, local files, and a Worker's dev server in tabs beside Chats and files. Browser tabs stay available across work-folders and return after a restart. One work-fold profile keeps its own sign-ins, separate from Chrome.
- **Let Workers work in pages.** Every Worker and the work-fold agent can read pages, inspect screenshots, click and type, reveal hover menus, drag sliders and items, scroll inside panels, attach local files to file inputs, and locate completed downloads. Their activity names the Chat using the page and keeps Stop available.
- **Use familiar browser controls.** The browser includes address suggestions and history, Find in page, zoom, tab reopening, printing and PDF saving, spelling suggestions, link previews, site permissions, and pop-up controls. Downloads keep distinct names even when matching files arrive together.
- **Keep shared browser work coordinated.** Input operations on one page take turns, Stop prevents further input, a stopped drag releases the mouse button, and a Chat closes only tabs it opened. Workers are taught to inspect the result before claiming success and to treat page content as untrusted.
- **Update browser certificate protection.** Electron 42.11.18 includes the block for compromised eMudhra intermediate certificates in Chromium and Node networking, following [Electron's security advisory](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9).
- **Recover removed Skills.** Imported Skills move to Recently deleted, with Undo and restoration to their original scope.
- **Keep everyday work in place.** Sent Chat attachments remain visible with their message, Attach to Chat follows the current or most recent Chat, unsaved AI Models edits survive closing Settings, and searching Files preserves the folder view.

File attachment currently uses an observed file-input ref and regular local files;
folder inputs and native file chooser automation are unsupported. Download
observations cover recent transfers during the current app launch. Browser
pages remain sandboxed, and a site's camera, microphone, location, or similar
permission request still needs the person's answer.

See [Built-in browser](../built-in-browser.md) and [Worker tools](../worker-tools.md).
The [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest)
records publication; source notes alone do not establish availability.
