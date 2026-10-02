import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { IncludedChromeConnectionHost } from "../src/local/agent/included-chrome-connection.js";
import type { ChromeConnectionSummary } from "../src/shared/chrome-connection.js";
import { listIncludedToolStatus, setupIncludedTool } from "../src/local/agent/included-tool-setup.js";
import { beginIncludedToolObservation, includedToolObservation } from "../src/local/agent/included-tool-observations.js";
import { includedComputerStatus } from "../resources/included-tools/readiness.js";
import { includedToolReadiness } from "../web-local/src/lib/included-tool-readiness.js";
import type { ResolvedPiRuntime } from "../src/local/agent/pi-runtime-config.js";

test("readiness summaries stay cold, preserve unknown setup, and disclose no saved secret", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const included = join(root, "included");
  const marker = join(root, "probe-loaded");
  const fail = join(root, "fail");
  const wait = join(root, "wait");
  const started = join(root, "started");
  await mkdir(join(included, "documents"), { recursive: true });
  await writeFile(join(included, "documents", "runtime.mjs"), `
    import { existsSync, writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'explicit probe loaded');
    export async function probeIncludedDocuments() {
      if (existsSync(${JSON.stringify(fail)})) throw new Error('Dependency probe failed');
      writeFileSync(${JSON.stringify(started)}, 'probe started');
      while (existsSync(${JSON.stringify(wait)})) await new Promise(resolve => setTimeout(resolve, 5));
      return { state: 'ready', reason: 'Dependencies available', versions: {}, runtime: 'test' };
    }
  `);
  for (const id of ["chrome", "computer", "web", "mcp"]) {
    await mkdir(join(included, id));
    await writeFile(join(included, id, "index.ts"), "throw new Error('A cold readiness read loaded executable resources');");
  }
  const authStorage = AuthStorage.inMemory();
  const provider = { resolveRuntime: async () => ({ agentDir: join(root, "pi"), authStorage, includedTools: { rootPath: included, stateRoot: join(root, "state") } }) };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => { assert.fail("Readiness inspection must not contact a provider or launch a connection"); }) as typeof fetch;
  const initial = await listIncludedToolStatus(root, provider);
  assert.deepEqual(initial.map(({ id, state }) => [id, state]), [["computer", "unknown"], ["chrome", "unavailable"], ["web", "ready"], ["mcp", "setup_required"], ["documents", "unknown"]]);
  assert.equal(includedToolReadiness(initial.find(({ id }) => id === "mcp")).label, "No Connections");
  await mkdir(join(root, "pi"), { recursive: true });
  await writeFile(join(root, "pi", "mcp.json"), JSON.stringify({ mcpServers: { synthetic: { url: "https://example.invalid/mcp", headers: { Authorization: "synthetic-config-secret" } } } }));
  const declared = (await listIncludedToolStatus(root, provider)).find(({ id }) => id === "mcp")!;
  assert.equal(includedToolReadiness(declared).label, "Configured");
  assert.equal(declared.state, "unknown", "a declaration is not proof of discovery or connection health");
  assert.doesNotMatch(JSON.stringify(declared), /synthetic-config-secret|example.invalid/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  await assert.rejects(setupIncludedTool(root, "chrome", "connect-chrome", {}, provider), /Chrome setup requires the desktop app/);
  authStorage.set("work-fold:web:brave", { type: "api_key", key: "synthetic-secret-not-for-status" });
  const configured = await listIncludedToolStatus(root, provider);
  assert.equal(configured.find(({ id }) => id === "web")!.state, "unknown");
  assert.doesNotMatch(JSON.stringify(configured), /synthetic-secret-not-for-status/);
  await setupIncludedTool(root, "documents", "check", {}, provider);
  assert.equal(await readFile(marker, "utf8"), "explicit probe loaded");
  assert.equal((await listIncludedToolStatus(root, provider)).find(({ id }) => id === "documents")!.state, "ready");
  const verified = (await listIncludedToolStatus(root, provider)).find(({ id }) => id === "documents")!;
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 6 * 60_000;
    const earlier = (await listIncludedToolStatus(root, provider)).find(({ id }) => id === "documents")!;
    assert.equal(earlier.state, "ready");
    assert.equal(earlier.stale, false, "document dependencies stay verified for the same running build");
    assert.equal(earlier.checkedAt, verified.checkedAt, "expiry retains the actual evidence timestamp");
    assert.deepEqual(includedToolReadiness(earlier), { label: "Ready", tone: "enabled", setup: false });
  } finally { Date.now = realNow; }
  await rm(started);
  await writeFile(wait, "hold older check");
  const olderCheck = setupIncludedTool(root, "documents", "check", {}, provider);
  try {
    const deadline = Date.now() + 3_000;
    while (await access(started).then(() => false, () => true)) {
      assert.ok(Date.now() < deadline, "the held native check must start");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await writeFile(fail, "new check fails");
    await assert.rejects(setupIncludedTool(root, "documents", "check", {}, provider), /Dependency probe failed/);
    assert.equal((await listIncludedToolStatus(root, provider)).find(({ id }) => id === "documents")!.state, "unknown");
  } finally {
    await rm(wait, { force: true });
    assert.equal((await olderCheck).status.state, "unknown", "the old caller must also receive the superseded state");
  }
  assert.equal((await listIncludedToolStatus(root, provider)).find(({ id }) => id === "documents")!.state, "unknown", "an older in-flight success cannot replace a newer failed check");
});

