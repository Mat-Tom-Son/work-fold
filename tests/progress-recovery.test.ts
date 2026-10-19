import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { FileCredentialStore, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ProgressRecovery, progressContextType, retainedEvidenceChars } from "../src/local/agent/progress-recovery.js";
import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { buildWorkFolderTurnContext } from "../src/local/agent/work-folder-turn-context.js";

async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = SessionManager.create(root, join(root, "sessions"));
  session.appendMessage({ role: "user", content: "A task", timestamp: Date.now() });
  let scope: { requestId: string; taskId: string; taskIds: string[] } | null = { requestId: "req-a", taskId: "turn-a", taskIds: ["turn-a"] };
  const recovery = new ProgressRecovery(root, session, () => scope);
  const handlers = new Map<string, (event: any) => any>();
  await recovery.extension({ on: (name: string, handler: (event: any) => any) => handlers.set(name, handler) } as any);
  const tool = recovery.tool();
  let calls = 0;
  const run = async (params: any) => {
    const result = await tool.execute(`progress-${calls++}`, { input: params }, undefined, undefined, {} as never);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  const capture = async (toolName: string, input: Record<string, unknown>, text: string, id = "call-1", between?: () => Promise<void>) => {
    await handlers.get("tool_call")!({ toolCallId: id, toolName, input });
    await between?.();
    await handlers.get("tool_result")!({ toolCallId: id, toolName, input, content: [{ type: "text", text }], isError: false });
  };
  return { root, session, recovery, run, capture, handlers, setScope: (next: typeof scope) => { scope = next; } };
}

test("completed results and agent findings survive reopen and answer turns without crossing request ownership", async t => {
  const h = await fixture(t);
  await writeFile(join(h.root, "sales.txt"), "USD 140\nEUR 215");
  await h.capture("helper", { task: "reconcile" }, '{"summary":"USD 140; EUR 215","outcome":"succeeded"}');
  const index = await h.run({ action: "list" }); const id = index.records[0].id;
  await h.run({ action: "save", summary: "Reconciled currencies separately", evidence: [id], files: ["sales.txt"] });
  const reopened = SessionManager.open(h.session.getSessionFile()!, join(h.root, "sessions"));
  const recovery = new ProgressRecovery(h.root, reopened, () => ({ requestId: "req-a", taskId: "turn-answer", taskIds: ["turn-a", "turn-answer"] }));
  const read = await recovery.tool().execute("recover", { input: { action: "read", id } }, undefined, undefined, {} as never);
  const recovered = JSON.parse((read.content[0] as { text: string }).text);
  assert.match(recovered.text, /USD 140; EUR 215/);
  assert.equal(recovered.sourceBinding, "untracked", "helper output never claims its implicit file inputs were pinned");
  assert.ok(JSON.stringify(read.details).length < 200, "codemode cannot duplicate the observation through details");
  h.setScope({ requestId: "req-b", taskId: "turn-b", taskIds: ["turn-a", "turn-b"] });
  assert.equal((await h.run({ action: "list" })).total, 0);
  await assert.rejects(h.run({ action: "read", id }), /belongs to this request/);
  await assert.rejects(h.run({ action: "save", summary: "Borrowed", evidence: [id] }), /belong to this request/);
});

test("recovered file observations expose changed, removed and concurrently changed sources", async t => {
  const h = await fixture(t); const path = join(h.root, "source.txt");
  await writeFile(path, "old bytes");
  await h.capture("read", { path: "source.txt", offset: 5, limit: 10 }, "old bytes");
  let id = (await h.run({ action: "list" })).records[0].id;
  assert.equal((await h.run({ action: "read", id })).freshness[0].state, "unchanged");
  assert.equal((await h.run({ action: "read", id })).sourceBinding, "bracketed");
  assert.deepEqual((await h.run({ action: "read", id })).selection, { offset: 5, limit: 10 }, "requested range survives independently of a summarized output");
  await writeFile(path, "new bytes");
  assert.equal((await h.run({ action: "read", id })).freshness[0].state, "changed-or-unavailable");
  assert.equal((await h.run({ action: "read", id })).text, "old bytes", "recovery does not silently replace historical evidence");
  await h.capture("read", { path: "source.txt" }, "new bytes", "call-race", () => writeFile(path, "later bytes"));
  id = (await h.run({ action: "list" })).records.at(-1).id;
  assert.equal((await h.run({ action: "read", id })).sourceBinding, "changed-during-call");
  await writeFile(join(h.root, "other.txt"), "different source");
  await h.handlers.get("tool_call")!({ toolCallId: "changed-input", toolName: "read", input: { path: "source.txt" } });
  await h.handlers.get("tool_result")!({ toolCallId: "changed-input", toolName: "read", input: { path: "other.txt" }, content: [{ type: "text", text: "different source" }], isError: false });
  const changedInput = (await h.run({ action: "list" })).records.at(-1).id;
  assert.equal((await h.run({ action: "read", id: changedInput })).sourceBinding, "changed-during-call", "changed invocation arguments cannot attest the original file");
  await rm(path);
  assert.equal((await h.run({ action: "read", id })).freshness[0].state, "changed-or-unavailable");
});

