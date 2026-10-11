import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFile(resolve(root, path), "utf8");

test("the top strip carries the sidebar toggle and the work-fold agent mark, without labels", async () => {
  const [controls, css] = await Promise.all([read("web-local/src/components/chrome/WindowChromeControls.tsx"), read("web-local/src/panels.css")]);
  assert.match(controls, /aria-label=\{sidebarLabel\}/);
  assert.match(controls, /aria-label=\{agentLabel\}/);
  assert.match(controls, /import menuBarMarkUrl from "\.\.\/\.\.\/\.\.\/\.\.\/desktop\/assets\/iconTemplate@2x\.png"/, "the agent toggle uses the menu-bar mark");
  assert.doesNotMatch(controls, /<span>[A-Z][a-z]/, "no visible text labels");
  assert.match(css, /:root\[data-platform="darwin"\] \.window-chrome-leading \{ left: 78px; \}/, "the sidebar toggle clears the macOS window buttons");
  assert.match(css, /-webkit-app-region: no-drag;/);
});

test("hiding the sidebar keeps the rail, and every rail destination brings the pane back", async () => {
  const [app, css] = await Promise.all([read("web-local/src/App.tsx"), read("web-local/src/panels.css")]);
  assert.match(app, /function selectRailMode\(mode: WorkFolderRailMode\): void \{\s*\/\/ Every rail destination brings a hidden navigation pane back\.\s*setSidebarHidden\(false\);/);
  assert.match(app, /<WorkFolderModeRail activeMode=\{activeMode\} paneHidden=\{sidebarCollapsed\}/);
  assert.match(css, /\.work-folder-layout\.sidebar-collapsed \{\s*grid-template-columns: var\(--work-folder-rail-width\) minmax\(0, 1fr\);/);
});

test("the agent panel is the shared work-fold agent chat, beside the work area and outside every tab", async () => {
  const app = await read("web-local/src/App.tsx");
  assert.match(app, /<aside className="agent-panel" id="work-fold-agent-panel" aria-label="work-fold agent" hidden=\{!agentPanelOpen\}>/);
  assert.match(app, /<WorkFoldAgentChat host="panel"/);
  assert.match(app, /onOpenModelSettings=\{\(\) => onOpenSettings\("ai-models", "agent", true\)\}/);
  const tabsStart = app.indexOf('<aside className="right-rail"');
  const panel = app.indexOf('<aside className="agent-panel"');
  assert.ok(tabsStart > 0 && panel > tabsStart, "the panel follows the tab area rather than living inside it");
});

test("the View menu toggles the sidebar and the agent panel", async () => {
  const main = await read("desktop/src/main.ts");
  assert.match(main, /label: "Toggle Sidebar", accelerator: "CommandOrControl\+B"/);
  assert.match(main, /label: "Toggle work-fold agent", accelerator: "CommandOrControl\+J"/);
});
