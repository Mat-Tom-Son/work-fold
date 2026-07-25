import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  appendMessage,
  conversationsDir,
  listConversations,
  readConversation,
  renameConversation,
  updateConversationLifecycle,
  type ChatMessage,
} from "../src/local/agent/chat-store.js";
import { configureWorkspaceStateRoot, legacyWorkspaceConversationDir, workspaceStateDir } from "../src/local/state-paths.js";

const chatStateRoot = await mkdtemp(join(tmpdir(), "workspace-chat-state-"));
configureWorkspaceStateRoot(chatStateRoot);
after(async () => {
  configureWorkspaceStateRoot(undefined);
  await rm(chatStateRoot, { recursive: true, force: true });
});

function message(id: string, content: string): ChatMessage {
  return {
    id,
    role: "user",
    content,
    createdAt: `2026-01-01T00:00:${id.padStart(2, "0")}Z`,
  };
}

test("chat store appends messages without rewriting the conversation log", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-append-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  await Promise.all(
    Array.from({ length: 20 }, (_, index) => appendMessage(workspaceRoot, "chat-concurrent", message(String(index), `message ${index}`))),
  );

  const messages = await readConversation(workspaceRoot, "chat-concurrent");
  assert.equal(messages.length, 20);
  assert.deepEqual(new Set(messages.map((item) => item.id)), new Set(Array.from({ length: 20 }, (_, index) => String(index))));
});

test("chat store rejects unsafe conversation ids", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-safe-id-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => appendMessage(workspaceRoot, "../outside", message("1", "escape attempt")),
    /Invalid conversation id/,
  );
  await assert.rejects(
    () => readConversation(workspaceRoot, "nested/chat"),
    /Invalid conversation id/,
  );
});

test("chat store migrates external conversations into .workspace without deleting the legacy copy", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-migration-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const legacyDir = legacyWorkspaceConversationDir(workspaceRoot);
  await mkdir(legacyDir, { recursive: true });
  const legacyPath = join(legacyDir, "chat-legacy.jsonl");
  await writeFile(legacyPath, `${JSON.stringify(message("1", "legacy conversation"))}\n`, "utf8");

  assert.equal((await listConversations(workspaceRoot))[0]?.id, "chat-legacy");
  const portablePath = join(conversationsDir(workspaceRoot), "chat-legacy.jsonl");
  assert.equal(await readFile(portablePath, "utf8"), await readFile(legacyPath, "utf8"));
  assert.deepEqual(await readConversation(workspaceRoot, "chat-legacy"), [message("1", "legacy conversation")]);
});

test("chat store skips malformed JSONL lines without deleting the transcript", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-malformed-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const dir = conversationsDir(workspaceRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "chat-malformed.jsonl");
  const systemLine = JSON.stringify({ id: "system", role: "system", content: "Workspace chat", createdAt: "2026-01-01T00:00:00Z" });
  const userLine = JSON.stringify(message("1", "valid user message"));
  const original = `${systemLine}\nnot json\n${userLine}\n{"id":"bad","role":"unknown","content":"bad","createdAt":"2026-01-01T00:00:02Z"}\n`;
  await writeFile(path, original, "utf8");

  assert.deepEqual(await readConversation(workspaceRoot, "chat-malformed"), [
    { id: "system", role: "system", content: "Workspace chat", createdAt: "2026-01-01T00:00:00Z" },
    message("1", "valid user message"),
  ]);

  const summaries = await listConversations(workspaceRoot);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.id, "chat-malformed");
  assert.equal(summaries[0]?.title, "valid user message");
  assert.equal(await readFile(path, "utf8"), original);
});

test("chat store keeps new appends readable after an unterminated malformed line", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-unterminated-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const dir = conversationsDir(workspaceRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "chat-unterminated.jsonl"), "truncated", "utf8");

  await appendMessage(workspaceRoot, "chat-unterminated", message("2", "after corruption"));

  assert.deepEqual(await readConversation(workspaceRoot, "chat-unterminated"), [
    message("2", "after corruption"),
  ]);
});

