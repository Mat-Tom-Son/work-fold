# Space identity role inventory

This document is the implementation contract for replacing the two raw hex values in
`web-local/src/lib/workspace-identity.ts` with a resolved, per-mode semantic palette. It maps every
live consumer of the Space identity variables to a bounded role taxonomy so the resolver can be built
without repeating the audit.

Status: audit complete, no runtime code changed. Read [visual design](visual-design.md) for the rules
this must not break and [product model](product-model.md) for the storage rails it must respect.

## Scope and method

Audited: the five stylesheets loaded by `web-local/src/main.tsx`, in cascade order —
`styles.css`, `professional-foundation.css`, `professional-shell.css`, `professional-surfaces.css`,
`professional-customization.css`. All are flat: no `@layer`, no nesting, one `@media` level. A rule in
a later file with an `.app-shell` prefix beats the same target in `styles.css`, and `.app-shell` is
always the root element (`App.tsx:205`, `App.tsx:207`), so those prefixes always match.

Tracked variables: the twelve written by `workspaceIdentityStyle()` (`workspace-identity.ts:108`),
plus `--workspace-banner-layers`, `--workspace-banner-base-rgb`, and `--workspace-banner-size`, which
are second-order consumers defined from them.

| Measure | Count |
| --- | --- |
| Declarations referencing an identity variable | 382 |
| Beaten by a later `.app-shell` rule (see Appendix A) | 45 |
| **Live declarations classified below** | **337** |
| Semantic roles | 16 |
| Declarations carrying a static non-identity fallback | 152 |
| Declarations inside a gradient | 30 |
| Declarations compositing with alpha | 126 |
| Files containing live consumers | 2 (`styles.css` 332, `professional-customization.css` 50) |

`professional-shell.css` and `professional-surfaces.css` contain **zero** identity consumers. The
entire surface is two files.

Grouping rule: repeated selectors are merged into one role only when both the semantic job and the
compositing ground are identical. Light and dark variants of the same rule are counted separately
because they resolve against different grounds and, today, use different literal values.

## Injection surface

`workspaceIdentityStyle()` is applied at fifteen sites. Everything inherits from the nearest one, so
a role's compositing ground depends on which scope it sits in.

| Site | Scope | Notes |
| --- | --- | --- |
| `App.tsx:892` | `.workspace-layout` | Selected Space. Widest scope; most roles resolve here. |
| `App.tsx:974` | `.workspace-surface-body` | Per surface tab — **may be a different Space** than the layout. |
| `App.tsx:1060` | `.workspace-surface-empty` | Empty state. |
| `WorkspaceSurfaceTabBar.tsx:121` | per tab | Tab-owned Space. |
| `WorkspaceSurfaceTabBar.tsx:223` | per switcher row | Foreign-Space identity. |
| `workspaceChrome.tsx:119` | rail avatar | |
| `workspaceChrome.tsx:318` | identity header | Banner ground. |
| `workspaceChrome.tsx:389` | switcher row | Foreign-Space identity. |
| `workspaceChrome.tsx:556` | appearance preview | Banner ground. |
| `workspaceChrome.tsx:581` | primary colour picker | |
| `workspaceChrome.tsx:595` | secondary colour picker | **Overrides `--workspace-custom-color` with `identity.secondaryColor`.** |
| `workspaceChrome.tsx:625` | banner picker | |
| `ChatPanel.tsx:1767` | chat empty state | |
| `workspacePanes.tsx:107` | Space card | Foreign-Space identity. |
| `workspacePanes.tsx:239` | chat group | Foreign-Space identity. |

Two consequences the resolver must honour. First, **a single view renders several Spaces at once** —
tabs, cards, chat groups, and switcher rows each carry their own identity, so the resolver runs per
identity, not once per window. Second, `workspaceChrome.tsx:595` rebinds `--workspace-custom-color`
to the secondary colour for one subtree, meaning every rule reading that variable silently switches
meaning inside it. That is the single worst aliasing hazard in the codebase and must not survive.

`.workspace-layout` also declares CSS-level defaults for the same variables (`styles.css:3553-3561`),
including `--workspace-selection-accent-rgb: 53, 111, 163` and
`--workspace-selection-border: rgba(…, 0.46)`. The inline style overrides these, and the JS border
alpha is `0.5` (`workspace-identity.ts:35`), not `0.46`. Two sources of truth disagree by 0.04.

## Role taxonomy

