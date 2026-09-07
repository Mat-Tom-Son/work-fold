import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RoutedRestrictedAppProposalHost } from "../src/local/agent/restricted-app-proposals.js";
import { RestrictedAppService, type RestrictedAppInstalled } from "../src/local/agent/restricted-app-service.js";
import { FileRestrictedAppStorage } from "../src/local/agent/restricted-app-storage.js";
import { materializeRestrictedAppWorkingCopy } from "../src/local/agent/restricted-app-working-copy.js";
import { appChangeDraft } from "../web-local/src/lib/chat-context-request.js";
import { prepareRestrictedAppChange } from "../web-local/src/lib/restricted-apps.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "work-fold-app-change-"));
  const spaceRoot = join(root, "source");
  const sourcePath = "original";
  const packageRoot = join(spaceRoot, sourcePath);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "change-demo", version: "1.0.0", type: "module", agentApp: "agent-app.json" }));
  await writeFile(join(packageRoot, "agent-app.json"), JSON.stringify({ version: 2, id: "change-demo", title: "Change demo", runtime: { kind: "sandboxed-web", entry: "index.html" }, ui: { icon: "mail" }, tools: [], automations: [], permissions: { network: [] } }));
  await writeFile(join(packageRoot, "index.html"), "<!doctype html><p>Reviewed original</p>");
  const storage = new FileRestrictedAppStorage(join(root, "state", "data"));
  const service = await RestrictedAppService.create({ rootPath: join(root, "state", "apps"), storage });
  const registryPath = join(root, "state", "proposals.json");
  const host = await RoutedRestrictedAppProposalHost.create({ service, registryPath });
  const scope = { spaceId: "source", spaceRoot, conversationId: "builder-chat", sourcePath };
  const proposal = (await host.propose(scope)).proposal!;
  const app = (await host.install(proposal.id))!;
  const input = { id: randomUUID(), spaceId: scope.spaceId, appId: app.manifest.id, expectedDigest: app.digest };
  return { root, spaceRoot, packageRoot, registryPath, service, storage, host, scope, app, input,
    close: async () => { await service.close(); await rm(root, { recursive: true, force: true }); } };
}

test("Change this app copies exact installed bytes, saves provenance, and retries without another copy or History entry", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.packageRoot, "index.html"), "Unreviewed later source");
    await mkdir(join(f.spaceRoot, ".work-fold", "conversations"), { recursive: true });
    await writeFile(join(f.spaceRoot, ".work-fold", "conversations", "secret.json"), "private transcript");
    let checkpoints = 0;
    const copy = (change: any, files: ReadonlyMap<string, Uint8Array>) => materializeRestrictedAppWorkingCopy(f.spaceRoot, change, files, async (paths) => {
      checkpoints++;
      assert.equal(paths.length, 3);
      assert.ok(paths.every((path) => path.startsWith(`${change.sourcePath}/`)));
    });
    const [first, retry] = await Promise.all([f.host.prepareChange(f.input, copy), f.host.prepareChange(f.input, copy)]);
    assert.deepEqual(retry, first);
    assert.equal(checkpoints, 1);
    assert.equal(first.status, "ready");
    assert.equal(first.buildConversationId, "builder-chat");
    assert.equal(first.baseFeatureInstallationId, f.app.featureInstallationId);
    assert.deepEqual(first.previewBase, { featureInstallationId: f.app.featureInstallationId, digest: f.app.digest });
    assert.match(await readFile(join(f.spaceRoot, first.sourcePath, "index.html"), "utf8"), /Reviewed original/);
    assert.deepEqual((await readdir(join(f.spaceRoot, first.sourcePath))).sort(), ["agent-app.json", "index.html", "package.json"]);
    assert.equal(await readFile(join(f.packageRoot, "index.html"), "utf8"), "Unreviewed later source");
    const reopened = await RoutedRestrictedAppProposalHost.create({ service: f.service, registryPath: f.registryPath });
    assert.deepEqual(await reopened.prepareChange(f.input, async () => { assert.fail("replay must not overwrite editable files"); }), first);
    await assert.rejects(reopened.prepareChange({ ...f.input, appId: "other" }, copy), /different revision/);
    await assert.rejects(reopened.prepareChange({ ...f.input, id: "../../bad" }, copy), /unique app-change request/);
    const draft = appChangeDraft({ ...first, targetSpaceId: "private-target", targetRuntimeInstanceId: "secret-runtime" } as any);
    assert.match(draft, /submit the changed package for review/);
    assert.doesNotMatch(draft, /private-target|secret-runtime|builder-chat/);
  } finally { await f.close(); }
});

