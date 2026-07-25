# Desktop experience parity

Workspace is a product extraction of the mature Kai Workspace desktop experience, not a new interface inspired by it. The neutral desktop interaction model from `win-kymadocs` commit `57ff910` is the behavioral baseline. Product-specific integrations and language may be replaced, but the general-purpose interaction quality should be preserved.

## Product translation

| Baseline concept | Workspace concept |
| --- | --- |
| Workspace backed by a local SharePoint mirror | Space backed directly by an ordinary folder |
| Kits | Skills |
| Sources | Library |
| Microsoft organization login | Assistant setup using Pi providers |
| Kai | Assistant |
| SharePoint sync and publish | Local files first; cloud-synced folders work through their desktop clients |

The translation is intentionally narrow. It does not justify replacing the shell, tabs, file interactions, chat experience, desktop integration, or accessibility behavior.

## Required interaction model

### Persistent surface tabs

- Chat, file, Library, History, and appearance surfaces open as tabs instead of route-only panes.
- Tabs persist and restore across application restarts.
- Each tab retains its Space identity; activating a tab from another Space activates that Space.
- Each Space remembers its most recently active tab.
- Existing conversations deduplicate to one tab while multiple unsent New Chat drafts remain possible.
- Renamed conversations update their tab titles.
- Moving or renaming a file retargets its open tab; deleting it closes the affected tab.
- Closing a tab selects the adjacent tab predictably.
- Arrow keys, Home, and End navigate the tab strip with correct focus and ARIA tab semantics.
- Inactive tab panels remain mounted when needed so drafts, scroll position, and transient UI state survive tab switches.

### Desktop shell

- Preserve the Windows custom title bar and the platform menu contract; macOS uses its native hidden-inset title bar plus application, File, Edit, View, Window, and Help menus.
- Preserve window size, position, maximized state, theme integration, and renderer recovery behavior.
- On Windows, closing the window may hide Workspace to the system tray when the preference is enabled. On macOS, closing the last window keeps the application host alive and the Dock icon recreates the window. Explicit Quit exits cleanly on both.
- The tray exposes clear Show and Quit actions and does not strand an invisible process.
- Update status and commands remain available from both the platform-appropriate desktop menu and settings surface.

### Files and folders

- The Files rail item, resizable file pane, search, expandable tree, file-type icons, details pane, and file history remain first-class for the selected Space.
- Right-click actions are available throughout the file tree and use native desktop context behavior where appropriate.
- Supported actions include open, reveal in Explorer/Finder, copy path, attach to chat, rename, move, upload/import, delete, and version history. File and folder creation controls should appear only when the corresponding workflow is implemented and verified.
- Desktop drag-out, file opening, and reveal operations use safe workspace-relative paths and never escape the Space root.
- Destructive actions require clear confirmation and preserve recovery/history behavior where supported.
- Registering an existing folder as a Space never moves or converts user files. It maintains only the documented hidden `.workspace/` identity and conversation layer; that layer and native `.pi/` configuration never appear as ordinary Files.

### Chat and navigation

- Preserve conversation history, rename, drafts, streaming activity, tool/runtime detail, stop behavior, context attachments, copy actions, suggested prompts, and extension UI requests.
- Preserve the command palette, keyboard shortcuts, toast/confirm feedback, onboarding, Space creation/linking, themes, typography, and resizable layout.
- A dedicated Space selector chooses the root-folder entity. Primary rail navigation uses `Files`, `Chats`, and `History`; the bottom-rail Add menu opens Library as a persistent Space-owned tab, Assistant-tool discovery/management, or app building. Library stays one shared personal collection: the owning Space is the default copy target, and any registered Space can be selected explicitly. The Space-owned Assistant tools work tab combines Installed and Discover views for Skills and Extensions while retaining scope, provenance, load state, diagnostics, and package lifecycle. Provider, model, API-key, and OAuth setup lives in `Settings → Assistant`.

### Management layer and CLI

- The read-only management layer is additive infrastructure; it must not replace or weaken Space-bound tabs, background continuity, native menus, or the visible trust and capability-management surfaces.
- The installed `workspace` command resolves the terminal's current folder to the same Space model as the renderer, can report live Assistant/compaction tasks, and exposes compact capability metadata through stable JSON.
- A headless CLI request must coexist with the running single-instance desktop app, return bounded stdout/stderr/exit status, and avoid opening or stealing focus from the interactive window.
- Installer PATH integration must be reversible and must not modify shell profile files.

### Restricted Space apps