Sixteen roles. Targets are WCAG 2.2 AA as the conformance gate; the APCA column is the supplemental
quality signal, applied as the stricter of the two.

| Role | Decls | Ground | WCAG 2.2 | APCA | Notes |
| --- | ---: | --- | --- | --- | --- |
| `accentTextBody` | 12 | chat surface | 4.5:1 | Lc 75 | Reading-size text |
| `accentTextUi` | 34 | surface / soft fill | 4.5:1 | Lc 75 | Small UI labels |
| `accentGlyph` | 41 | surface / soft fill | 3:1 | Lc 45 | SC 1.4.11 |
| `onAccentText` | 6 | `accentSolid` | 4.5:1 | Lc 75 | |
| `onAccentMuted` | 13 | `accentSolid` | 4.5:1 | Lc 60 | Alpha 0.10–0.78 composite |
| `accentSolid` | 17 | canvas | carrier | — | Must support `onAccentText` |
| `accentSoftFill` | 46 | surface | carrier | — | Alpha 0.13; ground for 28 fg decls |
| `accentBorderState` | 48 | surface | 3:1 | Lc 45 | SC 1.4.11 — focus/active |
| `accentBorderDecor` | 34 | surface | none | — | Resting edge, decorative |
| `accentFocusRing` | 19 | surface | none | — | **Decorative only — see below** |
| `accentIndicator` | 15 | surface | 3:1 | Lc 45 | Active pill / tab marker |
| `accentSwatch` | 3 | picker chrome | none | — | Self-referential preview |
| `bannerLayer` | 17 | banner base | uncertifiable | — | 9 gradients |
| `bannerOnImage` | 8 | user image | uncertifiable | — | Fixed scrim |
| `bannerChrome` | 6 | banner base | 3:1 | Lc 45 | Editor chrome |
| `aliasDefinition` | 18 | n/a | n/a | n/a | Variable-to-variable derivation |

### Foreground roles

**`accentTextBody`** — 12 decls, `styles.css:8953–13573`, light 7 / dark 5.
Accent as reading-size prose: `.message-body a`, `.message-body code`, `.message-body li::marker`,
`.message-body .workspace-file-link`, `.message-image-file`, `.message-image-external`,
`.agent-activity-log code`. Foreground on the chat content surface. Six use `color-mix` alpha.
Reads `--workspace-custom-color` only. **Highest-obligation role** — full 4.5:1 required.
Migration risk: high. All five dark variants use hardcoded `color-mix(…, 54–56%, #ffffff)` lightening
that the dark ramp replaces wholesale.

**`accentTextUi`** — 34 decls, `styles.css:5693–13556`, light 21 / dark 13.
Small UI text: `.new-chat-button`, `.workspace-card-customize`, `.surface-tab-action`,
`.turn-landing-heading span`, `.runtime-preview-item-title`, `.suggested-prompt-button`,
`.agent-activity-toggle span`, `.jump-to-latest`, `.workspace-header-switcher-badge`. Ten composite
with alpha. Reads all three of `--workspace-custom-color`, `--workspace-selection-accent`,
`--surface-tab-accent`. Ground varies: some sit on the surface, some on `accentSoftFill`.
Migration risk: high — ground is not statically determinable for every selector; see acceptance tests.

**`accentGlyph`** — 41 decls, `styles.css:530–15732` + `professional-customization.css:203–792`,
light 31 / dark 10. Icons and non-text marks: `.workspace-tab-icon`, `.workspace-identity-icon`,
`.surface-tab-icon`, `.workspace-rail-icon`, `.pane-category-chevron`, `.workspace-pane-switch-caret`,
`.workspace-appearance-surface-icon`, `.workspace-icon-option.active`, the seven
`.account-avatar-button.rail-account-button` variants, `.conversation-context-meter circle.value`
(`stroke`). No alpha in the foreground itself, but 28 of these sit on `accentSoftFill`.
Migration risk: medium — obligation is 3:1, and the composite drop of 11–14 Lc still clears it.

**`onAccentText`** — 6 decls, `styles.css:8521–13477`, light 4 / dark 2.
`.message.user`, `.message.user .message-body`, `.message.user .message-image-external`,
`.message.user .message-copy-button:hover`, and the `banner-bold` lockup. Reads
`--workspace-on-primary-accent` / `--workspace-on-accent`, currently produced by
`readableTextColorOn()` picking `#182846` or `#ffffff`.
Migration risk: low — this is the one relationship the current code already checks.

