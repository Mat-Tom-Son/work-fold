import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listNativeResources, setNativeResourceEnabled } from "../src/local/agent/resource-lifecycle.js";
import { loadAgentSkillCatalog } from "../src/local/agent/skill-catalog.js";

test("native resource inventory is inert and exact resource filters survive reload and preserve scopes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-resources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = join(root, "space"), agentDir = join(root, "agent");
  const provider = { resolveRuntime: async () => ({ agentDir, projectTrust: { override: true } }) };
  await mkdir(join(space, ".pi", "extensions"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  const marker = join(root, "executed");
  const a = join(space, ".pi", "extensions", "a.ts");
  const b = join(space, ".pi", "extensions", "b.ts");
  await writeFile(a, `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync(${JSON.stringify(marker)},'yes')}`);
  await writeFile(b, "export default function(){}");
  await writeFile(join(agentDir, "extensions", "personal.ts"), "export default function(){}");
  assert.equal((await listNativeResources(space, provider)).filter((item) => item.kind === "extensions").length, 3);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  await setNativeResourceEnabled(space, { path: a, kind: "extensions", scope: "project", enabled: false }, provider);
  const disabled = await listNativeResources(space, provider);
  assert.equal(disabled.find((item) => item.path === a)?.enabled, false);
  assert.equal(disabled.find((item) => item.path === b)?.enabled, true);
  assert.equal(disabled.find((item) => item.path.endsWith("personal.ts"))?.enabled, true);
  const catalog = await loadAgentSkillCatalog(space, provider);
  assert.ok(!catalog.extensions.some((item) => item.resolvedPath === a));
  assert.equal(catalog.resources?.find((item) => item.path === a)?.enabled, false);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  await setNativeResourceEnabled(space, { path: a, kind: "extensions", scope: "project", enabled: true }, provider);
  assert.equal((await listNativeResources(space, provider)).find((item) => item.path === a)?.enabled, true);
  await assert.rejects(setNativeResourceEnabled(space, { path: a, kind: "extensions", scope: "user", enabled: false }, provider), /no longer present/);
});

test("enabling one entry in an empty package filter preserves disabled siblings and other resource filters", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-package-filter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = join(root, "space"), agentDir = join(root, "agent"), pkg = join(root, "package");
  await mkdir(space); await mkdir(agentDir); await mkdir(join(pkg, "extensions"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "test-package", pi: { extensions: ["extensions/*.ts", "!extensions/private.ts"] } }));
  for (const name of ["a", "b", "private"]) await writeFile(join(pkg, "extensions", `${name}.ts`), "export default function(){}");
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ packages: [{ source: pkg, extensions: [], skills: ["!secret/**"] }], theme: "light" }));
  const provider = { resolveRuntime: async () => ({ agentDir, projectTrust: { override: true } }) };
  const a = join(pkg, "extensions", "a.ts");
  await setNativeResourceEnabled(space, { path: a, kind: "extensions", scope: "user", enabled: true }, provider);
  const resources = await listNativeResources(space, provider);
  assert.deepEqual(resources.filter((item) => item.kind === "extensions" && item.enabled).map((item) => item.path), [a]);
  assert.ok(!resources.some((item) => item.path.endsWith("private.ts")));
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(settings.packages[0].skills, ["!secret/**"]);
  assert.equal(settings.theme, "light");
  await setNativeResourceEnabled(space, { path: a, kind: "extensions", scope: "user", enabled: false }, provider);
  assert.equal((await listNativeResources(space, provider)).filter((item) => item.enabled && item.kind === "extensions").length, 0);
});

