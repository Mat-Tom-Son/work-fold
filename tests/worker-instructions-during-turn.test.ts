import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startLocalApi } from "../src/local/server.js";

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Worker instructions save while a turn runs, and that Chat picks them up when its turn ends", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-instructions-during-turn-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  // A Pi extension command answers turns without a model call.
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "noop.ts"), `export default function (pi) {
    pi.registerCommand("noop", { description: "Answer without a model", handler: async () => {} });
  }\n`, "utf8");
  const instructions = new Map<string, string>();
  const sessionInstructions: string[] = [];
  let holdNext = false;
  let release: (() => void) | null = null;
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      // Called each time a Chat's client is built: what its session will carry.
      async resolveRuntime(root: string) {
        sessionInstructions.push(instructions.get(root) ?? "");
        return { agentDir: join(sandbox, "agent"), workerInstructions: instructions.get(root) ?? "" };
      },
      async getWorkerInstructions(root: string) { return instructions.get(root) ?? ""; },
      async setWorkerInstructions(root: string, text: string) { instructions.set(root, text); },
    },
    async beforeAgentPrompt() {
      if (!holdNext) return;
      holdNext = false;
      await new Promise<void>((resolve) => { release = resolve; });
    },
  });
  try {
    const { workFolder } = await api.actFacade.createWorkFolder({ name: "Garden" });
    // A finished turn's request settles a moment before its Chat takes the next message.
    const sendWhenFree = async (content: string, conversationId: string) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          return await api.actFacade.sendMessage({ workFolder: workFolder.id, conversationId, content });
        } catch (error) {
          if (!/Wait for the current agent turn to finish/.test(String(error)) || Date.now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    };
    // Settled means the request itself finished, not just its latest turn.
    const settled = (taskId: string) => () => ["done", "partial", "failed", "stopped"].includes(api.requests.byTaskId(taskId)?.state ?? "");

    // The Worker is mid-turn when it saves its own work-folder's instructions.
    holdNext = true;
    const first = await api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "/noop" });
    await waitFor(() => release !== null, "the turn to be running");
    const saved = await api.actFacade.workerSetInstructions({ workFolder: workFolder.id, instructions: "This folder plans the spring vegetable garden." });
    assert.equal(saved.instructions, "This folder plans the spring vegetable garden.", "saving is not refused while the turn runs");
    assert.equal(api.requests.byTaskId(first.taskId)?.turns.at(-1)?.state, "running", "the running turn is not interrupted");
    release!();
    await waitFor(settled(first.taskId), "the first turn to finish");
    assert.equal(api.requests.byTaskId(first.taskId)?.state, "done");

    // That Chat's next turn runs on a rebuilt session that carries the new instructions.
    const builds = sessionInstructions.length;
    const second = await sendWhenFree("/noop", first.conversationId);
    await waitFor(settled(second.taskId), "the second turn to finish");
    assert.ok(sessionInstructions.length > builds, "the Chat's client was rebuilt");
    assert.equal(sessionInstructions.at(-1), "This folder plans the spring vegetable garden.");

    // An idle Chat rebuilds at once.
    await api.actFacade.workerSetInstructions({ workFolder: workFolder.id, instructions: "Keep seed orders in Supplies." });
    const third = await sendWhenFree("/noop", first.conversationId);
    await waitFor(settled(third.taskId), "the third turn to finish");
    assert.equal(sessionInstructions.at(-1), "Keep seed orders in Supplies.");
  } finally {
    // A failure while the turn is held must not leave close() waiting on it.
    holdNext = false;
    (release as (() => void) | null)?.();
    await api.close();
  }
});
