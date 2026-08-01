import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { TextDecoder } from "node:util";

import {
  canonicalizeJson,
  parseSha256Digest,
  type ProjectId,
  type Sha256Digest,
} from "./app-platform-contract.js";
import {
  AppReleaseError,
  appReleaseDefaultLimits,
  verifyAppRelease,
  type AppReleaseEnvelope,
  type AppReleaseLimits,
  type AppReleasePresentation,
} from "./app-platform-release.js";

export const localAppReleaseStoreFileName = "release.json" as const;

/**
 * Closure bytes count decoded artifact bytes. Their canonical on-disk base64
 * form can require four bytes for every three, while the fixed allowance
 * covers the bounded manifest, references, paths, and JSON structure.
 */
export const localAppReleaseStoreDefaultMaximumBytes =
  Math.ceil(appReleaseDefaultLimits.closureBytes * 4 / 3) + 16 * 1024 * 1024;

/**
 * Release history is durable but not allowed to consume an effectively
 * unbounded user-data volume. Four GiB accommodates many ordinary App versions
 * while keeping the worst valid local store operationally honest.
 */
export const localAppReleaseStoreDefaultMaximumAggregateBytes = 4 * 1024 * 1024 * 1024;

/**
 * Reconciliation is intentionally a bounded maintenance pass. A store beyond
 * this size requires an operator to inspect it instead of allowing one call to
 * turn into an unbounded deletion sweep.
 */
export const localAppReleaseStoreReconciliationMaximumObjects = 4_096;

/**
 * A healthy object contains release.json and, only while a put is committing,
 * one temporary file. The larger bound leaves recovery room for interrupted
 * legacy/concurrent writers without permitting one directory to create an
 * unbounded startup scan.
 */
export const localAppReleaseStoreMaximumObjectEntries = 64;

export type LocalAppReleaseStoreErrorCode =
  | "RELEASE_STORE_INVALID"
  | "RELEASE_STORE_NOT_FOUND"
  | "RELEASE_STORE_LIMIT_EXCEEDED"
  | "RELEASE_STORE_CORRUPT"
  | "RELEASE_STORE_UNSAFE"
  | "RELEASE_STORE_IO";

export class LocalAppReleaseStoreError extends Error {
  constructor(
    readonly code: LocalAppReleaseStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalAppReleaseStoreError";
  }
}

export interface LocalAppReleaseMetadata {
  readonly releaseDigest: Sha256Digest;
  readonly projectId: ProjectId;
  readonly presentation: AppReleasePresentation;
  readonly displayVersion: string;
  readonly runtimeApi: Readonly<{
    name: string;
    compatibleRange: string;
  }>;
  readonly featureIds: readonly string[];
  readonly createdAt: string;
  readonly sizeBytes: number;
}

export interface LocalAppReleaseStoreRecoveryResult {
  readonly removedTemporaryFiles: number;
  readonly cleanupPending: boolean;
}

export interface LocalAppReleaseStoreReconciliationResult {
  readonly removedOrphanObjects: number;
  readonly cleanupPending: boolean;
}

export interface LocalAppReleaseStoreOptions {
  readonly releaseLimits?: AppReleaseLimits;
  readonly aggregateBytes?: number;
  /** Failure-injection seam and platform adapter for orphan pruning. */
  readonly pruneIo?: Partial<LocalAppReleaseStorePruneIo>;
}

export interface LocalAppReleaseStorePruneIo {
  readonly unlink: (path: string) => Promise<void>;
  readonly removeDirectory: (path: string) => Promise<void>;
  readonly syncDirectory: (path: string) => Promise<void>;
}

export interface LocalAppReleaseStoreVerifiedProjection {
  readonly releaseDigest: Sha256Digest;
  readonly projectId: ProjectId;
  readonly presentation: AppReleasePresentation;
  readonly displayVersion: string;
  readonly runtimeApi: Readonly<{
    name: string;
    compatibleRange: string;
  }>;
  readonly features: readonly Readonly<{
    featureId: string;
    featureRevisionMediaType: string;
    featureRevisionDigest: string;
    declarationMediaType: string;
    declarationDigest: Sha256Digest;
    hasDataSchema: boolean;
    migrationCount: number;
  }>[];
  readonly createdAt: string;
  readonly sizeBytes: number;
}

export type LocalAppReleaseStoreReferenceValidator = (
  releases: readonly LocalAppReleaseStoreVerifiedProjection[],
) => void | Promise<void>;

interface StoredRelease {
  release: AppReleaseEnvelope;
  source: string;
  sizeBytes: number;
}

type PathInfo = Awaited<ReturnType<typeof lstat>>;

class ReferenceValidationFailure extends Error {
  constructor(readonly reason: unknown) {
    super("Referenced App Release validation failed.");
    this.name = "ReferenceValidationFailure";
  }
}

interface ReleaseObjectFileSnapshot {
  readonly name: string;
  readonly path: string;
  readonly info: PathInfo;
}

