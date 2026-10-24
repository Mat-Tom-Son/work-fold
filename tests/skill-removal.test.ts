import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  PiSkillRestoreConflictError,
  removePiSkill,
  restorePiSkill,
  type PiSkillRemovalCandidate,
} from "../src/local/agent/skill-import.js";
import type { PiRuntimeProvider } from "../src/local/agent/pi-runtime-config.js";

/** Moves the Skill folder aside, the way Recently deleted does, and remembers what it was handed. */
function holdingArea(sandbox: string) {
  const handed: PiSkillRemovalCandidate[] = [];
  return {
    handed,
    keep: async (skill: PiSkillRemovalCandidate) => {
      handed.push(skill);
      const kept = join(sandbox, "kept", String(handed.length));
      await mkdir(join(sandbox, "kept"), { recursive: true });
      await rename(skill.skillDir, kept);
      return kept;
    },
  };
}

const neverKeep = async (): Promise<never> => {
  throw new Error("a refused removal must never hand a folder over");
};

test("removing an imported Skill hands over its folder and an emptied bundle folder goes, nothing else", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-skill-removal-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const agentDir = join(sandbox, "agent");
  const workFolderRoot = join(sandbox, "work-folder");
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };
  const bundle = join(agentDir, "skills", "research-pack");
  await mkdir(join(bundle, "brave-search", "scripts"), { recursive: true });
  await mkdir(join(bundle, "citations"), { recursive: true });
  await mkdir(join(agentDir, "skills", "standalone"), { recursive: true });
  await mkdir(workFolderRoot, { recursive: true });
  await writeFile(join(bundle, "brave-search", "SKILL.md"), "---\nname: web-search\n---\n");
  await writeFile(join(bundle, "brave-search", "scripts", "search.sh"), "#!/bin/sh\n");
  await writeFile(join(bundle, "citations", "SKILL.md"), "---\ndescription: no name here\n---\n");
  await writeFile(join(agentDir, "skills", "standalone", "SKILL.md"), "---\nname: standalone\n---\n");
  const holding = holdingArea(sandbox);

  const first = await removePiSkill(workFolderRoot, { skillPath: join(bundle, "brave-search", "SKILL.md"), scope: "user", keep: holding.keep }, provider);
  assert.equal(first.removedPath, join(bundle, "brave-search"));
  assert.equal(first.skillName, "web-search", "the frontmatter name is the name Pi loads");
  assert.deepEqual(holding.handed[0], {
    scope: "user",
    skillDir: join(bundle, "brave-search"),
    skillsRoot: join(agentDir, "skills"),
    relativePath: "research-pack/brave-search",
    skillName: "web-search",
  });
  assert.equal(first.kept, join(sandbox, "kept", "1"));
  assert.equal(await readFile(join(first.kept, "scripts", "search.sh"), "utf8"), "#!/bin/sh\n", "the whole folder is handed over");
  assert.equal(existsSync(join(bundle, "brave-search")), false);
  assert.equal(existsSync(join(bundle, "citations", "SKILL.md")), true, "a sibling Skill in the same bundle survives");
  assert.equal(existsSync(bundle), true, "a bundle folder with Skills left keeps existing");

  const second = await removePiSkill(workFolderRoot, { skillPath: join(bundle, "citations", "SKILL.md"), scope: "user", keep: holding.keep }, provider);
  assert.equal(second.skillName, "citations", "without a frontmatter name, Pi names a Skill after its folder");
  assert.equal(existsSync(bundle), false, "the last Skill takes its emptied bundle folder with it");
  assert.equal(existsSync(join(agentDir, "skills")), true, "the skills root itself is never removed");
  assert.equal(existsSync(join(agentDir, "skills", "standalone", "SKILL.md")), true);
});

