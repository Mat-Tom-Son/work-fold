import assert from "node:assert/strict";
import test from "node:test";

import {
  composerCommandQuery,
  composerCommandValue,
  isHiddenComposerCommand,
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

test("the menu leaves out Pi built-ins the app already covers, but keeps compact and export", () => {
  const menu: AgentCommand[] = [
    ...["changelog", "hotkeys", "login", "logout", "copy", "model", "thinking", "settings", "session", "resume", "quit", "reload", "new", "import", "share", "fork", "clone", "tree", "trust", "name", "scoped-models"]
      .map((name): AgentCommand => ({ name, description: `Pi ${name}`, source: "builtin" })),
    { name: "compact", description: "Compact this Chat's working context", source: "builtin" },
    { name: "export", description: "Export this Chat", source: "builtin" },
    { name: "new", description: "A Skill that happens to share a name", source: "skill" },
  ];
  assert.deepEqual(
    matchingComposerCommands(menu, "", 50).map((command) => `${command.source}:${command.name}`),
    ["skill:new", "builtin:compact", "builtin:export"],
  );
  assert.equal(isHiddenComposerCommand({ name: "model", source: "builtin" }), true);
  assert.equal(isHiddenComposerCommand({ name: "model", source: "extension" }), false);
  assert.equal(isHiddenComposerCommand({ name: "compact", source: "builtin" }), false);
});

test("a hidden built-in typed in full closes the menu so Enter sends it as typed", () => {
  const menu: AgentCommand[] = [
    { name: "model", description: "Choose a model", source: "builtin" },
    { name: "scoped-models", description: "Choose models to cycle", source: "builtin" },
    { name: "skill:model-review", description: "Review a model", source: "skill" },
  ];
  assert.deepEqual(matchingComposerCommands(menu, "model"), []);
  assert.deepEqual(matchingComposerCommands(menu, "mod").map((command) => command.name), ["skill:model-review"]);
});
