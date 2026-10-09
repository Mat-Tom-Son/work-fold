import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { HostCredentialStore } from "../src/local/agent/auth-storage.js";
import { piAuthInteraction, getPiSetupStatus, listPiModels } from "../src/local/agent/pi-runtime-config.js";
import { createIncludedMcpSetup, includedNativeMcpOptions } from "../src/local/agent/included-mcp-setup.js";
import { PiConversationClient, type PiChatEvent } from "../src/local/agent/pi-client.js";
import { ModelContextInspector } from "../src/local/agent/model-context-inspector.js";
import { createEncryptedMcpCredentialBackend } from "../desktop/src/pi-mcp-credentials.js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { McpOAuthCredentialStore } from "@earendil-works/pi-coding-agent";

test("desktop MCP credentials keep native locking and never fall back to plaintext", async t => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-mcp-encrypted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "credentials.bin"), key = randomBytes(32);
  let available = true;
  const encryption = {
    isEncryptionAvailable: () => available,
    encryptString(value: string) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(value: Buffer) { const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); },
  };
  const backend = createEncryptedMcpCredentialBackend(path, encryption);
  const store = new McpOAuthCredentialStore(backend, join(root, "locks"));
  const server = store.forServer("scope-bound", "https://example.invalid/mcp");
  await server.save({ tokens: { access_token: "synthetic-secret", token_type: "Bearer" } });
  assert.equal((await server.load())!.tokens!.access_token, "synthetic-secret");
  assert.ok(!(await readFile(path, "utf8")).includes("synthetic-secret"));
  available = false;
  await assert.rejects(async () => server.save({ tokens: { access_token: "must-not-write", token_type: "Bearer" } }), /unavailable/);
  available = true;
  assert.equal((await server.load())!.tokens!.access_token, "synthetic-secret");
  await writeFile(path, "corrupt-private-content");
  await assert.rejects(async () => server.load(), error => /could not be read/.test(String(error)) && !String(error).includes("private-content"));
});

test("host credentials serialize rotation across providers, publish only durable saves, and recover after failure", async () => {
  let fail = false;
  let saved: unknown;
  const store = await HostCredentialStore.create({ load: async () => undefined, save: async data => {
    if (fail) throw new Error("Synthetic save failure"); saved = structuredClone(data);
  } });
  await Promise.all([store.modify("a", async () => ({ type: "api_key", key: "first" })),
    store.modify("b", async () => ({ type: "api_key", key: "second" }))]);
  assert.equal(Object.keys(saved as object).length, 2);
  await Promise.all(Array.from({ length: 10 }, () => store.modify("a", async current => {
    assert.equal((await store.read("b"))?.type, "api_key", "reads inside a modifier do not deadlock");
    return { type: "api_key", key: `${current?.type === "api_key" ? current.key : ""}x` };
  })));
  fail = true;
  await assert.rejects(store.delete("a"), /save failure/);
  assert.equal((await store.read("a") as { key: string }).key, "firstxxxxxxxxxx");
  fail = false;
  await store.delete("a"); await store.flush();
  assert.equal(await store.read("a"), undefined);
  assert.equal(await store.read("constructor"), undefined);
  const cancelled = AbortSignal.abort();
  await assert.rejects(store.modify("b", async () => { throw new Error("must not run"); }, { signal: cancelled }), { name: "AbortError" });
});

