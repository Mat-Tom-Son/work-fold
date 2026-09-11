import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { conversationsDir } from "../src/local/agent/chat-store.js";
import type { WorkFoldCliActReceiptV3 } from "../src/local/cli/act-receipts.js";
import { createWorkFoldCliActRequest, executeWorkFoldCliActRequest } from "../src/local/cli/index.js";
import { listSpaceCheckpoints } from "../src/local/history.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";
import { workFoldManagementScopeId } from "../src/local/state-paths.js";

/**
 * The acceptance journeys of docs/collaboration-contract.md, end to end: the
 * installed act lane (argv → executor → the real facade inside
 * startLocalApi) driving the same verbs an outside harness, a Space
 * Assistant, and the fold all get, over the durable request store.
 *
 * This file owns the two journeys that need no model:
 *
 * - **Delegate and clarify.** The fold hands work to a Space, the Space asks
 *   for the missing input and its turn ends, one answer continues it exactly
 *   once, it reports JSON plus a file, and the fold is brought back with the
 *   result. A restart in the middle preserves attribution and replays
 *   nothing; a replayed act request id and a second answer are both refused.
 * - **Request help from a Space.** Work that started in a Space with no
 *   parent owns its own root, reaches the person with a question, hands off
 *   to another Space with copies of its files, and that Space's report comes
 *   back to the first Space's root — with no management request anywhere,
 *   and nothing of the first Space inside the second Space's portable
 *   transcript.
 *
 * The journeys that need a real model turn (an app's assistant task
 * returning the one result envelope, and what a fresh Space Assistant
 * actually receives on the wire) live in
 * tests/work-fold-collaboration-journeys-model.test.ts.
 *
 * Turns run on a `/hold` extension command and wait at the prompt gate, so a
 * verb can be issued inside "its own running turn" and turns settle in the
 * order a journey needs.
 */

const token = "j".repeat(64);

type ReceiptEntry = Omit<WorkFoldCliActReceiptV3, "v" | "at">;

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RequestRef {
  id: string;
  rootId: string;
  kind: string;
  state: string;
  depth: number;
  spaceId: string | null;
  spaceName: string | null;
  conversationId: string;
  openQuestions: number;
  children: number;
  results: number;
}

interface ResultEnvelope {
  summary: string;
  data?: unknown;
  files?: Array<{ path: string; sha256: string; sizeBytes: number }>;
  outcome: "succeeded" | "partial" | "failed";
}

interface RequestDetail extends RequestRef {
  parentRequestId: string | null;
  parentTaskId: string | null;
  turns: Array<{ taskId: string; role: string; state: string }>;
  questions: Array<{ questionId: string; text: string; state: string; answer: string | null; continuationTaskId: string | null; respondent: string }>;
  resultRecords: Array<{ envelope: ResultEnvelope | null; outcome: string; taskId: string }>;
  childRequests: RequestDetail[];
}

/** No person-facing or machine-facing field in this build says an act waited on anyone. */
const gateVocabulary = /\bstaged\b|\bstaging\b|\bapprove[sd]?\b|\bapproval\b|\bdecisionId\b|\bdecision card\b|\bReviewed\b|\bUnrestricted\b|\bautoApproval\b/;

/** Receipt keys this build must not have: a decision, an approval, a staged act. */
function gateFields(record: object): string[] {
  return Object.keys(record).filter((key) => /decision|approval|approve|staged|policy/i.test(key));
}