interface ReleaseObjectSnapshot {
  readonly digest: Sha256Digest;
  readonly directory: string;
  readonly directoryInfo: PathInfo;
  readonly files: readonly ReleaseObjectFileSnapshot[];
  /**
   * An incomplete object is a digest directory containing no committed
   * release.json and only store-owned temporary files (or no files at all).
   * This is the precise shape an interrupted put can leave behind.
   */
  readonly state: "complete" | "incomplete";
  readonly referencedProjection: LocalAppReleaseStoreVerifiedProjection | null;
}

interface ReleaseStoreSnapshot {
  readonly rootInfo: PathInfo;
  readonly objects: readonly ReleaseObjectSnapshot[];
}

const digestDirectoryPattern = /^[0-9a-f]{64}$/;
const temporaryFilePattern = /^\.release-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const readChunkBytes = 64 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Durable, immutable storage for fully closed App Releases. Only the verified
 * release envelope is persisted, so host paths and other machine state are
 * never introduced by this store.
 */
export class LocalAppReleaseStore {
  readonly #rootPath: string;
  readonly #limits: AppReleaseLimits;
  readonly #maximumBytes: number;
  readonly #maximumAggregateBytes: number;
  readonly #pruneIo: LocalAppReleaseStorePruneIo;
  #tail: Promise<void> = Promise.resolve();

