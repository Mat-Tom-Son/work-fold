import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  appendMessage,
  conversationNeedsGeneratedTitle,
  conversationsDir,
  createConversation,
  findRemoteConversationTitleRename,
  listConversations,
  markConversationTitleAttempted,
  readConversation,
  renameConversation,
  setGeneratedConversationTitle,
  updateConversationLifecycle,
  type ChatMessage,
} from "../src/local/agent/chat-store.js";
import { configureWorkFoldStateRoot, spaceStateDir } from "../src/local/state-paths.js";

const chatStateRoot = await mkdtemp(join(tmpdir(), "workspace-chat-state-"));
configureWorkFoldStateRoot(chatStateRoot);
after(async () => {
  configureWorkFoldStateRoot(undefined);
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
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-append-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  await Promise.all(
    Array.from({ length: 20 }, (_, index) => appendMessage(spaceRoot, "chat-concurrent", message(String(index), `message ${index}`))),
  );

  const messages = await readConversation(spaceRoot, "chat-concurrent");
  assert.equal(messages.length, 20);
  assert.deepEqual(new Set(messages.map((item) => item.id)), new Set(Array.from({ length: 20 }, (_, index) => String(index))));
});

test("chat store rejects unsafe conversation ids", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-safe-id-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => appendMessage(spaceRoot, "../outside", message("1", "escape attempt")),
    /Invalid conversation id/,
  );
  await assert.rejects(
    () => readConversation(spaceRoot, "nested/chat"),
    /Invalid conversation id/,
  );
});

test("chat store ignores legacy external conversations and leaves them unchanged", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-migration-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));
  const legacyDir = join(spaceRoot, ".workspace", "conversations");
  await mkdir(legacyDir, { recursive: true });
  const legacyPath = join(legacyDir, "chat-legacy.jsonl");
  await writeFile(legacyPath, `${JSON.stringify(message("1", "legacy conversation"))}\n`, "utf8");

  assert.deepEqual(await listConversations(spaceRoot), []);
  await appendMessage(spaceRoot, "chat-legacy", message("2", "new work-fold conversation"));
  const portablePath = join(conversationsDir(spaceRoot), "chat-legacy.jsonl");
  assert.notEqual(await readFile(portablePath, "utf8"), await readFile(legacyPath, "utf8"));
  assert.equal(await readFile(legacyPath, "utf8"), `${JSON.stringify(message("1", "legacy conversation"))}\n`);
  assert.deepEqual(await readConversation(spaceRoot, "chat-legacy"), [message("2", "new work-fold conversation")]);
});

test("chat store skips malformed JSONL lines without deleting the transcript", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-malformed-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  const dir = conversationsDir(spaceRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "chat-malformed.jsonl");
  const systemLine = JSON.stringify({ id: "system", role: "system", content: "Workspace chat", createdAt: "2026-01-01T00:00:00Z" });
  const userLine = JSON.stringify(message("1", "valid user message"));
  const original = `${systemLine}\nnot json\n${userLine}\n{"id":"bad","role":"unknown","content":"bad","createdAt":"2026-01-01T00:00:02Z"}\n`;
  await writeFile(path, original, "utf8");

  assert.deepEqual(await readConversation(spaceRoot, "chat-malformed"), [
    { id: "system", role: "system", content: "Workspace chat", createdAt: "2026-01-01T00:00:00Z" },
    message("1", "valid user message"),
  ]);

  const summaries = await listConversations(spaceRoot);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.id, "chat-malformed");
  assert.equal(summaries[0]?.title, "New Chat");
  assert.equal(await readFile(path, "utf8"), original);
});

test("chat store keeps new appends readable after an unterminated malformed line", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-unterminated-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  const dir = conversationsDir(spaceRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "chat-unterminated.jsonl"), "truncated", "utf8");

  await appendMessage(spaceRoot, "chat-unterminated", message("2", "after corruption"));

  assert.deepEqual(await readConversation(spaceRoot, "chat-unterminated"), [
    message("2", "after corruption"),
  ]);
});

test("chat store preserves assistant landing metadata", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-landing-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

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

  await appendMessage(spaceRoot, "chat-landing", assistantMessage);

  assert.deepEqual(await readConversation(spaceRoot, "chat-landing"), [assistantMessage]);
});

