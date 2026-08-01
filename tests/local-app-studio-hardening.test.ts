import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileRestrictedAppStorage, type RestrictedAppStorageOwner } from "../src/local/agent/restricted-app-storage.js";
import {
  assertLocalAppReleasePreparationBounds,
  RestrictedAppService,
  type RestrictedAppInstalled,
} from "../src/local/agent/restricted-app-service.js";
import { appReleaseDefaultLimits, assembleAppRelease } from "../src/local/agent/app-platform-release.js";
import { LocalAppReleaseStore } from "../src/local/agent/local-app-release-store.js";

const sourceSpace = "ws-studio-hardening-source";
const targetSpace = "ws-studio-hardening-target";
const featureA = "feature-a";
const featureB = "feature-b";

test("Local App Release preparation rejects feature and closure bounds before package snapshots", () => {
  assert.throws(
    () => assertLocalAppReleasePreparationBounds(Array.from(
      { length: appReleaseDefaultLimits.features + 1 },
      () => ({ totalBytes: 1 }),
    )),
    (error: unknown) => errorCode(error) === "INPUT_INVALID" && /at most .* Features/i.test(errorMessage(error)),
  );
  assert.throws(
    () => assertLocalAppReleasePreparationBounds([
      { totalBytes: appReleaseDefaultLimits.closureBytes },
      { totalBytes: 1 },
    ]),
    (error: unknown) => errorCode(error) === "INPUT_INVALID" && /closure limit/i.test(errorMessage(error)),
  );
  assert.doesNotThrow(() => assertLocalAppReleasePreparationBounds([
    { totalBytes: appReleaseDefaultLimits.closureBytes - 1 },
    { totalBytes: 1 },
  ]));
});

test("startup rejects pending cleanup aimed at active App data before deleting it", async () => {
  const fixture = await createFixture("work-fold-local-app-cleanup-tamper-");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(fixture.sourceRoot, featureA, { marker: "active-cleanup-target" });
    service = await RestrictedAppService.create({ rootPath: fixture.rootPath, storage: fixture.storage });
    await declareProject(service);
    const preview = await installPreview(service, sourceSpace, fixture.sourceRoot, featureA);
    const owner = storageOwner(preview);
    await fixture.storage.set(owner, "must-survive", { protected: true });
    await service.close();
    service = undefined;

    const registryPath = join(fixture.rootPath, "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      pendingCleanups: unknown[];
    };
    registry.pendingCleanups.push({
      cleanupId: "cleanup_00000000-0000-4000-8000-000000000001",
      connectionScope: null,
      storageOwner: owner,
      packageDigest: null,
      createdAt: "2026-07-16T20:00:00.000Z",
    });
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    await assert.rejects(
      RestrictedAppService.create({ rootPath: fixture.rootPath, storage: fixture.storage }),
      /pending storage cleanup still belongs to active or retained App data/i,
    );
    assert.deepEqual(await fixture.storage.get(owner, "must-survive"), { protected: true });
  } finally {
    await service?.close().catch(() => undefined);
    await rm(fixture.sandbox, { recursive: true, force: true });
  }
});

