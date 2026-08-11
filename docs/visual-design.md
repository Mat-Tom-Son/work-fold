# work-fold visual system

work-fold uses a quiet desktop-tool aesthetic. The interface should feel native, legible, and deliberate before it feels customizable.

## Information hierarchy

- A **Space** is a root folder. It is selected or switched; it is not a peer navigation surface.
- **Files** is the first working surface inside the selected Space.
- Primary rail surfaces are Files, Chats, and History. Add, Shortcuts, and Settings stay at the bottom; Library and Assistant tools open as persistent Space-owned work tabs.
- Provider, model, and authentication controls live in Settings under Assistant; Assistant is not a rail group.
- The persistent header above the left pane identifies the selected root folder. Its compact menu switches, creates, registers, or manages Spaces; the selected rail item identifies the current surface.
- A conditional **Needs you** indicator may join the bottom-rail cluster only while staged decisions pend, opening an anchored flyout of host-composed cards; the glance opens as a compact panel from the Space-identity header region. Neither is a rail destination, tab, permanent badge, or notification stream, and both disappear entirely when they have nothing to show.

## Iconography

- Use Fluent System Icons for shell navigation, commands, status, and empty states.
- Use regular icons at rest and the matching filled icon for a selected navigation item.
- Use 16px icons for inline actions, 24px for the icon-only rail navigation, 20px for section markers, and no more than 24px for empty states.
- Material file-type icons are the one deliberate exception because file recognition benefits from familiar type colors.
- Do not mix icon libraries within one control group. The Space glyph may repeat only where it communicates inherited root context: the header switcher, cards, Chat groups, and Space-bound tabs. The banner itself is name-first.
- Space color may appear as a small avatar accent or active indicator, never as a frame around the application.

## Typography and spacing

- Windows defaults to Segoe UI Variable Text; macOS defaults to the system font. Both use 15px body copy and weights 400, 600, and 700.
- User-selected fonts and text sizes may change type, but must not change shell geometry or push controls out of bounds.
- Use the 4, 8, 12, 16, 24, and 32px spacing scale.
- Controls are 36–40px tall with 4–8px radii.
- Avoid all-caps labels, weight 800+, text shadows, ornamental whole-app gradients, and oversized hero headers.

## Layout

- Desktop rail navigation is icon-only: centered square targets (44–48px) with 24px Fluent icons, tooltips and accessible names carrying the labels, and one subtle selected state (soft fill plus a small accent pill). Narrow layouts return to horizontal rows with text labels.
- Every left-pane surface begins with the same 90px identity band in the same position. Its centered, name-only lockup represents the selected Space, not the active page, and opens the same Space menu on built-in, management, and contributed-app surfaces. The menu keeps Space rows and the three compact management actions on one-line row geometry. Library and Assistant tools use the full work canvas and normal Space-bound tab chrome instead of the navigator.
- Space banners stay inside the identity header and appearance previews. They do not wallpaper the right work surface or recolor structural borders; interaction color and shell structure remain part of the global application system.
- Color and icon identity inherit through Space-bound cards, chat groups, tabs, surfaces, and chat empty states. Content belonging to another Space carries that Space's own identity rather than the currently selected one.
- Chats in the selected Space remain visually primary. Every other registered Space appears afterward as a compact, collapsed disclosure row with its current-view count and aggregate activity across all of its Chats; opening one reveals its matching Chats without making it look like another permanent navigation level.
- The Library tab uses its owning Space as the initial copy destination but keeps the shared-personal scope visible and offers a plainly labeled selector for every registered Space.
- User Chat bubbles use one solid primary Space accent, never a gradient between accent colors. Assistant message headers are text-only and do not repeat a decorative Assistant avatar.
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

- Installed Space apps occupy the contributed rail region below the three stable primary destinations. They never replace or reorder Files, Chats, or History, and they never displace the Add entry points for Library or Assistant tools.
- work-fold owns the rail target, Space identity header, navigator frame, tab chrome, loading/unavailable states, theme context, and permission/lifecycle UI. The app owns only the sandboxed canvas inside its navigator or work-tab placeholder.
- A restricted app may render any reviewed local HTML/CSS/JavaScript that fits its task, but it must adapt to both compact navigator and full work-tab placements. Use `workFoldRestrictedApp.context` rather than viewport guesses to select the layout.
- Permission prompts and connection forms stay in Assistant tools, not inside app-controlled pixels. App UI may explain why a power is useful and handle denial, but it must not imitate a work-fold grant dialog or claim access before the host confirms it.
- App-requested tabs use the same Space-bound tab strip, focus, restore, close, and cross-Space behavior as built-in tabs. Titles should describe the current object or view, not repeat the app name on every tab.
- Host theme changes are delivered through app context. App content must remain legible in both themes, but it cannot make the shell transparent, recolor structural chrome, or draw over native menus and modals.

## macOS chrome

- Use the hidden-inset native macOS title bar, traffic lights, application menu, and Window menu. Do not render the Windows custom title bar on macOS.
- Keep Settings and About in the application menu, standard editing roles in Edit, and minimize/zoom/front roles in Window.
- Use sidebar vibrancy only for structural chrome when reduced transparency is off. Keep work surfaces opaque and fall back to theme-matched solid chrome.
- Use the macOS system font, system accent color, shortcut glyphs, and native overlay scrollbars without changing the shared Space, Files, Chats, History, Add, Library-tab, and Assistant-tools interaction contract.
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
- **Customize Space** controls one Space's accent, compact banner, and Fluent identity icon.
- Customize Space is opened from the Space card and lives in one right-side appearance tab per Space. Changes repaint every identity consumer immediately.
- Per-Space appearance is personal application state. It is not written into the user's ordinary folder and does not travel with shared files.
- The editor shows light and dark previews together and reports the semantic contrast audit without claiming that arbitrary images or gradients are statically certified.
- A custom image is resized and compressed before machine-local service storage. Unsafe image formats and malformed stored values are rejected.
- Every Space appearance control updates the preview, saves immediately, and offers Undo and Reset. Import/export uses the same typed, code-free proposal format as the agent harness.
- Layout order, native chrome, permission UI, target sizes, and non-colour state indicators are invariants, not customization options.

See [Space customization](space-customization.md) for the resolver, persistence, and harness contract,
[Desktop experience parity](ui-parity.md) for the complete interaction contract, and
[Architecture](architecture.md) for the native/renderer boundary.
