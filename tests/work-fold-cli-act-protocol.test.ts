import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  WORKFOLD_CLI_ACT_MAX_PAYLOAD_BYTES,
  WORKFOLD_CLI_ACT_PROTOCOL_VERSION,
  WorkFoldCliError,
  createWorkFoldCliActRequest,
  executeWorkFoldCliActRequest,
  isWorkFoldCliActRequest,
  parseWorkFoldCliActArgv,
  parseWorkFoldCliActRequest,
  parseWorkFoldCliRequestEnvelope,
  type WorkFoldActFacade,
} from "../src/local/cli/index.js";

const cwd = resolve(tmpdir());
const token = "a".repeat(64);
const createdAt = new Date().toISOString();

test("act request parsing enforces exact keys, token shape, and payload bounds", () => {
  const id = randomUUID();
  const parsed = parseWorkFoldCliActRequest({
    protocolVersion: 3,
    lane: "act",
    id,
    argv: ["chat", "status", "--space", "space-1"],
    cwd,
    createdAt,
    actToken: token,
    payload: { messageFile: "hello" },
  });
  assert.equal(parsed.protocolVersion, WORKFOLD_CLI_ACT_PROTOCOL_VERSION);
  assert.equal(parsed.id, id);
  assert.equal(parsed.payload?.messageFile, "hello");

  const base = { protocolVersion: 3, lane: "act", id: randomUUID(), argv: [], cwd, createdAt, actToken: token };
  assert.throws(() => parseWorkFoldCliActRequest({ ...base, extra: true }), /unsupported field: extra/);
  assert.throws(() => parseWorkFoldCliActRequest({ ...base, lane: "read" }), /lane/);
  assert.throws(() => parseWorkFoldCliActRequest({ ...base, actToken: "short" }), /token is malformed/);
  assert.throws(() => parseWorkFoldCliActRequest({ ...base, actToken: `${token}!` }), /token is malformed/);
  assert.throws(() => parseWorkFoldCliActRequest({ ...base, cwd: "relative/path" }), /absolute path/);
  assert.throws(() => parseWorkFoldCliActRequest({ ...base, createdAt: "not-a-date" }), /ISO timestamp/);
  assert.throws(() => parseWorkFoldCliActRequest({ ...base, payload: { other: 1 } }), /unsupported field: other/);
  assert.throws(
    () => parseWorkFoldCliActRequest({ ...base, payload: { messageFile: 42 } }),
    /messageFile must be text/,
  );

  const boundary = "y".repeat(WORKFOLD_CLI_ACT_MAX_PAYLOAD_BYTES);
  assert.equal(
    parseWorkFoldCliActRequest({ ...base, id: randomUUID(), payload: { messageFile: boundary } }).payload?.messageFile,
    boundary,
  );
  assert.throws(
    () => parseWorkFoldCliActRequest({ ...base, payload: { messageFile: `${boundary}z` } }),
    /exceeds/,
  );
});

test("the request envelope dispatches versions to their lanes", () => {
  const v1 = parseWorkFoldCliRequestEnvelope({
    protocolVersion: 1,
    id: randomUUID(),
    argv: ["context"],
    cwd,
    createdAt,
  });
  assert.equal(v1.protocolVersion, 1);
  assert.equal(isWorkFoldCliActRequest(v1), false);

  const act = parseWorkFoldCliRequestEnvelope({
    protocolVersion: 3,
    lane: "act",
    id: randomUUID(),
    argv: ["chat", "create", "--space", "space-1"],
    cwd,
    createdAt,
    actToken: token,
  });
  assert.equal(isWorkFoldCliActRequest(act), true);

  assert.throws(
    () => parseWorkFoldCliRequestEnvelope({ protocolVersion: 4, id: randomUUID(), argv: [], cwd, createdAt }),
    /Unsupported CLI protocol version/,
  );
});

test("createWorkFoldCliActRequest validates and normalizes like the parser", () => {
  const id = randomUUID();
  const request = createWorkFoldCliActRequest({
    id: id.toUpperCase(),
    argv: ["spaces", "create", "--name", "Home"],
    cwd: join(cwd, "."),
    actToken: token,
  });
  assert.equal(request.id, id.toLowerCase());
  assert.equal(request.cwd, cwd);
  assert.equal(request.lane, "act");
});

test("act command parsing rejects misplaced repeatable and duplicate boolean flags", () => {
  assert.throws(
    () => parseWorkFoldCliActArgv(["manage", "list", "--from", "ignored.txt"]),
    /--from cannot be used with 'manage list'/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["chat", "send", "--space", "space-1", "--new", "--new", "--message", "hello"]),
    /--new may be provided only once/,
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["files", "add", "--space", "space-1", "--from", "one", "--from", "two"]),
    { name: "files.add", output: "human", space: "space-1", fromPaths: ["one", "two"] },
  );
});

test("experimental Checks act commands require explicit Spaces and strict command-specific options", () => {
  assert.deepEqual(
    parseWorkFoldCliActArgv(["checks", "enable", "--space", "space-1", "--proposal", "proposals/tax.check.json"]),
    {
      name: "checks.enable",
      output: "human",
      space: "space-1",
      proposalPath: "proposals/tax.check.json",
    },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["checks", "disable", "--space", "space-1", "--check", "check-tax"]),
    { name: "checks.disable", output: "human", space: "space-1", check: "check-tax" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["checks", "run", "--space", "space-1"]),
    { name: "checks.run", output: "human", space: "space-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["checks", "run", "--space", "space-1", "--check", "check-tax"]),
    { name: "checks.run", output: "human", space: "space-1", check: "check-tax" },
  );
  for (const command of ["task", "result", "abort"] as const) {
    assert.deepEqual(
      parseWorkFoldCliActArgv(["checks", command, "--space", "space-1", "--task", "check-task-1"]),
      { name: `checks.${command}`, output: "human", space: "space-1", task: "check-task-1" },
    );
  }
  assert.deepEqual(
    parseWorkFoldCliActArgv(["checks", "problems", "--space", "space-1", "--check", "check-tax", "--json"]),
    { name: "checks.problems", output: "json", space: "space-1", check: "check-tax" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv([
      "checks",
      "decide",
      "--space",
      "space-1",
      "--finding",
      "finding-1",
      "--decision",
      "defer",
      "--until",
      "2026-08-03T10:30:00-04:00",
    ]),
    {
      name: "checks.decide",
      output: "human",
      space: "space-1",
      finding: "finding-1",
      decision: "defer",
      until: "2026-08-03T14:30:00.000Z",
    },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv([
      "checks",
      "decide",
      "--space",
      "space-1",
      "--finding",
      "finding-1",
      "--decision",
      "resolve",
    ]),
    {
      name: "checks.decide",
      output: "human",
      space: "space-1",
      finding: "finding-1",
      decision: "resolve",
    },
  );

  for (const argv of [
    ["checks", "enable", "--proposal", "proposal.json"],
    ["checks", "disable", "--check", "check-1"],
    ["checks", "run"],
    ["checks", "task", "--task", "task-1"],
    ["checks", "result", "--task", "task-1"],
    ["checks", "abort", "--task", "task-1"],
    ["checks", "problems"],
    ["checks", "decide", "--finding", "finding-1", "--decision", "accept"],
  ]) {
    assert.throws(() => parseWorkFoldCliActArgv(argv), /explicit --space/);
  }
  assert.throws(
    () => parseWorkFoldCliActArgv(["checks", "wait", "--space", "space-1", "--task", "task-1"]),
    /runs inside the work-fold shim/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["checks", "decide", "--space", "space-1", "--finding", "f", "--decision", "maybe"]),
    /must be accept, reject, resolve, or defer/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["checks", "decide", "--space", "space-1", "--finding", "f", "--decision", "defer"]),
    /requires --until/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["checks", "decide", "--space", "space-1", "--finding", "f", "--decision", "accept", "--until", createdAt]),
    /only with --decision defer/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["checks", "decide", "--space", "space-1", "--finding", "f", "--decision", "defer", "--until", "tomorrow"]),
    /must be an ISO timestamp/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["checks", "run", "--space", "space-1", "--proposal", "proposal.json"]),
    /--proposal cannot be used/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["spaces", "create", "--name", "Home", "--check", "check-1"]),
    /--check cannot be used/,
  );
});

test("Checks act execution bounds and terminal-scrubs structured and human output", async () => {
  const findings = Array.from({ length: 105 }, (_, index) => ({
    id: `finding-${index}`,
    fingerprint: `fingerprint-${index}`,
    checkId: "check-tax",
    declarationDigest: "d".repeat(64),
    sensorId: "path.exists",
    sensorRevision: 1,
    severity: "warning" as const,
    observedAt: createdAt,
    status: "active" as const,
    title: `Missing\u001b receipt ${index}`,
    targetPath: `receipts/${index}.pdf`,
    evidence: [{
      kind: "path-state" as const,
      path: `receipts/${index}.pdf`,
      expected: "file" as const,
      observed: "missing" as const,
      identity: { checkId: "check-tax", path: `receipts/${index}.pdf`, state: "missing" as const },
    }],
  }));
  const calls: unknown[] = [];
  const facade = {
    checksProblems: async (input: unknown) => {
      calls.push(input);
      return {
        space: { id: "space-1", name: "Taxes", spaceRoot: "/tmp/taxes" },
        checkId: "check-tax",
        findings,
        invalidated: 2,
        truncated: true,
        healthErrors: Array.from({ length: 22 }, (_, index) => `Health\u202e error ${index}`),
      };
    },
    checksTask: async (input: unknown) => {
      calls.push(input);
      return {
        space: { id: "space-1", name: "Taxes", spaceRoot: "/tmp/taxes" },
        task: {
          taskId: "check-task-1",
          runId: "check-run-1",
          state: "failed" as const,
          startedAt: createdAt,
          endedAt: createdAt,
          error: "Provider\u001b failed",
        },
      };
    },
  } as unknown as WorkFoldActFacade;
  const outcomes: string[] = [];
  const execute = (argv: string[]) => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          outcomes.push(record.outcome);
          return true;
        },
      },
    },
  );

  const response = await execute(["checks", "problems", "--space", "space-1", "--check", "check-tax", "--json"]);
  assert.equal(response.exitCode, 0);
  const json = JSON.parse(response.stdout) as {
    data: {
      findings: Array<{ title: string }>;
      findingCount: number;
      findingsReturned: number;
      findingsTruncated: boolean;
      sourceTruncated: boolean;
      healthErrors: string[];
      healthErrorCount: number;
      healthErrorsTruncated: boolean;
    };
  };
  assert.equal(json.data.findingCount, 105);
  assert.equal(json.data.findingsReturned, 100);
  assert.equal(json.data.findingsTruncated, true);
  assert.equal(json.data.sourceTruncated, true);
  assert.equal(json.data.healthErrorCount, 22);
  assert.equal(json.data.healthErrors.length, 20);
  assert.equal(json.data.healthErrorsTruncated, true);
  assert.equal(json.data.findings[0]?.title, "Missing� receipt 0");
  assert.equal(json.data.healthErrors[0], "Health� error 0");
  assert.deepEqual(calls[0], { space: "space-1", checkId: "check-tax" });

  const human = await execute(["checks", "task", "--space", "space-1", "--task", "check-task-1"]);
  assert.match(human.stdout, /Provider� failed/);
  assert.doesNotMatch(human.stdout, /\u001b/);
  assert.deepEqual(calls[1], { space: "space-1", taskId: "check-task-1" });
  assert.deepEqual(outcomes, ["accepted", "ok", "accepted", "ok"]);
});

