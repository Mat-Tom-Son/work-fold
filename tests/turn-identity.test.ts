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
  restateTurnIdentity,
  workFoldTurnContextCustomType,
  workFoldTurnIdentityCustomType,
} from "../src/local/agent/turn-identity.js";
import { buildWorkFolderTurnContext } from "../src/local/agent/work-folder-turn-context.js";

const workFolderId = "space-0123456789abcdef";

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

  const agent = buildTurnIdentity({ workFoldAgentTaskId: "agent-task-9" })!;
  assert.match(restateTurnIdentity([summary, tool], agent)![1]!.content as string, /request's task id is:\nagent-task-9/);
  assert.equal(buildTurnIdentity({}), null);
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

  assert.equal(await client.prompt("Which reporters are there?", { workFolderTurn: turn("turn-second-0002", "req-second") }), "Done.");
  assert.ok(summaries >= 1, "Pi compacted during the second turn");
  const afterCompaction = requests.at(-1)!;

  assert.match(afterCompaction, /turn-first-0001/, "the misleading summary is still there");
  const restatement = "The conversation above was compacted while this turn was running";
  assert.ok(afterCompaction.includes(restatement), "the identity is restated");
  assert.doesNotMatch(afterCompaction, /Which reporters are there\?/, "this turn's own prompt and context were summarized away");
  assert.match(afterCompaction, /\\"taskId\\": \\"turn-second-0002\\"/, "with the current turn's exact task id");
  assert.ok(afterCompaction.indexOf(restatement) > afterCompaction.indexOf("Critical Context"), "after the summary that names the old one");
  for (const before of requests.slice(0, 2)) assert.ok(!before.includes(restatement), "no restatement before any compaction");

  const saved = await readFile((await client.getState()).sessionFile!, "utf8");
  assert.match(saved, /"type":"compaction"/);
  assert.ok(!saved.includes(restatement), "the restatement is request-local");
});
