import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { createJiti } from "jiti";
import { probeIncludedDocuments, runDocumentScript } from "../resources/included-tools/documents/runtime.mjs";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t: { after(fn: () => Promise<void>): void }, source: string, extension = "mjs") {
  const cwd = await mkdtemp(join(tmpdir(), "workfold-documents-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const script = join(cwd, `script.${extension}`);
  await writeFile(script, source);
  return { cwd, script, artifactsDir: join(cwd, "retained") };
}

test("document runtime imports actual bundled libraries and encodes a canvas without files", async () => {
  const result = await probeIncludedDocuments();
  assert.equal(result.state, "ready", result.reason);
  assert.equal(result.versions["docx"], "9.7.1");
  assert.equal(result.versions["pdfjs-dist"], "6.3.289");
});

test("document wrapper loads under ordinary Jiti without Pi compatibility aliases", async () => {
  const jiti = createJiti(import.meta.url);
  const extension = await jiti.import<{ default: (pi: unknown) => void }>("../resources/included-tools/documents/index.ts");
  const tools: string[] = [];
  extension.default({ events: { emit() {} }, on() {}, registerTool(tool: { name: string }) { tools.push(tool.name); } });
  assert.deepEqual(tools, ["document_engine", "document_run"]);
});

test("ordinary project module creates real DOCX/XLSX/PPTX/PDF, reads PDF and returns source-pinned images", async (t) => {
  const setup = await fixture(t, `
import { writeFile } from 'node:fs/promises';
import { Document, Packer, Paragraph } from 'docx';
import { label } from './label.mjs';
export default async ({libraries,resolve,args,readPdf,renderPdf,emitImage}) => {
  await writeFile(resolve('brief.docx'), await Packer.toBuffer(new Document({sections:[{children:[new Paragraph(label)]}]})));
  const workbook = new libraries.ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Budget'); sheet.getCell('A1').value='Budget'; sheet.getCell('B2').value=42;
  sheet.getCell('B3').value={formula:'B2*2',result:84}; await workbook.xlsx.writeFile(resolve('budget.xlsx'));
  const deck = new libraries.PptxGenJS(); const slide=deck.addSlide(); slide.addText(label,{x:1,y:1,w:8,h:1});
  const bitmap = libraries.canvas.createCanvas(20,20); const ctx=bitmap.getContext('2d'); ctx.fillStyle='#008080';ctx.fillRect(0,0,20,20);
  slide.addImage({data:'image/png;base64,'+bitmap.toBuffer('image/png').toString('base64'),x:1,y:2,w:1,h:1});
  await deck.writeFile({fileName:resolve('brief.pptx')});
  const pdf=await libraries.pdfLib.PDFDocument.create(); const page=pdf.addPage([612,792]);
  page.drawText(label,{x:48,y:730,size:24}); page.drawText('Budget: $84',{x:48,y:685,size:14});
  await writeFile(resolve('brief.pdf'),await pdf.save());
  const text=await readPdf('brief.pdf'); const render=await renderPdf('brief.pdf',{outputDir:'review',pages:[1]});
  await emitImage(render.pages[0].path); return {text,render,args};
};`);
  await writeFile(join(setup.cwd, "label.mjs"), "export const label='Launch plan';");
  const result = await runDocumentScript({ ...setup, args: ["roundtrip"] });
  const value = JSON.parse(result.value);
  assert.match(value.text.pages[0].text, /Launch plan/);
  assert.deepEqual(value.args, ["roundtrip"]);
  const docx = await JSZip.loadAsync(await readFile(join(setup.cwd, "brief.docx")));
  assert.match(await docx.file("word/document.xml")!.async("string"), /Launch plan/);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(join(setup.cwd, "budget.xlsx"));
  assert.equal(workbook.getWorksheet("Budget")!.getCell("B2").value, 42);
  assert.deepEqual(workbook.getWorksheet("Budget")!.getCell("B3").value, { formula: "B2*2", result: 84 });
  const pptx = await JSZip.loadAsync(await readFile(join(setup.cwd, "brief.pptx")));
  assert.match(await pptx.file("ppt/slides/slide1.xml")!.async("string"), /Launch plan/);
  assert.equal(pptx.file(/ppt\/media\/image/).length, 1);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mimeType, "image/png");
  assert.equal(result.images[0].provenance.source.sha256, sha256(await readFile(join(setup.cwd, "brief.pdf"))));
  assert.equal(result.images[0].provenance.sha256, sha256(Buffer.from(result.images[0].data, "base64")));
  assert.equal(result.script.sha256, sha256(await readFile(setup.script)));
});

test("ordinary CommonJS require uses bundled fallback and local relative helpers", async (t) => {
  const setup = await fixture(t, "const { PDFDocument } = require('pdf-lib'); const value=require('./local.cjs'); module.exports=async({args})=>({pdf:typeof PDFDocument.create,value,args});", "cjs");
  await writeFile(join(setup.cwd, "local.cjs"), "module.exports=7;");
  const result = await runDocumentScript({ ...setup, args: ["x"] });
  assert.deepEqual(JSON.parse(result.value), { pdf: "function", value: 7, args: ["x"] });
});

test("script imports prefer project packages while host libraries keep their bundled origins", async (t) => {
  const setup = await fixture(t, "import {marker} from 'docx';export default({libraries})=>({marker,bundledDocument:typeof libraries.docx.Document});");
  const local = join(setup.cwd, "node_modules", "docx");
  await mkdir(local, { recursive: true });
  await writeFile(join(local, "package.json"), JSON.stringify({ name: "docx", type: "module", exports: "./index.mjs" }));
  await writeFile(join(local, "index.mjs"), "export const marker='project version';");
  const result = await runDocumentScript(setup);
  assert.deepEqual(JSON.parse(result.value), { marker: "project version", bundledDocument: "function" });
  assert.ok(!result.runtime.libraryOrigins.docx.includes(setup.cwd));
});

test("worker failures preserve bounded code and stack frames without arbitrary error properties", async (t) => {
  const setup = await fixture(t, "export default()=>{const error=new Error('Fixture failed');error.code='ERR_DOCUMENT_FIXTURE';error.secret='MUST_NOT_BE_SERIALIZED';error.stack+='\\nnot a frame: MUST_NOT_BE_SERIALIZED';throw error;};");
  await assert.rejects(runDocumentScript(setup), (error: Error & { code?: string; diagnostic?: unknown }) => {
    assert.equal(error.message, "Fixture failed");
    assert.equal(error.code, "ERR_DOCUMENT_FIXTURE");
    assert.match(error.stack!, /script\.mjs:1:/);
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /MUST_NOT_BE_SERIALIZED/);
    assert.ok(JSON.stringify(error.diagnostic).length < 4200);
    return true;
  });
});

