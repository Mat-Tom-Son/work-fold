import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileRestrictedAppStorage, validateRestrictedAppDataBackup,
  type RestrictedAppStorageOwner,
} from "../src/local/agent/restricted-app-storage.js";
import { parseDataNamespaceId, parseFeatureInstallationId, parseRuntimeInstanceId, parseTenantId } from "../src/local/agent/app-platform-contract.js";

const owner: RestrictedAppStorageOwner = {
  ownerClass: "instance", tenantId: parseTenantId("tenant_test"),
  runtimeInstanceId: parseRuntimeInstanceId("runtime-instance_test"),
  featureInstallationId: parseFeatureInstallationId("feature-installation_test"),
  dataNamespaceId: parseDataNamespaceId("data-namespace_test"),
};
const digest = "a".repeat(64);
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-app-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new FileRestrictedAppStorage(root) };
}

test("complete app backups restore more than the runtime transaction budget and survive restart", async (t) => {
  const { root, store } = await setup(t);
  for (let batch = 0; batch < 4; batch++) {
    await store.transaction(owner, { set: Array.from({ length: 128 }, (_, index) => ({ key: `record:${batch * 128 + index}`, value: { title: "Quote", index } })) });
  }
  const backup = await store.exportData(owner, "quotes", digest);
  assert.equal(backup.complete, true);
  assert.equal(backup.data.entries.length, 512);
  const parsed = validateRestrictedAppDataBackup(JSON.parse(JSON.stringify(backup)), owner, "quotes", digest);
  await store.clear(owner);
  const empty = await store.usage(owner);
  await store.replaceData(owner, { appDigest: digest, expectedRevision: empty.revision, entries: parsed.data.entries });
  const reopened = new FileRestrictedAppStorage(root);
  assert.equal((await reopened.keys(owner)).length, 512);
  const recovery = await reopened.recovery(owner, digest);
  assert.equal(recovery?.available, true);
  await reopened.replaceData(owner, { appDigest: digest, expectedRevision: empty.revision + 1, recoveryId: recovery!.id });
  assert.equal((await reopened.usage(owner)).keyCount, 0);
});

test("backup integrity, exact installation/revision and closed metadata are enforced", async (t) => {
  const { store } = await setup(t);
  await store.set(owner, "record", { count: 3 });
  const backup = await store.exportData(owner, "quotes", digest);
  const changed = structuredClone(backup);
  changed.data.entries[0]!.value = { count: 99 };
  assert.throws(() => validateRestrictedAppDataBackup(changed, owner, "quotes", digest), /integrity|usage/);
  assert.throws(() => validateRestrictedAppDataBackup(backup, owner, "quotes", "b".repeat(64)), /revision/);
  assert.throws(() => validateRestrictedAppDataBackup(backup, { ...owner, dataNamespaceId: parseDataNamespaceId("data-namespace_other") }, "quotes", digest), /identity/);
  assert.throws(() => validateRestrictedAppDataBackup({ ...backup, grants: ["all"] }, owner, "quotes", digest), /backup/);
  assert.throws(() => validateRestrictedAppDataBackup({ ...backup, complete: false }, owner, "quotes", digest), /backup/);
  assert.equal((await store.usage(owner)).revision, 1);
});

test("recovery cannot overwrite concurrent app writes or revive an updated revision", async (t) => {
  const { store } = await setup(t);
  await store.set(owner, "record", "before");
  await store.replaceData(owner, { appDigest: digest, expectedRevision: 1, entries: [] });
  const recovery = await store.recovery(owner, digest);
  assert.equal(recovery?.available, true);
  assert.equal((await store.recovery(owner, "b".repeat(64)))?.available, false);
  await store.set(owner, "new", "after");
  assert.equal((await store.recovery(owner, digest))?.available, false);
  await assert.rejects(store.replaceData(owner, { appDigest: digest, expectedRevision: 2, entries: [] }), /changed/);
  await assert.rejects(store.replaceData(owner, { appDigest: digest, expectedRevision: 3, recoveryId: recovery!.id }), /no longer current/);
  assert.equal(await store.get(owner, "new"), "after");
});

test("an interrupted restore has durable evidence but is never reported as undoable success", async (t) => {
  const { root, store } = await setup(t);
  await store.set(owner, "record", "original");
  let authorizations = 0;
  await assert.rejects(store.replaceData(owner, { appDigest: digest, expectedRevision: 1, entries: [] }, () => {
    if (++authorizations === 2) throw new Error("authority revoked before data commit");
  }), /revoked/);
  const reopened = new FileRestrictedAppStorage(root);
  assert.equal(await reopened.get(owner, "record"), "original");
  assert.equal((await reopened.recovery(owner, digest))?.available, false);
  assert.equal((await reopened.usage(owner)).revision, 1);
});

test("corrupt recovery metadata fails closed and never clears current data", async (t) => {
  const { root, store } = await setup(t);
  await store.set(owner, "record", "original");
  await store.replaceData(owner, { appDigest: digest, expectedRevision: 1, entries: [] });
  const shard = (await readdir(root))[0]!;
  const namespace = (await readdir(join(root, shard)))[0]!;
  await writeFile(join(root, shard, namespace, "recovery.json"), "{broken");
  await assert.rejects(store.recovery(owner, digest), /unreadable/);
  assert.equal((await store.usage(owner)).revision, 2);
});
