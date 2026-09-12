# Application appearance

## Design

The visual thesis is a quiet, readable workspace whose materials and typography feel personal while its navigation remains familiar. The Appearance page starts with small palette previews for the selected light/dark mode, then a live conversation and file-list sample, followed by reading, spacing, and accessibility controls. Existing Space identity is reached through Customize Space rather than reimplemented here.

Selection feedback is immediate; preview changes follow the actual controls. Hover and focus use the existing short transitions. Reduced motion removes those transitions, and no decorative animation is added to Settings.

Application preferences describe the person's working environment. Space appearance describes the working context. Changing the former must not overwrite a Space's colors, icon, banner, or portable content. Native window controls, navigation order, minimum navigation targets, action semantics, and non-color status cues remain invariant.

## Contract and scope

Application appearance is a versioned, code-free preference record. It includes color mode, surface palette, accent, interface typography, conversation typography and measure, code face, list density, message emphasis, contrast, motion, and transparency. Semantic accent roles reuse the Space appearance color solver against the chosen application surfaces. A raw accent color is never used as both text and a button fill.

Preferences and named presets are saved on this device in renderer storage, continuing the existing application theme and typography scope. Existing theme/font/size choices are migrated without resetting them. The desktop and its menu-bar conversation share these preferences. The paired web fold retains its current browser/device light/dark appearance and has no application-preset controls. Preferences do not synchronize through an account or to another origin. Restricted apps retain their existing light/dark context contract and their own presentation.

Built-in presets are starting points, not locked themes. Custom presets capture the current preferences and can be copied under a new name, replaced by saving with the same name, removed, exported, and imported as validated JSON. Import adds a saved preset; applying it is a separate, explicit choice. Import accepts only the current typed contract, bounded names and known values; it never loads CSS, scripts, fonts, URLs, or images. Space appearance proposals remain a separate contract.

Every change is immediate. Undo keeps the most recent 20 preference changes in the current renderer session; Reset appearance restores defaults and can itself be undone. Device accessibility preferences always apply. The person can additionally choose reduced motion, opaque surfaces, or increased contrast inside work-fold. Applying a preset cannot weaken those explicit preferences. Reset restores the application defaults and remains undoable; device accessibility settings still apply.

The store reads legacy `work-fold.theme` and `work-fold.typography.v1` only when no current record exists. Reading or migrating never writes storage. The first explicit change saves `work-fold.application-appearance.v1`; a second record holds up to 24 named presets. Unsupported future records remain untouched even after an explicit change: the UI identifies such changes as window-only. A storage failure likewise never reports a successful save. Cross-window storage events refresh the sibling renderer without writing back, and invalidate stale undo history.

Preset files are at most 16 KiB, have names of 1–60 characters, and contain only the current schema's closed enums, integer reading size, and validated six-digit accent. Local font stacks have system fallbacks and never trigger font downloads. Changing global surfaces re-solves each Space's accent against those actual surfaces while preserving its underlying identity. Button fills use the solver's solid role with its matching foreground; links, focus, and subtle selection use their own roles.

## Verification

Exercise migration, invalid and future records, preset import/export, persistence failure, cross-window updates, undo/reset, device accent changes, and both mode variants. Inspect Settings at narrow widths, enlarged reading text, each palette, and high contrast. Verify actual conversation and file-list styling as well as the illustrative preview. No provider calls are needed.
