import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalizeJson,
  parseProjectId,
  parseSha256Digest,
  type Sha256Digest,
} from "../src/local/agent/app-platform-contract.js";
import {
  assembleAppRelease,
  type AppReleaseEnvelope,
} from "../src/local/agent/app-platform-release.js";
import {
  LocalAppReleaseStore,
  LocalAppReleaseStoreError,
  localAppReleaseStoreFileName,
  localAppReleaseStoreMaximumObjectEntries,
  localAppReleaseStoreReconciliationMaximumObjects,
  type LocalAppReleaseStoreErrorCode,
} from "../src/local/agent/local-app-release-store.js";

const encoder = new TextEncoder();

type Mutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;

test("stores verified releases as canonical immutable content-addressed objects", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const release = fixture("alpha", "1.0.0", "2026-07-15T12:00:00.000Z");

  const metadata = await store.put(release);
  const file = releaseFile(root, release.releaseDigest);
  const source = await readFile(file, "utf8");

  assert.equal(source, `${canonicalizeJson(release)}\n`);
  assert.equal(source.endsWith("\n"), true);
  assert.equal(source.includes(root), false, "the store must not inject a machine-local path");
  assert.deepEqual(await store.read(release.releaseDigest), release);
  assert.deepEqual(metadata, {
    releaseDigest: release.releaseDigest,
    projectId: release.manifest.projectId,
    presentation: release.manifest.presentation,
    displayVersion: "1.0.0",
    runtimeApi: release.manifest.runtimeApi,
    featureIds: ["desk"],
    createdAt: "2026-07-15T12:00:00.000Z",
    sizeBytes: Buffer.byteLength(source),
  });
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.featureIds), true);
});

test("put is idempotent and never rewrites an existing verified digest", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const release = fixture("idempotent", "1.0.0", "2026-07-15T12:00:00.000Z");
  await store.put(release);
  const file = releaseFile(root, release.releaseDigest);
  const preservedTime = new Date("2020-01-02T03:04:05.000Z");
  await utimes(file, preservedTime, preservedTime);
  const before = await stat(file);

  const first = await store.put(JSON.parse(JSON.stringify(release)));
  const after = await stat(file);

  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(first.releaseDigest, release.releaseDigest);
  assert.deepEqual(await readdir(join(root, digestHex(release.releaseDigest))), [localAppReleaseStoreFileName]);
});

test("rejects an unverified release before creating any store paths", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const release = jsonClone(fixture("invalid", "1.0.0", "2026-07-15T12:00:00.000Z"));
  release.manifest.displayVersion = "changed-without-a-new-digest";

  await assert.rejects(store.put(release), storeError("RELEASE_STORE_INVALID"));
  assert.equal(await missing(root), true);
});

test("fails closed on a tampered existing object and will not repair it by overwriting", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const release = fixture("tamper", "1.0.0", "2026-07-15T12:00:00.000Z");
  await store.put(release);
  const file = releaseFile(root, release.releaseDigest);
  const tampered = jsonClone(release);
  tampered.manifest.presentation.title = "Tampered title";
  const tamperedSource = `${canonicalizeJson(tampered)}\n`;
  await writeFile(file, tamperedSource, "utf8");

  await assert.rejects(store.read(release.releaseDigest), storeError("RELEASE_STORE_CORRUPT"));
  await assert.rejects(store.put(release), storeError("RELEASE_STORE_CORRUPT"));
  assert.equal(await readFile(file, "utf8"), tamperedSource);
});

test("verifies the directory key on read and makes list fail closed on a misplaced release", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const release = fixture("misplaced", "1.0.0", "2026-07-15T12:00:00.000Z");
  await store.put(release);
  const wrongDigest = sha256(release.releaseDigest.endsWith("f") ? "e" : "f");
  const wrongDirectory = join(root, digestHex(wrongDigest));
  await mkdir(wrongDirectory);
  await writeFile(join(wrongDirectory, localAppReleaseStoreFileName), `${canonicalizeJson(release)}\n`, "utf8");

  await assert.rejects(store.read(wrongDigest), storeError("RELEASE_STORE_CORRUPT"));
  await assert.rejects(store.list(), storeError("RELEASE_STORE_CORRUPT"));
  assert.deepEqual(await store.read(release.releaseDigest), release);
});

