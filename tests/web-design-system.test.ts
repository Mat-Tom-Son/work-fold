import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
const postcss = createRequire(import.meta.url)("postcss");

const workFolderBannerPreviewSource = await readFile(join(process.cwd(), "web-local/src/components/chrome/WorkFolderBannerPreview.tsx"), "utf8");

const rendererRoot = join(process.cwd(), "web-local", "src");

const [
  appSource,
  rendererMainSource,
  workFolderChromeSource,
  workFolderPanesSource,
  workFolderIdentitySource,
  foundationCss,
  shellCss,
  legacyCss,
  surfacesCss,
  customizationCss,
  desktopSettingsSource,
  capabilitiesSource,
  surfaceTabsSource,
  chatPanelSource,
] = await Promise.all([
  readRenderer("App.tsx"),
  readRenderer("main.tsx"),
  readRenderer("components/panes/workFolderChrome.tsx"),
  readRenderer("components/panes/workFolderPanes.tsx"),
  readRenderer("lib/work-folder-identity.ts"),
  readRenderer("styles.css"),
  readRenderer("styles.css"),
  readRenderer("styles.css"),
  readRenderer("styles.css"),
  readRenderer("styles.css"),
  readRenderer("components/modals/DesktopSettingsModal.tsx"),
  readRenderer("components/panes/CapabilitiesPane.tsx"),
  readRenderer("hooks/useSurfaceTabs.ts"),
  readRenderer("components/chat/ChatPanel.tsx"),
]);

