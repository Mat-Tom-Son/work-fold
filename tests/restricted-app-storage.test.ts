import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  parseDataNamespaceId,
  parseFeatureInstallationId,
  parseRuntimeInstanceId,
  parseTenantId,
} from "../src/local/agent/app-platform-contract.js";

import {
  FileRestrictedAppStorage,
  RestrictedAppStorageError,
  restrictedAppStorageLimits,
  type RestrictedAppStorageJsonValue,
  type RestrictedAppStorageOwner,
} from "../src/local/agent/restricted-app-storage.js";

const owner: RestrictedAppStorageOwner = {
  ownerClass: "instance",
  tenantId: parseTenantId("tenant_one"),
  runtimeInstanceId: parseRuntimeInstanceId("runtime-instance_one"),
  featureInstallationId: parseFeatureInstallationId("feature-installation_one"),
  dataNamespaceId: parseDataNamespaceId("data-namespace_one"),
};

async function temporaryStore(t: test.TestContext): Promise<{
  root: string;
  store: FileRestrictedAppStorage;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-storage-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "restricted-app-data");
  return { root, store: new FileRestrictedAppStorage(root) };
}

async function onlyStorageFile(root: string): Promise<string> {
  const shards = await readdir(root);
  assert.equal(shards.length, 1);
  const owners = await readdir(join(root, shards[0]!));
  assert.equal(owners.length, 1);
  return join(root, shards[0]!, owners[0]!, "storage.json");
}

test("restricted app storage persists JSON values and isolates Tenant and Data Namespace owners", async (t) => {
  const { root, store } = await temporaryStore(t);
  const value = {
    cursor: "message-42",
    unread: 3,
    labels: ["inbox", "important"],
    flags: { synchronized: true },
  };

  const first = await store.set(owner, "inbox/state", value);
  assert.equal(first.changed, true);
  assert.equal(first.revision, 1);
  assert.deepEqual(first.changedKeys, ["inbox/state"]);
  value.flags.synchronized = false;

  const reopened = new FileRestrictedAppStorage(root);
  assert.deepEqual(await reopened.get(owner, "inbox/state"), {
    cursor: "message-42",
    unread: 3,
    labels: ["inbox", "important"],
    flags: { synchronized: true },
  });
  assert.deepEqual(await reopened.keys(owner), ["inbox/state"]);
  assert.deepEqual(await reopened.keys(owner, "inbox/"), ["inbox/state"]);
  assert.equal((await reopened.usage(owner)).keyCount, 1);
  assert.equal(await reopened.get({ ...owner, tenantId: parseTenantId("tenant_two") }, "inbox/state"), undefined);
  assert.equal(await reopened.get({ ...owner, dataNamespaceId: parseDataNamespaceId("data-namespace_two") }, "inbox/state"), undefined);
});

test("restricted app storage commits bounded transactions atomically with revision conflicts", async (t) => {
  const { root, store } = await temporaryStore(t);
  const committed = await store.transaction(owner, {
    expectedRevision: 0,
    set: [
      { key: "a", value: 1 },
      { key: "b", value: { ready: true } },
    ],
  });
  assert.equal(committed.revision, 1);
  assert.deepEqual(committed.changedKeys, ["a", "b"]);

  await assert.rejects(
    store.transaction(owner, { expectedRevision: 0, set: [{ key: "c", value: 3 }] }),
    (error) => error instanceof RestrictedAppStorageError && error.code === "STORAGE_CONFLICT",
  );
  assert.equal(await store.get(owner, "c"), undefined);

  await Promise.all(Array.from({ length: 48 }, (_, index) => store.set(owner, `concurrent/${index}`, index)));
  const reopened = new FileRestrictedAppStorage(root);
  const usage = await reopened.usage(owner);
  assert.equal(usage.keyCount, 50);
  assert.equal(usage.revision, 49);

  const unchanged = await reopened.transaction(owner, {
    expectedRevision: usage.revision,
    set: [{ key: "a", value: 1 }],
  });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.revision, usage.revision);
});

