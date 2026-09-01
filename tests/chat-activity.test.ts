import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RuntimeContextPreview } from "../web-local/src/components/chat/activity.js";
import { savedWorkTrailPreviews } from "../web-local/src/lib/chat-work-trail.js";

test("reasoning cleanup removes orphan emphasis without damaging valid Markdown or code", () => {
  const html = renderToStaticMarkup(createElement(RuntimeContextPreview, {
    entries: [{
      id: "thinking-1",
      kind: "thinking",
      phase: "complete",
      text: [
        "And **pushToast exists. **Valid emphasis** stays valid.",
        "Inline `2 ** 3` and fenced code stay literal:",
        "~~~js",
        "const value = 2 ** 3;",
        "~~~",
      ].join("\n\n"),
    }],
  }));

  assert.match(html, /And pushToast exists\./);
  assert.match(html, /<strong>Valid emphasis<\/strong>/);
  assert.match(html, /<code>2 \*\* 3<\/code>/);
  assert.match(html, /const value = 2 \*\* 3;/);
  assert.doesNotMatch(html, /And \*\*pushToast/);
});

test("tool activity uses compact human labels while retaining its safe target", () => {
  const html = renderToStaticMarkup(createElement(RuntimeContextPreview, {
    entries: [{
      id: "tool-1",
      kind: "tool",
      toolName: "read",
      text: "Read finished",
      detail: "src/local/server.ts",
      phase: "complete",
    }],
  }));

  assert.match(html, />Read file</);
  assert.match(html, />src\/local\/server\.ts</);
  assert.doesNotMatch(html, />Done</);
});

test("saved successful-turn work trails restore thinking and tools without a spinner", () => {
  const previews = savedWorkTrailPreviews({
    id: "assistant-1",
    role: "assistant",
    content: "Done.",
    createdAt: "2026-08-31T20:00:00.000Z",
    workTrail: [
      { kind: "thinking", text: "I should inspect the file.", phase: "complete" },
      { kind: "tool", text: "Read complete", detail: "notes.md", toolName: "read", phase: "complete" },
    ],
  });

  assert.deepEqual(previews.map(({ kind, text, phase }) => ({ kind, text, phase })), [
    { kind: "thinking", text: "I should inspect the file.", phase: "complete" },
    { kind: "tool", text: "Read complete", phase: "complete" },
  ]);
  assert.equal(previews[1]?.detail, "notes.md");
});
