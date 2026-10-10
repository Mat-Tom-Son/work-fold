import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RestrictedAppTaskService,
  restrictedAppResultWithinCeiling,
  restrictedAppTaskAuthorityDigest,
  restrictedAppTaskPrompt,
  restrictedAppTaskTurnRequestId,
  type RestrictedAppTaskPorts,
  type RestrictedAppTaskScope,
} from "../src/local/agent/restricted-app-tasks.js";
import type { RestrictedAppAssistantAction } from "../src/local/agent/restricted-app-manifest.js";
import { restrictedAppAssistantLimits } from "../src/shared/restricted-app-tasks.js";
import type { RestrictedAppTaskResult } from "../src/shared/restricted-app-tasks.js";
import type { WorkFoldDurableTurnRecord } from "../src/local/agent/turn-store.js";

const outputSchema = {
  type: "object" as const,
  properties: { cheapest: { type: "string" as const, maxLength: 80 }, total: { type: "number" as const } },
  required: ["cheapest"],
  additionalProperties: false as const,
};
const action: RestrictedAppAssistantAction = {
  id: "compare",
  title: "Compare quotes",
  instructions: "Compare the submitted quotes and write comparison.md.",
  inputSchema: { type: "object", properties: { quote: { type: "string", maxLength: 200 } }, required: ["quote"], additionalProperties: false },
  outputSchema,
};
const plainAction: RestrictedAppAssistantAction = { ...action, id: "summarize", title: "Summarize" };
delete (plainAction as { outputSchema?: unknown }).outputSchema;

const blobAction: RestrictedAppAssistantAction = {
  ...action,
  id: "export",
  title: "Export",
  outputSchema: {
    type: "object",
    properties: { blob: { type: "string", maxLength: 16 * 1024 * 1024 } },
    required: ["blob"],
    additionalProperties: false,
  },
};

