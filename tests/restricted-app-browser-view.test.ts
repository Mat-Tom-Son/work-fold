import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RestrictedAppService, type RestrictedAppInstalled } from "../src/local/agent/restricted-app-service.js";
import { FileRestrictedAppStorage, type RestrictedAppStorageOwner } from "../src/local/agent/restricted-app-storage.js";
import { restrictedAppTaskAuthorityDigest } from "../src/local/agent/restricted-app-tasks.js";
import { startLocalApi } from "../src/local/server.js";

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
    const proposal = await api.actFacade.appsInstallPreview({ space: space.id, packagePath: "app" });
    await api.foldDecisions.decide(proposal.staged.decisionId, { decision: "approved", surface: "main-window" });
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
