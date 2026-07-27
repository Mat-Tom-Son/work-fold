import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import JSZip from "jszip";

import { createPersistentPiAuthStorage, type PiAuthStorageData } from "../src/local/agent/auth-storage.js";
import { PiConversationClient, PiTurnFailure, type PiChatEvent } from "../src/local/agent/pi-client.js";
import { RoutedPiExtensionUiBridge, type PiExtensionUiRequest } from "../src/local/agent/extension-ui.js";
import { importPiSkillBundle } from "../src/local/agent/skill-import.js";
import { loadAgentSkillCatalog } from "../src/local/agent/skill-catalog.js";
import {
  installPiPackage,
  isPiProjectMutationTrusted,
  listPiModels,
  listPiPackages,
  removePiPackage,
  updatePiPackages,
  type PiRuntimeProvider,
} from "../src/local/agent/pi-runtime-config.js";

test("host-backed Pi AuthStorage persists provider-neutral API key data", async () => {
  let stored: PiAuthStorageData = {};
  const persistent = await createPersistentPiAuthStorage({
    agentDir: "unused",
    host: {
      async load() {
        return stored;
      },
      async save(data) {
        stored = structuredClone(data);
      },
    },
  });

  persistent.authStorage.set("openrouter", { type: "api_key", key: "test-key" });
  await persistent.flush();
  assert.deepEqual(stored, {
    openrouter: { type: "api_key", key: "test-key" },
  });
  const reopened = await createPersistentPiAuthStorage({
    agentDir: "unused",
    host: { async load() { return stored; }, async save(data) { stored = structuredClone(data); } },
  });
  assert.deepEqual(reopened.authStorage.get("openrouter"), { type: "api_key", key: "test-key" });
});

test("routed extension UI bridge resolves host responses", async () => {
  const bridge = new RoutedPiExtensionUiBridge();
  bridge.publish({ id: "editor-1", method: "setEditorText", text: "hello", conversationId: "conversation", workspaceRoot: "C:/workspace" });
  bridge.publish({ id: "editor-2", method: "pasteToEditor", text: " world", conversationId: "conversation", workspaceRoot: "C:/workspace" });
  assert.equal(bridge.getEditorText(), "hello world");
  const requestPromise = once(bridge, "request");
  const resultPromise = bridge.request({
    id: "request-1",
    method: "confirm",
    title: "Trust?",
    message: "Load project extensions?",
    conversationId: "conversation",
    workspaceRoot: "C:/workspace",
  });
  const [request] = await requestPromise as [PiExtensionUiRequest];
  assert.equal(request.id, "request-1");
  const settledPromise = once(bridge, "settled");
  assert.equal(bridge.respond(request.id, { confirmed: true }), true);
  assert.deepEqual(await resultPromise, { confirmed: true });
  assert.deepEqual((await settledPromise)[0], { id: "request-1", response: { confirmed: true } });
  assert.equal(bridge.respond(request.id, { confirmed: false }), false);
});

test("Anthropic-style ZIP skill bundles preserve complete skill directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-skill-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const provider: PiRuntimeProvider = {
    async resolveRuntime() {
      return { agentDir };
    },
  };

  const zip = new JSZip();
  zip.file("skill-pack/.claude-plugin/marketplace.json", "{}");
  zip.file("skill-pack/skills/reviewer/SKILL.md", "---\nname: reviewer\ndescription: Review files\n---\nReview carefully.\n");
  zip.file("skill-pack/skills/reviewer/scripts/check.js", "console.log('ok');\n");
  zip.file("skill-pack/skills/reviewer/references/rules.md", "# Rules\n");
  const bytes = await zip.generateAsync({ type: "uint8array" });

  const result = await importPiSkillBundle(workspaceRoot, {
    fileName: "anthropic-review.skill",
    bytes,
  }, provider);
  assert.equal(result.scope, "user");
  assert.deepEqual(result.skills.map((item) => item.name), ["reviewer"]);
  assert.match(await readFile(join(result.bundlePath, "skill-pack", "skills", "reviewer", "scripts", "check.js"), "utf8"), /console\.log/);
  assert.match(await readFile(join(result.bundlePath, "skill-pack", "skills", "reviewer", "references", "rules.md"), "utf8"), /Rules/);
  assert.equal(existsSync(join(result.bundlePath, "skill-pack", ".claude-plugin", "marketplace.json")), false);
  const catalog = await loadAgentSkillCatalog(workspaceRoot, provider);
  assert.equal(catalog.skills.some((skill) => skill.name === "reviewer"), true);
});

test("standalone SKILL.md imports use the declared skill name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-skill-markdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };
  const bytes = new TextEncoder().encode("---\nname: personal-helper\ndescription: A personal helper\n---\n\nHelp carefully.\n");

  const result = await importPiSkillBundle(workspaceRoot, { fileName: "SKILL.md", bytes }, provider);
  assert.deepEqual(result.skills, [{ name: "personal-helper", relativePath: "SKILL.md" }]);
  assert.match(await readFile(join(result.bundlePath, "SKILL.md"), "utf8"), /personal-helper/);
});