test("restricted app storage enforces value, transaction, key-count, and app byte quotas without partial writes", async (t) => {
  const { store } = await temporaryStore(t);

  await assert.rejects(
    store.set(owner, "oversized", "x".repeat(restrictedAppStorageLimits.valueBytes)),
    (error) => error instanceof RestrictedAppStorageError && error.code === "STORAGE_QUOTA",
  );
  assert.equal(await store.get(owner, "oversized"), undefined);

  await assert.rejects(
    store.transaction(owner, {
      set: [
        { key: "large-a", value: "a".repeat(90 * 1024) },
        { key: "large-b", value: "b".repeat(90 * 1024) },
      ],
    }),
    (error) => error instanceof RestrictedAppStorageError && error.code === "STORAGE_QUOTA",
  );
  assert.deepEqual(await store.keys(owner), []);

  for (let batch = 0; batch < 4; batch += 1) {
    await store.transaction(owner, {
      set: Array.from({ length: restrictedAppStorageLimits.transactionOperations }, (_, index) => ({
        key: `key-${batch}-${index}`,
        value: index,
      })),
    });
  }
  assert.equal((await store.usage(owner)).keyCount, restrictedAppStorageLimits.keys);
  await assert.rejects(
    store.set(owner, "key-over-limit", true),
    (error) => error instanceof RestrictedAppStorageError && error.code === "STORAGE_QUOTA",
  );
  assert.equal(await store.get(owner, "key-over-limit"), undefined);

  await store.clear(owner);
  const chunk = "z".repeat(127 * 1024);
  let quotaRejected = false;
  for (let index = 0; index < 48; index += 1) {
    try {
      await store.set(owner, `chunk-${index}`, chunk);
    } catch (error) {
      assert.ok(error instanceof RestrictedAppStorageError);
      assert.equal(error.code, "STORAGE_QUOTA");
      assert.equal(await store.get(owner, `chunk-${index}`), undefined);
      quotaRejected = true;
      break;
    }
  }
  assert.equal(quotaRejected, true);
  assert.ok((await store.usage(owner)).usageBytes <= restrictedAppStorageLimits.appBytes);
});

test("restricted app storage rejects non-JSON data, cycles, unsafe keys, and conflicting operations", async (t) => {
  const { store } = await temporaryStore(t);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;

  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(), cyclic]) {
    await assert.rejects(
      store.set(owner, "invalid", value as RestrictedAppStorageJsonValue),
      (error) => error instanceof RestrictedAppStorageError && error.code === "STORAGE_INVALID",
    );
  }
  await assert.rejects(store.set(owner, "bad\0key", true), /storage key is invalid/i);
  await assert.rejects(
    store.transaction(owner, { set: [{ key: "same", value: 1 }], delete: ["same"] }),
    /duplicate or conflicting keys/i,
  );
  assert.deepEqual(await store.keys(owner), []);
});

test("restricted app storage clear and deleteApp have distinct durable cleanup semantics", async (t) => {
  const { root, store } = await temporaryStore(t);
  await store.set(owner, "state", { value: 1 });
  const cleared = await store.clear(owner);
  assert.equal(cleared.changed, true);
  assert.equal(cleared.revision, 2);
  assert.equal(cleared.keyCount, 0);

  const reopened = new FileRestrictedAppStorage(root);
  assert.equal((await reopened.usage(owner)).revision, 2);
  assert.equal((await reopened.clear(owner)).changed, false);
  assert.equal(await reopened.deleteApp(owner), true);
  assert.equal(await reopened.deleteApp(owner), false);
  assert.deepEqual(await reopened.usage(owner), {
    revision: 0,
    usageBytes: 0,
    quotaBytes: restrictedAppStorageLimits.appBytes,
    keyCount: 0,
    keyLimit: restrictedAppStorageLimits.keys,
  });
});

