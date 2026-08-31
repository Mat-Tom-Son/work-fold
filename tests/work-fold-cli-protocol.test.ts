import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import {
  WORKFOLD_CLI_ACT_STAGED_COMMAND_NAMES,
  WORKFOLD_CLI_PROTOCOL_VERSION,
  WorkFoldCliError,
  WorkFoldCliExitCode,
  createWorkFoldCliRequest,
  createWorkFoldCliResponse,
  executeWorkFoldCliRequest,
  parseWorkFoldCliArgv,
  parseWorkFoldCliRequest,
  parseWorkFoldCliResponse,
  workFoldCliHelp,
  type WorkFoldCliActor,
  type WorkFoldCliKernel,
} from "../src/local/cli/index.js";

test("CLI request and response schemas preserve the locked protocol fields", () => {
  const id = randomUUID();
  const cwd = resolve(".");
  const request = createWorkFoldCliRequest({ id, argv: ["spaces", "list", "--json"], cwd, createdAt: "2026-07-11T12:00:00.000Z" });
  assert.deepEqual(request, {
    protocolVersion: 1,
    id,
    argv: ["spaces", "list", "--json"],
    cwd,
    createdAt: "2026-07-11T12:00:00.000Z",
  });

  const response = createWorkFoldCliResponse({ id, exitCode: 0, stdout: "ok\n", stderr: "" });
  assert.deepEqual(response, { protocolVersion: 1, id, exitCode: 0, stdout: "ok\n", stderr: "" });
  assert.deepEqual(parseWorkFoldCliResponse(JSON.parse(JSON.stringify(response))), response);
});

test("CLI protocol rejects unknown fields, bad versions, invalid ids, relative cwd, and invalid output", () => {
  const base = {
    protocolVersion: WORKFOLD_CLI_PROTOCOL_VERSION,
    id: randomUUID(),
    argv: [],
    cwd: resolve("."),
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => parseWorkFoldCliRequest({ ...base, extra: true }), /unsupported field/);
  assert.throws(() => parseWorkFoldCliRequest({ ...base, protocolVersion: 2 }), /Unsupported CLI protocol version/);
  assert.throws(() => parseWorkFoldCliRequest({ ...base, id: "..\\escape" }), /UUID/);
  assert.throws(() => parseWorkFoldCliRequest({ ...base, cwd: "relative" }), /absolute path/);
  assert.throws(() => parseWorkFoldCliResponse({ protocolVersion: 1, id: base.id, exitCode: 99, stdout: "", stderr: "" }), /exitCode/);
  assert.throws(() => parseWorkFoldCliResponse({ protocolVersion: 1, id: base.id, exitCode: 0, stdout: "", stderr: "", result: { invalid: undefined } }), /JSON-serializable/);
});

test("CLI argv parser supports every foundation command with global flags in either position", () => {
  assert.deepEqual(parseWorkFoldCliArgv([]), { name: "help", output: "human" });
  assert.deepEqual(parseWorkFoldCliArgv(["--json", "context", "--space", "Personal"]), {
    name: "context",
    output: "json",
    space: "Personal",
  });
  assert.deepEqual(parseWorkFoldCliArgv(["spaces", "list", "--space=space-1234567890abcdef", "--json"]), {
    name: "spaces.list",
    output: "json",
    space: "space-1234567890abcdef",
  });
  assert.deepEqual(parseWorkFoldCliArgv(["tasks", "list"]), { name: "tasks.list", output: "human" });
  assert.deepEqual(parseWorkFoldCliArgv(["capabilities", "list", "--space", "space-aaaaaaaaaaaaaaaa"]), {
    name: "capabilities.list",
    output: "human",
    space: "space-aaaaaaaaaaaaaaaa",
  });
  assert.deepEqual(parseWorkFoldCliArgv(["checks", "status", "--space", "space-aaaaaaaaaaaaaaaa", "--json"]), {
    name: "checks.status",
    output: "json",
    space: "space-aaaaaaaaaaaaaaaa",
  });
  assert.deepEqual(parseWorkFoldCliArgv(["version", "--json"]), { name: "version", output: "json" });
  assert.deepEqual(parseWorkFoldCliArgv(["--version", "--json"]), { name: "version", output: "json" });
  assert.deepEqual(parseWorkFoldCliArgv(["help", "tasks", "--json"]), { name: "help", output: "json", topic: "tasks" });
  assert.deepEqual(parseWorkFoldCliArgv(["spaces", "--help"]), { name: "help", output: "human", topic: "spaces" });
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
      () => parseWorkFoldCliArgv(argv),
      (error) => error instanceof WorkFoldCliError && error.exitCode === WorkFoldCliExitCode.usage && /work-fold help/.test(error.message),
      argv.join(" "),
    );
  }
});

