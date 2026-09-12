import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { startLocalApi } from "../src/local/server.js";
import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { ModelContextInspector } from "../src/local/agent/model-context-inspector.js";
import { workFoldManagementScopeId } from "../src/local/state-paths.js";
import type { ModelContextInspection, ModelContextInspectionState } from "../src/shared/model-context-inspection.js";

test("context diagnostics are authenticated, read-only to Pi, exactly scoped and absent from portable and remote Chat projections", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-context-api-"));
  const agentDir = join(root, "pi");
  const marker = "PAYLOAD-ONLY-CONTEXT-INSPECTION-MARKER";
  const secret = "synthetic-private-provider-api-key";
  const providerRequests: unknown[] = [];
  const providerServer = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      providerRequests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close", "x-private-response": secret });
      const send = (delta: object, finishReason: string | null) => response.write(`data: ${JSON.stringify({
        id: `context-call-${providerRequests.length}`, object: "chat.completion.chunk", created: 1, model: "context-api-model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
      send({ role: "assistant", content: "The requested work is complete." }, null);
      send({}, "stop");
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const providerPort = (providerServer.address() as AddressInfo).port;
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "inspection.ts"), `
    export default function(pi) {
      pi.registerProvider("context-api-provider", {
        api: "openai-completions", baseUrl: "http://127.0.0.1:${providerPort}/v1", apiKey: ${JSON.stringify(secret)},
        models: [{ id: "context-api-model", name: "Context API model", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
      });
      pi.on("before_provider_request", (event) => ({ ...event.payload, user: ${JSON.stringify(marker)} }));
    }
  `);
  let runtimeResolutions = 0;
  const sessionToken = "local-context-test-session";
  const options = {
    port: 0, appMode: "desktop" as const, stateBase: join(root, "state"), spaceBase: join(root, "content"), loadEnv: false,
    sessionToken,
    piRuntimeProvider: { async resolveRuntime() {
      runtimeResolutions += 1;
      return { agentDir, settingsManager: SettingsManager.inMemory({ defaultProvider: "context-api-provider", defaultModel: "context-api-model", defaultThinkingLevel: "off" }) };
    } },
  };
  let api = await startLocalApi(options);
  t.after(async () => {
    await api.close();
    await new Promise<void>((resolve) => providerServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const request = (path: string, method = "GET", body?: unknown, authenticated = true) => fetch(api.origin + path, {
    method,
    headers: { "content-type": "application/json", ...(authenticated ? { "x-work-fold-session": sessionToken } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async <T = any>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await request(path, method, body);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<T>;
  };
  const inspect = (query = "") => json<ModelContextInspectionState>(`/api/model-context${query}`);
  const initialResolutions = runtimeResolutions;
  assert.equal((await request("/api/model-context", "GET", undefined, false)).status, 401);
  assert.equal((await request("/api/model-context", "POST", { enabled: true }, false)).status, 401);
  assert.deepEqual((await inspect()).records, []);
  assert.equal((await inspect()).enabled, false);
  assert.equal((await request("/api/model-context/missing")).status, 404);
  assert.equal((await request("/api/model-context?conversationId=unknown")).status, 400);
  for (const body of [{}, { enabled: "true" }, { clear: false }, { enabled: true, clear: true }, { extra: true }]) {
    assert.equal((await request("/api/model-context", "POST", body)).status, 400);
  }
  assert.equal((await request("/api/model-context/missing", "POST", { enabled: true })).status, 400);
  assert.equal((await json<ModelContextInspectionState>("/api/model-context", "POST", { enabled: true })).enabled, true);
  assert.deepEqual((await inspect(`?spaceId=${workFoldManagementScopeId}&conversationId=unopened-chat`)).records, []);
  assert.equal(runtimeResolutions, initialResolutions, "opening or changing diagnostics never initializes a Pi session");
  assert.equal(providerRequests.length, 0);

  const space = (await api.actFacade.createSpace({ name: "Context inspection" })).space;
  const chat = (await api.actFacade.createConversation({ space: space.id })).conversation;
  const wrongChat = (await api.actFacade.createConversation({ space: space.id })).conversation;
  const [fold, spaceTurn] = await Promise.all([
    api.actFacade.manageSend({ content: "Handle a fold request.", newConversation: true }),
    api.actFacade.sendMessage({ space: space.id, conversationId: chat.id, content: "Handle a Space request." }),
  ]);
  await until(async () => (await api.actFacade.manageTurnStatus({ taskId: fold.taskId })).task.state === "succeeded"
    && (await api.actFacade.turnStatus({ space: space.id, taskId: spaceTurn.taskId })).task.state === "succeeded");
  const foldQuery = `?spaceId=${workFoldManagementScopeId}&conversationId=${fold.conversationId}`;
  const spaceQuery = `?spaceId=${space.id}&conversationId=${chat.id}`;
  const foldRecords = (await inspect(foldQuery)).records;
  const spaceRecords = (await inspect(spaceQuery)).records;
  const foldRecord = foldRecords.find((record) => record.owner.purpose === "assistant")!;
  const spaceRecord = spaceRecords.find((record) => record.owner.purpose === "assistant")!;
  assert.ok(foldRecord); assert.ok(spaceRecord);
  assert.equal(foldRecord.owner.taskId, fold.taskId);
  assert.equal(spaceRecord.owner.taskId, spaceTurn.taskId);
  assert.ok(foldRecords.every((record) => record.owner.conversationId === fold.conversationId));
  assert.ok(spaceRecords.every((record) => record.owner.conversationId === chat.id));
  assert.ok((await inspect()).records.length >= foldRecords.length + spaceRecords.length);
  assert.deepEqual((await inspect(`?spaceId=${space.id}&conversationId=${wrongChat.id}`)).records, []);
  assert.equal((await request(`/api/model-context/${spaceRecord.id}${foldQuery}`)).status, 404);
  assert.equal((await request(`/api/model-context/${spaceRecord.id}?spaceId=${space.id}&conversationId=${wrongChat.id}`)).status, 404);
  const detail = (await json<{ record: ModelContextInspection }>(`/api/model-context/${spaceRecord.id}${spaceQuery}`)).record;
  assert.equal(detail.stage, "provider_payload");
  assert.ok(JSON.stringify(detail.payloads).includes(marker), "the native payload hook is captured after its transformation");
  assert.ok(!JSON.stringify(detail.assembled).includes(marker), "provider payload and assembled context remain distinct");
  assert.ok(!JSON.stringify(detail).includes(secret), "auth and response headers never enter diagnostics");
  assert.ok(providerRequests.some((payload) => JSON.stringify(payload).includes(marker)), "observation does not replace the actual provider request");
  assert.deepEqual((detail.provenance!.value as any).dispatch.tools,
    (detail.assembled.value as any).tools.map((tool: any) => tool.name));

  const inferenceInspector = new ModelContextInspector();
  inferenceInspector.setEnabled(true);
  const sessionOnlyInstructions = "SESSION-INSTRUCTIONS-NOT-SENT-TO-BOUNDED-INFERENCE";
  const inferenceClient = new PiConversationClient("app-inference", space.spaceRoot, {
    async resolveRuntime() {
      return { ...await options.piRuntimeProvider.resolveRuntime(), assistantInstructions: sessionOnlyInstructions,
        modelContextInspector: inferenceInspector };
    },
  });
  try {
    const beforeInference = providerRequests.length;
    await inferenceClient.infer({ instructions: "Summarize the supplied notes.", input: "Synthetic workshop notes.", maxOutputBytes: 1024, timeoutMs: 5_000 });
    assert.equal(providerRequests.length, beforeInference + 1);
    const inference = inferenceInspector.get(inferenceInspector.list()[0]!.id)!;
    assert.equal(inference.owner.purpose, "app_inference");
    assert.equal(inference.truncated, false, JSON.stringify(inference.provenance?.omissions));
    const assembled = inference.assembled.value as any;
    const provenance = inference.provenance!.value as any;
    assert.deepEqual(provenance.dispatch.tools, []);
    assert.equal(provenance.dispatch.messageCount, 1);
    assert.equal(provenance.dispatch.systemPrompt.sha256, createHash("sha256").update(assembled.systemPrompt).digest("hex"));
    assert.ok(provenance.loadedSessionResources.tools.length > 0, "loaded tools remain discoverable as session metadata");
    assert.ok(provenance.loadedSessionResources.appendedInstructions.some((item: any) =>
      item.sha256 === createHash("sha256").update(`## Space instructions\n\n${sessionOnlyInstructions}`).digest("hex")));
    assert.equal("tools" in assembled, false);
    assert.ok(!JSON.stringify(providerRequests.at(-1)).includes(sessionOnlyInstructions));
    assert.ok(!JSON.stringify(inference).includes(secret));
  } finally {
    inferenceInspector.setEnabled(false);
    await inferenceClient.stop();
  }

  const baselineResolutions = runtimeResolutions;
  const baselineRequests = providerRequests.length;
  await inspect(); await inspect(spaceQuery);
  await json(`/api/model-context/${foldRecord.id}${foldQuery}`);
  assert.equal(runtimeResolutions, baselineResolutions);
  assert.equal(providerRequests.length, baselineRequests, "reopening captures never reruns model work");
  const assertPrivateProjection = (value: unknown) => {
    const text = JSON.stringify(value);
    assert.ok(!text.includes(marker));
    assert.ok(!text.includes(spaceRecord.id));
    assert.ok(!text.includes(foldRecord.id));
    assert.ok(!text.includes("assembled"));
  };
  const transcript = await json(`/api/spaces/${space.id}/conversations/${chat.id}`);
  assertPrivateProjection(transcript);
  assertPrivateProjection(await json(`/api/management/conversations/${fold.conversationId}`));
  const portableRoot = join(space.spaceRoot, ".work-fold", "conversations");
  for (const name of await readdir(portableRoot)) {
    if (name.endsWith(".jsonl") || name.endsWith(".json")) assertPrivateProjection(await readFile(join(portableRoot, name), "utf8"));
  }
  const principal = { browserId: "context-browser", grantId: "context-grant", requestId: "context-summary" };
  assertPrivateProjection(await api.remoteFacade.execute("management.summary", { conversationId: fold.conversationId }, principal));

  const cleared = await json<ModelContextInspectionState>("/api/model-context", "POST", { clear: true });
  assert.equal(cleared.enabled, true); assert.deepEqual(cleared.records, []);
  assert.equal((await request(`/api/model-context/${spaceRecord.id}${spaceQuery}`)).status, 404);
  const afterClear = await api.actFacade.manageSend({ conversationId: fold.conversationId, content: "Create a fresh capture after clearing." });
  await until(async () => (await api.actFacade.manageTurnStatus({ taskId: afterClear.taskId })).task.state === "succeeded");
  const beforeDisable = (await inspect()).records;
  assert.ok(beforeDisable.length > 0, "clear retains recording for subsequent requests");
  const disabled = await json<ModelContextInspectionState>("/api/model-context", "POST", { enabled: false });
  assert.equal(disabled.enabled, false); assert.deepEqual(disabled.records, []);
  assert.equal((await request(`/api/model-context/${beforeDisable[0]!.id}`)).status, 404, "disabling discards retained captures");
  const next = await api.actFacade.sendMessage({ space: space.id, conversationId: chat.id, content: "Another ordinary request while diagnostics are off." });
  await until(async () => (await api.actFacade.turnStatus({ space: space.id, taskId: next.taskId })).task.state === "succeeded");
  assert.deepEqual((await inspect()).records, [], "disabled recording stays empty during real model work");
  assertPrivateProjection(await json(`/api/spaces/${space.id}/conversations/${chat.id}`));
  assertPrivateProjection(await api.remoteFacade.execute("management.summary", { conversationId: fold.conversationId }, principal));

  await json("/api/model-context", "POST", { enabled: true });
  const last = await api.actFacade.sendMessage({ space: space.id, conversationId: chat.id, content: "Create a capture before restart." });
  await until(async () => (await api.actFacade.turnStatus({ space: space.id, taskId: last.taskId })).task.state === "succeeded");
  assert.ok((await inspect()).records.length > 0);
  const beforeRestartRequests = providerRequests.length;
  await api.close();
  api = await startLocalApi(options);
  const restarted = await inspect();
  assert.equal(restarted.enabled, false); assert.deepEqual(restarted.records, []);
  assert.equal(providerRequests.length, beforeRestartRequests, "restart never replays captured requests");
});

async function until(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the owned Assistant turn to settle.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
