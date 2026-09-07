import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

const { inspectRepository } = await import(new URL("../scripts/check-repository.mjs", import.meta.url).href);
const ignoreRules = `.env\n.env.*\n!.env.example\nnode_modules/\nout/\noutput/\n.codex/\nCLAUDE.local.md\n/.claude/*\n!/.claude/skills/\n/.claude/skills/*\n!/.claude/skills/alpha\n!/.claude/skills/beta\n`;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-repo-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  git("init", "-q");
  await write(".gitignore", ignoreRules);
  await write(".nvmrc", "24\n");
  await write("AGENTS.md", "# Shared contributor rules\n");
  await write("CLAUDE.md", "@AGENTS.md\n");
  await write("CONTRIBUTING.md", "[Docs](docs/README.md)\n");
  await write("docs/README.md", "# Docs\n");
  await write("package.json", JSON.stringify({ scripts: { check: "node check.mjs" } }));
  await write(".agents/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Example workflow\n---\n# Alpha\n");
  await mkdir(join(root, ".claude/skills"), { recursive: true });
  await symlink("../../.agents/skills/alpha", join(root, ".claude/skills/alpha"));
  git("add", ".");
  return { root, write, git, check: () => inspectRepository(root) };
}

test("a fresh repository passes without dependencies, network, or private harness state", async (t) => {
  const f = await fixture(t);
  await f.write(".claude/settings.local.json", "this deliberately is not JSON");
  await f.write(".codex/config.toml", "not parsed by the repository check");
  const result = await f.check();
  assert.deepEqual(result.problems, []);
  assert.equal(result.skills, 1);
});

test("new shared Skills must have matching Claude symlinks, including before staging", async (t) => {
  const f = await fixture(t);
  await f.write(".agents/skills/beta/SKILL.md", "---\nname: beta\ndescription: Another workflow\n---\n# Beta\n");
  assert.match((await f.check()).problems.join("\n"), /beta: missing shared Skill link/);
  const link = join(f.root, ".claude/skills/beta");
  await symlink("../../.agents/skills/alpha", link);
  assert.match((await f.check()).problems.join("\n"), /beta: must point to/);
  await unlink(link);
  await f.write(".claude/skills/beta", "../../.agents/skills/beta");
  assert.match((await f.check()).problems.join("\n"), /must be a symlink, not a copy/);
  await unlink(link);
  await symlink("../../.agents/skills/beta", link);
  assert.deepEqual((await f.check()).problems, []);
  assert.equal((await f.check()).skills, 2);
});

test("copied Claude workflows, extra imports, and malformed shared Skills are diagnosed", async (t) => {
  const f = await fixture(t);
  await f.write("CLAUDE.md", "@AGENTS.md\n@private-instructions.md\n");
  await f.write(".agents/skills/alpha/SKILL.md", "---\nname: different\n---\n");
  await f.write(".claude/skills/copied/SKILL.md", "# A second workflow\n");
  await f.write(".claude/rules/private.md", "npm run private-content-must-not-be-parsed\n");
  f.git("add", "-f", ".claude/skills/copied/SKILL.md", ".claude/rules/private.md");
  const problems = (await f.check()).problems.join("\n");
  assert.match(problems, /must import only @AGENTS.md/);
  assert.match(problems, /matching name and nonempty description/);
  assert.match(problems, /only shared Skill symlinks/);
  assert.doesNotMatch(problems, /private-content-must-not-be-parsed/);
});

test("documentation links resolve across Markdown, HTML, references, and encoded spaces", async (t) => {
  const f = await fixture(t);
  await f.write("docs/a file.md", "# A file\n");
  await f.write("docs/README.md", '[Inline](a%20file.md#heading)\n[Reference][guide]\n[guide]: <a file.md>\n<img src="a%20file.md" />\n```md\n[Example](missing-example.md)\n```\n`[also an example](absent.md)`\n[External](https://example.com)\n');
  assert.deepEqual((await f.check()).problems, []);
  await f.write("docs/README.md", "[Broken](missing.md)\n[Generated](../out/private.md)\n[Escape](../../outside.md)\n");
  await f.write("out/private.md", "Local files must not mask missing clone content");
  const problems = (await f.check()).problems.join("\n");
  assert.match(problems, /missing repository link missing.md/);
  assert.match(problems, /missing repository link ..\/out\/private.md/);
  assert.match(problems, /link escapes the checkout/);
});

test("documented npm commands respect package scope and retain dated release history", async (t) => {
  const f = await fixture(t);
  await f.write("services/bridge/package.json", JSON.stringify({ scripts: { start: "node server.mjs" } }));
  await f.write("services/bridge/README.md", "npm run start\nnpm --prefix . run check\n");
  await f.write("docs/releases/old.md", "npm run retired-command\n");
  assert.deepEqual((await f.check()).problems, []);
  await f.write("services/bridge/README.md", "npm run removed\n");
  assert.match((await f.check()).problems.join("\n"), /unknown npm script removed in services\/bridge\/package.json/);
});

test("forced local state and weakened ignore rules fail without deleting personal files", async (t) => {
  const f = await fixture(t);
  await f.write(".env", "REPO_TEST_FIXTURE=true\n");
  f.git("add", "-f", ".env");
  assert.match((await f.check()).problems.join("\n"), /.env: tracked despite ignore rules/);
  f.git("rm", "--cached", ".env");
  assert.equal(await readFile(join(f.root, ".env"), "utf8"), "REPO_TEST_FIXTURE=true\n");
  assert.deepEqual((await f.check()).problems, []);
  await f.write(".gitignore", "");
  assert.match((await f.check()).problems.join("\n"), /must exclude .env/);
});

test("links and documents cannot resolve into files outside the checkout", async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "work-fold-repo-external-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "external.md"), "npm run should-never-be-read\n");
  await symlink(join(outside, "external.md"), join(f.root, "external.md"));
  await f.write("docs/README.md", "[External](../external.md)\n");
  const problems = (await f.check()).problems.join("\n");
  assert.match(problems, /outside the checkout/);
  assert.doesNotMatch(problems, /should-never-be-read/);
});
