import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { buildTurnContextMessage, PiConversationClient } from "../src/local/agent/pi-client.js";
import {
  buildTurnIdentity,
  restatedRequestMaxChars,
  restateTurnIdentity,
  workFoldTurnContextCustomType,
  workFoldTurnIdentityCustomType,
} from "../src/local/agent/turn-identity.js";
import { buildWorkFolderTurnContext } from "../src/local/agent/work-folder-turn-context.js";

const workFolderId = "space-0123456789abcdef";

test("answer continuations retain the original output contract through compaction", () => {
  const assignment = 'Deliver result.json with exactly {totals: {currency: "0.00"}, includedIds: [], excludedIds: []}. Preserve sources.';
  const answer = "Exclude disputed rows and use the corrected source.";
  const workFolderTurn = buildWorkFolderTurnContext({ workFolderId, taskId: "answer-task", requestId: "request-a", assignment, answeredQuestionId: "question-a", handleSalt: "salt" });
  const identity = buildTurnIdentity({ workFolderTurn, request: answer })!;
  const messages = [{ role: "compactionSummary", summary: "The answer says to exclude disputes; write currencyTotals." }, { role: "user", content: answer }];
  const note = restateTurnIdentity(messages, identity)![1]!.content as string;
  assert.ok(note.includes(assignment), "the original assignment's literal fields must survive, not just the latest answer");
  assert.doesNotMatch(note, /<request>/, "the visible answer is not duplicated");
  assert.ok(!restateTurnIdentity(messages, buildTurnIdentity({ workFolderTurn: { workFolderId, taskId: "other", requestId: "request-b" }, request: "Another request" }))![1]!.content!.includes(assignment), "another request cannot inherit this assignment");
});

test("assignment recovery is bounded, preserves delegated scope and avoids duplicating visible instructions", () => {
  const assignment = `Use literal field names. ${"x".repeat(restatedRequestMaxChars)}TAIL`;
  const turn = buildWorkFolderTurnContext({ workFolderId, taskId: "child-answer", requestId: "child", parentTaskId: "hidden-parent", assignment, handleSalt: "salt" });
  const identity = buildTurnIdentity({ workFolderTurn: turn, request: "The answer is exclude." })!;
  const summary = { role: "compactionSummary", summary: "Earlier work." };
  const note = restateTurnIdentity([summary], identity)![1]!.content as string;
  assert.match(note, /<assignment>\nUse literal field names\./);
  assert.ok(!note.includes("TAIL")); assert.match(note, /original assignment continues/);
  assert.ok(!note.includes("hidden-parent"));
  const visible = restateTurnIdentity([summary, { role: "user", content: assignment }], identity)![1]!.content as string;
  assert.ok(!visible.includes("<assignment>"), "a fully visible assignment is not repeated");
  assert.equal(buildTurnIdentity({ workFolderTurn: turn, request: assignment })!.assignment, undefined, "the current request already carries an identical assignment");
  const short = { ...turn, delegated: { ...turn.delegated!, assignment: "A bounded excerpt", assignmentTruncated: true } };
  assert.match(restateTurnIdentity([summary], buildTurnIdentity({ workFolderTurn: short, request: "Continue" }))![1]!.content as string, /already truncated/);
  const prefix = "p".repeat(200);
  const latest = buildTurnIdentity({ workFoldAgentTaskId: "agent-a", request: `${prefix}NEW REQUIREMENT` });
  assert.ok((restateTurnIdentity([summary, { role: "user", content: `${prefix}OLD REQUIREMENT` }], latest)![1]!.content as string).includes("NEW REQUIREMENT"), "a matching prefix cannot stand in for the entire current request");
});

