import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiConversationClient } from "../src/local/agent/pi-client.js";
import {
  spaceOperationsGuideForScope,
  workFoldSpaceOperationsGuide,
  workFoldSpaceOperationsGuideHeading,
  workFoldSpaceOperationsGuideMaxBytes,
} from "../src/local/agent/space-operations-guide.js";

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

/**
 * What the guide teaches has to be what the host does. Two rules cost a Space
 * Assistant a refused command or a false boundary if the text drifts:
 * `chat answer` names the ASKING Space, not this one (src/local/server.ts
 * refuses any other), and `chat wait` returns the destination turn's own
 * closing reply — it is not a released-result filter.
 */
test("the guide teaches the two rules the host actually enforces", () => {
  const guide = workFoldSpaceOperationsGuide();

  // `--space` is this Space's id everywhere except `chat answer`.
  assert.match(guide, /the one exception is `chat answer`/);
  assert.match(guide, /chat answer --space <the Space that asked>/);
  assert.match(guide, /Name the asking Space, never your own/);
  assert.doesNotMatch(guide, /chat answer --space <id>/, "the answer verb never shows the caller's own id");

  // `chat wait` does not promise a filter the built path does not apply.
  assert.doesNotMatch(guide, /never its Chat/);
  assert.match(guide, /finished gives you that turn's closing reply/);

  assert.ok(Buffer.byteLength(guide, "utf8") <= workFoldSpaceOperationsGuideMaxBytes, "the guide stays inside its prompt budget");
});

function sessionAppendix(client: PiConversationClient): string[] {
  const session = (client as unknown as { session: { resourceLoader: { getAppendSystemPrompt(): string[] } } }).session;
  return session.resourceLoader.getAppendSystemPrompt();
}
