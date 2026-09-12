import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { defaultApplicationAppearance } from "../src/shared/application-appearance.js";

const root = process.cwd();
const read = (path: string) => readFile(join(root, path), "utf8");

test("first-run onboarding offers only the two folder actions", async () => {
  const [source, app] = await Promise.all([
    read("web-local/src/components/onboarding/OnboardingFlow.tsx"),
    read("web-local/src/App.tsx"),
  ]);

  assert.equal(defaultApplicationAppearance.mode, "dark");
  assert.match(app, /useApplicationAppearance/);

  assert.match(source, /aria-label="Choose a folder"/);
  assert.match(source, /Add existing folder/);
  assert.match(source, /Create new folder/);
  assert.match(source, /<FolderOpen/);
  assert.match(source, /<FolderPlus/);
  assert.match(app, /body:\s*\{ spaceRoot: selected\.path, folderGrantId: selected\.folderGrantId \}/);
  assert.match(app, /await checksControl\?\.suspend\(\);[\s\S]*?\/api\/spaces\/local-folder/);
  assert.match(app, /finally \{ void checksControl\?\.resume\(\); \}/);
  assert.doesNotMatch(app, /body:\s*\{ rootPath: selected\.path, folderGrantId:/);
  assert.doesNotMatch(source, /menubar|popover|walkthrough|Register it in place|ordinary folder|onboarding-(?:identity|start|choice)/i);
});

test("the empty-folder actions remain compact and accessible", async () => {
  const styles = await read("web-local/src/styles.css");

  assert.match(styles, /\.onboarding-actions\s*\{[\s\S]*?grid-template-columns:/);
  assert.match(styles, /\.onboarding-folder-action\s*\{[\s\S]*?min-height:\s*48px/);
  assert.match(styles, /\.onboarding-folder-action:focus-visible\s*\{[\s\S]*?outline:/);
});