test("lists only verified compact metadata in deterministic digest order", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const releases = [
    fixture("second", "2.0.0", "2026-07-16T12:00:00.000Z"),
    fixture("first", "1.0.0", "2026-07-15T12:00:00.000Z"),
  ];
  await Promise.all(releases.map((release) => store.put(release)));

  const listed = await store.list();
  const expectedDigests = releases.map((release) => release.releaseDigest).sort();
  assert.deepEqual(listed.map((entry) => entry.releaseDigest), expectedDigests);
  assert.deepEqual(listed.map((entry) => entry.featureIds), [["desk"], ["desk"]]);
  assert.equal(Object.isFrozen(listed), true);

  await writeFile(join(root, "not-a-release"), "leave me alone\n", "utf8");
  await assert.rejects(store.list(), storeError("RELEASE_STORE_CORRUPT"));
});

test("rejects an oversized object from its file metadata before parsing", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root, { releaseLimits: { closureBytes: 0 } });
  const digest = sha256("a");
  const directory = join(root, digestHex(digest));
  await mkdir(directory, { recursive: true });
  const handle = await open(join(directory, localAppReleaseStoreFileName), "w");
  try {
    await handle.truncate(store.maximumBytes + 1);
  } finally {
    await handle.close();
  }

  await assert.rejects(store.read(digest), storeError("RELEASE_STORE_LIMIT_EXCEEDED"));
});

test("enforces the aggregate byte quota before adding a new object while preserving idempotent puts", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const first = fixture("aggregate-first", "1.0.0", "2026-07-15T12:00:00.000Z");
  const second = fixture("aggregate-second", "2.0.0", "2026-07-16T12:00:00.000Z");
  const firstBytes = Buffer.byteLength(`${canonicalizeJson(first)}\n`);
  const store = new LocalAppReleaseStore(root, { aggregateBytes: firstBytes });

  assert.equal(store.maximumAggregateBytes, firstBytes);
  await store.put(first);
  await store.put(first);

  await assert.rejects(store.put(second), (error: unknown) => (
    storeError("RELEASE_STORE_LIMIT_EXCEEDED")(error)
    && error instanceof Error
    && /Delete an unused Release/i.test(error.message)
  ));
  assert.deepEqual(await store.read(first.releaseDigest), first);
  assert.equal(await missing(join(root, digestHex(second.releaseDigest))), true,
    "a quota rejection must not create the new content-addressed directory");
});

test("recovery removes only store-owned stale temp files and preserves valid objects", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const release = fixture("recovery", "1.0.0", "2026-07-15T12:00:00.000Z");
  await store.put(release);
  const directory = join(root, digestHex(release.releaseDigest));
  const stale = join(directory, `.release-${randomUUID()}.tmp`);
  const unrelated = join(root, "operator-note.txt");
  await writeFile(stale, "partial write", "utf8");
  await writeFile(unrelated, "preserve me", "utf8");

  const recovered = await store.recover();

  assert.deepEqual(recovered, { removedTemporaryFiles: 1, cleanupPending: false });
  assert.equal(await missing(stale), true);
  assert.equal(await readFile(unrelated, "utf8"), "preserve me");
  assert.deepEqual(await store.read(release.releaseDigest), release);
  assert.equal(await access(releaseFile(root, release.releaseDigest)).then(() => true), true);
});

test("recovery keeps a locked temporary object retryable", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const directory = join(root, digestHex(sha256("d")));
  const temporary = join(directory, `.release-${randomUUID()}.tmp`);
  let blockPruning = true;
  const store = new LocalAppReleaseStore(root, {
    pruneIo: {
      async unlink(path) {
        if (blockPruning) throw Object.assign(new Error("simulated temporary-file lock"), { code: "EPERM" });
        await unlink(path);
      },
    },
  });
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, "partial write", "utf8");

  assert.deepEqual(await store.recover(), { removedTemporaryFiles: 0, cleanupPending: true });
  assert.equal(await missing(temporary), false);
  blockPruning = false;
  assert.deepEqual(await store.recover(), { removedTemporaryFiles: 1, cleanupPending: false });
  assert.equal(await missing(temporary), true);
});

