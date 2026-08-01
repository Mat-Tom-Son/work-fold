import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { parseAppPlatformArtifactDigest } from "../src/local/agent/app-platform-artifact.js";
import {
  computeDeclarationDigest,
  parseFeatureInstallationId,
  parsePrincipalId,
  parseRuntimeInstanceId,
  parseTenantId,
} from "../src/local/agent/app-platform-contract.js";
import {
  EncryptedRestrictedAppConnectionStore,
  type RestrictedAppSecretEncryption,
} from "../src/local/agent/restricted-app-connection-store.js";
import type { RestrictedAppConnectionBinding } from "../src/local/agent/restricted-app-connections.js";

class TestEncryption implements RestrictedAppSecretEncryption {
  available = true;

  isAvailable(): boolean {
    return this.available;
  }

  encrypt(plaintext: string): Uint8Array {
    return Buffer.from(plaintext, "utf8").map((value) => value ^ 0xa5);
  }

  decrypt(ciphertext: Uint8Array): string {
    return Buffer.from(Buffer.from(ciphertext).map((value) => value ^ 0xa5)).toString("utf8");
  }
}

const tenantId = parseTenantId("tenant_local-test");
const runtimeInstanceId = parseRuntimeInstanceId("runtime-instance_mail-test");
const featureInstallationId = parseFeatureInstallationId("feature-installation_mail-test");
const principalId = parsePrincipalId("principal_local-test");
const featureRevisionDigest = parseAppPlatformArtifactDigest(`work-fold.artifact.v1:sha256:${"b".repeat(64)}`);
const declarationDigest = computeDeclarationDigest({ destinationId: "mail-api", auth: "bearer" });

function binding(overrides: Partial<RestrictedAppConnectionBinding> = {}): RestrictedAppConnectionBinding {
  return {
    tenantId,
    runtimeInstanceId,
    featureId: "mail-app",
    featureInstallationId,
    featureRevisionDigest,
    declarationId: "mail-api",
    declarationDigest,
    targetIdentity: "https://mail.example.com",
    owner: { kind: "instance", runtimeInstanceId },
    ...overrides,
  };
}

async function temporaryStore(t: test.TestContext): Promise<{
  file: string;
  encryption: TestEncryption;
  store: EncryptedRestrictedAppConnectionStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "work-fold-connections-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "restricted-app-connections.bin");
  const encryption = new TestEncryption();
  return { file, encryption, store: new EncryptedRestrictedAppConnectionStore(file, encryption) };
}

test("encrypted connection store persists without exposing plaintext credentials", async (t) => {
  const { file, encryption, store } = await temporaryStore(t);
  await store.set(binding(), { kind: "bearer", token: "durable-secret-token" });

  const ciphertext = await readFile(file);
  assert.equal(ciphertext.includes(Buffer.from("durable-secret-token")), false);
  const persisted = JSON.parse(encryption.decrypt(ciphertext)) as {
    schemaVersion: number;
    records: Array<Record<string, unknown>>;
  };
  assert.equal(persisted.schemaVersion, 3);
  assert.equal(persisted.records[0]?.recordVersion, 2);
  assert.match(String(persisted.records[0]?.connectionId), /^connection_/);
  assert.equal(persisted.records[0]?.tenantId, tenantId);
  assert.equal(persisted.records[0]?.runtimeInstanceId, runtimeInstanceId);
  assert.equal(persisted.records[0]?.featureInstallationId, featureInstallationId);
  assert.deepEqual(persisted.records[0]?.owner, { kind: "instance", runtimeInstanceId });
  assert.equal("spaceId" in (persisted.records[0] ?? {}), false);
  assert.equal("appId" in (persisted.records[0] ?? {}), false);
  assert.equal("digest" in (persisted.records[0] ?? {}), false);

  const reopened = new EncryptedRestrictedAppConnectionStore(file, encryption);
  assert.deepEqual(await reopened.get(binding()), { kind: "bearer", token: "durable-secret-token" });
});

