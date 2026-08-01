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
import type { SpaceSummary } from "../src/local/space.js";

test("WorkFoldCliKernelAdapter resolves --space by exact id before case-insensitive name", async () => {
  const alphaRoot = join(process.cwd(), "cli-adapter", "alpha");
  const betaRoot = join(process.cwd(), "cli-adapter", "beta");
  const alphaId = "space-aaaaaaaaaaaaaaaa";
  const betaId = "space-bbbbbbbbbbbbbbbb";
  const spaces = [
    space(alphaId, "Primary", alphaRoot),
    space(betaId, alphaId.toUpperCase(), betaRoot),
  ];
  const adapter = new WorkFoldCliKernelAdapter(new WorkFoldKernel(spaceDependencies(spaces)));
  const actor = { kind: "cli" as const, cwd: join(betaRoot, "documents") };

  const byId = await adapter.getContext(actor, { space: ` ${alphaId} ` });
  assert.equal(byId.space?.id, alphaId, "an exact id must win over another Space's matching name");

  const byName = await adapter.getContext(actor, { space: "primary" });
  assert.equal(byName.space?.id, alphaId);

  const inferred = await adapter.listSpaces(actor, {});
  assert.deepEqual(inferred.map(({ id, active }) => ({ id, active })), [
    { id: alphaId, active: false },
    { id: betaId, active: true },
  ]);

  const selected = await adapter.listSpaces(actor, { space: "PRIMARY" });
  assert.deepEqual(selected.map(({ id, active }) => ({ id, active })), [{ id: alphaId, active: true }]);
});

