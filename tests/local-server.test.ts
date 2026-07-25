import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import type { CapabilityRegistryService } from "../src/local/agent/capability-registry.js";
import { RoutedPiExtensionUiBridge } from "../src/local/agent/extension-ui.js";
import {
  RegisteredSpaceRuntimeProvider,
  RegisteredSpaceTrustAuthority,
} from "../src/local/agent/registered-space-runtime.js";
import { startLocalApi } from "../src/local/server.js";
import { WorkspaceKernel } from "../src/local/workspace-kernel.js";

test("local API covers Space files, the Library, and external restore points", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-api-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workspaceBase: join(sandbox, "content"),
    loadEnv: false,
  });
  try {
    assert.ok(api.kernel instanceof WorkspaceKernel, "startLocalApi must expose its compatible default kernel");
    assert.deepEqual(await json(`${api.origin}/api/bootstrap`), {
      workspaces: [],
      agent: { ready: true, configured: false, provider: null, model: null, piVersion: null, projectTrusted: false, error: null },
    });

    const created = await json(`${api.origin}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "API Space" }),
    }) as { workspace: { id: string } };

    const files = new FormData();
    files.set("targetFolderPath", "");
    files.set("relativePaths", JSON.stringify(["Notes/readme.md"]));
    files.append("files", new Blob(["# Hello\n"]), "readme.md");
    await ok(`${api.origin}/api/workspaces/${created.workspace.id}/upload-local-files`, { method: "POST", body: files });
    const preview = await json(`${api.origin}/api/workspaces/${created.workspace.id}/file?path=Notes%2Freadme.md`) as { text: string };
    assert.equal(preview.text, "# Hello\n");

    const resources = new FormData();
    resources.set("targetFolderPath", "");
    resources.set("relativePaths", JSON.stringify(["reference.txt"]));
    resources.append("files", new Blob(["reference"]), "reference.txt");
    const uploadedLibraryItem = await json(`${api.origin}/api/resources/upload`, { method: "POST", body: resources }) as { uploaded: Array<{ path: string }> };
    assert.equal(uploadedLibraryItem.uploaded[0]?.path, "reference.txt");
    const libraryTree = await json(`${api.origin}/api/resources/tree`) as { tree: Array<{ path: string }> };
    assert.equal(libraryTree.tree[0]?.path, "reference.txt");
    const copiedLibraryItem = await json(`${api.origin}/api/resources/copy-to-workspace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: created.workspace.id, paths: ["reference.txt"] }),
    }) as { copied: string[] };
    assert.deepEqual(copiedLibraryItem.copied, ["From Library/reference.txt"]);
    const libraryPreview = await json(`${api.origin}/api/workspaces/${created.workspace.id}/file?path=From%20Library%2Freference.txt`) as { text: string };
    assert.equal(libraryPreview.text, "reference");

    const checkpoint = await json(`${api.origin}/api/workspaces/${created.workspace.id}/history/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "API snapshot" }),
    }) as { checkpoint: { fileCount: number } };
    assert.equal(checkpoint.checkpoint.fileCount, 2);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("conversation runtime snapshots expose model and context state without transcript contents", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-runtime-snapshot-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workspaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const created = await json(`${api.origin}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Runtime Space" }),
    }) as { workspace: { id: string } };
    const conversation = await json(`${api.origin}/api/workspaces/${created.workspace.id}/conversations`, {
      method: "POST",
    }) as { conversation: { id: string } };
    const result = await json(
      `${api.origin}/api/workspaces/${created.workspace.id}/conversations/${conversation.conversation.id}/runtime`,
    ) as {
      runtime: {
        sessionId: string;
        usage: {
          contextTokens: number | null;
          contextWindow: number | null;
          contextPercent: number | null;
          totalTokens: number;
          cost: number;
        };
      };
    };

    assert.ok(result.runtime.sessionId);
    assert.deepEqual(Object.keys(result.runtime.usage).sort(), [
      "contextPercent",
      "contextTokens",
      "contextWindow",
      "cost",
      "totalTokens",
    ]);
    assert.equal(result.runtime.usage.totalTokens, 0);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("desktop linked folders require the exact one-shot picker grant", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-desktop-grant-test-"));
  const linkedRoot = join(sandbox, "linked");
  const stateRoot = join(sandbox, "state");
  await mkdir(linkedRoot, { recursive: true });
  let available = true;
  const api = await startLocalApi({
    port: 0,
    appMode: "desktop",
    stateBase: stateRoot,
    sessionToken: "desktop-session",
    loadEnv: false,
    localFolderGrantProvider: {
      consumeLocalFolderGrant(input) {
        assert.deepEqual(input, { rootPath: linkedRoot, grantId: "grant-1" });
        if (!available) return false;
        available = false;
        return true;
      },
    },
  });
  try {
    const headers = { "content-type": "application/json", "x-workspace-session": "desktop-session" };
    const first = await fetch(`${api.origin}/api/workspaces/local-folder`, {
      method: "POST",
      headers,
      body: JSON.stringify({ rootPath: linkedRoot, folderGrantId: "grant-1" }),
    });
    assert.equal(first.status, 201, await first.text());
    const replay = await fetch(`${api.origin}/api/workspaces/local-folder`, {
      method: "POST",
      headers,
      body: JSON.stringify({ rootPath: linkedRoot, folderGrantId: "grant-1" }),
    });
    assert.equal(replay.status, 403);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("registered Space authorization overrides Pi's independent project-trust decision", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-default-trust-test-"));
  const agentDir = join(sandbox, "agent");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workspaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir, settingsManager: SettingsManager.inMemory({ defaultProjectTrust: "always" }) };
      },
    },
  });
  try {
    const created = await json(`${api.origin}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Default Trust Space" }),
    }) as { workspace: { id: string } };
    const catalog = await json(`${api.origin}/api/workspaces/${created.workspace.id}/agent/catalog`) as any;
    assert.deepEqual(catalog.projectTrust, {
      required: false,
      trusted: true,
      savedDecision: null,
      mutationTrusted: true,
    });
    assert.deepEqual(catalog.trust, catalog.projectTrust);

  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("capability catalog and package lifecycle preserve native Pi state and provenance", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-capability-api-test-"));
  const agentDir = join(sandbox, "agent");
  const packageRoot = join(sandbox, "capability-package");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await mkdir(join(packageRoot, "skills", "catalog-skill"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "capability-package",
    private: true,
    pi: { extensions: ["extensions"], skills: ["skills"] },
  }), "utf8");
  await writeFile(join(packageRoot, "skills", "catalog-skill", "SKILL.md"), [
    "---",
    "name: catalog-skill",
    "description: Catalog Skill",
    "---",
    "Use the catalog.",
  ].join("\n"), "utf8");
  await writeFile(join(packageRoot, "extensions", "catalog.ts"), `export default function (pi) {
    pi.registerFlag("catalog-flag", { description: "Catalog flag", type: "boolean" });
    pi.registerCommand("catalog-command", { description: "Catalog command", handler: async () => undefined });
  }\n`, "utf8");

  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workspaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir }; } },
  });
  try {
    const created = await json(`${api.origin}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Capability Space" }),
    }) as { workspace: { id: string } };
    const workspaceId = created.workspace.id;

    const initialCatalog = await json(`${api.origin}/api/workspaces/${workspaceId}/agent/catalog`) as any;
    assert.deepEqual(initialCatalog.projectTrust, { required: false, trusted: true, savedDecision: null, mutationTrusted: true });
    assert.equal(initialCatalog.projectTrusted, true, "a Space with no gated resources must not be mislabeled untrusted");

    await ok(`${api.origin}/api/agent/packages/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, source: packageRoot, scope: "project" }),
    });

    const catalog = await json(`${api.origin}/api/workspaces/${workspaceId}/agent/catalog`) as any;
    assert.deepEqual(catalog.projectTrust, { required: true, trusted: true, savedDecision: null, mutationTrusted: true });
    assert.deepEqual(catalog.trust, catalog.projectTrust);
    assert.equal(catalog.projectTrusted, true);
    assert.equal(catalog.packages.length, 1);
    assert.equal(catalog.packages[0].scope, "project");
    assert.equal(catalog.packages[0].filtered, false);
    assert.equal(catalog.packages[0].installedPath, packageRoot);
    assert.equal(catalog.packages[0].installed, true);
    assert.equal(catalog.packages[0].loaded, true);

    const skill = catalog.skills.find((item: any) => item.name === "catalog-skill");
    assert.ok(skill);
    assert.equal(skill.enabled, true);
    assert.equal(skill.loaded, true);
    assert.equal(skill.status, "loaded");
    assert.equal(skill.scope, "project");
    assert.equal(skill.origin, "package");
    assert.equal(skill.packageSource, catalog.packages[0].source);
    assert.equal(skill.sourceInfo.path.endsWith("SKILL.md"), true);
    assert.equal(skill.sourceInfo.baseDir, packageRoot);
    assert.match(skill.content, /Use the catalog/);

    const extension = catalog.extensions.find((item: any) => item.name === "catalog");
    assert.ok(extension);
    assert.equal(extension.enabled, true);
    assert.equal(extension.loaded, true);
    assert.equal(extension.status, "loaded");
    assert.deepEqual(extension.flags, ["catalog-flag"]);
    assert.deepEqual(extension.commands, ["catalog-command"]);
    assert.equal(extension.sourceInfo.scope, "project");

    const tools = new Map(catalog.tools.map((tool: any) => [tool.name, tool]));
    assert.deepEqual(catalog.toolManagement, {
      mode: "session-only",
      persisted: false,
      mutable: false,
      scope: "chat",
      reason: "Pi has no persisted Personal or Space tool default; tool selection belongs to each Chat.",
    });
    assert.equal(tools.get("read")?.active, true);
    assert.equal(tools.get("read")?.label, "read");
    assert.equal(tools.get("read")?.kind, "core");
    assert.equal(tools.get("read")?.core, true);
    assert.equal(tools.get("read")?.configurable, false);
    assert.equal(tools.get("read")?.configurationScope, "chat");
    assert.equal(tools.get("find")?.active, false);

    await ok(`${api.origin}/api/agent/packages/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, source: catalog.packages[0].source, scope: "project" }),
    });
    const removal = await json(`${api.origin}/api/agent/packages/remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, source: catalog.packages[0].source, scope: "project" }),
    }) as { removed: boolean };
    assert.equal(removal.removed, true);
    const after = await json(`${api.origin}/api/workspaces/${workspaceId}/agent/catalog`) as any;
    assert.deepEqual(after.packages, []);
    assert.equal(after.skills.some((item: any) => item.name === "catalog-skill"), false);
    assert.equal(after.extensions.some((item: any) => item.name === "catalog"), false);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("registry discovery installs through guarded capability mutations without stopping active turns", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-capability-registry-test-"));
  const agentDir = join(sandbox, "agent");
  const packageRoot = join(sandbox, "registry-package");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(packageRoot, "skills", "registry-skill"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 300)),
    });
  }\n`, "utf8");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "registry-package",
    private: true,
    pi: { skills: ["skills"] },
  }), "utf8");
  await writeFile(join(packageRoot, "skills", "registry-skill", "SKILL.md"), [
    "---",
    "name: registry-skill",
    "description: Registry Skill",
    "---",
    "Use the registry.",
  ].join("\n"), "utf8");

  const registryItem = {
    id: "test:registry-package",
    name: "Registry package",
    description: "Controlled registry fixture",
    types: ["skill" as const],
    sourceKind: "reference" as const,
    installSource: packageRoot,
    official: true,
  };
  const bundleItem = {
    id: "test:registry-bundle",
    name: "Registry bundle",
    description: "Controlled Skill bundle fixture",
    types: ["skill" as const],
    sourceKind: "bundle" as const,
    official: true,
  };
  const capabilityRegistry: CapabilityRegistryService = {
    async search(options = {}) {
      return { items: [registryItem, bundleItem], total: 2, offset: options.offset ?? 0, limit: options.limit ?? 24, truncated: false, diagnostics: [] };
    },
    async details(id) {
      if (id === registryItem.id) return registryItem;
      if (id === bundleItem.id) return bundleItem;
      throw new Error(`Unknown fixture capability: ${id}`);
    },
    async buildOfficialSkillBundle(id) {
      assert.equal(id, bundleItem.id);
      return {
        fileName: "SKILL.md",
        bytes: new TextEncoder().encode("---\nname: bundled-skill\ndescription: Bundled Skill\n---\nUse the bundle.\n"),
        item: bundleItem,
      };
    },
  };
  const piRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };
  const spaceTrustAuthority = new RegisteredSpaceTrustAuthority();
  const kernel = new WorkspaceKernel({
    runtimeProvider: new RegisteredSpaceRuntimeProvider(piRuntimeProvider, spaceTrustAuthority),
  });

  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workspaceBase: join(sandbox, "content"),
    loadEnv: false,
    capabilityRegistry,
    kernel,
    piRuntimeProvider,
    spaceTrustAuthority,
  });
  try {
    const discovered = await json(`${api.origin}/api/agent/capabilities/discover?type=skill&sort=name&limit=10`) as any;
    assert.equal(discovered.items[0].id, registryItem.id);
    assert.equal(discovered.catalogUrl, "https://pi.dev/packages");

    const details = await json(`${api.origin}/api/agent/capabilities/details?id=${encodeURIComponent(registryItem.id)}`) as any;
    assert.equal(details.item.installSource, packageRoot);

    const created = await json(`${api.origin}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Registry Space" }),
    }) as { workspace: { id: string } };
    const workspaceId = created.workspace.id;
    const createdConversation = await json(`${api.origin}/api/workspaces/${workspaceId}/conversations`, { method: "POST" }) as { conversation: { id: string } };
    const conversationId = createdConversation.conversation.id;

    const activeTurn = await fetch(`${api.origin}/api/workspaces/${workspaceId}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/hold" }),
    });
    assert.equal(activeTurn.status, 202, await activeTurn.text());
    const runningTasks = await kernel.getTasks({ kind: "system" });
    assert.equal(runningTasks.tasks.some((task) => task.kind === "assistant_turn" && task.workspaceId === workspaceId && task.conversationId === conversationId), true);

    const blockedRegistryInstall = await fetch(`${api.origin}/api/agent/capabilities/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, id: registryItem.id, scope: "global" }),
    });
    assert.equal(blockedRegistryInstall.status, 409, await blockedRegistryInstall.text());

    for (const action of ["install", "update", "remove"] as const) {
      const blockedPackageMutation = await fetch(`${api.origin}/api/agent/packages/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, source: packageRoot, scope: "global" }),
      });
      assert.equal(blockedPackageMutation.status, 409, `${action}: ${await blockedPackageMutation.text()}`);
    }

    const skillImport = new FormData();
    skillImport.set("workspaceId", workspaceId);
    skillImport.set("scope", "global");
    skillImport.append("files", new Blob(["---\nname: blocked-skill\ndescription: Blocked Skill\n---\nWait.\n"]), "SKILL.md");
    const blockedSkillImport = await fetch(`${api.origin}/api/agent/skills/import`, { method: "POST", body: skillImport });
    assert.equal(blockedSkillImport.status, 409, await blockedSkillImport.text());

    await waitForAsync(async () => {
      const transcript = await json(`${api.origin}/api/workspaces/${workspaceId}/conversations/${conversationId}`) as any;
      return transcript.messages.some((message: any) => message.role === "assistant" && message.content === "Command completed.");
    });
    await waitForAsync(async () => (await kernel.getTasks({ kind: "system" })).tasks.length === 0);
    assert.deepEqual((await kernel.getTasks({ kind: "system" })).tasks, []);

    const installed = await json(`${api.origin}/api/agent/capabilities/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, id: registryItem.id, scope: "project" }),
    }) as any;
    assert.equal(installed.installed.kind, "package");
    assert.equal(installed.installed.source, details.item.installSource, "installation must use the exact source returned by review");
    const installedBundle = await json(`${api.origin}/api/agent/capabilities/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, id: bundleItem.id, scope: "project" }),
    }) as any;
    assert.equal(installedBundle.installed.kind, "skill");
    const catalog = await json(`${api.origin}/api/workspaces/${workspaceId}/agent/catalog`) as any;
    assert.equal(catalog.skills.some((skill: any) => skill.name === "registry-skill" && skill.scope === "project"), true);
    assert.equal(catalog.skills.some((skill: any) => skill.name === "bundled-skill" && skill.scope === "project"), true);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("capability mutations and explicit Chat compaction are mutually exclusive", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-capability-compaction-test-"));
  const agentDir = join(sandbox, "agent");
  const packageRoot = join(sandbox, "local-package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "local-package", private: true }), "utf8");

  type RuntimeBlock = { signalEntered(): void; released: Promise<void> };
  let nextRuntimeBlock: RuntimeBlock | null = null;
  const blockNextRuntimeResolution = () => {
    let signalEntered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    nextRuntimeBlock = { signalEntered, released };
    return { entered, release };
  };
  const kernel = new WorkspaceKernel();
  const piRuntimeProvider = {
    async resolveRuntime() {
      const block = nextRuntimeBlock;
      nextRuntimeBlock = null;
      if (block) {
        block.signalEntered();
        await block.released;
      }
      return { agentDir };
    },
  };

  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workspaceBase: join(sandbox, "content"),
    loadEnv: false,
    kernel,
    piRuntimeProvider,
  });
  try {
    const created = await json(`${api.origin}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Compaction Space" }),
    }) as { workspace: { id: string } };
    const workspaceId = created.workspace.id;
    const createdConversation = await json(`${api.origin}/api/workspaces/${workspaceId}/conversations`, { method: "POST" }) as { conversation: { id: string } };
    const conversationId = createdConversation.conversation.id;
    const compactUrl = `${api.origin}/api/workspaces/${workspaceId}/conversations/${conversationId}/compact`;

    const compactBlock = blockNextRuntimeResolution();
    const compactPromise = fetch(compactUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await compactBlock.entered;
    const compactingTasks = await kernel.getTasks({ kind: "system" });
    assert.deepEqual(compactingTasks.tasks.map((task) => ({ kind: task.kind, workspaceId: task.workspaceId, conversationId: task.conversationId })), [{
      kind: "compaction",
      workspaceId,
      conversationId,
    }]);
    const mutationDuringCompact = await fetch(`${api.origin}/api/agent/packages/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, source: packageRoot, scope: "global" }),
    });
    assert.equal(mutationDuringCompact.status, 409, await mutationDuringCompact.text());
    compactBlock.release();
    await (await compactPromise).text();
    assert.deepEqual((await kernel.getTasks({ kind: "system" })).tasks, []);

    const mutationBlock = blockNextRuntimeResolution();
    const mutationPromise = fetch(`${api.origin}/api/agent/packages/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, source: packageRoot, scope: "global" }),
    });
    await mutationBlock.entered;
    const compactDuringMutation = await fetch(compactUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(compactDuringMutation.status, 409, await compactDuringMutation.text());
    mutationBlock.release();
    const installed = await mutationPromise;
    assert.equal(installed.status, 201, await installed.text());
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("extension UI events retain the portable Space id after its folder moves", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-moved-extension-routing-test-"));
  const originalRoot = join(sandbox, "original-space");
  const movedRoot = join(sandbox, "moved-space");
  await mkdir(originalRoot, { recursive: true });
  const extensionUi = new RoutedPiExtensionUiBridge();
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workspaceBase: join(sandbox, "content"),
    loadEnv: false,
    extensionUiBridge: extensionUi,
  });
  const streamController = new AbortController();
  try {
    const original = await json(`${api.origin}/api/workspaces/local-folder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootPath: originalRoot }),
    }) as { workspace: { id: string } };
    const workspaceId = original.workspace.id;
    const createdConversation = await json(`${api.origin}/api/workspaces/${workspaceId}/conversations`, { method: "POST" }) as { conversation: { id: string } };
    const conversationId = createdConversation.conversation.id;

    await rename(originalRoot, movedRoot);
    const relinked = await json(`${api.origin}/api/workspaces/local-folder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootPath: movedRoot }),
    }) as { workspace: { id: string; rootPath: string } };
    assert.equal(relinked.workspace.id, workspaceId);
    assert.equal(relinked.workspace.rootPath, movedRoot);

    const streamResponse = await fetch(
      `${api.origin}/api/workspaces/${workspaceId}/conversations/${conversationId}/events`,
      { signal: streamController.signal },
    );
    assert.equal(streamResponse.ok, true);
    const streamEvents: TestStreamEvent[] = [];
    const pump = pumpSseEvents(streamResponse, streamEvents).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
    });
    await waitFor(() => streamEvents.some((event) => event.type === "turn_state"));

    extensionUi.publish({
      id: "moved-space-notification",
      method: "notify",
      message: "Portable route preserved.",
      workspaceRoot: movedRoot,
      conversationId,
    });
    await waitFor(() => streamEvents.some((event) => event.request?.id === "moved-space-notification"));
    assert.equal(streamEvents.find((event) => event.request?.id === "moved-space-notification")?.request?.message, "Portable route preserved.");

    streamController.abort();
    await pump;
  } finally {
    streamController.abort();
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("chat streams snapshot running state and survive a throwing desktop activity observer", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-background-chat-test-"));
  const agentDir = join(sandbox, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "complete.ts"), `export default function (pi) {
    pi.registerCommand("complete", {
      description: "Complete a deterministic test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 25)),
    });
  }\n`, "utf8");
  const activityCounts: number[] = [];
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workspaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir }; } },
    onAgentTurnActivity(activeTurns) {
      activityCounts.push(activeTurns);
      throw new Error("simulated desktop observer failure");
    },
  });
  const streamController = new AbortController();
  try {
    const created = await json(`${api.origin}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Background Space" }),
    }) as { workspace: { id: string } };
    const createdConversation = await json(`${api.origin}/api/workspaces/${created.workspace.id}/conversations`, {
      method: "POST",
    }) as { conversation: { id: string } };
    const conversationId = createdConversation.conversation.id;
    const streamResponse = await fetch(
      `${api.origin}/api/workspaces/${created.workspace.id}/conversations/${conversationId}/events`,
      { signal: streamController.signal },
    );
    assert.equal(streamResponse.ok, true);
    const streamEvents: TestStreamEvent[] = [];
    const pump = pumpSseEvents(streamResponse, streamEvents).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
    });

    await waitFor(() => streamEvents.some((event) => event.type === "turn_state" && event.running === false));
    const firstPost = await fetch(`${api.origin}/api/workspaces/${created.workspace.id}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/complete" }),
    });
    assert.equal(firstPost.status, 202, await firstPost.text());
    await waitFor(() => streamEvents.some((event) => event.type === "turn_state" && event.running === true));
    await waitFor(() => activityCounts.length >= 2 && activityCounts.at(-1) === 0);
    assert.deepEqual(activityCounts.slice(0, 2), [1, 0]);

    // If the observer exception escaped changeTurnCount, the running key would
    // remain stranded and this second turn would return 409.
    const secondPost = await fetch(`${api.origin}/api/workspaces/${created.workspace.id}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/complete" }),
    });
    assert.equal(secondPost.status, 202, await secondPost.text());
    await waitFor(() => activityCounts.length >= 4 && activityCounts.at(-1) === 0);
    assert.deepEqual(activityCounts.slice(2, 4), [1, 0]);

    streamController.abort();
    await pump;
  } finally {
    streamController.abort();
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text) as unknown;
}

async function ok(url: string, init?: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, text);
}

interface TestStreamEvent {
  type?: string;
  running?: boolean;
  request?: { id?: string; message?: string };
}

async function pumpSseEvents(response: Response, events: TestStreamEvent[]): Promise<void> {
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) events.push(JSON.parse(data) as TestStreamEvent);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for background chat state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous server state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