test("evidence output pages retain original warnings and disclose retention and image limits", async t => {
  const h = await fixture(t);
  const text = `Original tool warning: output truncated; continue at offset 501.\n${"x".repeat(retainedEvidenceChars + 40)}`;
  await h.capture("read", { path: "absent.txt" }, text);
  const id = (await h.run({ action: "list" })).records[0].id;
  const first = await h.run({ action: "read", id, limit: 100 });
  assert.match(first.text, /Original tool warning/); assert.equal(first.nextOffset, 100);
  assert.equal(first.retentionTruncated, true); assert.equal(first.originalChars, text.length);
  const last = await h.run({ action: "read", id, offset: retainedEvidenceChars - 10, limit: 100 });
  assert.equal(last.text.length, 10); assert.equal(last.nextOffset, null);
});

test("finding fingerprints refuse metadata, traversal and outgoing links, and Stop cannot record late work", async t => {
  const h = await fixture(t);
  await mkdir(join(h.root, ".work-fold")); await writeFile(join(h.root, ".work-fold", "private"), "private");
  await symlink(tmpdir(), join(h.root, "outside"));
  for (const path of [".work-fold/private", "../nope", "outside/nope"]) await assert.rejects(h.run({ action: "save", summary: "Claim", files: [path] }), /readable ordinary file/);
  await h.capture("bash", { command: "printf done" }, "done", "late", async () => { h.setScope(null); });
  h.setScope({ requestId: "req-a", taskId: "turn-a", taskIds: ["turn-a"] });
  assert.equal((await h.run({ action: "list" })).total, 0);
});

test("the index pages completed results and distinguishes failed tools and image-only observations", async t => {
  const h = await fixture(t);
  for (let i = 0; i < 41; i++) await h.capture("bash", { command: `case-${i}` }, `output-${i}`, `call-${i}`);
  const first = await h.run({ action: "list", limit: 40 }); assert.equal(first.records.length, 40); assert.equal(first.nextOffset, 40);
  const small = await h.run({ action: "list" }); assert.equal(small.records.length, 10); assert.equal(small.nextOffset, 10);
  assert.equal((await h.run({ action: "list", offset: 40 })).records.length, 1);
  await h.handlers.get("tool_result")!({ toolCallId: "failure", toolName: "edit", input: { path: "source.txt" }, content: [{ type: "text", text: "Could not find the old text" }], isError: true });
  await h.handlers.get("tool_result")!({ toolCallId: "image", toolName: "read", input: { path: "image.png" }, content: [{ type: "image", data: "not-retained", mimeType: "image/png" }], isError: false });
  const last = (await h.run({ action: "list", offset: 40 })).records;
  assert.equal(last[1].failed, true); assert.equal(last[2].imageCount, 1);
  assert.equal((await h.run({ action: "read", id: last[2].id })).text, "");
  assert.ok(!(await readFile(h.session.getSessionFile()!, "utf8")).includes("not-retained"));
  await writeFile(join(h.root, "source.txt"), "source");
  await h.run({ action: "save", summary: "A".repeat(2000), files: ["source.txt"] });
  const note = (await h.run({ action: "list", offset: 43 })).records[0];
  assert.equal(note.summary.length, 240); assert.equal(note.summaryTruncated, true);
  assert.equal(note.sourceCount, 1); assert.equal(note.sources, undefined, "index pages do not repeat full fingerprint payloads");
});