test("startup rejects a verified Release that targets unsupported local runtime capabilities", async () => {
  const fixture = await createFixture("work-fold-local-app-unsupported-release-");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(fixture.sourceRoot, featureA, { marker: "unsupported-release-source" });
    service = await RestrictedAppService.create({ rootPath: fixture.rootPath, storage: fixture.storage });
    await declareProject(service);
    const preview = await installPreview(service, sourceSpace, fixture.sourceRoot, featureA);
    const project = (await service.localAppStudio(sourceSpace)).project;
    assert.ok(project);
    await service.close();
    service = undefined;

    const createdAt = "2026-07-16T20:30:00.000Z";
    const unsupported = assembleAppRelease({
      projectId: project.projectId,
      presentation: project.presentation,
      displayVersion: "unsupported-runtime",
      runtimeApi: { name: "another-runtime", compatibleRange: "1.x" },
      features: [{
        featureId: featureA,
        featureRevision: {
          mediaType: "application/vnd.work-fold.restricted-app-package+bundle",
          entries: [{ path: "package.json", bytes: new TextEncoder().encode("{}") }],
        },
        declaration: {
          mediaType: "application/vnd.work-fold.restricted-app-manifest+json",
          value: { id: featureA },
        },
        dataSchema: null,
        migrations: [],
      }],
      dependencyInventory: { mediaType: "application/json", value: {} },
      buildProvenance: { mediaType: "application/json", value: {} },
      inspectionEvidence: { mediaType: "application/json", value: {} },
      createdAt,
    });
    const store = new LocalAppReleaseStore(join(fixture.rootPath, "releases"));
    await store.put(unsupported);
    const registryPath = join(fixture.rootPath, "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      releases: unknown[];
    };
    registry.releases.push({
      projectId: project.projectId,
      sourceSpaceId: sourceSpace,
      releaseDigest: unsupported.releaseDigest,
      displayVersion: unsupported.manifest.displayVersion,
      presentation: unsupported.manifest.presentation,
      featureIds: [featureA],
      state: "published",
      preparedAt: createdAt,
      publishedAt: createdAt,
      sourceFeatures: [{
        featureId: featureA,
        featureInstallationId: preview.featureInstallationId,
        packageDigest: preview.digest,
        artifactDigest: unsupported.manifest.features[0]!.featureRevision.digest,
      }],
    });
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    await assert.rejects(
      RestrictedAppService.create({ rootPath: fixture.rootPath, storage: fixture.storage }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /does not target the local restricted App runtime/i.test(errorMessage(error)),
    );
  } finally {
    await service?.close().catch(() => undefined);
    await rm(fixture.sandbox, { recursive: true, force: true });
  }
});

test("Local App update preparation and activation reject cross-runtime Feature conflicts without corrupting restart state", async () => {
  const fixture = await createFixture("work-fold-local-app-conflict-");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(fixture.sourceRoot, featureA, { marker: "source-a-v1" });
    service = await RestrictedAppService.create({ rootPath: fixture.rootPath, storage: fixture.storage });
    await declareProject(service);
    await installPreview(service, sourceSpace, fixture.sourceRoot, featureA);
    const firstRelease = await prepareAndPublish(service, "1.0.0");
    const firstInstall = await installRelease(service, firstRelease.releaseDigest);

    await writePackage(fixture.sourceRoot, featureB, { marker: "source-b-v1" });
    await installPreview(service, sourceSpace, fixture.sourceRoot, featureB);
    const secondRelease = await prepareAndPublish(service, "2.0.0");

    await writePackage(fixture.targetRoot, featureB, { version: "0.9.0", marker: "target-conflict-b" });
    const conflict = await installPreview(service, targetSpace, fixture.targetRoot, featureB);
    await assert.rejects(
      service.prepareLocalAppUpdate({
        sourceSpaceId: sourceSpace,
        runtimeInstanceId: firstInstall.instance.runtimeInstanceId,
        releaseDigest: secondRelease.releaseDigest,
      }),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /outside this App Instance|conflict/i.test(errorMessage(error)),
      "an update must not be prepared over an existing Feature owned by another Runtime Instance",
    );

    assert.equal(await service.remove({
      spaceId: targetSpace,
      appId: featureB,
      expectedDigest: conflict.digest,
    }), true);
    const operation = await service.prepareLocalAppUpdate({
      sourceSpaceId: sourceSpace,
      runtimeInstanceId: firstInstall.instance.runtimeInstanceId,
      releaseDigest: secondRelease.releaseDigest,
    });
    assert.equal(operation.plan.canCommit, true);
    assert.equal(operation.plan.transitions.find((item) => item.featureId === featureB)?.action, "add");

    await installPreview(service, targetSpace, fixture.targetRoot, featureB);
    await service.close();
    service = undefined;

    service = await RestrictedAppService.create({ rootPath: fixture.rootPath, storage: fixture.storage });
    assert.equal((await service.localAppStudio(sourceSpace)).operations.some((item) => item.operationId === operation.operationId), true,
      "the prepared update must remain readable after restart");
    await assert.rejects(
      service.activateLocalAppUpdate(operation.operationId),
      (error: unknown) => errorCode(error) === "REVISION_CHANGED" && /Feature|plan no longer matches/i.test(errorMessage(error)),
      "activation must re-check conflicts introduced after preparation",
    );

    await service.close();
    service = undefined;
    service = await RestrictedAppService.create({ rootPath: fixture.rootPath, storage: fixture.storage });
    const afterFailure = await service.localAppStudio(sourceSpace);
    assert.equal(afterFailure.operations.some((item) => item.operationId === operation.operationId), true,
      "a rejected activation must leave its durable operation readable for review or cancellation");
    assert.deepEqual(
      (await service.list(targetSpace)).map((app) => [app.manifest.id, app.runtimeInstanceKind]).sort(),
      [[featureA, "app"], [featureB, "development"]],
    );
  } finally {
    await service?.close().catch(() => undefined);
    await rm(fixture.sandbox, { recursive: true, force: true });
  }
});

