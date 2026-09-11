import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, protocol, webContents } from "electron";

import {
  RestrictedAppHost,
  restrictedAppProtocol,
} from "../dist/desktop/desktop/src/restricted-app-host.js";
import { RailTooltipOverlay } from "../dist/desktop/desktop/src/rail-tooltip-overlay.js";
import { stageRestrictedAppPackage } from "../dist/desktop/src/local/agent/restricted-app-package.js";
import { FileRestrictedAppStorage } from "../dist/desktop/src/local/agent/restricted-app-storage.js";
import { RestrictedAppNotificationBroker } from "../dist/desktop/src/local/agent/restricted-app-notifications.js";
import { RestrictedAppTaskError } from "../dist/desktop/src/local/agent/restricted-app-tasks.js";
import { parseRestrictedAppInferenceRequest } from "../dist/desktop/src/local/agent/restricted-app-inference.js";
import {
  RestrictedAppError,
  RestrictedAppNetworkBroker,
} from "../dist/desktop/src/local/agent/restricted-app-connections.js";
import { createRestrictedAppViewerAdapter } from "../dist/desktop/src/local/agent/restricted-app-viewer.js";
import {
  createAuthorityStamp,
  createDataNamespaceId,
  createFeatureInstallationId,
  createPrincipalId,
  createProjectId,
  createRuntimeInstanceId,
  createTenantId,
} from "../dist/desktop/src/local/agent/app-platform-contract.js";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

protocol.registerSchemesAsPrivileged([{
  scheme: restrictedAppProtocol,
  privileges: { standard: true, secure: true },
}]);
app.on("window-all-closed", () => {});

// Keep only lifecycle metadata for this synthetic sandbox. Capture it before
// cleanup destroys the evidence; never collect a normal work-fold profile.
const lifecycle = [];
app.on("web-contents-created", (_event, contents) => {
  const record = (event, detail = {}) => {
    lifecycle.push({ at: new Date().toISOString(), id: contents.id, event, ...detail });
    if (lifecycle.length > 200) lifecycle.shift();
  };
  for (const event of ["did-start-loading", "dom-ready", "did-finish-load", "did-stop-loading", "destroyed"]) {
    contents.on(event, () => record(event));
  }
  contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => record("did-fail-load", { code, description, mainFrame }));
  contents.on("render-process-gone", (_event, details) => record("render-process-gone", details));
});

