import { execFileSync } from "node:child_process";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Offline, read-only checks over the checkout. No provider/harness credentials,
// personal settings, network calls, or dependency installation are needed.
export async function inspectRepository(root) {
  root = await realpath(resolve(root));
  const problems = [];
  const git = (args, input) => {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }); }
    catch (error) {
      if (args[0] === "check-ignore" && error.status === 1) return error.stdout;
      throw error;
    }
  };
  const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const candidates = [...new Set([...tracked, ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)])];
  const files = [];
  for (const file of candidates) {
    try { await lstat(resolve(root, file)); files.push(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const present = new Set(files);
  const fail = (file, message) => problems.push(`${file}: ${message}`);
  const read = async (file) => {
    const path = await realpath(resolve(root, file));
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      fail(file, "file resolves outside the checkout");
      return "";
    }
    return readFile(path, "utf8");
  };
  for (const required of ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "docs/README.md", "package.json", ".nvmrc"]) {
    if (!present.has(required)) fail(required, "missing shared onboarding file");
  }
  if (present.has("CLAUDE.md")) {
    const claude = await read("CLAUDE.md");
    const imports = [...withoutCode(claude).matchAll(/(?:^|\s)@([^\s`]+)/g)].map((match) => match[1]);
    if (imports.length !== 1 || imports[0] !== "AGENTS.md") fail("CLAUDE.md", "must import only @AGENTS.md; keep shared policy there");
  }
  if (present.has("AGENTS.md") && Buffer.byteLength(await read("AGENTS.md")) > 32 * 1024) {
    fail("AGENTS.md", "exceeds Codex's default 32 KiB instruction budget; move task-specific detail into linked docs");
  }
  if (present.has(".nvmrc") && (await read(".nvmrc")).trim() !== "24") fail(".nvmrc", "must match the Node 24 contributor and CI lane");

  const skills = new Set(files.flatMap((file) => /^\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(file)?.slice(1) ?? []));
  for (const name of skills) {
    const source = `.agents/skills/${name}/SKILL.md`;
    const link = `.claude/skills/${name}`;
    const text = await read(source);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    const declaredName = /^name:\s*["']?([^\r\n"']+)["']?\s*$/m.exec(frontmatter)?.[1]?.trim();
    if (declaredName !== name || !/^description:\s*\S/m.test(frontmatter)) fail(source, "needs matching name and nonempty description frontmatter");
    if (!present.has(link)) {
      fail(link, `missing shared Skill link; create ../../.agents/skills/${name} and allow that link in .gitignore`);
    } else if (!(await lstat(resolve(root, link))).isSymbolicLink()) {
      fail(link, "must be a symlink, not a copy; enable Git symlink support if the checkout flattened it");
    } else if ((await readlink(resolve(root, link))).replaceAll("\\", "/") !== `../../.agents/skills/${name}`) {
      fail(link, `must point to ../../.agents/skills/${name}`);
    }
    // The release Skill's resource paths are also written as code spans.
    for (const match of text.matchAll(/`((?:\.\.?\/)[^`]+\.md)`/g)) await checkLink(source, match[1]);
  }
  for (const file of files) {
    if (file.startsWith(".claude/") && ![...skills].some((name) => file === `.claude/skills/${name}`)) {
      fail(file, "only shared Skill symlinks belong in tracked .claude state");
    }
    if (/^(?:\.codex|\.agent)\//.test(file) || /(?:^|\/)(?:AGENTS\.override\.md|CLAUDE\.local\.md)$/.test(file)) {
      fail(file, "machine-local or shadow instructions must not be committed");
    }
    if (file !== "AGENTS.md" && /(?:^|\/)AGENTS\.md$/.test(file)) fail(file, "shared contributor policy belongs in root AGENTS.md");
    if (file !== "CLAUDE.md" && /(?:^|\/)CLAUDE\.md$/.test(file)) fail(file, "use the root Claude entrypoint instead of a second contract");
    if (file.startsWith(".agents/skills/") && ![...skills].some((name) => file.startsWith(`.agents/skills/${name}/`))) fail(file, "shared Skill directory needs SKILL.md");
  }
  for (const file of git(["ls-files", "-ci", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) {
    fail(file, "tracked despite ignore rules; remove local/generated state from the index, not from your disk");
  }
  const probes = [".env", ".env.railway.local", ".env.macos.local", ".codex/config.toml", ".agent/local.md", "AGENTS.override.md", ".claude/settings.local.json", ".claude/launch.json", "CLAUDE.local.md", "node_modules/repo-probe", "out/repo-probe", "output/repo-probe"];
  const ignored = new Set(git(["check-ignore", "--no-index", "-z", "--stdin"], `${probes.join("\0")}\0`).split("\0"));
  for (const probe of probes) if (!ignored.has(probe)) fail(".gitignore", `must exclude ${probe}`);

  const localState = (file) => /^(?:\.claude|\.codex|\.agent)\//.test(file)
    || /(?:^|\/)(?:AGENTS\.override\.md|CLAUDE\.local\.md)$/.test(file);
  const documents = files.filter((file) => file.endsWith(".md") && !localState(file));
  const packages = new Map();
  for (const file of files.filter((file) => /(?:^|\/)package\.json$/.test(file) && !localState(file))) {
    packages.set(dirname(file), JSON.parse(await read(file)).scripts ?? {});
  }
  for (const file of documents) {
    const source = await read(file);
    const prose = withoutCode(source);
    for (const href of markdownDestinations(prose)) await checkLink(file, href);
    // Dated releases retain the commands that were true at publication time.
    if (file.startsWith("docs/releases/")) continue;
    let folder = dirname(file);
    while (!packages.has(folder) && folder !== ".") folder = dirname(folder);
    for (const match of source.matchAll(/\bnpm\s+(?:--prefix\s+(\S+)\s+)?run\s+(?:--silent\s+)?([a-z][\w:-]*)/g)) {
      const packageFolder = match[1] ? relative(root, resolve(root, match[1])) || "." : folder;
      if (!Object.hasOwn(packages.get(packageFolder) ?? {}, match[2])) fail(file, `unknown npm script ${match[2]} in ${packageFolder}/package.json`);
    }
  }
  return { problems: [...new Set(problems)], documents: documents.length, skills: skills.size };

  async function checkLink(file, href) {
    if (/^(?:[a-z][\w+.-]*:|#|\/\/)/i.test(href)) return;
    let path;
    try { path = decodeURIComponent(href.split(/[?#]/, 1)[0]); }
    catch { fail(file, `invalid encoded link ${href}`); return; }
    if (!path) return;
    const target = resolve(root, dirname(file), path);
    const local = relative(root, target);
    if (local.startsWith(`..${sep}`) || local === ".." || path.startsWith("/")) {
      fail(file, `link escapes the checkout: ${href}`); return;
    }
    // A private/generated file on the maintainer's machine must not mask a
    // broken link for someone cloning the repository.
    const portable = local.split(sep).join("/");
    if (!present.has(portable) && !files.some((item) => item.startsWith(`${portable}/`))) {
      fail(file, `missing repository link ${href}`); return;
    }
    try {
      const resolved = await realpath(target);
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) fail(file, `link resolves outside the checkout: ${href}`);
    } catch { fail(file, `broken link ${href}`); }
  }
}

function withoutCode(text) {
  return text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "").replace(/`+[^`\n]*`+/g, "");
}

export function markdownDestinations(text) {
  return [
    ...[...text.matchAll(/\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)].map((match) => match[1] ?? match[2]),
    ...[...text.matchAll(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)].map((match) => match[1] ?? match[2]),
    ...[...text.matchAll(/\b(?:src|href|srcset)="([^"]+)"/g)].map((match) => match[1]),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await inspectRepository(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
    if (result.problems.length) {
      console.error(`Repository checks found ${result.problems.length} issue(s):\n${result.problems.map((problem) => `- ${problem}`).join("\n")}`);
      process.exitCode = 1;
    } else console.log(`Repository checks passed (${result.documents} documents, ${result.skills} shared Skill${result.skills === 1 ? "" : "s"}).`);
  } catch (error) {
    console.error(`Repository checks could not run: ${error.message}`);
    process.exitCode = 1;
  }
}