test("chat store preserves interrupted assistant output and completed activity", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-interruption-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  const assistantMessage: ChatMessage = {
    id: "assistant-interrupted-1",
    role: "assistant",
    content: "I inspected the manuscript and found",
    createdAt: "2026-01-01T00:00:01Z",
    interruption: {
      reason: "provider_error",
      message: "Provider returned an error while streaming.",
      retryAttempts: 3,
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      activities: [{
        message: "Read complete",
        detail: "manuscript/chapter-one.md",
        toolName: "read",
        phase: "complete",
      }],
    },
  };

  await appendMessage(spaceRoot, "chat-interrupted", assistantMessage);

  assert.deepEqual(await readConversation(spaceRoot, "chat-interrupted"), [assistantMessage]);
});

test("chat store prefers generated landing title in conversation summaries", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-title-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  await appendMessage(spaceRoot, "chat-title", message("1", "Can you inspect the notes in this workspace and summarize the open questions?"));
  await appendMessage(spaceRoot, "chat-title", {
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

  const summaries = await listConversations(spaceRoot);
  assert.equal(summaries[0]?.title, "Workspace Notes Review");
});

test("new Chat placeholder does not override its generated landing title", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-created-title-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  const created = await createConversation(spaceRoot);
  await appendMessage(spaceRoot, created.id, message("1", "Plan a garden event rain fallback."));
  await appendMessage(spaceRoot, created.id, {
    id: "assistant-1",
    role: "assistant",
    content: "The rain plan is ready.",
    createdAt: "2026-01-01T00:00:02Z",
    landing: {
      summary: "The agent prepared a rain plan.",
      nextActions: [],
      followUpPrompt: null,
      conversationTitle: "Garden Event Rain Plan",
      generatedAt: "2026-01-01T00:00:03Z",
      provider: "openrouter",
      model: "z-ai/glm-5.2",
    },
  });

  const summaries = await listConversations(spaceRoot);
  assert.equal(summaries[0]?.title, "Garden Event Rain Plan");
});

test("an intentional later rename to New Chat remains authoritative", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-new-chat-rename-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  const created = await createConversation(spaceRoot);
  await appendMessage(spaceRoot, created.id, message("1", "Review this draft."));
  const renamed = await renameConversation(spaceRoot, created.id, "New Chat");

  assert.equal(renamed.title, "New Chat");
});

test("generated title persists after the first successful turn without overriding later manual renames", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-generated-title-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  const created = await createConversation(spaceRoot);
  await appendMessage(spaceRoot, created.id, message("1", "Review the launch checklist and identify missing owners."));
  const generated = await setGeneratedConversationTitle(spaceRoot, created.id, "Review the launch checklist");
  assert.equal(generated.title, "Review the launch checklist");
  assert.equal(
    (await readConversation(spaceRoot, created.id)).filter((item) => item.titleSource === "generated").length,
    1,
  );

  await setGeneratedConversationTitle(spaceRoot, created.id, "A different generated title");
  const renamed = await renameConversation(spaceRoot, created.id, "Launch owner review");
  await setGeneratedConversationTitle(spaceRoot, created.id, "A third generated title");
  assert.equal(renamed.title, "Launch owner review");
  assert.equal((await listConversations(spaceRoot))[0]?.title, "Launch owner review");
});

test("a failed first title request stays New Chat and is not repeated", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-title-attempt-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  const created = await createConversation(spaceRoot);
  await appendMessage(spaceRoot, created.id, message("1", "Please give this conversation a useful title."));
  assert.equal(conversationNeedsGeneratedTitle(await readConversation(spaceRoot, created.id)), true);

  const attempted = await markConversationTitleAttempted(spaceRoot, created.id);
  assert.equal(attempted.title, "New Chat");
  const transcript = await readConversation(spaceRoot, created.id);
  assert.equal(transcript.filter((item) => item.titleSource === "attempted").length, 1);
  assert.equal(conversationNeedsGeneratedTitle(transcript), false);

  await markConversationTitleAttempted(spaceRoot, created.id);
  assert.equal((await readConversation(spaceRoot, created.id)).filter((item) => item.titleSource === "attempted").length, 1);
});

test("a model title may legitimately match the first user message after the request is recorded", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-title-matches-request-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  const created = await createConversation(spaceRoot);
  const request = "Fix chat naming";
  await appendMessage(spaceRoot, created.id, message("1", request));
  await markConversationTitleAttempted(spaceRoot, created.id);

  const generated = await setGeneratedConversationTitle(spaceRoot, created.id, request);
  assert.equal(generated.title, request);
  assert.equal(conversationNeedsGeneratedTitle(await readConversation(spaceRoot, created.id)), false);
});

