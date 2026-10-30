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
 await dom.waitFor(()=>dom.container.textContent?.includes('1 file changed since then')===true);
 assert.equal(overlaps,0);
 assert.equal(requests.length,2);
 assert.equal(dom.container.querySelector('[role="alert"]'),null);
 assert.match(dom.container.querySelector('h1')!.textContent!,/After a Worker reply/,'saved "turn" labels read in plain words');
 const restore=dom.container.querySelector<HTMLButtonElement>('.history-review-header .ui-control--primary');
 assert.equal(restore?.textContent,'Restore','the one action sits at the top');assert.equal(restore!.disabled,false);
});

test('a restore point lists only what changed since then, in plain words, with Compare under its file', async t=>{
 const dom=await createDomHarness();const original=globalThis.fetch;
 t.after(async()=>{await dom.cleanup();globalThis.fetch=original;});
 const diffs:string[]=[];
 globalThis.fetch=async(input)=>{
  const url=String(input);
  if(url.includes('/history/diff?')){diffs.push(new URL(url,'http://localhost').searchParams.get('path')!);return Response.json({error:'not needed'},{status:404});}
  return url.endsWith('/preview')?Response.json({preview:{checkpointId:'checkpoint-two',scope:'full',
   restoreFiles:['Stories/Hiccup.md'],removePaths:['Archive/Old map.md'],moves:[{fromPath:'Drafts/notes.md',toPath:'Notes/notes.md'}],
   excludedPaths:['.pi','.work-fold','Video/walk.mov'],uncoveredPaths:['.pi','.work-fold/state.json'],conflicts:[]}})
   :Response.json({checkpoints:[{checkpointId:'checkpoint-two',label:'Manual Restore Point',createdAt:'2026-10-27T21:15:00Z',fileCount:115,reason:'manual'}]});
 };
 await dom.render(createElement(HistoryPane,{workFolder:{id:'disposable',name:'Test folder'} as never,selectedCheckpointId:'checkpoint-two',onError(message){assert.fail(message??'History error');}}));
 await dom.waitFor(()=>dom.container.textContent?.includes('3 files changed since then')===true);
 assert.match(dom.container.querySelector('h1')!.textContent!,/Saved by you/);
 const rows=[...dom.container.querySelectorAll('.history-change-row')].map(row=>`${row.querySelector('strong')!.textContent} ${row.querySelector('.history-change-kind')!.textContent}`);
 assert.deepEqual(rows,['Hiccup.md Changed','Old map.md Added','notes.md Moved']);
 assert.doesNotMatch(dom.container.textContent!,/Restored|captured|\.work-fold|\.pi\b/,'no past-tense label, jargon, or folders History never covers');
 assert.equal(dom.container.querySelector('.history-review-note')!.textContent,'Restoring leaves these alone: Video/walk.mov');
 assert.equal(dom.container.querySelector('input'),null,'no free-text file box');
 const compare=dom.container.querySelector<HTMLButtonElement>('.history-change-row button')!;
 await dom.act(async()=>{compare.click();});
 await dom.waitFor(()=>diffs.length===1);
 assert.deepEqual(diffs,['Stories/Hiccup.md']);
 assert.ok(compare.closest('li')!.querySelector('.history-file-comparison'),'the comparison opens under its own file');
 assert.equal(compare.textContent,'Hide');
});
