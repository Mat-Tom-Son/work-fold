import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { PiResourceCatalog } from "../src/local/agent/skill-catalog.js";
import {
  WorkFoldCliError,
  WorkFoldCliExitCode,
} from "../src/local/cli/protocol.js";
import { WorkFoldCliKernelAdapter } from "../src/local/work-fold-cli-adapter.js";
import { WorkFoldKernel } from "../src/local/work-fold-kernel.js";
import type { WorkFolderSummary } from "../src/local/work-folder.js";

test("WorkFoldCliKernelAdapter resolves --work-folder by exact id before case-insensitive name", async () => {
  const alphaRoot = join(process.cwd(), "cli-adapter", "alpha");
  const betaRoot = join(process.cwd(), "cli-adapter", "beta");
  const alphaId = "space-aaaaaaaaaaaaaaaa";
  const betaId = "space-bbbbbbbbbbbbbbbb";
  const workFolders = [
    workFolder(alphaId, "Primary", alphaRoot),
    workFolder(betaId, alphaId.toUpperCase(), betaRoot),
  ];
  const adapter = new WorkFoldCliKernelAdapter(new WorkFoldKernel(workFolderDependencies(workFolders)));
  const actor = { kind: "cli" as const, cwd: join(betaRoot, "documents") };

  const byId = await adapter.getContext(actor, { workFolder: ` ${alphaId} ` });
  assert.equal(byId.workFolder?.id, alphaId, "an exact id must win over another work-folder's matching name");

  const byName = await adapter.getContext(actor, { workFolder: "primary" });
  assert.equal(byName.workFolder?.id, alphaId);

  const inferred = await adapter.listWorkFolders(actor, {});
  assert.deepEqual(inferred.map(({ id, active }) => ({ id, active })), [
    { id: alphaId, active: false },
    { id: betaId, active: true },
  ]);

  const selected = await adapter.listWorkFolders(actor, { workFolder: "PRIMARY" });
  assert.deepEqual(selected.map(({ id, active }) => ({ id, active })), [{ id: alphaId, active: true }]);
});

test("WorkFoldCliKernelAdapter reports missing and ambiguous work-folder selectors as CLI errors", async () => {
  const root = join(process.cwd(), "cli-adapter-errors");
  const workFolders = [
    workFolder("space-1111111111111111", "Shared", join(root, "one")),
    workFolder("space-2222222222222222", "SHARED", join(root, "two")),
  ];
  const adapter = new WorkFoldCliKernelAdapter(new WorkFoldKernel(workFolderDependencies(workFolders)));
  const actor = { kind: "cli" as const, cwd: root };

  await assert.rejects(
    adapter.getContext(actor, { workFolder: "shared" }),
    (error: unknown) => error instanceof WorkFoldCliError
      && error.code === "conflict"
      && error.exitCode === WorkFoldCliExitCode.conflict
      && /ambiguous/i.test(error.message),
  );
  await assert.rejects(
    adapter.listTasks(actor, { workFolder: "missing" }),
    (error: unknown) => error instanceof WorkFoldCliError
      && error.code === "notFound"
      && error.exitCode === WorkFoldCliExitCode.notFound
      && /not found/i.test(error.message),
  );
});

test("WorkFoldCliKernelAdapter flattens scoped kernel tasks", async () => {
  const alphaRoot = join(process.cwd(), "cli-adapter-tasks", "alpha");
  const betaRoot = join(process.cwd(), "cli-adapter-tasks", "beta");
  const alphaId = "space-3333333333333333";
  const betaId = "space-4444444444444444";
  const workFolders = [
    workFolder(alphaId, "Alpha", alphaRoot),
    workFolder(betaId, "Beta", betaRoot),
  ];
  const timestamps = [new Date("2026-07-11T12:00:00.000Z"), new Date("2026-07-11T12:01:00.000Z")];
  const kernel = new WorkFoldKernel({
    ...workFolderDependencies(workFolders),
    now: () => timestamps.shift() ?? new Date("2026-07-11T12:02:00.000Z"),
  });
  kernel.startTask({ id: "turn-alpha", kind: "assistant_turn", workFolderId: alphaId, actor: { kind: "assistant" } });
  kernel.startTask({ id: "compact-beta", kind: "compaction", workFolderId: betaId, actor: { kind: "assistant" } });
  const adapter = new WorkFoldCliKernelAdapter(kernel);

  const tasks = await adapter.listTasks(
    { kind: "cli", cwd: join(alphaRoot, "documents") },
    { workFolder: "beta" },
  );
  assert.deepEqual(tasks, [{
    id: "compact-beta",
    label: "Chat compaction",
    status: "running",
    workFolderId: betaId,
    updatedAt: "2026-07-11T12:01:00.000Z",
  }]);
});