test("when keeping the Skill fails, nothing is removed", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-skill-removal-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const agentDir = join(sandbox, "agent");
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };
  await mkdir(join(agentDir, "skills", "pack", "only"), { recursive: true });
  await writeFile(join(agentDir, "skills", "pack", "only", "SKILL.md"), "---\nname: only\n---\n");

  await assert.rejects(
    removePiSkill(sandbox, {
      skillPath: join(agentDir, "skills", "pack", "only", "SKILL.md"),
      scope: "user",
      keep: async () => { throw new Error("Recently deleted is unavailable"); },
    }, provider),
    /Recently deleted is unavailable/,
  );
  assert.equal(existsSync(join(agentDir, "skills", "pack", "only", "SKILL.md")), true);
});

test("Skill removal refuses anything outside work-fold's import roots, links, and the root itself", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-skill-removal-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const agentDir = join(sandbox, "agent");
  const workFolderRoot = join(sandbox, "work-folder");
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };
  await mkdir(join(agentDir, "skills", "real"), { recursive: true });
  await mkdir(join(sandbox, "elsewhere", "other"), { recursive: true });
  await mkdir(join(sandbox, "elsewhere", "nested", "skill"), { recursive: true });
  await mkdir(workFolderRoot, { recursive: true });
  await writeFile(join(agentDir, "skills", "real", "SKILL.md"), "---\nname: real\n---\n");
  await writeFile(join(agentDir, "skills", "SKILL.md"), "---\nname: root-level\n---\n");
  await writeFile(join(sandbox, "elsewhere", "other", "SKILL.md"), "---\nname: other\n---\n");
  await writeFile(join(sandbox, "elsewhere", "nested", "skill", "SKILL.md"), "---\nname: nested\n---\n");
  await symlink(join(sandbox, "elsewhere", "other"), join(agentDir, "skills", "linked"));
  await symlink(join(sandbox, "elsewhere", "nested"), join(agentDir, "skills", "linked-parent"));

  await assert.rejects(
    removePiSkill(workFolderRoot, { skillPath: join(sandbox, "elsewhere", "other", "SKILL.md"), scope: "user", keep: neverKeep }, provider),
    /not stored in your Pi skills folder/,
  );
  await assert.rejects(
    removePiSkill(workFolderRoot, { skillPath: join(agentDir, "skills", "SKILL.md"), scope: "user", keep: neverKeep }, provider),
    /not stored in your Pi skills folder/,
    "a SKILL.md directly at the root would otherwise take the root",
  );
  await assert.rejects(
    removePiSkill(workFolderRoot, { skillPath: join(agentDir, "skills", "linked", "SKILL.md"), scope: "user", keep: neverKeep }, provider),
    /not an ordinary directory/,
  );
  await assert.rejects(
    removePiSkill(workFolderRoot, { skillPath: join(agentDir, "skills", "linked-parent", "skill", "SKILL.md"), scope: "user", keep: neverKeep }, provider),
    /resolves outside work-fold's import root/,
    "a symlink above the Skill directory cannot redirect removal outside the import root",
  );
  await assert.rejects(
    removePiSkill(workFolderRoot, { skillPath: join(agentDir, "skills", "real", "notes.md"), scope: "user", keep: neverKeep }, provider),
    /SKILL\.md identifies it/,
  );
  await assert.rejects(
    removePiSkill(workFolderRoot, { skillPath: join(workFolderRoot, ".pi", "skills", "x", "SKILL.md"), scope: "project", keep: neverKeep }, provider),
    /Trust this work-folder/,
    "work-folder-scoped removal needs the same explicit trust as work-folder-scoped installs",
  );
  assert.equal(existsSync(join(sandbox, "elsewhere", "other", "SKILL.md")), true);
  assert.equal(existsSync(join(sandbox, "elsewhere", "nested", "skill", "SKILL.md")), true);
  assert.equal(existsSync(join(agentDir, "skills", "real", "SKILL.md")), true);
});

