import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import {
  WORKSPACE_CLI_PROTOCOL_VERSION,
  WorkspaceCliError,
  WorkspaceCliExitCode,
  createWorkspaceCliRequest,
  createWorkspaceCliResponse,
  executeWorkspaceCliRequest,
  parseWorkspaceCliArgv,
  parseWorkspaceCliRequest,
  parseWorkspaceCliResponse,
  workspaceCliHelp,
  type WorkspaceCliActor,
  type WorkspaceCliKernel,
} from "../src/local/cli/index.js";

test("CLI request and response schemas preserve the locked protocol fields", () => {
  const id = randomUUID();
  const cwd = resolve(".");
  const request = createWorkspaceCliRequest({ id, argv: ["spaces", "list", "--json"], cwd, createdAt: "2026-07-11T12:00:00.000Z" });
  assert.deepEqual(request, {
    protocolVersion: 1,
    id,
    argv: ["spaces", "list", "--json"],
    cwd,
    createdAt: "2026-07-11T12:00:00.000Z",
  });

  const response = createWorkspaceCliResponse({ id, exitCode: 0, stdout: "ok\n", stderr: "" });
  assert.deepEqual(response, { protocolVersion: 1, id, exitCode: 0, stdout: "ok\n", stderr: "" });
  assert.deepEqual(parseWorkspaceCliResponse(JSON.parse(JSON.stringify(response))), response);
});

test("CLI protocol rejects unknown fields, bad versions, invalid ids, relative cwd, and invalid output", () => {
  const base = {
    protocolVersion: WORKSPACE_CLI_PROTOCOL_VERSION,
    id: randomUUID(),
    argv: [],
    cwd: resolve("."),
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => parseWorkspaceCliRequest({ ...base, extra: true }), /unsupported field/);
  assert.throws(() => parseWorkspaceCliRequest({ ...base, protocolVersion: 2 }), /Unsupported CLI protocol version/);
  assert.throws(() => parseWorkspaceCliRequest({ ...base, id: "..\\escape" }), /UUID/);
  assert.throws(() => parseWorkspaceCliRequest({ ...base, cwd: "relative" }), /absolute path/);
  assert.throws(() => parseWorkspaceCliResponse({ protocolVersion: 1, id: base.id, exitCode: 99, stdout: "", stderr: "" }), /exitCode/);
  assert.throws(() => parseWorkspaceCliResponse({ protocolVersion: 1, id: base.id, exitCode: 0, stdout: "", stderr: "", result: { invalid: undefined } }), /JSON-serializable/);
});

test("CLI argv parser supports every foundation command with global flags in either position", () => {
  assert.deepEqual(parseWorkspaceCliArgv([]), { name: "help", output: "human" });
  assert.deepEqual(parseWorkspaceCliArgv(["--json", "context", "--space", "Personal"]), {
    name: "context",
    output: "json",
    space: "Personal",
  });
  assert.deepEqual(parseWorkspaceCliArgv(["spaces", "list", "--space=ws-123", "--json"]), {
    name: "spaces.list",
    output: "json",
    space: "ws-123",
  });
  assert.deepEqual(parseWorkspaceCliArgv(["tasks", "list"]), { name: "tasks.list", output: "human" });
  assert.deepEqual(parseWorkspaceCliArgv(["capabilities", "list", "--space", "ws-a"]), {
    name: "capabilities.list",
    output: "human",
    space: "ws-a",
  });
  assert.deepEqual(parseWorkspaceCliArgv(["checks", "status", "--space", "ws-a", "--json"]), {
    name: "checks.status",
    output: "json",
    space: "ws-a",
  });
  assert.deepEqual(parseWorkspaceCliArgv(["version", "--json"]), { name: "version", output: "json" });
  assert.deepEqual(parseWorkspaceCliArgv(["--version", "--json"]), { name: "version", output: "json" });
  assert.deepEqual(parseWorkspaceCliArgv(["help", "tasks", "--json"]), { name: "help", output: "json", topic: "tasks" });
  assert.deepEqual(parseWorkspaceCliArgv(["spaces", "--help"]), { name: "help", output: "human", topic: "spaces" });
});

test("CLI argv parser produces stable usage errors", () => {
  for (const argv of [
    ["unknown"],
    ["spaces"],
    ["spaces", "list", "extra"],
    ["--wat"],
    ["context", "--space"],
    ["context", "--space", "one", "--space", "two"],
    ["version", "--space", "one"],
  ]) {
    assert.throws(
      () => parseWorkspaceCliArgv(argv),
      (error) => error instanceof WorkspaceCliError && error.exitCode === WorkspaceCliExitCode.usage && /workspace help/.test(error.message),
      argv.join(" "),
    );
  }
});

