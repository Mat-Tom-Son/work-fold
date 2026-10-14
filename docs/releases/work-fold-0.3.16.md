# work-fold 0.3.16

September 1, 2026

work-fold 0.3.16 makes Space management quieter and more direct, and closes
the remaining review and scheduling gaps in one-time Routings.

## Manage Spaces

- **Existing folder** and **New Space** are compact side-by-side actions with
  no explanatory filler.
- Selecting a Space opens its customization tab without switching away from
  **Manage Spaces** or changing the active Space.
- Rename now lives at the top of **Customize Space**. The separate rename and
  customize buttons are gone; the remaining hover action removes a linked
  Space or deletes a managed one.
- Managed-Space deletion explicitly warns that the folder, every file and
  folder inside it, and local Chat history are permanently deleted. Linked
  folders remain on disk when their registration is removed.

## Space customization

- Appearance controls keep their labels and remove setup narration that did
  not change a decision.
- The full icon catalog now lives in a contained, searchable, paginated
  browser without the former icon-count and browse-all controls.
- Space-name editing, icon pagination, responsive two-column Space creation,
  and renamed-tab restoration are covered by renderer tests.
- The Space-coloured composer focus treatment stands alone without the old
  blue browser outline, and hover-only Space deletion no longer carries a
  gradient fade.

## Routing review and scheduling

- A Reviewed-mode routing card now shows its exact title, trigger, current
  Space names and folders, every step, Chat message, file selector and bound,
  and Check id. The main window, menu-bar popover, and approved web browsers
  render the same host-composed facts.
- A one-time proposal must be at least two minutes away when staged, avoiding
  a decision card that cannot be approved in time. Authority admission still
  rechecks the canonical one-minute-to-366-day horizon.
- If a one-time slot becomes due while **Run a copy now** is still pending or
  active, the exact slot waits and runs once after the copy settles. It is no
  longer consumed as a skipped overlap, including across sleep and resume.
- Reviewed mode still asks once when standing routing authority is created or
  recreated. Unrestricted mode automatically consumes each fresh staged
  enablement, and scheduled occurrences never ask for another approval.

## Interface copy

- Secondary descriptions were removed or tightened across empty states,
  Assistant tools, Apps, search truncation, theme selection, Chat actions,
  the command palette, and file History while preserving copy that explains
  an authority or data consequence.

## Verification

- Node 24 TypeScript checks and the complete 1,046-test suite: 1,045 passed
  and one dormant Windows watcher test skipped intentionally.
- The routing scheduler's overlap test reads the scheduler admission directly
  and verifies its durable receipt after catch-up, avoiding a filesystem-poll
  race without weakening the asserted behavior.
- Clean lockfile installation, zero-vulnerability dependency audit, desktop
  preparation, Electron preload and restricted-app sandbox smokes, and
  desktop preflight.
- Focused coverage for exact routing review facts, stage-time horizon checks,
  manual-copy overlap, one-time durable completion, Space deletion copy,
  customization navigation, icon pagination, and composer focus styling.
- Developer ID signing, Apple notarization and stapling, Gatekeeper, updater
  metadata, checksums, and public-asset verification for tag `v0.3.16`.
  Installed-client updater confirmation follows after publication.

This is an in-place work-fold update. It does not read, migrate, or modify
legacy Workspace application state or `.workspace/` metadata.