test("the old first-message fallback is eligible for one real model title", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-legacy-title-fallback-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  const created = await createConversation(spaceRoot);
  const request = "hey, what's up what do you think of my game here in this space?";
  await appendMessage(spaceRoot, created.id, message("1", request));
  await appendMessage(spaceRoot, created.id, {
    id: "old-fallback",
    role: "system",
    kind: "conversation_title",
    titleSource: "generated",
    content: "hey, what's up what do you think of my game here in this...",
    createdAt: "2026-01-01T00:00:02Z",
  });

  assert.equal((await listConversations(spaceRoot))[0]?.title, "New Chat");
  assert.equal(conversationNeedsGeneratedTitle(await readConversation(spaceRoot, created.id)), true);
  assert.equal((await setGeneratedConversationTitle(spaceRoot, created.id, "Tic Tac Flow Game Review")).title, "Tic Tac Flow Game Review");
});

test("chat store manual conversation title overrides generated landing title", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-manual-title-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  await appendMessage(spaceRoot, "chat-manual-title", message("1", "Review this document draft."));
  await appendMessage(spaceRoot, "chat-manual-title", {
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

  const renamed = await renameConversation(spaceRoot, "chat-manual-title", "Manual Document Rename");
  assert.equal(renamed.title, "Manual Document Rename");

  const summaries = await listConversations(spaceRoot);
  assert.equal(summaries[0]?.title, "Manual Document Rename");
  assert.ok((await readConversation(spaceRoot, "chat-manual-title")).some((item) => item.kind === "conversation_title" && item.content === "Manual Document Rename"));
});

test("remote Chat title retries are append-only and idempotent within one browser grant", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-remote-title-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  const created = await createConversation(spaceRoot);
  await appendMessage(spaceRoot, created.id, message("1", "Review the launch notes."));
  const provenance = {
    source: "remote_web" as const,
    remotePrincipalId: "browser-title-test",
    remoteGrantId: "grant-title-test",
    remoteRequestId: "request-title-test",
  };
  const renamed = await renameConversation(spaceRoot, created.id, "Launch notes review", provenance);
  const transcriptPath = join(conversationsDir(spaceRoot), `${created.id}.jsonl`);
  const afterRename = await readFile(transcriptPath, "utf8");

  const replay = await renameConversation(spaceRoot, created.id, "A retry must not replace the result", provenance);
  assert.equal(replay.title, "Launch notes review");
  assert.equal(await readFile(transcriptPath, "utf8"), afterRename, "an exact retry does not append another title event");
  assert.equal((await findRemoteConversationTitleRename(spaceRoot, created.id, provenance))?.title, "Launch notes review");

  const otherGrant = await renameConversation(spaceRoot, created.id, "Launch notes for approval", {
    ...provenance,
    remoteGrantId: "grant-title-test-replacement",
  });
  assert.equal(otherGrant.title, "Launch notes for approval", "a replacement grant does not inherit the old grant's request ids");
  assert.equal(
    (await readConversation(spaceRoot, created.id)).filter((item) => item.kind === "conversation_title" && item.source === "remote_web").length,
    2,
  );
});

test("chat store persists archive and snooze state as append-only lifecycle events", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-lifecycle-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  await appendMessage(spaceRoot, "chat-lifecycle", message("1", "Review the launch checklist."));
  const before = (await listConversations(spaceRoot))[0]!;
  const archived = await updateConversationLifecycle(spaceRoot, "chat-lifecycle", { archived: true });
  assert.ok(archived.archivedAt);
  assert.equal(archived.snoozedUntil, null);
  assert.equal(archived.updatedAt, before.updatedAt, "lifecycle bookkeeping must not make a Chat look newly active");

  const restored = await updateConversationLifecycle(spaceRoot, "chat-lifecycle", { archived: false });
  assert.equal(restored.archivedAt, null);
  const snoozedUntil = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const snoozed = await updateConversationLifecycle(spaceRoot, "chat-lifecycle", { snoozedUntil });
  assert.equal(snoozed.snoozedUntil, snoozedUntil);
  assert.equal(snoozed.updatedAt, before.updatedAt);

  const resumed = await updateConversationLifecycle(spaceRoot, "chat-lifecycle", { snoozedUntil: null });
  assert.equal(resumed.snoozedUntil, null);
  const lifecycleEvents = (await readConversation(spaceRoot, "chat-lifecycle"))
    .filter((item) => item.kind === "conversation_lifecycle");
  assert.deepEqual(lifecycleEvents.map((item) => item.lifecycle), [
    { archived: true, snoozedUntil: null },
    { archived: false },
    { snoozedUntil },
    { snoozedUntil: null },
  ]);
});