test("CLI executor passes actor cwd and Space scope through the narrow kernel", async () => {
  const calls: Array<{ method: string; actor: WorkspaceCliActor; space?: string }> = [];
  const kernel = fixtureKernel(calls);
  const cwd = resolve("test-space");
  const commands = [
    ["context", "--space", "ws-a"],
    ["spaces", "list", "--space", "ws-a"],
    ["tasks", "list", "--space", "ws-a"],
    ["capabilities", "list", "--space", "ws-a"],
    ["checks", "status", "--space", "ws-a"],
  ];
  for (const argv of commands) {
    const response = await executeWorkspaceCliRequest(
      createWorkspaceCliRequest({ id: randomUUID(), argv, cwd }),
      kernel,
      { version: "1.2.3", now: () => new Date("2026-07-11T12:00:00.000Z") },
    );
    assert.equal(response.exitCode, WorkspaceCliExitCode.success);
    assert.equal(response.stderr, "");
    assert.equal(response.completedAt, "2026-07-11T12:00:00.000Z");
  }
  assert.deepEqual(calls.map(({ method, actor, space }) => ({ method, actor, space })), [
    { method: "context", actor: { kind: "cli", cwd }, space: "ws-a" },
    { method: "spaces", actor: { kind: "cli", cwd }, space: "ws-a" },
    { method: "tasks", actor: { kind: "cli", cwd }, space: "ws-a" },
    { method: "capabilities", actor: { kind: "cli", cwd }, space: "ws-a" },
    { method: "checks", actor: { kind: "cli", cwd }, space: "ws-a" },
  ]);
});

