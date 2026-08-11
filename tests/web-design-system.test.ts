import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const rendererRoot = join(process.cwd(), "web-local", "src");

const [
  appSource,
  rendererMainSource,
  spaceChromeSource,
  spacePanesSource,
  spaceIdentitySource,
  foundationCss,
  shellCss,
  legacyCss,
  surfacesCss,
  customizationCss,
  desktopSettingsSource,
  capabilitiesSource,
  surfaceTabsSource,
] = await Promise.all([
  readRenderer("App.tsx"),
  readRenderer("main.tsx"),
  readRenderer("components/panes/spaceChrome.tsx"),
  readRenderer("components/panes/spacePanes.tsx"),
  readRenderer("lib/space-identity.ts"),
  readRenderer("professional-foundation.css"),
  readRenderer("professional-shell.css"),
  readRenderer("styles.css"),
  readRenderer("professional-surfaces.css"),
  readRenderer("professional-customization.css"),
  readRenderer("components/modals/DesktopSettingsModal.tsx"),
  readRenderer("components/panes/CapabilitiesPane.tsx"),
  readRenderer("hooks/useSurfaceTabs.ts"),
]);

test("Files is the first primary surface and Space actions live in the persistent header menu", () => {
  const primaryItems = constArrayBody(spaceChromeSource, "primaryItems");
  const primaryModes = [...primaryItems.matchAll(/mode:\s*"([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(primaryModes, ["files", "chats", "history"]);
  assert.doesNotMatch(primaryItems, /mode:\s*"spaces"/);
  assert.doesNotMatch(primaryItems, /mode:\s*"library"/, "Library belongs in the Space-owned tab canvas, not the permanent rail");
  assert.doesNotMatch(primaryItems, /mode:\s*"capabilities"/, "infrequent tool administration must not occupy the primary rail");

  assert.doesNotMatch(spaceChromeSource, /space-rail-space-selector|space-rail-space-copy/);
  assert.match(spaceChromeSource, /primaryItems\.map/);
  assert.match(spaceChromeSource, /<span>Use existing folder<\/span>/);
  assert.match(spaceChromeSource, /<span>Create new Space<\/span>/);
  assert.match(spaceChromeSource, /<span>Manage Spaces<\/span>/);
  assert.match(spaceChromeSource, /aria-current=\{activeMode === item\.mode \? "page" : undefined\}/, "the active icon-only destination must be announced");
  assert.match(spaceChromeSource, /data-rail-tooltip=\{item\.title\}/, "icon-only destinations need visible hover and focus labels");
  assert.doesNotMatch(spaceChromeSource, /<span>Space<\/span>|ChevronRight20Regular|space-rail-space-caret/);
});

test("pane navigation uses one Fluent icon contract", () => {
  for (const [name, source] of [
    ["spaceChrome.tsx", spaceChromeSource],
    ["spacePanes.tsx", spacePanesSource],
  ] as const) {
    assert.doesNotMatch(source, /from\s+["']lucide-react["']/, `${name} must not mix Lucide into product surfaces`);
    assert.match(source, /from\s+["']@fluentui\/react-icons["']/, `${name} must use Fluent icons`);
  }

  const requiredNavPairs = [
    "DocumentFolder24",
    "ChatMultiple24",
    "History24",
  ];
  for (const icon of requiredNavPairs) {
    assert.match(spaceChromeSource, new RegExp(`\\b${icon}Regular\\b`), `${icon} needs a regular state`);
    assert.match(spaceChromeSource, new RegExp(`\\b${icon}Filled\\b`), `${icon} needs a filled active state`);
  }

  assert.match(spaceChromeSource, /professional-space-rail/);
  assert.match(spaceChromeSource, /Add24Regular/);
  assert.match(spaceChromeSource, /aria-label="Add or manage"/);
  assert.match(spaceChromeSource, /space-rail-add-anchor[\s\S]*?onBlurCapture=/);
  assert.doesNotMatch(spaceChromeSource, /aria-label="Assistant"/);
  assert.doesNotMatch(spaceChromeSource, /mode:\s*"setup"/);
  assert.doesNotMatch(spaceChromeSource, /<Bot\w*[^>]*>.*Assistant/s);
});

test("Library opens from Add as a persistent Space-owned work tab", () => {
  const primaryItems = constArrayBody(spaceChromeSource, "primaryItems");
  assert.doesNotMatch(primaryItems, /mode:\s*"library"/);
  assert.match(spaceChromeSource, /Open Library/);
  assert.match(spaceChromeSource, /chooseAddAction\(onOpenLibrary\)/);
  assert.match(appSource, /onOpenLibrary=\{\(\) => openLibrary\(space\)\}/);
  assert.match(surfaceTabsSource, /skipNextPersistRef = useRef\(!fixtureMode && !migrateLegacyLibraryMode\)/);
  assert.match(appSource, /tab\.kind === "library"[\s\S]*?<LibraryPane/);
  assert.doesNotMatch(appSource, /activeMode === "library"[\s\S]*?<LibraryPane/);
  assert.match(appSource, /const \[libraryTree, setLibraryTree\]/);
  assert.match(appSource, /tree=\{libraryTree\}[\s\S]*?onRefresh=\{refreshLibraryTree\}/);
  assert.doesNotMatch(spacePanesSource, /const \[tree, setTree\]/);
  assert.match(spacePanesSource, /Personal · available across Spaces/);
  assert.match(spacePanesSource, /Add a copy to[\s\S]*?spaces\.map/);
  assert.match(spacePanesSource, /Your Library stays unchanged; only the new copy belongs to the selected Space/);
  assert.match(spacePanesSource, /targetFolderPath", ""/);
  assert.match(spacePanesSource, /parentPath: ""/);
  assert.match(surfacesCss, /\.space-surface-body:has\(> \.library-pane\)[\s\S]*?container-type:\s*inline-size/);
  assert.match(surfacesCss, /\.library-tab-header[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
  assert.match(surfacesCss, /@container space-pane \(max-width: 760px\)[\s\S]*?\.library-tab-header[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test("Skills, Extensions, and apps open as an on-demand Assistant tools work tab", () => {
  const primaryItems = constArrayBody(spaceChromeSource, "primaryItems");
  assert.doesNotMatch(primaryItems, /mode:\s*"capabilities"/);
  assert.doesNotMatch(primaryItems, /mode:\s*"skills"|mode:\s*"extensions"/);
  assert.match(spaceChromeSource, /Browse Skills &amp; Extensions/);
  assert.match(spaceChromeSource, /Manage Assistant tools/);
  assert.match(appSource, /openAssistantToolsSurfaceTab\(space,\s*"installed"\)/);
  assert.match(appSource, /tab\.kind === "assistant-tools"[\s\S]*?<CapabilitiesPane/);
  assert.doesNotMatch(appSource, /activeMode === "capabilities"[\s\S]*?<CapabilitiesPane/);
  assert.match(capabilitiesSource, /Installed[\s\S]*Discover/);
  assert.match(capabilitiesSource, /Search installed tools/);
  assert.match(capabilitiesSource, /Skills[\s\S]*Extensions/);
  assert.match(capabilitiesSource, /Personal[\s\S]*This Space/);
  assert.match(capabilitiesSource, /capabilities\/details\?id=/);
  assert.match(capabilitiesSource, /capabilities\/install/);
  assert.match(capabilitiesSource, /capabilities-view-tabs[\s\S]*?view === "installed" \? \([\s\S]*?capabilities-installed-panel/);
  assert.match(capabilitiesSource, /view === "installed" \? \([\s\S]*?capabilities-installed-panel[\s\S]*?: \([\s\S]*?capabilities-discover-panel/);
  assert.match(capabilitiesSource, /addOpen \? \([\s\S]*?<AddCapabilityDialog/);
  assert.doesNotMatch(capabilitiesSource, /<section className="professional-card capabilities-add-panel"/);
  assert.match(capabilitiesSource, /<CoreToolsSection tools=\{catalog\.tools\} management=\{catalog\.toolManagement\}/);
  assert.match(capabilitiesSource, /tool\.core === true \|\| tool\.kind === "core"/);
  assert.match(capabilitiesSource, /These tools ship with Pi\. New Chats start with the defaults below/);
  assert.match(capabilitiesSource, /On in new Chats[\s\S]*Available to Chats/);
  assert.doesNotMatch(capabilitiesSource, /active\s*·[\s\S]*available tools/i);
  assert.match(capabilitiesSource, /setTypeFilter\("all"\);[\s\S]*setScopeFilter\("all"\);[\s\S]*selectView\("installed"\)/);
  assert.match(capabilitiesSource, /ArrowRight[\s\S]*ArrowLeft[\s\S]*Home[\s\S]*End/);
  assert.doesNotMatch(capabilitiesSource, /from\s+["']lucide-react["']/);

  for (const className of [
    "capabilities-pane",
    "assistant-tools-pane",
    "assistant-tools-header",
    "capabilities-view-tabs",
    "capabilities-view-content",
    "capabilities-add-panel",
    "capabilities-toolbar",
    "capabilities-search",
    "capabilities-resource-card",
    "capabilities-discover-card",
    "capability-dialog",
    "capability-review-facts",
    "capability-code-warning",
    "capabilities-core-tools",
    "capabilities-resource-section",
  ]) {
    assert.equal(hasClassSelector(surfacesCss, className), true, `Capabilities class .${className} must be styled`);
  }
  for (const className of [...staticClassTokens(capabilitiesSource)].filter((name) => /^capabilit(?:y|ies)-/.test(name))) {
    assert.equal(hasClassSelector(surfacesCss, className), true, `Static Capabilities class .${className} must be styled`);
  }
  assert.match(surfacesCss, /\.space-surface-body:has\(> \.assistant-tools-pane\)[\s\S]*?container-type:\s*inline-size/);
  assert.match(surfacesCss, /@container space-pane \(max-width: 520px\)[\s\S]*?\.capabilities-resource-card/);
  assert.match(surfacesCss, /@media \(max-width: 600px\)[\s\S]*?\.capability-dialog/);
});

test("Assistant configuration lives in Settings instead of the rail", () => {
  assert.match(desktopSettingsSource, /id:\s*"assistant"[\s\S]*?label:\s*"Assistant"/);
  assert.match(desktopSettingsSource, /<AssistantSetupPane[\s\S]*?embedded/);
  assert.match(appSource, /openSettings\("assistant"\)/);
  assert.doesNotMatch(appSource, /activeMode\s*===\s*"setup"/);
  assert.doesNotMatch(spaceChromeSource, /Assistant ·/);
});

test("Space identity and typography keep the restrained defaults", () => {
  const defaultIconBody = functionBody(spaceIdentitySource, "defaultSpaceIconName");
  assert.match(defaultIconBody, /^\s*return\s+["']folder["'];?\s*$/);
  assert.doesNotMatch(defaultIconBody, /notebook/i);

  const heavyWeightMatch = foundationCss.match(/--work-fold-font-weight-heavy:\s*(\d+)\s*;/);
  assert.ok(heavyWeightMatch, "professional foundation must declare the heavy-weight token");
  assert.equal(Number(heavyWeightMatch[1]), 700);

  const numericWeights = [
    Number(heavyWeightMatch[1]),
    ...[...foundationCss.matchAll(/font-weight:\s*(\d+)\s*;/g)].map((match) => Number(match[1])),
  ];
  assert.ok(numericWeights.every((weight) => weight <= 700), `foundation contains a weight above 700: ${numericWeights.join(", ")}`);
});

test("every referenced elevation and radius token is defined", () => {
  // A var() whose token is undefined is a silent no-op declaration — the
  // rail add menu and the needs-you flyout shipped shadowless, and the
  // capability dialog shipped square-cornered, exactly this way — so every
  // referenced --ui-shadow-* token must resolve in the light root and again
  // in the dark override, and every referenced --ui-radius-* token must
  // resolve in the root (radii are theme-invariant, so the dark override
  // never redefines them).
  const sheets = [foundationCss, shellCss, legacyCss, surfacesCss, customizationCss];
  const referencedShadows = new Set<string>();
  const referencedRadii = new Set<string>();
  for (const css of sheets) {
    for (const match of css.matchAll(/var\((--ui-shadow-[a-z-]+)[,)]/g)) referencedShadows.add(match[1]!);
    for (const match of css.matchAll(/var\((--ui-radius-[a-z-]+)[,)]/g)) referencedRadii.add(match[1]!);
  }
  assert.ok(referencedShadows.has("--ui-shadow-lg"), "the elevated flyout shadow is in use");
  assert.ok(referencedRadii.has("--ui-radius-xl"), "the capability-dialog radius is in use");
  const darkStart = foundationCss.indexOf(':root[data-theme="dark"]');
  assert.ok(darkStart > 0);
  const lightBlock = foundationCss.slice(foundationCss.indexOf(":root {"), darkStart);
  const darkBlock = foundationCss.slice(darkStart, foundationCss.indexOf("}", darkStart) + 1);
  for (const token of referencedShadows) {
    assert.ok(lightBlock.includes(`${token}:`), `${token} must be defined in the light theme`);
    assert.ok(darkBlock.includes(`${token}:`), `${token} must be defined for the dark theme`);
  }
  for (const token of referencedRadii) {
    assert.ok(lightBlock.includes(`${token}:`), `${token} must be defined in the root theme block`);
  }
});

test("every used P0 pane class has a CSS selector", () => {
  const p0Classes = [
    "assistant-setup-card",
    "setup-intro",
    "setup-grid",
    "security-note",
    "trust-banner",
    "install-panel",
    "scope-toggle",
    "package-input",
    "card-grid",
    "resource-card",
    "empty-state",
    "tool-details",
    "tool-list",
    "loading-row",
    "inline-error",
    "diagnostics",
    "history-list",
    "history-pane-actions",
    "library-split",
    "library-tree",
    "library-detail",
    "resource-selection",
    "chat-space-heading",
    "professional-surface",
    "professional-card",
    "professional-button",
    "professional-field",
    "professional-notice",
    "professional-install-panel",
    "professional-card-grid",
    "professional-empty-state",
  ];
  const staticClasses = staticClassTokens(spacePanesSource);
  const combinedCss = stripCssComments(`${legacyCss}\n${surfacesCss}`);
  const usedP0Classes = p0Classes.filter((className) => staticClasses.has(className));
  const missingSelectors = usedP0Classes.filter((className) => !hasClassSelector(combinedCss, className));

  assert.ok(usedP0Classes.length > 0, "the P0 contract must cover classes used by spacePanes");
  assert.deepEqual(missingSelectors, [], `P0 classes without CSS selectors: ${missingSelectors.join(", ")}`);
});

test("professional shell keeps compact navigation and the persistent Space identity header", () => {
  const layoutRule = cssRuleBody(shellCss, ".app-shell .space-layout");
  const modePaneRule = cssRuleBody(shellCss, ".app-shell .space-layout .space-mode-pane");
  const railRule = cssRuleBody(shellCss, ".app-shell .professional-space-rail");
  const navButtonRule = cssRuleBody(shellCss, ".app-shell .professional-space-rail .space-rail-button");
  const compactShellCss = shellCss.slice(shellCss.indexOf("@media (max-width: 820px)"));
  const compactRailRule = cssRuleBody(compactShellCss, ".app-shell .professional-space-rail");
  const compactNavRule = cssRuleBody(compactShellCss, ".app-shell .professional-space-rail .space-rail-nav");
  const compactAccountRule = cssRuleBody(compactShellCss, ".app-shell .professional-space-rail .space-rail-account");
  const shortDesktopShellCss = shellCss.slice(shellCss.indexOf("@media (max-height: 720px)"));
  const shortDesktopRailRule = cssRuleBody(shortDesktopShellCss, ".app-shell .professional-space-rail");
  const paneHeaderRule = cssRuleBody(shellCss, ".app-shell .space-layout .space-mode-pane .professional-pane-header");
  const spacesPaneRule = cssRuleBody(surfacesCss, ".space-pane-content.professional-spaces");

  assert.match(modePaneRule, /border-color:\s*var\(--ui-border\)/);
  assert.match(railRule, /border-color:\s*var\(--ui-border\)/);
  assert.match(paneHeaderRule, /border:\s*1px\s+solid\s+var\(--ui-border\)/);
  assert.match(paneHeaderRule, /background:\s*var\(--ui-surface\)/);
  for (const structuralRule of [modePaneRule, railRule, paneHeaderRule]) {
    assert.doesNotMatch(structuralRule, /--space-(?:selection|custom)-/, "structural borders must stay independent of Space accent colors");
  }

  assert.ok(maxPxValue(customPropertyValue(layoutRule, "--space-rail-width")) <= 180, "desktop rail must remain compact");
  assert.equal(maxPxValue(customPropertyValue(layoutRule, "--space-identity-header-height")), 90, "the Space banner must retain its established 90px geometry");
  assert.ok(pxDeclaration(navButtonRule, "min-height") <= 48, "primary navigation targets must stay compact");
  assert.equal(pxDeclaration(navButtonRule, "width"), pxDeclaration(navButtonRule, "min-height"), "primary navigation uses square icon-only targets");
  assert.match(shellCss, /\.professional-space-rail \.space-rail-label\s*\{[\s\S]*?display:\s*none/, "the desktop rail is icon-only; labels live in tooltips and accessible names");
  assert.match(compactShellCss, /\.space-rail-label\s*\{[\s\S]*?display:\s*block/, "the narrow horizontal rail restores text labels");
  assert.doesNotMatch(`${shellCss}\n${customizationCss}`, /space-rail-space-selector|space-rail-space-copy|space-rail-space-avatar/);
  assert.match(layoutRule, /--space-identity-title-size:\s*17px/);
  assert.match(layoutRule, /--space-identity-tracking:\s*0\.01em/);
  assert.match(shortDesktopRailRule, /padding:\s*8px\s+6px\s+6px/, "short desktop layouts must keep navigation compact");
  assert.match(compactRailRule, /overflow:\s*hidden/, "the narrow rail must contain independent scroll regions");
  assert.match(compactNavRule, /flex:\s*1\s+1\s+auto/);
  assert.match(compactNavRule, /overflow-x:\s*auto/, "narrow primary destinations must scroll instead of colliding with tools");
  assert.match(compactAccountRule, /flex:\s*0\s+0\s+auto/, "Shortcuts and Settings must remain reachable while destinations scroll");
  const tooltipRule = cssRuleBody(shellCss, ".app-shell .professional-space-rail [data-rail-tooltip]::after");
  assert.match(tooltipRule, /content:\s*attr\(data-rail-tooltip\)/);
  assert.match(shellCss, /\[data-rail-tooltip\]:focus-visible::after/, "tooltips must work for sighted keyboard users");
  assert.match(spacesPaneRule, /scrollbar-gutter:\s*auto/, "the Spaces pane must not reserve a dead right-side gutter");
  assert.match(shellCss, /\.professional-space-rail \.space-rail-button svg,[\s\S]*?\{[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;/);
});

test("Space customization is visible, compact, and separate from structural chrome", () => {
  assert.match(spaceChromeSource, /"space-banner-surface"/);
  assert.match(spaceChromeSource, /"space-identity-header"/);
  assert.match(spaceChromeSource, /space-pane-banner-image/);
  assert.match(spaceChromeSource, /spaceIdentityStyle\(itemIdentity\)/);
  assert.match(spaceChromeSource, /<SpaceIconGlyph icon=\{itemIdentity\.Icon\}/);
  assert.match(spaceChromeSource, /data-space-icon=\{itemIdentity\.iconName\}/);
  assert.match(spaceChromeSource, /space-appearance-preview/);
  assert.match(spaceChromeSource, /spaceLookOptions\.map/);
  assert.match(spaceChromeSource, /aria-label="Curated Space looks"/);
  assert.match(spaceChromeSource, /<strong>Fine tune<\/strong>/);
  assert.match(spaceChromeSource, /onResetSpace/);
  assert.match(customizationCss, /\.space-banner-surface\.banner-none/);

  const bannerHeaderRule = cssRuleBody(customizationCss, ".app-shell .space-layout .space-mode-pane .professional-pane-header.space-identity-header");
  const bannerTitleRule = cssRuleBody(customizationCss, ".app-shell .professional-pane-header.space-identity-header .space-pane-current-lockup strong");
  const previewTitleRule = cssRuleBody(customizationCss, ".space-appearance-preview-copy strong {");
  assert.match(bannerHeaderRule, /border:\s*1px\s+solid\s+var\(--ui-border\)/);
  assert.match(bannerTitleRule, /line-height:\s*1\.3/);
  assert.match(bannerTitleRule, /font-size:\s*var\(--space-identity-title-size\)/);
  assert.match(bannerTitleRule, /letter-spacing:\s*var\(--space-identity-tracking\)/, "the identity title should read as a deliberate display label without replacing the selected font");
  assert.match(previewTitleRule, /font-size:\s*var\(--space-identity-title-size\)/, "the appearance preview must match the live identity title scale");
  assert.match(previewTitleRule, /letter-spacing:\s*var\(--space-identity-tracking\)/);
  assert.match(bannerTitleRule, /padding-block:\s*2px/, "identity titles need descender-safe line boxes");
  assert.doesNotMatch(spaceChromeSource, /space-identity-header-icon|space-appearance-preview-icon/);
  assert.doesNotMatch(customizationCss, /space-identity-header-icon|space-appearance-preview-icon/);
  assert.match(customizationCss, /\.professional-space-switcher \.space-header-switcher-icon[\s\S]*?color:\s*var\(--space-accent-glyph\)/);
  assert.match(customizationCss, /\.professional-appearance-surface/);
  assert.match(customizationCss, /\.space-look-gallery/);
  assert.match(customizationCss, /\.space-look-card\.active/);
  assert.match(customizationCss, /\.space-banner-position-control/);
  const colorPickerRule = cssRuleBody(customizationCss, ".app-shell .professional-appearance-surface .space-color-picker");
  const colorWheelRule = cssRuleBody(customizationCss, ".app-shell .professional-appearance-surface .space-color-wheel");
  const colorPairClearRule = cssRuleBody(legacyCss, ".space-color-pair-clear");
  assert.match(colorPickerRule, /min-height:\s*38px/);
  assert.match(colorPickerRule, /height:\s*auto/, "the custom color wheel must remain inside its control");
  assert.match(colorWheelRule, /width:\s*28px/);
  assert.match(colorPairClearRule, /padding:\s*0/, "the paired-color clear icon must not overflow its control group");
  assert.match(spaceChromeSource, /onInput=[\s\S]*?aria-label="Choose second banner color"/);
  assert.match(customizationCss, /\.space-banner-surface\.banner-classic[\s\S]*?--space-banner-secondary-rgb/, "the second color must affect the default banner through its dedicated role");
  const activeRailMarkerRule = cssRuleBody(customizationCss, ".app-shell .professional-space-rail .space-rail-button.active::before");
  assert.match(activeRailMarkerRule, /background:\s*var\(--space-accent-indicator\)/, "the contrast-solved indicator role must drive the compact active pill");
  assert.doesNotMatch(activeRailMarkerRule, /box-shadow/, "the active pill must not resurrect the legacy full-row shadow");
  assert.match(customizationCss, /\.professional-spaces \.space-card-shell\.active[\s\S]*?background:\s*var\(--space-accent-soft-fill\)/);
  assert.match(customizationCss, /\.professional-chats \.chat-space-heading > span:first-child[\s\S]*?color:\s*var\(--space-accent-glyph\)/);
  assert.match(legacyCss, /\.message\.user\s*\{[\s\S]*?background:\s*var\(--space-accent-solid/, "user messages must use the resolved solid role");
  assert.match(legacyCss, /\.message\.user \.message-time\s*\{[\s\S]*?color:\s*var\(--space-on-accent-muted/, "message footer metadata must use its audited composite role");
  assert.match(spaceIdentitySource, /"--space-selection-accent":\s*identity\.color/, "transitional aliases must preserve the v1 accent until their consumers are assigned roles");
  assert.match(spaceIdentitySource, /"--space-selection-border":\s*identity\.borderColor/);
  assert.match(spaceIdentitySource, /"--space-selection-surface":\s*identity\.softColor/);
  assert.doesNotMatch(spaceIdentitySource, /"--space-banner-(?:primary|base)":/, "unused banner string tokens must not be injected at every identity scope");
  assert.match(spaceChromeSource, /\(\["light", "dark"\] as const\)\.map/, "the editor must preview both modes together");
  assert.match(customizationCss, /\.app-shell \.space-appearance-preview\.preview-light\s*\{[\s\S]*?--space-banner-base-rgb:\s*255,\s*255,\s*255/, "the light preview must beat the surrounding app theme");
  assert.match(customizationCss, /\.app-shell \.space-appearance-preview\.preview-dark\s*\{[\s\S]*?--space-banner-base-rgb:\s*23,\s*26,\s*33/, "the dark preview must beat the surrounding app theme");
  assert.match(spaceChromeSource, /parseSpaceAppearanceProposal/, "the editor must import the shared bounded proposal");
  assert.match(spaceChromeSource, /createSpaceAppearanceProposal/, "the editor must export the shared bounded proposal");
  assert.doesNotMatch(
    appSource,
    /normalizeSpaceCustomizations\(customizationsRef\.current,\s*new Set\(spaces/,
    "temporarily missing or moved Spaces must keep their identity until an explicit removal",
  );

  assert.match(foundationCss, /--work-fold-ui-font:\s*var\(--work-fold-font-family/);
  assert.match(rendererMainSource, /windowMaterial === "mica" \|\| windowMaterial === "vibrancy"[\s\S]*?dataset\.windowMaterial = windowMaterial/, "window material must be applied before React's first paint");
  assert.match(rendererMainSource, /delete document\.documentElement\.dataset\.windowMaterial/, "solid-material sessions must clear stale material state");
  assert.doesNotMatch(appSource, /dataset\.windowMaterial/, "window material must not wait for a passive React effect");
  assert.doesNotMatch(foundationCss, /--work-fold-font-size:/, "the professional layer must not override the user's text-size preference");
  assert.doesNotMatch(desktopSettingsSource, /from\s+["']lucide-react["']/);
  assert.match(desktopSettingsSource, /from\s+["']@fluentui\/react-icons["']/);
});

test("the left header is inherited Space identity on every mode, not a surface title", () => {
  const headerCall = appSource.match(/<SpacePaneHeader[\s\S]*?\/>/)?.[0];
  assert.ok(headerCall, "App must render the shared Space identity header");
  const headerIdentityProps = headerCall.split(" action=")[0]!;
  assert.match(headerIdentityProps, /space=\{space\}/);
  assert.match(headerIdentityProps, /identity=\{identity\}/);
  assert.doesNotMatch(headerIdentityProps, /switchable=/, "the Space menu must remain available on management and custom surfaces");
  assert.doesNotMatch(headerIdentityProps, /title=|paneTitle|onCustomize/);

  assert.match(spaceChromeSource, /<strong>\{space\.name\}<\/strong>/);
  assert.match(spaceChromeSource, /<span className="sr-only">\{detail\}<\/span>/);
  assert.match(spaceChromeSource, /className="space-pane-switch-trigger"/);
  assert.match(spaceChromeSource, /aria-haspopup="menu"/);
  assert.match(spaceChromeSource, /role="menu" aria-label="Space menu"/);
  assert.match(spaceChromeSource, /role="menuitem"/);
  assert.match(spaceChromeSource, /data-native-view-occluder="true"/);
  assert.match(spaceChromeSource, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(spaceChromeSource, /querySelector<HTMLButtonElement>\('\[role="menuitem"\]'\)\?\.focus\(\)/);
  assert.doesNotMatch(spaceChromeSource, /role=\{switcherEnabled \? "button" : undefined\}/);
  assert.doesNotMatch(spaceChromeSource, /onClick=\{toggleSwitcher\}[\s\S]{0,180}<SpaceIconGlyph/);
  assert.doesNotMatch(spaceChromeSource, /space-identity-header-icon/);
  assert.doesNotMatch(spaceChromeSource, /space-identity-header-text/);
  assert.doesNotMatch(spaceChromeSource, /Customize Space.*professional-header-action/s);
});

test("every left-pane mode keeps content padding below the shared Space banner", () => {
  const headerIndex = appSource.indexOf("<SpacePaneHeader");
  const filesContentIndex = appSource.indexOf('activeMode === "files" ? <div className="local-files-panel">');
  const localFilesRule = cssRuleBody(legacyCss, ".local-files-panel");

  assert.ok(headerIndex >= 0 && filesContentIndex > headerIndex, "the Files content wrapper must render below the shared header");
  assert.doesNotMatch(appSource, /activeMode === "files" \? "file-panel local-files-panel"/);
  assert.match(localFilesRule, /flex:\s*1 1 auto/);
  assert.match(localFilesRule, /padding:\s*12px/);
});

test("the appearance preview mirrors the Space header rather than the active surface", () => {
  assert.match(spaceChromeSource, /space-appearance-preview-copy"><strong>\{space\.name\}<\/strong>/);
  assert.doesNotMatch(spaceChromeSource, /space-appearance-preview-copy"><strong>Files<\/strong>/);
  assert.match(customizationCss, /\.space-appearance-preview\s*\{[\s\S]*?min-height:\s*90px;/);
});

async function readRenderer(relativePath: string): Promise<string> {
  return readFile(join(rendererRoot, relativePath), "utf8");
}

function constArrayBody(source: string, constName: string): string {
  const match = source.match(new RegExp(`const\\s+${escapeRegExp(constName)}[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\n\\s*\\];`));
  assert.ok(match, `could not find ${constName} array`);
  return match[1];
}

function functionBody(source: string, functionName: string): string {
  const match = source.match(new RegExp(`function\\s+${escapeRegExp(functionName)}\\s*\\([^)]*\\)\\s*:[^{]+\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `could not find ${functionName} function`);
  return match[1];
}

function staticClassTokens(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/className="([^"]+)"/g)]
      .flatMap((match) => match[1].split(/\s+/))
      .filter(Boolean),
  );
}

function hasClassSelector(css: string, className: string): boolean {
  return new RegExp(`\\.${escapeRegExp(className)}(?=\\s|[.#:>+~,{\\[]|\\))`).test(css);
}

function cssRuleBody(css: string, selector: string): string {
  const selectorIndex = css.indexOf(selector);
  assert.ok(selectorIndex >= 0, `could not find CSS selector: ${selector}`);
  const openBraceIndex = css.indexOf("{", selectorIndex);
  const closeBraceIndex = css.indexOf("}", openBraceIndex);
  assert.ok(openBraceIndex >= 0 && closeBraceIndex > openBraceIndex, `could not read CSS rule: ${selector}`);
  return css.slice(openBraceIndex + 1, closeBraceIndex);
}

function customPropertyValue(ruleBody: string, property: string): string {
  const match = ruleBody.match(new RegExp(`${escapeRegExp(property)}:\\s*([^;]+);`));
  assert.ok(match, `could not find ${property}`);
  return match[1];
}

function maxPxValue(value: string): number {
  const values = [...value.matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
  assert.ok(values.length > 0, `expected a pixel value in: ${value}`);
  return Math.max(...values);
}

function pxDeclaration(ruleBody: string, property: string): number {
  const match = ruleBody.match(new RegExp(`${escapeRegExp(property)}:\\s*(\\d+(?:\\.\\d+)?)px\\s*;`));
  assert.ok(match, `could not find pixel declaration ${property}`);
  return Number(match[1]);
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