  constructor(rootPath: string, options: LocalAppReleaseStoreOptions = {}) {
    if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
      throw new LocalAppReleaseStoreError("RELEASE_STORE_INVALID", "App Release store root must be a non-empty path.");
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new LocalAppReleaseStoreError("RELEASE_STORE_INVALID", "App Release store options must be an object.");
    }
    this.#rootPath = resolve(rootPath);
    this.#limits = Object.freeze({ ...(options.releaseLimits ?? {}) });
    this.#maximumBytes = maximumStoredReleaseBytes(this.#limits);
    this.#maximumAggregateBytes = aggregateStoredReleaseBytes(options.aggregateBytes);
    this.#pruneIo = pruneIoValue(options.pruneIo);
  }

  get maximumBytes(): number {
    return this.#maximumBytes;
  }

  get maximumAggregateBytes(): number {
    return this.#maximumAggregateBytes;
  }

  async put(value: unknown): Promise<LocalAppReleaseMetadata> {
    const release = verifyForWrite(value, this.#limits);
    const source = `${canonicalizeJson(release)}\n`;
    const bytes = Buffer.from(source, "utf8");
    if (bytes.byteLength > this.#maximumBytes) {
      throw new LocalAppReleaseStoreError(
        "RELEASE_STORE_LIMIT_EXCEEDED",
        `App Release requires ${bytes.byteLength} bytes; the store limit is ${this.#maximumBytes} bytes.`,
      );
    }

    return await this.#enqueue(async () => {
      try {
        await this.#ensureRoot(true);
        try {
          const existing = await this.#readStored(release.releaseDigest, "not-found");
          if (existing.source !== source) {
            throw corrupt("An existing App Release object does not match its content-addressed key.");
          }
          return metadataFrom(existing.release, existing.sizeBytes);
        } catch (error) {
          if (!(error instanceof LocalAppReleaseStoreError) || error.code !== "RELEASE_STORE_NOT_FOUND") throw error;
        }

        const storedBytes = await this.#measureStoredBytes();
        if (bytes.byteLength > this.#maximumAggregateBytes - storedBytes) {
          throw new LocalAppReleaseStoreError(
            "RELEASE_STORE_LIMIT_EXCEEDED",
            `App Release storage would exceed its ${this.#maximumAggregateBytes}-byte aggregate limit. Delete an unused Release before continuing.`,
          );
        }

        const directory = await this.#ensureDigestDirectory(release.releaseDigest);
        await assertReleaseDirectoryEntries(directory);
        const target = join(directory, localAppReleaseStoreFileName);

        const temporary = join(directory, `.release-${randomUUID()}.tmp`);
        let handle: FileHandle | null = null;
        try {
          handle = await open(temporary, "wx", 0o600);
          await handle.writeFile(bytes);
          await handle.sync();
          await handle.close();
          handle = null;

          if (await pathInfo(target)) {
            await unlink(temporary);
            const existing = await this.#readStored(release.releaseDigest, "corrupt");
            if (existing.source !== source) {
              throw corrupt("An existing App Release object does not match its content-addressed key.");
            }
            return metadataFrom(existing.release, existing.sizeBytes);
          }

          try {
            await rename(temporary, target);
          } catch (error) {
            const appeared = await pathInfo(target);
            if (!appeared) throw error;
            await rm(temporary, { force: true });
            const existing = await this.#readStored(release.releaseDigest, "corrupt");
            if (existing.source !== source) {
              throw corrupt("An existing App Release object does not match its content-addressed key.");
            }
            return metadataFrom(existing.release, existing.sizeBytes);
          }
          await syncDirectory(directory);
        } catch (error) {
          await handle?.close().catch(() => undefined);
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }

        const stored = await this.#readStored(release.releaseDigest, "corrupt");
        if (stored.source !== source) {
          throw corrupt("The App Release object changed while it was being committed.");
        }
        return metadataFrom(stored.release, stored.sizeBytes);
      } catch (error) {
        throw normalizeIoError(error, "store the App Release");
      }
    });
  }

  async read(digestValue: unknown): Promise<AppReleaseEnvelope> {
    const digest = parseDigestInput(digestValue);
    return await this.#enqueue(async () => {
      try {
        const exists = await this.#ensureRoot(false);
        if (!exists) throw notFound();
        return (await this.#readStored(digest, "not-found")).release;
      } catch (error) {
        throw normalizeIoError(error, "read the App Release");
      }
    });
  }

  async list(): Promise<readonly LocalAppReleaseMetadata[]> {
    return await this.#enqueue(async () => {
      try {
        const exists = await this.#ensureRoot(false);
        if (!exists) return Object.freeze([]);
        const rootEntries = await readBoundedDirectoryEntries(
          this.#rootPath,
          localAppReleaseStoreReconciliationMaximumObjects,
          () => objectLimitExceeded("list"),
        );
        const metadata: LocalAppReleaseMetadata[] = [];
        for (const entry of rootEntries) {
          if (!digestDirectoryPattern.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
            throw corrupt("The App Release store contains an unrecognized entry.");
          }
          const digest = parseDigestInput(`sha256:${entry.name}`);
          const stored = await this.#readStored(digest, "corrupt");
          metadata.push(metadataFrom(stored.release, stored.sizeBytes));
        }
        metadata.sort((left, right) => compareStrings(left.releaseDigest, right.releaseDigest));
        return Object.freeze(metadata);
      } catch (error) {
        throw normalizeIoError(error, "list App Releases");
      }
    });
  }

  async recover(): Promise<LocalAppReleaseStoreRecoveryResult> {
    return await this.#enqueue(async () => {
      try {
        const exists = await this.#ensureRoot(false);
        if (!exists) return Object.freeze({ removedTemporaryFiles: 0, cleanupPending: false });
        const rootEntries = await readBoundedDirectoryEntries(
          this.#rootPath,
          localAppReleaseStoreReconciliationMaximumObjects,
          () => objectLimitExceeded("recover"),
        );
        let removedTemporaryFiles = 0;
        let cleanupPending = false;
        for (const entry of rootEntries) {
          if (!digestDirectoryPattern.test(entry.name)) continue;
          const directory = join(this.#rootPath, entry.name);
          const directoryInfo = await pathInfo(directory);
          if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) {
            throw unsafe("An App Release object directory is not a safe directory.");
          }
          const entries = await readBoundedDirectoryEntries(
            directory,
            localAppReleaseStoreMaximumObjectEntries,
            objectEntryLimitExceeded,
          );
          let directoryChanged = false;
          for (const child of entries) {
            if (!temporaryFilePattern.test(child.name)) continue;
            const temporary = join(directory, child.name);
            const info = await pathInfo(temporary);
            if (!info?.isFile() || info.isSymbolicLink()) {
              throw unsafe("An App Release temporary object is not a safe regular file.");
            }
            try {
              await this.#pruneIo.unlink(temporary);
              removedTemporaryFiles += 1;
              directoryChanged = true;
            } catch (error) {
              if (retryablePruneError(error)) {
                cleanupPending = true;
                continue;
              }
              throw error;
            }
          }
          if (directoryChanged) {
            try {
              await this.#pruneIo.syncDirectory(directory);
            } catch (error) {
              if (retryablePruneError(error)) cleanupPending = true;
              else throw error;
            }
          }
        }
        return Object.freeze({ removedTemporaryFiles, cleanupPending });
      } catch (error) {
        throw normalizeIoError(error, "recover the App Release store");
      }
    });
  }

  /**
   * Removes complete content-addressed objects that are no longer referenced
   * by the registry. The whole store is validated before the first unlink, and
   * deletion is deliberately non-recursive so a raced filesystem entry cannot
   * expand the scope of the operation.
   */
  async reconcile(
    referencedReleaseDigests: readonly unknown[],
    validateReferenced?: LocalAppReleaseStoreReferenceValidator,
  ): Promise<LocalAppReleaseStoreReconciliationResult> {
    const referenced = parseReferencedDigests(referencedReleaseDigests);
    return await this.#enqueue(async () => {
      try {
        const exists = await this.#ensureRoot(false);
        if (!exists) {
          if (referenced.size > 0) throw corrupt("A referenced App Release object is missing.");
          if (validateReferenced) await callReferenceValidator(validateReferenced, Object.freeze([]));
          return Object.freeze({ removedOrphanObjects: 0, cleanupPending: false });
        }

        const snapshot = await this.#scanForReconciliation(referenced);
        await assertReleaseStoreSnapshot(this.#rootPath, snapshot);

        // A registry reference is durable evidence that a closed Release must
        // exist. Never interpret a referenced incomplete directory as garbage,
        // and perform this check before deleting any other orphan.
        if (snapshot.objects.some((object) => object.state === "incomplete" && referenced.has(object.digest))) {
          throw corrupt("A referenced App Release object is incomplete.");
        }
        const verifiedReferenced = snapshot.objects
          .filter((object) => referenced.has(object.digest))
          .map((object) => object.referencedProjection)
          .filter((projection): projection is LocalAppReleaseStoreVerifiedProjection => projection !== null)
          .sort((left, right) => compareStrings(left.releaseDigest, right.releaseDigest));
        if (verifiedReferenced.length !== referenced.size) {
          throw corrupt("A referenced App Release object is missing.");
        }
        const frozenReferenced = Object.freeze(verifiedReferenced);
        if (validateReferenced) {
          await callReferenceValidator(validateReferenced, frozenReferenced);
          // The validator may inspect other stores for cross-store integrity.
          // Revalidate this complete snapshot before the first deletion so that
          // callback latency cannot widen reconciliation's mutation race.
          await assertReleaseStoreSnapshot(this.#rootPath, snapshot);
        }

        let removedOrphanObjects = 0;
        let cleanupPending = false;
        for (const object of snapshot.objects) {
          if (referenced.has(object.digest)) continue;
          const pruning = await this.#pruneOrphanObject(object);
          if (pruning.removed) removedOrphanObjects += 1;
          if (pruning.pending) cleanupPending = true;
        }

        // Return only after every referenced object still matches the exact
        // file snapshot whose bytes produced the verified projection.
        for (const object of snapshot.objects) {
          if (referenced.has(object.digest)) await assertReleaseObjectSnapshot(object);
        }

        return Object.freeze({ removedOrphanObjects, cleanupPending });
      } catch (error) {
        if (error instanceof ReferenceValidationFailure) throw error.reason;
        throw normalizeIoError(error, "reconcile the App Release store");
      }
    });
  }

  async #pruneOrphanObject(
    object: ReleaseObjectSnapshot,
  ): Promise<Readonly<{ removed: boolean; pending: boolean }>> {
    // Recheck this object immediately before changing it. The initial
    // full-store check provides fail-closed all-or-nothing validation for
    // stable state; this second check narrows the remaining race window.
    await assertReleaseObjectSnapshot(object);
    for (const file of object.files) {
      const current = await pathInfo(file.path);
      if (!current?.isFile() || current.isSymbolicLink() || !sameFile(file.info, current)
        || !sameSnapshot(file.info, current)) {
        throw unsafe("An App Release object changed before orphan reconciliation.");
      }
      try {
        await this.#pruneIo.unlink(file.path);
      } catch (error) {
        if (retryablePruneError(error)) return Object.freeze({ removed: false, pending: true });
        throw error;
      }
    }

    try {
      await this.#pruneIo.syncDirectory(object.directory);
    } catch (error) {
      if (retryablePruneError(error)) return Object.freeze({ removed: false, pending: true });
      throw error;
    }
    const currentDirectory = await pathInfo(object.directory);
    if (!currentDirectory?.isDirectory() || currentDirectory.isSymbolicLink()
      || !sameFile(object.directoryInfo, currentDirectory)) {
      throw unsafe("An App Release object directory changed during orphan reconciliation.");
    }
    const remaining = await readBoundedDirectoryEntries(
      object.directory,
      0,
      () => unsafe("An App Release object directory changed during orphan reconciliation."),
    );
    if (remaining.length !== 0) {
      throw unsafe("An App Release object directory changed during orphan reconciliation.");
    }
    try {
      await this.#pruneIo.removeDirectory(object.directory);
    } catch (error) {
      if (retryablePruneError(error)) return Object.freeze({ removed: false, pending: true });
      throw error;
    }
    try {
      await this.#pruneIo.syncDirectory(this.#rootPath);
    } catch (error) {
      if (retryablePruneError(error)) return Object.freeze({ removed: true, pending: true });
      throw error;
    }
    return Object.freeze({ removed: true, pending: false });
  }

  async #scanForReconciliation(referenced: ReadonlySet<Sha256Digest>): Promise<ReleaseStoreSnapshot> {
    const rootInfo = await pathInfo(this.#rootPath);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
      throw unsafe("The App Release store root is not a safe directory.");
    }

    const rootEntries = await readBoundedDirectoryEntries(
      this.#rootPath,
      localAppReleaseStoreReconciliationMaximumObjects,
      () => objectLimitExceeded("reconcile"),
    );
    rootEntries.sort((left, right) => compareStrings(left.name, right.name));

    const objects: ReleaseObjectSnapshot[] = [];
    for (const entry of rootEntries) {
      if (!digestDirectoryPattern.test(entry.name)) {
        throw unsafe("The App Release store contains an entry not owned by reconciliation.");
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw unsafe("An App Release object key is not a safe directory.");
      }

      const digest = parseDigestInput(`sha256:${entry.name}`);
      const directory = join(this.#rootPath, entry.name);
      const directoryInfo = await pathInfo(directory);
      if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw unsafe("An App Release object directory is not a safe directory.");
      }
      const files = await snapshotReleaseObjectFiles(directory);
      const state = files.some((file) => file.name === localAppReleaseStoreFileName)
        ? "complete"
        : "incomplete";

      // A safe filename is not enough to establish ownership. Closed-release
      // verification proves that release.json belongs to this digest key. An
      // absent release.json is accepted only for the exact empty/temp-only
      // shape left by put before its atomic rename.
      const stored = state === "complete" ? await this.#readStored(digest, "corrupt") : null;
      objects.push(Object.freeze({
        digest,
        directory,
        directoryInfo,
        files,
        state,
        referencedProjection: stored && referenced.has(digest)
          ? verifiedProjectionFrom(stored.release, stored.sizeBytes)
          : null,
      }));
    }

    return Object.freeze({ rootInfo, objects: Object.freeze(objects) });
  }

  async #readStored(
    digest: Sha256Digest,
    missing: "not-found" | "corrupt",
  ): Promise<StoredRelease> {
    const directory = join(this.#rootPath, digestHex(digest));
    const directoryInfo = await pathInfo(directory);
    if (!directoryInfo) {
      if (missing === "not-found") throw notFound();
      throw corrupt("An App Release object directory is missing.");
    }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw unsafe("An App Release object directory is not a safe directory.");
    }
    await assertReleaseDirectoryEntries(directory);

    const file = join(directory, localAppReleaseStoreFileName);
    const before = await pathInfo(file);
    if (!before) {
      if (missing === "not-found") throw notFound();
      throw corrupt("An App Release object is missing release.json.");
    }
    if (!before.isFile() || before.isSymbolicLink()) {
      throw unsafe("An App Release object is not a safe regular file.");
    }
    if (before.size > this.#maximumBytes) {
      throw new LocalAppReleaseStoreError(
        "RELEASE_STORE_LIMIT_EXCEEDED",
        "An App Release object exceeds the store safety limit.",
      );
    }

    let handle: FileHandle;
    try {
      handle = await open(file, "r");
    } catch (error) {
      if (isMissing(error)) {
        if (missing === "not-found") throw notFound();
        throw corrupt("An App Release object disappeared while it was being opened.");
      }
      throw error;
    }

    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(before, opened)) {
        throw unsafe("An App Release object changed identity while it was being opened.");
      }
      if (opened.size > this.#maximumBytes) {
        throw new LocalAppReleaseStoreError(
          "RELEASE_STORE_LIMIT_EXCEEDED",
          "An App Release object exceeds the store safety limit.",
        );
      }
      bytes = await readBounded(handle, this.#maximumBytes);
      const after = await handle.stat();
      if (!sameFile(opened, after) || after.size !== bytes.byteLength || !sameSnapshot(opened, after)) {
        throw corrupt("An App Release object changed while it was being read.");
      }
    } finally {
      await handle.close();
    }

    const afterPath = await pathInfo(file);
    if (!afterPath?.isFile() || afterPath.isSymbolicLink() || !sameFile(before, afterPath)) {
      throw unsafe("An App Release object changed identity while it was being read.");
    }
    if (!sameSnapshot(before, afterPath)) {
      throw corrupt("An App Release object changed while it was being read.");
    }

    let source: string;
    try {
      source = decoder.decode(bytes);
    } catch (error) {
      throw corrupt("An App Release object is not valid UTF-8.", error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw corrupt("An App Release object is not valid JSON.", error);
    }

    let release: AppReleaseEnvelope;
    try {
      release = verifyAppRelease(parsed, this.#limits);
    } catch (error) {
      throw corrupt("An App Release object failed closed-release verification.", error);
    }
    if (release.releaseDigest !== digest) {
      throw corrupt("An App Release digest does not match its content-addressed directory.");
    }
    if (source !== `${canonicalizeJson(release)}\n`) {
      throw corrupt("An App Release object is not canonical JSON with one trailing newline.");
    }
    return { release, source, sizeBytes: bytes.byteLength };
  }

  async #ensureRoot(create: boolean): Promise<boolean> {
    let info = await pathInfo(this.#rootPath);
    if (!info && create) {
      await mkdir(this.#rootPath, { recursive: true, mode: 0o700 });
      info = await pathInfo(this.#rootPath);
    }
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw unsafe("The App Release store root is not a safe directory.");
    }
    return true;
  }

  async #ensureDigestDirectory(digest: Sha256Digest): Promise<string> {
    const directory = join(this.#rootPath, digestHex(digest));
    let info = await pathInfo(directory);
    if (!info) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      info = await pathInfo(directory);
      await syncDirectory(this.#rootPath);
    }
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw unsafe("An App Release object directory is not a safe directory.");
    }
    return directory;
  }

  async #measureStoredBytes(): Promise<number> {
    const rootInfo = await pathInfo(this.#rootPath);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
      throw unsafe("The App Release store root is not a safe directory.");
    }
    const rootEntries = await readBoundedDirectoryEntries(
      this.#rootPath,
      localAppReleaseStoreReconciliationMaximumObjects,
      () => objectLimitExceeded("measure"),
    );

    let total = 0;
    for (const entry of rootEntries) {
      if (!digestDirectoryPattern.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw unsafe("The App Release store contains an entry not owned by storage accounting.");
      }
      const directory = join(this.#rootPath, entry.name);
      const directoryInfo = await pathInfo(directory);
      if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw unsafe("An App Release object directory is not safe for storage accounting.");
      }
      const files = await snapshotReleaseObjectFiles(directory);
      for (const file of files) total = addStoredBytes(total, file.info.size);
    }

    const currentRoot = await pathInfo(this.#rootPath);
    if (!currentRoot?.isDirectory() || currentRoot.isSymbolicLink()
      || !sameFile(rootInfo, currentRoot) || !sameSnapshot(rootInfo, currentRoot)) {
      throw unsafe("The App Release store changed during storage accounting.");
    }
    return total;
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.catch(() => undefined).then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return await result;
  }
}