const scope: RestrictedAppTaskScope = {
  spaceId: "space-one",
  appId: "quotes",
  featureInstallationId: "feature-one",
  digest: "a".repeat(64),
  authorityDigest: restrictedAppTaskAuthorityDigest({ generation: 1 }),
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture(t: test.TestContext, options: { actions?: RestrictedAppAssistantAction[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-app-envelope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = new Date("2026-09-07T12:00:00.000Z");
  const turns = new Map<string, WorkFoldDurableTurnRecord>();
  let report: RestrictedAppTaskResult | null = null;
  const ports: RestrictedAppTaskPorts = {
    async withApp(_pin, operation) { return operation(options.actions ?? [action], { title: "Quote board" }); },
    async dispatch(record) {
      turns.set(record.id, {
        schema: "work-fold.turn.v1", turnId: `turn-${record.id}`, requestId: restrictedAppTaskTurnRequestId(record),
        requestDigest: "d".repeat(64), userMessageId: `message-${record.id}`, userMessageCreatedAt: now.toISOString(),
        spaceId: record.scope.spaceId, conversationId: record.conversationId, actorKind: "system", status: "running",
        userMessagePersisted: true, acceptedAt: now.toISOString(), updatedAt: now.toISOString(), assistantText: "",
      });
    },
    findTurn(record) { return turns.get(record.id) ?? null; },
    async cancelTurn() { /* unused */ },
    async findReport() { return report ? structuredClone(report) : null; },
  };
  const path = join(root, "tasks.json");
  let service = await RestrictedAppTaskService.create({ path, ports, now: () => now });
  return {
    path,
    ports,
    turns,
    get service() { return service; },
    file: async (actionId = action.id) => {
      const requestId = randomUUID();
      const started = await service.request(scope, { requestId, requestedAt: now.toISOString(), actionId, input: { quote: "North: $42" } });
      return { requestId, id: started.id };
    },
    settle: (id: string, assistantText: string) => {
      const turn = turns.get(id)!;
      turn.status = "succeeded";
      turn.assistantText = assistantText;
    },
    setReport: (value: RestrictedAppTaskResult | null) => { report = value; },
    restart: async () => { await service.flush(); service = await RestrictedAppTaskService.create({ path, ports, now: () => now }); },
  };
}

test("a settled turn with no filed report exposes the reply as the summary and nothing else", async (t) => {
  const f = await fixture(t);
  const task = await f.file();
  f.settle(task.id, "Saved comparison.md. North is cheaper.");
  const result = (await f.service.get(scope, task.requestId)).result!;
  assert.deepEqual(result, { summary: "Saved comparison.md. North is cheaper.", truncated: false, outcome: "succeeded" });
});

test("a filed report carries its summary, its outcome, validated details and the files it named", async (t) => {
  const f = await fixture(t);
  const task = await f.file();
  f.setReport({
    summary: "North is cheaper by $8.",
    truncated: false,
    outcome: "partial",
    data: { cheapest: "North", total: 42 },
    files: [{ path: "exports/comparison.md", sha256: sha256("comparison"), sizeBytes: 512 }],
  });
  f.settle(task.id, "ignored once a report exists");
  const result = (await f.service.get(scope, task.requestId)).result!;
  assert.equal(result.summary, "North is cheaper by $8.");
  assert.equal(result.outcome, "partial", "the Assistant's own account of the outcome survives");
  assert.deepEqual(result.data, { cheapest: "North", total: 42 });
  assert.deepEqual(result.files, [{ path: "exports/comparison.md", sha256: sha256("comparison"), sizeBytes: 512 }]);
  assert.equal((await f.service.list(scope))[0].result, undefined, "the sandbox list stays content-free");
  const primary = (await f.service.list(scope, "installation", "summary"))[0].result!;
  assert.equal(primary.summary, result.summary, "the trusted Apps screen gets its primary summary");
  assert.deepEqual(primary.files, result.files);
  assert.equal(primary.data, undefined, "structured details stay in the individual read");

  await f.restart();
  assert.deepEqual((await f.service.get(scope, task.requestId)).result, result, "the envelope survives a restart intact");
});

test("the declared shape is findable from the running turn, so `chat report` can check it first", async (t) => {
  const f = await fixture(t, { actions: [action, plainAction] });
  const task = await f.file();
  const turn = f.turns.get(task.id)!;

  // `chat report` resolves the pinned shape from the turn it is reporting for,
  // so a mismatched report is refused while the Assistant can still correct it
  // (docs/collaboration-contract.md, F29 — validated at report time, and again
  // when the result is projected to the app).
  assert.deepEqual(
    f.service.outputSchemaForTurn({ spaceId: scope.spaceId, conversationId: turn.conversationId, taskId: turn.turnId }),
    outputSchema,
  );
  // The pin is per task, not per manifest: another Space, another Chat, and
  // another turn id all answer nothing.
  assert.equal(f.service.outputSchemaForTurn({ spaceId: "space-two", conversationId: turn.conversationId, taskId: turn.turnId }), null);
  assert.equal(f.service.outputSchemaForTurn({ spaceId: scope.spaceId, conversationId: "chat-other", taskId: turn.turnId }), null);
  assert.equal(f.service.outputSchemaForTurn({ spaceId: scope.spaceId, conversationId: turn.conversationId, taskId: "turn-other" }), null);

  // An action that declared no shape has nothing to check against.
  const plain = await f.file(plainAction.id);
  const plainTurn = f.turns.get(plain.id)!;
  assert.equal(
    f.service.outputSchemaForTurn({ spaceId: scope.spaceId, conversationId: plainTurn.conversationId, taskId: plainTurn.turnId }),
    null,
  );
});

test("details that do not match the declared shape are dropped, said plainly, and the outcome is honest", async (t) => {
  const f = await fixture(t);
  const task = await f.file();
  f.setReport({ summary: "Compared the quotes.", truncated: false, outcome: "succeeded", data: { cheapest: 42 } });
  f.settle(task.id, "ignored");
  const result = (await f.service.get(scope, task.requestId)).result!;
  assert.equal(result.data, undefined);
  assert.equal(result.outcome, "failed");
  assert.match(result.summary, /did not match the object shape this action declared/);
  assert.match(result.summary, /Compared the quotes\./, "the Assistant's own words are kept");
});

test("details reported for an action that declared no shape never reach the app", async (t) => {
  const f = await fixture(t, { actions: [plainAction] });
  const task = await f.file(plainAction.id);
  f.setReport({ summary: "Summarized.", truncated: false, outcome: "succeeded", data: { anything: true } });
  f.settle(task.id, "ignored");
  const result = (await f.service.get(scope, task.requestId)).result!;
  assert.equal(result.data, undefined);
  assert.equal(result.outcome, "failed");
  assert.match(result.summary, /declared no shape for reported details/);
});

test("deliverables are bounded and each entry must name a safe Space-relative path", async (t) => {
  const f = await fixture(t);
  const task = await f.file();
  f.setReport({
    summary: "Exported everything.",
    truncated: false,
    outcome: "succeeded",
    files: [
      { path: "../outside.md", sha256: sha256("a"), sizeBytes: 1 },
      { path: ".work-fold/space.json", sha256: sha256("b"), sizeBytes: 1 },
      { path: "/absolute.md", sha256: sha256("c"), sizeBytes: 1 },
      { path: "ok.md", sha256: "not-a-fingerprint", sizeBytes: 1 },
      { path: "ok.md", sha256: sha256("d"), sizeBytes: -1 },
      ...Array.from({ length: 100 }, (_item, index) => ({
        path: `exports/file-${index}.md`, sha256: sha256(`file-${index}`), sizeBytes: index,
      })),
    ],
  });
  f.settle(task.id, "ignored");
  const files = (await f.service.get(scope, task.requestId)).result!.files!;
  assert.equal(files.length, 100);
  assert.ok(files.every((file) => file.path.startsWith("exports/")), "nothing outside the Space survives");
});

test("full-size details and a full-size summary now fit the envelope untouched", async (t) => {
  // This used to be the one way a valid report overran a 256 KiB ceiling. The
  // envelope is now far above both field bounds, so nothing is trimmed.
  assert.ok(restrictedAppAssistantLimits.resultBytes >= 16 * 1024 * 1024);
  const f = await fixture(t, { actions: [blobAction] });
  const task = await f.file(blobAction.id);
  const data = { blob: "y".repeat(restrictedAppAssistantLimits.dataBytes - 64) };
  f.setReport({
    summary: "x".repeat(restrictedAppAssistantLimits.summaryBytes),
    truncated: false,
    outcome: "succeeded",
    data,
    files: [{ path: "exports/comparison.md", sha256: sha256("comparison"), sizeBytes: 8 }],
  });
  f.settle(task.id, "ignored");
  const result = (await f.service.get(scope, task.requestId)).result!;
  assert.equal(result.truncated, false);
  assert.deepEqual(result.data, data, "details survive");
  assert.deepEqual(result.files?.map((file) => file.path), ["exports/comparison.md"]);
  assert.equal(result.summary, "x".repeat(restrictedAppAssistantLimits.summaryBytes));
});

test("an envelope over the whole-result ceiling drops details, then files, then summary — and says exactly what", () => {
  const ceiling = 2 * 1024;
  const file = (index: number) => ({ path: `exports/file-${index}.md`, sha256: sha256(`file-${index}`), sizeBytes: index });
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const base = { summary: "The comparison is done.", truncated: false, outcome: "succeeded" as const };

  const detailsOnly = restrictedAppResultWithinCeiling({ ...base, data: { blob: "y".repeat(4_000) }, files: [file(1), file(2)] }, ceiling);
  assert.equal(detailsOnly.truncated, true);
  assert.equal(detailsOnly.data, undefined, "details go first: the app can ask for them again");
  assert.equal(detailsOnly.files?.length, 2, "deliverables outlive details");
  assert.match(detailsOnly.summary, /^\[work-fold: this result was larger than 2 KB, the result limit in Settings → Automations → Limits, so its details were left out\.\]\n\nThe comparison is done\.$/);
  assert.ok(size(detailsOnly) <= ceiling);

  const files = Array.from({ length: 40 }, (_, index) => file(index));
  const someFiles = restrictedAppResultWithinCeiling({ ...base, files }, ceiling);
  assert.equal(someFiles.truncated, true);
  assert.ok(someFiles.files && someFiles.files.length > 0 && someFiles.files.length < files.length);
  assert.deepEqual(someFiles.files, files.slice(0, someFiles.files.length), "files are kept from the front");
  const dropped = files.length - someFiles.files.length;
  assert.match(someFiles.summary, new RegExp(`so ${dropped} of its ${files.length} files were left out\\.\\]`));
  assert.ok(size(someFiles) <= ceiling);

  const both = restrictedAppResultWithinCeiling({ ...base, data: { blob: "y" }, files }, ceiling);
  assert.match(both.summary, /so its details and \d+ of its 40 files were left out\.\]/);
  assert.ok(size(both) <= ceiling);

  // A summary bound larger than the envelope: the summary itself is shortened, note first.
  const longSummary = restrictedAppResultWithinCeiling({ ...base, summary: "z".repeat(10_000) }, ceiling, 32 * 1024);
  assert.equal(longSummary.truncated, true);
  assert.match(longSummary.summary, /^\[work-fold: this result was larger than 2 KB, the result limit in Settings → Automations → Limits, so its summary was shortened\.\]\n\nz+$/);
  assert.ok(size(longSummary) <= ceiling);

  const untouched = { ...base, data: { ok: true }, files: [file(1)] };
  assert.deepEqual(restrictedAppResultWithinCeiling(untouched, ceiling), untouched, "a result within the ceiling is returned as it is");
});

test("a failed, stopped or interrupted task exposes no envelope at all", async (t) => {
  const f = await fixture(t);
  f.setReport({ summary: "Half done.", truncated: false, outcome: "partial" });
  for (const status of ["failed", "aborted", "interrupted"] as const) {
    const task = await f.file();
    f.turns.get(task.id)!.status = status;
    const settled = await f.service.get(scope, task.requestId);
    assert.notEqual(settled.status, "succeeded");
    assert.equal(settled.result, undefined);
  }
});

test("a v2 journal upgrades its reply into a summary and is rewritten as v3", async (t) => {
  const f = await fixture(t);
  const task = await f.file();
  f.settle(task.id, "Saved comparison.md.");
  await f.service.get(scope, task.requestId);
  await f.service.flush();

  const journal = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(journal.schema, "work-fold.app-assistant-tasks.v3");
  const downgraded = {
    schema: "work-fold.app-assistant-tasks.v2",
    records: journal.records.map((record: Record<string, unknown>) => {
      const { outputSchema: _schema, ...rest } = record;
      return { ...rest, result: { text: "Saved comparison.md.", truncated: false } };
    }),
  };
  await writeFile(f.path, JSON.stringify(downgraded));

  await f.restart();
  const upgraded = (await f.service.get(scope, task.requestId)).result!;
  assert.deepEqual(upgraded, { summary: "Saved comparison.md.", truncated: false, outcome: "succeeded" });
  await f.file(); // the next save rewrites the whole journal at the current schema
  await f.service.flush();
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).schema, "work-fold.app-assistant-tasks.v3");
});

