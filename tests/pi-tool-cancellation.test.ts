import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { PiConversationClient, PiTurnDrainingError, type PiChatEvent } from "../src/local/agent/pi-client.js";
import { appendToolFeedbackGuide, workFoldToolFeedbackGuide } from "../src/local/agent/tool-feedback-guide.js";

test("Stop leaves native tool effects intact, suppresses late UI events and fences reuse until the tool drains", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-tool-cancellation-"));
  const agentDir = join(root, "pi");
  const spaceRoot = join(root, "content");
  const effectPath = join(spaceRoot, "effect.txt");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(spaceRoot, { recursive: true });
  await writeFile(join(spaceRoot, "AGENTS.md"), "Keep the original native project instructions.\n");
  const started = deferred<void>();
  const cancelled = deferred<void>();
  const release = deferred<void>();
  const providerRequests: any[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/hold") {
      started.resolve();
      void release.promise.then(() => response.end("released"));
      return;
    }
    if (request.url === "/cancelled") {
      cancelled.resolve(); response.end("observed"); return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      providerRequests.push(payload);
      const wantsSlowTool = !payload.messages.some((message: any) => message.role === "tool")
        && payload.messages.some((message: any) => JSON.stringify(message.content).includes("Run the slow tool"));
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      const send = (delta: object, finishReason: string | null) => response.write(`data: ${JSON.stringify({
        id: `call-${providerRequests.length}`, object: "chat.completion.chunk", created: 1, model: "cancellation-model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
      if (wantsSlowTool) {
        send({ role: "assistant", tool_calls: [{ index: 0, id: "slow-call", type: "function", function: { name: "slow_effect", arguments: "{}" } }] }, null);
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: "Ready for the next request." }, null);
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writeFile(join(agentDir, "extensions", "slow.ts"), `
    import { appendFile } from "node:fs/promises";
    export default function(pi) {
      pi.registerProvider("cancellation-provider", {
        api: "openai-completions", baseUrl: ${JSON.stringify(origin + "/v1")}, apiKey: "synthetic",
        models: [{ id: "cancellation-model", name: "Cancellation test", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
      });
      pi.registerTool({
        name: "slow_effect", label: "Slow effect", description: "A synthetic delayed effect", parameters: { type: "object", properties: {} },
        async execute(_id, _params, signal, onUpdate) {
          signal.addEventListener("abort", () => {
            onUpdate?.({ content: [{ type: "text", text: "late progress after Stop" }] });
            void fetch(${JSON.stringify(origin + "/cancelled")});
          }, { once: true });
          await fetch(${JSON.stringify(origin + "/hold")});
          await appendFile(${JSON.stringify(effectPath)}, "effect happened once\\n");
          onUpdate?.({ content: [{ type: "text", text: "late finished progress" }] });
          return { content: [{ type: "text", text: "effect happened once" }] };
        },
      });
    }
  `);
  const provider = { async resolveRuntime() { return {
    agentDir,
    assistantInstructions: "Keep the configured Assistant instructions.",
    settingsManager: SettingsManager.inMemory({ defaultProvider: "cancellation-provider", defaultModel: "cancellation-model", defaultThinkingLevel: "off" }),
  }; } };
  const client = new PiConversationClient("cancelled-chat", spaceRoot, provider);
  const other = new PiConversationClient("other-chat", spaceRoot, provider, undefined, { operationsGuide: "Keep the Space operations guide." });
  t.after(async () => {
    release.resolve();
    await Promise.all([client.stop(), other.stop()]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const events: PiChatEvent[] = [];
  client.on("event", (event: PiChatEvent) => events.push(event));
  const running = client.prompt("Run the slow tool once.", { managementTaskId: "first-task" });
  const rejected = assert.rejects(running, { name: "PiTurnCancelledError" });
  await started.promise;
  assert.ok(events.some((event) => event.type === "tool" && event.phase === "running"));
  assert.equal(await client.abort(), true, "Stop returns while the tool is still held");
  await rejected;
  await cancelled.promise;
  const stoppedEvents = events.length;
  const stoppedTrail = client.getTurnWorkTrail();
  await assert.rejects(client.prompt("Do something else.", { managementTaskId: "next-task" }), PiTurnDrainingError);
  await assert.rejects(client.compact(), PiTurnDrainingError);
  await assert.rejects(client.reloadResources(), PiTurnDrainingError);
  assert.equal(providerRequests.length, 1, "a draining Chat never queues another provider call");
  assert.equal(await other.prompt("An independent request."), "Ready for the next request.");
  for (const [index, payload] of providerRequests.entries()) {
    const system = payload.messages.find((message: any) => message.role === "system").content;
    assert.ok(system.includes("Keep the original native project instructions."));
    assert.ok(system.includes("Keep the configured Assistant instructions."));
    assert.equal(system.split(workFoldToolFeedbackGuide).length, 2, "the actual provider request carries one shared feedback appendix");
    assert.ok(system.indexOf("Keep the configured Assistant instructions.") < system.indexOf(workFoldToolFeedbackGuide));
    assert.equal(system.includes("Keep the Space operations guide."), index === 1, "only the Space scope receives its operations guide");
    if (index === 1) assert.ok(system.indexOf("Keep the Space operations guide.") < system.indexOf(workFoldToolFeedbackGuide));
  }
  assert.equal((await readFile(effectPath, "utf8").catch(() => "")), "");
  release.resolve();
  await until(async () => !(await client.getState()).isStreaming);
  assert.equal(await readFile(effectPath, "utf8"), "effect happened once\n", "Stop does not erase an actual external effect");
  assert.equal(events.length, stoppedEvents, "late native results do not repaint a stopped Chat");
  assert.deepEqual(client.getTurnWorkTrail(), stoppedTrail);
  assert.equal(await client.prompt("Continue with a fresh request.", { managementTaskId: "new-task" }), "Ready for the next request.");
  assert.equal(await readFile(effectPath, "utf8"), "effect happened once\n", "reuse does not replay the tool");
  assert.ok(providerRequests.at(-1).messages.some((message: any) => message.role === "tool" && JSON.stringify(message.content).includes("effect happened once")), "Pi retains the observed native tool outcome for future context");
});

test("the common feedback appendix preserves native and Space instruction order", () => {
  const original = ["native instructions", "personal instructions", "Space operations"];
  assert.deepEqual(appendToolFeedbackGuide(original), [...original, workFoldToolFeedbackGuide]);
  assert.deepEqual(original, ["native instructions", "personal instructions", "Space operations"]);
  assert.ok(Buffer.byteLength(workFoldToolFeedbackGuide, "utf8") < 4 * 1024);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function until(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the owned native tool to settle.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