function verifyForWrite(value: unknown, limits: AppReleaseLimits): AppReleaseEnvelope {
  try {
    return verifyAppRelease(value, limits);
  } catch (error) {
    const code = error instanceof AppReleaseError && error.code === "RELEASE_LIMIT_EXCEEDED"
      ? "RELEASE_STORE_LIMIT_EXCEEDED"
      : "RELEASE_STORE_INVALID";
    throw new LocalAppReleaseStoreError(code, "App Release verification failed before storage.", { cause: error });
  }
}

function maximumStoredReleaseBytes(limits: AppReleaseLimits): number {
  const value = limits.closureBytes ?? appReleaseDefaultLimits.closureBytes;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalAppReleaseStoreError(
      "RELEASE_STORE_INVALID",
      "App Release closureBytes limit must be a non-negative safe integer.",
    );
  }
  const boundedClosureBytes = Math.min(value, appReleaseDefaultLimits.closureBytes);
  return Math.ceil(boundedClosureBytes * 4 / 3) + 16 * 1024 * 1024;
}

function aggregateStoredReleaseBytes(value: unknown): number {
  const aggregateBytes = value ?? localAppReleaseStoreDefaultMaximumAggregateBytes;
  if (!Number.isSafeInteger(aggregateBytes) || Number(aggregateBytes) < 0) {
    throw new LocalAppReleaseStoreError(
      "RELEASE_STORE_INVALID",
      "App Release aggregateBytes must be a non-negative safe integer.",
    );
  }
  return Number(aggregateBytes);
}

