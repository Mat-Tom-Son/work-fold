import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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
  type LocalAppSpaceRemovalImpact,
  type RestrictedAppInstalled,
} from "../src/local/agent/restricted-app-service.js";
import { startLocalApi } from "../src/local/server.js";
import {
  beginSpaceRemoval,
  finalizeSpaceRemoval,
  markSpaceRemovalAppStateRemoved,
} from "../src/local/space.js";

const featureId = "connected-inbox";
const sourcePath = "apps/connected-inbox";

test("local App Studio API keeps Project, Release, installation, update, and data authority explicit", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-studio-api-"));
  const stateBase = join(sandbox, "state");
  const spaceBase = join(sandbox, "spaces");
  const restrictedAppRoot = join(stateBase, "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(restrictedAppRoot, "data"));
  const service = await RestrictedAppService.create({ rootPath: restrictedAppRoot, storage });
  let removeBeforeRevalidation: string | null = null;
  const api = await startLocalApi({
    port: 0,
    stateBase,
    spaceBase,
    loadEnv: false,
    restrictedAppService: service,
    beforeRestrictedAppSpaceRevalidation: async (spaceId) => {
      if (spaceId === removeBeforeRevalidation) {
        removeBeforeRevalidation = null;
        const intent = await beginSpaceRemoval(spaceId, spaceBase);
        await markSpaceRemovalAppStateRemoved(intent.spaceId);
        const removal = await finalizeSpaceRemoval(intent.spaceId);
        assert.equal(removal.cleanupPending, false, "the raced target removal must commit before validation resumes");
      }
    },
  });

  try {
    const source = await createSpace(api.origin, "App source");
    const target = await createSpace(api.origin, "App destination");
    const studioPath = `/api/spaces/${source.id}/app-studio`;

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
        body: { targetSpaceId: 42, releaseDigest: true },
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
      description: "A local-first inbox built and released from this Space.",
      icon: "mail",
    } as const;
    const declared = await request<{ project: LocalAppProject }>(api.origin, studioPath, {
      method: "PUT",
      body: presentation,
    });
    assert.equal(declared.project.spaceId, source.id);
    assert.deepEqual(declared.project.presentation, presentation);

    await writePackage(join(source.spaceRoot, ...sourcePath.split("/")), {
      packageVersion: "0.1.0",
      marker: "first-reviewed-revision",
    });
    const firstReview = await inspect(api.origin, source.id);
    const preview = await request<{ app: RestrictedAppInstalled }>(
      api.origin,
      `/api/spaces/${source.id}/restricted-apps`,
      { method: "POST", body: { sourcePath, expectedDigest: firstReview.digest } },
    );
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
        body: { targetSpaceId: target.id, releaseDigest: prepared.release.releaseDigest },
      },
    );
    assert.deepEqual(
      (await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath)).studio.operations,
      [],
      "reviewing a Release must not implicitly publish or prepare its installation",
    );

    await expectFailure(
      api.origin,
      `/api/spaces/${target.id}/app-studio/releases/publish`,
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
      /Space not found/i,
      {
        method: "POST",
        body: { targetSpaceId: "space-0000000000000000", releaseDigest: published.release.releaseDigest },
      },
    );
    const racedTarget = await createSpace(api.origin, "Removed during install preparation");
    removeBeforeRevalidation = racedTarget.id;
    await expectFailure(
      api.origin,
      `${studioPath}/installs/prepare`,
      404,
      /Space not found/i,
      {
        method: "POST",
        body: { targetSpaceId: racedTarget.id, releaseDigest: published.release.releaseDigest },
      },
    );
    assert.equal(removeBeforeRevalidation, null, "the post-reservation race seam must have run");
    assert.deepEqual(
      (await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath)).studio.operations,
      [],
      "an install cannot become durable after its target Space removal commits",
    );
    assert.equal(
      (await request<{ spaces: Array<{ id: string }> }>(api.origin, "/api/bootstrap")).spaces
        .some((space) => space.id === racedTarget.id),
      false,
      "the failed install must observe the committed target removal",
    );
    const install = await request<{ operation: LocalAppInstallPlan }>(api.origin, `${studioPath}/installs/prepare`, {
      method: "POST",
      body: { targetSpaceId: target.id, releaseDigest: published.release.releaseDigest },
    });
    assert.equal(install.operation.kind, "install");
    assert.equal(install.operation.targetSpaceId, target.id);
    assert.equal(install.operation.releaseDigest, published.release.releaseDigest);
    assert.deepEqual(
      (await request<{ impact: LocalAppSpaceRemovalImpact }>(
        api.origin,
        `/api/spaces/${target.id}/app-removal-impact`,
      )).impact,
      {
        activeSourceInstanceCount: 0,
        activeTargetInstanceCount: 0,
        retainedDataCount: 0,
        incomingPreparedOperationCount: 1,
      },
      "Space removal preflight must expose an incoming prepared installation before activation",
    );

    await expectFailure(
      api.origin,
      `/api/spaces/${target.id}/app-studio/operations/${install.operation.operationId}`,
      404,
      /operation not found/i,
      { method: "DELETE" },
    );
    await expectFailure(
      api.origin,
      `/api/spaces/${target.id}/app-studio/operations/${install.operation.operationId}/activate`,
      404,
      /operation not found/i,
      { method: "POST", body: {} },
    );
    const activated = await request<{
      instance: { runtimeInstanceId: string; spaceId: string; releaseDigest: string };
      apps: RestrictedAppInstalled[];
    }>(api.origin, `${studioPath}/operations/${install.operation.operationId}/activate`, {
      method: "POST",
      body: {},
    });
    assert.equal(activated.instance.runtimeInstanceId, install.operation.runtimeInstanceId);
    assert.equal(activated.instance.spaceId, target.id);
    assert.equal(activated.instance.releaseDigest, published.release.releaseDigest);
    assert.equal(activated.apps.length, 1);
    assertPowersOff(activated.apps[0]!, published.release.releaseDigest);
    await assertConnectionIsUnset(api.origin, target.id, activated.apps[0]!);
    assert.deepEqual(
      (await request<{ impact: LocalAppSpaceRemovalImpact }>(
        api.origin,
        `/api/spaces/${target.id}/app-removal-impact`,
      )).impact,
      {
        activeSourceInstanceCount: 0,
        activeTargetInstanceCount: 1,
        retainedDataCount: 0,
        incomingPreparedOperationCount: 0,
      },
      "Space removal preflight must expose an active target App Instance",
    );
    assert.equal(
      (await request<{ impact: LocalAppSpaceRemovalImpact }>(
        api.origin,
        `/api/spaces/${source.id}/app-removal-impact`,
      )).impact.activeSourceInstanceCount,
      1,
      "the source Space must expose its active downstream App Instance",
    );

    const firstTargetList = await request<{ apps: RestrictedAppInstalled[] }>(
      api.origin,
      `/api/spaces/${target.id}/restricted-apps`,
    );
    assert.equal(firstTargetList.apps.length, 1);
    assertPowersOff(firstTargetList.apps[0]!, published.release.releaseDigest);

    await expectFailure(
      api.origin,
      `/api/spaces/${target.id}`,
      400,
      /Uninstall release-backed Apps/i,
      { method: "DELETE" },
    );

    await writePackage(join(source.spaceRoot, ...sourcePath.split("/")), {
      packageVersion: "0.2.0",
      marker: "second-reviewed-revision",
    });
    const secondReview = await inspect(api.origin, source.id);
    await request<{ app: RestrictedAppInstalled }>(api.origin, `/api/spaces/${source.id}/restricted-apps`, {
      method: "POST",
      body: { sourcePath, expectedDigest: secondReview.digest },
    });
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
    assert.equal(update.operation.targetSpaceId, target.id);
    assert.equal(update.operation.plan.canCommit, true);
    assert.equal(update.operation.plan.toReleaseDigest, secondPublished.release.releaseDigest);

    await expectFailure(
      api.origin,
      `/api/spaces/${target.id}/app-studio/operations/${update.operation.operationId}/activate`,
      404,
      /operation not found/i,
      { method: "POST", body: {} },
    );
    const updated = await request<{
      instance: { runtimeInstanceId: string; spaceId: string; releaseDigest: string };
      apps: RestrictedAppInstalled[];
    }>(api.origin, `${studioPath}/operations/${update.operation.operationId}/activate`, {
      method: "POST",
      body: {},
    });
    assert.equal(updated.instance.runtimeInstanceId, activated.instance.runtimeInstanceId);
    assert.equal(updated.instance.releaseDigest, secondPublished.release.releaseDigest);
    assert.equal(updated.apps.length, 1);
    assertPowersOff(updated.apps[0]!, secondPublished.release.releaseDigest);
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
      `/api/spaces/${target.id}/local-app-instances/${installed.runtimeInstanceId}`,
      400,
      /retain or purge/i,
      { method: "DELETE", body: {} },
    );
    await expectFailure(
      api.origin,
      `/api/spaces/${source.id}/local-app-instances/${installed.runtimeInstanceId}`,
      404,
      /Instance not found/i,
      { method: "DELETE", body: { dataDisposition: "retain" } },
    );
    assert.equal(
      (await request<{ apps: RestrictedAppInstalled[] }>(api.origin, `/api/spaces/${target.id}/restricted-apps`)).apps.length,
      1,
      "a foreign Space cannot uninstall an attached App Instance",
    );

    const uninstalled = await request<{
      removed: boolean;
      retainedData: LocalAppRetainedData[];
      cleanupPending: boolean;
    }>(api.origin, `/api/spaces/${target.id}/local-app-instances/${installed.runtimeInstanceId}`, {
      method: "DELETE",
      body: { dataDisposition: "retain" },
    });
    assert.equal(uninstalled.removed, true);
    assert.equal(uninstalled.retainedData.length, 1);
    assert.equal(uninstalled.retainedData[0]?.dataNamespaceId, installed.dataNamespaceId);
    assert.equal((await storage.usage(owner)).keyCount, 1, "retain keeps the detached namespace on this device");

    await expectFailure(
      api.origin,
      `/api/spaces/${source.id}`,
      400,
      /Purge .* retained local data/i,
      { method: "DELETE" },
    );
    assert.equal(
      (await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath)).studio.project?.projectId,
      declared.project.projectId,
      "a retained-data blocker must be checked before committing a Space-removal intent",
    );

    const retainedDataId = uninstalled.retainedData[0]!.retainedDataId;
    await expectFailure(
      api.origin,
      `/api/spaces/${target.id}/app-studio/retained-data/${retainedDataId}`,
      404,
      /retained .*data not found/i,
      { method: "DELETE" },
    );
    assert.equal((await storage.usage(owner)).keyCount, 1, "a foreign Space cannot purge another Project's retained data");

    const purged = await request<{ purged: boolean; cleanupPending: boolean }>(
      api.origin,
      `${studioPath}/retained-data/${retainedDataId}`,
      { method: "DELETE" },
    );
    assert.equal(purged.purged, true);
    assert.equal(typeof purged.cleanupPending, "boolean");
    assert.equal((await storage.usage(owner)).keyCount, 0);
    assert.deepEqual(
      (await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath)).studio.retainedData,
      [],
    );

    const purgeInstall = await request<{ operation: LocalAppInstallPlan }>(api.origin, `${studioPath}/installs/prepare`, {
      method: "POST",
      body: { targetSpaceId: target.id, releaseDigest: secondPublished.release.releaseDigest },
    });
    const purgeActivated = await request<{ apps: RestrictedAppInstalled[] }>(
      api.origin,
      `${studioPath}/operations/${purgeInstall.operation.operationId}/activate`,
      { method: "POST", body: {} },
    );
    const purgeApp = purgeActivated.apps[0]!;
    const purgeOwner = storageOwner(purgeApp);
    await storage.set(purgeOwner, "temporary", true);
    const purgeUninstall = await request<{ removed: boolean; retainedData: LocalAppRetainedData[] }>(
      api.origin,
      `/api/spaces/${target.id}/local-app-instances/${purgeApp.runtimeInstanceId}`,
      { method: "DELETE", body: { dataDisposition: "purge" } },
    );
    assert.equal(purgeUninstall.removed, true);
    assert.deepEqual(purgeUninstall.retainedData, []);
    assert.equal((await storage.usage(purgeOwner)).keyCount, 0);

    const releaseDeletion = await request<{ deletion: { deleted: boolean; cleanupPending: boolean } }>(
      api.origin,
      `${studioPath}/releases/${encodeURIComponent(published.release.releaseDigest)}`,
      { method: "DELETE" },
    );
    assert.deepEqual(releaseDeletion.deletion, { deleted: true, cleanupPending: false });
    assert.equal(
      (await request<{ studio: LocalAppStudioSnapshot }>(api.origin, studioPath)).studio.releases
        .some((release) => release.releaseDigest === published.release.releaseDigest),
      false,
    );
    const repeatedDeletion = await request<{ deletion: { deleted: boolean; cleanupPending: boolean } }>(
      api.origin,
      `${studioPath}/releases/${encodeURIComponent(published.release.releaseDigest)}`,
      { method: "DELETE" },
    );
    assert.equal(repeatedDeletion.deletion.deleted, false, "Release deletion is retry-safe after registry commit");

    const removedSpace = await request<{ removed: boolean }>(api.origin, `/api/spaces/${target.id}`, {
      method: "DELETE",
    });
    assert.equal(removedSpace.removed, true, "the Space is removable after its attached App Instance is explicitly uninstalled");
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

