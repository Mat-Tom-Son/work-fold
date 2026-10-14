import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
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
  type LocalAppWorkFolderRecoveryCopy,
  type RestrictedAppInstalled,
  type RestrictedAppRuntimeDescriptor,
  type RestrictedAppRuntimeHost,
} from "../src/local/agent/restricted-app-service.js";
import { RestrictedAppRegistryVersionUnsupportedError } from "../src/local/agent/restricted-app-registry-error.js";

const sourceWorkFolder = "ws-local-app-studio-source";
const targetWorkFolder = "ws-local-app-studio-target";
const featureId = "connected-inbox";
const refreshAppAutomation = "refresh-mail";

test("Local App Studio separates Project declaration, immutable Release review, durable install preparation, and activation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-release-"));
  const sourceRoot = join(sandbox, "source-work-folder");
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
    const project = await service.declareLocalAppProject({ workFolderId: sourceWorkFolder, presentation });
    assert.deepEqual(project.presentation, presentation);
    assert.equal(project.workFolderId, sourceWorkFolder);

    const review = await service.inspect({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox" });
    const preview = await service.install({
      workFolderId: sourceWorkFolder,
      workFolderRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });
    assert.equal(preview.runtimeInstanceKind, "development");
    assert.equal(preview.releaseDigest, null);
    assert.equal(preview.projectId, project.projectId);

    const prepared = await service.prepareLocalAppRelease({ workFolderId: sourceWorkFolder, displayVersion: "1.0.0" });
    assert.equal(prepared.state, "prepared");
    assert.equal(prepared.publishedAt, null);
    assert.deepEqual(prepared.presentation, presentation);
    assert.deepEqual((await service.localAppStudio(sourceWorkFolder)).releases, [prepared]);
    await assert.rejects(
      service.prepareLocalAppInstall({
        sourceWorkFolderId: sourceWorkFolder,
        targetWorkFolderId: targetWorkFolder,
        releaseDigest: prepared.releaseDigest,
      }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /published Release/i.test(errorMessage(error)),
      "preparation is not publication and must not make a Release installable",
    );

    await writeFile(join(packageRoot, "worker.js"), workerSource("unreviewed-source-after-prepare"), "utf8");
    const published = await service.publishLocalAppRelease({
      workFolderId: sourceWorkFolder,
      releaseDigest: prepared.releaseDigest,
    });
    assert.equal(published.state, "published");
    assert.ok(published.publishedAt);

    const firstPlan = await service.prepareLocalAppInstall({
      sourceWorkFolderId: sourceWorkFolder,
      targetWorkFolderId: targetWorkFolder,
      releaseDigest: published.releaseDigest,
    });
    const retryPlan = await service.prepareLocalAppInstall({
      sourceWorkFolderId: sourceWorkFolder,
      targetWorkFolderId: targetWorkFolder,
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
    const recovered = await service.localAppStudio(sourceWorkFolder);
    assert.deepEqual(recovered.project?.presentation, presentation);
    assert.deepEqual(recovered.operations, [firstPlan], "a prepared install must survive process restart without allocating replacement ids");

    const activated = await service.activateLocalAppInstall(firstPlan.operationId);
    assert.equal(activated.instance.runtimeInstanceId, firstPlan.runtimeInstanceId);
    assert.equal(activated.instance.workFolderId, targetWorkFolder);
    assert.equal(activated.instance.releaseDigest, published.releaseDigest);
    assert.equal(activated.apps.length, 1);
    const installed = activated.apps[0]!;
    assert.equal(installed.runtimeInstanceKind, "app");
    assert.equal(installed.releaseDigest, published.releaseDigest);
    // An installed Feature comes up able to work (docs/receipts-not-gates.md, F21).
    assert.deepEqual(installed.networkGrants, ["mail-api"]);
    assert.deepEqual(installed.fileGrants, [{ id: "exports", declarationId: "exports", root: ".", access: "read-write" }], "a directory permission binds to the whole work-folder");
    assert.deepEqual(installed.notificationGrants, ["new-mail"]);
    assert.ok(installed.automations.length > 0);
    assert.equal(installed.automations.every((automation) => automation.enabled), true, "every declared automation is on");
    assert.deepEqual(await service.connectionStatus(targetWorkFolder, featureId, installed.digest), [{
      destinationId: "mail-api",
      owner: "instance",
      kind: null,
      configured: false,
    }], "installation must not silently configure a declared connection");

    const descriptor = await service.runtimeDescriptor(targetWorkFolder, featureId, installed.digest);
    const releasedWorker = await readFile(join(descriptor.stagedRoot, "worker.js"), "utf8");
    assert.match(releasedWorker, /release-one-reviewed-bytes/);
    assert.doesNotMatch(releasedWorker, /unreviewed-source-after-prepare/,
      "activation must materialize the prepared Release closure, never current source files");

    const development = (await service.list(sourceWorkFolder))[0]!;
    assert.equal(development.runtimeInstanceKind, "development");
    assert.equal(development.projectId, installed.projectId);
    assert.notEqual(development.runtimeInstanceId, installed.runtimeInstanceId);
    assert.notEqual(development.featureInstallationId, installed.featureInstallationId);
    assert.notEqual(development.dataNamespaceId, installed.dataNamespaceId);
    await storage.set(storageOwner(development), "shared-key", "development-value");
    await storage.set(storageOwner(installed), "shared-key", "installed-value");
    assert.equal(await storage.get(storageOwner(development), "shared-key"), "development-value");
    assert.equal(await storage.get(storageOwner(installed), "shared-key"), "installed-value");
    const editable = await service.snapshotForChange(targetWorkFolder, featureId, installed.digest);
    assert.equal(editable.app.sourceWorkFolderId, sourceWorkFolder);
    assert.equal(editable.app.workFolderId, targetWorkFolder);
    assert.equal(editable.previewBase?.featureInstallationId, development.featureInstallationId);
    assert.match(Buffer.from(editable.files.get("worker.js")!).toString(), /release-one-reviewed-bytes/);
    assert.ok([...editable.files.keys()].every((path) => !/storage|conversations|shared-key/.test(path)));
    const laterReview = await service.inspect({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox" });
    await service.install({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox", expectedDigest: laterReview.digest });
    await assert.rejects(service.snapshotForChange(targetWorkFolder, featureId, installed.digest), /different Local preview/);
    await service.remove({ workFolderId: sourceWorkFolder, appId: featureId, expectedDigest: laterReview.digest });
    const absentPreview = await service.snapshotForChange(targetWorkFolder, featureId, installed.digest);
    assert.equal(absentPreview.previewBase, null);
    const replaceAbsent = { workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox", expectedDigest: laterReview.digest, expectedPreviewBase: absentPreview.previewBase };
    await service.install(replaceAbsent);
    await assert.rejects(service.install(replaceAbsent), /Local preview changed/, "an absent predecessor must not silently replace a later install, even with identical bytes");
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("removing a target work-folder cancels a prepared install even before an App Instance exists", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-remove-target-"));
  const sourceRoot = join(sandbox, "source-work-folder");
  const packageRoot = join(sourceRoot, "apps", "connected-inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(packageRoot, { marker: "prepared-target-removal" });
    service = await RestrictedAppService.create({ rootPath });
    await service.declareLocalAppProject({
      workFolderId: sourceWorkFolder,
      presentation: { title: "Connected Inbox", description: null, icon: "mail" },
    });
    const review = await service.inspect({
      workFolderId: sourceWorkFolder,
      workFolderRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
    });
    await service.install({
      workFolderId: sourceWorkFolder,
      workFolderRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });
    const release = await prepareAndPublish(service, "1.0.0");
    const operation = await service.prepareLocalAppInstall({
      sourceWorkFolderId: sourceWorkFolder,
      targetWorkFolderId: targetWorkFolder,
      releaseDigest: release.releaseDigest,
    });
    assert.deepEqual((await service.localAppStudio(sourceWorkFolder)).operations, [operation]);
    assert.deepEqual(await service.workFolderRemovalMutationWorkFolderIds(sourceWorkFolder), [sourceWorkFolder, targetWorkFolder]);
    assert.deepEqual(await service.workFolderRemovalMutationWorkFolderIds(targetWorkFolder), [sourceWorkFolder, targetWorkFolder]);
    assert.deepEqual(await service.workFolderRemovalImpact(targetWorkFolder), {
      activeSourceInstanceCount: 0,
      activeTargetInstanceCount: 0,
      retainedDataCount: 0,
      incomingPreparedOperationCount: 1,
    });

    await service.removeWorkFolder(targetWorkFolder);

    assert.deepEqual((await service.localAppStudio(sourceWorkFolder)).operations, []);
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
  const sourceRoot = join(sandbox, "source-work-folder");
  const packageRoot = join(sourceRoot, "apps", "connected-inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(rootPath, "data"));
  const connections = new MemoryConnectionStore();
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(packageRoot, { marker: "release-deletion" });
    service = await RestrictedAppService.create({ rootPath, storage, connections });
    await service.declareLocalAppProject({
      workFolderId: sourceWorkFolder,
      presentation: { title: "Connected Inbox", description: "Release deletion fixture.", icon: "mail" },
    });
    const review = await service.inspect({
      workFolderId: sourceWorkFolder,
      workFolderRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
    });
    await service.install({
      workFolderId: sourceWorkFolder,
      workFolderRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });

    const unusedPrepared = await service.prepareLocalAppRelease({ workFolderId: sourceWorkFolder, displayVersion: "0.9.0" });
    const unusedPath = releaseObjectPath(rootPath, unusedPrepared.releaseDigest);
    assert.deepEqual(await service.deleteLocalAppRelease({
      workFolderId: sourceWorkFolder,
      releaseDigest: unusedPrepared.releaseDigest,
    }), { deleted: true, cleanupPending: false });
    await assert.rejects(access(unusedPath), (error: unknown) => isMissingError(error));
    assert.deepEqual(await service.deleteLocalAppRelease({
      workFolderId: sourceWorkFolder,
      releaseDigest: unusedPrepared.releaseDigest,
    }), { deleted: false, cleanupPending: false }, "deletion retries are idempotent");

    await service.close();
    service = undefined;
    service = await RestrictedAppService.create({ rootPath, storage, connections });

    const activeRelease = await prepareAndPublish(service, "1.0.0");
    const install = await service.prepareLocalAppInstall({
      sourceWorkFolderId: sourceWorkFolder,
      targetWorkFolderId: targetWorkFolder,
      releaseDigest: activeRelease.releaseDigest,
    });
    await assert.rejects(
      service.deleteLocalAppRelease({ workFolderId: sourceWorkFolder, releaseDigest: activeRelease.releaseDigest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /Cancel every prepared install/i.test(errorMessage(error)),
    );
    await service.cancelLocalAppOperation(install.operationId);

    const activeInstall = await service.prepareLocalAppInstall({
      sourceWorkFolderId: sourceWorkFolder,
      targetWorkFolderId: targetWorkFolder,
      releaseDigest: activeRelease.releaseDigest,
    });
    const installed = (await service.activateLocalAppInstall(activeInstall.operationId)).apps[0]!;
    await assert.rejects(
      service.deleteLocalAppRelease({ workFolderId: sourceWorkFolder, releaseDigest: activeRelease.releaseDigest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /Uninstall every App Instance/i.test(errorMessage(error)),
    );

    const updateTarget = await prepareAndPublish(service, "2.0.0");
    const update = await service.prepareLocalAppUpdate({
      sourceWorkFolderId: sourceWorkFolder,
      runtimeInstanceId: installed.runtimeInstanceId,
      releaseDigest: updateTarget.releaseDigest,
    });
    await assert.rejects(
      service.deleteLocalAppRelease({ workFolderId: sourceWorkFolder, releaseDigest: updateTarget.releaseDigest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /Cancel every prepared install/i.test(errorMessage(error)),
      "the prepared operation's target Release must remain closed",
    );
    await assert.rejects(
      service.deleteLocalAppRelease({ workFolderId: sourceWorkFolder, releaseDigest: activeRelease.releaseDigest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID"
        && /Uninstall every App Instance/i.test(errorMessage(error))
        && /Cancel every prepared install/i.test(errorMessage(error)),
      "the prepared operation's source Release must remain closed",
    );
    await service.cancelLocalAppOperation(update.operationId);
    assert.deepEqual(await service.deleteLocalAppRelease({
      workFolderId: sourceWorkFolder,
      releaseDigest: updateTarget.releaseDigest,
    }), { deleted: true, cleanupPending: false });

    const uninstalled = await service.uninstallLocalApp({
      runtimeInstanceId: installed.runtimeInstanceId,
      dataDisposition: "retain",
    });
    await assert.rejects(
      service.deleteLocalAppRelease({ workFolderId: sourceWorkFolder, releaseDigest: activeRelease.releaseDigest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /Purge the retained App data/i.test(errorMessage(error)),
    );
    await service.purgeLocalAppRetainedData(uninstalled.retainedData[0]!.retainedDataId);
    assert.deepEqual(await service.deleteLocalAppRelease({
      workFolderId: sourceWorkFolder,
      releaseDigest: activeRelease.releaseDigest,
    }), { deleted: true, cleanupPending: false });
    assert.deepEqual((await service.localAppStudio(sourceWorkFolder)).releases, []);
    assert.deepEqual(await readdir(join(rootPath, "releases")), []);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

/**
 * Deleting a Release hands its record and verified envelope to `keep` before
 * anything is removed, and `restoreLocalAppRelease` puts the same two values
 * back (docs/receipts-not-gates.md, F20). The restored Release survives a
 * restart, because startup checks every stored Release against its record.
 */
test("a deleted Release comes back from its kept copy, verified, in the state it was deleted in", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-release-restore-"));
  const sourceRoot = join(sandbox, "source-work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(rootPath, "data"));
  const connections = new MemoryConnectionStore();
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(join(sourceRoot, "apps", "connected-inbox"), { marker: "release-restore" });
    service = await RestrictedAppService.create({ rootPath, storage, connections });
    await service.declareLocalAppProject({
      workFolderId: sourceWorkFolder,
      presentation: { title: "Connected Inbox", description: "Release restore fixture.", icon: "mail" },
    });
    const review = await service.inspect({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox" });
    await service.install({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox", expectedDigest: review.digest });
    const published = await prepareAndPublish(service, "1.0.0");

    // A failing keep deletes nothing: the copy comes first.
    await assert.rejects(
      service.deleteLocalAppRelease({
        workFolderId: sourceWorkFolder,
        releaseDigest: published.releaseDigest,
        keep: async () => { throw new Error("Recently deleted is unavailable"); },
      }),
      /Recently deleted is unavailable/,
    );
    assert.equal((await service.localAppStudio(sourceWorkFolder)).releases.length, 1);

    let kept: { record: unknown; release: unknown } | undefined;
    assert.deepEqual(await service.deleteLocalAppRelease({
      workFolderId: sourceWorkFolder,
      releaseDigest: published.releaseDigest,
      keep: async (copy) => { kept = JSON.parse(JSON.stringify(copy)); },
    }), { deleted: true, cleanupPending: false });
    assert.ok(kept);
    assert.equal((kept.record as { releaseDigest: string }).releaseDigest, published.releaseDigest);
    assert.equal((kept.release as { releaseDigest: string }).releaseDigest, published.releaseDigest);
    await assert.rejects(access(releaseObjectPath(rootPath, published.releaseDigest)), (error: unknown) => isMissingError(error));

    // The envelope is checked against its own content digest and its record.
    const tampered = structuredClone(kept.release) as { manifest: { displayVersion: string } };
    tampered.manifest.displayVersion = "9.9.9";
    await assert.rejects(
      service.restoreLocalAppRelease({ workFolderId: sourceWorkFolder, record: kept.record, release: tampered }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID",
    );
    await assert.rejects(
      service.restoreLocalAppRelease({ workFolderId: targetWorkFolder, record: kept.record, release: kept.release }),
      /different work-folder/,
    );

    const restored = await service.restoreLocalAppRelease({ workFolderId: sourceWorkFolder, record: kept.record, release: kept.release });
    assert.deepEqual(restored, published, "the Release returns exactly as it was, published");
    await access(releaseObjectPath(rootPath, published.releaseDigest));
    assert.deepEqual(
      await service.restoreLocalAppRelease({ workFolderId: sourceWorkFolder, record: kept.record, release: kept.release }),
      published,
      "restoring a Release that is already back changes nothing",
    );

    await service.close();
    service = await RestrictedAppService.create({ rootPath, storage, connections });
    assert.deepEqual((await service.localAppStudio(sourceWorkFolder)).releases, [published], "the restored Release passes startup verification");

    // A version prepared again in the meantime is not overwritten.
    await service.deleteLocalAppRelease({ workFolderId: sourceWorkFolder, releaseDigest: published.releaseDigest });
    await writePackage(join(sourceRoot, "apps", "connected-inbox"), { marker: "release-restore-second" });
    const nextReview = await service.inspect({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox" });
    await service.install({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox", expectedDigest: nextReview.digest });
    await service.prepareLocalAppRelease({ workFolderId: sourceWorkFolder, displayVersion: "1.0.0" });
    await assert.rejects(
      service.restoreLocalAppRelease({ workFolderId: sourceWorkFolder, record: kept.record, release: kept.release }),
      /Another Release 1\.0\.0 has been prepared since/,
    );
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

/**
 * Removing a work-folder hands everything it takes out of App Studio to
 * `keep` before anything is removed, and `restoreWorkFolderAppStudio` puts
 * the same values back (docs/receipts-not-gates.md, F20): packages and
 * envelopes are re-checked, a newer App Project with its own work is never
 * merged, and previews return under fresh authority with the person's
 * narrowing intact. The restored history survives a restart.
 */
test("a removed work-folder's App Studio history comes back from its kept copy, re-checked", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-work-folder-restore-"));
  const sourceRoot = join(sandbox, "source-work-folder");
  const keptRoot = join(sandbox, "kept-packages");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(rootPath, "data"));
  const connections = new MemoryConnectionStore();
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(join(sourceRoot, "apps", "connected-inbox"), { marker: "work-folder-restore" });
    service = await RestrictedAppService.create({ rootPath, storage, connections, runtimeHost: new RecordingRuntimeHost() });
    const project = await service.declareLocalAppProject({
      workFolderId: sourceWorkFolder,
      presentation: { title: "Connected Inbox", description: "Work-folder restore fixture.", icon: "mail" },
    });
    const review = await service.inspect({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox" });
    const preview = await service.install({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox", expectedDigest: review.digest });
    // The person's narrowing is part of what comes back.
    await service.revokeNotifications({ workFolderId: sourceWorkFolder, appId: featureId, expectedDigest: preview.digest, permissionId: "new-mail" });
    const published = await prepareAndPublish(service, "1.0.0");
    const prepared = await service.prepareLocalAppRelease({ workFolderId: sourceWorkFolder, displayVersion: "1.1.0" });
    const operation = await service.prepareLocalAppInstall({
      sourceWorkFolderId: sourceWorkFolder,
      targetWorkFolderId: targetWorkFolder,
      releaseDigest: published.releaseDigest,
    });
    const before = await service.localAppStudio(sourceWorkFolder);
    const narrowed = before.previews[0]!;
    assert.deepEqual(narrowed.notificationGrants, []);

    // A failing keep removes nothing: the copy comes first.
    await assert.rejects(
      service.removeWorkFolder(sourceWorkFolder, { keep: async () => { throw new Error("Recently deleted is unavailable"); } }),
      /Recently deleted is unavailable/,
    );
    assert.deepEqual(await service.localAppStudio(sourceWorkFolder), before);

    let kept: LocalAppWorkFolderRecoveryCopy | undefined;
    await service.removeWorkFolder(sourceWorkFolder, {
      keep: async (copy) => {
        // What the Recently deleted store does: a JSON copy of the records and
        // a copy of each package folder, never the originals.
        for (const item of copy.packages) await cp(item.root, join(keptRoot, item.digest), { recursive: true });
        kept = JSON.parse(JSON.stringify(copy)) as LocalAppWorkFolderRecoveryCopy;
      },
    });
    assert.ok(kept);
    assert.equal(kept.project?.projectId, project.projectId);
    assert.deepEqual(kept.releases.map((item) => item.record.releaseDigest).sort(), [published.releaseDigest, prepared.releaseDigest].sort());
    assert.deepEqual(kept.operations.map((item) => item.operationId), [operation.operationId]);
    assert.ok(kept.adminReceipts.length > 0, "the Project's receipts travel with it");
    assert.deepEqual(await service.localAppStudio(sourceWorkFolder), {
      project: null, previews: [], releases: [], instances: [], operations: [], retainedData: [],
    });
    await assert.rejects(access(releaseObjectPath(rootPath, published.releaseDigest)), (error: unknown) => isMissingError(error));
    await assert.rejects(access(join(rootPath, "staged", preview.digest)), (error: unknown) => isMissingError(error));

    const packageRoots = new Map(kept.packages.map((item) => [item.digest, join(keptRoot, item.digest)]));
    const restoreInput = (overrides: Partial<Parameters<RestrictedAppService["restoreWorkFolderAppStudio"]>[0]> = {}) => ({
      workFolderId: sourceWorkFolder,
      studio: {
        project: kept!.project,
        runtimeInstances: kept!.runtimeInstances,
        previews: kept!.previews,
        operations: kept!.operations,
        adminReceipts: kept!.adminReceipts,
      },
      releases: kept!.releases,
      packageRoots,
      registeredWorkFolderIds: new Set([sourceWorkFolder, targetWorkFolder]),
      ...overrides,
    });

    // Every byte is re-checked: a changed package or envelope is refused.
    const tamperedRoot = join(sandbox, "tampered-package");
    await cp(join(keptRoot, preview.digest), tamperedRoot, { recursive: true });
    await writeFile(join(tamperedRoot, "worker.js"), workerSource("tampered"), "utf8");
    await assert.rejects(
      service.restoreWorkFolderAppStudio(restoreInput({ packageRoots: new Map([[preview.digest, tamperedRoot]]) })),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /failed its check/.test(errorMessage(error)),
    );
    const tamperedReleases = structuredClone(kept.releases);
    (tamperedReleases[0]!.release as unknown as { manifest: { displayVersion: string } }).manifest.displayVersion = "9.9.9";
    await assert.rejects(
      service.restoreWorkFolderAppStudio(restoreInput({ releases: tamperedReleases })),
      (error: unknown) => errorCode(error) === "INPUT_INVALID",
    );
    await assert.rejects(
      service.restoreWorkFolderAppStudio(restoreInput({ workFolderId: targetWorkFolder })),
      (error: unknown) => errorCode(error) === "INPUT_INVALID",
      "App Studio history goes back only into the work-folder it came from",
    );
    assert.equal((await service.localAppStudio(sourceWorkFolder)).project, null, "a refused restore changes nothing");

    // A newer App Project with its own apps is never merged; once it is empty it gives way.
    const newer = await service.install({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox", expectedDigest: review.digest });
    assert.notEqual(newer.projectId, project.projectId);
    assert.match(await service.workFolderAppStudioRestoreBlocker(sourceWorkFolder, project.projectId) ?? "", /started a new App Project/);
    await assert.rejects(
      service.restoreWorkFolderAppStudio(restoreInput()),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /does not merge two App Projects/.test(errorMessage(error)),
    );
    await service.remove({ workFolderId: sourceWorkFolder, appId: featureId, expectedDigest: newer.digest });
    assert.equal(await service.workFolderAppStudioRestoreBlocker(sourceWorkFolder, project.projectId), null);

    const restored = await service.restoreWorkFolderAppStudio(restoreInput());
    assert.equal(restored.restored, true);
    assert.equal(restored.droppedOperationCount, 0);
    assert.deepEqual(restored.project, before.project);
    assert.deepEqual(restored.releases.map((item) => [item.releaseDigest, item.state]).sort(), [
      [published.releaseDigest, "published"],
      [prepared.releaseDigest, "prepared"],
    ].sort(), "each Release returns in the state it was removed in");
    assert.deepEqual(restored.operations, [operation]);
    const back = restored.previews[0]!;
    assert.deepEqual(ids(back), ids(narrowed), "the preview keeps its installation and data identity, so its kept data can go back into it");
    assert.equal(back.digest, narrowed.digest);
    assert.deepEqual(back.notificationGrants, [], "the person's narrowing carries back");
    assert.deepEqual(back.networkGrants, narrowed.networkGrants);
    assert.equal(back.automations.find((item) => item.id === refreshAppAutomation)?.enabled, true);
    for (const field of ["featureInstallationGeneration", "grantGeneration", "connectionGeneration", "jobGeneration", "dataGeneration", "runtimeInstanceGeneration"] as const) {
      assert.notEqual(back.authority[field], narrowed.authority[field], `${field} is fresh, so nothing issued before the removal can act for it`);
    }
    assert.equal((await service.connectionStatus(sourceWorkFolder, featureId, back.digest))[0]?.configured, false,
      "secrets went with the removal and are entered again");
    await access(releaseObjectPath(rootPath, published.releaseDigest));
    await access(join(rootPath, "staged", preview.digest));

    const again = await service.restoreWorkFolderAppStudio(restoreInput());
    assert.equal(again.restored, false, "restoring history that is already back changes nothing");

    await service.close();
    service = await RestrictedAppService.create({ rootPath, storage, connections, runtimeHost: new RecordingRuntimeHost() });
    const reopened = await service.localAppStudio(sourceWorkFolder);
    assert.equal(reopened.project?.projectId, project.projectId, "the restored history passes startup verification");
    assert.equal(reopened.releases.length, 2);
    assert.equal(reopened.previews.length, 1);

    // The restored lineage works: the prepared Release still publishes against
    // its source previews, and the prepared install still activates.
    assert.equal((await service.publishLocalAppRelease({ workFolderId: sourceWorkFolder, releaseDigest: prepared.releaseDigest })).state, "published");
    const activated = await service.activateLocalAppInstall(operation.operationId);
    assert.equal(activated.instance.workFolderId, targetWorkFolder);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a target work-folder's cancelled installs come back only while they still fit", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-target-restore-"));
  const sourceRoot = join(sandbox, "source-work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(join(sourceRoot, "apps", "connected-inbox"), { marker: "target-restore" });
    service = await RestrictedAppService.create({ rootPath });
    const review = await service.inspect({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox" });
    await service.install({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox", expectedDigest: review.digest });
    const published = await prepareAndPublish(service, "1.0.0");
    const operation = await service.prepareLocalAppInstall({
      sourceWorkFolderId: sourceWorkFolder,
      targetWorkFolderId: targetWorkFolder,
      releaseDigest: published.releaseDigest,
    });

    let kept: LocalAppWorkFolderRecoveryCopy | undefined;
    await service.removeWorkFolder(targetWorkFolder, { keep: async (copy) => { kept = JSON.parse(JSON.stringify(copy)); } });
    assert.ok(kept);
    assert.equal(kept.project, null, "a target-only work-folder keeps no App Project");
    assert.deepEqual(kept.operations.map((item) => item.operationId), [operation.operationId]);
    assert.deepEqual((await service.localAppStudio(sourceWorkFolder)).operations, []);
    const input = (registered: string[]) => ({
      workFolderId: targetWorkFolder,
      studio: { project: kept!.project, runtimeInstances: kept!.runtimeInstances, previews: kept!.previews, operations: kept!.operations, adminReceipts: kept!.adminReceipts },
      releases: kept!.releases,
      packageRoots: new Map<string, string>(),
      registeredWorkFolderIds: new Set(registered),
    });

    // Aimed at a work-folder that is not registered, the install is counted, not guessed at.
    const unregistered = await service.restoreWorkFolderAppStudio(input([sourceWorkFolder]));
    assert.equal(unregistered.restored, false);
    assert.equal(unregistered.droppedOperationCount, 1);
    assert.deepEqual((await service.localAppStudio(sourceWorkFolder)).operations, []);

    const restored = await service.restoreWorkFolderAppStudio(input([sourceWorkFolder, targetWorkFolder]));
    assert.equal(restored.restored, true);
    assert.equal(restored.droppedOperationCount, 0);
    assert.deepEqual(restored.operations, [operation]);
    assert.deepEqual((await service.localAppStudio(sourceWorkFolder)).operations, [operation]);
    const repeated = await service.restoreWorkFolderAppStudio(input([sourceWorkFolder, targetWorkFolder]));
    assert.equal(repeated.restored, false);
    assert.equal(repeated.droppedOperationCount, 0, "an install already back is neither restored twice nor counted as lost");
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a retryable Release prune remains pending across restart without blocking service startup", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-release-prune-retry-"));
  const sourceRoot = join(sandbox, "source-work-folder");
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
      workFolderId: sourceWorkFolder,
      presentation: { title: "Connected Inbox", description: "Prune retry fixture.", icon: "mail" },
    });
    const review = await service.inspect({
      workFolderId: sourceWorkFolder,
      workFolderRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
    });
    await service.install({
      workFolderId: sourceWorkFolder,
      workFolderRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });
    const release = await service.prepareLocalAppRelease({ workFolderId: sourceWorkFolder, displayVersion: "0.9.0" });
    const objectPath = releaseObjectPath(rootPath, release.releaseDigest);

    blockPruning = true;
    assert.deepEqual(await service.deleteLocalAppRelease({
      workFolderId: sourceWorkFolder,
      releaseDigest: release.releaseDigest,
    }), { deleted: true, cleanupPending: true });
    assert.equal(await access(objectPath).then(() => true), true);
    await service.close();
    service = undefined;

    service = await RestrictedAppService.create({ rootPath, releaseStore });
    assert.deepEqual((await service.localAppStudio(sourceWorkFolder)).releases, [],
      "the committed registry deletion remains authoritative while bytes await pruning");
    assert.deepEqual(await service.deleteLocalAppRelease({
      workFolderId: sourceWorkFolder,
      releaseDigest: release.releaseDigest,
    }), { deleted: false, cleanupPending: true });

    blockPruning = false;
    assert.deepEqual(await service.deleteLocalAppRelease({
      workFolderId: sourceWorkFolder,
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
  const sourceRoot = join(sandbox, "source-work-folder");
  const packageRoot = join(sourceRoot, "apps", "connected-inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const releaseStore = new CountingReleaseStore(join(rootPath, "releases"));
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(packageRoot, { marker: "single-startup-verification" });
    service = await RestrictedAppService.create({ rootPath, releaseStore });
    const review = await service.inspect({
      workFolderId: sourceWorkFolder,
      workFolderRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
    });
    await service.install({
      workFolderId: sourceWorkFolder,
      workFolderRoot: sourceRoot,
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
    assert.equal((await service.localAppStudio(sourceWorkFolder)).releases.length, 1);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Local App updates carry continuity across revisions by default, reset every power only on request, roll back, and retain data explicitly", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-update-"));
  const sourceRoot = join(sandbox, "source-work-folder");
  const targetRoot = join(sandbox, "target-work-folder");
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
      workFolderId: sourceWorkFolder,
      presentation: { title: "Connected Inbox", description: "Update continuity fixture.", icon: "mail" },
    });
    const previewReview = await service.inspect({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox" });
    await service.install({
      workFolderId: sourceWorkFolder,
      workFolderRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: previewReview.digest,
    });
    const firstRelease = await prepareAndPublish(service, "1.0.0");
    const installPlan = await service.prepareLocalAppInstall({
      sourceWorkFolderId: sourceWorkFolder,
      targetWorkFolderId: targetWorkFolder,
      releaseDigest: firstRelease.releaseDigest,
    });
    const firstInstalled = (await service.activateLocalAppInstall(installPlan.operationId)).apps[0]!;
    const originalIds = {
      runtimeInstanceId: firstInstalled.runtimeInstanceId,
      featureInstallationId: firstInstalled.featureInstallationId,
      dataNamespaceId: firstInstalled.dataNamespaceId,
    };

    await service.grantNetwork({
      workFolderId: targetWorkFolder,
      appId: featureId,
      expectedDigest: firstInstalled.digest,
      destinationId: "mail-api",
    });
    await service.grantFiles({
      workFolderId: targetWorkFolder,
      workFolderRoot: targetRoot,
      appId: featureId,
      expectedDigest: firstInstalled.digest,
      permissionId: "exports",
      root: "exports",
    });
    await service.grantNotifications({
      workFolderId: targetWorkFolder,
      appId: featureId,
      expectedDigest: firstInstalled.digest,
      permissionId: "new-mail",
    });
    await service.setConnection({
      workFolderId: targetWorkFolder,
      appId: featureId,
      expectedDigest: firstInstalled.digest,
      destinationId: "mail-api",
      credential: { kind: "api-key", value: "local-test-secret" },
    });
    await service.setAppAutomationEnabled({
      workFolderId: targetWorkFolder,
      appId: featureId,
      expectedDigest: firstInstalled.digest,
      appAutomationId: refreshAppAutomation,
      enabled: true,
    });
    await storage.set(storageOwner(firstInstalled), "durable", { count: 7 });

    const exactRelease = await prepareAndPublish(service, "1.0.1");
    const exactUpdate = await service.prepareLocalAppUpdate({
      sourceWorkFolderId: sourceWorkFolder,
      runtimeInstanceId: firstInstalled.runtimeInstanceId,
      releaseDigest: exactRelease.releaseDigest,
    });
    assert.equal(exactUpdate.plan.canCommit, true);
    assert.equal(exactUpdate.plan.transitions[0]?.action, "keep");
    assert.deepEqual(exactUpdate.plan.transitions[0]?.resets, []);
    assert.deepEqual(exactUpdate.plan.transitions[0]?.continuity, {
      grants: ["file:exports", "network:mail-api", "notification:new-mail"],
      connections: ["mail-api"],
      enabledJobs: [refreshAppAutomation],
    });
    await assert.rejects(
      service.prepareLocalAppUpdate({
        sourceWorkFolderId: sourceWorkFolder,
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
    assert.equal(exactActivated.automations.find((item) => item.id === refreshAppAutomation)?.enabled, true);
    assert.equal((await service.connectionStatus(targetWorkFolder, featureId, exactActivated.digest))[0]?.configured, true);
    assert.deepEqual(await storage.get(storageOwner(exactActivated), "durable"), { count: 7 });

    const resetRelease = await prepareAndPublish(service, "1.0.2");
    const resetUpdate = await service.prepareLocalAppUpdate({
      sourceWorkFolderId: sourceWorkFolder,
      runtimeInstanceId: exactActivated.runtimeInstanceId,
      releaseDigest: resetRelease.releaseDigest,
      continuityPolicy: "reset",
    });
    assert.equal(resetUpdate.plan.transitions[0]?.action, "keep");
    assert.deepEqual(resetUpdate.plan.transitions[0]?.resets, ["grants", "connections", "jobs"]);
    const resetActivated = (await service.activateLocalAppUpdate(resetUpdate.operationId)).apps[0]!;
    assert.deepEqual(ids(resetActivated), originalIds, "an explicit authority reset keeps the Feature and data incarnation");
    // "reset" is the person's explicit choice to start over with the install
    // defaults: every declared power on again, and the connection gone.
    assert.deepEqual(resetActivated.networkGrants, ["mail-api"]);
    assert.deepEqual(resetActivated.fileGrants, [{ id: "exports", declarationId: "exports", root: ".", access: "read-write" }], "the reset re-binds the directory permission to the whole work-folder");
    assert.deepEqual(resetActivated.notificationGrants, ["new-mail"]);
    assert.equal(resetActivated.automations.every((automation) => automation.enabled), true);
    assert.equal((await service.connectionStatus(targetWorkFolder, featureId, resetActivated.digest))[0]?.configured, false,
      "an exact-revision reset must synchronously revoke the predecessor connection");
    assert.deepEqual(await storage.get(storageOwner(resetActivated), "durable"), { count: 7 });
    // The person narrows one default and connects again before the code changes.
    await service.revokeNotifications({
      workFolderId: targetWorkFolder,
      appId: featureId,
      expectedDigest: resetActivated.digest,
      permissionId: "new-mail",
    });
    await service.setConnection({
      workFolderId: targetWorkFolder,
      appId: featureId,
      expectedDigest: resetActivated.digest,
      destinationId: "mail-api",
      credential: { kind: "api-key", value: "replacement-test-secret" },
    });

    const staleRelease = await service.prepareLocalAppRelease({ workFolderId: sourceWorkFolder, displayVersion: "1.1.0" });
    await writePackage(packageRoot, { version: "0.2.0", marker: "changed-revision" });
    const changedReview = await service.inspect({ workFolderId: sourceWorkFolder, workFolderRoot: sourceRoot, sourcePath: "apps/connected-inbox" });
    await service.install({
      workFolderId: sourceWorkFolder,
      workFolderRoot: sourceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: changedReview.digest,
    });
    await assert.rejects(
      service.publishLocalAppRelease({ workFolderId: sourceWorkFolder, releaseDigest: staleRelease.releaseDigest }),
      (error: unknown) => errorCode(error) === "REVISION_CHANGED" && /changed after this Release was prepared/i.test(errorMessage(error)),
      "publishing must revalidate the reviewed Development Instance stamp",
    );

    const changedRelease = await prepareAndPublish(service, "2.0.0");
    const changedUpdate = await service.prepareLocalAppUpdate({
      sourceWorkFolderId: sourceWorkFolder,
      runtimeInstanceId: firstInstalled.runtimeInstanceId,
      releaseDigest: changedRelease.releaseDigest,
    });
    assert.equal(changedUpdate.plan.canCommit, true);
    assert.equal(changedUpdate.plan.transitions[0]?.action, "update");
    assert.equal(changedUpdate.plan.transitions[0]?.data, "retain");
    assert.deepEqual(changedUpdate.plan.transitions[0]?.resets, [], "the default continuity carries across a changed revision");
    assert.deepEqual(changedUpdate.plan.transitions[0]?.continuity, {
      grants: ["file:exports", "network:mail-api"],
      connections: ["mail-api"],
      enabledJobs: [refreshAppAutomation],
    });
    const changedActivated = (await service.activateLocalAppUpdate(changedUpdate.operationId)).apps[0]!;
    assert.deepEqual(ids(changedActivated), originalIds, "a revision switch keeps the Feature incarnation and data lineage");
    assert.deepEqual(changedActivated.networkGrants, ["mail-api"], "the person's granted state carries by declaration id");
    assert.deepEqual(changedActivated.fileGrants, [{ id: "exports", declarationId: "exports", root: ".", access: "read-write" }], "the whole-work-folder file grant carries with its unchanged declaration");
    assert.deepEqual(changedActivated.notificationGrants, [], "the person's revocation carries across the code change");
    assert.equal(changedActivated.automations.find((item) => item.id === refreshAppAutomation)?.enabled, true);
    assert.equal((await service.connectionStatus(targetWorkFolder, featureId, changedActivated.digest))[0]?.configured, true,
      "a byte-identical destination declaration keeps its connection");
    assert.deepEqual(await storage.get(storageOwner(changedActivated), "durable"), { count: 7 },
      "code revision must not imply a data namespace reset");

    const rollbackPlan = await service.prepareLocalAppUpdate({
      sourceWorkFolderId: sourceWorkFolder,
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
      service.remove({ workFolderId: targetWorkFolder, appId: featureId, expectedDigest: rolledBack.digest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /App Studio/i.test(errorMessage(error)),
      "a Feature-level remove must not bypass App Instance data disposition",
    );
    await assert.rejects(
      service.removeWorkFolder(targetWorkFolder),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /Uninstall release-backed Apps/i.test(errorMessage(error)),
      "work-folder removal must not implicitly delete an attached App Instance",
    );

    const uninstalled = await service.uninstallLocalApp({
      runtimeInstanceId: rolledBack.runtimeInstanceId,
      dataDisposition: "retain",
    });
    assert.equal(uninstalled.removed, true);
    assert.equal(uninstalled.retainedData.length, 1);
    assert.equal(uninstalled.retainedData[0]?.dataNamespaceId, originalIds.dataNamespaceId);
    assert.deepEqual(await service.list(targetWorkFolder), []);
    assert.deepEqual(await storage.get(storageOwner(rolledBack), "durable"), { count: 7 });
    assert.equal((await service.localAppStudio(sourceWorkFolder)).retainedData.length, 1);

    const purged = await service.purgeLocalAppRetainedData(uninstalled.retainedData[0]!.retainedDataId);
    assert.equal(purged.purged, true);
    assert.equal(purged.cleanupPending, false);
    assert.equal((await storage.usage(storageOwner(rolledBack))).keyCount, 0);
    assert.deepEqual((await service.localAppStudio(sourceWorkFolder)).retainedData, []);
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
        && error.supportedVersion === 6,
    );
    assert.equal(await readFile(registryPath, "utf8"), oldRegistry);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function prepareAndPublish(service: RestrictedAppService, displayVersion: string) {
  const prepared = await service.prepareLocalAppRelease({ workFolderId: sourceWorkFolder, displayVersion });
  return await service.publishLocalAppRelease({
    workFolderId: sourceWorkFolder,
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
  readonly stops: Array<{ workFolderId: string; appId: string; digest?: string }> = [];
  async invoke(_app: RestrictedAppRuntimeDescriptor, _action: string, _input: unknown): Promise<unknown> { return {}; }
  async runAppAutomation(): Promise<void> {}
  async stop(workFolderId: string, appId: string, digest?: string): Promise<void> {
    this.stops.push({ workFolderId, appId, ...(digest ? { digest } : {}) });
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

  async carryForward(
    from: RestrictedAppConnectionFeatureScope,
    to: RestrictedAppConnectionFeatureScope,
    keep: readonly { declarationId: string; declarationDigest: string }[],
  ): Promise<string[]> {
    const kept: string[] = [];
    for (const [key, record] of [...this.records]) {
      const binding = record.binding;
      if (!(binding.tenantId === from.tenantId && binding.runtimeInstanceId === from.runtimeInstanceId
        && binding.featureId === from.featureId && binding.featureInstallationId === from.featureInstallationId
        && binding.featureRevisionDigest === from.featureRevisionDigest)) continue;
      if (!keep.some((item) => item.declarationId === binding.declarationId && item.declarationDigest === binding.declarationDigest)) continue;
      this.records.delete(key);
      const moved = { ...binding, ...to };
      this.records.set(connectionKey(moved), { binding: moved, credential: record.credential });
      kept.push(binding.declarationId);
    }
    return kept.sort();
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
      id: refreshAppAutomation,
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
