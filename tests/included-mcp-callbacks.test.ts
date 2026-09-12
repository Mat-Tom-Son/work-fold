import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { startLocalApi } from "../src/local/server.js";
import { RoutedPiExtensionUiBridge, type PiExtensionUiRequest } from "../src/local/agent/extension-ui.js";

const require = createRequire(import.meta.url);
test("an included native MCP connection can ask again after its connecting turn settles", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-mcp-callback-"));
  const agentDir = join(root, "pi"); const server = join(root, "server.cjs"); const results = join(root, "results.jsonl");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(server, `let pending;let seq=0;const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');require('readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.method==='initialize'){send({jsonrpc:'2.0',id:q.id,result:{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'questions',version:'1'}}});}else if(q.method==='tools/list'){send({jsonrpc:'2.0',id:q.id,result:{tools:[{name:'ask',description:'Ask for input',inputSchema:{type:'object',properties:{}}}]}});}else if(q.method==='tools/call'){pending=q.id;send({jsonrpc:'2.0',id:'server-'+(++seq),method:'elicitation/create',params:{message:'Approve fixture input',requestedSchema:{type:'object',properties:{}}}});}else if(q.result&&String(q.id).startsWith('server-')){send({jsonrpc:'2.0',id:pending,result:{content:[{type:'text',text:q.result.action}]}});}});`);
  await writeFile(join(agentDir, "extensions", "mcp-fixture.ts"), `
    import { appendFile } from 'node:fs/promises';
    import { createMcpAdapter } from ${JSON.stringify(require.resolve("pi-mcp-adapter"))};
    export default function(pi) {
      let gateway;
      const intercepted = new Proxy(pi, { get(target,key) {
        if(key==='registerTool') return (tool) => { if(tool.name==='mcp') gateway=tool; return target.registerTool(tool); };
        const value=Reflect.get(target,key); return typeof value==='function'?value.bind(target):value;
      }});
      createMcpAdapter({agentDir:${JSON.stringify(agentDir)},initializeAtLoad:false,bootstrapLazyServers:false,hostSetupOnly:true,config:{mcpServers:{questions:{command:process.execPath,args:[${JSON.stringify(server)}],lifecycle:'lazy'}},settings:{sampling:false,elicitation:true,directTools:false,ui:false,notifyOnStartupConnect:false}}})(intercepted);
      pi.registerCommand('mcp-fixture-connect',{description:'Connect fixture',handler:async(_,ctx)=>{await gateway.execute('connect',{connect:'questions'},undefined,undefined,ctx);}});
      pi.registerCommand('mcp-fixture-ask',{description:'Ask over existing transport',handler:async(_,ctx)=>{const result=await gateway.execute('ask',{server:'questions',tool:'ask',args:{}},undefined,undefined,ctx);await appendFile(${JSON.stringify(results)},JSON.stringify(result)+'\\n');}});
    }
  `);
  const bridge = new RoutedPiExtensionUiBridge();
  const pending = new Map<string, PiExtensionUiRequest>();
  bridge.on("request", (request) => pending.set(request.id, request)); bridge.on("settled", ({ id }) => pending.delete(id));
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), spaceBase: join(root, "spaces"), loadEnv: false, extensionUiBridge: bridge, piRuntimeProvider: { resolveRuntime: async () => ({ agentDir }) } });
  const until = async (condition: () => boolean | Promise<boolean>) => { for (let n = 0; n < 500; n++) { if (await condition()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error("Timed out waiting for native MCP callback."); };
  const settled = (taskId: string) => until(async () => (await api.actFacade.manageTurnStatus({ taskId })).task.state !== "running");
  try {
    const first = await api.actFacade.manageSend({ content: "/mcp-fixture-connect", newConversation: true }); await settled(first.taskId);
    assert.equal((await api.actFacade.manageTurnStatus({ taskId: first.taskId })).task.state, "succeeded");
    const second = await api.actFacade.manageSend({ conversationId: first.conversationId, content: "/mcp-fixture-ask" });
    await until(() => pending.size === 1);
    const question = [...pending.values()][0]!;
    assert.equal(question.conversationId, first.conversationId);
    assert.equal(question.taskId, undefined, "legacy reused transports have Chat ownership, not an inferred new task");
    assert.equal(question.method, "select");
    bridge.respond(question.id, { value: "Continue" }); await settled(second.taskId);
    assert.equal((await api.actFacade.manageTurnStatus({ taskId: second.taskId })).task.state, "succeeded");
    assert.match(await readFile(results, "utf8"), /accept/);
    const third = await api.actFacade.manageSend({ conversationId: first.conversationId, content: "/mcp-fixture-ask" });
    await until(() => pending.size === 1); await api.actFacade.manageStop({ taskId: third.taskId }); await settled(third.taskId);
    assert.equal(pending.size, 0, "explicit Stop cancels session-owned MCP input too");
  } finally { await api.close(); await rm(root, { recursive: true, force: true }); }
});
