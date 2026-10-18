import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { conversationSessionPath, copyPiConversationSession } from "../src/local/agent/pi-client.js";
import type { PiRuntimeProvider } from "../src/local/agent/pi-runtime-config.js";

/**
 * `chat copy` copies a Chat's Pi session along its current path, ending at
 * the newest reply that asked for no tool, so the copy never inherits an
 * unanswered tool call from a turn still running in the original.
 */
test("a forked Pi session ends at the last finished reply and leaves the original untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-fork-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = join(root, "sessions");
  const workFolderRoot = join(root, "work-folder");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(workFolderRoot, { recursive: true });
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir: join(root, "agent"), sessionDir }; } };

  const sourcePath = conversationSessionPath(sessionDir, "chat-source");
  const source = SessionManager.open(sourcePath, sessionDir, workFolderRoot);
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content: unknown[], stopReason: string) => ({ role: "assistant", content, api: "openai-completions", provider: "test", model: "test", usage, stopReason, timestamp: Date.now() });
  source.appendMessage({ role: "user", content: "Draft the intro.", timestamp: Date.now() } as never);
  source.appendMessage(assistant([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.md" } }], "toolUse") as never);
  source.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "notes" }], isError: false, timestamp: Date.now() } as never);
  source.appendMessage(assistant([{ type: "text", text: "Here is the intro." }], "stop") as never);
  // A second turn still running: its tool call has no result yet.
  source.appendMessage({ role: "user", content: "Now the conclusion.", timestamp: Date.now() } as never);
  source.appendMessage(assistant([{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "draft.md" } }], "toolUse") as never);
  const before = await readFile(sourcePath, "utf8");

  assert.equal(await copyPiConversationSession({ workFolderRoot, runtimeProvider: provider, sourceConversationId: "chat-source", targetConversationId: "chat-copy" }), true);
  const copyPath = conversationSessionPath(sessionDir, "chat-copy");
  assert.ok(existsSync(copyPath));
  const copy = SessionManager.open(copyPath, sessionDir, workFolderRoot);
  const messages = copy.getBranch().filter((entry) => entry.type === "message").map((entry) => (entry as { message: { role: string; content: unknown } }).message);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
  assert.equal(JSON.stringify(messages.at(-1)!.content).includes("Here is the intro."), true);
  assert.equal(JSON.stringify(messages).includes("call-2"), false, "the running turn's unanswered call stays behind");
  assert.equal(await readFile(sourcePath, "utf8"), before, "the original session is never written");

  assert.equal(await copyPiConversationSession({ workFolderRoot, runtimeProvider: provider, sourceConversationId: "chat-missing", targetConversationId: "chat-copy-2" }), false);
});