**`onAccentMuted`** — 13 decls, `styles.css:8515–13477`, light 9 / dark 4. **All 13 composite.**
De-emphasised content on the accent fill: `.message.user .message-author` at 76%,
`.message.user .message-copy-button` at 78%, `.message.user .message-body code` background at 12%,
`.message.user .message-image-external` background at 10% and border at 28%.
`.message.user .message-author` is text, so 4.5:1 applies **against the composited fill**, not
against the solid. Migration risk: high — nothing checks this today.

### Fill roles

**`accentSolid`** — 17 decls, light 12 / dark 5. `.message.user` background, `.send-button`,
`.new-chat-button`, `.workspace-rename-action.save`, `.workspace-color-wheel-current`,
`.workspace-card-customize:hover`. No alpha. This is the carrier for `onAccentText`; it has no
contrast target of its own but constrains the on-colour.

**`accentSoftFill`** — 46 decls, light 31 / dark 15, 23 with alpha.
`--workspace-custom-color-soft` = `hexColorToRgba(color, 0.13)`. Fills active and hover states:
`.workspace-rail-icon`, `.workspace-tab-icon`, `.command-palette-option.active`,
`.workspace-header-switcher-row.active`, `.workspace-mode-pane`, `.workspace-pane-current`.
**This is the compositing ground for 28 foreground declarations.** Any audit that checks foregrounds
against the surface rather than against this composite is measuring the wrong pair — the real drop is
11–14 Lc in light mode and 2 Lc in dark.

### Line and state roles

**`accentBorderState`** — 48 decls, light 29 / dark 19. Borders in `:focus-visible`, `:hover`,
`.active`, `.switcher-open`, `.drop-active`, `.streaming` contexts: `.workspace-rail-button.active`,
`.workspace-pane-current.has-switcher:focus-visible`, `.installed-kit-pill:hover`,
`.composer.composer-drop-active .composer-input-shell`. SC 1.4.11 applies at 3:1.

**`accentBorderDecor`** — 34 decls, light 23 / dark 11. Resting decorative edges:
`.workspace-mode-pane`, `.workspace-pane-current`, `.workspace-mode-rail::after`,
`.workspace-pane-current-icon`, `.file-tree-search`. No SC obligation, but they should not disappear.
Recommend a floor of 1.5:1 as a quality guard, not a gate.

**`accentFocusRing`** — 19 decls, light 14 / dark 5, 12 with alpha.
Rings drawn as `box-shadow: 0 0 0 Npx var(--workspace-custom-color-soft)`. At alpha 0.13 these
measure **1.09:1 to 1.22:1** against their surface across the palette — they cannot serve as a focus
indicator and must not be treated as one.

Seven rules suppress the global `outline` and rely on the accompanying `border-color` change instead:
`styles.css:5277, 5862, 6149, 6199, 6440, 6567` and `professional-customization.css:136`. In those
rules the **border** is the focus indicator, so they belong to `accentBorderState` at 3:1 and the ring
is decoration layered on top. `professional-foundation.css:87–94` supplies a 2px `--ui-accent` outline
everywhere else; that is a global token, not a Space identity token, and stays outside this inventory.

**`accentIndicator`** — 15 decls, light 10 / dark 5. Inset markers that encode selection:
`inset 4px 0 0` on `.workspace-rail-button.active`, `inset 2px 0 0` on
`.chat-workspace-row-shell.active`, `inset 0 2px 0` on `.surface-tab.active`,
`.runtime-preview-item::before`. These convey state, so 3:1 applies.

**`accentSwatch`** — 3 decls. `.workspace-color-wheel-current` and the `.secondary.matched` split
gradient inside the colour picker. Self-referential: they display the colour being chosen, so they are
exempt from contrast targets by definition but must remain distinguishable from the picker chrome.

### Banner roles

**`bannerLayer`** — 17 decls, `professional-customization.css:7–466` + `styles.css:5482–6551`.
Nine gradient definitions (`banner-classic` through `banner-bold`) composing
`--workspace-selection-accent-rgb` and `--workspace-selection-accent2-rgb` at alphas from **0.07 to
0.94** over `rgb(--workspace-banner-base-rgb)`, plus four `background` and four `background-size`
consumers. No dark variants — the banner presets are mode-independent today.