interface Journey {
  sandbox: string;
  api: LocalApiHandle;
  records: ReceiptEntry[];
  /** Every `beforeAgentPrompt` this run reached, in order: the turns that actually prompted. */
  prompts: Array<{ spaceId: string; conversationId: string; taskId: string }>;
  held: Set<string>;
  run(argv: string[], options?: { id?: string }): Promise<CliRun>;
  /** argv → executor → facade, asserting the command succeeded, and returning its `data`. */
  ok<T>(argv: string[], options?: { id?: string }): Promise<T>;
  lastOk(): ReceiptEntry;
  outcomes(): string[];
  release(taskId: string): Promise<void>;
  settled(spaceId: string, taskId: string): Promise<void>;
  /** Close the app and open it again on the same state root, the way a relaunch does. */
  restart(beforeOpen?: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

async function startJourney(prefix: string): Promise<Journey> {
  const sandbox = await mkdtemp(join(tmpdir(), `work-fold-journey-${prefix}-`));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 25)),
    });
  }\n`, "utf8");
  const stateBase = join(sandbox, "state");
  const held = new Set<string>();
  const prompts: Array<{ spaceId: string; conversationId: string; taskId: string }> = [];
  const pending: Array<{ taskId: string; release: () => void }> = [];
  const records: ReceiptEntry[] = [];
  // Once teardown starts nothing is held: a turn accepted a moment ago can
  // reach the gate after the last release, and a held turn would keep
  // `close()` waiting forever.
  let draining = false;
  const open = (): Promise<LocalApiHandle> => {
    draining = false;
    return startLocalApi({
      port: 0,
      stateBase,
      spaceBase: join(sandbox, "content"),
      loadEnv: false,
      piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
      beforeAgentPrompt: async (event) => {
        prompts.push({ spaceId: event.spaceId, conversationId: event.conversationId, taskId: event.taskId });
        if (draining || !held.has(event.spaceId)) return;
        await new Promise<void>((release) => pending.push({ taskId: event.taskId, release }));
      },
    });
  };
  let api = await open();
  const drain = (): void => {
    draining = true;
    for (const turn of pending.splice(0)) turn.release();
  };
  const run = (argv: string[], options: { id?: string } = {}): Promise<CliRun> => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: options.id ?? randomUUID(), argv, cwd: sandbox, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade: api.actFacade, token }),
      resolveLineageParent: (taskId) => api.resolveManagementLineageParent(taskId),
      receipts: {
        // A journey replays an act request id on purpose, so the ledger the
        // executor consults has to be the real one, not a stub that always
        // says no.
        hasAccepted: async (requestId) => records.some((record) => record.requestId === requestId && record.outcome === "accepted"),
        append: async (record) => {
          records.push(structuredClone(record));
          return true;
        },
      },
    },
  );
  return {
    sandbox,
    get api() { return api; },
    records,
    prompts,
    held,
    run,
    async ok<T>(argv: string[], options: { id?: string } = {}): Promise<T> {
      const result = await run(argv, options);
      assert.equal(result.exitCode, 0, `${argv.join(" ")}\n${result.stderr}`);
      // Every act response is one shape, and no field in it says anything waited.
      assert.doesNotMatch(result.stdout, gateVocabulary, argv.join(" "));
      return (JSON.parse(result.stdout) as { ok: boolean; data: T }).data;
    },
    lastOk: () => records.filter((record) => record.outcome === "ok").at(-1)!,
    outcomes: () => records.map((record) => record.outcome),
    release: async (taskId) => {
      await waitFor(() => pending.some((turn) => turn.taskId === taskId), `turn ${taskId} to reach the prompt gate`);
      pending.splice(pending.findIndex((turn) => turn.taskId === taskId), 1)[0]!.release();
    },
    settled: async (spaceId, taskId) => {
      await waitFor(async () => {
        const status = spaceId === workFoldManagementScopeId
          ? await api.actFacade.manageTurnStatus({ taskId })
          : await api.actFacade.turnStatus({ space: spaceId, taskId });
        return status.task.state !== "running";
      }, `turn ${taskId} to settle`);
    },
    restart: async (beforeOpen) => {
      drain();
      await api.close();
      await beforeOpen?.();
      // Only ever one live handle: `configureWorkFoldStateRoot` is
      // process-global, so two open APIs would silently share a state root.
      api = await open();
    },
    close: async () => {
      drain();
      await api.close();
      await rm(sandbox, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function errorOf(stderr: string): { code?: string; message?: string } {
  try {
    return (JSON.parse(stderr) as { error?: { code?: string; message?: string } }).error ?? {};
  } catch {
    return {};
  }
}

async function transcript(api: LocalApiHandle, spaceId: string, conversationId: string): Promise<Array<{ role: string; content: string; requestId?: string }>> {
  const response = await fetch(new URL(`/api/spaces/${spaceId}/conversations/${conversationId}`, api.origin));
  assert.equal(response.status, 200);
  return (await response.json() as { messages: Array<{ role: string; content: string; requestId?: string }> }).messages;
}

async function managementTranscript(api: LocalApiHandle, conversationId: string): Promise<Array<{ role: string; content: string; requestId?: string }>> {
  const response = await fetch(new URL(`/api/management/conversations/${conversationId}`, api.origin));
  assert.equal(response.status, 200);
  return (await response.json() as { messages: Array<{ role: string; content: string; requestId?: string }> }).messages;
}

/**
 * The F29 envelope, checked the same way wherever it came from: a `chat
 * report`, an app's assistant task, a handoff outcome. Every journey that
 * produces one runs it through here, so a divergence fails in a test rather
 * than in review.
 */
function assertResultEnvelope(envelope: ResultEnvelope, expected: {
  summary: string;
  outcome: "succeeded" | "partial" | "failed";
  data?: unknown;
  files?: Array<{ path: string; bytes: string }>;
}): void {
  assert.deepEqual(
    Object.keys(envelope).sort(),
    ["data", "files", "outcome", "summary"].filter((key) => key in envelope).sort(),
    "an envelope carries summary, outcome, and the optional data and files — nothing undeclared",
  );
  assert.equal(envelope.summary, expected.summary);
  assert.equal(envelope.outcome, expected.outcome);
  assert.ok(Buffer.byteLength(envelope.summary, "utf8") <= 32 * 1024, "the summary stays inside its bound");
  if (expected.data === undefined) {
    assert.equal("data" in envelope, false, "no declared data means the key is absent, never null");
  } else {
    assert.deepEqual(envelope.data, expected.data);
  }
  const files = envelope.files ?? [];
  assert.equal(files.length, expected.files?.length ?? 0);
  for (const [index, file] of files.entries()) {
    const want = expected.files![index]!;
    assert.equal(file.path, want.path);
    assert.equal(file.path.startsWith("/"), false, "a deliverable path is Space-relative");
    // Never trust the reported digest: recompute it from the bytes on disk.
    assert.equal(file.sha256, createHash("sha256").update(want.bytes).digest("hex"));
    assert.equal(file.sizeBytes, Buffer.byteLength(want.bytes, "utf8"));
  }
}

test("journey: the fold delegates to a Space, the Space asks once, one answer continues it, and the report comes back without a fold turn to carry it", async () => {
  const j = await startJourney("delegate");
  try {
    const quotes = (await j.api.actFacade.createSpace({ name: "Quotes" })).space;
    await mkdir(join(quotes.spaceRoot, "quotes"), { recursive: true });
    j.held.add(workFoldManagementScopeId);
    j.held.add(quotes.id);

    // 1. The fold's own turn opens the root request.
    const root = await j.ok<{ conversationId: string; taskId: string }>([
      "manage", "send", "--new", "--message", "/hold", "--json",
    ]);
    const rootRequestId = j.api.requests.byTaskId(root.taskId)!.requestId;
    const opened = await j.ok<{ request: RequestDetail }>(["requests", "show", "--request", rootRequestId, "--json"]);
    assert.equal(opened.request.kind, "management");
    assert.equal(opened.request.rootId, rootRequestId);
    assert.equal(opened.request.state, "working");
    assert.equal(opened.request.parentTaskId, null);
    assert.deepEqual(opened.request.childRequests, []);

    // 2. The fold delegates while its own turn runs. The child is a request
    //    under the root, with the Space and Chat it lives in named on it.
    j.records.length = 0;
    // `/hold` runs as a registered extension command, so a turn needs no model
    // and waits at the prompt gate; the rest of the line is the assignment.
    const assignment = "/hold Compare the North and South quotes and report the winner.";
    const child = await j.ok<{ conversationId: string; taskId: string }>([
      "chat", "send", "--space", quotes.id, "--new", "--message", assignment, "--parent-task", root.taskId, "--json",
    ]);
    assert.deepEqual(j.outcomes(), ["accepted", "ok"]);
    assert.equal(j.lastOk().parentTaskId, root.taskId, "the receipt carries the fold's lineage");
    assert.equal(gateFields(j.lastOk()).length, 0, "nothing was decided ahead of this; it simply ran");
    const childRequestId = j.api.requests.byTaskId(child.taskId)!.requestId;
    const delegated = (await j.ok<{ request: RequestDetail }>(["requests", "show", "--request", childRequestId, "--json"])).request;
    assert.equal(delegated.parentTaskId, root.taskId);
    assert.equal(delegated.rootId, rootRequestId);
    assert.equal(delegated.depth, 1);
    assert.equal(delegated.spaceId, quotes.id);
    assert.equal(delegated.spaceName, "Quotes");
    assert.equal(delegated.conversationId, child.conversationId);
    assert.equal(delegated.kind, "cli", "the surface that sent it names the kind; the lineage names the fold");

    // 3. The Space asks for the missing input. Its task is waiting, the root
    //    is waiting with it, and the turn is not suspended.
    j.records.length = 0;
    const asked = await j.ok<{ question: { questionId: string; respondent: string; state: string }; redirectedToPerson: boolean; request: RequestRef }>([
      "chat", "ask", "--space", quotes.id, "--task", child.taskId, "--question", "Which currency should the totals use?", "--json",
    ]);
    assert.equal(asked.question.respondent, "person", "--to person is the default");
    assert.equal(asked.question.state, "open");
    assert.equal(asked.redirectedToPerson, false);
    assert.equal(asked.request.state, "waiting");
    assert.deepEqual(j.outcomes(), ["accepted", "ok"]);
    assert.doesNotMatch(JSON.stringify(j.records), /currency/i, "a receipt never carries the question text");

    // 4. F28: the host says which, on the status document, while the turn runs.
    const waitingStatus = await j.ok<{ task: { state: string }; waiting: { questionId: string; requestId: string; respondent: string; question: string; askedAt: string; expiresAt: string } | null; request: RequestRef }>([
      "chat", "status", "--space", quotes.id, "--task", child.taskId, "--json",
    ]);
    assert.equal(waitingStatus.task.state, "running");
    assert.ok(["running", "succeeded", "failed", "aborted", "unknown"].includes(waitingStatus.task.state), "the turn-state vocabulary is unchanged");
    assert.equal(waitingStatus.waiting?.questionId, asked.question.questionId);
    assert.equal(waitingStatus.waiting?.requestId, childRequestId);
    assert.equal(waitingStatus.waiting?.respondent, "person");
    assert.equal(waitingStatus.waiting?.question, "Which currency should the totals use?");
    assert.ok(Date.parse(waitingStatus.waiting!.expiresAt) > Date.parse(waitingStatus.waiting!.askedAt));
    assert.equal(waitingStatus.request?.state, "waiting");
    // The blocking loop belongs to the installed shim; the host keeps failing
    // an old one loudly rather than holding a broker request open.
    const waited = await j.run(["chat", "wait", "--space", quotes.id, "--task", child.taskId, "--json"]);
    assert.equal(waited.exitCode, 2);
    assert.match(waited.stderr, /runs inside the work-fold shim/);

    // 5. Needs you means a question was asked, never that something is held up.
    const glance = await j.ok<{ needsYou: Array<{ kind: string; headline: string; ref?: { questionId?: string } }> }>(["manage", "glance", "--json"]);
    const item = glance.needsYou.find((entry) => entry.ref?.questionId === asked.question.questionId);
    assert.ok(item, "the open question is what needs the person");
    assert.equal(item!.kind, "request-question");
    assert.match(item!.headline, /waiting on your answer/);
    assert.doesNotMatch(JSON.stringify(glance), /currency/i, "the glance names the question, never its text");

    // 6. Both turns end. The fold's turn never blocked on the child, and the
    //    request it left behind reports the open question honestly.
    await j.release(child.taskId);
    await j.settled(quotes.id, child.taskId);
    await j.release(root.taskId);
    await j.settled(workFoldManagementScopeId, root.taskId);
    // The question is delivered even though the child ended before its parent.
    await waitFor(() => j.api.requests.get(rootRequestId)!.turns.length === 2, "the question delivery");
    const questionDelivery = j.api.requests.get(rootRequestId)!.turns[1]!;
    await j.release(questionDelivery.taskId);
    await j.settled(workFoldManagementScopeId, questionDelivery.taskId);
    const parked = await j.api.actFacade.manageTurnStatus({ taskId: root.taskId });
    assert.equal(parked.task.state, "succeeded", "the fold's own turn finished instead of waiting");
    assert.equal(parked.requestGraph?.state, "waiting");
    assert.equal(parked.request?.phase, "needs_you", "manage status keeps its projection over the new store");
    const settledStatus = await j.ok<{ task: { state: string }; waiting: { questionId: string } | null }>([
      "chat", "status", "--space", quotes.id, "--task", child.taskId, "--json",
    ]);
    assert.equal(settledStatus.task.state, "succeeded");
    assert.equal(settledStatus.waiting?.questionId, asked.question.questionId, "a settled turn still reports what it is owed");

    // 7. One answer, one continuation; an answer from another Space and a
    //    second answer are refused, and neither starts a turn.
    const foreign = (await j.api.actFacade.createSpace({ name: "Elsewhere" })).space;
    j.records.length = 0;
    const wrongSpace = await j.run(["chat", "answer", "--space", foreign.id, "--question", asked.question.questionId, "--answer", "Euros.", "--json"]);
    assert.equal(errorOf(wrongSpace.stderr).code, "conflict");
    assert.match(wrongSpace.stderr, /belongs to Quotes/);
    assert.deepEqual(j.outcomes(), ["accepted", "error"], "a refusal after acceptance is journaled too");

    j.records.length = 0;
    const answered = await j.ok<{ question: { state: string; continuationTaskId: string }; continuation: { taskId: string; conversationId: string } }>([
      "chat", "answer", "--space", quotes.id, "--question", asked.question.questionId, "--answer", "/hold", "--json",
    ]);
    assert.equal(answered.question.state, "answered");
    assert.equal(answered.continuation.conversationId, child.conversationId, "the continuation is a new turn in the same Chat");
    assert.equal(answered.question.continuationTaskId, answered.continuation.taskId);
    assert.deepEqual(j.outcomes(), ["accepted", "ok"]);
    const carried = (await transcript(j.api, quotes.id, child.conversationId))
      .filter((message) => message.role === "user" && message.requestId === `answer-${asked.question.questionId}`);
    assert.equal(carried.length, 1, "exactly one continuation message, keyed by the question");
    assert.equal(carried[0]!.content, "/hold", "the answer is an ordinary user message; the question id stays machine-local");

    j.records.length = 0;
    const second = await j.run(["chat", "answer", "--space", quotes.id, "--question", asked.question.questionId, "--answer", "Euros.", "--json"]);
    assert.equal(second.exitCode, 5);
    assert.equal(errorOf(second.stderr).code, "conflict");
    assert.match(second.stderr, /already has an answer/);
    assert.deepEqual(j.outcomes(), ["accepted", "error"]);
    const replies = await transcript(j.api, quotes.id, child.conversationId);
    assert.equal(replies.filter((message) => message.content === "Euros.").length, 0, "a refused answer reaches no Chat");
    assert.equal(j.api.requests.get(childRequestId)!.turns.length, 2, "exactly one continuation turn");

    // 8. The Space reports JSON plus the file it produced, inside its
    //    continuation turn, and the envelope is the one shape.
    await writeFile(join(quotes.spaceRoot, "quotes", "comparison.md"), "# Comparison\nNorth: $42\nSouth: $50\n", "utf8");
    await writeFile(join(j.sandbox, "winner.json"), JSON.stringify({ winner: "North", delta: 8 }), "utf8");
    j.records.length = 0;
    const promptsBefore = j.prompts.length;
    const reported = await j.ok<{ resultId: string; result: ResultEnvelope; request: RequestRef }>([
      "chat", "report", "--space", quotes.id, "--task", answered.continuation.taskId,
      "--summary", "North is cheaper by $8.", "--data", "@winner.json",
      "--file", "quotes/comparison.md", "--outcome", "succeeded", "--json",
    ]);
    assertResultEnvelope(reported.result, {
      summary: "North is cheaper by $8.",
      outcome: "succeeded",
      data: { winner: "North", delta: 8 },
      files: [{ path: "quotes/comparison.md", bytes: "# Comparison\nNorth: $42\nSouth: $50\n" }],
    });
    assert.deepEqual(j.outcomes(), ["accepted", "ok"]);
    assert.equal(j.lastOk().detail, "report succeeded; 1 file");
    assert.doesNotMatch(JSON.stringify(j.records), /North|winner/, "receipts carry the shape, never the content");

    // 9. Delivery is host-side: the report reached the root record with no
    //    turn started anywhere to carry it.
    const afterReport = (await j.ok<{ request: RequestDetail }>(["requests", "show", "--request", rootRequestId, "--json"])).request;
    assert.equal(afterReport.childRequests[0]!.resultRecords[0]!.envelope!.summary, "North is cheaper by $8.");
    assert.equal(j.prompts.length, promptsBefore, "no turn ran to move the result");
    assert.equal(j.api.requests.get(rootRequestId)!.turns.length, 2);

    // 10. Every child has now settled after the fold's own turn ended, so the
    //     host brings the fold back exactly once with what came in.
    await j.release(answered.continuation.taskId);
    await j.settled(quotes.id, answered.continuation.taskId);
    await waitFor(() => j.api.requests.get(rootRequestId)!.turns.length === 3, "the fold to be brought back");
    const continuation = j.api.requests.get(rootRequestId)!;
    assert.equal(continuation.continuationCount, 2);
    assert.equal(continuation.turns[2]!.role, "continuation");
    const brought = (await managementTranscript(j.api, root.conversationId))
      .filter((message) => message.role === "user" && message.requestId === `continuation-${rootRequestId}-2`);
    assert.equal(brought.length, 1, "one continuation turn for the whole settle batch");
    assert.match(brought[0]!.content, /Nobody typed this message/);
    assert.match(brought[0]!.content, /succeeded: North is cheaper by \$8\./);
    assert.match(brought[0]!.content, /files: quotes\/comparison\.md/);
    assert.doesNotMatch(brought[0]!.content, gateVocabulary);
    await j.release(continuation.turns[2]!.taskId);
    await j.settled(workFoldManagementScopeId, continuation.turns[2]!.taskId);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(j.api.requests.get(rootRequestId)!.turns.length, 3, "a continuation never continues itself");

    // 11. The whole journey left receipts and nothing that waited on anyone.
    assert.doesNotMatch(JSON.stringify(j.records), gateVocabulary);
    assert.equal(j.records.some((record) => record.outcome === "accepted"), true);
    assert.deepEqual(j.records.flatMap(gateFields), []);
  } finally {
    await j.close();
  }
});

test("journey: a restart between the question and the answer keeps the request graph, replays nothing, and refuses a replayed act request id", async () => {
  const j = await startJourney("restart");
  try {
    const quotes = (await j.api.actFacade.createSpace({ name: "Quotes" })).space;
    j.held.add(workFoldManagementScopeId);
    j.held.add(quotes.id);
    const root = await j.ok<{ conversationId: string; taskId: string }>(["manage", "send", "--new", "--message", "/hold", "--json"]);
    const rootRequestId = j.api.requests.byTaskId(root.taskId)!.requestId;
    const child = await j.ok<{ conversationId: string; taskId: string }>([
      "chat", "send", "--space", quotes.id, "--new", "--message", "/hold Compare the quotes.", "--parent-task", root.taskId, "--json",
    ]);
    const childRequestId = j.api.requests.byTaskId(child.taskId)!.requestId;
    const asked = await j.ok<{ question: { questionId: string } }>([
      "chat", "ask", "--space", quotes.id, "--task", child.taskId, "--question", "Which currency?", "--json",
    ]);
    await j.release(child.taskId);
    await j.settled(quotes.id, child.taskId);
    await j.release(root.taskId);
    await j.settled(workFoldManagementScopeId, root.taskId);

    // Settling the original turn may start a follow-up about the child's
    // question. This journey restarts idle, waiting work: drain that exact
    // follow-up before quitting, or shutdown may correctly abort it and make
    // the root stopped. Its admission timing is not the restart contract.
    await waitFor(() => j.api.requests.get(rootRequestId)!.turns.length === 2, "the question follow-up to be accepted");
    const followupTaskId = j.api.requests.get(rootRequestId)!.turns[1]!.taskId;
    await j.release(followupTaskId);
    await j.settled(workFoldManagementScopeId, followupTaskId);
    assert.equal(j.api.requests.get(rootRequestId)!.state, "waiting");

    let promptsBefore = 0;
    let journalBefore = new Map<string, string>();
    // Capture after the old host drains. The new host cannot redispatch any
    // of those settled turns, including the follow-up.
    await j.restart(async () => {
      promptsBefore = j.prompts.length;
      journalBefore = await turnOutcomes(j.sandbox);
      assert.equal(journalBefore.get(child.taskId), "succeeded");
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Nothing was replayed: no turn prompted, no turn ran, and no settled
    // turn was given a second outcome. (The journal prunes settled records,
    // so the rule is "no new turn, no changed verdict", not "same size".)
    assert.equal(j.prompts.length, promptsBefore, "a restart starts no turn");
    const journalAfter = await turnOutcomes(j.sandbox);
    for (const [turnId, outcome] of journalAfter) {
      assert.ok(journalBefore.has(turnId), `a restart invented turn ${turnId}`);
      assert.equal(outcome, journalBefore.get(turnId), `a restart changed the verdict of turn ${turnId}`);
    }
    assert.equal((await j.api.kernel.getTasks({ kind: "system" })).tasks.length, 0);

    // Attribution survived: the same ids, the same links, the same question.
    const restored = (await j.ok<{ request: RequestDetail }>(["requests", "show", "--request", rootRequestId, "--json"])).request;
    assert.equal(restored.state, "waiting");
    assert.equal(restored.childRequests.length, 1);
    const restoredChild = restored.childRequests[0]!;
    assert.equal(restoredChild.id, childRequestId);
    assert.equal(restoredChild.parentTaskId, root.taskId);
    assert.equal(restoredChild.rootId, rootRequestId);
    assert.equal(restoredChild.spaceId, quotes.id);
    assert.equal(restoredChild.conversationId, child.conversationId);
    assert.equal(restoredChild.state, "waiting");
    assert.equal(restoredChild.questions[0]!.questionId, asked.question.questionId);
    assert.equal(restoredChild.questions[0]!.text, "Which currency?");
    assert.equal(restoredChild.questions[0]!.state, "open");
    assert.equal((await j.ok<{ waiting: { questionId: string } | null }>([
      "chat", "status", "--space", quotes.id, "--task", child.taskId, "--json",
    ])).waiting?.questionId, asked.question.questionId);

    // The answer still works, and continues the same Chat exactly once.
    const answerRequestId = randomUUID();
    j.records.length = 0;
    const answered = await j.ok<{ continuation: { taskId: string; conversationId: string } }>([
      "chat", "answer", "--space", quotes.id, "--question", asked.question.questionId, "--answer", "/hold", "--json",
    ], { id: answerRequestId });
    assert.equal(answered.continuation.conversationId, child.conversationId);
    assert.deepEqual(j.outcomes(), ["accepted", "ok"]);
    assert.equal(j.api.requests.byTaskId(answered.continuation.taskId)!.requestId, childRequestId, "the continuation joined the request it answers");

    // Replaying the exact act request id executes nothing, and says so. The
    // receipt ledger stays whole here: the accepted line above is what the
    // executor consults.
    const beforeReplay = j.records.length;
    const replayed = await j.run([
      "chat", "answer", "--space", quotes.id, "--question", asked.question.questionId, "--answer", "/hold", "--json",
    ], { id: answerRequestId });
    assert.equal(replayed.exitCode, 5);
    assert.equal(errorOf(replayed.stderr).code, "conflict");
    assert.match(replayed.stderr, /already executed/);
    assert.deepEqual(j.records.slice(beforeReplay).map((record) => record.outcome), ["rejected"], "a replay is refused before acceptance, and journaled as refused");
    assert.equal(j.api.requests.get(childRequestId)!.turns.length, 2, "still exactly one continuation");
    assert.equal(
      (await transcript(j.api, quotes.id, child.conversationId))
        .filter((message) => message.role === "user" && message.requestId === `answer-${asked.question.questionId}`).length,
      1,
    );

    // A second answer under a fresh act request id is refused on its own terms.
    const second = await j.run(["chat", "answer", "--space", quotes.id, "--question", asked.question.questionId, "--answer", "/hold", "--json"]);
    assert.equal(errorOf(second.stderr).code, "conflict");
    assert.match(second.stderr, /already has an answer/);
    await j.release(answered.continuation.taskId);
    await j.settled(quotes.id, answered.continuation.taskId);
  } finally {
    await j.close();
  }
});

test("journey: a Space asks for help with no request above it, hands off to another Space, and that Space's report comes back to the same root", async () => {
  const j = await startJourney("request-help");
  try {
    const drafts = (await j.api.actFacade.createSpace({ name: "Drafts" })).space;
    const reviews = (await j.api.actFacade.createSpace({ name: "Reviews" })).space;
    j.held.add(drafts.id);
    j.held.add(reviews.id);
    await mkdir(join(drafts.spaceRoot, "drafts"), { recursive: true });
    const draftBytes = "# Renewal\nDue in November.\n";
    await writeFile(join(drafts.spaceRoot, "drafts", "renewal.md"), draftBytes, "utf8");

    // 1. Work that starts in a Space owns its own root: no parent, no fold.
    const own = await j.ok<{ conversationId: string; taskId: string }>([
      "chat", "send", "--space", drafts.id, "--new", "--message", "/hold Draft the renewal note.", "--json",
    ]);
    const rootRequestId = j.api.requests.byTaskId(own.taskId)!.requestId;
    const opened = (await j.ok<{ request: RequestDetail }>(["requests", "show", "--request", rootRequestId, "--json"])).request;
    assert.equal(opened.rootId, rootRequestId);
    assert.equal(opened.parentTaskId, null);
    assert.equal(opened.parentRequestId, null);
    assert.equal(opened.depth, 0);
    assert.equal(opened.spaceId, drafts.id);

    // 2. `--to parent` with nothing above it reaches the person, and says so.
    const asked = await j.ok<{ question: { questionId: string; respondent: string }; redirectedToPerson: boolean; request: RequestRef }>([
      "chat", "ask", "--space", drafts.id, "--task", own.taskId, "--question", "Which renewal date applies?", "--to", "parent", "--json",
    ]);
    assert.equal(asked.redirectedToPerson, true);
    assert.equal(asked.question.respondent, "person");
    assert.equal(asked.request.state, "waiting");
    const listed = await j.ok<{ requests: Array<{ id: string; rootId: string }> }>(["requests", "list", "--json"]);
    assert.ok(listed.requests.some((request) => request.id === rootRequestId && request.rootId === rootRequestId));
    assert.ok(listed.requests.every((request) => request.id === request.rootId), "list shows roots only");

    // 3. One answer continues it once.
    await j.release(own.taskId);
    await j.settled(drafts.id, own.taskId);
    const answered = await j.ok<{ continuation: { taskId: string } }>([
      "chat", "answer", "--space", drafts.id, "--question", asked.question.questionId, "--answer", "/hold", "--json",
    ]);

    // 4. The hand-off: an additive, restore-pointed copy and a new Chat in
    //    the destination, recorded under the same root.
    j.records.length = 0;
    const reviewCheckpoints = (await listSpaceCheckpoints(reviews.spaceRoot)).length;
    const handed = await j.ok<{ conversationId: string; taskId: string; copied: string[]; checkpointId: string | null; request: RequestRef; toSpace: { id: string } }>([
      "chat", "handoff", "--space", drafts.id, "--task", answered.continuation.taskId,
      "--to-space", reviews.id, "--message", "/hold", "--file", "drafts/renewal.md", "--json",
    ]);
    assert.deepEqual(handed.copied, ["renewal.md"], "the copy lands in the destination the way `files add` lands one");
    assert.equal(handed.toSpace.id, reviews.id);
    assert.equal(await readFile(join(drafts.spaceRoot, "drafts", "renewal.md"), "utf8"), draftBytes, "the source keeps its bytes");
    assert.equal(await readFile(join(reviews.spaceRoot, "renewal.md"), "utf8"), draftBytes);
    assert.equal((await listSpaceCheckpoints(reviews.spaceRoot)).length, reviewCheckpoints + 1, "the copy landed with a restore point");
    assert.equal(j.api.requests.byTaskId(handed.taskId)!.rootId, rootRequestId, "the new Chat is a child of the caller's root");
    // The root id itself is not handed to a Space-scoped caller: `requests
    // show` reads a request by id, so it comes back as the opaque handle no
    // verb accepts (F9 as amended, F26).
    assert.match(handed.request.rootId, /^parent-[0-9a-f]{16}$/);
    assert.equal(handed.request.depth, 1);
    assert.deepEqual(j.outcomes(), ["accepted", "ok"]);
    assert.equal(j.lastOk().spaceId, reviews.id, "the receipt names the Space the effect landed in");
    assert.deepEqual(j.lastOk().undoRef, { kind: "checkpoint", value: handed.checkpointId });

    // 5. Only the released payload reached the destination. Space Chats
    //    travel with the folder, so the on-disk transcript is what matters.
    const portable = await readFile(join(conversationsDir(reviews.spaceRoot), `${handed.conversationId}.jsonl`), "utf8");
    assert.match(portable, /\/hold/, "the handoff message is what the destination was given");
    for (const secret of [own.conversationId, drafts.id, drafts.spaceRoot, rootRequestId, asked.question.questionId, "Which renewal date applies?"]) {
      assert.equal(portable.includes(secret), false, `the destination transcript must not carry ${secret}`);
    }

    // 6. The destination reports, and the result lands under the origin's
    //    root — with no management request in this journey at all.
    const reviewBytes = "# Review\nTone is fine.\n";
    await writeFile(join(reviews.spaceRoot, "review.md"), reviewBytes, "utf8");
    const reported = await j.ok<{ result: ResultEnvelope; request: RequestRef }>([
      "chat", "report", "--space", reviews.id, "--task", handed.taskId,
      "--summary", "Read the renewal draft; the tone is fine.", "--file", "review.md", "--outcome", "succeeded", "--json",
    ]);
    assertResultEnvelope(reported.result, {
      summary: "Read the renewal draft; the tone is fine.",
      outcome: "succeeded",
      files: [{ path: "review.md", bytes: reviewBytes }],
    });
    // The report's own request is the Reviews child, and the id above it is
    // the origin Space's root, which a Space-scoped verb never hands back.
    assert.equal(j.api.requests.byTaskId(handed.taskId)!.rootId, rootRequestId);
    assert.match(reported.request.rootId, /^parent-[0-9a-f]{16}$/);
    assert.equal(
      j.prompts.filter((prompt) => prompt.spaceId === workFoldManagementScopeId).length,
      0,
      "no fold turn ran anywhere in this journey, let alone to carry a result",
    );
    const whole = (await j.ok<{ request: RequestDetail }>(["requests", "show", "--request", rootRequestId, "--json"])).request;
    assert.equal(whole.childRequests.length, 1);
    assert.equal(whole.childRequests[0]!.spaceName, "Reviews");
    assert.equal(whole.childRequests[0]!.resultRecords[0]!.envelope!.summary, "Read the renewal draft; the tone is fine.");
    assert.equal(
      (await j.ok<{ requests: Array<{ kind: string }> }>(["requests", "list", "--json"])).requests.some((request) => request.kind === "management"),
      false,
      "nothing in this journey needed the fold",
    );

    // 7. Cross-Space reasoning stays machine-local: neither Space folder
    //    learned the other exists.
    for (const [here, there] of [[drafts, reviews], [reviews, drafts]] as const) {
      const records = await portableRecords(here.spaceRoot);
      assert.equal(records.includes(there.id), false, `${here.id} must not record ${there.id}`);
      assert.equal(records.includes(rootRequestId), false, "a request id is machine-local");
    }
    assert.equal(existsSync(join(j.sandbox, "state", "requests")), true, "the request graph lives under the state root");

    // 8. The refusals, each before anything is copied or recorded.
    await j.release(handed.taskId);
    await j.settled(reviews.id, handed.taskId);
    for (const [argv, code, pattern] of [
      [["chat", "ask", "--space", reviews.id, "--task", answered.continuation.taskId, "--question", "Whose?", "--json"], "conflict", /another Space's turn/],
      [["chat", "handoff", "--space", drafts.id, "--task", answered.continuation.taskId, "--to-space", "space-not-registered", "--message", "/hold", "--json"], "notFound", /space-not-registered/],
      [["chat", "handoff", "--space", drafts.id, "--task", answered.continuation.taskId, "--to-space", reviews.id, "--message", "/hold", "--file", "../outside.md", "--json"], "usage", /./],
      [["chat", "handoff", "--space", drafts.id, "--task", answered.continuation.taskId, "--to-space", reviews.id, "--message", "/hold", "--file", ".work-fold/space.json", "--json"], "usage", /./],
      [["chat", "handoff", "--space", drafts.id, "--task", answered.continuation.taskId, "--to-space", reviews.id, "--message", "/hold", "--file", ".workspace/legacy.json", "--json"], "usage", /./],
    ] as const) {
      const refused = await j.run([...argv]);
      assert.notEqual(refused.exitCode, 0, argv.join(" "));
      assert.equal(errorOf(refused.stderr).code, code, `${argv.join(" ")}: ${refused.stderr}`);
      assert.match(refused.stderr, pattern);
      assert.doesNotMatch(refused.stderr, gateVocabulary);
    }
    assert.equal(j.api.requests.get(rootRequestId)!.childRequestIds.length, 1, "no refusal left a child behind");
    await j.release(answered.continuation.taskId);
    await j.settled(drafts.id, answered.continuation.taskId);
  } finally {
    await j.close();
  }
});

