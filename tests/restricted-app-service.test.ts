import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import type {
  RestrictedAppConnectionBinding,
  RestrictedAppConnectionFeatureScope,
  RestrictedAppConnectionInstanceScope,
  RestrictedAppConnectionStore,
  RestrictedAppCredential,
} from "../src/local/agent/restricted-app-connections.js";
import {
  RestrictedAppService,
  type RestrictedAppInstalled,
  type RestrictedAppRuntimeAuthority,
  type RestrictedAppRuntimeDescriptor,
  type RestrictedAppRuntimeHost,
} from "../src/local/agent/restricted-app-service.js";
import {
  computeDeclarationDigest,
  type AuthorityStamp,
  type EffectivePrincipal,
} from "../src/local/agent/app-platform-contract.js";
import { FileRestrictedAppStorage, type RestrictedAppStorageOwner } from "../src/local/agent/restricted-app-storage.js";
import { RestrictedAppNotificationBroker } from "../src/local/agent/restricted-app-notifications.js";
import { RestrictedAppRegistryVersionUnsupportedError } from "../src/local/agent/restricted-app-registry-error.js";
import {
  RestrictedAppOAuthError,
  RestrictedAppOAuthPkceClient,
  type RestrictedAppOAuthConnection,
  type RestrictedAppOAuthPublicHttpsTransport,
} from "../src/local/agent/restricted-app-oauth.js";

const spaceOne = "ws-1111111111111111";
const spaceTwo = "ws-2222222222222222";
const spaceThree = "ws-3333333333333333";
const refreshAutomation = "refresh-mail";
const exportAutomation = "export-digest";

function platformStorageOwner(app: RestrictedAppInstalled): RestrictedAppStorageOwner {
  return {
    ownerClass: "instance",
    tenantId: app.tenantId,
    runtimeInstanceId: app.runtimeInstanceId,
    featureInstallationId: app.featureInstallationId,
    dataNamespaceId: app.dataNamespaceId,
  };
}

function platformConnectionBinding(app: RestrictedAppInstalled): RestrictedAppConnectionBinding {
  const declaration = app.manifest.permissions.network.find((item) => item.id === "mail-api")!;
  return {
    tenantId: app.tenantId,
    runtimeInstanceId: app.runtimeInstanceId,
    featureId: app.manifest.id,
    featureInstallationId: app.featureInstallationId,
    featureRevisionDigest: app.artifactDigest,
    declarationId: declaration.id,
    declarationDigest: computeDeclarationDigest(declaration),
    targetIdentity: "https://mail.example.com",
    owner: { kind: "instance", runtimeInstanceId: app.runtimeInstanceId },
  };
}