test("project skill imports require an explicit trust decision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-skill-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };
  const bytes = new TextEncoder().encode("---\nname: trusted-helper\ndescription: A trusted helper\n---\n\nHelp carefully.\n");

  await assert.rejects(
    importPiSkillBundle(workspaceRoot, { fileName: "SKILL.md", bytes, scope: "project" }, provider),
    /Trust this Space/,
  );
  new ProjectTrustStore(agentDir).set(workspaceRoot, true);
  const result = await importPiSkillBundle(workspaceRoot, { fileName: "SKILL.md", bytes, scope: "project" }, provider);
  assert.match(result.bundlePath.replace(/\\/g, "/"), /\/\.pi\/skills\/trusted-helper$/);
});

test("project package lifecycle requires the same explicit trust decision as Skill import", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-package-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const workspaceRoot = join(root, "workspace");
  const packageRoot = join(root, "local-package");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "local-capability", private: true }), "utf8");
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };

  await assert.rejects(
    installPiPackage(workspaceRoot, packageRoot, { scope: "project", runtimeProvider: provider }),
    /Trust this Space/,
  );

  new ProjectTrustStore(agentDir).set(workspaceRoot, true);
  await installPiPackage(workspaceRoot, packageRoot, { scope: "project", runtimeProvider: provider });
  const configured = (await listPiPackages(workspaceRoot, provider)).find((item) => item.scope === "project");
  assert.ok(configured);
  assert.equal(configured.installedPath, packageRoot);

  await updatePiPackages(workspaceRoot, configured.source, { scope: "project", runtimeProvider: provider });
  assert.equal(await removePiPackage(workspaceRoot, configured.source, { scope: "project", runtimeProvider: provider }), true);
  assert.equal((await listPiPackages(workspaceRoot, provider)).some((item) => item.scope === "project"), false);
});

test("project capability mutation trust honors negative policy precedence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-mutation-trust-precedence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const trustStore = new ProjectTrustStore(agentDir);

  trustStore.set(workspaceRoot, false);
  assert.equal(await isPiProjectMutationTrusted(workspaceRoot, {
    async resolveRuntime() {
      return {
        agentDir,
        settingsManager: SettingsManager.inMemory({ defaultProjectTrust: "always" }),
      };
    },
  }), false, "a saved Space denial must win over Pi's persistent always default");

  trustStore.set(workspaceRoot, true);
  assert.equal(await isPiProjectMutationTrusted(workspaceRoot, {
    async resolveRuntime() {
      return {
        agentDir,
        projectTrust: { override: false },
        settingsManager: SettingsManager.inMemory({ defaultProjectTrust: "always" }),
      };
    },
  }), false, "a negative host override must win over a saved allow decision and default");
});

test("native Pi host discovers trusted project extensions, skills, context, commands, and built-ins", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-native-pi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(workspaceRoot, ".pi", "extensions"), { recursive: true });
  await mkdir(join(workspaceRoot, ".pi", "skills", "demo"), { recursive: true });
  await writeFile(join(workspaceRoot, "AGENTS.md"), "# Workspace instructions\n", "utf8");
  await writeFile(
    join(workspaceRoot, ".pi", "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: Demo skill\n---\nFollow the demo.\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".pi", "extensions", "ping.ts"),
    `export default function (pi) {
      pi.registerProvider("test-provider", {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "$TEST_PROVIDER_API_KEY",
        models: [{
          id: "test-model",
          name: "Test Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 1024,
        }],
      });
      pi.registerCommand("ping", {
        description: "Ping the host",
        handler: async (_args, ctx) => ctx.ui.notify("pong", "info"),
      });
    }\n`,
    "utf8",
  );
  const extensionUi = new RoutedPiExtensionUiBridge();
  const provider: PiRuntimeProvider = {
    async resolveRuntime() {
      return { agentDir, extensionUi };
    },
  };
  const untrustedCatalog = await loadAgentSkillCatalog(workspaceRoot, provider);
  assert.equal(untrustedCatalog.projectTrust.trusted, false);
  assert.equal(untrustedCatalog.skills.some((skill) => skill.name === "demo"), false);
  assert.equal(untrustedCatalog.extensions.some((extension) => extension.resolvedPath.endsWith("ping.ts")), false);
  assert.equal(untrustedCatalog.contextFiles.some((file) => file.path.endsWith("AGENTS.md")), true);

  new ProjectTrustStore(agentDir).set(workspaceRoot, true);
  const client = new PiConversationClient("native-test", workspaceRoot, provider);
  t.after(() => client.stop());

  const catalog = await client.getCatalog();
  for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
    assert.equal(catalog.tools.some((tool) => tool.name === name), true, `missing built-in ${name}`);
  }
  assert.deepEqual(catalog.toolManagement, {
    mode: "session-only",
    persisted: false,
    mutable: false,
    scope: "chat",
    reason: "Pi has no persisted Personal or Space tool default; tool selection belongs to each Chat.",
  });
  const readTool = catalog.tools.find((tool) => tool.name === "read");
  assert.equal(readTool?.label, "read");
  assert.equal(readTool?.kind, "core");
  assert.equal(readTool?.core, true);
  assert.equal(readTool?.configurable, false);
  assert.equal(readTool?.configurationScope, "chat");
  assert.equal(catalog.extensions.some((extension) => extension.resolvedPath.endsWith("ping.ts")), true);
  assert.equal(catalog.skills.some((skill) => skill.name === "demo"), true);
  assert.equal(catalog.contextFiles.some((file) => file.path.endsWith("AGENTS.md")), true);
  assert.equal(catalog.commands.find((command) => command.name === "trust")?.description, "Show Space trust status");
  assert.equal(catalog.commands.some((command) => command.name === "ping" && command.source === "extension"), true);
  assert.equal(catalog.projectTrust.trusted, true);
  for (const unsupported of ["new", "resume", "fork", "clone", "tree", "import"]) {
    assert.equal(catalog.commands.some((command) => command.name === unsupported), false);
  }
  const models = await listPiModels(workspaceRoot, provider);
  assert.equal(models.some((model) => model.provider === "test-provider" && model.id === "test-model"), true);

  const uiEventPromise = once(extensionUi, "event");
  assert.equal(await client.prompt("/ping"), "Command completed.");
  const [uiEvent] = await uiEventPromise;
  assert.equal(uiEvent.method, "notify");
  assert.equal(uiEvent.message, "pong");
  assert.match(await client.prompt("/trust no"), /Remove the Space from Workspace to revoke it/);
  assert.equal(new ProjectTrustStore(agentDir).get(workspaceRoot), true, "hosted /trust must not mutate Space trust mid-turn");
  const runtimeState = await client.getState();
  const sessionBefore = runtimeState.sessionId;
  assert.equal(Number.isFinite(runtimeState.usage.totalTokens), true);
  assert.equal(Number.isFinite(runtimeState.usage.cost), true);
  assert.equal(runtimeState.usage.contextWindow === null || runtimeState.usage.contextWindow > 0, true);
  assert.match(await client.prompt("/new"), /unavailable because Workspace keeps the visible chat transcript synchronized/);
  assert.equal((await client.getState()).sessionId, sessionBefore);
});

