import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { nextDialogTabIndex } from "../web-local/src/hooks/useModalDialog.js";
import { resolveMessageImageSource } from "../web-local/src/lib/message-images.js";
import { nextMenuItemIndex } from "../web-local/src/lib/menu-navigation.js";
import { createSpaceOperationGate } from "../web-local/src/lib/space-operation-gate.js";

const root = process.cwd();
const [capabilities, textInputModal, messages, tabBar, spaceChrome, indexHtml, app, _retiredNeedsYou, spacePanes, ...desktopDialogs] = await Promise.all([
  read("web-local/src/components/panes/CapabilitiesPane.tsx"),
  read("web-local/src/components/modals/TextInputModal.tsx"),
  read("web-local/src/components/chat/messages.tsx"),
  read("web-local/src/components/chat/SpaceSurfaceTabBar.tsx"),
  read("web-local/src/components/panes/spaceChrome.tsx"),
  read("web-local/index.html"),
  read("web-local/src/App.tsx"),
  Promise.resolve(""),
  read("web-local/src/components/panes/spacePanes.tsx"),
  read("web-local/src/components/modals/DesktopSettingsModal.tsx"),
  read("web-local/src/components/modals/KeyboardShortcutsModal.tsx"),
  read("web-local/src/components/modals/CreateSpaceModal.tsx"),
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
  // against the real form in assistant-settings-ui.test.ts.
  assert.match(await read("web-local/src/components/modals/AppearanceSettingsPane.tsx"), /role="status">\{appearance\.error \?\? appearance\.notice/);
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
  assert.equal(settingsTabForPage("desktop", "routings"), "automations");
  assert.equal(settingsTabForPage("desktop", "limits"), "automations");
  assert.equal(settingsTabForPage("desktop", "deleted"), "recently-deleted");
  assert.equal(settingsTabForPage("general", "deleted"), "recently-deleted");
  assert.equal(settingsTabForPage("remote"), "web-access");
  for (const page of ["appearance", "assistant", "web-access", "shared-pages", "automations", "recently-deleted", "about"] as const) {
    assert.equal(settingsTabForPage(page), page);
  }
  const settings = desktopDialogs[0] ?? "";
  assert.doesNotMatch(settings, /label: "Desktop"/);
  assert.match(settings, /<FoldRoutingsPane \/>\s*<FoldLimitsPane onOpenRecentlyDeleted=\{\(\) => setPage\("recently-deleted"\)\} \/>/);
  assert.match(settings, /interfaceExtra=\{closeWindowControl\}/);
});

test("no surface offers an authority mode, a policy, or a decision card", () => {
  // docs/receipts-not-gates.md, F19/F24: the Settings → Automations pane has no
  // Authority selector and no Standing policies section; the main window has
  // no needs-you rail control; questions live inside their owning Chat.
  const settings = desktopDialogs[0] ?? "";
  assert.doesNotMatch(settings, /fold-authority|fold-policies|FoldAuthorityPane|FoldPoliciesPane|PolicyMatcherFields|"authority"/);
  assert.match(settings, /remoteAccessSettings\.pairedBrowserTrust/);
  assert.doesNotMatch(app, /NeedsYouRailControl|useNeedsYouDecisions|needsYouControl|\/api\/management\/decisions/);
  assert.match(app, /accountControl=\{<button className="space-rail-account-button"/);
});

test("the publications Settings section reveals links transiently and changes budgets in place", () => {
  // Settings → Shared pages (docs/fold-publishing.md, plan item 5; amended
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
  assert.match(settings, /window\.confirm\(foldPublicationsSettings\.stopSharingConfirm\)/);
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
  assert.match(settings, /<label className="fold-publication-sleep-copy" title=\{foldPublicationsSettings\.snapshotLabel\}>/);
  assert.doesNotMatch(settings, /fold-publication-snapshot-label/);
  // Budgets are one compact row of their own, not the address form's grid.
  assert.match(settings, /<div className="fold-publication-budgets">/);
  // One quiet state word per row, the precise reason in the tooltip only —
  // the old visible problem line is gone.
  assert.match(settings, /const health = sharedPageHealth\(publication, connection\);/);
  assert.match(settings, /title=\{health\.reason\}/);
  assert.match(settings, /foldPublicationsSettings\.states\[health\.state\]/);
  assert.doesNotMatch(settings, /Not reaching viewers|lastProblem\.reason/);
  // Empty states: web access first (switching the tab), then a file's tab.
  assert.match(settings, /foldPublicationsSettings\.emptyNoAddress[\s\S]{0,200}onClick=\{onOpenWebAccess\}/);
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
  assert.match(popover, /window\.confirm\(foldPublicationsSettings\.stopSharingConfirm\)/);
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
  assert.match(app, /onShare=\{shareFile\} shareSpaceId=\{space\.id\}/);
  assert.match(app, /onOpenSettings=\{openSharingSettings\}/);
});

test("the main window has no glance panel; the Space-identity header carries no action and the files refresh sits in the toolbar", () => {
  // The menu-bar popover's GlanceSection and the server digest stay; the
  // main-window "Since you last looked" panel is gone, so the renderer
  // neither fetches nor acknowledges the glance from the main window.
  assert.doesNotMatch(app, /GlanceHeaderControl|GlancePanel|useGlance/);
  assert.doesNotMatch(app, /headerAction/);
  assert.match(app, /const refreshFilesButton = <button className="minimal-icon-button"[\s\S]{0,300}?aria-label="Refresh files"/);
  assert.match(app, /\{refreshFilesButton\}\s*<button className="minimal-icon-button"[\s\S]{0,200}?aria-label="Add files"/);
  assert.doesNotMatch(app, /primaryItems[\s\S]{0,400}glance/i);
});

test("Manage folders has a Done exit and an Escape exit back to the previous mode", () => {
  // Done and Escape return to the mode the person was in before opening
  // Manage folders; Escape defers to an open menu, dialog, or modal.
  assert.match(app, /const modeBeforeManagingRef = useRef<SpaceRailMode>/);
  assert.match(app, /if \(activeMode !== "spaces"\) modeBeforeManagingRef\.current = activeMode;/);
  assert.match(app, /function leaveManageFolders\(\): void \{\s*selectRailMode\(modeBeforeManagingRef\.current\);/);
  assert.match(app, /onKeyDown=\{activeMode === "spaces" \? leaveManageFoldersOnEscape : undefined\}/);
  assert.match(app, /event\.currentTarget\.querySelector\('\[aria-expanded="true"\]'\)/);
  assert.match(app, /closest\?\.\('\[role="menu"\], \[role="dialog"\]'\)/);
  assert.match(app, /<SpacesPane [^\n]*onDone=\{leaveManageFolders\}/);
  assert.match(spacePanes, /<button className="spaces-pane-done" type="button" onClick=\{onDone\}>Done<\/button>/);
  // The header looks the same while managing: the menu entry, not the
  // trigger, marks Manage folders as current.
  assert.match(spaceChrome, /aria-current=\{managingSpaces \? "true" : undefined\}/);
  assert.doesNotMatch(spaceChrome, /managingSpaces \? "page"/);
  assert.match(spaceChrome, /aria-label=\{saving \? "Saving name" : undefined\}/);
});

test("file attachment requests stay bound to one Space-owned Chat tab", () => {
  assert.match(app, /setContextRequest\(\{\s*id:[^}]+spaceId:\s*space\.id,\s*surfaceTabId\s*\}\)/);
  assert.match(app, /contextPathRequest=\{chatContextRequestForTab\(contextRequest,\s*targetSpace\.id,\s*tab\.id\)\}/);
  assert.doesNotMatch(app, /contextPathRequest=\{active\s*&&\s*targetSpace\.id\s*===\s*space\.id\s*\?\s*contextRequest/);
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

test("space operation tokens reject stale completions even after switching back", () => {
  const gate = createSpaceOperationGate("space-a");
  const firstA = gate.capture();
  assert.equal(gate.isCurrent(firstA), true);
  gate.activate("space-b");
  assert.equal(gate.isCurrent(firstA), false);
  const currentB = gate.capture();
  gate.activate("space-a");
  assert.equal(gate.isCurrent(firstA), false);
  assert.equal(gate.isCurrent(currentB), false);
  assert.equal(gate.isCurrent(gate.capture()), true);

  assert.match(capabilities, /operationGateRef\.current\.activate\(space\.id\)/);
  assert.match(capabilities, /loadCatalog\(operation:\s*SpaceOperationToken/);
  for (const functionName of ["reviewDiscoverItem", "installPending", "mutatePackage"]) {
    const body = functionBody(capabilities, functionName);
    assert.match(body, /operationGateRef\.current\.capture\(\)/, `${functionName} must capture the active Space generation`);
    assert.match(body, /operationGateRef\.current\.isCurrent\(operation\)/, `${functionName} must reject stale completion work`);
  }
});

test("new-Chat Space menu has deterministic roving keyboard navigation", () => {
  assert.equal(nextMenuItemIndex(-1, 3, "ArrowDown"), 0);
  assert.equal(nextMenuItemIndex(-1, 3, "ArrowUp"), 2);
  assert.equal(nextMenuItemIndex(2, 3, "ArrowDown"), 0);
  assert.equal(nextMenuItemIndex(0, 3, "ArrowUp"), 2);
  assert.equal(nextMenuItemIndex(1, 3, "Home"), 0);
  assert.equal(nextMenuItemIndex(1, 3, "End"), 2);
  assert.equal(nextMenuItemIndex(0, 0, "ArrowDown"), null);

  assert.match(tabBar, /aria-controls="new-chat-space-menu"/);
  assert.match(tabBar, /onBlurCapture=/);
  assert.match(tabBar, /event\.key !== "Escape"[\s\S]*?menuButtonRef\.current\?\.focus\(\)/);
  assert.match(tabBar, /nextMenuItemIndex\(currentIndex,\s*items\.length/);
});

test("persistent Space menu has deterministic roving keyboard navigation", () => {
  assert.match(spaceChrome, /aria-controls=\{switcherId\}/);
  assert.match(spaceChrome, /onBlurCapture=/);
  assert.match(spaceChrome, /aria-label="Folder menu"/);
  assert.match(spaceChrome, /nextMenuItemIndex\(currentIndex,\s*items\.length/);
  assert.match(spaceChrome, /event\.key !== "Escape"[\s\S]*?switchTriggerRef\.current\?\.focus\(\)/);
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

test("the Folder-owned Automations rail entry sits after History, shows only when an automation touches the Folder, and opens its tab", () => {
  // docs/fold-routings.md, F15 as amended 2026-09-24: Settings → Automations
  // stays the management home; the Folder view is a read-mostly window.
  assert.match(spaceChrome, /\{primaryItems\.map[\s\S]*?\)\)\}\s*\{automations \? \(/);
  assert.match(spaceChrome, /\{automations \? \([\s\S]*?onClick=\{\(\) => onModeChange\("automations"\)\}[\s\S]*?Flash24Filled[\s\S]*?<span className="space-rail-label">Automations<\/span>[\s\S]*?\) : null\}\s*\{surfaces\.length \|\| apps\.length \? <span className="space-rail-app-divider"/);
  assert.match(app, /const folderAutomations = useFolderAutomations\(space\.id, Boolean\(fixture\)\);/);
  assert.match(app, /automations=\{hasFolderAutomations \? \{ active: activeTab\?\.kind === "space-automations" && activeTab\.spaceId === space\.id \} : null\}/);
  assert.match(app, /if \(mode === "automations"\) \{ tabs\.openSpaceAutomationsSurfaceTab\(space\); return; \}\s*setActiveMode\(mode\);/);
  assert.match(app, /tab\.kind === "space-automations" \? \(\s*<SpaceAutomationsPane[\s\S]*?onOpenAllAutomations=\{\(\) => onOpenSettings\("automations"\)\}/);
  // The mode opens a tab and is never persisted as the navigator mode.
  assert.match(app, /return \(\["files", "chats", "history"\] as SpaceRailMode\[\]\)\.includes/);
});