test("RestrictedAppService inspects reviewed bytes and requires the expected digest before installation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-review-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({ rootPath });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });

    assert.equal(review.packageName, "connected-inbox");
    assert.equal(review.manifest.id, "connected-inbox");
    assert.equal(review.manifest.runtime.entry, "index.html");
    assert.equal(review.manifest.runtime.worker, "worker.js");
    assert.match(review.digest, /^[0-9a-f]{64}$/);
    assert.ok(review.fileCount >= 4);
    assert.ok(review.totalBytes > 0);

    await assert.rejects(
      service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: "0".repeat(64) }),
      /changed after review/i,
    );

    const installed = await service.install({
      spaceId: spaceOne,
      spaceRoot,
      sourcePath: "apps/inbox",
      expectedDigest: review.digest,
    });
    assert.equal(installed.digest, review.digest);
    assert.equal(installed.spaceId, spaceOne);
    assert.deepEqual(installed.networkGrants, [], "installation reviews code but does not implicitly grant network access");
    assert.deepEqual(installed.fileGrants, [], "installation does not implicitly grant Space files");
    assert.deepEqual(installed.notificationGrants, [], "installation does not implicitly grant notifications");
    assert.deepEqual(installed.automations, [
      { id: refreshAutomation, enabled: false },
      { id: exportAutomation, enabled: false },
    ], "installation does not implicitly enable reviewed automations");
    assert.equal("stagedRoot" in installed, false, "app-data staging paths must remain internal");
    assert.equal(existsSync(join(rootPath, "staged", review.digest, "worker.js")), true);
    assert.match(await readFile(join(rootPath, "staged", review.digest, "worker.js"), "utf8"), /must remain inert/);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService startup removes only exact owned staging crash directories", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-staging-recovery-"));
  const rootPath = join(sandbox, "state", "restricted-apps");
  const staged = join(rootPath, "staged");
  const staleStaging = ".staging-00000000-0000-4000-8000-000000000001";
  const staleRelease = ".release-00000000-0000-4000-8000-000000000002";
  const unsafeLookalikes = [
    ".release-00000000-0000-1000-8000-000000000003",
    ".release-00000000-0000-4000-7000-000000000004",
    ".release-00000000-0000-4000-8000-000000000005-copy",
    ".release-not-an-owned-temporary-directory",
  ];
  try {
    await mkdir(join(staged, staleStaging, "nested"), { recursive: true });
    await writeFile(join(staged, staleStaging, "nested", "bytes.txt"), "stale", "utf8");
    await mkdir(join(staged, staleRelease, "nested"), { recursive: true });
    await writeFile(join(staged, staleRelease, "nested", "bytes.txt"), "stale", "utf8");
    for (const name of unsafeLookalikes) {
      await mkdir(join(staged, name), { recursive: true });
      await writeFile(join(staged, name, "keep.txt"), "keep", "utf8");
    }
    const ownedPatternFile = join(staged, ".release-00000000-0000-4000-8000-000000000006");
    await writeFile(ownedPatternFile, "not a directory", "utf8");

    const linkedTarget = join(sandbox, "linked-target");
    const linkedLookalike = join(staged, ".release-00000000-0000-4000-8000-000000000007");
    await mkdir(linkedTarget, { recursive: true });
    await writeFile(join(linkedTarget, "keep.txt"), "keep", "utf8");
    let linked = true;
    try {
      await symlink(linkedTarget, linkedLookalike, "junction");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "EPERM" && code !== "EACCES") throw error;
      linked = false;
      t.diagnostic("Linked staging lookalike assertion skipped because this host disallows directory links.");
    }

    const service = await RestrictedAppService.create({ rootPath });
    assert.equal(existsSync(join(staged, staleStaging)), false);
    assert.equal(existsSync(join(staged, staleRelease)), false);
    for (const name of unsafeLookalikes) assert.equal(existsSync(join(staged, name, "keep.txt")), true);
    assert.equal(existsSync(ownedPatternFile), true);
    if (linked) assert.equal(existsSync(join(linkedTarget, "keep.txt")), true);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService persists Space-scoped installs and keeps shared staged bytes until the last removal", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-persistence-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    const firstRuntime = new RecordingRuntimeHost();
    const first = await RestrictedAppService.create({
      rootPath,
      runtimeHost: firstRuntime,
      deferAutomationStart: false,
    });
    const review = await first.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await first.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await first.install({ spaceId: spaceTwo, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    const enabledApp = await first.setAutomationEnabled({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
      enabled: true,
    });
    const enabledNextRunAt = enabledApp.automations.find(({ id }) => id === refreshAutomation)?.nextRunAt;
    assert.ok(enabledNextRunAt, "enabling establishes a durable first cadence point");
    const registryAfterEnable = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      installations: Array<{ spaceId: string; automations: Array<{ id: string; lastScheduledAt?: string }> }>;
    };
    const enabledCadenceAnchor = registryAfterEnable.installations.find(({ spaceId }) => spaceId === spaceOne)
      ?.automations.find(({ id }) => id === refreshAutomation)?.lastScheduledAt;
    assert.ok(enabledCadenceAnchor);
    const persistedRun = await first.runAutomationNow({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
    });
    assert.equal(persistedRun.run.outcome, "success");
    const registryAfterManualRun = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      installations: Array<{ spaceId: string; automations: Array<{ id: string; lastScheduledAt?: string }> }>;
    };
    assert.equal(
      registryAfterManualRun.installations.find(({ spaceId }) => spaceId === spaceOne)
        ?.automations.find(({ id }) => id === refreshAutomation)?.lastScheduledAt,
      enabledCadenceAnchor,
      "a manual run must not move the durable recurring cadence",
    );
    assert.equal((await first.list(spaceOne)).length, 1);
    assert.equal((await first.list(spaceTwo)).length, 1);
    assert.deepEqual(await first.list("ws-3333333333333333"), []);
    await first.close();

    const secondRuntime = new RecordingRuntimeHost();
    const reopened = await RestrictedAppService.create({
      rootPath,
      runtimeHost: secondRuntime,
      deferAutomationStart: false,
    });
    const reopenedApp = (await reopened.list(spaceOne))[0];
    assert.equal(reopenedApp?.digest, review.digest);
    assert.equal(reopenedApp?.automations.find(({ id }) => id === refreshAutomation)?.enabled, true);
    assert.ok(reopenedApp?.automations.find(({ id }) => id === refreshAutomation)?.lastRunAt);
    assert.equal(
      reopenedApp?.automations.find(({ id }) => id === refreshAutomation)?.nextRunAt,
      enabledNextRunAt,
      "restarting before the first scheduled run must preserve its due time",
    );
    assert.deepEqual(
      await reopened.listAutomationRuns(spaceOne, "connected-inbox", review.digest, refreshAutomation),
      [persistedRun.run],
      "automation receipts and enabled state must survive service restart",
    );
    assert.equal((await reopened.list(spaceTwo))[0]?.digest, review.digest);

    assert.equal(await reopened.remove({ spaceId: spaceOne, appId: "connected-inbox", expectedDigest: review.digest }), true);
    assert.equal(existsSync(join(rootPath, "staged", review.digest)), true, "another Space still references the digest");
    assert.deepEqual(await reopened.list(spaceOne), []);
    assert.equal((await reopened.list(spaceTwo)).length, 1);

    assert.equal(await reopened.remove({ spaceId: spaceTwo, appId: "connected-inbox", expectedDigest: review.digest }), true);
    assert.equal(existsSync(join(rootPath, "staged", review.digest)), false, "the last removal should collect staged bytes");
    assert.deepEqual(secondRuntime.stops.map(({ spaceId }) => spaceId), [spaceOne, spaceTwo]);
    await reopened.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("deferred automation startup keeps excluded Spaces inert and starts other persisted jobs exactly once", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-deferred-automations-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    service = await RestrictedAppService.create({ rootPath, runtimeHost: new RecordingRuntimeHost() });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.install({ spaceId: spaceTwo, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    for (const spaceId of [spaceOne, spaceTwo]) {
      await service.setAutomationEnabled({
        spaceId,
        appId: "connected-inbox",
        expectedDigest: review.digest,
        automationId: refreshAutomation,
        enabled: true,
      });
    }
    await service.close();
    service = undefined;

    const runtime = new RecordingRuntimeHost();
    service = await RestrictedAppService.create({ rootPath, runtimeHost: runtime, deferAutomationStart: true });
    assert.equal((await service.list(spaceOne))[0]?.automations[0]?.nextRunAt, undefined);
    assert.equal((await service.list(spaceTwo))[0]?.automations[0]?.nextRunAt, undefined);

    service.startAutomations([spaceOne]);
    service.startAutomations([spaceOne]);

    assert.equal((await service.list(spaceOne))[0]?.automations[0]?.nextRunAt, undefined);
    assert.ok((await service.list(spaceTwo))[0]?.automations[0]?.nextRunAt);
    await assert.rejects(service.runAutomationNow({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
    }), (error: unknown) => error instanceof Error && "code" in error && error.code === "APP_UNAVAILABLE");
    const run = await service.runAutomationNow({
      spaceId: spaceTwo,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
    });
    assert.equal(run.run.outcome, "success");
    assert.equal(runtime.automationRuns.length, 1);

    service.startAutomations([spaceTwo]);
    assert.equal((await service.list(spaceTwo))[0]?.automations[0]?.nextRunAt, undefined,
      "a later exclusion may make another Space inert but cannot reactivate an earlier exclusion");
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService rejects an old branded registry without importing or rewriting it", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-old-registry-"));
  const rootPath = join(sandbox, "state", "restricted-apps");
  const registryPath = join(rootPath, "registry.json");
  const oldRegistry = `${JSON.stringify({ schemaVersion: 2, apps: [{ spaceId: spaceOne }] }, null, 2)}\n`;
  try {
    await mkdir(rootPath, { recursive: true });
    await writeFile(registryPath, oldRegistry, "utf8");
    await assert.rejects(
      RestrictedAppService.create({ rootPath }),
      (error) => error instanceof RestrictedAppRegistryVersionUnsupportedError
        && error.actualVersion === 2
        && error.supportedVersion === 5,
    );
    assert.equal(await readFile(registryPath, "utf8"), oldRegistry);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService advances only the durable authority domains affected by each local lifecycle mutation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-authority-domains-"));
  const spaceRoot = join(sandbox, "space");
  const sourceRoot = join(spaceRoot, "apps", "inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(rootPath, "data"));
  const connections = new MemoryConnectionStore();
  try {
    await writePackage(sourceRoot);
    const service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: new RecordingRuntimeHost(),
      storage,
      connections,
    });
    const firstReview = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    const installed = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: firstReview.digest });

    const granted = await service.grantNetwork({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: firstReview.digest,
      destinationId: "mail-api",
    });
    assert.deepEqual(changedAuthorityFields(installed.authority, granted.authority), ["grantGeneration"]);
    const repeatedGrant = await service.grantNetwork({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: firstReview.digest,
      destinationId: "mail-api",
    });
    assert.deepEqual(repeatedGrant.authority, granted.authority, "an idempotent grant does not create a false authority transition");

    await service.setConnection({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: firstReview.digest,
      destinationId: "mail-api",
      credential: { kind: "api-key", value: "secret" },
    });
    const connected = (await service.list(spaceOne))[0]!;
    assert.deepEqual(changedAuthorityFields(granted.authority, connected.authority), ["connectionGeneration"]);

    const enabled = await service.setAutomationEnabled({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: firstReview.digest,
      automationId: refreshAutomation,
      enabled: true,
    });
    assert.deepEqual(changedAuthorityFields(connected.authority, enabled.authority), ["jobGeneration"]);

    await storage.set(platformStorageOwner(installed), "temporary", true);
    await service.clearStorage(spaceOne, "connected-inbox", firstReview.digest);
    const cleared = (await service.list(spaceOne))[0]!;
    assert.deepEqual(changedAuthorityFields(enabled.authority, cleared.authority), ["dataGeneration"]);

    await writePackage(sourceRoot, { version: "0.2.0" });
    const secondReview = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    const updated = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: secondReview.digest });
    assert.equal(updated.projectId, installed.projectId);
    assert.equal(updated.runtimeInstanceId, installed.runtimeInstanceId);
    assert.equal(updated.featureInstallationId, installed.featureInstallationId, "a reviewed update preserves the installation incarnation");
    assert.equal(updated.dataNamespaceId, installed.dataNamespaceId, "a compatible update preserves the data lineage");
    assert.deepEqual(changedAuthorityFields(cleared.authority, updated.authority), [
      "connectionGeneration",
      "featureInstallationGeneration",
      "grantGeneration",
      "jobGeneration",
    ]);

    await service.remove({ spaceId: spaceOne, appId: "connected-inbox", expectedDigest: secondReview.digest });
    const reinstalled = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: secondReview.digest });
    assert.equal(reinstalled.projectId, installed.projectId, "Feature uninstall does not erase the App Project");
    assert.equal(reinstalled.runtimeInstanceId, installed.runtimeInstanceId, "Feature uninstall does not replace the Development Instance");
    assert.notEqual(reinstalled.featureInstallationId, installed.featureInstallationId, "reinstall creates a new incarnation");
    assert.notEqual(reinstalled.dataNamespaceId, installed.dataNamespaceId, "reinstall cannot revive removed data implicitly");
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService keeps installs idempotent, repairs missing staged bytes, and prevents app-id takeover", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-update-"));
  const spaceRoot = join(sandbox, "space");
  const sourceRoot = join(spaceRoot, "apps", "inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new RecordingRuntimeHost();
  const connections = new MemoryConnectionStore();
  const timestamps = [
    new Date("2026-07-13T12:00:00.000Z"),
    new Date("2026-07-13T12:01:00.000Z"),
  ];
  try {
    await writePackage(sourceRoot);
    const service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: runtime,
      connections,
      now: () => timestamps.shift() ?? new Date("2026-07-13T12:02:00.000Z"),
    });
    const firstReview = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    const firstInstall = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: firstReview.digest });
    const repeated = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: firstReview.digest });
    assert.deepEqual(repeated, firstInstall);
    assert.deepEqual(runtime.stops, []);

    await rm(join(rootPath, "staged", firstReview.digest), { recursive: true, force: true });
    const repaired = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: firstReview.digest });
    assert.equal(repaired.digest, firstReview.digest);
    assert.equal(existsSync(join(rootPath, "staged", firstReview.digest, "worker.js")), true, "idempotent install must restore a missing staged snapshot");

    await writePackage(sourceRoot, {
      version: "0.2.0",
      appSource: "export async function handleAction() { return { count: 2 }; }\nexport async function handleAutomation() {}\n",
    });
    const updateReview = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    const updated = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: updateReview.digest });
    assert.equal(updated.installedAt, firstInstall.installedAt);
    assert.notEqual(updated.updatedAt, firstInstall.updatedAt);
    assert.deepEqual(runtime.stops, [{ spaceId: spaceOne, appId: "connected-inbox", digest: firstReview.digest }]);
    assert.equal(existsSync(join(rootPath, "staged", firstReview.digest)), false);
    assert.deepEqual(connections.deletedFeatures, [{
      tenantId: firstInstall.tenantId,
      runtimeInstanceId: firstInstall.runtimeInstanceId,
      featureId: firstInstall.manifest.id,
      featureInstallationId: firstInstall.featureInstallationId,
      featureRevisionDigest: firstReview.artifactDigest,
    }]);

    await writePackage(join(spaceRoot, "apps", "takeover"), { packageName: "different-package" });
    const takeover = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/takeover" });
    await assert.rejects(
      service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/takeover", expectedDigest: takeover.digest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /different package already owns/i.test(errorMessage(error)),
    );
    assert.equal((await service.list(spaceOne))[0]?.digest, updateReview.digest);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService durably retries post-activation cleanup after restart", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-cleanup-retry-"));
  const spaceRoot = join(sandbox, "space");
  const sourceRoot = join(spaceRoot, "apps", "inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const connections = new FlakyConnectionStore();
  try {
    await writePackage(sourceRoot);
    let service = await RestrictedAppService.create({ rootPath, connections });
    const first = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: first.digest });
    await service.setConnection({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: first.digest,
      destinationId: "mail-api",
      credential: { kind: "api-key", value: "predecessor-secret" },
    });

    await writePackage(sourceRoot, {
      version: "0.2.0",
      appSource: "export async function handleAction() { return { count: 2 }; }\nexport async function handleAutomation() {}\n",
    });
    const second = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    connections.failNextFeatureDelete = true;
    const updated = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: second.digest });
    assert.equal(updated.digest, second.digest, "activation succeeds once stale authority is durably unreachable");
    assert.equal(connections.records.size, 1, "failed physical cleanup remains pending rather than rolling back activation");
    let registry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as { pendingCleanups: unknown[] };
    assert.equal(registry.pendingCleanups.length, 1);
    await service.close();

    service = await RestrictedAppService.create({ rootPath, connections });
    assert.equal(connections.records.size, 0, "startup retries the exact predecessor cleanup idempotently");
    registry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as { pendingCleanups: unknown[] };
    assert.equal(registry.pendingCleanups.length, 0);
    assert.equal((await service.list(spaceOne))[0]?.digest, second.digest);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService durably retries uninstall data purge without reviving the installation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-purge-retry-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const storage = new FlakyFileStorage(join(rootPath, "data"));
  const connections = new MemoryConnectionStore();
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    let service = await RestrictedAppService.create({ rootPath, storage, connections });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    const installed = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    const owner = platformStorageOwner(installed);
    await storage.set(owner, "retained-until-purge", { value: true });
    storage.failNextDelete = true;

    assert.equal(await service.remove({ spaceId: spaceOne, appId: "connected-inbox", expectedDigest: review.digest }), true);
    assert.deepEqual(await service.list(spaceOne), [], "logical uninstall is never rolled back after authority is fenced");
    assert.equal((await storage.usage(owner)).keyCount, 1, "failed physical purge remains durably pending");
    await service.close();

    service = await RestrictedAppService.create({ rootPath, storage, connections });
    assert.equal((await storage.usage(owner)).keyCount, 0, "startup completes the exact pending data purge");
    const registry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as { pendingCleanups: unknown[] };
    assert.equal(registry.pendingCleanups.length, 0);
    assert.deepEqual(await service.list(spaceOne), []);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService binds connections to explicit Tenant, Runtime Instance, Feature, revision, declaration, target, and owner", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-runtime-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new RecordingRuntimeHost();
  const connections = new MemoryConnectionStore();
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({ rootPath, runtimeHost: runtime, connections });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    const installed = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });

    assert.deepEqual(await service.connectionStatus(spaceOne, "connected-inbox", review.digest), [{
      destinationId: "mail-api",
      owner: "instance",
      kind: null,
      configured: false,
    }]);
    const credential = { kind: "api-key" as const, value: "secret-value" };
    assert.deepEqual(await service.setConnection({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      destinationId: "mail-api",
      credential,
    }), { destinationId: "mail-api", owner: "instance", kind: "api-key", configured: true });
    assert.deepEqual(connections.setBindings, [{
      binding: platformConnectionBinding(installed),
      credential,
    }]);
    assert.deepEqual(await service.connectionStatus(spaceOne, "connected-inbox", review.digest), [{
      destinationId: "mail-api",
      owner: "instance",
      kind: "api-key",
      configured: true,
    }]);

    const granted = await service.grantNetwork({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      destinationId: "mail-api",
    });
    assert.deepEqual(granted.networkGrants, ["mail-api"]);
    assert.deepEqual((await service.list(spaceOne))[0]?.networkGrants, ["mail-api"], "the explicit grant must be durable");

    const result = await service.invoke({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      action: "search",
      input: { query: "invoice" },
    });
    assert.deepEqual(result, { count: 7 });
    assert.equal(runtime.invocations.length, 1);
    assert.equal(runtime.invocations[0]?.app.spaceId, spaceOne);
    assert.equal(runtime.invocations[0]?.app.digest, review.digest);
    assert.deepEqual(runtime.invocations[0]?.app.networkGrants, ["mail-api"]);
    assert.equal(runtime.invocations[0]?.app.stagedRoot, join(rootPath, "staged", review.digest));
    assert.equal(isAbsolute(runtime.invocations[0]?.app.stagedRoot ?? ""), true);
    assert.equal(runtime.invocations[0]?.action, "search");
    assert.deepEqual(runtime.invocations[0]?.input, { query: "invoice" });

    await assert.rejects(
      service.invoke({ spaceId: spaceOne, appId: "connected-inbox", expectedDigest: review.digest, action: "undeclared", input: {} }),
      (error: unknown) => errorCode(error) === "ACTION_UNKNOWN",
    );
    const revoked = await service.revokeNetwork({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      destinationId: "mail-api",
    });
    assert.deepEqual(revoked.networkGrants, []);
    assert.deepEqual(runtime.stops, [
      { spaceId: spaceOne, appId: "connected-inbox", digest: review.digest },
      { spaceId: spaceOne, appId: "connected-inbox", digest: review.digest },
      { spaceId: spaceOne, appId: "connected-inbox", digest: review.digest },
    ], "credential replacement, grant, and revoke stop the old runtime owner before changing its authority");
    assert.equal(await service.deleteConnection({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      destinationId: "mail-api",
    }), true);
    assert.deepEqual(connections.deleteBindings, [platformConnectionBinding(installed)]);
    await service.close();
    assert.equal(runtime.closeCount, 1);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService scopes automation powers, resets live authority, and retains historical receipts on update", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-powers-"));
  const spaceRoot = join(sandbox, "space");
  const sourceRoot = join(spaceRoot, "apps", "inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(rootPath, "data"));
  const runtime = new RecordingRuntimeHost();
  try {
    await writePackage(sourceRoot);
    const service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: runtime,
      storage,
      deferAutomationStart: false,
    });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    const installed = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    const owner = platformStorageOwner(installed);
    await storage.set(owner, "view", { folder: "inbox" });

    await assert.rejects(service.grantFiles({
      spaceId: spaceOne,
      spaceRoot,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      permissionId: "exports",
      root: "missing-reports",
    }), (error: unknown) => errorCode(error) === "FILE_DENIED");
    await mkdir(join(spaceRoot, "reports"), { recursive: true });

    const withFiles = await service.grantFiles({
      spaceId: spaceOne,
      spaceRoot,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      permissionId: "exports",
      root: "reports",
    });
    assert.deepEqual(withFiles.fileGrants, [{ id: "exports", declarationId: "exports", root: "reports", access: "read-write" }]);
    const withNotifications = await service.grantNotifications({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      permissionId: "new-mail",
    });
    assert.deepEqual(withNotifications.notificationGrants, ["new-mail"]);
    const withNetwork = await service.grantNetwork({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      destinationId: "mail-api",
    });
    assert.deepEqual(withNetwork.networkGrants, ["mail-api"]);
    const refreshEnabled = await service.setAutomationEnabled({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
      enabled: true,
    });
    assert.equal(refreshEnabled.automations.find(({ id }) => id === refreshAutomation)?.enabled, true);
    await service.setAutomationEnabled({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: exportAutomation,
      enabled: true,
    });
    const refreshed = await service.runAutomationNow({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
    });
    const exported = await service.runAutomationNow({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: exportAutomation,
    });
    assert.equal(refreshed.run.outcome, "success");
    assert.equal(exported.run.outcome, "success");
    assert.equal(refreshed.run.verification, "captured");
    assert.equal(refreshed.run.kind, "job");
    assert.equal(refreshed.run.tenantId, installed.tenantId);
    assert.equal(refreshed.run.runtimeInstanceId, installed.runtimeInstanceId);
    assert.equal(refreshed.run.featureInstallationId, installed.featureInstallationId);
    assert.equal(refreshed.run.featureRevisionDigest, review.artifactDigest);
    assert.equal(refreshed.run.dataNamespaceId, installed.dataNamespaceId);
    assert.deepEqual(refreshed.run.effectivePrincipal, {
      principalId: installed.principalId,
      kind: "human",
      realm: "local",
    });
    assert.ok(refreshed.run.authority);
    assert.equal(refreshed.run.state, "succeeded");
    assert.equal(runtime.automationRuns.length, 2);
    assert.equal(runtime.automationRuns[0]?.event.reason, "manual");
    assert.deepEqual(runtime.automationRuns[0]?.event.effectivePrincipal, refreshed.run.effectivePrincipal);
    assert.equal(runtime.automationRuns[0]?.event.automationId, refreshAutomation);
    assert.equal(runtime.automationRuns[0]?.event.handler, "refresh-inbox");
    assert.deepEqual(runtime.automationRuns[0]?.app.networkGrants, ["mail-api"]);
    assert.deepEqual(runtime.automationRuns[0]?.app.fileGrants, []);
    assert.deepEqual(runtime.automationRuns[0]?.app.notificationGrants, ["new-mail"]);
    assert.deepEqual(runtime.automationRuns[0]?.app.automations.map(({ id }) => id), [refreshAutomation]);
    assert.equal(runtime.automationRuns[1]?.event.handler, "export-digest");
    assert.equal(runtime.automationRuns[1]?.event.automationId, exportAutomation);
    assert.deepEqual(runtime.automationRuns[1]?.app.networkGrants, []);
    assert.deepEqual(runtime.automationRuns[1]?.app.fileGrants, [{ id: "exports", declarationId: "exports", root: "reports", access: "read-write" }]);
    assert.deepEqual(runtime.automationRuns[1]?.app.notificationGrants, []);
    assert.deepEqual(runtime.automationRuns[1]?.app.automations.map(({ id }) => id), [exportAutomation]);
    assert.deepEqual(await service.listAutomationRuns(spaceOne, "connected-inbox", review.digest, refreshAutomation), [refreshed.run]);
    assert.deepEqual(await service.listAutomationRuns(spaceOne, "connected-inbox", review.digest, exportAutomation), [exported.run]);

    await writePackage(sourceRoot, {
      version: "0.2.0",
      appSource: "export async function handleAction() { return { count: 2 }; }\nexport async function handleAutomation() {}\n",
    });
    const nextReview = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    const updated = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: nextReview.digest });
    assert.deepEqual(updated.fileGrants, []);
    assert.deepEqual(updated.notificationGrants, []);
    assert.deepEqual(updated.networkGrants, []);
    assert.deepEqual(updated.automations, [
      { id: refreshAutomation, enabled: false },
      { id: exportAutomation, enabled: false },
    ]);
    assert.deepEqual(await service.listAutomationRuns(spaceOne, "connected-inbox", nextReview.digest, refreshAutomation), []);
    assert.deepEqual(await service.listAutomationRuns(spaceOne, "connected-inbox", nextReview.digest, exportAutomation), []);
    const updatedRegistry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      installations: Array<{ automationRuns: Array<{ packageDigest: string; verification: string }> }>;
      acceptedAutomationRuns: unknown[];
      historicalAutomationRuns: Array<{ runId: string; state: string; acceptedAt: string; scheduledAt: string }>;
    };
    assert.deepEqual(updatedRegistry.installations[0]?.automationRuns, [], "the new revision has no predecessor runs in its current view");
    assert.deepEqual(updatedRegistry.acceptedAutomationRuns, []);
    assert.equal(updatedRegistry.historicalAutomationRuns.length, 2);
    assert.equal(updatedRegistry.historicalAutomationRuns.every((run) => run.state === "succeeded"), true);
    assert.equal(
      updatedRegistry.historicalAutomationRuns.every((run) => Date.parse(run.acceptedAt) >= Date.parse(run.scheduledAt)),
      true,
      "acceptedAt is the durable host acceptance time, not a copied cadence timestamp",
    );
    assert.deepEqual(await storage.get(owner, "view"), { folder: "inbox" }, "same app storage survives a reviewed digest update");

    await service.close();
    const reopened = await RestrictedAppService.create({ rootPath, runtimeHost: runtime, storage });
    assert.deepEqual(
      await reopened.listAutomationRuns(spaceOne, "connected-inbox", nextReview.digest, refreshAutomation),
      [],
      "a restart after update keeps predecessor receipts only in the independent historical ledger",
    );
    await reopened.remove({ spaceId: spaceOne, appId: "connected-inbox", expectedDigest: nextReview.digest });
    const removedRegistry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      historicalAutomationRuns: Array<{ runId: string }>;
    };
    assert.equal(removedRegistry.historicalAutomationRuns.length, 2, "uninstall cannot erase the independent audit ledger");
    assert.equal((await storage.usage(owner)).keyCount, 0, "uninstall deletes machine-local app storage");
    await reopened.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService removes machine-local app state for only the removed Space", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-space-removal-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(rootPath, "data"));
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({ rootPath, storage });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    const installedOne = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    const installedTwo = await service.install({ spaceId: spaceTwo, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    const ownerOne = platformStorageOwner(installedOne);
    const ownerTwo = platformStorageOwner(installedTwo);
    await storage.set(ownerOne, "owner", "one");
    await storage.set(ownerTwo, "owner", "two");

    await service.removeSpace(spaceOne);
    assert.deepEqual(await service.list(spaceOne), []);
    assert.equal((await storage.usage(ownerOne)).keyCount, 0);
    assert.equal(await storage.get(ownerTwo, "owner"), "two");
    assert.equal((await service.list(spaceTwo)).length, 1);
    assert.equal(existsSync(join(rootPath, "staged", review.digest)), true);

    await service.removeSpace(spaceTwo);
    assert.equal((await storage.usage(ownerTwo)).keyCount, 0);
    assert.equal(existsSync(join(rootPath, "staged", review.digest)), false);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService revokes an empty Space's persisted Project and Development Instance context", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-empty-space-removal-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({ rootPath });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.remove({ spaceId: spaceOne, appId: "connected-inbox", expectedDigest: review.digest });

    const before = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      projects: Array<{ spaceId: string }>;
      runtimeInstances: Array<{ spaceId: string }>;
    };
    assert.equal(before.projects.some((item) => item.spaceId === spaceOne), true);
    assert.equal(before.runtimeInstances.some((item) => item.spaceId === spaceOne), true);

    await service.removeSpace(spaceOne);
    const after = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      projects: Array<{ spaceId: string }>;
      runtimeInstances: Array<{ spaceId: string }>;
    };
    assert.equal(after.projects.some((item) => item.spaceId === spaceOne), false);
    assert.equal(after.runtimeInstances.some((item) => item.spaceId === spaceOne), false);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService re-reads scoped notification grants when a queued automation acquires a global slot", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-automation-slot-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new QueuedNotificationRuntimeHost();
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: runtime,
      deferAutomationStart: false,
    });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    for (const spaceId of [spaceOne, spaceTwo, spaceThree]) {
      await service.install({ spaceId, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
      await service.grantNotifications({ spaceId, appId: "connected-inbox", expectedDigest: review.digest, permissionId: "new-mail" });
      await service.setAutomationEnabled({
        spaceId,
        appId: "connected-inbox",
        expectedDigest: review.digest,
        automationId: refreshAutomation,
        enabled: true,
      });
    }
    const first = service.runAutomationNow({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
    });
    const second = service.runAutomationNow({
      spaceId: spaceTwo,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
    });
    await runtime.waitForStarts(2);
    const acceptedRegistry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      acceptedAutomationRuns: Array<{ state: string; runId: string }>;
      historicalAutomationRuns: unknown[];
    };
    assert.equal(acceptedRegistry.acceptedAutomationRuns.length, 2, "acceptance is durable before a worker effect can finish");
    assert.equal(acceptedRegistry.acceptedAutomationRuns.every((receipt) => receipt.state === "accepted"), true);
    assert.deepEqual(acceptedRegistry.historicalAutomationRuns, []);
    const queued = service.runAutomationNow({
      spaceId: spaceThree,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
    });
    await service.revokeNotifications({ spaceId: spaceThree, appId: "connected-inbox", expectedDigest: review.digest, permissionId: "new-mail" });
    runtime.releaseOne();
    const failed = await queued;
    assert.equal(failed.run.outcome, "failure", "manual worker failures must be durable receipts rather than rejected service calls");
    assert.match(failed.run.error ?? "", /notification category is not granted/i);
    assert.equal(failed.app.automations.find(({ id }) => id === refreshAutomation)?.lastError, failed.run.error);
    assert.equal(failed.app.automations.find(({ id }) => id === refreshAutomation)?.lastRunAt, failed.run.finishedAt);
    assert.deepEqual(
      await service.listAutomationRuns(spaceThree, "connected-inbox", review.digest, refreshAutomation),
      [failed.run],
    );
    runtime.releaseOne();
    const completed = await Promise.all([first, second]);
    assert.deepEqual(completed.map(({ run }) => run.outcome), ["success", "success"]);
    assert.deepEqual(runtime.notificationsShown.sort(), [spaceOne, spaceTwo]);
    assert.deepEqual(runtime.notificationsDenied, [spaceThree]);
    const terminalRegistry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      acceptedAutomationRuns: unknown[];
      historicalAutomationRuns: Array<{ state: string }>;
    };
    assert.deepEqual(terminalRegistry.acceptedAutomationRuns, []);
    assert.equal(terminalRegistry.historicalAutomationRuns.length, 3);
    await service.close();
    service = undefined;
  } finally {
    runtime.releaseAll();
    await service?.close().catch(() => undefined);
    runtime.closeBroker();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService reconciles a crash after durable automation acceptance as an explicit unknown interruption", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-automation-recovery-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: new RecordingRuntimeHost(),
      deferAutomationStart: false,
    });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.setAutomationEnabled({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
      enabled: true,
    });
    const completed = await service.runAutomationNow({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
    });
    await service.close();
    service = undefined;

    const registryPath = join(rootPath, "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      acceptedAutomationRuns: unknown[];
      historicalAutomationRuns: Array<Record<string, unknown>>;
      installations: Array<{ automationRuns: unknown[] }>;
    };
    const terminal = registry.historicalAutomationRuns[0]!;
    registry.acceptedAutomationRuns = [{
      receiptId: terminal.receiptId,
      verification: terminal.verification,
      kind: terminal.kind,
      state: "accepted",
      spaceId: terminal.spaceId,
      appId: terminal.appId,
      packageDigest: terminal.packageDigest,
      runId: terminal.runId,
      automationId: terminal.automationId,
      reason: terminal.reason,
      scheduledAt: terminal.scheduledAt,
      tenantId: terminal.tenantId,
      runtimeInstanceId: terminal.runtimeInstanceId,
      featureInstallationId: terminal.featureInstallationId,
      featureRevisionDigest: terminal.featureRevisionDigest,
      dataNamespaceId: terminal.dataNamespaceId,
      effectivePrincipal: terminal.effectivePrincipal,
      authority: terminal.authority,
      acceptedAt: terminal.acceptedAt,
      occurrenceId: terminal.occurrenceId,
      attemptId: terminal.attemptId,
    }];
    registry.historicalAutomationRuns = [];
    registry.installations[0]!.automationRuns = [];
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    service = await RestrictedAppService.create({ rootPath, runtimeHost: new RecordingRuntimeHost() });
    const [recovered] = await service.listAutomationRuns(spaceOne, "connected-inbox", review.digest, refreshAutomation);
    assert.equal(recovered?.runId, completed.run.runId);
    assert.equal(recovered?.outcome, "interrupted");
    assert.equal(recovered?.state, "expired");
    assert.match(recovered?.error ?? "", /completion of external effects is unknown/i);
    const persisted = JSON.parse(await readFile(registryPath, "utf8")) as {
      acceptedAutomationRuns: unknown[];
      historicalAutomationRuns: Array<{ runId: string; outcome: string; state: string }>;
    };
    assert.deepEqual(persisted.acceptedAutomationRuns, []);
    assert.deepEqual(persisted.historicalAutomationRuns.map(({ runId, outcome, state }) => ({ runId, outcome, state })), [{
      runId: completed.run.runId,
      outcome: "interrupted",
      state: "expired",
    }]);
    await service.close();
    service = undefined;
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService's machine-wide run ledgers join active runs with scoped file-grant authority", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-active-runs-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new GatedAutomationRuntimeHost();
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    await mkdir(join(spaceRoot, "reports"), { recursive: true });
    service = await RestrictedAppService.create({ rootPath, runtimeHost: runtime, deferAutomationStart: false });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.grantFiles({
      spaceId: spaceOne,
      spaceRoot,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      permissionId: "exports",
      root: "reports",
    });
    for (const automationId of [refreshAutomation, exportAutomation]) {
      await service.setAutomationEnabled({
        spaceId: spaceOne,
        appId: "connected-inbox",
        expectedDigest: review.digest,
        automationId,
        enabled: true,
      });
    }
    assert.deepEqual(await service.listActiveAutomationRuns(), []);
    assert.deepEqual(await service.listAutomationRunHistory(), []);

    const refreshRun = service.runAutomationNow({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
    });
    const exportRun = service.runAutomationNow({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: exportAutomation,
    });
    await runtime.waitForStarts(2);
    const active = await service.listActiveAutomationRuns();
    assert.equal(active.length, 2);
    const byAutomation = new Map(active.map((run) => [run.automationId, run]));
    assert.deepEqual(
      byAutomation.get(refreshAutomation)?.fileGrantIds,
      [],
      "a run whose automation declares no file permissions provably holds none",
    );
    assert.deepEqual(
      byAutomation.get(exportAutomation)?.fileGrantIds,
      ["exports"],
      "the join narrows the installation's grants to the automation's declared permissions",
    );
    for (const run of active) {
      assert.equal(run.spaceId, spaceOne);
      assert.equal(run.appId, "connected-inbox");
      assert.equal(run.reason, "manual");
      assert.match(run.acceptedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(run.scheduledAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(run.runId);
    }

    runtime.releaseAll();
    const settled = await Promise.all([refreshRun, exportRun]);
    assert.deepEqual(settled.map(({ run }) => run.outcome), ["success", "success"]);
    assert.deepEqual(await service.listActiveAutomationRuns(), [], "settled runs leave the active ledger");
    const history = await service.listAutomationRunHistory();
    assert.deepEqual(
      history.map((receipt) => receipt.automationId).sort(),
      [exportAutomation, refreshAutomation].sort(),
    );
    for (const receipt of history) {
      assert.equal(receipt.spaceId, spaceOne);
      assert.equal(receipt.appId, "connected-inbox");
      assert.equal(receipt.outcome, "success");
      assert.equal(receipt.reason, "manual");
      assert.match(receipt.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(receipt.receiptId);
      assert.ok(receipt.runId);
    }
    assert.equal((await service.listAutomationRunHistory(1)).length, 1, "the history read is bounded by its limit");
    await assert.rejects(service.listAutomationRunHistory(0), /positive integer/);
    await service.close();
    service = undefined;
  } finally {
    runtime.releaseAll();
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService persists a nonempty fallback for an empty worker failure and reopens cleanly", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-empty-automation-error-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    const runtimeHost: RestrictedAppRuntimeHost = {
      async invoke() { return {}; },
      async runAutomation() { throw new Error("   "); },
      async close() {},
    };
    service = await RestrictedAppService.create({
      rootPath,
      runtimeHost,
      deferAutomationStart: false,
    });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.setAutomationEnabled({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
      enabled: true,
    });
    const failed = await service.runAutomationNow({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
    });
    assert.equal(failed.run.outcome, "failure");
    assert.equal(failed.run.error, "Automation run failed.");
    await service.close();
    service = undefined;

    service = await RestrictedAppService.create({ rootPath, runtimeHost });
    assert.equal(
      (await service.listAutomationRuns(spaceOne, "connected-inbox", review.digest, refreshAutomation))[0]?.error,
      "Automation run failed.",
    );
    await service.close();
    service = undefined;
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService serializes an automation launch started by stop behind the grant mutation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-automation-stop-race-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new StopRaceRuntimeHost();
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: runtime,
      deferAutomationStart: false,
    });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.grantNotifications({ spaceId: spaceOne, appId: "connected-inbox", expectedDigest: review.digest, permissionId: "new-mail" });
    await service.setAutomationEnabled({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
      enabled: true,
    });

    runtime.startAutomationWhenStopped(service, review.digest);
    await service.revokeNotifications({ spaceId: spaceOne, appId: "connected-inbox", expectedDigest: review.digest, permissionId: "new-mail" });
    const pendingRun = runtime.automationRun;
    assert.ok(pendingRun);
    const run = await pendingRun;

    assert.equal(run.run.outcome, "success");
    assert.equal(runtime.automationRuns.length, 1);
    assert.deepEqual(runtime.automationRuns[0]?.app.notificationGrants, [], "the post-stop launch must re-read the committed grant state");
    assert.deepEqual(runtime.automationRuns[0]?.app.networkGrants, [], "the named job must not inherit undeclared app powers");
    assert.deepEqual(await service.listAutomationRuns(spaceOne, "connected-inbox", review.digest, refreshAutomation), [run.run]);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a Space-removal fence blocks an automation already accepted into the service queue", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-automation-removal-fence-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new FenceDuringAuthoritySyncRuntimeHost();
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: runtime,
      deferAutomationStart: false,
    });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.setAutomationEnabled({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
      enabled: true,
    });

    runtime.fenceOnNextAuthoritySync(() => service.fenceSpaceRemoval(spaceOne));
    const result = await service.runAutomationNow({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      automationId: refreshAutomation,
    });

    assert.notEqual(result.run.outcome, "success");
    assert.equal(runtime.automationRuns, 0, "the runtime host must never receive work after the removal fence");
    assert.deepEqual(runtime.authorities, []);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a Space-removal fence retries runtime authority sync after a transient host failure", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-removal-fence-retry-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new FenceDuringAuthoritySyncRuntimeHost();
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({ rootPath, runtimeHost: runtime });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    assert.equal(runtime.authorities.length, 1);

    runtime.failNextAuthoritySync();
    assert.throws(() => service.fenceSpaceRemoval(spaceOne), /simulated authority sync failure/);
    assert.equal(runtime.authorities.length, 1, "the injected host failure models stale authority");
    service.fenceSpaceRemoval(spaceOne);
    assert.deepEqual(runtime.authorities, [], "replaying the same fence must retry authority synchronization");
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService uses OAuth generation invalidation so disconnect cannot be undone by an in-flight refresh", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-oauth-disconnect-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const connections = new MemoryConnectionStore();
  const runtime = new RecordingRuntimeHost();
  const configuration = { issuer: "https://identity.example.com", clientId: "work-fold-public-client", scopes: ["mail.read"] };
  let refreshStarted!: () => void;
  let releaseRefresh!: () => void;
  const started = new Promise<void>((resolvePromise) => { refreshStarted = resolvePromise; });
  const release = new Promise<void>((resolvePromise) => { releaseRefresh = resolvePromise; });
  const transport: RestrictedAppOAuthPublicHttpsTransport = {
    async getJson() {
      return {
        status: 200,
        body: {
          issuer: configuration.issuer,
          authorization_endpoint: "https://identity.example.com/authorize",
          token_endpoint: "https://identity.example.com/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        },
      };
    },
    async postForm() {
      refreshStarted();
      await release;
      return { status: 200, body: { access_token: "resurrected-access", token_type: "Bearer", expires_in: 3_600 } };
    },
  };
  const oauth = oauthClient(connections, transport, new Date("2026-07-13T12:00:00.000Z"));
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"), { networkAuth: [{ kind: "oauth2-pkce", ...configuration }] });
    const service = await RestrictedAppService.create({ rootPath, runtimeHost: runtime, connections, oauth });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    const installed = await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    const binding = platformConnectionBinding(installed);
    await connections.set(binding, {
      kind: "oauth2-pkce",
      issuer: configuration.issuer,
      clientId: configuration.clientId,
      requestedScopes: configuration.scopes,
      grantedScopes: configuration.scopes,
      tokenType: "Bearer",
      accessToken: "expiring-access",
      refreshToken: "old-refresh",
      expiresAt: "2026-07-13T12:00:30.000Z",
      connectedAt: "2026-07-12T12:00:00.000Z",
    });

    const authorization = oauth.authorize(binding, configuration, new Headers());
    await started;
    assert.equal(await service.deleteConnection({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      destinationId: "mail-api",
    }), true);
    releaseRefresh();

    await assert.rejects(authorization, (error: unknown) => error instanceof RestrictedAppOAuthError && error.code === "AUTH_REQUIRED");
    assert.equal(await connections.get(binding), undefined);
    assert.equal(connections.setBindings.length, 1, "the in-flight refresh must not save a replacement token");
    assert.deepEqual(runtime.stops, [{ spaceId: spaceOne, appId: "connected-inbox", digest: review.digest }]);
    await service.close();
  } finally {
    releaseRefresh?.();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("an exact Local App connection reset cannot be undone by an in-flight OAuth refresh", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-oauth-local-reset-"));
  const spaceRoot = join(sandbox, "source-space");
  const packageRoot = join(spaceRoot, "apps", "inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const connections = new MemoryConnectionStore();
  const configuration = { issuer: "https://identity.example.com", clientId: "work-fold-public-client", scopes: ["mail.read"] };
  let refreshStarted!: () => void;
  let releaseRefresh!: () => void;
  const started = new Promise<void>((resolvePromise) => { refreshStarted = resolvePromise; });
  const release = new Promise<void>((resolvePromise) => { releaseRefresh = resolvePromise; });
  const oauth = oauthClient(connections, {
    async getJson() {
      return {
        status: 200,
        body: {
          issuer: configuration.issuer,
          authorization_endpoint: "https://identity.example.com/authorize",
          token_endpoint: "https://identity.example.com/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        },
      };
    },
    async postForm() {
      refreshStarted();
      await release;
      return { status: 200, body: { access_token: "stale-successor-access", token_type: "Bearer", expires_in: 3_600 } };
    },
  }, new Date("2026-07-13T12:00:00.000Z"));
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(packageRoot, { networkAuth: [{ kind: "oauth2-pkce", ...configuration }] });
    service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: new RecordingRuntimeHost(),
      connections,
      oauth,
    });
    await service.declareLocalAppProject({
      spaceId: spaceOne,
      presentation: { title: "Connected Inbox", description: null, icon: "mail" },
    });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });

    const preparedOne = await service.prepareLocalAppRelease({ spaceId: spaceOne, displayVersion: "1.0.0" });
    const releaseOne = await service.publishLocalAppRelease({
      spaceId: spaceOne,
      releaseDigest: preparedOne.releaseDigest,
    });
    const install = await service.prepareLocalAppInstall({
      sourceSpaceId: spaceOne,
      targetSpaceId: spaceTwo,
      releaseDigest: releaseOne.releaseDigest,
    });
    const installed = (await service.activateLocalAppInstall(install.operationId)).apps[0]!;
    const binding = platformConnectionBinding(installed);
    await connections.set(binding, {
      kind: "oauth2-pkce",
      issuer: configuration.issuer,
      clientId: configuration.clientId,
      requestedScopes: configuration.scopes,
      grantedScopes: configuration.scopes,
      tokenType: "Bearer",
      accessToken: "expiring-access",
      refreshToken: "old-refresh",
      expiresAt: "2026-07-13T12:00:30.000Z",
      connectedAt: "2026-07-12T12:00:00.000Z",
    });

    const authorization = oauth.authorize(binding, configuration, new Headers());
    await started;
    const preparedTwo = await service.prepareLocalAppRelease({ spaceId: spaceOne, displayVersion: "1.0.1" });
    const releaseTwo = await service.publishLocalAppRelease({
      spaceId: spaceOne,
      releaseDigest: preparedTwo.releaseDigest,
    });
    const update = await service.prepareLocalAppUpdate({
      sourceSpaceId: spaceOne,
      runtimeInstanceId: installed.runtimeInstanceId,
      releaseDigest: releaseTwo.releaseDigest,
      continuityPolicy: "reset",
    });
    const successor = (await service.activateLocalAppUpdate(update.operationId)).apps[0]!;
    assert.deepEqual(platformConnectionBinding(successor), binding,
      "this regression must exercise the exact binding reused by the successor Feature");
    releaseRefresh();

    await assert.rejects(authorization, (error: unknown) => (
      error instanceof RestrictedAppOAuthError && error.code === "AUTH_REQUIRED"
    ));
    assert.equal(connections.setBindings.length, 1, "the stale refresh must not recreate the reset binding");
    assert.equal((await service.connectionStatus(spaceTwo, "connected-inbox", successor.digest))[0]?.configured, false);
  } finally {
    releaseRefresh?.();
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService invalidates OAuth generations before credential replacement, app update, and removal", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-oauth-lifecycle-"));
  const spaceRoot = join(sandbox, "space");
  const sourceRoot = join(spaceRoot, "apps", "inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const connections = new MemoryConnectionStore();
  const oauth = oauthClient(connections, {
    async getJson() { assert.fail("Lifecycle invalidation must not contact the provider."); },
    async postForm() { assert.fail("Lifecycle invalidation must not contact the provider."); },
  }, new Date("2026-07-13T12:00:00.000Z"));
  const networkAuth = [
    { kind: "api-key", header: "x-api-key" },
    { kind: "oauth2-pkce", issuer: "https://identity.example.com", clientId: "work-fold-public-client", scopes: ["mail.read"] },
  ];
  try {
    await writePackage(sourceRoot, { networkAuth });
    const service = await RestrictedAppService.create({ rootPath, runtimeHost: new RecordingRuntimeHost(), connections, oauth });
    const first = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: first.digest });
    await service.setConnection({
      spaceId: spaceOne,
      appId: "connected-inbox",
      expectedDigest: first.digest,
      destinationId: "mail-api",
      credential: { kind: "api-key", value: "replacement" },
    });

    await writePackage(sourceRoot, { version: "0.2.0", networkAuth });
    const second = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: second.digest });
    await service.remove({ spaceId: spaceOne, appId: "connected-inbox", expectedDigest: second.digest });

    assert.deepEqual(connections.deleteBindings.map((binding) => binding.featureRevisionDigest), [
      first.artifactDigest,
      first.artifactDigest,
      second.artifactDigest,
    ]);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService starts every Space app stop together and preserves state if any stop fails", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-remove-failure-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new RejectingStopRuntimeHost("second-inbox");
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    await writePackage(join(spaceRoot, "apps", "second"), { packageName: "second-inbox", appId: "second-inbox" });
    const service = await RestrictedAppService.create({ rootPath, runtimeHost: runtime });
    for (const sourcePath of ["apps/inbox", "apps/second"]) {
      const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath });
      await service.install({ spaceId: spaceOne, spaceRoot, sourcePath, expectedDigest: review.digest });
    }
    await assert.rejects(service.removeSpace(spaceOne), /stop failed/);
    assert.deepEqual(runtime.stops.sort(), ["connected-inbox", "second-inbox"]);
    assert.deepEqual((await service.list(spaceOne)).map((app) => app.manifest.id).sort(), ["connected-inbox", "second-inbox"]);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService fails closed when its durable registry is corrupt", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-corrupt-"));
  const rootPath = join(sandbox, "restricted-apps");
  try {
    await mkdir(join(rootPath, "staged"), { recursive: true });
    await writeFile(join(rootPath, "registry.json"), "{not-json", "utf8");
    await assert.rejects(
      RestrictedAppService.create({ rootPath }),
      /could not read the restricted app registry/i,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService identifies a registry written by a newer work-fold without rewriting it", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-newer-registry-"));
  const rootPath = join(sandbox, "restricted-apps");
  const registryPath = join(rootPath, "registry.json");
  const newerRegistry = `${JSON.stringify({ schemaVersion: 6, futureState: true }, null, 2)}\n`;
  try {
    await mkdir(rootPath, { recursive: true });
    await writeFile(registryPath, newerRegistry, "utf8");
    await assert.rejects(
      RestrictedAppService.create({ rootPath }),
      (error) => {
        assert.ok(error instanceof RestrictedAppRegistryVersionUnsupportedError);
        assert.equal(error.actualVersion, 6);
        assert.equal(error.supportedVersion, 5);
        return true;
      },
    );
    assert.equal(await readFile(registryPath, "utf8"), newerRegistry);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService rejects an oversized registry commit without bricking the last readable state", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-registry-bound-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  let service: RestrictedAppService | undefined;
  try {
    const packageRoot = join(spaceRoot, "apps", "large-contract");
    await writePackage(packageRoot);
    const manifestPath = join(packageRoot, "agent-app.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.tools = [{
      name: "large_contract",
      description: "Exercise bounded registry persistence.",
      action: "large-contract",
      inputSchema: {
        type: "string",
        enum: Array.from({ length: 32 }, (_, index) => `${index.toString().padStart(2, "0")}-${"x".repeat(13_900)}`),
      },
      resultSchema: { type: "null" },
    }];
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    service = await RestrictedAppService.create({ rootPath });
    const review = await service.inspect({ spaceId: "ws-registry-0", spaceRoot, sourcePath: "apps/large-contract" });
    const installedWorkspaces: string[] = [];
    let rejectedWorkspace = "";
    for (let index = 0; index < 24; index += 1) {
      const spaceId = `ws-registry-${index}`;
      try {
        await service.install({ spaceId, spaceRoot, sourcePath: "apps/large-contract", expectedDigest: review.digest });
        installedWorkspaces.push(spaceId);
      } catch (error) {
        assert.match(error instanceof Error ? error.message : String(error), /registry exceeds the 5242880-byte persistence limit/i);
        rejectedWorkspace = spaceId;
        break;
      }
    }
    assert.ok(installedWorkspaces.length > 1 && rejectedWorkspace, "the fixture must reach the write boundary");
    const registryPath = join(rootPath, "registry.json");
    assert.ok((await readFile(registryPath)).byteLength <= 5 * 1024 * 1024);
    assert.equal((await service.list(rejectedWorkspace)).length, 0);
    assert.equal((await service.list(installedWorkspaces.at(-1)!)).length, 1);
    await service.close();
    service = undefined;

    service = await RestrictedAppService.create({ rootPath });
    assert.equal((await service.list(rejectedWorkspace)).length, 0);
    assert.equal((await service.list(installedWorkspaces.at(-1)!)).length, 1);
    await service.close();
    service = undefined;
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService rejects corrupt required grant arrays without rewriting the registry", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-corrupt-grants-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "restricted-apps");
  const registryPath = join(rootPath, "registry.json");
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({ rootPath });
    const review = await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" });
    await service.install({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.close();

    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      installations: Array<{ networkGrants: unknown }>;
    };
    registry.installations[0]!.networkGrants = {};
    const corrupt = `${JSON.stringify(registry, null, 2)}\n`;
    await writeFile(registryPath, corrupt, "utf8");
    await assert.rejects(RestrictedAppService.create({ rootPath }), /network grants are missing/i);
    assert.equal(await readFile(registryPath, "utf8"), corrupt);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService confines package sources to normal visible directories inside the Space", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-paths-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const outsideRoot = join(sandbox, "outside-app");
  try {
    await writePackage(join(spaceRoot, "apps", "inbox"));
    await writePackage(join(spaceRoot, ".pi", "hidden-app"));
    await writePackage(join(spaceRoot, ".work-fold", "hidden-app"));
    await writePackage(join(spaceRoot, ".workspace", "hidden-app"));
    await writePackage(outsideRoot);
    const service = await RestrictedAppService.create({ rootPath });
    assert.equal((await service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/inbox" })).manifest.id, "connected-inbox");

    for (const sourcePath of [outsideRoot, "../outside-app", ".pi/hidden-app", ".work-fold/hidden-app", ".workspace/hidden-app", ".", ""]) {
      await assert.rejects(
        service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath }),
        (error: unknown) => errorCode(error) === "INPUT_INVALID",
        sourcePath || "<empty>",
      );
    }

    const linkedPath = join(spaceRoot, "apps", "linked-outside");
    try {
      await symlink(outsideRoot, linkedPath, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        service.inspect({ spaceId: spaceOne, spaceRoot, sourcePath: "apps/linked-outside" }),
        (error: unknown) => errorCode(error) === "INPUT_INVALID" && /link|escapes the Space/i.test(errorMessage(error)),
      );
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "EPERM" || code === "EACCES") t.diagnostic("Link confinement assertion skipped because this Windows host disallows directory links.");
      else throw error;
    }
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

type AutomationRuntimeEvent = {
  runId: string;
  automationId: string;
  handler: string;
  reason: "scheduled" | "manual" | "resume";
  scheduledAt: string;
  effectivePrincipal: EffectivePrincipal;
};

class RecordingRuntimeHost implements RestrictedAppRuntimeHost {
  readonly invocations: Array<{ app: RestrictedAppRuntimeDescriptor; action: string; input: unknown }> = [];
  readonly automationRuns: Array<{ app: RestrictedAppRuntimeDescriptor; event: AutomationRuntimeEvent }> = [];
  readonly stops: Array<{ spaceId: string; appId: string; digest?: string }> = [];
  closeCount = 0;

  async invoke(app: RestrictedAppRuntimeDescriptor, action: string, input: unknown): Promise<unknown> {
    this.invocations.push({ app: structuredClone(app), action, input: structuredClone(input) });
    return { count: 7 };
  }

  async runAutomation(app: RestrictedAppRuntimeDescriptor, event: AutomationRuntimeEvent): Promise<void> {
    this.automationRuns.push({ app: structuredClone(app), event: structuredClone(event) });
  }

  async stop(spaceId: string, appId: string, digest?: string): Promise<void> {
    this.stops.push({ spaceId, appId, ...(digest ? { digest } : {}) });
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

class GatedAutomationRuntimeHost implements RestrictedAppRuntimeHost {
  readonly #releases: Array<() => void> = [];
  readonly #startWaiters: Array<{ count: number; resolve: () => void }> = [];
  #started = 0;

  async invoke(): Promise<unknown> { return {}; }

  async runAutomation(): Promise<void> {
    this.#started += 1;
    for (const waiter of [...this.#startWaiters]) {
      if (this.#started < waiter.count) continue;
      this.#startWaiters.splice(this.#startWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    await new Promise<void>((resolvePromise) => this.#releases.push(resolvePromise));
  }

  async waitForStarts(count: number): Promise<void> {
    if (this.#started >= count) return;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(
        () => rejectPromise(new Error(`Timed out waiting for ${count} automation runs to start; observed ${this.#started}.`)),
        10_000,
      );
      this.#startWaiters.push({
        count,
        resolve: () => {
          clearTimeout(timeout);
          resolvePromise();
        },
      });
    });
  }

  releaseAll(): void {
    for (const release of this.#releases.splice(0)) release();
  }

  async stop(): Promise<void> {}
  async close(): Promise<void> {}
}

class QueuedNotificationRuntimeHost implements RestrictedAppRuntimeHost {
  readonly notificationsShown: string[] = [];
  readonly notificationsDenied: string[] = [];
  readonly #releases: Array<() => void> = [];
  readonly #startWaiters: Array<{ count: number; resolve: () => void }> = [];
  readonly #broker = new RestrictedAppNotificationBroker({
    sink: {
      isSupported: () => true,
      show: (notification, callbacks) => {
        this.notificationsShown.push(notification.spaceId);
        return { close: callbacks.onClose };
      },
    },
  });
  #started = 0;

  async invoke(): Promise<unknown> { return {}; }

  async runAutomation(app: RestrictedAppRuntimeDescriptor, event: AutomationRuntimeEvent): Promise<void> {
    this.#started += 1;
    this.#resolveStartWaiters();
    if (this.#started <= 2) await new Promise<void>((resolvePromise) => this.#releases.push(resolvePromise));
    try {
      this.#broker.show({
        spaceId: app.spaceId,
        appId: app.manifest.id,
        digest: app.digest,
        appTitle: app.manifest.title,
        declarations: app.manifest.permissions.notifications,
        grants: app.notificationGrants,
        automationEnabled: app.automations.some((automation) => automation.id === event.automationId && automation.enabled),
        invocationId: event.runId,
      }, { permissionId: "new-mail" }, () => undefined);
    } catch (error) {
      this.notificationsDenied.push(app.spaceId);
      throw error;
    }
  }

  async waitForStarts(count: number): Promise<void> {
    if (this.#started >= count) return;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const waiter = {
        count,
        resolve: () => {
          clearTimeout(timeout);
          resolvePromise();
        },
      };
      const timeout = setTimeout(() => {
        const index = this.#startWaiters.indexOf(waiter);
        if (index >= 0) this.#startWaiters.splice(index, 1);
        rejectPromise(new Error(`Timed out waiting for ${count} automation runs to start; observed ${this.#started}.`));
      }, 10_000);
      this.#startWaiters.push(waiter);
      this.#resolveStartWaiters();
    });
  }

  #resolveStartWaiters(): void {
    for (let index = this.#startWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#startWaiters[index];
      if (waiter && this.#started >= waiter.count) {
        this.#startWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  releaseOne(): void { this.#releases.shift()?.(); }
  releaseAll(): void {
    for (const release of this.#releases.splice(0)) release();
  }
  async stop(): Promise<void> {}
  async close(): Promise<void> {}
  closeBroker(): void { this.#broker.dispose(); }
}

class RejectingStopRuntimeHost implements RestrictedAppRuntimeHost {
  readonly stops: string[] = [];
  constructor(readonly rejectedAppId: string) {}
  async invoke(): Promise<unknown> { return {}; }
  async stop(_spaceId: string, appId: string): Promise<void> {
    this.stops.push(appId);
    if (appId === this.rejectedAppId) throw new Error("stop failed");
  }
  async close(): Promise<void> {}
}

class StopRaceRuntimeHost implements RestrictedAppRuntimeHost {
  readonly automationRuns: Array<{ app: RestrictedAppRuntimeDescriptor; event: AutomationRuntimeEvent }> = [];
  automationRun?: ReturnType<RestrictedAppService["runAutomationNow"]>;
  #onStop?: () => void;

  async invoke(): Promise<unknown> { return {}; }
  async runAutomation(app: RestrictedAppRuntimeDescriptor, event: AutomationRuntimeEvent): Promise<void> {
    this.automationRuns.push({ app: structuredClone(app), event: structuredClone(event) });
  }
  startAutomationWhenStopped(service: RestrictedAppService, digest: string): void {
    this.#onStop = () => {
      this.automationRun = service.runAutomationNow({
        spaceId: spaceOne,
        appId: "connected-inbox",
        expectedDigest: digest,
        automationId: refreshAutomation,
      });
    };
  }
  async stop(): Promise<void> {
    const callback = this.#onStop;
    this.#onStop = undefined;
    callback?.();
  }
  async close(): Promise<void> {}
}

class FenceDuringAuthoritySyncRuntimeHost implements RestrictedAppRuntimeHost {
  authorities: RestrictedAppRuntimeAuthority[] = [];
  automationRuns = 0;
  #onNextAuthoritySync: (() => void) | undefined;
  #failNextAuthoritySync = false;

  fenceOnNextAuthoritySync(callback: () => void): void {
    this.#onNextAuthoritySync = callback;
  }

  failNextAuthoritySync(): void {
    this.#failNextAuthoritySync = true;
  }

  syncAuthority(authorities: readonly RestrictedAppRuntimeAuthority[]): void {
    if (this.#failNextAuthoritySync) {
      this.#failNextAuthoritySync = false;
      throw new Error("simulated authority sync failure");
    }
    this.authorities = structuredClone(authorities);
    const callback = this.#onNextAuthoritySync;
    this.#onNextAuthoritySync = undefined;
    callback?.();
  }

  async invoke(): Promise<unknown> { return {}; }
  async runAutomation(): Promise<void> { this.automationRuns += 1; }
  async stop(): Promise<void> {}
  async close(): Promise<void> {}
}

class MemoryConnectionStore implements RestrictedAppConnectionStore {
  readonly records = new Map<string, RestrictedAppCredential>();
  readonly setBindings: Array<{ binding: RestrictedAppConnectionBinding; credential: RestrictedAppCredential }> = [];
  readonly deleteBindings: RestrictedAppConnectionBinding[] = [];
  readonly deletedFeatures: RestrictedAppConnectionFeatureScope[] = [];
  readonly deletedRuntimeInstances: RestrictedAppConnectionInstanceScope[] = [];

  async get(binding: RestrictedAppConnectionBinding): Promise<RestrictedAppCredential | undefined> {
    return structuredClone(this.records.get(connectionKey(binding)));
  }

  async set(binding: RestrictedAppConnectionBinding, credential: RestrictedAppCredential): Promise<void> {
    this.setBindings.push({ binding: structuredClone(binding), credential: structuredClone(credential) });
    this.records.set(connectionKey(binding), structuredClone(credential));
  }

  async delete(binding: RestrictedAppConnectionBinding): Promise<boolean> {
    this.deleteBindings.push(structuredClone(binding));
    return this.records.delete(connectionKey(binding));
  }

  async deleteFeature(scope: RestrictedAppConnectionFeatureScope): Promise<void> {
    this.deletedFeatures.push(structuredClone(scope));
    for (const [key, credential] of this.records) {
      const record = JSON.parse(key) as string[];
      if (record[0] === scope.tenantId && record[1] === scope.runtimeInstanceId
        && record[2] === scope.featureId && record[3] === scope.featureInstallationId
        && record[4] === scope.featureRevisionDigest) this.records.delete(key);
      else void credential;
    }
  }

  async deleteRuntimeInstance(scope: RestrictedAppConnectionInstanceScope): Promise<void> {
    this.deletedRuntimeInstances.push(structuredClone(scope));
    for (const key of this.records.keys()) {
      const record = JSON.parse(key) as string[];
      if (record[0] === scope.tenantId && record[1] === scope.runtimeInstanceId) this.records.delete(key);
    }
  }
}

class FlakyConnectionStore extends MemoryConnectionStore {
  failNextFeatureDelete = false;

  override async deleteFeature(scope: RestrictedAppConnectionFeatureScope): Promise<void> {
    if (this.failNextFeatureDelete) {
      this.failNextFeatureDelete = false;
      throw new Error("injected connection cleanup failure");
    }
    await super.deleteFeature(scope);
  }
}

class FlakyFileStorage extends FileRestrictedAppStorage {
  failNextDelete = false;

  override async deleteApp(owner: RestrictedAppStorageOwner): Promise<boolean> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("injected storage cleanup failure");
    }
    return await super.deleteApp(owner);
  }
}