test("restricted app storage reauthorizes immediately before an atomic commit", async (t) => {
  const { root, store } = await temporaryStore(t);
  await store.set(owner, "state", { value: 1 });
  let checks = 0;
  let revoked = false;
  let reachedCommit!: () => void;
  let releaseCommit!: () => void;
  const commitReached = new Promise<void>((resolve) => { reachedCommit = resolve; });
  const release = new Promise<void>((resolve) => { releaseCommit = resolve; });

  const mutation = store.set(owner, "state", { value: 2 }, async () => {
    checks += 1;
    reachedCommit();
    await release;
    if (revoked) throw new Error("authority changed");
  });
  await commitReached;
  revoked = true;
  releaseCommit();

  await assert.rejects(mutation, /authority changed/);
  assert.equal(checks, 1);
  assert.deepEqual(await store.get(owner, "state"), { value: 1 });
  assert.deepEqual((await new FileRestrictedAppStorage(root).usage(owner)), {
    revision: 1,
    usageBytes: 21,
    quotaBytes: restrictedAppStorageLimits.appBytes,
    keyCount: 1,
    keyLimit: restrictedAppStorageLimits.keys,
  });
});

test("restricted app storage ignores old Space/app stores", async (t) => {
  const { root, store } = await temporaryStore(t);
  const legacyOwner = { spaceId: "space-one", appId: "mail-app" };
  const legacyHash = createHash("sha256")
    .update("work-fold-restricted-app-storage-v1\0")
    .update(legacyOwner.spaceId)
    .update("\0")
    .update(legacyOwner.appId)
    .digest("hex");
  const legacyDirectory = join(root, legacyHash.slice(0, 2), legacyHash);
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(join(legacyDirectory, "storage.json"), JSON.stringify({
    schemaVersion: 1,
    ...legacyOwner,
    revision: 4,
    usageBytes: Buffer.byteLength(JSON.stringify(["state", { preserved: true }]), "utf8"),
    entries: [{ key: "state", value: { preserved: true } }],
  }), "utf8");

  assert.equal(await store.get(owner, "state"), undefined);
  assert.equal((await store.usage(owner)).revision, 0);
  assert.equal(JSON.parse(await readFile(join(legacyDirectory, "storage.json"), "utf8")).schemaVersion, 1);
});

test("restricted app storage writes one atomic regular file and fails closed on corruption", async (t) => {
  const { root, store } = await temporaryStore(t);
  await store.set(owner, "state", { value: 1 });
  await store.set(owner, "state", { value: 2 });
  const file = await onlyStorageFile(root);
  assert.deepEqual(await readdir(join(file, "..")), ["storage.json"]);

  const record = JSON.parse(await readFile(file, "utf8")) as { usageBytes: number };
  record.usageBytes += 1;
  await writeFile(file, JSON.stringify(record), "utf8");
  const reopened = new FileRestrictedAppStorage(root);
  await assert.rejects(
    reopened.get(owner, "state"),
    (error) => error instanceof RestrictedAppStorageError && error.code === "STORAGE_CORRUPT",
  );
});

test("restricted app storage refuses symbolic-link owner directories", async (t) => {
  const { root, store } = await temporaryStore(t);
  await store.set(owner, "state", "inside");
  const file = await onlyStorageFile(root);
  const ownerDirectory = dirname(file);
  const outside = join(root, "..", "outside-storage");
  await mkdir(outside);
  await writeFile(join(outside, "storage.json"), "outside", "utf8");
  await rm(ownerDirectory, { recursive: true, force: true });
  await symlink(outside, ownerDirectory, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    store.get(owner, "state"),
    (error) => error instanceof RestrictedAppStorageError && error.code === "STORAGE_UNSAFE",
  );
  assert.equal(await readFile(join(outside, "storage.json"), "utf8"), "outside");
});
