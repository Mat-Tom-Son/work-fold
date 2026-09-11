import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { spaceOperationsGuideForScope, workFoldSpaceOperationsGuideHeading } from "../src/local/agent/space-operations-guide.js";

/**
 * The operations guide reaches a Space Chat's real Pi session as a system
 * prompt appendix, after the person's Space instructions, the way those are
 * appended (docs/collaboration-contract.md, F26). No model is contacted:
 * building the session composes the prompt without a turn.
 */
test("a Space Chat's system prompt carries Space instructions and then the operations guide", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-guide-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const spaceRoot = join(root, "space");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(spaceRoot, { recursive: true });
  const provider = {
    async resolveRuntime() {
      return { agentDir, assistantInstructions: "Prefer short answers." };
    },
  };

  const guided = new PiConversationClient("guide", spaceRoot, provider, undefined, {
    operationsGuide: spaceOperationsGuideForScope("space-1")!,
  });
  t.after(() => guided.stop());
  await guided.getCatalog();
  const appended = sessionAppendix(guided);
  assert.equal(appended.length, 2, "Space instructions and the guide, nothing else");
  assert.match(appended[0]!, /^## Space instructions\n\nPrefer short answers\.$/);
  assert.ok(appended[1]!.startsWith(workFoldSpaceOperationsGuideHeading));

  const unguided = new PiConversationClient("plain", spaceRoot, provider);
  t.after(() => unguided.stop());
  await unguided.getCatalog();
  const plain = sessionAppendix(unguided);
  assert.equal(plain.length, 1, "a client built without the guide (the management scope) has only the instructions entry");
  assert.match(plain[0]!, /^## Space instructions/);

  // The guide is a session appendix; nothing new is written into the Space folder.
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(spaceRoot), []);
});

function sessionAppendix(client: PiConversationClient): string[] {
  const session = (client as unknown as { session: { resourceLoader: { getAppendSystemPrompt(): string[] } } }).session;
  return session.resourceLoader.getAppendSystemPrompt();
}