test("CLI help covers every landed act family and is honest about staging", () => {
  // The spelled verb inventory of docs/fold-act-ledger.md plus the sibling
  // routings/pages plans, as the act argv parser accepts them. Growing the
  // act table without growing help fails here on purpose.
  const families: Record<string, string[]> = {
    chat: ["create", "send", "status", "result", "wait", "abort", "rename", "snooze", "archive", "resume", "compact"],
    chats: ["list"],
    manage: ["send", "status", "result", "wait", "stop", "abort", "list", "glance"],
    checks: ["status", "enable", "disable", "run", "task", "result", "wait", "abort", "problems", "decide"],
    history: ["list", "save", "restore", "versions", "restore-file"],
    search: [""],
    files: ["add", "move", "rename", "delete", "mkdir", "create", "destroy"],
    library: ["list", "add", "folder create", "copy"],
    spaces: ["list", "create", "register", "rename", "unregister", "delete", "appearance apply", "appearance reset", "appearance undo"],
    tools: ["import-skill", "install", "update", "remove"],
    apps: [
      "proposals list", "proposals dismiss", "install-proposal", "install-preview", "remove",
      "grant", "revoke", "connect", "disconnect", "automation enable", "automation disable",
      "automation run", "storage clear", "retained purge", "project declare", "release prepare",
      "release publish", "release delete", "install prepare", "update prepare",
      "operation activate", "operation cancel", "uninstall",
    ],
    routings: ["stage", "list", "show", "run", "stop", "disable", "delete", "receipts"],
    pages: ["stage", "list", "status", "revoke", "narrow", "snapshot-off"],
    staged: ["list", "show", "cancel"],
  };
  const overview = workFoldCliHelp("work-fold");
  for (const [family, verbs] of Object.entries(families)) {
    const topic = workFoldCliHelp("work-fold", family);
    assert.notEqual(topic, overview, `'${family}' needs a dedicated help topic`);
    assert.match(overview, new RegExp(`\\b${family}\\b`), `the overview must list ${family}`);
    for (const verb of verbs) {
      const spelled = verb ? `${family} ${verb}` : family;
      assert.ok(topic.includes(`work-fold ${spelled} `), `help ${family} must show usage for '${spelled}'`);
    }
  }
  // Every consecrated row's family topic must say the act stages a decision
  // instead of executing; apps.uninstall is consecrated via --purge-data.
  for (const stagedName of WORKFOLD_CLI_ACT_STAGED_COMMAND_NAMES) {
    const family = stagedName.split(".")[0]!;
    assert.match(workFoldCliHelp("work-fold", family), /decision/, `help ${family} must explain staging for ${stagedName}`);
  }
  assert.match(workFoldCliHelp("work-fold", "apps"), /--purge-data/);
  // The setup-only boundary stays visible where an agent looks first.
  assert.match(overview, /local setup/);
  assert.match(overview, /Unrestricted lets the desktop host decide/);
});

test("CLI executor passes actor cwd and Space scope through the narrow kernel", async () => {
  const calls: Array<{ method: string; actor: WorkFoldCliActor; space?: string }> = [];
  const kernel = fixtureKernel(calls);
  const cwd = resolve("test-space");
  const commands = [
    ["context", "--space", "space-aaaaaaaaaaaaaaaa"],
    ["spaces", "list", "--space", "space-aaaaaaaaaaaaaaaa"],
    ["tasks", "list", "--space", "space-aaaaaaaaaaaaaaaa"],
    ["capabilities", "list", "--space", "space-aaaaaaaaaaaaaaaa"],
    ["checks", "status", "--space", "space-aaaaaaaaaaaaaaaa"],
  ];
  for (const argv of commands) {
    const response = await executeWorkFoldCliRequest(
      createWorkFoldCliRequest({ id: randomUUID(), argv, cwd }),
      kernel,
      { version: "1.2.3", now: () => new Date("2026-07-11T12:00:00.000Z") },
    );
    assert.equal(response.exitCode, WorkFoldCliExitCode.success);
    assert.equal(response.stderr, "");
    assert.equal(response.completedAt, "2026-07-11T12:00:00.000Z");
  }
  assert.deepEqual(calls.map(({ method, actor, space }) => ({ method, actor, space })), [
    { method: "context", actor: { kind: "cli", cwd }, space: "space-aaaaaaaaaaaaaaaa" },
    { method: "spaces", actor: { kind: "cli", cwd }, space: "space-aaaaaaaaaaaaaaaa" },
    { method: "tasks", actor: { kind: "cli", cwd }, space: "space-aaaaaaaaaaaaaaaa" },
    { method: "capabilities", actor: { kind: "cli", cwd }, space: "space-aaaaaaaaaaaaaaaa" },
    { method: "checks", actor: { kind: "cli", cwd }, space: "space-aaaaaaaaaaaaaaaa" },
  ]);
});