function parseDigestInput(value: unknown): Sha256Digest {
  try {
    return parseSha256Digest(value, "releaseDigest");
  } catch (error) {
    throw new LocalAppReleaseStoreError(
      "RELEASE_STORE_INVALID",
      "App Release lookup requires a lowercase sha256 digest.",
      { cause: error },
    );
  }
}

function parseReferencedDigests(value: readonly unknown[]): ReadonlySet<Sha256Digest> {
  if (!Array.isArray(value)) {
    throw new LocalAppReleaseStoreError(
      "RELEASE_STORE_INVALID",
      "App Release reconciliation requires an array of referenced digests.",
    );
  }
  if (value.length > localAppReleaseStoreReconciliationMaximumObjects) {
    throw new LocalAppReleaseStoreError(
      "RELEASE_STORE_LIMIT_EXCEEDED",
      `App Release reconciliation accepts at most ${localAppReleaseStoreReconciliationMaximumObjects} referenced digests.`,
    );
  }

  const digests = new Set<Sha256Digest>();
  for (const digest of value) digests.add(parseDigestInput(digest));
  return digests;
}

function digestHex(digest: Sha256Digest): string {
  const hex = digest.slice("sha256:".length);
  if (!digestDirectoryPattern.test(hex)) {
    throw new LocalAppReleaseStoreError("RELEASE_STORE_INVALID", "App Release digest is not a safe store key.");
  }
  return hex;
}

