import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  WORKFOLD_CLI_ACT_MAX_PAYLOAD_BYTES,
  WORKFOLD_CLI_ACT_PROTOCOL_VERSION,
  WORKFOLD_CLI_ACT_STAGED_COMMAND_NAMES,
  WorkFoldCliError,
  createWorkFoldCliActRequest,
  executeWorkFoldCliActRequest,
  isWorkFoldCliActRequest,
  isWorkFoldCliActStagedCommand,
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
    protocolVersion: 2,
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

  const base = { protocolVersion: 2, lane: "act", id: randomUUID(), argv: [], cwd, createdAt, actToken: token };
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
    protocolVersion: 2,
    lane: "act",
    id: randomUUID(),
    argv: ["chat", "create", "--space", "space-1"],
    cwd,
    createdAt,
    actToken: token,
  });
  assert.equal(isWorkFoldCliActRequest(act), true);

  assert.throws(
    () => parseWorkFoldCliRequestEnvelope({ protocolVersion: 3, id: randomUUID(), argv: [], cwd, createdAt }),
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
    parseWorkFoldCliActArgv(["files", "destroy", "--space", "space-1", "--path", "big.iso", "--path", "cache.bin"]),
    { name: "files.destroy", output: "human", space: "space-1", paths: ["big.iso", "cache.bin"] },
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
    () => parseWorkFoldCliActArgv(["files", "destroy", "--space", "s"]),
    /at least one --path/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv([
      "files",
      "destroy",
      "--space",
      "s",
      ...Array.from({ length: 26 }, (_, index) => ["--path", `file-${index}`]).flat(),
    ]),
    /At most 25 --path targets/,
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
    ["files", "destroy", "--path", "a"],
    ["history", "restore", "--checkpoint", "chk-1"],
    ["chat", "rename", "--conversation", "c", "--title", "t"],
  ]) {
    assert.throws(() => parseWorkFoldCliActArgv(argv), /explicit --space/);
  }
});

test("the never-list is refused at parse time as desktop-human-only", () => {
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
    [["policy", "create"], /Standing-policy authoring/],
    [["policies", "edit"], /Standing-policy authoring/],
    [["policy"], /Standing-policy authoring/],
    [["--json", "remote", "disable"], /Remote access administration/],
  ];
  for (const [argv, category] of refusals) {
    assert.throws(
      () => parseWorkFoldCliActArgv(argv),
      (error: unknown) =>
        error instanceof WorkFoldCliError
        && error.code === "permissionDenied"
        && category.test(error.message)
        && /desktop-human-only/.test(error.message)
        && /neither perform nor stage/.test(error.message),
      `expected never-list refusal for '${argv.join(" ")}'`,
    );
  }

  // Never-list family words remain usable as ordinary flag values.
  assert.deepEqual(
    parseWorkFoldCliActArgv(["chats", "list", "--space", "settings"]),
    { name: "chats.list", output: "human", space: "settings" },
  );
});