test("ledger Chat, History, file, search, Library, and Space commands parse with strict shapes", () => {
  assert.deepEqual(
    parseWorkFoldCliActArgv(["chat", "rename", "--space", "space-1", "--conversation", "conv-1", "--title", "Weekly plan"]),
    { name: "chat.rename", output: "human", space: "space-1", conversation: "conv-1", title: "Weekly plan" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["chat", "snooze", "--space", "space-1", "--conversation", "conv-1", "--until", "2026-08-11T09:00:00-04:00"]),
    { name: "chat.snooze", output: "human", space: "space-1", conversation: "conv-1", until: "2026-08-11T13:00:00.000Z" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["chat", "archive", "--space", "space-1", "--conversation", "conv-1", "--parent-task", "task-9"]),
    { name: "chat.archive", output: "human", space: "space-1", conversation: "conv-1", parentTaskId: "task-9" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["chat", "resume", "--space", "space-1", "--conversation", "conv-1"]),
    { name: "chat.resume", output: "human", space: "space-1", conversation: "conv-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["chat", "compact", "--space", "space-1", "--conversation", "conv-1"]),
    { name: "chat.compact", output: "human", space: "space-1", conversation: "conv-1" },
  );

  assert.deepEqual(
    parseWorkFoldCliActArgv(["history", "list", "--space", "space-1"]),
    { name: "history.list", output: "human", space: "space-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["history", "save", "--space", "space-1", "--label", "before cleanup"]),
    { name: "history.save", output: "human", space: "space-1", label: "before cleanup" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["history", "save", "--space", "space-1"]),
    { name: "history.save", output: "human", space: "space-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["history", "restore", "--space", "space-1", "--checkpoint", "chk-1"]),
    { name: "history.restore", output: "human", space: "space-1", checkpoint: "chk-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["history", "versions", "--space", "space-1", "--path", "docs/plan.md"]),
    { name: "history.versions", output: "human", space: "space-1", path: "docs/plan.md" },
  );
  const versionHash = "b".repeat(64);
  assert.deepEqual(
    parseWorkFoldCliActArgv(["history", "restore-file", "--space", "space-1", "--path", "docs/plan.md", "--version", versionHash]),
    { name: "history.restore-file", output: "human", space: "space-1", path: "docs/plan.md", version: versionHash },
  );

  assert.deepEqual(
    parseWorkFoldCliActArgv(["files", "move", "--space", "space-1", "--from", "docs/plan.md", "--to", "archive"]),
    { name: "files.move", output: "human", space: "space-1", fromPaths: ["docs/plan.md"], toDir: "archive" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["files", "rename", "--space", "space-1", "--path", "docs/plan.md", "--name", "plan-2026.md"]),
    { name: "files.rename", output: "human", space: "space-1", path: "docs/plan.md", entryName: "plan-2026.md" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["files", "delete", "--space", "space-1", "--path", "docs/old.md"]),
    { name: "files.delete", output: "human", space: "space-1", path: "docs/old.md" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["files", "mkdir", "--space", "space-1", "--path", "notes"]),
    { name: "files.mkdir", output: "human", space: "space-1", path: "notes" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["files", "create", "--space", "space-1", "--path", "notes/todo.md"]),
    { name: "files.create", output: "human", space: "space-1", path: "notes/todo.md" },
  );

  assert.deepEqual(
    parseWorkFoldCliActArgv(["search", "--space", "space-1", "--query", "tax receipts", "--scope", "files", "--json"]),
    { name: "search", output: "json", space: "space-1", query: "tax receipts", searchScope: "files" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["search", "--space", "space-1", "--query", "tax receipts"]),
    { name: "search", output: "human", space: "space-1", query: "tax receipts" },
  );

  assert.deepEqual(parseWorkFoldCliActArgv(["library", "list"]), { name: "library.list", output: "human" });
  assert.deepEqual(
    parseWorkFoldCliActArgv(["library", "add", "--from", "one.pdf", "--from", "two.pdf", "--to", "Receipts"]),
    { name: "library.add", output: "human", fromPaths: ["one.pdf", "two.pdf"], toDir: "Receipts" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["library", "folder", "create", "--name", "Receipts"]),
    { name: "library.folder.create", output: "human", folderName: "Receipts" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["library", "copy", "--item", "Receipts/one.pdf", "--space", "space-1"]),
    { name: "library.copy", output: "human", item: "Receipts/one.pdf", space: "space-1" },
  );

  assert.deepEqual(
    parseWorkFoldCliActArgv(["spaces", "rename", "--space", "space-1", "--name", "Home files"]),
    { name: "spaces.rename", output: "human", space: "space-1", spaceName: "Home files" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["spaces", "unregister", "--space", "space-1"]),
    { name: "spaces.unregister", output: "human", space: "space-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["spaces", "delete", "--space", "space-1"]),
    { name: "spaces.delete", output: "human", space: "space-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["spaces", "appearance", "apply", "--space", "space-1", "--proposal", "proposals/appearance.json"]),
    { name: "spaces.appearance.apply", output: "human", space: "space-1", proposalPath: "proposals/appearance.json" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["spaces", "appearance", "reset", "--space", "space-1"]),
    { name: "spaces.appearance.reset", output: "human", space: "space-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["spaces", "appearance", "undo", "--space", "space-1"]),
    { name: "spaces.appearance.undo", output: "human", space: "space-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["spaces", "assistant", "show", "--space", "space-1"]),
    { name: "spaces.assistant.show", output: "human", space: "space-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["spaces", "assistant", "model", "--space", "space-1", "--provider", "openrouter", "--model", "example/model"]),
    { name: "spaces.assistant.model", output: "human", space: "space-1", provider: "openrouter", model: "example/model" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["spaces", "assistant", "instructions", "--space", "space-1", "--instructions", "Keep it concise.", "--parent-task", "task-9"]),
    { name: "spaces.assistant.instructions", output: "human", space: "space-1", instructions: "Keep it concise.", parentTaskId: "task-9" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["spaces", "assistant", "instructions", "--space", "space-1", "--clear"]),
    { name: "spaces.assistant.instructions", output: "human", space: "space-1", instructions: "", clear: true },
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["spaces", "assistant", "instructions", "--space", "space-1", "--instructions", "x", "--clear"]),
    /exactly one of --instructions .* or --clear/,
  );
});

test("ledger tools and apps commands parse with strict shapes", () => {
  assert.deepEqual(
    parseWorkFoldCliActArgv(["tools", "import-skill", "--scope", "space", "--space", "space-1", "--from", "bundles/skill"]),
    { name: "tools.import-skill", output: "human", toolsScope: "space", space: "space-1", fromPaths: ["bundles/skill"] },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["tools", "import-skill", "--scope", "personal", "--from", "bundles/skill"]),
    { name: "tools.import-skill", output: "human", toolsScope: "personal", fromPaths: ["bundles/skill"] },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["tools", "install", "--id", "catalog-1", "--scope", "personal"]),
    { name: "tools.install", output: "human", toolsScope: "personal", catalogId: "catalog-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["tools", "install", "--source", "npm:example-pkg", "--scope", "space", "--space", "space-1"]),
    { name: "tools.install", output: "human", toolsScope: "space", space: "space-1", source: "npm:example-pkg" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["tools", "update", "--source", "npm:example-pkg", "--scope", "personal"]),
    { name: "tools.update", output: "human", toolsScope: "personal", source: "npm:example-pkg" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["tools", "remove", "--source", "npm:example-pkg", "--scope", "space", "--space", "space-1"]),
    { name: "tools.remove", output: "human", toolsScope: "space", space: "space-1", source: "npm:example-pkg" },
  );

  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "list", "--space", "space-1"]),
    { name: "apps.list", output: "human", space: "space-1" },
  );
  // --input carries JSON, so it deliberately escapes the control-character
  // rule every other bounded flag keeps; the app's runtime validates the value.
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "invoke", "--space", "space-1", "--app", "app-1", "--tool", "summarize", "--input", "{\n  \"text\": \"North\"\n}", "--parent-task", "task-1"]),
    { name: "apps.invoke", output: "human", space: "space-1", app: "app-1", tool: "summarize", toolInput: { text: "North" }, parentTaskId: "task-1" },
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["apps", "invoke", "--space", "space-1", "--app", "app-1", "--tool", "summarize"]),
    /Provide --input <json>/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["apps", "invoke", "--space", "space-1", "--app", "app-1", "--tool", "summarize", "--input", "{not json"]),
    /--input must be valid JSON/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["apps", "invoke", "--space", "space-1", "--app", "app-1", "--tool", "summarize", "--input", JSON.stringify({ text: "x".repeat(300_000) })]),
    /--input must be at most 262144 bytes/,
  );
  assert.throws(() => parseWorkFoldCliActArgv(["apps", "list", "--space", "space-1", "--app", "app-1"]), /--app/);
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "proposals", "list", "--space", "space-1", "--conversation", "conv-1"]),
    { name: "apps.proposals.list", output: "human", space: "space-1", conversation: "conv-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "proposals", "dismiss", "--space", "space-1", "--conversation", "conv-1", "--proposal", "proposal-1"]),
    { name: "apps.proposals.dismiss", output: "human", space: "space-1", conversation: "conv-1", proposal: "proposal-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "install-proposal", "--space", "space-1", "--conversation", "conv-1", "--proposal", "proposal-1"]),
    { name: "apps.install-proposal", output: "human", space: "space-1", conversation: "conv-1", proposal: "proposal-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "install-preview", "--space", "space-1", "--package", "apps/preview"]),
    { name: "apps.install-preview", output: "human", space: "space-1", packagePath: "apps/preview" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "remove", "--space", "space-1", "--app", "app-1"]),
    { name: "apps.remove", output: "human", space: "space-1", app: "app-1" },
  );
  const digest = "c".repeat(64);
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "grant", "--space", "space-1", "--app", "app-1", "--digest", digest, "--kind", "network", "--declaration", "decl-1"]),
    { name: "apps.grant", output: "human", space: "space-1", app: "app-1", digest, grantKind: "network", declaration: "decl-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "revoke", "--space", "space-1", "--app", "app-1", "--digest", digest, "--kind", "files", "--declaration", "decl-2"]),
    { name: "apps.revoke", output: "human", space: "space-1", app: "app-1", digest, grantKind: "files", declaration: "decl-2" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "connect", "--space", "space-1", "--app", "app-1", "--destination", "dest-1"]),
    { name: "apps.connect", output: "human", space: "space-1", app: "app-1", destination: "dest-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "disconnect", "--space", "space-1", "--app", "app-1", "--destination", "dest-1"]),
    { name: "apps.disconnect", output: "human", space: "space-1", app: "app-1", destination: "dest-1" },
  );
  for (const [verb, name] of [
    ["enable", "apps.automation.enable"],
    ["disable", "apps.automation.disable"],
    ["run", "apps.automation.run"],
  ] as const) {
    assert.deepEqual(
      parseWorkFoldCliActArgv(["apps", "automation", verb, "--space", "space-1", "--app", "app-1", "--automation", "job-1"]),
      { name, output: "human", space: "space-1", app: "app-1", automation: "job-1" },
    );
  }
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "storage", "clear", "--space", "space-1", "--app", "app-1"]),
    { name: "apps.storage.clear", output: "human", space: "space-1", app: "app-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "retained", "purge", "--space", "space-1", "--retained", "retained-1"]),
    { name: "apps.retained.purge", output: "human", space: "space-1", retained: "retained-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "project", "declare", "--space", "space-1", "--presentation", "studio/presentation.json"]),
    { name: "apps.project.declare", output: "human", space: "space-1", presentationPath: "studio/presentation.json" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "release", "prepare", "--space", "space-1", "--version", "1.2"]),
    { name: "apps.release.prepare", output: "human", space: "space-1", version: "1.2" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "release", "publish", "--space", "space-1", "--release", digest]),
    { name: "apps.release.publish", output: "human", space: "space-1", release: digest },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "release", "delete", "--space", "space-1", "--release", digest]),
    { name: "apps.release.delete", output: "human", space: "space-1", release: digest },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "install", "prepare", "--space", "space-1", "--release", digest, "--target-space", "space-2"]),
    { name: "apps.install.prepare", output: "human", space: "space-1", release: digest, targetSpace: "space-2" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "update", "prepare", "--space", "space-1", "--instance", "instance-1", "--release", digest]),
    { name: "apps.update.prepare", output: "human", space: "space-1", instance: "instance-1", release: digest },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "operation", "activate", "--space", "space-1", "--operation", "op-1"]),
    { name: "apps.operation.activate", output: "human", space: "space-1", operation: "op-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "operation", "cancel", "--space", "space-1", "--operation", "op-1"]),
    { name: "apps.operation.cancel", output: "human", space: "space-1", operation: "op-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "uninstall", "--space", "space-1", "--instance", "instance-1", "--retain-data"]),
    { name: "apps.uninstall", output: "human", space: "space-1", instance: "instance-1", disposition: "retain-data" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["apps", "uninstall", "--space", "space-1", "--instance", "instance-1", "--purge-data"]),
    { name: "apps.uninstall", output: "human", space: "space-1", instance: "instance-1", disposition: "purge-data" },
  );
});