test("the dispatched Chat is told how to report and what shape the app asked for", async (t) => {
  const f = await fixture(t);
  const task = await f.file();
  const detail = await f.service.detail(scope, task.requestId);
  const prompt = restrictedAppTaskPrompt(
    { ...detail, outputSchema },
    "Quote board",
  );
  assert.match(prompt, /work-fold chat report/);
  assert.match(prompt, /"cheapest"/);
  assert.match(prompt, /If you do not report, your final reply becomes the summary/);
  const plain = restrictedAppTaskPrompt({ title: "Summarize", instructions: "Do it.", inputJson: "{}" }, "Quote board");
  assert.doesNotMatch(plain, /JSON Schema/);
  assert.match(plain, /work-fold chat report/);
});


test("an unavailable selected report is a retriable read failure, never fallback success", async (t) => {
  const f = await fixture(t); const task = await f.file();
  f.settle(task.id, "Earlier reply");
  f.ports.findReport = async () => { throw new Error("temporary report read failure"); };
  await assert.rejects(f.service.get(scope, task.requestId), /temporary report read failure/);
  f.ports.findReport = async () => ({ summary: "Recovered selected result", outcome: "succeeded", truncated: false });
  assert.equal((await f.service.get(scope, task.requestId)).result?.summary, "Recovered selected result");
});

test("status polling reuses a validated report but follows a later request turn", async (t) => {
  const f = await fixture(t); const task = await f.file();
  const origin = f.turns.get(task.id)!;
  let latest = origin;
  let reads = 0;
  f.ports.findRequest = () => ({ state: latest.status === "succeeded" ? "done" : "working", taskIds: [origin.turnId, latest.turnId], turn: latest, usage: { turns: 1, inputTokens: 10, outputTokens: 5, amountUsdComplete: false } });
  f.ports.findReport = async () => ({ summary: `Result ${++reads}`, outcome: "succeeded", truncated: false });
  f.settle(task.id, "Initial result");
  assert.equal((await f.service.get(scope, task.requestId)).result?.summary, "Result 1");
  await f.service.get(scope, task.requestId);
  assert.equal(reads, 1);
  latest = { ...origin, turnId: "later-turn", status: "running", updatedAt: "2026-09-07T12:01:00.000Z" };
  const running = await f.service.get(scope, task.requestId);
  assert.equal(running.status, "running");
  assert.equal(running.result, undefined);
  latest.status = "succeeded";
  assert.equal((await f.service.get(scope, task.requestId)).result?.summary, "Result 2");
});