async function writePackage(root: string, options: {
  packageName?: string;
  version?: string;
  appId?: string;
  appSource?: string;
  networkAuth?: unknown[];
} = {}): Promise<void> {
  const packageName = options.packageName ?? "connected-inbox";
  const version = options.version ?? "0.1.0";
  const appId = options.appId ?? "connected-inbox";
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: packageName,
    version,
    private: true,
    type: "module",
    agentApp: "agent-app.json",
  }), "utf8");
  await writeFile(join(root, "agent-app.json"), JSON.stringify({
    version: 2,
    id: appId,
    title: "Connected inbox",
    runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
    ui: { icon: "mail" },
    tools: [{
      name: "inbox_search",
      description: "Search the connected inbox.",
      action: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", maxLength: 500 } },
        required: ["query"],
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 0 } },
        required: ["count"],
        additionalProperties: false,
      },
    }],
    automations: [{
      id: refreshAutomation,
      title: "Refresh inbox",
      description: "Check for newly arrived messages.",
      handler: "refresh-inbox",
      trigger: { kind: "interval", intervalMinutes: 30 },
      permissions: { network: ["mail-api"], files: [], notifications: ["new-mail"] },
      catchUp: "latest",
      overlap: "skip",
    }, {
      id: exportAutomation,
      title: "Export digest",
      description: "Write a digest into the selected reports folder.",
      handler: "export-digest",
      trigger: { kind: "interval", intervalMinutes: 60 },
      permissions: { network: [], files: ["exports"], notifications: [] },
      catchUp: "none",
      overlap: "skip",
    }],
    permissions: {
      files: [{ id: "exports", target: "directory", access: "read-write" }],
      notifications: [{ id: "new-mail", title: "New mail", description: "New messages are ready." }],
      network: [{
        id: "mail-api",
        target: { kind: "public-https", origin: "https://mail.example.com" },
        methods: ["GET"],
        auth: options.networkAuth ?? [{ kind: "api-key", header: "x-api-key" }],
      }],
    },
  }), "utf8");
  await writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8");
  await writeFile(join(root, "app.js"), "export {};\n", "utf8");
  await writeFile(
    join(root, "worker.js"),
    options.appSource ?? "// This code must remain inert during review and installation.\nexport async function handleAction() { return { count: 0 }; }\nexport async function handleAutomation() {}\n",
    "utf8",
  );
}

