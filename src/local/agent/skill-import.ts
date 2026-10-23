import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import JSZip from "jszip";

import {
  hasExplicitPiProjectMutationTrust,
  resolvePiRuntime,
  type PiRuntimeProvider,
} from "./pi-runtime-config.js";

export interface PiSkillBundleImportResult {
  scope: "user" | "project";
  bundlePath: string;
  skills: Array<{ name: string; relativePath: string }>;
}

/** Canonical content identity for a skill bundle: sha256 hex over the exact bytes. */
export function piSkillBundleContentDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Digest-verified import for the prepared `capability.skills.import` act
 * (docs/receipts-not-gates.md, F19). The prepared act pins the exact bytes
 * that were enumerated when it was prepared; this path refuses changed
 * content before any archive parsing, mirroring the restricted-app install
 * path's revision-changed posture, so the execution can only ever run the
 * bytes the receipt names.
 */
export async function importPiSkillBundleVerified(
  workFolderRoot: string,
  input: {
    fileName: string;
    bytes: Uint8Array;
    scope?: "user" | "project";
    expectedContentDigest: string;
  },
  runtimeProvider?: PiRuntimeProvider,
): Promise<PiSkillBundleImportResult> {
  const observed = piSkillBundleContentDigest(input.bytes);
  if (observed !== input.expectedContentDigest) {
    throw new Error("The skill bundle changed after it was reviewed. Restage the import from the current content.");
  }
  const { expectedContentDigest: _expected, ...importInput } = input;
  return importPiSkillBundle(workFolderRoot, importInput, runtimeProvider);
}

/**
 * Imports Agent Skills/Anthropic skill-pack ZIPs without enabling any bundled
 * extensions, hooks, MCP servers, or agents. The complete skill directories
 * are preserved so scripts, references, assets, and templates keep working.
 */
export async function importPiSkillBundle(
  workFolderRoot: string,
  input: {
    fileName: string;
    bytes: Uint8Array;
    scope?: "user" | "project";
  },
  runtimeProvider?: PiRuntimeProvider,
): Promise<PiSkillBundleImportResult> {
  if (input.bytes.byteLength === 0) throw new Error("The skill bundle is empty.");
  if (input.bytes.byteLength > maxArchiveBytes) throw new Error("The skill bundle exceeds the 100 MB archive limit.");
  const extension = extname(input.fileName).toLowerCase();
  if (extension === ".md") {
    if (basename(input.fileName).toLowerCase() !== "skill.md") {
      throw new Error("A standalone Markdown skill must be named SKILL.md.");
    }
    return importStandaloneSkill(workFolderRoot, input, runtimeProvider);
  }
  if (extension !== ".zip" && extension !== ".skill") {
    throw new Error("Skills must be a SKILL.md file or use a .zip or .skill bundle.");
  }

  const runtime = await resolvePiRuntime(workFolderRoot, runtimeProvider, { requestProjectTrust: false });
  const scope = input.scope ?? "user";
  if (scope === "project" && !hasExplicitPiProjectMutationTrust(runtime)) {
    throw new Error("Trust this work-folder before importing work-folder-scoped Skills.");
  }

  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(input.bytes, {
      createFolders: true,
    });
  } catch (error) {
    throw new Error(`Could not read the skill bundle: ${errorMessage(error)}`);
  }

  const entries = Object.values(archive.files);
  if (entries.length > maxArchiveEntries) throw new Error("The skill bundle contains too many files.");
  const normalized = entries.map((entry) => ({ entry, path: safeArchivePath(entry.name) }));
  const skillFiles = normalized.filter(({ entry, path }) => !entry.dir && basename(path).toLowerCase() === "skill.md");
  if (!skillFiles.length) throw new Error("The bundle does not contain a SKILL.md file.");
  const skillRoots = [...new Set(skillFiles.map(({ path }) => normalizeArchiveDir(dirname(path))))];
  const skillEntries = normalized.filter(({ path }) => skillRoots.some((root) => belongsToSkillRoot(path, root)));

  const destinationRoot = scope === "project"
    ? join(workFolderRoot, ".pi", "skills")
    : join(runtime.agentDir, "skills");
  await mkdir(destinationRoot, { recursive: true });
  const bundleName = safeBundleName(input.fileName);
  const destination = join(destinationRoot, bundleName);
  if (existsSync(destination)) {
    throw new Error(`A skill bundle named "${bundleName}" is already installed in this scope.`);
  }

  const stagingParent = await mkdtemp(join(destinationRoot, ".skill-import-"));
  const stagedBundle = join(stagingParent, bundleName);
  let uncompressedBytes = 0;
  try {
    await mkdir(stagedBundle, { recursive: true });
    for (const { entry, path } of skillEntries) {
      if (isSymlink(entry)) throw new Error(`Skill bundles cannot contain symbolic links: ${path}`);
      const target = join(stagedBundle, ...path.split("/"));
      if (entry.dir) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      let entryBytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          entryBytes += chunk.byteLength;
          uncompressedBytes += chunk.byteLength;
          if (entryBytes > maxSingleEntryBytes) return callback(new Error(`Skill file exceeds the 100 MB limit: ${path}`));
          if (uncompressedBytes > maxUncompressedBytes) return callback(new Error("The expanded skill bundle exceeds the 500 MB limit."));
          callback(null, chunk);
        },
      });
      await pipeline(entry.nodeStream("nodebuffer"), limiter, createWriteStream(target, { flags: "wx" }));
    }
    await rename(stagedBundle, destination);
  } catch (error) {
    throw new Error(`Could not install the skill bundle: ${errorMessage(error)}`);
  } finally {
    await rm(stagingParent, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    scope,
    bundlePath: destination,
    skills: skillFiles.map(({ path }) => {
      const parent = dirname(path);
      return {
        name: parent === "." ? bundleName : basename(parent),
        relativePath: path,
      };
    }),
  };
}

