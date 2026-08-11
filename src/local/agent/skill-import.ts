import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
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
 * Digest-verified import for the fold's consecrated `capability.skills.import`
 * execution (docs/fold-consecrations.md). The staged act pins the exact bytes
 * that were enumerated at staging time; this path refuses changed content
 * before any archive parsing, mirroring the restricted-app install path's
 * revision-changed posture, so approval can only ever execute the reviewed
 * bundle.
 */
export async function importPiSkillBundleVerified(
  spaceRoot: string,
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
  return importPiSkillBundle(spaceRoot, importInput, runtimeProvider);
}

/**
 * Imports Agent Skills/Anthropic skill-pack ZIPs without enabling any bundled
 * extensions, hooks, MCP servers, or agents. The complete skill directories
 * are preserved so scripts, references, assets, and templates keep working.
 */
export async function importPiSkillBundle(
  spaceRoot: string,
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
    return importStandaloneSkill(spaceRoot, input, runtimeProvider);
  }
  if (extension !== ".zip" && extension !== ".skill") {
    throw new Error("Skills must be a SKILL.md file or use a .zip or .skill bundle.");
  }

  const runtime = await resolvePiRuntime(spaceRoot, runtimeProvider, { requestProjectTrust: false });
  const scope = input.scope ?? "user";
  if (scope === "project" && !hasExplicitPiProjectMutationTrust(runtime)) {
    throw new Error("Trust this Space before importing Space-scoped Skills.");
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
    ? join(spaceRoot, ".pi", "skills")
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
  spaceRoot: string,
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

  const runtime = await resolvePiRuntime(spaceRoot, runtimeProvider, { requestProjectTrust: false });
  const scope = input.scope ?? "user";
  if (scope === "project" && !hasExplicitPiProjectMutationTrust(runtime)) {
    throw new Error("Trust this Space before importing Space-scoped Skills.");
  }
  const destinationRoot = scope === "project"
    ? join(spaceRoot, ".pi", "skills")
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