**`bannerOnImage`** — 8 decls. Text and controls over a user-supplied image with a fixed scrim
(`linear-gradient(180deg, rgba(9,14,24,.16), rgba(9,14,24,.52))`), plus the `banner-bold` case where
text sits on a near-opaque accent gradient.

**`bannerChrome`** — 6 decls. The appearance editor's own furniture:
`.workspace-appearance-preview-label`, `.workspace-banner-swatch.active`.

### Alias definitions

**`aliasDefinition`** — 18 decls at `styles.css:3553–11805`. Variables defined from other identity
variables: `.workspace-layout` derives `--workspace-selection-accent`,
`--workspace-selection-border`, `--workspace-selection-surface` from `-rgb` triples;
`.workspace-mode-pane-files .source-dropdown` re-exports them as `--cloud-accent`,
`--cloud-accent-dark`, `--cloud-accent-soft`, `--cloud-border`; `.surface-tab` and
`.workspace-card-shell` re-export as `--surface-tab-accent`.

These are pure indirection and should be **deleted**, not ported. The resolver emits final role values
directly; a derivation chain that turns one input into four differently-aliased outputs is exactly the
aliasing this work removes. The `--cloud-*` re-export is the clearest case — a fifth name for the same
colour, scoped to one dropdown.

## Canonical role names and palette output contract

The resolver is a pure function. No DOM, no storage, no side effects.

```ts
export interface AccentIdentity {
  hue: number;          // OKLCH H, 0–360
  chroma: number;       // OKLCH C, 0–0.4, the requested maximum
  referenceHex: string; // the v1 value; see compatibility below
}

export interface ResolverGround {
  mode: "light" | "dark";
  surface: string;      // --ui-surface for this mode
  canvas: string;       // --ui-canvas for this mode
  softAlpha: number;    // 0.13 today; the resolver composites against the result
}

export interface ResolvedAccentPalette {
  mode: "light" | "dark";
  textBody: string;         // ≥ 4.5:1 on surface AND on softFill
  textUi: string;           // ≥ 4.5:1 on surface AND on softFill
  glyph: string;            // ≥ 3:1 on surface AND on softFill
  solid: string;            // carrier
  onSolid: string;          // ≥ 4.5:1 on solid
  onSolidMuted: string;     // ≥ 4.5:1 on solid, at its declared alpha
  softFill: string;         // composited, not an rgba() string
  borderState: string;      // ≥ 3:1 on surface
  borderDecor: string;      // ≥ 1.5:1 on surface (guard, not gate)
  focusRing: string;        // decorative
  indicator: string;        // ≥ 3:1 on surface
  bannerPrimary: string;
  bannerSecondary: string;
  bannerBase: string;
  meta: {
    chromaUsed: number;         // may be below identity.chroma
    chromaReducedBy: string[];  // role names that forced the reduction
    unsatisfiable: string[];    // roles that could not meet target at any chroma
  };
}

export function resolveAccent(
  identity: AccentIdentity,
  ground: ResolverGround,
  enforcement: "guided" | "warned" | "off",
): ResolvedAccentPalette;
```

Two rules. **`softFill` is emitted composited**, as a final colour, not as `rgba()` — otherwise every
foreground check against it is guessing at the backdrop. And **every text and glyph role is solved
against both the surface and the soft fill**, taking the stricter, because the audit shows the same
token is used on both grounds.

## v1 hex compatibility

The existing hex must be retained, not discarded. Store all three fields:

```jsonc
{ "hue": 252, "chroma": 0.160, "referenceHex": "#0d74ce", "schema": 2 }
```

Migration for each stored `color` / `color2`:

1. Convert the v1 hex to OKLCH. Record `hue` and `chroma`; keep the hex verbatim as `referenceHex`.
2. Resolve the light-mode palette. Compare `solid` to `referenceHex`.
3. If they differ by more than a small threshold, **`referenceHex` wins for `solid` in light mode** and
   the derived roles are solved around it. The user's Space keeps the colour they chose.
4. Dark mode has no v1 reference — today's dark appearance is a `color-mix` artefact, not a choice —
   so it is fully resolved.
5. Never write schema 2 back over schema 1 until the user opens the Studio. Read-upgrade in memory;
   persist only on an explicit change.

A prior round-trip check over the twelve shipped Space colours in
`workspace-identity.ts:8–21` showed a worst-case single-channel deviation of 2/255. That result
covers **colour-space conversion only**, at each colour's own reference lightness. It is not evidence
that the rendered product is unchanged, and it says nothing about arbitrary user-chosen hex, the new
role values, composites, or gradients. Those are the acceptance tests below, and they are the gate.