test("two edits cannot overwrite each other's newer preview, including across proposal-host restart", async () => {
  const f = await fixture();
  try {
    const copy = (change: any, files: ReadonlyMap<string, Uint8Array>) => materializeRestrictedAppWorkingCopy(f.spaceRoot, change, files, async () => {});
    const first = await f.host.prepareChange(f.input, copy);
    const second = await f.host.prepareChange({ ...f.input, id: randomUUID() }, copy);
    await writeFile(join(f.spaceRoot, first.sourcePath, "index.html"), "<p>First edit</p>");
    await writeFile(join(f.spaceRoot, second.sourcePath, "index.html"), "<p>Second edit</p>");
    const one = (await f.host.propose({ ...f.scope, sourcePath: first.sourcePath })).proposal!;
    const two = (await f.host.propose({ ...f.scope, sourcePath: second.sourcePath })).proposal!;
    assert.equal(one.changeId, first.id);
    const installed = (await f.host.install(one.id))!;
    assert.equal(installed.featureInstallationId, f.app.featureInstallationId);
    assert.equal(installed.dataNamespaceId, f.app.dataNamespaceId);
    const reopened = await RoutedRestrictedAppProposalHost.create({ service: f.service, registryPath: f.registryPath });
    await assert.rejects(reopened.install(two.id), /Local preview changed/);
    assert.equal((await reopened.get(two.id))?.status, "revision-changed");
    assert.equal((await f.service.list(f.scope.spaceId))[0]!.digest, installed.digest);
    // A follow-up edit in the same working copy advances from its own successfully reviewed preview.
    await writeFile(join(f.spaceRoot, first.sourcePath, "index.html"), "<p>First edit continued</p>");
    const followup = (await reopened.propose({ ...f.scope, sourcePath: first.sourcePath })).proposal!;
    assert.equal(followup.expectedPreviewBase?.digest, installed.digest);
    const continued = (await reopened.install(followup.id))!;
    const beforeReinstall = await reopened.prepareChange({ ...f.input, id: randomUUID(), expectedDigest: continued.digest }, copy);
    await f.service.remove({ spaceId: f.scope.spaceId, appId: f.app.manifest.id, expectedDigest: continued.digest });
    const reinstalled = await f.service.install({ ...f.scope, sourcePath: first.sourcePath, expectedDigest: continued.digest });
    assert.notEqual(reinstalled.featureInstallationId, continued.featureInstallationId);
    await writeFile(join(f.spaceRoot, beforeReinstall.sourcePath, "index.html"), "<p>Stale incarnation</p>");
    const stale = (await reopened.propose({ ...f.scope, sourcePath: beforeReinstall.sourcePath })).proposal!;
    await assert.rejects(reopened.install(stale.id), /Local preview changed/);
  } finally { await f.close(); }
});

