import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";

import type { ConversationSummary, SpaceSummary } from "../web-local/src/types.js";
import { createDomHarness } from "./support/dom.js";

const spaces: SpaceSummary[] = [
  {
    id: "space-1",
    name: "Planning",
    rootPath: "/planning",
    location: { kind: "local", storage: "linked" },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
  {
    id: "space-2",
    name: "Writing",
    rootPath: "/writing",
    location: { kind: "local", storage: "linked" },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
];

const planningChat: ConversationSummary = {
  id: "chat-1",
  title: "Budget review",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:01:00.000Z",
  archivedAt: null,
  snoozedUntil: null,
};

test("Chat search reaches transcript contents across Spaces and opens the owning Chat", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const calls: string[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("space-2")) return new Response("{}", { status: 500 });
    const matching = [{
      conversationId: "chat-1",
      title: "Budget review",
      role: "assistant",
      createdAt: "2026-07-01T00:01:00.000Z",
      preview: "The hidden quarterly figure is ready.",
    }];
    return new Response(JSON.stringify({ chats: matching, truncated: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const opened: string[] = [];
  const { ChatContentSearch } = await import("../web-local/src/components/panes/ChatContentSearch.js");
  await dom.render(createElement(ChatContentSearch, {
    spaces,
    conversations: { "space-1": [planningChat], "space-2": [] },
    query: "quarterly",
    view: "active",
    now: Date.parse("2026-07-02T00:00:00.000Z"),
    onOpen: (space: SpaceSummary, conversation: ConversationSummary) => {
      opened.push(`${space.id}:${conversation.id}`);
    },
  }));

  await dom.waitFor(() => calls.length === 2);
  assert.ok(calls.every((url) => url.includes("scope=chats") && url.includes("q=quarterly")));
  await dom.waitFor(() => (dom.container.textContent ?? "").includes("hidden quarterly figure"));
  assert.match(dom.container.textContent ?? "", /Planning/);
  assert.match(dom.container.textContent ?? "", /Budget review/);
  assert.match(dom.container.textContent ?? "", /Some Spaces couldn\u2019t be searched/, "one unavailable Space does not hide other matches");

  dom.container.querySelector<HTMLButtonElement>(".chat-content-search li button")?.click();
  assert.deepEqual(opened, ["space-1:chat-1"]);
});