test("updating A+B to A retains B, then purge uninstall deletes active and previously retained storage", async () => {
  const fixture = await createFixture("work-fold-local-app-purge-");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(fixture.sourceRoot, featureA, { marker: "source-a" });
    await writePackage(fixture.sourceRoot, featureB, { marker: "source-b" });
    service = await RestrictedAppService.create({ rootPath: fixture.rootPath, storage: fixture.storage });
    await declareProject(service);
    await installPreview(service, sourceSpace, fixture.sourceRoot, featureA);
    const sourceB = await installPreview(service, sourceSpace, fixture.sourceRoot, featureB);

    const combinedRelease = await prepareAndPublish(service, "1.0.0");
    const installed = await installRelease(service, combinedRelease.releaseDigest);
    const installedA = requiredApp(installed.apps, featureA);
    const installedB = requiredApp(installed.apps, featureB);
    await fixture.storage.set(storageOwner(installedA), "state", { feature: featureA, value: 1 });
    await fixture.storage.set(storageOwner(installedB), "state", { feature: featureB, value: 2 });

    assert.equal(await service.remove({
      spaceId: sourceSpace,
      appId: featureB,
      expectedDigest: sourceB.digest,
    }), true);
    const singleRelease = await prepareAndPublish(service, "2.0.0");
    const operation = await service.prepareLocalAppUpdate({
      sourceSpaceId: sourceSpace,
      runtimeInstanceId: installed.instance.runtimeInstanceId,
      releaseDigest: singleRelease.releaseDigest,
    });
    assert.equal(operation.plan.transitions.find((item) => item.featureId === featureB)?.action, "remove");

    const updated = await service.activateLocalAppUpdate(operation.operationId);
    assert.deepEqual(updated.apps.map((app) => app.manifest.id), [featureA]);
    assert.deepEqual(await fixture.storage.get(storageOwner(installedB), "state"), { feature: featureB, value: 2 });
    const retained = (await service.localAppStudio(sourceSpace)).retainedData;
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.featureId, featureB);
    assert.equal(retained[0]?.runtimeInstanceId, installed.instance.runtimeInstanceId);

    const uninstall = await service.uninstallLocalApp({
      runtimeInstanceId: updated.instance.runtimeInstanceId,
      dataDisposition: "purge",
    });
    assert.equal(uninstall.removed, true);
    assert.deepEqual(uninstall.retainedData, []);
    assert.deepEqual(await service.list(targetSpace), []);
    assert.deepEqual((await service.localAppStudio(sourceSpace)).retainedData, []);
    assert.equal((await fixture.storage.usage(storageOwner(installedA))).keyCount, 0,
      "purge must delete the still-active A namespace");
    assert.equal((await fixture.storage.usage(storageOwner(installedB))).keyCount, 0,
      "purge must also delete B data retained by the preceding update");
  } finally {
    await service?.close().catch(() => undefined);
    await rm(fixture.sandbox, { recursive: true, force: true });
  }
});

