import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Document, Packer, Paragraph } from "docx";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
// Native runtime resources are intentionally ordinary JavaScript modules.
import { discoverDocumentEngines, runDocumentEngine } from "../resources/included-tools/documents/engines.mjs";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("installed LibreOffice renders Word and recalculates a new workbook without touching sources", { timeout: 60_000 }, async (t) => {
  const engines = await discoverDocumentEngines();
  if (!engines.libreoffice.available) { t.skip("LibreOffice is not installed; optional engine is reported explicitly."); return; }
  const root = await mkdtemp(join(tmpdir(), "work-fold-office-engine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source.docx"), output = join(root, "rendered.pdf");
  const original = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Engine rendering fixture")] }] }));
  await writeFile(source, original);
  const result = await runDocumentEngine({ operation: "render", source, output, cwd: root, stateRoot: root, timeoutMs: 45_000 });
  assert.equal(result.source.sha256, sha(original));
  assert.equal(result.output.sha256, sha(await readFile(output)));
  assert.equal((await PDFDocument.load(await readFile(output))).getPageCount(), 1);
  assert.deepEqual(await readFile(source), original);
  assert.match(result.engine.version, /LibreOffice/);
  await assert.rejects(runDocumentEngine({ operation: "render", source, output, cwd: root }), /already exists/);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Values");
  sheet.getCell("A1").value = 6; sheet.getCell("B1").value = 7;
  sheet.getCell("C1").value = { formula: "A1*B1", result: -100 };
  const xlsx = join(root, "input.xlsx"); await workbook.xlsx.writeFile(xlsx);
  const originalWorkbook = await readFile(xlsx);
  const calculated = join(root, "calculated.xlsx");
  await runDocumentEngine({ operation: "recalculate", source: xlsx, output: calculated, cwd: root, stateRoot: root, timeoutMs: 45_000 });
  const reopened = new ExcelJS.Workbook(); await reopened.xlsx.readFile(calculated);
  assert.equal((reopened.getWorksheet("Values")!.getCell("C1").value as { result: number }).result, 42);
  assert.deepEqual(await readFile(xlsx), originalWorkbook);
});

test("OCR adapter uses explicit language, fresh output, retained logs and source identity", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-ocr-engine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "synthetic-engine"), source = join(root, "page.png"), output = join(root, "recognized.txt");
  await writeFile(source, "synthetic image");
  await writeFile(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';const a=process.argv.slice(2);if(a[0]==='--version'){console.log('Synthetic Tesseract test adapter');}else{if(a[2]!=='-l'||a[3]!=='eng+deu')throw Error('wrong language');writeFileSync(a[1]+'.txt','Recognized fixture');console.log('completed');}\n`);
  await chmod(executable, 0o700);
  const result = await runDocumentEngine({ operation: "ocr", source, output, enginePath: executable, language: "eng+deu", stateRoot: root, timeoutMs: 300_000 });
  assert.equal(await readFile(output, "utf8"), "Recognized fixture");
  assert.match(await readFile(result.logPath, "utf8"), /completed/);
  assert.equal(result.source.sha256, sha(await readFile(source)));
  await assert.rejects(runDocumentEngine({ operation: "ocr", source, output, enginePath: executable }), /already exists/);
});

test("Stop terminates an owned engine and preserves its log without publishing partial output", { skip: process.platform === "win32", timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-engine-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "slow-engine"), marker = join(root, "started"), source = join(root, "page.png"), output = join(root, "text.txt");
  await writeFile(source, "fixture");
  await writeFile(executable, `#!${process.execPath}\nimport{writeFileSync,writeSync}from'node:fs';if(process.argv.includes('--version'))console.log('Synthetic');else{writeSync(1,'started\\n');writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);}\n`);
  await chmod(executable, 0o700);
  const controller = new AbortController();
  const running = runDocumentEngine({ operation: "ocr", source, output, enginePath: executable, signal: controller.signal, stateRoot: root });
  const rejected = assert.rejects(running, /stopped.*Retained engine log/s);
  let pid = 0;
  for (let attempt = 0; attempt < 300 && !pid; attempt++) {
    pid = Number(await readFile(marker, "utf8").catch(() => "0"));
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pid);
  controller.abort(); await rejected;
  assert.throws(() => process.kill(pid, 0));
  await assert.rejects(readFile(output), { code: "ENOENT" });
  const runs = await readdir(join(root, "document-artifacts"));
  assert.equal(runs.length, 1);
  assert.match(await readFile(join(root, "document-artifacts", runs[0]!, "engine.log"), "utf8"), /started/);
  await assert.rejects(readFile(join(root, "document-artifacts", runs[0]!, "scratch", "source.png")), { code: "ENOENT" });
});

