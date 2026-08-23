import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { removePiSkill } from "../src/local/agent/skill-import.js";
import type { PiRuntimeProvider } from "../src/local/agent/pi-runtime-config.js";

test("removing an imported Skill deletes its folder and an emptied bundle folder, nothing else", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-skill-removal-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const agentDir = join(sandbox, "agent");
  const spaceRoot = join(sandbox, "space");
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };
  const bundle = join(agentDir, "skills", "research-pack");
  await mkdir(join(bundle, "brave-search", "scripts"), { recursive: true });
  await mkdir(join(bundle, "citations"), { recursive: true });
  await mkdir(join(agentDir, "skills", "standalone"), { recursive: true });
  await mkdir(spaceRoot, { recursive: true });
  await writeFile(join(bundle, "brave-search", "SKILL.md"), "---\nname: brave-search\n---\n");
  await writeFile(join(bundle, "brave-search", "scripts", "search.sh"), "#!/bin/sh\n");
  await writeFile(join(bundle, "citations", "SKILL.md"), "---\nname: citations\n---\n");
  await writeFile(join(agentDir, "skills", "standalone", "SKILL.md"), "---\nname: standalone\n---\n");

  const first = await removePiSkill(spaceRoot, { skillPath: join(bundle, "brave-search", "SKILL.md"), scope: "user" }, provider);
  assert.equal(first.removedPath, join(bundle, "brave-search"));
  assert.equal(existsSync(join(bundle, "brave-search")), false);
  assert.equal(existsSync(join(bundle, "citations", "SKILL.md")), true, "a sibling Skill in the same bundle survives");
  assert.equal(existsSync(bundle), true, "a bundle folder with Skills left keeps existing");

  await removePiSkill(spaceRoot, { skillPath: join(bundle, "citations", "SKILL.md"), scope: "user" }, provider);
  assert.equal(existsSync(bundle), false, "the last Skill takes its emptied bundle folder with it");
  assert.equal(existsSync(join(agentDir, "skills")), true, "the skills root itself is never removed");
  assert.equal(existsSync(join(agentDir, "skills", "standalone", "SKILL.md")), true);
});

test("Skill removal refuses anything outside work-fold's import roots, links, and the root itself", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-skill-removal-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const agentDir = join(sandbox, "agent");
  const spaceRoot = join(sandbox, "space");
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };
  await mkdir(join(agentDir, "skills", "real"), { recursive: true });
  await mkdir(join(sandbox, "elsewhere", "other"), { recursive: true });
  await mkdir(join(sandbox, "elsewhere", "nested", "skill"), { recursive: true });
  await mkdir(spaceRoot, { recursive: true });
  await writeFile(join(agentDir, "skills", "real", "SKILL.md"), "---\nname: real\n---\n");
  await writeFile(join(agentDir, "skills", "SKILL.md"), "---\nname: root-level\n---\n");
  await writeFile(join(sandbox, "elsewhere", "other", "SKILL.md"), "---\nname: other\n---\n");
  await writeFile(join(sandbox, "elsewhere", "nested", "skill", "SKILL.md"), "---\nname: nested\n---\n");
  await symlink(join(sandbox, "elsewhere", "other"), join(agentDir, "skills", "linked"));
  await symlink(join(sandbox, "elsewhere", "nested"), join(agentDir, "skills", "linked-parent"));

  await assert.rejects(
    removePiSkill(spaceRoot, { skillPath: join(sandbox, "elsewhere", "other", "SKILL.md"), scope: "user" }, provider),
    /not stored in your Pi skills folder/,
  );
  await assert.rejects(
    removePiSkill(spaceRoot, { skillPath: join(agentDir, "skills", "SKILL.md"), scope: "user" }, provider),
    /not stored in your Pi skills folder/,
    "a SKILL.md directly at the root would otherwise delete the root",
  );
  await assert.rejects(
    removePiSkill(spaceRoot, { skillPath: join(agentDir, "skills", "linked", "SKILL.md"), scope: "user" }, provider),
    /not an ordinary directory/,
  );
  await assert.rejects(
    removePiSkill(spaceRoot, { skillPath: join(agentDir, "skills", "linked-parent", "skill", "SKILL.md"), scope: "user" }, provider),
    /resolves outside work-fold's import root/,
    "a symlink above the Skill directory cannot redirect recursive removal outside the import root",
  );
  await assert.rejects(
    removePiSkill(spaceRoot, { skillPath: join(agentDir, "skills", "real", "notes.md"), scope: "user" }, provider),
    /SKILL\.md identifies it/,
  );
  await assert.rejects(
    removePiSkill(spaceRoot, { skillPath: join(spaceRoot, ".pi", "skills", "x", "SKILL.md"), scope: "project" }, provider),
    /Trust this Space/,
    "Space-scoped removal needs the same explicit trust as Space-scoped installs",
  );
  assert.equal(existsSync(join(sandbox, "elsewhere", "other", "SKILL.md")), true);
  assert.equal(existsSync(join(sandbox, "elsewhere", "nested", "skill", "SKILL.md")), true);
  assert.equal(existsSync(join(agentDir, "skills", "real", "SKILL.md")), true);
});