test("Files is the first primary surface and work-folder actions live in the persistent header menu", () => {
  const primaryItems = constArrayBody(workFolderChromeSource, "primaryItems");
  const primaryModes = [...primaryItems.matchAll(/mode:\s*"([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(primaryModes, ["files", "chats", "history"]);
  assert.doesNotMatch(primaryItems, /mode:\s*"work-folders"/);
  assert.doesNotMatch(primaryItems, /mode:\s*"library"/, "Library belongs in the work-folder-owned tab canvas, not the permanent rail");
  assert.doesNotMatch(primaryItems, /mode:\s*"capabilities"/, "infrequent tool administration must not occupy the primary rail");

  assert.doesNotMatch(workFolderChromeSource, /work-folder-rail-work-folder-selector|work-folder-rail-work-folder-copy/);
  assert.match(workFolderChromeSource, /primaryItems\.map/);
  assert.match(workFolderChromeSource, /<span>Use existing folder<\/span>/);
  assert.match(workFolderChromeSource, /<span>Create new work-folder<\/span>/);
  assert.match(workFolderChromeSource, /<span>Manage work-folders<\/span>/);
  assert.match(workFolderChromeSource, /aria-current=\{shownMode === item\.mode \? "page" : undefined\}/, "the active icon-only destination must be announced");
  assert.match(workFolderChromeSource, /aria-label=\{item\.ariaLabel\}/, "icon-only destinations need accessible names");
  assert.doesNotMatch(workFolderChromeSource, /<span>work-folder<\/span>|work-folder-rail-work-folder-caret/);
  assert.doesNotMatch(primaryItems, /ChevronRight20Regular/);
});

test("pane navigation uses Fluent icons with the requested Blocks icon for Skills & Extensions", () => {
  for (const [name, source] of [
    ["workFolderChrome.tsx", workFolderChromeSource],
    ["workFolderPanes.tsx", workFolderPanesSource],
  ] as const) {
    const navigationSource = name === "workFolderChrome.tsx" ? source.replace('import { Blocks } from "lucide-react";', "") : source;
    assert.doesNotMatch(navigationSource, /from\s+["']lucide-react["']/, `${name} must keep the Blocks exception limited to Skills & Extensions`);
    assert.match(source, /from\s+["']@fluentui\/react-icons["']/, `${name} must use Fluent icons`);
  }

  const requiredNavPairs = [
    "DocumentFolder24",
    "ChatMultiple24",
    "History24",
  ];
  for (const icon of requiredNavPairs) {
    assert.match(workFolderChromeSource, new RegExp(`\\b${icon}Regular\\b`), `${icon} needs a regular state`);
    assert.match(workFolderChromeSource, new RegExp(`\\b${icon}Filled\\b`), `${icon} needs a filled active state`);
  }

  assert.match(workFolderChromeSource, /professional-work-folder-rail/);
  assert.match(workFolderChromeSource, /<Blocks size=\{24\} strokeWidth=\{1\.5\} aria-hidden="true" \/>/);
  // The Add button opens the Skills & Extensions popup directly; there is no Add menu (2026-09-25).
  assert.match(workFolderChromeSource, /aria-label="Skills & Extensions"/);
  assert.match(workFolderChromeSource, /onClick=\{\(\) => onOpenSkillsExtensions\("installed"\)\}/);
  assert.doesNotMatch(workFolderChromeSource, /id="work-folder-add-menu"|chooseAddAction|onOpenLibrary|onOpenApps/);
  assert.doesNotMatch(workFolderChromeSource, /aria-label="agent"/);
  assert.doesNotMatch(workFolderChromeSource, /mode:\s*"setup"/);
  assert.doesNotMatch(workFolderChromeSource, /<Bot\w*[^>]*>.*agent/s);
});

test("the Library is retired from the desktop (2026-09-25)", () => {
  const primaryItems = constArrayBody(workFolderChromeSource, "primaryItems");
  assert.doesNotMatch(primaryItems, /mode:\s*"library"/);
  assert.doesNotMatch(workFolderChromeSource, /Your Library|onOpenLibrary/);
  assert.doesNotMatch(appSource, /LibraryPane|openLibrary\(|libraryTree|migrateLegacyLibraryMode/);
  assert.doesNotMatch(workFolderPanesSource, /export function LibraryPane|From Library/);
  assert.doesNotMatch(surfaceTabsSource, /migrateLegacyLibrary|"library"/);
});

test("Skills & Extensions opens as a popup from the Add button, and apps are managed in Settings", () => {
  const primaryItems = constArrayBody(workFolderChromeSource, "primaryItems");
  assert.doesNotMatch(primaryItems, /mode:\s*"capabilities"/);
  assert.doesNotMatch(primaryItems, /mode:\s*"skills"|mode:\s*"extensions"/);
  // The rail's Add button opens one popup: Skills & Extensions. Discovery and
  // management are the same place; apps are managed in Settings → Apps and
  // built by asking a Worker in a Chat, so nothing here seeds a Chat.
  assert.doesNotMatch(workFolderChromeSource, /Browse Skills &amp; Extensions|Manage agent tools|Build an app|Your Library|<strong>Apps<\/strong>/);
  assert.match(appSource, /skillsExtensionsView \? <SkillsExtensionsModal/);
  assert.match(appSource, /onOpenSkillsExtensions=\{setSkillsExtensionsView\}/);
  assert.doesNotMatch(appSource, /startAppBuildChat|onBuildApp=|<WorkFolderAppsPane|openWorkFolderAppsSurfaceTab|openAssistantToolsSurfaceTab/);
  assert.match(appSource, /run: \(\) => onOpenSettings\("apps"\)/);
  assert.match(chatPanelSource, /textarea\.setSelectionRange\(end, end\)/);
  assert.doesNotMatch(surfaceTabsSource, /"assistant-tools"|"work-folder-apps"|"library"/);
  assert.match(capabilitiesSource, /<h1>Skills &amp; Extensions<\/h1>/);
  // Where a tool lives is one explicit decision in the review step, shown as
  // the work-fold agent above folders hierarchy rather than a bare Personal/This folder toggle.
  assert.match(capabilitiesSource, /Where should it live\?/);
  assert.match(capabilitiesSource, /function ScopeHierarchyGlyph/);
  assert.match(capabilitiesSource, /"work-fold agent"[\s\S]*"Here"/);
  assert.match(capabilitiesSource, /"Everywhere"[\s\S]*This work-folder only/);
  assert.doesNotMatch(capabilitiesSource, /Personal · everywhere|"Personal"/);
  // Discover is text-only; installed rows use a neutral type glyph.
  assert.doesNotMatch(capabilitiesSource, /CapabilityMonogram|monogramHue|Bookmark16Regular/);
  assert.match(capabilitiesSource, /capabilities-kind-icon/);
  assert.match(capabilitiesSource, /label="View Source" icon=\{false\}/);
  assert.match(capabilitiesSource, /function GitHubMark/);
  assert.doesNotMatch(capabilitiesSource, />Review<\/button>|Install…/);
  assert.doesNotMatch(capabilitiesSource, /Installation location|Install to</);
  assert.match(appSource, /setSkillsExtensionsView\("installed"\)/);
  assert.doesNotMatch(appSource, /activeMode === "capabilities"[\s\S]*?<CapabilitiesPane/);
  assert.match(capabilitiesSource, /Installed[\s\S]*Discover/);
  assert.match(capabilitiesSource, /Search installed tools/);
  assert.match(capabilitiesSource, /Skills[\s\S]*Extensions/);
  assert.match(capabilitiesSource, /Everywhere[\s\S]*This work-folder only/);
  assert.match(capabilitiesSource, /capabilities\/details\?id=/);
  assert.match(capabilitiesSource, /capabilities\/install/);
  assert.match(capabilitiesSource, /capabilities-view-tabs[\s\S]*?view === "installed" \? \([\s\S]*?capabilities-installed-panel/);
  assert.match(capabilitiesSource, /view === "installed" \? \([\s\S]*?capabilities-installed-panel[\s\S]*?: \([\s\S]*?capabilities-discover-panel/);
  assert.match(capabilitiesSource, /addOpen \? \([\s\S]*?<AddCapabilityDialog/);
  assert.doesNotMatch(capabilitiesSource, /<section className="professional-card capabilities-add-panel"/);
  assert.match(capabilitiesSource, /<CoreToolsSection tools=\{catalog\.tools\} management=\{catalog\.toolManagement\}/);
  assert.match(capabilitiesSource, /tool\.core === true \|\| tool\.kind === "core"/);
  assert.match(capabilitiesSource, /On in new Chats/);
  assert.match(capabilitiesSource, /Available to Chats/);
  assert.match(capabilitiesSource, /On in new Chats[\s\S]*Available to Chats/);
  assert.doesNotMatch(capabilitiesSource, /active\s*·[\s\S]*available tools/i);
  assert.match(capabilitiesSource, /setTypeFilter\("all"\);[\s\S]*selectView\("installed"\)/);
  // Installed tools are grouped by where they live instead of filtered by a
  // scope dropdown; Everywhere comes first because it reaches the most.
  assert.match(capabilitiesSource, /<IncludedToolsStrip[\s\S]*<ScopeGroup[\s\S]*scope="global"[\s\S]*<ScopeGroup[\s\S]*scope="project"/);
  assert.match(capabilitiesSource, /Included with work-fold/);
  assert.match(capabilitiesSource, /capabilities-scope-columns/);
  assert.doesNotMatch(capabilitiesSource, /All scopes|installedSort|Add to this folder|Add for everywhere/);
  // Sandboxed apps are a different lane with their own authority model: they
  // live in the work-folder-owned Apps tab, never inside Skills & Extensions.
  assert.doesNotMatch(capabilitiesSource, /RestrictedAppsSection|restrictedApps|"Apps"/);
  assert.match(appSource, /id: "go:work-folder-apps"/);
  // Catalog listings keep provenance readable in text, including its limit.
  assert.doesNotMatch(capabilitiesSource, /capabilities-external-host|"GitHub"|capabilities-official-badge/);
  assert.match(capabilitiesSource, /safety-reviewed\."\>First-party \/ reference</);
  assert.match(capabilitiesSource, /ArrowRight[\s\S]*ArrowLeft[\s\S]*Home[\s\S]*End/);
  assert.doesNotMatch(capabilitiesSource, /from\s+["']lucide-react["']/);

  for (const className of [
    "capabilities-pane",
    "skills-extensions-pane",
    "skills-extensions-header",
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
    "capabilities-panel",
    "capabilities-scope-group",
  ]) {
    assert.equal(hasClassSelector(surfacesCss, className), true, `Capabilities class .${className} must be styled`);
  }
  for (const className of [...staticClassTokens(capabilitiesSource)].filter((name) => /^capabilit(?:y|ies)-/.test(name))) {
    assert.equal(hasClassSelector(surfacesCss, className), true, `Static Capabilities class .${className} must be styled`);
  }
  assert.match(surfacesCss, /\.skills-extensions-modal\s*\{[^}]*container-name: skills-and-extensions;[^}]*container-type: inline-size/);
  assert.match(surfacesCss, /@container skills-and-extensions \(max-width: 540px\)[\s\S]*?\.capabilities-discover-card/);
  assert.match(surfacesCss, /@media \(max-width: 600px\)[\s\S]*?\.capability-dialog/);
});

test("agent configuration lives in Settings instead of the rail", () => {
  assert.match(desktopSettingsSource, /id:\s*"ai-models"[\s\S]*?label:\s*"AI Models"/);
  assert.match(desktopSettingsSource, /<AiModelsPane[\s\S]*?embedded/);
  assert.match(appSource, /openSettings\("ai-models", scope, true\)/);
  assert.match(appSource, /onOpenSettings\("ai-models", "work-folder", true, targetWorkFolder\.id\)/);
  assert.doesNotMatch(appSource, /activeMode\s*===\s*"setup"/);
  assert.doesNotMatch(workFolderChromeSource, /agent ·/);
});

test("work-folder identity and typography keep the restrained defaults", () => {
  const defaultIconBody = functionBody(workFolderIdentitySource, "defaultWorkFolderIconName");
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
  const lightBlock = cssRuleBody(foundationCss, ":root");
  const darkBlock = cssRuleBody(foundationCss, ':root[data-theme="dark"]');
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
    "ai-models-settings-section",
    "ai-models-scope-control",
    "ai-models-refresh",
    "ai-models-form-fields",
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
    "chat-work-folder-heading",
    "professional-surface",
    "professional-card",
    "ui-control",
    "professional-field",
    "professional-notice",
    "professional-install-panel",
    "professional-card-grid",
    "professional-empty-state",
  ];
  const staticClasses = staticClassTokens(workFolderPanesSource);
  const combinedCss = stripCssComments(`${legacyCss}\n${surfacesCss}`);
  const usedP0Classes = p0Classes.filter((className) => staticClasses.has(className));
  const missingSelectors = usedP0Classes.filter((className) => !hasClassSelector(combinedCss, className));

  assert.ok(usedP0Classes.length > 0, "the P0 contract must cover classes used by spacePanes");
  assert.deepEqual(missingSelectors, [], `P0 classes without CSS selectors: ${missingSelectors.join(", ")}`);
});

test("professional shell keeps compact navigation and the persistent work-folder identity header", () => {
  const layoutRule = cssRuleBody(shellCss, ".app-shell .work-folder-layout");
  const modePaneRule = cssRuleBody(shellCss, ".app-shell .work-folder-mode-pane");
  const railRule = cssRuleBody(shellCss, ".app-shell .professional-work-folder-rail");
  const navButtonRule = cssRuleBody(shellCss, ".app-shell .professional-work-folder-rail .work-folder-rail-button");
  const compactShellCss = shellCss.slice(shellCss.indexOf("@media (max-width: 820px)"));
  const compactRailRule = cssRuleBody(compactShellCss, ".app-shell .professional-work-folder-rail");
  const compactNavRule = cssRuleBody(compactShellCss, ".app-shell .professional-work-folder-rail .work-folder-rail-nav");
  const compactAccountRule = cssRuleBody(compactShellCss, ".app-shell .professional-work-folder-rail .work-folder-rail-account");
  const shortDesktopShellCss = shellCss.slice(shellCss.indexOf("@media (max-height: 720px)"));
  const shortDesktopRailRule = cssRuleBody(shortDesktopShellCss, ".app-shell .professional-work-folder-rail");
  const paneHeaderRule = cssRuleBody(shellCss, ".app-shell .work-folder-layout .work-folder-mode-pane .professional-pane-header");
  const workFoldersPaneRule = cssRuleBody(surfacesCss, ".work-folder-pane-content.professional-work-folders");

  assert.match(modePaneRule, /border:\s*0/);
  assert.match(railRule, /border:\s*0/);
  assert.match(paneHeaderRule, /border:\s*0/);
  assert.match(paneHeaderRule, /background:\s*var\(--ui-surface\)/);
  for (const structuralRule of [modePaneRule, railRule, paneHeaderRule]) {
    assert.doesNotMatch(structuralRule, /--work-folder-(?:selection|custom)-/, "structural borders must stay independent of work-folder accent colors");
  }

  assert.ok(maxPxValue(customPropertyValue(layoutRule, "--work-folder-rail-width")) <= 180, "desktop rail must remain compact");
  assert.equal(maxPxValue(customPropertyValue(layoutRule, "--work-folder-identity-header-height")), 112, "the work-folder banner retains the approved personality and geometry");
  assert.ok(pxDeclaration(navButtonRule, "min-height") <= 48, "primary navigation targets must stay compact");
  assert.equal(pxDeclaration(navButtonRule, "width"), pxDeclaration(navButtonRule, "min-height"), "primary navigation uses square icon-only targets");
  assert.match(shellCss, /\.professional-work-folder-rail \.work-folder-rail-label\s*\{[\s\S]*?display:\s*none/, "the desktop rail is icon-only; labels live in tooltips and accessible names");
  assert.match(compactShellCss, /\.work-folder-rail-label\s*\{[\s\S]*?display:\s*block/, "the narrow horizontal rail restores text labels");
  assert.doesNotMatch(`${shellCss}\n${customizationCss}`, /work-folder-rail-work-folder-selector|work-folder-rail-work-folder-copy|work-folder-rail-work-folder-avatar/);
  assert.match(layoutRule, /--work-folder-identity-title-size:\s*17px/);
  assert.match(layoutRule, /--work-folder-identity-tracking:\s*0\.01em/);
  assert.match(shortDesktopRailRule, /padding:\s*8px\s+6px\s+6px/, "short desktop layouts must keep navigation compact");
  assert.match(compactRailRule, /overflow:\s*hidden/, "the narrow rail must contain independent scroll regions");
  assert.match(compactNavRule, /flex:\s*1\s+1\s+auto/);
  assert.match(compactNavRule, /overflow-x:\s*auto/, "narrow primary destinations must scroll instead of colliding with tools");
  assert.match(compactAccountRule, /flex:\s*0\s+0\s+auto/, "Shortcuts and Settings must remain reachable while destinations scroll");
  assert.doesNotMatch(shellCss, /data-rail-tooltip/, "icon controls use accessible names without persistent hover labels");
  assert.match(workFoldersPaneRule, /scrollbar-gutter:\s*auto/, "the work-folders pane must not reserve a dead right-side gutter");
  assert.match(shellCss, /\.professional-work-folder-rail \.work-folder-rail-button svg,[\s\S]*?\{[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;/);
});

test("work-folder customization is visible, compact, and separate from structural chrome", () => {
  assert.match(workFolderChromeSource, /"work-folder-banner-surface"/);
  assert.match(workFolderChromeSource, /"work-folder-identity-header"/);
  assert.match(workFolderChromeSource, /work-folder-pane-banner-image/);
  assert.match(workFolderChromeSource, /workFolderIdentityStyle\(itemIdentity\)/);
  assert.match(workFolderChromeSource, /<WorkFolderIconGlyph icon=\{itemIdentity\.Icon\}/);
  assert.match(workFolderChromeSource, /data-work-folder-icon=\{itemIdentity\.iconName\}/);
  assert.match(workFolderChromeSource, /<WorkFolderBannerPreview/);
  assert.match(workFolderChromeSource, /aria-label="work-folder color presets"/);
  assert.doesNotMatch(workFolderChromeSource, /workFolderLookOptions|work-folder color pairs/);
  assert.match(workFolderChromeSource, /function WorkFolderNameEditor/);
  assert.match(workFolderChromeSource, /<span>work-folder name<\/span>/);
  assert.match(workFolderChromeSource, /finally\s*\{\s*setSaving\(false\);\s*\}/);
  assert.doesNotMatch(workFolderChromeSource, /Fine tune|Saved on this computer|Start with a balanced color pair|Shown in the work-folder menu and tabs/);
  assert.match(workFolderChromeSource, /const workFolderIconPageSize = 96/);
  assert.match(workFolderChromeSource, /className="work-folder-icon-browser"/);
  assert.match(workFolderChromeSource, /aria-label="Previous icon page"/);
  assert.match(workFolderChromeSource, /aria-label="Next icon page"/);
  assert.match(workFolderChromeSource, /\}, \[workFolderId, identity\.iconName\]\);/);
  assert.doesNotMatch(workFolderChromeSource, /Browse all|Show recommended|\$\{workFolderIconOptions\.length\}/);
  assert.match(workFolderChromeSource, /onResetWorkFolder/);
  assert.match(customizationCss, /\.work-folder-banner-surface\.banner-none/);

  const bannerHeaderRule = cssRuleBody(customizationCss, ".app-shell .work-folder-layout .work-folder-mode-pane .professional-pane-header.work-folder-identity-header");
  const bannerTitleRule = cssRuleBody(customizationCss, ".app-shell .professional-pane-header.work-folder-identity-header .work-folder-pane-current-lockup strong");
  const previewTitleRule = cssRuleBody(customizationCss, ".work-folder-appearance-preview-copy strong {");
  assert.doesNotMatch(bannerHeaderRule, /border:\s*1px/, "banner artwork has no decorative frame");
  assert.match(bannerTitleRule, /line-height:\s*1\.3/);
  assert.match(bannerTitleRule, /font-size:\s*var\(--work-folder-identity-title-size\)/);
  assert.match(bannerTitleRule, /letter-spacing:\s*var\(--work-folder-identity-tracking\)/, "the identity title should read as a deliberate display label without replacing the selected font");
  assert.match(previewTitleRule, /font-size:\s*var\(--work-folder-identity-title-size\)/, "the appearance preview must match the live identity title scale");
  assert.match(previewTitleRule, /letter-spacing:\s*var\(--work-folder-identity-tracking\)/);
  assert.match(bannerTitleRule, /padding-block:\s*2px/, "identity titles need descender-safe line boxes");
  assert.doesNotMatch(workFolderChromeSource, /work-folder-identity-header-icon|work-folder-appearance-preview-icon/);
  assert.doesNotMatch(customizationCss, /work-folder-identity-header-icon|work-folder-appearance-preview-icon/);
  assert.match(customizationCss, /\.professional-work-folder-switcher \.work-folder-header-switcher-icon[\s\S]*?color:\s*var\(--work-folder-accent-glyph\)/);
  assert.match(customizationCss, /\.professional-appearance-surface/);
  assert.match(workFolderBannerPreviewSource, /bannerFraming/, "image framing remains part of the real banner preview");
  const colorPickerRule = cssRuleBody(customizationCss, ".app-shell .professional-appearance-surface .work-folder-color-picker");
  const colorWheelRule = cssRuleBody(customizationCss, ".app-shell .professional-appearance-surface .work-folder-color-wheel");
  const colorPairClearRule = cssRuleBody(legacyCss, ".work-folder-color-pair-clear");
  assert.match(colorPickerRule, /min-height:\s*38px/);
  assert.match(colorPickerRule, /height:\s*auto/, "the custom color wheel must remain inside its control");
  assert.match(colorWheelRule, /width:\s*28px/);
  assert.match(colorPairClearRule, /padding:\s*0/, "the paired-color clear icon must not overflow its control group");
  assert.match(workFolderChromeSource, /onInput=[\s\S]*?aria-label="Choose second banner color"/);
  assert.match(customizationCss, /\.work-folder-banner-surface\.banner-classic[\s\S]*?--work-folder-banner-secondary-rgb/, "the second color must affect the default banner through its dedicated role");
  const activeRailMarkerRule = cssRuleBody(customizationCss, ".app-shell .professional-work-folder-rail .work-folder-rail-button.active::before");
  assert.match(activeRailMarkerRule, /background:\s*var\(--work-folder-accent-indicator(?:,|\))/, "the contrast-solved indicator role must drive the compact active pill");
  assert.doesNotMatch(activeRailMarkerRule, /box-shadow/, "the active pill must not resurrect the legacy full-row shadow");
  assert.match(customizationCss, /\.professional-work-folders \.work-folder-card-shell\.active[\s\S]*?background:\s*var\(--work-folder-accent-soft-fill\)/);
  assert.match(customizationCss, /\.professional-chats \.chat-work-folder-heading > span:first-child[\s\S]*?color:\s*var\(--work-folder-accent-glyph\)/);
  assert.match(legacyCss, /\.message\.user \.message-surface/, "the user bubble keeps its semantic style owner");
  assert.match(legacyCss, /\.message-time\s*\{[\s\S]*?color:\s*var\(--ui-text-muted\)/, "message footer metadata uses the neutral appearance role");
  assert.match(workFolderIdentitySource, /"--work-folder-selection-accent":\s*identity\.color/, "transitional aliases must preserve the v1 accent until their consumers are assigned roles");
  assert.match(workFolderIdentitySource, /"--work-folder-selection-border":\s*identity\.borderColor/);
  assert.match(workFolderIdentitySource, /"--work-folder-selection-surface":\s*identity\.softColor/);
  assert.doesNotMatch(workFolderIdentitySource, /"--work-folder-banner-(?:primary|base)":/, "unused banner string tokens must not be injected at every identity scope");
  assert.match(workFolderBannerPreviewSource, /\(\["light", "dark"\] as const\)\.map/, "the editor must preview both modes together");
  assert.match(customizationCss, /\.app-shell \.work-folder-appearance-preview\.preview-light\s*\{[\s\S]*?--work-folder-banner-base-rgb:\s*255,\s*255,\s*255/, "the light preview must beat the surrounding app theme");
  assert.match(customizationCss, /\.app-shell \.work-folder-appearance-preview\.preview-dark\s*\{[\s\S]*?--work-folder-banner-base-rgb:\s*23,\s*26,\s*33/, "the dark preview must beat the surrounding app theme");
  assert.match(workFolderChromeSource, /parseWorkFolderAppearanceProposal/, "the editor must import the shared bounded proposal");
  assert.match(workFolderChromeSource, /createWorkFolderAppearanceProposal/, "the editor must export the shared bounded proposal");
  assert.doesNotMatch(
    appSource,
    /normalizeWorkFolderCustomizations\(customizationsRef\.current,\s*new Set\(work-folders/,
    "temporarily missing or moved work-folders must keep their identity until an explicit removal",
  );

  assert.match(foundationCss, /--work-fold-ui-font:\s*var\(--work-fold-font-family/);
  assert.match(rendererMainSource, /windowMaterial === "mica" \|\| windowMaterial === "vibrancy"[\s\S]*?dataset\.windowMaterial = windowMaterial/, "window material must be applied before React's first paint");
  assert.match(rendererMainSource, /delete document\.documentElement\.dataset\.windowMaterial/, "solid-material sessions must clear stale material state");
  assert.doesNotMatch(appSource, /dataset\.windowMaterial/, "window material must not wait for a passive React effect");
  assert.match(foundationCss, /--work-fold-font-size:\s*15px/, "the canonical sheet supplies a fallback; the appearance resolver owns the selected size");
  assert.match(foundationCss, /\.composer textarea:focus-visible\s*\{[\s\S]*?outline:\s*0/, "the work-folder-colored composer shell must own the visible focus treatment");
  const settingsIconsSource = desktopSettingsSource.replace('import { LayoutPanelLeft } from "lucide-react";', "");
  assert.doesNotMatch(settingsIconsSource, /from\s+["']lucide-react["']/, "Settings keeps its icon exceptions limited to the requested controls");
  assert.match(desktopSettingsSource, /id: "apps", label: "Apps", icon: <LayoutPanelLeft size=\{20\} strokeWidth=\{1\.5\} aria-hidden="true" \/>/);
  assert.match(desktopSettingsSource, /id: "web-access", label: "Web Access", icon: <GlobeCode size=\{20\} strokeWidth=\{1\.5\} aria-hidden="true" \/>/);
  assert.match(desktopSettingsSource, /from\s+["']@fluentui\/react-icons["']/);
});

test("Manage work-folders is a compact launcher into customization", () => {
  assert.doesNotMatch(workFolderPanesSource, /Where does this work live\?|Use an existing folder or create a clean one|professional-work-folder-intro/);
  assert.doesNotMatch(workFolderPanesSource, /Turn it into a work-folder|Start with a clean folder|professional-work-folder-action-copy/);
  assert.match(workFolderPanesSource, /className="professional-work-folder-actions" aria-label="Add a work-folder"/);
  const actionRule = cssRuleBody(surfacesCss, ".professional-work-folder-actions");
  assert.match(actionRule, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(surfacesCss.slice(surfacesCss.indexOf("@container space-pane (max-width: 520px)")), /\.professional-work-folder-actions,[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(workFolderPanesSource, /onClick=\{\(\) => onCustomize\(item\)\}/);
  assert.doesNotMatch(appSource, /current === "work-folders" \? "files" : current/);
  assert.doesNotMatch(workFolderPanesSource, /work-folder-card-rename|work-folder-card-customize/);
  assert.match(workFolderPanesSource, /work-folder-card-delete/);
  assert.match(workFolderPanesSource, /const deletesFolder = item\.location\.storage === "managed"/);
  assert.match(workFolderPanesSource, /aria-label=\{`\$\{deletesFolder \? "Delete" : "Remove"\} \$\{item\.name\}`\}/);
  assert.doesNotMatch(workFolderPanesSource, /"Managed folder"|"Linked folder"/);
  assert.match(workFolderPanesSource, /const location = item\.location\.storage === "managed" \? "" : shortFolderLocation\(item\.workFolderRoot\);/);
  assert.match(workFolderPanesSource, /<span title=\{item\.workFolderRoot \|\| undefined\}>/);
  assert.match(surfacesCss, /\.app-shell \.professional-work-folders \.work-folder-card-actions \.work-folder-card-delete\s*\{[^}]*color:\s*var\(--ui-text-muted\)/);
  assert.doesNotMatch(legacyCss, /\.work-folder-card-actions\s*\{[^}]*linear-gradient/s);
  assert.match(surfacesCss, /\.professional-work-folders \.work-folder-card-main\s*\{[^}]*padding-right:\s*52px/);
  assert.doesNotMatch(appSource, /Give this work-folder a recognizable identity|<h2>Customize \{targetWorkFolder\.name\}<\/h2>/);
});

test("the left header is inherited work-folder identity on every mode, not a surface title", () => {
  const headerCall = appSource.match(/<WorkFolderPaneHeader[\s\S]*?\/>/)?.[0];
  assert.ok(headerCall, "App must render the shared work-folder identity header");
  const headerIdentityProps = headerCall.split(" action=")[0]!;
  assert.match(headerIdentityProps, /workFolder=\{workFolder\}/);
  assert.match(headerIdentityProps, /identity=\{identity\}/);
  assert.doesNotMatch(headerIdentityProps, /switchable=/, "the work-folder menu must remain available on management and custom surfaces");
  assert.doesNotMatch(headerIdentityProps, /title=|paneTitle|onCustomize/);

  assert.match(workFolderChromeSource, /<strong>\{workFolder\.name\}<\/strong>/);
  assert.match(workFolderChromeSource, /<span className="sr-only">\{detail\}<\/span>/);
  assert.match(workFolderChromeSource, /className="work-folder-pane-switch-trigger"/);
  assert.match(workFolderChromeSource, /aria-haspopup="menu"/);
  assert.match(workFolderChromeSource, /role="menu" aria-label="work-folder menu"/);
  assert.match(workFolderChromeSource, /role="menuitem"/);
  assert.match(workFolderChromeSource, /data-native-view-occluder="true"/);
  assert.match(workFolderChromeSource, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(workFolderChromeSource, /querySelector<HTMLButtonElement>\('\[role="menuitem"\]'\)\?\.focus\(\)/);
  assert.doesNotMatch(workFolderChromeSource, /role=\{switcherEnabled \? "button" : undefined\}/);
  assert.doesNotMatch(workFolderChromeSource, /onClick=\{toggleSwitcher\}[\s\S]{0,180}<WorkFolderIconGlyph/);
  assert.doesNotMatch(workFolderChromeSource, /work-folder-identity-header-icon/);
  assert.doesNotMatch(workFolderChromeSource, /work-folder-identity-header-text/);
  assert.doesNotMatch(workFolderChromeSource, /Customize work-folder.*professional-header-action/s);
});

test("every left-pane mode keeps content padding below the shared work-folder banner", () => {
  const headerIndex = appSource.indexOf("<WorkFolderPaneHeader");
  const filesContentIndex = appSource.indexOf('activeMode === "files" ? <div className="local-files-panel">');
  const localFilesRule = cssRuleBody(legacyCss, ".local-files-panel");

  assert.ok(headerIndex >= 0 && filesContentIndex > headerIndex, "the Files content wrapper must render below the shared header");
  assert.doesNotMatch(appSource, /activeMode === "files" \? "file-panel local-files-panel"/);
  assert.match(localFilesRule, /flex:\s*1 1 auto/);
  assert.match(localFilesRule, /padding:\s*12px/);
});

test("the appearance preview mirrors the work-folder header rather than the active surface", () => {
  assert.match(workFolderBannerPreviewSource, /work-folder-appearance-preview-copy"><strong>\{name\}<\/strong>/);
  assert.doesNotMatch(workFolderChromeSource, /work-folder-appearance-preview-copy"><strong>Files<\/strong>/);
  assert.match(customizationCss, /\.work-folder-appearance-preview\s*\{[\s\S]*?min-height:\s*112px;/);
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
  const target = selector.replace(/\s*\{$/, "");
  const bodies: string[] = [];
  postcss.parse(css).walkRules((rule: { selector: string; nodes: Array<{ type: string; toString(): string }> }) => {
    if (postcss.list.comma(rule.selector).some((s: string) => s === target || (target !== ":root" && s.endsWith(" " + target)))) bodies.push(rule.nodes.filter((n) => n.type === "decl").map((n) => n.toString() + ";").join("\n"));
  });
  assert.ok(bodies.length, `could not find CSS selector: ${target}`);
  return bodies.reverse().join("\n");
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