test("encrypted connection store binds secrets to Tenant, Runtime Instance, Feature Installation, revision, declaration, target, and owner", async (t) => {
  const { store } = await temporaryStore(t);
  await store.set(binding(), { kind: "api-key", value: "bound-secret" });

  assert.deepEqual(await store.get(binding()), { kind: "api-key", value: "bound-secret" });
  for (const mismatch of [
    binding({ tenantId: parseTenantId("tenant_other-test") }),
    binding({ runtimeInstanceId: parseRuntimeInstanceId("runtime-instance_other-test"), owner: { kind: "instance", runtimeInstanceId: parseRuntimeInstanceId("runtime-instance_other-test") } }),
    binding({ featureId: "other-app" }),
    binding({ featureInstallationId: parseFeatureInstallationId("feature-installation_other-test") }),
    binding({ featureRevisionDigest: parseAppPlatformArtifactDigest(`work-fold.artifact.v1:sha256:${"c".repeat(64)}`) }),
    binding({ declarationId: "calendar-api" }),
    binding({ declarationDigest: computeDeclarationDigest({ destinationId: "mail-api", auth: "basic" }) }),
    binding({ targetIdentity: "https://other.example.com" }),
    binding({ owner: { kind: "principal", principalId } }),
  ]) {
    assert.equal(await store.get(mismatch), undefined);
  }
});

test("encrypted connection store serializes writes and durably revokes exact, Feature, and Runtime Instance bindings", async (t) => {
  const { file, encryption, store } = await temporaryStore(t);
  await Promise.all([
    store.set(binding(), { kind: "bearer", token: "first" }),
    store.set(binding({
      declarationId: "calendar-api",
      declarationDigest: computeDeclarationDigest({ destinationId: "calendar-api", auth: "basic" }),
      targetIdentity: "https://calendar.example.com",
    }), { kind: "basic", username: "user", password: "second" }),
  ]);

  assert.equal(await store.delete(binding()), true);
  assert.equal(await store.delete(binding()), false);
  let reopened = new EncryptedRestrictedAppConnectionStore(file, encryption);
  assert.equal(await reopened.get(binding()), undefined);
  assert.deepEqual(
    await reopened.get(binding({
      declarationId: "calendar-api",
      declarationDigest: computeDeclarationDigest({ destinationId: "calendar-api", auth: "basic" }),
      targetIdentity: "https://calendar.example.com",
    })),
    { kind: "basic", username: "user", password: "second" },
  );

  await reopened.deleteFeature({ tenantId, runtimeInstanceId, featureId: "mail-app", featureInstallationId, featureRevisionDigest });
  reopened = new EncryptedRestrictedAppConnectionStore(file, encryption);
  assert.equal(await reopened.get(binding({
    declarationId: "calendar-api",
    declarationDigest: computeDeclarationDigest({ destinationId: "calendar-api", auth: "basic" }),
    targetIdentity: "https://calendar.example.com",
  })), undefined);

  await reopened.set(binding(), { kind: "bearer", token: "third" });
  await reopened.deleteRuntimeInstance({ tenantId, runtimeInstanceId });
  assert.equal(await reopened.get(binding()), undefined);
});

test("encrypted connection store rejects owner substitution and cross-instance owner records", async (t) => {
  const { store } = await temporaryStore(t);
  const otherRuntime = parseRuntimeInstanceId("runtime-instance_other-test");
  await assert.rejects(
    store.set(binding({ owner: { kind: "instance", runtimeInstanceId: otherRuntime } }), { kind: "bearer", token: "secret" }),
    /does not belong to its Runtime Instance/i,
  );
  await store.set(binding({ owner: { kind: "principal", principalId } }), { kind: "bearer", token: "personal" });
  assert.equal(await store.get(binding()), undefined);
  assert.deepEqual(
    await store.get(binding({ owner: { kind: "principal", principalId } })),
    { kind: "bearer", token: "personal" },
  );
});

