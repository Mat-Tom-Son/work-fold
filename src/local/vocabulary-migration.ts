/**
 * One-time move of app state, and of each work-folder's portable metadata,
 * to the 2026-10-10 vocabulary (scripts/vocabulary/GLOSSARY.md): work-folder,
 * Worker, work-fold agent, Automation, Recently deleted, overview.
 *
 * The migration renames the stores whose names changed and rewrites the JSON
 * keys and enum values they hold, using tables generated from the same
 * codemod that renamed the code (vocabulary-migration-tables.json), so the
 * two cannot disagree. It touches only app-owned stores from an allowlist —
 * never a work-folder's content, a conversation log, an app package, or a
 * browser cache — never rewrites human text, keeps a copy of every file it
 * changes under `vocabulary-migration-backup/`, and records completion so it
 * runs once. A store whose new name already exists is left alone.
 *
 * Remove this module once no profile from before 2026-10-10 remains.
 */
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import migrationTables from "./vocabulary-migration-tables.json" with { type: "json" };

const tables = migrationTables as { version: number; keys: Record<string, string>; values: Record<string, string> };

export const vocabularyMigrationVersion = 1;
export const vocabularyMigrationMarker = "vocabulary-migration.json";
export const vocabularyMigrationBackupDir = "vocabulary-migration-backup";

/** Stores renamed in app state, in the order they move (paths relative to the state root). */
const stateMoves: ReadonlyArray<readonly [string, string]> = [
  ["space-registry.json", "work-folder-registry.json"],
  ["assistant-model-preferences.json", "model-preferences.json"],
  ["glance-seen.json", "overview-seen.json"],
  ["routings", "automations"],
  [join("automations", "routings.json"), join("automations", "automations.json")],
  ["trash", "recently-deleted"],
  [join("state", "spaces"), join("state", "work-folders")],
  [join("checks", "spaces"), join("checks", "work-folders")],
  [join("fold", "publications.json"), join("shared-pages", "publications.json")],
];

/** App-owned JSON stores the migration may rewrite (relative to the state root). */
const rewriteRoots: readonly string[] = [
  "work-folder-registry.json",
  "model-preferences.json",
  "overview-seen.json",
  "automations",
  "recently-deleted",
  join("state", "work-folders"),
  join("checks", "work-folders"),
  "shared-pages",
  "requests",
  "turns",
  join("cli", "receipts"),
  join("restricted-apps", "registry.json"),
  join("restricted-apps", "proposals.json"),
  join("restricted-apps", "browser-actions.json"),
  join("restricted-apps", "inference-receipts.jsonl"),
  join("restricted-apps", "assistant-tasks.json"),
];

/** Fields that hold a person's or a model's words; their string values are never remapped. */
const humanTextKeys = new Set([
  "name", "title", "label", "text", "content", "message", "summary", "question", "answer", "query",
  "description", "error", "detail", "assistantText", "prompt", "instructions", "criteria", "reply", "note",
]);

/** Fields whose whole value is someone else's data (file paths, structured results, tool input); kept byte for byte. */
const opaqueKeys = new Set([
  "details", "payload", "data", "input", "output", "arguments", "args", "attachments",
  "path", "paths", "relativePath", "files", "deleteOnRestore", "changedPaths",
]);

/** Fields that hold names or ids; only a machine-local Automation id changes there. */
const identityKeys = new Set(["id", "value", "ids"]);

/** Directories under a rewrite root that hold content rather than app records. */
const contentDirectories = new Set(["conversations", "data", "staged", "releases", "payload", "objects", "checkpoints"]);

export interface VocabularyMigrationReport {
  alreadyMigrated: boolean;
  moved: string[];
  rewritten: string[];
  workFolders: string[];
}

/**
 * Migrates one state root. Safe to call on every start: it returns at once
 * when the marker is present, and each step is skipped when its result
 * already exists.
 */
export async function migrateVocabularyState(stateRoot: string): Promise<VocabularyMigrationReport> {
  const report: VocabularyMigrationReport = { alreadyMigrated: false, moved: [], rewritten: [], workFolders: [] };
  const marker = join(stateRoot, vocabularyMigrationMarker);
  if (await exists(marker)) return { ...report, alreadyMigrated: true };
  if (!(await exists(stateRoot))) return report;

  for (const [from, to] of stateMoves) {
    if (await moveIfPresent(join(stateRoot, from), join(stateRoot, to))) report.moved.push(`${from} → ${to}`);
  }
  // Automation proposals the work-fold agent wrote into its working folder.
  const agentRoot = join(stateRoot, "management");
  for (const name of await listNames(agentRoot)) {
    if (!name.endsWith(".work-fold-routing.json")) continue;
    const next = name.replace(/\.work-fold-routing\.json$/, ".work-fold-automation.json");
    if (await moveIfPresent(join(agentRoot, name), join(agentRoot, next))) report.moved.push(`management/${name} → ${next}`);
  }

  for (const root of rewriteRoots) {
    for (const file of await jsonFiles(join(stateRoot, root))) {
      if (await rewriteJsonFile(stateRoot, file)) report.rewritten.push(relative(stateRoot, file));
    }
  }

  // Registered folders: rename the portable manifest now rather than on first open.
  for (const workFolderRoot of await registeredWorkFolderRoots(stateRoot)) {
    if (await migrateWorkFolderMetadata(workFolderRoot)) report.workFolders.push(workFolderRoot);
  }

  await writeFile(marker, `${JSON.stringify({ version: vocabularyMigrationVersion, migratedAt: new Date().toISOString(), ...report }, null, 2)}\n`, { mode: 0o600 });
  return report;
}

