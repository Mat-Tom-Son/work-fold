import assert from 'node:assert/strict';
import { searchWithDuckDuckGo } from 'pi-web-access/duckduckgo.ts';
const original=globalThis.fetch;
try{
 globalThis.fetch=async()=>new Response('<html>Please complete the challenge.</html>',{status:200});
 await assert.rejects(searchWithDuckDuckGo('fixture'),/no parseable results/);
 console.log('PASS challenge is an error, not an empty successful search');
 globalThis.fetch=async()=>new Response('rate limit',{status:429});
 await assert.rejects(searchWithDuckDuckGo('fixture'),/429/);
 console.log('PASS rate limit is explicit');
 let cancelled=false;
 globalThis.fetch=async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(6*1024*1024));},cancel(){cancelled=true;}}));
 await assert.rejects(searchWithDuckDuckGo('fixture'),/5 MiB/);assert.equal(cancelled,true);
 console.log('PASS oversized body stops streaming at the shared download ceiling');
 globalThis.fetch=async(_url,init)=>new Promise((_r,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
 const controller=new AbortController();const pending=searchWithDuckDuckGo('fixture',{signal:controller.signal});controller.abort();await assert.rejects(pending,/Aborted/);
 console.log('PASS cancellation interrupts a pending search');
}finally{globalThis.fetch=original;}
