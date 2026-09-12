import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  return { cwd, script };
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
  assert.deepEqual(tools, ["document_run"]);
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

test("output is bounded and omissions are explicit", async (t) => {
  const setup = await fixture(t, "export default ()=>{console.log('x'.repeat(100000));return 'y'.repeat(100000)};");
  const result = await runDocumentScript(setup);
  assert.equal(result.valueTruncated, true); assert.equal(result.logsTruncated, true);
  assert.equal(Buffer.byteLength(result.value), 65536); assert.equal(Buffer.byteLength(result.logs), 65536);
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
  assert.deepEqual((await readdir(setup.cwd)).sort(), ["script.mjs", "test.pdf"]);
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
  const failed = assert.rejects(tool.execute("run-1", { script: setup.script }, undefined, undefined, { cwd: setup.cwd }), /stopped/);
  t.after(shutdown);
  for (let attempt = 0; attempt < 800; attempt++) {
    try { await access(join(setup.cwd, "render-ready")); break; } catch { await delay(25); }
  }
  await shutdown();
  assert.deepEqual(await readdir(join(stateRoot, "document-runs")), []);
  const path = await readFile(join(setup.cwd, "render-ready"), "utf8");
  await assert.rejects(access(path), { code: "ENOENT" });
  await failed;
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

test("PowerPoint image parser rejects vulnerable optional types while PNG and JPEG work", async (t) => {
  const setup = await fixture(t, `import{createRequire}from'node:module';const require=createRequire(import.meta.url);export default({libraries})=>{
    const parser=require('image-size');const malformed=[Buffer.from('icns0000'),Buffer.from([0,0,0,12,74,88,76,32,13,10,135,10,0,0,0,12,102,116,121,112,106,120,108,32]),Buffer.from([0,0,0,0,102,116,121,112,104,101,105,99,0,0,0,0])];
    const errors=malformed.map(bytes=>{try{return parser(bytes)}catch(e){return e.message}});
    const surface=libraries.canvas.createCanvas(15,20);return{errors,png:parser(surface.toBuffer('image/png')),jpeg:parser(surface.toBuffer('image/jpeg'))};};`);
  const result = JSON.parse((await runDocumentScript(setup)).value);
  assert.deepEqual(result.errors, ["disabled file type: icns", "disabled file type: jxl", "disabled file type: heif"]);
  assert.equal(result.png.width, 15); assert.equal(result.jpeg.height, 20);
});
