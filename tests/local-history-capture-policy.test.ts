import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSpaceCheckpoint, createSpaceMutationCheckpoint, restoreSpaceCheckpoint } from "../src/local/history.js";
import { GitignoreDirectoryRules, createFullHistoryCapturePolicy } from "../src/local/history-capture-policy.js";
import { setSpaceIgnoreState } from "../src/local/space-ignore.js";
import { configureWorkFoldStateRoot } from "../src/local/state-paths.js";

test("gitignore directory rules follow git precedence: anchoring, any-depth names, descendants, negation, nesting", () => {
  const rules = new GitignoreDirectoryRules();
  rules.addRules("", [
    "# build output",
    "dist/",
    "/out",
    "build",
    "coverage/**",
    "**/generated",
    "docs/**/cache",
    "!keep-me",
    "*.tmp",
    "target\\ dir",
    "",
  ].join("\n"));
  rules.addRules("packages/app", "node-build\n!dist\n");

  assert.equal(rules.excludesDirectory("dist"), true);
  assert.equal(rules.excludesDirectory("packages/lib/dist"), true, "unanchored names match at any depth");
  assert.equal(rules.excludesDirectory("out"), true);
  assert.equal(rules.excludesDirectory("packages/lib/out"), false, "a leading slash anchors to the .gitignore directory");
  assert.equal(rules.excludesDirectory("build"), true);
  assert.equal(rules.excludesDirectory("coverage"), true);
  assert.equal(rules.excludesDirectory("coverage/lcov-report"), true);
  assert.equal(rules.excludesDirectory("src/generated"), true);
  assert.equal(rules.excludesDirectory("docs/api/v2/cache"), true);
  assert.equal(rules.excludesDirectory("docs/cache"), true);
  assert.equal(rules.excludesDirectory("keep-me"), false);
  assert.equal(rules.excludesDirectory("scratch.tmp"), true);
  assert.equal(rules.excludesDirectory("target dir"), true, "escaped spaces are literal");
  assert.equal(rules.excludesDirectory("src"), false);
  assert.equal(rules.excludesDirectory("packages/app/node-build"), true, "nested .gitignore rules apply beneath their directory");
  assert.equal(rules.excludesDirectory("packages/other/node-build"), false);
  assert.equal(rules.excludesDirectory("packages/app/dist"), false, "a closer negation wins over the root rule");
});

test("full checkpoints skip gitignored, Space-ignored, dependency, and cache directories — but keep every individual file", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "space-history-policy-"));
  const root = join(sandbox, "space");
  configureWorkFoldStateRoot(join(sandbox, "state"));
  t.after(async () => {
    configureWorkFoldStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "dist", "assets"), { recursive: true });
  await mkdir(join(root, "docs", "build"), { recursive: true });
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await mkdir(join(root, ".venv", "lib"), { recursive: true });
  await mkdir(join(root, "target", "debug"), { recursive: true });
  await mkdir(join(root, "scratch"), { recursive: true });
  await mkdir(join(root, "__pycache__"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "dist/\n.env\n*.log\n");
  await writeFile(join(root, "docs", ".gitignore"), "build/\n");
  await writeFile(join(root, "src", "index.ts"), "export const answer = 42;\n");
  await writeFile(join(root, "dist", "assets", "bundle.js"), "minified");
  await writeFile(join(root, "docs", "build", "index.html"), "<html></html>");
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
  await writeFile(join(root, "node_modules", "dep", "index.js"), "dependency");
  await writeFile(join(root, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
  await writeFile(join(root, ".venv", "lib", "site.py"), "# venv");
  await writeFile(join(root, "target", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
  await writeFile(join(root, "target", "debug", "app"), "binary");
  await writeFile(join(root, "scratch", "notes.txt"), "temporary");
  await writeFile(join(root, "__pycache__", "mod.pyc"), "bytecode");
  await writeFile(join(root, ".env"), "SECRET=keep-me\n");
  await writeFile(join(root, "debug.log"), "gitignored file, still captured\n");
  await writeFile(join(root, "README.md"), "# Project\n");
  await setSpaceIgnoreState(root, ["scratch", "README.md"], true);

  const checkpoint = await createSpaceCheckpoint(root, { reason: "pre_turn" });
  assert.deepEqual(new Set(checkpoint.files.map((file) => file.path)), new Set([
    ".env",
    ".gitignore",
    "README.md",
    "debug.log",
    "docs/.gitignore",
    "docs/guide.md",
    "src/index.ts",
  ]));
  const excluded = checkpoint.skippedFiles.filter((file) => file.reason === "excluded").map((file) => file.path);
  assert.deepEqual(new Set(excluded), new Set([".venv", "__pycache__", "dist", "docs/build", "node_modules", "scratch", "target"]));
  assert.deepEqual(checkpoint.directories, ["docs", "src"]);

  const policy = await createFullHistoryCapturePolicy(root);
  await policy.enterDirectory("", root);
  assert.equal(await policy.excludeDirectory("dist", join(root, "dist")), "gitignore");
  assert.equal(await policy.excludeDirectory("scratch", join(root, "scratch")), "space_ignore");
  assert.equal(await policy.excludeDirectory("target", join(root, "target")), "builtin");
  assert.equal(await policy.excludeDirectory(".venv", join(root, ".venv")), "builtin");
  assert.equal(policy.excludeFile("README.md"), null, "a file hidden from Files and Search remains History material");
  assert.equal(policy.excludeFile(".env"), null, "gitignored files remain History material");
  assert.equal(policy.excludeFile("src/.git"), "builtin", "a gitlink file is version-control internals");

  // A targeted mutation checkpoint still captures exactly what it is asked
  // about, even inside gitignored output, so an explicit edit there keeps a
  // restore point.
  const targeted = await createSpaceMutationCheckpoint(root, { paths: ["dist/assets/bundle.js"], reason: "mutation" });
  assert.deepEqual(targeted.files.map((file) => file.path), ["dist/assets/bundle.js"]);

  // Restoring a full checkpoint never deletes excluded content.
  await writeFile(join(root, "src", "index.ts"), "export const answer = 43;\n");
  const restored = await restoreSpaceCheckpoint(root, checkpoint.checkpointId);
  assert.deepEqual(restored.restoredFiles, ["src/index.ts"]);
  assert.deepEqual(restored.deletedFiles, []);
});

test("large files are hashed from a stream and stored once", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "space-history-stream-"));
  const root = join(sandbox, "space");
  configureWorkFoldStateRoot(join(sandbox, "state"));
  t.after(async () => {
    configureWorkFoldStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  await mkdir(root, { recursive: true });
  const big = Buffer.alloc(9 * 1024 * 1024, 3);
  await writeFile(join(root, "big.bin"), big);
  await writeFile(join(root, "big-copy.bin"), big);
  await writeFile(join(root, "small.txt"), "hello");
  const first = await createSpaceCheckpoint(root, { reason: "manual" });
  assert.equal(first.fileCount, 3);
  const hashes = new Set(first.files.map((file) => file.hashSha256));
  assert.equal(hashes.size, 2, "identical large files share one blob");
  assert.equal(first.files.find((file) => file.path === "big.bin")?.sizeBytes, big.byteLength);
  const second = await createSpaceCheckpoint(root, { reason: "manual" });
  assert.equal(second.checkpointId, first.checkpointId, "an unchanged Space reuses the identical manifest");
});