test("publishing rejects a prepared Release after its App Project presentation changes", async () => {
  const fixture = await createFixture("work-fold-local-app-presentation-");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(fixture.sourceRoot, featureA, { marker: "presentation-source" });
    service = await RestrictedAppService.create({ rootPath: fixture.rootPath, storage: fixture.storage });
    await declareProject(service);
    await installPreview(service, sourceSpace, fixture.sourceRoot, featureA);
    const prepared = await service.prepareLocalAppRelease({ spaceId: sourceSpace, displayVersion: "1.0.0" });

    await service.declareLocalAppProject({
      spaceId: sourceSpace,
      presentation: {
        title: "Hardening fixture, revised",
        description: "Presentation edits after preparation require a new immutable Release review.",
        icon: "shield",
      },
    });
    await assert.rejects(
      service.publishLocalAppRelease({ spaceId: sourceSpace, releaseDigest: prepared.releaseDigest }),
      (error: unknown) => errorCode(error) === "REVISION_CHANGED" && /presentation|Project|Release/i.test(errorMessage(error)),
    );
    const release = (await service.localAppStudio(sourceSpace)).releases.find((item) => item.releaseDigest === prepared.releaseDigest);
    assert.equal(release?.state, "prepared");
    assert.equal(release?.presentation.title, "Hardening fixture");
  } finally {
    await service?.close().catch(() => undefined);
    await rm(fixture.sandbox, { recursive: true, force: true });
  }
});

test("source Space removal is blocked while its local Release lineage and retained data remain", async () => {
  const fixture = await createFixture("work-fold-local-app-source-removal-");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(fixture.sourceRoot, featureA, { marker: "retained-source" });
    service = await RestrictedAppService.create({ rootPath: fixture.rootPath, storage: fixture.storage });
    await declareProject(service);
    await installPreview(service, sourceSpace, fixture.sourceRoot, featureA);
    const release = await prepareAndPublish(service, "1.0.0");
    const installed = await installRelease(service, release.releaseDigest);
    await fixture.storage.set(storageOwner(installed.apps[0]!), "state", "retained-value");
    const uninstalled = await service.uninstallLocalApp({
      runtimeInstanceId: installed.instance.runtimeInstanceId,
      dataDisposition: "retain",
    });
    assert.equal(uninstalled.retainedData.length, 1);
    const beforeRemoval = await service.localAppStudio(sourceSpace);
    assert.equal(beforeRemoval.instances.length, 0);
    assert.equal(beforeRemoval.releases.length, 1);
    assert.equal(beforeRemoval.retainedData.length, 1);

    await assert.rejects(
      service.removeSpace(sourceSpace),
      (error: unknown) => errorCode(error) === "INPUT_INVALID" && /Release|retained|lineage|App Project/i.test(errorMessage(error)),
      "removing the source Space must not orphan machine-local Release and retained-data management state",
    );
    const afterRejection = await service.localAppStudio(sourceSpace);
    assert.equal(afterRejection.project?.spaceId, sourceSpace);
    assert.equal(afterRejection.previews.length, 1);
    assert.equal(afterRejection.releases.length, 1);
    assert.equal(afterRejection.retainedData.length, 1);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(fixture.sandbox, { recursive: true, force: true });
  }
});

test("startup rejects a structurally valid registry projection that diverges from its immutable Release", async () => {
  const fixture = await createFixture("work-fold-local-app-projection-");
  let service: RestrictedAppService | undefined;
  try {
    await writePackage(fixture.sourceRoot, featureA, { marker: "projection-source" });
    service = await RestrictedAppService.create({ rootPath: fixture.rootPath, storage: fixture.storage });
    await declareProject(service);
    await installPreview(service, sourceSpace, fixture.sourceRoot, featureA);
    const release = await prepareAndPublish(service, "1.0.0");
    await installRelease(service, release.releaseDigest);
    await service.close();
    service = undefined;

    const registryPath = join(fixture.rootPath, "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      installations: Array<{
        runtimeInstanceKind: string;
        version: string;
        manifest: { title: string };
      }>;
    };
    const projection = registry.installations.find((item) => item.runtimeInstanceKind === "app");
    assert.ok(projection);
    projection.version = "9.9.9";
    projection.manifest.title = "Tampered release projection";
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    await assert.rejects(
      RestrictedAppService.create({ rootPath: fixture.rootPath, storage: fixture.storage }),
      (error: unknown) => /active Release|Release-backed Feature projection|immutable Release|projection/i.test(errorMessage(error)),
    );
  } finally {
    await service?.close().catch(() => undefined);
    await rm(fixture.sandbox, { recursive: true, force: true });
  }
});

