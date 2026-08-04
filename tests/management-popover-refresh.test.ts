import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("the persistent menu-bar popover reconciles replies whenever it becomes visible again", async () => {
  const source = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  assert.match(source, /window\.addEventListener\("focus", refreshWhenVisible\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange", refreshWhenVisible\)/);
  assert.match(source, /refreshConversation\(\)/);
  assert.match(source, /api<\{ messages: ManagementMessage\[\] \}>\(`\/api\/management\/conversations\/\$\{encodeURIComponent\(nextConversationId\)\}`\)/);
  assert.match(source, /messages\.map\(\(message\) =>/);
  assert.match(source, /message\.role === "assistant"[\s\S]*?<ReactMarkdown remarkPlugins=\{\[remarkGfm\]\}>\{message\.content\}<\/ReactMarkdown>/);
  assert.doesNotMatch(source, /\{request\.reply\.content\}/);
});

test("the menu-bar popover starts a clean saved management chat without deleting the previous transcript", async () => {
  const source = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  assert.match(source, />\s*<SquarePen aria-hidden="true" \/>\s*<span>New chat<\/span>/);
  assert.match(source, /startingNewChatRef\.current = true/);
  assert.match(source, /body\.newConversation = true/);
  assert.match(source, /previous chat is still saved on this desktop/);
  assert.match(source, /idlePollIntervalMs = 5_000/);
});