test("native script syntax failures include a bounded source location without external tools", async (t) => {
  const setup = await fixture(t, 'export default async () => {\n  const title = "Keep "Photos" Safe";\n};');
  await assert.rejects(runDocumentScript(setup), (error: Error) => {
    assert.match(error.message, /Unexpected identifier/);
    assert.match(error.message, /script\.mjs:2:\d+/);
    assert.match(error.message, /const title = "Keep "Photos" Safe"/);
    assert.match(error.message, /\n +\^$/);
    assert.ok(error.message.length < 1000);
    return true;
  });
});

test("dependency syntax failures are not misattributed to a valid entry script", async (t) => {
  const setup = await fixture(t, "import './broken.mjs';export default()=>42;");
  await writeFile(join(setup.cwd, "broken.mjs"), "export const = 2;");
  await assert.rejects(runDocumentScript(setup), (error: Error) => {
    assert.doesNotMatch(error.message, /script\.mjs:\d/);
    return true;
  });
});

test("Stop terminates a synchronous script loop; no stopped work is replayed", async (t) => {
  const setup = await fixture(t, "import {writeFileSync} from 'node:fs'; export default ({resolve})=>{writeFileSync(resolve('started'),'yes');while(true){}};");
  const controller = new AbortController();
  const run = runDocumentScript({ ...setup, signal: controller.signal });
  const stopped = assert.rejects(run, /stopped.*Files already written may remain/);
  t.after(async () => controller.abort());
  // Full-suite concurrency may delay initial library imports. Observe the
  // script's own marker instead of depending on a fixed startup sleep.
  for (let attempt = 0; attempt < 800; attempt++) {
    try { await access(join(setup.cwd, "started")); break; }
    catch { await delay(25); }
  }
  controller.abort();
  await stopped;
  assert.equal(await readFile(join(setup.cwd, "started"), "utf8"), "yes");
});

