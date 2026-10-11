# work-folder customization

work-fold treats appearance as a safe, machine-local identity layer for a work-folder. It is deliberately
smaller than a CSS theme engine: people and agents may choose bounded identity values, while work-fold
continues to own navigation, permission UI, native chrome, hit targets, accessibility, and layout
integrity.

Read [the historical role inventory](archive/customization-role-inventory.md) for the original CSS audit and
[the visual system](visual-design.md) for the invariant shell rules.

## Person-facing experience

**Customize work-folder** opens a popup dialog from the work-folder header, **Manage work-folders**, or
**Settings → Appearance**. Like Settings and Skills & Extensions, it contains
keyboard focus and closes with Escape, its close button, or a click outside. It stays pinned to the
work-folder it was opened for and leaves the active Chat or file tab in place; running Chats stay mounted.
Previously saved Customize tabs are discarded on restore, preserving the remaining tabs.
The header keeps Banner, Icon, and Color at the top right. The work-folder name and paired previews
stay in fixed positions; only the controls below scroll. The editor keeps the common path direct:

- use the compact Banner, Icon, and Color sections;
- choose from 24 labeled accent presets or a custom color without replacing the banner;
- set a second color under Banner → Pattern colors, shown only while a pattern uses it;
- choose a bundled image (Tide, Ember, Fold, or Dusk), compact pattern, or safe raster upload;
- drag an image preview to reposition, or open Adjust image for position, zoom, and reset;
- browse Popular, Nature, Life, Creative, Travel, Work, or All in the searchable Fluent icon catalog;
- compare the resolved identity in light and dark at the same time;
- see whether text, glyphs, focus borders, and selection indicators meet their contrast targets;
- undo the latest edits, reset the work-folder, or import/export a code-free appearance proposal.

The four original image presets ship as local WebP assets with separate picker thumbnails; they
work offline in the desktop and paired web renderer. They were generated for work-fold with the
built-in image generation tool from coastal, warm color-field, layered-paper, and dusk concepts.
Image framing opens in a popover and does not resize the preview or move the controls. Color choices
show the actual color with a centered selection mark; the accent applies to rail, tab, and Chat identity
even with an image banner. Pattern banners include a restrained primary-color wash so choosing an
accent visibly changes the banner; None stays plain, and image artwork keeps its own colors. The
second pattern color does not recolor image pixels. Updating the preset
palette preserves existing default work-folder colors. The editor uses short labels rather than explanatory paragraphs. Import and export sit under More;
the footer's Model and Instructions shortcuts open the existing AI Models settings pinned to this
work-folder, even when the popup was opened for a work-folder other than the active one. The shortcuts have
no decorative Worker label or divider. Settings shows a back arrow beside its title only when entered
through these shortcuts; it returns to the same work-folder and Banner, Icon, or Color section. Closing
Settings or opening it through a normal entry clears that return path.

`bannerPreset` stores one of the four stable preset ids, never an arbitrary asset URL or a copy of
the image. A safe uploaded `bannerImage` takes precedence if an imported proposal contains both.
`bannerFraming` stores finite `x` and `y` percentages in 0–100 and `zoom` in 1–2. Invalid framing is
discarded; older top/center/bottom image positions remain supported until an explicit framing edit.
Pointer gestures preview locally and commit once on release, so Undo restores the previous framing
in one step. Arrow keys and labelled sliders provide keyboard controls. Presets, framing, and icons
use the same version-2 normalization, durable store, and proposal round trips as existing colors.
Preset titles and header controls get bounded light/dark backing surfaces for readability.

Every edit repaints that work-folder everywhere it appears, including foreign-work-folder tabs, switcher rows,
cards, and Chat groups. Appearance remains application state on this computer. It is not written into
the work-folder's `.work-fold/` directory and does not travel with ordinary files.

Undo keeps the latest 20 edits for the current app session. Durable state keeps the latest committed
appearance plus a last-known-good backup; it does not present a persistent theme-history system.

## Semantic colour contract

