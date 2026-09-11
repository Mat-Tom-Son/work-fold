import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RestrictedAppService, type RestrictedAppInstalled } from "../src/local/agent/restricted-app-service.js";
import { FileRestrictedAppStorage, type RestrictedAppStorageOwner } from "../src/local/agent/restricted-app-storage.js";
import { restrictedAppTaskAuthorityDigest } from "../src/local/agent/restricted-app-tasks.js";
import { startLocalApi } from "../src/local/server.js";
import type { RestrictedAppActionExecution } from "../src/local/agent/restricted-app-service.js";

const scopeFor = (app: RestrictedAppInstalled) => ({ spaceId: app.spaceId, appId: app.manifest.id, featureInstallationId: app.featureInstallationId, digest: app.digest, authorityDigest: restrictedAppTaskAuthorityDigest(app.authority) });
const ownerFor = (app: RestrictedAppInstalled): RestrictedAppStorageOwner => ({ ownerClass: "instance", tenantId: app.tenantId, runtimeInstanceId: app.runtimeInstanceId, featureInstallationId: app.featureInstallationId, dataNamespaceId: app.dataNamespaceId });

test("private browser views use reviewed bytes and selected data without creating public exposure", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-browser-app-"));
  const source = join(root, "space", "app");
  const rootPath = join(root, "state");
  const storage = new FileRestrictedAppStorage(join(root, "data"));
  const service = await RestrictedAppService.create({ rootPath, storage });
  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "web-view-qa", version: "1.0.0", type: "module", agentApp: "agent-app.json" }));
    await writeFile(join(source, "agent-app.json"), JSON.stringify({ version: 2, id: "web-view-qa", title: "Quote board", runtime: { kind: "sandboxed-web", entry: "index.html" }, ui: {}, tools: [], permissions: { network: [], files: [], notifications: [] }, automations: [], viewer: { entry: "web.html", readable: ["quotes/"] } }));
    await writeFile(join(source, "index.html"), "<!doctype html><p>Desktop UI</p>");
    await writeFile(join(source, "web.html"), "<!doctype html><p>Reviewed web view</p>");
    await writeFile(join(source, "too-large.txt"), "x".repeat(1024 * 1024 + 1));
    const input = { spaceId: "space-one", spaceRoot: join(root, "space"), sourcePath: "app" };
    const review = await service.inspect(input);
    let app = await service.install({ ...input, expectedDigest: review.digest });
    const scope = scopeFor(app);
    assert.equal(app.runtimeInstanceKind, "development", "private preview does not require publishing a Release or a viewer link");
    await storage.set(ownerFor(app), "quotes/north", { unitPrice: 42 });
    await storage.set(ownerFor(app), "private/secret", "not shared");
    const entry = await service.readBrowserView(scope, { kind: "entry" });
    assert.equal(entry.state, "served");
    if (entry.state !== "served" || !entry.result.ok || entry.result.result.kind !== "entry") assert.fail();
    assert.match(Buffer.from(entry.result.result.bytes, "base64url").toString(), /Reviewed web view/);
    const keys = await service.readBrowserView(scope, { kind: "data.keys" });
    assert.deepEqual(keys, { state: "served", result: { ok: true, result: { kind: "data.keys", prefix: "", keys: ["quotes/north"] } } });
    const value = await service.readBrowserView(scope, { kind: "data.get", key: "quotes/north" });
    assert.deepEqual(value, { state: "served", result: { ok: true, result: { kind: "data.get", key: "quotes/north", present: true, value: { unitPrice: 42 } } } });
    for (const call of [{ kind: "data.get", key: "private/secret" }, { kind: "data.set", key: "quotes/north", value: 0 }, { kind: "data.get", key: "quotes/north", owner: ownerFor(app) }, { kind: "assistant.request" }, { kind: "files.read" }, { kind: "network.fetch" }, { kind: "actions.invoke" }]) {
      const result = await service.readBrowserView(scope, call);
      assert.equal(result.state, "served");
      if (result.state !== "served") assert.fail();
      assert.equal(result.result.ok, false);
    }
    for (const path of ["../web.html", "/web.html", "file:/etc/passwd", "absent.html", "too-large.txt"]) {
      const result = await service.readBrowserView(scope, { kind: "asset", path });
      assert.ok(result.state === "served" && !result.result.ok);
    }
    await assert.rejects(service.readBrowserView({ ...scope, spaceId: "space-other" }, { kind: "entry" }));
    await assert.rejects(service.readBrowserView({ ...scope, digest: "0".repeat(64) }, { kind: "entry" }));
    let releaseRead!: () => void;
    let markReading!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const reading = new Promise<void>((resolve) => { markReading = resolve; });
    const get = storage.get.bind(storage);
    storage.get = async (owner, key) => { markReading(); await gate; return get(owner, key); };
    const pending = service.readBrowserView(scope, { kind: "data.get", key: "quotes/north" });
    await reading;
    const clearing = service.clearStorage(app.spaceId, app.manifest.id, app.digest, app.featureInstallationId);
    releaseRead();
    await assert.rejects(pending, /changed/, "a queued authority change fences the pending read before delivery");
    await clearing;
    storage.get = get;
    await assert.rejects(service.readBrowserView(scope, { kind: "entry" }), /changed/);
    app = (await service.list(app.spaceId))[0]!;
    const current = scopeFor(app);
    await writeFile(join(source, "web.html"), "Unreviewed edit");
    const stillReviewed = await service.readBrowserView(current, { kind: "entry" });
    assert.deepEqual(stillReviewed, entry, "source edits do not replace installed bytes");
    await writeFile(join(rootPath, "staged", app.digest, "web.html"), "Tampered staged bytes");
    assert.equal((await service.readBrowserView(current, { kind: "entry" })).state, "not-available");
    await service.remove({ spaceId: app.spaceId, appId: app.manifest.id, featureInstallationId: app.featureInstallationId, expectedDigest: app.digest });
    await assert.rejects(service.readBrowserView(current, { kind: "entry" }));
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("approved-browser app operations project exact identities and refuse foreign or extra scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-browser-app-api-"));
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), spaceBase: join(root, "spaces"), loadEnv: false });
  const principal = { browserId: "browser-one", grantId: "grant-one", requestId: "request-one" };
  try {
    const { space } = await api.actFacade.createSpace({ name: "Web app" });
    const { space: other } = await api.actFacade.createSpace({ name: "Other Space" });
    const source = join(space.spaceRoot, "app");
    await mkdir(source);
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "browser-api-qa", version: "1.0.0", type: "module", agentApp: "agent-app.json" }));
    await writeFile(join(source, "agent-app.json"), JSON.stringify({ version: 2, id: "browser-api-qa", title: "Browser API QA", runtime: { kind: "sandboxed-web", entry: "index.html" }, ui: {}, tools: [], permissions: { network: [], files: [], notifications: [] }, automations: [], viewer: { entry: "index.html", readable: ["public/"] } }));
    await writeFile(join(source, "index.html"), "<!doctype html><h1>Installed app</h1>");
    const installedPreview = await api.actFacade.appsInstallPreview({ space: space.id, packagePath: "app" });
    const catalog = await api.remoteFacade.execute("apps.list", { spaceId: space.id }, principal) as { apps: Array<Record<string, any>> };
    assert.equal(catalog.apps.length, 1);
    assert.ok(!JSON.stringify(catalog).includes(root));
    const app = catalog.apps[0]!;
    assert.equal(app.webView, true);
    const scope = { spaceId: app.spaceId, appId: app.appId, featureInstallationId: app.featureInstallationId, digest: app.digest, authorityDigest: app.authorityDigest };
    const result = await api.remoteFacade.execute("apps.read", { ...scope, call: { kind: "entry" } }, principal) as { state: string };
    assert.equal(result.state, "served");
    for (const value of [{ ...scope, spaceId: other.id }, { ...scope, owner: "foreign" }, { ...scope, authorityDigest: "0".repeat(64) }, { ...scope, featureInstallationId: "replacement" }]) {
      await assert.rejects(api.remoteFacade.execute("apps.read", { ...value, call: { kind: "entry" } }, principal));
    }
    await assert.rejects(api.remoteFacade.execute("apps.list", { spaceId: space.id }, { ...principal, grantId: "" }));
    await assert.rejects(api.remoteFacade.execute("apps.list", { spaceId: space.id, includeCredentials: true }, principal));
    const denied = await api.remoteFacade.execute("apps.read", { ...scope, call: { kind: "actions.invoke", action: "anything" } }, principal) as { result: { ok: boolean } };
    assert.equal(denied.result.ok, false);
  } finally { await api.close(); await rm(root, { recursive: true, force: true }); }
});