test("enabling native path aliases removes equivalent force exclusions without changing siblings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-resource-aliases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = join(root, "space"), agentDir = join(root, "agent"), piDir = join(space, ".pi");
  await mkdir(join(piDir, "extensions"), { recursive: true });
  await mkdir(agentDir);
  const a = join(piDir, "extensions", "a.ts"), b = join(piDir, "extensions", "b.ts");
  const marker = join(root, "a-loaded");
  await writeFile(a, `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync(${JSON.stringify(marker)},'yes')}`);
  await writeFile(b, "export default function(){}");
  const settingsPath = join(piDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ extensions: ["!extensions/*", "-./extensions/a.ts", `-${a}`, "+extensions/b.ts"] }));
  const provider = { resolveRuntime: async () => ({ agentDir, projectTrust: { override: true } }) };
  assert.equal((await listNativeResources(space, provider)).find((item) => item.path === a)?.enabled, false);
  await setNativeResourceEnabled(space, { path: a, kind: "extensions", scope: "project", enabled: true }, provider);
  const resources = await listNativeResources(space, provider);
  assert.equal(resources.find((item) => item.path === a)?.enabled, true);
  assert.equal(resources.find((item) => item.path === b)?.enabled, true);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).extensions, ["!extensions/*", "+extensions/b.ts", `+${a}`]);
  const catalog = await loadAgentSkillCatalog(space, provider);
  assert.ok(catalog.extensions.some((item) => item.resolvedPath === a));
  assert.equal(await readFile(marker, "utf8"), "yes");
});

test("Skill directory and SKILL.md exclusions identify the same native resource", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-skill-aliases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = join(root, "space"), agentDir = join(root, "agent");
  await mkdir(space);
  for (const name of ["a", "b"]) {
    await mkdir(join(agentDir, "skills", name), { recursive: true });
    await writeFile(join(agentDir, "skills", name, "SKILL.md"), `---\nname: fixture-${name}\ndescription: A fixture Skill.\n---\nInstructions.`);
  }
  const aDir = join(agentDir, "skills", "a"), a = join(aDir, "SKILL.md"), b = join(agentDir, "skills", "b", "SKILL.md");
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ skills: ["-skills/a", "-./skills/a/SKILL.md", `-${aDir}`, "-skills/b"] }));
  const provider = { resolveRuntime: async () => ({ agentDir, projectTrust: { override: true } }) };
  await setNativeResourceEnabled(space, { path: a, kind: "skills", scope: "user", enabled: true }, provider);
  const resources = await listNativeResources(space, provider);
  assert.equal(resources.find((item) => item.path === a)?.enabled, true);
  assert.equal(resources.find((item) => item.path === b)?.enabled, false);
  const catalog = await loadAgentSkillCatalog(space, provider);
  assert.ok(catalog.skills.some((item) => item.path === a));
  assert.ok(!catalog.skills.some((item) => item.path === b));
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).skills, ["-skills/b", `+${a}`]);
});

