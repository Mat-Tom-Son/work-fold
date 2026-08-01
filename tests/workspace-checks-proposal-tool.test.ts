import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { normalizeWorkspaceCheckProposal } from "../src/shared/checks.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts", "workspace-checks.ts");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");

test("the shared proposal tool creates and validates inert cross-file-type scope without enabling it", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-check-proposal-tool-"));
  const proposalPath = join(sandbox, "deliverables.workspace-check.json");
  const created = await run(process.execPath, [
    tsxCli, script, "create-file-presence",
    "--title", "Required deliverables exist",
    "--file", "Manuscript/draft.md",
    "--file", "Finance/budget.xlsx",
    "--file", "Design/cover.psd",
    "--expect", "present",
    "--created-by", "codex",
    "--out", proposalPath,
    "--json",
  ], { cwd: sandbox });
  const output = JSON.parse(created.stdout);
  assert.equal(output.created, true);
  const proposal = normalizeWorkspaceCheckProposal(JSON.parse(await readFile(proposalPath, "utf8")));
  assert.deepEqual(proposal.check.targets.map((target) => target.path), [
    "Manuscript/draft.md",
    "Finance/budget.xlsx",
    "Design/cover.psd",
  ]);
  assert.equal("enabled" in proposal, false);

  const validated = await run(process.execPath, [tsxCli, script, "validate", proposalPath, "--json"], { cwd: sandbox });
  assert.equal(JSON.parse(validated.stdout).valid, true);
});
