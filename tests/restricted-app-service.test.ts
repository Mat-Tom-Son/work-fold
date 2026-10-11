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
  installationNeeds,
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

const workFolderOne = "ws-1111111111111111";
const workFolderTwo = "ws-2222222222222222";
const workFolderThree = "ws-3333333333333333";
const refreshAppAutomation = "refresh-mail";
const exportAppAutomation = "export-digest";

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
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({ rootPath });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });

    assert.equal(review.packageName, "connected-inbox");
    assert.equal(review.manifest.id, "connected-inbox");
    assert.equal(review.manifest.runtime.entry, "index.html");
    assert.equal(review.manifest.runtime.worker, "worker.js");
    assert.match(review.digest, /^[0-9a-f]{64}$/);
    assert.ok(review.fileCount >= 4);
    assert.ok(review.totalBytes > 0);

    await assert.rejects(
      service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: "0".repeat(64) }),
      /changed after review/i,
    );

    const installed = await service.install({
      workFolderId: workFolderOne,
      workFolderRoot,
      sourcePath: "apps/inbox",
      expectedDigest: review.digest,
    });
    assert.equal(installed.digest, review.digest);
    assert.equal(installed.workFolderId, workFolderOne);
    assert.deepEqual(installed.networkGrants, ["mail-api"], "an installed app reaches every declared destination");
    assert.deepEqual(installed.fileGrants, [{ id: "exports", declarationId: "exports", root: ".", access: "read-write" }], "a directory permission binds to the whole work-folder");
    assert.deepEqual(installed.notificationGrants, ["new-mail"], "every notification category is on");
    assert.deepEqual(installed.automations, [
      { id: refreshAppAutomation, enabled: true },
      { id: exportAppAutomation, enabled: true },
    ], "every declared automation is on (no next run while the scheduler is deferred)");
    assert.equal("stagedRoot" in installed, false, "app-data staging paths must remain internal");
    assert.equal(existsSync(join(rootPath, "staged", review.digest, "worker.js")), true);
    assert.match(await readFile(join(rootPath, "staged", review.digest, "worker.js"), "utf8"), /must remain inert/);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("install defaults bind a Check slot only to a work-folder's single Check, leave file-target permissions for the person, and report every need", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-defaults-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const checksByWorkFolder = new Map<string, Array<{ checkId: string; declarationDigest: string; title: string }>>([
    [workFolderOne, [{ checkId: "quote-review", declarationDigest: "a".repeat(64), title: "Quote review" }]],
    [workFolderTwo, [
      { checkId: "quote-review", declarationDigest: "a".repeat(64), title: "Quote review" },
      { checkId: "tone", declarationDigest: "b".repeat(64), title: "Tone" },
    ]],
  ]);
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"), {
      checks: [{ id: "review-slot", title: "Review result" }, { id: "second-slot", title: "Second result" }],
      files: [{ id: "exports", target: "directory", access: "read-write" }, { id: "ledger", target: "file", access: "read" }],
    });
    const service = await RestrictedAppService.create({ rootPath, listChecks: async (workFolderId) => checksByWorkFolder.get(workFolderId) ?? [] });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    const single = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    assert.deepEqual(single.checkGrants, [
      { permissionId: "review-slot", title: "Quote review", checkId: "quote-review", declarationDigest: "a".repeat(64) },
      { permissionId: "second-slot", title: "Quote review", checkId: "quote-review", declarationDigest: "a".repeat(64) },
    ], "exactly one registered Check binds every declared slot");
    assert.deepEqual(single.fileGrants, [{ id: "exports", declarationId: "exports", root: ".", access: "read-write" }], "a file-target permission waits for a chosen file");
    assert.deepEqual(installationNeeds(single, await service.connectionStatus(workFolderOne, "connected-inbox", single.digest)), {
      connections: ["mail-api"],
      files: ["ledger"],
      checks: [],
    }, "the api-key destination and the file choice still need the person");

    const ambiguous = await service.install({ workFolderId: workFolderTwo, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    assert.equal(ambiguous.checkGrants, undefined, "two Checks bind nothing; the person chooses in Apps");
    assert.deepEqual(installationNeeds(ambiguous, []).checks, ["review-slot", "second-slot"]);

    const chosen = await service.grantFiles({
      workFolderId: workFolderOne, workFolderRoot, appId: "connected-inbox", expectedDigest: single.digest, permissionId: "ledger", root: "apps/inbox/package.json",
    });
    assert.deepEqual(installationNeeds(chosen, [{ destinationId: "mail-api", owner: "instance", kind: "api-key", configured: true }] as any).files, []);
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

test("RestrictedAppService persists work-folder-scoped installs and keeps shared staged bytes until the last removal", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-persistence-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    const firstRuntime = new RecordingRuntimeHost();
    const first = await RestrictedAppService.create({
      rootPath,
      runtimeHost: firstRuntime,
      deferAppAutomationStart: false,
    });
    const review = await first.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await first.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await first.install({ workFolderId: workFolderTwo, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    const enabledApp = await first.setAppAutomationEnabled({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
      enabled: true,
    });
    const enabledNextRunAt = enabledApp.automations.find(({ id }) => id === refreshAppAutomation)?.nextRunAt;
    assert.ok(enabledNextRunAt, "enabling establishes a durable first cadence point");
    const registryAfterEnable = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      installations: Array<{ workFolderId: string; automations: Array<{ id: string; lastScheduledAt?: string }> }>;
    };
    const enabledCadenceAnchor = registryAfterEnable.installations.find(({ workFolderId }) => workFolderId === workFolderOne)
      ?.automations.find(({ id }) => id === refreshAppAutomation)?.lastScheduledAt;
    assert.ok(enabledCadenceAnchor);
    const persistedRun = await first.runAppAutomationNow({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
    });
    assert.equal(persistedRun.run.outcome, "success");
    const registryAfterManualRun = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      installations: Array<{ workFolderId: string; automations: Array<{ id: string; lastScheduledAt?: string }> }>;
    };
    assert.equal(
      registryAfterManualRun.installations.find(({ workFolderId }) => workFolderId === workFolderOne)
        ?.automations.find(({ id }) => id === refreshAppAutomation)?.lastScheduledAt,
      enabledCadenceAnchor,
      "a manual run must not move the durable recurring cadence",
    );
    assert.equal((await first.list(workFolderOne)).length, 1);
    assert.equal((await first.list(workFolderTwo)).length, 1);
    assert.deepEqual(await first.list("ws-3333333333333333"), []);
    await first.close();

    const secondRuntime = new RecordingRuntimeHost();
    const reopened = await RestrictedAppService.create({
      rootPath,
      runtimeHost: secondRuntime,
      deferAppAutomationStart: false,
    });
    const reopenedApp = (await reopened.list(workFolderOne))[0];
    assert.equal(reopenedApp?.digest, review.digest);
    assert.equal(reopenedApp?.automations.find(({ id }) => id === refreshAppAutomation)?.enabled, true);
    assert.ok(reopenedApp?.automations.find(({ id }) => id === refreshAppAutomation)?.lastRunAt);
    assert.equal(
      reopenedApp?.automations.find(({ id }) => id === refreshAppAutomation)?.nextRunAt,
      enabledNextRunAt,
      "restarting before the first scheduled run must preserve its due time",
    );
    assert.deepEqual(
      await reopened.listAppAutomationRuns(workFolderOne, "connected-inbox", review.digest, refreshAppAutomation),
      [persistedRun.run],
      "automation receipts and enabled state must survive service restart",
    );
    assert.equal((await reopened.list(workFolderTwo))[0]?.digest, review.digest);

    assert.equal(await reopened.remove({ workFolderId: workFolderOne, appId: "connected-inbox", expectedDigest: review.digest }), true);
    assert.equal(existsSync(join(rootPath, "staged", review.digest)), true, "another work-folder still references the digest");
    assert.deepEqual(await reopened.list(workFolderOne), []);
    assert.equal((await reopened.list(workFolderTwo)).length, 1);

    assert.equal(await reopened.remove({ workFolderId: workFolderTwo, appId: "connected-inbox", expectedDigest: review.digest }), true);
    assert.equal(existsSync(join(rootPath, "staged", review.digest)), false, "the last removal should collect staged bytes");
    assert.deepEqual(secondRuntime.stops.map(({ workFolderId }) => workFolderId), [workFolderOne, workFolderTwo]);
    await reopened.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("deferred automation startup keeps excluded work-folders inert and starts other persisted jobs exactly once", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-deferred-automations-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    service = await RestrictedAppService.create({ rootPath, runtimeHost: new RecordingRuntimeHost() });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.install({ workFolderId: workFolderTwo, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    for (const workFolderId of [workFolderOne, workFolderTwo]) {
      await service.setAppAutomationEnabled({
        workFolderId,
        appId: "connected-inbox",
        expectedDigest: review.digest,
        appAutomationId: refreshAppAutomation,
        enabled: true,
      });
    }
    await service.close();
    service = undefined;

    const runtime = new RecordingRuntimeHost();
    service = await RestrictedAppService.create({ rootPath, runtimeHost: runtime, deferAppAutomationStart: true });
    assert.equal((await service.list(workFolderOne))[0]?.automations[0]?.nextRunAt, undefined);
    assert.equal((await service.list(workFolderTwo))[0]?.automations[0]?.nextRunAt, undefined);

    service.startAppAutomations([workFolderOne]);
    service.startAppAutomations([workFolderOne]);

    assert.equal((await service.list(workFolderOne))[0]?.automations[0]?.nextRunAt, undefined);
    assert.ok((await service.list(workFolderTwo))[0]?.automations[0]?.nextRunAt);
    await assert.rejects(service.runAppAutomationNow({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
    }), (error: unknown) => error instanceof Error && "code" in error && error.code === "APP_UNAVAILABLE");
    const run = await service.runAppAutomationNow({
      workFolderId: workFolderTwo,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
    });
    assert.equal(run.run.outcome, "success");
    assert.equal(runtime.appAutomationRuns.length, 1);

    service.startAppAutomations([workFolderTwo]);
    assert.equal((await service.list(workFolderTwo))[0]?.automations[0]?.nextRunAt, undefined,
      "a later exclusion may make another work-folder inert but cannot reactivate an earlier exclusion");
  } finally {
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService rejects an old branded registry without importing or rewriting it", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-old-registry-"));
  const rootPath = join(sandbox, "state", "restricted-apps");
  const registryPath = join(rootPath, "registry.json");
  const oldRegistry = `${JSON.stringify({ schemaVersion: 2, apps: [{ workFolderId: workFolderOne }] }, null, 2)}\n`;
  try {
    await mkdir(rootPath, { recursive: true });
    await writeFile(registryPath, oldRegistry, "utf8");
    await assert.rejects(
      RestrictedAppService.create({ rootPath }),
      (error) => error instanceof RestrictedAppRegistryVersionUnsupportedError
        && error.actualVersion === 2
        && error.supportedVersion === 6,
    );
    assert.equal(await readFile(registryPath, "utf8"), oldRegistry);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService advances only the durable authority domains affected by each local lifecycle mutation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-authority-domains-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const sourceRoot = join(workFolderRoot, "apps", "inbox");
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
    const firstReview = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    const installed = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: firstReview.digest });

    const repeatedGrant = await service.grantNetwork({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: firstReview.digest,
      destinationId: "mail-api",
    });
    assert.deepEqual(repeatedGrant.authority, installed.authority, "granting an already-on destination does not create a false authority transition");
    const granted = await service.revokeNetwork({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: firstReview.digest,
      destinationId: "mail-api",
    });
    assert.deepEqual(changedAuthorityFields(installed.authority, granted.authority), ["grantGeneration"]);

    await service.setConnection({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: firstReview.digest,
      destinationId: "mail-api",
      credential: { kind: "api-key", value: "secret" },
    });
    const connected = (await service.list(workFolderOne))[0]!;
    assert.deepEqual(changedAuthorityFields(granted.authority, connected.authority), ["connectionGeneration"]);

    const enabled = await service.setAppAutomationEnabled({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: firstReview.digest,
      appAutomationId: refreshAppAutomation,
      enabled: false,
    });
    assert.deepEqual(changedAuthorityFields(connected.authority, enabled.authority), ["jobGeneration"]);

    await storage.set(platformStorageOwner(installed), "temporary", true);
    await service.clearStorage(workFolderOne, "connected-inbox", firstReview.digest);
    const cleared = (await service.list(workFolderOne))[0]!;
    assert.deepEqual(changedAuthorityFields(enabled.authority, cleared.authority), ["dataGeneration"]);

    await writePackage(sourceRoot, { version: "0.2.0" });
    const secondReview = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    const updated = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: secondReview.digest });
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

    await service.remove({ workFolderId: workFolderOne, appId: "connected-inbox", expectedDigest: secondReview.digest });
    const reinstalled = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: secondReview.digest });
    assert.equal(reinstalled.projectId, installed.projectId, "Feature uninstall does not erase the App Project");
    assert.equal(reinstalled.runtimeInstanceId, installed.runtimeInstanceId, "Feature uninstall does not replace the Development Instance");
    assert.notEqual(reinstalled.featureInstallationId, installed.featureInstallationId, "reinstall creates a new incarnation");
    assert.notEqual(reinstalled.dataNamespaceId, installed.dataNamespaceId, "reinstall cannot revive removed data implicitly");
    await assert.rejects(service.runtimeDescriptor(workFolderOne, "connected-inbox", secondReview.digest, installed.featureInstallationId), { code: "APP_UNAVAILABLE" });
    await assert.rejects(service.runtimeDescriptor(workFolderTwo, "connected-inbox", secondReview.digest, reinstalled.featureInstallationId), { code: "APP_UNAVAILABLE" });
    assert.equal((await service.runtimeDescriptor(workFolderOne, "connected-inbox", secondReview.digest, reinstalled.featureInstallationId)).featureInstallationId, reinstalled.featureInstallationId);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService keeps installs idempotent, repairs missing staged bytes, and prevents app-id takeover", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-update-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const sourceRoot = join(workFolderRoot, "apps", "inbox");
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
    const firstReview = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    const firstInstall = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: firstReview.digest });
    const repeated = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: firstReview.digest });
    assert.deepEqual(repeated, firstInstall);
    assert.deepEqual(runtime.stops, []);

    await rm(join(rootPath, "staged", firstReview.digest), { recursive: true, force: true });
    const repaired = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: firstReview.digest });
    assert.equal(repaired.digest, firstReview.digest);
    assert.equal(existsSync(join(rootPath, "staged", firstReview.digest, "worker.js")), true, "idempotent install must restore a missing staged snapshot");

    await service.setConnection({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: firstReview.digest,
      destinationId: "mail-api",
      credential: { kind: "api-key", value: "secret-before-update" },
    });
    await writePackage(sourceRoot, {
      version: "0.2.0",
      appSource: "export async function handleAction() { return { count: 2 }; }\nexport async function handleAutomation() {}\n",
    });
    const updateReview = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    const updated = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: updateReview.digest });
    assert.equal(updated.installedAt, firstInstall.installedAt);
    assert.notEqual(updated.updatedAt, firstInstall.updatedAt);
    assert.deepEqual(runtime.stops.slice(0, 2), [
      { workFolderId: workFolderOne, appId: "connected-inbox", digest: firstReview.digest },
      { workFolderId: workFolderOne, appId: "connected-inbox", digest: firstReview.digest },
    ], "the connection change and the update stop the old runtime owner");
    assert.equal(existsSync(join(rootPath, "staged", firstReview.digest)), false);
    assert.equal(connections.carriedForward.length, 1);
    assert.deepEqual(connections.carriedForward[0]!.kept, ["mail-api"], "a byte-identical destination declaration carries its connection");
    assert.equal(connections.carriedForward[0]!.to.featureRevisionDigest, updateReview.artifactDigest);
    assert.deepEqual(await connections.get(platformConnectionBinding(updated)), { kind: "api-key", value: "secret-before-update" });
    assert.equal((await service.connectionStatus(workFolderOne, "connected-inbox", updateReview.digest))[0]?.configured, true);
    assert.deepEqual(connections.deletedFeatures, [{
      tenantId: firstInstall.tenantId,
      runtimeInstanceId: firstInstall.runtimeInstanceId,
      featureId: firstInstall.manifest.id,
      featureInstallationId: firstInstall.featureInstallationId,
      featureRevisionDigest: firstReview.artifactDigest,
    }], "the emptied predecessor scope is still cleaned up");

    await writePackage(sourceRoot, { version: "0.3.0", networkMethods: ["GET", "POST"] });
    const changedReview = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    const changed = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: changedReview.digest });
    assert.deepEqual(connections.carriedForward[1]!.kept, [], "a changed destination declaration drops its connection");
    assert.equal(await connections.get(platformConnectionBinding(changed)), undefined);
    assert.equal((await service.connectionStatus(workFolderOne, "connected-inbox", changedReview.digest))[0]?.configured, false);
    assert.deepEqual(changed.networkGrants, ["mail-api"], "the grant itself carries by id");

    await writePackage(join(workFolderRoot, "apps", "takeover"), { packageName: "different-package" });
    const takeover = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/takeover" });
    await assert.rejects(
      service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/takeover", expectedDigest: takeover.digest }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /different package already owns/i.test(errorMessage(error)),
    );
    assert.equal((await service.list(workFolderOne))[0]?.digest, changedReview.digest);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService durably retries post-activation cleanup after restart", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-cleanup-retry-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const sourceRoot = join(workFolderRoot, "apps", "inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const connections = new FlakyConnectionStore();
  try {
    await writePackage(sourceRoot);
    let service = await RestrictedAppService.create({ rootPath, connections });
    const first = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: first.digest });
    await service.setConnection({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: first.digest,
      destinationId: "mail-api",
      credential: { kind: "api-key", value: "predecessor-secret" },
    });

    // A changed destination declaration drops its connection: the retired scope's
    // record is removed by the durable cleanup, not carried forward.
    await writePackage(sourceRoot, { version: "0.2.0", networkMethods: ["GET", "POST"] });
    const second = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    connections.failNextFeatureDelete = true;
    const updated = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: second.digest });
    assert.equal(updated.digest, second.digest, "activation succeeds once stale authority is durably unreachable");
    assert.equal(connections.records.size, 1, "failed physical cleanup remains pending rather than rolling back activation");
    assert.equal((await service.connectionStatus(workFolderOne, "connected-inbox", second.digest))[0]?.configured, false, "the successor never reads the retired record");
    let registry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as { pendingCleanups: unknown[] };
    assert.equal(registry.pendingCleanups.length, 1);
    await service.close();

    service = await RestrictedAppService.create({ rootPath, connections });
    assert.equal(connections.records.size, 0, "startup retries the exact predecessor cleanup idempotently");
    registry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as { pendingCleanups: unknown[] };
    assert.equal(registry.pendingCleanups.length, 0);
    assert.equal((await service.list(workFolderOne))[0]?.digest, second.digest);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService durably retries uninstall data purge without reviving the installation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-purge-retry-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const storage = new FlakyFileStorage(join(rootPath, "data"));
  const connections = new MemoryConnectionStore();
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    let service = await RestrictedAppService.create({ rootPath, storage, connections });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    const installed = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    const owner = platformStorageOwner(installed);
    await storage.set(owner, "retained-until-purge", { value: true });
    storage.failNextDelete = true;

    assert.equal(await service.remove({ workFolderId: workFolderOne, appId: "connected-inbox", expectedDigest: review.digest }), true);
    assert.deepEqual(await service.list(workFolderOne), [], "logical uninstall is never rolled back after authority is fenced");
    assert.equal((await storage.usage(owner)).keyCount, 1, "failed physical purge remains durably pending");
    await service.close();

    service = await RestrictedAppService.create({ rootPath, storage, connections });
    assert.equal((await storage.usage(owner)).keyCount, 0, "startup completes the exact pending data purge");
    const registry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as { pendingCleanups: unknown[] };
    assert.equal(registry.pendingCleanups.length, 0);
    assert.deepEqual(await service.list(workFolderOne), []);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService binds connections to explicit Tenant, Runtime Instance, Feature, revision, declaration, target, and owner", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-runtime-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new RecordingRuntimeHost();
  const connections = new MemoryConnectionStore();
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({ rootPath, runtimeHost: runtime, connections });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    const installed = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });

    assert.deepEqual(await service.connectionStatus(workFolderOne, "connected-inbox", review.digest), [{
      destinationId: "mail-api",
      owner: "instance",
      kind: null,
      configured: false,
    }]);
    const credential = { kind: "api-key" as const, value: "secret-value" };
    assert.deepEqual(await service.setConnection({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      destinationId: "mail-api",
      credential,
    }), { destinationId: "mail-api", owner: "instance", kind: "api-key", configured: true });
    assert.deepEqual(connections.setBindings, [{
      binding: platformConnectionBinding(installed),
      credential,
    }]);
    assert.deepEqual(await service.connectionStatus(workFolderOne, "connected-inbox", review.digest), [{
      destinationId: "mail-api",
      owner: "instance",
      kind: "api-key",
      configured: true,
    }]);

    assert.deepEqual(installed.networkGrants, ["mail-api"], "the destination is reachable from the install");
    assert.deepEqual((await service.list(workFolderOne))[0]?.networkGrants, ["mail-api"], "the default grant is durable");

    const result = await service.invoke({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      action: "search",
      input: { query: "invoice" },
    });
    assert.deepEqual(result, { count: 7 });
    assert.equal(runtime.invocations.length, 1);
    assert.equal(runtime.invocations[0]?.app.workFolderId, workFolderOne);
    assert.equal(runtime.invocations[0]?.app.digest, review.digest);
    assert.deepEqual(runtime.invocations[0]?.app.networkGrants, ["mail-api"]);
    assert.equal(runtime.invocations[0]?.app.stagedRoot, join(rootPath, "staged", review.digest));
    assert.equal(isAbsolute(runtime.invocations[0]?.app.stagedRoot ?? ""), true);
    assert.equal(runtime.invocations[0]?.action, "search");
    assert.deepEqual(runtime.invocations[0]?.input, { query: "invoice" });

    await assert.rejects(
      service.invoke({ workFolderId: workFolderOne, appId: "connected-inbox", expectedDigest: review.digest, action: "undeclared", input: {} }),
      (error: unknown) => errorCode(error) === "ACTION_UNKNOWN",
    );
    const revoked = await service.revokeNetwork({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      destinationId: "mail-api",
    });
    assert.deepEqual(revoked.networkGrants, []);
    assert.deepEqual(runtime.stops, [
      { workFolderId: workFolderOne, appId: "connected-inbox", digest: review.digest },
      { workFolderId: workFolderOne, appId: "connected-inbox", digest: review.digest },
    ], "credential replacement and revoke stop the old runtime owner before changing its authority");
    assert.equal(await service.deleteConnection({
      workFolderId: workFolderOne,
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

test("RestrictedAppService scopes automation powers and carries grants, automation state, run receipts, and byte-identical connections across a preview digest change", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-powers-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const sourceRoot = join(workFolderRoot, "apps", "inbox");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(rootPath, "data"));
  const runtime = new RecordingRuntimeHost();
  try {
    await writePackage(sourceRoot);
    const service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: runtime,
      storage,
      deferAppAutomationStart: false,
    });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    const installed = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    const owner = platformStorageOwner(installed);
    await storage.set(owner, "view", { folder: "inbox" });

    assert.deepEqual(installed.fileGrants, [{ id: "exports", declarationId: "exports", root: ".", access: "read-write" }], "the directory permission starts over the whole work-folder");
    await assert.rejects(service.grantFiles({
      workFolderId: workFolderOne,
      workFolderRoot,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      permissionId: "exports",
      root: "missing-reports",
    }), (error: unknown) => errorCode(error) === "FILE_DENIED");
    await mkdir(join(workFolderRoot, "reports"), { recursive: true });

    const withFiles = await service.grantFiles({
      workFolderId: workFolderOne,
      workFolderRoot,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      permissionId: "exports",
      root: "reports",
    });
    assert.deepEqual(withFiles.fileGrants, [{ id: "exports", declarationId: "exports", root: "reports", access: "read-write" }], "granting again with a folder narrows the whole-work-folder default");
    assert.deepEqual(changedAuthorityFields(installed.authority, withFiles.authority), ["grantGeneration"]);
    assert.deepEqual(withFiles.notificationGrants, ["new-mail"]);
    assert.deepEqual(withFiles.networkGrants, ["mail-api"]);
    assert.ok(withFiles.automations.every((automation) => automation.enabled && automation.nextRunAt), "every automation is on with a scheduled next run");
    const refreshed = await service.runAppAutomationNow({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
    });
    const exported = await service.runAppAutomationNow({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: exportAppAutomation,
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
    assert.equal(runtime.appAutomationRuns.length, 2);
    assert.equal(runtime.appAutomationRuns[0]?.event.reason, "manual");
    assert.deepEqual(runtime.appAutomationRuns[0]?.event.effectivePrincipal, refreshed.run.effectivePrincipal);
    assert.equal(runtime.appAutomationRuns[0]?.event.appAutomationId, refreshAppAutomation);
    assert.equal(runtime.appAutomationRuns[0]?.event.handler, "refresh-inbox");
    assert.deepEqual(runtime.appAutomationRuns[0]?.app.networkGrants, ["mail-api"]);
    assert.deepEqual(runtime.appAutomationRuns[0]?.app.fileGrants, []);
    assert.deepEqual(runtime.appAutomationRuns[0]?.app.notificationGrants, ["new-mail"]);
    assert.deepEqual(runtime.appAutomationRuns[0]?.app.automations.map(({ id }) => id), [refreshAppAutomation]);
    assert.equal(runtime.appAutomationRuns[1]?.event.handler, "export-digest");
    assert.equal(runtime.appAutomationRuns[1]?.event.appAutomationId, exportAppAutomation);
    assert.deepEqual(runtime.appAutomationRuns[1]?.app.networkGrants, []);
    assert.deepEqual(runtime.appAutomationRuns[1]?.app.fileGrants, [{ id: "exports", declarationId: "exports", root: "reports", access: "read-write" }]);
    assert.deepEqual(runtime.appAutomationRuns[1]?.app.notificationGrants, []);
    assert.deepEqual(runtime.appAutomationRuns[1]?.app.automations.map(({ id }) => id), [exportAppAutomation]);
    assert.deepEqual(await service.listAppAutomationRuns(workFolderOne, "connected-inbox", review.digest, refreshAppAutomation), [refreshed.run]);
    assert.deepEqual(await service.listAppAutomationRuns(workFolderOne, "connected-inbox", review.digest, exportAppAutomation), [exported.run]);

    await writePackage(sourceRoot, {
      version: "0.2.0",
      appSource: "export async function handleAction() { return { count: 2 }; }\nexport async function handleAutomation() {}\n",
    });
    await service.revokeNotifications({ workFolderId: workFolderOne, appId: "connected-inbox", expectedDigest: review.digest, permissionId: "new-mail" });
    await service.setAppAutomationEnabled({ workFolderId: workFolderOne, appId: "connected-inbox", expectedDigest: review.digest, appAutomationId: exportAppAutomation, enabled: false });
    const nextReview = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    const updated = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: nextReview.digest });
    assert.deepEqual(updated.fileGrants, [{ id: "exports", declarationId: "exports", root: "reports", access: "read-write" }], "the chosen folder carries when the declaration is unchanged");
    assert.deepEqual(updated.notificationGrants, [], "a revocation survives the code change");
    assert.deepEqual(updated.networkGrants, ["mail-api"]);
    assert.equal(updated.automations.find(({ id }) => id === refreshAppAutomation)?.enabled, true);
    assert.equal(updated.automations.find(({ id }) => id === exportAppAutomation)?.enabled, false, "a disabled automation stays disabled");
    assert.deepEqual(await service.listAppAutomationRuns(workFolderOne, "connected-inbox", nextReview.digest, refreshAppAutomation), [refreshed.run], "run history carries across revisions");
    assert.deepEqual(await service.listAppAutomationRuns(workFolderOne, "connected-inbox", nextReview.digest, exportAppAutomation), [exported.run]);
    assert.equal(refreshed.run.featureRevisionDigest, review.artifactDigest, "a carried receipt still names its own revision");
    const updatedRegistry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      installations: Array<{ appAutomationRuns: Array<{ packageDigest: string; verification: string }> }>;
      acceptedAppAutomationRuns: unknown[];
      historicalAppAutomationRuns: Array<{ runId: string; state: string; acceptedAt: string; scheduledAt: string }>;
    };
    assert.equal(updatedRegistry.installations[0]?.appAutomationRuns.length, 2, "the new revision keeps the predecessor's receipts");
    assert.deepEqual(updatedRegistry.acceptedAppAutomationRuns, []);
    assert.equal(updatedRegistry.historicalAppAutomationRuns.length, 2);
    assert.equal(updatedRegistry.historicalAppAutomationRuns.every((run) => run.state === "succeeded"), true);
    assert.equal(
      updatedRegistry.historicalAppAutomationRuns.every((run) => Date.parse(run.acceptedAt) >= Date.parse(run.scheduledAt)),
      true,
      "acceptedAt is the durable host acceptance time, not a copied cadence timestamp",
    );
    assert.deepEqual(await storage.get(owner, "view"), { folder: "inbox" }, "same app storage survives a reviewed digest update");

    await service.close();
    const reopened = await RestrictedAppService.create({ rootPath, runtimeHost: runtime, storage });
    assert.deepEqual(
      await reopened.listAppAutomationRuns(workFolderOne, "connected-inbox", nextReview.digest, refreshAppAutomation),
      [refreshed.run],
      "a restart after update keeps the carried receipts",
    );
    await reopened.remove({ workFolderId: workFolderOne, appId: "connected-inbox", expectedDigest: nextReview.digest });
    const removedRegistry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      historicalAppAutomationRuns: Array<{ runId: string }>;
    };
    assert.equal(removedRegistry.historicalAppAutomationRuns.length, 2, "uninstall cannot erase the independent audit ledger");
    assert.equal((await storage.usage(owner)).keyCount, 0, "uninstall deletes machine-local app storage");
    await reopened.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService removes machine-local app state for only the removed work-folder", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-work-folder-removal-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(rootPath, "data"));
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({ rootPath, storage });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    const installedOne = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    const installedTwo = await service.install({ workFolderId: workFolderTwo, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    const ownerOne = platformStorageOwner(installedOne);
    const ownerTwo = platformStorageOwner(installedTwo);
    await storage.set(ownerOne, "owner", "one");
    await storage.set(ownerTwo, "owner", "two");

    await service.removeWorkFolder(workFolderOne);
    assert.deepEqual(await service.list(workFolderOne), []);
    assert.equal((await storage.usage(ownerOne)).keyCount, 0);
    assert.equal(await storage.get(ownerTwo, "owner"), "two");
    assert.equal((await service.list(workFolderTwo)).length, 1);
    assert.equal(existsSync(join(rootPath, "staged", review.digest)), true);

    await service.removeWorkFolder(workFolderTwo);
    assert.equal((await storage.usage(ownerTwo)).keyCount, 0);
    assert.equal(existsSync(join(rootPath, "staged", review.digest)), false);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService revokes an empty work-folder's persisted Project and Development Instance context", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-empty-work-folder-removal-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({ rootPath });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.remove({ workFolderId: workFolderOne, appId: "connected-inbox", expectedDigest: review.digest });

    const before = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      projects: Array<{ workFolderId: string }>;
      runtimeInstances: Array<{ workFolderId: string }>;
    };
    assert.equal(before.projects.some((item) => item.workFolderId === workFolderOne), true);
    assert.equal(before.runtimeInstances.some((item) => item.workFolderId === workFolderOne), true);

    await service.removeWorkFolder(workFolderOne);
    const after = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      projects: Array<{ workFolderId: string }>;
      runtimeInstances: Array<{ workFolderId: string }>;
    };
    assert.equal(after.projects.some((item) => item.workFolderId === workFolderOne), false);
    assert.equal(after.runtimeInstances.some((item) => item.workFolderId === workFolderOne), false);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService re-reads scoped notification grants when a queued automation acquires a global slot", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-automation-slot-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new QueuedNotificationRuntimeHost();
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: runtime,
      deferAppAutomationStart: false,
      appAutomationMaxConcurrency: 2,
    });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    for (const workFolderId of [workFolderOne, workFolderTwo, workFolderThree]) {
      await service.install({ workFolderId, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
      await service.grantNotifications({ workFolderId, appId: "connected-inbox", expectedDigest: review.digest, permissionId: "new-mail" });
      await service.setAppAutomationEnabled({
        workFolderId,
        appId: "connected-inbox",
        expectedDigest: review.digest,
        appAutomationId: refreshAppAutomation,
        enabled: true,
      });
    }
    const first = service.runAppAutomationNow({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
    });
    const second = service.runAppAutomationNow({
      workFolderId: workFolderTwo,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
    });
    await runtime.waitForStarts(2);
    const acceptedRegistry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      acceptedAppAutomationRuns: Array<{ state: string; runId: string }>;
      historicalAppAutomationRuns: unknown[];
    };
    assert.equal(acceptedRegistry.acceptedAppAutomationRuns.length, 2, "acceptance is durable before a worker effect can finish");
    assert.equal(acceptedRegistry.acceptedAppAutomationRuns.every((receipt) => receipt.state === "accepted"), true);
    assert.deepEqual(acceptedRegistry.historicalAppAutomationRuns, []);
    const queued = service.runAppAutomationNow({
      workFolderId: workFolderThree,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
    });
    await service.revokeNotifications({ workFolderId: workFolderThree, appId: "connected-inbox", expectedDigest: review.digest, permissionId: "new-mail" });
    runtime.releaseOne();
    const failed = await queued;
    assert.equal(failed.run.outcome, "failure", "manual worker failures must be durable receipts rather than rejected service calls");
    assert.match(failed.run.error ?? "", /notification category is not granted/i);
    assert.equal(failed.app.automations.find(({ id }) => id === refreshAppAutomation)?.lastError, failed.run.error);
    assert.equal(failed.app.automations.find(({ id }) => id === refreshAppAutomation)?.lastRunAt, failed.run.finishedAt);
    assert.deepEqual(
      await service.listAppAutomationRuns(workFolderThree, "connected-inbox", review.digest, refreshAppAutomation),
      [failed.run],
    );
    runtime.releaseOne();
    const completed = await Promise.all([first, second]);
    assert.deepEqual(completed.map(({ run }) => run.outcome), ["success", "success"]);
    assert.deepEqual(runtime.notificationsShown.sort(), [workFolderOne, workFolderTwo]);
    assert.deepEqual(runtime.notificationsDenied, [workFolderThree]);
    const terminalRegistry = JSON.parse(await readFile(join(rootPath, "registry.json"), "utf8")) as {
      acceptedAppAutomationRuns: unknown[];
      historicalAppAutomationRuns: Array<{ state: string }>;
    };
    assert.deepEqual(terminalRegistry.acceptedAppAutomationRuns, []);
    assert.equal(terminalRegistry.historicalAppAutomationRuns.length, 3);
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
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: new RecordingRuntimeHost(),
      deferAppAutomationStart: false,
    });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.setAppAutomationEnabled({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
      enabled: true,
    });
    const completed = await service.runAppAutomationNow({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
    });
    await service.close();
    service = undefined;

    const registryPath = join(rootPath, "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      acceptedAppAutomationRuns: unknown[];
      historicalAppAutomationRuns: Array<Record<string, unknown>>;
      installations: Array<{ appAutomationRuns: unknown[] }>;
    };
    const terminal = registry.historicalAppAutomationRuns[0]!;
    registry.acceptedAppAutomationRuns = [{
      receiptId: terminal.receiptId,
      verification: terminal.verification,
      kind: terminal.kind,
      state: "accepted",
      workFolderId: terminal.workFolderId,
      appId: terminal.appId,
      packageDigest: terminal.packageDigest,
      runId: terminal.runId,
      appAutomationId: terminal.appAutomationId,
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
    registry.historicalAppAutomationRuns = [];
    registry.installations[0]!.appAutomationRuns = [];
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    service = await RestrictedAppService.create({ rootPath, runtimeHost: new RecordingRuntimeHost() });
    const [recovered] = await service.listAppAutomationRuns(workFolderOne, "connected-inbox", review.digest, refreshAppAutomation);
    assert.equal(recovered?.runId, completed.run.runId);
    assert.equal(recovered?.outcome, "interrupted");
    assert.equal(recovered?.state, "expired");
    assert.match(recovered?.error ?? "", /completion of external effects is unknown/i);
    const persisted = JSON.parse(await readFile(registryPath, "utf8")) as {
      acceptedAppAutomationRuns: unknown[];
      historicalAppAutomationRuns: Array<{ runId: string; outcome: string; state: string }>;
    };
    assert.deepEqual(persisted.acceptedAppAutomationRuns, []);
    assert.deepEqual(persisted.historicalAppAutomationRuns.map(({ runId, outcome, state }) => ({ runId, outcome, state })), [{
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
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new GatedAppAutomationRuntimeHost();
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    await mkdir(join(workFolderRoot, "reports"), { recursive: true });
    service = await RestrictedAppService.create({ rootPath, runtimeHost: runtime, deferAppAutomationStart: false });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.grantFiles({
      workFolderId: workFolderOne,
      workFolderRoot,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      permissionId: "exports",
      root: "reports",
    });
    for (const appAutomationId of [refreshAppAutomation, exportAppAutomation]) {
      await service.setAppAutomationEnabled({
        workFolderId: workFolderOne,
        appId: "connected-inbox",
        expectedDigest: review.digest,
        appAutomationId,
        enabled: true,
      });
    }
    assert.deepEqual(await service.listActiveAppAutomationRuns(), []);
    assert.deepEqual(await service.listAppAutomationRunHistory(), []);

    const refreshRun = service.runAppAutomationNow({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
    });
    const exportRun = service.runAppAutomationNow({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: exportAppAutomation,
    });
    await runtime.waitForStarts(2);
    const active = await service.listActiveAppAutomationRuns();
    assert.equal(active.length, 2);
    const byAppAutomation = new Map(active.map((run) => [run.appAutomationId, run]));
    assert.deepEqual(
      byAppAutomation.get(refreshAppAutomation)?.fileGrantIds,
      [],
      "a run whose automation declares no file permissions provably holds none",
    );
    assert.deepEqual(
      byAppAutomation.get(exportAppAutomation)?.fileGrantIds,
      ["exports"],
      "the join narrows the installation's grants to the automation's declared permissions",
    );
    for (const run of active) {
      assert.equal(run.workFolderId, workFolderOne);
      assert.equal(run.appId, "connected-inbox");
      assert.equal(run.reason, "manual");
      assert.match(run.acceptedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(run.scheduledAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(run.runId);
    }

    runtime.releaseAll();
    const settled = await Promise.all([refreshRun, exportRun]);
    assert.deepEqual(settled.map(({ run }) => run.outcome), ["success", "success"]);
    assert.deepEqual(await service.listActiveAppAutomationRuns(), [], "settled runs leave the active ledger");
    const history = await service.listAppAutomationRunHistory();
    assert.deepEqual(
      history.map((receipt) => receipt.appAutomationId).sort(),
      [exportAppAutomation, refreshAppAutomation].sort(),
    );
    for (const receipt of history) {
      assert.equal(receipt.workFolderId, workFolderOne);
      assert.equal(receipt.appId, "connected-inbox");
      assert.equal(receipt.outcome, "success");
      assert.equal(receipt.reason, "manual");
      assert.match(receipt.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(receipt.receiptId);
      assert.ok(receipt.runId);
    }
    assert.equal((await service.listAppAutomationRunHistory(1)).length, 1, "the history read is bounded by its limit");
    await assert.rejects(service.listAppAutomationRunHistory(0), /positive integer/);
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
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    const runtimeHost: RestrictedAppRuntimeHost = {
      async invoke() { return {}; },
      async runAppAutomation() { throw new Error("   "); },
      async close() {},
    };
    service = await RestrictedAppService.create({
      rootPath,
      runtimeHost,
      deferAppAutomationStart: false,
    });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.setAppAutomationEnabled({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
      enabled: true,
    });
    const failed = await service.runAppAutomationNow({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
    });
    assert.equal(failed.run.outcome, "failure");
    assert.equal(failed.run.error, "Automation run failed.");
    await service.close();
    service = undefined;

    service = await RestrictedAppService.create({ rootPath, runtimeHost });
    assert.equal(
      (await service.listAppAutomationRuns(workFolderOne, "connected-inbox", review.digest, refreshAppAutomation))[0]?.error,
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
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new StopRaceRuntimeHost();
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: runtime,
      deferAppAutomationStart: false,
    });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.grantNotifications({ workFolderId: workFolderOne, appId: "connected-inbox", expectedDigest: review.digest, permissionId: "new-mail" });
    await service.setAppAutomationEnabled({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
      enabled: true,
    });

    runtime.startAppAutomationWhenStopped(service, review.digest);
    await service.revokeNotifications({ workFolderId: workFolderOne, appId: "connected-inbox", expectedDigest: review.digest, permissionId: "new-mail" });
    const pendingRun = runtime.appAutomationRun;
    assert.ok(pendingRun);
    const run = await pendingRun;

    assert.equal(run.run.outcome, "success");
    assert.equal(runtime.appAutomationRuns.length, 1);
    assert.deepEqual(runtime.appAutomationRuns[0]?.app.notificationGrants, [], "the post-stop launch must re-read the committed grant state");
    assert.deepEqual(runtime.appAutomationRuns[0]?.app.networkGrants, ["mail-api"], "the named job keeps the declared destination it names");
    assert.deepEqual(runtime.appAutomationRuns[0]?.app.fileGrants, [], "the named job must not inherit undeclared app powers");
    assert.deepEqual(await service.listAppAutomationRuns(workFolderOne, "connected-inbox", review.digest, refreshAppAutomation), [run.run]);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a work-folder-removal fence blocks an automation already accepted into the service queue", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-automation-removal-fence-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new FenceDuringAuthoritySyncRuntimeHost();
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: runtime,
      deferAppAutomationStart: false,
    });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.setAppAutomationEnabled({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
      enabled: true,
    });

    runtime.fenceOnNextAuthoritySync(() => service.fenceWorkFolderRemoval(workFolderOne));
    const result = await service.runAppAutomationNow({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
    });

    assert.notEqual(result.run.outcome, "success");
    assert.equal(runtime.appAutomationRuns, 0, "the runtime host must never receive work after the removal fence");
    assert.deepEqual(runtime.authorities, []);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a work-folder-removal fence retries runtime authority sync after a transient host failure", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-removal-fence-retry-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new FenceDuringAuthoritySyncRuntimeHost();
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({ rootPath, runtimeHost: runtime });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    assert.equal(runtime.authorities.length, 1);

    runtime.failNextAuthoritySync();
    assert.throws(() => service.fenceWorkFolderRemoval(workFolderOne), /simulated authority sync failure/);
    assert.equal(runtime.authorities.length, 1, "the injected host failure models stale authority");
    service.fenceWorkFolderRemoval(workFolderOne);
    assert.deepEqual(runtime.authorities, [], "replaying the same fence must retry authority synchronization");
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService uses OAuth generation invalidation so disconnect cannot be undone by an in-flight refresh", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-oauth-disconnect-"));
  const workFolderRoot = join(sandbox, "work-folder");
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
    await writePackage(join(workFolderRoot, "apps", "inbox"), { networkAuth: [{ kind: "oauth2-pkce", ...configuration }] });
    const service = await RestrictedAppService.create({ rootPath, runtimeHost: runtime, connections, oauth });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    const installed = await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
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
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      destinationId: "mail-api",
    }), true);
    releaseRefresh();

    await assert.rejects(authorization, (error: unknown) => error instanceof RestrictedAppOAuthError && error.code === "AUTH_REQUIRED");
    assert.equal(await connections.get(binding), undefined);
    assert.equal(connections.setBindings.length, 1, "the in-flight refresh must not save a replacement token");
    assert.deepEqual(runtime.stops, [{ workFolderId: workFolderOne, appId: "connected-inbox", digest: review.digest }]);
    await service.close();
  } finally {
    releaseRefresh?.();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("an exact Local App connection reset cannot be undone by an in-flight OAuth refresh", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-oauth-local-reset-"));
  const workFolderRoot = join(sandbox, "source-work-folder");
  const packageRoot = join(workFolderRoot, "apps", "inbox");
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
      workFolderId: workFolderOne,
      presentation: { title: "Connected Inbox", description: null, icon: "mail" },
    });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });

    const preparedOne = await service.prepareLocalAppRelease({ workFolderId: workFolderOne, displayVersion: "1.0.0" });
    const releaseOne = await service.publishLocalAppRelease({
      workFolderId: workFolderOne,
      releaseDigest: preparedOne.releaseDigest,
    });
    const install = await service.prepareLocalAppInstall({
      sourceWorkFolderId: workFolderOne,
      targetWorkFolderId: workFolderTwo,
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
    const preparedTwo = await service.prepareLocalAppRelease({ workFolderId: workFolderOne, displayVersion: "1.0.1" });
    const releaseTwo = await service.publishLocalAppRelease({
      workFolderId: workFolderOne,
      releaseDigest: preparedTwo.releaseDigest,
    });
    const update = await service.prepareLocalAppUpdate({
      sourceWorkFolderId: workFolderOne,
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
    assert.equal((await service.connectionStatus(workFolderTwo, "connected-inbox", successor.digest))[0]?.configured, false);
  } finally {
    releaseRefresh?.();
    await service?.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService invalidates OAuth generations before credential replacement, app update, and removal", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-oauth-lifecycle-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const sourceRoot = join(workFolderRoot, "apps", "inbox");
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
    const first = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: first.digest });
    await service.setConnection({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: first.digest,
      destinationId: "mail-api",
      credential: { kind: "api-key", value: "replacement" },
    });

    await writePackage(sourceRoot, { version: "0.2.0", networkAuth });
    const second = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: second.digest });
    await service.remove({ workFolderId: workFolderOne, appId: "connected-inbox", expectedDigest: second.digest });

    assert.deepEqual(connections.deleteBindings.map((binding) => binding.featureRevisionDigest), [
      first.artifactDigest,
      second.artifactDigest,
    ], "credential replacement and removal disconnect; the byte-identical update carries the binding instead");
    assert.deepEqual(connections.carriedForward.map((item) => item.kept), [["mail-api"]]);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("RestrictedAppService starts every work-folder app stop together and preserves state if any stop fails", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-remove-failure-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new RejectingStopRuntimeHost("second-inbox");
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    await writePackage(join(workFolderRoot, "apps", "second"), { packageName: "second-inbox", appId: "second-inbox" });
    const service = await RestrictedAppService.create({ rootPath, runtimeHost: runtime });
    for (const sourcePath of ["apps/inbox", "apps/second"]) {
      const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath });
      await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath, expectedDigest: review.digest });
    }
    await assert.rejects(service.removeWorkFolder(workFolderOne), /stop failed/);
    assert.deepEqual(runtime.stops.sort(), ["connected-inbox", "second-inbox"]);
    assert.deepEqual((await service.list(workFolderOne)).map((app) => app.manifest.id).sort(), ["connected-inbox", "second-inbox"]);
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
  const newerRegistry = `${JSON.stringify({ schemaVersion: 7, futureState: true }, null, 2)}\n`;
  try {
    await mkdir(rootPath, { recursive: true });
    await writeFile(registryPath, newerRegistry, "utf8");
    await assert.rejects(
      RestrictedAppService.create({ rootPath }),
      (error) => {
        assert.ok(error instanceof RestrictedAppRegistryVersionUnsupportedError);
        assert.equal(error.actualVersion, 7);
        assert.equal(error.supportedVersion, 6);
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
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  let service: RestrictedAppService | undefined;
  try {
    const packageRoot = join(workFolderRoot, "apps", "large-contract");
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

    // The production ceiling is 256 MiB; a small configured one keeps this fast
    // while exercising the same refusal and recovery path.
    const registryMaximumBytes = 5 * 1024 * 1024;
    service = await RestrictedAppService.create({ rootPath, registryMaximumBytes });
    const review = await service.inspect({ workFolderId: "ws-registry-0", workFolderRoot, sourcePath: "apps/large-contract" });
    const installedWorkspaces: string[] = [];
    let rejectedWorkspace = "";
    for (let index = 0; index < 24; index += 1) {
      const workFolderId = `ws-registry-${index}`;
      try {
        await service.install({ workFolderId, workFolderRoot, sourcePath: "apps/large-contract", expectedDigest: review.digest });
        installedWorkspaces.push(workFolderId);
      } catch (error) {
        assert.match(error instanceof Error ? error.message : String(error), /registry exceeds the 5242880-byte persistence limit/i);
        rejectedWorkspace = workFolderId;
        break;
      }
    }
    assert.ok(installedWorkspaces.length > 1 && rejectedWorkspace, "the fixture must reach the write boundary");
    const registryPath = join(rootPath, "registry.json");
    assert.ok((await readFile(registryPath)).byteLength <= registryMaximumBytes);
    assert.equal((await service.list(rejectedWorkspace)).length, 0);
    assert.equal((await service.list(installedWorkspaces.at(-1)!)).length, 1);
    await service.close();
    service = undefined;

    service = await RestrictedAppService.create({ rootPath, registryMaximumBytes });
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
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "restricted-apps");
  const registryPath = join(rootPath, "registry.json");
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({ rootPath });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
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

test("RestrictedAppService confines package sources to normal visible directories inside the work-folder", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-paths-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const outsideRoot = join(sandbox, "outside-app");
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    await writePackage(join(workFolderRoot, ".pi", "hidden-app"));
    await writePackage(join(workFolderRoot, ".work-fold", "hidden-app"));
    await writePackage(join(workFolderRoot, ".workspace", "hidden-app"));
    await writePackage(outsideRoot);
    const service = await RestrictedAppService.create({ rootPath });
    assert.equal((await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" })).manifest.id, "connected-inbox");

    for (const sourcePath of [outsideRoot, "../outside-app", ".pi/hidden-app", ".work-fold/hidden-app", ".workspace/hidden-app", ".", ""]) {
      await assert.rejects(
        service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath }),
        (error: unknown) => errorCode(error) === "INPUT_INVALID",
        sourcePath || "<empty>",
      );
    }

    const linkedPath = join(workFolderRoot, "apps", "linked-outside");
    try {
      await symlink(outsideRoot, linkedPath, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/linked-outside" }),
        (error: unknown) => errorCode(error) === "INPUT_INVALID" && /link|escapes the work-folder/i.test(errorMessage(error)),
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

type AppAutomationRuntimeEvent = {
  runId: string;
  appAutomationId: string;
  handler: string;
  reason: "scheduled" | "manual" | "resume";
  scheduledAt: string;
  effectivePrincipal: EffectivePrincipal;
};

class RecordingRuntimeHost implements RestrictedAppRuntimeHost {
  readonly invocations: Array<{ app: RestrictedAppRuntimeDescriptor; action: string; input: unknown }> = [];
  readonly appAutomationRuns: Array<{ app: RestrictedAppRuntimeDescriptor; event: AppAutomationRuntimeEvent }> = [];
  readonly stops: Array<{ workFolderId: string; appId: string; digest?: string }> = [];
  closeCount = 0;

  async invoke(app: RestrictedAppRuntimeDescriptor, action: string, input: unknown): Promise<unknown> {
    this.invocations.push({ app: structuredClone(app), action, input: structuredClone(input) });
    return { count: 7 };
  }

  async runAppAutomation(app: RestrictedAppRuntimeDescriptor, event: AppAutomationRuntimeEvent): Promise<void> {
    this.appAutomationRuns.push({ app: structuredClone(app), event: structuredClone(event) });
  }

  async stop(workFolderId: string, appId: string, digest?: string): Promise<void> {
    this.stops.push({ workFolderId, appId, ...(digest ? { digest } : {}) });
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

class GatedAppAutomationRuntimeHost implements RestrictedAppRuntimeHost {
  readonly #releases: Array<() => void> = [];
  readonly #startWaiters: Array<{ count: number; resolve: () => void }> = [];
  #started = 0;

  async invoke(): Promise<unknown> { return {}; }

  async runAppAutomation(): Promise<void> {
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
        this.notificationsShown.push(notification.workFolderId);
        return { close: callbacks.onClose };
      },
    },
  });
  #started = 0;

  async invoke(): Promise<unknown> { return {}; }

  async runAppAutomation(app: RestrictedAppRuntimeDescriptor, event: AppAutomationRuntimeEvent): Promise<void> {
    this.#started += 1;
    this.#resolveStartWaiters();
    if (this.#started <= 2) await new Promise<void>((resolvePromise) => this.#releases.push(resolvePromise));
    try {
      this.#broker.show({
        workFolderId: app.workFolderId,
        appId: app.manifest.id,
        digest: app.digest,
        appTitle: app.manifest.title,
        declarations: app.manifest.permissions.notifications,
        grants: app.notificationGrants,
        appAutomationEnabled: app.automations.some((automation) => automation.id === event.appAutomationId && automation.enabled),
        invocationId: event.runId,
      }, { permissionId: "new-mail" }, () => undefined);
    } catch (error) {
      this.notificationsDenied.push(app.workFolderId);
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
  async stop(_workFolderId: string, appId: string): Promise<void> {
    this.stops.push(appId);
    if (appId === this.rejectedAppId) throw new Error("stop failed");
  }
  async close(): Promise<void> {}
}

class StopRaceRuntimeHost implements RestrictedAppRuntimeHost {
  readonly appAutomationRuns: Array<{ app: RestrictedAppRuntimeDescriptor; event: AppAutomationRuntimeEvent }> = [];
  appAutomationRun?: ReturnType<RestrictedAppService["runAppAutomationNow"]>;
  #onStop?: () => void;

  async invoke(): Promise<unknown> { return {}; }
  async runAppAutomation(app: RestrictedAppRuntimeDescriptor, event: AppAutomationRuntimeEvent): Promise<void> {
    this.appAutomationRuns.push({ app: structuredClone(app), event: structuredClone(event) });
  }
  startAppAutomationWhenStopped(service: RestrictedAppService, digest: string): void {
    this.#onStop = () => {
      this.appAutomationRun = service.runAppAutomationNow({
        workFolderId: workFolderOne,
        appId: "connected-inbox",
        expectedDigest: digest,
        appAutomationId: refreshAppAutomation,
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
  appAutomationRuns = 0;
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
  async runAppAutomation(): Promise<void> { this.appAutomationRuns += 1; }
  async stop(): Promise<void> {}
  async close(): Promise<void> {}
}

class MemoryConnectionStore implements RestrictedAppConnectionStore {
  readonly records = new Map<string, RestrictedAppCredential>();
  readonly setBindings: Array<{ binding: RestrictedAppConnectionBinding; credential: RestrictedAppCredential }> = [];
  readonly deleteBindings: RestrictedAppConnectionBinding[] = [];
  readonly deletedFeatures: RestrictedAppConnectionFeatureScope[] = [];
  readonly deletedRuntimeInstances: RestrictedAppConnectionInstanceScope[] = [];
  readonly carriedForward: Array<{ from: RestrictedAppConnectionFeatureScope; to: RestrictedAppConnectionFeatureScope; kept: string[] }> = [];

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

  async carryForward(
    from: RestrictedAppConnectionFeatureScope,
    to: RestrictedAppConnectionFeatureScope,
    keep: readonly { declarationId: string; declarationDigest: string }[],
  ): Promise<string[]> {
    const kept: string[] = [];
    for (const [key, credential] of [...this.records]) {
      const record = JSON.parse(key) as string[];
      if (!(record[0] === from.tenantId && record[1] === from.runtimeInstanceId && record[2] === from.featureId
        && record[3] === from.featureInstallationId && record[4] === from.featureRevisionDigest)) continue;
      if (!keep.some((item) => item.declarationId === record[5] && item.declarationDigest === record[6])) continue;
      this.records.delete(key);
      this.records.set(JSON.stringify([to.tenantId, to.runtimeInstanceId, to.featureId, to.featureInstallationId, to.featureRevisionDigest, ...record.slice(5)]), credential);
      kept.push(record[5]!);
    }
    this.carriedForward.push({ from: structuredClone(from), to: structuredClone(to), kept: kept.sort() });
    return kept.sort();
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
  networkMethods?: string[];
  checks?: Array<{ id: string; title: string }>;
  files?: Array<{ id: string; target: "file" | "directory"; access: "read" | "read-write" }>;
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
      id: refreshAppAutomation,
      title: "Refresh inbox",
      description: "Check for newly arrived messages.",
      handler: "refresh-inbox",
      trigger: { kind: "interval", intervalMinutes: 30 },
      permissions: { network: ["mail-api"], files: [], notifications: ["new-mail"] },
      catchUp: "latest",
      overlap: "skip",
    }, {
      id: exportAppAutomation,
      title: "Export digest",
      description: "Write a digest into the selected reports folder.",
      handler: "export-digest",
      trigger: { kind: "interval", intervalMinutes: 60 },
      permissions: { network: [], files: ["exports"], notifications: [] },
      catchUp: "none",
      overlap: "skip",
    }],
    permissions: {
      files: options.files ?? [{ id: "exports", target: "directory", access: "read-write" }],
      notifications: [{ id: "new-mail", title: "New mail", description: "New messages are ready." }],
      network: [{
        id: "mail-api",
        target: { kind: "public-https", origin: "https://mail.example.com" },
        methods: options.networkMethods ?? ["GET"],
        auth: options.networkAuth ?? [{ kind: "api-key", header: "x-api-key" }],
      }],
      ...(options.checks ? { checks: options.checks } : {}),
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

test("a History reservation blocks new automation launches and releases without changing grants", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-service-automation-removal-fence-"));
  const workFolderRoot = join(sandbox, "work-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const runtime = new FenceDuringAuthoritySyncRuntimeHost();
  try {
    await writePackage(join(workFolderRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: runtime,
      deferAppAutomationStart: false,
    });
    const review = await service.inspect({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox" });
    await service.install({ workFolderId: workFolderOne, workFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
    await service.setAppAutomationEnabled({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
      enabled: true,
    });

    const result = await service.withHistoryRestoreReservation(workFolderOne, () => service.runAppAutomationNow({
      workFolderId: workFolderOne,
      appId: "connected-inbox",
      expectedDigest: review.digest,
      appAutomationId: refreshAppAutomation,
    }));

    assert.notEqual(result.run.outcome, "success");
    assert.equal(runtime.appAutomationRuns, 0, "the runtime host cannot launch during restoration");
    assert.equal((await service.list(workFolderOne))[0]?.automations[0]?.enabled, true);
    const subsequent = await service.runAppAutomationNow({ workFolderId: workFolderOne, appId: "connected-inbox", expectedDigest: review.digest, appAutomationId: refreshAppAutomation });
    assert.equal(subsequent.run.outcome, "success");
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