async function importStandaloneSkill(
  workFolderRoot: string,
  input: { fileName: string; bytes: Uint8Array; scope?: "user" | "project" },
  runtimeProvider?: PiRuntimeProvider,
): Promise<PiSkillBundleImportResult> {
  if (input.bytes.byteLength > maxStandaloneSkillBytes) {
    throw new Error("A standalone SKILL.md file cannot exceed 2 MB.");
  }
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch {
    throw new Error("SKILL.md must contain valid UTF-8 text.");
  }
  const declaredName = skillFrontmatterName(markdown);
  if (!declaredName) throw new Error("SKILL.md must declare a name in YAML frontmatter.");

  const runtime = await resolvePiRuntime(workFolderRoot, runtimeProvider, { requestProjectTrust: false });
  const scope = input.scope ?? "user";
  if (scope === "project" && !hasExplicitPiProjectMutationTrust(runtime)) {
    throw new Error("Trust this work-folder before importing work-folder-scoped Skills.");
  }
  const destinationRoot = scope === "project"
    ? join(workFolderRoot, ".pi", "skills")
    : join(runtime.agentDir, "skills");
  await mkdir(destinationRoot, { recursive: true });
  const bundleName = safeBundleName(`${declaredName}.skill`);
  const destination = join(destinationRoot, bundleName);
  if (existsSync(destination)) {
    throw new Error(`A skill named "${bundleName}" is already installed in this scope.`);
  }

  const stagingParent = await mkdtemp(join(destinationRoot, ".skill-import-"));
  const stagedBundle = join(stagingParent, bundleName);
  try {
    await mkdir(stagedBundle, { recursive: true });
    await writeFile(join(stagedBundle, "SKILL.md"), input.bytes, { flag: "wx" });
    await rename(stagedBundle, destination);
  } catch (error) {
    throw new Error(`Could not install SKILL.md: ${errorMessage(error)}`);
  } finally {
    await rm(stagingParent, { recursive: true, force: true }).catch(() => undefined);
  }
  return {
    scope,
    bundlePath: destination,
    skills: [{ name: declaredName, relativePath: "SKILL.md" }],
  };
}

