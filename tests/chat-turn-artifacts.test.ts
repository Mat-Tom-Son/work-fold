import assert from "node:assert/strict";
import test from "node:test";

import { latestAssistantMessageId, settledTurnHasNewAssistantMessage } from "../web-local/src/lib/chat-turn-artifacts.js";
import type { ChatMessage } from "../web-local/src/types.js";

const user = (id: string): ChatMessage => ({ id, role: "user", content: id, createdAt: "2026-08-01T00:00:00.000Z" });
const assistant = (id: string): ChatMessage => ({ id, role: "assistant", content: id, createdAt: "2026-08-01T00:00:01.000Z" });

test("latest Assistant message ignores a trailing user turn", () => {
  assert.equal(latestAssistantMessageId([user("user-1"), assistant("assistant-1"), user("user-2")]), "assistant-1");
  assert.equal(latestAssistantMessageId([user("user-only")]), null);
});

test("a stopped turn without a persisted reply cannot donate live artifacts to the previous reply", () => {
  const transcript = [user("user-1"), assistant("assistant-1"), user("stopped-user")];
  assert.equal(settledTurnHasNewAssistantMessage("assistant-1", transcript), false);
});

test("a completed or interrupted persisted reply owns its turn artifacts", () => {
  const transcript = [user("user-1"), assistant("assistant-1"), user("user-2"), assistant("assistant-2")];
  assert.equal(settledTurnHasNewAssistantMessage("assistant-1", transcript), true);
  assert.equal(settledTurnHasNewAssistantMessage(null, [user("user-1"), assistant("assistant-1")]), true);
});

test("untracked reconciliation preserves the existing recovery behavior", () => {
  assert.equal(settledTurnHasNewAssistantMessage(undefined, [user("user-1")]), true);
});