test("package toggles remove absolute and relative aliases for only the selected resource", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-package-aliases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = join(root, "space"), agentDir = join(root, "agent"), pkg = join(root, "package");
  await mkdir(space); await mkdir(agentDir); await mkdir(join(pkg, "extensions"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture", pi: { extensions: ["extensions/*.ts"] } }));
  const a = join(pkg, "extensions", "a.ts"), b = join(pkg, "extensions", "b.ts");
  for (const path of [a, b]) await writeFile(path, "export default function(){}");
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ packages: [{ source: pkg, extensions: ["-./extensions/a.ts", `-${a}`, "-extensions/b.ts"] }] }));
  const provider = { resolveRuntime: async () => ({ agentDir, projectTrust: { override: true } }) };
  await setNativeResourceEnabled(space, { path: a, kind: "extensions", scope: "user", enabled: true }, provider);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).packages[0].extensions, ["-extensions/b.ts", "+extensions/a.ts"]);
  const catalog = await loadAgentSkillCatalog(space, provider);
  assert.ok(catalog.extensions.some((item) => item.resolvedPath === a));
  assert.ok(!catalog.extensions.some((item) => item.resolvedPath === b));
});

test("turning off a string-configured package resource never enables manifest-omitted kinds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-package-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = join(root, "space"), agentDir = join(root, "agent"), pkg = join(root, "package");
  await mkdir(space); await mkdir(agentDir);
  for (const dir of ["extensions", "skills/unadvertised", "prompts", "themes"]) await mkdir(join(pkg, dir), { recursive: true });
  const a = join(pkg, "extensions", "a.ts");
  await writeFile(a, "export default function(){}");
  await writeFile(join(pkg, "skills", "unadvertised", "SKILL.md"), "---\nname: unadvertised\ndescription: Must stay excluded.\n---\nInstructions.");
  await writeFile(join(pkg, "prompts", "unadvertised.md"), "An undeclared prompt.");
  await writeFile(join(pkg, "themes", "unadvertised.json"), "{}");
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture", pi: { extensions: ["extensions/a.ts"] } }));
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ packages: [pkg], theme: "light" }));
  const provider = { resolveRuntime: async () => ({ agentDir, projectTrust: { override: true } }) };
  await setNativeResourceEnabled(space, { path: a, kind: "extensions", scope: "user", enabled: false }, provider);
  assert.ok(!(await listNativeResources(space, provider)).some((item) => item.path.startsWith(pkg) && item.enabled));
  const catalog = await loadAgentSkillCatalog(space, provider);
  assert.ok(!catalog.skills.some((item) => item.path.startsWith(pkg)));
  assert.ok(!catalog.prompts.some((item) => item.path.startsWith(pkg)));
  assert.ok(!catalog.extensions.some((item) => item.resolvedPath.startsWith(pkg)));
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  for (const kind of ["skills", "prompts", "themes"]) assert.deepEqual(settings.packages[0][kind], []);
  assert.equal(settings.theme, "light");
  await setNativeResourceEnabled(space, { path: a, kind: "extensions", scope: "user", enabled: true }, provider);
  const enabled = (await listNativeResources(space, provider)).filter((item) => item.path.startsWith(pkg) && item.enabled);
  assert.deepEqual(enabled.map((item) => item.path), [a]);
});

test("single-file package disablement fails honestly without changing settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-single-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = join(root, "space"), agentDir = join(root, "agent"), single = join(root, "single.ts");
  await mkdir(space); await mkdir(agentDir); await writeFile(single, "export default function(){}");
  const settingsPath = join(agentDir, "settings.json");
  const original = JSON.stringify({ packages: [single] });
  await writeFile(settingsPath, original);
  const provider = { resolveRuntime: async () => ({ agentDir, projectTrust: { override: true } }) };
  await assert.rejects(setNativeResourceEnabled(space, { path: single, kind: "extensions", scope: "user", enabled: false }, provider), /single-file package/);
  assert.equal(await readFile(settingsPath, "utf8"), original);
  const catalog = await loadAgentSkillCatalog(space, provider);
  assert.ok(catalog.extensions.some((item) => item.resolvedPath === single));
  assert.equal(catalog.resources?.find((item) => item.path === single)?.enabled, true);
});

test("autoload-disabled package resources stay discoverable without imports and enable individually", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-package-dormant-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = join(root, "space"), agentDir = join(root, "agent"), pkg = join(root, "package");
  await mkdir(space); await mkdir(agentDir); await mkdir(join(pkg, "extensions"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture", pi: { extensions: ["extensions/*.ts", "!extensions/private.ts"] } }));
  for (const name of ["a", "b", "private"]) await writeFile(join(pkg, "extensions", `${name}.ts`), `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync(${JSON.stringify(join(root, `${name}-loaded`))},'yes')}`);
  const settingsPath = join(agentDir, "settings.json");
  const original = JSON.stringify({ packages: [{ source: pkg, autoload: false, extensions: [] }] });
  await writeFile(settingsPath, original);
  const provider = { resolveRuntime: async () => ({ agentDir, projectTrust: { override: true } }) };
  const a = join(pkg, "extensions", "a.ts"), b = join(pkg, "extensions", "b.ts");
  const dormant = (await listNativeResources(space, provider)).filter((item) => item.path.startsWith(pkg));
  assert.deepEqual(dormant.map((item) => item.path).sort(), [a, b]);
  assert.ok(dormant.every((item) => !item.enabled));
  assert.equal(await readFile(settingsPath, "utf8"), original);
  assert.ok(!(await loadAgentSkillCatalog(space, provider)).extensions.some((item) => item.resolvedPath.startsWith(pkg)));
  for (const name of ["a", "b", "private"]) await assert.rejects(readFile(join(root, `${name}-loaded`)), { code: "ENOENT" });
  await setNativeResourceEnabled(space, { path: a, kind: "extensions", scope: "user", enabled: true }, provider);
  const catalog = await loadAgentSkillCatalog(space, provider);
  assert.ok(catalog.extensions.some((item) => item.resolvedPath === a));
  assert.ok(!catalog.extensions.some((item) => item.resolvedPath === b));
  assert.equal(catalog.resources?.find((item) => item.path === b)?.enabled, false);
  assert.equal(await readFile(join(root, "a-loaded"), "utf8"), "yes");
  await assert.rejects(readFile(join(root, "b-loaded")), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).packages[0].autoload, false);
});

test("project package deltas retain global inheritance and exact scope during inventory and toggles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-package-delta-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = join(root, "space"), agentDir = join(root, "agent"), pkg = join(root, "package");
  await mkdir(join(space, ".pi"), { recursive: true }); await mkdir(agentDir); await mkdir(join(pkg, "extensions"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture", pi: { extensions: ["extensions/*.ts"] } }));
  const a = join(pkg, "extensions", "a.ts"), b = join(pkg, "extensions", "b.ts");
  for (const path of [a, b]) await writeFile(path, "export default function(){}");
  const global = JSON.stringify({ packages: [pkg] });
  await writeFile(join(agentDir, "settings.json"), global);
  await writeFile(join(space, ".pi", "settings.json"), JSON.stringify({ packages: [{ source: pkg, autoload: false, extensions: ["-extensions/a.ts"] }] }));
  const provider = { resolveRuntime: async () => ({ agentDir, projectTrust: { override: true } }) };
  const resources = (await listNativeResources(space, provider)).filter((item) => item.path.startsWith(pkg));
  assert.equal(resources.length, 2);
  assert.equal(resources.find((item) => item.path === a)?.metadata.scope, "project");
  assert.equal(resources.find((item) => item.path === a)?.enabled, false);
  assert.equal(resources.find((item) => item.path === b)?.metadata.scope, "user");
  assert.equal(resources.find((item) => item.path === b)?.enabled, true);
  await setNativeResourceEnabled(space, { path: a, kind: "extensions", scope: "project", enabled: true }, provider);
  const catalog = await loadAgentSkillCatalog(space, provider);
  assert.ok(catalog.extensions.some((item) => item.resolvedPath === a));
  assert.ok(catalog.extensions.some((item) => item.resolvedPath === b));
  assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), global);
});

test("relative Skill aliases shared by .pi and ancestor .agents roots preserve sibling choices", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-multi-root-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = join(root, "space"), agentDir = join(root, "agent");
  const local = join(space, ".pi", "skills", "shared", "SKILL.md");
  const ancestor = join(root, ".agents", "skills", "shared", "SKILL.md");
  await mkdir(agentDir);
  for (const path of [local, ancestor]) {
    await mkdir(path.slice(0, -"/SKILL.md".length), { recursive: true });
    await writeFile(path, "---\nname: shared\ndescription: A fixture Skill.\n---\nInstructions.");
  }
  const settingsPath = join(space, ".pi", "settings.json");
  const provider = { resolveRuntime: async () => ({ agentDir, projectTrust: { override: true } }) };
  for (const [patterns, enableLocal, expectedAncestor] of [
    [["-skills/shared"], true, false],
    [["!skills/**", "+skills/shared"], false, true],
  ] as const) {
    await writeFile(settingsPath, JSON.stringify({ skills: patterns }));
    await setNativeResourceEnabled(space, { path: local, kind: "skills", scope: "project", enabled: enableLocal }, provider);
    const resources = await listNativeResources(space, provider);
    assert.equal(resources.find((item) => item.path === local)?.enabled, enableLocal);
    assert.equal(resources.find((item) => item.path === ancestor)?.enabled, expectedAncestor);
    const catalog = await loadAgentSkillCatalog(space, provider);
    assert.equal(catalog.skills.some((item) => item.path === local), enableLocal);
    assert.equal(catalog.skills.some((item) => item.path === ancestor), expectedAncestor);
  }
});
