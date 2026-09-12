import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiConversationClient, PiTurnDrainingError } from "../src/local/agent/pi-client.js";
import { RoutedPiExtensionUiBridge, type PiExtensionUiRequest } from "../src/local/agent/extension-ui.js";

test("a native transport opened in a stopped turn can ask after drain, but never during drain or after disposal", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-stopped-transport-"));
  const agentDir = join(root, "pi"), spaceRoot = join(root, "space"), results = join(root, "results.jsonl");
  await mkdir(join(agentDir, "extensions"), { recursive: true }); await mkdir(spaceRoot);
  let socket: Socket | undefined;
  const server = createServer((connected) => { socket = connected; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await writeFile(join(agentDir, "extensions", "transport.ts"), `
    import { createConnection } from 'node:net';
    import { createInterface } from 'node:readline';
    import { appendFile } from 'node:fs/promises';
    export default function(pi) {
      let socket;
      pi.registerCommand('open-transport', {description:'Open a native connection inside this command',handler:async(_,ctx)=>{
        const ui = ctx.ui;
        let drain; const held = new Promise(resolve=>{drain=resolve});
        socket=createConnection({host:'127.0.0.1',port:${address.port}});
        createInterface({input:socket}).on('line',async title=>{
          if(title==='release-opening'){drain();return}
          const answer=await ui.input(title);
          await appendFile(${JSON.stringify(results)},JSON.stringify({title,answer:answer??null})+'\\n');
        });
        await held;
      }});
      pi.registerCommand('noop', {description:'Prove native drain through public reuse',handler:async()=>{}});
      pi.registerCommand('next-question', {description:'Hold a different turn',handler:async(_,ctx)=>{
        await ctx.ui.input('New turn question');
      }});
      // Deliberately retain this misbehaving transport on session_shutdown:
      // even callbacks the Extension fails to clean must lose host UI access.
    }
  `);
  const bridge = new RoutedPiExtensionUiBridge();
  const pending = new Map<string, PiExtensionUiRequest>();
  const emitted: PiExtensionUiRequest[] = [];
  bridge.on("request", (request) => { pending.set(request.id, request); emitted.push(request); });
  bridge.on("settled", ({ id }) => pending.delete(id));
  const client = new PiConversationClient("transport-chat", spaceRoot, { resolveRuntime: async () => ({ agentDir, extensionUi: bridge }) });
  t.after(async () => {
    socket?.write("release-opening\n");
    await client.stop(); socket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const records = async (): Promise<Array<{ title: string; answer: string | null }>> => (await readFile(results, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const send = (title: string) => { assert.ok(socket); socket.write(`${title}\n`); };
  const opening = client.prompt("/open-transport", { managementTaskId: "opening-task" });
  const openingCancelled = assert.rejects(opening, { name: "PiTurnCancelledError" });
  await until(() => Boolean(socket));
  send("Before Stop"); await until(() => pending.size === 1);
  assert.equal([...pending.values()][0]!.taskId, "opening-task");
  assert.equal(await client.abort(), true); await openingCancelled;
  await until(async () => (await records()).some(record => record.title === "Before Stop" && record.answer === null));
  assert.equal(pending.size, 0);

  send("During drain");
  await until(async () => (await records()).some(record => record.title === "During drain" && record.answer === null));
  assert.equal(emitted.length, 1, "cancelled native work cannot open another question while it drains");
  await assert.rejects(client.prompt("/noop", { managementTaskId: "too-early" }), PiTurnDrainingError);
  send("release-opening");
  await until(async () => {
    try { await client.prompt("/noop", { managementTaskId: "drain-probe" }); return true; }
    catch (error) { if (error instanceof PiTurnDrainingError) return false; throw error; }
  });

  const next = client.prompt("/next-question", { managementTaskId: "new-task" });
  await until(() => pending.size === 1);
  const newQuestion = [...pending.values()][0]!; assert.equal(newQuestion.taskId, "new-task");
  send("After drained Stop"); await until(() => pending.size === 2);
  const surviving = [...pending.values()].find(request => request.title === "After drained Stop")!;
  assert.equal(surviving.conversationId, "transport-chat");
  assert.equal(surviving.taskId, undefined, "a surviving connection has Chat ownership, never the old or current task");
  bridge.respond(surviving.id, { value: "Still connected" });
  bridge.respond(newQuestion.id, { value: "Finish new turn" }); await next;
  await until(async () => (await records()).some(record => record.title === "After drained Stop" && record.answer === "Still connected"));

  send("Pending at disposal"); await until(() => pending.size === 1);
  await client.stop();
  await until(async () => (await records()).some(record => record.title === "Pending at disposal" && record.answer === null));
  const beforeDisposedCallback = emitted.length;
  send("After disposal");
  await until(async () => (await records()).some(record => record.title === "After disposal" && record.answer === null));
  assert.equal(pending.size, 0);
  assert.equal(emitted.length, beforeDisposedCallback, "disposed session callbacks cannot regain the Chat UI");
});

async function until(condition: () => boolean | Promise<boolean>) {
  for (let count = 0; count < 1000; count++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Timed out waiting for native transport lifetime.");
}
