import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parseSpaceAppearanceProposal } from "../src/shared/space-appearance.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts", "work-fold-appearance.ts");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");

test("the appearance proposal tool emits the new kind, target fields, and default suffix", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-appearance-proposal-"));
  const created = await run(process.execPath, [
    tsxCli, script, "create",
    "--name", "Client work",
    "--color", "#0d74ce",
    "--space-id", "space-client",
    "--space-name", "Client",
    "--created-by", "codex",
    "--json",
  ], { cwd: sandbox });
  const output = JSON.parse(created.stdout) as { path: string; proposal: unknown };
  assert.equal(basename(output.path), "client-work.work-fold-appearance.json");
  const proposal = parseSpaceAppearanceProposal(JSON.parse(await readFile(output.path, "utf8")));
  assert.equal(proposal.kind, "work-fold.space-appearance");
  assert.deepEqual(proposal.target, { spaceId: "space-client", spaceName: "Client" });
});

test("the appearance proposal tool rejects legacy Workspace target options", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-appearance-legacy-option-"));
  await assert.rejects(
    () => run(process.execPath, [
      tsxCli, script, "create",
      "--name", "Legacy",
      "--color", "#0d74ce",
      "--workspace-id", "space-client",
    ], { cwd: sandbox }),
    /Unknown option '--workspace-id'/,
  );
});
