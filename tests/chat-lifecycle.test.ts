import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateChatActivityStatus,
  chatActivityKey,
  chatSnoozeTimeLabel,
  conversationLifecycleView,
  isRecentlyResurfaced,
  resolveChatSnoozePresets,
} from "../web-local/src/lib/chat-lifecycle.js";
import { normalizeChatAttentionKeys } from "../web-local/src/hooks/useChatActivity.js";

test("conversation lifecycle prioritizes archive and automatically resurfaces due snoozes", () => {
  const now = Date.parse("2026-07-25T16:00:00.000Z");
  const base = { id: "chat-1", title: "Launch notes", updatedAt: "2026-07-25T12:00:00.000Z" };

  assert.equal(conversationLifecycleView(base, now), "active");
  assert.equal(conversationLifecycleView({ ...base, snoozedUntil: "2026-07-25T17:00:00.000Z" }, now), "snoozed");
  assert.equal(conversationLifecycleView({ ...base, snoozedUntil: "2026-07-25T15:00:00.000Z" }, now), "active");
  assert.equal(conversationLifecycleView({
    ...base,
    archivedAt: "2026-07-25T14:00:00.000Z",
    snoozedUntil: "2026-07-25T17:00:00.000Z",
  }, now), "archived");
});

test("recently resurfaced marker lasts one day and ignores archived Chats", () => {
  const now = Date.parse("2026-07-25T16:00:00.000Z");
  const base = { id: "chat-1", title: "Launch notes", updatedAt: "2026-07-25T12:00:00.000Z" };

  assert.equal(isRecentlyResurfaced({ ...base, snoozedUntil: "2026-07-25T15:00:00.000Z" }, now), true);
  assert.equal(isRecentlyResurfaced({ ...base, snoozedUntil: "2026-07-24T15:59:59.000Z" }, now), false);
  assert.equal(isRecentlyResurfaced({
    ...base,
    archivedAt: "2026-07-25T15:30:00.000Z",
    snoozedUntil: "2026-07-25T15:00:00.000Z",
  }, now), false);
});

test("snooze presets use local calendar boundaries and omit a nearly elapsed evening", () => {
  const morning = new Date(2026, 6, 24, 10, 30);
  const morningPresets = resolveChatSnoozePresets(morning);
  assert.deepEqual(morningPresets.map((item) => item.id), ["hour", "evening", "tomorrow", "next-week"]);
  const tomorrow = new Date(morningPresets.find((item) => item.id === "tomorrow")!.snoozedUntil);
  assert.equal(tomorrow.getDate(), 25);
  assert.equal(tomorrow.getHours(), 9);

  const late = resolveChatSnoozePresets(new Date(2026, 6, 24, 17, 30));
  assert.deepEqual(late.map((item) => item.id), ["hour", "tomorrow", "next-week"]);
});

test("snooze labels compare local days safely across daylight-saving boundaries", () => {
  const beforeSpringChange = new Date(2026, 2, 7, 23, 30);
  const nextMorning = new Date(2026, 2, 8, 9, 0).toISOString();
  assert.match(chatSnoozeTimeLabel(nextMorning, beforeSpringChange), /^Tomorrow,/);
});

test("chat activity keys remain scoped to a Space and conversation", () => {
  assert.equal(chatActivityKey("space-a", "chat-1"), "space-a:chat-1");
  assert.notEqual(chatActivityKey("space-a", "chat-1"), chatActivityKey("space-b", "chat-1"));
});

test("Space activity remains visible when the active Chat is filtered from the current list", () => {
  const chats = [
    { id: "chat-running", title: "Hidden by search", updatedAt: "2026-07-25T12:00:00.000Z" },
    { id: "chat-visible", title: "Visible", updatedAt: "2026-07-25T13:00:00.000Z" },
  ];
  assert.equal(aggregateChatActivityStatus("space-a", chats, { "space-a:chat-running": "running" }), "running");
  assert.equal(aggregateChatActivityStatus("space-a", chats, { "space-a:chat-running": "attention" }), "attention");
  assert.equal(aggregateChatActivityStatus("space-a", chats, {}), null);
});

test("persisted attention state keeps only bounded scoped keys", () => {
  assert.deepEqual(
    [...normalizeChatAttentionKeys(["space-a:chat-1", "space-a:chat-1", "", 3, "unscoped"])],
    ["space-a:chat-1"],
  );
  assert.deepEqual([...normalizeChatAttentionKeys({ key: "space-a:chat-1" })], []);
});
