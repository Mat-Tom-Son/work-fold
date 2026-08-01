import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  WORKFOLD_CLI_ACT_MAX_PAYLOAD_BYTES,
  WORKFOLD_CLI_ACT_PROTOCOL_VERSION,
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
