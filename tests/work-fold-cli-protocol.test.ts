import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import {
  normalizeWorkFoldAutomationProposal,
  workFoldAutomationMessagePlaceholders,
} from "../src/local/automations/automation-declarations.js";

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
import { workFoldRequestLimits, workFoldAutomationDeclarationBounds } from "../src/shared/work-fold-limits.js";

test("CLI request and response schemas preserve the locked protocol fields", () => {
  const id = randomUUID();
  const cwd = resolve(".");
  const request = createWorkFoldCliRequest({ id, argv: ["work-folders", "list", "--json"], cwd, createdAt: "2026-07-11T12:00:00.000Z" });
  assert.deepEqual(request, {
    protocolVersion: 1,
    id,
    argv: ["work-folders", "list", "--json"],
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
  assert.deepEqual(parseWorkFoldCliArgv(["--json", "context", "--work-folder", "Everywhere"]), {
    name: "context",
    output: "json",
    workFolder: "Everywhere",
  });
  assert.deepEqual(parseWorkFoldCliArgv(["work-folders", "list", "--work-folder=space-1234567890abcdef", "--json"]), {
    name: "work-folders.list",
    output: "json",
    workFolder: "space-1234567890abcdef",
  });
  assert.deepEqual(parseWorkFoldCliArgv(["tasks", "list"]), { name: "tasks.list", output: "human" });
  assert.deepEqual(parseWorkFoldCliArgv(["capabilities", "list", "--work-folder", "space-aaaaaaaaaaaaaaaa"]), {
    name: "capabilities.list",
    output: "human",
    workFolder: "space-aaaaaaaaaaaaaaaa",
  });
  assert.deepEqual(parseWorkFoldCliArgv(["checks", "status", "--work-folder", "space-aaaaaaaaaaaaaaaa", "--json"]), {
    name: "checks.status",
    output: "json",
    workFolder: "space-aaaaaaaaaaaaaaaa",
  });
  assert.deepEqual(parseWorkFoldCliArgv(["version", "--json"]), { name: "version", output: "json" });
  assert.deepEqual(parseWorkFoldCliArgv(["--version", "--json"]), { name: "version", output: "json" });
  assert.deepEqual(parseWorkFoldCliArgv(["help", "tasks", "--json"]), { name: "help", output: "json", topic: "tasks" });
  assert.deepEqual(parseWorkFoldCliArgv(["work-folders", "--help"]), { name: "help", output: "human", topic: "work-folders" });
});

test("CLI argv parser produces stable usage errors", () => {
  for (const argv of [
    ["unknown"],
    ["work-folders"],
    ["work-folders", "list", "extra"],
    ["--wat"],
    ["context", "--work-folder"],
    ["context", "--work-folder", "one", "--work-folder", "two"],
    ["version", "--work-folder", "one"],
  ]) {
    assert.throws(
      () => parseWorkFoldCliArgv(argv),
      (error) => error instanceof WorkFoldCliError && error.exitCode === WorkFoldCliExitCode.usage && /work-fold help/.test(error.message),
      argv.join(" "),
    );
  }
});

test("CLI help covers every landed act family and is honest about what it runs", () => {
  // The spelled verb inventory of docs/act-ledger.md plus the sibling
  // automations/pages plans, as the act argv parser accepts them. Growing the
  // act table without growing help fails here on purpose.
  const families: Record<string, string[]> = {
    chat: [
      "create", "send", "status", "result", "wait", "abort", "rename", "snooze", "archive", "resume", "compact",
      "report", "ask", "answer", "handoff",
    ],
    chats: ["list"],
    agent: ["send", "status", "result", "wait", "stop", "abort", "list", "overview"],
    checks: ["status", "enable", "disable", "run", "task", "result", "wait", "abort", "problems", "decide"],
    history: ["list", "save", "restore", "versions", "restore-file"],
    search: [""],
    files: ["add", "move", "rename", "delete", "mkdir", "create"],
    "work-folders": [
      "list", "create", "register", "rename", "unregister", "delete",
      "appearance apply", "appearance reset", "appearance undo",
      "worker show", "worker model", "worker instructions",
    ],
    tools: ["import-skill", "install", "update", "remove"],
    apps: [
      "list", "invoke", "proposals list", "proposals dismiss", "install-proposal", "install-preview", "remove",
      "grant", "revoke", "connect", "disconnect", "automation enable", "automation disable",
      "automation run", "storage clear", "retained purge", "project declare", "release prepare",
      "release publish", "release delete", "install prepare", "update prepare",
      "operation activate", "operation cancel", "uninstall",
    ],
    automations: ["enable", "list", "show", "run", "stop", "disable", "delete", "receipts"],
    pages: ["share", "share-app", "list", "status", "revoke", "narrow", "widen", "snapshot-off"],
    "recently-deleted": ["list", "restore"],
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
  // permission covers the whole work-folder (docs/receipts-not-gates.md, F21).
  assert.match(workFoldCliHelp("work-fold", "apps"), /--kind <network\|files\|notifications> --declaration <id> \[--path <work-folder-path>\]/);
  assert.match(workFoldCliHelp("work-fold", "apps"), /names a single file needs\n?.*--path <work-folder-path>/);
  // Recently deleted is where a delete History could not fully cover goes
  // (docs/receipts-not-gates.md, F20), and nothing empties it early.
  const recentlyDeletedTopic = workFoldCliHelp("work-fold", "recently-deleted");
  assert.match(recentlyDeletedTopic, /Recently deleted holds what a delete could not leave to History/);
  assert.match(recentlyDeletedTopic, /30 days by default/);
  assert.match(recentlyDeletedTopic, /Nothing empties Recently deleted early/);
  assert.match(overview, /recently-deleted list\|restore\s+Bring back what was deleted/);
  assert.match(workFoldCliHelp("work-fold", "files"), /moves to Recently deleted instead/);
  assert.match(workFoldCliHelp("work-fold", "work-folders"), /moves\na managed work-folder to Recently deleted/);
  assert.doesNotMatch(overview, /files destroy|\bdestroy\b/);
  // The setup-only boundary stays visible where an agent looks first.
  assert.match(overview, /local setup/);
  assert.match(overview, /runs immediately and leaves a receipt/);
});

test("CLI executor passes actor cwd and work-folder scope through the narrow kernel", async () => {
  const calls: Array<{ method: string; actor: WorkFoldCliActor; workFolder?: string }> = [];
  const kernel = fixtureKernel(calls);
  const cwd = resolve("test-work-folder");
  const commands = [
    ["context", "--work-folder", "space-aaaaaaaaaaaaaaaa"],
    ["work-folders", "list", "--work-folder", "space-aaaaaaaaaaaaaaaa"],
    ["tasks", "list", "--work-folder", "space-aaaaaaaaaaaaaaaa"],
    ["capabilities", "list", "--work-folder", "space-aaaaaaaaaaaaaaaa"],
    ["checks", "status", "--work-folder", "space-aaaaaaaaaaaaaaaa"],
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
  assert.deepEqual(calls.map(({ method, actor, workFolder }) => ({ method, actor, workFolder })), [
    { method: "context", actor: { kind: "cli", cwd }, workFolder: "space-aaaaaaaaaaaaaaaa" },
    { method: "work-folders", actor: { kind: "cli", cwd }, workFolder: "space-aaaaaaaaaaaaaaaa" },
    { method: "tasks", actor: { kind: "cli", cwd }, workFolder: "space-aaaaaaaaaaaaaaaa" },
    { method: "capabilities", actor: { kind: "cli", cwd }, workFolder: "space-aaaaaaaaaaaaaaaa" },
    { method: "checks", actor: { kind: "cli", cwd }, workFolder: "space-aaaaaaaaaaaaaaaa" },
  ]);
});

test("CLI Checks status emits aggregate-only JSON and human output", async () => {
  const kernel = fixtureKernel([]);
  const cwd = resolve("test-work-folder");
  const json = await executeWorkFoldCliRequest(
    createWorkFoldCliRequest({ id: randomUUID(), argv: ["checks", "status", "--work-folder", "space-aaaaaaaaaaaaaaaa", "--json"], cwd }),
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
      workFolderId: "space-aaaaaaaaaaaaaaaa",
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
    createWorkFoldCliRequest({ id: randomUUID(), argv: ["checks", "status", "--work-folder", "space-aaaaaaaaaaaaaaaa"], cwd }),
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
    createWorkFoldCliRequest({ id: randomUUID(), argv: ["work-folders", "list"], cwd }),
    kernel,
    { version: "1.2.3" },
  );
  assert.equal(human.exitCode, 0);
  assert.match(human.stdout, /Everywhere \[space-aaaaaaaaaaaaaaaa\].*test-work-folder/);
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
      capabilities: [{ id: "skill-a", name: "Example Skill", kind: "skill", scope: "work-folder", status: "loaded", source: ".pi/skills/example" }],
      total: 1,
    },
  });
  assert.deepEqual(json.result, JSON.parse(json.stdout).data);
});

test("CLI human output neutralizes terminal control sequences from host metadata and errors", async () => {
  const hostile = "before\u001b]8;;https://example.invalid\u0007click\u001b]8;;\u0007\u009b31m\u202eafter";
  const kernel: WorkFoldCliKernel = {
    async getContext() {
      return { cwd: hostile, workFolder: { id: hostile, name: hostile, workFolderRoot: hostile }, selectedPath: hostile, activeSurface: hostile };
    },
    async listWorkFolders() {
      return [{ id: hostile, name: hostile, workFolderRoot: hostile }];
    },
    async listTasks() {
      return [{ id: hostile, label: hostile, status: hostile, workFolderId: hostile }];
    },
    async listCapabilities() {
      return [{ id: hostile, name: hostile, kind: "other", scope: hostile, status: hostile, source: hostile }];
    },
    async getChecksStatus() {
      return {
        kind: "work-fold.checks.experimental", version: 1, available: true, workFolderId: hostile,
        state: "current-clear", configured: 1, proposed: 0, enabled: 1, current: 1, neverRun: 0,
        stale: 0, blocked: 0, errors: 0, needsAttention: 0, running: 0, lastRunAt: null,
      };
    },
  };
  const cwd = resolve(".");
  for (const argv of [["context"], ["work-folders", "list"], ["tasks", "list"], ["capabilities", "list"], ["checks", "status"]]) {
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

test("Automation help's complete authoring example passes the real proposal validator", () => {
  const example = workFoldCliHelp("work-fold", "automations").split("\n").find((line) => line.startsWith('{"kind":"work-fold.automation-proposal"'));
  assert.ok(example);
  const proposal = normalizeWorkFoldAutomationProposal(JSON.parse(example));
  assert.equal(proposal.version, 4);
  assert.equal(proposal.automation.trigger.kind, "files-changed");
  assert.deepEqual(proposal.automation.steps.map((step) => step.kind), ["files", "chat", "check", "agent"]);
  // The example teaches the closed placeholder set, so it must itself be
  // something the parser accepts and the executor can fill in.
  const adopt = proposal.automation.steps[1] as { message: string };
  assert.deepEqual(
    workFoldAutomationMessagePlaceholders(adopt.message).map((entry) => entry.name),
    ["trigger.changedFiles"],
  );
  const report = proposal.automation.steps[3] as { message: string };
  assert.deepEqual(
    workFoldAutomationMessagePlaceholders(report.message).map((entry) => entry.name),
    ["trigger.summary", "steps.adopt.createdFiles"],
  );
  const help = workFoldCliHelp("work-fold", "automations");
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
    "chat report", "chat ask", "chat answer", "chat handoff", "chat wait", "agent wait", "requests list", "requests show",
  ]) {
    assert.ok(help.includes(`work-fold ${spelled} `), `help collaborate must show usage for '${spelled}'`);
  }
  // Bounds are visible where a person can change them, and a refusal names
  // the same place (docs/receipts-not-gates.md, principle 6).
  assert.match(help, /Settings → (?:Automations|Recently deleted)/);
  assert.match(help, /Nothing waits on someone clicking something\./);
  assert.doesNotMatch(help, /\bcard\b|\bmode\b|sandboxed/i);
});

test("the act parser accepts the four collaboration verbs and the request reads", () => {
  assert.deepEqual(
    parseWorkFoldCliActArgv([
      "chat", "report", "--work-folder", "work-folder-1", "--task", "task-1",
      "--summary", "Drafted the note.", "--file", "drafts/q3.md", "--file", "drafts/q3-data.csv",
      "--data", '{"words":812}', "--outcome", "partial", "--json",
    ]),
    {
      name: "chat.report", output: "json", workFolder: "work-folder-1", task: "task-1",
      summary: "Drafted the note.", files: ["drafts/q3.md", "drafts/q3-data.csv"],
      outcome: "partial", resultData: { words: 812 },
    },
  );
  // An outcome is succeeded unless the reporter says otherwise, and a report
  // that names no file carries an empty list rather than a missing field.
  assert.deepEqual(
    parseWorkFoldCliActArgv(["chat", "report", "--work-folder", "work-folder-1", "--task", "task-1", "--summary", "Done."]),
    { name: "chat.report", output: "human", workFolder: "work-folder-1", task: "task-1", summary: "Done.", files: [], outcome: "succeeded" },
  );
  // `--data @<path>` defers the read to the host, which resolves it against
  // the directory the command ran in; argv could not carry 256 KiB anyway.
  assert.deepEqual(
    parseWorkFoldCliActArgv([
      "chat", "report", "--work-folder", "work-folder-1", "--task", "task-1", "--summary", "Done.", "--data", "@out/result.json",
    ]),
    {
      name: "chat.report", output: "human", workFolder: "work-folder-1", task: "task-1",
      summary: "Done.", files: [], outcome: "succeeded", resultDataPath: "out/result.json",
    },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv(["chat", "ask", "--work-folder", "work-folder-1", "--task", "task-1", "--question", "Which quarter?"]),
    { name: "chat.ask", output: "human", workFolder: "work-folder-1", task: "task-1", question: "Which quarter?", respondent: "person" },
  );
  assert.equal(
    parseWorkFoldCliActArgv([
      "chat", "ask", "--work-folder", "work-folder-1", "--task", "task-1", "--question", "Which quarter?", "--to", "parent",
    ]).respondent,
    "parent",
  );
  // --question carries free text for ask and an id for answer. That is the
  // contract's spelling (docs/collaboration-contract.md), not a slip.
  assert.deepEqual(
    parseWorkFoldCliActArgv(["chat", "answer", "--work-folder", "work-folder-1", "--question", "question-1", "--answer", "November."]),
    { name: "chat.answer", output: "human", workFolder: "work-folder-1", questionId: "question-1", answer: "November." },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv([
      "chat", "handoff", "--work-folder", "work-folder-1", "--task", "task-1", "--to-work-folder", "work-folder-2",
      "--message", "Take this on.", "--file", "drafts/q3.md",
    ]),
    {
      name: "chat.handoff", output: "human", workFolder: "work-folder-1", task: "task-1", toWorkFolder: "work-folder-2",
      message: "Take this on.", files: ["drafts/q3.md"],
    },
  );
  assert.deepEqual(
    parseWorkFoldCliActArgv([
      "chat", "handoff", "--work-folder", "work-folder-1", "--task", "task-1", "--to-work-folder", "work-folder-2", "--message-from-payload",
    ]),
    {
      name: "chat.handoff", output: "human", workFolder: "work-folder-1", task: "task-1", toWorkFolder: "work-folder-2",
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
    ["chat", "report", "--work-folder", "work-folder-1", "--task", "task-1", "--summary", "Done."],
    ["chat", "ask", "--work-folder", "work-folder-1", "--task", "task-1", "--question", "Which?"],
    ["chat", "answer", "--work-folder", "work-folder-1", "--question", "question-1", "--answer", "November."],
    ["chat", "handoff", "--work-folder", "work-folder-1", "--task", "task-1", "--to-work-folder", "work-folder-2", "--message", "Go."],
  ]) {
    assert.equal(parseWorkFoldCliActArgv([...argv, "--parent-task", "task-root"]).parentTaskId, "task-root", argv.join(" "));
  }
});

test("the act parser refuses malformed collaboration arguments with stable usage errors", () => {
  const refusals: Array<[string[], RegExp]> = [
    [["chat", "send", "--work-folder", "work-folder-1", "--new", "--message", "hi", "--file", "notes.md"], /--file cannot be used with 'chat send'\./],
    [["requests", "list", "--work-folder", "work-folder-1"], /sits above work-folders, so 'requests' takes no --work-folder\./],
    [["requests", "show"], /Provide --request <request-id>\./],
    [["requests", "list", "--parent-task", "task-1"], /--parent-task cannot be used with 'requests list'\./],
    [["chat", "ask", "--work-folder", "work-folder-1", "--task", "task-1", "--question", "Which?", "--to", "someone"], /--to must be person or parent\./],
    [["chat", "report", "--work-folder", "work-folder-1", "--task", "task-1", "--summary", "Done.", "--outcome", "great"], /--outcome must be succeeded, partial, or failed\./],
    [["chat", "report", "--work-folder", "work-folder-1", "--task", "task-1", "--summary", "Done.", "--data", "not json"], /--data must be valid JSON, or @<path> naming a JSON file\./],
    [["chat", "report", "--work-folder", "work-folder-1", "--task", "task-1"], /Provide --summary <text> or --summary-file <path>\./],
    [["chat", "report", "--task", "task-1", "--summary", "Done."], /explicit --work-folder/],
    [
      ["chat", "report", "--work-folder", "work-folder-1", "--task", "task-1", "--summary", "Done.", "--file", "q3.md", "--file", "q3.md"],
      /--file names the same path twice\./,
    ],
    [["chat", "handoff", "--work-folder", "work-folder-1", "--task", "task-1", "--to-work-folder", "work-folder-2"], /Provide --message <text> or --message-file <path>\./],
    [["chat", "answer", "--work-folder", "work-folder-1", "--question", "question-1"], /Provide --answer <text> or --answer-file <path>\./],
    [["chat", "answer", "--work-folder", "work-folder-1", "--question", "question-1", "--answer", "November.", "--task", "task-1"], /--task cannot be used with 'chat answer'\./],
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
    "chat", "ask", "--work-folder", "work-folder-1", "--task", "task-1",
    "--question", "x".repeat(workFoldRequestLimits.maxQuestionTextBytes + 1),
  ]);
  assert.throws(overLongQuestion, (error) => error instanceof WorkFoldCliError
    && error.exitCode === WorkFoldCliExitCode.usage
    && error.message.startsWith(workFoldRequestLimitMessage("questionText", workFoldRequestLimits.maxQuestionTextBytes)));
  const manyHandoffFiles = Array.from({ length: 100 }, (_, index) => ["--file", `notes/${index}.md`]).flat();
  assert.doesNotThrow(() => parseWorkFoldCliActArgv([
    "chat", "handoff", "--work-folder", "work-folder-1", "--task", "task-1", "--to-work-folder", "work-folder-2", "--message", "Take this.", ...manyHandoffFiles,
  ]));
  const manyDeliverables = Array.from(
    { length: 100 },
    (_, index) => ["--file", `drafts/${index}.md`],
  ).flat();
  assert.doesNotThrow(() => parseWorkFoldCliActArgv([
    "chat", "report", "--work-folder", "work-folder-1", "--task", "task-1", "--summary", "Done.", ...manyDeliverables,
  ]));
});

test("CLI help/version avoid kernel work and kernel failures map to stable exit codes", async () => {
  let called = false;
  const kernel: WorkFoldCliKernel = {
    async getContext() { called = true; throw new WorkFoldCliError("permissionDenied", "Not allowed."); },
    async listWorkFolders() { called = true; return []; },
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

function fixtureKernel(calls: Array<{ method: string; actor: WorkFoldCliActor; workFolder?: string }>): WorkFoldCliKernel {
  return {
    async getContext(actor, options) {
      calls.push({ method: "context", actor, workFolder: options.workFolder });
      return { cwd: actor.cwd, workFolder: { id: "space-aaaaaaaaaaaaaaaa", name: "Everywhere", workFolderRoot: resolve("test-work-folder"), active: true }, selectedPath: "notes.md", activeSurface: "Files" };
    },
    async listWorkFolders(actor, options) {
      calls.push({ method: "work-folders", actor, workFolder: options.workFolder });
      return [{ id: "space-aaaaaaaaaaaaaaaa", name: "Everywhere", workFolderRoot: resolve("test-work-folder"), active: true }];
    },
    async listTasks(actor, options) {
      calls.push({ method: "tasks", actor, workFolder: options.workFolder });
      return [{ id: "task-a", label: "Index files", status: "running", workFolderId: "space-aaaaaaaaaaaaaaaa", updatedAt: "2026-07-11T12:00:00.000Z" }];
    },
    async listCapabilities(actor, options) {
      calls.push({ method: "capabilities", actor, workFolder: options.workFolder });
      return [{ id: "skill-a", name: "Example Skill", kind: "skill", scope: "work-folder", status: "loaded", source: ".pi/skills/example" }];
    },
    async getChecksStatus(actor, options) {
      calls.push({ method: "checks", actor, workFolder: options.workFolder });
      return {
        kind: "work-fold.checks.experimental",
        version: 1,
        available: true,
        workFolderId: "space-aaaaaaaaaaaaaaaa",
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