function metadataFrom(release: AppReleaseEnvelope, sizeBytes: number): LocalAppReleaseMetadata {
  return Object.freeze({
    releaseDigest: release.releaseDigest,
    projectId: release.manifest.projectId,
    presentation: release.manifest.presentation,
    displayVersion: release.manifest.displayVersion,
    runtimeApi: release.manifest.runtimeApi,
    featureIds: Object.freeze(release.manifest.features.map((feature) => feature.featureId)),
    createdAt: release.manifest.createdAt,
    sizeBytes,
  });
}

function verifiedProjectionFrom(
  release: AppReleaseEnvelope,
  sizeBytes: number,
): LocalAppReleaseStoreVerifiedProjection {
  return Object.freeze({
    releaseDigest: release.releaseDigest,
    projectId: release.manifest.projectId,
    presentation: Object.freeze(structuredClone(release.manifest.presentation)),
    displayVersion: release.manifest.displayVersion,
    runtimeApi: Object.freeze({ ...release.manifest.runtimeApi }),
    features: Object.freeze(release.manifest.features.map((feature) => Object.freeze({
      featureId: feature.featureId,
      featureRevisionMediaType: feature.featureRevision.mediaType,
      featureRevisionDigest: feature.featureRevision.digest,
      declarationMediaType: feature.declaration.mediaType,
      declarationDigest: feature.declaration.digest,
      hasDataSchema: feature.dataSchema !== null,
      migrationCount: feature.migrations.length,
    }))),
    createdAt: release.manifest.createdAt,
    sizeBytes,
  });
}

