/**
 * Bounded observation of one granted file root, so an app view can learn that
 * something under a root it already reads has changed
 * (docs/collaboration-contract.md, F30).
 *
 * Metadata only: no file bytes are read, hashed, or delivered, and no path ever
 * leaves this module. A hint carries ids and a revision, never content, so the
 * caller learns only *that* a root moved and re-reads through the ordinary file
 * broker with the authority it already has.
 *
 * Like the routing folder observer this is a bounded poll rather than an OS
 * watcher: polling works the same on a synchronized drive as on a local disk,
 * where watcher events are lossy. Unlike that observer, a bound reached here
 * degrades to `truncated: true` rather than failing — an app view that cannot
 * be told the whole truth is still better served by "something under your root
 * changed" than by silence.
 */
import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { restrictedAppSubscriptionLimits } from "../../shared/restricted-app-tasks.js";
import type { RestrictedAppFileGrant } from "./restricted-app-files.js";

export interface RestrictedAppFileWatchLimits {
  fileMaxFiles: number;
  fileMaxVisitedEntries: number;
  fileMaxDepth: number;
  fileDebounceMs: number;
  fileMinHintIntervalMs: number;
}

export interface RestrictedAppFileSnapshot {
  /** Covers the root's own identity and every observed entry. */
  digest: string;
  /** Root-relative path → `dev:ino:size:mtimeNs:ctimeNs`. Never leaves the host. */
  entries: Record<string, string>;
  /** A bound was reached; the observation is partial but stable. */
  truncated: boolean;
}

/** A grant plus the declared target kind, which decides file versus folder. */
export interface RestrictedAppFileWatchTarget {
  grant: RestrictedAppFileGrant;
  target: "file" | "directory";
}

/**
 * Bounded metadata scan of one granted root. Symbolic links and work-fold, Pi,
 * and legacy product metadata are invisible here exactly as they are to the
 * file broker, so an app can never learn about a path it could not read.
 */
export async function observeRestrictedAppGrantRoot(
  spaceRoot: string,
  target: RestrictedAppFileWatchTarget,
  limits: RestrictedAppFileWatchLimits = restrictedAppSubscriptionLimits,
): Promise<RestrictedAppFileSnapshot> {
  const root = resolveGrantRoot(spaceRoot, target.grant.root);
  const before = await lstat(root, { bigint: true });
  if (before.isSymbolicLink()) throw new Error("A granted root cannot be a link.");
  const entries: Record<string, string> = Object.create(null);
  let truncated = false;
  if (target.target === "file") {
    if (!before.isFile()) throw new Error("The granted file is no longer an ordinary file.");
    entries[""] = stamp(before);
  } else {
    if (!before.isDirectory()) throw new Error("The granted folder is no longer an ordinary folder.");
    const walk = await walkDirectory(root, limits);
    Object.assign(entries, walk.entries);
    truncated = walk.truncated;
  }
  const after = await lstat(root, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino) throw new Error("The granted root moved during observation.");
  const digest = createHash("sha256")
    .update(JSON.stringify({
      root: [String(after.dev), String(after.ino)],
      truncated,
      entries: Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    }))
    .digest("hex");
  return { digest, entries, truncated };
}

/**
 * The per-root change detector. Observations restart from a baseline
 * deliberately: what changed while the machine slept, while the view was
 * closed, or before the app was installed is not replayed as news.
 */
export class RestrictedAppFileWatch {
  baseline?: RestrictedAppFileSnapshot;
  candidate?: { snapshot: RestrictedAppFileSnapshot; since: number };
  lastFired = Number.NEGATIVE_INFINITY;
  failure?: string;

  /** Drops the baseline so the next observation re-establishes it silently. */
  reset(): void {
    this.baseline = undefined;
    this.candidate = undefined;
  }

  /**
   * Fires once a changed observation has held still for the debounce and the
   * cooldown since the last hint has passed. No path is returned: a hint
   * carries ids and a revision, never content.
   */
  observe(
    snapshot: RestrictedAppFileSnapshot,
    now: number,
    limits: RestrictedAppFileWatchLimits = restrictedAppSubscriptionLimits,
  ): { truncated: boolean } | null {
    this.failure = undefined;
    if (!this.baseline) { this.baseline = snapshot; this.candidate = undefined; return null; }
    if (snapshot.digest === this.baseline.digest) { this.candidate = undefined; return null; }
    if (this.candidate?.snapshot.digest !== snapshot.digest) { this.candidate = { snapshot, since: now }; return null; }
    if (now - this.candidate.since < limits.fileDebounceMs) return null;
    if (now - this.lastFired < limits.fileMinHintIntervalMs) return null;
    this.baseline = snapshot;
    this.candidate = undefined;
    this.lastFired = now;
    return { truncated: snapshot.truncated };
  }

  /** A failed observation emits nothing and rebaselines on the next success. */
  fail(error: unknown): void {
    this.reset();
    this.failure = error instanceof Error ? error.message : "Granted-folder observation failed.";
  }
}

function stamp(info: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":");
}

async function walkDirectory(
  root: string,
  limits: RestrictedAppFileWatchLimits,
): Promise<{ entries: Record<string, string>; truncated: boolean }> {
  const entries: Record<string, string> = Object.create(null);
  let visited = 0;
  let files = 0;
  let truncated = false;
  const queue: Array<{ absolute: string; relativePath: string; depth: number }> = [{ absolute: root, relativePath: "", depth: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    let directory;
    try { directory = await opendir(current.absolute); }
    catch { truncated = true; continue; }
    try {
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        if (isReservedMetadataSegment(entry.name) || entry.isSymbolicLink()) continue;
        visited += 1;
        if (visited > limits.fileMaxVisitedEntries) { truncated = true; break; }
        const absolute = join(current.absolute, entry.name);
        const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
        let info;
        try { info = await lstat(absolute, { bigint: true }); }
        catch { truncated = true; continue; }
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          if (current.depth + 1 > limits.fileMaxDepth) { truncated = true; continue; }
          // The folder's own stamp records a rename or a replacement of an
          // otherwise unchanged subtree.
          entries[`${relativePath}/`] = stamp(info);
          queue.push({ absolute, relativePath, depth: current.depth + 1 });
          continue;
        }
        if (!info.isFile()) continue;
        if (files >= limits.fileMaxFiles) { truncated = true; continue; }
        files += 1;
        entries[relativePath] = stamp(info);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    if (visited > limits.fileMaxVisitedEntries) break;
  }
  return { entries, truncated };
}

function resolveGrantRoot(spaceRoot: string, root: string): string {
  const absolute = resolve(spaceRoot, root);
  const inside = relative(resolve(spaceRoot), absolute);
  if (inside && (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))) {
    throw new Error("A granted root must stay inside its Space.");
  }
  return absolute;
}

function isReservedMetadataSegment(segment: string): boolean {
  const value = segment.toLocaleLowerCase("en-US");
  return value === ".work-fold" || value === ".workspace" || value === ".pi";
}