## Cases the resolver cannot certify statically

These must be handled by policy, not by the contrast solver. The Studio should say so plainly rather
than display a passing badge it cannot justify.

1. **Banner gradients** (`bannerLayer`, 9 definitions). Contrast varies continuously across the fill.
   Certify by sampling the composited gradient at a fixed grid over the band's real geometry and
   reporting the worst cell, and treat the result as advisory for decorative bands. Where a lockup sits
   on the band, certify the lockup's own worst cell as a gate.
2. **User banner images** (`bannerOnImage`, 8 decls). Arbitrary pixels under a fixed scrim. The scrim
   cannot guarantee any ratio. Options, in order of preference: measure the actual composited luminance
   under the text box at upload time and choose the on-colour from it; or raise scrim opacity until the
   measured worst case passes; or keep the current text-shadow treatment and mark the case advisory.
   Do not report it as passing.
3. **`banner-bold`** — accent gradient at alpha 0.82–0.94 carrying text. Near-solid, so it can be
   gated, but only if the resolver models the gradient endpoints rather than the mid-tone.
4. **Third-party surfaces.** Restricted-app canvases and extension surfaces receive theme context but
   render their own pixels. Out of scope; do not audit or claim coverage.
5. **`accentSwatch`.** Self-referential by design.

## Role-level acceptance tests

Table-driven over the cross product of the twelve shipped colours, a set of adversarial hues
(pure yellow ≈ 95, cyan ≈ 195, magenta ≈ 330, and a near-neutral at chroma 0.01), and both modes.

1. **Target satisfaction.** For every gated role, the resolved value meets its WCAG 2.2 target against
   every ground it is used on. Assert against the composited `softFill`, not the surface, for the 28
   declarations identified above.
2. **Dual gate.** Where APCA is configured, the emitted value satisfies the stricter of WCAG and APCA.
   Regression guard: no role ships below its WCAG target because APCA passed.
3. **Chroma degradation is reported.** When a hue cannot hold the requested chroma, `meta.chromaUsed`
   is below the request, `meta.chromaReducedBy` names the binding role, and hue is unchanged within
   1°.
4. **Unsatisfiable is surfaced, not silently clamped.** A role that cannot pass at any chroma appears
   in `meta.unsatisfiable`.
5. **Migration fidelity.** For each of the twelve v1 colours, light-mode `solid` equals the stored
   `referenceHex` exactly under the rule above. Snapshot every other role so future resolver changes
   show up as an intentional diff.
6. **Mode independence.** Resolving light does not mutate state used by dark. Both orders produce
   identical output.
7. **Foreign-Space isolation.** Two identities resolved in one render produce independent palettes;
   no shared mutable state.
8. **Secondary colour does not alias the primary.** After the `workspaceChrome.tsx:595` rebinding is
   removed, no role in a subtree resolves to the secondary colour unless it is a banner role.
9. **Determinism.** Same inputs, same outputs, across runs and platforms.
10. **No regression in on-accent.** `onSolid` continues to match `readableTextColorOn()` for all
    twelve v1 colours, or the difference is an explicit, reviewed improvement.

Wire these as unit tests against the pure resolver. They need no DOM and should run in the existing
`npm test` lane.

## Migration risk register

| Risk | Size | Detail |
| --- | ---: | --- |
| Static fallbacks mask un-themed rendering | 152 decls | `var(--x, #60a5fa)`, `var(--x, var(--workspace-blue-700))`, `#7aa7c7`, `#315b78`, `#1d3f78`. Outside an injection scope these render a fixed blue. Removing them changes appearance in contexts nobody has audited; keeping them hides resolver failures. Decide per role, and prefer a resolved neutral over a literal blue. |
| Hardcoded dark-mode lightening | 15 decls | `color-mix(…, N%, #ffffff)` at five ratios: 54% (×6), 56% (×4), 34% (×3), 40%, 36%. Delete all; the dark ramp replaces them. Expect visible dark-mode change — this is the intended fix, and it should be shown in the release notes. |
| Soft-fill composite unmodelled | 28 fg decls | Foregrounds solved against the surface but rendered on the 0.13 fill. Currently clears 3:1 for glyphs; would fail a 4.5:1 text target. |
| Secondary colour rebinding | 1 site | `workspaceChrome.tsx:595`. Must be replaced with a dedicated banner variable. |
| Two sources of truth for border alpha | 2 values | CSS default 0.46 (`styles.css:3561`) vs JS 0.5 (`workspace-identity.ts:35`). |
| Alias re-export chains | 18 decls | `--cloud-*`, `--surface-tab-*`. Delete rather than port. |
| Focus rings mistaken for indicators | 19 decls | 1.09–1.22:1. Seven rules suppress `outline`; the border carries focus there. |
| Overridden CSS left in place | 45 decls | Appendix A. Dead weight that will confuse the port. |

