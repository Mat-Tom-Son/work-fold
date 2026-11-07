import assert from "node:assert/strict";
import test from "node:test";

import { executeWorkFoldCliRequest, workFoldCliHelp } from "../src/local/cli/commands.js";
import { outsideAgentSkill, outsideAgentSkillName } from "../src/shared/outside-agent-skill.js";
import { productIdentity } from "../src/shared/product-identity.js";

/**
 * The skill another AI agent uses to drive the app's command (owner request,
 * 2026-11-07): a valid SKILL.md, every command it cites a real one, and every
 * name taken from the identity file so a rename carries it along.
 */

const cli = productIdentity.cliCommand;

test("the skill is a SKILL.md named for the command, with a description", () => {
  const skill = outsideAgentSkill();
  const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1];
  assert.ok(frontMatter, "starts with front matter");
  assert.match(frontMatter, new RegExp(`^name: ${cli}$`, "m"));
  assert.match(frontMatter, /^description: .{40,}/m);
  assert.equal(outsideAgentSkillName(), cli);
  // Short on purpose: recipes and pointers to help, not a copy of it.
  assert.ok(skill.split("\n").length < 120, "the skill stays short");
});

test("every command the skill cites is one the command line documents", () => {
  const skill = outsideAgentSkill();
  const cited = [...skill.matchAll(new RegExp(`\`${cli} ([a-z-]+)(?: ([a-z-]+))?`, "g"))]
    .map((match) => ({ group: match[1]!, verb: match[2] }))
    .filter((item) => item.group !== "help");
  assert.ok(cited.length >= 20, "the skill cites the commands it teaches");
  for (const { group, verb } of cited) {
    const usage = `${workFoldCliHelp(cli)}\n${workFoldCliHelp(cli, group)}`;
    const spelled = verb && usage.includes(`${cli} ${group} ${verb} `) ? `${group} ${verb}` : group;
    assert.ok(usage.includes(`${cli} ${spelled} `) || usage.includes(`${cli} ${spelled}\n`), `the help documents '${cli} ${spelled}'`);
  }
  for (const topic of [...skill.matchAll(new RegExp(`\`${cli} help ([a-z-]+)\``, "g"))].map((match) => match[1]!)) {
    assert.notEqual(workFoldCliHelp(cli, topic), workFoldCliHelp(cli), `'${cli} help ${topic}' is a real topic`);
  }
});

test("a renamed product leaves no trace of the old brand in the skill", () => {
  const renamed = outsideAgentSkill({ productName: "Acme", cliCommand: "acme" });
  assert.match(renamed, /^---\nname: acme\n/);
  assert.match(renamed, /`acme chat send --work-folder/);
  assert.match(renamed, /The \*\*Acme agent\*\*/);
  // The noun "work-folder" is its own rename decision (docs/rebrand-plan.md).
  assert.doesNotMatch(renamed.replace(/work-folders?/g, ""), /work-?fold/i);
});

test("the command prints the skill", async () => {
  const run = async (argv: string[]) => executeWorkFoldCliRequest(
    { protocolVersion: 1, id: "8f0b7d2e-4c1a-4b5e-9d3f-2a6c8e1b7f40", argv, cwd: "/", createdAt: new Date().toISOString() } as never,
    {} as never,
    { version: "1.0.0", productName: productIdentity.productName },
  );
  const human = await run(["skill"]);
  assert.equal(human.exitCode, 0);
  assert.equal(human.stdout, outsideAgentSkill());
  const json = await run(["skill", "--json"]);
  assert.equal(JSON.parse(json.stdout).data.text, outsideAgentSkill());
  assert.notEqual((await run(["skill", "extra"])).exitCode, 0);
  assert.match(workFoldCliHelp(cli), /skill +Print the skill file that teaches another AI agent this command/);
});