const maxArchiveBytes = 100 * 1024 * 1024;
const maxUncompressedBytes = 500 * 1024 * 1024;
const maxSingleEntryBytes = 100 * 1024 * 1024;
const maxArchiveEntries = 10_000;
const maxStandaloneSkillBytes = 2 * 1024 * 1024;

function skillFrontmatterName(markdown: string): string | null {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1];
  if (!frontmatter) return null;
  const rawName = /^name\s*:\s*(.+?)\s*$/im.exec(frontmatter)?.[1]?.trim();
  if (!rawName) return null;
  const unquoted = rawName.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted ?? "");
  return unquoted.trim() || null;
}

function normalizeArchiveDir(value: string): string {
  return value === "." ? "." : value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function belongsToSkillRoot(path: string, root: string): boolean {
  if (root !== ".") return path === root || path.startsWith(`${root}/`);
  const first = path.split("/")[0]?.toLocaleLowerCase() ?? "";
  return !blockedRootPluginEntries.has(first);
}

const blockedRootPluginEntries = new Set([
  ".claude-plugin",
  "agents",
  "commands",
  "hooks",
  "mcp",
  "mcp-servers",
  "marketplace.json",
  "plugin.json",
  "plugins",
]);

function safeArchivePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (
    !segments.length
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => segment === ".." || segment.includes("\0") || segment.includes(":"))
  ) {
    throw new Error(`Unsafe path in skill bundle: ${value}`);
  }
  return segments.join("/");
}

function safeBundleName(fileName: string): string {
  const withoutExtension = basename(fileName, extname(fileName));
  const cleaned = withoutExtension
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80);
  return cleaned || "skill-bundle";
}

