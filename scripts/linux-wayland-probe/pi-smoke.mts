/** Real Pi/client/host/portal/input acceptance on the private GNOME fixture.
 * The loopback provider scripts tool calls; it is not real-model acceptance. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { AuthStorage, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ComputerSessionService } from "../../src/local/agent/computer-session.js";
import { NativeWaylandTransport } from "../../src/local/agent/wayland-transport.js";
import { PiConversationClient } from "../../src/local/agent/pi-client.js";

assert.equal(process.env.WORKFOLD_ISOLATED_GNOME_TEST, "1");
assert.equal(process.env.XDG_RUNTIME_DIR, "/tmp/workfold-runtime");
assert.ok(existsSync("/run/.containerenv") || existsSync("/.dockerenv"));
assert.equal(existsSync("/tmp/workfold-input-fixture"), false, "Use a fresh isolated input fixture");
const run = promisify(execFile);
const ui = (command: string) => run("python3", ["/work/scripts/linux-wayland-probe/portal-test-ui.py", command], { timeout: 20_000 });
await ui("desktop-ready");
const root = await mkdtemp("/tmp/workfold-wayland-pi-");
const spaceRoot = join(root, "folder"), agentDir = join(root, "pi"), stateRoot = join(root, "state");
await Promise.all([spaceRoot, agentDir, stateRoot].map(path => mkdir(path, { mode: 0o700 })));
const fixture = spawn("python3", ["/work/scripts/linux-wayland-probe/input-fixture.py"], { stdio: "ignore" });
async function until(check: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!await check()) { assert.ok(Date.now() < end, "Native fixture did not settle"); await delay(25); }
}
const events = async () => JSON.parse(await readFile("/tmp/workfold-input-fixture/events.json", "utf8"));
await until(async () => existsSync("/tmp/workfold-input-fixture/events.json") && (await events()).mapped);
const service = new ComputerSessionService({ launch: () => NativeWaylandTransport.launch("/work/out/included-tools/wayland-helper/work-fold-wayland") });
const conversationId = `chat-${randomUUID()}`;
const owner = { scope: "management" as const, conversationId, spaceRoot };
const failures: Error[] = [];
let requests = 0, imageRequests = 0;
const server = createServer(async (request, response) => {
  try {
    let bytes = "";
    for await (const chunk of request) { bytes += chunk; assert.ok(bytes.length < 40 * 1024 * 1024); }
    const payload = JSON.parse(bytes);
    assert.ok(++requests <= 4, "Unexpected Pi model loop");
    if (bytes.includes("data:image/png;base64,")) imageRequests++;
    const results = payload.messages.filter((message: any) => message.role === "tool");
    const last = JSON.stringify(results.at(-1)?.content ?? "");
    let tool: { name: string; arguments: object } | undefined;
    if (requests === 1) tool = { name: "find_roots", arguments: { kind: "shared_screen" } };
    if (requests === 2) {
      const ref = last.match(/@r-shared-[a-f0-9-]{36}/)?.[0]; assert.ok(ref, "Pi did not receive a shared-screen root");
      tool = { name: "observe_ui", arguments: { root: ref, mode: "visual" } };
    }
    if (requests === 3) {
      const stateId = last.match(/@shared-[a-f0-9-]{36}/)?.[0]; assert.ok(stateId, "Pi did not receive an observation");
      assert.ok(bytes.includes("data:image/png;base64,"), "Actual image must reach Pi's provider transport");
      tool = { name: "act_ui", arguments: { stateId, actions: [
        { action: "click", x: 500, y: 160 }, { action: "typeText", text: "Pi controlled this shared Wayland screen." },
        { action: "scroll", scrollY: 120 }, { action: "keypress", keys: ["Ctrl", "s"] },
      ] } };
    }
    if (requests === 4) assert.match(last, /Input sent; verify/);
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const send = (delta: object, reason: string | null) => response.write(`data: ${JSON.stringify({
      id: `fixture-${requests}`, object: "chat.completion.chunk", created: 1, model: "wayland-fixture",
      choices: [{ index: 0, delta, finish_reason: reason }],
    })}\n\n`);
    if (tool) {
      send({ role: "assistant", tool_calls: [{ index: 0, id: `tool-${requests}`, type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, null);
      send({}, "tool_calls");
    } else { send({ role: "assistant", content: "Shared-screen fixture completed." }, null); send({}, "stop"); }
    response.end("data: [DONE]\n\n");
  } catch (error) { failures.push(error as Error); response.writeHead(500); response.end("Fixture rejected unexpected tool behavior"); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const authStorage = AuthStorage.inMemory();
const modelRegistry = ModelRegistry.inMemory(authStorage);
modelRegistry.registerProvider("wayland-fixture", { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "synthetic",
  models: [{ id: "wayland-fixture", name: "Wayland scripted fixture", reasoning: false, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 1024 }] });
const client = new PiConversationClient(conversationId, spaceRoot, { resolveRuntime: async () => ({
  agentDir, authStorage, modelRegistry,
  settingsManager: SettingsManager.inMemory({ defaultProvider: "wayland-fixture", defaultModel: "wayland-fixture", defaultThinkingLevel: "off", retry: { enabled: false } }),
  includedTools: { rootPath: "/work/resources/included-tools", stateRoot,
    helperAppPath: "/work/out/included-tools/computer-helper/linux-bridge", computerSession: service },
}) });
try {
  const sharing = service.start(owner);
  await Promise.all([sharing, ui("choose-input")]);
  const accepted = `task-${randomUUID()}`;
  const response = await client.prompt("Complete the isolated Wayland native acceptance fixture.", { managementTaskId: accepted });
  assert.deepEqual(failures, []); assert.equal(requests, 4); assert.ok(imageRequests >= 2);
  assert.equal(response, "Shared-screen fixture completed.");
  await until(async () => (await events()).saved);
  assert.equal(await readFile("/tmp/workfold-input-fixture/saved.txt", "utf8"), "Pi controlled this shared Wayland screen.");
  assert.equal((await events()).clicks, 1);
  assert.equal(service.status().state, "active"); assert.equal(service.status().controlInUse, false, "Turn completion releases the native seat");
  await client.stop();
  assert.equal(service.status().state, "idle", "Chat disposal ends its grant");
  console.log("PASS real Pi client → included Pi tools → host accepted-turn lease → native portal → PipeWire image → provider request → libei input → exact saved bytes → turn release → Chat teardown. Provider responses are scripted.");
} finally {
  await client.stop().catch(() => {}); await service.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fixture.kill("SIGTERM");
  await new Promise<void>(resolve => { if (fixture.exitCode !== null) resolve(); else fixture.once("exit", () => resolve()); });
  for (const error of failures) console.error(error.message);
}
