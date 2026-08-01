import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { spaceStateDir } from "./state-paths.js";
import { ensureSafeSpaceRoot, resolveSpacePath } from "./space.js";

export interface SpaceIgnoreState {
  version: 1;
  patterns: string[];
}

export interface SpaceIgnoreUpdate {
  ignored: boolean;
  paths: string[];
  patterns: string[];
}

const builtInPatterns = [".work-fold", ".workspace", ".pi", ".DS_Store", "Thumbs.db", "~$*", ".~lock.*#"];

export async function readSpaceIgnoreState(spaceRoot: string): Promise<SpaceIgnoreState> {
  const root = ensureSafeSpaceRoot(spaceRoot);
  const file = ignoreStateFile(root);
  if (!existsSync(file)) return { version: 1, patterns: [] };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<SpaceIgnoreState>;
    return {
      version: 1,
      patterns: Array.isArray(parsed.patterns)
        ? parsed.patterns.filter((item): item is string => typeof item === "string").map(normalizePattern).filter(Boolean).slice(0, 500)
        : [],
    };
  } catch {
    return { version: 1, patterns: [] };
  }
}

export async function setSpaceIgnoreState(
  spaceRoot: string,
  paths: string[],
  ignored: boolean,
): Promise<SpaceIgnoreUpdate> {
  const root = ensureSafeSpaceRoot(spaceRoot);
  const normalizedPaths = [...new Set(paths.map(normalizeSpacePath).filter(Boolean))].slice(0, 100);
  if (!normalizedPaths.length || normalizedPaths.includes(".")) throw new Error("Choose at least one Space item.");
  const requestedPatterns: string[] = [];
  for (const path of normalizedPaths) {
    const absolute = resolveSpacePath(root, path);
    if (absolute === root) throw new Error("The Space root cannot be ignored.");
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new Error(`Space item not found: ${path}`);
    requestedPatterns.push(info.isDirectory() ? `${path}/` : path);
  }

  const state = await readSpaceIgnoreState(root);
  const existing = new Set(state.patterns);
  for (const pattern of requestedPatterns) {
    existing.delete(pattern);
    existing.delete(`!${pattern}`);
    if (ignored) existing.add(pattern);
    else if (isSpaceIgnored(pattern.replace(/\/$/, ""), [...existing])) existing.add(`!${pattern}`);
  }
  const patterns = [...existing].sort((left, right) => left.localeCompare(right));
  const file = ignoreStateFile(root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version: 1, patterns }, null, 2)}\n`, "utf8");
  return { ignored, paths: normalizedPaths, patterns };
}

export function isSpaceIgnored(relativePath: string, configuredPatterns: string[]): boolean {
  const path = normalizeSpacePath(relativePath);
  if (!path) return false;
  let ignored = false;
  for (const rawPattern of [...builtInPatterns, ...configuredPatterns]) {
    const negated = rawPattern.startsWith("!");
    const pattern = normalizePattern(negated ? rawPattern.slice(1) : rawPattern);
    if (pattern && ignoreRuleMatches(path, pattern)) ignored = !negated;
  }
  return ignored;
}

export function isAlwaysHiddenSpaceEntry(name: string): boolean {
  return builtInPatterns.some((pattern) => ignoreRuleMatches(name, pattern));
}

function ignoreStateFile(spaceRoot: string): string {
  return join(spaceStateDir(spaceRoot), "ignore.json");
}

function normalizePattern(value: string): string {
  const negated = value.trim().startsWith("!");
  const normalized = normalizeSpacePath(value.trim().replace(/^!/, ""));
  if (!normalized || normalized.includes("..")) return "";
  const withFolderMarker = /[\\/]$/.test(value.trim()) ? `${normalized}/` : normalized;
  return negated ? `!${withFolderMarker}` : withFolderMarker;
}

function normalizeSpacePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+|\/+$/g, "");
}

function ignoreRuleMatches(relativePath: string, rawPattern: string): boolean {
  const path = normalizeSpacePath(relativePath);
  const folderPattern = rawPattern.endsWith("/");
  const pattern = normalizeSpacePath(rawPattern);
  if (!pattern) return false;
  const regex = globRegex(pattern);
  if (regex.test(path)) return true;
  if (folderPattern && (path === pattern || path.startsWith(`${pattern}/`))) return true;
  if (!pattern.includes("/")) return path.split("/").some((segment) => regex.test(segment));
  return false;
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "");
}