/** The durable turn journal's last word on every turn it still holds. */
async function turnOutcomes(sandbox: string): Promise<Map<string, string>> {
  const path = join(sandbox, "state", "turns", "turns.jsonl");
  const outcomes = new Map<string, string>();
  if (!existsSync(path)) return outcomes;
  for (const line of (await readFile(path, "utf8")).trim().split("\n")) {
    if (!line) continue;
    const record = JSON.parse(line) as { turnId?: string; status?: string };
    if (record.turnId && record.status) outcomes.set(record.turnId, record.status);
  }
  return outcomes;
}

/** Everything the portable `.work-fold/` records of a Space folder say, as one string. */
async function portableRecords(spaceRoot: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const root = join(spaceRoot, ".work-fold");
  if (!existsSync(root)) return "";
  const parts: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else parts.push(entry.name, await readFile(path, "utf8"));
    }
  };
  await walk(root);
  return parts.join("\n");
}


test("person-facing work follows delegation, routes exact answers, exposes saved answers, and stops the whole request", async () => {
  const j = await startJourney("work-ui");
  try {
    const a = (await j.api.actFacade.createSpace({ name: "Planning" })).space;
    const b = (await j.api.actFacade.createSpace({ name: "Quotes" })).space;
    j.held.add(a.id); j.held.add(b.id);
    const parent = await j.api.actFacade.sendMessage({ space: a.id, newConversation: true, content: "/hold" });
    const child = await j.api.actFacade.sendMessage({ space: b.id, newConversation: true, content: "/hold", parentTaskId: parent.taskId });
    const question = await j.api.actFacade.chatAsk({ space: b.id, taskId: child.taskId, question: "Which currency?", respondent: "person" });
    await j.release(child.taskId); await j.settled(b.id, child.taskId);
    const root = j.api.requests.byTaskId(parent.taskId)!;
    const read = async () => {
      const response = await fetch(`${j.api.origin}/api/spaces/${a.id}/conversations/${parent.conversationId}/work`);
      assert.equal(response.status, 200);
      return (await response.json() as any).work;
    };
    const post = (action: string, body: unknown) => fetch(`${j.api.origin}/api/requests/${root.requestId}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const view = await read();
    assert.equal(view.requestId, root.requestId);
    assert.equal(view.canStop, true);
    assert.equal(view.questions[0].text, "Which currency?");
    assert.equal(view.questions[0].from, "Quotes");
    assert.equal(view.questions[0].canAnswer, true);
    assert.equal(view.children[0].label, "Needs your answer");
    const answered = await post("answer", { questionId: question.question.questionId, answer: "/hold" });
    assert.equal(answered.status, 200, await answered.text());
    const continued = j.api.requests.byTaskId(child.taskId)!;
    assert.equal(continued.turns.length, 2);
    assert.equal((await read()).questions.length, 0);
    const replay = await post("answer", { questionId: question.question.questionId, answer: "/hold" });
    assert.equal(replay.status, 200);
    assert.equal(j.api.requests.byTaskId(child.taskId)!.turns.length, 2);
    const other = await j.api.actFacade.chatAsk({ space: b.id, taskId: continued.turns[1]!.taskId, question: "Confirm the date?", respondent: "person" });
    await j.release(continued.turns[1]!.taskId); await j.settled(b.id, continued.turns[1]!.taskId);
    await j.api.requests.answer({ questionId: other.question.questionId, answer: "/hold" });
    assert.equal((await read()).questions[0].state, "recorded");
    assert.equal((await read()).children[0].label, "Ready to continue");
    const stop = await fetch(`${j.api.origin}/api/spaces/${a.id}/conversations/${parent.conversationId}/abort`, { method: "POST" });
    assert.equal(stop.status, 200);
    assert.equal(j.api.requests.get(root.requestId)!.state, "stopped");
    assert.equal(j.api.requests.question(other.question.questionId)!.state, "cancelled");
    assert.equal((await read()).canStop, false);
    const late = await post("answer", { questionId: other.question.questionId, answer: "/hold" });
    assert.notEqual(late.status, 200);
    await j.release(parent.taskId);
  } finally { await j.close(); }
});

test("paired work views admit only the browser's management request and its descendants", async () => {
  const j = await startJourney("work-ui-remote");
  try {
    const space = (await j.api.actFacade.createSpace({ name: "Research" })).space;
    j.held.add(workFoldManagementScopeId); j.held.add(space.id);
    const principal = { browserId: "browser-one", grantId: "grant-one", requestId: "remote-origin" };
    const root = await j.api.remoteFacade.execute("management.send", { content: "/hold", newConversation: true }, principal) as any;
    const child = await j.api.actFacade.sendMessage({ space: space.id, newConversation: true, content: "/hold", parentTaskId: root.taskId });
    const question = await j.api.actFacade.chatAsk({ space: space.id, taskId: child.taskId, question: "Which region?", respondent: "person" });
    await j.release(child.taskId); await j.settled(space.id, child.taskId);
    const work = await j.api.remoteFacade.execute("management.work", { taskId: child.taskId }, principal) as any;
    assert.equal(work.work.questions[0].id, question.question.questionId);
    await assert.rejects(j.api.remoteFacade.execute("management.work", { taskId: child.taskId }, { ...principal, grantId: "another-grant" }), /another surface/);
    await assert.rejects(j.api.remoteFacade.execute("management.answer", { taskId: root.taskId, questionId: question.question.questionId, answer: "/hold" }, { ...principal, browserId: "other-browser" }), /another surface/);
    await j.api.remoteFacade.execute("management.answer", { taskId: root.taskId, questionId: question.question.questionId, answer: "/hold" }, principal);
    assert.equal(j.api.requests.byTaskId(child.taskId)!.turns.length, 2);
    const local = await j.api.actFacade.sendMessage({ space: space.id, newConversation: true, content: "/hold" });
    const localQuestion = await j.api.actFacade.chatAsk({ space: space.id, taskId: local.taskId, question: "Private question", respondent: "person" });
    await assert.rejects(j.api.remoteFacade.execute("management.answer", { taskId: root.taskId, questionId: localQuestion.question.questionId, answer: "/hold" }, principal), /does not belong/);
    const glance = await j.api.remoteFacade.execute("management.glance", {}, principal) as any;
    assert.equal(glance.glance.needsYou.find((item: any) => item.ref.questionId === localQuestion.question.questionId).canOpenWork, false);
  } finally { await j.close(); }
});

test("saved delegated files are usable and an explicit follow-up carries those results once", async () => {
  const j = await startJourney("work-ui-results");
  try {
    await j.api.requests.setContinuationsEnabled(false);
    const a = (await j.api.actFacade.createSpace({ name: "Planning" })).space;
    const b = (await j.api.actFacade.createSpace({ name: "Quotes" })).space;
    j.held.add(a.id); j.held.add(b.id);
    const parent = await j.api.actFacade.sendMessage({ space: a.id, newConversation: true, content: "/hold" });
    const child = await j.api.actFacade.sendMessage({ space: b.id, newConversation: true, content: "/hold", parentTaskId: parent.taskId });
    await writeFile(join(b.spaceRoot, "comparison.txt"), "North: $42; South: $50");
    await j.api.actFacade.chatReport({ space: b.id, taskId: child.taskId, summary: "North costs eight dollars less.", outcome: "partial", files: ["comparison.txt"] });
    await j.release(child.taskId); await j.settled(b.id, child.taskId);
    await j.release(parent.taskId); await j.settled(a.id, parent.taskId);
    const record = j.api.requests.byTaskId(parent.taskId)!;
    const response = await fetch(`${j.api.origin}/api/tasks/${parent.taskId}/work`);
    const view = (await response.json() as any).work;
    assert.equal(view.state, "partial");
    assert.equal(view.label, "Partly finished");
    assert.equal(view.canContinue, true);
    assert.equal(view.result.files[0].spaceId, b.id);
    assert.equal(view.result.files[0].path, "comparison.txt");
    const resume = () => fetch(`${j.api.origin}/api/requests/${record.requestId}/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deliveryId: "manual-ui-once" }) });
    const accepted = await resume();
    assert.equal(accepted.status, 200, await accepted.text());
    const replay = await resume();
    assert.equal(replay.status, 200, await replay.text());
    assert.equal(j.api.requests.get(record.requestId)!.turns.length, 2);
    assert.deepEqual(j.api.requests.get(record.requestId)!.deliveredChildTaskIds, [child.taskId]);
    const transcript = await readFile(join(conversationsDir(a.spaceRoot), `${parent.conversationId}.jsonl`), "utf8");
    const followup = transcript.trim().split("\n").map((line) => JSON.parse(line)).find((message) => message.kind === "assistant_continuation");
    assert.ok(followup);
    assert.match(followup.content, /North costs eight dollars less/);
    assert.match(followup.content, /comparison.txt/);
    const currentTask = j.api.requests.get(record.requestId)!.turns.at(-1)!.taskId;
    await j.release(currentTask); await j.settled(a.id, currentTask);
    const finished = await fetch(`${j.api.origin}/api/tasks/${parent.taskId}/work`);
    assert.equal((await finished.json() as any).work.canContinue, false, "delivered results do not offer another synthesis");
  } finally { await j.close(); }
});