test("a removed Skill goes back to the same path in either scope, recreating an emptied bundle folder", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-skill-restore-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const agentDir = join(sandbox, "agent");
  const workFolderRoot = join(sandbox, "work-folder");
  const provider: PiRuntimeProvider = {
    async resolveRuntime() { return { agentDir, projectTrust: { override: true } }; },
  };
  const everywhere = join(agentDir, "skills", "pack", "writer");
  const local = join(workFolderRoot, ".pi", "skills", "notes");
  await mkdir(everywhere, { recursive: true });
  await mkdir(local, { recursive: true });
  await writeFile(join(everywhere, "SKILL.md"), "---\nname: writer\n---\n");
  await writeFile(join(local, "SKILL.md"), "---\nname: notes\n---\n");
  const holding = holdingArea(sandbox);

  const removedEverywhere = await removePiSkill(workFolderRoot, { skillPath: join(everywhere, "SKILL.md"), scope: "user", keep: holding.keep }, provider);
  const removedLocal = await removePiSkill(workFolderRoot, { skillPath: join(local, "SKILL.md"), scope: "project", keep: holding.keep }, provider);
  assert.equal(existsSync(join(agentDir, "skills", "pack")), false);
  assert.equal(holding.handed[1]!.relativePath, "notes");
  assert.equal(holding.handed[1]!.skillsRoot, join(workFolderRoot, ".pi", "skills"));

  // Like the store's restoreTree: the parent folder is created, the kept folder moves into place.
  const putBack = (kept: string) => async (destination: string) => {
    await mkdir(dirname(destination), { recursive: true });
    await rename(kept, destination);
    return destination;
  };
  const back = await restorePiSkill(workFolderRoot, {
    scope: "user", relativePath: "pack/writer", skillName: "writer", putBack: putBack(removedEverywhere.kept),
  }, provider);
  assert.equal(back.restoredPath, everywhere);
  assert.equal(await readFile(join(everywhere, "SKILL.md"), "utf8"), "---\nname: writer\n---\n");
  const backLocal = await restorePiSkill(workFolderRoot, {
    scope: "project", relativePath: "notes", skillName: "notes", putBack: putBack(removedLocal.kept),
  }, provider);
  assert.equal(backLocal.restoredPath, local);
  assert.equal(existsSync(join(local, "SKILL.md")), true);
});

test("restoring refuses a same-named Skill, an occupied folder, a linked parent, and an untrusted work-folder", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-skill-restore-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const agentDir = join(sandbox, "agent");
  const workFolderRoot = join(sandbox, "work-folder");
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };
  await mkdir(join(agentDir, "skills", "writer-v2"), { recursive: true });
  await mkdir(join(agentDir, "skills", "occupied"), { recursive: true });
  await mkdir(join(sandbox, "elsewhere"), { recursive: true });
  await mkdir(workFolderRoot, { recursive: true });
  // The same Skill imported again in the meantime, under a different folder.
  await writeFile(join(agentDir, "skills", "writer-v2", "SKILL.md"), "---\nname: \"writer\"\n---\n");
  await symlink(join(sandbox, "elsewhere"), join(agentDir, "skills", "linked"));
  const neverPutBack = async (): Promise<never> => {
    throw new Error("a refused restore must never move anything");
  };

  await assert.rejects(
    restorePiSkill(workFolderRoot, { scope: "user", relativePath: "pack/writer", skillName: "writer", putBack: neverPutBack }, provider),
    (error: unknown) => error instanceof PiSkillRestoreConflictError
      && /A Skill named "writer" is already installed Everywhere \(writer-v2\)/.test(error.message),
  );
  await assert.rejects(
    restorePiSkill(workFolderRoot, { scope: "user", relativePath: "occupied", skillName: "fresh", putBack: neverPutBack }, provider),
    (error: unknown) => error instanceof PiSkillRestoreConflictError && /Something is already at occupied Everywhere/.test(error.message),
  );
  await assert.rejects(
    restorePiSkill(workFolderRoot, { scope: "user", relativePath: "linked/fresh", skillName: "fresh", putBack: neverPutBack }, provider),
    /not an ordinary folder/,
  );
  await assert.rejects(
    restorePiSkill(workFolderRoot, { scope: "user", relativePath: "../outside", skillName: "fresh", putBack: neverPutBack }, provider),
    /path is invalid/,
  );
  await assert.rejects(
    restorePiSkill(workFolderRoot, { scope: "project", relativePath: "notes", skillName: "notes", putBack: neverPutBack }, provider),
    /Trust this work-folder/,
  );
  assert.equal(existsSync(join(sandbox, "elsewhere", "fresh")), false);
});
