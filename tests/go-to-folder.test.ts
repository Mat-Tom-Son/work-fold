import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { expandTypedPath, goToFolder } from "../src/local/go-to-folder.js";

async function home(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-to-folder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "Documents", "Projects", "Roomcraft", "Assets"), { recursive: true });
  await writeFile(join(root, "Documents", "Projects", "Roomcraft", "Assets", "Roomcraft.unity"), "scene");
  await mkdir(join(root, "Documents", "Projects", "Recipes"));
  await mkdir(join(root, "Documents", "Projects", ".hidden"));
  await mkdir(join(root, "Downloads"));
  return root;
}

test("a typed path opens the place holding it: a work-folder before a Standard Folder, the deepest first", async (t) => {
  const root = await home(t);
  const projects = join(root, "Documents", "Projects");
  const workFolders = [{ id: "space-roomcraft", workFolderRoot: join(projects, "Roomcraft") }];

  const folder = await goToFolder(join(projects, "Roomcraft", "Assets"), workFolders, root);
  assert.deepEqual(folder.target, { place: { kind: "work-folder", id: "space-roomcraft" }, path: "Assets", select: null });

  // A file opens its folder with the file selected, as Finder's Go to Folder does.
  const file = await goToFolder(join(projects, "Roomcraft", "Assets", "Roomcraft.unity"), workFolders, root);
  assert.deepEqual(file.target, { place: { kind: "work-folder", id: "space-roomcraft" }, path: "Assets", select: "Assets/Roomcraft.unity" });

  // Outside the work-folder, the most specific Standard Folder (Documents, not the home folder).
  const documents = await goToFolder("~/Documents/Projects", workFolders, root);
  assert.deepEqual(documents.target, { place: { kind: "standard", id: "documents" }, path: "Projects", select: null });
  const homeFolder = await goToFolder("~", workFolders, root);
  assert.deepEqual(homeFolder.target, { place: { kind: "standard", id: "home" }, path: "", select: null });
});

test("Go to Folder completes names in the typed folder and says plainly what it can't open", async (t) => {
  const root = await home(t);
  const partial = await goToFolder("~/Documents/Projects/R", [], root);
  assert.equal(partial.target, null, "a partial name opens nothing yet");
  assert.deepEqual(partial.suggestions.map((item) => item.name), ["Recipes", "Roomcraft"]);
  const listed = await goToFolder("~/Documents/Projects/", [], root);
  assert.deepEqual(listed.suggestions.map((item) => item.name), ["Recipes", "Roomcraft"], "dot folders stay hidden");
  const outside = await goToFolder("/System/Library", [], root);
  assert.equal(outside.target, null);
  assert.match(outside.message ?? "", /home folder, iCloud Drive, a work-folder/);
  assert.equal(expandTypedPath("relative/name", root), null, "names relative to the folder shown are resolved in the window");
});