test("native auth preserves secret prompts, cancels losing callback input, and propagates browser failures", async () => {
  let secret: boolean | undefined;
  const controller = new AbortController();
  const interaction = piAuthInteraction({ openUrl: async () => { throw new Error("browser failed"); },
    showDeviceCode() {}, select: async () => undefined,
    prompt: async input => { secret = input.secret; return "synthetic"; },
    manualCodeInput: () => new Promise(() => {}),
  });
  assert.equal(await interaction.prompt({ type: "secret", message: "Key" }), "synthetic");
  assert.equal(secret, true);
  const pending = interaction.prompt({ type: "manual_code", message: "Code", signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  interaction.notify({ type: "auth_url", url: "https://example.invalid" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(interaction.signal?.aborted, true);
});

test("native project MCP overrides narrow one folder without copying or revoking Everywhere credentials", async t => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-native-override-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "pi"), cwd = join(root, "folder");
  await mkdir(agentDir); await mkdir(join(cwd, ".pi"), { recursive: true });
  const global = { mcpServers: { shared: { url: "https://example.invalid/mcp", exposure: "direct" } } };
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify(global));
  await writeFile(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { shared: { enabled: false } } }));
  const setup = createIncludedMcpSetup({ agentDir, cwd, credentials: FileCredentialStore.inMemory(), openAuthorizationUrl() {} });
  t.after(() => setup.dispose());
  const rows = await setup.list(); assert.equal(rows.length, 2);
  const folder = rows.find(row => row.scope === "project")!;
  assert.equal(folder.disabled, true); assert.equal(folder.exposure, "direct");
  await setup.setEnabled({ ...folder, expectedRevision: folder.revision }, true);
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8")), global);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, ".pi", "mcp.json"), "utf8")), { mcpServers: { shared: { enabled: true } } });
  await assert.rejects(setup.saveBearer({ scope: "project", name: "shared", token: "synthetic" }), /Everywhere/);
  await assert.rejects(setup.disconnect({ scope: "project", name: "shared" }), /Everywhere/);
});

test("closing a native MCP runtime prevents an in-flight refresh from restoring revoked credentials", async t => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-native-revoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = await includedNativeMcpOptions({ agentDir: root }, FileCredentialStore.inMemory(), "session");
  const pendingRefresh = options.credentials!.forServer("fixture", "https://example.invalid/mcp");
  options.disposeCredentials();
  await assert.rejects(async () => pendingRefresh.save({ tokens: { access_token: "stale-token", token_type: "Bearer" } }), /session has closed/);
  assert.equal(await readFile(join(root, "mcp-auth.json"), "utf8").catch(() => undefined), undefined);
});

test("real codemode calls image and classifier models, returns file evidence and attributes usage to its accepted turn", async t => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-pi-one-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "fixture-chat", models: [{ id: "chat", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }] });
  const credentials = FileCredentialStore.inMemory();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
  runtime.registerNativeProvider(faux.provider);
  const usage: Usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
    cost: { input: 0.1, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.11 } };
  const base = { provider: "fixture-art", baseUrl: "https://example.invalid", name: "Fixture", input: ["text"] as ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
  const painter = { ...base, type: "image" as const, id: "paint", api: "fixture-image", output: ["image"] as ["image"] };
  const judge = { ...base, type: "classifier" as const, id: "judge", api: "fixture-classifier", contextWindow: 4096 };
  let images = 0, classifications = 0;
  runtime.registerNativeProvider({ ...faux.provider, id: "fixture-art", name: "Fixture art", getModels: () => [], getAllModels: () => [painter, judge],
    async generateImages(model, context) { images++; assert.equal(context.input[0]?.type, "text");
      return { api: model.api, provider: model.provider, model: model.id, output: [{ type: "text", text: "Image fixture completed" }], usage, stopReason: "stop", timestamp: Date.now() }; },
    async classify(model, context) { classifications++; assert.equal(context.state.note, "review");
      return { api: model.api, provider: model.provider, model: model.id, answers: { ready: { type: "bool", probability: 1 } }, usage, stopReason: "stop", timestamp: Date.now() }; },
  });
  const inspector = new ModelContextInspector(); inspector.setEnabled(true);
  const provider = { resolveRuntime: async () => ({ agentDir: join(root, "pi"), credentials, modelRuntime: runtime, modelContextInspector: inspector,
    preferredModel: { provider: "fixture-chat", id: "chat" }, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }) }) };
  const client = new PiConversationClient("native-models", root, provider); t.after(() => client.stop());
  const events: PiChatEvent[] = []; client.on("event", event => events.push(event));
  faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code: `
    const painter = await models.getModelOfType('image', 'fixture-art', 'paint');
    const judge = await models.getModelOfType('classifier', 'fixture-art', 'judge');
    text(await models.generateImages(painter, {input:[{type:'text', text:'a fixture'}]}));
    text(await models.classify(judge, {state:{note:'review'}, questions:{ready:{type:'bool',instructions:'Ready?',criteria:{true:'ready',false:'not ready'}}}}));
    text(await tools.write({path:'native-evidence.txt', content:'codemode wrote this'}));
  ` }, { id: "code-1" })), fauxAssistantMessage("The native calls completed.")]);
  assert.equal(await client.prompt("Run native model operations.", { managementTaskId: "accepted-native-turn" }), "The native calls completed.");
  assert.equal(images, 1); assert.equal(classifications, 1);
  assert.equal(await readFile(join(root, "native-evidence.txt"), "utf8"), "codemode wrote this");
  assert.ok(events.some(event => event.type === "tool" && event.toolName === "write" && event.phase === "complete" && Number.isFinite(event.durationMs)));
  assert.ok(client.getTurnUsage()!.amountUsd! >= 0.22);
  for (const kind of ["image", "classifier"]) {
    const record = inspector.list().find(record => record.owner.purpose === kind)!;
    assert.equal(record.owner.taskId, "accepted-native-turn"); assert.equal(record.owner.conversationId, "native-models");
  }
  const setup = await getPiSetupStatus(root, provider);
  assert.ok(setup.providers.some(item => item.id === "fixture-art" && item.modelCount === 2));
  assert.ok(!(await listPiModels(root, provider)).some(item => item.provider === "fixture-art"), "chat selector only offers chat models");
});

