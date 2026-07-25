import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { nextDialogTabIndex } from "../web-local/src/hooks/useModalDialog.js";
import { resolveMessageImageSource } from "../web-local/src/lib/message-images.js";
import { nextMenuItemIndex } from "../web-local/src/lib/menu-navigation.js";
import { createWorkspaceOperationGate } from "../web-local/src/lib/workspace-operation-gate.js";

const root = process.cwd();
const [capabilities, textInputModal, messages, tabBar, indexHtml] = await Promise.all([
  read("web-local/src/components/panes/CapabilitiesPane.tsx"),
  read("web-local/src/components/modals/TextInputModal.tsx"),
  read("web-local/src/components/chat/messages.tsx"),
  read("web-local/src/components/chat/WorkspaceSurfaceTabBar.tsx"),
  read("web-local/index.html"),
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
});

test("Markdown image policy embeds only CSP-compatible sources and links remote HTTPS images", () => {
  const base = "https://workspace.local/app";
  assert.deepEqual(resolveMessageImageSource("/api/assets/preview.png", base), {
    kind: "embed",
    src: "https://workspace.local/api/assets/preview.png",
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
});

test("workspace operation tokens reject stale completions even after switching back", () => {
  const gate = createWorkspaceOperationGate("space-a");
  const firstA = gate.capture();
  assert.equal(gate.isCurrent(firstA), true);
  gate.activate("space-b");
  assert.equal(gate.isCurrent(firstA), false);
  const currentB = gate.capture();
  gate.activate("space-a");
  assert.equal(gate.isCurrent(firstA), false);
  assert.equal(gate.isCurrent(currentB), false);
  assert.equal(gate.isCurrent(gate.capture()), true);

  assert.match(capabilities, /operationGateRef\.current\.activate\(workspace\.id\)/);
  assert.match(capabilities, /loadCatalog\(operation:\s*WorkspaceOperationToken/);
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

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const nextFunction = source.indexOf("\n  async function ", start + 1);
  return source.slice(start, nextFunction >= 0 ? nextFunction : source.length);
}

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}