test("consecration staging and staged-act commands parse with strict shapes", () => {
  assert.deepEqual(
    parseWorkFoldCliActArgv(["routings", "stage", "--proposal", "fold/weekly.work-fold-routing.json"]),
    { name: "routings.stage", output: "human", proposalPath: "fold/weekly.work-fold-routing.json" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["routings", "stage", "--proposal", "weekly.json", "--parent-task", "task-1"]),
    { name: "routings.stage", output: "human", proposalPath: "weekly.json", parentTaskId: "task-1" },
  );
  // Routings are above Spaces, like the manage group.
  assert.throws(
    () => parseWorkFoldCliActArgv(["routings", "stage", "--proposal", "weekly.json", "--space", "space-1"]),
    /--space cannot be used with 'routings stage'/,
  );

  assert.deepEqual(
    parseWorkFoldCliActArgv(["pages", "stage", "--space", "space-1", "--path", "reports/weekly.md", "--title", "Weekly report"]),
    { name: "pages.stage", output: "human", space: "space-1", path: "reports/weekly.md", title: "Weekly report" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["pages", "stage", "--space", "space-1", "--path", "weekly.md", "--title", "Weekly", "--snapshot"]),
    { name: "pages.stage", output: "human", space: "space-1", path: "weekly.md", title: "Weekly", snapshot: true },
  );
  assert.throws(() => parseWorkFoldCliActArgv(["pages", "stage", "--path", "weekly.md", "--title", "W"]), /explicit --space/);
  assert.throws(
    () => parseWorkFoldCliActArgv(["pages", "stage", "--space", "space-1", "--path", "a.md", "--title", "A", "--message", "x"]),
    /--message cannot be used with 'pages stage'/,
  );

  // Rung 3: hosted-app exposure staging. The pins come from the installed
  // Instance's reviewed manifest host-side; argv names only the identity.
  assert.deepEqual(
    parseWorkFoldCliActArgv(["pages", "stage-app", "--space", "space-1", "--instance", "feature-installation-1"]),
    { name: "pages.stage-app", output: "human", space: "space-1", instance: "feature-installation-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["pages", "stage-app", "--space", "space-1", "--instance", "fi-1", "--parent-task", "task-9", "--json"]),
    { name: "pages.stage-app", output: "json", space: "space-1", instance: "fi-1", parentTaskId: "task-9" },
  );
  assert.throws(() => parseWorkFoldCliActArgv(["pages", "stage-app", "--instance", "fi-1"]), /explicit --space/);
  assert.throws(
    () => parseWorkFoldCliActArgv(["pages", "stage-app", "--space", "space-1", "--instance", "fi-1", "--title", "T"]),
    /--title cannot be used with 'pages stage-app'/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["pages", "stage-app", "--space", "space-1", "--instance", "fi-1", "--snapshot"]),
    /--snapshot cannot be used with 'pages stage-app'/,
    "apps have no snapshot lane; asleep is the only offline state",
  );

  assert.deepEqual(parseWorkFoldCliActArgv(["staged", "list"]), { name: "staged.list", output: "human" });
  assert.deepEqual(
    parseWorkFoldCliActArgv(["staged", "show", "--id", "act-1", "--json"]),
    { name: "staged.show", output: "json", stagedActId: "act-1" },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["staged", "cancel", "--id", "act-1", "--parent-task", "task-1"]),
    { name: "staged.cancel", output: "human", stagedActId: "act-1", parentTaskId: "task-1" },
  );
  // Inspection reads carry no lineage; deciding has no argv shape at all.
  assert.throws(
    () => parseWorkFoldCliActArgv(["staged", "list", "--parent-task", "task-1"]),
    /--parent-task cannot be used with 'staged list'/,
  );
  assert.throws(
    () => parseWorkFoldCliActArgv(["staged", "show", "--id", "act-1", "--parent-task", "task-1"]),
    /--parent-task cannot be used with 'staged show'/,
  );
  assert.throws(() => parseWorkFoldCliActArgv(["staged", "approve", "--id", "act-1"]), /Unknown command: staged approve/);
  assert.throws(() => parseWorkFoldCliActArgv(["staged", "decide", "--id", "act-1"]), /Unknown command: staged decide/);
});

