import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { nextDialogTabIndex } from "../web-local/src/hooks/useModalDialog.js";
import { resolveMessageImageSource } from "../web-local/src/lib/message-images.js";
import { nextMenuItemIndex } from "../web-local/src/lib/menu-navigation.js";
import { createSpaceOperationGate } from "../web-local/src/lib/space-operation-gate.js";

const root = process.cwd();
const [capabilities, textInputModal, messages, tabBar, spaceChrome, indexHtml, app, needsYouDecisions, glancePanel, assistantPanes, ...desktopDialogs] = await Promise.all([
  read("web-local/src/components/panes/CapabilitiesPane.tsx"),
  read("web-local/src/components/modals/TextInputModal.tsx"),
  read("web-local/src/components/chat/messages.tsx"),
  read("web-local/src/components/chat/SpaceSurfaceTabBar.tsx"),
  read("web-local/src/components/panes/spaceChrome.tsx"),
  read("web-local/index.html"),
  read("web-local/src/App.tsx"),
  read("web-local/src/components/NeedsYouDecisions.tsx"),
  read("web-local/src/components/chrome/GlancePanel.tsx"),
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

test("Settings makes saved state explicit and locks configured credentials", () => {
  const settings = desktopDialogs[0] ?? "";
  assert.match(assistantPanes, /disabled=\{saving \|\| authConfigured\}/);
  assert.match(assistantPanes, /removableAuth[\s\S]*?Remove API key/);
  assert.match(assistantPanes, /!setupChanged/);
  assert.match(assistantPanes, /\/api\/agent\/auth[\s\S]*?method:\s*"DELETE"/);
  assert.match(assistantPanes, /professional-save-status" role="status"/);
  assert.match(settings, /Changes save automatically/);
  assert.match(settings, /settings-close-button/);
  assert.match(settings, /setCloseToTrayNotice\("Saved"\)/);
  assert.match(settings, /Private address created/);
  assert.match(settings, /!remoteSettingsChanged/);
});

test("the publications Settings section reveals links transiently and only narrows", () => {
  // Settings → The fold → Pages your fold serves (docs/fold-publishing.md,
  // plan item 5): the pane is a read-and-narrow surface over the renderer
  // session. The share link is composed on demand from the reveal route plus
  // the viewer origin, held only in pane state, and never persisted; every
  // mutation control narrows — stop sharing, tighten budgets, snapshot off —
  // and no widening control exists here.
  const settings = desktopDialogs[0] ?? "";
  // The reveal composes origin + path + fragment key transiently in state.
  assert.match(settings, /setRevealed\(\{ publicationId: publication\.publicationId, link: `\$\{viewerOrigin\}\$\{response\.viewerPath\}#\$\{response\.key\}` \}\)/);
  // No address, no reveal: the control is disabled until Remote access exists.
  assert.match(settings, /disabled=\{Boolean\(busy\) \|\| !viewerOrigin\}/);
  // Stop sharing takes the contract confirm and drops any revealed link.
  assert.match(settings, /window\.confirm\(foldPublicationsSettings\.stopSharingConfirm\)/);
  assert.match(settings, /setRevealed\(\(current\) => \(current\?\.publicationId === publication\.publicationId \? null : current\)\)/);
  // Narrowing inputs clamp at the current budgets — the UI cannot ask to widen.
  assert.match(settings, /max=\{publication\.serveRatePerMinute\}/);
  assert.match(settings, /max=\{Math\.round\(publication\.byteBudgetPerDay \/ \(1024 \* 1024\)\)\}/);
  // Snapshot has an off verb only; turning it on is staged through the fold.
  assert.match(settings, /\/snapshot-off`/);
  assert.doesNotMatch(settings, /snapshot-on/);
  // The retention choice stays labeled: opted-in pages carry the explicit
  // relay-copy label, everything else the widening hint.
  assert.match(settings, /publication\.snapshotEnabled \?[\s\S]{0,200}foldPublicationsSettings\.snapshotLabel/);
  assert.match(settings, /foldPublicationsSettings\.snapshotWidenHint/);
  // Hosted-app rows (kind "app") render the consecrated exposure binding —
  // App Instance id, short Release digest, viewer entry, the complete
  // viewer-readable surface — never the page-only relativePath line, and the
  // page line stays behind the kind branch so an app row can no longer
  // render "undefined" as its source.
  assert.match(settings, /publication\.kind === "app" && publication\.app/);
  assert.match(settings, /App Instance \{publication\.app\.appInstanceId\} · Release <code>\{shortReleaseDigest\(publication\.app\.releaseDigest\)\}<\/code>/);
  assert.match(settings, /Viewer entry \{publication\.app\.viewerEntry\} · Viewer-readable surface: \{publication\.app\.viewerSurface\.join\(", "\)\}/);
  assert.match(settings, /: \{publication\.relativePath\} — \{stateLine\(publication\)\}<\/>\}/);
});

test("the standing-policies Settings section edits label and matcher in place, never the kind", () => {
  // The inline editor rides the shipped PATCH route with exactly the two
  // editable fields; a policy's kind never changes (the store refuses it with
  // "delete and create instead"), so the editor never sends one. Both the add
  // form and the editor render the same closed matcher vocabulary component.
  const settings = desktopDialogs[0] ?? "";
  assert.match(settings, /method: "PATCH",\s*body: \{ label: current\.label\.trim\(\), match \},/);
  assert.equal((settings.match(/<PolicyMatcherFields/g) ?? []).length, 2);
  assert.match(settings, /editing\?\.policyId === policy\.id \? foldPoliciesSettings\.editCancel : foldPoliciesSettings\.edit/);
  assert.doesNotMatch(settings, /PATCH[\s\S]{0,200}kind:/, "the PATCH body never carries a kind");
});

test("the needs-you flyout is conditional, anchored to the bottom rail cluster, and never a rail destination", () => {
  // Decisions belong to the fold above all Spaces: the hook lives in App, is
  // fixture-safe, and refreshes on the same focus/visibility discipline as
  // the bootstrap — no background watcher. Deciding here records surface
  // "main-window"; the popover records "popover".
  assert.match(app, /surface: "main-window",\s*listenForReturn: true,\s*enabled: !fixtureRequested,/);
  assert.match(app, /needsYouControl=\{<NeedsYouRailControl state=\{needsYouDecisions\} \/>\}/);
  // The indicator joins the bottom rail cluster beside Settings instead of
  // adding a fourth primary destination (primaryNavigation stays pinned in
  // web-ui-contract.test.ts).
  assert.match(app, /accountControl=\{<>\{needsYouControl\}<button className="space-rail-account-button"/);
  assert.doesNotMatch(app, /primaryItems[\s\S]{0,400}needs-you/i);
  // Conditional presence: no pending decisions, no control — it lingers only
  // while the open flyout still shows the final outcome notice.
  assert.match(needsYouDecisions, /if \(count === 0 && !\(open && state\.notice\)\) return null;/);
  // The flyout is an anchored, window-scope surface with the Add-menu close
  // behaviors: outside pointerdown, Escape restoring focus, and blur-capture.
  assert.match(needsYouDecisions, /className="space-rail-needs-you-anchor"/);
  assert.match(needsYouDecisions, /aria-haspopup="dialog"/);
  assert.match(needsYouDecisions, /id="needs-you-flyout" className="needs-you-flyout" role="dialog"/);
  // The flyout overlaps the content area, so it carries the native-view
  // occluder marker the header switcher and glance panel already carry —
  // otherwise it renders under a restricted-app native viewport.
  assert.match(needsYouDecisions, /className="needs-you-flyout" role="dialog" aria-label=\{needsYouSurface\.heading\} data-native-view-occluder="true"/);
  assert.match(needsYouDecisions, /document\.addEventListener\("pointerdown", closeFromOutside, true\)/);
  assert.match(needsYouDecisions, /event\.key !== "Escape"/);
  assert.match(needsYouDecisions, /onBlurCapture=/);
  // Decisions made elsewhere become visible on the existing return discipline.
  assert.match(needsYouDecisions, /window\.addEventListener\("focus", refreshOnReturn\)/);
  assert.match(needsYouDecisions, /document\.addEventListener\("visibilitychange", refreshOnReturn\)/);
});

test("the main-window glance panel hangs off the Space-identity header, mounts only while open, and never becomes a rail destination", () => {
  // The glance (docs/fold-glance.md, surface `main-window`): the digest panel
  // is reachable from the persistent Space-identity header's action cluster —
  // not a rail destination, badge, or permanent navigation item
  // (primaryNavigation stays pinned in web-ui-contract.test.ts). The fixture
  // preview omits it because the digest reads the live local API.
  assert.match(app, /const headerAction = fixture && activeMode !== "files" \? undefined : <>/);
  assert.match(app, /\{fixture \? null : <GlanceHeaderControl \/>\}/);
  assert.match(app, /action=\{headerAction\}/);
  assert.doesNotMatch(app, /primaryItems[\s\S]{0,400}glance/i);
  // The shared surface-agnostic hook and section render as surface
  // "main-window", and the hook mounts only while the panel is open: nothing
  // is fetched — and no marker can advance — for a panel nobody is looking at.
  assert.match(glancePanel, /useGlance\("main-window"\)/);
  assert.match(glancePanel, /<GlanceSection state=\{state\} surface="main-window" \/>/);
  assert.match(glancePanel, /\{open\s*\?\s*createPortal\(/);
  // While open it refreshes on the focus/visibility discipline Checks use.
  assert.match(glancePanel, /window\.addEventListener\("focus", refreshOnReturn\)/);
  assert.match(glancePanel, /document\.addEventListener\("visibilitychange", refreshOnReturn\)/);
  // Anchored-dialog disciplines: outside pointerdown, Escape restoring focus,
  // and the native-view occluder marker the header switcher already carries.
  assert.match(glancePanel, /aria-haspopup="dialog"/);
  assert.match(glancePanel, /role="dialog"/);
  assert.match(glancePanel, /data-native-view-occluder="true"/);
  assert.match(glancePanel, /document\.addEventListener\("pointerdown", closeFromOutside, true\)/);
  assert.match(glancePanel, /event\.key !== "Escape"/);
  // An empty digest stays epistemically honest: nothing recorded, never "all clear".
  assert.match(glancePanel, /Nothing recorded right now/);
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
  assert.match(indexHtml, /<link rel="icon" href="data:image\/svg\+xml,/);
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
  assert.match(spaceChrome, /aria-label="Space menu"/);
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
