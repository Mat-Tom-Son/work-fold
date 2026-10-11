import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { nextDialogTabIndex } from "../web-local/src/hooks/useModalDialog.js";
import { resolveMessageImageSource } from "../web-local/src/lib/message-images.js";
import { nextMenuItemIndex } from "../web-local/src/lib/menu-navigation.js";
import { createWorkFolderOperationGate } from "../web-local/src/lib/work-folder-operation-gate.js";
import { fileSharing } from "../web-local/src/ui-contract.js";

const root = process.cwd();
const [capabilities, textInputModal, messages, tabBar, workFolderChrome, indexHtml, app, _retiredNeedsYou, workFolderPanes, ...desktopDialogs] = await Promise.all([
  read("web-local/src/components/panes/CapabilitiesPane.tsx"),
  read("web-local/src/components/modals/TextInputModal.tsx"),
  read("web-local/src/components/chat/messages.tsx"),
  read("web-local/src/components/chat/WorkFolderSurfaceTabBar.tsx"),
  read("web-local/src/components/panes/workFolderChrome.tsx"),
  read("web-local/index.html"),
  read("web-local/src/App.tsx"),
  Promise.resolve(""),
  read("web-local/src/components/panes/workFolderPanes.tsx"),
  read("web-local/src/components/modals/DesktopSettingsModal.tsx"),
  read("web-local/src/components/modals/CreateWorkFolderModal.tsx"),
  read("web-local/src/components/modals/FileVersionHistoryModal.tsx"),
  read("web-local/src/components/modals/CommandPaletteHost.tsx"),
]);

test("modal focus wrapping handles both boundaries and an escaped focus target", () => {
  assert.equal(nextDialogTabIndex(0, 3, true), 2);
  assert.equal(nextDialogTabIndex(2, 3, false), 0);
  assert.equal(nextDialogTabIndex(1, 3, false), null);
  assert.equal(nextDialogTabIndex(-1, 3, false), 0);
  assert.equal(nextDialogTabIndex(-1, 3, true), 2);
  assert.equal(nextDialogTabIndex(-1, 0, false), null);
});

