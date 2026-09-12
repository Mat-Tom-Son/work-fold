import assert from "node:assert/strict";
import test from "node:test";
import { groupChatsByRecency } from "../web-local/src/lib/chat-recency.js";

test("management chat history uses local calendar days across DST and year boundaries", () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    for (const [now, yesterday] of [
      ["2026-03-09T12:00:00-04:00", "2026-03-08T08:00:00-04:00"],
      ["2026-11-02T12:00:00-05:00", "2026-11-01T08:00:00-05:00"],
      ["2027-01-01T12:00:00-05:00", "2026-12-31T08:00:00-05:00"],
    ]) {
      const chats = [{ id: "today", updatedAt: now }, { id: "yesterday", updatedAt: yesterday }];
      assert.deepEqual(groupChatsByRecency(chats, new Date(now)).map(([label, grouped]) => [label, grouped.map(chat => chat.id)]),
        [["Today", ["today"]], ["Yesterday", ["yesterday"]]]);
    }
    const days = ["2026-09-12", "2026-09-11", "2026-09-07", "2026-09-06", "2026-08-30"];
    assert.deepEqual(groupChatsByRecency(days.map(day => ({ updatedAt: `${day}T12:00:00-04:00` })), new Date("2026-09-12T15:00:00-04:00")).map(([label]) => label),
      ["Today", "Yesterday", "Earlier this week", "Last week", "Older"]);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