test("build context keeps the source Chat and exact update target through subsequent working copies", async () => {
  const f = await fixture();
  try {
    const initial = await f.host.buildContext(f.scope.spaceId, f.app.manifest.id, f.app.digest);
    assert.deepEqual(initial, { sourceSpaceId: f.scope.spaceId, sourcePath: f.scope.sourcePath,
      buildConversationId: f.scope.conversationId, updateTargetRuntimeInstanceId: null });
    const release = await f.service.prepareLocalAppRelease({ spaceId: f.scope.spaceId, displayVersion: "1.0.0" });
    await f.service.publishLocalAppRelease({ spaceId: f.scope.spaceId, releaseDigest: release.releaseDigest });
    const plan = await f.service.prepareLocalAppInstall({ sourceSpaceId: f.scope.spaceId, targetSpaceId: "target", releaseDigest: release.releaseDigest });
    const { instance, apps } = await f.service.activateLocalAppInstall(plan.operationId);
    const copy = (change: any, files: ReadonlyMap<string, Uint8Array>) => materializeRestrictedAppWorkingCopy(f.spaceRoot, change, files, async () => {});
    const change = await f.host.prepareChange({ ...f.input, spaceId: "target", expectedDigest: apps[0]!.digest }, copy);
    await writeFile(join(f.spaceRoot, change.sourcePath, "index.html"), "<p>Updated for the target</p>");
    const proposal = (await f.host.propose({ ...f.scope, conversationId: "work-fold.act.install-preview", sourcePath: change.sourcePath })).proposal!;
    const preview = (await f.host.install(proposal.id))!;
    const build = await f.host.buildContext(preview.spaceId, preview.manifest.id, preview.digest);
    assert.deepEqual(build, { sourceSpaceId: f.scope.spaceId, sourcePath: change.sourcePath,
      buildConversationId: "builder-chat", updateTargetRuntimeInstanceId: instance.runtimeInstanceId });
    const next = await f.host.prepareChange({ ...f.input, id: randomUUID(), expectedDigest: preview.digest }, copy);
    assert.equal(next.buildConversationId, "builder-chat");
    await writeFile(join(f.spaceRoot, next.sourcePath, "index.html"), "<p>Second edit for the same target</p>");
    const nextProposal = (await f.host.propose({ ...f.scope, conversationId: "work-fold.act.install-preview", sourcePath: next.sourcePath })).proposal!;
    const nextPreview = (await f.host.install(nextProposal.id))!;
    const reopened = await RoutedRestrictedAppProposalHost.create({ service: f.service, registryPath: f.registryPath });
    assert.equal((await reopened.buildContext(nextPreview.spaceId, nextPreview.manifest.id, nextPreview.digest)).updateTargetRuntimeInstanceId, instance.runtimeInstanceId);
    await f.service.uninstallLocalApp({ runtimeInstanceId: instance.runtimeInstanceId, dataDisposition: "purge" });
    const removed = await reopened.buildContext(nextPreview.spaceId, nextPreview.manifest.id, nextPreview.digest);
    assert.equal(removed.updateTargetRuntimeInstanceId, null, "a stale origin must not point at another installation");
    assert.equal(removed.buildConversationId, "builder-chat");
  } finally { await f.close(); }
});

test("interrupted copies resume from exact bytes, preserve later edits, and fail closed on corrupt provenance", async () => {
  const f = await fixture();
  try {
    let path = "";
    await assert.rejects(f.host.prepareChange(f.input, async (change, files) => {
      path = change.sourcePath;
      await materializeRestrictedAppWorkingCopy(f.spaceRoot, change, files, async () => {});
      throw new Error("interrupted before ready receipt");
    }), /interrupted/);
    let reopened = await RoutedRestrictedAppProposalHost.create({ service: f.service, registryPath: f.registryPath });
    await writeFile(join(f.spaceRoot, path, "index.html"), "Preserve my edit");
    await assert.rejects(reopened.prepareChange(f.input, (change, files) => materializeRestrictedAppWorkingCopy(f.spaceRoot, change, files, async () => {})), /interrupted working copy has been edited/);
    assert.equal(await readFile(join(f.spaceRoot, path, "index.html"), "utf8"), "Preserve my edit");
    // With original bytes restored by the person, the same receipt can complete without a second folder.
    await writeFile(join(f.spaceRoot, path, "index.html"), "<!doctype html><p>Reviewed original</p>");
    const resumed = await reopened.prepareChange(f.input, (change, files) => materializeRestrictedAppWorkingCopy(f.spaceRoot, change, files, async () => {}));
    assert.equal(resumed.sourcePath, path);
    await writeFile(f.registryPath, "{invalid");
    await assert.rejects(RoutedRestrictedAppProposalHost.create({ service: f.service, registryPath: f.registryPath }), SyntaxError);
    await writeFile(f.registryPath, JSON.stringify({ schemaVersion: 3, proposals: [], changes: [resumed] }));
    await assert.rejects(RoutedRestrictedAppProposalHost.create({ service: f.service, registryPath: f.registryPath }), /unsupported version/);
  } finally { await f.close(); }
});

