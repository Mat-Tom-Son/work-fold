import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { PiResourceCatalog } from "../src/local/agent/skill-catalog.js";
import {
  WorkspaceCliError,
  WorkspaceCliExitCode,
} from "../src/local/cli/protocol.js";
import { WorkspaceCliKernelAdapter } from "../src/local/workspace-cli-adapter.js";
import { WorkspaceKernel } from "../src/local/workspace-kernel.js";
import type { WorkspaceSummary } from "../src/local/workspace.js";

test("WorkspaceCliKernelAdapter resolves --space by exact id before case-insensitive name", async () => {
  const alphaRoot = join(process.cwd(), "cli-adapter", "alpha");
  const betaRoot = join(process.cwd(), "cli-adapter", "beta");
  const spaces = [
    space("alpha", "Primary", alphaRoot),
    space("beta", "ALPHA", betaRoot),
  ];
  const adapter = new WorkspaceCliKernelAdapter(new WorkspaceKernel(spaceDependencies(spaces)));
  const actor = { kind: "cli" as const, cwd: join(betaRoot, "documents") };

  const byId = await adapter.getContext(actor, { space: " alpha " });
  assert.equal(byId.space?.id, "alpha", "an exact id must win over another Space's matching name");

  const byName = await adapter.getContext(actor, { space: "primary" });
  assert.equal(byName.space?.id, "alpha");

  const inferred = await adapter.listSpaces(actor, {});
  assert.deepEqual(inferred.map(({ id, active }) => ({ id, active })), [
    { id: "alpha", active: false },
    { id: "beta", active: true },
  ]);

  const selected = await adapter.listSpaces(actor, { space: "PRIMARY" });
  assert.deepEqual(selected.map(({ id, active }) => ({ id, active })), [{ id: "alpha", active: true }]);
});

test("WorkspaceCliKernelAdapter reports missing and ambiguous Space selectors as CLI errors", async () => {
  const root = join(process.cwd(), "cli-adapter-errors");
  const spaces = [
    space("ws-one", "Shared", join(root, "one")),
    space("ws-two", "SHARED", join(root, "two")),
  ];
  const adapter = new WorkspaceCliKernelAdapter(new WorkspaceKernel(spaceDependencies(spaces)));
  const actor = { kind: "cli" as const, cwd: root };

  await assert.rejects(
    adapter.getContext(actor, { space: "shared" }),
    (error: unknown) => error instanceof WorkspaceCliError
      && error.code === "conflict"
      && error.exitCode === WorkspaceCliExitCode.conflict
      && /ambiguous/i.test(error.message),
  );
  await assert.rejects(
    adapter.listTasks(actor, { space: "missing" }),
    (error: unknown) => error instanceof WorkspaceCliError
      && error.code === "notFound"
      && error.exitCode === WorkspaceCliExitCode.notFound
      && /not found/i.test(error.message),
  );
});

test("WorkspaceCliKernelAdapter flattens scoped kernel tasks", async () => {
  const alphaRoot = join(process.cwd(), "cli-adapter-tasks", "alpha");
  const betaRoot = join(process.cwd(), "cli-adapter-tasks", "beta");
  const spaces = [
    space("ws-alpha", "Alpha", alphaRoot),
    space("ws-beta", "Beta", betaRoot),
  ];
  const timestamps = [new Date("2026-07-11T12:00:00.000Z"), new Date("2026-07-11T12:01:00.000Z")];
  const kernel = new WorkspaceKernel({
    ...spaceDependencies(spaces),
    now: () => timestamps.shift() ?? new Date("2026-07-11T12:02:00.000Z"),
  });
  kernel.startTask({ id: "turn-alpha", kind: "assistant_turn", workspaceId: "ws-alpha", actor: { kind: "assistant" } });
  kernel.startTask({ id: "compact-beta", kind: "compaction", workspaceId: "ws-beta", actor: { kind: "assistant" } });
  const adapter = new WorkspaceCliKernelAdapter(kernel);

  const tasks = await adapter.listTasks(
    { kind: "cli", cwd: join(alphaRoot, "documents") },
    { space: "beta" },
  );
  assert.deepEqual(tasks, [{
    id: "compact-beta",
    label: "Chat compaction",
    status: "running",
    workspaceId: "ws-beta",
    updatedAt: "2026-07-11T12:01:00.000Z",
  }]);
});

