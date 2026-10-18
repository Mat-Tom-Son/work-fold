import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { includedToolsRoot } from "../src/local/agent/included-tools.js";
import { parseWorkFoldCliActArgv } from "../src/local/cli/act-commands.js";

/**
 * Set up for me reorganizes a person's folder, so it has to follow the rule
 * the Worker guide teaches: moves, renames, and new folders go through the
 * restore-pointed `work-fold files` verbs, never raw tools. And it promises
 * only the undo History actually reports.
 */
const skillPath = join(includedToolsRoot(), "skills", "set-up-work-folder", "SKILL.md");

test("Set up for me organizes with the work-fold file verbs, never raw mkdir or mv", async () => {
  const skill = await readFile(skillPath, "utf8");
  assert.doesNotMatch(skill, /mkdir -p|mv -n/, "no raw folder or move commands");
  for (const verb of ["files mkdir", "files move", "files rename"]) {
    assert.ok(skill.includes(`work-fold ${verb} --work-folder <id>`), `the Skill shows ${verb} with --work-folder`);
  }
  assert.match(skill, /refuse rather\s+than overwrite/);
  assert.match(skill, /next free ` \(2\)`/, "a name clash still becomes \" (2)\", chosen by the Worker");
  assert.match(skill, /`fromPath` and `path`/, "the receipts supply the list of moves");

  // Every example command parses with the CLI's own act parser, so the Skill
  // never teaches a flag the verbs do not take.
  const examples = skill.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("work-fold files "));
  assert.ok(examples.length >= 3);
  for (const example of examples) {
    const argv = shellWords(example.replace("<id>", "work-folder-1")).slice(1);
    const parsed = parseWorkFoldCliActArgv(argv);
    assert.equal(parsed.workFolder, "work-folder-1", example);
    assert.equal(parsed.output, "json", example);
  }
});

test("Set up for me promises only the undo History reports", async () => {
  const skill = await readFile(skillPath, "utf8");
  assert.doesNotMatch(skill, /every change here can be undone/);
  assert.match(skill, /History took a\s+restore point before this turn \(check its coverage in your turn context/);
  assert.match(skill, /when your turn context shows History captured a restore point/);
  assert.match(skill, /each move and rename has its own restore point/);
});

function shellWords(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!);
}