test("timeout terminates a synchronous loop and pre-abort does not execute", async (t) => {
  const setup = await fixture(t, "export default ()=>{while(true){}};");
  await assert.rejects(runDocumentScript({ ...setup, timeoutMs: 1000 }), /exceeded 1000 ms/);
  await assert.rejects(runDocumentScript({ ...setup, signal: AbortSignal.abort() }), /before execution/);
});

test("an allocation loop fails in its worker while a sibling and the host remain usable", { timeout: 30_000 }, async (t) => {
  const runaway = await fixture(t, "export default()=>{const retained=[];while(true)retained.push(new Array(50000).fill(retained.length));};");
  const sibling = await fixture(t, "import{writeFileSync}from'node:fs';export default({resolve})=>{writeFileSync(resolve('completed'),'sibling');return 42;};");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 25);
  try {
    const failed = assert.rejects(runDocumentScript({ ...runaway, timeoutMs: 15_000 }), (error: Error & { code?: string }) => {
      assert.equal(error.code, "ERR_WORKER_OUT_OF_MEMORY");
      assert.match(error.message, /512 MiB JavaScript heap limit/);
      assert.match(error.message, /files already written may remain/);
      return true;
    });
    const completed = await runDocumentScript(sibling);
    await failed;
    assert.equal(completed.value, "42");
    assert.equal(await readFile(join(sibling.cwd, "completed"), "utf8"), "sibling");
    assert.ok(ticks > 0, "the main event loop continued during the failing script");
    assert.equal((await probeIncludedDocuments()).state, "ready", "a fresh worker still operates after the failed run");
  } finally { clearInterval(timer); }
});

test("output is bounded and omissions are explicit", async (t) => {
  const setup = await fixture(t, "export default ()=>{console.log('x'.repeat(100000));return 'y'.repeat(100000)};");
  const result = await runDocumentScript(setup);
  assert.equal(result.valueTruncated, true); assert.equal(result.logsTruncated, true);
  const overflow = JSON.parse(result.value);
  assert.equal(overflow.overflow, true);
  assert.equal(await readFile(overflow.artifact.path, "utf8"), "y".repeat(100000));
  assert.equal(Buffer.byteLength(result.logs), 65536);
  assert.equal(await readFile(result.artifacts.logs, "utf8"), "x".repeat(100000) + "\n");
});

test("changed render cannot retain PDF provenance and collisions do not overwrite", async (t) => {
  const setup = await fixture(t, `import{writeFile}from'node:fs/promises';export default async({libraries,resolve,renderPdf,emitImage})=>{
    const pdf=await libraries.pdfLib.PDFDocument.create();pdf.addPage();await writeFile(resolve('test.pdf'),await pdf.save());
    const render=await renderPdf('test.pdf',{outputDir:'out',pages:[1]});
    let collision='';try{await renderPdf('test.pdf',{outputDir:'out',pages:[1]})}catch(e){collision=e.message}
    const smaller=await renderPdf('test.pdf',{outputDir:'out',pages:[1],scale:0.5});
    await writeFile(render.pages[0].path,libraries.canvas.createCanvas(10,10).toBuffer('image/png'));
    let changed='';try{await emitImage(render.pages[0].path)}catch(e){changed=e.message}return{collision,changed,original:render.pages[0],smaller:smaller.pages[0]};};`);
  const result = JSON.parse((await runDocumentScript(setup)).value);
  assert.match(result.collision, /EEXIST/); assert.match(result.changed, /changed before emission/);
  assert.notEqual(result.original.path, result.smaller.path);
  assert.ok(result.original.width > result.smaller.width);
  assert.equal(result.original.source.sha256, result.smaller.source.sha256);
});