test("native observations are runtime-bound, ordered against explicit checks, and require real computer permission evidence", () => {
  const runtime = { agentDir: "/synthetic/readiness/pi", config: { includedTools: { stateRoot: "/synthetic/readiness/state", rootPath: "/synthetic/readiness/runtime", helperAppPath: "/synthetic/helper.app" } } } as ResolvedPiRuntime;
  const ready = includedComputerStatus({ status: "ready", accessibility: true, screenRecording: true });
  const oldUse = beginIncludedToolObservation(runtime, "computer");
  const newCheck = beginIncludedToolObservation(runtime, "computer", true);
  assert.equal(oldUse(ready).state, "unknown", "late native evidence cannot outlive a newer explicit check");
  newCheck(includedComputerStatus({ status: "setup_required", accessibility: true, screenRecording: false }));
  assert.equal(includedToolObservation(runtime, "computer")?.state, "setup_required");
  const nextUse = beginIncludedToolObservation(runtime, "computer");
  nextUse(ready);
  assert.equal(includedToolObservation(runtime, "computer")?.state, "ready");
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 6 * 60_000;
    const historical = includedToolObservation(runtime, "computer")!;
    assert.equal(historical.stale, true);
    assert.equal(includedToolReadiness(historical).label, "Last Check Passed");
    assert.equal(includedToolReadiness(historical).tone, "");
  } finally { Date.now = realNow; }
  assert.equal(includedToolObservation({ ...runtime, config: { includedTools: { ...runtime.config.includedTools!, rootPath: "/synthetic/other-runtime" } } }, "computer"), undefined);
  assert.equal(includedComputerStatus({ status: "not_running" }).state, "unknown", "idle is not unavailable or ready");
  assert.match(includedComputerStatus({ status: "not_running" }).detail, /idle/);
});

test("Computer Check observes without starting or repairing the helper", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-computer-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const included = join(root, "included");
  await mkdir(join(included, "computer"), { recursive: true });
  const launchLog = join(root, "launch-policy");
  await writeFile(join(included, "computer", "index.ts"), `
    import { appendFileSync } from 'node:fs';
    export async function probeIncludedComputer(_config, options) {
      if (typeof options.launch !== 'boolean') throw new Error('Explicit launch policy required');
      appendFileSync(${JSON.stringify(launchLog)}, String(options.launch)+String.fromCharCode(10));
      return {status:'ready', accessibility:true, screenRecording:true};
    }
    export async function setupIncludedComputer() { throw new Error('Check must not enter permission setup'); }
  `);
  const provider = { resolveRuntime: async () => ({ agentDir: join(root, "pi"), authStorage: AuthStorage.inMemory(), includedTools: { rootPath: included, stateRoot: join(root, "state") } }) };
  const result = await setupIncludedTool(root, "computer", "check", {}, provider);
  assert.equal(result.status.state, "ready");
  assert.deepEqual(result.status.facts, { accessibility: true, screenRecording: true });
  assert.equal(await readFile(launchLog, "utf8"), "false\n", "ordinary Check never launches the helper");
  const started = await setupIncludedTool(root, "computer", "start-check", {}, provider);
  assert.equal(started.status.state, "ready", "deliberate start uses the non-repair probe path");
  assert.equal(await readFile(launchLog, "utf8"), "false\ntrue\n");
});