test("History failure removes only the new working copy; linked destinations are rejected", async () => {
  const f = await fixture();
  try {
    let path = "";
    await assert.rejects(f.host.prepareChange(f.input, (change, files) => {
      path = change.sourcePath;
      return materializeRestrictedAppWorkingCopy(f.spaceRoot, change, files, async () => { throw new Error("History unavailable"); });
    }), /History unavailable/);
    await assert.rejects(access(join(f.spaceRoot, path)));
    assert.match(await readFile(join(f.packageRoot, "index.html"), "utf8"), /Reviewed original/);
    await symlink(f.packageRoot, join(f.spaceRoot, path), "dir");
    await assert.rejects(f.host.prepareChange(f.input, (change, files) => materializeRestrictedAppWorkingCopy(f.spaceRoot, change, files, async () => {})), /link|symbolic/i);
  } finally { await f.close(); }
});

test("the desktop button's API helper sends one structured, authenticated change request", async (context) => {
  const f = await fixture();
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    workFoldDesktop: { api: { baseUrl: "http://localhost:9999", getSessionHeaders: async () => ({ "x-work-fold-session": "test-session" }) } },
  } });
  context.after(() => { if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window"); });
  const response = { id: f.input.id, sourceSpaceId: f.scope.spaceId, sourcePath: "working", appId: f.app.manifest.id,
    title: f.app.manifest.title, version: f.app.version, baseDigest: f.app.digest, buildConversationId: null };
  const fetch = context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "http://localhost:9999/api/spaces/source/restricted-apps/change-demo/change");
    assert.equal(options?.method, "POST");
    assert.equal((options?.headers as Record<string, string>)["x-work-fold-session"], "test-session");
    assert.deepEqual(JSON.parse(options?.body as string), { requestId: f.input.id, expectedDigest: f.app.digest, featureInstallationId: f.app.featureInstallationId });
    return new Response(JSON.stringify({ change: response }), { status: 201 });
  });
  try {
    assert.deepEqual(await prepareRestrictedAppChange(f.app, f.input.id), response);
    assert.equal(fetch.mock.callCount(), 1);
  } finally { await f.close(); }
});