test("default PDF reviews leave no Space PNGs and retain native image bytes after cleanup", async (t) => {
  const setup = await fixture(t, `import{writeFile}from'node:fs/promises';export default async({libraries,resolve,renderPdf,emitImage})=>{
    const pdf=await libraries.pdfLib.PDFDocument.create();pdf.addPage([200,200]);await writeFile(resolve('test.pdf'),await pdf.save());
    const render=await renderPdf('test.pdf');await emitImage(render.pages[0].path);return render;};`);
  const stateRoot = await mkdtemp(join(tmpdir(), "workfold-document-state-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const result = await runDocumentScript({ ...setup, stateRoot });
  const rendered = JSON.parse(result.value);
  assert.equal(rendered.pages[0].temporary, true);
  assert.ok(rendered.pages[0].path.startsWith(stateRoot));
  await assert.rejects(access(rendered.pages[0].path), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(stateRoot, "document-runs")), []);
  assert.deepEqual((await readdir(setup.cwd)).sort(), ["retained", "script.mjs", "test.pdf"]);
  assert.equal(result.images.length, 1);
  assert.equal(sha256(Buffer.from(result.images[0].data, "base64")), rendered.pages[0].sha256);
});

test("Stop removes only host-owned temporary PDF reviews", async (t) => {
  const setup = await fixture(t, `import{writeFile}from'node:fs/promises';export default async({libraries,resolve,renderPdf})=>{
    const pdf=await libraries.pdfLib.PDFDocument.create();pdf.addPage([200,200]);await writeFile(resolve('test.pdf'),await pdf.save());
    const render=await renderPdf('test.pdf');await writeFile(resolve('render-ready'),render.pages[0].path);while(true){};};`);
  const stateRoot = await mkdtemp(join(tmpdir(), "workfold-document-state-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const controller = new AbortController(); t.after(async () => controller.abort());
  const stopped = assert.rejects(runDocumentScript({ ...setup, stateRoot, signal: controller.signal }), /stopped/);
  for (let attempt = 0; attempt < 800; attempt++) {
    try { await access(join(setup.cwd, "render-ready")); break; } catch { await delay(25); }
  }
  controller.abort(); await stopped;
  const image = await readFile(join(setup.cwd, "render-ready"), "utf8");
  await assert.rejects(access(image), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(stateRoot, "document-runs")), []);
  assert.ok((await readFile(join(setup.cwd, "test.pdf"))).length > 100);
});

test("native session shutdown waits for document worker termination and temporary cleanup", async (t) => {
  const setup = await fixture(t, `import{writeFile}from'node:fs/promises';export default async({libraries,resolve,renderPdf})=>{
    const pdf=await libraries.pdfLib.PDFDocument.create();pdf.addPage([200,200]);await writeFile(resolve('test.pdf'),await pdf.save());
    const render=await renderPdf('test.pdf');await writeFile(resolve('render-ready'),render.pages[0].path);while(true){};};`);
  const stateRoot = await mkdtemp(join(tmpdir(), "workfold-document-shutdown-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const extension = await createJiti(import.meta.url).import<{ default: (pi: unknown) => void }>("../resources/included-tools/documents/index.ts");
  let shutdown!: () => Promise<void>;
  let tool!: { execute(id: string, args: { script: string }, signal: undefined, update: undefined, context: { cwd: string }): Promise<unknown> };
  extension.default({
    events: { emit(_name: string, query: Record<string, unknown>) { query.context = { version: 1, mode: "session", cwd: setup.cwd, stateRoot }; } },
    on(name: string, handler: () => Promise<void>) { if (name === "session_shutdown") shutdown = handler; },
    registerTool(value: typeof tool) { tool = value; },
  });
  const failed = tool.execute("run-1", { script: setup.script }, undefined, undefined, { cwd: setup.cwd });
  t.after(shutdown);
  for (let attempt = 0; attempt < 800; attempt++) {
    try { await access(join(setup.cwd, "render-ready")); break; } catch { await delay(25); }
  }
  await shutdown();
  assert.deepEqual(await readdir(join(stateRoot, "document-runs")), []);
  const path = await readFile(join(setup.cwd, "render-ready"), "utf8");
  await assert.rejects(access(path), { code: "ENOENT" });
  const partial = await failed as { content: Array<{ text: string }>; details: { documentRunOutcome: string } };
  assert.equal(partial.details.documentRunOutcome, "stopped");
  assert.match(partial.content[0].text, /stopped/);
  assert.match(partial.content[0].text, /observations.ndjson/);
  await assert.rejects(tool.execute("run-2", { script: setup.script }, undefined, undefined, { cwd: setup.cwd }), /session has closed/);
});

test("oversized PNG headers reject before native image decoding", async (t) => {
  const setup = await fixture(t, `import{writeFile}from'node:fs/promises';export default async({libraries,resolve,emitImage})=>{
    const bytes=libraries.canvas.createCanvas(1,1).toBuffer('image/png');bytes.writeUInt32BE(100000,16);bytes.writeUInt32BE(100000,20);
    await writeFile(resolve('oversized.png'),bytes);await emitImage('oversized.png');};`);
  await assert.rejects(runDocumentScript(setup), /exceeds the pixel limit/);
});

test("worker termination rejection settles the caller deterministically", async (t) => {
  const setup = await fixture(t, "export default()=>42;");
  const original = Worker.prototype.terminate;
  Worker.prototype.terminate = async function () { await original.call(this); throw new Error("simulated termination rejection"); };
  try { await assert.rejects(runDocumentScript(setup), /cleanup failed: simulated termination rejection/); }
  finally { Worker.prototype.terminate = original; }
});

test("PowerPoint image parser rejects malformed headers while PNG and JPEG work", async (t) => {
  const setup = await fixture(t, `import{createRequire}from'node:module';const require=createRequire(import.meta.url);export default({libraries})=>{
    const parser=require('image-size');const malformed=[Buffer.from('icns0000'),Buffer.from([0,0,0,12,74,88,76,32,13,10,135,10,0,0,0,12,102,116,121,112,106,120,108,32]),Buffer.from([0,0,0,0,102,116,121,112,104,101,105,99,0,0,0,0])];
    const errors=malformed.map(bytes=>{try{return parser(bytes)}catch(e){return e.message}});
    const surface=libraries.canvas.createCanvas(15,20);return{errors,png:parser(surface.toBuffer('image/png')),jpeg:parser(surface.toBuffer('image/jpeg'))};};`);
  const result = JSON.parse((await runDocumentScript(setup)).value);
  assert.equal(result.errors.length, 3);
  for (const error of result.errors) { assert.equal(typeof error, "string"); assert.doesNotMatch(error, /disabled file type/); }
  assert.equal(result.png.width, 15); assert.equal(result.jpeg.height, 20);
});

test("explicit twelve-page PDF selection and fifth image succeed through one configured handle", async (t) => {
  const setup = await fixture(t, `import{writeFile}from'node:fs/promises';export default async({libraries,resolve,openPdf,emitImage})=>{
    const pdf=await libraries.pdfLib.PDFDocument.create();for(let n=1;n<=12;n++){const page=pdf.addPage([100,100]);page.drawText('Page '+n,{x:5,y:50,size:10})}
    await writeFile(resolve('many.pdf'),await pdf.save());const handle=await openPdf('many.pdf');
    try {const pages=Array.from({length:12},(_,i)=>i+1);const text=await handle.readText({pages});
      const render=await handle.render({pages,scale:1});const emissions=[];for(const page of render.pages)emissions.push(await emitImage(page.path));
      return{textPages:text.pages.length,renderPages:render.pages.length,complete:render.complete,emissions:emissions.map(e=>e.admitted),source:handle.source};
    }finally{await handle.close()}};`);
  const result = await runDocumentScript(setup);
  const value = JSON.parse(result.value);
  assert.equal(value.textPages, 12); assert.equal(value.renderPages, 12); assert.equal(value.complete, true);
  assert.deepEqual(value.emissions, Array(12).fill(true)); assert.equal(result.images.length, 12);
  assert.ok(result.images.every((image: { provenance: { source: { sha256: string } } }) => image.provenance.source.sha256 === value.source.sha256));
});

test("dense PDF text continues within a page and refuses changed sources", async (t) => {
  const setup = await fixture(t, `import{writeFile}from'node:fs/promises';export default async({libraries,resolve,readPdf,openPdf})=>{
    const pdf=await libraries.pdfLib.PDFDocument.create();const page=pdf.addPage([2000,2000]);
    for(let n=0;n<120;n++)page.drawText(('row-'+n+' café ').repeat(60),{x:1,y:1990-n*10,size:1});
    await writeFile(resolve('dense.pdf'),await pdf.save());
    let cursor,joined='',chunks=[];do{const part=await readPdf('dense.pdf',{maxBytes:4096,continuation:cursor});const item=part.pages[0];chunks.push({offset:item.offset,next:item.nextOffset,bytes:Buffer.byteLength(item.text)});joined+=item.text;cursor=part.continuation}while(cursor);
    const pinned=await readPdf('dense.pdf',{maxBytes:4096});const handle=await openPdf('dense.pdf');
    const replacement=await libraries.pdfLib.PDFDocument.create();replacement.addPage();await writeFile(resolve('dense.pdf'),await replacement.save());
    let changed='';try{await readPdf('dense.pdf',{continuation:pinned.continuation})}catch(e){changed=e.message}
    const sameSnapshot=await handle.readText({continuation:pinned.continuation,maxBytes:4096});await handle.close();
    return{chunks,total:joined.length,hasReplacement:joined.includes('�'),changed,sameSnapshot:sameSnapshot.source.sha256===pinned.source.sha256};};`);
  const value = JSON.parse((await runDocumentScript(setup)).value);
  assert.ok(value.total > 65_536); assert.ok(value.chunks.length > 16);
  assert.equal(value.chunks[0].offset, 0);
  for (let index = 1; index < value.chunks.length; index++) assert.equal(value.chunks[index].offset, value.chunks[index - 1].next);
  assert.equal(value.chunks.at(-1).next, value.total);
  assert.ok(value.chunks.every((chunk: { bytes: number }) => chunk.bytes <= 4096));
  assert.equal(value.hasReplacement, false); assert.equal(value.sameSnapshot, true);
  assert.match(value.changed, /source changed/);
});

test("large serialized results preserve valid JSON and expose complete ordinary artifacts", async (t) => {
  const setup = await fixture(t, "export default()=>({text:'é'.repeat(100000),items:[1,2,3]});");
  const result = await runDocumentScript(setup);
  const overflow = JSON.parse(result.value);
  assert.equal(overflow.originalFormat, "json");
  assert.deepEqual(JSON.parse(await readFile(overflow.artifact.path, "utf8")), { text: "é".repeat(100000), items: [1, 2, 3] });
  assert.equal(overflow.artifact.sha256, sha256(await readFile(overflow.artifact.path)));
  assert.equal(JSON.parse(await readFile(result.artifacts.manifest, "utf8")).outcome, "succeeded");
});

test("image response budget spills selected images without losing prior output or throwing", async (t) => {
  const setup = await fixture(t, `import{writeFile}from'node:fs/promises';import{randomFillSync}from'node:crypto';export default async({libraries,resolve,emitImage})=>{
    const surface=libraries.canvas.createCanvas(512,512);const ctx=surface.getContext('2d');const pixels=ctx.createImageData(512,512);randomFillSync(pixels.data);ctx.putImageData(pixels,0,0);
    await writeFile(resolve('noise.png'),surface.toBuffer('image/png'));const selections=[];for(let i=0;i<12;i++)selections.push(await emitImage('noise.png'));return selections;};`);
  const result = await runDocumentScript(setup);
  const selections = JSON.parse(result.value);
  assert.ok(result.images.length > 4); assert.ok(result.images.length < 12);
  assert.equal(selections.filter((item: { admitted: boolean }) => item.admitted).length, result.images.length);
  const spilled = selections.find((item: { admitted: boolean }) => !item.admitted);
  assert.equal(spilled.reason, "response-image-budget");
  assert.match(spilled.continuation, /do not rerun/);
  assert.equal(spilled.artifact.sha256, sha256(await readFile(spilled.artifact.path)));
  const followup = await fixture(t, `export default async({emitImage,args})=>await emitImage(args[0]);`);
  assert.equal((await runDocumentScript({ ...followup, args: [spilled.artifact.path] })).images.length, 1);
});

test("failed scripts preserve logged evidence, selected images, progress, and committed files exactly once", async (t) => {
  const setup = await fixture(t, `import{appendFile,writeFile}from'node:fs/promises';export default async({libraries,resolve,emitImage,progress})=>{
    await appendFile(resolve('effects'),'once\\n');console.log('Completed the first stage');
    await writeFile(resolve('review.png'),libraries.canvas.createCanvas(10,10).toBuffer('image/png'));await emitImage('review.png');
    await progress({completed:'first stage',file:resolve('effects')});throw Error('Later stage failed');};`);
  const updates: unknown[] = [];
  await assert.rejects(runDocumentScript({ ...setup, onUpdate: (update: unknown) => updates.push(update) }), (error: Error & { partialResult?: any }) => {
    assert.equal(error.partialResult.outcome, "failed");
    assert.equal(error.partialResult.images.length, 1);
    assert.match(error.partialResult.value, /first stage/);
    return true;
  });
  // Inspect the durable manifest independently: error handling must not require
  // replaying the producer just to recover its selected observation.
  const directories = await readdir(setup.artifactsDir);
  assert.equal(directories.length, 1);
  const manifest = JSON.parse(await readFile(join(setup.artifactsDir, directories[0], "run.json"), "utf8"));
  assert.equal(manifest.outcome, "failed"); assert.equal(manifest.images.length, 1);
  assert.equal(JSON.parse(manifest.value).completed, "first stage");
  assert.match(manifest.logs, /Completed the first stage/); assert.match(manifest.failure.message, /Later stage failed/);
  assert.equal(await readFile(join(setup.cwd, "effects"), "utf8"), "once\n");
  assert.ok(updates.length > 0);
});

test("timeout exposes partial observations and long selected deadlines do not overflow Node timers", async (t) => {
  const setup = await fixture(t, `import{writeFile}from'node:fs/promises';export default async({resolve,progress})=>{await writeFile(resolve('effect'),'one');await progress({saved:resolve('effect')});console.log('saved');while(true){}};`);
  await assert.rejects(runDocumentScript({ ...setup, timeoutMs: 2000 }), (error: Error & { partialResult?: any }) => {
    assert.equal(error.partialResult.outcome, "timed_out");
    assert.match(error.partialResult.value, /effect/);
    assert.match(error.partialResult.logs, /saved/);
    assert.equal(error.partialResult.observations[0].kind, "progress");
    return true;
  });
  const quick = await fixture(t, "export default()=>42;");
  assert.equal((await runDocumentScript({ ...quick, timeoutMs: 2_147_483_648 })).value, "42");
  assert.equal((await runDocumentScript({ ...quick, timeoutMs: 120_001 })).value, "42");
  await assert.rejects(runDocumentScript({ ...quick, timeoutMs: Number.MAX_SAFE_INTEGER + 1 }), /positive safe integer/);
});

test("PDF crop inspects small detail and oversized requested scale fits the canvas budget", async (t) => {
  const setup = await fixture(t, `import{writeFile}from'node:fs/promises';export default async({libraries,resolve,openPdf})=>{
    const pdf=await libraries.pdfLib.PDFDocument.create();pdf.addPage([1000,1000]).drawText('small detail',{x:100,y:850,size:5});await writeFile(resolve('page.pdf'),await pdf.save());
    const handle=await openPdf('page.pdf');try{const fit=await handle.render({scale:100});const crop=await handle.render({scale:8,region:{x:95,y:140,width:80,height:20}});return{fit:fit.pages[0],crop:crop.pages[0]}}finally{await handle.close()}};`);
  const value = JSON.parse((await runDocumentScript(setup)).value);
  assert.equal(value.fit.fitted, true); assert.ok(value.fit.width * value.fit.height <= 4_000_000);
  assert.equal(value.crop.scale, 8); assert.equal(value.crop.fitted, false);
  assert.equal(value.crop.width, 640); assert.equal(value.crop.height, 160);
  assert.equal(value.crop.artifact.sha256, sha256(await readFile(value.crop.artifact.path)));
});

test("PDF fitting respects rounded pixel and dimension limits before image emission", async (t) => {
  const setup = await fixture(t, `import{writeFile}from'node:fs/promises';export default async({libraries,resolve,openPdf,emitImage})=>{
    const pdf=await libraries.pdfLib.PDFDocument.create();
    for(const size of [[1683.779527559055,2383.937007874016],[2383.937007874016,1683.779527559055],[40000,200]])pdf.addPage(size).drawText('Rounding boundary',{x:40,y:40,size:12});
    await writeFile(resolve('boundary.pdf'),await pdf.save());const handle=await openPdf('boundary.pdf');
    try{
      const fit=await handle.render();const crop=await handle.render({pages:[1],scale:10,region:{x:0.125,y:0.25,width:1683.5,height:2383.5}});
      const pages=[...fit.pages,...crop.pages];const emissions=[];for(const page of pages)emissions.push(await emitImage(page.path));
      let refusal='';try{await handle.render({pages:[1],fitToBudget:false})}catch(error){refusal=error.message}
      return{pages,emissions,refusal};
    }finally{await handle.close()}};`);
  const result = await runDocumentScript(setup);
  const value = JSON.parse(result.value);
  assert.equal(value.pages.length, 4);
  assert.equal(result.images.length, 4, "every fitted render is accepted by the real image-emission boundary");
  for (const [index, page] of value.pages.entries()) {
    assert.ok(page.width * page.height <= 4_000_000, `render ${index} is within the integer pixel budget`);
    assert.ok(page.width <= 32767 && page.height <= 32767);
    assert.equal(page.fitted, true);
    assert.equal(value.emissions[index].admitted, true);
    const png = await readFile(page.artifact.path);
    assert.equal(png.readUInt32BE(16), page.width);
    assert.equal(png.readUInt32BE(20), page.height);
  }
  assert.match(value.refusal, /exceeds the canvas budget/);
});

test("native document failure keeps evidence content and only its own result gets error status", async (t) => {
  const setup = await fixture(t, "export default async({progress})=>{await progress({completed:1});throw Error('failed after progress')};");
  const extension = await createJiti(import.meta.url).import<{ default: (pi: unknown) => void }>("../resources/included-tools/documents/index.ts");
  let resultHook!: (event: unknown) => unknown;
  let tool: any;
  extension.default({ events: { emit() {} }, on(name: string, handler: typeof resultHook) { if (name === "tool_result") resultHook = handler; }, registerTool(value: unknown) { tool = value; } });
  assert.equal(tool.parameters.properties.timeoutMs.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(tool.parameters.properties.timeoutMs.default, undefined);
  const result = await tool.execute("run", setup, undefined, undefined, { cwd: setup.cwd });
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.outcome, "failed"); assert.equal(JSON.parse(envelope.result).completed, 1);
  assert.match(envelope.failure.message, /failed after progress/);
  assert.deepEqual(resultHook({ toolName: "document_run", details: result.details }), { isError: true });
  assert.equal(resultHook({ toolName: "other", details: result.details }), undefined);
  assert.equal(resultHook({ toolName: "document_run", details: { documentRunOutcome: "succeeded" } }), undefined);
});

test("PDF source capture budget is explicit and can be selected independently of the default", async (t) => {
  const setup = await fixture(t, `import{writeFile}from'node:fs/promises';export default async({libraries,resolve,readPdf,openPdf})=>{
    const pdf=await libraries.pdfLib.PDFDocument.create();pdf.addPage().drawText('Source budget');const bytes=await pdf.save();await writeFile(resolve('source.pdf'),bytes);
    let small='',invalid='';try{await readPdf('source.pdf',{maxSourceBytes:bytes.length-1})}catch(e){small=e.message}
    try{await openPdf('source.pdf',{maxSourceBytes:Infinity})}catch(e){invalid=e.message}
    const admitted=await readPdf('source.pdf',{maxSourceBytes:bytes.length});const larger=await openPdf('source.pdf',{maxSourceBytes:128*1024*1024,expectedSha256:admitted.source.sha256});
    try{return{small,invalid,text:admitted.pages[0].text,same:larger.source.sha256===admitted.source.sha256}}finally{await larger.close()}};`);
  const value = JSON.parse((await runDocumentScript(setup)).value);
  assert.match(value.small, /at most/); assert.match(value.invalid, /positive safe integer/);
  assert.match(value.text, /Source budget/); assert.equal(value.same, true);
});
