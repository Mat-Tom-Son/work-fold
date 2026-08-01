import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  RestrictedAppConnectionBinding,
  RestrictedAppConnectionFeatureScope,
  RestrictedAppConnectionInstanceScope,
  RestrictedAppConnectionStore,
  RestrictedAppCredential,
  RestrictedAppEffectAuthorizer,
} from "../src/local/agent/restricted-app-connections.js";
import { FileRestrictedAppStorage, type RestrictedAppStorageOwner } from "../src/local/agent/restricted-app-storage.js";
import { LocalAppReleaseStore } from "../src/local/agent/local-app-release-store.js";
import {
  RestrictedAppService,
  type RestrictedAppInstalled,
  type RestrictedAppRuntimeDescriptor,
  type RestrictedAppRuntimeHost,
} from "../src/local/agent/restricted-app-service.js";
import { RestrictedAppRegistryVersionUnsupportedError } from "../src/local/agent/restricted-app-registry-error.js";

const sourceSpace = "ws-local-app-studio-source";
const targetSpace = "ws-local-app-studio-target";
const featureId = "connected-inbox";
const refreshAutomation = "refresh-mail";

test("Local App Studio separates Project declaration, immutable Release review, durable install preparation, and activation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-release-"));
  const sourceRoot = join(sandbox, "source-space");
  const packageRoot = join(sourceRoot, "apps", "connected-inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(rootPath, "data"));
  const connections = new MemoryConnectionStore();
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(packageRoot, { marker: "release-one-reviewed-bytes" });
    service = await RestrictedAppService.create({
      rootPath,
      storage,
      connections,
      runtimeHost: new RecordingRuntimeHost(),
    });

    const presentation = {
      title: "Connected Inbox Studio",
      description: "A deliberately declared local App Project.",
      icon: "mail",
    } as const;
    const project = await service.declareLocalAppProject({ spaceId: sourceSpace, presentation });
    assert.deepEqual(project.presentation, presentation);
    assert.equal(project.spaceId, sourceSpace);

    const review = await service.inspect({ spaceId: sourceSpace, spaceRoot: sourceRoot, sourcePath: "apps/connected-inbox" });
    const preview = await service.install({
      spaceId: sourceSpace,
      spaceRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });
    assert.equal(preview.runtimeInstanceKind, "development");
    assert.equal(preview.releaseDigest, null);
    assert.equal(preview.projectId, project.projectId);

    const prepared = await service.prepareLocalAppRelease({ spaceId: sourceSpace, displayVersion: "1.0.0" });
    assert.equal(prepared.state, "prepared");
    assert.equal(prepared.publishedAt, null);
    assert.deepEqual(prepared.presentation, presentation);
    assert.deepEqual((await service.localAppStudio(sourceSpace)).releases, [prepared]);
    await assert.rejects(
      service.prepareLocalAppInstall({
        sourceSpaceId: sourceSpace,
        targetSpaceId: targetSpace,
        releaseDigest: prepared.releaseDigest,
      }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /published Release/i.test(errorMessage(error)),
      "preparation is not publication and must not make a Release installable",
    );

    await writeFile(join(packageRoot, "worker.js"), workerSource("unreviewed-source-after-prepare"), "utf8");
    const published = await service.publishLocalAppRelease({
      spaceId: sourceSpace,
      releaseDigest: prepared.releaseDigest,
    });
    assert.equal(published.state, "published");
    assert.ok(published.publishedAt);

    const firstPlan = await service.prepareLocalAppInstall({
      sourceSpaceId: sourceSpace,
      targetSpaceId: targetSpace,
      releaseDigest: published.releaseDigest,
    });
    const retryPlan = await service.prepareLocalAppInstall({
      sourceSpaceId: sourceSpace,
      targetSpaceId: targetSpace,
      releaseDigest: published.releaseDigest,
    });
    assert.deepEqual(retryPlan, firstPlan, "retries must return the durably reserved operation and identity allocations");
    assert.match(firstPlan.operationId, /^operation_/);
    assert.match(firstPlan.runtimeInstanceId, /^runtime-instance_/);
    assert.match(firstPlan.features[0]?.featureInstallationId ?? "", /^feature-installation_/);
    assert.match(firstPlan.features[0]?.dataNamespaceId ?? "", /^data-namespace_/);

    await service.close();
    service = undefined;
    service = await RestrictedAppService.create({
      rootPath,
      storage,
      connections,
      runtimeHost: new RecordingRuntimeHost(),
    });
    const recovered = await service.localAppStudio(sourceSpace);
    assert.deepEqual(recovered.project?.presentation, presentation);
    assert.deepEqual(recovered.operations, [firstPlan], "a prepared install must survive process restart without allocating replacement ids");

    const activated = await service.activateLocalAppInstall(firstPlan.operationId);
    assert.equal(activated.instance.runtimeInstanceId, firstPlan.runtimeInstanceId);
    assert.equal(activated.instance.spaceId, targetSpace);
    assert.equal(activated.instance.releaseDigest, published.releaseDigest);
    assert.equal(activated.apps.length, 1);
    const installed = activated.apps[0]!;
    assert.equal(installed.runtimeInstanceKind, "app");
    assert.equal(installed.releaseDigest, published.releaseDigest);
    assert.deepEqual(installed.networkGrants, []);
    assert.deepEqual(installed.fileGrants, []);
    assert.deepEqual(installed.notificationGrants, []);
    assert.ok(installed.automations.length > 0);
    assert.equal(installed.automations.every((automation) => !automation.enabled), true);
    assert.deepEqual(await service.connectionStatus(targetSpace, featureId, installed.digest), [{
      destinationId: "mail-api",
      owner: "instance",
      kind: null,
      configured: false,
    }], "installation must not silently configure a declared connection");

    const descriptor = await service.runtimeDescriptor(targetSpace, featureId, installed.digest);
    const releasedWorker = await readFile(join(descriptor.stagedRoot, "worker.js"), "utf8");
    assert.match(releasedWorker, /release-one-reviewed-bytes/);
    assert.doesNotMatch(releasedWorker, /unreviewed-source-after-prepare/,
      "activation must materialize the prepared Release closure, never current source files");

    const development = (await service.list(sourceSpace))[0]!;
    assert.equal(development.runtimeInstanceKind, "development");
    assert.equal(development.projectId, installed.projectId);
    assert.notEqual(development.runtimeInstanceId, installed.runtimeInstanceId);
    assert.notEqual(development.featureInstallationId, installed.featureInstallationId);
    assert.notEqual(development.dataNamespaceId, installed.dataNamespaceId);
    await storage.set(storageOwner(development), "shared-key", "development-value");
    await storage.set(storageOwner(installed), "shared-key", "installed-value");
    assert.equal(await storage.get(storageOwner(development), "shared-key"), "development-value");
    assert.equal(await storage.get(storageOwner(installed), "shared-key"), "installed-value");
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("removing a target Space cancels a prepared install even before an App Instance exists", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-remove-target-"));
  const sourceRoot = join(sandbox, "source-space");
  const packageRoot = join(sourceRoot, "apps", "connected-inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(packageRoot, { marker: "prepared-target-removal" });
    service = await RestrictedAppService.create({ rootPath });
    await service.declareLocalAppProject({
      spaceId: sourceSpace,
      presentation: { title: "Connected Inbox", description: null, icon: "mail" },
    });
    const review = await service.inspect({
      spaceId: sourceSpace,
      spaceRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
    });
    await service.install({
      spaceId: sourceSpace,
      spaceRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });
    const release = await prepareAndPublish(service, "1.0.0");
    const operation = await service.prepareLocalAppInstall({
      sourceSpaceId: sourceSpace,
      targetSpaceId: targetSpace,
      releaseDigest: release.releaseDigest,
    });
    assert.deepEqual((await service.localAppStudio(sourceSpace)).operations, [operation]);
    assert.deepEqual(await service.spaceRemovalMutationSpaceIds(sourceSpace), [sourceSpace, targetSpace]);
    assert.deepEqual(await service.spaceRemovalMutationSpaceIds(targetSpace), [sourceSpace, targetSpace]);
    assert.deepEqual(await service.spaceRemovalImpact(targetSpace), {
      activeSourceInstanceCount: 0,
      activeTargetInstanceCount: 0,
      retainedDataCount: 0,
      incomingPreparedOperationCount: 1,
    });

    await service.removeSpace(targetSpace);

    assert.deepEqual((await service.localAppStudio(sourceSpace)).operations, []);
    await assert.rejects(
      service.activateLocalAppInstall(operation.operationId),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /no longer available/i.test(errorMessage(error)),
    );
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Release deletion prunes only unused objects and preserves every active, prepared, or retained obligation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-release-delete-"));
  const sourceRoot = join(sandbox, "source-space");
  const packageRoot = join(sourceRoot, "apps", "connected-inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(rootPath, "data"));
  const connections = new MemoryConnectionStore();
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(packageRoot, { marker: "release-deletion" });
    service = await RestrictedAppService.create({ rootPath, storage, connections });
    await service.declareLocalAppProject({
      spaceId: sourceSpace,
      presentation: { title: "Connected Inbox", description: "Release deletion fixture.", icon: "mail" },
    });
    const review = await service.inspect({
      spaceId: sourceSpace,
      spaceRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
    });
    await service.install({
      spaceId: sourceSpace,
      spaceRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });

    const unusedPrepared = await service.prepareLocalAppRelease({ spaceId: sourceSpace, displayVersion: "0.9.0" });
    const unusedPath = releaseObjectPath(rootPath, unusedPrepared.releaseDigest);
    assert.deepEqual(await service.deleteLocalAppRelease({
      spaceId: sourceSpace,
      releaseDigest: unusedPrepared.releaseDigest,
    }), { deleted: true, cleanupPending: false });
    await assert.rejects(access(unusedPath), (error: unknown) => isMissingError(error));
    assert.deepEqual(await service.deleteLocalAppRelease({
      spaceId: sourceSpace,
      releaseDigest: unusedPrepared.releaseDigest,
    }), { deleted: false, cleanupPending: false }, "deletion retries are idempotent");

    await service.close();
    service = undefined;
    service = await RestrictedAppService.create({ rootPath, storage, connections });

    const activeRelease = await prepareAndPublish(service, "1.0.0");
    const install = await service.prepareLocalAppInstall({
      sourceSpaceId: sourceSpace,
      targetSpaceId: targetSpace,
      releaseDigest: activeRelease.releaseDigest,
    });
    await assert.rejects(
      service.deleteLocalAppRelease({ spaceId: sourceSpace, releaseDigest: activeRelease.releaseDigest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /Cancel every prepared install/i.test(errorMessage(error)),
    );
    await service.cancelLocalAppOperation(install.operationId);

    const activeInstall = await service.prepareLocalAppInstall({
      sourceSpaceId: sourceSpace,
      targetSpaceId: targetSpace,
      releaseDigest: activeRelease.releaseDigest,
    });
    const installed = (await service.activateLocalAppInstall(activeInstall.operationId)).apps[0]!;
    await assert.rejects(
      service.deleteLocalAppRelease({ spaceId: sourceSpace, releaseDigest: activeRelease.releaseDigest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /Uninstall every App Instance/i.test(errorMessage(error)),
    );

    const updateTarget = await prepareAndPublish(service, "2.0.0");
    const update = await service.prepareLocalAppUpdate({
      sourceSpaceId: sourceSpace,
      runtimeInstanceId: installed.runtimeInstanceId,
      releaseDigest: updateTarget.releaseDigest,
    });
    await assert.rejects(
      service.deleteLocalAppRelease({ spaceId: sourceSpace, releaseDigest: updateTarget.releaseDigest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /Cancel every prepared install/i.test(errorMessage(error)),
      "the prepared operation's target Release must remain closed",
    );
    await assert.rejects(
      service.deleteLocalAppRelease({ spaceId: sourceSpace, releaseDigest: activeRelease.releaseDigest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID"
        && /Uninstall every App Instance/i.test(errorMessage(error))
        && /Cancel every prepared install/i.test(errorMessage(error)),
      "the prepared operation's source Release must remain closed",
    );
    await service.cancelLocalAppOperation(update.operationId);
    assert.deepEqual(await service.deleteLocalAppRelease({
      spaceId: sourceSpace,
      releaseDigest: updateTarget.releaseDigest,
    }), { deleted: true, cleanupPending: false });

    const uninstalled = await service.uninstallLocalApp({
      runtimeInstanceId: installed.runtimeInstanceId,
      dataDisposition: "retain",
    });
    await assert.rejects(
      service.deleteLocalAppRelease({ spaceId: sourceSpace, releaseDigest: activeRelease.releaseDigest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /Purge the retained App data/i.test(errorMessage(error)),
    );
    await service.purgeLocalAppRetainedData(uninstalled.retainedData[0]!.retainedDataId);
    assert.deepEqual(await service.deleteLocalAppRelease({
      spaceId: sourceSpace,
      releaseDigest: activeRelease.releaseDigest,
    }), { deleted: true, cleanupPending: false });
    assert.deepEqual((await service.localAppStudio(sourceSpace)).releases, []);
    assert.deepEqual(await readdir(join(rootPath, "releases")), []);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a retryable Release prune remains pending across restart without blocking service startup", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-release-prune-retry-"));
  const sourceRoot = join(sandbox, "source-space");
  const packageRoot = join(sourceRoot, "apps", "connected-inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  let blockPruning = false;
  const releaseStore = new LocalAppReleaseStore(join(rootPath, "releases"), {
    pruneIo: {
      async unlink(path) {
        if (blockPruning) {
          throw Object.assign(new Error("simulated Windows Release lock"), { code: "EBUSY" });
        }
        await unlink(path);
      },
    },
  });
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(packageRoot, { marker: "restart-safe-prune" });
    service = await RestrictedAppService.create({ rootPath, releaseStore });
    await service.declareLocalAppProject({
      spaceId: sourceSpace,
      presentation: { title: "Connected Inbox", description: "Prune retry fixture.", icon: "mail" },
    });
    const review = await service.inspect({
      spaceId: sourceSpace,
      spaceRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
    });
    await service.install({
      spaceId: sourceSpace,
      spaceRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });
    const release = await service.prepareLocalAppRelease({ spaceId: sourceSpace, displayVersion: "0.9.0" });
    const objectPath = releaseObjectPath(rootPath, release.releaseDigest);

    blockPruning = true;
    assert.deepEqual(await service.deleteLocalAppRelease({
      spaceId: sourceSpace,
      releaseDigest: release.releaseDigest,
    }), { deleted: true, cleanupPending: true });
    assert.equal(await access(objectPath).then(() => true), true);
    await service.close();
    service = undefined;

    service = await RestrictedAppService.create({ rootPath, releaseStore });
    assert.deepEqual((await service.localAppStudio(sourceSpace)).releases, [],
      "the committed registry deletion remains authoritative while bytes await pruning");
    assert.deepEqual(await service.deleteLocalAppRelease({
      spaceId: sourceSpace,
      releaseDigest: release.releaseDigest,
    }), { deleted: false, cleanupPending: true });

    blockPruning = false;
    assert.deepEqual(await service.deleteLocalAppRelease({
      spaceId: sourceSpace,
      releaseDigest: release.releaseDigest,
    }), { deleted: false, cleanupPending: false });
    await assert.rejects(access(objectPath), (error: unknown) => isMissingError(error));
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("startup consumes the Release store's single verified reconciliation projection without rereading closures", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-release-startup-"));
  const sourceRoot = join(sandbox, "source-space");
  const packageRoot = join(sourceRoot, "apps", "connected-inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const releaseStore = new CountingReleaseStore(join(rootPath, "releases"));
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(packageRoot, { marker: "single-startup-verification" });
    service = await RestrictedAppService.create({ rootPath, releaseStore });
    const review = await service.inspect({
      spaceId: sourceSpace,
      spaceRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
    });
    await service.install({
      spaceId: sourceSpace,
      spaceRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });
    await prepareAndPublish(service, "1.0.0");
    await service.close();
    service = undefined;
    releaseStore.readCalls = 0;

    service = await RestrictedAppService.create({ rootPath, releaseStore });

    assert.equal(releaseStore.readCalls, 0,
      "reconciliation's verified projection must replace a redundant startup read of each full Release");
    assert.equal((await service.localAppStudio(sourceSpace)).releases.length, 1);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Local App updates preserve only exact continuity, reset every power on revision change, roll back, and retain data explicitly", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-update-"));
  const sourceRoot = join(sandbox, "source-space");
  const targetRoot = join(sandbox, "target-space");
  const packageRoot = join(sourceRoot, "apps", "connected-inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(rootPath, "data"));
  const connections = new MemoryConnectionStore();
  const runtimeHost = new RecordingRuntimeHost();
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(packageRoot, { marker: "original-revision" });
    await mkdir(join(targetRoot, "exports"), { recursive: true });
    service = await RestrictedAppService.create({ rootPath, storage, connections, runtimeHost });
    await service.declareLocalAppProject({
      spaceId: sourceSpace,
      presentation: { title: "Connected Inbox", description: "Update continuity fixture.", icon: "mail" },
    });
    const previewReview = await service.inspect({ spaceId: sourceSpace, spaceRoot: sourceRoot, sourcePath: "apps/connected-inbox" });
    await service.install({
      spaceId: sourceSpace,
      spaceRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: previewReview.digest,
    });
    const firstRelease = await prepareAndPublish(service, "1.0.0");
    const installPlan = await service.prepareLocalAppInstall({
      sourceSpaceId: sourceSpace,
      targetSpaceId: targetSpace,
      releaseDigest: firstRelease.releaseDigest,
    });
    const firstInstalled = (await service.activateLocalAppInstall(installPlan.operationId)).apps[0]!;
    const originalIds = {
      runtimeInstanceId: firstInstalled.runtimeInstanceId,
      featureInstallationId: firstInstalled.featureInstallationId,
      dataNamespaceId: firstInstalled.dataNamespaceId,
    };

    await service.grantNetwork({
      spaceId: targetSpace,
      appId: featureId,
      expectedDigest: firstInstalled.digest,
      destinationId: "mail-api",
    });
    await service.grantFiles({
      spaceId: targetSpace,
      spaceRoot: targetRoot,
      appId: featureId,
      expectedDigest: firstInstalled.digest,
      permissionId: "exports",
      root: "exports",
    });
    await service.grantNotifications({
      spaceId: targetSpace,
      appId: featureId,
      expectedDigest: firstInstalled.digest,
      permissionId: "new-mail",
    });
    await service.setConnection({
      spaceId: targetSpace,
      appId: featureId,
      expectedDigest: firstInstalled.digest,
      destinationId: "mail-api",
      credential: { kind: "api-key", value: "local-test-secret" },
    });
    await service.setAutomationEnabled({
      spaceId: targetSpace,
      appId: featureId,
      expectedDigest: firstInstalled.digest,
      automationId: refreshAutomation,
      enabled: true,
    });
    await storage.set(storageOwner(firstInstalled), "durable", { count: 7 });

    const exactRelease = await prepareAndPublish(service, "1.0.1");
    const exactUpdate = await service.prepareLocalAppUpdate({
      sourceSpaceId: sourceSpace,
      runtimeInstanceId: firstInstalled.runtimeInstanceId,
      releaseDigest: exactRelease.releaseDigest,
    });
    assert.equal(exactUpdate.plan.canCommit, true);
    assert.equal(exactUpdate.plan.transitions[0]?.action, "keep");
    assert.deepEqual(exactUpdate.plan.transitions[0]?.resets, []);
    assert.deepEqual(exactUpdate.plan.transitions[0]?.continuity, {
      grants: ["file:exports", "network:mail-api", "notification:new-mail"],
      connections: ["mail-api"],
      enabledJobs: [refreshAutomation],
    });
    await assert.rejects(
      service.prepareLocalAppUpdate({
        sourceSpaceId: sourceSpace,
        runtimeInstanceId: firstInstalled.runtimeInstanceId,
        releaseDigest: exactRelease.releaseDigest,
        continuityPolicy: "reset",
      }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /different access policy/i.test(errorMessage(error)),
      "idempotent update preparation must not silently replace the person's authority-continuity choice",
    );
    const exactActivated = (await service.activateLocalAppUpdate(exactUpdate.operationId)).apps[0]!;
    assert.deepEqual(ids(exactActivated), originalIds);
    assert.deepEqual(exactActivated.networkGrants, ["mail-api"]);
    assert.deepEqual(exactActivated.fileGrants.map((grant) => grant.declarationId), ["exports"]);
    assert.deepEqual(exactActivated.notificationGrants, ["new-mail"]);
    assert.equal(exactActivated.automations.find((item) => item.id === refreshAutomation)?.enabled, true);
    assert.equal((await service.connectionStatus(targetSpace, featureId, exactActivated.digest))[0]?.configured, true);
    assert.deepEqual(await storage.get(storageOwner(exactActivated), "durable"), { count: 7 });

    const resetRelease = await prepareAndPublish(service, "1.0.2");
    const resetUpdate = await service.prepareLocalAppUpdate({
      sourceSpaceId: sourceSpace,
      runtimeInstanceId: exactActivated.runtimeInstanceId,
      releaseDigest: resetRelease.releaseDigest,
      continuityPolicy: "reset",
    });
    assert.equal(resetUpdate.plan.transitions[0]?.action, "keep");
    assert.deepEqual(resetUpdate.plan.transitions[0]?.resets, ["grants", "connections", "jobs"]);
    const resetActivated = (await service.activateLocalAppUpdate(resetUpdate.operationId)).apps[0]!;
    assert.deepEqual(ids(resetActivated), originalIds, "an explicit authority reset keeps the Feature and data incarnation");
    assert.deepEqual(resetActivated.networkGrants, []);
    assert.deepEqual(resetActivated.fileGrants, []);
    assert.deepEqual(resetActivated.notificationGrants, []);
    assert.equal(resetActivated.automations.every((automation) => !automation.enabled), true);
    assert.equal((await service.connectionStatus(targetSpace, featureId, resetActivated.digest))[0]?.configured, false,
      "an exact-revision reset must synchronously revoke the predecessor connection");
    assert.deepEqual(await storage.get(storageOwner(resetActivated), "durable"), { count: 7 });
    await service.grantNetwork({
      spaceId: targetSpace,
      appId: featureId,
      expectedDigest: resetActivated.digest,
      destinationId: "mail-api",
    });
    await service.setConnection({
      spaceId: targetSpace,
      appId: featureId,
      expectedDigest: resetActivated.digest,
      destinationId: "mail-api",
      credential: { kind: "api-key", value: "replacement-test-secret" },
    });
    await service.setAutomationEnabled({
      spaceId: targetSpace,
      appId: featureId,
      expectedDigest: resetActivated.digest,
      automationId: refreshAutomation,
      enabled: true,
    });

    const staleRelease = await service.prepareLocalAppRelease({ spaceId: sourceSpace, displayVersion: "1.1.0" });
    await writePackage(packageRoot, { version: "0.2.0", marker: "changed-revision" });
    const changedReview = await service.inspect({ spaceId: sourceSpace, spaceRoot: sourceRoot, sourcePath: "apps/connected-inbox" });
    await service.install({
      spaceId: sourceSpace,
      spaceRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: changedReview.digest,
    });
    await assert.rejects(
      service.publishLocalAppRelease({ spaceId: sourceSpace, releaseDigest: staleRelease.releaseDigest }),
      (error: unknown) => errorCode(error) === "REVISION_CHANGED" && /changed after this Release was prepared/i.test(errorMessage(error)),
      "publishing must revalidate the reviewed Development Instance stamp",
    );

    const changedRelease = await prepareAndPublish(service, "2.0.0");
    const changedUpdate = await service.prepareLocalAppUpdate({
      sourceSpaceId: sourceSpace,
      runtimeInstanceId: firstInstalled.runtimeInstanceId,
      releaseDigest: changedRelease.releaseDigest,
    });
    assert.equal(changedUpdate.plan.canCommit, true);
    assert.equal(changedUpdate.plan.transitions[0]?.action, "update");
    assert.equal(changedUpdate.plan.transitions[0]?.data, "retain");
    assert.deepEqual(changedUpdate.plan.transitions[0]?.resets, ["grants", "connections", "jobs"]);
    const changedActivated = (await service.activateLocalAppUpdate(changedUpdate.operationId)).apps[0]!;
    assert.deepEqual(ids(changedActivated), originalIds, "a revision switch keeps the Feature incarnation and data lineage");
    assert.deepEqual(changedActivated.networkGrants, []);
    assert.deepEqual(changedActivated.fileGrants, []);
    assert.deepEqual(changedActivated.notificationGrants, []);
    assert.equal(changedActivated.automations.every((automation) => !automation.enabled), true);
    assert.equal((await service.connectionStatus(targetSpace, featureId, changedActivated.digest))[0]?.configured, false);
    assert.deepEqual(await storage.get(storageOwner(changedActivated), "durable"), { count: 7 },
      "code revision must not imply a data namespace reset");

    const rollbackPlan = await service.prepareLocalAppUpdate({
      sourceSpaceId: sourceSpace,
      runtimeInstanceId: changedActivated.runtimeInstanceId,
      releaseDigest: exactRelease.releaseDigest,
    });
    assert.equal(rollbackPlan.plan.toReleaseDigest, exactRelease.releaseDigest);
    assert.equal(rollbackPlan.plan.transitions[0]?.action, "update");
    const rolledBack = (await service.activateLocalAppUpdate(rollbackPlan.operationId)).apps[0]!;
    assert.equal(rolledBack.releaseDigest, exactRelease.releaseDigest);
    assert.equal(rolledBack.digest, exactActivated.digest);
    assert.deepEqual(ids(rolledBack), originalIds);
    assert.deepEqual(await storage.get(storageOwner(rolledBack), "durable"), { count: 7 });

    await assert.rejects(
      service.remove({ spaceId: targetSpace, appId: featureId, expectedDigest: rolledBack.digest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /App Studio/i.test(errorMessage(error)),
      "a Feature-level remove must not bypass App Instance data disposition",
    );
    await assert.rejects(
      service.removeSpace(targetSpace),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /Uninstall release-backed Apps/i.test(errorMessage(error)),
      "Space removal must not implicitly delete an attached App Instance",
    );

    const uninstalled = await service.uninstallLocalApp({
      runtimeInstanceId: rolledBack.runtimeInstanceId,
      dataDisposition: "retain",
    });
    assert.equal(uninstalled.removed, true);
    assert.equal(uninstalled.retainedData.length, 1);
    assert.equal(uninstalled.retainedData[0]?.dataNamespaceId, originalIds.dataNamespaceId);
    assert.deepEqual(await service.list(targetSpace), []);
    assert.deepEqual(await storage.get(storageOwner(rolledBack), "durable"), { count: 7 });
    assert.equal((await service.localAppStudio(sourceSpace)).retainedData.length, 1);

    const purged = await service.purgeLocalAppRetainedData(uninstalled.retainedData[0]!.retainedDataId);
    assert.equal(purged.purged, true);
    assert.equal(purged.cleanupPending, false);
    assert.equal((await storage.usage(storageOwner(rolledBack))).keyCount, 0);
    assert.deepEqual((await service.localAppStudio(sourceSpace)).retainedData, []);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Restricted app registry rejects v3 without importing or rewriting it", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-v3-"));
  const rootPath = join(sandbox, "state", "restricted-apps");
  const registryPath = join(rootPath, "registry.json");
  const oldRegistry = `${JSON.stringify({ schemaVersion: 3, projects: [] }, null, 2)}\n`;
  try {
    await mkdir(rootPath, { recursive: true });
    await writeFile(registryPath, oldRegistry, "utf8");
    await assert.rejects(
      RestrictedAppService.create({ rootPath }),
      (error) => error instanceof RestrictedAppRegistryVersionUnsupportedError
        && error.actualVersion === 3
        && error.supportedVersion === 5,
    );
    assert.equal(await readFile(registryPath, "utf8"), oldRegistry);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function prepareAndPublish(service: RestrictedAppService, displayVersion: string) {
  const prepared = await service.prepareLocalAppRelease({ spaceId: sourceSpace, displayVersion });
  return await service.publishLocalAppRelease({
    spaceId: sourceSpace,
    releaseDigest: prepared.releaseDigest,
  });
}

function ids(app: RestrictedAppInstalled) {
  return {
    runtimeInstanceId: app.runtimeInstanceId,
    featureInstallationId: app.featureInstallationId,
    dataNamespaceId: app.dataNamespaceId,
  };
}

function storageOwner(app: RestrictedAppInstalled): RestrictedAppStorageOwner {
  return {
    ownerClass: "instance",
    tenantId: app.tenantId,
    runtimeInstanceId: app.runtimeInstanceId,
    featureInstallationId: app.featureInstallationId,
    dataNamespaceId: app.dataNamespaceId,
  };
}

class RecordingRuntimeHost implements RestrictedAppRuntimeHost {
  readonly stops: Array<{ spaceId: string; appId: string; digest?: string }> = [];
  async invoke(_app: RestrictedAppRuntimeDescriptor, _action: string, _input: unknown): Promise<unknown> { return {}; }
  async runAutomation(): Promise<void> {}
  async stop(spaceId: string, appId: string, digest?: string): Promise<void> {
    this.stops.push({ spaceId, appId, ...(digest ? { digest } : {}) });
  }
  async close(): Promise<void> {}
}

class CountingReleaseStore extends LocalAppReleaseStore {
  readCalls = 0;

  override async read(digestValue: unknown) {
    this.readCalls += 1;
    return await super.read(digestValue);
  }
}

class MemoryConnectionStore implements RestrictedAppConnectionStore {
  readonly records = new Map<string, {
    binding: RestrictedAppConnectionBinding;
    credential: RestrictedAppCredential;
  }>();

  async get(binding: RestrictedAppConnectionBinding): Promise<RestrictedAppCredential | undefined> {
    return structuredClone(this.records.get(connectionKey(binding))?.credential);
  }

  async set(
    binding: RestrictedAppConnectionBinding,
    credential: RestrictedAppCredential,
    authorizeCommit?: RestrictedAppEffectAuthorizer,
  ): Promise<void> {
    await authorizeCommit?.();
    this.records.set(connectionKey(binding), {
      binding: structuredClone(binding),
      credential: structuredClone(credential),
    });
  }

  async delete(binding: RestrictedAppConnectionBinding, authorizeCommit?: RestrictedAppEffectAuthorizer): Promise<boolean> {
    await authorizeCommit?.();
    return this.records.delete(connectionKey(binding));
  }

  async deleteFeature(scope: RestrictedAppConnectionFeatureScope): Promise<void> {
    for (const [key, record] of this.records) {
      const binding = record.binding;
      if (binding.tenantId === scope.tenantId
        && binding.runtimeInstanceId === scope.runtimeInstanceId
        && binding.featureId === scope.featureId
        && binding.featureInstallationId === scope.featureInstallationId
        && binding.featureRevisionDigest === scope.featureRevisionDigest) this.records.delete(key);
    }
  }

  async deleteRuntimeInstance(scope: RestrictedAppConnectionInstanceScope): Promise<void> {
    for (const [key, record] of this.records) {
      if (record.binding.tenantId === scope.tenantId
        && record.binding.runtimeInstanceId === scope.runtimeInstanceId) this.records.delete(key);
    }
  }
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

async function writePackage(root: string, options: { version?: string; marker: string }): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: featureId,
    version: options.version ?? "0.1.0",
    private: true,
    type: "module",
    agentApp: "agent-app.json",
  }), "utf8");
  await writeFile(join(root, "agent-app.json"), JSON.stringify({
    version: 2,
    id: featureId,
    title: "Connected inbox",
    description: "Search and automate a deliberately restricted inbox.",
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
      permissions: { network: ["mail-api"], files: ["exports"], notifications: ["new-mail"] },
      catchUp: "latest",
      overlap: "skip",
    }],
    permissions: {
      files: [{ id: "exports", target: "directory", access: "read-write" }],
      notifications: [{ id: "new-mail", title: "New mail", description: "New messages are ready." }],
      network: [{
        id: "mail-api",
        target: { kind: "public-https", origin: "https://mail.example.com" },
        methods: ["GET"],
        auth: [{ kind: "api-key", header: "x-api-key" }],
      }],
    },
  }), "utf8");
  await writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8");
  await writeFile(join(root, "app.js"), "export {};\n", "utf8");
  await writeFile(join(root, "worker.js"), workerSource(options.marker), "utf8");
}

function workerSource(marker: string): string {
  return `// ${marker}\nexport async function handleAction() { return { count: 0 }; }\nexport async function handleAutomation() {}\n`;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function releaseObjectPath(rootPath: string, digest: string): string {
  return join(rootPath, "releases", digest.slice("sha256:".length));
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