test("reconciliation removes only unreferenced verified objects and is idempotent", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const referenced = fixture("referenced", "1.0.0", "2026-07-15T12:00:00.000Z");
  const orphan = fixture("orphan", "2.0.0", "2026-07-16T12:00:00.000Z");
  await Promise.all([store.put(referenced), store.put(orphan)]);

  const first = await store.reconcile([referenced.releaseDigest]);

  assert.deepEqual(first, { removedOrphanObjects: 1, cleanupPending: false });
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(await store.read(referenced.releaseDigest), referenced);
  assert.equal(await missing(join(root, digestHex(orphan.releaseDigest))), true);

  const second = await store.reconcile([referenced.releaseDigest]);
  assert.deepEqual(second, { removedOrphanObjects: 0, cleanupPending: false });
  assert.deepEqual(await readdir(root), [digestHex(referenced.releaseDigest)]);
});

test("reconciliation validates compact referenced projections before deleting any orphan", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const referenced = fixture("projection-reference", "1.0.0", "2026-07-15T12:00:00.000Z");
  const orphan = fixture("projection-orphan", "2.0.0", "2026-07-16T12:00:00.000Z");
  await Promise.all([store.put(referenced), store.put(orphan)]);
  const sentinel = new Error("registry projection rejected");
  let inspected = false;

  await assert.rejects(store.reconcile([referenced.releaseDigest], (releases) => {
    inspected = true;
    assert.equal(Object.isFrozen(releases), true);
    assert.equal(releases.length, 1);
    const projection = releases[0]!;
    assert.equal(Object.isFrozen(projection), true);
    assert.equal(Object.isFrozen(projection.presentation), true);
    assert.equal(Object.isFrozen(projection.runtimeApi), true);
    assert.equal(Object.isFrozen(projection.features), true);
    assert.equal(Object.isFrozen(projection.features[0]), true);
    assert.equal(projection.releaseDigest, referenced.releaseDigest);
    assert.equal(projection.projectId, referenced.manifest.projectId);
    assert.equal(projection.displayVersion, referenced.manifest.displayVersion);
    assert.equal(projection.features[0]?.featureRevisionDigest,
      referenced.manifest.features[0]?.featureRevision.digest);
    throw sentinel;
  }), (error: unknown) => error === sentinel);

  assert.equal(inspected, true);
  assert.equal(await missing(join(root, digestHex(orphan.releaseDigest))), false,
    "a validator failure must leave every orphan untouched");
  assert.deepEqual(await store.reconcile([referenced.releaseDigest], () => undefined), {
    removedOrphanObjects: 1,
    cleanupPending: false,
  });
});

test("reconciliation reports retryable physical prune I/O without weakening validation", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  let blockPruning = true;
  const store = new LocalAppReleaseStore(root, {
    pruneIo: {
      async unlink(path) {
        if (blockPruning) {
          throw Object.assign(new Error("simulated locked Release object"), { code: "EBUSY" });
        }
        await unlink(path);
      },
    },
  });
  const orphan = fixture("retryable-prune", "1.0.0", "2026-07-15T12:00:00.000Z");
  await store.put(orphan);

  assert.deepEqual(await store.reconcile([]), {
    removedOrphanObjects: 0,
    cleanupPending: true,
  });
  assert.equal(await missing(releaseFile(root, orphan.releaseDigest)), false,
    "a retryable lock must leave the verified object for a later exact retry");

  blockPruning = false;
  assert.deepEqual(await store.reconcile([]), {
    removedOrphanObjects: 1,
    cleanupPending: false,
  });
  assert.equal(await missing(join(root, digestHex(orphan.releaseDigest))), true);
});

test("reconciliation fails closed when a referenced object or store root is missing", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const referenced = fixture("missing-reference", "1.0.0", "2026-07-15T12:00:00.000Z");

  await assert.rejects(store.reconcile([referenced.releaseDigest]), storeError("RELEASE_STORE_CORRUPT"));
  assert.equal(await missing(root), true, "a failed read-only reconciliation must not create its root");

  await mkdir(root);
  await assert.rejects(store.reconcile([referenced.releaseDigest]), storeError("RELEASE_STORE_CORRUPT"));
});

test("recovery and reconciliation remove an empty directory left by an interrupted put", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const incompleteDigest = sha256("b");
  const incompleteDirectory = join(root, digestHex(incompleteDigest));
  await mkdir(incompleteDirectory, { recursive: true });

  assert.deepEqual(await store.recover(), { removedTemporaryFiles: 0, cleanupPending: false });
  assert.deepEqual(await store.reconcile([]), { removedOrphanObjects: 1, cleanupPending: false });
  assert.equal(await missing(incompleteDirectory), true);
});

