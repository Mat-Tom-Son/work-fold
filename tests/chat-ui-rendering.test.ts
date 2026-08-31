import assert from "node:assert/strict";
import test from "node:test";

import {
  chatDisplayTitle,
  chatDraftStorageKey,
  clearStoredPendingChatSend,
  modelConversationTitle,
  readStoredPendingChatSend,
  writeStoredPendingChatSend,
} from "../web-local/src/lib/format.js";
import { collectSpacePathCandidates, spacePathCandidate } from "../web-local/src/lib/space-path-links.js";

test("blank Chat tabs keep independent drafts while saved conversations keep stable keys", () => {
  const firstDraft = chatDraftStorageKey("space-1", null, "chat:space-1:draft:first");
  const secondDraft = chatDraftStorageKey("space-1", null, "chat:space-1:draft:second");

  assert.notEqual(firstDraft, secondDraft);
  assert.equal(
    chatDraftStorageKey("space-1", "conversation-1", "chat:space-1:draft:first"),
    chatDraftStorageKey("space-1", "conversation-1", "chat:space-1:draft:second"),
  );
  assert.equal(chatDraftStorageKey("space-1", null), "work-fold.space.chat-draft:space-1:new-chat");
});

test("pending Chat sends preserve one stable acceptance identity across renderer recovery", () => {
  const values = new Map<string, string>();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    },
  });
  try {
    const pending = {
      version: 1 as const,
      requestId: "request-recovery-1",
      userMessageId: "message-recovery-1",
      content: "Continue exactly once.",
      createdAt: "2026-08-13T12:00:00.000Z",
      selectedPath: "notes.md",
      contextPaths: ["notes.md"],
      transientConversation: false,
      draftStorageKey: "draft-key",
    };
    assert.equal(writeStoredPendingChatSend("space-1", "chat-1", pending), true);
    assert.deepEqual(readStoredPendingChatSend("space-1", "chat-1"), pending);
    clearStoredPendingChatSend("space-1", "chat-1");
    assert.equal(readStoredPendingChatSend("space-1", "chat-1"), null);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Chat title rendering ignores only the initial placeholder and accepts generated or manual titles", () => {
  const createdAt = "2026-01-01T00:00:00Z";
  const placeholder = {
    id: "title-placeholder",
    role: "system" as const,
    kind: "conversation_title" as const,
    titleSource: "placeholder" as const,
    content: "New Chat",
    createdAt,
  };
  assert.equal(modelConversationTitle([placeholder]), null);
  assert.equal(chatDisplayTitle({ serverTitle: "New Chat" }), "New Chat");
  assert.equal(modelConversationTitle([
    placeholder,
    {
      ...placeholder,
      id: "title-generated",
      titleSource: "generated",
      content: "Launch checklist review",
      createdAt: "2026-01-01T00:00:01Z",
    },
  ]), "Launch checklist review");
  assert.equal(modelConversationTitle([
    placeholder,
    { id: "request", role: "user", content: "Review the launch checklist and identify missing owners.", createdAt },
    {
      ...placeholder,
      id: "legacy-fallback",
      titleSource: "generated",
      content: "Review the launch checklist and identify missing owners.",
      createdAt: "2026-01-01T00:00:01Z",
    },
  ]), null, "the old first-message fallback is not presented as a model title");
  assert.equal(modelConversationTitle([
    placeholder,
    { id: "request", role: "user", content: "Fix chat naming", createdAt },
    {
      ...placeholder,
      id: "title-attempted",
      titleSource: "attempted",
      content: "New Chat",
      createdAt: "2026-01-01T00:00:01Z",
    },
    {
      ...placeholder,
      id: "title-generated",
      titleSource: "generated",
      content: "Fix chat naming",
      createdAt: "2026-01-01T00:00:02Z",
    },
  ]), "Fix chat naming", "a recorded model response may legitimately match a short first message");
  assert.equal(modelConversationTitle([
    placeholder,
    {
      ...placeholder,
      id: "title-manual",
      titleSource: "manual",
      content: "New Chat",
      createdAt: "2026-01-01T00:00:02Z",
    },
  ]), "New Chat");
});

test("assistant Markdown discovers relative Space links and common code paths", () => {
  const candidates = collectSpacePathCandidates([
    "Open [App](web-local/src/App.tsx) and [product notes](<docs/Product notes.md>).",
    "Then inspect `src/local/server.ts:42:7`, README.md#L12, and scripts/release.ps1.",
    "Leave [the web](https://example.com/docs/file.ts) external.",
  ].join("\n"));

  assert.deepEqual(candidates, [
    "src/local/server.ts",
    "web-local/src/App.tsx",
    "docs/Product notes.md",
    "README.md",
    "scripts/release.ps1",
  ]);
  assert.equal(spacePathCandidate("./web-local/src/App.tsx:120", { allowSpaces: true }), "web-local/src/App.tsx");
  assert.equal(spacePathCandidate("README.md#installation", { allowSpaces: true }), "README.md");
  assert.equal(spacePathCandidate("https://example.com/file.ts", { allowSpaces: true }), null);
  assert.equal(spacePathCandidate("../outside.ts", { allowSpaces: true }), null);
});