test("ledger command flag validation refuses malformed and misplaced shapes", () => {
  assert.throws(
    () => parseWorkFoldCliActArgv(["chat", "snooze", "--space", "s", "--conversation", "c", "--until", "tomorrow"]),
    /--until must be an ISO timestamp/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["chat", "snooze", "--space", "s", "--conversation", "c"]),
    /Provide --until <ISO-timestamp>/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["search", "--space", "s", "--query", "q", "--scope", "everything"]),
    /--scope must be files, chats, or all/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["search", "--space", "s", "--query", "q".repeat(201)]),
    /--query must be at most 200 characters/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["files", "move", "--space", "s", "--from", "a", "--from", "b", "--to", "dir"]),
    /exactly one --from/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["files", "move", "--space", "s", "--from", "a"]),
    /Provide --to <space-folder>/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["files", "delete", "--space", "s", "--path", "a", "--path", "b"]),
    /--path may be provided only once/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["tools", "install", "--id", "cat-1", "--source", "npm:pkg", "--scope", "personal"]),
    /exactly one of --id <catalog-id> or --source <package-source>/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["tools", "install", "--scope", "personal"]),
    /exactly one of --id <catalog-id> or --source <package-source>/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["tools", "import-skill", "--scope", "space", "--from", "bundle"]),
    /--scope space requires an explicit --space/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["tools", "import-skill", "--scope", "personal", "--space", "s", "--from", "bundle"]),
    /--space cannot be used with --scope personal/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["tools", "update", "--source", "npm:pkg", "--scope", "global"]),
    /--scope must be personal or space/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["apps", "grant", "--space", "s", "--app", "a", "--digest", "d", "--kind", "everything", "--declaration", "x"]),
    /--kind must be network, files, or notifications/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["apps", "uninstall", "--space", "s", "--instance", "i"]),
    /never defaulted/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["apps", "uninstall", "--space", "s", "--instance", "i", "--retain-data", "--purge-data"]),
    /never defaulted/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["spaces", "rename", "--space", "s", "--name", "bad\u0007name"]),
    /--name contains unsupported control characters/,
  );

  // New flags stay fenced off the shipped commands, and vice versa.
  assert.throws(
    () => parseWorkFoldCliActArgv(["chat", "create", "--space", "s", "--title", "x"]),
    /--title cannot be used with 'chat create'/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["spaces", "create", "--name", "Home", "--release", "digest"]),
    /--release cannot be used with 'spaces create'/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["chat", "rename", "--space", "s", "--conversation", "c", "--title", "t", "--check", "x"]),
    /--check cannot be used with 'chat rename'/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["files", "mkdir", "--space", "s", "--path", "dir", "--message", "x"]),
    /--message cannot be used with 'files mkdir'/,
  );

  // Content-bearing act reads carry no management lineage.
  assert.throws(
    () => parseWorkFoldCliActArgv(["history", "list", "--space", "s", "--parent-task", "task-1"]),
    /--parent-task cannot be used with 'history list'/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["search", "--space", "s", "--query", "q", "--parent-task", "task-1"]),
    /--parent-task cannot be used with 'search'/,
  );

  // The Library is personal and Space-free.
  assert.throws(
    () => parseWorkFoldCliActArgv(["library", "list", "--space", "s"]),
    /--space cannot be used with 'library list'/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["library", "add", "--from", "one.pdf", "--space", "s"]),
    /--space cannot be used with 'library add'/,
  );

  // Space-scoped writes still require explicit selection.
  for (const argv of [
    ["spaces", "delete"],
    ["history", "restore", "--checkpoint", "chk-1"],
    ["chat", "rename", "--conversation", "c", "--title", "t"],
  ]) {
    assert.throws(() => parseWorkFoldCliActArgv(argv), /explicit --space/);
  }
});

test("setup-only authority families are refused at parse time", () => {
  const refusals: Array<[string[], RegExp]> = [
    [["remote", "disable"], /Remote access administration/],
    [["browsers", "approve"], /Remote access administration/],
    [["browser", "revoke"], /Remote access administration/],
    [["pairing", "approve"], /Act-token and pairing machinery/],
    [["token", "mint"], /Act-token and pairing machinery/],
    [["tokens", "rotate"], /Act-token and pairing machinery/],
    [["provider", "set-key"], /Provider credentials/],
    [["providers", "remove"], /Provider credentials/],
    [["credentials", "remove"], /Provider credentials/],
    [["settings", "assistant"], /Settings administration/],
    [["--json", "remote", "disable"], /Remote access administration/],
  ];
  for (const [argv, category] of refusals) {
    assert.throws(
      () => parseWorkFoldCliActArgv(argv),
      (error: unknown) =>
        error instanceof WorkFoldCliError
        && error.code === "permissionDenied"
        && category.test(error.message)
        && /local setup only/.test(error.message)
        && /cannot perform it/.test(error.message),
      `expected setup-only refusal for '${argv.join(" ")}'`,
    );
  }

  // Setup-only family words remain usable as ordinary flag values.
  assert.deepEqual(
    parseWorkFoldCliActArgv(["chats", "list", "--space", "settings"]),
    { name: "chats.list", output: "human", space: "settings" },
  );
});

test("direct verbs parse with strict shapes", () => {
  assert.deepEqual(
    parseWorkFoldCliActArgv(["routings", "enable", "--proposal", "fold/weekly.work-fold-routing.json"]),
    { name: "routings.enable", output: "human", proposalPath: "fold/weekly.work-fold-routing.json" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["routings", "enable", "--proposal", "weekly.json", "--parent-task", "task-1"]),
    { name: "routings.enable", output: "human", proposalPath: "weekly.json", parentTaskId: "task-1" },
  );
  // Routings are above Spaces, like the manage group.
  assert.throws(
    () => parseWorkFoldCliActArgv(["routings", "enable", "--proposal", "weekly.json", "--space", "space-1"]),
    /--space cannot be used with 'routings enable'/,
  );

  assert.deepEqual(
    parseWorkFoldCliActArgv(["pages", "share", "--space", "space-1", "--path", "reports/weekly.md", "--title", "Weekly report"]),
    { name: "pages.share", output: "human", space: "space-1", path: "reports/weekly.md", title: "Weekly report" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["pages", "share", "--space", "space-1", "--path", "weekly.md", "--title", "Weekly", "--snapshot"]),
    { name: "pages.share", output: "human", space: "space-1", path: "weekly.md", title: "Weekly", snapshot: true },
  );
  assert.throws(() => parseWorkFoldCliActArgv(["pages", "share", "--path", "weekly.md", "--title", "W"]), /explicit --space/);
  assert.throws(
    () => parseWorkFoldCliActArgv(["pages", "share", "--space", "space-1", "--path", "a.md", "--title", "A", "--message", "x"]),
    /--message cannot be used with 'pages share'/,
  );

  // Rung 3: hosted-app exposure. The pins come from the installed Instance's
  // reviewed manifest host-side; argv names only the identity.
  assert.deepEqual(
    parseWorkFoldCliActArgv(["pages", "share-app", "--space", "space-1", "--instance", "feature-installation-1"]),
    { name: "pages.share-app", output: "human", space: "space-1", instance: "feature-installation-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["pages", "share-app", "--space", "space-1", "--instance", "fi-1", "--parent-task", "task-9", "--json"]),
    { name: "pages.share-app", output: "json", space: "space-1", instance: "fi-1", parentTaskId: "task-9" },
  );
  assert.throws(() => parseWorkFoldCliActArgv(["pages", "share-app", "--instance", "fi-1"]), /explicit --space/);
  assert.throws(
    () => parseWorkFoldCliActArgv(["pages", "share-app", "--space", "space-1", "--instance", "fi-1", "--title", "T"]),
    /--title cannot be used with 'pages share-app'/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["pages", "share-app", "--space", "space-1", "--instance", "fi-1", "--snapshot"]),
    /--snapshot cannot be used with 'pages share-app'/,
    "apps have no snapshot lane; asleep is the only offline state",
  );

  // Recently deleted sits above Spaces too (docs/receipts-not-gates.md, F20):
  // each item names the Space it came from, so neither verb takes --space.
  assert.deepEqual(parseWorkFoldCliActArgv(["trash", "list", "--json"]), { name: "trash.list", output: "json" });
  assert.deepEqual(
    parseWorkFoldCliActArgv(["trash", "restore", "--entry", "trash-20260910083000-53db781d"]),
    { name: "trash.restore", output: "human", entry: "trash-20260910083000-53db781d" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["trash", "restore", "--entry", "trash-20260910083000-53db781d", "--to", "/tmp/copy.json", "--parent-task", "task-4"]),
    {
      name: "trash.restore",
      output: "human",
      entry: "trash-20260910083000-53db781d",
      toPath: "/tmp/copy.json",
      parentTaskId: "task-4",
    },
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["trash", "list", "--space", "space-1"]),
    /--space cannot be used with 'trash list'/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["trash", "restore", "--space", "space-1", "--entry", "trash-20260910083000-53db781d"]),
    /--space cannot be used with 'trash restore'/,
  );
  assert.throws(() => parseWorkFoldCliActArgv(["trash", "restore"]), /--entry/);
  assert.throws(
    () => parseWorkFoldCliActArgv(["trash", "list", "--parent-task", "task-1"]),
    /--parent-task cannot be used with 'trash list'/,
  );

  // The pending-decision family, permanent deletion, and the retired holding
  // spellings of the routing and outward-exposure verbs are gone from the
  // vocabulary (docs/receipts-not-gates.md, F19/F20): unknown commands, not
  // refusals with a story.
  for (const argv of [
    ["staged", "list"], ["staged", "show"], ["staged", "cancel"],
    ["routings", "stage"], ["pages", "stage"],
  ]) {
    assert.throws(() => parseWorkFoldCliActArgv(argv), /Unknown command/, `expected an unknown command for '${argv.join(" ")}'`);
  }
  assert.throws(
    () => parseWorkFoldCliActArgv(["files", "destroy"]),
    /Unknown command: files destroy/,
  );
});