test("recovery and reconciliation remove a temp-only directory left by an interrupted put", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const incompleteDigest = sha256("c");
  const incompleteDirectory = join(root, digestHex(incompleteDigest));
  const temporary = join(incompleteDirectory, `.release-${randomUUID()}.tmp`);
  await mkdir(incompleteDirectory, { recursive: true });
  await writeFile(temporary, "partial write", "utf8");

  assert.deepEqual(await store.recover(), { removedTemporaryFiles: 1, cleanupPending: false });
  assert.equal(await missing(temporary), true);
  assert.deepEqual(await store.reconcile([]), { removedOrphanObjects: 1, cleanupPending: false });
  assert.equal(await missing(incompleteDirectory), true);
});

test("reconciliation fails closed on an unsafe sibling before removing an incomplete object", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const incompleteDigest = sha256("b");
  const incompleteDirectory = join(root, digestHex(incompleteDigest));
  const unsafeDigest = sha256("c");
  const unsafeDirectory = join(root, digestHex(unsafeDigest));
  const unsafeSibling = join(unsafeDirectory, "operator-note.txt");
  await mkdir(incompleteDirectory, { recursive: true });
  await mkdir(unsafeDirectory);
  await writeFile(unsafeSibling, "not store-owned\n", "utf8");

  await assert.rejects(store.reconcile([]), storeError("RELEASE_STORE_UNSAFE"));
  assert.equal(await missing(incompleteDirectory), false, "validation must finish before incomplete-object deletion");
  assert.equal(await readFile(unsafeSibling, "utf8"), "not store-owned\n");
});

test("reconciliation never removes an incomplete object referenced by the registry", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const incompleteDigest = sha256("b");
  const incompleteDirectory = join(root, digestHex(incompleteDigest));
  await mkdir(incompleteDirectory, { recursive: true });

  await assert.rejects(store.reconcile([incompleteDigest]), storeError("RELEASE_STORE_CORRUPT"));
  assert.equal(await missing(incompleteDirectory), false);
});

test("reconciliation fails closed before deleting when the store contains unsafe entries", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const orphan = fixture("unsafe-orphan", "1.0.0", "2026-07-15T12:00:00.000Z");
  await store.put(orphan);
  const orphanFile = releaseFile(root, orphan.releaseDigest);

  const unknownRootEntry = join(root, "operator-note.txt");
  await writeFile(unknownRootEntry, "not store-owned\n", "utf8");
  await assert.rejects(store.reconcile([]), storeError("RELEASE_STORE_UNSAFE"));
  assert.equal(await missing(orphanFile), false, "validation must finish before any orphan deletion");
  await rm(unknownRootEntry);

  const unknownObjectEntry = join(root, digestHex(orphan.releaseDigest), "not-release-data.txt");
  await writeFile(unknownObjectEntry, "not store-owned\n", "utf8");
  await assert.rejects(store.reconcile([]), storeError("RELEASE_STORE_UNSAFE"));
  assert.equal(await missing(orphanFile), false);
  await rm(unknownObjectEntry);

  const nonDirectoryDigest = sha256("e");
  const nonDirectoryPath = join(root, digestHex(nonDirectoryDigest));
  await writeFile(nonDirectoryPath, "not a directory\n", "utf8");
  await assert.rejects(store.reconcile([]), storeError("RELEASE_STORE_UNSAFE"));
  assert.equal(await missing(orphanFile), false);
  await rm(nonDirectoryPath);

  const linkedDigest = sha256("d");
  const linkedPath = join(root, digestHex(linkedDigest));
  const linkedTarget = join(sandbox, "outside-store");
  await mkdir(linkedTarget);
  try {
    await symlink(linkedTarget, linkedPath, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(store.reconcile([]), storeError("RELEASE_STORE_UNSAFE"));
    assert.equal(await missing(orphanFile), false);
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
  }
});

