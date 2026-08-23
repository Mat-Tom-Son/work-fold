import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isSpaceIgnored, readSpaceIgnoreState } from "./space-ignore.js";

/**
 * What a full History checkpoint captures.
 *
 * History is a recovery boundary for the person's own work, so a capture
 * walks real bytes rather than trusting metadata. That makes capture cost
 * proportional to what is walked, which is why the walk leaves out content
 * that is provably not the person's work or that they have said is not:
 *
 * - directories that are version-control internals, installed dependencies,
 *   Python virtual environments (`pyvenv.cfg`), or self-declared caches
 *   (`CACHEDIR.TAG`), plus work-fold's own hidden support directories;
 * - directories the person ignored in Files (the Space ignore rules);
 * - directories a `.gitignore` excludes — build output, tool caches.
 *
 * Individual files are always recovery material: a gitignored `.env` or a
 * file hidden from Files and Search is exactly the small, precious thing a
 * recovery point exists for, so file-level ignore rules never apply here.
 *
 * Targeted mutation checkpoints capture the paths they are asked about and
 * consult only the always-skipped set.
 */

export type HistoryExclusionReason = "builtin" | "space_ignore" | "gitignore";

export interface HistoryCapturePolicy {
  /** Decides whether a directory (and everything beneath it) is skipped. */
  excludeDirectory(relativePath: string, absolutePath: string): Promise<HistoryExclusionReason | null>;
  /** Decides whether one file is skipped. */
  excludeFile(relativePath: string): HistoryExclusionReason | null;
  /** Registers a directory that will be descended into (loads its `.gitignore`). */
  enterDirectory(relativePath: string, absolutePath: string): Promise<void>;
}

export const historyAlwaysSkippedSegments = new Set([
  ".git",
  ".hg",
  ".svn",
  ".jj",
  ".pi",
  ".work-fold",
  ".workspace",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
]);

/** Marker files whose presence identifies a directory as generated, not authored. */
const generatedDirectoryMarkers = ["pyvenv.cfg", "CACHEDIR.TAG"];

export function isHistoryAlwaysSkippedSegment(segment: string): boolean {
  return historyAlwaysSkippedSegments.has(process.platform === "win32" ? segment.toLocaleLowerCase("en-US") : segment);
}

export function pathHasAlwaysSkippedSegment(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => isHistoryAlwaysSkippedSegment(segment));
}

export async function directoryLooksGenerated(absolutePath: string): Promise<boolean> {
  return generatedDirectoryMarkers.some((marker) => existsSync(join(absolutePath, marker)));
}

/** Policy for targeted captures: only the always-skipped set applies. */
export function createTargetedHistoryCapturePolicy(): HistoryCapturePolicy {
  return {
    async excludeDirectory(relativePath) {
      return pathHasAlwaysSkippedSegment(relativePath) ? "builtin" : null;
    },
    excludeFile(relativePath) {
      return pathHasAlwaysSkippedSegment(relativePath) ? "builtin" : null;
    },
    async enterDirectory() {},
  };
}

export async function createFullHistoryCapturePolicy(spaceRoot: string): Promise<HistoryCapturePolicy> {
  const ignore = await readSpaceIgnoreState(spaceRoot).catch(() => ({ version: 1 as const, patterns: [] as string[] }));
  const gitignore = new GitignoreDirectoryRules();
  return {
    async excludeDirectory(relativePath, absolutePath) {
      const name = relativePath.split("/").pop() ?? "";
      if (isHistoryAlwaysSkippedSegment(name)) return "builtin";
      if (await directoryLooksGenerated(absolutePath)) return "builtin";
      if (isSpaceIgnored(relativePath, ignore.patterns)) return "space_ignore";
      if (gitignore.excludesDirectory(relativePath)) return "gitignore";
      return null;
    },
    excludeFile(relativePath) {
      const name = relativePath.split("/").pop() ?? "";
      return isHistoryAlwaysSkippedSegment(name) ? "builtin" : null;
    },
    async enterDirectory(relativePath, absolutePath) {
      await gitignore.load(relativePath, absolutePath);
    },
  };
}

