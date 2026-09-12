import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthStorage, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PiConversationClient, type PiChatEvent } from "../src/local/agent/pi-client.js";
import { ModelContextInspector } from "../src/local/agent/model-context-inspector.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A real Pi serializer talks only to this local deterministic provider. */
async function fixture(t: test.TestContext, options: { vision?: boolean; blockImages?: boolean; tool?: string; instructions?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-native-feedback-"));
  const agentDir = join(root, "pi");
  const spaceRoot = join(root, "space");
  const requests: any[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      const send = (delta: unknown, finishReason: string | null = null) => response.write(`data: ${JSON.stringify({
        id: `feedback-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
      const hasToolResult = body.messages.some((message: any) => message.role === "tool");
      const isTitle = JSON.stringify(body.messages).includes("Write a specific 3 to 7 word title");
      const isInference = JSON.stringify(body.messages).includes("You are answering one bounded request from a Space app");
      const isCheck = body.tools?.some((tool: any) => tool.function?.name === "submit_review");
      if (isCheck) {
        send({ role: "assistant", tool_calls: [{ index: 0, id: "review-1", type: "function", function: {
          name: "submit_review", arguments: JSON.stringify({ findings: [] }),
        } }] });
        send({}, "tool_calls");
      } else if (!hasToolResult && !isTitle && !isInference) {
        send({ role: "assistant", tool_calls: [{ index: 0, id: "observe-1", type: "function", function: {
          name: options.tool ?? "observe_fixture", arguments: JSON.stringify(options.tool === "read" ? { path: "preview.png" } : {}),
        } }] });
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: isTitle ? "A verified fixture result" : "Inspected the returned evidence." });
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(error);
      response.writeHead(500); response.end("Fixture failed");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(spaceRoot, { recursive: true });
  await writeFile(join(spaceRoot, "preview.png"), Buffer.from(png, "base64"));
  await writeFile(join(agentDir, "extensions", "observations.ts"), `
    export default function(pi) {
      pi.registerTool({ name: "observe_fixture", label: "Observe fixture", description: "Read explicit fixture evidence",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() { return {
          content: [{type:"text",text:"Observed rows 1–3: total=6; other rows uninspected."},
            {type:"image",data:${JSON.stringify(png)},mimeType:"image/png"}],
          details: { privateMetadata: "DETAILS_ARE_NOT_MODEL_CONTENT" }
        }; }
      });
      pi.on("context", (event) => ({ messages: [...event.messages,
        { role: "user", content: "NATIVE_CONTEXT_HOOK", timestamp: 1 }] }));
      pi.on("before_provider_request", (event) => ({ ...event.payload, user: "NATIVE_PAYLOAD_HOOK" }));
    }
  `);
  const authStorage = AuthStorage.inMemory({ "feedback-test": { type: "api_key", key: "local-fixture-key" } });
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider("feedback-test", {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: "local-fixture-key",
    models: [{ id: "fixture", name: "Feedback fixture", reasoning: false, input: options.vision === false ? ["text"] : ["text", "image"],
      contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const inspector = new ModelContextInspector();
  inspector.setEnabled(true);
  const client = new PiConversationClient("feedback-chat", spaceRoot, {
    async resolveRuntime() {
      return { agentDir, authStorage, modelRegistry, modelContextInspector: inspector,
        assistantInstructions: options.instructions ?? "PERSONAL_INSTRUCTIONS_SURVIVE",
        preferredModel: { provider: "feedback-test", id: "fixture" },
        settingsManager: SettingsManager.inMemory({ images: { blockImages: options.blockImages ?? false }, retry: { enabled: false }, defaultThinkingLevel: "off" }),
      };
    },
  });
  const events: PiChatEvent[] = [];
  client.on("event", (event) => events.push(event));
  t.after(async () => {
    await client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  });
  return { client, inspector, requests, events, spaceRoot };
}

test("native extension text and images reach the next provider request without work-fold result metadata", async (t) => {
  const { client, requests, events, inspector } = await fixture(t);
  assert.equal(await client.prompt("Inspect the fixture.", { managementTaskId: "task-fixture" }), "Inspected the returned evidence.");
  assert.equal(requests.length, 2);
  const next = JSON.stringify(requests[1]);
  assert.match(next, /Observed rows 1–3: total=6/);
  assert.match(next, /data:image\/png;base64,/);
  assert.doesNotMatch(next, /DETAILS_ARE_NOT_MODEL_CONTENT/);
  assert.match(next, /NATIVE_CONTEXT_HOOK/);
  assert.equal(requests[1].user, "NATIVE_PAYLOAD_HOOK");
  assert.match(next, /PERSONAL_INSTRUCTIONS_SURVIVE/);
  const visibleTrail = events.filter((event) => event.type === "tool").map(({ raw: _raw, ...event }) => event);
  assert.ok(visibleTrail.length > 0);
  assert.doesNotMatch(JSON.stringify(visibleTrail), /data:image|DETAILS_ARE_NOT_MODEL_CONTENT|Observed rows/);
  const records = inspector.list();
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.owner.taskId === "task-fixture"));
  const details = JSON.stringify(records.map((record) => inspector.get(record.id)));
  assert.match(details, /NATIVE_PAYLOAD_HOOK/);
  assert.doesNotMatch(details, /local-fixture-key/);
});

test("Pi's built-in read composes image inspection through the same native provider path", async (t) => {
  const { client, requests } = await fixture(t, { tool: "read" });
  await client.prompt("Inspect preview.png.");
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]), /Read image file/);
  assert.match(JSON.stringify(requests[1]), /data:image\/png;base64,/);
});

test("the inspector retains the full native system prompt beyond 32 KiB without changing provider input", async (t) => {
  const instructions = "Project guidance\n".repeat(4000) + "FINAL_PROJECT_INSTRUCTION";
  const { client, requests, inspector } = await fixture(t, { instructions });
  await client.prompt("Inspect the fixture with a long project guide.");
  const first = inspector.list().at(-1)!;
  const detail = inspector.get(first.id)!;
  const prompt = (detail.assembled.value as any).systemPrompt;
  assert.ok(Buffer.byteLength(prompt) > 32 * 1024);
  assert.ok(prompt.includes(instructions));
  assert.equal(requests[0].messages.find((message: any) => message.role === "system").content, prompt);
  assert.equal((detail.payloads[0]!.value as any).messages.find((message: any) => message.role === "system").content, prompt);
});

test("Pi's native image blocking remains authoritative for vision-capable models", async (t) => {
  const { client, requests } = await fixture(t, { blockImages: true });
  await client.prompt("Inspect the fixture with images disabled.");
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]), /Image reading is disabled/);
  assert.doesNotMatch(JSON.stringify(requests[1]), /data:image|image_url/);
  assert.match(JSON.stringify(requests[1]), /total=6/);
});

