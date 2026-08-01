import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (path: string) => readFile(join(root, path), "utf8");

test("first-run onboarding locates the always-available menu-bar surface", async () => {
  const [source, app] = await Promise.all([
    read("web-local/src/components/onboarding/OnboardingFlow.tsx"),
    read("web-local/src/App.tsx"),
  ]);

  assert.match(source, /work-fold lives in your menu bar\./);
  assert.match(source, /Click the fold—or drop something on it—from anywhere on your Mac\./);
  assert.match(source, /className="onboarding-menubar-scene" role="img"/);
  assert.match(source, /<WorkFoldMark/);
  assert.match(source, /Drop files, folders, or links/);
  assert.match(source, /They wait here until you add an instruction\./);
  assert.match(source, /Tell work-fold what to do/);
  assert.match(source, /Close the main window whenever you like/);
  assert.match(source, /Work keeps going\./);
  assert.match(source, /Across your Spaces/);
  assert.ok(source.indexOf("onboarding-menubar-scene") < source.indexOf("onboarding-identity"), "the menu-bar scene should sit above the welcome identity");
  assert.ok(source.indexOf("onboarding-identity") < source.indexOf("onboarding-start"), "the welcome identity should separate the menu-bar scene from Space setup");
  assert.match(app, /value === "light" \|\| value === "dark" \|\| value === "system" \? value : "dark"/);

  assert.match(source, /Start with a folder/);
  assert.match(source, /Use an existing folder/);
  assert.match(source, /Register it in place\. Nothing moves\./);
  assert.match(source, /Create a new Space/);
  assert.match(source, /work-fold creates a new ordinary folder\./);
  assert.match(source, /<FolderOpen/);
  assert.match(source, /<FolderPlus/);
  assert.match(app, /body:\s*\{ spaceRoot: selected\.path, folderGrantId: selected\.folderGrantId \}/);
  assert.match(app, /await checksControl\?\.suspend\(\);[\s\S]*?\/api\/spaces\/local-folder/);
  assert.match(app, /finally \{ void checksControl\?\.resume\(\); \}/);
  assert.doesNotMatch(app, /body:\s*\{ rootPath: selected\.path, folderGrantId:/);
  assert.doesNotMatch(source, /<Sparkles|<HardDrive|Google Drive|How do you want to begin|onboarding-anatomy/);
});

test("the menu-bar welcome scene keeps its composed surface across accessibility modes", async () => {
  const styles = await read("web-local/src/styles.css");

  assert.match(styles, /\.onboarding-menubar-scene\s*\{[\s\S]*?grid-template-rows:/);
  assert.match(styles, /\.onboarding-menubar-strip\s*\{[\s\S]*?backdrop-filter:/);
  assert.match(styles, /\.onboarding-popover-preview\s*\{[\s\S]*?transform-origin:/);
  assert.match(styles, /\.onboarding-choice-list\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(styles, /\.onboarding-choice-card\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border:\s*0/);

  assert.match(styles, /\.app-shell\[data-theme="dark"\] \.onboarding-menubar-strip/);
  assert.match(styles, /\.app-shell\[data-theme="dark"\] \.onboarding-choice-list/);
  assert.match(styles, /@media \(forced-colors: active\)[\s\S]*?\.onboarding-menubar-strip[\s\S]*?forced-color-adjust:\s*none/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.onboarding-menubar-strip[\s\S]*?opacity:\s*1 !important/);
  assert.doesNotMatch(styles, /onboarding-(?:map|anatomy)/);
});
