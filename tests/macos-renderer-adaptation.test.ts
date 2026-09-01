import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { typographyFontOptionsForPlatform } from "../web-local/src/constants.js";
import { nativeOpenLabel, revealInFileManagerLabel } from "../web-local/src/lib/file-actions.js";
import { desktopShortcutKeyLabel, desktopShortcutModifierKey } from "../web-local/src/lib/keyboard.js";
import { desktopFileDragHint, typographyFontForPlatform, spaceEntryNativePath } from "../web-local/src/lib/platform.js";

const root = process.cwd();
const [app, rendererMain, styles, customization, settings, shortcuts, restrictedApps] = await Promise.all([
  read("web-local/src/App.tsx"),
  read("web-local/src/main.tsx"),
  read("web-local/src/styles.css"),
  read("web-local/src/professional-customization.css"),
  read("web-local/src/components/modals/DesktopSettingsModal.tsx"),
  read("web-local/src/components/modals/KeyboardShortcutsModal.tsx"),
  read("web-local/src/components/panes/RestrictedAppsSection.tsx"),
]);

test("typography ships the brand font everywhere and omits the Windows-only Segoe choice on macOS", () => {
  assert.deepEqual(typographyFontOptionsForPlatform("darwin").map(({ value, label }) => [value, label]), [
    ["default", "Default"],
    ["verdana", "Verdana"],
    ["aptos", "Aptos"],
  ]);
  assert.deepEqual(typographyFontOptionsForPlatform("win32").map(({ value, label }) => [value, label]), [
    ["default", "Default"],
    ["stable", "Segoe UI"],
    ["verdana", "Verdana"],
    ["aptos", "Aptos"],
  ]);
  assert.equal(typographyFontForPlatform("stable", "darwin"), "default");
  assert.equal(typographyFontForPlatform("stable", "win32"), "stable");
  // Inter is bundled, so the default stack no longer forks per platform.
  assert.match(styles, /--work-fold-font-family-default:\s*"Inter Variable"/);
  assert.doesNotMatch(styles, /:root\[data-platform="darwin"\][\s\S]{0,200}--work-fold-font-family-default/);
  assert.match(settings, /<span>Device setting<\/span>/);
  assert.doesNotMatch(settings, /Match your device’s appearance/);
  assert.doesNotMatch(settings, /Match Windows/);
});

test("macOS shortcut and file-drag labels use native notation without changing Windows", () => {
  assert.equal(desktopShortcutModifierKey("darwin"), "Command");
  assert.equal(desktopShortcutKeyLabel("Command", "darwin"), "⌘");
  assert.equal(desktopShortcutKeyLabel("Option", "darwin"), "⌥");
  assert.equal(desktopShortcutKeyLabel("Shift", "darwin"), "⇧");
  assert.equal(desktopShortcutModifierKey("win32"), "Ctrl");
  assert.equal(desktopShortcutKeyLabel("Shift", "win32"), "Shift");
  assert.equal(desktopFileDragHint("notes.md", "darwin"), "notes.md — drag to move, Option-drag to Finder");
  assert.equal(desktopFileDragHint("notes.md", "win32"), "notes.md — drag to move, Alt+drag to File Explorer");
  assert.equal(revealInFileManagerLabel("darwin"), "Show in Finder");
  assert.equal(nativeOpenLabel({ name: "legacy.doc", path: "legacy.doc", kind: "file" }, "darwin").text, "Show in Finder");
  assert.equal(nativeOpenLabel({ name: "legacy.doc", path: "legacy.doc", kind: "file" }, "win32").text, "Show in File Explorer");
  assert.equal(spaceEntryNativePath("/Users/mat/Space", "notes/draft.md", "darwin"), "/Users/mat/Space/notes/draft.md");
  assert.equal(spaceEntryNativePath("C:\\Users\\mat\\Space", "notes/draft.md", "win32"), "C:\\Users\\mat\\Space\\notes\\draft.md");
  assert.match(shortcuts, /macOS \? "Finder" : "File Explorer"/);
});