test("Stop kills a descendant that ignores TERM after its engine parent exits", { skip: process.platform === "win32", timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-engine-descendant-stop-"));
  let parentPid = 0, descendantPid = 0;
  t.after(async () => {
    for (const pid of [parentPid, descendantPid]) if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await rm(root, { recursive: true, force: true });
  });
  const executable = join(root, "engine"), parentMarker = join(root, "parent"), childMarker = join(root, "child");
  const source = join(root, "page.png"), output = join(root, "text.txt");
  const childCode = `const{writeFileSync}=require('node:fs');process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(childMarker)},String(process.pid));setInterval(()=>{},1000);`;
  await writeFile(source, "fixture");
  await writeFile(executable, `#!${process.execPath}\nimport{spawn}from'node:child_process';import{writeFileSync}from'node:fs';if(process.argv.includes('--version'))console.log('Synthetic');else{writeFileSync(${JSON.stringify(parentMarker)},String(process.pid));spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});console.log('spawned descendant');setInterval(()=>{},1000);}\n`);
  await chmod(executable, 0o700);
  const controller = new AbortController();
  const running = runDocumentEngine({ operation: "ocr", source, output, enginePath: executable, signal: controller.signal, stateRoot: root });
  const rejected = assert.rejects(running, /stopped.*Retained engine log/s);
  for (let attempt = 0; attempt < 300 && !descendantPid; attempt++) {
    parentPid = Number(await readFile(parentMarker, "utf8").catch(() => "0"));
    descendantPid = Number(await readFile(childMarker, "utf8").catch(() => "0"));
    if (!descendantPid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(parentPid);
  assert.ok(descendantPid);
  controller.abort(); await rejected;
  assert.throws(() => process.kill(parentPid, 0));
  // Group SIGKILL delivery and OS reaping can finish just after the parent closes.
  let descendantAlive = true;
  for (let attempt = 0; attempt < 100 && descendantAlive; attempt++) {
    try { process.kill(descendantPid, 0); } catch { descendantAlive = false; }
    if (descendantAlive) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(descendantAlive, false, "an owned descendant must not outlive Stop");
  await assert.rejects(readFile(output), { code: "ENOENT" });
});

test("Stop during output publication reports interruption and retains the created file and log", { skip: process.platform === "win32", timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-engine-publish-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "engine"), source = join(root, "page.png"), output = join(root, "text.txt");
  const outputBytes = 128 * 1024 * 1024;
  await writeFile(source, "fixture");
  // A sparse output keeps the fixture cheap without materializing a large
  // string or Buffer; the real asynchronous publish/hash path still runs.
  await writeFile(executable, `#!${process.execPath}\nimport{openSync,ftruncateSync,closeSync,writeSync}from'node:fs';if(process.argv.includes('--version'))console.log('Synthetic');else{const fd=openSync(process.argv[3]+'.txt','w');ftruncateSync(fd,${outputBytes});closeSync(fd);writeSync(1,'output ready\\n');}\n`);
  await chmod(executable, 0o700);
  const controller = new AbortController();
  const watcher = watch(root, (_event, path) => { if (path === "text.txt") controller.abort(); });
  t.after(() => watcher.close());
  await assert.rejects(runDocumentEngine({ operation: "ocr", source, output, enginePath: executable, signal: controller.signal, stateRoot: root }), /stopped.*Retained engine log.*Output path to inspect/s);
  assert.equal(controller.signal.aborted, true);
  assert.equal((await stat(output)).size, outputBytes, "completed file effects remain available for inspection");
  assert.equal(await readFile(source, "utf8"), "fixture");
  const runs = await readdir(join(root, "document-artifacts"));
  assert.equal(runs.length, 1);
  assert.match(await readFile(join(root, "document-artifacts", runs[0]!, "engine.log"), "utf8"), /output ready/);
  await assert.rejects(stat(join(root, "document-artifacts", runs[0]!, "scratch")), { code: "ENOENT" });
});