test("a source-Space release can be changed, previewed and updated without sharing preview data or authority", async () => {
  const f = await fixture();
  let reopened: RestrictedAppService | undefined;
  const owner = (app: RestrictedAppInstalled) => ({ ownerClass: "instance" as const, tenantId: app.tenantId,
    runtimeInstanceId: app.runtimeInstanceId, featureInstallationId: app.featureInstallationId, dataNamespaceId: app.dataNamespaceId });
  const publish = async (version: string) => {
    const release = await f.service.prepareLocalAppRelease({ spaceId: f.scope.spaceId, displayVersion: version });
    await f.service.publishLocalAppRelease({ spaceId: f.scope.spaceId, releaseDigest: release.releaseDigest });
    return release;
  };
  try {
    const firstRelease = await publish("1.0.0");
    const plan = await f.service.prepareLocalAppInstall({ sourceSpaceId: f.scope.spaceId, targetSpaceId: f.scope.spaceId, releaseDigest: firstRelease.releaseDigest });
    const installed = await f.service.activateLocalAppInstall(plan.operationId);
    const live = installed.apps[0]!;
    assert.notEqual(live.featureInstallationId, f.app.featureInstallationId);
    assert.notEqual(live.dataNamespaceId, f.app.dataNamespaceId);
    await f.storage.set(owner(f.app), "quote", "preview data");
    await f.storage.set(owner(live), "quote", "release data");
    await assert.rejects(f.service.storageUsage(live.spaceId, live.manifest.id, live.digest), /exact app installation/);
    const input = { ...f.input, id: randomUUID(), featureInstallationId: live.featureInstallationId };
    const change = await f.host.prepareChange(input, (receipt, files) => materializeRestrictedAppWorkingCopy(f.spaceRoot, receipt, files, async () => {}));
    assert.deepEqual(change.previewBase, { featureInstallationId: f.app.featureInstallationId, digest: f.app.digest });
    assert.equal(change.targetRuntimeInstanceId, live.runtimeInstanceId);
    await writeFile(join(f.spaceRoot, change.sourcePath, "index.html"), "<!doctype html><p>Changed preview</p>");
    const proposed = (await f.host.propose({ ...f.scope, sourcePath: change.sourcePath })).proposal!;
    const preview = (await f.host.install(proposed.id))!;
    assert.equal(preview.featureInstallationId, f.app.featureInstallationId);
    assert.notEqual(preview.digest, live.digest);
    assert.equal((await f.service.runtimeDescriptor(live.spaceId, live.manifest.id, live.digest, live.featureInstallationId)).digest, live.digest);
    assert.equal(await f.storage.get(owner(preview), "quote"), "preview data");
    assert.equal(await f.storage.get(owner(live), "quote"), "release data");
    assert.equal((await f.host.buildContext(preview.spaceId, preview.manifest.id, preview.digest, preview.featureInstallationId)).updateTargetRuntimeInstanceId, live.runtimeInstanceId);
    const secondRelease = await publish("1.1.0");
    const update = await f.service.prepareLocalAppUpdate({ sourceSpaceId: f.scope.spaceId, runtimeInstanceId: live.runtimeInstanceId, releaseDigest: secondRelease.releaseDigest });
    const updated = await f.service.activateLocalAppUpdate(update.operationId);
    assert.equal(updated.apps[0]!.featureInstallationId, live.featureInstallationId);
    assert.equal(updated.apps[0]!.digest, preview.digest);
    assert.equal(await f.storage.get(owner(updated.apps[0]!), "quote"), "release data");
    assert.equal(await f.storage.get(owner(preview), "quote"), "preview data");
    assert.equal((await f.service.localAppStudio(f.scope.spaceId)).previews.length, 1);
    await f.service.close();
    reopened = await RestrictedAppService.create({ rootPath: join(f.root, "state", "apps"), storage: f.storage });
    assert.equal((await reopened.list(f.scope.spaceId)).length, 2, "coexistence survives registry reload");
    await assert.rejects(reopened.remove({ spaceId: preview.spaceId, appId: preview.manifest.id, expectedDigest: preview.digest }), /exact app installation/);
    await reopened.remove({ spaceId: preview.spaceId, appId: preview.manifest.id, expectedDigest: preview.digest, featureInstallationId: preview.featureInstallationId });
    assert.deepEqual((await reopened.list(f.scope.spaceId)).map((app) => app.featureInstallationId), [live.featureInstallationId]);
    assert.equal(await f.storage.get(owner(live), "quote"), "release data");
    const changes = await RoutedRestrictedAppProposalHost.create({ service: reopened, registryPath: f.registryPath });
    const newCopy = await changes.prepareChange({ ...input, id: randomUUID(), expectedDigest: preview.digest },
      (receipt, files) => materializeRestrictedAppWorkingCopy(f.spaceRoot, receipt, files, async () => {}));
    assert.equal(newCopy.previewBase, null, "an installed release does not count as an existing preview");
    const restoredProposal = (await changes.propose({ ...f.scope, sourcePath: newCopy.sourcePath })).proposal!;
    const restoredPreview = (await changes.install(restoredProposal.id))!;
    assert.notEqual(restoredPreview.featureInstallationId, preview.featureInstallationId);
    assert.equal(await f.storage.get(owner(restoredPreview), "quote"), undefined, "a fresh preview cannot inherit release or removed-preview data");
    assert.equal((await reopened.list(f.scope.spaceId)).length, 2);
  } finally { await reopened?.close(); await f.close(); }
});

test("the current work-fold v5 registry upgrades atomically without changing installation or data identity", async () => {
  const f = await fixture();
  let reopened: RestrictedAppService | undefined;
  const path = join(f.root, "state", "apps", "registry.json");
  try {
    await f.service.close();
    const before = JSON.parse(await readFile(path, "utf8"));
    assert.equal(before.schemaVersion, 6);
    await writeFile(path, JSON.stringify({ ...before, schemaVersion: 5 }));
    reopened = await RestrictedAppService.create({ rootPath: join(f.root, "state", "apps"), storage: f.storage });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), before);
    assert.equal((await reopened.list(f.scope.spaceId))[0]!.featureInstallationId, f.app.featureInstallationId);
  } finally { await reopened?.close(); await f.close(); }
});
