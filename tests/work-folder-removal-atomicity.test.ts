import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from "node:net";
import test from "node:test";

import {
  RestrictedAppService,
  type RestrictedAppRuntimeAuthority,
  type RestrictedAppRuntimeHost,
} from "../src/local/agent/restricted-app-service.js";
import { WorkFoldCheckService } from "../src/local/checks/check-service.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";
import { configureWorkFoldStateRoot, workFolderCheckStateFile, workFolderRegistryFile, workFolderStateDir } from "../src/local/state-paths.js";
import { createWorkFolderCheckpoint, listWorkFolderCheckpoints } from "../src/local/history.js";
import { WorkFoldRecentlyDeletedStore } from "../src/local/recently-deleted-store.js";
import { WorkFoldKernel } from "../src/local/work-fold-kernel.js";
import {
  beginWorkFolderRemoval,
  createManagedWorkFolder,
  listPendingWorkFolderRemovals,
  type WorkFolderRegistry,
  type WorkFolderRemovalIo,
} from "../src/local/work-folder.js";

const exampleRestrictedAppRoot = fileURLToPath(new URL(
  "../examples/packages/restricted-connected-inbox/",
  import.meta.url,
));

test("a failed removal-intent commit preserves both the work-folder and its App Project", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-removal-intent-api-"));
  const stateBase = join(sandbox, "state");
  const workFolderBase = join(sandbox, "work-folders");
  const service = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
  const api = await startLocalApi({
    port: 0,
    stateBase,
    workFolderBase,
    loadEnv: false,
    restrictedAppService: service,
    workFolderRemovalIo: {
      async persistRegistry() {
        throw new Error("simulated removal-intent persistence failure");
      },
    },
  });
  try {
    const workFolder = await createAppProject(api, "Atomic source");
    const response = await fetch(`${api.origin}/api/work-folders/${workFolder.id}`, { method: "DELETE" });
    assert.equal(response.status, 500);
    assert.match((await response.json() as { error: string }).error, /simulated removal-intent persistence failure/);

    const bootstrap = await request<{ workFolders: Array<{ id: string }> }>(api, "/api/bootstrap");
    assert.equal(bootstrap.workFolders.some((item) => item.id === workFolder.id), true);
    assert.equal((await service.localAppStudio(workFolder.id)).project?.presentation.title, "Atomic source App");
    assert.equal(existsSync(workFolder.workFolderRoot), true);
    assert.deepEqual(await listPendingWorkFolderRemovals(), []);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("managed-folder deletion failure returns committed removal and startup recovery finishes it", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-removal-folder-api-"));
  const stateBase = join(sandbox, "state");
  const workFolderBase = join(sandbox, "work-folders");
  let blockManagedDelete = true;
  const removalIo: Partial<WorkFolderRemovalIo> = {
    async claimManagedRoot(rootPath, claimPath) {
      if (blockManagedDelete) throw new Error("simulated managed-folder lock");
      await rename(rootPath, claimPath);
    },
  };
  let api: LocalApiHandle | null = null;
  try {
    const service = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: service,
      workFolderRemovalIo: removalIo,
    });
    const workFolder = await createAppProject(api, "Locked source");
    await writeFile(join(workFolder.workFolderRoot, "keep-until-retry.txt"), "pending", "utf8");
    const removal = await request<{
      removed: true;
      deleted: boolean;
      cleanupPending: boolean;
      recentlyDeleted: { entryId: string } | null;
    }>(api, `/api/work-folders/${workFolder.id}`, { method: "DELETE" });
    assert.deepEqual(removal, { removed: true, deleted: false, workFolderRoot: workFolder.workFolderRoot, cleanupPending: true, recentlyDeleted: null, appRecentlyDeletedEntries: [] });
    assert.equal(existsSync(workFolder.workFolderRoot), true);
    assert.equal((await service.localAppStudio(workFolder.id)).project, null);
    assert.equal((await request<{ workFolders: Array<{ id: string }> }>(api, "/api/bootstrap")).workFolders.some((item) => item.id === workFolder.id), false);
    assert.equal((await listPendingWorkFolderRemovals())[0]?.phase, "app-state-removed");

    await api.close();
    api = null;
    blockManagedDelete = false;
    const recoveredService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: recoveredService,
      workFolderRemovalIo: removalIo,
    });
    assert.equal(existsSync(workFolder.workFolderRoot), false);
    assert.deepEqual(await listPendingWorkFolderRemovals(), []);
    assert.deepEqual((await request<{ workFolders: unknown[] }>(api, "/api/bootstrap")).workFolders, []);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("startup removal recovery purges damaged Check authority before finalizing the intent", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-removal-check-state-api-"));
  const stateBase = join(sandbox, "state");
  const workFolderBase = join(sandbox, "work-folders");
  let api: LocalApiHandle | null = null;
  try {
    const service = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: service,
    });
    const workFolder = await createAppProject(api, "Damaged Check state");
    const intent = await beginWorkFolderRemoval(workFolder.id, workFolderBase);
    assert.equal(intent.phase, "requested");
    const checkState = workFolderCheckStateFile(workFolder.id);
    await mkdir(dirname(checkState), { recursive: true });
    await writeFile(checkState, "{damaged current state", "utf8");
    await writeFile(`${checkState}.bak`, JSON.stringify({ version: 999, authorizations: { unsafe: true } }), "utf8");

    await api.close();
    api = null;
    const recoveredService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: recoveredService,
    });
    assert.equal(existsSync(checkState), false);
    assert.equal(existsSync(`${checkState}.bak`), false);
    assert.deepEqual(await listPendingWorkFolderRemovals(), []);
    assert.equal(existsSync(workFolder.workFolderRoot), false);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("post-intent Check cleanup failure returns committed pending removal and recovers", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-removal-check-retry-api-"));
  const stateBase = join(sandbox, "state");
  const workFolderBase = join(sandbox, "work-folders");
  let api: LocalApiHandle | null = null;
  try {
    const service = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    const checks = new WorkFoldCheckService({ kernel: new WorkFoldKernel() });
    checks.removeWorkFolder = async () => { throw new Error("simulated Check cleanup failure"); };
    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: service,
      checkService: checks,
    });
    const workFolder = await createAppProject(api, "Check cleanup retry");
    const removal = await request<{ removed: true; deleted: boolean; cleanupPending: boolean; recentlyDeleted: unknown }>(
      api,
      `/api/work-folders/${workFolder.id}`,
      { method: "DELETE" },
    );
    assert.deepEqual(removal, { removed: true, deleted: false, workFolderRoot: workFolder.workFolderRoot, cleanupPending: true, recentlyDeleted: null, appRecentlyDeletedEntries: [] });
    assert.equal((await listPendingWorkFolderRemovals())[0]?.phase, "requested");
    assert.deepEqual((await request<{ workFolders: unknown[] }>(api, "/api/bootstrap")).workFolders, []);

    await api.close();
    api = null;
    const recoveredService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: recoveredService,
    });
    assert.deepEqual(await listPendingWorkFolderRemovals(), []);
    assert.equal(existsSync(workFolder.workFolderRoot), false);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Check leases close removal and nested-work-folder registration races before registry mutation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-check-registry-leases-api-"));
  const stateBase = join(sandbox, "state");
  const workFolderBase = join(sandbox, "work-folders");
  let api: LocalApiHandle | null = null;
  try {
    const initialService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: initialService,
    });
    const workFolder = await createAppProject(api, "Check lease source");
    await api.close();
    api = null;

    let statusGate: Promise<void> | null = null;
    let signalStatusStarted: (() => void) | null = null;
    const checks = new WorkFoldCheckService({
      kernel: new WorkFoldKernel(),
      listWorkFolders: async () => {
        signalStatusStarted?.();
        if (statusGate) await statusGate;
        return [{
          id: workFolder.id,
          name: "Check lease source",
          workFolderRoot: workFolder.workFolderRoot,
          location: { kind: "local", storage: "managed" },
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        }];
      },
    });
    let releaseRevalidation!: () => void;
    const revalidationGate = new Promise<void>((resolvePromise) => { releaseRevalidation = resolvePromise; });
    let signalRevalidationStarted!: () => void;
    const revalidationStarted = new Promise<void>((resolvePromise) => { signalRevalidationStarted = resolvePromise; });
    const service = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: service,
      checkService: checks,
      beforeRestrictedAppWorkFolderRevalidation: async () => {
        signalRevalidationStarted();
        await revalidationGate;
      },
    });

    const removalResponsePromise = fetch(`${api.origin}/api/work-folders/${workFolder.id}`, { method: "DELETE" });
    await revalidationStarted;
    let releaseStatus!: () => void;
    statusGate = new Promise<void>((resolvePromise) => { releaseStatus = resolvePromise; });
    let signalFirstStatus!: () => void;
    const firstStatusStarted = new Promise<void>((resolvePromise) => { signalFirstStatus = resolvePromise; });
    signalStatusStarted = signalFirstStatus;
    const firstStatus = checks.status({ id: workFolder.id, workFolderRoot: workFolder.workFolderRoot });
    await firstStatusStarted;
    releaseRevalidation();
    const removalResponse = await removalResponsePromise;
    assert.equal(removalResponse.status, 409, "removal must refuse before committing an intent when late Check work owns the lease");
    assert.deepEqual(await listPendingWorkFolderRemovals(), []);
    releaseStatus();
    statusGate = null;
    signalStatusStarted = null;
    await firstStatus;

    let releaseSecondStatus!: () => void;
    statusGate = new Promise<void>((resolvePromise) => { releaseSecondStatus = resolvePromise; });
    let signalSecondStatus!: () => void;
    const secondStatusStarted = new Promise<void>((resolvePromise) => { signalSecondStatus = resolvePromise; });
    signalStatusStarted = signalSecondStatus;
    const secondStatus = checks.status({ id: workFolder.id, workFolderRoot: workFolder.workFolderRoot });
    await secondStatusStarted;
    const childRoot = join(workFolder.workFolderRoot, "Nested");
    await mkdir(childRoot);
    const registrationResponse = await fetch(`${api.origin}/api/work-folders/local-folder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workFolderRoot: childRoot }),
    });
    assert.equal(registrationResponse.status, 409, "registration cannot establish a nested boundary during evidence work");
    releaseSecondStatus();
    statusGate = null;
    signalStatusStarted = null;
    await secondStatus;

    const registered = await request<{ workFolder: { workFolderRoot: string } }>(api, "/api/work-folders/local-folder", {
      method: "POST",
      body: { workFolderRoot: childRoot },
    });
    assert.equal(registered.workFolder.workFolderRoot, childRoot);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("final registry persistence failure keeps a retryable intent after App and folder removal", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-removal-registry-api-"));
  const stateBase = join(sandbox, "state");
  const workFolderBase = join(sandbox, "work-folders");
  let blockFinalCommit = true;
  const removalIo: Partial<WorkFolderRemovalIo> = {
    async persistRegistry(registry) {
      if (blockFinalCommit && registry.pendingRemovals.length === 0) {
        throw new Error("simulated final work-folder registry failure");
      }
      await persistRegistryForTest(registry);
    },
  };
  let api: LocalApiHandle | null = null;
  try {
    const service = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: service,
      workFolderRemovalIo: removalIo,
    });
    const workFolder = await createAppProject(api, "Registry source");
    const removal = await request<{
      removed: true;
      deleted: boolean;
      cleanupPending: boolean;
      recentlyDeleted: { entryId: string; restoreBy: string } | null;
    }>(api, `/api/work-folders/${workFolder.id}`, { method: "DELETE" });
    assert.equal(removal.removed, true);
    assert.equal(removal.deleted, true);
    assert.equal(removal.cleanupPending, true);
    assert.equal(existsSync(workFolder.workFolderRoot), false);
    // The claimed folder was moved, not erased (docs/receipts-not-gates.md, F20).
    const kept = (await api.recentlyDeleted.list()).entries;
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.kind, "work-folder");
    assert.equal(kept[0]?.originalPath, workFolder.workFolderRoot);
    assert.equal(removal.recentlyDeleted?.entryId, kept[0]?.id);
    assert.equal((await service.localAppStudio(workFolder.id)).project, null);
    assert.equal((await listPendingWorkFolderRemovals())[0]?.phase, "app-state-removed");

    await api.close();
    api = null;
    blockFinalCommit = false;
    const recoveredService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: recoveredService,
      workFolderRemovalIo: removalIo,
    });
    assert.deepEqual(await listPendingWorkFolderRemovals(), []);
    assert.deepEqual((await request<{ workFolders: unknown[] }>(api, "/api/bootstrap")).workFolders, []);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("startup carries remaining History into a deletion whose folder already reached Recently deleted", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-removal-history-recovery-"));
  const stateBase = join(sandbox, "state");
  const recentlyDeletedRoot = join(stateBase, "recently-deleted");
  let blockedStatePath: string | null = null;
  let api: LocalApiHandle | null = null;
  try {
    const recentlyDeleted = await WorkFoldRecentlyDeletedStore.open({ rootPath: recentlyDeletedRoot, io: {
      async rename(from, to) {
        if (from === blockedStatePath) throw new Error("simulated History move interruption");
        await rename(from, to);
      },
    } });
    api = await startLocalApi({ port: 0, stateBase, workFolderBase: join(sandbox, "work-folders"), loadEnv: false, recentlyDeletedStore: recentlyDeleted });
    const { workFolder } = await api.actFacade.createWorkFolder({ name: "History source" });
    await writeFile(join(workFolder.workFolderRoot, "draft.txt"), "Original draft\n");
    const checkpoint = await createWorkFolderCheckpoint(workFolder.workFolderRoot, { label: "Before interruption" });
    blockedStatePath = workFolderStateDir(workFolder.workFolderRoot);
    const removal = await request<{ cleanupPending: boolean }>(api, `/api/work-folders/${workFolder.id}`, { method: "DELETE" });
    assert.equal(removal.cleanupPending, true);
    assert.equal(existsSync(workFolder.workFolderRoot), false);
    assert.equal(existsSync(blockedStatePath), true, "History has not moved yet");
    const [entry] = (await api.recentlyDeleted.list()).entries;
    assert.ok(entry);
    assert.equal(entry.stateDir, undefined);
    await api.close();
    api = null;
    blockedStatePath = null;
    api = await startLocalApi({ port: 0, stateBase, workFolderBase: join(sandbox, "work-folders"), loadEnv: false, recentlyDeletedStore: await WorkFoldRecentlyDeletedStore.open({ rootPath: recentlyDeletedRoot }) });
    assert.deepEqual(await listPendingWorkFolderRemovals(), []);
    assert.equal((await api.recentlyDeleted.get(entry.id))?.stateDir, true);
    assert.equal(existsSync(workFolderStateDir(workFolder.workFolderRoot)), false);
    await api.recentlyDeleted.restoreTree(entry.id, { absolutePath: workFolder.workFolderRoot, stateDirFor: workFolderStateDir });
    assert.equal(await readFile(join(workFolder.workFolderRoot, "draft.txt"), "utf8"), "Original draft\n");
    assert.ok((await listWorkFolderCheckpoints(workFolder.workFolderRoot)).some((item) => item.id === checkpoint.id), "the original checkpoint is restored");
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("post-intent App cleanup failure reports pending and cannot block later API startup", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-removal-app-retry-api-"));
  const stateBase = join(sandbox, "state");
  const workFolderBase = join(sandbox, "work-folders");
  let api: LocalApiHandle | null = null;
  try {
    const runtime = new AppAutomationRecordingRuntimeHost();
    const service = await RestrictedAppService.create({
      rootPath: join(stateBase, "restricted-apps"),
      runtimeHost: runtime,
    });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: service,
    });
    const workFolder = await createAppProject(api, "App cleanup retry");
    const packageRoot = join(workFolder.workFolderRoot, "apps", "connected-inbox");
    await cp(exampleRestrictedAppRoot, packageRoot, { recursive: true });
    const review = await service.inspect({
      workFolderId: workFolder.id,
      workFolderRoot: workFolder.workFolderRoot,
      sourcePath: "apps/connected-inbox",
    });
    await service.install({
      workFolderId: workFolder.id,
      workFolderRoot: workFolder.workFolderRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });
    await service.setAppAutomationEnabled({
      workFolderId: workFolder.id,
      appId: "restricted-connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: "refresh-inbox",
      enabled: true,
    });
    assert.equal(runtime.authorities.length, 1);
    service.removeWorkFolder = async () => { throw new Error("simulated App cleanup failure"); };
    const removal = await request<{ removed: true; deleted: boolean; cleanupPending: boolean; recentlyDeleted: unknown }>(
      api,
      `/api/work-folders/${workFolder.id}`,
      { method: "DELETE" },
    );
    assert.deepEqual(removal, { removed: true, deleted: false, workFolderRoot: workFolder.workFolderRoot, cleanupPending: true, recentlyDeleted: null, appRecentlyDeletedEntries: [] });
    assert.equal((await listPendingWorkFolderRemovals())[0]?.phase, "requested");
    assert.equal(existsSync(workFolder.workFolderRoot), true);
    assert.deepEqual(runtime.authorities, [], "the durable removal intent must fence live broker authority");
    await assert.rejects(service.runAppAutomationNow({
      workFolderId: workFolder.id,
      appId: "restricted-connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: "refresh-inbox",
    }), /Automations are not active for this work-folder/);
    assert.equal(runtime.appAutomationRuns, 0, "the fenced work-folder cannot launch another automation");

    await api.close();
    api = null;
    const stillFailingService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    stillFailingService.removeWorkFolder = async () => { throw new Error("simulated startup retry failure"); };
    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: stillFailingService,
    });
    assert.deepEqual((await request<{ workFolders: unknown[] }>(api, "/api/bootstrap")).workFolders, []);
    assert.equal((await listPendingWorkFolderRemovals())[0]?.phase, "requested");

    await api.close();
    api = null;
    const recoveredService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: recoveredService,
    });
    assert.equal(existsSync(workFolder.workFolderRoot), false);
    assert.deepEqual(await listPendingWorkFolderRemovals(), []);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Local API owns first automation startup and removes a pending work-folder before a due job can launch", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-removal-deferred-app-automation-api-"));
  const stateBase = join(sandbox, "state");
  const workFolderBase = join(sandbox, "work-folders");
  const restrictedAppRoot = join(stateBase, "restricted-apps");
  const setupTime = new Date("2026-07-15T12:00:00.000Z");
  const recoveryTime = new Date("2026-07-15T13:00:00.000Z");
  let api: LocalApiHandle | null = null;
  let service: RestrictedAppService | null = null;
  let occupiedPortServer: NetServer | null = null;
  try {
    configureWorkFoldStateRoot(stateBase);
    const workFolder = await createManagedWorkFolder("Pending automated work-folder", workFolderBase);
    const packageRoot = join(workFolder.workFolderRoot, "apps", "connected-inbox");
    await cp(exampleRestrictedAppRoot, packageRoot, { recursive: true });

    const setupRuntime = new AppAutomationRecordingRuntimeHost();
    service = await RestrictedAppService.create({
      rootPath: restrictedAppRoot,
      runtimeHost: setupRuntime,
      now: () => setupTime,
      deferAppAutomationStart: false,
    });
    const review = await service.inspect({
      workFolderId: workFolder.id,
      workFolderRoot: workFolder.workFolderRoot,
      sourcePath: "apps/connected-inbox",
    });
    await service.install({
      workFolderId: workFolder.id,
      workFolderRoot: workFolder.workFolderRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });
    await service.setAppAutomationEnabled({
      workFolderId: workFolder.id,
      appId: "restricted-connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: "refresh-inbox",
      enabled: true,
    });
    await service.close();
    service = null;

    await beginWorkFolderRemoval(workFolder.id, workFolderBase);

    const rejectedRuntime = new AppAutomationRecordingRuntimeHost();
    const alreadyStarted = await RestrictedAppService.create({
      rootPath: restrictedAppRoot,
      runtimeHost: rejectedRuntime,
      now: () => recoveryTime,
      deferAppAutomationStart: false,
    });
    await assert.rejects(startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: alreadyStarted,
    }), /automation startup is still deferred/i,
    "the Local API must never accept a service that could have launched jobs before recovery");
    await alreadyStarted.close();
    assert.equal(rejectedRuntime.appAutomationRuns, 0);
    assert.equal((await listPendingWorkFolderRemovals()).length, 1,
      "rejecting unsafe composition must not consume the pending removal intent");

    const runtime = new AppAutomationRecordingRuntimeHost();
    service = await RestrictedAppService.create({
      rootPath: restrictedAppRoot,
      runtimeHost: runtime,
      now: () => recoveryTime,
    });
    assert.equal(service.appAutomationsStarted, false, "service construction is deferred by default");

    occupiedPortServer = createNetServer();
    await listenOnEphemeralPort(occupiedPortServer);
    const occupiedPort = (occupiedPortServer.address() as AddressInfo).port;
    await assert.rejects(startLocalApi({
      port: occupiedPort,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: service,
    }), (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
    "a failed socket bind must reject startup");
    assert.equal(service.appAutomationsStarted, false,
      "a failed socket bind must not leave the scheduler running without an API handle");
    assert.equal(runtime.appAutomationRuns, 0, "a due job must remain inert after failed API startup");
    await closeNetServer(occupiedPortServer);
    occupiedPortServer = null;

    api = await startLocalApi({
      port: 0,
      stateBase,
      workFolderBase,
      loadEnv: false,
      restrictedAppService: service,
    });
    assert.equal(service.appAutomationsStarted, true, "the Local API starts jobs only after recovery");
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(runtime.appAutomationRuns, 0, "the due job from the removed work-folder must never launch");
    assert.deepEqual(await service.list(workFolder.id), []);
    assert.deepEqual(await listPendingWorkFolderRemovals(), []);
    assert.equal(existsSync(workFolder.workFolderRoot), false);
  } finally {
    await api?.close().catch(() => undefined);
    if (!api) await service?.close().catch(() => undefined);
    if (occupiedPortServer) await closeNetServer(occupiedPortServer).catch(() => undefined);
    configureWorkFoldStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

function listenOnEphemeralPort(server: NetServer): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function closeNetServer(server: NetServer): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

async function createAppProject(api: LocalApiHandle, name: string): Promise<{ id: string; workFolderRoot: string }> {
  const { workFolder } = await request<{ workFolder: { id: string; workFolderRoot: string } }>(api, "/api/work-folders", {
    method: "POST",
    body: { name },
  });
  await request(api, `/api/work-folders/${workFolder.id}/app-studio`, {
    method: "PUT",
    body: { title: `${name} App`, description: null, icon: null },
  });
  return workFolder;
}

async function request<T = unknown>(
  api: LocalApiHandle,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${api.origin}${path}`, {
    method: options.method ?? "GET",
    ...(options.body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options.body),
    }),
  });
  const value = await response.json() as T & { error?: string };
  assert.equal(response.ok, true, value.error);
  return value;
}

async function persistRegistryForTest(registry: WorkFolderRegistry): Promise<void> {
  const file = workFolderRegistryFile();
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.test.tmp`;
  await writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

class AppAutomationRecordingRuntimeHost implements RestrictedAppRuntimeHost {
  appAutomationRuns = 0;
  authorities: RestrictedAppRuntimeAuthority[] = [];

  syncAuthority(authorities: readonly RestrictedAppRuntimeAuthority[]): void {
    this.authorities = structuredClone(authorities);
  }
  async invoke(): Promise<unknown> { return {}; }
  async runAppAutomation(): Promise<void> { this.appAutomationRuns += 1; }
  async stop(): Promise<void> {}
  async close(): Promise<void> {}
}