test("chat store preserves assistant landing metadata", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-landing-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const assistantMessage: ChatMessage = {
    id: "assistant-1",
    role: "assistant",
    content: "Completed the requested review.",
    createdAt: "2026-01-01T00:00:01Z",
    landing: {
      summary: "The agent completed the requested review.",
      nextActions: ["Review the draft output", "Confirm the open question"],
      followUpPrompt: "Show me the open question.",
      conversationTitle: "Draft Review Follow-up",
      generatedAt: "2026-01-01T00:00:02Z",
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
    },
  };

  await appendMessage(workspaceRoot, "chat-landing", assistantMessage);

  assert.deepEqual(await readConversation(workspaceRoot, "chat-landing"), [assistantMessage]);
});

test("chat store prefers generated landing title in conversation summaries", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-title-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  await appendMessage(workspaceRoot, "chat-title", message("1", "Can you inspect the notes in this workspace and summarize the open questions?"));
  await appendMessage(workspaceRoot, "chat-title", {
    id: "assistant-1",
    role: "assistant",
    content: "Completed the requested review.",
    createdAt: "2026-01-01T00:00:02Z",
    landing: {
      summary: "The agent completed the requested review.",
      nextActions: [],
      followUpPrompt: null,
      conversationTitle: "Workspace Notes Review",
      generatedAt: "2026-01-01T00:00:03Z",
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
    },
  });

  const summaries = await listConversations(workspaceRoot);
  assert.equal(summaries[0]?.title, "Workspace Notes Review");
});

test("chat store manual conversation title overrides generated landing title", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-manual-title-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  await appendMessage(workspaceRoot, "chat-manual-title", message("1", "Review this document draft."));
  await appendMessage(workspaceRoot, "chat-manual-title", {
    id: "assistant-1",
    role: "assistant",
    content: "Completed the requested review.",
    createdAt: "2026-01-01T00:00:02Z",
    landing: {
      summary: "The agent completed the requested review.",
      nextActions: [],
      followUpPrompt: null,
      conversationTitle: "Generated Document Review",
      generatedAt: "2026-01-01T00:00:03Z",
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
    },
  });

  const renamed = await renameConversation(workspaceRoot, "chat-manual-title", "Manual Document Rename");
  assert.equal(renamed.title, "Manual Document Rename");

  const summaries = await listConversations(workspaceRoot);
  assert.equal(summaries[0]?.title, "Manual Document Rename");
  assert.ok((await readConversation(workspaceRoot, "chat-manual-title")).some((item) => item.kind === "conversation_title" && item.content === "Manual Document Rename"));
});

test("chat store persists archive and snooze state as append-only lifecycle events", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-lifecycle-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  await appendMessage(workspaceRoot, "chat-lifecycle", message("1", "Review the launch checklist."));
  const before = (await listConversations(workspaceRoot))[0]!;
  const archived = await updateConversationLifecycle(workspaceRoot, "chat-lifecycle", { archived: true });
  assert.ok(archived.archivedAt);
  assert.equal(archived.snoozedUntil, null);
  assert.equal(archived.updatedAt, before.updatedAt, "lifecycle bookkeeping must not make a Chat look newly active");

  const restored = await updateConversationLifecycle(workspaceRoot, "chat-lifecycle", { archived: false });
  assert.equal(restored.archivedAt, null);
  const snoozedUntil = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const snoozed = await updateConversationLifecycle(workspaceRoot, "chat-lifecycle", { snoozedUntil });
  assert.equal(snoozed.snoozedUntil, snoozedUntil);
  assert.equal(snoozed.updatedAt, before.updatedAt);

  const resumed = await updateConversationLifecycle(workspaceRoot, "chat-lifecycle", { snoozedUntil: null });
  assert.equal(resumed.snoozedUntil, null);
  const lifecycleEvents = (await readConversation(workspaceRoot, "chat-lifecycle"))
    .filter((item) => item.kind === "conversation_lifecycle");
  assert.deepEqual(lifecycleEvents.map((item) => item.lifecycle), [
    { archived: true, snoozedUntil: null },
    { archived: false },
    { snoozedUntil },
    { snoozedUntil: null },
  ]);
});