test("a Worker's turn context still opens with its exact identity", () => {
  const workFolderTurn = buildWorkFolderTurnContext({ workFolderId, taskId: "turn-a", requestId: "req-a", handleSalt: "salt" });
  const text = buildTurnContextMessage({ workFolderTurn });
  assert.match(text, /This turn's work-fold identity \(host-owned; use these exact ids\):\n\{\n {2}"workFolderId": "space-0123456789abcdef",\n {2}"taskId": "turn-a",\n {2}"requestId": "req-a"\n\}\nPass --work-folder with that work-folder id and --task with that task id/);
  const agent = buildTurnContextMessage({ workFoldAgentTaskId: "agent-task-1" });
  assert.match(agent, /This work-fold agent request's task id is:\nagent-task-1\nAdd --parent-task with that exact id/);
});

test("the identity is restated after a compaction summary only when the turn's own context is gone", () => {
  const identity = buildTurnIdentity({ workFolderTurn: { workFolderId, taskId: "turn-current", requestId: "req-current" } })!;
  assert.equal(identity.taskId, "turn-current");
  assert.match(identity.text, /replaces any task id, request id, or work-folder id named in the summary/);
  assert.match(identity.text, /"taskId": "turn-current"/);

  const summary = { role: "compactionSummary", summary: "Task ID: turn-previous", timestamp: 10 };
  const ownContext = { role: "custom", customType: workFoldTurnContextCustomType, content: buildTurnContextMessage({
    workFolderTurn: buildWorkFolderTurnContext({ workFolderId, taskId: "turn-current", requestId: "req-current", handleSalt: "salt" }),
  }), timestamp: 20 };
  const olderContext = { ...ownContext, content: "\"taskId\": \"turn-previous\"" };
  const user = { role: "user", content: "Find the reporters.", timestamp: 21 };
  const tool = { role: "toolResult", content: [{ type: "text", text: "lots of text" }], timestamp: 30 };

  assert.equal(restateTurnIdentity([user, tool], identity), undefined, "no compaction, nothing to restate");
  assert.equal(restateTurnIdentity([summary, ownContext, user, tool], identity), undefined, "the turn's own context survived");
  assert.equal(restateTurnIdentity([summary, tool], null), undefined, "between turns there is nothing to restate");

  const restated = restateTurnIdentity([olderContext, summary, tool], identity)!;
  assert.deepEqual(restated.map((message) => message.role), ["custom", "compactionSummary", "custom", "toolResult"]);
  const note = restated[2] as { customType: string; content: string; display: boolean; timestamp: number };
  assert.equal(note.customType, workFoldTurnIdentityCustomType);
  assert.equal(note.display, false);
  assert.equal(note.timestamp, 10, "it sits with the summary, so its position is stable across requests");
  assert.match(note.content, /"taskId": "turn-current"/);

  assert.match(note.content, /Recover applicable observations and findings with progress first/, "restatement recovers completed work before more verification");
  assert.match(note.content, /Recheck changed sources, dynamic state, missing coverage or unresolved concerns/);
  assert.doesNotMatch(note.content, /<request>/, "no request was given, so none is restated");

  const agent = buildTurnIdentity({ workFoldAgentTaskId: "agent-task-9" })!;
  assert.match(restateTurnIdentity([summary, tool], agent)![1]!.content as string, /request's task id is:\nagent-task-9/);
  assert.equal(buildTurnIdentity({}), null);
});

test("after compaction the turn's own request is restated only when it is no longer visible", () => {
  const request = "Which interviewees reported the export bug? People describe it in many different ways.";
  const identity = buildTurnIdentity({ workFolderTurn: { workFolderId, taskId: "turn-current", requestId: "req-current" }, request })!;
  const summary = { role: "compactionSummary", summary: "## Original Request\nThe user's actual task is not included.", timestamp: 10 };
  const tool = { role: "toolResult", content: [{ type: "text", text: "scan output" }], timestamp: 30 };

  const gone = restateTurnIdentity([summary, tool], identity)!;
  const note = gone[1]!.content as string;
  assert.match(note, /This turn's request \(the person's message, restated because the summary above may not include it\):\n<request>\nWhich interviewees reported the export bug\? People describe it in many different ways\.\n<\/request>/);
  assert.ok(note.indexOf("<request>") < note.indexOf("Recover applicable observations"), "the reminder comes last");

  const prompt = { role: "user", content: [{ type: "text", text: request }], timestamp: 25 };
  const visible = restateTurnIdentity([summary, prompt, tool], identity)!;
  assert.doesNotMatch(visible[1]!.content as string, /<request>/, "a request still in view is not repeated");

  const long = `${"x".repeat(restatedRequestMaxChars)}TAIL`;
  const cut = restateTurnIdentity([summary, tool], buildTurnIdentity({ workFoldAgentTaskId: "agent-task-1", request: long }))![1]!.content as string;
  assert.ok(!cut.includes("TAIL"));
  assert.match(cut, /\[The message continues for 4 more characters; it is this turn's message in the Chat\.\]/);
});

test("after a real mid-turn compaction the next request carries the current turn's exact ids, and nothing extra is saved", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wf-compaction-ids-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A long file the second turn reads, enough to cross the compaction trigger.
  await writeFile(join(root, "big.txt"), Array.from({ length: 1500 }, (_, index) => `line ${index}: an ordinary note about the archive`).join("\n"));
  const faux = fauxProvider({ provider: "fixture-identity", models: [{ id: "chat", contextWindow: 200_000, maxTokens: 4_000 }] });
  const credentials = FileCredentialStore.inMemory();
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ compaction: { enabled: true } });
  const client = new PiConversationClient("identity-chat", root, {
    resolveRuntime: async () => ({ agentDir: join(root, "..", `${root.split("/").pop()}-pi`), credentials, modelRuntime,
      preferredModel: { provider: "fixture-identity", id: "chat" }, settingsManager: settings }),
  });
  t.after(() => client.stop());

  const requests: string[] = [];
  let summaries = 0;
  const respond = (context: unknown) => {
    const text = JSON.stringify(context);
    if (text.includes("You are a context summarization assistant")) {
      summaries += 1;
      // The failure observed live: the summary names the previous turn's task id as current.
      return fauxAssistantMessage("## Goal\nList the reporters.\n\n## Critical Context\n- Task ID: `turn-first-0001`\n- Work-folder ID: `space-0123456789abcdef`");
    }
    requests.push(text);
    if (requests.length === 1) return fauxAssistantMessage("Noted.");
    if (requests.length === 2) return fauxAssistantMessage(fauxToolCall("read", { path: "big.txt" }, { id: "read-1" }));
    return fauxAssistantMessage("Done.");
  };
  faux.setResponses(Array.from({ length: 12 }, () => respond));

  const turn = (taskId: string, requestId: string) => buildWorkFolderTurnContext({ workFolderId, taskId, requestId, handleSalt: "salt" });
  assert.equal(await client.prompt("Remember this handbook.", { workFolderTurn: turn("turn-first-0001", "req-first") }), "Noted.");
  // Put the trigger just above what the Chat already holds, as a long Chat would be.
  const held = (await client.getState()).usage.contextTokens ?? 0;
  assert.ok(held > 0);
  settings.applyOverrides({ compaction: { enabled: true, reserveTokens: 200_000 - (held + 3_000), keepRecentTokens: 500 } });

  const assignment = 'Deliver result.json with exactly {totals: {currency: "0.00"}, includedIds: [], excludedIds: []}.';
  assert.equal(await client.prompt("Which reporters are there?", { workFolderTurn: { ...turn("turn-second-0002", "req-second"), assignment, answeredQuestionId: "question-current" } }), "Done.");
  assert.ok(summaries >= 1, "Pi compacted during the second turn");
  const afterCompaction = requests.at(-1)!;

  assert.match(afterCompaction, /turn-first-0001/, "the misleading summary is still there");
  const restatement = "The conversation above was compacted while this turn was running";
  assert.ok(afterCompaction.includes(restatement), "the identity is restated");
  assert.ok(afterCompaction.includes(JSON.stringify(assignment).slice(1, -1)), "the original assignment's exact data shape reaches the real post-compaction transport");
  const requestAt = afterCompaction.indexOf("Which reporters are there?");
  assert.ok(requestAt > afterCompaction.indexOf("This turn's request"), "the turn's own request, summarized away, is restated");
  assert.equal(afterCompaction.indexOf("Which reporters are there?", requestAt + 1), -1, "only once");
  assert.ok(afterCompaction.includes("Recover applicable observations"), "with recovery and targeted rechecks rather than repeating every check");
  assert.match(afterCompaction, /\\"taskId\\": \\"turn-second-0002\\"/, "with the current turn's exact task id");
  assert.ok(afterCompaction.indexOf(restatement) > afterCompaction.indexOf("Critical Context"), "after the summary that names the old one");
  for (const before of requests.slice(0, 2)) assert.ok(!before.includes(restatement), "no restatement before any compaction");

  const saved = await readFile((await client.getState()).sessionFile!, "utf8");
  assert.match(saved, /"type":"compaction"/);
  assert.ok(!saved.includes(restatement), "the restatement is request-local");
});

test("the restatement after compaction carries the request's checklist as it stands", () => {
  const identity = buildTurnIdentity({ workFolderTurn: { workFolderId, taskId: "turn-current", requestId: "req-current" } })!;
  const summary = { role: "compactionSummary", summary: "Earlier work.", timestamp: 10 };
  const messages = [summary, { role: "user", content: "Keep going.", timestamp: 20 }];
  const withChecklist = restateTurnIdentity(messages, { ...identity, checklist: [{ text: "Read the quotes", status: "done" }, { text: "Write the summary", status: "doing" }] })!;
  const note = withChecklist.find((message) => (message as { customType?: string }).customType === workFoldTurnIdentityCustomType) as { content: string };
  assert.match(note.content, /Your checklist for this request as it stands/);
  assert.match(note.content, /\[x\] Read the quotes\n\[~\] Write the summary/);
  const without = restateTurnIdentity(messages, identity)!;
  const plain = without.find((message) => (message as { customType?: string }).customType === workFoldTurnIdentityCustomType) as { content: string };
  assert.doesNotMatch(plain.content, /checklist/i);
});