test("consecrated verbs stage through the facade, stamp decisionId on receipts, and render the pending decision", async () => {
  const spaceRef = { id: "space-1", name: "Fold Space", spaceRoot: "/tmp/fold" };
  const expiresAt = "2026-08-12T10:00:00.000Z";
  const stagedShape = (kind: string, category: string, extra: Record<string, unknown> = {}) => ({
    decisionId: "act-11111111",
    kind,
    category,
    state: "staged" as const,
    createdAt,
    expiresAt,
    deduplicated: false,
    ...extra,
  });
  const calls: Array<{ method: string; input?: unknown }> = [];
  const facade = {
    spacesDelete: async (input: unknown) => {
      calls.push({ method: "spacesDelete", input });
      return { space: spaceRef, staged: stagedShape("space.delete-folder", "destroy") };
    },
    toolsInstall: async (input: unknown) => {
      calls.push({ method: "toolsInstall", input });
      return {
        scope: "personal",
        staged: stagedShape("capability.package.install", "make-runnable", { deduplicated: true, priorDenialAt: createdAt }),
        source: "npm:@demo/toolkit@1.2.3",
        packageId: "npm:@demo/toolkit",
        version: "1.2.3",
        resourceSummary: "1 skill(s), 1 extension(s) — executable Pi capability",
      };
    },
    appsUninstallPurge: async (input: unknown) => {
      calls.push({ method: "appsUninstallPurge", input });
      return {
        space: spaceRef,
        staged: stagedShape("app.data.purge", "destroy"),
        runtimeInstanceId: "runtime-instance_1",
        dataNamespaceIds: ["data-namespace_1"],
      };
    },
    routingsStage: async (input: unknown) => {
      calls.push({ method: "routingsStage", input });
      return {
        staged: stagedShape("routing.enable", "widen-power"),
        routingId: "routing-weekly",
        declarationDigest: "e".repeat(64),
        title: "Weekly glue",
        referencedSpaceIds: ["space-1"],
      };
    },
    pagesStage: async (input: unknown) => {
      calls.push({ method: "pagesStage", input });
      return {
        space: spaceRef,
        staged: stagedShape("publish.viewer.expose", "widen-power"),
        relativePath: "reports/weekly.md",
        title: "Weekly report",
        snapshotEnabled: false,
        serveRatePerMinute: 60,
        byteBudgetPerDay: 268435456,
      };
    },
    pagesStageApp: async (input: unknown) => {
      calls.push({ method: "pagesStageApp", input });
      return {
        space: spaceRef,
        staged: stagedShape("publish.viewer.expose", "widen-power"),
        appId: "fixture-app",
        title: "Fixture app",
        appInstanceId: "feature-installation-1",
        releaseDigest: `sha256:${"a".repeat(64)}`,
        viewerEntry: "viewer.html",
        viewerSurface: ["entry:viewer.html", "data:public/"],
        serveRatePerMinute: 60,
        byteBudgetPerDay: 268435456,
      };
    },
    appsInstallPreview: async (input: unknown) => {
      calls.push({ method: "appsInstallPreview", input });
      return {
        space: spaceRef,
        staged: stagedShape("app.review.approve", "make-runnable"),
        proposalId: "proposal-1",
        digest: "f".repeat(64),
        replacesInstalled: false,
      };
    },
  } as unknown as WorkFoldActFacade;
  const records: Array<{ outcome: string; command: string; errorCode?: string; decisionId?: string; detail?: string }> = [];
  const execute = (argv: string[]) => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          records.push({
            outcome: record.outcome,
            command: record.command,
            ...(record.errorCode ? { errorCode: record.errorCode } : {}),
            ...(record.decisionId ? { decisionId: record.decisionId } : {}),
            ...(record.detail ? { detail: record.detail } : {}),
          });
          return true;
        },
      },
    },
  );
  const lastOk = () => records.filter((record) => record.outcome === "ok").at(-1)!;

  const staged = await execute(["spaces", "delete", "--space", "space-1", "--json"]);
  assert.equal(staged.exitCode, 0);
  const stagedJson = JSON.parse(staged.stdout) as { ok: boolean; data: { staged: { decisionId: string; state: string } } };
  assert.equal(stagedJson.ok, true);
  assert.equal(stagedJson.data.staged.decisionId, "act-11111111");
  assert.equal(stagedJson.data.staged.state, "staged");
  const spacesDeleteCall = calls.at(-1)!;
  assert.equal(spacesDeleteCall.method, "spacesDelete");
  const spacesDeleteInput = spacesDeleteCall.input as { space: string; requestId?: string };
  assert.equal(spacesDeleteInput.space, "space-1");
  assert.ok(spacesDeleteInput.requestId, "the staging act's journal id rides into provenance");
  assert.deepEqual(records.map((record) => record.outcome), ["accepted", "ok"]);
  assert.equal(lastOk().decisionId, "act-11111111", "the staging receipt stamps the pending decision id");
  assert.equal(lastOk().detail, "staged space.delete-folder");

  const install = await execute(["tools", "install", "--source", "npm:@demo/toolkit", "--scope", "personal"]);
  assert.equal(install.exitCode, 0);
  assert.match(install.stdout, /Staged installing npm:@demo\/toolkit 1\.2\.3 \(personal scope\)\./);
  assert.match(install.stdout, /installs code that can run as you/);
  assert.match(install.stdout, /Decision act-11111111 expires 2026-08-12T10:00:00\.000Z; nothing runs until it is approved\./);
  assert.match(install.stdout, /An identical act was already pending; this is the existing card, not a second one\./);
  assert.match(install.stdout, /An identical act was denied at .*; the card states that\./);
  assert.equal(lastOk().decisionId, "act-11111111");
  assert.match(lastOk().detail ?? "", /^staged capability\.package\.install \(already pending\); scope personal; source npm:@demo\/toolkit@1\.2\.3; version 1\.2\.3$/);

  const purge = await execute(["apps", "uninstall", "--space", "space-1", "--instance", "runtime-instance_1", "--purge-data"]);
  assert.equal(purge.exitCode, 0);
  assert.match(purge.stdout, /Staged uninstalling instance runtime-instance_1 from Fold Space \[space-1\] with its data purged\./);
  assert.match(purge.stdout, /deletes something for good/);
  assert.equal(calls.at(-1)?.method, "appsUninstallPurge");
  assert.equal(lastOk().detail, "staged app.data.purge; instance runtime-instance_1");

  const routing = await execute(["routings", "stage", "--proposal", "fold/weekly.json"]);
  assert.equal(routing.exitCode, 0);
  assert.match(routing.stdout, /Staged enabling routing "Weekly glue" \[routing-weekly\] at digest e+\./);
  assert.match(routing.stdout, /grants a standing power/);
  assert.deepEqual(calls.at(-1)?.method, "routingsStage");
  assert.equal((calls.at(-1)?.input as { proposalPath: string }).proposalPath, "fold/weekly.json");
  assert.equal((calls.at(-1)?.input as { cwd: string }).cwd, cwd);
  assert.equal(lastOk().detail, `staged routing.enable; routing routing-weekly; digest ${"e".repeat(64)}`);

  const page = await execute(["pages", "stage", "--space", "space-1", "--path", "reports/weekly.md", "--title", "Weekly report"]);
  assert.equal(page.exitCode, 0);
  assert.match(page.stdout, /Staged sharing "Weekly report" \(reports\/weekly\.md\) from Fold Space \[space-1\] as a page — snapshot off\./);
  assert.equal(lastOk().detail, "staged publish.viewer.expose; source reports/weekly.md; serveRatePerMinute=60 byteBudgetPerDay=268435456 snapshot=off");

  const hostedApp = await execute(["pages", "stage-app", "--space", "space-1", "--instance", "feature-installation-1"]);
  assert.equal(hostedApp.exitCode, 0);
  assert.match(
    hostedApp.stdout,
    /Staged putting "Fixture app" \(App Instance feature-installation-1, Release sha256:a+\) from Fold Space \[space-1\] at your address/,
  );
  assert.match(hostedApp.stdout, /viewer-readable surface: entry:viewer\.html, data:public\//);
  assert.equal(calls.at(-1)?.method, "pagesStageApp");
  assert.equal((calls.at(-1)?.input as { instance: string }).instance, "feature-installation-1");
  assert.equal(
    lastOk().detail,
    `staged publish.viewer.expose; appInstanceId feature-installation-1; releaseDigest sha256:${"a".repeat(64)}; `
      + "viewerEntry viewer.html; viewerSurface entry:viewer.html,data:public/; serveRatePerMinute=60 byteBudgetPerDay=268435456",
  );

  // The host creates the pending review itself, so `apps install-preview`
  // stages the same app.review.approve decision the Chat proposal path uses.
  records.length = 0;
  const preview = await execute(["apps", "install-preview", "--space", "space-1", "--package", "apps/preview"]);
  assert.equal(preview.exitCode, 0);
  assert.match(preview.stdout, /Staged/);
  assert.match(preview.stdout, /Decision act-11111111 expires 2026-08-12T10:00:00\.000Z/);
  assert.equal(calls.at(-1)?.method, "appsInstallPreview");
  const previewInput = calls.at(-1)?.input as { space: string; packagePath: string; requestId?: string };
  assert.equal(previewInput.space, "space-1");
  assert.equal(previewInput.packagePath, "apps/preview");
  assert.ok(previewInput.requestId, "the staging act's journal id rides into provenance");
  assert.deepEqual(records.map((record) => record.outcome), ["accepted", "ok"]);
  assert.equal(lastOk().decisionId, "act-11111111");
  assert.match(lastOk().detail ?? "", /^staged app\.review\.approve/);

  // A never-list refusal happens at parse time: no journal entry at all.
  records.length = 0;
  const neverList = await execute(["provider", "set-key"]);
  assert.equal(neverList.exitCode, 4);
  assert.match(neverList.stderr, /Provider credentials is desktop-human-only/);
  assert.deepEqual(records, []);
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
    version: 0,
    composedAt: "2026-08-10T12:00:00.000Z",
    cursor: "2026-08-10T11:00:00.000Z/settled-turns:task-1",
    running: [{ id: "kernel-tasks:task-2", at: createdAt, kind: "assistant-turn", spaceName: "Fold Space", headline: "Assistant turn running" }],
    needsYou: [{ id: "staged-acts:act-1", at: createdAt, kind: "pending-decision", headline: "Needs your decision: routing.enable — widen a power" }],
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
  assert.equal(parsed.data.needsYou[0]?.kind, "pending-decision");

  const human = await execute(["manage", "glance"]);
  assert.match(human.stdout, /Running:\n- Assistant turn running \(Fold Space\)/);
  assert.match(human.stdout, /Needs you:\n- Needs your decision: routing\.enable/);
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
      };
    },
    filesDestroy: async (input: unknown) => {
      calls.push({ method: "filesDestroy", input });
      return {
        space: spaceRef,
        staged: {
          decisionId: "act-destroy-1",
          kind: "files.destroy",
          category: "destroy" as const,
          state: "staged" as const,
          createdAt,
          expiresAt: "2026-08-12T10:00:00.000Z",
          deduplicated: false,
        },
        paths: ["big.iso"],
        contentIdentities: [`file:sha256:${"f".repeat(64)}:9000000000`],
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

  // The staged sibling now stages for real: a delete History cannot cover
  // refuses into `files destroy`, which composes observed identities and
  // returns the pending decision instead of executing anything.
  const destroy = await execute(["files", "destroy", "--space", "space-1", "--path", "big.iso"]);
  assert.equal(destroy.exitCode, 0);
  assert.match(destroy.stdout, /Staged destroying 1 path in Fold Space \[space-1\] that no restore point can cover\./);
  assert.match(destroy.stdout, /deletes something for good/);
  assert.deepEqual(calls.at(-1)?.method, "filesDestroy");
  assert.deepEqual((calls.at(-1)?.input as { paths: string[] }).paths, ["big.iso"]);
  assert.equal(lastOk().decisionId, "act-destroy-1", "the staging receipt stamps the decision id");
  assert.match(lastOk().detail ?? "", /^staged files\.destroy; 1 path\(s\): big\.iso$/);
});