## Appendix A — overridden and dead CSS

45 declarations, all in `styles.css`, are beaten by `.app-shell`-prefixed rules in
`professional-customization.css`. They should be deleted as part of the port rather than migrated.
Line numbers below are the **rule's opening selector line**, not the declaration line. Confirm each
against the current file before deleting — they move.

- `background` (11) — 5656, 5666, 5876, 6033, 6297, 6444, 6577, 10162, 11867, 11872, 12096
- `color` (10) — 3788, 3821, 5493, 5580, 5666, 6297, 6444, 11849, 12141, 12159
- `--workspace-banner-layers` (9) — 5410, 5414, 5420, 5429, 5436, 5443, 5451, 5457, 5467
- `border-color` (9) — 5656, 6033, 6396, 6444, 6571, 11867, 11872, 12013, 12096
- `box-shadow` (6) — 5745, 6033, 6396, 6571, 12013, 12096

The nine superseded `--workspace-banner-layers` definitions are the full duplicate preset set:
`styles.css` defines all nine banner treatments and `professional-customization.css:7–55` redefines
every one of them. Only the second set renders.

Separately, ten `professional-*` class prefixes appear in stylesheets but are never rendered by any
`.tsx`: `professional-capability-card`, `professional-capability-copy`, `professional-card-grid`,
`professional-import-row`, `professional-install-heading`, `professional-install-panel`,
`professional-notice-success`, `professional-package-input`, `professional-tool-details`,
`professional-tool-list`. Not all carry identity variables, but all are dead selectors.

## Appendix B — where the frontend and an authenticated harness meet

Today appearance is renderer-local: `readStoredJsonValue` / `writeStoredJsonValue` over
`localStorage` (`web-local/src/lib/storage.ts`), keyed `workspace.appearance.v1`
(`constants.ts:66`), read at `App.tsx:238`, with a one-time toast when a write fails. That is adequate
for two hex values. It is not adequate for versioned presets, undo history, import/export, or
last-known-good recovery, and it has no atomicity or schema migration.

The resolver itself is pure and belongs in the harness-neutral `src/shared/` contract. **Appearance state** should move
behind a domain service in `src/local/` that owns atomic writes, schema migration, last-known-good
recovery, import normalisation and size limits, and the global-versus-per-Space split — the same shape
as the existing capability and app services.

Two constraints on how a harness reaches it.

**Name collision.** `WorkspaceThemeSnapshot` already exists at `workspace-kernel.ts:173` and means a
**Pi capability theme** — it carries `scope`, `origin: "package" | "top-level"`, `packageSource`, and
`provenance`, and is projected to the CLI at `workspace-cli-adapter.ts:121`. A Workspace shell
appearance record is a different domain object with a different lifecycle and must not reuse that name,
that snapshot, or that catalog entry. Suggested names: `WorkspaceAppearanceSnapshot` and an
`appearance` key, kept clear of `capabilities.themes`.

**Protocol v1 stays read-only.** Per `src/local/cli/protocol.ts`, v1 is a same-user, read-only control
surface, not an authenticated caller boundary. A read-only `workspace appearance --json` projection —
active identity, resolved role values, audit results, schema version — fits v1 and is useful for
verification. **Applying or importing a theme is a mutation and must not go through v1.** It requires
the separately versioned authenticated transport, with authorization, replay protection, explicit
scope, and durable receipts, as recorded in [the management layer](management-layer.md).

Product rails this inventory assumes and does not change: appearance stays machine-local application
state and is not written into `.workspace/` (see [product model](product-model.md); the `space.json`
schema may grow for portable appearance only as a deliberate, separate decision); themes carry typed,
bounded values only and never CSS or JavaScript; and navigation order, permission and connection UI,
native macOS chrome, Space-tab ownership, minimum hit targets, and colour never being the sole carrier
of state remain invariants rather than preferences.