test("WorkspaceCliKernelAdapter flattens every capability kind without exposing Skill contents", async () => {
  const root = join(process.cwd(), "cli-adapter-capabilities");
  const workspace = space("ws-capabilities", "Capabilities", root);
  const projectPackage = "npm:@demo/project-kit@1.0.0";
  const catalog: PiResourceCatalog = {
    projectTrust: { required: true, trusted: true, savedDecision: true },
    packages: [],
    toolManagement: {
      mode: "session-only",
      persisted: false,
      mutable: false,
      scope: "chat",
      reason: "Tools belong to the Chat.",
    },
    skills: [{
      name: "project-research",
      description: "Research a project",
      path: join(root, ".pi", "skills", "research", "SKILL.md"),
      baseDir: root,
      disableModelInvocation: false,
      content: "TOP SECRET SKILL CONTENT",
      source: source("skills/research/SKILL.md", projectPackage, "project", "package", root),
    }],
    extensions: [{
      path: "extensions/review.ts",
      resolvedPath: join(root, ".pi", "extensions", "review.ts"),
      source: source("extensions/review.ts", "auto", "user", "top-level"),
      tools: ["review"],
      commands: [],
      flags: [],
    }],
    surfaces: [{
      id: "private-dashboard",
      title: "Private dashboard",
      extensionPath: join(root, ".pi", "extensions", "review.ts"),
      manifestPath: join(root, ".pi", "extensions", "surface.json"),
      source: source("extensions/review.ts", "auto", "user", "top-level"),
      views: [{
        id: "overview",
        title: "Overview",
        blocks: [{ type: "text", text: "PRIVATE SURFACE CONTENT" }],
      }],
    }],
    tools: [{
      name: "read",
      label: "Read",
      description: "Read a file",
      active: true,
      kind: "core",
      core: true,
      configurable: false,
      configurationScope: "chat",
      source: source("builtin:read", "builtin", "user", "top-level"),
    }],
    prompts: [{
      name: "handoff",
      description: "Prepare a handoff",
      path: join(root, ".pi", "prompts", "handoff.md"),
      source: source("prompts/handoff.md", "auto", "project", "top-level", root),
    }],
    themes: [{
      name: "Kai Dark",
      path: join(root, ".pi", "themes", "kai-dark.json"),
      source: source("themes/kai-dark.json", "auto", "temporary", "top-level"),
    }],
    contextFiles: [],
    commands: [{
      name: "trust",
      description: "Show trust",
      source: "builtin",
    }],
    diagnostics: [],
  };
  const kernel = new WorkspaceKernel({
    ...spaceDependencies([workspace]),
    async loadCapabilityCatalog() { return catalog; },
    async listPackages() {
      return [{
        source: projectPackage,
        scope: "project" as const,
        filtered: false,
        installedPath: join(root, ".pi", "npm", "project-kit"),
      }];
    },
    async isProjectMutationTrusted() { return true; },
  });
  const adapter = new WorkspaceCliKernelAdapter(kernel);

  const capabilities = await adapter.listCapabilities(
    { kind: "cli", cwd: join(process.cwd(), "outside-capability-space") },
    { space: "capabilities" },
  );
  assert.deepEqual(new Set(capabilities.map((item) => item.kind)), new Set([
    "skill",
    "extension",
    "tool",
    "package",
    "other",
  ]));
  assert.deepEqual(
    capabilities.filter((item) => item.kind === "other").map((item) => item.id.split(":", 1)[0]).sort(),
    ["command", "prompt", "theme"],
  );
  assert.equal(capabilities.find((item) => item.kind === "skill")?.scope, "space");
  assert.equal(capabilities.find((item) => item.kind === "extension")?.scope, "personal");
  assert.equal(capabilities.find((item) => item.id.startsWith("theme:"))?.scope, "temporary");
  assert.equal(JSON.stringify(capabilities).includes("TOP SECRET SKILL CONTENT"), false);
  assert.equal(JSON.stringify(capabilities).includes("PRIVATE SURFACE CONTENT"), false);
  assert.equal(Object.hasOwn(capabilities.find((item) => item.kind === "skill") ?? {}, "content"), false);
});

test("WorkspaceCliKernelAdapter maps missing cwd capability context to notFound", async () => {
  const root = join(process.cwd(), "cli-adapter-context-required");
  const adapter = new WorkspaceCliKernelAdapter(new WorkspaceKernel(spaceDependencies([
    space("ws-only", "Only", root),
  ])));

  await assert.rejects(
    adapter.listCapabilities({ kind: "cli", cwd: join(process.cwd(), "outside-all-spaces") }, {}),
    (error: unknown) => error instanceof WorkspaceCliError
      && error.code === "notFound"
      && error.exitCode === WorkspaceCliExitCode.notFound
      && /--space/.test(error.message),
  );
});

