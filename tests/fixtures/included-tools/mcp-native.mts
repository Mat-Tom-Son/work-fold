import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { DefaultResourceLoader, createAgentSession, SessionManager, SettingsManager, FileCredentialStore, ModelRuntime, createMcpExtension, createCodemodeExtension, createToolSearchExtension } from '@earendil-works/pi-coding-agent';
import { includedNativeMcpOptions } from '../../../src/local/agent/included-mcp-setup.js';
const root=await mkdtemp(join(tmpdir(),'work-fold-mcp-native-'));
const nativeAgentDir=join(root,'pi');
process.env.PI_CODING_AGENT_DIR=join(root,'ambient-pi');
await mkdir(nativeAgentDir,{recursive:true});
await mkdir(process.env.PI_CODING_AGENT_DIR,{recursive:true});
const log=join(root,'stdio.jsonl');
const serverPath=join(root,'server.cjs');
await writeFile(serverPath,`const fs=require('fs'); const log=${JSON.stringify(log)}; fs.appendFileSync(log,JSON.stringify({started:process.pid})+'\\n'); require('readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(q)+'\\n');if(!('id' in q))return;let result;if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(q.method==='tools/list')result={tools:[{name:'echo',description:'Return selected note',inputSchema:{type:'object',properties:{note:{type:'string'}},required:['note'],additionalProperties:false}},{name:'slow',description:'A slow read only call',inputSchema:{type:'object',properties:{}}}]};else if(q.method==='tools/call'){result={content:[{type:'text',text:q.params.arguments?.note??'finished'}]};if(q.params.name==='slow'){setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n'),10000);return;}}else if(q.method==='ping')result={};else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'unknown'}})+'\\n');return;}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`);
const httpLog:any[]=[];
const http=createServer(async(req,res)=>{if(req.method==='GET'){res.writeHead(405);res.end();return;}const chunks=[];for await(const c of req)chunks.push(c);const q=JSON.parse(Buffer.concat(chunks).toString());httpLog.push(q);if(!('id'in q)){res.writeHead(202);res.end();return;}let result;if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'http-fixture',version:'1'}};else if(q.method==='tools/list')result={tools:[{name:'echo',description:'Return note',inputSchema:{type:'object',properties:{note:{type:'string'}},required:['note']}}]};else if(q.method==='tools/call')result={content:[{type:'text',text:q.params.arguments.note}],structuredContent:{records:q.params.arguments.note==='large-structured'?Array.from({length:5000},(_,i)=>({id:i,note:'record data'})):[{id:1}],nextCursor:'NATIVE_CURSOR_EVIDENCE'}};else result={};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});
await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
const sessions:any[]=[];
async function shutdown(s:any){await s.extensionRunner.emit({type:'session_shutdown',reason:'shutdown'});s.dispose();}
const pause=(ms=50)=>new Promise(r=>setTimeout(r,ms));
const logs=async()=> (await readFile(log,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
try {
 await writeFile(join(nativeAgentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
   local: { command: process.execPath, args: [serverPath], exposure: 'direct' },
   remote: { url: `http://127.0.0.1:${(http.address() as any).port}/mcp`, exposure: 'deferred' },
 } }));
 const credentials = FileCredentialStore.inMemory();
 const fauxs = new Map<any, ReturnType<typeof fauxProvider>>();
 async function loader(name: string, mode: 'catalog' | 'session') {
   const cwd = join(root, name); await mkdir(cwd, {recursive: true});
   const settings = SettingsManager.inMemory({ defaultTools: ['+codemode', '+tool_search'] });
   const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: nativeAgentDir, settingsManager: settings,
     noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
     extensionFactories: [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension(await includedNativeMcpOptions({agentDir: nativeAgentDir}, credentials, mode))],
   });
   await resourceLoader.reload(); assert.deepEqual(resourceLoader.getExtensions().errors, []);
   return {cwd, settings, resourceLoader};
 }
 const catalog = await loader('catalog', 'catalog'); await pause(100);
 assert.equal((await logs()).length, 0); assert.equal(httpLog.length, 0);
 console.log('PASS native catalog import does not spawn configured servers');
 async function session(name: string) {
   const l = await loader(name, 'session');
   const faux = fauxProvider(); const modelRuntime = await ModelRuntime.create({credentials, modelsPath: null});
   modelRuntime.registerNativeProvider(faux.provider);
   const {session} = await createAgentSession({cwd: l.cwd, agentDir: nativeAgentDir,
     modelRuntime, model: faux.getModel(), resourceLoader: l.resourceLoader,
     settingsManager: l.settings, sessionManager: SessionManager.inMemory(l.cwd),
   });
   fauxs.set(session, faux); sessions.push(session); await session.bindExtensions({mode: 'rpc'});
   for(let n=0; n<100 && !session.getCallableToolNames().includes('mcp__local__echo'); n++) await pause(10);
   return session;
 }
 const a = await session('a'), b = await session('b');
 assert.ok(a.getCallableToolNames().includes('mcp__local__echo'));
 assert.ok(a.getActiveToolNames().includes('codemode'));
 assert.ok(a.getActiveToolNames().includes('tool_search'));
 const call = (s: any, name: string, args: any, signal?: AbortSignal) => {
   const tool = s.agent.state.tools.find((t: any) => t.name === name); assert.ok(tool, name);
   return tool.execute('fixture-'+Math.random(), args, signal);
 };
 let result = await call(a, 'mcp__local__echo', {note: 'local-one'});
 assert.match(JSON.stringify(result), /local-one/);
 console.log('PASS stdio initialize/discover/invoke through native tool wrapper');
 const events: any[] = []; a.subscribe((event: any) => events.push(event));
 const code = "const matches = await searchTools('echo', {namespace:'remote'}); text(matches); text((await tools.mcp__remote__echo({note:'large-structured'})).structuredContent.nextCursor); text((await models.getModelsOfType('image')).length); text((await models.getModelsOfType('classifier')).length);";
 fauxs.get(a)!.setResponses([fauxAssistantMessage(fauxToolCall('codemode', {code}, {id:'script-1'})), fauxAssistantMessage('Done.')]);
 await a.prompt('Run the fixture script.');
 result = a.messages.find((m:any)=>m.role==='toolResult' && m.toolCallId==='script-1');
 assert.match(JSON.stringify(result), /NATIVE_CURSOR_EVIDENCE/);
 assert.equal(httpLog.filter(x=>x.method==='tools/call').length, 1, 'structured calls never replay');
 assert.ok(result.details.calls.some((c:any)=>c.name==='mcp__remote__echo'));
 assert.ok(events.some(e=>e.type==='tool_execution_end' && e.parentToolCallId));
 console.log('PASS native codemode discovery, structured cursors, nested tool events and image/classifier catalogs');
 const controller = new AbortController();
 const slow = call(a, 'mcp__local__slow', {}, controller.signal).catch(e=>e);
 await pause(70); controller.abort(); await slow; await pause(70);
 assert.ok((await logs()).some(x=>x.method==='notifications/cancelled'));
 console.log('PASS cancellation reaches stdio MCP peer');
 await shutdown(a);
 result = await call(b, 'mcp__local__echo', {note: 'second-survives'}); assert.match(JSON.stringify(result), /second-survives/);
 console.log('PASS disposing one session preserves the other session transport');
 assert.equal(await readFile(join(process.env.PI_CODING_AGENT_DIR!, 'mcp-auth.json'),'utf8').catch(()=>null), null);
 console.log('ALL NATIVE MCP CHECKS PASSED');
} finally { for(const s of sessions) await shutdown(s); http.closeAllConnections(); await new Promise<void>(r=>http.close(()=>r())); await pause(100); await rm(root,{recursive:true,force:true}); }
