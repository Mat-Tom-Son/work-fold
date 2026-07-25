import assert from "node:assert/strict";
import test from "node:test";

import {
  composerCommandQuery,
  composerCommandValue,
  matchingComposerCommands,
} from "../web-local/src/components/chat/command-menu.js";
import type { AgentCommand } from "../web-local/src/types.js";

const commands: AgentCommand[] = [
  { name: "model", description: "Choose a model", source: "builtin" },
  { name: "skill:review", description: "Review the current document", source: "skill" },
  { name: "release-notes", description: "Draft release notes", source: "prompt" },
  { name: "calendar", description: "Read the team calendar", source: "extension" },
];

test("composer command discovery only activates for one leading slash fragment", () => {
  assert.equal(composerCommandQuery("/"), "");
  assert.equal(composerCommandQuery("/skill:rev"), "skill:rev");
  assert.equal(composerCommandQuery("/model openai"), null);
  assert.equal(composerCommandQuery("please /model"), null);
  assert.equal(composerCommandQuery("//model"), null);
});

test("composer command discovery ranks names before descriptions and keeps Skills prominent", () => {
  assert.deepEqual(
    matchingComposerCommands(commands, "release").map((command) => command.name),
    ["release-notes"],
  );
  assert.deepEqual(
    matchingComposerCommands(commands, "review").map((command) => command.name),
    ["skill:review"],
  );
  assert.equal(matchingComposerCommands(commands, "")[0]?.source, "skill");
});

test("composer command selection leaves argument-taking commands ready for input", () => {
  assert.equal(composerCommandValue(commands[0]!), "/model ");
  assert.equal(composerCommandValue(commands[1]!), "/skill:review");
});
