import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLocalApi } from "../src/local/server.js";
import type { SpaceSummary } from "../web-local/src/types.js";
import { commandPaletteResultGroups, type CommandPaletteCommand } from "../web-local/src/components/modals/CommandPaletteHost.js";

test("command palette searches real API Space summaries by name and folder without crashing", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-palette-contract-"));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), spaceBase: join(sandbox, "content"), loadEnv: false });
  try {
    const response = await fetch(`${api.origin}/api/spaces`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Editorial" }),
    });
    assert.equal(response.status, 201);
    const { space } = await response.json() as { space: SpaceSummary };
    assert.equal(space.spaceRoot, join(sandbox, "content", "editorial"));
    const commands: CommandPaletteCommand[] = [
      { id: "go:checks", groupId: "go-to", groupLabel: "Go to", label: "Checks", run() {} },
      { id: `space:${space.id}`, groupId: "switch-space", groupLabel: "Switch Space", label: space.name, matchTargets: [space.name, space.spaceRoot], run() {} },
    ];
    const ids = (query: string) => commandPaletteResultGroups(commands, query).flatMap((group) => group.results.map((result) => result.command.id));
    assert.deepEqual(ids("Checks"), ["go:checks"]);
    assert.deepEqual(ids("Editorial"), [`space:${space.id}`]);
    assert.deepEqual(ids(join(sandbox, "content")), [`space:${space.id}`]);
  } finally { await api.close(); await rm(sandbox, { recursive: true, force: true }); }
});