test("Chrome readiness uses only current host observations and trusted actions, without exposing native connection data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-chrome-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  let observed: ChromeConnectionSummary = { state: "not_connected", hasSelection: false, checkedAt: new Date().toISOString() };
  const response = () => ({ ...observed, leaseToken: "synthetic-private-lease", clientId: "synthetic-private-profile" });
  const service: IncludedChromeConnectionHost = {
    status: () => { calls.push("status"); return response(); },
    prepare: async () => { calls.push("prepare"); return response(); },
    check: async () => { calls.push("check"); observed = { ...observed, state: "connected", hasSelection: true, extensionVersion: "1.2.0" }; return response(); },
    disconnect: async () => { calls.push("disconnect"); return { ...response(), state: "busy" }; },
    changeProfile: async () => { calls.push("changeProfile"); observed = { ...observed, state: "not_connected", hasSelection: false }; return response(); },
    getChromeConnection: async () => { assert.fail("Renderer setup must never acquire a native lease"); },
    onChromeConnectionRevoked: () => { assert.fail("Renderer setup must not own connection lifetime"); },
    reportChromeConnectionObservation: () => { assert.fail("Renderer cannot claim a browser handshake"); },
    beginChromeWork: () => { assert.fail("Renderer setup must not admit model work"); },
  };
  const includedTools = { rootPath: join(root, "must-not-import"), stateRoot: join(root, "state"), chromeConnection: service };
  const provider = { resolveRuntime: async () => ({ agentDir: join(root, "pi"), authStorage: AuthStorage.inMemory(), includedTools }) };
  const cold = (await listIncludedToolStatus(root, provider)).find(({ id }) => id === "chrome")!;
  assert.deepEqual(calls, ["status"], "cold reads must not prepare, check, or connect");
  assert.equal(cold.chrome?.state, "not_connected");
  assert.doesNotMatch(JSON.stringify(cold), /synthetic-private|leaseToken|clientId/);
  const prepared = await setupIncludedTool(root, "chrome", "connect-chrome", {}, provider);
  assert.equal(prepared.status.state, "setup_required", "opening the Store cannot establish Ready");
  assert.equal(prepared.status.chrome?.hasSelection, false);
  const connected = await setupIncludedTool(root, "chrome", "check", {}, provider);
  assert.equal(connected.status.chrome?.state, "connected");
  assert.equal(connected.status.state, "ready");
  assert.equal(connected.status.chrome?.extensionVersion, "1.2.0");
  assert.doesNotMatch(JSON.stringify(connected), /synthetic-private|leaseToken|clientId/);
  observed = { ...observed, state: "not_connected" };
  assert.equal((await listIncludedToolStatus(root, provider)).find(({ id }) => id === "chrome")?.state, "setup_required", "a previous Check must not cache Ready after the authenticated observation expires");
  const refused = await setupIncludedTool(root, "chrome", "disconnect-chrome", {}, provider);
  assert.equal(refused.status.chrome?.state, "busy");
  assert.equal(refused.status.chrome?.hasSelection, true);
  const changed = await setupIncludedTool(root, "chrome", "change-chrome-profile", {}, provider);
  assert.equal(changed.status.chrome?.hasSelection, false);
  assert.deepEqual(calls, ["status", "prepare", "check", "status", "disconnect", "changeProfile"]);
  await assert.rejects(setupIncludedTool(root, "chrome", "prepare-companion" as never, {}, provider), /Unknown Chrome setup action/);
});