test("WorkspaceCliKernelAdapter resolves Check status scope and projects only aggregate fields", async () => {
  const alphaRoot = join(process.cwd(), "cli-adapter-checks", "alpha");
  const betaRoot = join(process.cwd(), "cli-adapter-checks", "beta");
  const spaces = [
    space("ws-alpha", "Alpha", alphaRoot),
    space("ws-beta", "Beta", betaRoot),
  ];
  const calls: Array<{ workspaceId: string; workspaceRoot: string }> = [];
  const adapter = new WorkspaceCliKernelAdapter(new WorkspaceKernel(spaceDependencies(spaces)), {
    async checksStatusProvider(input) {
      calls.push(input);
      return {
        kind: "workspace.checks.experimental",
        version: 0,
        workspaceId: input.workspaceId,
        state: "needs-attention",
        configured: 4,
        proposed: 1,
        enabled: 3,
        current: 2,
        stale: 1,
        blocked: 0,
        errors: 0,
        needsAttention: 2,
        running: 1,
        lastRunAt: "2026-08-01T12:00:00-04:00",
        title: "PRIVATE CHECK TITLE",
        path: "/private/Space/secret.txt",
        evidence: "PRIVATE QUOTE",
        decisions: ["accept"],
        sensorParameters: { prompt: "PRIVATE PROMPT" },
        errorText: "PRIVATE ERROR DETAIL",
      } as never;
    },
  });

  const result = await adapter.getChecksStatus(
    { kind: "cli", cwd: join(alphaRoot, "documents") },
    { space: "beta" },
  );
  assert.deepEqual(calls, [{ workspaceId: "ws-beta", workspaceRoot: betaRoot }]);
  assert.deepEqual(result, {
    kind: "workspace.checks.experimental",
    version: 0,
    available: true,
    workspaceId: "ws-beta",
    state: "needs-attention",
    configured: 4,
    proposed: 1,
    enabled: 3,
    current: 2,
    stale: 1,
    blocked: 0,
    errors: 0,
    needsAttention: 2,
    running: 1,
    lastRunAt: "2026-08-01T16:00:00.000Z",
  });
  const serialized = JSON.stringify(result);
  for (const secret of ["PRIVATE CHECK TITLE", betaRoot, "PRIVATE QUOTE", "accept", "PRIVATE PROMPT", "PRIVATE ERROR DETAIL"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("WorkspaceCliKernelAdapter reports unavailable status when no safe aggregate provider exists", async () => {
  const root = join(process.cwd(), "cli-adapter-checks-unavailable");
  const workspace = space("ws-only", "Only", root);
  const actor = { kind: "cli" as const, cwd: join(root, "documents") };
  const expected = {
    kind: "workspace.checks.experimental" as const,
    version: 0 as const,
    available: false,
    workspaceId: workspace.id,
    state: "unavailable" as const,
    configured: 0,
    proposed: 0,
    enabled: 0,
    current: 0,
    stale: 0,
    blocked: 0,
    errors: 0,
    needsAttention: 0,
    running: 0,
    lastRunAt: null,
  };

  const withoutProvider = new WorkspaceCliKernelAdapter(new WorkspaceKernel(spaceDependencies([workspace])));
  assert.deepEqual(await withoutProvider.getChecksStatus(actor, {}), expected);

  const failedProvider = new WorkspaceCliKernelAdapter(new WorkspaceKernel(spaceDependencies([workspace])), {
    async checksStatusProvider() {
      throw new Error(`PRIVATE CHECK FAILURE at ${join(root, "secret.txt")}`);
    },
  });
  const failed = await failedProvider.getChecksStatus(actor, {});
  assert.deepEqual(failed, expected);
  assert.equal(JSON.stringify(failed).includes("PRIVATE CHECK FAILURE"), false);

  const invalidProvider = new WorkspaceCliKernelAdapter(new WorkspaceKernel(spaceDependencies([workspace])), {
    async checksStatusProvider() {
      return {
        kind: "workspace.checks.experimental",
        version: 0,
        workspaceId: workspace.id,
        state: "not-configured",
        configured: -1,
        proposed: 0,
        enabled: 0,
        current: 0,
        stale: 0,
        blocked: 0,
        errors: 0,
        needsAttention: 0,
        running: 0,
        lastRunAt: null,
      };
    },
  });
  assert.deepEqual(await invalidProvider.getChecksStatus(actor, {}), expected);
});

function spaceDependencies(spaces: WorkspaceSummary[]) {
  return {
    async listWorkspaces() { return spaces; },
    async getWorkspace(workspaceId: string) {
      const workspace = spaces.find((item) => item.id === workspaceId);
      if (!workspace) throw new Error(`Unknown Space: ${workspaceId}`);
      return workspace;
    },
  };
}

function space(id: string, name: string, rootPath: string): WorkspaceSummary {
  return {
    id,
    name,
    rootPath,
    location: { kind: "local", storage: "linked" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function source(
  path: string,
  sourceName: string,
  scope: "user" | "project" | "temporary",
  origin: "package" | "top-level",
  baseDir?: string,
) {
  return {
    path,
    source: sourceName,
    scope,
    origin,
    ...(baseDir ? { baseDir } : {}),
  };
}
