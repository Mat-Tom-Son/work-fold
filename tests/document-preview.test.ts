import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Document, Packer, Paragraph } from "docx";
import JSZip from "jszip";
// Native runtime resources are intentionally ordinary JavaScript modules.
import { registerDocumentEngineTools, runDocumentEngine } from "../resources/included-tools/documents/engines.mjs";
import { discoverDocumentEngines } from "../resources/included-tools/readiness.js";

const PptxGenJS = createRequire(import.meta.url)("pptxgenjs");
const posixOnly = { skip: process.platform === "win32" };

async function deck(path: string, titles: string[]) {
  const presentation = new PptxGenJS();
  for (const title of titles) presentation.addSlide().addText(title, { x: 0.5, y: 0.5, w: 8, h: 1 });
  await presentation.writeFile({ fileName: path });
}
async function slideTitles(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const presentation = await zip.file("ppt/presentation.xml")!.async("string");
  const relations = await zip.file("ppt/_rels/presentation.xml.rels")!.async("string");
  const ids = [...presentation.matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)].map((match) => match[1]);
  return Promise.all(ids.map(async (id) => {
    const target = relations.match(new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`))![1]!;
    return (await zip.file(`ppt/${target}`)!.async("string")).match(/<a:t>([^<]*)<\/a:t>/)![1];
  }));
}

/** A stand-in with qlmanage's command line: it "draws" by copying the file it was given, so tests can see which file that was. */
async function standIn(root: string, behaviour: "copy" | "hang" | "nothing") {
  const path = join(root, `qlmanage-${behaviour}`);
  const draw = behaviour === "copy" ? "copyFileSync(file,join(dir,basename(file)+'.png'));console.log('* '+file+' produced one thumbnail');console.log('Done producing thumbnails');"
    : behaviour === "hang" ? `writeFileSync(${JSON.stringify(join(root, "hung"))},String(process.pid));setInterval(()=>{},1000);` : "console.log('Done producing thumbnails');";
  await writeFile(path, `#!${process.execPath}\nimport{copyFileSync,writeFileSync}from'node:fs';import{basename,join}from'node:path';const a=process.argv.slice(2);if(a[0]==='--version'){console.log('QuickLook framework: v5.0 (synthetic)');}else{if(a[0]!=='-t'||a[1]!=='-s'||a[3]!=='-o')throw Error('unexpected arguments '+a.join(' '));const dir=a[4],file=a[5];${draw}}\n`);
  await chmod(path, 0o700);
  return path;
}
const searchFor = (root: string, quicklook: string) => ({ path: "", home: root, platform: "darwin", candidates: { libreoffice: [], tesseract: [], homebrew: [], quicklook: [quicklook] } });

test("preview draws page 1 of a Word file and any slide of a deck from a private copy", posixOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const search = searchFor(root, await standIn(root, "copy"));
  const report = join(root, "report.docx");
  const original = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Preview fixture")] }] }));
  await writeFile(report, original);
  const page = await runDocumentEngine({ operation: "preview", source: "report.docx", output: ".worker/task/report.png", cwd: root, stateRoot: root, search });
  assert.equal(page.shows, "page 1");
  assert.equal(page.engine.name, "quicklook");
  assert.equal(page.engine.version, "QuickLook framework: v5.0 (synthetic)");
  assert.match(page.note, /Later pages are not shown/);
  assert.deepEqual(await readFile(join(root, ".worker/task/report.png")), original, "Quick Look was given the captured file itself");
  assert.deepEqual(await readFile(report), original);

  const slides = join(root, "deck.pptx");
  await deck(slides, ["One", "Two", "Three", "Four"]);
  const deckBytes = await readFile(slides);
  const third = await runDocumentEngine({ operation: "preview", source: "deck.pptx", output: "slide-3.png", slide: 3, cwd: root, stateRoot: root, search });
  assert.equal(third.shows, "slide 3");
  assert.deepEqual(await slideTitles(await readFile(join(root, "slide-3.png"))), ["Three", "One", "Two", "Four"], "the chosen slide comes first in the private copy");
  assert.deepEqual(await readFile(slides), deckBytes, "the deck itself is never reordered");
  assert.equal(third.source.sizeBytes, deckBytes.length);
  const first = await runDocumentEngine({ operation: "preview", source: "deck.pptx", output: "slide-1.png", cwd: root, stateRoot: root, search });
  assert.equal(first.shows, "slide 1");
  assert.deepEqual(await readFile(join(root, "slide-1.png")), deckBytes);

  await assert.rejects(runDocumentEngine({ operation: "preview", source: "deck.pptx", output: "slide-9.png", slide: 9, cwd: root, stateRoot: root, search }), /The deck has 4 slides; choose a slide from 1 to 4/);
  await assert.rejects(runDocumentEngine({ operation: "preview", source: "report.docx", output: "page-2.png", slide: 2, cwd: root, stateRoot: root, search }), /Word file previews page 1 only/);
  await assert.rejects(runDocumentEngine({ operation: "preview", source: "deck.pptx", output: "slide.pdf", cwd: root, stateRoot: root, search }), /Preview output must be a PNG/);
  await writeFile(join(root, "budget.xlsx"), "workbook");
  await assert.rejects(runDocumentEngine({ operation: "preview", source: "budget.xlsx", output: "sheet.png", cwd: root, stateRoot: root, search }), /Preview accepts a DOCX or PPTX source/);
  await assert.rejects(runDocumentEngine({ operation: "render", source: "deck.pptx", output: "deck.pdf", slide: 2, cwd: root, stateRoot: root, search }), /slide applies only to preview/);
  await assert.rejects(runDocumentEngine({ operation: "preview", source: "report.docx", output: "report.png", cwd: root, stateRoot: root, search: { ...search, platform: "linux", candidates: { ...search.candidates, quicklook: [] } } }), /built into macOS/);
});

test("a file Quick Look cannot draw fails plainly instead of hanging", { ...posixOnly, timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-preview-failure-"));
  let hungPid = 0;
  t.after(async () => { if (hungPid) { try { process.kill(hungPid, "SIGKILL"); } catch {} } await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "damaged.docx"), "not a document");
  const started = Date.now();
  // A full second lets the stand-in start and record its pid even under the
  // load of the complete suite; a busier machine may still stop it first.
  await assert.rejects(runDocumentEngine({ operation: "preview", source: "damaged.docx", output: "damaged.png", timeoutMs: 1_000, cwd: root, stateRoot: root, search: searchFor(root, await standIn(root, "hang")) }),
    /Quick Look couldn't draw this file\. It may be damaged, or a kind Quick Look doesn't know\. It didn't finish within 1 second\.\nRetained engine log/);
  assert.ok(Date.now() - started < 5_000);
  const recorded = await readFile(join(root, "hung"), "utf8").catch(() => null);
  if (recorded !== null) {
    hungPid = Number(recorded);
    assert.throws(() => process.kill(hungPid, 0), "the hung previewer is killed at the deadline");
    hungPid = 0;
  }
  await assert.rejects(runDocumentEngine({ operation: "preview", source: "damaged.docx", output: "nothing.png", cwd: root, stateRoot: root, search: searchFor(root, await standIn(root, "nothing")) }),
    /Quick Look couldn't draw this file\. It may be damaged, or a kind Quick Look doesn't know\.\nRetained engine log/);
  assert.equal(existsSync(join(root, "nothing.png")), false);
});

test("the tool looks for engines where the host's Documents status looks", posixOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-preview-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const quicklook = await standIn(root, "copy");
  const tools = new Map<string, any>();
  registerDocumentEngineTools({ on() {}, registerTool: (tool: any) => tools.set(tool.name, tool) }, { cwd: root, stateRoot: root, documentEngineSearch: searchFor(root, quicklook) });
  const engine = tools.get("document_engine");
  const status = JSON.parse((await engine.execute("status", { input: { operation: "status" } }, undefined, undefined, {})).content[0].text);
  assert.equal(status.libreoffice.available, false, "the host hid LibreOffice, so the tool does too");
  assert.equal(status.quicklook.executable, quicklook);
  assert.deepEqual(status.quicklook.operations, ["preview"]);
  await writeFile(join(root, "report.docx"), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Host search")] }] })));
  const preview = await engine.execute("preview", { input: { operation: "preview", source: "report.docx", output: "report.png" } }, undefined, undefined, { cwd: root });
  assert.equal(preview.details.engine.executable, quicklook);
  assert.match(engine.description, /Quick Look/);
});

test("Quick Look is found only on macOS, at its system path", async () => {
  const linux = await discoverDocumentEngines({ path: "", home: "/nowhere", platform: "linux", candidates: { libreoffice: [], tesseract: [], homebrew: [] } });
  assert.equal(linux.quicklook.available, false);
  assert.match(linux.quicklook.setup!, /built into macOS/);
  if (process.platform === "darwin" && existsSync("/usr/bin/qlmanage")) {
    const mac = await discoverDocumentEngines({ path: "", home: "/nowhere", platform: "darwin", candidates: { libreoffice: [], tesseract: [], homebrew: [] } });
    assert.equal(mac.quicklook.executable, "/usr/bin/qlmanage");
  }
});

test("real Quick Look draws a Word page and a chosen slide as PNG images", { skip: process.platform !== "darwin" || !existsSync("/usr/bin/qlmanage"), timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-quick-look-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "report.docx"), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Quick Look fixture")] }] })));
  await deck(join(root, "deck.pptx"), ["One", "Two", "Three"]);
  const size = async (path: string) => {
    const bytes = await readFile(path);
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  };
  const page = await runDocumentEngine({ operation: "preview", source: "report.docx", output: "page.png", cwd: root, stateRoot: root, timeoutMs: 45_000 });
  const [pageWidth, pageHeight] = await size(page.output.path);
  assert.equal(pageHeight, 2000, "a portrait page is drawn 2000 pixels tall");
  assert.ok(pageWidth! > 1000 && pageWidth! < pageHeight!);
  assert.match(page.engine.version, /QuickLook/);
  const slide = await runDocumentEngine({ operation: "preview", source: "deck.pptx", output: "slide.png", slide: 2, cwd: root, stateRoot: root, timeoutMs: 45_000 });
  const [slideWidth, slideHeight] = await size(slide.output.path);
  assert.equal(slideWidth, 2000, "a wide slide is drawn 2000 pixels wide");
  assert.ok(slideHeight! < slideWidth!);
});