test("target-scoped uninstall survives an unavailable linked source Space", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-local-app-missing-source-api-"));
  const stateBase = join(sandbox, "state");
  const restrictedAppRoot = join(stateBase, "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(restrictedAppRoot, "data"));
  const service = await RestrictedAppService.create({ rootPath: restrictedAppRoot, storage });
  const api = await startLocalApi({
    port: 0,
    stateBase,
    spaceBase: join(sandbox, "managed-spaces"),
    loadEnv: false,
    restrictedAppService: service,
  });

  try {
    const linkedRoot = join(sandbox, "linked-app-source");
    await mkdir(linkedRoot, { recursive: true });
    const source = await registerLinkedSpace(api.origin, linkedRoot);
    assert.equal(source.location.storage, "linked");
    const target = await createSpace(api.origin, "Missing-source destination");
    const studioPath = `/api/spaces/${source.id}/app-studio`;

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
    const review = await inspect(api.origin, source.id);
    await request<{ app: RestrictedAppInstalled }>(api.origin, `/api/spaces/${source.id}/restricted-apps`, {
      method: "POST",
      body: { sourcePath, expectedDigest: review.digest },
    });
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
      body: { targetSpaceId: target.id, releaseDigest: published.release.releaseDigest },
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
    const afterMove = await request<{ spaces: Array<{ id: string }> }>(api.origin, "/api/bootstrap");
    assert.equal(afterMove.spaces.some((space) => space.id === source.id), false);
    assert.equal(afterMove.spaces.some((space) => space.id === target.id), true);
    await expectFailure(api.origin, studioPath, 404, /Space not found/i);

    const uninstalled = await request<{ removed: boolean; retainedData: LocalAppRetainedData[] }>(
      api.origin,
      `/api/spaces/${target.id}/local-app-instances/${installed.runtimeInstanceId}`,
      { method: "DELETE", body: { dataDisposition: "purge" } },
    );
    assert.equal(uninstalled.removed, true);
    assert.deepEqual(uninstalled.retainedData, []);
    assert.equal((await storage.usage(owner)).keyCount, 0);
    assert.deepEqual(
      (await request<{ apps: RestrictedAppInstalled[] }>(api.origin, `/api/spaces/${target.id}/restricted-apps`)).apps,
      [],
    );

    const removedTarget = await request<{ removed: boolean }>(api.origin, `/api/spaces/${target.id}`, {
      method: "DELETE",
    });
    assert.equal(removedTarget.removed, true);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function createSpace(origin: string, name: string): Promise<{ id: string; spaceRoot: string }> {
  return (await request<{ space: { id: string; spaceRoot: string } }>(origin, "/api/spaces", {
    method: "POST",
    body: { name },
  })).space;
}

async function registerLinkedSpace(
  origin: string,
  spaceRoot: string,
): Promise<{ id: string; spaceRoot: string; location: { storage: "linked" } }> {
  return (await request<{
    space: { id: string; spaceRoot: string; location: { storage: "linked" } };
  }>(origin, "/api/spaces/local-folder", {
    method: "POST",
    body: { spaceRoot },
  })).space;
}

async function inspect(origin: string, spaceId: string): Promise<{ digest: string }> {
  return (await request<{ review: { digest: string } }>(
    origin,
    `/api/spaces/${spaceId}/restricted-apps/inspect`,
    { method: "POST", body: { sourcePath } },
  )).review;
}

function assertPowersOff(app: RestrictedAppInstalled, releaseDigest: string): void {
  assert.equal(app.runtimeInstanceKind, "app");
  assert.equal(app.releaseDigest, releaseDigest);
  assert.deepEqual(app.networkGrants, []);
  assert.deepEqual(app.fileGrants, []);
  assert.deepEqual(app.notificationGrants, []);
  assert.ok(app.automations.length > 0);
  assert.equal(app.automations.every((automation) => automation.enabled === false), true);
}

async function assertConnectionIsUnset(origin: string, spaceId: string, app: RestrictedAppInstalled): Promise<void> {
  const response = await request<{
    connections: Array<{ destinationId: string; owner: string; kind: string | null; configured: boolean }>;
  }>(
    origin,
    `/api/spaces/${spaceId}/restricted-apps/${featureId}/connections?expectedDigest=${app.digest}`,
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