test("reconciliation validates digest input and bounds both references and scanned objects", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const store = new LocalAppReleaseStore(root);
  const validDigest = sha256("a");

  await assert.rejects(
    store.reconcile("not-an-array" as unknown as readonly unknown[]),
    storeError("RELEASE_STORE_INVALID"),
  );
  await assert.rejects(store.reconcile(["sha256:not-a-digest"]), storeError("RELEASE_STORE_INVALID"));
  await assert.rejects(
    store.reconcile([`sha256:${"A".repeat(64)}`]),
    storeError("RELEASE_STORE_INVALID"),
  );
  await assert.rejects(
    store.reconcile(Array.from(
      { length: localAppReleaseStoreReconciliationMaximumObjects + 1 },
      () => validDigest,
    )),
    storeError("RELEASE_STORE_LIMIT_EXCEEDED"),
  );
  assert.equal(await missing(root), true, "invalid inputs must not create the store root");

  await mkdir(root);
  const names = Array.from(
    { length: localAppReleaseStoreReconciliationMaximumObjects + 1 },
    (_, index) => index.toString(16).padStart(64, "0"),
  );
  for (let offset = 0; offset < names.length; offset += 256) {
    await Promise.all(names.slice(offset, offset + 256).map((name) => mkdir(join(root, name))));
  }
  await assert.rejects(store.recover(), storeError("RELEASE_STORE_LIMIT_EXCEEDED"));
  await assert.rejects(store.list(), storeError("RELEASE_STORE_LIMIT_EXCEEDED"));
  await assert.rejects(store.reconcile([]), storeError("RELEASE_STORE_LIMIT_EXCEEDED"));
  assert.equal((await readdir(root)).length, localAppReleaseStoreReconciliationMaximumObjects + 1);
});

test("store operations bound entries inside one object directory", async (t) => {
  const sandbox = await temporaryStore(t);
  const root = join(sandbox, "releases");
  const directory = join(root, digestHex(sha256("f")));
  const store = new LocalAppReleaseStore(root);
  await mkdir(directory, { recursive: true });
  await Promise.all(Array.from({ length: localAppReleaseStoreMaximumObjectEntries + 1 }, async () => {
    await writeFile(join(directory, `.release-${randomUUID()}.tmp`), "", "utf8");
  }));

  await assert.rejects(store.recover(), storeError("RELEASE_STORE_LIMIT_EXCEEDED"));
  await assert.rejects(store.reconcile([]), storeError("RELEASE_STORE_LIMIT_EXCEEDED"));
  assert.equal((await readdir(directory)).length, localAppReleaseStoreMaximumObjectEntries + 1,
    "a bounded scan must fail before deleting any entry");
});

function fixture(marker: string, displayVersion: string, createdAt: string): AppReleaseEnvelope {
  return assembleAppRelease({
    projectId: parseProjectId("project_release-store"),
    presentation: {
      title: "Community Desk",
      description: "A small local-first desk.",
      icon: "sprout",
    },
    displayVersion,
    runtimeApi: { name: "work-fold.feature-broker", compatibleRange: "1.x" },
    features: [{
      featureId: "desk",
      featureRevision: {
        mediaType: "application/vnd.work-fold.feature+bundle",
        entries: [{ path: "worker.js", bytes: encoder.encode(`export const marker = ${JSON.stringify(marker)};\n`) }],
      },
      declaration: {
        mediaType: "application/vnd.work-fold.feature-declaration+json",
        value: { featureId: "desk", marker, actions: [] },
      },
      dataSchema: null,
      migrations: [],
    }],
    dependencyInventory: {
      mediaType: "application/vnd.cyclonedx+json",
      value: { bomFormat: "CycloneDX", components: [] },
    },
    buildProvenance: {
      mediaType: "application/vnd.work-fold.build-provenance+json",
      value: { builder: "release-store-test", marker },
    },
    inspectionEvidence: {
      mediaType: "application/vnd.work-fold.inspection-evidence+json",
      value: { policy: "test", findings: [] },
    },
    createdAt,
  });
}

async function temporaryStore(t: test.TestContext): Promise<string> {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-release-store-"));
  t.after(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });
  return sandbox;
}

function releaseFile(root: string, digest: Sha256Digest): string {
  return join(root, digestHex(digest), localAppReleaseStoreFileName);
}

function digestHex(digest: Sha256Digest): string {
  return digest.slice("sha256:".length);
}

function sha256(character: string): Sha256Digest {
  return parseSha256Digest(`sha256:${character.repeat(64)}`);
}

function jsonClone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

function storeError(code: LocalAppReleaseStoreErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof LocalAppReleaseStoreError && error.code === code;
}

async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

function isPermissionDenied(error: unknown): boolean {
  return error instanceof Error && "code" in error && ["EACCES", "EPERM"].includes(String(error.code));
}
