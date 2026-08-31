import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isPiTurnNotRunningError, isPiTurnTimeoutError, piTurnTimeoutMs } from "../src/local/agent/pi-client.js";
import { builtInPiCommands } from "../src/local/agent/skill-catalog.js";
import { startLocalApi } from "../src/local/server.js";
import type { WorkFoldKernel } from "../src/local/work-fold-kernel.js";

test("an Assistant turn has no wall-clock cap unless a host opts into one", () => {
  assert.equal(piTurnTimeoutMs({}), 0, "native Pi sessions have no turn cap, so neither does work-fold by default");
  assert.equal(piTurnTimeoutMs({ WORKFOLD_PI_TURN_TIMEOUT_MS: "120000" }), 120_000);
  assert.equal(piTurnTimeoutMs({ PI_TURN_TIMEOUT_MS: "5000" }), 5_000);
  assert.equal(piTurnTimeoutMs({ WORKFOLD_PI_TURN_TIMEOUT_MS: "nonsense" }), 0);
  assert.equal(piTurnTimeoutMs({ WORKFOLD_PI_TURN_TIMEOUT_MS: "-1" }), 0);
  const timeout = new Error("x");
  timeout.name = "PiTurnTimeoutError";
  assert.equal(isPiTurnTimeoutError(timeout), true);
  assert.equal(isPiTurnTimeoutError(new Error("x")), false);
  const notRunning = new Error("x");
  notRunning.name = "PiTurnNotRunningError";
  assert.equal(isPiTurnNotRunningError(notRunning), true);
});

test("the thinking level is a first-class Chat command alongside model selection", () => {
  const names = builtInPiCommands.map((command) => command.name);
  assert.ok(names.includes("model"));
  assert.ok(names.includes("thinking"));
  assert.equal(names.indexOf("thinking"), names.indexOf("model") + 1, "thinking sits next to model in the command menu");
});

test("steering requires a running agent turn and never appends a message it could not deliver", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-steer-test-"));
  const agentDir = join(sandbox, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 400)),
    });
  }\n`, "utf8");
  const piRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider,
  });
  try {
    const created = await json(`${api.origin}/api/spaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Steer Space" }),
    }) as { space: { id: string } };
    const spaceId = created.space.id;
    const conversation = await json(`${api.origin}/api/spaces/${spaceId}/conversations`, { method: "POST" }) as { conversation: { id: string } };
    const conversationId = conversation.conversation.id;
    const messages = `${api.origin}/api/spaces/${spaceId}/conversations/${conversationId}/messages`;

    const invalid = await fetch(messages, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", delivery: "followUp" }),
    });
    assert.equal(invalid.status, 400);

    const idle = await fetch(messages, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "redirect please", delivery: "steer" }),
    });
    assert.equal(idle.status, 409, "with no turn running the caller must send normally");

    const accepted = await fetch(messages, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/hold" }),
    });
    assert.equal(accepted.status, 202, await accepted.text());
    // An extension command occupies the turn without an agent run, so Pi has
    // no stream to steer: the host refuses instead of queueing a stale
    // message for a later turn.
    const duringCommand = await fetch(messages, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "redirect please", delivery: "steer" }),
    });
    assert.equal(duringCommand.status, 409, await duringCommand.text());

    await waitForTurnToSettle(api.kernel, conversationId);
    const transcript = await json(`${api.origin}/api/spaces/${spaceId}/conversations/${conversationId}`) as { messages: Array<{ role: string; content: string; delivery?: string }> };
    assert.equal(transcript.messages.some((message) => message.content === "redirect please"), false, "a refused steer leaves no trace in the transcript");
    assert.equal(transcript.messages.some((message) => message.delivery === "steer"), false);

    const runtime = await json(`${api.origin}/api/spaces/${spaceId}/conversations/${conversationId}/runtime`) as { runtime: { thinkingLevel: string; thinkingLevels: string[] } };
    assert.ok(Array.isArray(runtime.runtime.thinkingLevels), "runtime state lists the levels the current model supports");
    assert.ok(runtime.runtime.thinkingLevels.includes(runtime.runtime.thinkingLevel));

    const nextLevel = runtime.runtime.thinkingLevels.find((level) => level !== runtime.runtime.thinkingLevel);
    if (nextLevel) {
      const changed = await json(`${api.origin}/api/spaces/${spaceId}/conversations/${conversationId}/thinking`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level: nextLevel }),
      }) as { thinking: { level: string }; runtime: { thinkingLevel: string } };
      assert.equal(changed.thinking.level, nextLevel);
      assert.equal(changed.runtime.thinkingLevel, nextLevel, "the selected reasoning level updates the live Pi session");
    }

    const badLevel = await fetch(`${api.origin}/api/spaces/${spaceId}/conversations/${conversationId}/thinking`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "galaxy-brain" }),
    });
    assert.equal(badLevel.status, 400);
    assert.match((await badLevel.json() as { error: string }).error, /Thinking level must be one of/);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

// The kernel task finishes after the turn's running flag clears, so waiting on
// it (rather than on the transcript) observes a fully settled turn.
async function waitForTurnToSettle(kernel: WorkFoldKernel, conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const tasks = await kernel.getTasks({ kind: "system" });
    if (!tasks.tasks.some((task) => task.kind === "assistant_turn" && task.conversationId === conversationId)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("The held turn did not settle.");
}

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}