test("WorkFoldCliKernelAdapter reports missing and ambiguous Space selectors as CLI errors", async () => {
  const root = join(process.cwd(), "cli-adapter-errors");
  const spaces = [
    space("space-1111111111111111", "Shared", join(root, "one")),
    space("space-2222222222222222", "SHARED", join(root, "two")),
  ];
  const adapter = new WorkFoldCliKernelAdapter(new WorkFoldKernel(spaceDependencies(spaces)));
  const actor = { kind: "cli" as const, cwd: root };

  await assert.rejects(
    adapter.getContext(actor, { space: "shared" }),
    (error: unknown) => error instanceof WorkFoldCliError
      && error.code === "conflict"
      && error.exitCode === WorkFoldCliExitCode.conflict
      && /ambiguous/i.test(error.message),
  );
  await assert.rejects(
    adapter.listTasks(actor, { space: "missing" }),
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
  const spaces = [
    space(alphaId, "Alpha", alphaRoot),
    space(betaId, "Beta", betaRoot),
  ];
  const timestamps = [new Date("2026-07-11T12:00:00.000Z"), new Date("2026-07-11T12:01:00.000Z")];
  const kernel = new WorkFoldKernel({
    ...spaceDependencies(spaces),
    now: () => timestamps.shift() ?? new Date("2026-07-11T12:02:00.000Z"),
  });
  kernel.startTask({ id: "turn-alpha", kind: "assistant_turn", spaceId: alphaId, actor: { kind: "assistant" } });
  kernel.startTask({ id: "compact-beta", kind: "compaction", spaceId: betaId, actor: { kind: "assistant" } });
  const adapter = new WorkFoldCliKernelAdapter(kernel);

  const tasks = await adapter.listTasks(
    { kind: "cli", cwd: join(alphaRoot, "documents") },
    { space: "beta" },
  );
  assert.deepEqual(tasks, [{
    id: "compact-beta",
    label: "Chat compaction",
    status: "running",
    spaceId: betaId,
    updatedAt: "2026-07-11T12:01:00.000Z",
  }]);
});

test("WorkFoldCliKernelAdapter flattens every capability kind without exposing Skill contents", async () => {
  const root = join(process.cwd(), "cli-adapter-capabilities");
  const spaceSummary = space("space-5555555555555555", "Capabilities", root);
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
    ...spaceDependencies([spaceSummary]),
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

test("WorkFoldCliKernelAdapter maps missing cwd capability context to notFound", async () => {
  const root = join(process.cwd(), "cli-adapter-context-required");
  const adapter = new WorkFoldCliKernelAdapter(new WorkFoldKernel(spaceDependencies([
    space("space-6666666666666666", "Only", root),
  ])));

  await assert.rejects(
    adapter.listCapabilities({ kind: "cli", cwd: join(process.cwd(), "outside-all-spaces") }, {}),
    (error: unknown) => error instanceof WorkFoldCliError
      && error.code === "notFound"
      && error.exitCode === WorkFoldCliExitCode.notFound
      && /--space/.test(error.message),
  );
});

test("WorkFoldCliKernelAdapter resolves Check status scope and projects only aggregate fields", async () => {
  const alphaRoot = join(process.cwd(), "cli-adapter-checks", "alpha");
  const betaRoot = join(process.cwd(), "cli-adapter-checks", "beta");
  const alphaId = "space-7777777777777777";
  const betaId = "space-8888888888888888";
  const spaces = [
    space(alphaId, "Alpha", alphaRoot),
    space(betaId, "Beta", betaRoot),
  ];
  const calls: Array<{ spaceId: string; spaceRoot: string }> = [];
  const adapter = new WorkFoldCliKernelAdapter(new WorkFoldKernel(spaceDependencies(spaces)), {
    async checksStatusProvider(input) {
      calls.push(input);
      return {
        kind: "work-fold.checks.experimental",
        version: 0,
        spaceId: input.spaceId,
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
  assert.deepEqual(calls, [{ spaceId: betaId, spaceRoot: betaRoot }]);
  assert.deepEqual(result, {
    kind: "work-fold.checks.experimental",
    version: 0,
    available: true,
    spaceId: betaId,
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
  const spaceSummary = space("space-9999999999999999", "Only", root);
  const actor = { kind: "cli" as const, cwd: join(root, "documents") };
  const expected = {
    kind: "work-fold.checks.experimental" as const,
    version: 0 as const,
    available: false,
    spaceId: spaceSummary.id,
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

  const withoutProvider = new WorkFoldCliKernelAdapter(new WorkFoldKernel(spaceDependencies([spaceSummary])));
  assert.deepEqual(await withoutProvider.getChecksStatus(actor, {}), expected);

  const failedProvider = new WorkFoldCliKernelAdapter(new WorkFoldKernel(spaceDependencies([spaceSummary])), {
    async checksStatusProvider() {
      throw new Error(`PRIVATE CHECK FAILURE at ${join(root, "secret.txt")}`);
    },
  });
  const failed = await failedProvider.getChecksStatus(actor, {});
  assert.deepEqual(failed, expected);
  assert.equal(JSON.stringify(failed).includes("PRIVATE CHECK FAILURE"), false);

  const invalidProvider = new WorkFoldCliKernelAdapter(new WorkFoldKernel(spaceDependencies([spaceSummary])), {
    async checksStatusProvider() {
      return {
        kind: "work-fold.checks.experimental",
        version: 0,
        spaceId: spaceSummary.id,
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

  const inconsistentProvider = new WorkFoldCliKernelAdapter(new WorkFoldKernel(spaceDependencies([spaceSummary])), {
    async checksStatusProvider() {
      return {
        kind: "work-fold.checks.experimental",
        version: 0,
        spaceId: spaceSummary.id,
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

function spaceDependencies(spaces: SpaceSummary[]) {
  return {
    async listSpaces() { return spaces; },
    async getSpace(spaceId: string) {
      const spaceSummary = spaces.find((item) => item.id === spaceId);
      if (!spaceSummary) throw new Error(`Unknown Space: ${spaceId}`);
      return spaceSummary;
    },
  };
}

function space(id: string, name: string, spaceRoot: string): SpaceSummary {
  return {
    id,
    name,
    spaceRoot,
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
