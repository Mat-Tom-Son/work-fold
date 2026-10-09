# work-fold visual system

work-fold uses a quiet desktop-tool aesthetic. The interface should feel native, legible, and deliberate before it feels customizable.

## Brand

- The mark ships from the designer icon pack in `desktop/assets/brand/pack/`: one vector master with an optically simplified small-size variant, exported per platform (tiled macOS/Windows app icons, bare-cube transparents, monochrome ladders, and the tab-ready menu-bar template). Lockups are the provided horizontal artwork as single images — black on light themes, white on dark — never stitched from separate cube and wordmark pieces. The installers (`npm run desktop:icons`, `node scripts/generate-bridge-web-icons.mjs`, `node scripts/sync-bridge-fonts.mjs`) are copy-and-verify; no surface keeps a private or redrawn copy of the mark.
- The palette pairs deep navy ink (`#0e386c` brand navy, `#1c2530` body ink) with the bright blue interactive accent (`#0b6fd6` on light fields, `#1ea0ff` on dark), and reserves the cube's teal `#22cfc6`, green `#46d586`, and gold `#f6b516` for semantic and illustrative moments. The Original light palette builds on the `#e9eae6` neutral field; the Original dark palette builds on charcoal (`#202425` canvas). Filled accent controls use the paired contrast color, never white-on-bright-blue.
- In-app lockups pair the mark with the product name set in Poppins — the bubble wordmark art is reserved for marketing surfaces (the landing page, the OG image, the DMG background).
- Tokens live in `web-local/src/brand.css` and `web-local/src/styles.css` (desktop shell), `web-local/src/popover/popover.css` (the fold popover), and `services/bridge/public/app.css` (the web client); `tests/work-fold-brand.test.ts` guards the contract.

## Information hierarchy

- A **Space** is a root folder. It is selected or switched; it is not a peer navigation surface.
- **Files** is the first working surface inside the selected Space.
- Primary rail surfaces are Files, Chats, and History. Add and Settings stay at the bottom; Keyboard Shortcuts is a Settings page; Add opens the Skills & Extensions popup directly, a dialog pinned to the Space it was opened from.
- Provider, model, and authentication controls live in Settings under Assistant; Assistant is not a rail group.
- The persistent header above the left pane identifies the selected root folder. Its compact menu switches, creates, registers, or manages Spaces; the selected rail item identifies the current surface.
- A conditional **Needs you** indicator may join the bottom-rail cluster only while an Assistant question or a due snooze waits, opening an anchored flyout of those items. It is not a rail destination, tab, permanent badge, or notification stream, and it disappears entirely when it has nothing to show.

## Iconography

- Use Fluent System Icons for shell navigation, commands, status, and empty states.
- Use regular icons at rest and the matching filled icon for a selected navigation item.
- Use 16px icons for inline actions, 24px for the icon-only rail navigation, 20px for section markers, and no more than 24px for empty states.
- Material file-type icons retain their familiar type colors. The rail's Skills & Extensions control uses the Lucide **Blocks** icon at 24px; Settings → Apps uses **Layout Panel Left** and Web Access uses **Globe Code** at 20px (2026-10-08). These requested icons use a 1.5px stroke to match the neighboring Fluent outlines and inherit the same control colors; other shell controls retain Fluent icons.
- Keep icon-library exceptions limited to those named controls. The Space glyph may repeat only where it communicates inherited root context: the header switcher, cards, Chat groups, and Space-bound tabs. The banner itself is name-first.
- Space color may appear as a small avatar accent or active indicator, never as a frame around the application.

## Typography and spacing

- Every platform defaults to the bundled brand fonts: Inter Variable for body copy and controls, Poppins SemiBold (600) for interface headings. Markdown-rendered conversation and document content keeps the body face. Body copy is 15px with weights 400, 600, and 700; the fonts ship with the app and the web client, never from a CDN.
- User-selected fonts and text sizes may change type, but must not change shell geometry or push controls out of bounds.
- Use the 4, 8, 12, 16, 24, and 32px spacing scale.
- Compact toolbar controls are 30px tall with 5px radii; primary rail targets remain 44px. Files and Chats share 28/30/38px compact/standard/spacious rows, with larger touch targets when the platform requests them.
- Avoid all-caps labels, weight 800+, text shadows, ornamental whole-app gradients, and oversized hero headers.

## Layout

