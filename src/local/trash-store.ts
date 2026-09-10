/**
 * Machine-local trash for reversible destruction (docs/receipts-not-gates.md, F20).
 *
 * Nothing work-fold destroys is permanent at the moment it happens. History
 * covers ordinary deletion; whatever History cannot capture (oversized,
 * unreadable, symbolic-link, or always-excluded content), a deleted managed
 * Space folder, and app data that was cleared or purged is moved here instead
 * of erased, and stays restorable for a retention window (default 30 days,
 * 1..365). People see this store as "Recently deleted".
 *
 * Layout under `rootPath` (`workFoldTrashRoot()` in production):
 *
 *   settings.json                              { version: 1, retentionDays, lastPurgeAt }
 *   entries/<entryId>/manifest.json            WorkFoldTrashManifest — the only commit marker
 *   entries/<entryId>/payload/<name>           file | folder | space: the moved tree, original basename
 *   entries/<entryId>/payload/app-data.json    app-storage | app-retained: a RestrictedAppDataBackup
 *   entries/<entryId>/state/                   space only: the Space's machine-local state dir (History)
 *   incoming/<uuid>/                           cross-device copy staging, swept on open()
 *
 * Entry ids are `trash-<yyyymmddHHMMSS>-<uuid8>` (see `workFoldTrashEntryIdPattern`).
 * Directories are 0o700 and files 0o600, like the other machine-local stores.
 *
 * API (every method serializes through one in-process queue):
 *
 *   WorkFoldTrashStore.open(options)        create the layout, load settings, sweep debris
 *   store.trashTree(input)                  move a file, folder, or Space folder in
 *   store.trashAppData(input)               write a verified app-data export in
 *   store.list() / store.get(id)            tolerant listing; damaged records are reported, never dropped
 *   store.restoreTree(id, destination)      move a tree back, collision-renaming like space.ts
 *   store.readAppData(id)                   read and re-verify an app-data export
 *   store.remove(id)                        "Delete now"; refuses (HELD) for legacy `.workspace/` trees
 *   store.purgeExpired(now)                 retention purge; fails closed on legacy trees
 *   store.purgeExpiredIfDue(intervalMs)     the wake-tolerant "once a day while awake" wrapper
 *   store.retentionDays() / setRetentionDays(days)   1..365; rewrites every entry's `restoreBy`
 *
 * Invariants:
 *
 * - Nothing inside a moved tree is read except during size measurement and
 *   the legacy-metadata walk; symbolic links are never followed (`lstat`
 *   everywhere; the copy fallback copies links verbatim).
 * - `manifest.json` is the commit marker. `trashTree` writes it `complete:
 *   false`, moves the source with `rename` (falling back to a verbatim copy
 *   into `incoming/`, fsync, rename into place, then release of the source
 *   when the devices differ), and rewrites it `complete: true`. A crash
 *   therefore leaves either nothing (the source untouched, the entry
 *   directory removed) or a listable entry whose payload exists; `list()`
 *   repairs the latter's `complete` flag lazily.
 * - Manifests are validated on read (closed shape, enums, ISO dates, id
 *   pattern, payload shape). Anything else lands in `damaged` with the
 *   reason and is never removed silently.
 * - Ids come only from the store and are re-validated against
 *   `workFoldTrashEntryIdPattern` before any path join.
 * - Reserved names inside payloads (`.work-fold`, `.pi`, `.workspace`) are
 *   data, never interpreted — except that a tree holding legacy
 *   `.workspace/` records is never erased by retention or "Delete now" (the
 *   clean-break rule). Such an entry is marked `held`; the person can still
 *   restore it or handle the folder outside the product.
 */