function oauthClient(
  connections: MemoryConnectionStore,
  transport: RestrictedAppOAuthPublicHttpsTransport,
  now: Date,
): RestrictedAppOAuthPkceClient {
  return new RestrictedAppOAuthPkceClient({
    store: {
      encrypted: true,
      async get(binding): Promise<RestrictedAppOAuthConnection | undefined> {
        const credential = await connections.get(binding);
        return credential?.kind === "oauth2-pkce" ? credential : undefined;
      },
      async set(binding, connection): Promise<void> { await connections.set(binding, connection); },
      async delete(binding): Promise<boolean> { return await connections.delete(binding); },
    },
    transport,
    now: () => new Date(now.valueOf()),
    openExternal: async () => assert.fail("These tests must not open a browser."),
  });
}

function connectionKey(binding: RestrictedAppConnectionBinding): string {
  return JSON.stringify([
    binding.tenantId,
    binding.runtimeInstanceId,
    binding.featureId,
    binding.featureInstallationId,
    binding.featureRevisionDigest,
    binding.declarationId,
    binding.declarationDigest,
    binding.targetIdentity,
    binding.owner.kind,
    binding.owner.kind === "instance" ? binding.owner.runtimeInstanceId : binding.owner.principalId,
  ]);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function changedAuthorityFields(left: AuthorityStamp, right: AuthorityStamp): string[] {
  return (Object.keys(left) as Array<keyof AuthorityStamp>)
    .filter((field) => left[field] !== right[field])
    .sort();
}
