import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import {
  normalizeWorkFoldRoutingProposal,
  workFoldRoutingMessagePlaceholders,
} from "../src/local/routings/routing-declarations.js";

import {
  WORKFOLD_CLI_PROTOCOL_VERSION,
  WorkFoldCliError,
  WorkFoldCliExitCode,
  createWorkFoldCliRequest,
  createWorkFoldCliResponse,
  executeWorkFoldCliRequest,
  parseWorkFoldCliActArgv,
  parseWorkFoldCliArgv,
  parseWorkFoldCliRequest,
  parseWorkFoldCliResponse,
  workFoldCliHelp,
  type WorkFoldCliActor,
  type WorkFoldCliKernel,
} from "../src/local/cli/index.js";
import {
  workFoldQuestionIdPattern,
  workFoldRequestIdPattern,
  workFoldRequestLimitMessage,
} from "../src/local/requests/request-records.js";
import { workFoldRequestLimits, workFoldRoutingDeclarationBounds } from "../src/shared/fold-limits.js";

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

test("CLI help covers every landed act family and is honest about what it runs", () => {
  // The spelled verb inventory of docs/fold-act-ledger.md plus the sibling
  // routings/pages plans, as the act argv parser accepts them. Growing the
  // act table without growing help fails here on purpose.
  const families: Record<string, string[]> = {
    chat: [
      "create", "send", "status", "result", "wait", "abort", "rename", "snooze", "archive", "resume", "compact",
      "report", "ask", "answer", "handoff",
    ],
    chats: ["list"],
    manage: ["send", "status", "result", "wait", "stop", "abort", "list", "glance"],
    checks: ["status", "enable", "disable", "run", "task", "result", "wait", "abort", "problems", "decide"],
    history: ["list", "save", "restore", "versions", "restore-file"],
    search: [""],
    files: ["add", "move", "rename", "delete", "mkdir", "create"],
    library: ["list", "add", "folder create", "copy"],
    spaces: [
      "list", "create", "register", "rename", "unregister", "delete",
      "appearance apply", "appearance reset", "appearance undo",
      "assistant show", "assistant model", "assistant instructions",
    ],
    tools: ["import-skill", "install", "update", "remove"],
    apps: [
      "list", "invoke", "proposals list", "proposals dismiss", "install-proposal", "install-preview", "remove",
      "grant", "revoke", "connect", "disconnect", "automation enable", "automation disable",
      "automation run", "storage clear", "retained purge", "project declare", "release prepare",
      "release publish", "release delete", "install prepare", "update prepare",
      "operation activate", "operation cancel", "uninstall",
    ],
    routings: ["enable", "list", "show", "run", "stop", "disable", "delete", "receipts"],
    pages: ["share", "share-app", "list", "status", "revoke", "narrow", "snapshot-off"],
    trash: ["list", "restore"],
    requests: ["list", "show"],
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
  // Every verb runs immediately and leaves a receipt (docs/receipts-not-gates.md):
  // no family topic promises a gate, and none of the retired vocabulary survives.
  // `collaborate` is a topic without a verb family of its own, so the loop
  // names it explicitly rather than picking it up from the table.
  for (const family of [...Object.keys(families), "collaborate"]) {
    const topic = workFoldCliHelp("work-fold", family);
    assert.doesNotMatch(topic, /[Ss]taged|pending decision|decision card|needs-you card|approv|Reviewed mode|Unrestricted|polic/, `help ${family} must not describe a gate`);
  }
  assert.doesNotMatch(overview, /[Ss]taged|decision|approv|Reviewed|Unrestricted|polic/);
  assert.match(workFoldCliHelp("work-fold", "tools"), /immediately with a receipt/);
  assert.match(workFoldCliHelp("work-fold", "apps"), /--purge-data/);
  // A single-file permission is granted by naming its file; a folder
  // permission covers the whole Space (docs/receipts-not-gates.md, F21).
  assert.match(workFoldCliHelp("work-fold", "apps"), /--kind <network\|files\|notifications> --declaration <id> \[--path <space-path>\]/);
  assert.match(workFoldCliHelp("work-fold", "apps"), /names a single file needs\n?.*--path <space-path>/);
  // Recently deleted is where a delete History could not fully cover goes
  // (docs/receipts-not-gates.md, F20), and nothing empties it early.
  const trashTopic = workFoldCliHelp("work-fold", "trash");
  assert.match(trashTopic, /Recently deleted holds what a delete could not leave to History/);
  assert.match(trashTopic, /30 days by default/);
  assert.match(trashTopic, /Nothing empties Recently deleted early/);
  assert.match(overview, /trash list\|restore  Bring back what was deleted/);
  assert.match(workFoldCliHelp("work-fold", "files"), /moves to Recently deleted instead/);
  assert.match(workFoldCliHelp("work-fold", "spaces"), /moves a managed Space's folder\nto Recently deleted/);
  assert.doesNotMatch(overview, /files destroy|\bdestroy\b/);
  // The setup-only boundary stays visible where an agent looks first.
  assert.match(overview, /local setup/);
  assert.match(overview, /runs immediately and leaves a receipt/);
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
      version: 1,
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
        kind: "work-fold.checks.experimental", version: 1, available: true, spaceId: hostile,
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

test("Routing help's complete authoring example passes the real proposal validator", () => {
  const example = workFoldCliHelp("work-fold", "routings").split("\n").find((line) => line.startsWith('{"kind":"work-fold.routing-proposal"'));
  assert.ok(example);
  const proposal = normalizeWorkFoldRoutingProposal(JSON.parse(example));
  assert.equal(proposal.version, 4);
  assert.equal(proposal.routing.trigger.kind, "files-changed");
  assert.deepEqual(proposal.routing.steps.map((step) => step.kind), ["files", "chat", "check", "fold"]);
  // The example teaches the closed placeholder set, so it must itself be
  // something the parser accepts and the executor can fill in.
  const adopt = proposal.routing.steps[1] as { message: string };
  assert.deepEqual(
    workFoldRoutingMessagePlaceholders(adopt.message).map((entry) => entry.name),
    ["trigger.changedFiles"],
  );
  const report = proposal.routing.steps[3] as { message: string };
  assert.deepEqual(
    workFoldRoutingMessagePlaceholders(report.message).map((entry) => entry.name),
    ["trigger.summary", "steps.adopt.createdFiles"],
  );
  const help = workFoldCliHelp("work-fold", "routings");
  assert.doesNotMatch(help, /Up to 16 steps/);
  assert.doesNotMatch(help, /staged|approve|policy|Reviewed|Unrestricted|\bcard\b|\bmode\b/i);
});

test("help collaborate's worked example parses through the real act parser", () => {
  const help = workFoldCliHelp("work-fold", "collaborate");
  const example = help.split("\n").filter((line) => line.startsWith("  $ work-fold "));
  // send -> wait -> answer -> report -> wait -> requests show: the whole F27
  // round trip, so a flag spelled one way in help and another in the parser
  // fails here instead of in someone's terminal.
  assert.equal(example.length, 6);
  const argvs = example.map((line) => exampleArgv(line.slice("  $ work-fold ".length)));
  const parsed = argvs.map((argv) => {
    if (argv[0] === "chat" && argv[1] === "wait") {
      // The wait loop runs inside the installed shim, not the host, so the
      // host parser refuses it on purpose and says where it lives.
      assert.throws(() => parseWorkFoldCliActArgv(argv), /runs inside the work-fold shim/);
      return "chat.wait";
    }
    return parseWorkFoldCliActArgv(argv).name;
  });
  assert.deepEqual(parsed, ["chat.send", "chat.wait", "chat.answer", "chat.report", "chat.wait", "requests.show"]);
  // The lineage has to be runnable, not only parseable. An answer starts a
  // NEW turn, so the report and the wait that follow it must not reuse the
  // task id from the wait that came before it: the host refuses an older
  // turn's id ("use the turn that is running now").
  const taskOf = (argv: string[]): string | undefined => argv[argv.indexOf("--task") + 1];
  const askedTask = taskOf(argvs[1]!);
  assert.ok(askedTask);
  for (const index of [3, 4]) {
    assert.notEqual(taskOf(argvs[index]!), askedTask, "the continuation is its own turn, with its own task id");
  }
  assert.equal(taskOf(argvs[3]!), taskOf(argvs[4]!), "the report and the wait after it follow the same continuation");
  // The example ids are the shapes the host actually mints, so an agent
  // copying the shape does not build ids every verb rejects.
  assert.match(argvs[2]![argvs[2]!.indexOf("--question") + 1]!, workFoldQuestionIdPattern);
  assert.match(argvs[5]![argvs[5]!.indexOf("--request") + 1]!, workFoldRequestIdPattern);
  // The topic documents every verb the contract lists, in the contract's own
  // spelling, so an agent reading help sees the shape the parser accepts.
  for (const spelled of [
    "chat report", "chat ask", "chat answer", "chat handoff", "chat wait", "manage wait", "requests list", "requests show",
  ]) {
    assert.ok(help.includes(`work-fold ${spelled} `), `help collaborate must show usage for '${spelled}'`);
  }
  // Bounds are visible where a person can change them, and a refusal names
  // the same place (docs/receipts-not-gates.md, principle 6).
  assert.match(help, /Settings → Desktop →/);
  assert.match(help, /Nothing waits on someone clicking something\./);
  assert.doesNotMatch(help, /\bcard\b|\bmode\b|sandboxed/i);
});

test("the act parser accepts the four collaboration verbs and the request reads", () => {
  assert.deepEqual(
    parseWorkFoldCliActArgv([
      "chat", "report", "--space", "space-1", "--task", "task-1",
      "--summary", "Drafted the note.", "--file", "drafts/q3.md", "--file", "drafts/q3-data.csv",
      "--data", '{"words":812}', "--outcome", "partial", "--json",
    ]),
    {
      name: "chat.report", output: "json", space: "space-1", task: "task-1",
      summary: "Drafted the note.", files: ["drafts/q3.md", "drafts/q3-data.csv"],
      outcome: "partial", resultData: { words: 812 },
    },
  );
  // An outcome is succeeded unless the reporter says otherwise, and a report
  // that names no file carries an empty list rather than a missing field.
  assert.deepEqual(
    parseWorkFoldCliActArgv(["chat", "report", "--space", "space-1", "--task", "task-1", "--summary", "Done."]),
    { name: "chat.report", output: "human", space: "space-1", task: "task-1", summary: "Done.", files: [], outcome: "succeeded" },
  );
  // `--data @<path>` defers the read to the host, which resolves it against
  // the directory the command ran in; argv could not carry 256 KiB anyway.
  assert.deepEqual(
    parseWorkFoldCliActArgv([
      "chat", "report", "--space", "space-1", "--task", "task-1", "--summary", "Done.", "--data", "@out/result.json",
    ]),
    {
      name: "chat.report", output: "human", space: "space-1", task: "task-1",
      summary: "Done.", files: [], outcome: "succeeded", resultDataPath: "out/result.json",
    },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["chat", "ask", "--space", "space-1", "--task", "task-1", "--question", "Which quarter?"]),
    { name: "chat.ask", output: "human", space: "space-1", task: "task-1", question: "Which quarter?", respondent: "person" },
  );
  assert.equal(
    parseWorkFoldCliActArgv([
      "chat", "ask", "--space", "space-1", "--task", "task-1", "--question", "Which quarter?", "--to", "parent",
    ]).respondent,
    "parent",
  );
  // --question carries free text for ask and an id for answer. That is the
  // contract's spelling (docs/collaboration-contract.md), not a slip.
  assert.deepEqual(
    parseWorkFoldCliActArgv(["chat", "answer", "--space", "space-1", "--question", "question-1", "--answer", "November."]),
    { name: "chat.answer", output: "human", space: "space-1", questionId: "question-1", answer: "November." },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv([
      "chat", "handoff", "--space", "space-1", "--task", "task-1", "--to-space", "space-2",
      "--message", "Take this on.", "--file", "drafts/q3.md",
    ]),
    {
      name: "chat.handoff", output: "human", space: "space-1", task: "task-1", toSpace: "space-2",
      message: "Take this on.", files: ["drafts/q3.md"],
    },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv([
      "chat", "handoff", "--space", "space-1", "--task", "task-1", "--to-space", "space-2", "--message-from-payload",
    ]),
    {
      name: "chat.handoff", output: "human", space: "space-1", task: "task-1", toSpace: "space-2",
      messageFromPayload: true, files: [],
    },
  );
  assert.deepEqual(parseWorkFoldCliActArgv(["requests", "list", "--json"]), { name: "requests.list", output: "json" });
  assert.deepEqual(
    parseWorkFoldCliActArgv(["requests", "show", "--request", "request-1"]),
    { name: "requests.show", output: "human", request: "request-1" },
  );
  // All four are mutations, so all four record management lineage; the two
  // request reads deliberately do not.
  for (const argv of [
    ["chat", "report", "--space", "space-1", "--task", "task-1", "--summary", "Done."],
    ["chat", "ask", "--space", "space-1", "--task", "task-1", "--question", "Which?"],
    ["chat", "answer", "--space", "space-1", "--question", "question-1", "--answer", "November."],
    ["chat", "handoff", "--space", "space-1", "--task", "task-1", "--to-space", "space-2", "--message", "Go."],
  ]) {
    assert.equal(parseWorkFoldCliActArgv([...argv, "--parent-task", "task-root"]).parentTaskId, "task-root", argv.join(" "));
  }
});

test("the act parser refuses malformed collaboration arguments with stable usage errors", () => {
  const refusals: Array<[string[], RegExp]> = [
    [["chat", "send", "--space", "space-1", "--new", "--message", "hi", "--file", "notes.md"], /--file cannot be used with 'chat send'\./],
    [["requests", "list", "--space", "space-1"], /sits above Spaces, so 'requests' takes no --space\./],
    [["requests", "show"], /Provide --request <request-id>\./],
    [["requests", "list", "--parent-task", "task-1"], /--parent-task cannot be used with 'requests list'\./],
    [["chat", "ask", "--space", "space-1", "--task", "task-1", "--question", "Which?", "--to", "someone"], /--to must be person or parent\./],
    [["chat", "report", "--space", "space-1", "--task", "task-1", "--summary", "Done.", "--outcome", "great"], /--outcome must be succeeded, partial, or failed\./],
    [["chat", "report", "--space", "space-1", "--task", "task-1", "--summary", "Done.", "--data", "not json"], /--data must be valid JSON, or @<path> naming a JSON file\./],
    [["chat", "report", "--space", "space-1", "--task", "task-1"], /Provide --summary <text>\./],
    [["chat", "report", "--task", "task-1", "--summary", "Done."], /explicit --space/],
    [
      ["chat", "report", "--space", "space-1", "--task", "task-1", "--summary", "Done.", "--file", "q3.md", "--file", "q3.md"],
      /--file names the same path twice\./,
    ],
    [["chat", "handoff", "--space", "space-1", "--task", "task-1", "--to-space", "space-2"], /Provide --message <text> or --message-file <path>\./],
    [["chat", "answer", "--space", "space-1", "--question", "question-1"], /Provide --answer <text>\./],
    [["chat", "answer", "--space", "space-1", "--question", "question-1", "--answer", "November.", "--task", "task-1"], /--task cannot be used with 'chat answer'\./],
  ];
  for (const [argv, message] of refusals) {
    assert.throws(
      () => parseWorkFoldCliActArgv(argv),
      (error) => error instanceof WorkFoldCliError && error.exitCode === WorkFoldCliExitCode.usage && message.test(error.message),
      argv.join(" "),
    );
  }
  // A bound refused at parse time says exactly what the same bound says when
  // the request record refuses it (docs/receipts-not-gates.md, principle 6).
  const overLongQuestion = () => parseWorkFoldCliActArgv([
    "chat", "ask", "--space", "space-1", "--task", "task-1",
    "--question", "x".repeat(workFoldRequestLimits.maxQuestionTextBytes + 1),
  ]);
  assert.throws(overLongQuestion, (error) => error instanceof WorkFoldCliError
    && error.exitCode === WorkFoldCliExitCode.usage
    && error.message.startsWith(workFoldRequestLimitMessage("questionText", workFoldRequestLimits.maxQuestionTextBytes)));
  const manyHandoffFiles = Array.from({ length: 100 }, (_, index) => ["--file", `notes/${index}.md`]).flat();
  assert.doesNotThrow(() => parseWorkFoldCliActArgv([
    "chat", "handoff", "--space", "space-1", "--task", "task-1", "--to-space", "space-2", "--message", "Take this.", ...manyHandoffFiles,
  ]));
  const manyDeliverables = Array.from(
    { length: 100 },
    (_, index) => ["--file", `drafts/${index}.md`],
  ).flat();
  assert.doesNotThrow(() => parseWorkFoldCliActArgv([
    "chat", "report", "--space", "space-1", "--task", "task-1", "--summary", "Done.", ...manyDeliverables,
  ]));
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

/** Splits one documented example line the way a shell would: quoted text is one argument. */
function exampleArgv(line: string): string[] {
  const argv: string[] = [];
  const tokens = /"([^"]*)"|(\S+)/g;
  for (let match = tokens.exec(line); match; match = tokens.exec(line)) {
    argv.push(match[1] ?? match[2] ?? "");
  }
  return argv;
}

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
        version: 1,
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