function isSymlink(entry: JSZip.JSZipObject): boolean {
  const permissions = entry.unixPermissions;
  return typeof permissions === "number" && (permissions & 0o170000) === 0o120000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/** A validated imported Skill, as removal hands it over to be kept. */
export interface PiSkillRemovalCandidate {
  scope: "user" | "project";
  /** The Skill directory, an ordinary directory inside `skillsRoot`. */
  skillDir: string;
  /** The scope's import root: `<agentDir>/skills` or the work-folder's `.pi/skills`. */
  skillsRoot: string;
  /** `skillDir` inside `skillsRoot`, `/`-separated; what `restorePiSkill` takes back. */
  relativePath: string;
  /** The name Pi loads the Skill under: its frontmatter `name`, else its folder name. */
  skillName: string;
}

export interface PiSkillRemovalResult<K> {
  scope: "user" | "project";
  /** The Skill directory that left the import root. */
  removedPath: string;
  skillName: string;
  /** Whatever `keep` returned for the moved folder. */
  kept: K;
}

/**
 * Removes one imported Skill: the directory holding its `SKILL.md`, plus any
 * bundle folders above it that became empty. Only Skills inside work-fold's
 * own import roots (`<agentDir>/skills` for Everywhere, `.pi/skills` in the
 * work-folder) are eligible; Skills that arrived through a Pi package, a settings
 * path, or another location are managed where they were installed.
 *
 * Removal never erases the Skill. `.pi/` and Pi's own folder are outside
 * History, so `keep` must move the validated folder somewhere it can come back
 * from (Recently deleted, docs/receipts-not-gates.md F20); if `keep` throws,
 * nothing else is touched.
 */
export async function removePiSkill<K>(
  workFolderRoot: string,
  input: { skillPath: string; scope?: "user" | "project"; keep: (skill: PiSkillRemovalCandidate) => Promise<K> },
  runtimeProvider?: PiRuntimeProvider,
): Promise<PiSkillRemovalResult<K>> {
  const runtime = await resolvePiRuntime(workFolderRoot, runtimeProvider, { requestProjectTrust: false });
  const scope = input.scope ?? "user";
  if (scope === "project" && !hasExplicitPiProjectMutationTrust(runtime)) {
    throw new Error("Trust this work-folder before removing work-folder-scoped Skills.");
  }
  const root = piSkillsRoot(workFolderRoot, runtime.agentDir, scope);
  const skillFile = resolve(input.skillPath);
  if (basename(skillFile).toLowerCase() !== "skill.md") throw new Error("Only a Skill's SKILL.md identifies it for removal.");
  const skillDir = dirname(skillFile);
  const relativeDir = relative(root, skillDir);
  if (!relativeDir || relativeDir === "." || relativeDir.startsWith("..") || isAbsolute(relativeDir)) {
    throw new Error(scope === "project"
      ? "This Skill is not stored in this work-folder's .pi/skills folder, so work-fold cannot remove it from here."
      : "This Skill is not stored in your Pi skills folder, so work-fold cannot remove it from here.");
  }
  for (const segment of relativeDir.split(sep)) {
    if (!segment || segment === "." || segment === "..") throw new Error("The Skill path is invalid.");
  }
  const info = await lstat(skillDir).catch(() => null);
  if (!info) throw new Error("The Skill folder no longer exists.");
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("The Skill folder is not an ordinary directory.");
  const fileInfo = await lstat(skillFile).catch(() => null);
  if (!fileInfo || !fileInfo.isFile()) throw new Error("The Skill's SKILL.md no longer exists.");
  // Lexical containment is not enough: an ancestor below the import root may
  // itself be a symlink. Resolve both existing directories before the folder
  // is moved so `skills/linked/nested/SKILL.md` cannot take bytes from elsewhere.
  const [realRoot, realSkillDir] = await Promise.all([realpath(root), realpath(skillDir)]);
  const realRelativeDir = relative(realRoot, realSkillDir);
  if (!realRelativeDir || realRelativeDir === "." || realRelativeDir.startsWith("..") || isAbsolute(realRelativeDir)) {
    throw new Error("The Skill folder resolves outside work-fold's import root and cannot be removed.");
  }
  const skillName = await piSkillName(skillFile);
  const kept = await input.keep({ scope, skillDir, skillsRoot: root, relativePath: relativeDir.split(sep).join("/"), skillName });

  // A multi-Skill bundle folder that is now empty is removed as well so the
  // same bundle can be imported again later. Restoring recreates it.
  let parent = dirname(skillDir);
  while (parent !== root) {
    const parentRelative = relative(root, parent);
    if (!parentRelative || parentRelative.startsWith("..") || isAbsolute(parentRelative)) break;
    const entries = await readdir(parent).catch(() => null);
    if (entries === null || entries.length > 0) break;
    await rmdir(parent).catch(() => undefined);
    parent = dirname(parent);
  }
  return { scope, removedPath: skillDir, skillName, kept };
}

/** Restoring would put a second Skill under a name Pi already loads in that scope, or over an existing folder. */
export class PiSkillRestoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiSkillRestoreConflictError";
  }
}

/**
 * Puts a removed Skill back into the same scope's import root at the same
 * path inside it, through `putBack`, which moves the kept folder to the
 * destination it is given. The destination is re-derived from the current
 * runtime, never taken from the record, and every folder above it that
 * already exists must be an ordinary directory inside the root.
 *
 * Pi loads only the first Skill of a given name, so a restore that would sit
 * beside a Skill of the same name — such as the same Skill imported again in
 * the meantime — is refused with PiSkillRestoreConflictError rather than
 * renamed into a Skill that silently does not load. An occupied destination
 * folder is refused the same way; nothing is merged or replaced.
 */