- A reviewed restricted app belongs to exactly one Space and contributes its rail navigator without becoming a full-trust Pi Extension or silently inheriting another Space's identity.
- App-requested work tabs are ordinary persistent Space-owned tabs. Restoring or activating one restores its owning Space, while removal or a reviewed-digest change cannot leave a stale executable view mounted.
- Adding a preview, each network destination, each Space-file grant, each notification category, each stored connection, and each named automation remain separate, visible controls. Adding the preview grants none of them.
- Visible UI and optional worker execution use separate sandbox hosts. Direct networking, Node access, arbitrary navigation, and host powers outside an accepted UI/action/automation lifecycle remain denied.
- Machine-local app storage survives a reviewed app update and an application update. Active visible app UI receives bounded invalidation hints; inactive views recover durable state when reopened instead of receiving queued hidden updates.
- System notifications use only reviewed static copy during a separately enabled automation whose permission subset includes the granted category. Clicking one targets the exact owning Space and app, and revocation, suspend, app stop, removal, or shutdown closes outstanding authority and native handles.

## Deliberately removed or replaced

- Microsoft/Azure organization authentication and organization-account UI.
- SharePoint mirror, publish, readiness, and controlled-document semantics.
- Compliance/SOP-specific review surfaces and Kymanox/Kai branding.
- Company signing credentials and compatibility identifiers that are not needed by the separate Workspace product.

Pi remains the agent runtime. Workspace should expose Pi's provider setup, standard built-in tools, Skills, Extensions, packages, registered-Space project authorization, and supported extension UI without inventing a second full-trust capability system. Restricted app packages are a deliberately separate sandbox lane and must never be loaded as Pi Extensions.

## Acceptance evidence

A corrective port is ready for release only when all of the following are true:

1. The original and Workspace fixture screens have been captured at the same viewport and reviewed side by side.
2. Tabs have been exercised for restore, multiple drafts, cross-Space activation, rename, move, delete, close fallback, and keyboard navigation.
3. File-tree context actions and native open/reveal/drag behavior have been exercised against a disposable Space.
4. Custom menus, close-to-tray, Show, Quit, window-state restore, and updater surfaces have been exercised in packaged Electron.
5. Type checks, tests, renderer build, desktop compile/preflight, the real-Electron restricted-app probe, and a packaged smoke build pass on the supported Node runtime.
6. The app contains no user-facing Kai, Kymanox, Kits, Sources, SharePoint, or Microsoft-login copy except in migration or historical documentation.
7. The packaged CLI resolves context, lists Spaces/tasks/capabilities, coexists with the GUI, and cleans its request/response handoff.
8. No public release is published until the product review is accepted and the release commit is green on main CI.
9. The checked-in restricted Connected inbox example has been exercised in a disposable Space for default-off grants and schedules, rail and persistent-tab ownership, storage invalidation/reload, explicit named automation runs and receipts, static notification routing, revocation, suspend/resume, and teardown.
10. An installed-updater smoke preserves version-2 restricted-app reviewed digests, grants, encrypted connection status, automation settings and receipts, local storage, and Space-owned surfaces across the version change.

## Accepted public baseline

The first July 10, 2026 local candidate at commit `71e5fa4` was rejected after real screenshots exposed two release-blocking defects: it called the Files surface “Space,” and several newly written pane structures had no matching styles. That build remains historical evidence of why packaged visual review is a release gate.

Workspace 0.2.7 at commit `db5c149` established the accepted public baseline on July 12, 2026. It preserves the interaction contract above, uses the compact Fluent icon-only rail with accessible labels/tooltips, applies supported Windows Mica with a safe fallback, and includes the shared management kernel and installed read-only CLI.

The 0.2.8 development checkpoint at commit `27aa329` established the restricted-app sandbox baseline: Space-owned rail and work-tab surfaces, separate visible and worker sandboxes, default-off external authority, host-owned connections and storage, deterministic teardown, and a release-gating real-Electron probe. The current version-2 contract replaces its single-job prototype with named automations; compatibility with that unreleased manifest shape is intentionally not retained. The checkpoint notes remain in [releases/0.2.8.md](releases/0.2.8.md) as development history.

Future changes must retain those behaviors while satisfying [the Workspace visual system](visual-design.md), [the management-layer contract](management-layer.md), and the current build/release gates. Browser review must cover every primary, Assistant, and restricted-app surface in light and dark themes at the true minimum window size and at a tall desktop aspect ratio. Automated checks must continue to guard the Files/Space distinction, Space-bound tabs, Fluent shell-icon contract, compact neutral chrome, JSX-to-CSS contracts, and the restricted-app runtime boundary.