test("Pi's actual provider conversion omits unsupported images and preserves useful text", async (t) => {
  const { client, requests, inspector } = await fixture(t, { vision: false, tool: "read" });
  await client.prompt("Inspect preview.png with the selected text model.");
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]), /does not support images/);
  assert.doesNotMatch(JSON.stringify(requests[1]), /data:image|image_url/);
  assert.ok(inspector.list().every((record) => record.stage === "provider_payload"));
});

test("auxiliary title calls are recorded with their own context and no borrowed task", async (t) => {
  const { client, requests, inspector } = await fixture(t);
  await client.prompt("Inspect the fixture.", { managementTaskId: "original-task" });
  assert.equal(await client.generateConversationTitle("Fixture request", "Fixture answer"), "A verified fixture result");
  assert.equal(requests.length, 3);
  assert.doesNotMatch(JSON.stringify(requests[2]), /Observed rows|PERSONAL_INSTRUCTIONS_SURVIVE|NATIVE_CONTEXT_HOOK/);
  const title = inspector.list().find((record) => record.owner.purpose === "title");
  assert.ok(title);
  assert.equal(title.owner.taskId, undefined);
  assert.equal(title.stage, "provider_payload", "direct stream calls are observed even without the Agent loop's hook");
});

test("overlapping title, Check and app inference contexts retain separate purposes without Chat instructions", async (t) => {
  const { client, inspector } = await fixture(t);
  await client.prompt("Inspect the fixture.", { managementTaskId: "parent-turn" });
  inspector.clear();
  await Promise.all([
    client.generateConversationTitle("Only title input", "Only title reply"),
    client.reviewCheck({ criteria: "Only Check criteria", files: [], signal: new AbortController().signal }),
    client.infer({ instructions: "Only app instructions", input: "Only app input", maxOutputBytes: 4096, timeoutMs: 5000 }),
  ]);
  const records = inspector.list();
  assert.deepEqual(records.map((record) => record.owner.purpose).sort(), ["app_inference", "check", "title"]);
  for (const record of records) {
    assert.equal(record.owner.taskId, undefined);
    assert.equal(record.stage, "provider_payload");
    const detail = JSON.stringify(inspector.get(record.id));
    assert.doesNotMatch(detail, /PERSONAL_INSTRUCTIONS_SURVIVE|Observed rows|NATIVE_CONTEXT_HOOK/);
    if (record.owner.purpose === "title") assert.doesNotMatch(detail, /Only Check criteria|Only app input/);
    if (record.owner.purpose === "check") assert.doesNotMatch(detail, /Only title input|Only app input/);
    if (record.owner.purpose === "app_inference") assert.doesNotMatch(detail, /Only title input|Only Check criteria/);
  }
});
