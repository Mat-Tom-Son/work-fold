import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const rendererRoot = join(process.cwd(), "web-local", "src");

const [
  appSource,
  rendererMainSource,
  workspaceChromeSource,
  workspacePanesSource,
  workspaceIdentitySource,
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
  readRenderer("components/panes/workspaceChrome.tsx"),
  readRenderer("components/panes/workspacePanes.tsx"),
  readRenderer("lib/workspace-identity.ts"),
  readRenderer("professional-foundation.css"),
  readRenderer("professional-shell.css"),
  readRenderer("styles.css"),
  readRenderer("professional-surfaces.css"),
  readRenderer("professional-customization.css"),
  readRenderer("components/modals/DesktopSettingsModal.tsx"),
  readRenderer("components/panes/CapabilitiesPane.tsx"),
  readRenderer("hooks/useSurfaceTabs.ts"),
]);

test("Files is the first primary surface and Space remains the root selector", () => {
  const primaryItems = constArrayBody(workspaceChromeSource, "primaryItems");
  const primaryModes = [...primaryItems.matchAll(/mode:\s*"([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(primaryModes, ["files", "chats", "history"]);
  assert.doesNotMatch(primaryItems, /mode:\s*"workspaces"/);
  assert.doesNotMatch(primaryItems, /mode:\s*"library"/, "Library belongs in the Space-owned tab canvas, not the permanent rail");
  assert.doesNotMatch(primaryItems, /mode:\s*"capabilities"/, "infrequent tool administration must not occupy the primary rail");

  const selectorIndex = workspaceChromeSource.indexOf("workspace-rail-space-selector");
  const primaryRenderIndex = workspaceChromeSource.indexOf("primaryItems.map");
  assert.ok(selectorIndex >= 0, "the rail must expose a distinct Space selector");
  assert.ok(primaryRenderIndex > selectorIndex, "the Space selector must render before primary surfaces");
  assert.match(workspaceChromeSource, /onModeChange\("workspaces"\)/);
  assert.match(workspaceChromeSource, /aria-current=\{activeMode === item\.mode \? "page" : undefined\}/, "the active icon-only destination must be announced");
  assert.match(workspaceChromeSource, /data-rail-tooltip=\{item\.title\}/, "icon-only destinations need visible hover and focus labels");
  assert.match(workspaceChromeSource, /workspace-rail-space-copy"><strong>\{workspaceLabel\}<\/strong>/);
  assert.doesNotMatch(workspaceChromeSource, /<span>Space<\/span>|ChevronRight20Regular|workspace-rail-space-caret/);
});

test("pane navigation uses one Fluent icon contract", () => {
  for (const [name, source] of [
    ["workspaceChrome.tsx", workspaceChromeSource],
    ["workspacePanes.tsx", workspacePanesSource],
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
    assert.match(workspaceChromeSource, new RegExp(`\\b${icon}Regular\\b`), `${icon} needs a regular state`);
    assert.match(workspaceChromeSource, new RegExp(`\\b${icon}Filled\\b`), `${icon} needs a filled active state`);
  }

  assert.match(workspaceChromeSource, /professional-workspace-rail/);
  assert.match(workspaceChromeSource, /Add24Regular/);
  assert.match(workspaceChromeSource, /aria-label="Add or manage"/);
  assert.match(workspaceChromeSource, /workspace-rail-add-anchor[\s\S]*?onBlurCapture=/);
  assert.doesNotMatch(workspaceChromeSource, /aria-label="Assistant"/);
  assert.doesNotMatch(workspaceChromeSource, /mode:\s*"setup"/);
  assert.doesNotMatch(workspaceChromeSource, /<Bot\w*[^>]*>.*Assistant/s);
});

test("Library opens from Add as a persistent Space-owned work tab", () => {
  const primaryItems = constArrayBody(workspaceChromeSource, "primaryItems");
  assert.doesNotMatch(primaryItems, /mode:\s*"library"/);
  assert.match(workspaceChromeSource, /Open Library/);
  assert.match(workspaceChromeSource, /chooseAddAction\(onOpenLibrary\)/);
  assert.match(appSource, /onOpenLibrary=\{\(\) => openLibrary\(workspace\)\}/);
  assert.match(surfaceTabsSource, /skipNextPersistRef = useRef\(!fixtureMode && !migrateLegacyLibraryMode\)/);
  assert.match(appSource, /tab\.kind === "library"[\s\S]*?<LibraryPane/);
  assert.doesNotMatch(appSource, /activeMode === "library"[\s\S]*?<LibraryPane/);
  assert.match(appSource, /const \[libraryTree, setLibraryTree\]/);
  assert.match(appSource, /tree=\{libraryTree\}[\s\S]*?onRefresh=\{refreshLibraryTree\}/);
  assert.doesNotMatch(workspacePanesSource, /const \[tree, setTree\]/);
  assert.match(workspacePanesSource, /Personal · available across Spaces/);
  assert.match(workspacePanesSource, /Add a copy to[\s\S]*?workspaces\.map/);
  assert.match(workspacePanesSource, /Your Library stays unchanged; only the new copy belongs to the selected Space/);
  assert.match(workspacePanesSource, /targetFolderPath", ""/);
  assert.match(workspacePanesSource, /parentPath: ""/);
  assert.match(surfacesCss, /\.workspace-surface-body:has\(> \.library-pane\)[\s\S]*?container-type:\s*inline-size/);
  assert.match(surfacesCss, /\.library-tab-header[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
  assert.match(surfacesCss, /@container workspace-pane \(max-width: 760px\)[\s\S]*?\.library-tab-header[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test("Skills, Extensions, and apps open as an on-demand Assistant tools work tab", () => {
  const primaryItems = constArrayBody(workspaceChromeSource, "primaryItems");
  assert.doesNotMatch(primaryItems, /mode:\s*"capabilities"/);
  assert.doesNotMatch(primaryItems, /mode:\s*"skills"|mode:\s*"extensions"/);
  assert.match(workspaceChromeSource, /Browse Skills &amp; Extensions/);
  assert.match(workspaceChromeSource, /Manage Assistant tools/);
  assert.match(appSource, /openAssistantToolsSurfaceTab\(workspace,\s*"installed"\)/);
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
  assert.match(surfacesCss, /\.workspace-surface-body:has\(> \.assistant-tools-pane\)[\s\S]*?container-type:\s*inline-size/);
  assert.match(surfacesCss, /@container workspace-pane \(max-width: 520px\)[\s\S]*?\.capabilities-resource-card/);
  assert.match(surfacesCss, /@media \(max-width: 600px\)[\s\S]*?\.capability-dialog/);
});

test("Assistant configuration lives in Settings instead of the rail", () => {
  assert.match(desktopSettingsSource, /id:\s*"assistant"[\s\S]*?label:\s*"Assistant"/);
  assert.match(desktopSettingsSource, /<AssistantSetupPane[\s\S]*?embedded/);
  assert.match(appSource, /openSettings\("assistant"\)/);
  assert.doesNotMatch(appSource, /activeMode\s*===\s*"setup"/);
  assert.doesNotMatch(workspaceChromeSource, /Assistant ·/);
});

test("Space identity and typography keep the restrained defaults", () => {
  const defaultIconBody = functionBody(workspaceIdentitySource, "defaultWorkspaceIconName");
  assert.match(defaultIconBody, /^\s*return\s+["']folder["'];?\s*$/);
  assert.doesNotMatch(defaultIconBody, /notebook/i);

  const heavyWeightMatch = foundationCss.match(/--workspace-font-weight-heavy:\s*(\d+)\s*;/);
  assert.ok(heavyWeightMatch, "professional foundation must declare the heavy-weight token");
  assert.equal(Number(heavyWeightMatch[1]), 700);

  const numericWeights = [
    Number(heavyWeightMatch[1]),
    ...[...foundationCss.matchAll(/font-weight:\s*(\d+)\s*;/g)].map((match) => Number(match[1])),
  ];
  assert.ok(numericWeights.every((weight) => weight <= 700), `foundation contains a weight above 700: ${numericWeights.join(", ")}`);
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
    "chat-workspace-heading",
    "professional-surface",
    "professional-card",
    "professional-button",
    "professional-field",
    "professional-notice",
    "professional-install-panel",
    "professional-card-grid",
    "professional-empty-state",
  ];
  const staticClasses = staticClassTokens(workspacePanesSource);
  const combinedCss = stripCssComments(`${legacyCss}\n${surfacesCss}`);
  const usedP0Classes = p0Classes.filter((className) => staticClasses.has(className));
  const missingSelectors = usedP0Classes.filter((className) => !hasClassSelector(combinedCss, className));

  assert.ok(usedP0Classes.length > 0, "the P0 contract must cover classes used by workspacePanes");
  assert.deepEqual(missingSelectors, [], `P0 classes without CSS selectors: ${missingSelectors.join(", ")}`);
});

test("professional shell keeps compact navigation and the persistent Space identity header", () => {
  const layoutRule = cssRuleBody(shellCss, ".app-shell .workspace-layout");
  const modePaneRule = cssRuleBody(shellCss, ".app-shell .workspace-layout .workspace-mode-pane");
  const railRule = cssRuleBody(shellCss, ".app-shell .professional-workspace-rail");
  const navButtonRule = cssRuleBody(shellCss, ".app-shell .professional-workspace-rail .workspace-rail-button");
  const spaceSelectorRule = cssRuleBody(shellCss, ".app-shell .professional-workspace-rail .workspace-rail-space-selector");
  const compactShellCss = shellCss.slice(shellCss.indexOf("@media (max-width: 820px)"));
  const compactSpaceSelectorRule = cssRuleBody(compactShellCss, ".app-shell .professional-workspace-rail .workspace-rail-space-selector");
  const compactRailRule = cssRuleBody(compactShellCss, ".app-shell .professional-workspace-rail");
  const compactNavRule = cssRuleBody(compactShellCss, ".app-shell .professional-workspace-rail .workspace-rail-nav");
  const compactAccountRule = cssRuleBody(compactShellCss, ".app-shell .professional-workspace-rail .workspace-rail-account");
  const compactSpaceCopyRule = cssRuleBody(compactShellCss, ".app-shell .professional-workspace-rail .workspace-rail-space-copy");
  const compactSpaceNameRule = cssRuleBody(compactShellCss, ".app-shell .professional-workspace-rail .workspace-rail-space-copy strong");
  const shortDesktopShellCss = shellCss.slice(shellCss.indexOf("@media (max-height: 720px)"));
  const shortDesktopRailRule = cssRuleBody(shortDesktopShellCss, ".app-shell .professional-workspace-rail");
  const paneHeaderRule = cssRuleBody(shellCss, ".app-shell .workspace-layout .workspace-mode-pane .professional-pane-header");
  const spacesPaneRule = cssRuleBody(surfacesCss, ".workspace-pane-content.professional-spaces");

  assert.match(modePaneRule, /border-color:\s*var\(--ui-border\)/);
  assert.match(railRule, /border-color:\s*var\(--ui-border\)/);
  assert.match(paneHeaderRule, /border:\s*1px\s+solid\s+var\(--ui-border\)/);
  assert.match(paneHeaderRule, /background:\s*var\(--ui-surface\)/);
  for (const structuralRule of [modePaneRule, railRule, paneHeaderRule]) {
    assert.doesNotMatch(structuralRule, /--workspace-(?:selection|custom)-/, "structural borders must stay independent of Space accent colors");
  }

  assert.ok(maxPxValue(customPropertyValue(layoutRule, "--workspace-rail-width")) <= 180, "desktop rail must remain compact");
  assert.equal(maxPxValue(customPropertyValue(layoutRule, "--workspace-identity-header-height")), 90, "the Space banner must retain its established 90px geometry");
  assert.ok(pxDeclaration(navButtonRule, "min-height") <= 48, "primary navigation targets must stay compact");
  assert.equal(pxDeclaration(navButtonRule, "width"), pxDeclaration(navButtonRule, "min-height"), "primary navigation uses square icon-only targets");
  assert.match(shellCss, /\.professional-workspace-rail \.workspace-rail-label\s*\{[\s\S]*?display:\s*none/, "the desktop rail is icon-only; labels live in tooltips and accessible names");
  assert.match(compactShellCss, /\.workspace-rail-label\s*\{[\s\S]*?display:\s*block/, "the narrow horizontal rail restores text labels");
  assert.match(spaceSelectorRule, /height:\s*48px/, "the root Space selector is a compact 48px identity tile");
  assert.match(spaceSelectorRule, /margin:\s*21px\s+0\s+17px/, "the identity tile stays centered within the 90px header band");
  assert.match(shellCss, /\.professional-workspace-rail \.workspace-rail-space-copy\s*\{[^}]*display:\s*none/, "the desktop rail tile hides the Space name; the pane header carries it");
  assert.match(spaceSelectorRule, /border-radius:\s*var\(--workspace-identity-radius\)/, "the root Space selector and banner must share a silhouette");
  assert.match(spaceSelectorRule, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, "the desktop Space identity must use a centered single-column lockup");
  assert.match(spaceSelectorRule, /grid-template-rows:\s*1fr/, "the desktop identity tile has one visible icon row");
  assert.match(spaceSelectorRule, /place-items:\s*center/);
  assert.match(layoutRule, /--workspace-identity-glyph-size:\s*26px/, "the Space identity glyph should carry slightly more visual weight");
  assert.match(layoutRule, /--workspace-identity-rail-label-size:\s*14px/);
  assert.match(layoutRule, /--workspace-identity-title-size:\s*17px/);
  assert.match(layoutRule, /--workspace-identity-tracking:\s*0\.01em/);
  assert.match(shortDesktopRailRule, /padding:\s*8px\s+6px\s+6px/, "short desktop layouts must keep the identity selector aligned with the pane banner");
  assert.match(compactSpaceSelectorRule, /height:\s*auto/);
  assert.match(compactSpaceSelectorRule, /min-height:\s*46px/);
  assert.match(compactSpaceSelectorRule, /grid-template-columns:\s*28px\s+minmax\(0,\s*1fr\)/, "the narrow rail must retain its horizontal lockup");
  assert.match(compactSpaceSelectorRule, /grid-template-rows:\s*none/);
  assert.match(compactSpaceSelectorRule, /place-items:\s*center\s+start/);
  assert.match(compactSpaceCopyRule, /justify-items:\s*start/);
  assert.match(compactSpaceCopyRule, /text-align:\s*left/);
  assert.match(compactSpaceNameRule, /white-space:\s*nowrap/);
  assert.match(compactSpaceNameRule, /-webkit-line-clamp:\s*unset/);
  assert.match(compactSpaceNameRule, /text-overflow:\s*ellipsis/, "the narrow Space label must truncate without colliding with navigation");
  assert.match(compactRailRule, /overflow:\s*hidden/, "the narrow rail must contain independent scroll regions");
  assert.match(compactNavRule, /flex:\s*1\s+1\s+auto/);
  assert.match(compactNavRule, /overflow-x:\s*auto/, "narrow primary destinations must scroll instead of colliding with tools");
  assert.match(compactAccountRule, /flex:\s*0\s+0\s+auto/, "Shortcuts and Settings must remain reachable while destinations scroll");
  const tooltipRule = cssRuleBody(shellCss, ".app-shell .professional-workspace-rail [data-rail-tooltip]::after");
  assert.match(tooltipRule, /content:\s*attr\(data-rail-tooltip\)/);
  assert.match(shellCss, /\[data-rail-tooltip\]:focus-visible::after/, "tooltips must work for sighted keyboard users");
  assert.match(spacesPaneRule, /scrollbar-gutter:\s*auto/, "the Spaces pane must not reserve a dead right-side gutter");
  assert.match(shellCss, /\.professional-workspace-rail \.workspace-rail-button svg,[\s\S]*?\{[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;/);
});

test("Space customization is visible, compact, and separate from structural chrome", () => {
  assert.match(workspaceChromeSource, /"workspace-banner-surface"/);
  assert.match(workspaceChromeSource, /"space-identity-header"/);
  assert.match(workspaceChromeSource, /workspace-pane-banner-image/);
  assert.match(workspaceChromeSource, /workspaceIdentityStyle\(workspaceIdentity\)/);
  assert.match(workspaceChromeSource, /<WorkspaceIconGlyph icon=\{workspaceIdentity\.Icon\}/);
  assert.match(workspaceChromeSource, /data-space-icon=\{workspaceIdentity\.iconName\}/);
  assert.match(workspaceChromeSource, /workspace-appearance-preview/);
  assert.match(workspaceChromeSource, /onResetWorkspace/);
  assert.match(customizationCss, /\.workspace-banner-surface\.banner-none/);

  const bannerHeaderRule = cssRuleBody(customizationCss, ".app-shell .workspace-layout .workspace-mode-pane .professional-pane-header.space-identity-header");
  const bannerTitleRule = cssRuleBody(customizationCss, ".app-shell .professional-pane-header.space-identity-header .workspace-pane-current-lockup strong");
  const previewTitleRule = cssRuleBody(customizationCss, ".workspace-appearance-preview-copy strong {");
  const railIconRule = cssRuleBody(customizationCss, ".app-shell .professional-workspace-rail .workspace-rail-space-avatar");
  const darkRailIconRule = cssRuleBody(customizationCss, ".app-shell[data-theme=\"dark\"] .professional-workspace-rail .workspace-rail-space-selector .workspace-rail-space-avatar");
  assert.match(bannerHeaderRule, /border:\s*1px\s+solid\s+var\(--ui-border\)/);
  assert.match(bannerTitleRule, /line-height:\s*1\.3/);
  assert.match(bannerTitleRule, /font-size:\s*var\(--workspace-identity-title-size\)/);
  assert.match(bannerTitleRule, /letter-spacing:\s*var\(--workspace-identity-tracking\)/, "the identity title should read as a deliberate display label without replacing the selected font");
  assert.match(previewTitleRule, /font-size:\s*var\(--workspace-identity-title-size\)/, "the appearance preview must match the live identity title scale");
  assert.match(previewTitleRule, /letter-spacing:\s*var\(--workspace-identity-tracking\)/);
  assert.match(bannerTitleRule, /padding-block:\s*2px/, "identity titles need descender-safe line boxes");
  for (const identityIconRule of [railIconRule, darkRailIconRule]) {
    assert.match(identityIconRule, /background:\s*transparent/, "identity glyphs must not sit on filled tiles");
  }
  assert.doesNotMatch(workspaceChromeSource, /space-identity-header-icon|workspace-appearance-preview-icon/);
  assert.doesNotMatch(customizationCss, /space-identity-header-icon|workspace-appearance-preview-icon/);
  assert.match(darkRailIconRule, /box-shadow:\s*none/, "legacy dark-theme decoration must not recreate an icon tile");
  assert.match(customizationCss, /\.professional-appearance-surface/);
  assert.match(customizationCss, /\.workspace-banner-position-control/);
  const colorPickerRule = cssRuleBody(customizationCss, ".app-shell .professional-appearance-surface .workspace-color-picker");
  const colorWheelRule = cssRuleBody(customizationCss, ".app-shell .professional-appearance-surface .workspace-color-wheel");
  const colorPairClearRule = cssRuleBody(legacyCss, ".workspace-color-pair-clear");
  assert.match(colorPickerRule, /min-height:\s*38px/);
  assert.match(colorPickerRule, /height:\s*auto/, "the custom color wheel must remain inside its control");
  assert.match(colorWheelRule, /width:\s*28px/);
  assert.match(colorPairClearRule, /padding:\s*0/, "the paired-color clear icon must not overflow its control group");
  assert.match(workspaceChromeSource, /onInput=[\s\S]*?aria-label="Choose second banner color"/);
  assert.match(customizationCss, /\.workspace-banner-surface\.banner-classic[\s\S]*?--workspace-banner-secondary-rgb/, "the second color must affect the default banner through its dedicated role");
  const activeRailMarkerRule = cssRuleBody(customizationCss, ".app-shell .professional-workspace-rail .workspace-rail-button.active::before");
  assert.match(activeRailMarkerRule, /background:\s*var\(--workspace-accent-indicator\)/, "the contrast-solved indicator role must drive the compact active pill");
  assert.doesNotMatch(activeRailMarkerRule, /box-shadow/, "the active pill must not resurrect the legacy full-row shadow");
  assert.match(customizationCss, /\.professional-spaces \.workspace-card-shell\.active[\s\S]*?background:\s*var\(--workspace-accent-soft-fill\)/);
  assert.match(customizationCss, /\.professional-chats \.chat-workspace-heading > span:first-child[\s\S]*?color:\s*var\(--workspace-accent-glyph\)/);
  assert.match(legacyCss, /\.message\.user\s*\{[\s\S]*?background:\s*var\(--workspace-accent-solid/, "user messages must use the resolved solid role");
  assert.match(legacyCss, /\.message\.user \.message-author\s*\{[\s\S]*?color:\s*var\(--workspace-on-accent-muted/, "muted author text must use its audited composite role");
  assert.match(workspaceIdentitySource, /"--workspace-selection-accent":\s*identity\.color/, "transitional aliases must preserve the v1 accent until their consumers are assigned roles");
  assert.match(workspaceIdentitySource, /"--workspace-selection-border":\s*identity\.borderColor/);
  assert.match(workspaceIdentitySource, /"--workspace-selection-surface":\s*identity\.softColor/);
  assert.doesNotMatch(workspaceIdentitySource, /"--workspace-banner-(?:primary|base)":/, "unused banner string tokens must not be injected at every identity scope");
  assert.match(workspaceChromeSource, /\(\["light", "dark"\] as const\)\.map/, "the editor must preview both modes together");
  assert.match(customizationCss, /\.app-shell \.workspace-appearance-preview\.preview-light\s*\{[\s\S]*?--workspace-banner-base-rgb:\s*255,\s*255,\s*255/, "the light preview must beat the surrounding app theme");
  assert.match(customizationCss, /\.app-shell \.workspace-appearance-preview\.preview-dark\s*\{[\s\S]*?--workspace-banner-base-rgb:\s*23,\s*26,\s*33/, "the dark preview must beat the surrounding app theme");
  assert.match(workspaceChromeSource, /parseSpaceAppearanceProposal/, "the editor must import the shared bounded proposal");
  assert.match(workspaceChromeSource, /createSpaceAppearanceProposal/, "the editor must export the shared bounded proposal");
  assert.doesNotMatch(
    appSource,
    /normalizeWorkspaceCustomizations\(customizationsRef\.current,\s*new Set\(workspaces/,
    "temporarily missing or moved Spaces must keep their identity until an explicit removal",
  );

  assert.match(foundationCss, /--workspace-ui-font:\s*var\(--workspace-font-family/);
  assert.match(rendererMainSource, /windowMaterial === "mica" \|\| windowMaterial === "vibrancy"[\s\S]*?dataset\.windowMaterial = windowMaterial/, "window material must be applied before React's first paint");
  assert.match(rendererMainSource, /delete document\.documentElement\.dataset\.windowMaterial/, "solid-material sessions must clear stale material state");
  assert.doesNotMatch(appSource, /dataset\.windowMaterial/, "window material must not wait for a passive React effect");
  assert.doesNotMatch(foundationCss, /--workspace-font-size:/, "the professional layer must not override the user's text-size preference");
  assert.doesNotMatch(desktopSettingsSource, /from\s+["']lucide-react["']/);
  assert.match(desktopSettingsSource, /from\s+["']@fluentui\/react-icons["']/);
});

test("the left header is inherited Space identity on every mode, not a surface title", () => {
  const headerCall = appSource.match(/<WorkspacePaneHeader[\s\S]*?\/>/)?.[0];
  assert.ok(headerCall, "App must render the shared Space identity header");
  const headerIdentityProps = headerCall.split(" action=")[0]!;
  assert.match(headerIdentityProps, /workspace=\{workspace\}/);
  assert.match(headerIdentityProps, /identity=\{identity\}/);
  assert.match(headerIdentityProps, /switchable=\{activeMode !== "workspaces"\}/);
  assert.doesNotMatch(headerIdentityProps, /title=|paneTitle|onCustomize/);

  assert.match(workspaceChromeSource, /<strong>\{workspace\.name\}<\/strong>/);
  assert.match(workspaceChromeSource, /<span className="sr-only">\{detail\}<\/span>/);
  assert.match(workspaceChromeSource, /className="workspace-pane-switch-trigger"/);
  assert.match(workspaceChromeSource, /aria-haspopup="menu"/);
  assert.match(workspaceChromeSource, /role="menu" aria-label="Switch Space"/);
  assert.match(workspaceChromeSource, /role="menuitem"/);
  assert.match(workspaceChromeSource, /querySelector<HTMLButtonElement>\('\[role="menuitem"\]:not\(:disabled\)'\)\?\.focus\(\)/);
  assert.doesNotMatch(workspaceChromeSource, /role=\{switcherEnabled \? "button" : undefined\}/);
  assert.doesNotMatch(workspaceChromeSource, /onClick=\{toggleSwitcher\}[\s\S]{0,180}<WorkspaceIconGlyph/);
  assert.doesNotMatch(workspaceChromeSource, /space-identity-header-icon/);
  assert.doesNotMatch(workspaceChromeSource, /space-identity-header-text/);
  assert.doesNotMatch(workspaceChromeSource, /Customize Space.*professional-header-action/s);
});

test("every left-pane mode keeps content padding below the shared Space banner", () => {
  const headerIndex = appSource.indexOf("<WorkspacePaneHeader");
  const filesContentIndex = appSource.indexOf('activeMode === "files" ? <div className="local-files-panel">');
  const localFilesRule = cssRuleBody(legacyCss, ".local-files-panel");

  assert.ok(headerIndex >= 0 && filesContentIndex > headerIndex, "the Files content wrapper must render below the shared header");
  assert.doesNotMatch(appSource, /activeMode === "files" \? "file-panel local-files-panel"/);
  assert.match(localFilesRule, /flex:\s*1 1 auto/);
  assert.match(localFilesRule, /padding:\s*12px/);
});

test("the appearance preview mirrors the Space header rather than the active surface", () => {
  assert.match(workspaceChromeSource, /workspace-appearance-preview-copy"><strong>\{workspace\.name\}<\/strong>/);
  assert.doesNotMatch(workspaceChromeSource, /workspace-appearance-preview-copy"><strong>Files<\/strong>/);
  assert.match(customizationCss, /\.workspace-appearance-preview\s*\{[\s\S]*?min-height:\s*90px;/);
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