- Desktop rail navigation is icon-only: centered square targets (44–48px) with 24px Fluent icons, tooltips and accessible names carrying the labels, and one subtle selected state (soft fill plus a small accent pill). Narrow layouts return to horizontal rows with text labels.
- Every left-pane surface begins with the same 112px identity band in the same position. Its centered, name-only lockup represents the selected Space, not the active page, and opens the same Space menu on built-in, management, and contributed-app surfaces. The menu keeps Space rows and the three compact management actions on one-line row geometry. Skills & Extensions opens as a popup dialog, like Settings, rather than a navigator or work tab.
- Space banners stay inside the identity header and appearance previews. They do not wallpaper the right work surface or recolor structural borders; interaction color and shell structure remain part of the global application system.
- Color and icon identity inherit through Space-bound cards, chat groups, tabs, surfaces, and chat empty states. Content belonging to another Space carries that Space's own identity rather than the currently selected one.
- Chats in the selected Space remain visually primary. Every other registered Space appears afterward as a compact, collapsed disclosure row with its current-view count and aggregate activity across all of its Chats; opening one reveals its matching Chats without making it look like another permanent navigation level.
- The Skills & Extensions Installed view places the Included with work-fold strip above Everywhere and This folder only, which sit side by side and stack on narrow widths; rows open their details on click.
- With four or more tabs open, tabs narrow but keep their Space icon and a normal close button.
- Settings → AI Models chooses its scope with two large buttons (This worker, naming the Space, and work-fold agent) rather than radio circles; its model is a dropdown that shows the chosen model closed and opens with a search box at the top and vendor headings, closing again on a choice. Settings → Automations keeps Limits collapsed under a disclosure by default.
- Settings → Appearance starts with a labeled Preview, followed by Presets, without a reserved success-notice strip. AI Models places Save Model at the right of its action row. Shared Pages gives each page a padded summary and a separate wrapping footer with Sleep Copy and its sharing actions; state, source, budgets, and usage remain visible, and links and budget editors open within the same row.
- User Chat bubbles use the contrast-solved soft Space accent and its matching reading foreground; Quiet uses the selected neutral surface. Copy sits at the right edge beneath the user bubble, with its timestamp revealed to its left on hover or keyboard focus. Assistant message headers are text-only and do not repeat a decorative Assistant avatar.
- Forms use stacked labels and hints with an explicit action row.
- Notices use `icon | copy | action` and stack only when their own pane becomes narrow.
- Empty states are centered, restrained, and no wider than 440px.
- Resizable panes must adapt to their own width; prefer container queries to viewport-only breakpoints.

## Windows material

- Use Mica only on Windows 11 22H2 or newer (build 22621+) and only when the operating system does not report reduced transparency.
- When Mica is active, keep the titlebar overlay transparent and make only the root window chrome, rail, and pane gutters transparent. Content surfaces remain opaque so hierarchy and contrast do not depend on the wallpaper.
- The preload reports `window.material` and `main.tsx` applies `data-window-material="mica"` synchronously before React's first paint. Do not move this to a passive effect that produces a solid-background flash.
- Older Windows builds and reduced-transparency sessions use a theme-matched solid background. Light, dark, and system theme changes must update native chrome and the renderer together.

## Restricted Space app surfaces

- Installed Space apps occupy the contributed rail region below the three stable primary destinations. They never replace or reorder Files, Chats, or History, and they never displace the Add button that opens Skills & Extensions.
- work-fold owns the rail target, Space identity header, navigator frame, tab chrome, loading/unavailable states, theme context, and permission/lifecycle UI. The app owns only the sandboxed canvas inside its navigator or work-tab placeholder.
- A restricted app may render any reviewed local HTML/CSS/JavaScript that fits its task, but it must adapt to both compact navigator and full work-tab placements. Use `workFoldRestrictedApp.context` rather than viewport guesses to select the layout.
- Grant controls and connection forms stay in Settings → Apps, not inside app-controlled pixels. App UI may explain why a power is useful and handle denial, but it must not imitate a work-fold grant dialog or claim access before the host confirms it.
- App-requested tabs use the same Space-bound tab strip, focus, restore, close, and cross-Space behavior as built-in tabs. Titles should describe the current object or view, not repeat the app name on every tab.
- Host theme changes are delivered through app context. App content must remain legible in both themes, but it cannot make the shell transparent, recolor structural chrome, or draw over native menus and modals.

## macOS chrome