/**
 * A work-folder's portable identity moved from `.work-fold/space.json` to
 * `.work-fold/work-folder.json`. Folders travel between machines, so this
 * runs whenever a folder's metadata is read, not only at startup.
 */
export async function migrateWorkFolderMetadata(workFolderRoot: string): Promise<boolean> {
  const metadata = join(workFolderRoot, ".work-fold");
  // Like every portable metadata path, neither the directory nor the manifest may be a link.
  const directory = await lstat(metadata).catch(() => null);
  if (!directory?.isDirectory()) return false;
  const legacy = await lstat(join(metadata, "space.json")).catch(() => null);
  if (!legacy?.isFile()) return false;
  return moveIfPresent(join(metadata, "space.json"), join(metadata, "work-folder.json"));
}

// --- mapping ----------------------------------------------------------------

/** Maps one JSON value: keys by the key table, exact enum values by the value table. */
export function migrateVocabularyValue(value: unknown, parentKey?: string): unknown {
  if (parentKey !== undefined && opaqueKeys.has(parentKey)) return value;
  if (typeof value === "string") {
    if (parentKey !== undefined && humanTextKeys.has(parentKey)) return value;
    if (parentKey !== undefined && identityKeys.has(parentKey)) return migrateAutomationId(value);
    return migrateEnumValue(value);
  }
  if (Array.isArray(value)) return value.map((item) => migrateVocabularyValue(item, parentKey));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const nextKey = migrateKey(key);
      out[nextKey] = migrateVocabularyValue(item, opaqueKeys.has(key) ? key : nextKey);
    }
    return out;
  }
  return value;
}

function migrateKey(key: string): string {
  if (Object.hasOwn(tables.keys, key)) return tables.keys[key]!;
  // Model preferences are keyed per work-folder as `space:<id>`.
  if (key.startsWith("space:")) return `work-folder:${key.slice("space:".length)}`;
  return key;
}

function migrateEnumValue(value: string): string {
  if (Object.hasOwn(tables.values, value)) return tables.values[value]!;
  return migrateAutomationId(value);
}

/** Machine-local Automation ids; work-folder ids (`space-<hex>`) and Recently deleted ids keep their shape. */
function migrateAutomationId(value: string): string {
  const automationId = /^routing-([0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|v1-upgrade)$/.exec(value);
  return automationId ? `automation-${automationId[1]}` : value;
}

// --- files ------------------------------------------------------------------

async function rewriteJsonFile(stateRoot: string, file: string): Promise<boolean> {
  const original = await readFile(file, "utf8");
  let next: string;
  if (file.endsWith(".jsonl")) {
    next = original.split("\n").map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(migrateVocabularyValue(JSON.parse(line)));
      } catch {
        return line; // A damaged line stays exactly as it was.
      }
    }).join("\n");
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(original);
    } catch {
      return false;
    }
    const indented = /^\{\n|^\[\n/.test(original);
    next = `${JSON.stringify(migrateVocabularyValue(parsed), null, indented ? 2 : undefined)}${original.endsWith("\n") ? "\n" : ""}`;
  }
  if (next === original) return false;
  const backup = join(stateRoot, vocabularyMigrationBackupDir, relative(stateRoot, file));
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
  await copyFile(file, backup, constants.COPYFILE_EXCL).catch(() => undefined);
  const temporary = `${file}.vocabulary-migration`;
  await writeFile(temporary, next, { mode: (await lstat(file)).mode & 0o777 });
  await rename(temporary, file);
  return true;
}

async function jsonFiles(path: string): Promise<string[]> {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink()) return [];
  if (info.isFile()) return /\.jsonl?$/.test(path) ? [path] : [];
  if (!info.isDirectory()) return [];
  const out: string[] = [];
  for (const name of await listNames(path)) {
    // Conversation logs, deleted folders, History, and app data carry people's words and files.
    if (contentDirectories.has(name)) continue;
    out.push(...await jsonFiles(join(path, name)));
  }
  return out;
}

async function registeredWorkFolderRoots(stateRoot: string): Promise<string[]> {
  try {
    const registry = JSON.parse(await readFile(join(stateRoot, "work-folder-registry.json"), "utf8")) as { workFolders?: Array<{ workFolderRoot?: unknown }> };
    return (registry.workFolders ?? []).map((entry) => entry.workFolderRoot).filter((root): root is string => typeof root === "string");
  } catch {
    return [];
  }
}

async function moveIfPresent(from: string, to: string): Promise<boolean> {
  const source = await lstat(from).catch(() => null);
  if (!source || await exists(to)) return false;
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  return true;
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => null));
}

async function listNames(path: string): Promise<string[]> {
  return readdir(path).catch(() => []);
}
