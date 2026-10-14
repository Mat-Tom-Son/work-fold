import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLocalApi } from "../src/local/server.js";
import type { WorkFolderSummary } from "../web-local/src/types.js";
import { commandPaletteResultGroups, type CommandPaletteCommand } from "../web-local/src/components/modals/CommandPaletteHost.js";

test("command palette searches real API work-folder summaries by name and folder without crashing", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-palette-contract-"));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), workFolderBase: join(sandbox, "content"), loadEnv: false });
  try {
    const response = await fetch(`${api.origin}/api/work-folders`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Editorial" }),
    });
    assert.equal(response.status, 201);
    const { workFolder } = await response.json() as { workFolder: WorkFolderSummary };
    assert.equal(workFolder.workFolderRoot, join(sandbox, "content", "editorial"));
    const commands: CommandPaletteCommand[] = [
      { id: "go:checks", groupId: "go-to", groupLabel: "Go to", label: "Checks", run() {} },
      { id: `work-folder:${workFolder.id}`, groupId: "switch-work-folder", groupLabel: "Switch work-folder", label: workFolder.name, matchTargets: [workFolder.name, workFolder.workFolderRoot], run() {} },
    ];
    const ids = (query: string) => commandPaletteResultGroups(commands, query).flatMap((group) => group.results.map((result) => result.command.id));
    // The random temporary path may also be a legitimate fuzzy match.
    assert.equal(ids("Checks")[0], "go:checks");
    assert.deepEqual(ids("Editorial"), [`work-folder:${workFolder.id}`]);
    assert.deepEqual(ids(join(sandbox, "content")), [`work-folder:${workFolder.id}`]);
  } finally { await api.close(); await rm(sandbox, { recursive: true, force: true }); }
});