test("renderer publishes platform and material before mounting and keeps Mac scrollbars native", () => {
  const datasetIndex = rendererMain.indexOf("document.documentElement.dataset.platform");
  const renderIndex = rendererMain.indexOf("ReactDOM.createRoot");
  assert.ok(datasetIndex >= 0 && datasetIndex < renderIndex);
  assert.match(rendererMain, /windowMaterial === "mica" \|\| windowMaterial === "vibrancy"/);
  assert.match(styles, /:root:not\(\[data-platform="darwin"\]\) \*::-webkit-scrollbar/);
  assert.doesNotMatch(styles, /(?:^|\n)\*::-webkit-scrollbar/);
  assert.match(customization, /:root\[data-platform="darwin"\] \*[\s\S]*?scrollbar-width:\s*auto[\s\S]*?scrollbar-gutter:\s*auto/);
});

test("macOS vibrancy is confined to navigation with an opaque work surface and solid fallback", () => {
  assert.match(customization, /data-window-material="vibrancy"[\s\S]*?professional-space-rail[\s\S]*?background:\s*transparent/);
  assert.match(customization, /data-window-material="vibrancy"[\s\S]*?\.right-rail[\s\S]*?background:\s*var\(--ui-surface\)/);
  assert.match(customization, /data-platform="darwin"[\s\S]*?-webkit-app-region:\s*drag/);
  assert.match(customization, /data-platform="darwin"[\s\S]*?padding-top:\s*38px/);
  assert.doesNotMatch(customization, /data-window-material="none"/);
});

test("desktop Space state, Finder-open routing, and guarded Quick Look are wired in the renderer", () => {
  assert.match(app, /space\.setActiveSpace\?\.\(activeSpace\?\.id \?\? null\)/);
  assert.match(app, /desktopSpace\.onOpenSpace\(\(spaceId\)/);
  assert.match(app, /function refreshOnReturn\(\)[\s\S]*?void refreshBootstrap\(\)/);
  assert.match(app, /window\.addEventListener\("focus", refreshOnReturn\)/);
  assert.match(app, /document\.addEventListener\("visibilitychange", refreshOnReturn\)/);
  assert.match(app, /window\.removeEventListener\("focus", refreshOnReturn\)/);
  assert.match(app, /document\.removeEventListener\("visibilitychange", refreshOnReturn\)/);
  assert.match(app, /previewFile\(space\.id, path\)/);
  assert.match(app, /activeMode !== "files"/);
  assert.match(app, /\[data-tree-row\]/);
  assert.match(app, /input, textarea, select, button/);
  assert.match(app, /\[role='dialog'\]\[aria-modal='true'\]/);
});

test("Space previews an already-selected Mac file row without changing other tree keyboard behavior", async () => {
  const fileTree = await read("web-local/src/components/tree/FileTree.tsx");
  assert.match(app, /onPreviewFile=\{isMacOS\(\) \? previewLocalFile : undefined\}/);
  assert.match(fileTree, /event\.key === " "[\s\S]*?onPreviewFile && selectedPath === entry\.path[\s\S]*?onPreviewFile\(entry\.path\)[\s\S]*?else onSelectFile\(entry\.path\)/);
});

test("Darwin file-tree context menus use native command IDs while Windows keeps the React menu", () => {
  assert.match(app, /if \(isMacOS\(\) && popupFileMenu\)/);
  assert.match(app, /popupFileMenu\(\{[\s\S]*?spaceId: space\.id[\s\S]*?path: entry\.path[\s\S]*?kind: entry\.kind[\s\S]*?capabilities:/);
  assert.match(app, /open: entry\.kind === "folder" \|\| canOpenDirectly\(entry\.path\)/);
  for (const command of ["open", "reveal", "copy-path", "attach-chat", "version-history", "upload-here", "rename", "delete"]) {
    assert.match(app, new RegExp(`command === "${command}"`));
  }
  assert.match(app, /setFileContextMenu\(\{ entry,[\s\S]*?returnFocusTarget \}\)/, "non-Mac and bridge-less sessions retain the React menu");
  const nativeRequest = app.match(/const command = await popupFileMenu\(\{([\s\S]*?)\n\s*point,\n\s*\}\);/)?.[1];
  assert.ok(nativeRequest, "native popup request must be present");
  assert.doesNotMatch(nativeRequest, /(?:label|callback|onSelect):/, "native popup requests must contain data and capabilities only");
});

test("restricted-app notification copy is platform-neutral", () => {
  assert.match(restrictedApps, /<h3 id="restricted-app-notifications-title">Notifications<\/h3>/);
  assert.match(restrictedApps, /System notification settings can still suppress it/);
  assert.doesNotMatch(restrictedApps, /Windows notifications|Windows notification settings/);
});

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}