test("chat store rejects past snoozes and snoozing archived Chats", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-lifecycle-invalid-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  await appendMessage(spaceRoot, "chat-lifecycle-invalid", message("1", "Keep this for later."));
  await assert.rejects(
    () => updateConversationLifecycle(spaceRoot, "chat-lifecycle-invalid", { snoozedUntil: "2020-01-01T00:00:00.000Z" }),
    /future snooze time/,
  );
  await updateConversationLifecycle(spaceRoot, "chat-lifecycle-invalid", { archived: true });
  await assert.rejects(
    () => updateConversationLifecycle(spaceRoot, "chat-lifecycle-invalid", { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() }),
    /Unarchive this Chat/,
  );
});

test("chat store keeps messages when landing metadata is malformed", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-bad-landing-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));

  const dir = conversationsDir(spaceRoot);
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

  assert.deepEqual(await readConversation(spaceRoot, "chat-bad-landing"), [
    {
      id: "assistant-1",
      role: "assistant",
      content: "Completed the requested review.",
      createdAt: "2026-01-01T00:00:01Z",
    },
  ]);
});

test("chat listing reuses cached summaries and rebuilds them when a transcript changes", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-index-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));
  await appendMessage(spaceRoot, "chat-indexed", message("1", "Give this Chat a compact cache title."));
  await setGeneratedConversationTitle(spaceRoot, "chat-indexed", "alpha");

  assert.equal((await listConversations(spaceRoot))[0]?.title, "alpha");

  // Same size, same mtime, different bytes. The filesystem change identity
  // still moves, so an external rewrite must invalidate the derived cache.
  const transcript = join(conversationsDir(spaceRoot), "chat-indexed.jsonl");
  const before = await stat(transcript);
  await writeFile(transcript, (await readFile(transcript, "utf8")).replace("alpha", "bravo"), "utf8");
  await utimes(transcript, before.atime, before.mtime);
  assert.equal((await stat(transcript)).size, before.size, "rewrite must preserve size for this assertion to mean anything");
  assert.equal((await listConversations(spaceRoot))[0]?.title, "bravo", "a metadata-preserving rewrite invalidates the cached summary");

  // Appending moves both size and mtime, so the summary must be rebuilt.
  await appendMessage(spaceRoot, "chat-indexed", message("2", "charlie"));
  assert.equal((await listConversations(spaceRoot))[0]?.title, "bravo", "a later append keeps the updated title");
});

test("chat listing ignores cache records that do not describe their own transcript", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-index-invalid-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));
  await appendMessage(spaceRoot, "chat-guarded", message("1", "genuine"));
  await listConversations(spaceRoot);

  const indexFile = join(spaceStateDir(spaceRoot), "conversation-index.json");
  const transcript = await stat(join(conversationsDir(spaceRoot), "chat-guarded.jsonl"));
  await writeFile(indexFile, `${JSON.stringify({
    version: 4,
    entries: {
      "chat-guarded": {
        sizeBytes: transcript.size,
        modifiedAt: transcript.mtime.toISOString(),
        changedAt: transcript.ctime.toISOString(),
        device: String(transcript.dev),
        inode: String(transcript.ino),
        // Claims to summarize a different conversation than its own key.
        summary: { id: "chat-other", title: "injected", createdAt: "x", updatedAt: "x", archivedAt: null, snoozedUntil: null },
      },
    },
  })}\n`, "utf8");

  assert.equal((await listConversations(spaceRoot))[0]?.title, "New Chat", "a self-inconsistent cache record is discarded");
});

test("chat listing rebuilds a previous-version cache after title semantics change", async (t) => {
  const spaceRoot = await mkdtemp(join(tmpdir(), "workspace-chat-store-index-version-"));
  t.after(() => rm(spaceRoot, { recursive: true, force: true }));
  const created = await createConversation(spaceRoot);
  await appendMessage(spaceRoot, created.id, message("1", "Name this completed conversation"));
  const transcript = await stat(join(conversationsDir(spaceRoot), `${created.id}.jsonl`));

  const indexFile = join(spaceStateDir(spaceRoot), "conversation-index.json");
  await mkdir(spaceStateDir(spaceRoot), { recursive: true });
  await writeFile(indexFile, `${JSON.stringify({
    version: 2,
    entries: {
      [created.id]: {
        sizeBytes: transcript.size,
        modifiedAt: transcript.mtime.toISOString(),
        changedAt: transcript.ctime.toISOString(),
        device: String(transcript.dev),
        inode: String(transcript.ino),
        summary: {
          id: created.id,
          title: "New Chat",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:01Z",
          archivedAt: null,
          snoozedUntil: null,
        },
      },
    },
  })}\n`, "utf8");

  assert.equal((await listConversations(spaceRoot))[0]?.title, "New Chat");
  assert.equal(JSON.parse(await readFile(indexFile, "utf8")).version, 4);
});
