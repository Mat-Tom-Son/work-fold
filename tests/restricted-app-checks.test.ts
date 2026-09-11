import assert from "node:assert/strict";
import test from "node:test";
import { readRestrictedAppCheck } from "../src/local/agent/restricted-app-checks.js";
import type { RestrictedAppCheckResult } from "../src/shared/restricted-app-checks.js";

const result: RestrictedAppCheckResult = { checkId: "selected", declarationDigest: "a".repeat(64), title: "Quote review", state: "never-run", lastRunAt: null, findings: [], truncated: false };
const declarations = [{ id: "quote-review", title: "Quote review" }];
const grants = [{ permissionId: "quote-review", checkId: result.checkId, declarationDigest: result.declarationDigest }];

test("restricted Check broker derives the selected identity and rejects widening before reading", async () => {
  const calls: unknown[] = [];
  const context = { spaceId: "space-one", declarations, grants, assertCurrent() {}, read: async (...args: string[]) => { calls.push(args); return result; } };
  assert.deepEqual(await readRestrictedAppCheck(context, { permissionId: "quote-review" }), result);
  assert.deepEqual(calls, [["space-one", "selected", "a".repeat(64)]]);
  for (const request of [null, {}, [], { permissionId: "other" }, { permissionId: "quote-review", spaceId: "space-two" }, { permissionId: "quote-review", checkId: "secret" }]) {
    await assert.rejects(readRestrictedAppCheck(context, request), { code: "CHECK_DENIED" });
  }
  await assert.rejects(readRestrictedAppCheck({ ...context, grants: [] }, { permissionId: "quote-review" }), { code: "CHECK_DENIED" });
  assert.equal(calls.length, 1);
});

test("restricted Check broker fences in-flight reads and bounds failed or mismatched responses", async () => {
  let current = true;
  const context = { spaceId: "space-one", declarations, grants, assertCurrent() { if (!current) throw new Error("revoked"); }, read: async () => { current = false; return result; } };
  await assert.rejects(readRestrictedAppCheck(context, { permissionId: "quote-review" }), /revoked/);
  current = true;
  for (const read of [async () => ({ ...result, checkId: "foreign" }), async () => ({ ...result, title: "a".repeat(300_000) }), async () => { throw new Error("secret internal file path"); }]) {
    await assert.rejects(readRestrictedAppCheck({ ...context, read }, { permissionId: "quote-review" }), (error: any) => error.code === "CHECK_UNAVAILABLE" && !error.message.includes("secret"));
  }
});

test("Check grants pin installations and declarations, carry across changed bytes by permission id, and survive release continuity", async (t) => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { RestrictedAppService } = await import("../src/local/agent/restricted-app-service.js");
  const root = await mkdtemp(join(tmpdir(), "work-fold-app-check-grants-"));
  const packageRoot = join(root, "space", "app");
  await mkdir(packageRoot, { recursive: true });
  const manifest = { version: 2, id: "quote-app", title: "Quotes", runtime: { kind: "sandboxed-web", entry: "index.html" }, ui: {}, tools: [], automations: [], permissions: { network: [], checks: declarations } };
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "quote-app", version: "1.0.0", type: "module", agentApp: "agent-app.json" }));
  await writeFile(join(packageRoot, "agent-app.json"), JSON.stringify(manifest));
  await writeFile(join(packageRoot, "index.html"), "<!doctype html><p>Quotes</p>");
  const stops: unknown[][] = [];
  const options = { rootPath: join(root, "state"), readCheckResult: async (spaceId: string, checkId: string, digest: string) => {
    assert.equal(spaceId, "source");
    if (checkId !== result.checkId || digest !== result.declarationDigest) throw new Error("Selected Check unavailable");
    return result;
  }, runtimeHost: { async invoke() {}, async stop(...args: unknown[]) { stops.push(args); }, async close() {} } };
  let service = await RestrictedAppService.create(options);
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const scope = { spaceId: "source", spaceRoot: join(root, "space"), sourcePath: "app" };
  const reviewed = await service.inspect(scope);
  const preview = await service.install({ ...scope, expectedDigest: reviewed.digest });
  const selection = { checkId: result.checkId, declarationDigest: result.declarationDigest };
  const pin = { spaceId: preview.spaceId, appId: preview.manifest.id, featureInstallationId: preview.featureInstallationId, expectedDigest: preview.digest, permissionId: "quote-review", selection };
  assert.deepEqual(preview.checkGrants ?? [], []);
  await assert.rejects(service.setCheckGrant({ ...pin, permissionId: "unknown" }));
  await assert.rejects(service.setCheckGrant({ ...pin, selection: { ...selection, checkId: "foreign" } }));
  await assert.rejects(service.setCheckGrant({ ...pin, featureInstallationId: undefined as any }));
  const granted = await service.setCheckGrant(pin);
  assert.equal(granted.checkGrants?.[0]?.checkId, "selected");
  assert.notDeepEqual(granted.authority, preview.authority);
  assert.deepEqual((await service.setCheckGrant(pin)).authority, granted.authority, "same selection is idempotent after revalidation");
  assert.deepEqual(stops.at(-1), [preview.spaceId, preview.manifest.id, preview.digest, preview.featureInstallationId]);
  const release = await service.prepareLocalAppRelease({ spaceId: "source", displayVersion: "1.0.0" });
  await service.publishLocalAppRelease({ spaceId: "source", releaseDigest: release.releaseDigest });
  const plan = await service.prepareLocalAppInstall({ sourceSpaceId: "source", targetSpaceId: "source", releaseDigest: release.releaseDigest });
  const live = (await service.activateLocalAppInstall(plan.operationId)).apps[0]!;
  assert.deepEqual(live.checkGrants ?? [], [], "release never inherits preview grants");
  await service.setCheckGrant({ ...pin, featureInstallationId: live.featureInstallationId });
  const identical = await service.prepareLocalAppRelease({ spaceId: "source", displayVersion: "1.0.1" });
  await service.publishLocalAppRelease({ spaceId: "source", releaseDigest: identical.releaseDigest });
  const update = await service.prepareLocalAppUpdate({ sourceSpaceId: "source", runtimeInstanceId: live.runtimeInstanceId, releaseDigest: identical.releaseDigest });
  const updated = (await service.activateLocalAppUpdate(update.operationId)).apps[0]!;
  assert.equal(updated.checkGrants?.[0]?.checkId, "selected");
  await writeFile(join(packageRoot, "index.html"), "<!doctype html><p>Changed</p>");
  const changed = await service.inspect(scope);
  const next = await service.install({ ...scope, expectedDigest: changed.digest });
  // A code change carries the chosen Check by permission id (docs/receipts-not-gates.md, F21);
  // the old revision pin still cannot change it.
  assert.equal(next.checkGrants?.[0]?.checkId, "selected", "preview changes carry the selection");
  assert.equal(next.checkGrants?.[0]?.declarationDigest, selection.declarationDigest);
  await assert.rejects(service.setCheckGrant(pin), /changed/);
  await service.close();
  service = await RestrictedAppService.create(options);
  const restored = await service.findByFeatureInstallation("source", live.featureInstallationId);
  assert.equal(restored?.checkGrants?.[0]?.declarationDigest, selection.declarationDigest);
  await service.setCheckGrant({ ...pin, featureInstallationId: live.featureInstallationId, selection: null });
  assert.deepEqual((await service.findByFeatureInstallation("source", live.featureInstallationId))?.checkGrants ?? [], []);
  assert.equal(JSON.parse(await readFile(join(root, "state", "registry.json"), "utf8")).schemaVersion, 6);
});