async function createFixture(prefix: string): Promise<{
  sandbox: string;
  sourceRoot: string;
  targetRoot: string;
  rootPath: string;
  storage: FileRestrictedAppStorage;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), prefix));
  const sourceRoot = join(sandbox, "source-space");
  const targetRoot = join(sandbox, "target-space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  await Promise.all([mkdir(sourceRoot, { recursive: true }), mkdir(targetRoot, { recursive: true })]);
  return {
    sandbox,
    sourceRoot,
    targetRoot,
    rootPath,
    storage: new FileRestrictedAppStorage(join(rootPath, "data")),
  };
}

async function declareProject(service: RestrictedAppService): Promise<void> {
  await service.declareLocalAppProject({
    spaceId: sourceSpace,
    presentation: {
      title: "Hardening fixture",
      description: "Adversarial Local App Studio lifecycle coverage.",
      icon: "shield",
    },
  });
}

async function installPreview(
  service: RestrictedAppService,
  spaceId: string,
  spaceRoot: string,
  featureId: string,
): Promise<RestrictedAppInstalled> {
  const sourcePath = `apps/${featureId}`;
  const review = await service.inspect({ spaceId, spaceRoot, sourcePath });
  return await service.install({ spaceId, spaceRoot, sourcePath, expectedDigest: review.digest });
}

async function prepareAndPublish(service: RestrictedAppService, displayVersion: string) {
  const prepared = await service.prepareLocalAppRelease({ spaceId: sourceSpace, displayVersion });
  return await service.publishLocalAppRelease({ spaceId: sourceSpace, releaseDigest: prepared.releaseDigest });
}

async function installRelease(service: RestrictedAppService, releaseDigest: string) {
  const operation = await service.prepareLocalAppInstall({
    sourceSpaceId: sourceSpace,
    targetSpaceId: targetSpace,
    releaseDigest,
  });
  return await service.activateLocalAppInstall(operation.operationId);
}

function requiredApp(apps: RestrictedAppInstalled[], featureId: string): RestrictedAppInstalled {
  const app = apps.find((item) => item.manifest.id === featureId);
  assert.ok(app, `expected installed ${featureId}`);
  return app;
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

async function writePackage(
  spaceRoot: string,
  featureId: string,
  options: { version?: string; marker: string },
): Promise<void> {
  const root = join(spaceRoot, "apps", featureId);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: featureId,
    version: options.version ?? "1.0.0",
    private: true,
    type: "module",
    agentApp: "agent-app.json",
  }), "utf8");
  await writeFile(join(root, "agent-app.json"), JSON.stringify({
    version: 2,
    id: featureId,
    title: featureTitle(featureId),
    description: `A realistic restricted ${featureTitle(featureId)} fixture.`,
    runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
    ui: { icon: "box" },
    tools: [{
      name: `${featureId.replaceAll("-", "_")}_read`,
      description: `Read ${featureTitle(featureId)} state.`,
      action: "read",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", maxLength: 200 } },
        required: ["query"],
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    }],
    automations: [{
      id: "refresh",
      title: "Refresh",
      description: `Refresh ${featureTitle(featureId)} state.`,
      handler: "refresh",
      trigger: { kind: "interval", intervalMinutes: 60 },
      permissions: { network: ["service-api"], files: ["app-data"], notifications: ["status"] },
      catchUp: "latest",
      overlap: "skip",
    }],
    permissions: {
      files: [{ id: "app-data", target: "directory", access: "read-write" }],
      notifications: [{ id: "status", title: "Status changed", description: "The local app status changed." }],
      network: [{
        id: "service-api",
        target: { kind: "public-https", origin: `https://${featureId}.example.com` },
        methods: ["GET"],
        auth: [{ kind: "api-key", header: "x-api-key" }],
      }],
    },
  }), "utf8");
  await writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8");
  await writeFile(join(root, "app.js"), "export {};\n", "utf8");
  await writeFile(
    join(root, "worker.js"),
    `// ${options.marker}\nexport async function handleAction() { return { value: ${JSON.stringify(options.marker)} }; }\nexport async function handleAutomation() {}\n`,
    "utf8",
  );
}

function featureTitle(featureId: string): string {
  return featureId.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