interface GitignoreRule {
  negated: boolean;
  /** Anchored rules match relative to their `.gitignore` directory; unanchored rules match any basename at any depth. */
  anchored: boolean;
  /** `foo/**` style rules match everything beneath `foo`. */
  matchesDescendants: boolean;
  regex: RegExp;
}

/**
 * Directory-only `.gitignore` evaluation. Rules from every `.gitignore` on the
 * path to a directory are consulted, closest file last, last match wins —
 * the same precedence git uses. Because an excluded directory is never
 * entered, a negation cannot re-include anything beneath it, which matches
 * git's documented behavior.
 */
export class GitignoreDirectoryRules {
  readonly #rulesByDirectory = new Map<string, GitignoreRule[]>();

  async load(relativeDirectory: string, absoluteDirectory: string): Promise<void> {
    const text = await readFile(join(absoluteDirectory, ".gitignore"), "utf8").catch(() => null);
    if (text === null) return;
    const rules = parseGitignoreRules(text);
    if (rules.length) this.#rulesByDirectory.set(relativeDirectory, rules);
  }

  addRules(relativeDirectory: string, text: string): void {
    const rules = parseGitignoreRules(text);
    if (rules.length) this.#rulesByDirectory.set(relativeDirectory, rules);
  }

  excludesDirectory(relativePath: string): boolean {
    if (!relativePath) return false;
    let excluded = false;
    for (const base of ancestorDirectories(relativePath)) {
      const rules = this.#rulesByDirectory.get(base);
      if (!rules) continue;
      const scoped = base ? relativePath.slice(base.length + 1) : relativePath;
      for (const rule of rules) {
        if (ruleMatches(rule, scoped)) excluded = !rule.negated;
      }
    }
    return excluded;
  }
}

function ancestorDirectories(relativePath: string): string[] {
  const segments = relativePath.split("/");
  const result = [""];
  for (let index = 1; index < segments.length; index += 1) result.push(segments.slice(0, index).join("/"));
  return result;
}

function ruleMatches(rule: GitignoreRule, scopedPath: string): boolean {
  if (rule.anchored) return rule.regex.test(scopedPath);
  const segments = scopedPath.split("/");
  if (rule.matchesDescendants) {
    for (let index = 0; index < segments.length; index += 1) {
      if (rule.regex.test(segments.slice(index).join("/"))) return true;
    }
    return false;
  }
  return segments.some((segment) => rule.regex.test(segment));
}

export function parseGitignoreRules(text: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/(?<!\\)\s+$/u, "");
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1);
    }
    if (!line) continue;
    // A trailing slash only restricts a rule to directories; this matcher is
    // directory-only already.
    if (line.endsWith("/")) line = line.slice(0, -1);
    if (line.startsWith("**/")) line = line.slice(3);
    let matchesDescendants = false;
    if (line.endsWith("/**")) {
      matchesDescendants = true;
      line = line.slice(0, -3);
    }
    if (!line) continue;
    const anchored = line.startsWith("/") || line.slice(0, -1).includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const regex = gitignoreGlobToRegex(line, matchesDescendants);
    if (!regex) continue;
    rules.push({ negated, anchored, matchesDescendants, regex });
  }
  return rules;
}

function gitignoreGlobToRegex(pattern: string, matchesDescendants: boolean): RegExp | null {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*" && pattern[index + 1] === "*") {
      // `a/**/b` spans directories; a bare `**` inside a segment acts like `*`.
      const followedBySlash = pattern[index + 2] === "/";
      const precededBySlash = index === 0 || pattern[index - 1] === "/";
      if (precededBySlash && followedBySlash) {
        source += "(?:.*/)?";
        index += 2;
        continue;
      }
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end > index + 1) {
        let body = pattern.slice(index + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        source += `[${body.replace(/\\/g, "\\\\")}]`;
        index = end;
        continue;
      }
      source += "\\[";
      continue;
    }
    if (char === "\\" && index + 1 < pattern.length) {
      source += escapeRegex(pattern[index + 1] ?? "");
      index += 1;
      continue;
    }
    source += escapeRegex(char);
  }
  try {
    return new RegExp(`^${source}${matchesDescendants ? "(?:/.*)?" : ""}$`);
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
