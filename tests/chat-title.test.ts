import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  conversationTitleFromFirstUserMessage,
  normalizeGeneratedConversationTitle,
} from "../src/shared/chat-title.js";

test("model-generated chat titles are unwrapped and kept deliberately short", () => {
  assert.equal(normalizeGeneratedConversationTitle('Title: "Audit the Web Bridge Release"'), "Audit the Web Bridge Release");
  assert.equal(normalizeGeneratedConversationTitle("## Repair automatic conversation naming\nExtra explanation"), "Repair automatic conversation naming");
  assert.equal(normalizeGeneratedConversationTitle("one two three four five six seven eight nine"), "one two three four five six seven");
  assert.equal(normalizeGeneratedConversationTitle("   "), null);
});

test("the first-message fallback remains available when the title model cannot answer", () => {
  assert.equal(conversationTitleFromFirstUserMessage("Fix chat naming"), "Fix chat naming");
});

test("successful first turns name chats with the conversation's active Pi model", async () => {
  const client = await readFile(resolve("src/local/agent/pi-client.ts"), "utf8");
  const server = await readFile(resolve("src/local/server.ts"), "utf8");
  assert.match(client, /const model = session\.model;/);
  assert.match(client, /completeSimple\(model,/);
  assert.match(client, /modelRegistry\.getApiKeyAndHeaders\(model\)/);
  assert.match(server, /await client\.generateConversationTitle\(firstUserMessage, finalText\)/);
  assert.match(server, /modelTitle \?\? conversationTitleFromFirstUserMessage/);
  assert.match(server, /message\.titleSource !== "placeholder"/);
});
