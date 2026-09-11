import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RestrictedAppTaskService,
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
    properties: { blob: { type: "string", maxLength: 300_000 } },
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
      ...Array.from({ length: restrictedAppAssistantLimits.resultFiles + 4 }, (_item, index) => ({
        path: `exports/file-${index}.md`, sha256: sha256(`file-${index}`), sizeBytes: index,
      })),
    ],
  });
  f.settle(task.id, "ignored");
  const files = (await f.service.get(scope, task.requestId)).result!.files!;
  assert.equal(files.length, restrictedAppAssistantLimits.resultFiles);
  assert.ok(files.every((file) => file.path.startsWith("exports/")), "nothing outside the Space survives");
});

test("an envelope over the whole-result ceiling drops its details first and says it was trimmed", async (t) => {
  // A full-size `data` plus a full-size summary is the one way a valid report
  // can pass both field bounds and still overrun the envelope ceiling.
  const f = await fixture(t, { actions: [blobAction] });
  const task = await f.file(blobAction.id);
  f.setReport({
    summary: "x".repeat(restrictedAppAssistantLimits.summaryBytes),
    truncated: false,
    outcome: "succeeded",
    data: { blob: "y".repeat(restrictedAppAssistantLimits.dataBytes - 64) },
    files: [{ path: "exports/comparison.md", sha256: sha256("comparison"), sizeBytes: 8 }],
  });
  f.settle(task.id, "ignored");
  const result = (await f.service.get(scope, task.requestId)).result!;
  assert.equal(result.truncated, true);
  assert.equal(result.data, undefined, "details go first: the app can ask for them again");
  assert.deepEqual(result.files?.map((file) => file.path), ["exports/comparison.md"], "deliverables outlive details");
  assert.equal(Buffer.byteLength(result.summary), restrictedAppAssistantLimits.summaryBytes,
    "the summary is the one field an app always has");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= restrictedAppAssistantLimits.resultBytes);
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