test("encrypted connection store reauthorizes after staging and before its atomic commit", async (t) => {
  const { file, store } = await temporaryStore(t);
  await store.set(binding(), { kind: "bearer", token: "current-secret" });
  const before = await readFile(file);
  let revoked = false;
  let reachedCommit!: () => void;
  let releaseCommit!: () => void;
  const commitReached = new Promise<void>((resolve) => { reachedCommit = resolve; });
  const release = new Promise<void>((resolve) => { releaseCommit = resolve; });

  const mutation = store.set(binding(), { kind: "bearer", token: "revoked-secret" }, async () => {
    reachedCommit();
    await release;
    if (revoked) throw new Error("authority revoked");
  });
  await commitReached;
  revoked = true;
  releaseCommit();

  await assert.rejects(mutation, /authority revoked/);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual((await readdir(join(file, ".."))).filter((name) => name.endsWith(".tmp")), []);
  assert.deepEqual(await store.get(binding()), { kind: "bearer", token: "current-secret" });
});

test("old connection formats are rejected without rewriting their ciphertext", async (t) => {
  const { file, encryption } = await temporaryStore(t);
  const legacy = {
    schemaVersion: 1,
    records: [{
      spaceId: "space-one",
      appId: "mail-app",
      digest: "b".repeat(64),
      destinationId: "mail-api",
      origin: "https://mail.example.com",
      credential: { kind: "bearer", token: "legacy-secret" },
      updatedAt: "2026-07-15T00:00:00.000Z",
    }],
  };
  await writeFile(file, encryption.encrypt(JSON.stringify(legacy)));
  const store = new EncryptedRestrictedAppConnectionStore(file, encryption);
  const legacyCiphertext = await readFile(file);
  await assert.rejects(store.get(binding()), /version is unsupported/i);
  await assert.rejects(store.set(binding(), { kind: "bearer", token: "replacement-secret" }), /version is unsupported/i);
  assert.deepEqual(await readFile(file), legacyCiphertext);
});

test("encrypted connection store fails closed on corruption and never falls back to a backup", async (t) => {
  const { file, encryption, store } = await temporaryStore(t);
  await store.set(binding(), { kind: "bearer", token: "revoked-secret" });
  const staleCiphertext = await readFile(file);
  await store.delete(binding());
  await writeFile(`${file}.bak`, staleCiphertext);
  await writeFile(file, Buffer.from("corrupt primary"));

  const reopened = new EncryptedRestrictedAppConnectionStore(file, encryption);
  await assert.rejects(reopened.get(binding()), /could not read restricted app connections/i);
  assert.deepEqual((await readdir(join(file, ".."))).filter((name) => name.endsWith(".bak")), ["restricted-app-connections.bin.bak"]);
});

test("encrypted connection store refuses credential writes when encryption is unavailable", async (t) => {
  const { encryption, store } = await temporaryStore(t);
  encryption.available = false;
  await assert.rejects(
    store.set(binding(), { kind: "bearer", token: "must-not-write" }),
    /secure storage is unavailable/i,
  );
});

test("encrypted connection store rejects the 1,025th record without corrupting the readable ceiling", async (t) => {
  const { file, encryption, store } = await temporaryStore(t);
  await store.set(binding(), { kind: "bearer", token: "ceiling-secret" });
  const persisted = JSON.parse(encryption.decrypt(await readFile(file))) as {
    schemaVersion: 3;
    records: Array<Record<string, unknown>>;
  };
  const template = persisted.records[0]!;
  persisted.records = Array.from({ length: 1_024 }, (_, index) => index === 0
    ? template
    : {
        ...structuredClone(template),
        connectionId: `connection_${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        declarationId: `mail-api-${index}`,
      });
  await writeFile(file, encryption.encrypt(JSON.stringify(persisted)));
  const before = await readFile(file);
  const full = new EncryptedRestrictedAppConnectionStore(file, encryption);

  await assert.rejects(
    full.set(binding({
      declarationId: "overflow-api",
      declarationDigest: computeDeclarationDigest({ destinationId: "overflow-api", auth: "bearer" }),
    }), { kind: "bearer", token: "must-not-commit" }),
    /cannot contain more than 1024 records/i,
  );

  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await full.get(binding()), { kind: "bearer", token: "ceiling-secret" });
});