test("formerly gated verbs execute through the facade and receipt without a decision id", async () => {
  const spaceRef = { id: "space-1", name: "Fold Space", spaceRoot: "/tmp/fold" };
  const appRef = { spaceId: "space-1", appId: "quote-board", featureInstallationId: "feature-installation-1", digest: "f".repeat(64), title: "Quote board", version: "0.9.0" };
  const publication = {
    publicationId: "pub-1", kind: "page", spaceId: "space-1", spaceName: "Fold Space", relativePath: "reports/weekly.md", title: "Weekly report",
    state: "active", live: true, serveRatePerMinute: 60, byteBudgetPerDay: 268435456, snapshotEnabled: false,
    createdAt, updatedAt: createdAt, bridgeSlot: "pending", viewerPath: "/p/pub-1",
  };
  const calls: Array<{ method: string; input?: unknown }> = [];
  let routingsEnableAlready = false;
  const facade = {
    spacesDelete: async (input: unknown) => {
      calls.push({ method: "spacesDelete", input });
      return { space: spaceRef, storage: "managed", removed: true, cleanupPending: true };
    },
    toolsInstall: async (input: unknown) => {
      calls.push({ method: "toolsInstall", input });
      return {
        scope: "personal",
        source: "npm:@demo/toolkit@1.2.3",
        packageId: "npm:@demo/toolkit",
        version: "1.2.3",
        resourceSummary: "1 skill(s), 1 extension(s) — executable Pi capability",
        installed: true,
      };
    },
    toolsImportSkill: async (input: unknown) => {
      calls.push({ method: "toolsImportSkill", input });
      return { scope: "space", space: spaceRef, source: "/tmp/notes.skill", contentDigest: "c".repeat(64), skillNames: ["notes", "todo"], bundlePath: "/tmp/fold/.pi/skills/notes.skill" };
    },
    appsUninstallPurge: async (input: unknown) => {
      calls.push({ method: "appsUninstallPurge", input });
      return { space: spaceRef, runtimeInstanceId: "runtime-instance_1", purgedNamespaceIds: ["data-namespace_1"], removed: true, cleanupPending: false };
    },
    appsGrant: async (input: unknown) => {
      calls.push({ method: "appsGrant", input });
      return { space: spaceRef, appId: "quote-board", grantKind: "files", declaration: "exports", granted: true, root: "." };
    },
    appsStorageClear: async (input: unknown) => {
      calls.push({ method: "appsStorageClear", input });
      return { space: spaceRef, appId: "quote-board", clearedBytes: 2048, remainingBytes: 0 };
    },
    routingsEnable: async (input: unknown) => {
      calls.push({ method: "routingsEnable", input });
      return {
        routingId: "routing-weekly",
        declarationDigest: "e".repeat(64),
        title: "Weekly glue",
        referencedSpaceIds: ["space-1"],
        health: "enabled",
        enabledAt: "2026-09-01T12:00:00.000Z",
        alreadyEnabled: routingsEnableAlready,
        stoppedRunId: null,
      };
    },
    pagesShare: async (input: unknown) => {
      calls.push({ method: "pagesShare", input });
      return { space: spaceRef, publication };
    },
    pagesShareApp: async (input: unknown) => {
      calls.push({ method: "pagesShareApp", input });
      return {
        space: spaceRef,
        publication: {
          ...publication, publicationId: "pub-app", kind: "app", relativePath: undefined, title: "Fixture app", viewerPath: "/a/pub-app",
          appInstanceId: "feature-installation-1", releaseDigest: `sha256:${"a".repeat(64)}`, viewerEntry: "viewer.html", viewerSurface: ["entry:viewer.html", "data:public/"],
        },
      };
    },
    appsInstallPreview: async (input: unknown) => {
      calls.push({ method: "appsInstallPreview", input });
      return {
        space: spaceRef,
        proposalId: "proposal-1",
        digest: "f".repeat(64),
        title: "Quote board",
        packageName: "quote-board",
        version: "0.9.0",
        replacesInstalled: true,
        app: appRef,
        granted: { destinations: 2, wholeSpaceFolders: 1, notifications: 0, checks: 0, automations: 1 },
        needs: { connections: ["crm"], files: ["ledger"], checks: ["review"] },
      };
    },
  } as unknown as WorkFoldActFacade;
  const records: Array<Record<string, unknown>> = [];
  const execute = (argv: string[]) => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          records.push({ ...record });
          return true;
        },
      },
    },
  );
  const lastOk = () => records.filter((record) => record.outcome === "ok").at(-1)!;

  // Every verb executes on the first call and returns its effect: no pending
  // decision, no decision id anywhere in the result or the receipts.
  const deleted = await execute(["spaces", "delete", "--space", "space-1", "--json"]);
  assert.equal(deleted.exitCode, 0);
  const deletedJson = JSON.parse(deleted.stdout) as { ok: boolean; data: Record<string, unknown> };
  assert.equal(deletedJson.ok, true);
  assert.equal(deletedJson.data.removed, true);
  assert.equal("staged" in deletedJson.data, false);
  assert.equal("decisionId" in deletedJson.data, false);
  const spacesDeleteInput = calls.at(-1)!.input as { space: string; requestId?: string };
  assert.equal(spacesDeleteInput.space, "space-1");
  assert.ok(spacesDeleteInput.requestId, "the act request's journal id rides into the facade");
  assert.deepEqual(records.map((record) => record.outcome), ["accepted", "ok"]);
  assert.equal(lastOk().decisionId, undefined, "receipts carry no decision id");
  assert.equal(lastOk().detail, "space.delete-folder");
  const deletedHuman = await execute(["spaces", "delete", "--space", "space-1"]);
  assert.match(deletedHuman.stdout, /^Deleted the managed folder of Fold Space \[space-1\]\. Final cleanup completes at the next start\.\n$/);

  const install = await execute(["tools", "install", "--source", "npm:@demo/toolkit", "--scope", "personal"]);
  assert.equal(install.exitCode, 0);
  assert.match(install.stdout, /^Installed npm:@demo\/toolkit 1\.2\.3 \(personal scope\)\.\n$/);
  assert.doesNotMatch(install.stdout, /staged|approv|decision/i);
  assert.equal(lastOk().detail, "capability.package.install; scope personal; source npm:@demo/toolkit@1.2.3; version 1.2.3");
  assert.deepEqual(lastOk().undoRef, { kind: "package-source", value: "npm:@demo/toolkit@1.2.3" });

  const imported = await execute(["tools", "import-skill", "--scope", "space", "--space", "space-1", "--from", "notes.skill"]);
  assert.equal(imported.exitCode, 0);
  assert.match(imported.stdout, /^Imported notes, todo \(space scope\)\.\n$/);
  assert.equal(lastOk().detail, `capability.skills.import; scope space; source /tmp/notes.skill; digest ${"c".repeat(64)}`);
  assert.deepEqual(lastOk().undoRef, { kind: "skill-bundle-path", value: "/tmp/fold/.pi/skills/notes.skill" });

  const purge = await execute(["apps", "uninstall", "--space", "space-1", "--instance", "runtime-instance_1", "--purge-data"]);
  assert.equal(purge.exitCode, 0);
  assert.match(purge.stdout, /^Uninstalled instance runtime-instance_1 from Fold Space \[space-1\] and purged its data\.\n$/);
  assert.equal(calls.at(-1)?.method, "appsUninstallPurge");
  assert.equal(lastOk().detail, "app.data.purge; instance runtime-instance_1");

  const grant = await execute(["apps", "grant", "--space", "space-1", "--app", "quote-board", "--digest", "f".repeat(64), "--kind", "files", "--declaration", "exports"]);
  assert.equal(grant.exitCode, 0);
  assert.match(grant.stdout, /^Granted files exports to quote-board in Fold Space \[space-1\]\. It covers the whole Space folder\.\n$/);
  assert.equal(lastOk().detail, "app.grant.files; app quote-board; declaration exports; root .");
  assert.deepEqual(lastOk().undoRef, { kind: "declaration", value: "exports" });

  const cleared = await execute(["apps", "storage", "clear", "--space", "space-1", "--app", "quote-board"]);
  assert.match(cleared.stdout, /^Cleared 2048 bytes of live storage of quote-board in Fold Space \[space-1\]; 0 bytes remain\.\n$/);
  assert.equal(lastOk().detail, "app.storage.clear; app quote-board; bytes 2048");

  const routing = await execute(["routings", "enable", "--proposal", "fold/weekly.json"]);
  assert.equal(routing.exitCode, 0);
  assert.match(routing.stdout, /^Enabled routing "Weekly glue" \[routing-weekly\]\. It now runs on its trigger; /);
  assert.match(routing.stdout, /'routings disable --routing routing-weekly' turns it off\.\n$/);
  assert.equal(calls.at(-1)?.method, "routingsEnable");
  assert.equal((calls.at(-1)?.input as { proposalPath: string }).proposalPath, "fold/weekly.json");
  assert.equal((calls.at(-1)?.input as { cwd: string }).cwd, cwd);
  assert.equal(lastOk().detail, `routing.enable; routing routing-weekly; digest ${"e".repeat(64)}`);
  assert.deepEqual(lastOk().undoRef, { kind: "routing-id", value: "routing-weekly" });

  // Enabling the same declaration again changes nothing, and says so.
  routingsEnableAlready = true;
  const again = await execute(["routings", "enable", "--proposal", "fold/weekly.json"]);
  assert.equal(again.exitCode, 0);
  assert.match(again.stdout, /^Routing "Weekly glue" \[routing-weekly\] is already on with this exact declaration; nothing changed\.\n$/);
  assert.equal(lastOk().detail, `routing.enable; routing routing-weekly; digest ${"e".repeat(64)}; already enabled`);
  routingsEnableAlready = false;

  const page = await execute(["pages", "share", "--space", "space-1", "--path", "reports/weekly.md", "--title", "Weekly report"]);
  assert.equal(page.exitCode, 0);
  assert.match(page.stdout, /^Sharing "Weekly report" \(reports\/weekly\.md\) from Fold Space \[space-1\] at \/p\/pub-1\. Reveal the link in Settings → The fold\.\n$/);
  assert.equal(lastOk().detail, "publish.viewer.expose; source reports/weekly.md; publication pub-1");
  assert.deepEqual(lastOk().undoRef, { kind: "publicationId", value: "pub-1" });

  const hostedApp = await execute(["pages", "share-app", "--space", "space-1", "--instance", "feature-installation-1"]);
  assert.equal(hostedApp.exitCode, 0);
  assert.match(hostedApp.stdout, /^Sharing "Fixture app" \(App Instance feature-installation-1\) from Fold Space \[space-1\] at \/a\/pub-app\.\n$/);
  assert.equal(calls.at(-1)?.method, "pagesShareApp");
  assert.equal((calls.at(-1)?.input as { instance: string }).instance, "feature-installation-1");
  assert.equal(lastOk().detail, `publish.viewer.expose; appInstanceId feature-installation-1; releaseDigest sha256:${"a".repeat(64)}; publication pub-app`);

  // The host creates the review itself and installs it at once through the
  // same digest-checked path a Chat proposal uses.
  records.length = 0;
  const preview = await execute(["apps", "install-preview", "--space", "space-1", "--package", "apps/preview"]);
  assert.equal(preview.exitCode, 0);
  // Both halves, the way the Chat path reports them: what came on, and what
  // deliberately still needs the person (docs/receipts-not-gates.md, F21).
  assert.match(preview.stdout, /^Installed Quote board 0\.9\.0 in Fold Space \[space-1\]\. It replaced the previous installation\.\n/);
  assert.match(preview.stdout, /On now: 2 destinations, 1 folder permission over the whole Space, 0 notifications, 0 Check slots, 1 automation\.\n/);
  assert.match(
    preview.stdout,
    /Still needs the person, in the Apps tab: connect crm; choose a file for ledger; choose a Check for review\.\n$/,
  );
  const previewInput = calls.at(-1)?.input as { space: string; packagePath: string; requestId?: string };
  assert.equal(previewInput.space, "space-1");
  assert.equal(previewInput.packagePath, "apps/preview");
  assert.ok(previewInput.requestId, "the act request's journal id rides into the facade");
  assert.deepEqual(records.map((record) => record.outcome), ["accepted", "ok"]);
  assert.equal(
    lastOk().detail,
    `app.review.install; proposal proposal-1; digest ${"f".repeat(64)}; replaced installed preview; 3 still needs the person`,
  );

  // A setup-only refusal happens at parse time: no journal entry at all.
  records.length = 0;
  const neverList = await execute(["provider", "set-key"]);
  assert.equal(neverList.exitCode, 4);
  assert.match(neverList.stderr, /Provider credentials is local setup only/);
  assert.deepEqual(records, []);
});

test("remote lineage on a management parent stamps the browser identity on act receipts", async () => {
  const facade = {
    pagesRevoke: async () => ({
      publication: { publicationId: "pub-1", kind: "page", spaceId: "space-1", title: "Weekly", state: "revoked", live: false, serveRatePerMinute: 60, byteBudgetPerDay: 1, snapshotEnabled: false, createdAt, updatedAt: createdAt, bridgeSlot: "pending", viewerPath: "/p/pub-1" },
      alreadyRevoked: false,
    }),
  } as unknown as WorkFoldActFacade;
  const records: Array<Record<string, unknown>> = [];
  const response = await executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv: ["pages", "revoke", "--publication", "pub-1", "--parent-task", "task-remote"], cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      resolveLineageParent: (taskId) => (taskId === "task-remote" ? { taskId, browserId: "browser-9", grantId: "grant-9" } : null),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => { records.push({ ...record }); return true; },
      },
    },
  );
  assert.equal(response.exitCode, 0);
  assert.deepEqual(records.map((record) => [record.outcome, record.parentTaskId, record.browserId, record.grantId]), [
    ["accepted", "task-remote", "browser-9", "grant-9"],
    ["ok", "task-remote", "browser-9", "grant-9"],
  ]);
});

test("manage glance parses strictly, dispatches to the facade, journals, and renders the digest", async () => {
  assert.deepEqual(parseWorkFoldCliActArgv(["manage", "glance"]), { name: "manage.glance", output: "human" });
  assert.deepEqual(parseWorkFoldCliActArgv(["manage", "glance", "--json"]), { name: "manage.glance", output: "json" });
  assert.throws(
    () => parseWorkFoldCliActArgv(["manage", "glance", "--space", "space-1"]),
    /--space cannot be used with 'manage glance'/,
  );

  const snapshot = {
    kind: "work-fold.glance.experimental",
    version: 1,
    composedAt: "2026-08-10T12:00:00.000Z",
    cursor: "2026-08-10T11:00:00.000Z/settled-turns:task-1",
    running: [{ id: "kernel-tasks:task-2", at: createdAt, kind: "assistant-turn", spaceName: "Fold Space", headline: "Assistant turn running" }],
    needsYou: [{ id: "chats:chat-3:question", at: createdAt, kind: "chat-question", spaceName: "Fold Space", headline: "\"Quarterly plan\" is waiting on your reply" }],
    changes: [{ id: "settled-turns:task-1", at: createdAt, kind: "turn-settled", spaceName: "Fold Space", headline: "Assistant turn succeeded" }],
    checks: [{ spaceId: "space-1", spaceName: "Fold Space", state: "needs-attention", needsAttention: 2, neverRun: 0, stale: 0, blocked: 0, errors: 0, lastRunAt: createdAt }],
    seen: {},
    truncated: { running: false, needsYou: false, changes: true, checks: false },
    unavailable: ["routing-runs"],
  };
  const calls: string[] = [];
  const records: Array<{ command: string; outcome: string }> = [];
  const facade = {
    manageGlance: async () => {
      calls.push("manageGlance");
      return snapshot;
    },
  } as unknown as WorkFoldActFacade;
  const execute = (argv: string[]) => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          records.push({ command: record.command, outcome: record.outcome });
          return true;
        },
      },
    },
  );

  const json = await execute(["manage", "glance", "--json"]);
  assert.equal(json.exitCode, 0);
  const parsed = JSON.parse(json.stdout) as { ok: boolean; command: string; data: typeof snapshot };
  assert.equal(parsed.command, "manage.glance");
  assert.equal(parsed.data.kind, "work-fold.glance.experimental");
  assert.equal(parsed.data.needsYou[0]?.kind, "chat-question");

  const human = await execute(["manage", "glance"]);
  assert.match(human.stdout, /Running:\n- Assistant turn running \(Fold Space\)/);
  assert.match(human.stdout, /Needs you:\n- .*"Quarterly plan" is waiting on your reply/);
  assert.match(human.stdout, /Since you last looked \(more omitted\):/);
  assert.match(human.stdout, /- Fold Space: needs-attention — 2 findings need attention/);
  assert.match(human.stdout, /Unavailable sources this composition: routing-runs\./);

  assert.equal(calls.length, 2);
  assert.deepEqual(records, [
    { command: "manage.glance", outcome: "accepted" },
    { command: "manage.glance", outcome: "ok" },
    { command: "manage.glance", outcome: "accepted" },
    { command: "manage.glance", outcome: "ok" },
  ], "the shared journal-first executor covers the glance with no special casing");
});

test("routing receipt JSON stays chronological and human output shows its newest bounded tail", async () => {
  const receipts = Array.from({ length: 60 }, (_, index) => ({
    at: new Date(Date.parse("2026-09-01T12:00:00.000Z") + index * 1_000).toISOString(),
    scope: "routing" as const,
    outcome: "enabled" as const,
    routingId: `routing-${String(index).padStart(2, "0")}`,
  }));
  const facade = {
    routingsReceipts: async () => ({ receipts, truncated: false, damagedLineCount: 0 }),
  } as unknown as WorkFoldActFacade;
  const execute = (argv: string[]) => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      receipts: { hasAccepted: async () => false, append: async () => true },
    },
  );

  const json = await execute(["routings", "receipts", "--json"]);
  assert.equal(json.exitCode, 0);
  const parsed = JSON.parse(json.stdout) as { data: { receipts: typeof receipts } };
  assert.equal(parsed.data.receipts[0]?.routingId, "routing-00");
  assert.equal(parsed.data.receipts.at(-1)?.routingId, "routing-59");

  const human = await execute(["routings", "receipts"]);
  assert.match(human.stdout, /10 older receipt\(s\) in the --json result\./);
  assert.doesNotMatch(human.stdout, /\[routing-09\]/);
  assert.ok(human.stdout.indexOf("[routing-10]") < human.stdout.indexOf("[routing-59]"));
});