test("malformed invisible journal entries cannot poison recovery context", async t => {
  const h = await fixture(t);
  h.session.appendCustomEntry("work-fold-progress.v1", { requestId: "req-a", taskId: "turn-a", id: "bad", text: "bad", sources: [] });
  assert.equal((await h.run({ action: "list" })).total, 0);
  assert.equal(await h.handlers.get("context")!({ messages: [{ role: "compactionSummary", summary: "Earlier work" }] }), undefined);
});

test("a native compaction recovers a completed read despite a misleading summary, without rereading its file", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-progress-compact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "big.txt"), Array.from({ length: 600 }, (_, i) => `line ${i}: complete retained observation ${"data ".repeat(8)}`).join("\n"));
  const faux = fauxProvider({ provider: "fixture-progress", models: [{ id: "fixture-progress", contextWindow: 200_000 }] });
  const settings = SettingsManager.inMemory({ defaultProvider: "fixture-progress", defaultModel: "fixture-progress", compaction: { enabled: false } });
  const credentials = FileCredentialStore.inMemory(); const models = await ModelRuntime.create({ credentials, modelsPath: null }); models.registerNativeProvider(faux.provider);
  const client = new PiConversationClient("chat-progress", root, { resolveRuntime: async () => ({ agentDir: join(root, "pi"), credentials, settingsManager: settings, modelRuntime: models, preferredModel: { provider: "fixture-progress", id: "fixture-progress" } }) });
  t.after(() => client.stop());
  let requests = 0; let summaries = 0; let recovered = false;
  const evidenceId = `ev-${createHash("sha256").update("turn-current\0read-once").digest("hex").slice(0, 20)}`;
  const respond = (context: unknown) => {
    const text = JSON.stringify(context);
    if (text.includes("You are a context summarization assistant")) { summaries++; return fauxAssistantMessage("Earlier read output was truncated; file reading is incomplete. Repeat all reads."); }
    requests++;
    if (requests === 1) return fauxAssistantMessage("Ready.");
    if (requests === 2) return fauxAssistantMessage(fauxToolCall("read", { path: "big.txt", offset: 1, limit: 600 }, { id: "read-once" }));
    if (requests === 3) {
      assert.ok(text.includes("Host-kept progress and evidence")); assert.ok(text.includes(evidenceId));
      assert.ok(text.includes("does not mean the tool never completed"));
      return fauxAssistantMessage(fauxToolCall("progress", { input: { action: "read", id: evidenceId, offset: 0, limit: 1000 } }));
    }
    if (requests === 4) {
      recovered = text.includes("complete retained observation") && text.includes("unchanged");
      return fauxAssistantMessage(fauxToolCall("progress", { input: { action: "save" } }, { id: "missing-summary" }));
    }
    if (requests === 5) {
      assert.match(text, /summary/, "native validation explains the required save field");
      return fauxAssistantMessage(fauxToolCall("progress", { input: { action: "save", summary: "Read the material once and recovered its observation.", evidence: [evidenceId] } }));
    }
    return fauxAssistantMessage("Recovered the completed observation.");
  };
  faux.setResponses(Array.from({ length: 20 }, () => respond));
  const turn = (taskId: string, requestId: string) => ({ workFolderTurn: buildWorkFolderTurnContext({ workFolderId: "space-0123456789abcdef", taskId, requestId, handleSalt: "salt" }) });
  await client.prompt("Prepare.", turn("turn-before", "req-before"));
  const held = (await client.getState()).usage.contextTokens!;
  settings.applyOverrides({ compaction: { enabled: true, reserveTokens: 200_000 - (held + 2500), keepRecentTokens: 500 } });
  assert.equal(await client.prompt("Read the material and finish.", turn("turn-current", "req-current")), "Recovered the completed observation.");
  assert.ok(summaries > 0); assert.ok(recovered);
  const saved = await readFile((await client.getState()).sessionFile!, "utf8");
  const entries = saved.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const reads = entries.flatMap(entry => entry.message?.role === "assistant" ? entry.message.content.filter((part: any) => part.type === "toolCall" && part.name === "read") : []);
  assert.equal(reads.length, 1, "the model retrieved evidence rather than re-executing read");
  assert.equal(entries.filter(entry => entry.customType === "work-fold-progress.v1" && entry.data?.kind === "finding").length, 1, "the invalid save never becomes a finding");
  assert.ok(!entries.some(entry => entry.customType === progressContextType), "recovery context is request-local, not saved as instructions");
});