test("WorkFoldCliKernelAdapter flattens every capability kind without exposing Skill contents", async () => {
  const root = join(process.cwd(), "cli-adapter-capabilities");
  const workFolderSummary = workFolder("space-5555555555555555", "Capabilities", root);
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
  const kernel = new WorkFoldKernel({
    ...workFolderDependencies([workFolderSummary]),
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
  const adapter = new WorkFoldCliKernelAdapter(kernel);

  const capabilities = await adapter.listCapabilities(
    { kind: "cli", cwd: join(process.cwd(), "outside-capability-work-folder") },
    { workFolder: "capabilities" },
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
  assert.equal(capabilities.find((item) => item.kind === "skill")?.scope, "work-folder");
  assert.equal(capabilities.find((item) => item.kind === "extension")?.scope, "everywhere");
  assert.equal(capabilities.find((item) => item.id.startsWith("theme:"))?.scope, "temporary");
  assert.equal(JSON.stringify(capabilities).includes("TOP SECRET SKILL CONTENT"), false);
  assert.equal(JSON.stringify(capabilities).includes("PRIVATE SURFACE CONTENT"), false);
  assert.equal(Object.hasOwn(capabilities.find((item) => item.kind === "skill") ?? {}, "content"), false);
});

test("WorkFoldCliKernelAdapter maps missing cwd capability context to notFound", async () => {
  const root = join(process.cwd(), "cli-adapter-context-required");
  const adapter = new WorkFoldCliKernelAdapter(new WorkFoldKernel(workFolderDependencies([
    workFolder("space-6666666666666666", "Only", root),
  ])));

  await assert.rejects(
    adapter.listCapabilities({ kind: "cli", cwd: join(process.cwd(), "outside-all-work-folders") }, {}),
    (error: unknown) => error instanceof WorkFoldCliError
      && error.code === "notFound"
      && error.exitCode === WorkFoldCliExitCode.notFound
      && /--work-folder/.test(error.message),
  );
});

test("WorkFoldCliKernelAdapter resolves Check status scope and projects only aggregate fields", async () => {
  const alphaRoot = join(process.cwd(), "cli-adapter-checks", "alpha");
  const betaRoot = join(process.cwd(), "cli-adapter-checks", "beta");
  const alphaId = "space-7777777777777777";
  const betaId = "space-8888888888888888";
  const workFolders = [
    workFolder(alphaId, "Alpha", alphaRoot),
    workFolder(betaId, "Beta", betaRoot),
  ];
  const calls: Array<{ workFolderId: string; workFolderRoot: string }> = [];
  const adapter = new WorkFoldCliKernelAdapter(new WorkFoldKernel(workFolderDependencies(workFolders)), {
    async checksStatusProvider(input) {
      calls.push(input);
      return {
        kind: "work-fold.checks.experimental",
        version: 1,
        workFolderId: input.workFolderId,
        state: "needs-attention",
        configured: 4,
        proposed: 1,
        enabled: 3,
        current: 1,
        neverRun: 1,
        stale: 1,
        blocked: 0,
        errors: 0,
        needsAttention: 2,
        running: 1,
        lastRunAt: "2026-08-01T12:00:00-04:00",
        title: "PRIVATE CHECK TITLE",
        path: "/private/work-folder/secret.txt",
        evidence: "PRIVATE QUOTE",
        decisions: ["accept"],
        sensorParameters: { prompt: "PRIVATE PROMPT" },
        errorText: "PRIVATE ERROR DETAIL",
      } as never;
    },
  });

  const result = await adapter.getChecksStatus(
    { kind: "cli", cwd: join(alphaRoot, "documents") },
    { workFolder: "beta" },
  );
  assert.deepEqual(calls, [{ workFolderId: betaId, workFolderRoot: betaRoot }]);
  assert.deepEqual(result, {
    kind: "work-fold.checks.experimental",
    version: 1,
    available: true,
    workFolderId: betaId,
    state: "needs-attention",
    configured: 4,
    proposed: 1,
    enabled: 3,
    current: 1,
    neverRun: 1,
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

test("WorkFoldCliKernelAdapter reports unavailable status when no safe aggregate provider exists", async () => {
  const root = join(process.cwd(), "cli-adapter-checks-unavailable");
  const workFolderSummary = workFolder("space-9999999999999999", "Only", root);
  const actor = { kind: "cli" as const, cwd: join(root, "documents") };
  const expected = {
    kind: "work-fold.checks.experimental" as const,
    version: 1 as const,
    available: false,
    workFolderId: workFolderSummary.id,
    state: "unavailable" as const,
    configured: 0,
    proposed: 0,
    enabled: 0,
    current: 0,
    neverRun: 0,
    stale: 0,
    blocked: 0,
    errors: 0,
    needsAttention: 0,
    running: 0,
    lastRunAt: null,
  };

  const withoutProvider = new WorkFoldCliKernelAdapter(new WorkFoldKernel(workFolderDependencies([workFolderSummary])));
  assert.deepEqual(await withoutProvider.getChecksStatus(actor, {}), expected);

  const failedProvider = new WorkFoldCliKernelAdapter(new WorkFoldKernel(workFolderDependencies([workFolderSummary])), {
    async checksStatusProvider() {
      throw new Error(`PRIVATE CHECK FAILURE at ${join(root, "secret.txt")}`);
    },
  });
  const failed = await failedProvider.getChecksStatus(actor, {});
  assert.deepEqual(failed, expected);
  assert.equal(JSON.stringify(failed).includes("PRIVATE CHECK FAILURE"), false);

  const invalidProvider = new WorkFoldCliKernelAdapter(new WorkFoldKernel(workFolderDependencies([workFolderSummary])), {
    async checksStatusProvider() {
      return {
        kind: "work-fold.checks.experimental",
        version: 1,
        workFolderId: workFolderSummary.id,
        state: "not-configured",
        configured: -1,
        proposed: 0,
        enabled: 0,
        current: 0,
        neverRun: 0,
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

  const inconsistentProvider = new WorkFoldCliKernelAdapter(new WorkFoldKernel(workFolderDependencies([workFolderSummary])), {
    async checksStatusProvider() {
      return {
        kind: "work-fold.checks.experimental",
        version: 1,
        workFolderId: workFolderSummary.id,
        state: "stale",
        configured: 1,
        proposed: 0,
        enabled: 1,
        current: 1,
        neverRun: 1,
        stale: 0,
        blocked: 0,
        errors: 0,
        needsAttention: 0,
        running: 0,
        lastRunAt: null,
      };
    },
  });
  assert.deepEqual(await inconsistentProvider.getChecksStatus(actor, {}), expected);
});

function workFolderDependencies(workFolders: WorkFolderSummary[]) {
  return {
    async listWorkFolders() { return workFolders; },
    async getWorkFolder(workFolderId: string) {
      const workFolderSummary = workFolders.find((item) => item.id === workFolderId);
      if (!workFolderSummary) throw new Error(`Unknown work-folder: ${workFolderId}`);
      return workFolderSummary;
    },
  };
}

function workFolder(id: string, name: string, workFolderRoot: string): WorkFolderSummary {
  return {
    id,
    name,
    workFolderRoot,
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