test("approved-browser actions use the installed worker service, live grant authority and durable deduplication", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-browser-action-api-"));
  const calls: Array<{ action: string; input: unknown; execution: RestrictedAppActionExecution }> = [];
  const service = await RestrictedAppService.create({ rootPath: join(root, "apps"), runtimeHost: {
    async invoke(_app, action, input, execution) { assert.ok(execution); execution.assertCurrent(); calls.push({ action, input, execution }); return { saved: true }; },
    async stop() {}, async close() {},
  } });
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), spaceBase: join(root, "spaces"), loadEnv: false, restrictedAppService: service });
  const principal = { browserId: "browser-one", grantId: "grant-one", requestId: "transport-request" };
  let allowed = true;
  const authority = { assertCurrent() { if (!allowed) throw new Error("Revoked"); } };
  try {
    const { space } = await api.actFacade.createSpace({ name: "Action QA" });
    const source = join(space.spaceRoot, "app"); await mkdir(source);
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "browser-action-qa", version: "1.0.0", type: "module", agentApp: "agent-app.json" }));
    await writeFile(join(source, "agent-app.json"), JSON.stringify({ version: 2, id: "browser-action-qa", title: "Action QA", runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" }, ui: {},
      tools: [{ name: "save", description: "Save a quote", action: "save", inputSchema: { type: "object", properties: { quote: { type: "string" } }, required: ["quote"], additionalProperties: false },
        resultSchema: { type: "object", properties: { saved: { type: "boolean" } }, required: ["saved"], additionalProperties: false } }],
      permissions: { network: [], files: [], notifications: [] }, automations: [], viewer: { entry: "index.html", readable: ["public/"] } }));
    await writeFile(join(source, "index.html"), "<!doctype html><h1>Installed app</h1>");
    await writeFile(join(source, "worker.js"), "export async function handleAction() { return { saved: true }; }");
    const installedPreview = await api.actFacade.appsInstallPreview({ space: space.id, packagePath: "app" });
    const app = (await service.list(space.id))[0]!; const scope = scopeFor(app);
    const request = { requestId: randomUUID(), requestedAt: new Date().toISOString(), action: "save", input: { quote: "North: $42" } };
    await assert.rejects(api.remoteFacade.execute("apps.actions.request", { ...scope, request }, principal), /live paired browser/);
    await assert.rejects(api.remoteFacade.execute("apps.actions.request", { ...scope, request, browserId: "other" }, principal, authority));
    const first = await api.remoteFacade.execute("apps.actions.request", { ...scope, request }, principal, authority) as { action: { id: string; status: string } };
    assert.equal(first.action.status, "pending"); assert.equal(calls.length, 0);
    const { review } = await api.remoteFacade.execute("apps.actions.review", { ...scope, requestId: request.requestId }, principal, authority) as { review: { reviewDigest: string } };
    await assert.rejects(api.remoteFacade.execute("apps.actions.approve", { ...scope, requestId: request.requestId, reviewDigest: review.reviewDigest }, { ...principal, grantId: "other" }, authority));
    const approval = { ...scope, requestId: request.requestId, reviewDigest: review.reviewDigest };
    await api.remoteFacade.execute("apps.actions.approve", approval, principal, authority);
    for (let index = 0; index < 100 && calls.length === 0; index++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, 1); assert.equal(calls[0]!.execution.invocationId, first.action.id);
    await api.remoteFacade.execute("apps.actions.approve", approval, { ...principal, requestId: "reconnected-transport" }, authority);
    assert.equal(calls.length, 1);
    allowed = false;
    assert.throws(() => calls[0]!.execution.assertCurrent(), /Revoked/);
    await assert.rejects(api.remoteFacade.execute("apps.actions.get", { ...scope, requestId: request.requestId }, principal, authority), /Revoked/);
    allowed = true;
    const pending = { ...request, requestId: randomUUID() };
    await api.remoteFacade.execute("apps.actions.request", { ...scope, request: pending }, principal, authority);
    await api.remoteFacade.revokeGrantAuthority!(principal.grantId);
    const cancelled = await api.remoteFacade.execute("apps.actions.get", { ...scope, requestId: pending.requestId }, principal, authority) as { action: { status: string } };
    assert.equal(cancelled.action.status, "cancelled");
    await service.remove({ spaceId: app.spaceId, appId: app.manifest.id, featureInstallationId: app.featureInstallationId, expectedDigest: app.digest });
    await assert.rejects(api.remoteFacade.execute("apps.actions.get", { ...scope, requestId: request.requestId }, principal, authority));
    assert.throws(() => calls[0]!.execution.assertCurrent(), /authority|installed|changed/i);
  } finally { await api.close(); await rm(root, { recursive: true, force: true }); }
});