test("Space, appearance, tools, and App Studio acts dispatch to the facade, stamp receipts, and render bespoke output", async () => {
  const spaceRef = { id: "space-1", name: "Fold Space", spaceRoot: "/tmp/fold" };
  const targetRef = { id: "space-2", name: "Target Space", spaceRoot: "/tmp/target" };
  const releaseDigest = `sha256:${"a".repeat(64)}`;
  const priorDigest = `sha256:${"b".repeat(64)}`;
  const calls: Array<{ method: string; input?: unknown }> = [];
  let toolsRemoved = true;
  const facade = {
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
      return {
        space: spaceRef,
        staged: {
          decisionId: "act-purge-1",
          kind: "app.data.purge",
          category: "destroy" as const,
          state: "staged" as const,
          createdAt,
          expiresAt: "2026-08-12T10:00:00.000Z",
          deduplicated: false,
        },
        runtimeInstanceId: "runtime-instance_1",
        dataNamespaceIds: ["data-namespace_1"],
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
      return { space: spaceRef, appId: "connected-inbox", digest: "d".repeat(64), removed: true };
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
  assert.match(removedPersonal.stdout, /Removed package @example\/pkg \(personal scope\)\. Reinstalling it is a fresh decision/);
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

  // The Space-app authority direct verbs: narrowing and neutral only, with
  // honest receipt details; widening stays consecrated.
  const proposals = await execute(["apps", "proposals", "list", "--space", "space-1", "--conversation", "conv-1"]);
  assert.match(proposals.stdout, /1 app proposal in Chat \[conv-1\] of Fold Space \[space-1\]:/);
  assert.match(proposals.stdout, /- Connected inbox 0\.1\.0 \[proposal-1\] — pending — digest d+/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", conversationId: "conv-1" });

  const dismissed = await execute(["apps", "proposals", "dismiss", "--space", "space-1", "--conversation", "conv-1", "--proposal", "proposal-1"]);
  assert.match(dismissed.stdout, /Dismissed app proposal proposal-1 in Fold Space \[space-1\]\. Nothing runnable existed; the Assistant may propose again\./);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", conversationId: "conv-1", proposal: "proposal-1" });
  assert.equal(lastOk().detail, "proposal proposal-1");

  const removedApp = await execute(["apps", "remove", "--space", "space-1", "--app", "connected-inbox"]);
  assert.match(removedApp.stdout, /Removed app connected-inbox \[digest d+\] from Fold Space \[space-1\]\. Reinstalling it is a fresh decision/);
  assert.deepEqual(calls.at(-1)?.input, { space: "space-1", app: "connected-inbox" });
  assert.equal(lastOk().detail, `app connected-inbox; digest ${"d".repeat(64)}`);

  const revoked = await execute(["apps", "revoke", "--space", "space-1", "--app", "connected-inbox", "--digest", "d".repeat(64), "--kind", "files", "--declaration", "space-notes"]);
  assert.match(revoked.stdout, /Revoked the files grant space-notes from connected-inbox in Fold Space \[space-1\]\. Re-granting it is a fresh decision/);
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
  assert.match(disabledAutomation.stdout, /Disabled automation daily-sync of connected-inbox in Fold Space \[space-1\]\. Re-enabling it is a fresh decision/);
  assert.equal(lastOk().detail, "app connected-inbox; automation daily-sync");

  const ranAutomation = await execute(["apps", "automation", "run", "--space", "space-1", "--app", "connected-inbox", "--automation", "daily-sync"]);
  assert.match(ranAutomation.stdout, /Automation daily-sync of connected-inbox ran with outcome success \(run run-77\)\./);
  assert.equal(lastOk().detail, "app connected-inbox; automation daily-sync; run run-77; outcome success");

  // The consecrated uninstall disposition stages: the executor routes
  // `--purge-data` to the staging method, never to the retain-only uninstall.
  records.length = 0;
  const purge = await execute(["apps", "uninstall", "--space", "space-1", "--instance", "runtime-instance_1", "--purge-data"]);
  assert.equal(purge.exitCode, 0);
  assert.match(purge.stdout, /Staged uninstalling instance runtime-instance_1 from Fold Space \[space-1\] with its data purged\./);
  assert.equal(calls.at(-1)?.method, "appsUninstallPurge");
  assert.deepEqual(records.map((record) => record.outcome), ["accepted", "ok"]);
  assert.equal(lastOk().decisionId, "act-purge-1");
  assert.equal(lastOk().detail, "staged app.data.purge; instance runtime-instance_1");
});

test("staged-verb classification matches the ledger's consecration rows", () => {
  assert.deepEqual([...WORKFOLD_CLI_ACT_STAGED_COMMAND_NAMES], [
    "spaces.delete",
    "files.destroy",
    "tools.import-skill",
    "tools.install",
    "tools.update",
    "apps.install-proposal",
    "apps.install-preview",
    "apps.grant",
    "apps.connect",
    "apps.automation.enable",
    "apps.storage.clear",
    "apps.retained.purge",
    "routings.stage",
    "pages.stage",
    "pages.stage-app",
  ]);
  assert.equal(isWorkFoldCliActStagedCommand({ name: "spaces.delete" }), true);
  assert.equal(isWorkFoldCliActStagedCommand({ name: "spaces.unregister" }), false);
  assert.equal(isWorkFoldCliActStagedCommand({ name: "apps.uninstall", disposition: "purge-data" }), true);
  assert.equal(isWorkFoldCliActStagedCommand({ name: "apps.uninstall", disposition: "retain-data" }), false);
  assert.equal(isWorkFoldCliActStagedCommand({ name: "apps.revoke" }), false);
  assert.equal(isWorkFoldCliActStagedCommand({ name: "routings.stage" }), true);
  assert.equal(isWorkFoldCliActStagedCommand({ name: "pages.stage" }), true);
  assert.equal(isWorkFoldCliActStagedCommand({ name: "pages.stage-app" }), true);
  // Inspection and cancellation over the store are not consecrations.
  assert.equal(isWorkFoldCliActStagedCommand({ name: "staged.list" }), false);
  assert.equal(isWorkFoldCliActStagedCommand({ name: "staged.cancel" }), false);
});

test("the ledger families ride the unchanged act protocol v2 envelope", () => {
  assert.equal(WORKFOLD_CLI_ACT_PROTOCOL_VERSION, 2);
  const id = randomUUID();
  const argv = ["files", "destroy", "--space", "space-1", "--path", "big.iso", "--path", "cache.bin"];
  const request = createWorkFoldCliActRequest({ id, argv, cwd, actToken: token });
  assert.deepEqual(
    Object.keys(request).sort(),
    ["actToken", "argv", "createdAt", "cwd", "id", "lane", "protocolVersion"],
  );
  assert.equal(request.protocolVersion, 2);
  assert.equal(request.lane, "act");
  assert.deepEqual(request.argv, argv);

  // The envelope gains no staging or decision fields; unknown keys still fail closed.
  assert.throws(
    () => parseWorkFoldCliActRequest({
      protocolVersion: 2,
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
