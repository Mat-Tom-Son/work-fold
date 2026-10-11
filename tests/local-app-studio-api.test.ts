import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileRestrictedAppStorage, type RestrictedAppStorageOwner } from "../src/local/agent/restricted-app-storage.js";
import {
  RestrictedAppService,
  type LocalAppInstallPlan,
  type LocalAppProject,
  type LocalAppRelease,
  type LocalAppRetainedData,
  type LocalAppStudioSnapshot,
  type LocalAppUpdatePlan,
  type LocalAppWorkFolderRemovalImpact,
  type RestrictedAppInstalled,
} from "../src/local/agent/restricted-app-service.js";
import { startLocalApi } from "../src/local/server.js";
import {
  beginWorkFolderRemoval,
  finalizeWorkFolderRemoval,
  markWorkFolderRemovalAppStateRemoved,
} from "../src/local/work-folder.js";

const featureId = "connected-inbox";
const sourcePath = "apps/connected-inbox";

test("local App Studio API keeps Project, Release, installation, update, and data authority explicit", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-api-"));
  const stateBase = join(sandbox, "state");
  const workFolderBase = join(sandbox, "work-folders");
  const restrictedAppRoot = join(stateBase, "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(restrictedAppRoot, "data"));
  const service = await RestrictedAppService.create({ rootPath: restrictedAppRoot, storage });
  let removeBeforeRevalidation: string | null = null;
  const api = await startLocalApi({
    port: 0,
    stateBase,
    workFolderBase,
    loadEnv: false,
    restrictedAppService: service,
    beforeRestrictedAppWorkFolderRevalidation: async (workFolderId) => {
      if (workFolderId === removeBeforeRevalidation) {
        removeBeforeRevalidation = null;
        const intent = await beginWorkFolderRemoval(workFolderId, workFolderBase);
        await markWorkFolderRemovalAppStateRemoved(intent.workFolderId);
        const removal = await finalizeWorkFolderRemoval(intent.workFolderId);
        assert.equal(removal.cleanupPending, false, "the raced target removal must commit before validation resumes");
      }
    },
  });

  try {
    const source = await createWorkFolder(api.origin, "App source");
    const target = await createWorkFolder(api.origin, "App destination");
    const studioPath = `/api/work-folders/${source.id}/app-studio`;

    const initial = await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath);
    assert.deepEqual(initial.studio, {
      project: null,
      previews: [],
      releases: [],
      instances: [],
      operations: [],
      retainedData: [],
    });

    const malformedJson = await fetch(`${api.origin}${studioPath}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(malformedJson.status, 400);
    await malformedJson.json();

    const malformedBodyStatuses = await Promise.all((await Promise.all([
      rawRequest(api.origin, studioPath, { method: "PUT", body: { title: 42 } }),
      rawRequest(api.origin, `${studioPath}/releases/prepare`, { method: "POST", body: { displayVersion: 42 } }),
      rawRequest(api.origin, `${studioPath}/releases/publish`, { method: "POST", body: { releaseDigest: true } }),
      rawRequest(api.origin, `${studioPath}/installs/prepare`, {
        method: "POST",
        body: { targetWorkFolderId: 42, releaseDigest: true },
      }),
      rawRequest(
        api.origin,
        `${studioPath}/instances/runtime-instance_00000000-0000-4000-8000-000000000000/updates/prepare`,
        { method: "POST", body: { releaseDigest: 42 } },
      ),
    ])).map(async (response) => {
      await response.json();
      return response.status;
    }));

    const presentation = {
      title: "Connected Inbox",
      description: "A local-first inbox built and released from this work-folder.",
      icon: "mail",
    } as const;
    const declared = await request<{ project: LocalAppProject }>(api.origin, studioPath, {
      method: "PUT",
      body: presentation,
    });
    assert.equal(declared.project.workFolderId, source.id);
    assert.deepEqual(declared.project.presentation, presentation);

    await writePackage(join(source.workFolderRoot, ...sourcePath.split("/")), {
      packageVersion: "0.1.0",
      marker: "first-reviewed-revision",
    });
    const preview = { app: await installPreview(service, source) };
    assert.equal(preview.app.runtimeInstanceKind, "development");
    assert.equal(preview.app.releaseDigest, null);
    assert.equal(preview.app.projectId, declared.project.projectId);

    await expectFailure(
      api.origin,
      `${studioPath}/releases/prepare`,
      400,
      /Release version/i,
      { method: "POST", body: {} },
    );
    const prepared = await request<{ release: LocalAppRelease }>(api.origin, `${studioPath}/releases/prepare`, {
      method: "POST",
      body: { displayVersion: "1.0.0" },
    });
    assert.equal(prepared.release.state, "prepared");
    assert.equal(prepared.release.publishedAt, null);
    assert.deepEqual(prepared.release.presentation, presentation);

    await expectFailure(
      api.origin,
      `${studioPath}/installs/prepare`,
      400,
      /published Release/i,
      {
        method: "POST",
        body: { targetWorkFolderId: target.id, releaseDigest: prepared.release.releaseDigest },
      },
    );
    assert.deepEqual(
      (await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath)).studio.operations,
      [],
      "reviewing a Release must not implicitly publish or prepare its installation",
    );

    await expectFailure(
      api.origin,
      `/api/work-folders/${target.id}/app-studio/releases/publish`,
      400,
      /does not belong/i,
      { method: "POST", body: { releaseDigest: prepared.release.releaseDigest } },
    );
    const published = await request<{ release: LocalAppRelease }>(api.origin, `${studioPath}/releases/publish`, {
      method: "POST",
      body: { releaseDigest: prepared.release.releaseDigest },
    });
    assert.equal(published.release.state, "published");
    assert.ok(published.release.publishedAt);

    await expectFailure(
      api.origin,
      `${studioPath}/installs/prepare`,
      404,
      /work-folder not found/i,
      {
        method: "POST",
        body: { targetWorkFolderId: "space-0000000000000000", releaseDigest: published.release.releaseDigest },
      },
    );
    const racedTarget = await createWorkFolder(api.origin, "Removed during install preparation");
    removeBeforeRevalidation = racedTarget.id;
    await expectFailure(
      api.origin,
      `${studioPath}/installs/prepare`,
      404,
      /work-folder not found/i,
      {
        method: "POST",
        body: { targetWorkFolderId: racedTarget.id, releaseDigest: published.release.releaseDigest },
      },
    );
    assert.equal(removeBeforeRevalidation, null, "the post-reservation race seam must have run");
    assert.deepEqual(
      (await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath)).studio.operations,
      [],
      "an install cannot become durable after its target work-folder removal commits",
    );
    assert.equal(
      (await request<{ workFolders: Array<{ id: string }> }>(api.origin, "/api/bootstrap")).workFolders
        .some((workFolder) => workFolder.id === racedTarget.id),
      false,
      "the failed install must observe the committed target removal",
    );
    const install = await request<{ operation: LocalAppInstallPlan }>(api.origin, `${studioPath}/installs/prepare`, {
      method: "POST",
      body: { targetWorkFolderId: target.id, releaseDigest: published.release.releaseDigest },
    });
    assert.equal(install.operation.kind, "install");
    assert.equal(install.operation.targetWorkFolderId, target.id);
    assert.equal(install.operation.releaseDigest, published.release.releaseDigest);
    assert.deepEqual(
      (await request<{ impact: LocalAppWorkFolderRemovalImpact }>(
        api.origin,
        `/api/work-folders/${target.id}/app-removal-impact`,
      )).impact,
      {
        activeSourceInstanceCount: 0,
        activeTargetInstanceCount: 0,
        retainedDataCount: 0,
        incomingPreparedOperationCount: 1,
      },
      "work-folder removal preflight must expose an incoming prepared installation before activation",
    );

    await expectFailure(
      api.origin,
      `/api/work-folders/${target.id}/app-studio/operations/${install.operation.operationId}`,
      404,
      /operation not found/i,
      { method: "DELETE" },
    );
    await expectFailure(
      api.origin,
      `/api/work-folders/${target.id}/app-studio/operations/${install.operation.operationId}/activate`,
      404,
      /operation not found/i,
      { method: "POST", body: {} },
    );
    const activated = await request<{
      instance: { runtimeInstanceId: string; workFolderId: string; releaseDigest: string };
      apps: RestrictedAppInstalled[];
    }>(api.origin, `${studioPath}/operations/${install.operation.operationId}/activate`, {
      method: "POST",
      body: {},
    });
    assert.equal(activated.instance.runtimeInstanceId, install.operation.runtimeInstanceId);
    assert.equal(activated.instance.workFolderId, target.id);
    assert.equal(activated.instance.releaseDigest, published.release.releaseDigest);
    assert.equal(activated.apps.length, 1);
    assertPowersOn(activated.apps[0]!, published.release.releaseDigest);
    await assertConnectionIsUnset(api.origin, target.id, activated.apps[0]!);
    assert.deepEqual(
      (await request<{ impact: LocalAppWorkFolderRemovalImpact }>(
        api.origin,
        `/api/work-folders/${target.id}/app-removal-impact`,
      )).impact,
      {
        activeSourceInstanceCount: 0,
        activeTargetInstanceCount: 1,
        retainedDataCount: 0,
        incomingPreparedOperationCount: 0,
      },
      "work-folder removal preflight must expose an active target App Instance",
    );
    assert.equal(
      (await request<{ impact: LocalAppWorkFolderRemovalImpact }>(
        api.origin,
        `/api/work-folders/${source.id}/app-removal-impact`,
      )).impact.activeSourceInstanceCount,
      1,
      "the source work-folder must expose its active downstream App Instance",
    );

    const firstTargetList = await request<{ apps: RestrictedAppInstalled[] }>(
      api.origin,
      `/api/work-folders/${target.id}/restricted-apps`,
    );
    assert.equal(firstTargetList.apps.length, 1);
    assertPowersOn(firstTargetList.apps[0]!, published.release.releaseDigest);

    await expectFailure(
      api.origin,
      `/api/work-folders/${target.id}`,
      400,
      /Uninstall release-backed Apps/i,
      { method: "DELETE" },
    );

    await writePackage(join(source.workFolderRoot, ...sourcePath.split("/")), {
      packageVersion: "0.2.0",
      marker: "second-reviewed-revision",
    });
    await installPreview(service, source);
    const secondPrepared = await request<{ release: LocalAppRelease }>(api.origin, `${studioPath}/releases/prepare`, {
      method: "POST",
      body: { displayVersion: "2.0.0" },
    });
    const secondPublished = await request<{ release: LocalAppRelease }>(api.origin, `${studioPath}/releases/publish`, {
      method: "POST",
      body: { releaseDigest: secondPrepared.release.releaseDigest },
    });

    await expectFailure(
      api.origin,
      `${studioPath}/instances/${activated.instance.runtimeInstanceId}/updates/prepare`,
      400,
      /continuity.*eligible or reset/i,
      {
        method: "POST",
        body: { releaseDigest: secondPublished.release.releaseDigest, continuityPolicy: "preserve" },
      },
    );
    await expectFailure(
      api.origin,
      `${studioPath}/instances/${activated.instance.runtimeInstanceId}/updates/prepare`,
      400,
      /target published Release/i,
      { method: "POST", body: {} },
    );
    await expectFailure(
      api.origin,
      `${studioPath}/instances/runtime-instance_00000000-0000-4000-8000-000000000000/updates/prepare`,
      404,
      /Instance not found/i,
      { method: "POST", body: { releaseDigest: secondPublished.release.releaseDigest } },
    );
    const update = await request<{ operation: LocalAppUpdatePlan }>(
      api.origin,
      `${studioPath}/instances/${activated.instance.runtimeInstanceId}/updates/prepare`,
      {
        method: "POST",
        body: { releaseDigest: secondPublished.release.releaseDigest, continuityPolicy: "reset" },
      },
    );
    assert.equal(update.operation.kind, "update");
    assert.equal(update.operation.targetWorkFolderId, target.id);
    assert.equal(update.operation.plan.canCommit, true);
    assert.equal(update.operation.plan.toReleaseDigest, secondPublished.release.releaseDigest);

    await expectFailure(
      api.origin,
      `/api/work-folders/${target.id}/app-studio/operations/${update.operation.operationId}/activate`,
      404,
      /operation not found/i,
      { method: "POST", body: {} },
    );
    const updated = await request<{
      instance: { runtimeInstanceId: string; workFolderId: string; releaseDigest: string };
      apps: RestrictedAppInstalled[];
    }>(api.origin, `${studioPath}/operations/${update.operation.operationId}/activate`, {
      method: "POST",
      body: {},
    });
    assert.equal(updated.instance.runtimeInstanceId, activated.instance.runtimeInstanceId);
    assert.equal(updated.instance.releaseDigest, secondPublished.release.releaseDigest);
    assert.equal(updated.apps.length, 1);
    assertPowersOn(updated.apps[0]!, secondPublished.release.releaseDigest);
    await assertConnectionIsUnset(api.origin, target.id, updated.apps[0]!);

    await expectFailure(
      api.origin,
      `${studioPath}/releases/${encodeURIComponent(secondPublished.release.releaseDigest)}`,
      400,
      /Release is still required/i,
      { method: "DELETE" },
    );

    const installed = updated.apps[0]!;
    const owner = storageOwner(installed);
    await storage.set(owner, "view-state", { selectedFolder: "inbox" });
    assert.equal((await storage.usage(owner)).keyCount, 1);

    await expectFailure(
      api.origin,
      `/api/work-folders/${target.id}/local-app-instances/${installed.runtimeInstanceId}`,
      400,
      /retain or purge/i,
      { method: "DELETE", body: {} },
    );
    await expectFailure(
      api.origin,
      `/api/work-folders/${source.id}/local-app-instances/${installed.runtimeInstanceId}`,
      404,
      /Instance not found/i,
      { method: "DELETE", body: { dataDisposition: "retain" } },
    );
    assert.equal(
      (await request<{ apps: RestrictedAppInstalled[] }>(api.origin, `/api/work-folders/${target.id}/restricted-apps`)).apps.length,
      1,
      "a foreign work-folder cannot uninstall an attached App Instance",
    );

    const uninstalled = await request<{
      removed: boolean;
      retainedData: LocalAppRetainedData[];
      cleanupPending: boolean;
    }>(api.origin, `/api/work-folders/${target.id}/local-app-instances/${installed.runtimeInstanceId}`, {
      method: "DELETE",
      body: { dataDisposition: "retain" },
    });
    assert.equal(uninstalled.removed, true);
    assert.equal(uninstalled.retainedData.length, 1);
    assert.equal(uninstalled.retainedData[0]?.dataNamespaceId, installed.dataNamespaceId);
    assert.equal((await storage.usage(owner)).keyCount, 1, "retain keeps the detached namespace on this device");

    await expectFailure(
      api.origin,
      `/api/work-folders/${source.id}`,
      400,
      /Purge .* retained local data/i,
      { method: "DELETE" },
    );
    assert.equal(
      (await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath)).studio.project?.projectId,
      declared.project.projectId,
      "a retained-data blocker must be checked before committing a work-folder-removal intent",
    );

    const retainedDataId = uninstalled.retainedData[0]!.retainedDataId;
    const retainedExport = await request<{ backup: { appId: string; complete: boolean; data: { entries: unknown[] } } }>(api.origin, `${studioPath}/retained-data/${retainedDataId}`);
    assert.equal(retainedExport.backup.appId, installed.manifest.id);
    assert.equal(retainedExport.backup.complete, true);
    assert.deepEqual(retainedExport.backup.data.entries, [{ key: "view-state", value: { selectedFolder: "inbox" } }]);
    const foreignExport = await fetch(`${api.origin}/api/work-folders/${target.id}/app-studio/retained-data/${retainedDataId}`);
    assert.equal(foreignExport.status, 503, "a foreign work-folder cannot export retained Project data");
    await expectFailure(
      api.origin,
      `/api/work-folders/${target.id}/app-studio/retained-data/${retainedDataId}`,
      404,
      /retained .*data not found/i,
      { method: "DELETE" },
    );
    assert.equal((await storage.usage(owner)).keyCount, 1, "a foreign work-folder cannot purge another Project's retained data");

    const purged = await request<{ purged: boolean; cleanupPending: boolean; recentlyDeleted: Array<{ entryId: string }> }>(
      api.origin,
      `${studioPath}/retained-data/${retainedDataId}`,
      { method: "DELETE" },
    );
    assert.equal(purged.purged, true);
    assert.equal(typeof purged.cleanupPending, "boolean");
    assert.equal((await storage.usage(owner)).keyCount, 0);
    // The purge keeps a complete copy in Recently deleted first
    // (docs/receipts-not-gates.md, F20). Retained data has no app to go back
    // into, so the copy is a file the person can save.
    assert.equal(purged.recentlyDeleted.length, 1);
    const keptRetained = (await api.recentlyDeleted.list()).entries.filter((entry) => entry.kind === "app-retained");
    assert.equal(keptRetained.length, 1);
    assert.equal(keptRetained[0]?.id, purged.recentlyDeleted[0]?.entryId);
    assert.equal(keptRetained[0]?.reason, "apps.retained.purge");
    assert.deepEqual(
      (await api.recentlyDeleted.readAppData(keptRetained[0]!.id)).data.entries,
      retainedExport.backup.data.entries,
    );
    // Retained data has no app to go back into, so it can only be saved as a
    // file, and never into a work-folder or work-fold's own files.
    assert.equal(keptRetained[0]!.kind, "app-retained");
    await assert.rejects(
      api.actFacade.recentlyDeletedRestore({ entry: keptRetained[0]!.id }),
      /no app to go back into|Save a copy/i,
    );
    await assert.rejects(
      api.actFacade.recentlyDeletedRestore({ entry: keptRetained[0]!.id, toPath: join(source.workFolderRoot, "copy.json") }),
      /outside your work-folders/i,
    );
    const savedTo = join(sandbox, "saved-app-data.json");
    const saved = await api.actFacade.recentlyDeletedRestore({ entry: keptRetained[0]!.id, toPath: savedTo });
    assert.equal(saved.restored.kind, "saved-copy");
    const savedBackup = JSON.parse(await readFile(savedTo, "utf8")) as { data: { entries: unknown[] } };
    assert.deepEqual(savedBackup.data.entries, retainedExport.backup.data.entries);
    assert.equal(
      (await api.recentlyDeleted.list()).entries.some((entry) => entry.id === keptRetained[0]!.id),
      false,
      "a saved copy leaves Recently deleted",
    );
    assert.deepEqual(
      (await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath)).studio.retainedData,
      [],
    );

    const purgeInstall = await request<{ operation: LocalAppInstallPlan }>(api.origin, `${studioPath}/installs/prepare`, {
      method: "POST",
      body: { targetWorkFolderId: target.id, releaseDigest: secondPublished.release.releaseDigest },
    });
    const purgeActivated = await request<{ apps: RestrictedAppInstalled[] }>(
      api.origin,
      `${studioPath}/operations/${purgeInstall.operation.operationId}/activate`,
      { method: "POST", body: {} },
    );
    const purgeApp = purgeActivated.apps[0]!;
    const purgeOwner = storageOwner(purgeApp);
    await storage.set(purgeOwner, "temporary", true);
    const purgeUninstall = await request<{
      removed: boolean;
      retainedData: LocalAppRetainedData[];
      recentlyDeleted: Array<{ entryId: string; restoreBy: string }>;
    }>(
      api.origin,
      `/api/work-folders/${target.id}/local-app-instances/${purgeApp.runtimeInstanceId}`,
      { method: "DELETE", body: { dataDisposition: "purge" } },
    );
    assert.equal(purgeUninstall.removed, true);
    assert.deepEqual(purgeUninstall.retainedData, []);
    assert.equal((await storage.usage(purgeOwner)).keyCount, 0);
    // Uninstall-with-purge keeps a copy of every namespace it destroys
    // (docs/receipts-not-gates.md, F20). The app is gone, so the copy can only
    // be saved as a file.
    assert.equal(purgeUninstall.recentlyDeleted.length, 1);
    const keptPurge = (await api.recentlyDeleted.list()).entries
      .find((entry) => entry.id === purgeUninstall.recentlyDeleted[0]?.entryId);
    assert.equal(keptPurge?.reason, "apps.uninstall.purge");
    assert.equal(keptPurge?.kind, "app-storage");
    assert.deepEqual(
      (await api.recentlyDeleted.readAppData(keptPurge!.id)).data.entries,
      [{ key: "temporary", value: true }],
    );
    await assert.rejects(
      api.actFacade.recentlyDeletedRestore({ entry: keptPurge!.id }),
      /no longer installed|Save a copy/i,
    );

    type ReleaseDeletion = { deletion: { deleted: boolean; cleanupPending: boolean; recentlyDeleted: { entryId: string; restoreBy: string } | null } };
    const releaseIsListed = async () => (await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath)).studio.releases
      .some((release) => release.releaseDigest === published.release.releaseDigest);
    const releaseDeletion = await request<ReleaseDeletion>(
      api.origin,
      `${studioPath}/releases/${encodeURIComponent(published.release.releaseDigest)}`,
      { method: "DELETE" },
    );
    assert.equal(releaseDeletion.deletion.deleted, true);
    assert.equal(releaseDeletion.deletion.cleanupPending, false);
    assert.equal(await releaseIsListed(), false);
    // Deleting a Release is reversible (docs/receipts-not-gates.md, F20): it
    // waits in Recently deleted and comes back published, as it was.
    const keptRelease = releaseDeletion.deletion.recentlyDeleted;
    assert.ok(keptRelease, "the deleted Release waits in Recently deleted");
    const listedRelease = (await request<{ entries: Array<{ id: string; kind: string; reason: string; name: string; restorable: string; receiptId: string | null }> }>(
      api.origin,
      "/api/settings/recently-deleted",
    )).entries.find((entry) => entry.id === keptRelease.entryId);
    assert.equal(listedRelease?.kind, "app-release");
    assert.equal(listedRelease?.reason, "apps.release.delete");
    assert.equal(listedRelease?.name, "Connected Inbox 1.0.0");
    assert.equal(listedRelease?.restorable, "in-place");
    assert.match(listedRelease?.receiptId ?? "", /\S/, "the deletion's receipt names the entry it produced");
    const restoredRelease = await request<{ restored: { kind: string; releaseDigest: string; displayVersion: string } }>(
      api.origin,
      `/api/settings/recently-deleted/${keptRelease.entryId}/restore`,
      { method: "POST", body: {} },
    );
    assert.deepEqual(
      { kind: restoredRelease.restored.kind, releaseDigest: restoredRelease.restored.releaseDigest, displayVersion: restoredRelease.restored.displayVersion },
      { kind: "app-release", releaseDigest: published.release.releaseDigest, displayVersion: "1.0.0" },
    );
    const back = (await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath)).studio.releases
      .find((release) => release.releaseDigest === published.release.releaseDigest);
    assert.equal(back?.state, "published", "the Release returns in the state it was deleted in");
    assert.equal(
      (await api.recentlyDeleted.list()).entries.some((entry) => entry.id === keptRelease.entryId),
      false,
      "a restored Release leaves Recently deleted",
    );

    const secondDeletion = await request<ReleaseDeletion>(
      api.origin,
      `${studioPath}/releases/${encodeURIComponent(published.release.releaseDigest)}`,
      { method: "DELETE" },
    );
    assert.equal(secondDeletion.deletion.deleted, true);
    assert.equal(await releaseIsListed(), false);
    const repeatedDeletion = await request<ReleaseDeletion>(
      api.origin,
      `${studioPath}/releases/${encodeURIComponent(published.release.releaseDigest)}`,
      { method: "DELETE" },
    );
    assert.equal(repeatedDeletion.deletion.deleted, false, "Release deletion is retry-safe after registry commit");
    assert.equal(repeatedDeletion.deletion.recentlyDeleted, null, "a delete that removed nothing keeps nothing");

    const removedWorkFolder = await request<{ removed: boolean }>(api.origin, `/api/work-folders/${target.id}`, {
      method: "DELETE",
    });
    assert.equal(removedWorkFolder.removed, true, "the work-folder is removable after its attached App Instance is explicitly uninstalled");
    assert.deepEqual(
      malformedBodyStatuses,
      [400, 400, 400, 400, 400],
      "wrong JSON value types are client errors, never route-level TypeErrors",
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("target-scoped uninstall survives an unavailable linked source work-folder", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-missing-source-api-"));
  const stateBase = join(sandbox, "state");
  const restrictedAppRoot = join(stateBase, "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(restrictedAppRoot, "data"));
  const service = await RestrictedAppService.create({ rootPath: restrictedAppRoot, storage });
  const api = await startLocalApi({
    port: 0,
    stateBase,
    workFolderBase: join(sandbox, "managed-spaces"),
    loadEnv: false,
    restrictedAppService: service,
  });

  try {
    const linkedRoot = join(sandbox, "linked-app-source");
    await mkdir(linkedRoot, { recursive: true });
    const source = await registerLinkedWorkFolder(api.origin, linkedRoot);
    assert.equal(source.location.storage, "linked");
    const target = await createWorkFolder(api.origin, "Missing-source destination");
    const studioPath = `/api/work-folders/${source.id}/app-studio`;

    await request<{ project: LocalAppProject }>(api.origin, studioPath, {
      method: "PUT",
      body: {
        title: "Portable Inbox",
        description: "A Release whose source folder may later become unavailable.",
        icon: "mail",
      },
    });
    await writePackage(join(linkedRoot, ...sourcePath.split("/")), {
      packageVersion: "1.0.0",
      marker: "linked-source-release",
    });
    await installPreview(service, source);
    const prepared = await request<{ release: LocalAppRelease }>(api.origin, `${studioPath}/releases/prepare`, {
      method: "POST",
      body: { displayVersion: "1.0.0" },
    });
    const published = await request<{ release: LocalAppRelease }>(api.origin, `${studioPath}/releases/publish`, {
      method: "POST",
      body: { releaseDigest: prepared.release.releaseDigest },
    });
    const install = await request<{ operation: LocalAppInstallPlan }>(api.origin, `${studioPath}/installs/prepare`, {
      method: "POST",
      body: { targetWorkFolderId: target.id, releaseDigest: published.release.releaseDigest },
    });
    const activated = await request<{ apps: RestrictedAppInstalled[] }>(
      api.origin,
      `${studioPath}/operations/${install.operation.operationId}/activate`,
      { method: "POST", body: {} },
    );
    const installed = activated.apps[0]!;
    const owner = storageOwner(installed);
    await storage.set(owner, "local-state", { unread: 3 });

    const movedRoot = join(sandbox, "linked-app-source-moved-away");
    await rename(linkedRoot, movedRoot);
    const afterMove = await request<{ workFolders: Array<{ id: string }> }>(api.origin, "/api/bootstrap");
    assert.equal(afterMove.workFolders.some((workFolder) => workFolder.id === source.id), false);
    assert.equal(afterMove.workFolders.some((workFolder) => workFolder.id === target.id), true);
    await expectFailure(api.origin, studioPath, 404, /work-folder not found/i);

    const uninstalled = await request<{ removed: boolean; retainedData: LocalAppRetainedData[] }>(
      api.origin,
      `/api/work-folders/${target.id}/local-app-instances/${installed.runtimeInstanceId}`,
      { method: "DELETE", body: { dataDisposition: "purge" } },
    );
    assert.equal(uninstalled.removed, true);
    assert.deepEqual(uninstalled.retainedData, []);
    assert.equal((await storage.usage(owner)).keyCount, 0);
    assert.deepEqual(
      (await request<{ apps: RestrictedAppInstalled[] }>(api.origin, `/api/work-folders/${target.id}/restricted-apps`)).apps,
      [],
    );

    const removedTarget = await request<{ removed: boolean }>(api.origin, `/api/work-folders/${target.id}`, {
      method: "DELETE",
    });
    assert.equal(removedTarget.removed, true);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("removing a work-folder keeps its App Studio history in Recently deleted and brings it back with its apps' data", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-removal-api-"));
  const stateBase = join(sandbox, "state");
  const restrictedAppRoot = join(stateBase, "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(restrictedAppRoot, "data"));
  const service = await RestrictedAppService.create({ rootPath: restrictedAppRoot, storage });
  const api = await startLocalApi({
    port: 0,
    stateBase,
    workFolderBase: join(sandbox, "managed-work-folders"),
    loadEnv: false,
    restrictedAppService: service,
  });
  type Listed = { id: string; kind: string; reason: string; name: string; restorable: string; note?: string; receiptId: string | null };
  const listed = async () => (await request<{ entries: Listed[] }>(api.origin, "/api/settings/recently-deleted")).entries;

  try {
    const linkedRoot = join(sandbox, "linked-app-source");
    await mkdir(linkedRoot, { recursive: true });
    const source = await registerLinkedWorkFolder(api.origin, linkedRoot);
    const studioPath = `/api/work-folders/${source.id}/app-studio`;
    await request<{ project: LocalAppProject }>(api.origin, studioPath, {
      method: "PUT",
      body: { title: "Connected Inbox", description: "Kept through removal.", icon: "mail" },
    });
    await writePackage(join(linkedRoot, ...sourcePath.split("/")), { packageVersion: "1.0.0", marker: "kept-through-removal" });
    const preview = await installPreview(service, source);
    await storage.set(storageOwner(preview), "inbox", { unread: 4 });
    const prepared = await request<{ release: LocalAppRelease }>(api.origin, `${studioPath}/releases/prepare`, {
      method: "POST",
      body: { displayVersion: "1.0.0" },
    });
    await request<{ release: LocalAppRelease }>(api.origin, `${studioPath}/releases/publish`, {
      method: "POST",
      body: { releaseDigest: prepared.release.releaseDigest },
    });

    const removal = await request<{
      appRecentlyDeletedEntries: Array<{ entryId: string }>;
      appStudioRecentlyDeleted: { entryId: string; restoreBy: string } | null;
    }>(api.origin, `/api/work-folders/${source.id}`, { method: "DELETE" });
    const studioEntryId = removal.appStudioRecentlyDeleted?.entryId;
    assert.ok(studioEntryId, "the removal names the App Studio history it kept");
    assert.equal(removal.appRecentlyDeletedEntries.length, 1, "the preview's data was kept as its own item");
    const dataEntryId = removal.appRecentlyDeletedEntries[0]!.entryId;
    assert.equal((await storage.usage(storageOwner(preview))).keyCount, 0, "the live data went with the preview");

    // Until the work-folder is registered again, restore refuses plainly.
    let entries = await listed();
    const studioEntry = entries.find((entry) => entry.id === studioEntryId);
    assert.equal(studioEntry?.kind, "app-studio");
    assert.equal(studioEntry?.reason, "apps.work-folder.removed");
    assert.equal(studioEntry?.name, "Connected Inbox");
    assert.match(studioEntry?.receiptId ?? "", /\S/, "the removal's receipt names the entry it produced");
    assert.equal(studioEntry?.restorable, "blocked");
    assert.match(studioEntry?.note ?? "", /Put .* back first/);
    const dataEntry = entries.find((entry) => entry.id === dataEntryId);
    assert.equal(dataEntry?.restorable, "save-only");
    assert.match(dataEntry?.note ?? "", /Restore this work-folder's App Studio history first/);
    await expectFailure(api.origin, `/api/settings/recently-deleted/${studioEntryId}/restore`, 409, /Put .* back first/, { method: "POST", body: {} });

    // The folder kept its portable identity, so adding it again brings the same work-folder back.
    const again = await registerLinkedWorkFolder(api.origin, linkedRoot);
    assert.equal(again.id, source.id);
    assert.equal((await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath)).studio.project, null);
    entries = await listed();
    assert.equal(entries.find((entry) => entry.id === studioEntryId)?.restorable, "in-place");

    const restored = await request<{ restored: {
      kind: string;
      projectTitle: string | null;
      previewCount: number;
      releaseCount: number;
      droppedOperationCount: number;
      appDataEntryIds: string[];
    } }>(api.origin, `/api/settings/recently-deleted/${studioEntryId}/restore`, { method: "POST", body: {} });
    assert.equal(restored.restored.kind, "app-studio");
    assert.equal(restored.restored.projectTitle, "Connected Inbox");
    assert.equal(restored.restored.previewCount, 1);
    assert.equal(restored.restored.releaseCount, 1);
    assert.equal(restored.restored.droppedOperationCount, 0);
    assert.deepEqual(restored.restored.appDataEntryIds, [dataEntryId], "the preview's data goes back into it in the same act");

    const studio = (await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath)).studio;
    assert.equal(studio.project?.presentation.title, "Connected Inbox");
    assert.deepEqual(studio.releases.map((release) => [release.releaseDigest, release.state]), [[prepared.release.releaseDigest, "published"]]);
    const back = studio.previews[0]!;
    assert.equal(back.featureInstallationId, preview.featureInstallationId);
    assert.deepEqual(await storage.get(storageOwner(back), "inbox"), { unread: 4 });
    entries = await listed();
    assert.equal(entries.some((entry) => entry.id === studioEntryId || entry.id === dataEntryId), false, "both items leave Recently deleted");
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function createWorkFolder(origin: string, name: string): Promise<{ id: string; workFolderRoot: string }> {
  return (await request<{ workFolder: { id: string; workFolderRoot: string } }>(origin, "/api/work-folders", {
    method: "POST",
    body: { name },
  })).workFolder;
}

async function registerLinkedWorkFolder(
  origin: string,
  workFolderRoot: string,
): Promise<{ id: string; workFolderRoot: string; location: { storage: "linked" } }> {
  return (await request<{
    workFolder: { id: string; workFolderRoot: string; location: { storage: "linked" } };
  }>(origin, "/api/work-folders/local-folder", {
    method: "POST",
    body: { workFolderRoot },
  })).workFolder;
}

/** Adds the package as a Local preview through the service's own inspect-then-install path. */
async function installPreview(service: RestrictedAppService, workFolder: { id: string; workFolderRoot: string }): Promise<RestrictedAppInstalled> {
  const review = await service.inspect({ workFolderId: workFolder.id, workFolderRoot: workFolder.workFolderRoot, sourcePath });
  return await service.install({ workFolderId: workFolder.id, workFolderRoot: workFolder.workFolderRoot, sourcePath, expectedDigest: review.digest });
}

/** An installed or reset Feature comes up with the install defaults (docs/receipts-not-gates.md, F21). */
function assertPowersOn(app: RestrictedAppInstalled, releaseDigest: string): void {
  assert.equal(app.runtimeInstanceKind, "app");
  assert.equal(app.releaseDigest, releaseDigest);
  assert.deepEqual(app.networkGrants, ["mail-api"]);
  assert.deepEqual(app.fileGrants, [{ id: "exports", declarationId: "exports", root: ".", access: "read-write" }]);
  assert.deepEqual(app.notificationGrants, ["new-mail"]);
  assert.ok(app.automations.length > 0);
  assert.equal(app.automations.every((automation) => automation.enabled === true), true);
}

async function assertConnectionIsUnset(origin: string, workFolderId: string, app: RestrictedAppInstalled): Promise<void> {
  const response = await request<{
    connections: Array<{ destinationId: string; owner: string; kind: string | null; configured: boolean }>;
  }>(
    origin,
    `/api/work-folders/${workFolderId}/restricted-apps/${featureId}/connections?expectedDigest=${app.digest}`,
  );
  assert.deepEqual(response.connections, [{
    destinationId: "mail-api",
    owner: "instance",
    kind: null,
    configured: false,
  }]);
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

interface RequestOptions {
  method?: string;
  body?: unknown;
}

async function rawRequest(origin: string, path: string, options: RequestOptions = {}): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    method: options.method ?? "GET",
    ...(options.body !== undefined ? {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options.body),
    } : {}),
  });
}

async function request<T>(origin: string, path: string, options: RequestOptions = {}): Promise<T> {
  const response = await rawRequest(origin, path, options);
  const value = await response.json() as T & { error?: string };
  assert.equal(response.ok, true, value.error);
  return value;
}

async function expectFailure(
  origin: string,
  path: string,
  status: number,
  message: RegExp,
  options: RequestOptions = {},
): Promise<void> {
  const response = await rawRequest(origin, path, options);
  const value = await response.json() as { error?: string; code?: string };
  assert.equal(response.status, status, value.error);
  assert.match(value.error ?? "", message);
}

async function writePackage(
  root: string,
  options: { packageVersion: string; marker: string },
): Promise<void> {
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({
      name: featureId,
      version: options.packageVersion,
      private: true,
      type: "module",
      agentApp: "agent-app.json",
    }), "utf8"),
    writeFile(join(root, "agent-app.json"), JSON.stringify({
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
        id: "refresh-mail",
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
    }), "utf8"),
    writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8"),
    writeFile(join(root, "app.js"), "export {};\n", "utf8"),
    writeFile(
      join(root, "worker.js"),
      `// ${options.marker}\nexport async function handleAction() { return { count: 0 }; }\nexport async function handleAutomation() {}\n`,
      "utf8",
    ),
  ]);
}
