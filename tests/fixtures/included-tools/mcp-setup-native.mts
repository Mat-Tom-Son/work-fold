import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createIncludedMcpSetup, loadIncludedMcpConfig } from '../../../src/local/agent/included-mcp-setup.js';
import { DefaultResourceLoader, createAgentSession, SessionManager, SettingsManager, AuthStorage, ModelRegistry, createEventBus } from '@earendil-works/pi-coding-agent';

// Stub only the OS boundary. Both independently loaded native modules then
// share the same secure store, just as separate native keyring instances do.
// Never read or write a real personal credential in this fixture.
delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
const moduleApi=createRequire(import.meta.url)('node:module');
const originalLoad=moduleApi._load;
const secrets=new Map<string,string>();
moduleApi._load=function(request:string,...args:any[]){if(request==='@napi-rs/keyring')return {Entry:class {key:string;constructor(service:string,account:string){this.key=service+'\0'+account;}getPassword(){return secrets.get(this.key)??null;}setPassword(value:string){secrets.set(this.key,value);}deleteCredential(){return secrets.delete(this.key);}}};return originalLoad.call(this,request,...args);};
process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE='1';
const root=await mkdtemp(join(tmpdir(),'work-fold-mcp-setup-'));
const agentDir=join(root,'pi'),aDir=join(root,'space-a'),bDir=join(root,'space-b');
await Promise.all([agentDir,aDir,bDir].map(p=>mkdir(p,{recursive:true})));
process.env.PI_CODING_AGENT_DIR=join(root,'ambient');
const authHeaders:string[]=[];let origin='';let authorization:URL|undefined;let mutateBeforeToken=false;let tokenSeen=0;let fenced=0;let tokenFenceSeen=0;
const server=createServer(async(req,res)=>{
 const url=new URL(req.url??'/',origin||'http://127.0.0.1');
 const json=(status:number,data:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
 if(url.pathname==='/oauth-mcp'&&req.method==='POST'){res.writeHead(401,{'www-authenticate':`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`});res.end();return;}
 if(url.pathname==='/.well-known/oauth-protected-resource'){json(200,{resource:origin+'/oauth-mcp',authorization_servers:[origin],scopes_supported:['mcp:read']});return;}
 if(['/.well-known/oauth-authorization-server','/.well-known/openid-configuration'].includes(url.pathname)){json(200,{issuer:origin,authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',registration_endpoint:origin+'/register',response_types_supported:['code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],authorization_response_iss_parameter_supported:true});return;}
 if(url.pathname==='/register'){let body='';for await(const chunk of req)body+=chunk;json(201,{client_id:'fixture-client',redirect_uris:JSON.parse(body).redirect_uris});return;}
 if(url.pathname==='/token'){
  let body='';for await(const chunk of req)body+=chunk;const fields=new URLSearchParams(body);tokenSeen++;assert.equal(createHash('sha256').update(fields.get('code_verifier')!).digest('base64url'),authorization!.searchParams.get('code_challenge'));
  if(mutateBeforeToken){const path=join(aDir,'.pi','mcp.json');const raw=JSON.parse(await readFile(path,'utf8'));raw.mcpServers.stale.oauth.scope='changed-after-browser';await writeFile(path,JSON.stringify(raw));}
  json(200,{access_token:'oauth-private-token',refresh_token:'oauth-private-refresh',token_type:'Bearer',expires_in:900});return;
 }
 if(url.pathname==='/slow-mcp'){return;}
 if(['/mcp','/empty-mcp'].includes(url.pathname)&&req.method==='POST'){
  authHeaders.push(String(req.headers.authorization));let body='';for await(const chunk of req)body+=chunk;const q=JSON.parse(body);if(!('id'in q)){res.writeHead(202);res.end();return;}
  const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:q.method==='tools/list'?{tools:url.pathname==='/empty-mcp'?[]:[{name:'ping',description:'Return success',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'Connection works'}]};json(200,{jsonrpc:'2.0',id:q.id,result});return;
 }
 res.writeHead(404);res.end();
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as any).port}`;
let openMode:'complete'|'hold'='complete';
const openAuthorizationUrl=async(value:string)=>{authorization=new URL(value);assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');if(openMode==='hold')return;const callback=new URL(authorization.searchParams.get('redirect_uri')!);callback.searchParams.set('code','fixture-code');callback.searchParams.set('state',authorization.searchParams.get('state')!);callback.searchParams.set('iss',origin);assert.equal((await fetch(callback)).status,200);};
const withMutation=async<T>(_selection:unknown,action:()=>Promise<T>):Promise<T>=>{fenced++;if(tokenSeen)tokenFenceSeen++;try{return await action();}finally{fenced--;}};
const a=createIncludedMcpSetup({agentDir,cwd:aDir,openAuthorizationUrl,withMutation});const b=createIncludedMcpSetup({agentDir,cwd:bDir,openAuthorizationUrl,withMutation});
const sessions:any[]=[];
const pause=()=>new Promise(r=>setTimeout(r,20));
async function settle(service:typeof a,id:string){for(let n=0;n<300;n++){const state=service.oauthStatus(id);if(state.state!=='running')return state;await pause();}throw Error('OAuth fixture timed out');}
try{
 // Ambient shared files and imported configurations are deliberately ignored.
 await writeFile(join(root,'mcp.json'),JSON.stringify({mcpServers:{ambient:{command:'should-not-run'}}}));
 const definition={url:origin+'/mcp',auth:'bearer' as const,lifecycle:'lazy' as const};
 await a.saveServer({scope:'global',name:'same',definition});await a.saveServer({scope:'project',name:'same',definition});await b.saveServer({scope:'project',name:'same',definition});
 await a.saveBearer({scope:'global',name:'same',token:'global-token'});await a.saveBearer({scope:'project',name:'same',token:'space-a-token'});await b.saveBearer({scope:'project',name:'same',token:'space-b-token'});
 const globalConfig=await loadIncludedMcpConfig({agentDir});const aConfig=await loadIncludedMcpConfig({agentDir,cwd:aDir});const bConfig=await loadIncludedMcpConfig({agentDir,cwd:bDir});
 assert.equal(new Set([globalConfig,aConfig,bConfig].map(c=>(c.mcpServers.same as any).credentialId)).size,3);assert.equal(aConfig.settings?.sampling,false);assert.equal(aConfig.mcpServers.ambient,undefined);
 const status=await a.list({inspectCredentials:true});assert.ok(status.every(s=>s.credential==='present'));assert.doesNotMatch(JSON.stringify(status),/global-token|space-a-token|space-b-token/);
 assert.doesNotMatch(await readFile(join(agentDir,'mcp.json'),'utf8'),/global-token/);assert.doesNotMatch(await readFile(join(aDir,'.pi','mcp.json'),'utf8'),/space-a-token/);
 console.log('PASS global/project/sibling credential names are independent and absent from config/status');
 async function native(cwd:string,config:any){const events=createEventBus();events.on('work-fold:extension-host:v1',(query:any)=>{query.context={version:1,mode:'session',cwd,agentDir,stateRoot:root,getMcpConfig:async()=>config};});const settings=SettingsManager.inMemory();const resourceLoader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,eventBus:events,noContextFiles:true,noSkills:true,noThemes:true,noPromptTemplates:true,additionalExtensionPaths:[resolve('resources/included-tools/mcp/index.ts')]});await resourceLoader.reload();assert.deepEqual(resourceLoader.getExtensions().errors,[]);const authStorage=AuthStorage.inMemory();const {session}=await createAgentSession({cwd,agentDir,authStorage,modelRegistry:ModelRegistry.inMemory(authStorage),resourceLoader,settingsManager:settings,sessionManager:SessionManager.inMemory(),noTools:'builtin'});await session.bindExtensions({mode:'rpc'});sessions.push(session);const tool=session.agent.state.tools.find((t:any)=>t.name==='mcp')!;const result=await tool.execute('connect',{connect:'same'});assert.ok(!result.isError,JSON.stringify(result));}
 await native(aDir,aConfig);await native(bDir,bConfig);assert.ok(authHeaders.includes('Bearer space-a-token'));assert.ok(authHeaders.includes('Bearer space-b-token'));assert.ok(!authHeaders.includes('Bearer global-token'));console.log('PASS actual included wrapper and native HTTP transport use the owning Space token');
 const checked=await a.probe({scope:'project',name:'same'});assert.equal(checked.state,'ready');assert.equal(checked.tools,1);
 await a.saveServer({scope:'project',name:'empty',definition:{url:origin+'/empty-mcp',auth:false}});assert.equal((await a.probe({scope:'project',name:'empty'})).state,'empty');
 await a.saveServer({scope:'project',name:'unreachable',definition:{url:origin+'/missing',auth:false}});assert.equal((await a.probe({scope:'project',name:'unreachable'})).state,'error');
 await a.saveServer({scope:'project',name:'slow',definition:{url:origin+'/slow-mcp',auth:false}});const probeAbort=new AbortController();const pendingProbe=a.probe({scope:'project',name:'slow'},{signal:probeAbort.signal});setTimeout(()=>probeAbort.abort(),50);assert.equal((await pendingProbe).state,'cancelled');
 console.log('PASS native connection checks distinguish ready, empty, failure and cancellation');
 await a.disconnect({scope:'project',name:'same'});assert.equal((await a.list({inspectCredentials:true})).find(s=>s.scope==='project')!.credential,'missing');assert.equal((await b.list({inspectCredentials:true}))[1].credential,'present');
 const oauth={url:origin+'/oauth-mcp',auth:'oauth' as const,oauth:{scope:'mcp:read',redirectUri:'http://127.0.0.1:{port}/callback'}};
 await a.saveServer({scope:'project',name:'oauth',definition:oauth});let job=await a.startOAuth({scope:'project',name:'oauth'});assert.equal((await settle(a,job.id)).state,'connected');assert.ok(tokenFenceSeen>0);assert.equal((await a.list({inspectCredentials:true})).find(s=>s.name==='oauth')!.credential,'present');assert.equal(fenced,0);console.log('PASS real PKCE loopback callback commits native tokens inside the host mutation fence');
 await a.saveServer({scope:'project',name:'stale',definition:oauth});mutateBeforeToken=true;job=await a.startOAuth({scope:'project',name:'stale'});assert.equal((await settle(a,job.id)).state,'failed');assert.equal((await a.list({inspectCredentials:true})).find(s=>s.name==='stale')!.credential,'missing');mutateBeforeToken=false;console.log('PASS changed configuration rejects token persistence after browser authorization');
 await a.saveServer({scope:'project',name:'cancel',definition:oauth});openMode='hold';job=await a.startOAuth({scope:'project',name:'cancel'});for(let n=0;n<100&&!authorization;n++)await pause();await a.cancelOAuth(job.id);assert.equal(a.oauthStatus(job.id).state,'cancelled');assert.equal((await a.list({inspectCredentials:true})).find(s=>s.name==='cancel')!.credential,'missing');console.log('PASS cancelled setup closes its callback and cannot save tokens');
 console.log('ALL MCP SETUP CHECKS PASSED');
}finally{for(const session of sessions){await session.extensionRunner.emit({type:'session_shutdown',reason:'shutdown'});session.dispose();}await a.dispose();await b.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});moduleApi._load=originalLoad;}