test("a fold app-install result follows the executed review's exact installation and stays private to its browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-app-result-"));
  const agentDir = join(root, "agent"); await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "done.ts"), 'export default function(pi) { pi.registerCommand("done", { description: "Finish a test", handler: async () => {} }); }');
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), spaceBase: join(root, "spaces"), loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir }; } }, beforeAgentPrompt: async () => gate });
  const principal = { browserId: "browser-one", grantId: "grant-one", requestId: "request-install" };
  try {
    const { space } = await api.actFacade.createSpace({ name: "App result" });
    const source = join(space.spaceRoot, "app"); await mkdir(source);
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "app-result-qa", version: "1.0.0", type: "module", agentApp: "agent-app.json" }));
    await writeFile(join(source, "agent-app.json"), JSON.stringify({ version: 2, id: "app-result-qa", title: "Quote board", runtime: { kind: "sandboxed-web", entry: "index.html" },
      ui: {}, tools: [], permissions: { network: [], files: [], notifications: [] }, automations: [], viewer: { entry: "index.html", readable: ["quotes/"] } }));
    await writeFile(join(source, "index.html"), "<!doctype html><h1>Quote board</h1>");
    const parent = await api.remoteFacade.execute("management.send", { content: "/done", newConversation: true }, principal) as { taskId: string; conversationId: string };
    const installedPreview = await api.actFacade.appsInstallPreview({ space: space.id, packagePath: "app", parentTaskId: parent.taskId });
    const view = async (who = principal) => await api.remoteFacade.execute("management.summary", { conversationId: parent.conversationId }, who) as { latestRequest: { actions?: Array<{ apps?: unknown[] }> } };
    const apps = (await api.remoteFacade.execute("apps.list", { spaceId: space.id }, principal) as { apps: Array<Record<string, any>> }).apps;
    assert.equal(installedPreview.app.featureInstallationId, apps[0]!.featureInstallationId, "the install result names the exact installation");
    const result = (await view()).latestRequest.actions![0]!.apps;
    assert.deepEqual(result, [{ spaceId: space.id, appId: apps[0]!.appId, featureInstallationId: apps[0]!.featureInstallationId,
      digest: apps[0]!.digest, title: "Quote board", version: "1.0.0" }]);
    assert.equal((await view({ ...principal, grantId: "another-grant" })).latestRequest.actions, undefined);
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally { release(); await api.close(); await rm(root, { recursive: true, force: true }); }
});
