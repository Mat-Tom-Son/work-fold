import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { compareWorkFoldGlanceCursors, parseWorkFoldGlanceCursor } from "./glance.js";
import { workFoldStateRoot } from "./state-paths.js";

/**
 * Per-surface last-seen markers for the glance: machine-local presentation
 * preference in the same class as the Chat attention marker — disposable,
 * never portable conversation content, and never authority over anything. A
 * marker hides nothing (surfaces reveal the bounded tail regardless), so the
 * store's failure direction is always over-reporting: a damaged file resets
 * markers, a failed write leaves the old marker, and a backward or replayed
 * advance is a no-op.
 */

export const workFoldGlanceSeenStateVersion = 1 as const;

export interface WorkFoldGlanceSeenMarker {
  seenThrough: string;
  updatedAt: string;
}

export interface WorkFoldGlanceSeenState {
  version: typeof workFoldGlanceSeenStateVersion;
  surfaces: Record<string, WorkFoldGlanceSeenMarker>;
}

export interface WorkFoldGlanceSeenAdvanceResult {
  advanced: boolean;
  seenThrough: string | null;
}

/** The two desktop surfaces; approved remote browsers use `remote:<grantId>`. */
export const WORKFOLD_GLANCE_BUILTIN_SURFACES = ["popover", "main-window"] as const;

const remoteSurfacePrefix = "remote:";
const grantIdPattern = /^[A-Za-z0-9._:-]{1,160}$/;
const defaultMaxSurfaces = 128;

export function workFoldGlanceRemoteSurfaceId(grantId: string): string {
  const normalized = grantId.trim();
  if (!grantIdPattern.test(normalized)) throw new Error("A valid remote grant id is required.");
  return `${remoteSurfacePrefix}${normalized}`;
}

/** Closed surface vocabulary: `popover`, `main-window`, or `remote:<grantId>`. */
export function isWorkFoldGlanceSurfaceId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if ((WORKFOLD_GLANCE_BUILTIN_SURFACES as readonly string[]).includes(value)) return true;
  return value.startsWith(remoteSurfacePrefix) && grantIdPattern.test(value.slice(remoteSurfacePrefix.length));
}

export function workFoldGlanceSeenFile(): string {
  return join(workFoldStateRoot(), "glance-seen.json");
}

export interface WorkFoldGlanceSeenStoreOptions {
  path?: string;
  now?: () => Date;
  maxSurfaces?: number;
}

export class WorkFoldGlanceSeenStore {
  readonly path: string;
  readonly #now: () => Date;
  readonly #maxSurfaces: number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkFoldGlanceSeenStoreOptions = {}) {
    this.path = options.path ?? workFoldGlanceSeenFile();
    this.#now = options.now ?? (() => new Date());
    this.#maxSurfaces = options.maxSurfaces ?? defaultMaxSurfaces;
  }

  /** The digest's `seen` table: surfaceId -> acknowledged cursor. */
  async seenCursors(): Promise<Record<string, string>> {
    const state = await this.#read();
    const cursors: Record<string, string> = {};
    for (const surfaceId of Object.keys(state.surfaces).sort(compareStrings)) {
      cursors[surfaceId] = state.surfaces[surfaceId].seenThrough;
    }
    return cursors;
  }

  async read(): Promise<WorkFoldGlanceSeenState> {
    return this.#read();
  }

  /**
   * Monotonic acknowledgement: moves a surface's marker to `cursor` only when
   * that cursor is strictly newer than the recorded one, so a replayed or
   * reordered advance is a no-op. Never throws — a refused or failed advance
   * only leaves items rendering as new.
   */
  advance(surfaceId: string, cursor: string): Promise<WorkFoldGlanceSeenAdvanceResult> {
    const operation = this.#queue.catch(() => undefined).then(async (): Promise<WorkFoldGlanceSeenAdvanceResult> => {
      if (!isWorkFoldGlanceSurfaceId(surfaceId) || !parseWorkFoldGlanceCursor(cursor)) {
        return { advanced: false, seenThrough: null };
      }
      const state = await this.#read();
      const existing = state.surfaces[surfaceId];
      if (existing && compareWorkFoldGlanceCursors(cursor, existing.seenThrough) <= 0) {
        return { advanced: false, seenThrough: existing.seenThrough };
      }
      if (!existing && Object.keys(state.surfaces).length >= this.#maxSurfaces) {
        // Refusing a new surface at the cap leaves it with no marker, which
        // only over-reports newness on that surface.
        return { advanced: false, seenThrough: null };
      }
      const next: WorkFoldGlanceSeenState = {
        version: workFoldGlanceSeenStateVersion,
        surfaces: {
          ...state.surfaces,
          [surfaceId]: { seenThrough: cursor, updatedAt: this.#now().toISOString() },
        },
      };
      if (!await this.#write(next)) {
        return { advanced: false, seenThrough: existing?.seenThrough ?? null };
      }
      return { advanced: true, seenThrough: cursor };
    });
    this.#queue = operation;
    return operation;
  }

  /**
   * Deletes one surface's marker; revoking a remote browser removes its
   * `remote:<grantId>` marker along with the rest of that grant's state.
   */
  removeSurface(surfaceId: string): Promise<boolean> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      if (typeof surfaceId !== "string" || !surfaceId) return false;
      const state = await this.#read();
      if (!(surfaceId in state.surfaces)) return false;
      const surfaces = { ...state.surfaces };
      delete surfaces[surfaceId];
      return this.#write({ version: workFoldGlanceSeenStateVersion, surfaces });
    });
    this.#queue = operation;
    return operation;
  }

  /**
   * Markers are disposable preference: a missing, malformed, or
   * future-versioned file resets to no markers, which only over-reports.
   */
  async #read(): Promise<WorkFoldGlanceSeenState> {
    const empty: WorkFoldGlanceSeenState = { version: workFoldGlanceSeenStateVersion, surfaces: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      return empty;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    const record = parsed as { version?: unknown; surfaces?: unknown };
    if (record.version !== workFoldGlanceSeenStateVersion) return empty;
    if (!record.surfaces || typeof record.surfaces !== "object" || Array.isArray(record.surfaces)) return empty;
    const surfaces: Record<string, WorkFoldGlanceSeenMarker> = {};
    for (const [surfaceId, value] of Object.entries(record.surfaces as Record<string, unknown>)) {
      if (!isWorkFoldGlanceSurfaceId(surfaceId)) continue;
      const marker = parseMarker(value);
      if (marker) surfaces[surfaceId] = marker;
    }
    return { version: workFoldGlanceSeenStateVersion, surfaces };
  }

  /**
   * Single atomic small-file write, write-temp-then-rename like the
   * conversation index. A failed write leaves the old marker in place.
   */
  async #write(state: WorkFoldGlanceSeenState): Promise<boolean> {
    const temporary = `${this.path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(state)}\n`, "utf8");
      await rename(temporary, this.path);
      return true;
    } catch {
      await unlink(temporary).catch(() => undefined);
      return false;
    }
  }
}

function parseMarker(value: unknown): WorkFoldGlanceSeenMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { seenThrough?: unknown; updatedAt?: unknown };
  if (typeof record.seenThrough !== "string" || !parseWorkFoldGlanceCursor(record.seenThrough)) return null;
  if (typeof record.updatedAt !== "string" || !record.updatedAt) return null;
  return { seenThrough: record.seenThrough, updatedAt: record.updatedAt };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
