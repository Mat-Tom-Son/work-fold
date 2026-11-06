import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { nextDialogTabIndex } from "../web-local/src/hooks/useModalDialog.js";
import { resolveMessageImageSource } from "../web-local/src/lib/message-images.js";
import { nextMenuItemIndex } from "../web-local/src/lib/menu-navigation.js";
import { createWorkFolderOperationGate } from "../web-local/src/lib/work-folder-operation-gate.js";

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
  for (const page of ["appearance", "ai-models", "web-access", "automations", "published", "recently-deleted", "shortcuts", "about"] as const) {
    assert.equal(settingsTabForPage(page), page);
  }
  const settings = desktopDialogs[0] ?? "";
  assert.doesNotMatch(settings, /label: "Desktop"/);
  assert.match(settings, /<AutomationsPane fixtureMode=\{fixtureMode\} \/>\s*<WorkFoldLimitsPane onOpenRecentlyDeleted=\{\(\) => setPage\("recently-deleted"\)\} fixtureMode=\{fixtureMode\} \/>/);
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

test("a file tab's header is a labeled toolbar with Copy for text and a More menu", async () => {
  const [pane, styles] = await Promise.all([
    read("web-local/src/components/panes/FileDetailsPane.tsx"),
    read("web-local/src/styles.css"),
  ]);
  // Clipboard bytes, freshness, empty files and cancelled reads are covered
  // by file-details-ui.test.ts against the mounted component.
  // The everyday actions keep their words; the rest are named items in More,
  // never a row of unlabeled icons.
  assert.match(pane, /<span className="file-details-action-label">Attach to Chat<\/span>/);
  assert.doesNotMatch(pane, /className="ui-control ui-control--icon" type="button" title=\{revealLabel\}/);
  for (const item of ["Open With", "Copy File Path", "Version History", "Rename"]) assert.match(pane, new RegExp(`label: "${item}"`));
  assert.match(pane, /aria-haspopup="menu" aria-expanded=\{open\}/);
  assert.match(pane, /className="context-menu file-details-menu" role="menu"/);
  // Narrow tabs drop the words before they wrap the row.
  assert.match(styles, /@container file-details \(max-width: 560px\) \{\n\n\.file-details-action-label \{\n  display: none;/);
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
  assert.match(workFolderChrome, /aria-label=\{saving \? "Saving Name" : undefined\}/);
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

test("the work-folder-owned Automations rail entry sits after History, shows only when an automation touches the work-folder, and lists them in the left pane", () => {
  // docs/automations.md, F15 as amended 2026-09-24: Settings → Automations
  // stays the management home; the work-folder view is a read-mostly window.
  assert.match(workFolderChrome, /\{primaryItems\.map[\s\S]*?\)\)\}\s*\{automations \? \(/);
  assert.match(workFolderChrome, /\{automations \? \([\s\S]*?onClick=\{\(\) => onModeChange\("automations"\)\}[\s\S]*?Flash24Filled[\s\S]*?<span className="work-folder-rail-label">Automations<\/span>[\s\S]*?\) : null\}\s*\{surfaces\.length \|\| apps\.length \? <span className="work-folder-rail-app-divider"/);
  assert.match(app, /const folderAutomations = useFolderAutomations\(workFolder\.id, Boolean\(fixture\)\);/);
  assert.match(app, /automations=\{hasFolderAutomations \? \{ active: !sidebarCollapsed && activeMode === "automations" \} : null\}/);
  // 2026-10-11: like Files, the rail button shows a list in the left pane and
  // never opens a tab itself; clicking an automation opens its own tab.
  assert.doesNotMatch(app, /openWorkFolderAutomationsSurfaceTab\(workFolder\)/);
  assert.match(app, /\{activeMode === "automations" \? <WorkFolderAutomationsNavigator automations=\{folderAutomations\.byWorkFolder\[workFolder\.id\]\}[\s\S]*?onOpen=\{\(automation\) => tabs\.openWorkFolderAutomationSurfaceTab\(workFolder, automation\)\}/);
  assert.match(app, /tab\.kind === "work-folder-automations" \|\| tab\.kind === "work-folder-automation" \? \(\s*<WorkFolderAutomationsPane[\s\S]*?automationId: tab\.automationId[\s\S]*?onOpenAllAutomations=\{\(\) => onOpenSettings\("automations"\)\}/);
  assert.match(app, /return \(\["files", "chats", "history", "automations"\] as WorkFolderRailMode\[\]\)\.includes/);
  assert.match(app, /if \(folderAutomationsLoaded && !hasFolderAutomations\) setActiveMode\("files"\);/, "the pane falls back to Files when nothing is automated here");
});

 test("Keyboard Shortcuts shares Settings navigation and the rail has no shortcuts button", () => {
  assert.match(desktopDialogs[0] ?? "", /id: "shortcuts", label: "Shortcut Keys"/);
  assert.match(desktopDialogs[0] ?? "", /<KeyboardShortcutsPane \/>/);
  assert.match(app, /openKeyboardShortcuts = useCallback\(\(\) => openSettings\("shortcuts"\)/);
  assert.doesNotMatch(workFolderChrome, /onOpenKeyboardShortcuts|<span>Shortcuts<\/span>/);
 });

test("app and Extension rail buttons show their left pane and leave opening tabs to a click inside it", () => {
  const selectRailMode = /function selectRailMode\(mode: WorkFolderRailMode\): void \{([\s\S]*?)\n  \}/.exec(app)?.[1] ?? "";
  assert.ok(selectRailMode, "selectRailMode is found");
  assert.doesNotMatch(selectRailMode, /openExtensionSurfaceTab|openRestrictedApp/, "a rail click never opens an Extension or app tab");
  assert.match(app, /<ExtensionSurfacePane surface=\{activeSurface\}[\s\S]*?onOpenView=\{\(view\) => tabs\.openExtensionSurfaceTab\(workFolder, activeSurface, view\)\}/);
});