export async function restorePiSkill<R>(
  workFolderRoot: string,
  input: {
    scope: "user" | "project";
    relativePath: string;
    skillName: string;
    putBack: (destination: string) => Promise<R>;
  },
  runtimeProvider?: PiRuntimeProvider,
): Promise<{ scope: "user" | "project"; restoredPath: string; restored: R }> {
  const runtime = await resolvePiRuntime(workFolderRoot, runtimeProvider, { requestProjectTrust: false });
  if (input.scope === "project" && !hasExplicitPiProjectMutationTrust(runtime)) {
    throw new Error("Trust this work-folder before restoring work-folder-scoped Skills.");
  }
  const segments = input.relativePath.split("/");
  if (!segments.length || segments.some((segment) => (
    !segment || segment === "." || segment === ".." || /[\\\u0000-\u001f:]/.test(segment)
  ))) {
    throw new Error("The kept Skill's path is invalid.");
  }
  const root = piSkillsRoot(workFolderRoot, runtime.agentDir, input.scope);
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  const destination = join(root, ...segments);
  const where = input.scope === "project" ? "in this work-folder" : "Everywhere";
  let ancestor = root;
  for (const segment of segments.slice(0, -1)) {
    ancestor = join(ancestor, segment);
    const info = await lstat(ancestor).catch(() => null);
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new PiSkillRestoreConflictError(`${relative(root, ancestor)} is not an ordinary folder, so the Skill cannot go back inside it.`);
    }
    const realRelative = relative(realRoot, await realpath(ancestor));
    if (!realRelative || realRelative.startsWith("..") || isAbsolute(realRelative)) {
      throw new Error("The Skill's folder resolves outside work-fold's import root, so it cannot go back there.");
    }
  }
  const sameName = await findPiSkillNamed(root, input.skillName);
  if (sameName) {
    throw new PiSkillRestoreConflictError(
      `A Skill named "${input.skillName}" is already installed ${where} (${relative(root, dirname(sameName)).split(sep).join("/") || "."}). `
        + "Remove that one first, then restore this one.",
    );
  }
  if (await lstat(destination).catch(() => null)) {
    throw new PiSkillRestoreConflictError(
      `Something is already at ${input.relativePath} ${where}. Remove it, then restore this Skill.`,
    );
  }
  const restored = await input.putBack(destination);
  return { scope: input.scope, restoredPath: destination, restored };
}

function piSkillsRoot(workFolderRoot: string, agentDir: string, scope: "user" | "project"): string {
  return resolve(scope === "project" ? join(workFolderRoot, ".pi", "skills") : join(agentDir, "skills"));
}

/** Pi's rule for a SKILL.md's name: the frontmatter `name`, else the folder that holds it. */
async function piSkillName(skillFile: string): Promise<string> {
  return skillFrontmatterName(await readSkillHead(skillFile) ?? "") ?? basename(dirname(skillFile));
}

/** The start of a Skill file, enough for its frontmatter; null when it cannot be read. */
async function readSkillHead(path: string): Promise<string | null> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(maxSkillHeadBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The first Skill in an import root that Pi would load under `name`, walked
 * the way Pi walks a skills folder: a folder holding SKILL.md is one Skill,
 * dot-folders and node_modules are skipped, and a root-level Markdown file
 * with a frontmatter name counts too. Links are not followed. The walk is
 * bounded; past the bound it stops looking rather than guessing.
 */
async function findPiSkillNamed(root: string, name: string): Promise<string | null> {
  const stack = [root];
  let visited = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) continue;
    const skillFile = entries.find((entry) => entry.name === "SKILL.md" && entry.isFile());
    if (skillFile) {
      if (await piSkillName(join(dir, skillFile.name)) === name) return join(dir, skillFile.name);
      continue;
    }
    for (const entry of entries) {
      if (++visited > maxSkillScanEntries) return null;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (dir === root && entry.isFile() && extname(entry.name) === ".md") {
        if (skillFrontmatterName(await readSkillHead(path) ?? "") === name) return path;
      }
    }
  }
  return null;
}

const maxSkillHeadBytes = 64 * 1024;
const maxSkillScanEntries = 64 * 1024;
