import assert from "node:assert/strict";
import test from "node:test";

import { QueuedMessageSync } from "../web-local/src/lib/queued-message-sync.js";

// A window's queued message against the app's numbered copy (2026-10-27).
// The sequences below are the two the PR #94 review reproduced in a renderer.

test("an echo of an older write never erases text added after it", () => {
  const sync = new QueuedMessageSync();
  sync.writeStarted();
  assert.equal(sync.append("First"), "First");
  // Second is added while First's write is still in flight.
  sync.writeStarted();
  assert.equal(sync.append("Second"), "First\nSecond");
  // First's write lands and its echo arrives.
  sync.writeSettled(1);
  assert.equal(sync.applyEvent({ revision: 1, queued: { content: "First" } }), false);
  // Third is added before Second's write lands.
  sync.writeStarted();
  assert.equal(sync.append("Third"), "First\nSecond\nThird", "the write carries every line");
  sync.writeSettled(2);
  sync.applyEvent({ revision: 2, queued: { content: "First\nSecond" } });
  assert.equal(sync.content, "First\nSecond\nThird");
  sync.writeSettled(3);
  assert.equal(sync.applyEvent({ revision: 3, queued: { content: "First\nSecond\nThird" } }), false, "its own echo changes nothing");
  assert.equal(sync.content, "First\nSecond\nThird");
  assert.equal(sync.onServer, true);
});

test("late write and Cancel echoes arriving together never restore a cancelled message", () => {
  const sync = new QueuedMessageSync();
  sync.writeStarted();
  sync.append("Never mind");
  // Cancel while the write is in flight: it is ordered after the write.
  const cancelled = sync.cancel();
  assert.deepEqual(cancelled, { content: "Never mind", needsDelete: true });
  sync.writeSettled(4);
  assert.equal(sync.onServer, false, "a write acknowledged after Cancel does not mark it held by the app");
  sync.cancelSettled(5);
  // Both echoes arrive in one batch after Cancel finished.
  assert.equal(sync.applyEvent({ revision: 4, queued: { content: "Never mind" } }), false);
  assert.equal(sync.applyEvent({ revision: 5, queued: null }), false);
  assert.equal(sync.content, null);
  assert.equal(sync.onServer, false);
});

test("newer changes from the app still reach a quiet window", () => {
  const sync = new QueuedMessageSync();
  assert.equal(sync.applyEvent({ revision: 7, queued: { content: "From another window" } }), true);
  assert.equal(sync.content, "From another window");
  assert.equal(sync.applyEvent({ revision: 8, queued: { content: "From another window", held: true } }), true);
  assert.equal(sync.held, true, "a Stop elsewhere shows as held");
  assert.equal(sync.applyEvent({ revision: 9, queued: null }), true);
  assert.equal(sync.content, null);
  // Only a copy the app held is cleared by the app; a window's own unsent draft stays.
  sync.append("Waiting for my turn to be accepted");
  assert.equal(sync.applyEvent({ revision: 10, queued: null }), false);
  assert.equal(sync.content, "Waiting for my turn to be accepted");
});