- Use the hidden-inset native macOS title bar, traffic lights, application menu, and Window menu. Do not render the Windows custom title bar on macOS.
- Keep Settings and About in the application menu, standard editing roles in Edit, and minimize/zoom/front roles in Window.
- Use sidebar vibrancy only for structural chrome when reduced transparency is off. Keep work surfaces opaque and fall back to theme-matched solid chrome.
- Use the macOS system font, system accent color, shortcut glyphs, and native overlay scrollbars without changing the shared Space, Files, Chats, History, Add, and Skills & Extensions interaction contract.
- Support Finder-oriented file behavior: Show in Finder, Quick Look, represented Space folders, and recent Space documents. Keep all host actions path-confined to the owning Space.

## Visual acceptance

Before a handoff, exercise every primary surface and every Settings section in light and dark themes at 1440×900, 1280×800, and a tall/narrow desktop window. Reject the candidate for:

- overlapping or concatenated copy;
- clipped labels or controls;
- horizontal page overflow;
- full-width buttons without an intentional form layout;
- mixed shell icon weights or sizes;
- repeated decorative identity graphics;
- empty states that leave unexplained split-pane chrome;
- focus, hover, active, and disabled states that are not visually distinct.

For Electron-integrated changes, repeat a packaged-app pass that confirms the platform material or its solid fallback, light/dark/system transitions, native menus, updater state, and the minimum window size. Browser fixtures cannot prove native material or titlebar behavior.

## Appearance scopes

- **Settings → Appearance** controls the application theme, font, and text size.
- **Customize Folder** controls one Folder's accent, compact banner, and Fluent identity icon.
- Customize Folder opens a popup from the Folder header, Manage Folders, or Settings → Appearance, pinned to that Folder. The work tab remains in place. Changes repaint every identity consumer immediately.
- Per-Space appearance is personal application state. It is not written into the user's ordinary folder and does not travel with shared files.
- The editor shows light and dark previews together and reports the semantic contrast audit without claiming that arbitrary images or gradients are statically certified.
- Banner, Icon, and Color sit at the top right of the fixed popup header. Name and paired previews
  keep the same geometry across sections; only the control region scrolls. Bundled images use named
  thumbnails; image framing uses draggable previews and an on-demand position/zoom popover. Color
  offers 24 labeled accent swatches; second colors belong only to Banner’s pattern controls. Icons start with a small Popular
  selection and add Nature, Life, Creative, Travel, Work, and All filters with larger 24px glyphs.
  Keep utility copy short. Worker shortcuts open the existing Folder-scoped model and instruction settings.
- A custom image is resized and compressed before machine-local service storage. Unsafe image formats and malformed stored values are rejected.
- Every Space appearance control updates the preview, saves immediately, and offers Undo and Reset. Import/export uses the same typed, code-free proposal format as the agent harness.
- Layout order, native chrome, permission UI, target sizes, and non-colour state indicators are invariants, not customization options.

See [Space customization](space-customization.md) for the resolver, persistence, and harness contract,
[Desktop experience parity](ui-parity.md) for the complete interaction contract, and
[Architecture](architecture.md) for the native/renderer boundary.

## Desktop consolidation (2026-10-09)

The design thesis is a calm desktop workbench anchored by each work-folder's distinctive banner. The content order is folder identity, Files/Chats/History navigation, then the selected work tab. Hover fills the existing target within 110ms; active, pressed, keyboard focus and disabled states remain distinct without lifting or scaling controls.

`web-local/src/styles.css` is the canonical desktop stylesheet. The former professional foundation/shell/surfaces/customization, Settings, appearance-editor and History override files are retired. Shared actions use `ui-control` with primary, quiet or icon variants; feature classes own their layout. Styles for retired Library, Drive setup, publishing drawers, activity panes and the standalone shortcuts dialog are removed after checking their renderer consumers. Brand artwork, the shared application preference sheet, and component styles shared with the paired web renderer retain their separate contracts.

`src/shared/application-appearance.ts` remains authoritative for palettes, custom accents, fonts, reading size/measure/spacing, density and accessibility. `application-appearance.css` projects those same preferences into the desktop and menu-bar renderer. Saved records, presets, Undo and Reset keep their schema and behavior. Work-folder colors, icons, patterns, uploaded banners and framing remain independent; no design selector overrides saved palette variables. The composer shell owns the complete focus boundary, including Commands/model/reasoning and Send. File tabs align metadata, a wrapping action row and document content to one gutter while keeping the selected reading preferences.