`src/shared/work-folder-appearance.ts` is the shared pure contract. A stored accent retains the exact v1
hex as `referenceHex` and records its OKLCH hue and requested chroma. The resolver emits separate
light and dark values for text, glyphs, solid fills, on-solid text, soft fills, state and decorative
borders, focus decoration, indicators, and banner endpoints.

WCAG 2.2 remains the conformance gate. APCA is a supplemental gate for perceptual quality; a role
must satisfy both when an APCA target exists. Foreground roles are checked against both the ordinary
surface and the final composited soft fill. The resolver never accepts CSS or JavaScript.

The first release migrates the highest-obligation reading text, user-message solid/on-solid pairs,
active markers, and the Customize work-folder surface. Transitional v1 aliases deliberately retain their
old rendering values for still-unported consumers. The historical inventory guides the remaining
role assignment, but its consumer counts and source locations must be re-audited before changes.

Banner gradients and user images remain advisory visual cases because their contrast depends on
position or arbitrary pixels. The UI labels that limitation instead of claiming they are certified.

## Persistence and clean break

`WorkFolderAppearanceStore` owns version-2 `appearance.json` beneath work-fold's platform application-data
root. Writes use a same-directory temporary file, restrictive file mode, file sync, atomic replacement
where the platform supports it, and a last-known-good backup for recovery. Unsupported future versions
fail closed rather than being rewritten. The renderer reads the snapshot from `/api/bootstrap` and
writes through the token-authenticated local renderer API.

Legacy Workspace local-storage appearance values and profile records are not read or imported.
work-fold begins with its own empty appearance store. Unsupported work-fold future versions fail
closed and remain byte-for-byte untouched rather than being rewritten.

## Agent and harness workflow

Codex, Claude Code, and any other shell-capable development harness use the same checked-in command:

```bash
npm run --silent work-fold:appearance -- create \
  --name "Client work" \
  --color "#0d74ce" \
  --secondary "#6550b9" \
  --icon briefcase \
  --banner aurora \
  --created-by codex \
  --out client-work.work-fold.json

npm run --silent work-fold:appearance -- validate client-work.work-fold.json --json
npm run --silent work-fold:appearance -- resolve client-work.work-fold.json --json
```

Use `--created-by claude-code` from Claude Code. `--banner-image <path>` accepts PNG, JPEG, WebP, GIF,
or BMP, resizes it within 1600×640, and stores a bounded WebP data URL. Run
`npm run --silent work-fold:appearance -- help` for all options.
`--banner-preset fold` selects a bundled image; `--frame-x`, `--frame-y`, and `--zoom` set its framing.
The same flags can frame an uploaded image. Creating a proposal remains inert and never edits a work-folder.

The result is inert:

```json
{
  "kind": "work-fold.work-folder-appearance",
  "version": 1,
  "name": "Client work",
  "customization": {
    "schema": 2,
    "primary": {
      "schema": 2,
      "hue": 252.12,
      "chroma": 0.16,
      "referenceHex": "#0d74ce"
    },
    "iconName": "briefcase",
    "bannerName": "aurora"
  },
  "createdBy": "codex"
}
```

The proposal command intentionally has no `apply` operation. A person imports the file into the
target work-folder and sees the resolved preview. Applying a preset is a mutation; automation that through the
unauthenticated protocol-v1 management CLI would violate its read-only boundary. The separate
receipted application path is the act lane's `work-fold work-folders appearance apply|reset|undo`, which
accepts only the same typed proposal file, journals before mutating, records the prior customization
for one-act undo, and requires the running app's per-launch act token — the authenticated, scoped,
replay-protected, receipted transport defined in [the work-fold agent layer](work-fold-agent-and-cli.md). The
npm-script primitive stays inert and import-only.

## Verification

The normal gates cover the shared contract, clean-profile store, renderer API, UI structure, and package:

```bash
npm run check
npm test
npm run desktop:prepare
```

For visual acceptance, exercise Customize work-folder in light and dark at the standard window sizes in
[the visual system](visual-design.md), including a preset with a secondary colour, a custom image,
undo, reset, proposal export, and proposal import.