let failed = false;
void mark("loaded")
  .then(() => app.whenReady())
  .then(() => mark("ready"))
  .then(runSmoke)
  .then(() => console.log("Restricted app Electron sandbox smoke passed."))
  .catch(async (error) => {
    failed = true;
    await mark(`error ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    console.error(error);
  })
  .finally(() => app.exit(failed ? 1 : 0));

async function runSmoke() {
  await mark("smoke-start");
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-electron-"));
  const listener = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("escape");
  });
  let hits = 0;
  listener.on("upgrade", (socket) => {
    hits += 1;
    socket.destroy();
  });
  await new Promise((resolveListen, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolveListen);
  });
  await mark("listener-ready");
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const escapeUrl = `http://127.0.0.1:${address.port}/escape`;
  let host;
  try {
    process.env.WORKFOLD_STATE_DIR = join(sandbox, "state");
    const spaceRoot = join(sandbox, "space");
    const sourceRoot = join(spaceRoot, "apps", "source");
    const stagingRoot = join(sandbox, "staged");
    await writeSmokePackage(sourceRoot, address.port);
    await mkdir(join(spaceRoot, "exports"), { recursive: true });
    const receipt = await stageRestrictedAppPackage(sourceRoot, stagingRoot);
    await mark("package-staged");
    const connections = new EmptyConnections();
    const networkOwners = [];
    let lateNetworkEffects = 0;
    let nextLateEffectStarted;
    const productionNetworkBroker = new RestrictedAppNetworkBroker({ credentials: connections });
    const networkBroker = {
      get limits() {
        return productionNetworkBroker.limits;
      },
      async request(owner, manifest, request, signal, authorizeEffect) {
        if (request?.destinationId === "principal-probe") {
          networkOwners.push(structuredClone(owner));
          throw new RestrictedAppError("NETWORK_DENIED", "Principal attribution probe completed.");
        }
        if (request?.destinationId === "late-effect") {
          const started = nextLateEffectStarted;
          nextLateEffectStarted = undefined;
          started?.();
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 180));
          await authorizeEffect?.();
          lateNetworkEffects += 1;
          return { status: 204, headers: {}, body: "", encoding: "utf8" };
        }
        return await productionNetworkBroker.request(owner, manifest, request, signal, authorizeEffect);
      },
    };
    const storage = new FileRestrictedAppStorage(join(sandbox, "app-data"));
    const tabCommands = [];
    const shownNotifications = [];
    const notificationBroker = new RestrictedAppNotificationBroker({
      sink: {
        isSupported: () => true,
        show: (notification, callbacks) => {
          const handle = { close: () => callbacks.onClose() };
          shownNotifications.push({ notification, callbacks, handle });
          return handle;
        },
      },
    });
    host = new RestrictedAppHost({
      readCheckResult: async (spaceId, checkId, declarationDigest) => {
        assert.equal(spaceId, "ws-electron-smoke");
        assert.equal(checkId, "smoke-check");
        assert.equal(declarationDigest, "c".repeat(64));
        return { checkId, declarationDigest, title: "Smoke Check", state: "never-run", lastRunAt: null, findings: [], truncated: false };
      },
      assistantTasks: async () => ({
        async request(scope, request, assertCurrent) {
          assertCurrent();
          assert.equal(scope.spaceId, "ws-electron-smoke");
          assert.equal(scope.appId, "restricted-electron-smoke");
          assert.equal(typeof scope.featureInstallationId, "string");
          assert.match(scope.authorityDigest, /^[a-f0-9]{64}$/);
          if (request.actionId !== "compare") throw new RestrictedAppTaskError("TASK_DENIED", "Choose a declared action.");
          return { requestId: request.requestId, status: "pending" };
        },
        async list() { return []; },
        async get(_scope, requestId) { return { requestId, status: "pending" }; },
        async cancel(_scope, requestId, assertCurrent) { assertCurrent(); return { requestId, status: "cancelled" }; },
      }),
      assistantInference: async () => ({
        async infer(scope, surface, request, options) {
          // The real request bounds, so the smoke exercises the same refusals
          // an app meets in the running product.
          const parsed = parseRestrictedAppInferenceRequest(request);
          options.assertCurrent();
          assert.equal(scope.spaceId, "ws-electron-smoke");
          assert.equal(scope.appId, "restricted-electron-smoke");
          assert.match(scope.authorityDigest, /^[a-f0-9]{64}$/);
          const model = { provider: "smoke", id: "smoke-model" };
          const usage = { inputTokens: 1, outputTokens: 1 };
          // A real model call is never under the five-second worker invocation
          // deadline, and the published inference budget is 120 s
          // (docs/receipts-not-gates.md, F22). A worker awaiting this lane must
          // not be crashed for it, so the worker surface deliberately answers
          // later than that deadline.
          if (surface === "worker") await new Promise((resolve) => setTimeout(resolve, 6_000));
          return parsed.outputSchema
            ? { json: { echoed: parsed.input }, model, usage }
            : { text: "echo:" + surface, truncated: false, model, usage };
        },
      }),
      connections,
      networkBroker,
      storage,
      resolveSpaceRoot: async (spaceId) => spaceId === "ws-electron-smoke" ? spaceRoot : null,
      preloadPath: join(rootDir, "dist", "desktop", "desktop", "src", "restricted-app-preload.cjs"),
      notifications: notificationBroker,
      onTabCommand: (command) => tabCommands.push(command),
    });
    const descriptor = {
      spaceId: "ws-electron-smoke",
      projectId: createProjectId(),
      tenantId: createTenantId(),
      principalId: createPrincipalId(),
      servicePrincipalId: createPrincipalId(),
      runtimeInstanceId: createRuntimeInstanceId(),
      featureInstallationId: createFeatureInstallationId(),
      dataNamespaceId: createDataNamespaceId(),
      authority: createAuthorityStamp(),
      packageName: receipt.packageName,
      version: receipt.version,
      digest: receipt.digest,
      artifactDigest: receipt.artifactDigest,
      manifest: receipt.manifest,
      networkGrants: ["escape", "principal-probe", "late-effect"],
      checkGrants: [{ permissionId: "review", checkId: "smoke-check", declarationDigest: "c".repeat(64) }],
      fileGrants: [{ id: "exports", declarationId: "exports", root: "exports", access: "read-write" }],
      notificationGrants: ["automation-update", "post-return", "suspend-probe"],
      automations: [{ id: "smoke-automation", enabled: true }],
      fileCount: receipt.fileCount,
      totalBytes: receipt.totalBytes,
      installedAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
      stagedRoot: receipt.stagedRoot,
    };
    const storageOwner = {
      ownerClass: "instance",
      tenantId: descriptor.tenantId,
      runtimeInstanceId: descriptor.runtimeInstanceId,
      featureInstallationId: descriptor.featureInstallationId,
      dataNamespaceId: descriptor.dataNamespaceId,
    };
    host.syncAuthority([{
      spaceId: descriptor.spaceId,
      appId: descriptor.manifest.id,
      digest: descriptor.digest,
      runtimeInstanceId: descriptor.runtimeInstanceId,
      featureInstallationId: descriptor.featureInstallationId,
      authority: descriptor.authority,
    }]);

    const probe = await host.invoke(descriptor, "probe", { text: "Hello, 🌍 — 你好", escapeUrl });
    await mark(`probe-complete ${JSON.stringify(probe)}`);
    assert.deepEqual(probe, {
      echoed: "Hello, 🌍 — 你好",
      nodeGlobalsAbsent: true,
      nodeImportBlocked: true,
      directFetchBlocked: true,
      directWebSocketBlocked: true,
      webRtcBlocked: true,
      popupBlocked: true,
      brokerDenied: true,
      workerTopLevelStorageDenied: true,
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    assert.equal(hits, 0, "the restricted renderer must not reach the loopback listener directly");

    const peer = { ...descriptor, runtimeInstanceId: createRuntimeInstanceId(), featureInstallationId: createFeatureInstallationId(),
      dataNamespaceId: createDataNamespaceId(), authority: createAuthorityStamp(), networkGrants: [], fileGrants: [], notificationGrants: [], automations: [] };
    const authorityOf = (item) => ({ spaceId: item.spaceId, appId: item.manifest.id, digest: item.digest,
      runtimeInstanceId: item.runtimeInstanceId, featureInstallationId: item.featureInstallationId, authority: item.authority });
    const peerOwner = { ...storageOwner, runtimeInstanceId: peer.runtimeInstanceId, featureInstallationId: peer.featureInstallationId, dataNamespaceId: peer.dataNamespaceId };
    await storage.set(storageOwner, "instance-value", "source");
    await storage.set(peerOwner, "instance-value", "release");
    host.syncAuthority([authorityOf(descriptor), authorityOf(peer)]);
    assert.throws(() => host.syncAuthority([authorityOf(descriptor), { ...authorityOf(peer), featureInstallationId: descriptor.featureInstallationId, appId: "different-name" }]), /duplicate Feature Installation identity/);
    const sourceIdentity = await host.invoke(descriptor, "instance", {});
    const peerIdentity = await host.invoke(peer, "instance", {});
    assert.equal(sourceIdentity.value, "source");
    assert.equal(peerIdentity.value, "release");
    assert.notEqual(sourceIdentity.token, peerIdentity.token);
    const stoppedAction = new AbortController();
    stoppedAction.abort();
    await assert.rejects(host.invoke(descriptor, "signal", {}, { invocationId: randomUUID(), signal: stoppedAction.signal, assertCurrent() {} }), (error) => error?.code === "AUTHORITY_STALE");
    let browserAllowed = true;
    const actionSignal = new AbortController();
    const revocationExecution = { invocationId: randomUUID(), signal: actionSignal.signal,
      assertCurrent() { if (!browserAllowed) throw new RestrictedAppError("AUTHORITY_STALE", "The browser was revoked."); } };
    nextLateEffectStarted = () => { browserAllowed = false; };
    const effectsBeforeFence = lateNetworkEffects;
    await assert.rejects(host.invoke(descriptor, "revocation-fence", {}, revocationExecution));
    assert.equal(lateNetworkEffects, effectsBeforeFence, "browser revocation fences an already-admitted network effect without relying on abort");
    assert.equal(await storage.get(storageOwner, "revocation-fence"), undefined, "a revoked action cannot continue into storage");
    browserAllowed = true;
    nextLateEffectStarted = () => actionSignal.abort();
    await assert.rejects(host.invoke(descriptor, "revocation-fence", {}, revocationExecution));
    assert.equal(lateNetworkEffects, effectsBeforeFence);
    assert.deepEqual(await host.invoke(peer, "instance", {}), peerIdentity, "stopping a fenced action does not stop its sibling installation");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 220));
    assert.equal(lateNetworkEffects, effectsBeforeFence, "a stopped worker's delayed effect remains fenced");
    const reusedSignal = new AbortController();
    await host.invoke(descriptor, "signal", {}, { invocationId: randomUUID(), signal: reusedSignal.signal, assertCurrent() {} });
    const afterFencedAction = await host.invoke(descriptor, "instance", {});
    reusedSignal.abort();
    assert.deepEqual(await host.invoke(descriptor, "instance", {}), afterFencedAction, "a completed action releases its abort listener");
    await mark("revocation-fence-complete");
    assert.equal((await host.invoke(descriptor, "instance", {})).value, sourceIdentity.value, "a sibling must not replace the original data owner");
    host.syncAuthority([authorityOf(descriptor)]);
    await assert.rejects(host.invoke(peer, "instance", {}), (error) => error?.code === "AUTHORITY_STALE");
    assert.deepEqual(await host.invoke(descriptor, "instance", {}), afterFencedAction, "revoking a sibling must not invalidate the original worker");
    host.syncAuthority([authorityOf(descriptor), authorityOf(peer)]);
    const peerAfterRevocation = await host.invoke(peer, "instance", {});
    await host.stop(descriptor.spaceId, descriptor.manifest.id, descriptor.digest, descriptor.featureInstallationId);
    assert.deepEqual(await host.invoke(peer, "instance", {}), peerAfterRevocation, "an exact installation stop leaves its sibling running");
    await host.stop(peer.spaceId, peer.manifest.id, peer.digest, peer.featureInstallationId);
    const pendingPeer = host.invoke(peer, "instance", {});
    const pendingRejection = assert.rejects(pendingPeer, (error) => error?.code === "APP_UNAVAILABLE");
    host.syncAuthority([authorityOf(descriptor)]);
    host.syncAuthority([authorityOf(descriptor), authorityOf(peer)]);
    await pendingRejection;
    host.syncAuthority([authorityOf(descriptor)]);
    await mark("installation-isolation-complete");

    await mark("notification-start");
    assert.deepEqual(await host.invoke(descriptor, "notification", {}), {
      workerTopLevelNotificationDenied: true,
      actionNotificationDenied: true,
      workerInferText: "echo:worker",
      workerTopLevelInferDenied: true,
      workerChecksHints: 0,
    });

    await mark("frame-denial-start");
    await assert.rejects(host.invoke(descriptor, "frame", {}), (error) => error?.code === "APP_CRASHED");
    await mark("frame-recovery-start");
    const afterFrame = await host.invoke(descriptor, "probe", { text: "Frame recovery", escapeUrl });
    assert.equal(afterFrame.echoed, "Frame recovery");
    await assert.rejects(host.invoke(descriptor, "huge", {}), (error) => error?.code === "OUTPUT_INVALID");
    await assert.rejects(host.invoke(descriptor, "cyclic", {}), (error) => error?.code === "OUTPUT_INVALID");
    await assert.rejects(host.invoke(descriptor, "intrinsics", {}), (error) => error?.code === "OUTPUT_INVALID");
    await mark("timeout-start");
    await assert.rejects(host.invoke(descriptor, "hang", {}), (error) => error?.code === "APP_TIMEOUT");
    await mark("timeout-complete");

    const recovered = await host.invoke(descriptor, "probe", { text: "Recovered ✅", escapeUrl });
    assert.equal(recovered.echoed, "Recovered ✅");
    assert.equal(hits, 0);
    await mark("recovery-complete");

    await mark("automation-start");
    await host.runAutomation(descriptor, automationEvent("2026-07-13T00:00:00.000Z", "manual", {
      principalId: descriptor.principalId,
      kind: "human",
      realm: "local",
    }));
    assert.equal(networkOwners.at(-1)?.effectivePrincipalId, descriptor.principalId, "manual work reaches the broker as the human Principal");
    await host.runAutomation(descriptor, automationEvent("2026-07-13T00:00:15.000Z", "manual", {
      principalId: descriptor.principalId,
      kind: "human",
      realm: "local",
    }));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    assert.equal(lateNetworkEffects, 0, "unawaited network work cannot outlive its exact worker operation");
    assert.deepEqual(await storage.get(storageOwner, "automation"), {
      runId: "smoke-2026-07-13T00:00:00.000Z",
      automationId: "smoke-automation",
      handler: "smoke",
      reason: "manual",
      scheduledAt: "2026-07-13T00:00:00.000Z",
    });
    assert.deepEqual(shownNotifications.map((item) => item.notification), [{
      spaceId: descriptor.spaceId,
      appId: descriptor.manifest.id,
      featureInstallationId: descriptor.featureInstallationId,
      digest: descriptor.digest,
      permissionId: "automation-update",
      title: "work-fold · Restricted Electron smoke — Automation update",
      body: "New sandboxed app data is ready.",
    }]);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
    assert.equal(shownNotifications.length, 1, "notification calls after handleAutomation returns are denied");
    assert.equal(await storage.get(storageOwner, "worker-storage-events"), 0);
    // A worker subscribes, but only what it can act on reaches it: Check
    // results are view-only, and tasks arrive only while it holds an operation.
    assert.equal(await storage.get(storageOwner, "worker-checks-hints"), 0);
    assert.equal(await storage.get(storageOwner, "worker-tasks-hints"), 0);
    const suspendedRun = host.runAutomation(descriptor, automationEvent("2026-07-13T00:00:30.000Z", "scheduled", {
      principalId: descriptor.servicePrincipalId,
      kind: "service",
      realm: "local",
    }));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    host.suspend();
    await assert.rejects(suspendedRun, (error) => error?.code === "APP_ERROR");
    assert.equal(networkOwners.at(-1)?.effectivePrincipalId, descriptor.servicePrincipalId, "scheduled work reaches the broker as the service Principal");
    assert.equal(shownNotifications.length, 1, "suspend denies an in-flight automation notification");
    host.resume();
    await mark("automation-complete");

    const parent = new BrowserWindow({ show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await parent.loadURL("data:text/html,<main>work-fold owner</main>");
    const staleMount = host.mountUi(descriptor, parent.webContents, parent, {
      mountId: "00000000-0000-4000-8000-000000000000",
      placement: "navigator",
      route: "/",
      sequence: 0,
      bounds: { x: 0, y: 0, width: 320, height: 500 },
      active: true,
      occluded: false,
      theme: "dark",
    });
    const staleMountRejection = assert.rejects(
      staleMount,
      (error) => error?.code === "APP_UNAVAILABLE",
      "stop invalidates an in-flight stale UI mount",
    );
    await host.stop(descriptor.spaceId, descriptor.manifest.id, descriptor.digest);
    await staleMountRejection;
    const mountId = "11111111-1111-4111-8111-111111111111";
    await host.mountUi(descriptor, parent.webContents, parent, {
      mountId,
      placement: "navigator",
      route: "/",
      state: { escapeUrl },
      sequence: 0,
      bounds: { x: 0, y: 0, width: 320, height: 500 },
      active: true,
      occluded: false,
      theme: "dark",
    });
    await waitFor(
      () => tabCommands.length === 1,
      "the visible restricted app did not finish its startup bridge calls",
    );
    assert.equal(hits, 0, "the visible restricted app must not reach loopback directly");
    assert.deepEqual(tabCommands.map((command) => ({ type: command.type, spaceId: command.spaceId, appId: command.appId, digest: command.digest, featureInstallationId: command.featureInstallationId, tab: command.tab })), [{
      type: "open",
      spaceId: descriptor.spaceId,
      appId: descriptor.manifest.id,
      digest: descriptor.digest,
      featureInstallationId: descriptor.featureInstallationId,
      tab: {
        appTabId: "smoke-tab",
        title: "Sandbox ready",
        route: "/ready",
        state: { directFetchBlocked: true, stored: "visible-ui", file: "host-brokered" },
      },
    }]);
    await mark("tooltip-mount-start");
    const tooltipOverlay = new RailTooltipOverlay(parent);
    tooltipOverlay.show({
      text: "Restricted Electron smoke",
      bounds: { x: 72, y: 28, width: 170, height: 28 },
      theme: "light",
    });
    await waitFor(
      () => parent.contentView.children.length === 2,
      "the native rail tooltip did not mount above the restricted app view",
      15_000, // Native document readiness on shared runners; still assert actual mount/order.
    );
    await mark("tooltip-mounted");
    assert.match(parent.contentView.children[0]?.webContents.getURL() ?? "", /^agent-app:/);
    assert.match(parent.contentView.children.at(-1)?.webContents.getURL() ?? "", /^data:text\/html/);
    host.layoutUi(parent.webContents.id, {
      mountId,
      placement: "navigator",
      route: "/",
      state: { escapeUrl },
      sequence: 1,
      bounds: { x: 0, y: 0, width: 320, height: 500 },
      active: true,
      occluded: false,
      theme: "dark",
    });
    tooltipOverlay.raise();
    assert.equal(parent.contentView.children.length, 2, "showing a tooltip must keep the restricted app attached");
    assert.match(parent.contentView.children[0]?.webContents.getURL() ?? "", /^agent-app:/);
    assert.match(parent.contentView.children.at(-1)?.webContents.getURL() ?? "", /^data:text\/html/);
    tooltipOverlay.hide();
    assert.equal(parent.contentView.children.length, 1, "hiding a tooltip must leave the restricted app attached");
    assert.match(parent.contentView.children[0]?.webContents.getURL() ?? "", /^agent-app:/);
    const originalContents = parent.contentView.children[0].webContents;
    assert.equal(await storage.get(storageOwner, "ui-notification-denied"), true);
    assert.deepEqual(await storage.get(storageOwner, "check-read"), { checkId: "smoke-check", declarationDigest: "c".repeat(64), title: "Smoke Check", state: "never-run", lastRunAt: null, findings: [], truncated: false });
    assert.equal(await storage.get(storageOwner, "check-undeclared-denied"), true);
    assert.deepEqual(await storage.get(storageOwner, "assistant-bridge"), { requested: "pending", read: "pending", cancelled: "cancelled", undeclaredDenied: true, approvalAbsent: true });
    assert.deepEqual(await storage.get(storageOwner, "assistant-infer"), {
      text: "echo:view",
      model: "smoke-model",
      json: { echoed: "south" },
      invalidRefused: true,
    });
    await storage.transaction(storageOwner, {
      set: Array.from({ length: 128 }, (_, index) => ({ key: "seed-" + String(index).padStart(3, "0"), value: index })),
    });
    await host.runAutomation(descriptor, automationEvent("2026-07-13T00:01:00.000Z", "scheduled", {
      principalId: descriptor.servicePrincipalId,
      kind: "service",
      realm: "local",
    }));
    await waitFor(async () => (
      await storage.get(storageOwner, "active-storage-event") === true
      && await storage.get(storageOwner, "reset-storage-event") === true
      && await storage.get(storageOwner, "automation-storage-event-count") === 1
    ), async () => `the active app view did not receive its bounded storage event: ${JSON.stringify({
      active: await storage.get(storageOwner, "active-storage-event"),
      reset: await storage.get(storageOwner, "reset-storage-event"),
      count: await storage.get(storageOwner, "automation-storage-event-count"),
    })}`, 15_000);
    assert.equal(await storage.get(storageOwner, "active-storage-event"), true, "automation storage changes reach the active owning UI");
    assert.equal(await storage.get(storageOwner, "reset-storage-event"), true, "more than 128 changed keys produce a bounded reset hint");
    // The three owned-id hints (docs/collaboration-contract.md, F30): pushed by
    // the host, delivered to the mounts each read lane admits, carrying ids and
    // a revision and never content.
    assert.equal(await storage.get(storageOwner, "ui-hint-listener-type-checked"), 3, "every registration type-checks its listener");
    host.publishAssistantActivity({
      spaceId: descriptor.spaceId,
      appId: descriptor.manifest.id,
      featureInstallationId: descriptor.featureInstallationId,
      taskIds: ["smoke-task"],
      receiptIds: ["smoke-receipt"],
    });
    await waitFor(async () => (await storage.get(storageOwner, "ui-tasks-hint"))?.count === 1,
      "the active app view never received its Assistant task hint", 15_000);
    const firstTasksHint = await storage.get(storageOwner, "ui-tasks-hint");
    assert.deepEqual(firstTasksHint.taskIds, ["smoke-task"]);
    assert.deepEqual(firstTasksHint.receiptIds, ["smoke-receipt"]);
    assert.equal(firstTasksHint.revision, 1, "a revision orders hints inside one mount's lifetime");
    assert.equal(firstTasksHint.active, true);

    host.publishCheckResultsChanged({ spaceId: descriptor.spaceId, checkIds: ["smoke-check", "not-selected"] });
    await waitFor(async () => (await storage.get(storageOwner, "ui-checks-hint"))?.count === 1,
      "the active app view never received its Check result hint", 15_000);
    assert.deepEqual((await storage.get(storageOwner, "ui-checks-hint")).permissionIds, ["review"],
      "a Check hint names this app's own slot, never the Check id");
    host.publishCheckResultsChanged({ spaceId: descriptor.spaceId, checkIds: ["not-selected"] });
    host.publishCheckResultsChanged({ spaceId: "another-space", checkIds: ["smoke-check"] });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    assert.equal((await storage.get(storageOwner, "ui-checks-hint")).count, 1,
      "a Check this app did not select, or another Space's, produces nothing");

    // The view wrote smoke.txt into its granted root at startup, so the bounded
    // granted-root observation has a real change to notice.
    await waitFor(async () => (await storage.get(storageOwner, "ui-files-hint"))?.count >= 1,
      "the active app view never learned its granted folder changed", 20_000);
    const filesHint = await storage.get(storageOwner, "ui-files-hint");
    assert.deepEqual(filesHint.permissionIds, ["exports"], "a file hint names the grant the app already passes to files.read");
    assert.equal(filesHint.truncated, false);
    assert.ok(!JSON.stringify(filesHint).includes("smoke.txt"), "a hint carries ids and a revision, never a path");

    host.syncAuthority([authorityOf(descriptor), authorityOf(peer)]);
    await host.invoke(peer, "signal", {});
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    assert.deepEqual(await storage.get(peerOwner, "automation"), { peerSignal: true });
    assert.equal(await storage.get(storageOwner, "automation-storage-event-count"), 1, "a sibling's data change cannot reach the original view");
    host.syncAuthority([authorityOf(descriptor)]);
    assert.equal(await storage.get(storageOwner, "automation-storage-event-count"), 1, "one automation mutation emits once");
    host.layoutUi(parent.webContents.id, {
      mountId,
      placement: "navigator",
      route: "/",
      state: { escapeUrl },
      sequence: 2,
      bounds: { x: 0, y: 0, width: 320, height: 500 },
      active: false,
      occluded: true,
      theme: "dark",
    });
    await waitFor(
      async () => await storage.get(storageOwner, "inactive-powers") !== undefined,
      "the inactive app view did not finish its authority probe",
    );
    assert.deepEqual(await storage.get(storageOwner, "inactive-powers"), {
      fileDenied: true,
      networkDenied: true,
      checkDenied: true,
      assistantDenied: true,
      inferDenied: true,
    });
    // An inactive view is told nothing and gets no replay when it comes back.
    const hintsWhenInactive = {
      tasks: (await storage.get(storageOwner, "ui-tasks-hint"))?.count,
      checks: (await storage.get(storageOwner, "ui-checks-hint"))?.count,
      files: (await storage.get(storageOwner, "ui-files-hint"))?.count,
    };
    host.publishAssistantActivity({
      spaceId: descriptor.spaceId,
      appId: descriptor.manifest.id,
      featureInstallationId: descriptor.featureInstallationId,
      taskIds: ["while-inactive"],
      receiptIds: [],
    });
    host.publishCheckResultsChanged({ spaceId: descriptor.spaceId, checkIds: ["smoke-check"] });
    await writeFile(join(spaceRoot, "exports", "while-inactive.txt"), "changed while inactive", "utf8");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 4_000));
    assert.deepEqual({
      tasks: (await storage.get(storageOwner, "ui-tasks-hint"))?.count,
      checks: (await storage.get(storageOwner, "ui-checks-hint"))?.count,
      files: (await storage.get(storageOwner, "ui-files-hint"))?.count,
    }, hintsWhenInactive, "an inactive app view receives no hint and no replay");
    assert.equal(hits, 0, "an inactive app view must not retain file or network powers");
    await host.runAutomation(descriptor, automationEvent("2026-07-13T00:02:00.000Z", "resume", {
      principalId: descriptor.servicePrincipalId,
      kind: "service",
      realm: "local",
    }));
    assert.equal(networkOwners.at(-1)?.effectivePrincipalId, descriptor.servicePrincipalId, "resumed work reaches the broker as the service Principal");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    assert.equal(await storage.get(storageOwner, "inactive-storage-event"), undefined, "inactive app views receive no storage event or replay");
    tooltipOverlay.close();
    // Reusing a renderer mount id must never reuse another installation's view.
    await mkdir(join(spaceRoot, "peer-exports"));
    const peerUi = { ...peer, fileGrants: descriptor.fileGrants.map((grant) => ({ ...grant, root: "peer-exports" })), networkGrants: descriptor.networkGrants };
    host.syncAuthority([authorityOf(descriptor), authorityOf(peerUi)]);
    await host.mountUi(peerUi, parent.webContents, parent, {
      mountId, placement: "navigator", route: "/", state: { escapeUrl }, sequence: 3,
      bounds: { x: 0, y: 0, width: 320, height: 500 }, active: true, occluded: false, theme: "dark",
    });
    await waitFor(() => tabCommands.length === 2, "the sibling installation did not create its own view");
    assert.equal(originalContents.isDestroyed(), true);
    assert.equal(tabCommands[1].featureInstallationId, peer.featureInstallationId);
    assert.equal(await storage.get(peerOwner, "visible"), "visible-ui");
    const peerView = parent.contentView.children[0];
    await host.stop(descriptor.spaceId, descriptor.manifest.id, descriptor.digest, descriptor.featureInstallationId);
    assert.equal(peerView.webContents.isDestroyed(), false, "stopping the original must preserve its sibling view");
    await host.unmountUi(parent.webContents.id, mountId);
    parent.destroy();
    await mark("ui-complete");

    // Rung 3 viewer-scope denials (docs/fold-publishing.md; fold integration
    // item 26): the desktop viewer adapter over the same real staged bytes,
    // storage, and identity records this Electron host runs — viewers reach
    // the reviewed entry, exact staged assets, and the manifest-declared
    // viewer-readable collection, and nothing else: no actions, no egress,
    // no connections, no files, no writes.
    const viewerState = { releaseDigest: `sha256:${"a".repeat(64)}`, widenSurface: false };
    const viewerAdapter = createRestrictedAppViewerAdapter({
      resolveInstance: async (appInstanceId) => {
        if (appInstanceId !== descriptor.featureInstallationId) return null;
        const manifest = structuredClone(descriptor.manifest);
        if (viewerState.widenSurface && manifest.viewer) manifest.viewer.readable.push("viewer-private/");
        return {
          spaceId: descriptor.spaceId,
          packageName: descriptor.packageName,
          version: descriptor.version,
          digest: descriptor.digest,
          artifactDigest: descriptor.artifactDigest,
          releaseDigest: viewerState.releaseDigest,
          runtimeInstanceKind: "app",
          manifest,
          tenantId: descriptor.tenantId,
          runtimeInstanceId: descriptor.runtimeInstanceId,
          featureInstallationId: descriptor.featureInstallationId,
          dataNamespaceId: descriptor.dataNamespaceId,
          fileCount: descriptor.fileCount,
          totalBytes: descriptor.totalBytes,
          stagedRoot: descriptor.stagedRoot,
        };
      },
      storage,
    });
    const exposure = await viewerAdapter.resolveExposure(descriptor.featureInstallationId);
    assert.equal(exposure.eligible, true);
    assert.deepEqual(exposure.pins.viewerSurface, ["entry:viewer.html", "data:viewer-public/"]);
    const viewerPins = exposure.pins;
    await storage.set(storageOwner, "viewer-public/greeting", "hello audience");
    await storage.set(storageOwner, "viewer-private/secret", "never");
    const viewerHitsBefore = hits;
    const networkOwnersBefore = networkOwners.length;
    const notificationsBefore = shownNotifications.length;

    const served = async (call) => {
      const outcome = await viewerAdapter.serve(viewerPins, call);
      assert.equal(outcome.state, "served", `expected a served outcome for ${JSON.stringify(call)}`);
      return outcome.result;
    };
    const deniedViewer = async (call, pattern) => {
      const result = await served(call);
      assert.equal(result.ok, false, `expected a typed viewer denial for ${JSON.stringify(call)}`);
      assert.match(result.message, pattern);
    };

    const entry = await served({ kind: "entry" });
    assert.equal(entry.ok, true);
    assert.equal(
      Buffer.from(entry.result.bytes, "base64url").toString("utf8"),
      "<!doctype html><main>viewer smoke surface</main>",
      "the viewer entry serves the exact staged bytes",
    );
    const asset = await served({ kind: "asset", path: "index.html" });
    assert.equal(asset.ok, true);
    const dataRead = await served({ kind: "data.get", key: "viewer-public/greeting" });
    assert.deepEqual(dataRead.result, { kind: "data.get", key: "viewer-public/greeting", present: true, value: "hello audience" });
    const dataKeys = await served({ kind: "data.keys" });
    assert.deepEqual(dataKeys.result.keys.filter((key) => key.startsWith("viewer-")), ["viewer-public/greeting"],
      "keys outside the viewer-readable collection are never listed");

    // The denial matrix of integration item 26: actions, egress, connections,
    // files, writes — plus notifications, jobs, host UI, and unknown kinds.
    await deniedViewer({ kind: "data.set", key: "viewer-public/greeting", value: "defaced" }, /Viewers mutate nothing/);
    await deniedViewer({ kind: "storage.clear" }, /Viewers mutate nothing/);
    await deniedViewer({ kind: "action", action: "probe" }, /person's runtime/);
    await deniedViewer({ kind: "invoke", tool: "probe", input: { text: "x", escapeUrl } }, /person's runtime/);
    await deniedViewer({ kind: "network.request", destinationId: "escape", method: "GET", path: "/escape" }, /network egress/);
    await deniedViewer({ kind: "fetch", url: escapeUrl }, /network egress/);
    await deniedViewer({ kind: "connections.list" }, /saved credential/);
    await deniedViewer({ kind: "oauth.start", destinationId: "mail-api" }, /saved credential/);
    await deniedViewer({ kind: "files.read", grantId: "exports", path: "smoke.txt" }, /person's own use of the app/);
    await deniedViewer({ kind: "notifications.show", permissionId: "automation-update" }, /Notifications are not viewer-reachable/);
    await deniedViewer({ kind: "automation.run", automationId: "smoke-automation" }, /Viewers cannot run, schedule, or observe jobs/);
    await deniedViewer({ kind: "tabs.open", tabId: "viewer-tab" }, /outside the desktop shell/);
    await deniedViewer({ kind: "made.up.call" }, /not viewer-reachable/);
    await deniedViewer({ kind: "data.get", key: "viewer-private/secret" }, /outside the app's viewer-readable collections/);
    const escapeAsset = await served({ kind: "asset", path: "../outside.js" });
    assert.equal(escapeAsset.ok, false);
    assert.equal(escapeAsset.code, "not-found");

    assert.equal(hits, viewerHitsBefore, "no viewer call may reach the loopback listener");
    assert.equal(networkOwners.length, networkOwnersBefore, "no viewer call reaches the network broker at all");
    assert.equal(shownNotifications.length, notificationsBefore, "no viewer call shows a notification");
    assert.equal(await storage.get(storageOwner, "viewer-public/greeting"), "hello audience", "viewer traffic mutated nothing");

    // An unchanged-surface update keeps serving; a widened surface stops
    // until a fresh outward-exposure consecration.
    viewerState.releaseDigest = `sha256:${"b".repeat(64)}`;
    assert.equal((await viewerAdapter.serve(viewerPins, { kind: "entry" })).state, "served");
    viewerState.widenSurface = true;
    const widened = await viewerAdapter.serve(viewerPins, { kind: "entry" });
    assert.equal(widened.state, "not-available");
    assert.match(widened.reason, /viewer surface changed/);
    viewerState.widenSurface = false;
    await mark("viewer-scope-complete");
  } catch (error) {
    await captureFailure(error).catch((captureError) => console.error("Smoke diagnostics failed:", captureError));
    throw error;
  } finally {
    await mark("cleanup-start");
    try {
      await host?.close();
    } catch (error) {
      await mark(`host-close-error ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      throw error;
    }
    await mark("host-closed");
    await new Promise((resolveClose) => listener.close(resolveClose));
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function mark(message) {
  console.log(`[restricted-app smoke] ${message}`);
  const path = process.env.WORKFOLD_RESTRICTED_SMOKE_LOG;
  if (path) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${new Date().toISOString()} ${message}\n`, "utf8");
  }
}

async function captureFailure(error) {
  const directory = join(rootDir, "out", "ci", "restricted-app-smoke");
  await mkdir(directory, { recursive: true });
  const windows = BrowserWindow.getAllWindows().map((window) => ({
    id: window.id, bounds: window.getBounds(), visible: window.isVisible(),
    children: window.contentView.children.map((view) => view.webContents?.id ?? null),
  }));
  const contents = webContents.getAllWebContents().filter((item) => !item.isDestroyed());
  const snapshot = contents.map((item) => ({
    id: item.id, type: item.getType(), loading: item.isLoading(),
    // A data URL can contain an entire document; only its scheme is useful.
    scheme: item.getURL().split(":", 1)[0], crashed: item.isCrashed(),
  }));
  await writeFile(join(directory, "state.json"), JSON.stringify({
    error: error instanceof Error ? error.stack : String(error), lifecycle, windows, contents: snapshot,
  }, null, 2));
  for (const item of contents) {
    let timer;
    try {
      const screenshot = await Promise.race([
        item.capturePage(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Capture timed out")), 2_000); }),
      ]);
      if (!screenshot.isEmpty()) await writeFile(join(directory, `contents-${item.id}.png`), screenshot.toPNG());
    } catch { /* A failed renderer may be unable to paint; state.json remains. */ }
    finally { clearTimeout(timer); }
  }
  console.error(`Electron failure evidence: ${directory}`);
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.fail(typeof message === "function" ? await message() : message);
}

async function writeSmokePackage(root, loopbackPort) {
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({
      name: "restricted-electron-smoke",
      version: "0.1.0",
      private: true,
      type: "module",
      agentApp: "agent-app.json",
    }), "utf8"),
    writeFile(join(root, "agent-app.json"), JSON.stringify(smokeManifest(loopbackPort)), "utf8"),
    writeFile(join(root, "index.html"), "<!doctype html><main id=app></main><script type=module src=ui.js></script>", "utf8"),
    writeFile(join(root, "viewer.html"), "<!doctype html><main>viewer smoke surface</main>", "utf8"),
    writeFile(join(root, "ui.js"), `
const bridge = globalThis.workFoldRestrictedApp;
const context = bridge.context.get();
let currentActive = context.active;
let automationStorageEventCount = 0;
bridge.storage.onChanged(async (event) => {
  if (event.reset) {
    automationStorageEventCount += 1;
    await bridge.storage.set("reset-storage-event", true);
    await bridge.storage.set("automation-storage-event-count", automationStorageEventCount);
    await bridge.storage.set(currentActive ? "active-storage-event" : "inactive-storage-event", true);
    return;
  }
  if (!event.keys.includes("automation")) return;
  automationStorageEventCount += 1;
  await bridge.storage.set("automation-storage-event-count", automationStorageEventCount);
  await bridge.storage.set(currentActive ? "active-storage-event" : "inactive-storage-event", true);
});
// The three owned-id hints (docs/collaboration-contract.md, F30). Each carries
// ids and an ordering revision only; the counters prove no replay.
let tasksHints = 0;
let checksHints = 0;
let filesHints = 0;
bridge.tasks.onChanged(async (event) => {
  tasksHints += 1;
  await bridge.storage.set("ui-tasks-hint", { count: tasksHints, revision: event.revision, taskIds: event.taskIds, receiptIds: event.receiptIds, active: currentActive });
});
bridge.checks.onChanged(async (event) => {
  checksHints += 1;
  await bridge.storage.set("ui-checks-hint", { count: checksHints, revision: event.revision, permissionIds: event.permissionIds, active: currentActive });
});
bridge.files.onChanged(async (event) => {
  filesHints += 1;
  await bridge.storage.set("ui-files-hint", { count: filesHints, revision: event.revision, permissionIds: event.permissionIds, truncated: event.truncated, active: currentActive });
});
let hintListenerTypeChecked = 0;
for (const register of [bridge.tasks.onChanged, bridge.checks.onChanged, bridge.files.onChanged]) {
  try { register("not a function"); } catch (error) { if (error instanceof TypeError) hintListenerTypeChecked += 1; }
}
await bridge.storage.set("ui-hint-listener-type-checked", hintListenerTypeChecked);
bridge.context.onChanged(async (next) => {
  currentActive = next.active;
  if (next.active) return;
  let fileDenied = false;
  let networkDenied = false;
  let checkDenied = false;
  let assistantDenied = false;
  try { await bridge.files.read({ grantId: "exports", path: "smoke.txt", encoding: "utf8" }); } catch { fileDenied = true; }
  try { await bridge.request({ destinationId: "escape", method: "GET", path: "/escape" }); } catch { networkDenied = true; }
  try { await bridge.checks.read({ permissionId: "review" }); } catch { checkDenied = true; }
  try { await bridge.assistant.list(); } catch (error) { assistantDenied = error instanceof Error && error.code === "TASK_DENIED"; }
  let inferDenied = false;
  try { await bridge.assistant.infer({ instructions: "Echo", input: "hi" }); }
  catch (error) { inferDenied = error instanceof Error && error.code === "INFER_UNAVAILABLE"; }
  await bridge.storage.set("inactive-powers", { fileDenied, networkDenied, checkDenied, assistantDenied, inferDenied });
});
await bridge.storage.set("check-read", await bridge.checks.read({ permissionId: "review" }));
let undeclaredCheckDenied = false;
try { await bridge.checks.read({ permissionId: "other" }); } catch (error) { undeclaredCheckDenied = error.code === "CHECK_DENIED"; }
await bridge.storage.set("check-undeclared-denied", undeclaredCheckDenied);
const assistantRequest = { requestId: "request-one", actionId: "compare", input: {}, requestedAt: new Date().toISOString() };
const requestedTask = await bridge.assistant.request(assistantRequest);
const readTask = await bridge.assistant.get(assistantRequest.requestId);
const cancelledTask = await bridge.assistant.cancel(assistantRequest.requestId);
let assistantUndeclaredDenied = false;
try { await bridge.assistant.request({ ...assistantRequest, actionId: "other" }); } catch (error) { assistantUndeclaredDenied = error instanceof Error && error.code === "TASK_DENIED"; }
await bridge.storage.set("assistant-bridge", { requested: requestedTask.status, read: readTask.status, cancelled: cancelledTask.status, undeclaredDenied: assistantUndeclaredDenied, approvalAbsent: bridge.assistant.approve === undefined });
const inferredText = await bridge.assistant.infer({ instructions: "Echo the input.", input: "north" });
const inferredJson = await bridge.assistant.infer({
  instructions: "Echo the input.",
  input: "south",
  outputSchema: { type: "object", properties: { echoed: { type: "string", maxLength: 40 } }, required: ["echoed"], additionalProperties: false },
});
let inferInvalid = false;
try { await bridge.assistant.infer({ instructions: "", input: "x" }); }
catch (error) { inferInvalid = error instanceof Error && error.code === "INFER_INVALID"; }
await bridge.storage.set("assistant-infer", { text: inferredText.text, model: inferredText.model.id, json: inferredJson.json, invalidRefused: inferInvalid });
let uiNotificationDenied = false;
try { await bridge.notifications.show({ permissionId: "automation-update" }); } catch { uiNotificationDenied = true; }
await bridge.storage.set("ui-notification-denied", uiNotificationDenied);
let directFetchBlocked = false;
try { await fetch(context.state.escapeUrl); } catch { directFetchBlocked = true; }
await bridge.storage.set("visible", "visible-ui");
const stored = await bridge.storage.get("visible");
await bridge.files.write({ grantId: "exports", path: "smoke.txt", encoding: "utf8", data: "host-brokered", mode: "create" });
const file = await bridge.files.read({ grantId: "exports", path: "smoke.txt", encoding: "utf8" });
document.querySelector("#app").textContent = context.theme + ":" + String(directFetchBlocked);
await bridge.tabs.open({ tabId: "smoke-tab", title: "Sandbox ready", route: "/ready", state: { directFetchBlocked, stored, file: file.data } });
`, "utf8"),
    writeFile(join(root, "worker.js"), `
let workerTopLevelStorageDenied = false;
try { await globalThis.workFoldRestrictedApp.storage.set("worker-top-level", true); }
catch { workerTopLevelStorageDenied = true; }
let workerTopLevelNotificationDenied = false;
try { await globalThis.workFoldRestrictedApp.notifications.show({ permissionId: "automation-update" }); }
catch { workerTopLevelNotificationDenied = true; }
// Outside an operation a worker holds no lease, so neither Assistant lane answers.
let workerTopLevelInferDenied = false;
try { await globalThis.workFoldRestrictedApp.assistant.infer({ instructions: "Echo.", input: "top" }); }
catch (error) { workerTopLevelInferDenied = error instanceof Error && error.code === "INFER_UNAVAILABLE"; }
let workerStorageEvents = 0;
const workerInstanceToken = crypto.randomUUID();
globalThis.workFoldRestrictedApp.storage.onChanged(() => { workerStorageEvents += 1; });
// A worker subscribes at top level but is only eligible while it holds an
// operation, and it is never eligible for Check results at all.
let workerTasksHints = 0;
let workerChecksHints = 0;
globalThis.workFoldRestrictedApp.tasks.onChanged(() => { workerTasksHints += 1; });
globalThis.workFoldRestrictedApp.checks.onChanged(() => { workerChecksHints += 1; });
globalThis.workFoldRestrictedApp.files.onChanged(() => {});

export async function handleAction(action, input) {
  if (action === "revocation-fence") {
    await globalThis.workFoldRestrictedApp.request({ destinationId: "late-effect", method: "POST", path: "/commit" });
    await globalThis.workFoldRestrictedApp.storage.set("revocation-fence", true);
    return true;
  }
  if (action === "instance") return { token: workerInstanceToken, value: await globalThis.workFoldRestrictedApp.storage.get("instance-value") };
  if (action === "signal") { await globalThis.workFoldRestrictedApp.storage.set("automation", { peerSignal: true }); return true; }
  if (action === "notification") {
    let checkDenied = false;
    try { await globalThis.workFoldRestrictedApp.checks.read({ permissionId: "review" }); }
    catch (error) { checkDenied = error instanceof Error && error.code === "CHECK_DENIED"; }
    if (!checkDenied) throw new Error("A worker must not read Check results.");
    // A worker holding an operation may reach both Assistant lanes
    // (docs/receipts-not-gates.md, F22).
    const workerTasks = await globalThis.workFoldRestrictedApp.assistant.list();
    if (!Array.isArray(workerTasks)) throw new Error("A worker action must reach Assistant requests.");
    const workerInference = await globalThis.workFoldRestrictedApp.assistant.infer({ instructions: "Echo.", input: "worker" });
    if (workerInference.text !== "echo:worker") throw new Error("A worker action must reach bounded inference.");
    let actionNotificationDenied = false;
    try { await globalThis.workFoldRestrictedApp.notifications.show({ permissionId: "automation-update" }); }
    catch { actionNotificationDenied = true; }
    return { workerTopLevelNotificationDenied, actionNotificationDenied, workerInferText: workerInference.text, workerTopLevelInferDenied, workerChecksHints };
  }
  if (action === "huge") return "x".repeat(300000);
  if (action === "cyclic") { const value = {}; value.self = value; return value; }
  if (action === "frame") {
    document.body.append(document.createElement("iframe"));
    await new Promise(() => {});
  }
  if (action === "intrinsics") {
    JSON.stringify = () => "{}";
    TextEncoder.prototype.encode = () => new Uint8Array(0);
    return "x".repeat(300000);
  }
  if (action === "hang") { for (;;) {} }
  let nodeImportBlocked = false;
  try { await import("node:fs"); } catch { nodeImportBlocked = true; }
  let directFetchBlocked = false;
  try { await fetch(input.escapeUrl); } catch { directFetchBlocked = true; }
  let directWebSocketBlocked = false;
  try {
    directWebSocketBlocked = await new Promise((resolve) => {
      const socket = new WebSocket(input.escapeUrl.replace("http:", "ws:"));
      const timer = setTimeout(() => { socket.close(); resolve(true); }, 500);
      socket.onopen = () => { clearTimeout(timer); socket.close(); resolve(false); };
      socket.onerror = () => { clearTimeout(timer); resolve(true); };
    });
  } catch { directWebSocketBlocked = true; }
  const webRtcBlocked = typeof RTCPeerConnection === "undefined";
  const popupBlocked = window.open(input.escapeUrl) === null;
  let brokerDenied = false;
  try {
    await globalThis.workFoldRestrictedApp.request({ destinationId: "mail-api", method: "GET", path: "/messages" });
  } catch (error) { brokerDenied = error instanceof Error && error.code === "NETWORK_DENIED"; }
  return {
    echoed: input.text,
    nodeGlobalsAbsent: typeof process === "undefined" && typeof require === "undefined" && typeof Buffer === "undefined",
    nodeImportBlocked,
    directFetchBlocked,
    directWebSocketBlocked,
    webRtcBlocked,
    popupBlocked,
    brokerDenied,
    workerTopLevelStorageDenied,
  };
}

export async function handleAutomation(event) {
  if (event.automationId !== "smoke-automation" || event.handler !== "smoke") throw new Error("Unknown automation.");
  if (event.scheduledAt === "2026-07-13T00:00:15.000Z") {
    void globalThis.workFoldRestrictedApp.request({ destinationId: "late-effect", method: "POST", path: "/commit" }).catch(() => {});
    return;
  }
  try { await globalThis.workFoldRestrictedApp.request({ destinationId: "principal-probe", method: "GET", path: "/probe" }); }
  catch {}
  if (event.scheduledAt === "2026-07-13T00:00:30.000Z") {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await globalThis.workFoldRestrictedApp.notifications.show({ permissionId: "suspend-probe" });
    return;
  }
  if (event.scheduledAt === "2026-07-13T00:01:00.000Z") {
    await globalThis.workFoldRestrictedApp.storage.transaction({
      clear: true,
      set: [{ key: "automation", value: event }],
    });
  } else {
    await globalThis.workFoldRestrictedApp.storage.set("automation", event);
  }
  await globalThis.workFoldRestrictedApp.notifications.show({ permissionId: "automation-update" });
  await new Promise((resolve) => setTimeout(resolve, 120));
  await globalThis.workFoldRestrictedApp.storage.set("worker-storage-events", workerStorageEvents);
  await globalThis.workFoldRestrictedApp.storage.set("worker-checks-hints", workerChecksHints);
  await globalThis.workFoldRestrictedApp.storage.set("worker-tasks-hints", workerTasksHints);
  setTimeout(async () => {
    try { await globalThis.workFoldRestrictedApp.notifications.show({ permissionId: "post-return" }); }
    catch {}
  }, 200);
}
`, "utf8"),
  ]);
}

function smokeManifest(loopbackPort) {
  const emptyInput = { type: "object", properties: {}, required: [], additionalProperties: false };
  return {
    version: 2,
    id: "restricted-electron-smoke",
    title: "Restricted Electron smoke",
    runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
    ui: { icon: "apps", cornerRadius: 24 },
    tools: [
      {
        name: "revocation-fence", description: "Probe action authority across a delayed effect.", action: "revocation-fence",
        inputSchema: emptyInput, resultSchema: { type: "boolean" },
      },
      {
        name: "signal", description: "Write one installation-owned test value.", action: "signal",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }, resultSchema: { type: "boolean" },
      },
      {
        name: "instance", description: "Read this installation's private test value.", action: "instance",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        resultSchema: { type: "object", properties: { token: { type: "string", maxLength: 100 }, value: { type: "string", maxLength: 100 } }, required: ["token", "value"], additionalProperties: false },
      },
      {
        name: "probe",
        description: "Probe the Chromium sandbox boundary.",
        action: "probe",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", maxLength: 200 },
            escapeUrl: { type: "string", maxLength: 500 },
          },
          required: ["text", "escapeUrl"],
          additionalProperties: false,
        },
        resultSchema: {
          type: "object",
          properties: {
            echoed: { type: "string", maxLength: 200 },
            nodeGlobalsAbsent: { type: "boolean" },
            nodeImportBlocked: { type: "boolean" },
            directFetchBlocked: { type: "boolean" },
            directWebSocketBlocked: { type: "boolean" },
            webRtcBlocked: { type: "boolean" },
            popupBlocked: { type: "boolean" },
            brokerDenied: { type: "boolean" },
            workerTopLevelStorageDenied: { type: "boolean" },
          },
          required: ["echoed", "nodeGlobalsAbsent", "nodeImportBlocked", "directFetchBlocked", "directWebSocketBlocked", "webRtcBlocked", "popupBlocked", "brokerDenied", "workerTopLevelStorageDenied"],
          additionalProperties: false,
        },
      },
      {
        name: "notification",
        description: "Verify action notification denial.",
        action: "notification",
        inputSchema: emptyInput,
        resultSchema: {
          type: "object",
          properties: {
            workerTopLevelNotificationDenied: { type: "boolean" },
            actionNotificationDenied: { type: "boolean" },
            workerInferText: { type: "string", maxLength: 40 },
            workerTopLevelInferDenied: { type: "boolean" },
            workerChecksHints: { type: "integer", minimum: 0, maximum: 64 },
          },
          required: ["workerTopLevelNotificationDenied", "actionNotificationDenied", "workerInferText", "workerTopLevelInferDenied", "workerChecksHints"],
          additionalProperties: false,
        },
      },
      { name: "huge", description: "Return an oversized result.", action: "huge", inputSchema: emptyInput, resultSchema: { type: "string" } },
      { name: "cyclic", description: "Return a cyclic result.", action: "cyclic", inputSchema: emptyInput, resultSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
      { name: "frame", description: "Try to create a child frame.", action: "frame", inputSchema: emptyInput, resultSchema: { type: "null" } },
      { name: "intrinsics", description: "Tamper with renderer intrinsics.", action: "intrinsics", inputSchema: emptyInput, resultSchema: { type: "string" } },
      { name: "hang", description: "Block the renderer.", action: "hang", inputSchema: emptyInput, resultSchema: { type: "null" } },
    ],
    automations: [{
      id: "smoke-automation",
      title: "Smoke automation",
      handler: "smoke",
      trigger: { kind: "interval", intervalMinutes: 30 },
      permissions: {
        network: ["principal-probe", "late-effect"],
        files: ["exports"],
        notifications: ["automation-update", "post-return", "suspend-probe"],
      },
      catchUp: "latest",
      overlap: "skip",
    }],
    permissions: {
      checks: [{ id: "review", title: "Smoke Check" }],
      files: [{ id: "exports", target: "directory", access: "read-write" }],
      notifications: [
        { id: "automation-update", title: "Automation update", description: "New sandboxed app data is ready." },
        { id: "post-return", title: "Post-return probe", description: "This notification must never be shown." },
        { id: "suspend-probe", title: "Suspend probe", description: "This notification must never survive suspend." },
      ],
      network: [
        { id: "mail-api", target: { kind: "public-https", origin: "https://mail.example.com" }, methods: ["GET"], auth: [{ kind: "none" }] },
        { id: "principal-probe", target: { kind: "public-https", origin: "https://principal-probe.example.com" }, methods: ["GET"], auth: [{ kind: "none" }] },
        { id: "late-effect", target: { kind: "public-https", origin: "https://late-effect.example.com" }, methods: ["POST"], auth: [{ kind: "none" }] },
        { id: "escape", target: { kind: "loopback-http", host: "127.0.0.1", port: loopbackPort }, methods: ["GET"], auth: [{ kind: "none" }] },
      ],
    },
    // The rung-3 viewer surface (docs/fold-publishing.md): one reviewed entry
    // document and one viewer-readable collection, exercised by the
    // viewer-scope denial probe below.
    viewer: { entry: "viewer.html", readable: ["viewer-public/"] },
  };
}

function automationEvent(scheduledAt, reason, effectivePrincipal) {
  return {
    runId: `smoke-${scheduledAt}`,
    automationId: "smoke-automation",
    handler: "smoke",
    reason,
    scheduledAt,
    effectivePrincipal,
  };
}

class EmptyConnections {
  async get() { return undefined; }
  async set() {}
  async delete() { return false; }
  async deleteApp() {}
}
