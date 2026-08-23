import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import {
  PiConversationClient,
  joinAssistantSegments,
  type PiChatEvent,
} from "../src/local/agent/pi-client.js";
import type { PiRuntimeProvider } from "../src/local/agent/pi-runtime-config.js";

test("assistant text segments join as paragraphs and tool-call-only segments vanish", () => {
  assert.equal(joinAssistantSegments(["Let me look.", "", "  ", "Fixed.\n"]), "Let me look.\n\nFixed.");
  assert.equal(joinAssistantSegments([]), "");
  assert.equal(joinAssistantSegments(["", "only"]), "only");
});

test("a turn's commentary before and after tool calls is kept in the saved reply, matching what streamed", async (t) => {
  let requestCount = 0;
  const providerServer = createServer((request, response) => {
    requestCount += 1;
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "close",
      });
      const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
        id: `completion-${requestCount}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "segment-model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      const sawToolResult = /"role":"tool"/.test(body);
      if (!sawToolResult) {
        send(chunk({ role: "assistant", content: "Let me check the file first." }, null));
        send(chunk({
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: "echo inspected" }) },
          }],
        }, null));
        send(chunk({}, "tool_calls"));
      } else {
        send(chunk({ role: "assistant", content: "It says inspected — " }, null));
        send(chunk({ content: "all good." }, null));
        send(chunk({}, "stop"));
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    providerServer.once("error", reject);
    providerServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    providerServer.close((error) => error ? reject(error) : resolve());
  }));
  const port = (providerServer.address() as AddressInfo).port;

  const root = await mkdtemp(join(tmpdir(), "workspace-transcript-segments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const spaceRoot = join(root, "workspace");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(spaceRoot, { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "segment-provider.ts"),
    `export default function (pi) {
      pi.registerProvider("segment-provider", {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:${port}/v1",
        apiKey: "test-key",
        models: [{
          id: "segment-model",
          name: "Segment Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 1024,
        }],
      });
    }\n`,
    "utf8",
  );
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "segment-provider",
    defaultModel: "segment-model",
    defaultThinkingLevel: "off",
  });
  const provider: PiRuntimeProvider = {
    async resolveRuntime() {
      return { agentDir, settingsManager };
    },
  };
  const client = new PiConversationClient("transcript-segments-test", spaceRoot, provider);
  t.after(() => client.stop());
  const events: PiChatEvent[] = [];
  client.on("event", (event: PiChatEvent) => events.push(event));

  const reply = await client.prompt("Inspect the file and report.");
  assert.equal(requestCount, 2, "the tool call round-trips through Pi's agent loop");
  assert.equal(reply, "Let me check the file first.\n\nIt says inspected — all good.");

  const streamed = events.filter((event) => event.type === "assistant_delta").map((event) => event.text ?? "").join("");
  assert.equal(streamed, reply, "the live stream carries the same paragraph break the saved reply has");
  const finalMessage = [...events].reverse().find((event) => event.type === "assistant_message");
  assert.equal(finalMessage?.text, reply);
  assert.ok(events.some((event) => event.type === "tool" && event.toolName === "bash"), "the tool activity is reported alongside the text");
});
