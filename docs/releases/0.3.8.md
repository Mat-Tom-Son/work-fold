# work-fold 0.3.8

August 31, 2026

work-fold 0.3.8 makes the fold popover feel like a deliberate compact chat and
puts each Chat's actual model and reasoning level directly within reach.

## A cleaner fold

- The menu-bar popover keeps its conversation open instead of hiding it behind
  a disclosure, with direct **Open app** and **New chat** actions in the header.
- The permanent drop instruction is gone. Dragging a file, folder, or link over
  the popover temporarily turns the whole surface into the drop target.
- Send sits inside the composer and becomes Stop in place while work runs, so
  the layout stays stable and a follow-up can still be drafted.
- Idle status copy, the redundant footer, the overflow menu, and the compressed
  logo treatment have been removed from the small surface.

## Model and reasoning controls

- Space Chat composers show the actual model name. Clicking it opens
  Settings → Assistant already scoped to that Space and focused on its model.
- The fold composer shows its own model and opens the same settings page scoped
  to **The fold** through a narrow desktop bridge.
- Space and fold Chats expose a real per-Chat reasoning selector whenever the
  current Pi model supports more than one level. The selector is text-only,
  uses the same typography as the model label, and contains only level names.
- The fold reasoning control writes through to its live Pi session and refuses
  changes while a turn is running, matching Space Chat behavior.

## Safety and compatibility

- The popover retains its separate sandboxed preload. Its only new desktop
  capability is a fixed action that opens fold-scoped Assistant settings in the
  trusted main window.
- Thinking-level values are validated against the current model's supported
  list before Pi state is changed.
- This is an in-place work-fold update. It does not read, migrate, or modify
  legacy Workspace application state or `.workspace/` metadata.

## Current limitations

- macOS is the only active CI packaging and public distribution lane. Windows
  workflows and release gates remain disabled.
- The macOS updater publishes Apple-silicon (`arm64`) artifacts only.
- A reasoning selector appears only after a Chat has a Pi runtime and only for
  models that advertise multiple supported levels.

## Verification

- Node 24 TypeScript checks, the complete 995-test suite with one intentional
  skip, and the high-severity dependency audit.
- Real-browser review of the main Chat composer and the menu-bar popover at its
  shipped 400 × 560 dimensions, including model/settings targeting, reasoning
  behavior, typography, and caret alignment.
- Desktop preparation plus the guarded macOS signing, notarization, packaging,
  updater, checksum, and remote-digest release lanes.
