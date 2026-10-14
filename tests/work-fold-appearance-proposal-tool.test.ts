import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parseWorkFolderAppearanceProposal } from "../src/shared/work-folder-appearance.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts", "work-fold-appearance.ts");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");

test("the inert appearance tool creates bounded built-in banner framing without writing work-folder content", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-banner-proposal-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const path = join(sandbox, "fold.json");
  await run(process.execPath, [tsxCli, script, "create", "--name", "Notes", "--color", "#0e7490", "--banner-preset", "fold", "--frame-x", "25", "--frame-y", "72", "--zoom", "1.25", "--out", path], { cwd: sandbox });
  const proposal = parseWorkFolderAppearanceProposal(JSON.parse(await readFile(path, "utf8")));
  assert.equal(proposal.customization.bannerPreset, "fold");
  assert.deepEqual(proposal.customization.bannerFraming, { x: 25, y: 72, zoom: 1.25 });
  await assert.rejects(run(process.execPath, [tsxCli, script, "create", "--color", "#0e7490", "--banner-preset", "https://example.test/x.webp", "--out", path]));
  await assert.rejects(run(process.execPath, [tsxCli, script, "create", "--color", "#0e7490", "--zoom", "3", "--out", path]));
});

test("the appearance proposal tool emits the new kind, target fields, and default suffix", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-appearance-proposal-"));
  const created = await run(process.execPath, [
    tsxCli, script, "create",
    "--name", "Client work",
    "--color", "#0d74ce",
    "--work-folder-id", "work-folder-client",
    "--work-folder-name", "Client",
    "--created-by", "codex",
    "--json",
  ], { cwd: sandbox });
  const output = JSON.parse(created.stdout) as { path: string; proposal: unknown };
  assert.equal(basename(output.path), "client-work.work-fold-appearance.json");
  const proposal = parseWorkFolderAppearanceProposal(JSON.parse(await readFile(output.path, "utf8")));
  assert.equal(proposal.kind, "work-fold.work-folder-appearance");
  assert.deepEqual(proposal.target, { workFolderId: "work-folder-client", workFolderName: "Client" });
});

test("the appearance proposal tool rejects legacy Workspace target options", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-appearance-legacy-option-"));
  await assert.rejects(
    () => run(process.execPath, [
      tsxCli, script, "create",
      "--name", "Legacy",
      "--color", "#0d74ce",
      "--workspace-id", "work-folder-client",
    ], { cwd: sandbox }),
    /Unknown option '--workspace-id'/,
  );
});
