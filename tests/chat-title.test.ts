import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { normalizeGeneratedConversationTitle } from "../src/shared/chat-title.js";

test("model-generated chat titles are unwrapped and kept deliberately short", () => {
  assert.equal(normalizeGeneratedConversationTitle('Title: "Audit the Web Bridge Release"'), "Audit the Web Bridge Release");
  assert.equal(normalizeGeneratedConversationTitle("## Repair automatic conversation naming\nExtra explanation"), "Repair automatic conversation naming");
  assert.equal(normalizeGeneratedConversationTitle("one two three four five six seven eight nine"), "one two three four five six seven");
  assert.equal(normalizeGeneratedConversationTitle("   "), null);
});

test("successful first turns name chats with the conversation's active Pi model", async () => {
  const client = await readFile(resolve("src/local/agent/pi-client.ts"), "utf8");
  const server = await readFile(resolve("src/local/server.ts"), "utf8");
  assert.match(client, /const model = session\.model;/);
  assert.match(client, /session\.agent\.streamFn\(model,/);
  assert.match(client, /maxTokens: Math\.min\(model\.maxTokens > 0 \? model\.maxTokens : 512, 512\)/);
  assert.doesNotMatch(client, /temperature:\s*0\.2/);
  assert.doesNotMatch(client, /completeSimple\(model,/);
  assert.match(server, /await client\.generateConversationTitle\(firstUserMessage, finalText\)/);
  assert.match(server, /await markConversationTitleAttempted\(spaceRoot, conversationId\)/);
  assert.doesNotMatch(server, /modelTitle \?\? conversationTitleFromFirstUserMessage/);
});