test("CLI Checks status emits aggregate-only JSON and human output", async () => {
  const kernel = fixtureKernel([]);
  const cwd = resolve("test-space");
  const json = await executeWorkspaceCliRequest(
    createWorkspaceCliRequest({ id: randomUUID(), argv: ["checks", "status", "--space", "ws-a", "--json"], cwd }),
    kernel,
    { version: "1.2.3" },
  );
  assert.equal(json.exitCode, 0);
  assert.deepEqual(JSON.parse(json.stdout), {
    ok: true,
    command: "checks.status",
    data: {
      kind: "workspace.checks.experimental",
      version: 0,
      available: true,
      workspaceId: "ws-a",
      state: "needs-attention",
      configured: 3,
      proposed: 1,
      enabled: 2,
      current: 1,
      stale: 1,
      blocked: 0,
      errors: 0,
      needsAttention: 2,
      running: 0,
      lastRunAt: "2026-08-01T12:00:00.000Z",
    },
  });
  const serialized = JSON.stringify(JSON.parse(json.stdout));
  for (const forbidden of ["title", "path", "evidence", "decision", "sensor", "parameter", "errorText"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const human = await executeWorkspaceCliRequest(
    createWorkspaceCliRequest({ id: randomUUID(), argv: ["checks", "status", "--space", "ws-a"], cwd }),
    kernel,
    { version: "1.2.3" },
  );
  assert.match(human.stdout, /^Checks: needs attention/m);
  assert.match(human.stdout, /Configured: 3 \(2 enabled, 1 proposed\)/);
  assert.match(human.stdout, /Needs attention: 2/);
  assert.doesNotMatch(human.stdout, /title|path|evidence|decision|sensor|parameter|error text/i);
});

test("CLI executor emits useful human output and a stable JSON envelope", async () => {
  const kernel = fixtureKernel([]);
  const cwd = resolve(".");
  const human = await executeWorkspaceCliRequest(
    createWorkspaceCliRequest({ id: randomUUID(), argv: ["spaces", "list"], cwd }),
    kernel,
    { version: "1.2.3" },
  );
  assert.equal(human.exitCode, 0);
  assert.match(human.stdout, /Personal \[ws-a\].*test-space/);
  assert.equal(human.stderr, "");

  const json = await executeWorkspaceCliRequest(
    createWorkspaceCliRequest({ id: randomUUID(), argv: ["capabilities", "list", "--json"], cwd }),
    kernel,
    { version: "1.2.3" },
  );
  assert.deepEqual(JSON.parse(json.stdout), {
    ok: true,
    command: "capabilities.list",
    data: {
      capabilities: [{ id: "skill-a", name: "Example Skill", kind: "skill", scope: "space", status: "loaded", source: ".pi/skills/example" }],
      total: 1,
    },
  });
  assert.deepEqual(json.result, JSON.parse(json.stdout).data);
});

test("CLI human output neutralizes terminal control sequences from host metadata and errors", async () => {
  const hostile = "before\u001b]8;;https://example.invalid\u0007click\u001b]8;;\u0007\u009b31m\u202eafter";
  const kernel: WorkspaceCliKernel = {
    async getContext() {
      return { cwd: hostile, space: { id: hostile, name: hostile, rootPath: hostile }, selectedPath: hostile, activeSurface: hostile };
    },
    async listSpaces() {
      return [{ id: hostile, name: hostile, rootPath: hostile }];
    },
    async listTasks() {
      return [{ id: hostile, label: hostile, status: hostile, workspaceId: hostile }];
    },
    async listCapabilities() {
      return [{ id: hostile, name: hostile, kind: "other", scope: hostile, status: hostile, source: hostile }];
    },
    async getChecksStatus() {
      return {
        kind: "workspace.checks.experimental", version: 0, available: true, workspaceId: hostile,
        state: "current-clear", configured: 1, proposed: 0, enabled: 1, current: 1,
        stale: 0, blocked: 0, errors: 0, needsAttention: 0, running: 0, lastRunAt: null,
      };
    },
  };
  const cwd = resolve(".");
  for (const argv of [["context"], ["spaces", "list"], ["tasks", "list"], ["capabilities", "list"], ["checks", "status"]]) {
    const response = await executeWorkspaceCliRequest(createWorkspaceCliRequest({ id: randomUUID(), argv, cwd }), kernel, { version: "1.2.3" });
    assert.equal(response.exitCode, 0);
    assert.doesNotMatch(response.stdout, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  }

  const failingKernel: WorkspaceCliKernel = {
    ...kernel,
    async getContext() { throw new Error(hostile); },
  };
  const failure = await executeWorkspaceCliRequest(
    createWorkspaceCliRequest({ id: randomUUID(), argv: ["context"], cwd }),
    failingKernel,
    { version: "1.2.3" },
  );
  assert.doesNotMatch(failure.stderr, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
});

test("CLI help/version avoid kernel work and kernel failures map to stable exit codes", async () => {
  let called = false;
  const kernel: WorkspaceCliKernel = {
    async getContext() { called = true; throw new WorkspaceCliError("permissionDenied", "Not allowed."); },
    async listSpaces() { called = true; return []; },
    async listTasks() { called = true; return []; },
    async listCapabilities() { called = true; return []; },
    async getChecksStatus() { called = true; throw new WorkspaceCliError("permissionDenied", "Not allowed."); },
  };
  const cwd = resolve(".");
  const version = await executeWorkspaceCliRequest(createWorkspaceCliRequest({ id: randomUUID(), argv: ["--version"], cwd }), kernel, { version: "1.2.3" });
  assert.equal(version.stdout, "Workspace 1.2.3\n");
  const help = await executeWorkspaceCliRequest(createWorkspaceCliRequest({ id: randomUUID(), argv: ["help", "context"], cwd }), kernel, { version: "1.2.3" });
  assert.equal(help.stdout, workspaceCliHelp("Workspace", "context"));
  assert.equal(called, false);

  const usage = await executeWorkspaceCliRequest(createWorkspaceCliRequest({ id: randomUUID(), argv: ["unknown"], cwd }), kernel, { version: "1.2.3" });
  assert.equal(usage.stderr, "Unknown command: unknown\nRun 'workspace help' for usage.\n");

  const denied = await executeWorkspaceCliRequest(createWorkspaceCliRequest({ id: randomUUID(), argv: ["context", "--json"], cwd }), kernel, { version: "1.2.3" });
  assert.equal(denied.exitCode, WorkspaceCliExitCode.permissionDenied);
  assert.equal(JSON.parse(denied.stderr).error.code, "permissionDenied");
});

function fixtureKernel(calls: Array<{ method: string; actor: WorkspaceCliActor; space?: string }>): WorkspaceCliKernel {
  return {
    async getContext(actor, options) {
      calls.push({ method: "context", actor, space: options.space });
      return { cwd: actor.cwd, space: { id: "ws-a", name: "Personal", rootPath: resolve("test-space"), active: true }, selectedPath: "notes.md", activeSurface: "Files" };
    },
    async listSpaces(actor, options) {
      calls.push({ method: "spaces", actor, space: options.space });
      return [{ id: "ws-a", name: "Personal", rootPath: resolve("test-space"), active: true }];
    },
    async listTasks(actor, options) {
      calls.push({ method: "tasks", actor, space: options.space });
      return [{ id: "task-a", label: "Index files", status: "running", workspaceId: "ws-a", updatedAt: "2026-07-11T12:00:00.000Z" }];
    },
    async listCapabilities(actor, options) {
      calls.push({ method: "capabilities", actor, space: options.space });
      return [{ id: "skill-a", name: "Example Skill", kind: "skill", scope: "space", status: "loaded", source: ".pi/skills/example" }];
    },
    async getChecksStatus(actor, options) {
      calls.push({ method: "checks", actor, space: options.space });
      return {
        kind: "workspace.checks.experimental",
        version: 0,
        available: true,
        workspaceId: "ws-a",
        state: "needs-attention",
        configured: 3,
        proposed: 1,
        enabled: 2,
        current: 1,
        stale: 1,
        blocked: 0,
        errors: 0,
        needsAttention: 2,
        running: 0,
        lastRunAt: "2026-08-01T12:00:00.000Z",
      };
    },
  };
}
