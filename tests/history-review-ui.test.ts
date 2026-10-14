import assert from 'node:assert/strict';
import {createRequire,registerHooks} from 'node:module';
import test from 'node:test';
import {createElement,StrictMode} from 'react';
import {createDomHarness} from './support/dom.js';
const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const assets = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:history-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === "test:history-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
    if (/\.(css|svg)(?:\?|$)/.test(url)) return { format: "module", source: "export default '';", shortCircuit: true };
    return next(url, context);
  },
});

const {HistoryPane}=await import('../web-local/src/components/panes/workFolderPanes.js');
assets.deregister();

test('opening a History restore point completes under the exclusive host read fence', async t=>{
 const dom=await createDomHarness();const original=globalThis.fetch;
 t.after(async()=>{await dom.cleanup();globalThis.fetch=original;});
 let active=false;let overlaps=0;const requests:string[]=[];
 globalThis.fetch=async(input,init)=>{
  assert.equal(init?.method??'GET','GET','inspection must never restore files');
  requests.push(String(input));
  if(active){overlaps++;return Response.json({error:'Wait for the current History or work-folder registration operation to finish.'},{status:409});}
  active=true;
  try{
   await new Promise(r=>setTimeout(r,15));
   return String(input).endsWith('/preview')?Response.json({preview:{checkpointId:'checkpoint-one',scope:'full',restoreFiles:['note.txt'],removePaths:[],moves:[],excludedPaths:[],uncoveredPaths:[],conflicts:[]}}):Response.json({checkpoints:[{checkpointId:'checkpoint-one',label:'After turn',createdAt:'2026-10-08T23:00:00Z',fileCount:1,reason:'post_turn'}]});
  }finally{active=false;}
 };
 await dom.render(createElement(StrictMode,null,createElement(HistoryPane,{workFolder:{id:'disposable',name:'Test folder'} as never,selectedCheckpointId:'checkpoint-one',onError(message){assert.fail(message??'History error');}})));
 await dom.waitFor(()=>dom.container.textContent?.includes('Restore files · 1')===true);
 assert.equal(overlaps,0);
 assert.equal(requests.length,2);
 assert.equal(dom.container.querySelector('[role="alert"]'),null);
 assert.match(dom.container.querySelector('h1')!.textContent!,/After turn/);
 const restore=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Restore these files');
 assert.ok(restore);assert.equal(restore.disabled,false);
});
