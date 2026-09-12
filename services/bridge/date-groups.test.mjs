import assert from "node:assert/strict";
import test from "node:test";
import { groupConversationsByDate } from "./public/date-groups.js";

const chat = (id, updatedAt) => ({ id, updatedAt });
const labels = (items, now) => groupConversationsByDate(items, now).map((group) => [group.label, group.conversations.map((item) => item.id)]);

test("chat date groups use local Monday-start calendar boundaries", () => {
  const now = new Date(2026, 8, 16, 12); // Wednesday
  assert.deepEqual(labels([
    chat("today", new Date(2026, 8, 16, 0, 1)),
    chat("yesterday", new Date(2026, 8, 15, 23, 59)),
    chat("monday", new Date(2026, 8, 14, 8)),
    chat("last-sunday", new Date(2026, 8, 13, 12)),
    chat("older", new Date(2026, 7, 29, 12)),
  ], now), [
    ["Today", ["today"]],
    ["Yesterday", ["yesterday"]],
    ["Earlier this week", ["monday"]],
    ["Last week", ["last-sunday"]],
    ["Older", ["older"]],
  ]);
});

test("Sunday and Monday keep yesterday separate from the current week", () => {
  assert.deepEqual(labels([
    chat("sunday", new Date(2026, 8, 13, 10)),
    chat("saturday", new Date(2026, 8, 12, 10)),
  ], new Date(2026, 8, 13, 12)), [["Today", ["sunday"]], ["Yesterday", ["saturday"]]]);
  assert.deepEqual(labels([
    chat("monday", new Date(2026, 8, 14, 10)),
    chat("sunday", new Date(2026, 8, 13, 10)),
    chat("last-monday", new Date(2026, 8, 7, 10)),
  ], new Date(2026, 8, 14, 12)), [["Today", ["monday"]], ["Yesterday", ["sunday"]], ["Last week", ["last-monday"]]]);
});

test("calendar arithmetic survives a year boundary and daylight-saving change", () => {
  assert.deepEqual(labels([
    chat("new-year", new Date(2026, 0, 1, 1)),
    chat("new-years-eve", new Date(2025, 11, 31, 23)),
    chat("monday", new Date(2025, 11, 29, 8)),
  ], new Date(2026, 0, 1, 12)), [["Today", ["new-year"]], ["Yesterday", ["new-years-eve"]], ["Earlier this week", ["monday"]]]);
  assert.deepEqual(labels([
    chat("monday", new Date(2026, 2, 9, 0, 1)),
    chat("sunday", new Date(2026, 2, 8, 23, 59)),
  ], new Date(2026, 2, 9, 12)), [["Today", ["monday"]], ["Yesterday", ["sunday"]]]);
});