async function callReferenceValidator(
  validator: LocalAppReleaseStoreReferenceValidator,
  releases: readonly LocalAppReleaseStoreVerifiedProjection[],
): Promise<void> {
  try {
    await validator(releases);
  } catch (error) {
    throw new ReferenceValidationFailure(error);
  }
}

function addStoredBytes(current: number, additional: number | bigint): number {
  const boundedAdditional = typeof additional === "bigint"
    ? additional >= 0n && additional <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(additional) : Number.NaN
    : additional;
  if (!Number.isSafeInteger(current) || current < 0
    || !Number.isSafeInteger(boundedAdditional) || boundedAdditional < 0
    || current > Number.MAX_SAFE_INTEGER - boundedAdditional) {
    throw new LocalAppReleaseStoreError(
      "RELEASE_STORE_LIMIT_EXCEEDED",
      "App Release storage accounting exceeds the safe integer range.",
    );
  }
  return current + boundedAdditional;
}

function pruneIoValue(value: unknown): LocalAppReleaseStorePruneIo {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new LocalAppReleaseStoreError("RELEASE_STORE_INVALID", "App Release pruneIo must be an object.");
  }
  const record = (value ?? {}) as Record<string, unknown>;
  const allowed = new Set(["unlink", "removeDirectory", "syncDirectory"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new LocalAppReleaseStoreError("RELEASE_STORE_INVALID", "App Release pruneIo contains an unknown operation.");
  }
  for (const key of allowed) {
    if (record[key] !== undefined && typeof record[key] !== "function") {
      throw new LocalAppReleaseStoreError("RELEASE_STORE_INVALID", `App Release pruneIo.${key} must be a function.`);
    }
  }
  return Object.freeze({
    unlink: (record.unlink as LocalAppReleaseStorePruneIo["unlink"] | undefined) ?? unlink,
    removeDirectory: (record.removeDirectory as LocalAppReleaseStorePruneIo["removeDirectory"] | undefined) ?? rmdir,
    syncDirectory: (record.syncDirectory as LocalAppReleaseStorePruneIo["syncDirectory"] | undefined) ?? syncDirectory,
  });
}

async function readBoundedDirectoryEntries(
  path: string,
  maximumEntries: number,
  overflow: () => Error,
): Promise<Dirent[]> {
  const directory = await opendir(path);
  const entries: Dirent[] = [];
  try {
    while (true) {
      const entry = await directory.read();
      if (!entry) return entries;
      if (entries.length >= maximumEntries) throw overflow();
      entries.push(entry);
    }
  } finally {
    await directory.close().catch((error) => {
      if (!isNodeError(error) || error.code !== "ERR_DIR_CLOSED") throw error;
    });
  }
}

function objectLimitExceeded(action: "list" | "recover" | "reconcile" | "measure"): LocalAppReleaseStoreError {
  const verb = action === "list" ? "listing"
    : action === "recover" ? "recovery"
      : action === "reconcile" ? "reconciliation"
        : "storage accounting";
  return new LocalAppReleaseStoreError(
    "RELEASE_STORE_LIMIT_EXCEEDED",
    `App Release ${verb} is limited to ${localAppReleaseStoreReconciliationMaximumObjects} objects.`,
  );
}

function objectEntryLimitExceeded(): LocalAppReleaseStoreError {
  return new LocalAppReleaseStoreError(
    "RELEASE_STORE_LIMIT_EXCEEDED",
    `An App Release object is limited to ${localAppReleaseStoreMaximumObjectEntries} entries.`,
  );
}

function retryablePruneError(error: unknown): boolean {
  return isNodeError(error) && [
    "EACCES",
    "EBUSY",
    "EDQUOT",
    "EIO",
    "EMFILE",
    "ENFILE",
    "ENOMEM",
    "ENOSPC",
    "EPERM",
    "EROFS",
    "ETXTBSY",
  ].includes(error.code ?? "");
}

async function assertReleaseDirectoryEntries(directory: string): Promise<void> {
  const entries = await readBoundedDirectoryEntries(
    directory,
    localAppReleaseStoreMaximumObjectEntries,
    objectEntryLimitExceeded,
  );
  for (const entry of entries) {
    if (entry.name === localAppReleaseStoreFileName) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw unsafe("release.json is not a safe regular file.");
      }
      continue;
    }
    if (temporaryFilePattern.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw unsafe("An App Release temporary object is not a safe regular file.");
      }
      continue;
    }
    throw corrupt("An App Release object directory contains an unrecognized entry.");
  }
}

