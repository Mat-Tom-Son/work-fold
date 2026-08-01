import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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
import { WorkspaceCheckService } from "../src/local/checks/check-service.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";
import { configureWorkspaceStateRoot, workspaceCheckStateFile, workspaceRegistryFile } from "../src/local/state-paths.js";
import { WorkspaceKernel } from "../src/local/workspace-kernel.js";
import {
  beginWorkspaceRemoval,
  createManagedWorkspace,
  listPendingWorkspaceRemovals,
  type WorkspaceRegistry,
  type WorkspaceRemovalIo,
} from "../src/local/workspace.js";

const exampleRestrictedAppRoot = fileURLToPath(new URL(
  "../examples/packages/restricted-connected-inbox/",
  import.meta.url,
));

test("a failed removal-intent commit preserves both the Space and its App Project", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-removal-intent-api-"));
  const stateBase = join(sandbox, "state");
  const workspaceBase = join(sandbox, "spaces");
  const service = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
  const api = await startLocalApi({
    port: 0,
    stateBase,
    workspaceBase,
    loadEnv: false,
    restrictedAppService: service,
    workspaceRemovalIo: {
      async persistRegistry() {
        throw new Error("simulated removal-intent persistence failure");
      },
    },
  });
  try {
    const workspace = await createAppProject(api, "Atomic source");
    const response = await fetch(`${api.origin}/api/workspaces/${workspace.id}`, { method: "DELETE" });
    assert.equal(response.status, 500);
    assert.match((await response.json() as { error: string }).error, /simulated removal-intent persistence failure/);

    const bootstrap = await request<{ workspaces: Array<{ id: string }> }>(api, "/api/bootstrap");
    assert.equal(bootstrap.workspaces.some((item) => item.id === workspace.id), true);
    assert.equal((await service.localAppStudio(workspace.id)).project?.presentation.title, "Atomic source App");
    assert.equal(existsSync(workspace.rootPath), true);
    assert.deepEqual(await listPendingWorkspaceRemovals(), []);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("managed-folder deletion failure returns committed removal and startup recovery finishes it", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-removal-folder-api-"));
  const stateBase = join(sandbox, "state");
  const workspaceBase = join(sandbox, "spaces");
  let blockManagedDelete = true;
  const removalIo: Partial<WorkspaceRemovalIo> = {
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
      workspaceBase,
      loadEnv: false,
      restrictedAppService: service,
      workspaceRemovalIo: removalIo,
    });
    const workspace = await createAppProject(api, "Locked source");
    await writeFile(join(workspace.rootPath, "keep-until-retry.txt"), "pending", "utf8");
    const removal = await request<{
      removed: true;
      deleted: boolean;
      cleanupPending: boolean;
    }>(api, `/api/workspaces/${workspace.id}`, { method: "DELETE" });
    assert.deepEqual(removal, { removed: true, deleted: false, rootPath: workspace.rootPath, cleanupPending: true });
    assert.equal(existsSync(workspace.rootPath), true);
    assert.equal((await service.localAppStudio(workspace.id)).project, null);
    assert.equal((await request<{ workspaces: Array<{ id: string }> }>(api, "/api/bootstrap")).workspaces.some((item) => item.id === workspace.id), false);
    assert.equal((await listPendingWorkspaceRemovals())[0]?.phase, "app-state-removed");

    await api.close();
    api = null;
    blockManagedDelete = false;
    const recoveredService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workspaceBase,
      loadEnv: false,
      restrictedAppService: recoveredService,
      workspaceRemovalIo: removalIo,
    });
    assert.equal(existsSync(workspace.rootPath), false);
    assert.deepEqual(await listPendingWorkspaceRemovals(), []);
    assert.deepEqual((await request<{ workspaces: unknown[] }>(api, "/api/bootstrap")).workspaces, []);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("startup removal recovery purges damaged Check authority before finalizing the intent", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-removal-check-state-api-"));
  const stateBase = join(sandbox, "state");
  const workspaceBase = join(sandbox, "spaces");
  let api: LocalApiHandle | null = null;
  try {
    const service = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workspaceBase,
      loadEnv: false,
      restrictedAppService: service,
    });
    const workspace = await createAppProject(api, "Damaged Check state");
    const intent = await beginWorkspaceRemoval(workspace.id, workspaceBase);
    assert.equal(intent.phase, "requested");
    const checkState = workspaceCheckStateFile(workspace.id);
    await mkdir(dirname(checkState), { recursive: true });
    await writeFile(checkState, "{damaged current state", "utf8");
    await writeFile(`${checkState}.bak`, JSON.stringify({ version: 999, authorizations: { unsafe: true } }), "utf8");

    await api.close();
    api = null;
    const recoveredService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workspaceBase,
      loadEnv: false,
      restrictedAppService: recoveredService,
    });
    assert.equal(existsSync(checkState), false);
    assert.equal(existsSync(`${checkState}.bak`), false);
    assert.deepEqual(await listPendingWorkspaceRemovals(), []);
    assert.equal(existsSync(workspace.rootPath), false);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("post-intent Check cleanup failure returns committed pending removal and recovers", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-removal-check-retry-api-"));
  const stateBase = join(sandbox, "state");
  const workspaceBase = join(sandbox, "spaces");
  let api: LocalApiHandle | null = null;
  try {
    const service = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    const checks = new WorkspaceCheckService({ kernel: new WorkspaceKernel() });
    checks.removeSpace = async () => { throw new Error("simulated Check cleanup failure"); };
    api = await startLocalApi({
      port: 0,
      stateBase,
      workspaceBase,
      loadEnv: false,
      restrictedAppService: service,
      checkService: checks,
    });
    const workspace = await createAppProject(api, "Check cleanup retry");
    const removal = await request<{ removed: true; deleted: boolean; cleanupPending: boolean }>(
      api,
      `/api/workspaces/${workspace.id}`,
      { method: "DELETE" },
    );
    assert.deepEqual(removal, { removed: true, deleted: false, rootPath: workspace.rootPath, cleanupPending: true });
    assert.equal((await listPendingWorkspaceRemovals())[0]?.phase, "requested");
    assert.deepEqual((await request<{ workspaces: unknown[] }>(api, "/api/bootstrap")).workspaces, []);

    await api.close();
    api = null;
    const recoveredService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workspaceBase,
      loadEnv: false,
      restrictedAppService: recoveredService,
    });
    assert.deepEqual(await listPendingWorkspaceRemovals(), []);
    assert.equal(existsSync(workspace.rootPath), false);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Check leases close removal and nested-Space registration races before registry mutation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-check-registry-leases-api-"));
  const stateBase = join(sandbox, "state");
  const workspaceBase = join(sandbox, "spaces");
  let api: LocalApiHandle | null = null;
  try {
    const initialService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workspaceBase,
      loadEnv: false,
      restrictedAppService: initialService,
    });
    const workspace = await createAppProject(api, "Check lease source");
    await api.close();
    api = null;

    let statusGate: Promise<void> | null = null;
    let signalStatusStarted: (() => void) | null = null;
    const checks = new WorkspaceCheckService({
      kernel: new WorkspaceKernel(),
      listSpaces: async () => {
        signalStatusStarted?.();
        if (statusGate) await statusGate;
        return [{
          id: workspace.id,
          name: "Check lease source",
          rootPath: workspace.rootPath,
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
      workspaceBase,
      loadEnv: false,
      restrictedAppService: service,
      checkService: checks,
      beforeRestrictedAppWorkspaceRevalidation: async () => {
        signalRevalidationStarted();
        await revalidationGate;
      },
    });

    const removalResponsePromise = fetch(`${api.origin}/api/workspaces/${workspace.id}`, { method: "DELETE" });
    await revalidationStarted;
    let releaseStatus!: () => void;
    statusGate = new Promise<void>((resolvePromise) => { releaseStatus = resolvePromise; });
    let signalFirstStatus!: () => void;
    const firstStatusStarted = new Promise<void>((resolvePromise) => { signalFirstStatus = resolvePromise; });
    signalStatusStarted = signalFirstStatus;
    const firstStatus = checks.status({ id: workspace.id, rootPath: workspace.rootPath });
    await firstStatusStarted;
    releaseRevalidation();
    const removalResponse = await removalResponsePromise;
    assert.equal(removalResponse.status, 409, "removal must refuse before committing an intent when late Check work owns the lease");
    assert.deepEqual(await listPendingWorkspaceRemovals(), []);
    releaseStatus();
    statusGate = null;
    signalStatusStarted = null;
    await firstStatus;

    let releaseSecondStatus!: () => void;
    statusGate = new Promise<void>((resolvePromise) => { releaseSecondStatus = resolvePromise; });
    let signalSecondStatus!: () => void;
    const secondStatusStarted = new Promise<void>((resolvePromise) => { signalSecondStatus = resolvePromise; });
    signalStatusStarted = signalSecondStatus;
    const secondStatus = checks.status({ id: workspace.id, rootPath: workspace.rootPath });
    await secondStatusStarted;
    const childRoot = join(workspace.rootPath, "Nested");
    await mkdir(childRoot);
    const registrationResponse = await fetch(`${api.origin}/api/workspaces/local-folder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootPath: childRoot }),
    });
    assert.equal(registrationResponse.status, 409, "registration cannot establish a nested boundary during evidence work");
    releaseSecondStatus();
    statusGate = null;
    signalStatusStarted = null;
    await secondStatus;

    const registered = await request<{ workspace: { rootPath: string } }>(api, "/api/workspaces/local-folder", {
      method: "POST",
      body: { rootPath: childRoot },
    });
    assert.equal(registered.workspace.rootPath, childRoot);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("final registry persistence failure keeps a retryable intent after App and folder removal", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-removal-registry-api-"));
  const stateBase = join(sandbox, "state");
  const workspaceBase = join(sandbox, "spaces");
  let blockFinalCommit = true;
  const removalIo: Partial<WorkspaceRemovalIo> = {
    async persistRegistry(registry) {
      if (blockFinalCommit && registry.pendingRemovals.length === 0) {
        throw new Error("simulated final workspace registry failure");
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
      workspaceBase,
      loadEnv: false,
      restrictedAppService: service,
      workspaceRemovalIo: removalIo,
    });
    const workspace = await createAppProject(api, "Registry source");
    const removal = await request<{ removed: true; deleted: boolean; cleanupPending: boolean }>(
      api,
      `/api/workspaces/${workspace.id}`,
      { method: "DELETE" },
    );
    assert.deepEqual(removal, { removed: true, deleted: true, rootPath: workspace.rootPath, cleanupPending: true });
    assert.equal(existsSync(workspace.rootPath), false);
    assert.equal((await service.localAppStudio(workspace.id)).project, null);
    assert.equal((await listPendingWorkspaceRemovals())[0]?.phase, "app-state-removed");

    await api.close();
    api = null;
    blockFinalCommit = false;
    const recoveredService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workspaceBase,
      loadEnv: false,
      restrictedAppService: recoveredService,
      workspaceRemovalIo: removalIo,
    });
    assert.deepEqual(await listPendingWorkspaceRemovals(), []);
    assert.deepEqual((await request<{ workspaces: unknown[] }>(api, "/api/bootstrap")).workspaces, []);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("post-intent App cleanup failure reports pending and cannot block later API startup", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-removal-app-retry-api-"));
  const stateBase = join(sandbox, "state");
  const workspaceBase = join(sandbox, "spaces");
  let api: LocalApiHandle | null = null;
  try {
    const runtime = new AutomationRecordingRuntimeHost();
    const service = await RestrictedAppService.create({
      rootPath: join(stateBase, "restricted-apps"),
      runtimeHost: runtime,
    });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workspaceBase,
      loadEnv: false,
      restrictedAppService: service,
    });
    const workspace = await createAppProject(api, "App cleanup retry");
    const packageRoot = join(workspace.rootPath, "apps", "connected-inbox");
    await cp(exampleRestrictedAppRoot, packageRoot, { recursive: true });
    const review = await service.inspect({
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      sourcePath: "apps/connected-inbox",
    });
    await service.install({
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });
    await service.setAutomationEnabled({
      workspaceId: workspace.id,
      appId: "restricted-connected-inbox",
      expectedDigest: review.digest,
      automationId: "refresh-inbox",
      enabled: true,
    });
    assert.equal(runtime.authorities.length, 1);
    service.removeWorkspace = async () => { throw new Error("simulated App cleanup failure"); };
    const removal = await request<{ removed: true; deleted: boolean; cleanupPending: boolean }>(
      api,
      `/api/workspaces/${workspace.id}`,
      { method: "DELETE" },
    );
    assert.deepEqual(removal, { removed: true, deleted: false, rootPath: workspace.rootPath, cleanupPending: true });
    assert.equal((await listPendingWorkspaceRemovals())[0]?.phase, "requested");
    assert.equal(existsSync(workspace.rootPath), true);
    assert.deepEqual(runtime.authorities, [], "the durable removal intent must fence live broker authority");
    await assert.rejects(service.runAutomationNow({
      workspaceId: workspace.id,
      appId: "restricted-connected-inbox",
      expectedDigest: review.digest,
      automationId: "refresh-inbox",
    }), /Automations are not active for this Space/);
    assert.equal(runtime.automationRuns, 0, "the fenced Space cannot launch another automation");

    await api.close();
    api = null;
    const stillFailingService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    stillFailingService.removeWorkspace = async () => { throw new Error("simulated startup retry failure"); };
    api = await startLocalApi({
      port: 0,
      stateBase,
      workspaceBase,
      loadEnv: false,
      restrictedAppService: stillFailingService,
    });
    assert.deepEqual((await request<{ workspaces: unknown[] }>(api, "/api/bootstrap")).workspaces, []);
    assert.equal((await listPendingWorkspaceRemovals())[0]?.phase, "requested");

    await api.close();
    api = null;
    const recoveredService = await RestrictedAppService.create({ rootPath: join(stateBase, "restricted-apps") });
    api = await startLocalApi({
      port: 0,
      stateBase,
      workspaceBase,
      loadEnv: false,
      restrictedAppService: recoveredService,
    });
    assert.equal(existsSync(workspace.rootPath), false);
    assert.deepEqual(await listPendingWorkspaceRemovals(), []);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Local API owns first automation startup and removes a pending Space before a due job can launch", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-removal-deferred-automation-api-"));
  const stateBase = join(sandbox, "state");
  const workspaceBase = join(sandbox, "spaces");
  const restrictedAppRoot = join(stateBase, "restricted-apps");
  const setupTime = new Date("2026-07-15T12:00:00.000Z");
  const recoveryTime = new Date("2026-07-15T13:00:00.000Z");
  let api: LocalApiHandle | null = null;
  let service: RestrictedAppService | null = null;
  let occupiedPortServer: NetServer | null = null;
  try {
    configureWorkspaceStateRoot(stateBase);
    const workspace = await createManagedWorkspace("Pending automated Space", workspaceBase);
    const packageRoot = join(workspace.rootPath, "apps", "connected-inbox");
    await cp(exampleRestrictedAppRoot, packageRoot, { recursive: true });

    const setupRuntime = new AutomationRecordingRuntimeHost();
    service = await RestrictedAppService.create({
      rootPath: restrictedAppRoot,
      runtimeHost: setupRuntime,
      now: () => setupTime,
      deferAutomationStart: false,
    });
    const review = await service.inspect({
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      sourcePath: "apps/connected-inbox",
    });
    await service.install({
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });
    await service.setAutomationEnabled({
      workspaceId: workspace.id,
      appId: "restricted-connected-inbox",
      expectedDigest: review.digest,
      automationId: "refresh-inbox",
      enabled: true,
    });
    await service.close();
    service = null;

    await beginWorkspaceRemoval(workspace.id, workspaceBase);

    const rejectedRuntime = new AutomationRecordingRuntimeHost();
    const alreadyStarted = await RestrictedAppService.create({
      rootPath: restrictedAppRoot,
      runtimeHost: rejectedRuntime,
      now: () => recoveryTime,
      deferAutomationStart: false,
    });
    await assert.rejects(startLocalApi({
      port: 0,
      stateBase,
      workspaceBase,
      loadEnv: false,
      restrictedAppService: alreadyStarted,
    }), /automation startup is still deferred/i,
    "the Local API must never accept a service that could have launched jobs before recovery");
    await alreadyStarted.close();
    assert.equal(rejectedRuntime.automationRuns, 0);
    assert.equal((await listPendingWorkspaceRemovals()).length, 1,
      "rejecting unsafe composition must not consume the pending removal intent");

    const runtime = new AutomationRecordingRuntimeHost();
    service = await RestrictedAppService.create({
      rootPath: restrictedAppRoot,
      runtimeHost: runtime,
      now: () => recoveryTime,
    });
    assert.equal(service.automationsStarted, false, "service construction is deferred by default");

    occupiedPortServer = createNetServer();
    await listenOnEphemeralPort(occupiedPortServer);
    const occupiedPort = (occupiedPortServer.address() as AddressInfo).port;
    await assert.rejects(startLocalApi({
      port: occupiedPort,
      stateBase,
      workspaceBase,
      loadEnv: false,
      restrictedAppService: service,
    }), (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
    "a failed socket bind must reject startup");
    assert.equal(service.automationsStarted, false,
      "a failed socket bind must not leave the scheduler running without an API handle");
    assert.equal(runtime.automationRuns, 0, "a due job must remain inert after failed API startup");
    await closeNetServer(occupiedPortServer);
    occupiedPortServer = null;

    api = await startLocalApi({
      port: 0,
      stateBase,
      workspaceBase,
      loadEnv: false,
      restrictedAppService: service,
    });
    assert.equal(service.automationsStarted, true, "the Local API starts jobs only after recovery");
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(runtime.automationRuns, 0, "the due job from the removed Space must never launch");
    assert.deepEqual(await service.list(workspace.id), []);
    assert.deepEqual(await listPendingWorkspaceRemovals(), []);
    assert.equal(existsSync(workspace.rootPath), false);
  } finally {
    await api?.close().catch(() => undefined);
    if (!api) await service?.close().catch(() => undefined);
    if (occupiedPortServer) await closeNetServer(occupiedPortServer).catch(() => undefined);
    configureWorkspaceStateRoot(undefined);
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

async function createAppProject(api: LocalApiHandle, name: string): Promise<{ id: string; rootPath: string }> {
  const { workspace } = await request<{ workspace: { id: string; rootPath: string } }>(api, "/api/workspaces", {
    method: "POST",
    body: { name },
  });
  await request(api, `/api/workspaces/${workspace.id}/app-studio`, {
    method: "PUT",
    body: { title: `${name} App`, description: null, icon: null },
  });
  return workspace;
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

async function persistRegistryForTest(registry: WorkspaceRegistry): Promise<void> {
  const file = workspaceRegistryFile();
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.test.tmp`;
  await writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

class AutomationRecordingRuntimeHost implements RestrictedAppRuntimeHost {
  automationRuns = 0;
  authorities: RestrictedAppRuntimeAuthority[] = [];

  syncAuthority(authorities: readonly RestrictedAppRuntimeAuthority[]): void {
    this.authorities = structuredClone(authorities);
  }
  async invoke(): Promise<unknown> { return {}; }
  async runAutomation(): Promise<void> { this.automationRuns += 1; }
  async stop(): Promise<void> {}
  async close(): Promise<void> {}
}