test("CLI Checks status emits aggregate-only JSON and human output", async () => {
  const kernel = fixtureKernel([]);
  const cwd = resolve("test-space");
  const json = await executeWorkFoldCliRequest(
    createWorkFoldCliRequest({ id: randomUUID(), argv: ["checks", "status", "--space", "space-aaaaaaaaaaaaaaaa", "--json"], cwd }),
    kernel,
    { version: "1.2.3" },
  );
  assert.equal(json.exitCode, 0);
  assert.deepEqual(JSON.parse(json.stdout), {
    ok: true,
    command: "checks.status",
    data: {
      kind: "work-fold.checks.experimental",
      version: 0,
      available: true,
      spaceId: "space-aaaaaaaaaaaaaaaa",
      state: "needs-attention",
      configured: 3,
      proposed: 1,
      enabled: 2,
      current: 1,
      neverRun: 1,
      stale: 0,
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

  const human = await executeWorkFoldCliRequest(
    createWorkFoldCliRequest({ id: randomUUID(), argv: ["checks", "status", "--space", "space-aaaaaaaaaaaaaaaa"], cwd }),
    kernel,
    { version: "1.2.3" },
  );
  assert.match(human.stdout, /^Checks: needs attention/m);
  assert.match(human.stdout, /Configured: 3 \(2 enabled, 1 proposed\)/);
  assert.match(human.stdout, /Never run: 1/);
  assert.match(human.stdout, /Stale: 0/);
  assert.match(human.stdout, /Needs attention: 2/);
  assert.doesNotMatch(human.stdout, /title|path|evidence|decision|sensor|parameter|error text/i);
});

test("CLI executor emits useful human output and a stable JSON envelope", async () => {
  const kernel = fixtureKernel([]);
  const cwd = resolve(".");
  const human = await executeWorkFoldCliRequest(
    createWorkFoldCliRequest({ id: randomUUID(), argv: ["spaces", "list"], cwd }),
    kernel,
    { version: "1.2.3" },
  );
  assert.equal(human.exitCode, 0);
  assert.match(human.stdout, /Personal \[space-aaaaaaaaaaaaaaaa\].*test-space/);
  assert.equal(human.stderr, "");

  const json = await executeWorkFoldCliRequest(
    createWorkFoldCliRequest({ id: randomUUID(), argv: ["capabilities", "list", "--json"], cwd }),
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
  const kernel: WorkFoldCliKernel = {
    async getContext() {
      return { cwd: hostile, space: { id: hostile, name: hostile, spaceRoot: hostile }, selectedPath: hostile, activeSurface: hostile };
    },
    async listSpaces() {
      return [{ id: hostile, name: hostile, spaceRoot: hostile }];
    },
    async listTasks() {
      return [{ id: hostile, label: hostile, status: hostile, spaceId: hostile }];
    },
    async listCapabilities() {
      return [{ id: hostile, name: hostile, kind: "other", scope: hostile, status: hostile, source: hostile }];
    },
    async getChecksStatus() {
      return {
        kind: "work-fold.checks.experimental", version: 0, available: true, spaceId: hostile,
        state: "current-clear", configured: 1, proposed: 0, enabled: 1, current: 1, neverRun: 0,
        stale: 0, blocked: 0, errors: 0, needsAttention: 0, running: 0, lastRunAt: null,
      };
    },
  };
  const cwd = resolve(".");
  for (const argv of [["context"], ["spaces", "list"], ["tasks", "list"], ["capabilities", "list"], ["checks", "status"]]) {
    const response = await executeWorkFoldCliRequest(createWorkFoldCliRequest({ id: randomUUID(), argv, cwd }), kernel, { version: "1.2.3" });
    assert.equal(response.exitCode, 0);
    assert.doesNotMatch(response.stdout, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  }

  const failingKernel: WorkFoldCliKernel = {
    ...kernel,
    async getContext() { throw new Error(hostile); },
  };
  const failure = await executeWorkFoldCliRequest(
    createWorkFoldCliRequest({ id: randomUUID(), argv: ["context"], cwd }),
    failingKernel,
    { version: "1.2.3" },
  );
  assert.doesNotMatch(failure.stderr, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
});

test("CLI help/version avoid kernel work and kernel failures map to stable exit codes", async () => {
  let called = false;
  const kernel: WorkFoldCliKernel = {
    async getContext() { called = true; throw new WorkFoldCliError("permissionDenied", "Not allowed."); },
    async listSpaces() { called = true; return []; },
    async listTasks() { called = true; return []; },
    async listCapabilities() { called = true; return []; },
    async getChecksStatus() { called = true; throw new WorkFoldCliError("permissionDenied", "Not allowed."); },
  };
  const cwd = resolve(".");
  const version = await executeWorkFoldCliRequest(createWorkFoldCliRequest({ id: randomUUID(), argv: ["--version"], cwd }), kernel, { version: "1.2.3" });
  assert.equal(version.stdout, "work-fold 1.2.3\n");
  const help = await executeWorkFoldCliRequest(createWorkFoldCliRequest({ id: randomUUID(), argv: ["help", "context"], cwd }), kernel, { version: "1.2.3" });
  assert.equal(help.stdout, workFoldCliHelp("work-fold", "context"));
  assert.equal(called, false);

  const usage = await executeWorkFoldCliRequest(createWorkFoldCliRequest({ id: randomUUID(), argv: ["unknown"], cwd }), kernel, { version: "1.2.3" });
  assert.equal(usage.stderr, "Unknown command: unknown\nRun 'work-fold help' for usage.\n");

  const denied = await executeWorkFoldCliRequest(createWorkFoldCliRequest({ id: randomUUID(), argv: ["context", "--json"], cwd }), kernel, { version: "1.2.3" });
  assert.equal(denied.exitCode, WorkFoldCliExitCode.permissionDenied);
  assert.equal(JSON.parse(denied.stderr).error.code, "permissionDenied");
});

function fixtureKernel(calls: Array<{ method: string; actor: WorkFoldCliActor; space?: string }>): WorkFoldCliKernel {
  return {
    async getContext(actor, options) {
      calls.push({ method: "context", actor, space: options.space });
      return { cwd: actor.cwd, space: { id: "space-aaaaaaaaaaaaaaaa", name: "Personal", spaceRoot: resolve("test-space"), active: true }, selectedPath: "notes.md", activeSurface: "Files" };
    },
    async listSpaces(actor, options) {
      calls.push({ method: "spaces", actor, space: options.space });
      return [{ id: "space-aaaaaaaaaaaaaaaa", name: "Personal", spaceRoot: resolve("test-space"), active: true }];
    },
    async listTasks(actor, options) {
      calls.push({ method: "tasks", actor, space: options.space });
      return [{ id: "task-a", label: "Index files", status: "running", spaceId: "space-aaaaaaaaaaaaaaaa", updatedAt: "2026-07-11T12:00:00.000Z" }];
    },
    async listCapabilities(actor, options) {
      calls.push({ method: "capabilities", actor, space: options.space });
      return [{ id: "skill-a", name: "Example Skill", kind: "skill", scope: "space", status: "loaded", source: ".pi/skills/example" }];
    },
    async getChecksStatus(actor, options) {
      calls.push({ method: "checks", actor, space: options.space });
      return {
        kind: "work-fold.checks.experimental",
        version: 0,
        available: true,
        spaceId: "space-aaaaaaaaaaaaaaaa",
        state: "needs-attention",
        configured: 3,
        proposed: 1,
        enabled: 2,
        current: 1,
        neverRun: 1,
        stale: 0,
        blocked: 0,
        errors: 0,
        needsAttention: 2,
        running: 0,
        lastRunAt: "2026-08-01T12:00:00.000Z",
      };
    },
  };
}