async function snapshotReleaseObjectFiles(directory: string): Promise<readonly ReleaseObjectFileSnapshot[]> {
  const entries = await readBoundedDirectoryEntries(
    directory,
    localAppReleaseStoreMaximumObjectEntries,
    objectEntryLimitExceeded,
  );
  entries.sort((left, right) => compareStrings(left.name, right.name));
  const files: ReleaseObjectFileSnapshot[] = [];
  for (const entry of entries) {
    if (entry.name !== localAppReleaseStoreFileName && !temporaryFilePattern.test(entry.name)) {
      throw unsafe("An App Release object directory contains an entry not owned by reconciliation.");
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw unsafe("An App Release object contains an unsafe file entry.");
    }
    const path = join(directory, entry.name);
    const info = await pathInfo(path);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw unsafe("An App Release object contains an unsafe regular-file path.");
    }
    files.push(Object.freeze({ name: entry.name, path, info }));
  }
  return Object.freeze(files);
}

async function assertReleaseStoreSnapshot(rootPath: string, snapshot: ReleaseStoreSnapshot): Promise<void> {
  const rootInfo = await pathInfo(rootPath);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()
    || !sameFile(snapshot.rootInfo, rootInfo) || !sameSnapshot(snapshot.rootInfo, rootInfo)) {
    throw unsafe("The App Release store changed during orphan reconciliation validation.");
  }

  const entries = await readBoundedDirectoryEntries(
    rootPath,
    snapshot.objects.length,
    () => unsafe("The App Release store changed during orphan reconciliation validation."),
  );
  entries.sort((left, right) => compareStrings(left.name, right.name));
  if (entries.length !== snapshot.objects.length) {
    throw unsafe("The App Release store changed during orphan reconciliation validation.");
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const object = snapshot.objects[index];
    if (!entry || !object || entry.name !== digestHex(object.digest)
      || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw unsafe("The App Release store changed during orphan reconciliation validation.");
    }
    await assertReleaseObjectSnapshot(object);
  }
}

async function assertReleaseObjectSnapshot(snapshot: ReleaseObjectSnapshot): Promise<void> {
  const directoryInfo = await pathInfo(snapshot.directory);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()
    || !sameFile(snapshot.directoryInfo, directoryInfo) || !sameSnapshot(snapshot.directoryInfo, directoryInfo)) {
    throw unsafe("An App Release object changed during orphan reconciliation validation.");
  }

  const entries = await readBoundedDirectoryEntries(
    snapshot.directory,
    snapshot.files.length,
    () => unsafe("An App Release object changed during orphan reconciliation validation."),
  );
  entries.sort((left, right) => compareStrings(left.name, right.name));
  if (entries.length !== snapshot.files.length) {
    throw unsafe("An App Release object changed during orphan reconciliation validation.");
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const file = snapshot.files[index];
    if (!entry || !file || entry.name !== file.name || !entry.isFile() || entry.isSymbolicLink()) {
      throw unsafe("An App Release object changed during orphan reconciliation validation.");
    }
    const info = await pathInfo(file.path);
    if (!info?.isFile() || info.isSymbolicLink() || !sameFile(file.info, info) || !sameSnapshot(file.info, info)) {
      throw unsafe("An App Release object changed during orphan reconciliation validation.");
    }
  }
}

async function readBounded(handle: FileHandle, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let position = 0;
  while (position <= maximumBytes) {
    const capacity = Math.min(readChunkBytes, maximumBytes + 1 - position);
    const chunk = Buffer.allocUnsafe(capacity);
    const { bytesRead } = await handle.read(chunk, 0, capacity, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    if (position > maximumBytes) {
      throw new LocalAppReleaseStoreError(
        "RELEASE_STORE_LIMIT_EXCEEDED",
        "An App Release object exceeds the store safety limit.",
      );
    }
    chunks.push(bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, position);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function directorySyncUnsupported(error: unknown): boolean {
  if (!isNodeError(error)) return false;
  if (["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes(error.code ?? "")) return true;
  return process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code ?? "");
}

async function pathInfo(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function notFound(): LocalAppReleaseStoreError {
  return new LocalAppReleaseStoreError("RELEASE_STORE_NOT_FOUND", "App Release object was not found.");
}

function corrupt(message: string, cause?: unknown): LocalAppReleaseStoreError {
  return new LocalAppReleaseStoreError("RELEASE_STORE_CORRUPT", message, cause === undefined ? undefined : { cause });
}

function unsafe(message: string): LocalAppReleaseStoreError {
  return new LocalAppReleaseStoreError("RELEASE_STORE_UNSAFE", message);
}

function normalizeIoError(error: unknown, action: string): LocalAppReleaseStoreError {
  if (error instanceof LocalAppReleaseStoreError) return error;
  return new LocalAppReleaseStoreError(
    "RELEASE_STORE_IO",
    `work-fold could not ${action}.`,
    { cause: error },
  );
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