test("native cache warming stays inside an accepted turn, records usage and is observed once with the correct owner", { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-native-warm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "pi"); await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "warm.ts"), "export default pi => pi.on('cache_warming_decision', () => ({action:'warm'}));");
  const faux = fauxProvider({ provider: "fixture-warm", models: [{ id: "chat", cost: { input: 100, output: 100, cacheRead: 1, cacheWrite: 1 } }] });
  faux.getModel().promptCache = { short: 10.1 };
  const warm = fauxProvider({ provider: "fixture-warm" });
  let release!: () => void;
  let warms = 0;
  faux.setResponses([fauxAssistantMessage("Seed context."), async () => {
    await new Promise<void>(resolve => { release = resolve; }); return fauxAssistantMessage("The turn finished.");
  }]);
  const original = faux.provider.streamSimple;
  const runtime = await ModelRuntime.create({ credentials: FileCredentialStore.inMemory(), modelsPath: null });
  runtime.registerNativeProvider({ ...faux.provider, streamSimple(model, context, options) {
    if (options?.maxTokens !== 1) return original(model, context, options);
    assert.equal(options.maxRetries, 0);
    warms++; warm.setResponses([fauxAssistantMessage("x")]);
    setTimeout(() => release(), 20);
    return warm.provider.streamSimple(model, context, options);
  } });
  const inspector = new ModelContextInspector(); inspector.setEnabled(true);
  const settings = SettingsManager.inMemory({ cacheWarming: "idle", compaction: { enabled: false } });
  const client = new PiConversationClient("warming", root, { resolveRuntime: async () => ({ agentDir, modelRuntime: runtime,
    settingsManager: settings, modelContextInspector: inspector, preferredModel: { provider: "fixture-warm", id: "chat" } }) });
  t.after(() => client.stop());
  await client.prompt("Seed the cache.");
  assert.equal(await client.prompt("Wait for a warm request.", { managementTaskId: "warm-owner" }), "The turn finished.");
  const entries = (await readFile((await client.getState()).sessionFile!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(entries.some(entry => entry.type === "usage" && entry.kind === "cache_warm"));
  const captures = inspector.list().filter(record => record.owner.purpose === "cache_warm");
  assert.equal(captures.length, warms); assert.equal(captures[0]!.owner.taskId, "warm-owner");
  assert.ok(client.getTurnUsage()!.outputTokens > 0);
  const settledWarms = warms;
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(warms, settledWarms, "idle preference does not create unowned work after settlement");
});