import { randomUUID } from "node:crypto";
import { existsSync, type CopyOptions } from "node:fs";
import { cp, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import {
  parseDataNamespaceId,
  parseFeatureInstallationId,
  parseRuntimeInstanceId,
  parseTenantId,
} from "./agent/app-platform-contract.js";
import {
  validateRestrictedAppDataBackup,
  type RestrictedAppDataBackup,
  type RestrictedAppStorageOwner,
} from "./agent/restricted-app-storage.js";

export const WORKFOLD_TRASH_DEFAULT_RETENTION_DAYS = 30;
export const WORKFOLD_TRASH_MIN_RETENTION_DAYS = 1;
export const WORKFOLD_TRASH_MAX_RETENTION_DAYS = 365;
/** "Daily while awake": `purgeExpiredIfDue` runs at most this often by default. */
export const WORKFOLD_TRASH_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Shape of every entry id; CLI and route input must match it before any path join. */
export const workFoldTrashEntryIdPattern = /^trash-\d{14}-[0-9a-f]{8}$/;

export type WorkFoldTrashKind = "file" | "folder" | "space" | "app-storage" | "app-retained";

export type WorkFoldTrashReason =
  | "files.delete"
  | "spaces.delete"
  | "apps.storage.clear"
  | "apps.retained.purge"
  | "apps.uninstall.purge";

/** Why History alone could not keep a copy of one path inside a trashed entry. */
export interface WorkFoldTrashUncoveredPath {
  /** Space-relative path inside the moved entry. */
  path: string;
  /** Mirrors `CheckpointSkippedFile.reason` in history.ts. */
  reason: "too_large" | "unreadable" | "symbolic_link" | "excluded";
}

export type WorkFoldTrashAppDataIdentity = {
  kind: "app-data";
  appId: string;
  appDigest: string;
  featureInstallationId: string;
  runtimeInstanceId: string;
  dataNamespaceId: string;
  sourceSpaceId: string;
  projectId: string;
  releaseDigest: string | null;
  /** app-retained only. */
  retainedDataId?: string;
};

export type WorkFoldTrashPayload =
  /** file | folder | space: the basename of the moved tree under `payload/`. */
  | { kind: "tree"; name: string }
  | WorkFoldTrashAppDataIdentity;

export interface WorkFoldTrashHold {
  /**
   * `legacy-metadata`: the tree holds `.workspace/` records from the earlier
   * product, which work-fold never erases. `unreadable`: a directory inside
   * the tree could not be listed, so the store cannot prove it holds none.
   */
  reason: "legacy-metadata" | "unreadable";
  noticedAt: string;
}

export interface WorkFoldTrashManifest {
  version: 1;
  id: string;
  kind: WorkFoldTrashKind;
  reason: WorkFoldTrashReason;
  spaceId: string;
  /** Display and Space re-registration. */
  spaceName?: string;
  /** file/folder: Space-relative path. space: absolute managed folder path. app-*: `<appId>/<dataNamespaceId>`. */
  originalPath: string;
  sizeBytes: number;
  /** The measurement walk hit its budget, so `sizeBytes` is a lower bound. */
  sizeApproximate?: true;
  deletedAt: string;
  restoreBy: string;
  /** The act request id (CLI) or the desktop's minted `settings:`/`desktop:` request id that produced the entry. */
  receiptId: string | null;
  payload: WorkFoldTrashPayload;
  /** False until the move landed (crash marker). */
  complete: boolean;
  /** files.delete: why History alone could not cover it. */
  uncovered?: WorkFoldTrashUncoveredPath[];
  /** Set at purge or "Delete now" time; a held entry is never erased by the store. */
  held?: WorkFoldTrashHold;
  /** space: the History state dir travelled with the folder and sits under `state/`. */
  stateDir?: true;
}

export interface WorkFoldTrashEntry extends WorkFoldTrashManifest {
  entryPath: string;
  payloadPath: string;
}

export interface WorkFoldTrashDamagedRecord {
  id: string;
  error: string;
}

export interface WorkFoldTrashListing {
  /** Newest first. */
  entries: WorkFoldTrashEntry[];
  /** Records the store cannot read or trust. They are never removed silently. */
  damaged: WorkFoldTrashDamagedRecord[];
  retentionDays: number;
}

export type WorkFoldTrashErrorCode = "NOT_FOUND" | "INPUT_INVALID" | "STORE_DAMAGED" | "HELD" | "MOVE_FAILED";

export class WorkFoldTrashError extends Error {
  readonly code: WorkFoldTrashErrorCode;
  /** Present when the failure left (or refused to remove) a specific entry. */
  readonly entryId?: string;

  constructor(code: WorkFoldTrashErrorCode, message: string, options: { entryId?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkFoldTrashError";
    this.code = code;
    if (options.entryId !== undefined) this.entryId = options.entryId;
  }
}

/** Filesystem seams for tests (cross-device fallback, failing moves). Production uses node:fs. */
export interface WorkFoldTrashStoreIo {
  rename?(from: string, to: string): Promise<void>;
  cp?(from: string, to: string, options: CopyOptions): Promise<void>;
}

export interface WorkFoldTrashStoreOptions {
  /** `workFoldTrashRoot()` in production; a temporary directory in tests. */
  rootPath: string;
  now?: () => Date;
  /** 1..365; default 30. Applied only when `settings.json` does not exist yet. */
  defaultRetentionDays?: number;
  io?: WorkFoldTrashStoreIo;
}

export interface WorkFoldTrashTreeInput {
  kind: "file" | "folder" | "space";
  reason: WorkFoldTrashReason;
  /** Absolute path of the file or directory to move (for `space`, the removal claim path). */
  sourcePath: string;
  spaceId: string;
  spaceName?: string;
  /** Space-relative path (file/folder) or the absolute original root (space). Its basename names the payload. */
  originalPath: string;
  receiptId: string | null;
  uncovered?: WorkFoldTrashUncoveredPath[];
  /** space: absolute `spaceStateDir` to move under `state/`; a missing directory is fine. */
  stateDirPath?: string;
}

export interface WorkFoldTrashAppDataInput {
  kind: "app-storage" | "app-retained";
  reason: WorkFoldTrashReason;
  /** From restricted-app-storage.ts `exportData` / the service's `exportStorage`. */
  backup: RestrictedAppDataBackup;
  identity: WorkFoldTrashAppDataIdentity;
  spaceId: string;
  spaceName?: string;
  receiptId: string | null;
}

export interface WorkFoldTrashRestoreDestination {
  /** Where the tree goes back. An occupied path is collision-renamed (`stem (2).ext` / `name-2`). */
  absolutePath: string;
  /** space entries whose History state travelled: where `state/` goes back. */
  stateDirPath?: string;
  /** Alternative to `stateDirPath` that sees the final (possibly renamed) path first. */
  stateDirFor?: (restoredPath: string) => string;
}

export interface WorkFoldTrashRestoreResult {
  restoredPath: string;
  renamed: boolean;
  stateDirMovedTo?: string;
}

export interface WorkFoldTrashPurgeResult {
  purged: string[];
  held: string[];
  failed: WorkFoldTrashDamagedRecord[];
}

const TRASH_KINDS: readonly WorkFoldTrashKind[] = ["file", "folder", "space", "app-storage", "app-retained"];
const TRASH_REASONS: readonly WorkFoldTrashReason[] = [
  "files.delete", "spaces.delete", "apps.storage.clear", "apps.retained.purge", "apps.uninstall.purge",
];
const UNCOVERED_REASONS: readonly WorkFoldTrashUncoveredPath["reason"][] = ["too_large", "unreadable", "symbolic_link", "excluded"];
const HOLD_REASONS: readonly WorkFoldTrashHold["reason"][] = ["legacy-metadata", "unreadable"];
const MANIFEST_KEYS = new Set([
  "version", "id", "kind", "reason", "spaceId", "spaceName", "originalPath", "sizeBytes", "sizeApproximate",
  "deletedAt", "restoreBy", "receiptId", "payload", "complete", "uncovered", "held", "stateDir",
]);
const APP_DATA_IDENTITY_KEYS = new Set([
  "kind", "appId", "appDigest", "featureInstallationId", "runtimeInstanceId", "dataNamespaceId",
  "sourceSpaceId", "projectId", "releaseDigest", "retainedDataId",
]);
const APP_DATA_FILE = "app-data.json";
const MANIFEST_FILE = "manifest.json";
const MEASURE_ENTRY_BUDGET = 64 * 1024;
const MAX_UNCOVERED_PATHS = 65536;
const MAX_TEXT_LENGTH = 4096;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const LEGACY_METADATA_SEGMENT = ".workspace";
const RECENTLY_DELETED = "Recently deleted";

interface TrashSettingsFile {
  version: 1;
  retentionDays: number;
  lastPurgeAt: string | null;
}

type EntryRead =
  | { state: "entry"; entry: WorkFoldTrashEntry }
  | { state: "damaged"; id: string; error: string }
  | { state: "absent" };

/** Thrown by `#move`; `landed` says whether the destination already holds a complete copy. */
class MoveError extends Error {
  constructor(readonly landed: boolean, cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "MoveError";
  }
}

export class WorkFoldTrashStore {
  readonly rootPath: string;
  readonly #now: () => Date;
  readonly #io: Required<WorkFoldTrashStoreIo>;
  #settings: TrashSettingsFile;
  #queue: Promise<void> = Promise.resolve();

  private constructor(rootPath: string, options: WorkFoldTrashStoreOptions, settings: TrashSettingsFile) {
    this.rootPath = rootPath;
    this.#now = options.now ?? (() => new Date());
    this.#io = {
      rename: options.io?.rename ?? ((from, to) => rename(from, to)),
      cp: options.io?.cp ?? ((from, to, copyOptions) => cp(from, to, copyOptions)),
    };
    this.#settings = settings;
  }

  /**
   * Creates the layout, reads or creates `settings.json`, sweeps `incoming/`
   * and pure debris under `entries/` (a directory with neither a manifest, a
   * payload, nor state). Never deletes anything that holds a payload, even
   * without a manifest: `list()` reports it under `damaged`.
   */
  static async open(options: WorkFoldTrashStoreOptions): Promise<WorkFoldTrashStore> {
    const rootPath = resolve(options.rootPath);
    const defaultRetentionDays = options.defaultRetentionDays ?? WORKFOLD_TRASH_DEFAULT_RETENTION_DAYS;
    assertRetentionDays(defaultRetentionDays);
    await mkdir(rootPath, { recursive: true, mode: 0o700 });
    await mkdir(join(rootPath, "entries"), { recursive: true, mode: 0o700 });
    await mkdir(join(rootPath, "incoming"), { recursive: true, mode: 0o700 });
    const settings = await loadSettings(join(rootPath, "settings.json"), defaultRetentionDays);
    const store = new WorkFoldTrashStore(rootPath, options, settings);
    await store.#sweep();
    return store;
  }

  retentionDays(): number {
    return this.#settings.retentionDays;
  }

  /** Last retention purge, or null when none has run at this root yet. */
  lastPurgeAt(): string | null {
    return this.#settings.lastPurgeAt;
  }

  /** Validates 1..365, rewrites `settings.json`, and rewrites `restoreBy` on every readable complete manifest. */
  async setRetentionDays(days: number): Promise<void> {
    assertRetentionDays(days);
    await this.#mutate(async () => {
      await this.#writeSettings({ ...this.#settings, retentionDays: days });
      let firstFailure: unknown = null;
      for (const entry of (await this.#readAll(false)).entries) {
        if (!entry.complete) continue;
        try {
          await this.#writeManifest(entry.entryPath, { ...manifestOf(entry), restoreBy: addDays(entry.deletedAt, days) });
        } catch (error) {
          firstFailure ??= error;
        }
      }
      if (firstFailure !== null) {
        throw new WorkFoldTrashError(
          "STORE_DAMAGED",
          `work-fold saved the new retention but could not update every item in ${RECENTLY_DELETED}: ${errorMessage(firstFailure)}`,
          { cause: firstFailure },
        );
      }
    });
  }

  /**
   * Moves a file, folder, or Space folder into the trash. Crash-safe order:
   * entry dir → manifest `{complete:false}` → move source → optional state
   * dir → measure → manifest `{complete:true}`. A failure before the source
   * moved removes the entry directory and throws MOVE_FAILED (nothing was
   * moved). A failure after the copy landed keeps the entry — the copy is now
   * the only complete one — and throws MOVE_FAILED naming it.
   */
  async trashTree(input: WorkFoldTrashTreeInput): Promise<WorkFoldTrashEntry> {
    const sourcePath = requireAbsolutePath(input.sourcePath, "The path to move");
    if (input.kind !== "file" && input.kind !== "folder" && input.kind !== "space") {
      throw new WorkFoldTrashError("INPUT_INVALID", "Only files, folders, and Space folders can be moved as trees.");
    }
    assertReason(input.reason);
    const spaceId = requireText(input.spaceId, "Space id", 160);
    const spaceName = input.spaceName === undefined ? undefined : requireText(input.spaceName, "Space name", 200);
    const originalPath = requireText(input.originalPath, "The original path", MAX_TEXT_LENGTH);
    const receiptId = requireReceiptId(input.receiptId);
    const uncovered = normalizeUncovered(input.uncovered);
    const name = payloadNameFor(originalPath);
    const stateDirPath = input.stateDirPath === undefined ? undefined : requireAbsolutePath(input.stateDirPath, "The Space state path");
    if (stateDirPath !== undefined && input.kind !== "space") {
      throw new WorkFoldTrashError("INPUT_INVALID", "Only a Space folder carries History state with it.");
    }
    const sourceInfo = await lstat(sourcePath).catch((error: NodeJS.ErrnoException) => {
      throw new WorkFoldTrashError("MOVE_FAILED", `work-fold could not move ${sourcePath} into ${RECENTLY_DELETED}: ${errorMessage(error)}. Nothing was moved.`, { cause: error });
    });
    if (input.kind === "file" ? sourceInfo.isDirectory() : !sourceInfo.isDirectory()) {
      throw new WorkFoldTrashError(
        "INPUT_INVALID",
        input.kind === "file" ? `${sourcePath} is a folder, not a file.` : `${sourcePath} is not a folder.`,
      );
    }

    return await this.#mutate(async () => {
      const deletedAt = this.#now().toISOString();
      const id = newEntryId(deletedAt);
      const entryPath = join(this.rootPath, "entries", id);
      const payloadDir = join(entryPath, "payload");
      const payloadPath = join(payloadDir, name);
      const manifest: WorkFoldTrashManifest = {
        version: 1,
        id,
        kind: input.kind,
        reason: input.reason,
        spaceId,
        ...(spaceName === undefined ? {} : { spaceName }),
        originalPath,
        sizeBytes: 0,
        deletedAt,
        restoreBy: addDays(deletedAt, this.#settings.retentionDays),
        receiptId,
        payload: { kind: "tree", name },
        complete: false,
        ...(uncovered.length ? { uncovered } : {}),
      };
      try {
        await mkdir(entryPath, { mode: 0o700 });
        await mkdir(payloadDir, { mode: 0o700 });
        await this.#writeManifest(entryPath, manifest);
      } catch (error) {
        await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
        throw new WorkFoldTrashError("MOVE_FAILED", `work-fold could not prepare ${RECENTLY_DELETED}: ${errorMessage(error)}. Nothing was moved.`, { cause: error });
      }
      try {
        await this.#move(sourcePath, payloadPath, { stagingDir: this.#newStagingDir() });
      } catch (error) {
        if (error instanceof MoveError && error.landed) {
          throw new WorkFoldTrashError(
            "MOVE_FAILED",
            `work-fold copied ${sourcePath} into ${RECENTLY_DELETED} (${id}) but could not release the original: ${error.message}. The copy is kept there.`,
            { entryId: id, cause: error },
          );
        }
        await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
        throw new WorkFoldTrashError("MOVE_FAILED", `work-fold could not move ${sourcePath} into ${RECENTLY_DELETED}: ${errorMessage(error)}. Nothing was moved.`, { cause: error });
      }
      // From here the source is gone: the entry stays whatever happens next.
      let stateDir = false;
      if (stateDirPath !== undefined) {
        const stateInfo = await lstat(stateDirPath).catch(() => null);
        if (stateInfo?.isDirectory()) {
          try {
            await this.#move(stateDirPath, join(entryPath, "state"), { stagingDir: this.#newStagingDir() });
            stateDir = true;
          } catch (error) {
            throw new WorkFoldTrashError(
              "MOVE_FAILED",
              `work-fold moved ${sourcePath} into ${RECENTLY_DELETED} (${id}) but could not move its History state along: ${errorMessage(error)}.`,
              { entryId: id, cause: error },
            );
          }
        }
      }
      const measured = await measureTree(payloadPath);
      const completed: WorkFoldTrashManifest = {
        ...manifest,
        sizeBytes: measured.sizeBytes,
        ...(measured.approximate ? { sizeApproximate: true as const } : {}),
        complete: true,
        ...(stateDir ? { stateDir: true as const } : {}),
      };
      await this.#writeManifest(entryPath, completed).catch(() => undefined); // list() repairs a missed commit
      return { ...completed, entryPath, payloadPath };
    });
  }

  /**
   * Writes a verified app-data export as `payload/app-data.json`. The backup
   * is re-validated exactly as `validateRestrictedAppDataBackup` does (closed
   * shape, identity, sha256); a mismatch is INPUT_INVALID and nothing is
   * written.
   */
  async trashAppData(input: WorkFoldTrashAppDataInput): Promise<WorkFoldTrashEntry> {
    if (input.kind !== "app-storage" && input.kind !== "app-retained") {
      throw new WorkFoldTrashError("INPUT_INVALID", "Only app data exports can be kept this way.");
    }
    assertReason(input.reason);
    const spaceId = requireText(input.spaceId, "Space id", 160);
    const spaceName = input.spaceName === undefined ? undefined : requireText(input.spaceName, "Space name", 200);
    const receiptId = requireReceiptId(input.receiptId);
    const identity = normalizeAppDataIdentity(input.identity);
    if (input.kind === "app-retained" && identity.retainedDataId === undefined) {
      throw new WorkFoldTrashError("INPUT_INVALID", "Retained app data needs its retained-data id.");
    }
    const backup = verifyBackup(input.backup, identity, "INPUT_INVALID");
    const serialized = `${JSON.stringify(backup)}\n`;

    return await this.#mutate(async () => {
      const deletedAt = this.#now().toISOString();
      const id = newEntryId(deletedAt);
      const entryPath = join(this.rootPath, "entries", id);
      const payloadDir = join(entryPath, "payload");
      const payloadPath = join(payloadDir, APP_DATA_FILE);
      const manifest: WorkFoldTrashManifest = {
        version: 1,
        id,
        kind: input.kind,
        reason: input.reason,
        spaceId,
        ...(spaceName === undefined ? {} : { spaceName }),
        originalPath: `${identity.appId}/${identity.dataNamespaceId}`,
        sizeBytes: Buffer.byteLength(serialized, "utf8"),
        deletedAt,
        restoreBy: addDays(deletedAt, this.#settings.retentionDays),
        receiptId,
        payload: identity,
        complete: false,
      };
      try {
        await mkdir(entryPath, { mode: 0o700 });
        await mkdir(payloadDir, { mode: 0o700 });
        await this.#writeManifest(entryPath, manifest);
        await writeFileAtomic(payloadPath, serialized);
        const completed = { ...manifest, complete: true };
        await this.#writeManifest(entryPath, completed);
        return { ...completed, entryPath, payloadPath };
      } catch (error) {
        await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
        throw new WorkFoldTrashError("MOVE_FAILED", `work-fold could not keep a copy of the app data in ${RECENTLY_DELETED}: ${errorMessage(error)}.`, { cause: error });
      }
    });
  }

  /** Every readable entry, newest first, plus the records that could not be trusted. Repairs missed commits. */
  async list(): Promise<WorkFoldTrashListing> {
    return await this.#mutate(async () => {
      const { entries, damaged } = await this.#readAll(true);
      return { entries, damaged, retentionDays: this.#settings.retentionDays };
    });
  }

  /** One entry by id; null when nothing has that id; STORE_DAMAGED when its record cannot be trusted. */
  async get(id: string): Promise<WorkFoldTrashEntry | null> {
    assertEntryId(id);
    return await this.#mutate(async () => this.#requireReadable(id, true));
  }

  /**
   * Moves a file, folder, or Space folder back. An occupied destination is
   * collision-renamed with the space.ts rules (`stem (2).ext` for files,
   * `name-2` for folders). On success the entry directory is removed. On
   * failure the entry is left intact and MOVE_FAILED is thrown.
   */
  async restoreTree(id: string, destination: WorkFoldTrashRestoreDestination): Promise<WorkFoldTrashRestoreResult> {
    assertEntryId(id);
    const desired = requireAbsolutePath(destination.absolutePath, "The restore destination");
    return await this.#mutate(async () => {
      const entry = await this.#requireEntry(id, true);
      if (entry.payload.kind !== "tree") {
        throw new WorkFoldTrashError("INPUT_INVALID", `${id} holds app data, which cannot be put back as a file or folder this way.`);
      }
      const finalPath = existsSync(desired)
        ? (entry.kind === "file" ? nextAvailableFile(desired) : nextAvailableDirectory(dirname(desired), basename(desired)))
        : desired;
      let stateTarget: string | undefined;
      if (entry.stateDir) {
        const chosen = destination.stateDirFor ? destination.stateDirFor(finalPath) : destination.stateDirPath;
        if (chosen === undefined) {
          throw new WorkFoldTrashError("INPUT_INVALID", `${id} carries the Space's History state; say where that state goes back.`);
        }
        stateTarget = requireAbsolutePath(chosen, "The History state destination");
        if (existsSync(stateTarget)) {
          throw new WorkFoldTrashError(
            "MOVE_FAILED",
            `work-fold could not restore ${basename(finalPath)}: History state already exists at ${stateTarget}. It is still in ${RECENTLY_DELETED}.`,
            { entryId: id },
          );
        }
      }
      const failure = (error: unknown): WorkFoldTrashError => new WorkFoldTrashError(
        "MOVE_FAILED",
        `work-fold could not restore ${entry.payload.kind === "tree" ? entry.payload.name : id} to ${finalPath}: ${errorMessage(error)}. It is still in ${RECENTLY_DELETED}.`,
        { entryId: id, cause: error },
      );
      try {
        await mkdir(dirname(finalPath), { recursive: true });
        await this.#move(entry.payloadPath, finalPath);
      } catch (error) {
        if (error instanceof MoveError && error.landed) {
          // The copy is in place but the trash still holds the original; keep it so nothing is lost twice.
          throw new WorkFoldTrashError(
            "MOVE_FAILED",
            `work-fold copied ${basename(finalPath)} back to ${finalPath} but could not clear the copy in ${RECENTLY_DELETED}: ${error.message}.`,
            { entryId: id, cause: error },
          );
        }
        throw failure(error);
      }
      let stateDirMovedTo: string | undefined;
      if (stateTarget !== undefined) {
        try {
          await mkdir(dirname(stateTarget), { recursive: true, mode: 0o700 });
          await this.#move(join(entry.entryPath, "state"), stateTarget);
          stateDirMovedTo = stateTarget;
        } catch (error) {
          // Best-effort rollback so the entry stays restorable as a whole.
          await this.#io.rename(finalPath, entry.payloadPath).catch(() => undefined);
          throw failure(error);
        }
      }
      await this.#erase(entry.entryPath);
      return { restoredPath: finalPath, renamed: finalPath !== desired, ...(stateDirMovedTo === undefined ? {} : { stateDirMovedTo }) };
    });
  }

  /** Reads an app-data export back and re-verifies it; a tampered or truncated file is STORE_DAMAGED. */
  async readAppData(id: string): Promise<RestrictedAppDataBackup> {
    assertEntryId(id);
    return await this.#mutate(async () => {
      const entry = await this.#requireEntry(id, false);
      if (entry.payload.kind !== "app-data") {
        throw new WorkFoldTrashError("INPUT_INVALID", `${id} is a ${entry.kind}, not app data.`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(entry.payloadPath, "utf8"));
      } catch (error) {
        throw new WorkFoldTrashError("STORE_DAMAGED", `The app data kept as ${id} in ${RECENTLY_DELETED} cannot be read: ${errorMessage(error)}`, { entryId: id, cause: error });
      }
      return verifyBackup(parsed, entry.payload, "STORE_DAMAGED", id);
    });
  }

  /**
   * "Delete now" and post-restore cleanup of app-data entries. Refuses with
   * HELD when the tree holds legacy `.workspace/` records or cannot be fully
   * listed (the clean-break rule) and marks the manifest `held`. A damaged
   * record is removed only when the same walk clears it.
   */
  async remove(id: string): Promise<{ removed: boolean }> {
    assertEntryId(id);
    return await this.#mutate(async () => {
      const read = await this.#readEntry(id, false);
      if (read.state === "absent") return { removed: false };
      const entryPath = join(this.rootPath, "entries", id);
      if (read.state === "entry" && read.entry.held) throw heldError(read.entry.held, id, entryPath);
      const hold = await holdReasonFor(entryPath);
      if (hold) {
        const held: WorkFoldTrashHold = { reason: hold, noticedAt: this.#now().toISOString() };
        if (read.state === "entry") {
          await this.#writeManifest(entryPath, { ...manifestOf(read.entry), held }).catch(() => undefined);
        }
        throw heldError(held, id, entryPath);
      }
      await this.#erase(entryPath);
      return { removed: true };
    });
  }

  /**
   * Erases every complete entry whose `restoreBy` has passed, except trees
   * that hold legacy `.workspace/` records or cannot be fully listed: those
   * become `held` and stay. Never throws for a single entry; records
   * `lastPurgeAt` in `settings.json`.
   */
  async purgeExpired(now: Date = this.#now()): Promise<WorkFoldTrashPurgeResult> {
    return await this.#mutate(async () => {
      const result: WorkFoldTrashPurgeResult = { purged: [], held: [], failed: [] };
      for (const entry of (await this.#readAll(false)).entries) {
        if (entry.held) {
          result.held.push(entry.id);
          continue;
        }
        if (!entry.complete || Date.parse(entry.restoreBy) > now.getTime()) continue;
        try {
          const hold = await holdReasonFor(entry.entryPath);
          if (hold) {
            await this.#writeManifest(entry.entryPath, { ...manifestOf(entry), held: { reason: hold, noticedAt: now.toISOString() } });
            result.held.push(entry.id);
            continue;
          }
          await this.#erase(entry.entryPath);
          result.purged.push(entry.id);
        } catch (error) {
          result.failed.push({ id: entry.id, error: errorMessage(error) });
        }
      }
      await this.#writeSettings({ ...this.#settings, lastPurgeAt: now.toISOString() });
      return result;
    });
  }

  /** Runs `purgeExpired` only when at least `intervalMs` passed since the last purge (wake-tolerant daily cadence). */
  async purgeExpiredIfDue(intervalMs: number = WORKFOLD_TRASH_PURGE_INTERVAL_MS): Promise<WorkFoldTrashPurgeResult | null> {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new WorkFoldTrashError("INPUT_INVALID", "The purge interval must be a non-negative number of milliseconds.");
    }
    const now = this.#now();
    const last = this.#settings.lastPurgeAt === null ? Number.NaN : Date.parse(this.#settings.lastPurgeAt);
    if (Number.isFinite(last) && now.getTime() - last < intervalMs) return null;
    return await this.purgeExpired(now);
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return await result;
  }

  #newStagingDir(): string {
    return join(this.rootPath, "incoming", randomUUID());
  }

  async #sweep(): Promise<void> {
    const incoming = join(this.rootPath, "incoming");
    for (const name of await readdir(incoming).catch(() => [] as string[])) {
      await rm(join(incoming, name), { recursive: true, force: true }).catch(() => undefined);
    }
    const entries = join(this.rootPath, "entries");
    for (const name of await readdir(entries).catch(() => [] as string[])) {
      const entryPath = join(entries, name);
      const keeps = [MANIFEST_FILE, "payload", "state"].some((child) => existsSync(join(entryPath, child)));
      if (!keeps) await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #writeSettings(settings: TrashSettingsFile): Promise<void> {
    await writeFileAtomic(join(this.rootPath, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    this.#settings = settings;
  }

  async #writeManifest(entryPath: string, manifest: WorkFoldTrashManifest): Promise<void> {
    await writeFileAtomic(join(entryPath, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /**
   * Moves `source` to `destination`: `rename` first; when the devices differ,
   * a verbatim copy (symbolic links copied as links, never followed) into
   * `stagingDir` (or straight to the destination), fsync, rename into place,
   * then release of the source. Throws `MoveError` with `landed: true` only
   * once the destination holds a complete copy.
   */
  async #move(source: string, destination: string, options: { stagingDir?: string } = {}): Promise<void> {
    try {
      await this.#io.rename(source, destination);
      return;
    } catch (error) {
      if (!isNodeError(error, "EXDEV")) throw new MoveError(false, error);
    }
    const stagingDir = options.stagingDir;
    const copyTarget = stagingDir === undefined ? destination : join(stagingDir, basename(destination));
    try {
      if (stagingDir !== undefined) await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      await this.#io.cp(source, copyTarget, {
        recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true,
      });
      await syncTree(copyTarget);
      if (stagingDir !== undefined) await this.#io.rename(copyTarget, destination);
    } catch (error) {
      await rm(stagingDir ?? copyTarget, { recursive: true, force: true }).catch(() => undefined);
      throw new MoveError(false, error);
    }
    if (stagingDir !== undefined) await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    try {
      await rm(source, { recursive: true, force: true });
    } catch (error) {
      throw new MoveError(true, error);
    }
  }

  /** Removes an entry directory atomically from the listing: rename into `incoming/`, then erase. */
  async #erase(entryPath: string): Promise<void> {
    const parked = this.#newStagingDir();
    try {
      await rename(entryPath, parked);
    } catch {
      await rm(entryPath, { recursive: true, force: true });
      return;
    }
    await rm(parked, { recursive: true, force: true });
  }

  async #readAll(repair: boolean): Promise<{ entries: WorkFoldTrashEntry[]; damaged: WorkFoldTrashDamagedRecord[] }> {
    const entriesDir = join(this.rootPath, "entries");
    const entries: WorkFoldTrashEntry[] = [];
    const damaged: WorkFoldTrashDamagedRecord[] = [];
    for (const name of await readdir(entriesDir).catch(() => [] as string[])) {
      if (!workFoldTrashEntryIdPattern.test(name)) {
        const info = await lstat(join(entriesDir, name)).catch(() => null);
        if (info?.isDirectory()) damaged.push({ id: name, error: `${name} is not a ${RECENTLY_DELETED} record name.` });
        continue;
      }
      const read = await this.#readEntry(name, repair);
      if (read.state === "entry") entries.push(read.entry);
      else if (read.state === "damaged") damaged.push({ id: read.id, error: read.error });
    }
    entries.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt) || right.id.localeCompare(left.id));
    damaged.sort((left, right) => left.id.localeCompare(right.id));
    return { entries, damaged };
  }

  async #requireReadable(id: string, repair: boolean): Promise<WorkFoldTrashEntry | null> {
    const read = await this.#readEntry(id, repair);
    if (read.state === "absent") return null;
    if (read.state === "damaged") {
      throw new WorkFoldTrashError("STORE_DAMAGED", `The ${RECENTLY_DELETED} record ${id} is damaged: ${read.error}`, { entryId: id });
    }
    return read.entry;
  }

  async #requireEntry(id: string, repair: boolean): Promise<WorkFoldTrashEntry> {
    const entry = await this.#requireReadable(id, repair);
    if (!entry) throw new WorkFoldTrashError("NOT_FOUND", `Nothing in ${RECENTLY_DELETED} has the id ${id}.`, { entryId: id });
    return entry;
  }

  async #readEntry(id: string, repair: boolean): Promise<EntryRead> {
    const entryPath = join(this.rootPath, "entries", id);
    const info = await lstat(entryPath).catch(() => null);
    if (!info) return { state: "absent" };
    if (!info.isDirectory()) return { state: "damaged", id, error: "the record is not a directory." };
    let raw: string;
    try {
      raw = await readFile(join(entryPath, MANIFEST_FILE), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        const hasContent = ["payload", "state"].some((child) => existsSync(join(entryPath, child)));
        return hasContent ? { state: "damaged", id, error: "manifest.json is missing but content is present." } : { state: "absent" };
      }
      return { state: "damaged", id, error: `manifest.json cannot be read: ${errorMessage(error)}` };
    }
    let manifest: WorkFoldTrashManifest;
    try {
      manifest = parseManifest(JSON.parse(raw));
    } catch (error) {
      return { state: "damaged", id, error: `manifest.json is not a valid record: ${errorMessage(error)}` };
    }
    if (manifest.id !== id) return { state: "damaged", id, error: `manifest.json names ${manifest.id} instead of ${id}.` };
    const payloadPath = join(entryPath, "payload", manifest.payload.kind === "tree" ? manifest.payload.name : APP_DATA_FILE);
    const payloadInfo = await lstat(payloadPath).catch(() => null);
    if (!payloadInfo) {
      return { state: "damaged", id, error: manifest.complete ? "its content is missing." : "its content never arrived." };
    }
    if (manifest.stateDir && !existsSync(join(entryPath, "state"))) {
      return { state: "damaged", id, error: "its History state is missing." };
    }
    if (!manifest.complete) {
      // The move landed but the commit never happened (a crash between the two manifest writes).
      const measured = manifest.payload.kind === "tree" ? await measureTree(payloadPath) : { sizeBytes: payloadInfo.size, approximate: false };
      manifest = {
        ...manifest,
        sizeBytes: measured.sizeBytes,
        ...(measured.approximate ? { sizeApproximate: true as const } : {}),
        complete: true,
      };
      if (repair) await this.#writeManifest(entryPath, manifest).catch(() => undefined);
    }
    return { state: "entry", entry: { ...manifest, entryPath, payloadPath } };
  }
}

