# Space customization

work-fold treats appearance as a safe, machine-local identity layer for a Space. It is deliberately
smaller than a CSS theme engine: people and agents may choose bounded identity values, while work-fold
continues to own navigation, permission UI, native chrome, hit targets, accessibility, and layout
integrity.

Read [the role inventory](customization-role-inventory.md) for the audited CSS consumers and
[the visual system](visual-design.md) for the invariant shell rules.

## Person-facing experience

Selecting a Space in **Manage Spaces** opens its Space-owned **Customize Space** work tab directly.
The Space name is editable at the top, followed by the appearance controls. The editor keeps the
common path direct:

- choose a primary colour and optional banner partner;
- choose a compact pattern or safe raster image;
- search the Fluent identity icon catalog;
- compare the resolved identity in light and dark at the same time;
- see whether text, glyphs, focus borders, and selection indicators meet their contrast targets;
- undo the latest edits, reset the Space, or import/export a code-free appearance proposal.

Every edit repaints that Space everywhere it appears, including foreign-Space tabs, switcher rows,
cards, and Chat groups. Appearance remains application state on this computer. It is not written into
the Space's `.work-fold/` directory and does not travel with ordinary files.

Undo keeps the latest 20 edits for the current app session. Durable state keeps the latest committed
appearance plus a last-known-good backup; it does not present a persistent theme-history system.

## Semantic colour contract

`src/shared/space-appearance.ts` is the shared pure contract. A stored accent retains the exact v1
hex as `referenceHex` and records its OKLCH hue and requested chroma. The resolver emits separate
light and dark values for text, glyphs, solid fills, on-solid text, soft fills, state and decorative
borders, focus decoration, indicators, and banner endpoints.

WCAG 2.2 remains the conformance gate. APCA is a supplemental gate for perceptual quality; a role
must satisfy both when an APCA target exists. Foreground roles are checked against both the ordinary
surface and the final composited soft fill. The resolver never accepts CSS or JavaScript.

The first release migrates the highest-obligation reading text, user-message solid/on-solid pairs,
active markers, and the Customize Space surface. Transitional v1 aliases deliberately retain their
old rendering values for still-unported consumers; the exhaustive inventory is the source of truth
for finishing that mechanical role assignment without pretending the alias census is already zero.

Banner gradients and user images remain advisory visual cases because their contrast depends on
position or arbitrary pixels. The UI labels that limitation instead of claiming they are certified.

## Persistence and clean break

`SpaceAppearanceStore` owns version-2 `appearance.json` beneath work-fold's platform application-data
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

The result is inert:

```json
{
  "kind": "work-fold.space-appearance",
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
target Space and sees the resolved preview. Applying a preset is a mutation; routing that through the
unauthenticated protocol-v1 management CLI would violate its read-only boundary. The separate
receipted application path is the act lane's `work-fold spaces appearance apply|reset|undo`, which
accepts only the same typed proposal file, journals before mutating, records the prior customization
for one-act undo, and requires the running app's per-launch act token — the authenticated, scoped,
replay-protected, receipted transport defined in [the management layer](management-layer.md). The
npm-script primitive stays inert and import-only.

## Verification

The normal gates cover the shared contract, clean-profile store, renderer API, UI structure, and package:

```bash
npm run check
npm test
npm run desktop:prepare
```

For visual acceptance, exercise Customize Space in light and dark at the standard window sizes in
[the visual system](visual-design.md), including a preset with a secondary colour, a custom image,
undo, reset, proposal export, and proposal import.
