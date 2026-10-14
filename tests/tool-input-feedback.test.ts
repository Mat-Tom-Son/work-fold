import assert from "node:assert/strict";
import test from "node:test";
import { toolFailureGuidance, toolInputFeedbackExtension } from "../src/local/agent/tool-input-feedback.js";

test("failure feedback preserves structured data, images, native flags, usage and successful results", () => {
  const handlers = new Map<string, (event: any) => any>();
  toolInputFeedbackExtension({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
  const content = [{ type: "text", text: "Partial execution evidence" }, { type: "image", data: "selected-pixels", mimeType: "image/png" }];
  const structuredContent = { status: "partial", receipt: "effect-receipt" };
  const usage = { input: 3, output: 2 };
  const event = { toolName: "arbitrary_mcp_tool", toolCallId: "outer/1", parentToolCallId: "outer", isError: true, content, structuredContent, details: { receipt: "effect-receipt" }, usage };
  const result = handlers.get("tool_result")!(event);
  assert.deepEqual(result.content.slice(0, 2), content);
  assert.equal(result.structuredContent, structuredContent);
  assert.equal(result.content[2].text, toolFailureGuidance);
  assert.equal(result.isError, undefined, "native error authority is not replaced");
  assert.equal(result.usage, undefined, "native usage accounting is not replaced");
  assert.equal(content.length, 2, "original observations are not mutated");
  assert.equal(handlers.get("tool_result")!({ ...event, isError: false }), undefined);
  const message = { role: "toolResult", ...event, timestamp: 42, durationMs: 9 };
  const finalized = handlers.get("message_end")!({ message }).message;
  assert.equal(finalized.toolCallId, message.toolCallId);
  assert.equal(finalized.usage, usage);
  assert.equal(finalized.details, message.details);
  assert.equal(finalized.structuredContent, structuredContent);
  assert.equal(finalized.isError, true);
  assert.equal(handlers.get("message_end")!({ message: { ...finalized, content: result.content } }), undefined);
});