function manifestOf(entry: WorkFoldTrashEntry): WorkFoldTrashManifest {
  const { entryPath: _entryPath, payloadPath: _payloadPath, ...manifest } = entry;
  return manifest;
}

function heldError(held: WorkFoldTrashHold, id: string, entryPath: string): WorkFoldTrashError {
  return new WorkFoldTrashError(
    "HELD",
    held.reason === "legacy-metadata"
      ? `This item holds records from the earlier Workspace product, so work-fold never erases it. Open its folder to handle it yourself: ${entryPath}`
      : `work-fold could not look through everything in this item, so it will not erase it. Open its folder to handle it yourself: ${entryPath}`,
    { entryId: id },
  );
}

function newEntryId(deletedAt: string): string {
  return `trash-${deletedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 24 * 60 * 60 * 1000).toISOString();
}

function assertRetentionDays(days: number): void {
  if (!Number.isInteger(days) || days < WORKFOLD_TRASH_MIN_RETENTION_DAYS || days > WORKFOLD_TRASH_MAX_RETENTION_DAYS) {
    throw new WorkFoldTrashError(
      "INPUT_INVALID",
      `Deleted items can be kept for a whole number of days between ${WORKFOLD_TRASH_MIN_RETENTION_DAYS} and ${WORKFOLD_TRASH_MAX_RETENTION_DAYS}.`,
    );
  }
}

function assertEntryId(id: string): void {
  if (typeof id !== "string" || !workFoldTrashEntryIdPattern.test(id)) {
    throw new WorkFoldTrashError("INPUT_INVALID", `${RECENTLY_DELETED} ids look like trash-YYYYMMDDHHMMSS-xxxxxxxx.`);
  }
}

function assertReason(reason: unknown): asserts reason is WorkFoldTrashReason {
  if (!TRASH_REASONS.includes(reason as WorkFoldTrashReason)) {
    throw new WorkFoldTrashError("INPUT_INVALID", "The reason must name the delete, Space, or app-data command that produced the item.");
  }
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || FORBIDDEN_TEXT.test(value)) {
    throw new WorkFoldTrashError("INPUT_INVALID", `${label} must be plain text of at most ${maxLength} characters.`);
  }
  return value;
}

function requireReceiptId(value: unknown): string | null {
  if (value === null) return null;
  return requireText(value, "The receipt id", 200);
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value) || FORBIDDEN_TEXT.test(value)) {
    throw new WorkFoldTrashError("INPUT_INVALID", `${label} must be an absolute path.`);
  }
  return resolve(value);
}

function payloadNameFor(originalPath: string): string {
  const name = basename(originalPath.replace(/[\\/]+$/, ""));
  if (!isSafeSegment(name)) {
    throw new WorkFoldTrashError("INPUT_INVALID", "The original path must end in a file or folder name.");
  }
  return name;
}

function isSafeSegment(name: string): boolean {
  return typeof name === "string" && name.length > 0 && name.length <= 255 && name !== "." && name !== ".."
    && !/[\\/\u0000-\u001f]/.test(name);
}

function normalizeUncovered(value: unknown): WorkFoldTrashUncoveredPath[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_UNCOVERED_PATHS) {
    throw new WorkFoldTrashError("INPUT_INVALID", `The uncovered paths must be a list of at most ${MAX_UNCOVERED_PATHS} items.`);
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some((key) => key !== "path" && key !== "reason")
      || !UNCOVERED_REASONS.includes((item as WorkFoldTrashUncoveredPath).reason)) {
      throw new WorkFoldTrashError("INPUT_INVALID", "Each uncovered path needs a path and one of the History skip reasons.");
    }
    return { path: requireText((item as WorkFoldTrashUncoveredPath).path, "An uncovered path", MAX_TEXT_LENGTH), reason: (item as WorkFoldTrashUncoveredPath).reason };
  });
}

function normalizeAppDataIdentity(value: unknown): WorkFoldTrashAppDataIdentity {
  const invalid = (): never => {
    throw new WorkFoldTrashError("INPUT_INVALID", "The app data identity must name the app, its revision, installation, instance, namespace, source Space, and project.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  if (Object.keys(value).some((key) => !APP_DATA_IDENTITY_KEYS.has(key))) return invalid();
  const raw = value as Partial<WorkFoldTrashAppDataIdentity>;
  if (raw.kind !== "app-data") return invalid();
  const text = (field: unknown): string => {
    if (typeof field !== "string" || !field.trim() || field.length > 512 || FORBIDDEN_TEXT.test(field)) return invalid();
    return field;
  };
  const identity: WorkFoldTrashAppDataIdentity = {
    kind: "app-data",
    appId: text(raw.appId),
    appDigest: text(raw.appDigest),
    featureInstallationId: text(raw.featureInstallationId),
    runtimeInstanceId: text(raw.runtimeInstanceId),
    dataNamespaceId: text(raw.dataNamespaceId),
    sourceSpaceId: text(raw.sourceSpaceId),
    projectId: text(raw.projectId),
    releaseDigest: raw.releaseDigest === null ? null : text(raw.releaseDigest),
  };
  if (raw.retainedDataId !== undefined) identity.retainedDataId = text(raw.retainedDataId);
  return identity;
}

/**
 * Re-validates a backup exactly as the storage layer does (closed shape,
 * owner identity taken from the export itself, sha256) and checks it names
 * the identity the entry claims.
 */
function verifyBackup(value: unknown, identity: WorkFoldTrashAppDataIdentity, code: "INPUT_INVALID" | "STORE_DAMAGED", entryId?: string): RestrictedAppDataBackup {
  const fail = (reason: string): never => {
    throw new WorkFoldTrashError(
      code,
      code === "INPUT_INVALID"
        ? `The app data export cannot be kept: ${reason}`
        : `The app data kept as ${entryId} in ${RECENTLY_DELETED} failed its integrity check: ${reason}`,
      entryId === undefined ? {} : { entryId },
    );
  };
  const candidate = value as Partial<RestrictedAppDataBackup> | null;
  const data = candidate && typeof candidate === "object" && candidate.data && typeof candidate.data === "object" ? candidate.data : null;
  if (!data) return fail("it is not a complete app data export.");
  if (candidate!.appId !== identity.appId || candidate!.appDigest !== identity.appDigest) return fail("it belongs to a different app or app revision.");
  let owner: RestrictedAppStorageOwner;
  try {
    owner = {
      ownerClass: "instance",
      tenantId: parseTenantId(data.tenantId),
      runtimeInstanceId: parseRuntimeInstanceId(identity.runtimeInstanceId),
      featureInstallationId: parseFeatureInstallationId(identity.featureInstallationId),
      dataNamespaceId: parseDataNamespaceId(identity.dataNamespaceId),
    };
  } catch (error) {
    return fail(errorMessage(error));
  }
  try {
    return validateRestrictedAppDataBackup(value, owner, identity.appId, identity.appDigest);
  } catch (error) {
    return fail(errorMessage(error));
  }
}

function parseManifest(value: unknown): WorkFoldTrashManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  const unknownKey = Object.keys(value).find((key) => !MANIFEST_KEYS.has(key));
  if (unknownKey !== undefined) throw new Error(`unknown field ${unknownKey}`);
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error("unsupported version");
  if (typeof raw.id !== "string" || !workFoldTrashEntryIdPattern.test(raw.id)) throw new Error("invalid id");
  if (!TRASH_KINDS.includes(raw.kind as WorkFoldTrashKind)) throw new Error("invalid kind");
  if (!TRASH_REASONS.includes(raw.reason as WorkFoldTrashReason)) throw new Error("invalid reason");
  if (typeof raw.spaceId !== "string" || !raw.spaceId.trim()) throw new Error("invalid spaceId");
  if (raw.spaceName !== undefined && (typeof raw.spaceName !== "string" || !raw.spaceName.trim())) throw new Error("invalid spaceName");
  if (typeof raw.originalPath !== "string" || !raw.originalPath.trim()) throw new Error("invalid originalPath");
  if (!Number.isSafeInteger(raw.sizeBytes) || (raw.sizeBytes as number) < 0) throw new Error("invalid sizeBytes");
  if (raw.sizeApproximate !== undefined && raw.sizeApproximate !== true) throw new Error("invalid sizeApproximate");
  for (const field of ["deletedAt", "restoreBy"]) {
    if (typeof raw[field] !== "string" || !Number.isFinite(Date.parse(raw[field] as string))) throw new Error(`invalid ${field}`);
  }
  if (raw.receiptId !== null && (typeof raw.receiptId !== "string" || !raw.receiptId.trim())) throw new Error("invalid receiptId");
  if (typeof raw.complete !== "boolean") throw new Error("invalid complete");
  if (raw.stateDir !== undefined && raw.stateDir !== true) throw new Error("invalid stateDir");
  const payload = parsePayload(raw.payload, raw.kind as WorkFoldTrashKind);
  const manifest: WorkFoldTrashManifest = {
    version: 1,
    id: raw.id,
    kind: raw.kind as WorkFoldTrashKind,
    reason: raw.reason as WorkFoldTrashReason,
    spaceId: raw.spaceId,
    originalPath: raw.originalPath,
    sizeBytes: raw.sizeBytes as number,
    deletedAt: raw.deletedAt as string,
    restoreBy: raw.restoreBy as string,
    receiptId: raw.receiptId as string | null,
    payload,
    complete: raw.complete,
  };
  if (raw.spaceName !== undefined) manifest.spaceName = raw.spaceName as string;
  if (raw.sizeApproximate === true) manifest.sizeApproximate = true;
  if (raw.stateDir === true) {
    if (manifest.kind !== "space") throw new Error("only a Space entry carries state");
    manifest.stateDir = true;
  }
  if (raw.uncovered !== undefined) {
    try {
      manifest.uncovered = normalizeUncovered(raw.uncovered);
    } catch {
      throw new Error("invalid uncovered");
    }
  }
  if (raw.held !== undefined) {
    const held = raw.held as Partial<WorkFoldTrashHold> | null;
    if (!held || typeof held !== "object" || Array.isArray(held)
      || Object.keys(held).some((key) => key !== "reason" && key !== "noticedAt")
      || !HOLD_REASONS.includes(held.reason as WorkFoldTrashHold["reason"])
      || typeof held.noticedAt !== "string" || !Number.isFinite(Date.parse(held.noticedAt))) {
      throw new Error("invalid held");
    }
    manifest.held = { reason: held.reason as WorkFoldTrashHold["reason"], noticedAt: held.noticedAt };
  }
  return manifest;
}

function parsePayload(value: unknown, kind: WorkFoldTrashKind): WorkFoldTrashPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid payload");
  const raw = value as Record<string, unknown>;
  if (kind === "file" || kind === "folder" || kind === "space") {
    if (raw.kind !== "tree" || Object.keys(raw).some((key) => key !== "kind" && key !== "name") || !isSafeSegment(raw.name as string)) {
      throw new Error("invalid tree payload");
    }
    return { kind: "tree", name: raw.name as string };
  }
  try {
    return normalizeAppDataIdentity(raw);
  } catch {
    throw new Error("invalid app data payload");
  }
}

async function loadSettings(path: string, defaultRetentionDays: number): Promise<TrashSettingsFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw new WorkFoldTrashError("STORE_DAMAGED", `The ${RECENTLY_DELETED} settings at ${path} cannot be read: ${errorMessage(error)}`, { cause: error });
    }
    const settings: TrashSettingsFile = { version: 1, retentionDays: defaultRetentionDays, lastPurgeAt: null };
    await writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
    return settings;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WorkFoldTrashError("STORE_DAMAGED", `The ${RECENTLY_DELETED} settings at ${path} are not valid JSON. Nothing is guessed from a damaged file.`, { cause: error });
  }
  const record = parsed as Partial<TrashSettingsFile> | null;
  if (!record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).some((key) => !["version", "retentionDays", "lastPurgeAt"].includes(key))
    || record.version !== 1
    || !Number.isInteger(record.retentionDays) || record.retentionDays! < WORKFOLD_TRASH_MIN_RETENTION_DAYS || record.retentionDays! > WORKFOLD_TRASH_MAX_RETENTION_DAYS
    || (record.lastPurgeAt !== null && (typeof record.lastPurgeAt !== "string" || !Number.isFinite(Date.parse(record.lastPurgeAt))))) {
    throw new WorkFoldTrashError("STORE_DAMAGED", `The ${RECENTLY_DELETED} settings at ${path} are not a valid record. Nothing is guessed from a damaged file.`);
  }
  return { version: 1, retentionDays: record.retentionDays!, lastPurgeAt: record.lastPurgeAt ?? null };
}

/** Temp file, fsync, rename; 0o600 like the other machine-local stores. */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(dirname(path));
}

/** Best-effort durability for a copied tree: fsync every regular file and directory, never following links. */
async function syncTree(path: string): Promise<void> {
  const stack = [path];
  while (stack.length) {
    const current = stack.pop()!;
    const info = await lstat(current).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      for (const name of await readdir(current).catch(() => [] as string[])) stack.push(join(current, name));
      await syncDirectory(current);
    } else if (info.isFile()) {
      const handle = await open(current, "r").catch(() => null);
      if (!handle) continue;
      try {
        await handle.sync().catch(() => undefined);
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Bounded size walk (lstat only; links count their own size). */
async function measureTree(path: string): Promise<{ sizeBytes: number; approximate: boolean }> {
  let visited = 0;
  let sizeBytes = 0;
  let approximate = false;
  const stack = [path];
  while (stack.length) {
    const current = stack.pop()!;
    if (++visited > MEASURE_ENTRY_BUDGET) {
      approximate = true;
      break;
    }
    const info = await lstat(current).catch(() => null);
    if (!info) {
      approximate = true;
      continue;
    }
    if (info.isDirectory()) {
      const names = await readdir(current).catch(() => null);
      if (!names) {
        approximate = true;
        continue;
      }
      for (const name of names) stack.push(join(current, name));
    } else {
      sizeBytes += info.size;
    }
  }
  return { sizeBytes, approximate };
}

/**
 * The clean-break rule: a tree that holds a `.workspace` segment is legacy
 * metadata work-fold never erases. Directories only (symbolic links are not
 * descended); an unlistable directory fails closed as `unreadable`.
 */
async function holdReasonFor(entryPath: string): Promise<WorkFoldTrashHold["reason"] | null> {
  const stack = [entryPath];
  while (stack.length) {
    const current = stack.pop()!;
    const children = await readdir(current, { withFileTypes: true }).catch(() => null);
    if (!children) return "unreadable";
    for (const child of children) {
      if (isLegacyMetadataSegment(child.name)) return "legacy-metadata";
      if (child.isDirectory()) stack.push(join(current, child.name));
    }
  }
  return null;
}

function isLegacyMetadataSegment(name: string): boolean {
  return (process.platform === "win32" ? name.toLocaleLowerCase("en-US") : name) === LEGACY_METADATA_SEGMENT;
}

function nextAvailableDirectory(parent: string, segment: string): string {
  let candidate = join(parent, segment);
  for (let index = 2; existsSync(candidate); index += 1) candidate = join(parent, `${segment}-${index}`);
  return candidate;
}

function nextAvailableFile(desired: string): string {
  const extension = extname(desired);
  const stem = basename(desired, extension);
  let index = 2;
  let candidate = join(dirname(desired), `${stem} (${index})${extension}`);
  while (existsSync(candidate)) candidate = join(dirname(desired), `${stem} (${index += 1})${extension}`);
  return candidate;
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