// What the shared dialog contract actually does — focus entry and containment,
// Tab wrapping, Escape handling, background isolation, and focus restoration —
// is asserted against a real DOM in renderer-modal-dialog.test.ts. Matching the
// hook's source here would pass whether or not that behaviour survives.
test("in-tree dialogs are wired to the shared dialog contract", () => {
  assert.equal((capabilities.match(/useModalDialog\(\{/g) ?? []).length, 3);
  assert.equal((capabilities.match(/ref=\{dialogRef\}\s+tabIndex=\{-1\}/g) ?? []).length, 3);
  assert.match(capabilities, /initialFocusRef:\s*cancelRef/);
  assert.match(textInputModal, /useModalDialog\(\{\s*onClose,\s*blocked:\s*saving,\s*initialFocusRef:\s*inputRef\s*\}\)/);
  assert.match(textInputModal, /ref=\{dialogRef\}\s+tabIndex=\{-1\}/);
  for (const dialog of desktopDialogs) {
    assert.match(dialog, /useModalDialog\(\{/);
    assert.match(dialog, /ref=\{dialogRef\}\s+tabIndex=\{-1\}/);
  }
});

test("Settings preserves save feedback and explicit remote setup", async () => {
  const settings = desktopDialogs[0] ?? "";
  // Credential visibility, removal, saves and stale responses are exercised
  // against the real form in ai-models-settings-ui.test.ts.
  const appearance = await read("web-local/src/components/modals/AppearanceSettingsPane.tsx");
  assert.match(appearance, /role="alert">\{appearance\.error\}/);
  assert.doesNotMatch(appearance, /appearance-settings-status-row|appearance\.notice/);
  assert.match(settings, /settings-close-button/);
  assert.match(settings, /setCloseToTrayNotice\("Saved"\)/);
  assert.match(settings, /Private address created/);
  assert.match(settings, /!remoteSettingsChanged/);
});

test("Settings keeps older page ids landing on the tab that now holds their content", async () => {
  const { createRequire, registerHooks } = await import("node:module");
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const assets = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:settings-page-icons", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:settings-page-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      if (/\.(css|png|svg)(?:\?|$)/.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
      return next(url, context);
    },
  });
  const { settingsTabForPage } = await import("../web-local/src/components/modals/DesktopSettingsModal.js");
  assets.deregister();
  assert.equal(settingsTabForPage("desktop"), "automations");
  assert.equal(settingsTabForPage("general"), "automations");
  assert.equal(settingsTabForPage("desktop", "automations"), "automations");
  assert.equal(settingsTabForPage("desktop", "limits"), "automations");
  assert.equal(settingsTabForPage("desktop", "deleted"), "recently-deleted");
  assert.equal(settingsTabForPage("general", "deleted"), "recently-deleted");
  assert.equal(settingsTabForPage("remote"), "web-access");
  for (const page of ["appearance", "ai-models", "web-access", "shared-pages", "automations", "recently-deleted", "shortcuts", "about"] as const) {
    assert.equal(settingsTabForPage(page), page);
  }
  const settings = desktopDialogs[0] ?? "";
  assert.doesNotMatch(settings, /label: "Desktop"/);
  assert.match(settings, /<AutomationsPane \/>\s*<WorkFoldLimitsPane onOpenRecentlyDeleted=\{\(\) => setPage\("recently-deleted"\)\} \/>/);
  assert.match(settings, /interfaceExtra=\{closeWindowControl\}/);
});

test("no surface offers an authority mode, a policy, or a decision card", () => {
  // docs/receipts-not-gates.md, F19/F24: the Settings → Automations pane has no
  // Authority selector and no Standing policies section; the main window has
  // no needs-you rail control; questions live inside their owning Chat.
  const settings = desktopDialogs[0] ?? "";
  assert.doesNotMatch(settings, /fold-authority|fold-policies|FoldAuthorityPane|FoldPoliciesPane|PolicyMatcherFields|"authority"/);
  assert.match(settings, /remoteAccessSettings\.pairedBrowserTrust/);
  assert.doesNotMatch(app, /NeedsYouRailControl|useNeedsYouDecisions|needsYouControl|\/api\/work-fold-agent\/decisions/);
  assert.match(app, /accountControl=\{<button className="work-folder-rail-account-button"/);
});

test("the publications Settings section reveals links transiently and changes budgets in place", () => {
  // Settings → Shared pages (docs/shared-pages.md, plan item 5; amended
  // 2026-09-24): the share link is composed on demand from the reveal route
  // plus the viewer origin, held only in pane state, and never persisted.
  // Stop sharing keeps its confirm; one Budgets control narrows or widens in
  // place and a Sleep copy toggle turns the relay copy on or off, each a
  // receipted act over the renderer session.
  const settings = desktopDialogs[0] ?? "";
  // The reveal composes origin + path + fragment key transiently in state.
  assert.match(settings, /setRevealed\(\{ publicationId: publication\.publicationId, link: `\$\{viewerOrigin\}\$\{response\.viewerPath\}#\$\{response\.key\}` \}\)/);
  // No address, no reveal: the control is disabled until Remote access exists.
  assert.match(settings, /disabled=\{Boolean\(busy\) \|\| !viewerOrigin\}/);
  // Stop sharing takes the contract confirm and drops any revealed link.
  assert.match(settings, /window\.confirm\(publicationsSettings\.stopSharingConfirm\)/);
  assert.match(settings, /setRevealed\(\(current\) => \(current\?\.publicationId === publication\.publicationId \? null : current\)\)/);
  // Budgets: inputs clamp at the publication ceilings, and one Save sends a
  // lower value to narrow and a higher one to widen.
  assert.match(settings, /max=\{pageServeRateMaximum\}/);
  assert.match(settings, /max=\{pageByteBudgetMaximumMiB\}/);
  assert.match(settings, /\/narrow`, \{ method: "POST", body: lower \}/);
  assert.match(settings, /\/widen`, \{ method: "POST", body: higher \}/);
  assert.doesNotMatch(settings, /narrowHint|Tighten budgets/);
  // Sleep copy: on widens with snapshotEnabled, off is the narrowing verb.
  assert.match(settings, /role="switch"/);
  assert.match(settings, /enabled \? \{ snapshotEnabled: true \} : \{\}/);
  assert.match(settings, /\/snapshot-off`/);
  // The retention disclosure rides on the Sleep copy label's tooltip, not a
  // visible sentence.
  assert.match(settings, /<label className="publication-sleep-copy" title=\{publicationsSettings\.snapshotLabel\}>/);
  assert.doesNotMatch(settings, /fold-publication-snapshot-label/);
  // Budgets are one compact row of their own, not the address form's grid.
  assert.match(settings, /<div className="publication-budgets">/);
  // One quiet state word per row, the precise reason in the tooltip only —
  // the old visible problem line is gone.
  assert.match(settings, /const health = sharedPageHealth\(publication, connection\);/);
  assert.match(settings, /title=\{health\.reason\}/);
  assert.match(settings, /publicationsSettings\.states\[health\.state\]/);
  assert.doesNotMatch(settings, /Not reaching viewers|lastProblem\.reason/);
  // Empty states: web access first (switching the tab), then a file's tab.
  assert.match(settings, /publicationsSettings\.emptyNoAddress[\s\S]{0,200}onClick=\{onOpenWebAccess\}/);
  assert.match(settings, /onOpenWebAccess=\{\(\) => setPage\("web-access"\)\}/);
  // The preview renders sample pages for every state.
  assert.match(settings, /buildFixturePublications\(\)/);
  // Hosted-app rows (kind "app") render the exposure's pinned identities —
  // App Instance id, short Release digest, viewer entry, the complete
  // viewer-readable surface — never the page-only relativePath line.
  assert.match(settings, /publication\.kind === "app" && publication\.app/);
  assert.match(settings, /App Instance \{publication\.app\.appInstanceId\} · Release <code>\{shortReleaseDigest\(publication\.app\.releaseDigest\)\}<\/code>/);
  assert.match(settings, /Viewer entry \{publication\.app\.viewerEntry\} · Viewer-readable surface: \{publication\.app\.viewerSurface\.join\(", "\)\}/);
  assert.match(settings, /: \{publication\.relativePath\}<\/>\}/);
});

test("a file tab shares on the click and holds the link in a popover", async () => {
  const [pane, popover, menu] = await Promise.all([
    read("web-local/src/components/panes/FileDetailsPane.tsx"),
    read("web-local/src/components/panes/FileSharePopover.tsx"),
    read("web-local/src/components/tree/FileContextMenu.tsx"),
  ]);
  // Share sits after Open with, only for the file types a page can be.
  assert.match(pane, /Open with<\/button> : null\}\n\s*\{isShareablePath\(path\) \? <FileShareControl /);
  // One click shares through the Settings route with the file name as title;
  // no confirmation, a plain toast, then the link.
  assert.match(popover, /"\/api\/settings\/publications\/share"/);
  assert.match(popover, /title: pageTitleFromFileName\(fileName\)/);
  assert.match(popover, /showToast\(\{ text: fileSharing\.sharedToast\(result\.publication\.title\), tone: "success" \}\)/);
  assert.doesNotMatch(popover.slice(0, popover.indexOf("async function stopSharing")), /confirm\(/, "sharing never asks first");
  // Stop sharing keeps its confirm.
  assert.match(popover, /window\.confirm\(publicationsSettings\.stopSharingConfirm\)/);
  // No address: refused up front with a way to Web access.
  assert.match(popover, /caught\.code === "NO_ADDRESS"/);
  assert.match(popover, /onOpenSettings\("web-access"\)/);
  // No revealable link: point at Shared pages.
  assert.match(popover, /fileSharing\.linkInSettings/);
  assert.match(popover, /onOpenSettings\("shared-pages"\)/);
  // The preview shows a sample link and a toast instead of sharing.
  assert.match(popover, /sharedPageLink\(fixtureViewerOrigin, publication\.viewerPath, fixtureShareLinkKey\)/);
  // The link sits on one line in a read-only field, and the popover is
  // placed inside the file pane so it never scrolls the pane sideways.
  assert.match(popover, /<input className="file-share-link" type="text" readOnly value=\{link\}/);
  assert.match(popover, /const popoverWidth = 440;/);
  assert.match(popover, /anchor\.closest\("\.file-details-pane"\)/);
  assert.match(popover, /fileSharing\.previewDisabled/);
  // The Files menu offers Share / Shared for the same file types.
  assert.match(menu, /alreadyShared \? fileSharing\.shared : fileSharing\.share/);
  assert.match(menu, /isShareablePath\(entry\.path\)/);
  assert.match(app, /onShare=\{shareFile\} shareWorkFolderId=\{workFolder\.id\}/);
  assert.match(app, /onOpenSettings=\{openSharingSettings\}/);
});

test("a shared file carries a quiet mark in Files and on its tab", async () => {
  const [fileTree, styles] = await Promise.all([
    read("web-local/src/components/tree/FileTree.tsx"),
    read("web-local/src/styles.css"),
  ]);
  // Files: one 12px Share2 glyph after the name, files only, with the
  // check-attention dot still in place beside it.
  assert.match(fileTree, /sharedPaths\?: ReadonlySet<string>;/);
  assert.match(fileTree, /const shared = entry\.kind === "file" && sharedPaths\.has\(entry\.path\);/);
  assert.match(fileTree, /<HighlightedFileName name=\{entry\.name\} query=\{searchQuery\} \/>\{shared \? <SharedPageGlyph className="file-shared-marker" \/> : null\}<\/>/);
  assert.match(fileTree, /\{checkAttention \? <span className="file-check-attention-marker" aria-hidden="true" \/> : null\}/);
  assert.match(fileTree, /sharedPaths=\{sharedPaths\}/, "nested folders keep the mark");
  assert.match(fileTree, /aria-label=\{rowLabel\}/);
  assert.match(fileTree, /\$\{shared \? ` · \$\{fileSharing\.sharedMarkLabel\}` : ""\}/);
  assert.match(fileTree, /<span className=\{className\} title=\{fileSharing\.sharedMarkTooltip\} aria-hidden="true"><Share2 size=\{12\} \/><\/span>/);
  assert.match(app, /const sharedPaths = useMemo\(\(\) => sharedPathsForWorkFolder\(sharedPages, workFolder\.id\), \[sharedPages, workFolder\.id\]\);/);
  assert.match(app, /checkAttentionPaths=\{checks\.attentionPaths\} sharedPaths=\{sharedPaths\}/);
  // File tabs: the same glyph before the close button, inside the tab's
  // own trailing column so the width tiers are untouched.
  assert.match(tabBar, /const shared = tab\.kind === "file" && Boolean\(isSharedFile\?\.\(tab\.workFolderId, tab\.path\)\);/);
  assert.match(tabBar, /\{shared \? <SharedPageGlyph className="surface-tab-shared-marker" \/> : null\}\n\s*<\/button>\n\s*<button\n\s*className="surface-tab-close"/);
  assert.match(app, /isSharedFile=\{\(workFolderId, path\) => Boolean\(activeSharedPageFor\(sharedPages, workFolderId, path\)\)\}/);
  assert.match(styles, /\.file-row-entry\.is-shared \{\n\s*grid-template-columns: auto minmax\(0, max-content\) auto minmax\(0, 1fr\);/);
  assert.match(styles, /\.app-shell\[data-theme="dark"\] \.file-shared-marker,\n\.app-shell\[data-theme="dark"\] \.surface-tab-shared-marker \{/);
  assert.equal(fileSharing.sharedMarkLabel, "Shared as a Page");
  assert.equal(fileSharing.sharedMarkTooltip, "Shared as a page. Anyone with the link can read it.");
});

test("the main window has no overview panel; the work-folder-identity header carries no action and Files keeps its actions in the right-click menu", () => {
  // The server digest stays (the popover's GlanceSection is gone too); the
  // main-window "Since you last looked" panel is gone, so the renderer
  // neither fetches nor acknowledges the overview from the main window.
  assert.doesNotMatch(app, /OverviewHeaderControl|OverviewPanel|useOverview/);
  assert.doesNotMatch(app, /headerAction/);
  // 2026-10-01: the search box spans the toolbar; refresh, new folder, and
  // add files are right-click actions, and a background refresh never dims
  // the tree.
  assert.doesNotMatch(app, /refreshFilesButton|aria-label="Refresh files"|aria-label="Add files"/);
  assert.match(app, /onRefresh=\{\(\) => void tree\.refresh\(false\)\}/);
  assert.match(app, /else if \(command === "refresh"\) await tree\.refresh\(false\);/);
  assert.doesNotMatch(app, /refreshing-files/);
  assert.doesNotMatch(app, /primaryItems[\s\S]{0,400}overview/i);
});

test("Manage folders has a Done exit and an Escape exit back to the previous mode", () => {
  // Done and Escape return to the mode the person was in before opening
  // Manage folders; Escape defers to an open menu, dialog, or modal.
  assert.match(app, /const modeBeforeManagingRef = useRef<WorkFolderRailMode>/);
  assert.match(app, /if \(activeMode !== "work-folders"\) modeBeforeManagingRef\.current = activeMode;/);
  assert.match(app, /function leaveManageFolders\(\): void \{\s*selectRailMode\(modeBeforeManagingRef\.current\);/);
  assert.match(app, /onKeyDown=\{activeMode === "work-folders" \? leaveManageFoldersOnEscape : undefined\}/);
  assert.match(app, /event\.currentTarget\.querySelector\('\[aria-expanded="true"\]'\)/);
  assert.match(app, /closest\?\.\('\[role="menu"\], \[role="dialog"\]'\)/);
  assert.match(app, /<WorkFoldersPane [^\n]*onDone=\{leaveManageFolders\}/);
  assert.match(workFolderPanes, /<button className="work-folders-pane-done" type="button" onClick=\{onDone\}>Done<\/button>/);
  // The header looks the same while managing: the menu entry, not the
  // trigger, marks Manage folders as current.
  assert.match(workFolderChrome, /aria-current=\{managingWorkFolders \? "true" : undefined\}/);
  assert.doesNotMatch(workFolderChrome, /managingWorkFolders \? "page"/);
  assert.match(workFolderChrome, /aria-label=\{saving \? "Saving name" : undefined\}/);
});

test("file attachment requests stay bound to one work-folder-owned Chat tab", () => {
  assert.match(app, /setContextRequest\(\{\s*id:[^}]+workFolderId:\s*workFolder\.id,\s*surfaceTabId\s*\}\)/);
  assert.match(app, /contextPathRequest=\{chatContextRequestForTab\(contextRequest,\s*targetWorkFolder\.id,\s*tab\.id\)\}/);
  assert.doesNotMatch(app, /contextPathRequest=\{active\s*&&\s*targetWorkFolder\.id\s*===\s*workFolder\.id\s*\?\s*contextRequest/);
});

test("Markdown image policy embeds only CSP-compatible sources and links remote HTTPS images", () => {
  const base = "https://work-fold.local/app";
  assert.deepEqual(resolveMessageImageSource("/api/assets/preview.png", base), {
    kind: "embed",
    src: "https://work-fold.local/api/assets/preview.png",
  });
  assert.deepEqual(resolveMessageImageSource("data:image/png;base64,AA==", base), {
    kind: "embed",
    src: "data:image/png;base64,AA==",
  });
  assert.deepEqual(resolveMessageImageSource("https://images.example/preview.png", base), {
    kind: "external-link",
    href: "https://images.example/preview.png",
  });
  assert.deepEqual(resolveMessageImageSource("http://images.example/preview.png", base), { kind: "blocked" });
  assert.deepEqual(resolveMessageImageSource("docs/preview.png", base), { kind: "blocked" });
  assert.deepEqual(resolveMessageImageSource("data:image/svg+xml;base64,AA==", base), { kind: "blocked" });

  assert.match(messages, /resolution\.kind === "embed"[\s\S]*?<img className="message-image"/);
  assert.match(messages, /resolution\.kind === "external-link"[\s\S]*?message-image-external/);
  assert.match(messages, /message-image-unavailable/);
  assert.match(indexHtml, /img-src 'self' data: blob:/);
  assert.doesNotMatch(indexHtml, /img-src[^;]*https:/);
  assert.doesNotMatch(indexHtml, /frame-ancestors/, "frame-ancestors is ignored in a meta CSP and should not create console noise");
  assert.match(indexHtml, /<link rel="icon" href="data:image\/png;base64,/);
});

test("work-folder operation tokens reject stale completions even after switching back", () => {
  const gate = createWorkFolderOperationGate("work-folder-a");
  const firstA = gate.capture();
  assert.equal(gate.isCurrent(firstA), true);
  gate.activate("work-folder-b");
  assert.equal(gate.isCurrent(firstA), false);
  const currentB = gate.capture();
  gate.activate("work-folder-a");
  assert.equal(gate.isCurrent(firstA), false);
  assert.equal(gate.isCurrent(currentB), false);
  assert.equal(gate.isCurrent(gate.capture()), true);

  assert.match(capabilities, /operationGateRef\.current\.activate\(workFolder\.id\)/);
  assert.match(capabilities, /loadCatalog\(operation:\s*WorkFolderOperationToken/);
  for (const functionName of ["reviewDiscoverItem", "installPending", "mutatePackage"]) {
    const body = functionBody(capabilities, functionName);
    assert.match(body, /operationGateRef\.current\.capture\(\)/, `${functionName} must capture the active work-folder generation`);
    assert.match(body, /operationGateRef\.current\.isCurrent\(operation\)/, `${functionName} must reject stale completion work`);
  }
});

test("new-Chat work-folder menu has deterministic roving keyboard navigation", () => {
  assert.equal(nextMenuItemIndex(-1, 3, "ArrowDown"), 0);
  assert.equal(nextMenuItemIndex(-1, 3, "ArrowUp"), 2);
  assert.equal(nextMenuItemIndex(2, 3, "ArrowDown"), 0);
  assert.equal(nextMenuItemIndex(0, 3, "ArrowUp"), 2);
  assert.equal(nextMenuItemIndex(1, 3, "Home"), 0);
  assert.equal(nextMenuItemIndex(1, 3, "End"), 2);
  assert.equal(nextMenuItemIndex(0, 0, "ArrowDown"), null);

  assert.match(tabBar, /aria-controls="new-chat-work-folder-menu"/);
  assert.match(tabBar, /onBlurCapture=/);
  assert.match(tabBar, /event\.key !== "Escape"[\s\S]*?menuButtonRef\.current\?\.focus\(\)/);
  assert.match(tabBar, /nextMenuItemIndex\(currentIndex,\s*items\.length/);
});

test("persistent work-folder menu has deterministic roving keyboard navigation", () => {
  assert.match(workFolderChrome, /aria-controls=\{switcherId\}/);
  assert.match(workFolderChrome, /onBlurCapture=/);
  assert.match(workFolderChrome, /aria-label="work-folder menu"/);
  assert.match(workFolderChrome, /nextMenuItemIndex\(currentIndex,\s*items\.length/);
  assert.match(workFolderChrome, /event\.key !== "Escape"[\s\S]*?switchTriggerRef\.current\?\.focus\(\)/);
});

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const nextFunction = source.indexOf("\n  async function ", start + 1);
  return source.slice(start, nextFunction >= 0 ? nextFunction : source.length);
}

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

test("the work-folder-owned Automations rail entry sits after History, shows only when an automation touches the work-folder, and opens its tab", () => {
  // docs/automations.md, F15 as amended 2026-09-24: Settings → Automations
  // stays the management home; the work-folder view is a read-mostly window.
  assert.match(workFolderChrome, /\{primaryItems\.map[\s\S]*?\)\)\}\s*\{automations \? \(/);
  assert.match(workFolderChrome, /\{automations \? \([\s\S]*?onClick=\{\(\) => onModeChange\("automations"\)\}[\s\S]*?Flash24Filled[\s\S]*?<span className="work-folder-rail-label">Automations<\/span>[\s\S]*?\) : null\}\s*\{surfaces\.length \|\| apps\.length \? <span className="work-folder-rail-app-divider"/);
  assert.match(app, /const folderAutomations = useFolderAutomations\(workFolder\.id, Boolean\(fixture\)\);/);
  assert.match(app, /automations=\{hasFolderAutomations \? \{ active: activeTab\?\.kind === "work-folder-automations" && activeTab\.workFolderId === workFolder\.id \} : null\}/);
  assert.match(app, /if \(mode === "automations"\) \{ tabs\.openWorkFolderAutomationsSurfaceTab\(workFolder\); return; \}\s*setActiveMode\(mode\);/);
  assert.match(app, /tab\.kind === "work-folder-automations" \? \(\s*<WorkFolderAutomationsPane[\s\S]*?onOpenAllAutomations=\{\(\) => onOpenSettings\("automations"\)\}/);
  // The mode opens a tab and is never persisted as the navigator mode.
  assert.match(app, /return \(\["files", "chats", "history"\] as WorkFolderRailMode\[\]\)\.includes/);
});

 test("Keyboard Shortcuts shares Settings navigation and the rail has no shortcuts button", () => {
  assert.match(desktopDialogs[0] ?? "", /id: "shortcuts", label: "Shortcut Keys"/);
  assert.match(desktopDialogs[0] ?? "", /<KeyboardShortcutsPane \/>/);
  assert.match(app, /openKeyboardShortcuts = useCallback\(\(\) => openSettings\("shortcuts"\)/);
  assert.doesNotMatch(workFolderChrome, /onOpenKeyboardShortcuts|<span>Shortcuts<\/span>/);
 });