test("generic provider finish errors retry from the safe point and retain the final partial attempt", async (t) => {
  let requestCount = 0;
  const providerServer = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close",
    });
    const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    const chunk = (content: string, finishReason: string | null) => ({
      id: `completion-${requestCount}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "retry-model",
      choices: [{
        index: 0,
        delta: content ? { role: "assistant", content } : {},
        finish_reason: finishReason,
      }],
    });

    if (requestCount === 1) {
      send(chunk("Discarded partial attempt.", null));
      send(chunk("", "error"));
    } else if (requestCount === 2) {
      send(chunk("Recovered answer.", null));
      send(chunk("", "stop"));
    } else if (requestCount === 3) {
      send(chunk("First doomed attempt.", null));
      send(chunk("", "error"));
    } else {
      send(chunk("Last durable partial.", null));
      send(chunk("", "error"));
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    providerServer.once("error", reject);
    providerServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    providerServer.close((error) => error ? reject(error) : resolve());
  }));
  const port = (providerServer.address() as AddressInfo).port;

  const root = await mkdtemp(join(tmpdir(), "workspace-provider-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "retry-provider.ts"),
    `export default function (pi) {
      pi.registerProvider("retry-provider", {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:${port}/v1",
        apiKey: "test-key",
        models: [{
          id: "retry-model",
          name: "Retry Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 1024,
        }],
      });
    }\n`,
    "utf8",
  );
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "retry-provider",
    defaultModel: "retry-model",
    defaultThinkingLevel: "off",
    retry: {
      enabled: true,
      maxRetries: 1,
      baseDelayMs: 1,
      provider: { maxRetries: 0 },
    },
  });
  const provider: PiRuntimeProvider = {
    async resolveRuntime() {
      return { agentDir, settingsManager };
    },
  };
  const client = new PiConversationClient("provider-retry-test", workspaceRoot, provider);
  t.after(() => client.stop());
  const events: PiChatEvent[] = [];
  client.on("event", (event: PiChatEvent) => events.push(event));

  assert.equal(await client.prompt("Recover this request."), "Recovered answer.");
  assert.equal(requestCount, 2);
  assert.equal(
    events.some((event) => event.type === "assistant_message" && event.text === ""),
    true,
    "the failed attempt must be cleared before streaming the retry",
  );
  assert.equal(
    events.some((event) => event.type === "status" && event.message?.includes("Retrying provider request (1/1)")),
    true,
  );

  await assert.rejects(
    client.prompt("Exhaust the retry budget."),
    (error: unknown) => {
      assert.ok(error instanceof PiTurnFailure);
      assert.equal(error.retryAttempts, 1);
      assert.equal(error.partialText, "Last durable partial.");
      assert.equal(error.provider, "retry-provider");
      assert.equal(error.model, "retry-model");
      return true;
    },
  );
  assert.equal(requestCount, 4);
});
