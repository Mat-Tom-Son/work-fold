# work-fold 0.3.17

September 1, 2026

work-fold 0.3.17 makes Space management quieter and more direct, and closes
the remaining review and scheduling gaps in one-time Routings.

## Manage Spaces

- **Existing folder** and **New Space** are compact side-by-side actions with
  no explanatory filler.
- Selecting a Space opens customization without leaving **Manage Spaces** or
  changing the active Space.
- Rename lives at the top of **Customize Space**; the separate rename and
  customize buttons are gone.
- Managed-Space deletion explicitly warns that the folder, every item inside
  it, and local Chat history are permanently deleted. Removing a linked Space
  leaves its folder on disk.

## Space customization

- Appearance controls keep their labels and remove setup narration that does
  not change a decision.
- The complete icon catalog is searchable and paginated inside one contained
  browser.
- Space-coloured composer focus stands alone without the old blue outline,
  and hover-only Space deletion no longer carries a gradient fade.

## Routing review and scheduling

- Reviewed-mode routing cards show the exact trigger, current Space names and
  folders, steps, Chat messages, file selectors and bounds, and Check ids on
  desktop, in the menu-bar popover, and in approved browsers.
- One-time proposals must be at least two minutes away when staged; authority
  admission still rechecks the canonical one-minute-to-366-day horizon.
- A one-time slot that becomes due during **Run a copy now** waits and runs
  once after the copy settles instead of being consumed as an overlap.
- Reviewed mode asks once when routing authority is created or recreated.
  Unrestricted mode consumes fresh enablement automatically, and scheduled
  occurrences never ask again.

## Interface copy

- Secondary descriptions were removed or tightened across empty states,
  Assistant tools, Apps, search, theme selection, Chat actions, the command
  palette, and file History while preserving authority and data consequences.

## Verification

- Node 24 TypeScript checks and the complete 1,046-test suite: 1,045 passed
  and one dormant Windows watcher test skipped intentionally.
- The routing overlap regression awaits the scheduler's in-memory admission
  signal and verifies the durable receipt after catch-up, avoiding both
  filesystem and microtask ordering races without weakening the behavior.
- Clean lockfile installation, zero-vulnerability dependency audit, desktop
  preparation, Electron preload and restricted-app sandbox smokes, and
  desktop preflight.
- Developer ID signing, Apple notarization and stapling, Gatekeeper, updater
  metadata, checksums, and public-asset verification for tag `v0.3.17`.
  Installed-client updater confirmation follows after publication.

This is an in-place work-fold update. It does not read, migrate, or modify
legacy Workspace application state or `.workspace/` metadata.