test("chat store rejects past snoozes and snoozing archived Chats", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-lifecycle-invalid-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  await appendMessage(workspaceRoot, "chat-lifecycle-invalid", message("1", "Keep this for later."));
  await assert.rejects(
    () => updateConversationLifecycle(workspaceRoot, "chat-lifecycle-invalid", { snoozedUntil: "2020-01-01T00:00:00.000Z" }),
    /future snooze time/,
  );
  await updateConversationLifecycle(workspaceRoot, "chat-lifecycle-invalid", { archived: true });
  await assert.rejects(
    () => updateConversationLifecycle(workspaceRoot, "chat-lifecycle-invalid", { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() }),
    /Unarchive this Chat/,
  );
});

test("chat store keeps messages when landing metadata is malformed", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-bad-landing-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const dir = conversationsDir(workspaceRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "chat-bad-landing.jsonl"), `${JSON.stringify({
    id: "assistant-1",
    role: "assistant",
    content: "Completed the requested review.",
    createdAt: "2026-01-01T00:00:01Z",
    landing: {
      summary: "The agent completed the requested review.",
      nextActions: "not an array",
      followUpPrompt: null,
      generatedAt: "2026-01-01T00:00:02Z",
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
    },
  })}\n`, "utf8");

  assert.deepEqual(await readConversation(workspaceRoot, "chat-bad-landing"), [
    {
      id: "assistant-1",
      role: "assistant",
      content: "Completed the requested review.",
      createdAt: "2026-01-01T00:00:01Z",
    },
  ]);
});

test("chat listing reuses cached summaries and rebuilds them when a transcript changes", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-index-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await appendMessage(workspaceRoot, "chat-indexed", message("1", "alpha"));

  assert.equal((await listConversations(workspaceRoot))[0]?.title, "alpha");

  // Same size, same mtime, different bytes. Only a listing that skipped the
  // transcript can still report the original title, so this pins the cache
  // itself rather than an incidental re-read producing the same answer.
  const transcript = join(conversationsDir(workspaceRoot), "chat-indexed.jsonl");
  const before = await stat(transcript);
  await writeFile(transcript, (await readFile(transcript, "utf8")).replace("alpha", "bravo"), "utf8");
  await utimes(transcript, before.atime, before.mtime);
  assert.equal((await stat(transcript)).size, before.size, "rewrite must preserve size for this assertion to mean anything");
  assert.equal((await listConversations(workspaceRoot))[0]?.title, "alpha", "an unchanged size and mtime reuses the cached summary");

  // Appending moves both size and mtime, so the summary must be rebuilt.
  await appendMessage(workspaceRoot, "chat-indexed", message("2", "charlie"));
  assert.equal((await listConversations(workspaceRoot))[0]?.title, "bravo", "a changed transcript is parsed again");
});

test("chat listing ignores cache records that do not describe their own transcript", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-index-invalid-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await appendMessage(workspaceRoot, "chat-guarded", message("1", "genuine"));
  await listConversations(workspaceRoot);

  const indexFile = join(workspaceStateDir(workspaceRoot), "conversation-index.json");
  const transcript = await stat(join(conversationsDir(workspaceRoot), "chat-guarded.jsonl"));
  await writeFile(indexFile, `${JSON.stringify({
    version: 1,
    entries: {
      "chat-guarded": {
        sizeBytes: transcript.size,
        modifiedAt: transcript.mtime.toISOString(),
        // Claims to summarize a different conversation than its own key.
        summary: { id: "chat-other", title: "injected", createdAt: "x", updatedAt: "x", archivedAt: null, snoozedUntil: null },
      },
    },
  })}\n`, "utf8");

  assert.equal((await listConversations(workspaceRoot))[0]?.title, "genuine", "a self-inconsistent cache record is discarded");
});
