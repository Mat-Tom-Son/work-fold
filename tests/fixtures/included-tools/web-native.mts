import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DefaultResourceLoader, createAgentSession, SessionManager, SettingsManager, AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
const nativeFetch=globalThis.fetch;
const {createWebAccessExtension}=await import('pi-web-access/embedded.ts');
assert.equal(globalThis.fetch,nativeFetch);
const root=await mkdtemp(join(tmpdir(),'work-fold-web-native-'));
const agentDir=join(root,'pi');await mkdir(agentDir);
process.env.PI_CODING_AGENT_DIR=agentDir;
const seen:Array<{url:string;key:unknown}>=[];
const timers=new Set<ReturnType<typeof setTimeout>>();
const server=createServer((req,res)=>{
 seen.push({url:req.url!,key:req.headers['x-subscription-token']});
 if(req.url?.startsWith('/web/search')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({web:{results:[{title:'Source fixture',url:'https://example.org/facts',description:'A source-bearing snippet.'}]}}));return;}
 if(req.url==='/error'){res.writeHead(503);res.end('No page');return;}
 if(req.url==='/binary'){res.writeHead(200,{'content-type':'application/pdf'});res.end('%PDF-fixture');return;}
 if(req.url==='/slow'){const timer=setTimeout(()=>{timers.delete(timer);res.writeHead(200,{'content-type':'text/plain'});res.end('Late result');},10000);timers.add(timer);req.on('close',()=>{clearTimeout(timer);timers.delete(timer);});return;}
 res.writeHead(200,{'content-type':'text/html'});res.end('<html><head><title>Workshop Planning</title></head><body><article><h1>Workshop Planning</h1>'+('<p>Doors open at nine. Registration costs twenty dollars. The workshop includes materials and lunch. Bring a notebook and arrive early for check in.</p>'.repeat(30))+'</article></body></html>');
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${(server.address() as any).port}`;
const sessions:any[]=[];
async function shutdown(s:any){await s.extensionRunner.emit({type:'session_shutdown',reason:'shutdown'});s.dispose();}
try{
 async function session(label:string,key?:string){const settings=SettingsManager.inMemory({retry:{enabled:false}});const loader=new DefaultResourceLoader({cwd:root,agentDir,settingsManager:settings,noContextFiles:true,noSkills:true,noThemes:true,noPromptTemplates:true,extensionFactories:[{path:join(root,`web-${label}.ts`),factory:createWebAccessExtension({networkPolicy:{allowRanges:[],trustEnvProxy:false,allowLoopback:true},getSearchConfig:()=>key==='default'?{provider:'duckduckgo'}:{provider:'brave',apiKey:key??'',apiBaseUrl:base}})}]});await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);const authStorage=AuthStorage.inMemory();const {session}=await createAgentSession({cwd:root,agentDir,settingsManager:settings,authStorage,modelRegistry:ModelRegistry.inMemory(authStorage),resourceLoader:loader,sessionManager:SessionManager.inMemory(),noTools:'builtin'});await session.bindExtensions({mode:'rpc'});sessions.push(session);return session;}
 const a=await session('a','secret-a');const b=await session('b','secret-b');const noSearch=await session('no-search');assert.equal(seen.length,0);assert.equal(globalThis.fetch,nativeFetch);console.log('PASS native import/catalog/session setup sends no network request and leaves global fetch unchanged');
 const call=(s:any,name:string,args:any,signal?:AbortSignal)=>s.agent.state.tools.find((t:any)=>t.name===name).execute('test-'+Math.random(),args,signal);
 const [one,two]=await Promise.all([call(a,'web_search',{query:'A'}),call(b,'web_search',{query:'B'})]);assert.deepEqual(seen.map(x=>x.key).sort(),['secret-a','secret-b']);assert.match(JSON.stringify(one),/https:\/\/example.org\/facts/);assert.doesNotMatch(JSON.stringify([one,two]),/secret-a|secret-b/);console.log('PASS same-cwd factories keep credentials independent and search returns source URLs without secrets');
 const before=seen.length;await assert.rejects(call(noSearch,'web_search',{query:'Missing config'}),/Skills & Extensions/);assert.equal(seen.length,before);console.log('PASS unconfigured search explains exact setup and makes no network request');
 const page=await call(noSearch,'fetch_content',{url:base+'/page',limit:800});assert.match(JSON.stringify(page),/Workshop Planning|Registration costs twenty/);assert.equal(page.details.start,0);assert.equal(page.details.end,800);assert.ok(page.details.total>800);assert.match(page.details.digest,/^[a-f0-9]{64}$/);const next=await call(noSearch,'fetch_content',{url:base+'/page',offset:800,limit:800});assert.equal(next.details.digest,page.details.digest);console.log('PASS direct local Readability extraction, explicit ranges and matching content provenance');
 await assert.rejects(call(a,'fetch_content',{url:base+'/error'}),/HTTP 503/);await assert.rejects(call(a,'fetch_content',{url:base+'/binary'}),/file or document tool/);console.log('PASS HTTP failure and PDF return honest errors without hosted extraction');
 const abort=new AbortController();const pending=call(a,'fetch_content',{url:base+'/slow'},abort.signal);setTimeout(()=>abort.abort(),30);await assert.rejects(pending);const pendingA=call(a,'fetch_content',{url:base+'/slow'});await shutdown(a);await assert.rejects(pendingA);const survived=await call(b,'fetch_content',{url:base+'/page'});assert.match(JSON.stringify(survived),/Workshop Planning/);console.log('PASS tool cancellation and session shutdown do not cancel another Chat');
 if(process.env.WORKFOLD_LIVE_WEB_TEST==='1'){const duck=await session('default','default');const live=await call(duck,'web_search',{query:'Mozilla Readability repository',count:3});assert.equal(live.details.provider,'duckduckgo');assert.ok(live.details.resultCount>0);assert.match(JSON.stringify(live),/https:\/\/github.com\/mozilla\/readability/);console.log('PASS real default DuckDuckGo search succeeds without keys or another model');}
 assert.equal(globalThis.fetch,nativeFetch);console.log('ALL NATIVE WEB CHECKS PASSED');
}finally{for(const s of sessions)await shutdown(s);for(const t of timers)clearTimeout(t);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
