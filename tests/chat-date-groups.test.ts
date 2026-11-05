import assert from "node:assert/strict";
import test from "node:test";
import { chatDateGroups } from "../web-local/src/components/panes/workFolderPanes.js";
import type { ConversationSummary } from "../web-local/src/types.js";

const now = new Date(2026, 10, 4, 15, 0).getTime();
const hoursAgo = (hours: number): ConversationSummary => {
  const at = new Date(now - hours * 60 * 60 * 1_000).toISOString();
  return { id: `chat-${hours}`, title: `${hours}h`, createdAt: at, updatedAt: at, archivedAt: null, snoozedUntil: null };
};

test("Chats group by Today, Yesterday, the last week, the last month, and Earlier", () => {
  const groups = chatDateGroups([hoursAgo(1), hoursAgo(14), hoursAgo(20), hoursAgo(24 * 3), hoursAgo(24 * 12), hoursAgo(24 * 90)], now);
  assert.deepEqual(groups.map((group) => [group.label, group.chats.length]), [
    ["Today", 2],
    ["Yesterday", 1],
    ["Previous 7 Days", 1],
    ["Previous 30 Days", 1],
    ["Earlier", 1],
  ]);
});

test("a history from one day is a single group, so the list stays plain", () => {
  assert.equal(chatDateGroups([hoursAgo(1), hoursAgo(2)], now).length, 1);
});