test("Chat lifecycle and History acts dispatch to the facade, stamp undo references, and render bespoke output", async () => {
  const spaceRef = { id: "space-1", name: "Fold Space", spaceRoot: "/tmp/fold" };
  const conversationRef = (over: Record<string, unknown> = {}) => ({
    id: "conv-1",
    title: "Weekly plan",
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    snoozedUntil: null,
    ...over,
  });
  const checkpointSummary = {
    checkpointId: "cp-20260810120000-aaaaaaaa",
    createdAt,
    label: "draft one",
    reason: "manual",
    scope: "full" as const,
    fileCount: 3,
    totalBytes: 42,
    skippedFileCount: 0,
  };
  const calls: Array<{ method: string; input: unknown }> = [];
  let saveCreated = true;
  const facade = {
    chatRename: async (input: unknown) => {
      calls.push({ method: "chatRename", input });
      return { space: spaceRef, conversation: conversationRef(), priorTitle: "New Chat" };
    },
    chatSnooze: async (input: unknown) => {
      calls.push({ method: "chatSnooze", input });
      return {
        space: spaceRef,
        conversation: conversationRef({ snoozedUntil: "2026-08-11T13:00:00.000Z" }),
        priorLifecycle: { archivedAt: null, snoozedUntil: null },
      };
    },
    chatArchive: async (input: unknown) => {
      calls.push({ method: "chatArchive", input });
      return {
        space: spaceRef,
        conversation: conversationRef({ archivedAt: createdAt }),
        priorLifecycle: { archivedAt: null, snoozedUntil: "2026-08-11T13:00:00.000Z" },
      };
    },
    chatResume: async (input: unknown) => {
      calls.push({ method: "chatResume", input });
      return {
        space: spaceRef,
        conversation: conversationRef(),
        priorLifecycle: { archivedAt: createdAt, snoozedUntil: null },
      };
    },
    historyList: async (input: unknown) => {
      calls.push({ method: "historyList", input });
      return { space: spaceRef, checkpoints: [] };
    },
    historySave: async (input: unknown) => {
      calls.push({ method: "historySave", input });
      return { space: spaceRef, checkpoint: checkpointSummary, created: saveCreated };
    },
    historyRestore: async (input: unknown) => {
      calls.push({ method: "historyRestore", input });
      return {
        space: spaceRef,
        restored: true,
        checkpointId: "cp-20260810120000-aaaaaaaa",
        safetyCheckpointId: "cp-20260810120100-bbbbbbbb",
        restoredFileCount: 2,
        deletedFileCount: 1,
        movedEntryCount: 0,
        unchangedFileCount: 4,
        skippedLargeFileCount: 1,
      };
    },
    historyVersions: async (input: unknown) => {
      calls.push({ method: "historyVersions", input });
      return {
        space: spaceRef,
        path: "docs/plan.md",
        versions: [{
          path: "docs/plan.md",
          hashSha256: "e".repeat(64),
          sizeBytes: 12,
          modifiedAt: createdAt,
          capturedAt: createdAt,
          checkpointId: checkpointSummary.checkpointId,
        }],
      };
    },
    historyRestoreFile: async (input: unknown) => {
      calls.push({ method: "historyRestoreFile", input });
      return {
        space: spaceRef,
        restored: true,
        path: "docs/plan.md",
        hashSha256: "e".repeat(64),
        previousHashSha256: "f".repeat(64),
        safetyCheckpointId: "cp-20260810120200-cccccccc",
      };
    },
    chatCompact: async (input: unknown) => {
      calls.push({ method: "chatCompact", input });
      return { space: spaceRef, conversationId: "conv-1", compacted: true, taskId: "task-compact-1" };
    },
  } as unknown as WorkFoldActFacade;
  const records: Array<{
    outcome: string;
    command: string;
    conversationId?: string;
    checkpointId?: string;
    taskId?: string;
    parentTaskId?: string;
    detail?: string;
    undoRef?: { kind: string; value: string };
  }> = [];
  const execute = (argv: string[]) => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      resolveLineageParent: (taskId) => (taskId === "task-9" ? { taskId } : null),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          records.push({
            outcome: record.outcome,
            command: record.command,
            ...(record.conversationId ? { conversationId: record.conversationId } : {}),
            ...(record.checkpointId ? { checkpointId: record.checkpointId } : {}),
            ...(record.taskId ? { taskId: record.taskId } : {}),
            ...(record.parentTaskId ? { parentTaskId: record.parentTaskId } : {}),
            ...(record.detail ? { detail: record.detail } : {}),
            ...(record.undoRef ? { undoRef: record.undoRef } : {}),
          });
          return true;
        },
      },
    },
  );
  const lastOk = () => records.filter((record) => record.outcome === "ok").at(-1)!;

  const renamed = await execute(["chat", "rename", "--space", "space-1", "--conversation", "conv-1", "--title", "Weekly plan"]);
  assert.equal(renamed.exitCode, 0);
  assert.match(renamed.stdout, /Renamed Chat \[conv-1\] to "Weekly plan" in Fold Space \[space-1\] \(was "New Chat"\)\./);
  assert.deepEqual(calls.at(-1), {
    method: "chatRename",
    input: { space: "space-1", conversationId: "conv-1", title: "Weekly plan" },
  });
  assert.equal(lastOk().conversationId, "conv-1");
  assert.deepEqual(lastOk().undoRef, { kind: "chat-title", value: "New Chat" });

  const snoozed = await execute(["chat", "snooze", "--space", "space-1", "--conversation", "conv-1", "--until", "2026-08-11T13:00:00.000Z"]);
  assert.match(snoozed.stdout, /Snoozed Chat "Weekly plan" \[conv-1\] until 2026-08-11T13:00:00\.000Z/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", conversationId: "conv-1", until: "2026-08-11T13:00:00.000Z" });
  assert.deepEqual(lastOk().undoRef, { kind: "chat-lifecycle", value: "active" });

  const archived = await execute(["chat", "archive", "--space", "space-1", "--conversation", "conv-1", "--parent-task", "task-9"]);
  assert.match(archived.stdout, /Archived Chat "Weekly plan" \[conv-1\]/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", conversationId: "conv-1", parentTaskId: "task-9" });
  assert.equal(lastOk().parentTaskId, "task-9");
  assert.deepEqual(lastOk().undoRef, { kind: "chat-lifecycle", value: "snoozed:2026-08-11T13:00:00.000Z" });

  const resumed = await execute(["chat", "resume", "--space", "space-1", "--conversation", "conv-1"]);
  assert.match(resumed.stdout, /Resumed Chat "Weekly plan" \[conv-1\] in Fold Space \[space-1\] \(was archived\)\./);
  assert.deepEqual(lastOk().undoRef, { kind: "chat-lifecycle", value: "archived" });

  const emptyList = await execute(["history", "list", "--space", "space-1"]);
  assert.match(emptyList.stdout, /No restore points saved in Fold Space \[space-1\]\./);
  assert.equal(lastOk().undoRef, undefined);

  const saved = await execute(["history", "save", "--space", "space-1", "--label", "draft one"]);
  assert.match(saved.stdout, /Saved restore point cp-20260810120000-aaaaaaaa \(3 files\) in Fold Space \[space-1\]\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", label: "draft one" });
  assert.equal(lastOk().checkpointId, "cp-20260810120000-aaaaaaaa");
  assert.equal(lastOk().detail, "created restore point");

  saveCreated = false;
  const unchanged = await execute(["history", "save", "--space", "space-1"]);
  assert.match(unchanged.stdout, /already matches restore point cp-20260810120000-aaaaaaaa; no new restore point was created\./);
  assert.equal(lastOk().detail, "already matches the latest restore point");

  const restored = await execute(["history", "restore", "--space", "space-1", "--checkpoint", "cp-20260810120000-aaaaaaaa"]);
  assert.match(restored.stdout, /Restored Fold Space \[space-1\] to restore point cp-20260810120000-aaaaaaaa\./);
  assert.match(restored.stdout, /2 file\(s\) restored; 1 deleted; 0 moved back; 4 unchanged\./);
  assert.match(restored.stdout, /History skipped 1 oversized file recorded by that restore point\./);
  assert.match(restored.stdout, /Safety restore point: cp-20260810120100-bbbbbbbb/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", checkpointId: "cp-20260810120000-aaaaaaaa" });
  assert.equal(lastOk().checkpointId, "cp-20260810120000-aaaaaaaa");
  assert.deepEqual(lastOk().undoRef, { kind: "safety-checkpoint", value: "cp-20260810120100-bbbbbbbb" });

  const versions = await execute(["history", "versions", "--space", "space-1", "--path", "docs/plan.md"]);
  assert.match(versions.stdout, /1 saved version of docs\/plan\.md in Fold Space \[space-1\]:/);
  assert.match(versions.stdout, new RegExp(`- ${"e".repeat(64)} — captured`));
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", path: "docs/plan.md" });

  const restoredFile = await execute([
    "history", "restore-file", "--space", "space-1", "--path", "docs/plan.md", "--version", "e".repeat(64),
  ]);
  assert.match(restoredFile.stdout, new RegExp(`Restored docs/plan\\.md to version ${"e".repeat(64)}`));
  assert.match(restoredFile.stdout, /Safety restore point: cp-20260810120200-cccccccc/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", path: "docs/plan.md", version: "e".repeat(64) });
  assert.equal(lastOk().checkpointId, "cp-20260810120200-cccccccc");
  assert.deepEqual(lastOk().undoRef, { kind: "safety-checkpoint", value: "cp-20260810120200-cccccccc" });

  // chat compact dispatches with the kernel-task discipline: the receipt
  // carries the compaction task id and no undo reference — compaction is
  // additive summarization, not deletion.
  const compact = await execute(["chat", "compact", "--space", "space-1", "--conversation", "conv-1", "--parent-task", "task-9"]);
  assert.equal(compact.exitCode, 0);
  assert.match(compact.stdout, /Compacted Chat \[conv-1\] in Fold Space \[space-1\] \(task task-compact-1\)\./);
  assert.match(compact.stdout, /additive summarization; nothing was deleted\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", conversationId: "conv-1", parentTaskId: "task-9" });
  assert.equal(lastOk().taskId, "task-compact-1");
  assert.equal(lastOk().conversationId, "conv-1");
  assert.equal(lastOk().undoRef, undefined);
});

test("file, search, and Library acts dispatch to the facade, stamp receipts, and render bespoke output", async () => {
  const spaceRef = { id: "space-1", name: "Fold Space", spaceRoot: "/tmp/fold" };
  const calls: Array<{ method: string; input?: unknown }> = [];
  let searchResult: Record<string, unknown> = {};
  /** Swapped per case: a delete History covered, then one it could not. */
  let deleteRecovery: Record<string, unknown> = { kind: "history" as const };
  const facade = {
    filesMove: async (input: unknown) => {
      calls.push({ method: "filesMove", input });
      return {
        space: spaceRef,
        fromPath: "docs/plan.md",
        path: "archive/plan.md",
        kind: "file" as const,
        safetyCheckpointId: "cp-20260810130000-aaaaaaaa",
      };
    },
    filesRename: async (input: unknown) => {
      calls.push({ method: "filesRename", input });
      return {
        space: spaceRef,
        fromPath: "docs/plan.md",
        path: "docs/plan-2026.md",
        priorName: "plan.md",
        kind: "file" as const,
        safetyCheckpointId: "cp-20260810130100-bbbbbbbb",
      };
    },
    filesDelete: async (input: unknown) => {
      calls.push({ method: "filesDelete", input });
      return {
        space: spaceRef,
        deleted: true,
        path: "docs/old.md",
        kind: "file" as const,
        safetyCheckpointId: "cp-20260810130200-cccccccc",
        recovery: deleteRecovery,
      };
    },
    trashList: async () => {
      calls.push({ method: "trashList" });
      return {
        entries: [{
          id: "trash-20260910083000-53db781d",
          kind: "folder" as const,
          reason: "files.delete" as const,
          spaceId: "space-1",
          spaceName: "Fold Space",
          originalPath: "Drafts",
          name: "Drafts",
          sizeBytes: 12_400,
          deletedAt: "2026-09-10T08:30:00.000Z",
          restoreBy: "2026-10-10T08:30:00.000Z",
          receiptId: "req-1",
          restorable: "in-place" as const,
        }],
        retentionDays: 30,
        damagedCount: 0,
      };
    },
    trashRestore: async (input: unknown) => {
      calls.push({ method: "trashRestore", input });
      return {
        entry: {
          id: "trash-20260910083000-53db781d",
          kind: "folder" as const,
          reason: "files.delete" as const,
          spaceId: "space-1",
          spaceName: "Fold Space",
          originalPath: "Drafts",
          name: "Drafts",
          sizeBytes: 12_400,
          deletedAt: "2026-09-10T08:30:00.000Z",
          restoreBy: "2026-10-10T08:30:00.000Z",
          receiptId: "req-1",
          restorable: "in-place" as const,
        },
        restored: {
          kind: "folder" as const,
          space: spaceRef,
          path: "Drafts-2",
          renamed: true,
          safetyCheckpointId: "cp-20260910083100-aaaabbbb",
        },
      };
    },
    filesMkdir: async (input: unknown) => {
      calls.push({ method: "filesMkdir", input });
      return {
        space: spaceRef,
        created: true,
        path: "notes",
        kind: "folder" as const,
        safetyCheckpointId: "cp-20260810130300-dddddddd",
      };
    },
    filesCreate: async (input: unknown) => {
      calls.push({ method: "filesCreate", input });
      return {
        space: spaceRef,
        created: true,
        path: "notes/todo.md",
        kind: "file" as const,
        safetyCheckpointId: "cp-20260810130400-eeeeeeee",
      };
    },
    search: async (input: unknown) => {
      calls.push({ method: "search", input });
      return searchResult;
    },
    libraryList: async () => {
      calls.push({ method: "libraryList" });
      return {
        items: [
          { path: "Receipts", kind: "folder" as const },
          { path: "Receipts/one.pdf", kind: "file" as const, sizeBytes: 12 },
        ],
        truncated: false,
      };
    },
    libraryCopy: async (input: unknown) => {
      calls.push({ method: "libraryCopy", input });
      return {
        space: spaceRef,
        item: "Receipts/one.pdf",
        copied: "From Library/one.pdf",
        checkpointId: "cp-20260810130500-ffffffff",
      };
    },
    libraryAdd: async (input: unknown) => {
      calls.push({ method: "libraryAdd", input });
      return {
        added: [
          { path: "Receipts/two.pdf", sizeBytes: 9 },
          { path: "Receipts/three.pdf", sizeBytes: 10 },
        ],
      };
    },
    libraryFolderCreate: async (input: unknown) => {
      calls.push({ method: "libraryFolderCreate", input });
      return { created: true, path: "Contracts" };
    },
  } as unknown as WorkFoldActFacade;
  const records: Array<Record<string, unknown>> = [];
  const execute = (argv: string[]) => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      resolveLineageParent: (taskId) => (taskId === "task-9" ? { taskId } : null),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          records.push({ ...record });
          return true;
        },
      },
    },
  );
  const lastOk = () => records.filter((record) => record.outcome === "ok").at(-1)!;

  const moved = await execute(["files", "move", "--space", "space-1", "--from", "docs/plan.md", "--to", "archive"]);
  assert.equal(moved.exitCode, 0);
  assert.match(moved.stdout, /Moved docs\/plan\.md to archive\/plan\.md in Fold Space \[space-1\]\./);
  assert.match(moved.stdout, /Safety restore point: cp-20260810130000-aaaaaaaa/);
  assert.deepEqual(calls.at(-1), { method: "filesMove", input: { space: "space-1", fromPath: "docs/plan.md", toDir: "archive" } });
  assert.equal(lastOk().checkpointId, "cp-20260810130000-aaaaaaaa");
  assert.deepEqual(lastOk().undoRef, { kind: "safety-checkpoint", value: "cp-20260810130000-aaaaaaaa" });
  assert.equal(lastOk().detail, "moved to archive/plan.md");

  const renamed = await execute(["files", "rename", "--space", "space-1", "--path", "docs/plan.md", "--name", "plan-2026.md", "--parent-task", "task-9"]);
  assert.match(renamed.stdout, /Renamed docs\/plan\.md to docs\/plan-2026\.md in Fold Space \[space-1\]\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", path: "docs/plan.md", newName: "plan-2026.md", parentTaskId: "task-9" });
  assert.equal(lastOk().parentTaskId, "task-9");
  assert.equal(lastOk().checkpointId, "cp-20260810130100-bbbbbbbb");
  assert.deepEqual(lastOk().undoRef, { kind: "entry-name", value: "plan.md" });

  const deleted = await execute(["files", "delete", "--space", "space-1", "--path", "docs/old.md"]);
  assert.match(deleted.stdout, /Deleted file docs\/old\.md in Fold Space \[space-1\]\./);
  assert.match(deleted.stdout, /Safety restore point: cp-20260810130200-cccccccc — restore it with 'history restore' to undo this delete\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", path: "docs/old.md" });
  assert.equal(lastOk().checkpointId, "cp-20260810130200-cccccccc");
  assert.deepEqual(lastOk().undoRef, { kind: "safety-checkpoint", value: "cp-20260810130200-cccccccc" });

  // F20: when History could not keep a copy of every matched file, the delete
  // still goes through, names why, and its undo reference is the Recently
  // deleted item rather than the partial restore point.
  deleteRecovery = {
    kind: "trash" as const,
    entryId: "trash-20260910083000-53db781d",
    restoreBy: "2026-10-10T08:30:00.000Z",
    uncovered: [
      { path: "docs/big.iso", reason: "too_large" as const },
      { path: "docs/link.md", reason: "symbolic_link" as const },
    ],
  };
  const movedToTrash = await execute(["files", "delete", "--space", "space-1", "--path", "docs/old.md"]);
  assert.match(movedToTrash.stdout, /It is in Recently deleted until 2026-10-10T08:30:00\.000Z because History could not keep a copy of 2 files: docs\/big\.iso \(too large\); docs\/link\.md \(a link\)\./);
  assert.match(movedToTrash.stdout, /Put it back with 'trash restore --entry trash-20260910083000-53db781d'/);
  assert.equal(lastOk().detail, "trash trash-20260910083000-53db781d");
  assert.deepEqual(lastOk().undoRef, { kind: "trash-entry", value: "trash-20260910083000-53db781d" });
  assert.equal(lastOk().checkpointId, "cp-20260810130200-cccccccc", "the restore point still covered what it could");
  deleteRecovery = { kind: "history" as const };

  // Recently deleted's own verbs: a content-free listing and a restore whose
  // undo is the additive restore point it recorded.
  const trashListed = await execute(["trash", "list"]);
  assert.match(trashListed.stdout, /1 item\(s\) in Recently deleted \(kept 30 days\):/);
  assert.match(trashListed.stdout, /- trash-20260910083000-53db781d — folder "Drafts" from Fold Space \[space-1\] — 12400 bytes/);
  assert.match(trashListed.stdout, /kept until 2026-10-10T08:30:00\.000Z/);
  assert.deepEqual(calls.at(-1), { method: "trashList" });

  const trashRestored = await execute(["trash", "restore", "--entry", "trash-20260910083000-53db781d"]);
  assert.match(trashRestored.stdout, /Restored folder Drafts-2 to Fold Space \[space-1\] under a new name, because the old one was taken\./);
  assert.equal((calls.at(-1) as { input: { entry: string } }).input.entry, "trash-20260910083000-53db781d");
  assert.equal(lastOk().spaceId, "space-1");
  assert.equal(lastOk().detail, "entry trash-20260910083000-53db781d; kind folder; restored Drafts-2");
  assert.deepEqual(lastOk().undoRef, { kind: "safety-checkpoint", value: "cp-20260910083100-aaaabbbb" });

  const madeFolder = await execute(["files", "mkdir", "--space", "space-1", "--path", "notes"]);
  assert.match(madeFolder.stdout, /Created folder notes in Fold Space \[space-1\]\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", path: "notes" });
  assert.equal(lastOk().checkpointId, undefined, "creation receipts deliberately carry no restore-point reference");
  assert.deepEqual(lastOk().undoRef, { kind: "created-path", value: "notes" });

  const createdFile = await execute(["files", "create", "--space", "space-1", "--path", "notes/todo.md"]);
  assert.match(createdFile.stdout, /Created empty file notes\/todo\.md in Fold Space \[space-1\]\./);
  assert.equal(lastOk().checkpointId, undefined);
  assert.deepEqual(lastOk().undoRef, { kind: "created-path", value: "notes/todo.md" });

  // Search renders bounded matches, discloses a stopped bound, and its
  // receipt records the scope but never the query text.
  searchResult = {
    space: spaceRef,
    scope: "files",
    query: "quarterly budget",
    files: [{ path: "notes/plan.md", line: 2, preview: "the Quarterly budget is due" }],
    chats: [],
    truncated: true,
    scannedFiles: 41,
  };
  const searched = await execute(["search", "--space", "space-1", "--query", "quarterly budget", "--scope", "files"]);
  assert.match(searched.stdout, /1 match for "quarterly budget" in Fold Space \[space-1\] \(scope files\):/);
  assert.match(searched.stdout, /- notes\/plan\.md:2 — the Quarterly budget is due/);
  assert.match(searched.stdout, /A search bound stopped before covering everything/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", query: "quarterly budget", scope: "files" });
  assert.equal(lastOk().detail, "scope files");
  assert.doesNotMatch(JSON.stringify(records), /quarterly/, "receipts never record the query text");

  searchResult = { space: spaceRef, scope: "all", query: "nothing here", files: [], chats: [], truncated: false, scannedFiles: 3 };
  const emptySearch = await execute(["search", "--space", "space-1", "--query", "nothing here"]);
  assert.match(emptySearch.stdout, /No matches for "nothing here" in Fold Space \[space-1\] \(scope all\)\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", query: "nothing here" });

  const listed = await execute(["library", "list"]);
  assert.match(listed.stdout, /2 Library items:/);
  assert.match(listed.stdout, /- Receipts\//);
  assert.match(listed.stdout, /- Receipts\/one\.pdf/);
  assert.deepEqual(calls.at(-1), { method: "libraryList" });

  const copied = await execute(["library", "copy", "--item", "Receipts/one.pdf", "--space", "space-1"]);
  assert.match(copied.stdout, /Copied Receipts\/one\.pdf from the Library to From Library\/one\.pdf in Fold Space \[space-1\]\./);
  assert.match(copied.stdout, /Restore point: cp-20260810130500-ffffffff/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", item: "Receipts/one.pdf" });
  assert.equal(lastOk().checkpointId, "cp-20260810130500-ffffffff");
  assert.equal(lastOk().detail, "copied to From Library/one.pdf");

  // library add is personal and Space-free: no --space, no restore point,
  // and its receipt records the added-file count only.
  const addedToLibrary = await execute(["library", "add", "--from", "receipts/two.pdf", "--from", "receipts/three.pdf", "--to", "Receipts", "--parent-task", "task-9"]);
  assert.equal(addedToLibrary.exitCode, 0);
  assert.match(addedToLibrary.stdout, /Added 2 files to the Library:/);
  assert.match(addedToLibrary.stdout, /- Receipts\/two\.pdf/);
  assert.match(addedToLibrary.stdout, /personal and Space-free, so no restore point applies\./);
  assert.deepEqual(calls.at(-1)?.input, {
    fromPaths: ["receipts/two.pdf", "receipts/three.pdf"],
    toDir: "Receipts",
    cwd,
    parentTaskId: "task-9",
  });
  assert.equal(lastOk().detail, "added 2 file(s) to the Library");
  assert.equal(lastOk().spaceId, undefined, "the Library carries no Space id");
  assert.equal(lastOk().checkpointId, undefined, "History is a Space concept; the Library records no restore point");
  assert.throws(
    () => parseWorkFoldCliActArgv(["library", "add", "--from", "x.pdf", "--space", "space-1"]),
    /--space cannot be used with 'library add'/,
  );

  const createdLibraryFolder = await execute(["library", "folder", "create", "--name", "Contracts"]);
  assert.match(createdLibraryFolder.stdout, /Created Library folder Contracts\./);
  assert.deepEqual(calls.at(-1)?.input, { name: "Contracts" });
  assert.equal(lastOk().detail, "Library folder Contracts");
  assert.equal(lastOk().undoRef, undefined, "no in-product Library removal verb exists, so there is no undo reference");

  // Permanent deletion left the vocabulary (docs/receipts-not-gates.md, F20).
  assert.throws(
    () => parseWorkFoldCliActArgv(["files", "destroy"]),
    /Unknown command: files destroy/,
  );
});

test("Space, appearance, tools, and App Studio acts dispatch to the facade, stamp receipts, and render bespoke output", async () => {
  const spaceRef = { id: "space-1", name: "Fold Space", spaceRoot: "/tmp/fold" };
  const targetRef = { id: "space-2", name: "Target Space", spaceRoot: "/tmp/target" };
  const releaseDigest = `sha256:${"a".repeat(64)}`;
  const priorDigest = `sha256:${"b".repeat(64)}`;
  const calls: Array<{ method: string; input?: unknown }> = [];
  let toolsRemoved = true;
  const facade = {
    assistantShow: async (input: unknown) => {
      calls.push({ method: "assistantShow", input });
      return {
        space: spaceRef,
        model: { provider: "openrouter", id: "example/model" },
        availableModels: [{ provider: "openrouter", id: "example/model", name: "Example Model", reasoning: true }],
        instructions: "Keep it concise.",
      };
    },
    assistantSetModel: async (input: unknown) => {
      calls.push({ method: "assistantSetModel", input });
      return { space: spaceRef, model: { provider: "openrouter", id: "example/model" } };
    },
    assistantSetInstructions: async (input: unknown) => {
      calls.push({ method: "assistantSetInstructions", input });
      return { space: spaceRef, instructions: (input as { instructions: string }).instructions };
    },
    spacesRename: async (input: unknown) => {
      calls.push({ method: "spacesRename", input });
      return { space: { ...spaceRef, name: "Fold Prime" }, priorName: "Fold Space" };
    },
    spacesUnregister: async (input: unknown) => {
      calls.push({ method: "spacesUnregister", input });
      return { space: spaceRef, storage: "linked" as const, removed: true, cleanupPending: false };
    },
    spacesAppearanceApply: async (input: unknown) => {
      calls.push({ method: "spacesAppearanceApply", input });
      return {
        space: spaceRef,
        applied: true,
        proposalName: "Calm blue",
        appearanceRef: "sha256:1111111111111111",
        priorAppearanceRef: null,
      };
    },
    spacesAppearanceReset: async (input: unknown) => {
      calls.push({ method: "spacesAppearanceReset", input });
      return {
        space: spaceRef,
        reset: true,
        changed: true,
        priorAppearanceRef: "sha256:1111111111111111",
      };
    },
    spacesAppearanceUndo: async (input: unknown) => {
      calls.push({ method: "spacesAppearanceUndo", input });
      return {
        space: spaceRef,
        restored: true,
        restoredAppearanceRef: "sha256:1111111111111111",
        displacedAppearanceRef: null,
      };
    },
    toolsRemove: async (input: unknown) => {
      calls.push({ method: "toolsRemove", input });
      const scoped = (input as { scope: "personal" | "space"; space?: string; source: string });
      return {
        scope: scoped.scope,
        ...(scoped.scope === "space" ? { space: spaceRef } : {}),
        source: scoped.source,
        removed: toolsRemoved,
      };
    },
    appsProjectDeclare: async (input: unknown) => {
      calls.push({ method: "appsProjectDeclare", input });
      return {
        space: spaceRef,
        project: { projectId: "project_1", presentation: { title: "Connected Inbox", description: null, icon: "mail" } },
        priorPresentation: null,
        priorPresentationRef: null,
      };
    },
    appsReleasePrepare: async (input: unknown) => {
      calls.push({ method: "appsReleasePrepare", input });
      return {
        space: spaceRef,
        release: {
          releaseDigest,
          displayVersion: "1.0.0",
          state: "prepared" as const,
          preparedAt: createdAt,
          publishedAt: null,
          featureCount: 1,
        },
      };
    },
    appsReleasePublish: async (input: unknown) => {
      calls.push({ method: "appsReleasePublish", input });
      return {
        space: spaceRef,
        release: {
          releaseDigest,
          displayVersion: "1.0.0",
          state: "published" as const,
          preparedAt: createdAt,
          publishedAt: createdAt,
          featureCount: 1,
        },
      };
    },
    appsReleaseDelete: async (input: unknown) => {
      calls.push({ method: "appsReleaseDelete", input });
      return { space: spaceRef, releaseDigest, deleted: true, cleanupPending: false };
    },
    appsInstallPrepare: async (input: unknown) => {
      calls.push({ method: "appsInstallPrepare", input });
      return {
        space: spaceRef,
        targetSpace: targetRef,
        operation: {
          operationId: "operation_1",
          kind: "install" as const,
          releaseDigest,
          runtimeInstanceId: "runtime-instance_1",
          targetSpaceId: targetRef.id,
          preparedAt: createdAt,
        },
      };
    },
    appsUpdatePrepare: async (input: unknown) => {
      calls.push({ method: "appsUpdatePrepare", input });
      return {
        space: spaceRef,
        targetSpace: targetRef,
        operation: {
          operationId: "operation_2",
          kind: "update" as const,
          releaseDigest,
          runtimeInstanceId: "runtime-instance_1",
          targetSpaceId: targetRef.id,
          preparedAt: createdAt,
          fromReleaseDigest: priorDigest,
          continuityPolicy: "eligible" as const,
        },
      };
    },
    appsOperationActivate: async (input: unknown) => {
      calls.push({ method: "appsOperationActivate", input });
      return {
        space: spaceRef,
        operationId: "operation_1",
        operationKind: "install" as const,
        instance: {
          runtimeInstanceId: "runtime-instance_1",
          spaceId: targetRef.id,
          releaseDigest,
          displayVersion: "1.0.0",
        },
      };
    },
    appsOperationCancel: async (input: unknown) => {
      calls.push({ method: "appsOperationCancel", input });
      return { space: spaceRef, operationId: "operation_2", cancelled: true };
    },
    appsUninstall: async (input: unknown) => {
      calls.push({ method: "appsUninstall", input });
      return {
        space: spaceRef,
        runtimeInstanceId: "runtime-instance_1",
        removed: true,
        retainedNamespaceIds: ["data-namespace_1"],
        cleanupPending: false,
      };
    },
    appsUninstallPurge: async (input: unknown) => {
      calls.push({ method: "appsUninstallPurge", input });
      return { space: spaceRef, runtimeInstanceId: "runtime-instance_1", purgedNamespaceIds: ["data-namespace_1"], removed: true, cleanupPending: true };
    },
    appsList: async (input: unknown) => {
      calls.push({ method: "appsList", input });
      return {
        space: spaceRef,
        apps: [{
          appId: "connected-inbox",
          featureInstallationId: "feature-installation_1",
          digest: "d".repeat(64),
          title: "Connected inbox",
          description: "Reads the shared inbox.",
          version: "0.1.0",
          kind: "preview" as const,
          tools: [{
            name: "summarize",
            description: "Summarize the inbox.",
            action: "summarize",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
            resultSchema: { type: "string" },
          }],
          assistantActions: [{ id: "compare", title: "Compare quotes" }],
          grants: { network: ["crm"], files: [{ declarationId: "space-notes", root: ".", access: "read-write" }], notifications: [], checks: [] },
          connections: [{ destinationId: "crm", kind: null, configured: false }],
          automations: [{ id: "daily-sync", title: "Daily sync", enabled: true, nextRunAt: createdAt, lastRunAt: null }],
        }],
        truncated: false,
      };
    },
    appsInvoke: async (input: unknown) => {
      calls.push({ method: "appsInvoke", input });
      return {
        space: spaceRef,
        appId: "connected-inbox",
        featureInstallationId: "feature-installation_1",
        digest: "d".repeat(64),
        tool: "summarize",
        action: "summarize",
        result: { summary: "Two quotes, North is cheaper." },
      };
    },
    appsProposalsList: async (input: unknown) => {
      calls.push({ method: "appsProposalsList", input });
      return {
        space: spaceRef,
        conversationId: "conv-1",
        proposals: [{
          id: "proposal-1",
          status: "pending" as const,
          sourcePath: "apps/inbox",
          title: "Connected inbox",
          packageName: "connected-inbox",
          version: "0.1.0",
          digest: "d".repeat(64),
          createdAt,
          updatedAt: createdAt,
        }],
      };
    },
    appsProposalsDismiss: async (input: unknown) => {
      calls.push({ method: "appsProposalsDismiss", input });
      return { space: spaceRef, proposalId: "proposal-1", dismissed: true };
    },
    appsRemove: async (input: unknown) => {
      calls.push({ method: "appsRemove", input });
      return {
        space: spaceRef,
        appId: "connected-inbox",
        digest: "d".repeat(64),
        removed: true,
        trash: { entryId: "trash-app-1", restoreBy: "2026-10-10T00:00:00.000Z" },
      };
    },
    appsRevoke: async (input: unknown) => {
      calls.push({ method: "appsRevoke", input });
      const scoped = input as { kind: "network" | "files" | "notifications"; declaration: string };
      return {
        space: spaceRef,
        appId: "connected-inbox",
        grantKind: scoped.kind,
        declaration: scoped.declaration,
        revoked: scoped.declaration !== "never-granted",
      };
    },
    appsDisconnect: async (input: unknown) => {
      calls.push({ method: "appsDisconnect", input });
      return { space: spaceRef, appId: "connected-inbox", destination: "crm", disconnected: true };
    },
    appsAutomationDisable: async (input: unknown) => {
      calls.push({ method: "appsAutomationDisable", input });
      return { space: spaceRef, appId: "connected-inbox", automationId: "daily-sync", disabled: true, wasEnabled: true };
    },
    appsAutomationRun: async (input: unknown) => {
      calls.push({ method: "appsAutomationRun", input });
      return {
        space: spaceRef,
        appId: "connected-inbox",
        automationId: "daily-sync",
        run: { runId: "run-77", outcome: "success" as const, startedAt: createdAt, finishedAt: createdAt },
      };
    },
  } as unknown as WorkFoldActFacade;
  const records: Array<Record<string, unknown>> = [];
  const execute = (argv: string[]) => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      resolveLineageParent: (taskId) => (taskId === "task-9" ? { taskId } : null),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          records.push({ ...record });
          return true;
        },
      },
    },
  );
  const lastOk = () => records.filter((record) => record.outcome === "ok").at(-1)!;

  const renamed = await execute(["spaces", "rename", "--space", "space-1", "--name", "Fold Prime"]);
  assert.equal(renamed.exitCode, 0);
  assert.match(renamed.stdout, /Renamed Space Fold Prime \[space-1\] \(was "Fold Space"\)\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", name: "Fold Prime" });
  assert.equal(lastOk().spaceId, "space-1");
  assert.deepEqual(lastOk().undoRef, { kind: "space-name", value: "Fold Space" });

  const unregistered = await execute(["spaces", "unregister", "--space", "space-1", "--parent-task", "task-9"]);
  assert.match(unregistered.stdout, /Unregistered linked Space Fold Space \[space-1\]\./);
  assert.match(unregistered.stdout, /The folder remains at \/tmp\/fold with its portable \.work-fold identity/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", parentTaskId: "task-9" });
  assert.equal(lastOk().parentTaskId, "task-9");
  assert.equal(lastOk().detail, "storage linked");
  assert.deepEqual(lastOk().undoRef, { kind: "space-root", value: "/tmp/fold" });

  const assistant = await execute(["spaces", "assistant", "show", "--space", "space-1"]);
  assert.match(assistant.stdout, /Default model for new Chats: openrouter\/example\/model/);
  assert.match(assistant.stdout, /Example Model \(openrouter\/example\/model\)/);
  assert.match(assistant.stdout, /Keep it concise\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1" });

  const assigned = await execute(["spaces", "assistant", "model", "--space", "space-1", "--provider", "openrouter", "--model", "example/model", "--parent-task", "task-9"]);
  assert.match(assigned.stdout, /default for new Chats/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", provider: "openrouter", model: "example/model", parentTaskId: "task-9" });
  assert.equal(lastOk().detail, "provider openrouter; model example/model");

  const instructed = await execute(["spaces", "assistant", "instructions", "--space", "space-1", "--instructions", "Use the glossary.", "--parent-task", "task-9"]);
  assert.match(instructed.stdout, /Saved Space instructions/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", instructions: "Use the glossary.", parentTaskId: "task-9" });
  assert.equal(lastOk().detail, "updated; 17 character(s)");
  assert.doesNotMatch(JSON.stringify(records), /Use the glossary\./, "receipts never record Space instruction content");

  const applied = await execute(["spaces", "appearance", "apply", "--space", "space-1", "--proposal", "calm.work-fold-appearance.json"]);
  assert.match(applied.stdout, /Applied appearance proposal "Calm blue" to Fold Space \[space-1\] \(was the default appearance\)\./);
  assert.match(applied.stdout, /Undo it with 'spaces appearance undo'\./);
  assert.deepEqual(calls.at(-1)?.input, {
    space: "space-1",
    proposalPath: "calm.work-fold-appearance.json",
    cwd,
  });
  assert.equal(lastOk().detail, "applied sha256:1111111111111111");
  assert.deepEqual(lastOk().undoRef, { kind: "appearance-ref", value: "none" });

  const resetOutcome = await execute(["spaces", "appearance", "reset", "--space", "space-1"]);
  assert.match(resetOutcome.stdout, /Reset Fold Space \[space-1\] to the default appearance \(was sha256:1111111111111111\)\./);
  assert.deepEqual(lastOk().undoRef, { kind: "appearance-ref", value: "sha256:1111111111111111" });

  const undone = await execute(["spaces", "appearance", "undo", "--space", "space-1"]);
  assert.match(undone.stdout, /Restored Fold Space \[space-1\] to sha256:1111111111111111\. Running 'spaces appearance undo' again swaps back\./);
  assert.equal(lastOk().detail, "restored sha256:1111111111111111");
  assert.deepEqual(lastOk().undoRef, { kind: "appearance-ref", value: "none" });

  const removedPersonal = await execute(["tools", "remove", "--scope", "personal", "--source", "@example/pkg"]);
  assert.match(removedPersonal.stdout, /Removed package @example\/pkg \(personal scope\)\. Reinstalling it is a fresh receipted act/);
  assert.deepEqual(calls.at(-1)?.input, { scope: "personal", source: "@example/pkg" });
  assert.equal(lastOk().detail, "scope personal; source @example/pkg");
  assert.equal(lastOk().spaceId, undefined);

  toolsRemoved = false;
  const removedSpace = await execute(["tools", "remove", "--scope", "space", "--space", "space-1", "--source", "./tools/pkg"]);
  assert.match(removedSpace.stdout, /Package \.\/tools\/pkg is not installed \(Space scope in Fold Space \[space-1\]\); nothing was removed\./);
  assert.deepEqual(calls.at(-1)?.input, { scope: "space", space: "space-1", source: "./tools/pkg" });
  assert.equal(lastOk().detail, "scope space; source ./tools/pkg (not installed)");
  assert.equal(lastOk().spaceId, "space-1");

  const declared = await execute(["apps", "project", "declare", "--space", "space-1", "--presentation", "presentation.json"]);
  assert.match(declared.stdout, /Declared App Project presentation "Connected Inbox" \[project_1\] in Fold Space \[space-1\]\. This is the Project's first declared presentation\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", presentationPath: "presentation.json", cwd });
  assert.deepEqual(lastOk().undoRef, { kind: "app-presentation-ref", value: "none" });

  const prepared = await execute(["apps", "release", "prepare", "--space", "space-1", "--version", "1.0.0"]);
  assert.match(prepared.stdout, /Prepared Release 1\.0\.0 \[sha256:a+\] in Fold Space \[space-1\] \(1 Feature\)\./);
  assert.match(prepared.stdout, /Later source edits cannot alter its bytes/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", version: "1.0.0" });
  assert.equal(lastOk().detail, `release ${releaseDigest}`);
  assert.deepEqual(lastOk().undoRef, { kind: "release-digest", value: releaseDigest });

  const published = await execute(["apps", "release", "publish", "--space", "space-1", "--release", releaseDigest]);
  assert.match(published.stdout, /Published Release 1\.0\.0 \[sha256:a+\] in Fold Space \[space-1\]\./);
  assert.match(published.stdout, /local state transition — nothing is uploaded, hosted, listed, or granted\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", release: releaseDigest });

  const installPrepared = await execute(["apps", "install", "prepare", "--space", "space-1", "--release", releaseDigest, "--target-space", "space-2"]);
  assert.match(installPrepared.stdout, /Prepared install of Release \[sha256:a+\] into Target Space \[space-2\] — operation operation_1\./);
  assert.match(installPrepared.stdout, /every power starts off\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", release: releaseDigest, targetSpace: "space-2" });
  assert.equal(lastOk().detail, "operation operation_1");
  assert.deepEqual(lastOk().undoRef, { kind: "operation-id", value: "operation_1" });

  const activated = await execute(["apps", "operation", "activate", "--space", "space-1", "--operation", "operation_1"]);
  assert.match(activated.stdout, /Activated install operation operation_1: instance runtime-instance_1 now runs Release 1\.0\.0 \[sha256:a+\]\. Every power starts off\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", operation: "operation_1" });
  assert.equal(lastOk().detail, `operation operation_1; release ${releaseDigest}`);

  const updatePrepared = await execute(["apps", "update", "prepare", "--space", "space-1", "--instance", "runtime-instance_1", "--release", releaseDigest]);
  assert.match(updatePrepared.stdout, /Prepared update of instance runtime-instance_1 from Release \[sha256:b+\] to \[sha256:a+\] — operation operation_2\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", instance: "runtime-instance_1", release: releaseDigest });
  assert.equal(lastOk().detail, `operation operation_2; from ${priorDigest}; to ${releaseDigest}`);
  assert.deepEqual(lastOk().undoRef, { kind: "operation-id", value: "operation_2" });

  const cancelled = await execute(["apps", "operation", "cancel", "--space", "space-1", "--operation", "operation_2"]);
  assert.match(cancelled.stdout, /Cancelled prepared operation operation_2\. Prepare it again when needed\./);
  assert.equal(lastOk().detail, "operation operation_2");

  const uninstalled = await execute(["apps", "uninstall", "--space", "space-1", "--instance", "runtime-instance_1", "--retain-data"]);
  assert.match(uninstalled.stdout, /Uninstalled instance runtime-instance_1 from Fold Space \[space-1\], retaining 1 data namespace\./);
  assert.match(uninstalled.stdout, /Retained data does not remain runnable, and reinstalling creates a new instance\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", instance: "runtime-instance_1" });
  assert.equal(lastOk().detail, "instance runtime-instance_1; retained data-namespace_1");

  const deletedRelease = await execute(["apps", "release", "delete", "--space", "space-1", "--release", releaseDigest]);
  assert.match(deletedRelease.stdout, /Deleted unused Release \[sha256:a+\] in Fold Space \[space-1\]\./);
  assert.equal(lastOk().detail, `release ${releaseDigest}`);
  assert.equal(lastOk().undoRef, undefined);

  // The fold reads what an app can do, then runs one of its declared tools.
  const listedApps = await execute(["apps", "list", "--space", "space-1"]);
  assert.match(listedApps.stdout, /1 app in Fold Space \[space-1\]:/);
  assert.match(listedApps.stdout, /- Connected inbox 0\.1\.0 \[connected-inbox\] \(preview\)/);
  assert.match(listedApps.stdout, /tools: summarize/);
  assert.match(listedApps.stdout, /automations: daily-sync on/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1" });
  assert.equal(lastOk().detail, "apps 1");
  const listedJson = JSON.parse((await execute(["apps", "list", "--space", "space-1", "--json"])).stdout);
  assert.equal(listedJson.data.apps[0].tools[0].inputSchema.type, "object", "a caller can build --input from the listing alone");
  assert.deepEqual(listedJson.data.apps[0].assistantActions, [{ id: "compare", title: "Compare quotes" }]);

  const invoked = await execute(["apps", "invoke", "--space", "space-1", "--app", "connected-inbox", "--tool", "summarize", "--input", "{\"text\":\"North $42\"}", "--parent-task", "task-9"]);
  assert.match(invoked.stdout, /Ran summarize of connected-inbox in Fold Space \[space-1\]\./);
  assert.match(invoked.stdout, /Two quotes, North is cheaper\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", app: "connected-inbox", tool: "summarize", input: { text: "North $42" }, parentTaskId: "task-9" });
  assert.equal(lastOk().parentTaskId, "task-9");
  assert.match(String(lastOk().detail), /^app connected-inbox; tool summarize; result \d+ bytes$/);

  // The Space-app authority direct verbs: narrowing, neutral, and widening
  // alike, with honest receipt details. Under F21 `apps grant` is a direct
  // receipted verb too; nothing here waits on a second act.
  const proposals = await execute(["apps", "proposals", "list", "--space", "space-1", "--conversation", "conv-1"]);
  assert.match(proposals.stdout, /1 app proposal in Chat \[conv-1\] of Fold Space \[space-1\]:/);
  assert.match(proposals.stdout, /- Connected inbox 0\.1\.0 \[proposal-1\] — pending — digest d+/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", conversationId: "conv-1" });

  const dismissed = await execute(["apps", "proposals", "dismiss", "--space", "space-1", "--conversation", "conv-1", "--proposal", "proposal-1"]);
  assert.match(dismissed.stdout, /Dismissed app proposal proposal-1 in Fold Space \[space-1\]\. Nothing runnable existed; the Assistant may propose again\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", conversationId: "conv-1", proposal: "proposal-1" });
  assert.equal(lastOk().detail, "proposal proposal-1");

  const removedApp = await execute(["apps", "remove", "--space", "space-1", "--app", "connected-inbox"]);
  assert.match(removedApp.stdout, /Removed app connected-inbox \[digest d+\] from Fold Space \[space-1\]\. Reinstalling it is a fresh receipted act/);
  // Removing a preview takes its data with it, so the removal names the
  // recoverable copy it left behind (docs/receipts-not-gates.md, F20).
  assert.match(removedApp.stdout, /Its data is in Recently deleted until 2026-10-10T00:00:00\.000Z — save it with 'trash restore --entry trash-app-1 --to <path>'\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", app: "connected-inbox", requestId: lastOk().requestId });
  assert.equal(lastOk().detail, `app connected-inbox; digest ${"d".repeat(64)}; trash trash-app-1`);

  const revoked = await execute(["apps", "revoke", "--space", "space-1", "--app", "connected-inbox", "--digest", "d".repeat(64), "--kind", "files", "--declaration", "space-notes"]);
  assert.match(revoked.stdout, /Revoked the files grant space-notes from connected-inbox in Fold Space \[space-1\]\. Re-granting it is a fresh receipted act/);
  assert.deepEqual(calls.at(-1)?.input, {
    space: "space-1",
    app: "connected-inbox",
    digest: "d".repeat(64),
    kind: "files",
    declaration: "space-notes",
  });
  assert.equal(lastOk().detail, "app connected-inbox; kind files; declaration space-notes");

  const revokeMiss = await execute(["apps", "revoke", "--space", "space-1", "--app", "connected-inbox", "--digest", "d".repeat(64), "--kind", "network", "--declaration", "never-granted"]);
  assert.match(revokeMiss.stdout, /was not granted in Fold Space \[space-1\]; authority is unchanged\./);
  assert.equal(lastOk().detail, "app connected-inbox; kind network; declaration never-granted (was not granted)");

  const disconnected = await execute(["apps", "disconnect", "--space", "space-1", "--app", "connected-inbox", "--destination", "crm"]);
  assert.match(disconnected.stdout, /Removed the saved connection to crm from connected-inbox in Fold Space \[space-1\]\./);
  assert.match(disconnected.stdout, /Deleting the local record does not revoke the credential at its provider\./);
  assert.equal(lastOk().detail, "app connected-inbox; destination crm; local record only — provider credential not revoked");

  const disabledAutomation = await execute(["apps", "automation", "disable", "--space", "space-1", "--app", "connected-inbox", "--automation", "daily-sync"]);
  assert.match(disabledAutomation.stdout, /Disabled automation daily-sync of connected-inbox in Fold Space \[space-1\]\. Re-enabling it is a fresh receipted act/);
  assert.equal(lastOk().detail, "app connected-inbox; automation daily-sync");

  const ranAutomation = await execute(["apps", "automation", "run", "--space", "space-1", "--app", "connected-inbox", "--automation", "daily-sync"]);
  assert.match(ranAutomation.stdout, /Automation daily-sync of connected-inbox ran with outcome success \(run run-77\)\./);
  assert.equal(lastOk().detail, "app connected-inbox; automation daily-sync; run run-77; outcome success");

  // The uninstall disposition executes immediately: the executor routes
  // `--purge-data` to the purge method, never to the retain-only uninstall.
  records.length = 0;
  const purge = await execute(["apps", "uninstall", "--space", "space-1", "--instance", "runtime-instance_1", "--purge-data"]);
  assert.equal(purge.exitCode, 0);
  assert.match(purge.stdout, /^Uninstalled instance runtime-instance_1 from Fold Space \[space-1\] and purged its data\.\nSome app cleanup is still pending; work-fold finishes it on the next start\.\n$/);
  assert.equal(calls.at(-1)?.method, "appsUninstallPurge");
  assert.deepEqual(records.map((record) => record.outcome), ["accepted", "ok"]);
  assert.equal(lastOk().decisionId, undefined);
  assert.equal(lastOk().detail, "app.data.purge; instance runtime-instance_1");
});

test("the ledger families ride the act protocol v3 envelope", () => {
  assert.equal(WORKFOLD_CLI_ACT_PROTOCOL_VERSION, 3);
  const id = randomUUID();
  const argv = ["spaces", "delete", "--space", "space-1"];
  const request = createWorkFoldCliActRequest({ id, argv, cwd, actToken: token });
  assert.deepEqual(
    Object.keys(request).sort(),
    ["actToken", "argv", "createdAt", "cwd", "id", "lane", "protocolVersion"],
  );
  assert.equal(request.protocolVersion, 3);
  assert.equal(request.lane, "act");
  assert.deepEqual(request.argv, argv);

  // The envelope gains no decision fields; unknown keys still fail closed.
  assert.throws(
    () => parseWorkFoldCliActRequest({
      protocolVersion: 3,
      lane: "act",
      id: randomUUID(),
      argv: ["spaces", "delete", "--space", "space-1"],
      cwd,
      createdAt,
      actToken: token,
      decisionId: "decision-1",
    }),
    /unsupported field: decisionId/,
  );
});

test("Check and correction proposals use explicit inert act verbs", () => {
  for (const verb of ["propose", "propose-fix"]) {
    assert.deepEqual(parseWorkFoldCliActArgv(["checks", verb, "--space", "space-1", "--proposal", "review.json", "--json"]), {
      name: `checks.${verb}`, space: "space-1", proposalPath: "review.json", output: "json",
    });
    assert.throws(() => parseWorkFoldCliActArgv(["checks", verb, "--proposal", "review.json"]), /space/i);
    assert.throws(() => parseWorkFoldCliActArgv(["checks", verb, "--space", "space-1", "--proposal", "review.json", "--enable"]), /flag|option/i);
  }
});


test("resource enablement verbs require exact scope, kind and path", () => {
  const args = ["--scope", "personal", "--kind", "extensions", "--path", "/tools/example.ts"];
  assert.equal(parseWorkFoldCliActArgv(["tools", "enable", ...args]).name, "tools.enable");
  assert.equal(parseWorkFoldCliActArgv(["tools", "disable", ...args]).name, "tools.disable");
  assert.throws(() => parseWorkFoldCliActArgv(["tools", "enable", "--scope", "space", "--kind", "extensions", "--path", "/tools/example.ts"]), /space/i);
  assert.throws(() => parseWorkFoldCliActArgv(["tools", "enable", "--scope", "personal", "--kind", "made-up", "--path", "/tools/example.ts"]), /kind/);
});
