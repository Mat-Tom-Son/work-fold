import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { loadConversationContextAttachmentsForTurn, previewConversationContextAttachment, readableAttachmentText } from "../src/local/conversation-context.js";

const PptxGenJS = createRequire(import.meta.url)("pptxgenjs");
const relationshipsNamespace = "http://schemas.openxmlformats.org/package/2006/relationships";
const documentRelationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const presentationNamespace = "http://schemas.openxmlformats.org/presentationml/2006/main";
const drawingNamespace = "http://schemas.openxmlformats.org/drawingml/2006/main";
const spreadsheetNamespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

type OfficeKind = "pptx" | "xlsx";

function relationships(entries: Array<{ id: string; target: string; type: string; mode?: string }>): string {
  return `<Relationships xmlns="${relationshipsNamespace}">${entries.map((entry) => `<Relationship Id="${entry.id}" Target="${entry.target}" Type="${documentRelationships}/${entry.type}"${entry.mode ? ` TargetMode="${entry.mode}"` : ""}/>`).join("")}</Relationships>`;
}

function officeFixture(kind: OfficeKind, count = 2): JSZip {
  const archive = new JSZip();
  const presentation = kind === "pptx";
  const main = presentation ? "ppt/presentation.xml" : "xl/workbook.xml";
  archive.file("_rels/.rels", relationships([{ id: "document", target: main, type: "officeDocument" }]));
  const references = Array.from({ length: count }, (_, index) => index + 1);
  archive.file(main, presentation
    ? `<p:presentation xmlns:p="${presentationNamespace}" xmlns:r="${documentRelationships}"><p:sldIdLst>${references.map((i) => `<p:sldId id="${255 + i}" r:id="part${i}"/>`).join("")}</p:sldIdLst></p:presentation>`
    : `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${documentRelationships}"><sheets>${references.map((i) => `<sheet name="Tab ${i}" sheetId="${i}" r:id="part${i}"/>`).join("")}</sheets></workbook>`);
  archive.file(presentation ? "ppt/_rels/presentation.xml.rels" : "xl/_rels/workbook.xml.rels", relationships(references.map((i) => ({
    id: `part${i}`, target: presentation ? `slides/slide${i}.xml` : `worksheets/sheet${i}.xml`, type: presentation ? "slide" : "worksheet",
  }))));
  for (const i of references) {
    archive.file(presentation ? `ppt/slides/slide${i}.xml` : `xl/worksheets/sheet${i}.xml`, presentation
      ? `<p:sld xmlns:p="${presentationNamespace}" xmlns:a="${drawingNamespace}"><p:cSld><p:spTree><a:p><a:r><a:t>MARKER_${i}_END</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`
      : `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>MARKER_${i}_END</t></is></c></row></sheetData></worksheet>`);
  }
  return archive;
}

async function attachment(t: TestContext, kind: OfficeKind, archive: JSZip) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-office-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = `attachment.${kind}`;
  await writeFile(join(root, path), await archive.generateAsync({ type: "nodebuffer" }));
  const [loaded] = await loadConversationContextAttachmentsForTurn(root, [path]);
  assert.ok(loaded);
  const preview = await previewConversationContextAttachment(root, { path });
  assert.equal(preview.mode, loaded.mode);
  assert.equal(preview.reason, loaded.reason);
  return loaded;
}

test("PowerPoint attachment text follows presentation relationship order, excluding orphan slides", async (t) => {
  const deck = new PptxGenJS();
  deck.addSlide().addText("FIRST_CREATED_SLIDE");
  deck.addSlide().addText("SECOND_CREATED_SLIDE");
  const archive = await JSZip.loadAsync(await deck.write({ outputType: "nodebuffer" }));
  const manifest = await archive.file("ppt/presentation.xml")!.async("string");
  const list = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(manifest)!;
  const ids = list[1]!.match(/<p:sldId\b[^>]*\/>/g)!;
  archive.file("ppt/presentation.xml", manifest.replace(list[0], `<p:sldIdLst>${ids.reverse().join("")}</p:sldIdLst>`));
  archive.file("ppt/slides/slide3.xml", `<p:sld xmlns:p="${presentationNamespace}" xmlns:a="${drawingNamespace}"><a:p><a:t>ORPHAN_SLIDE</a:t></a:p></p:sld>`);
  const loaded = await attachment(t, "pptx", archive);
  assert.equal(loaded.mode, "full_extracted_text");
  assert.equal(loaded.includedInPrompt, true);
  assert.match(loaded.text!, /Slide 1\s+SECOND_CREATED_SLIDE\s+Slide 2\s+FIRST_CREATED_SLIDE/);
  assert.doesNotMatch(loaded.text!, /ORPHAN_SLIDE/);
});

test("Excel attachment text follows named workbook sheets and shared-string relationships", async (t) => {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet("First & Original");
  first.getCell("A1").value = "FIRST_CREATED_SHEET";
  first.getCell("B1").value = { formula: "6*7", result: 42 };
  workbook.addWorksheet("Second").getCell("A1").value = "SECOND_CREATED_SHEET";
  const archive = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  const manifest = await archive.file("xl/workbook.xml")!.async("string");
  const list = /<sheets>([\s\S]*?)<\/sheets>/.exec(manifest)!;
  const ids = list[1]!.match(/<sheet\b[^>]*\/>/g)!;
  archive.file("xl/workbook.xml", manifest.replace(list[0], `<sheets>${ids.reverse().join("")}</sheets>`));
  archive.file("xl/text/values.xml", await archive.file("xl/sharedStrings.xml")!.async("string"));
  archive.remove("xl/sharedStrings.xml");
  const rels = await archive.file("xl/_rels/workbook.xml.rels")!.async("string");
  archive.file("xl/_rels/workbook.xml.rels", rels.replace('Target="sharedStrings.xml"', 'Target="text/values.xml"'));
  archive.file("xl/worksheets/sheet3.xml", `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row><c t="inlineStr"><is><t>ORPHAN_SHEET</t></is></c></row></sheetData></worksheet>`);
  const loaded = await attachment(t, "xlsx", archive);
  assert.equal(loaded.mode, "full_extracted_text");
  assert.equal(loaded.includedInPrompt, true);
  assert.match(loaded.text!, /Worksheet 1: Second\s+SECOND_CREATED_SHEET\s+Worksheet 2: First & Original\s+FIRST_CREATED_SHEET\t42/);
  assert.doesNotMatch(loaded.text!, /ORPHAN_SHEET/);
});

for (const kind of ["pptx", "xlsx"] as const) {
  test(`${kind}: 500 referenced parts attach completely, but 501 never silently truncate`, async (t) => {
    const withinLimit = await attachment(t, kind, officeFixture(kind, 500));
    assert.equal(withinLimit.mode, "full_extracted_text");
    assert.match(withinLimit.text!, /MARKER_500_END/);
    assert.ok(withinLimit.estimatedTokens < withinLimit.budgetTokens);
    const overLimit = await attachment(t, kind, officeFixture(kind, 501));
    assert.equal(overLimit.mode, "path_only_reference");
    assert.equal(overLimit.includedInPrompt, false);
    assert.equal(overLimit.text, null);
    assert.match(overLimit.reason!, /500 (slides|worksheets) extraction limit/);
    assert.match(overLimit.detail, /complete text cannot be attached/);
  });

  const main = kind === "pptx" ? "ppt/presentation.xml" : "xl/workbook.xml";
  const part = kind === "pptx" ? "ppt/slides/slide2.xml" : "xl/worksheets/sheet2.xml";
  const rels = kind === "pptx" ? "ppt/_rels/presentation.xml.rels" : "xl/_rels/workbook.xml.rels";
  const partType = kind === "pptx" ? "slide" : "worksheet";
  for (const scenario of [
    { name: "missing document manifest", change: async (archive: JSZip) => { archive.remove(main); }, reason: /missing required part/ },
    { name: "missing referenced part", change: async (archive: JSZip) => { archive.remove(part); }, reason: /missing required part/ },
    { name: "malformed referenced part", change: async (archive: JSZip) => { archive.file(part, (await archive.file(part)!.async("string")).slice(0, -4)); }, reason: /malformed XML/ },
    { name: "malformed manifest", change: async (archive: JSZip) => { archive.file(main, (await archive.file(main)!.async("string")).slice(0, -4)); }, reason: /malformed XML/ },
    { name: "malformed relationship XML", change: async (archive: JSZip) => { archive.file(rels, (await archive.file(rels)!.async("string")).slice(0, -4)); }, reason: /malformed XML/ },
    { name: "missing relationship", change: async (archive: JSZip) => { archive.file(rels, (await archive.file(rels)!.async("string")).replace('Id="part2"', 'Id="unrelated"')); }, reason: /references missing/ },
    { name: "duplicate relationship", change: async (archive: JSZip) => { archive.file(rels, (await archive.file(rels)!.async("string")).replace('Id="part2"', 'Id="part1"')); }, reason: /duplicate relationship/ },
    { name: "external relationship", change: async (archive: JSZip) => { archive.file(rels, (await archive.file(rels)!.async("string")).replace('Id="part2"', 'Id="part2" TargetMode="External"')); }, reason: /unsupported.*relationship/ },
    { name: "unsupported part type", change: async (archive: JSZip) => { archive.file(rels, (await archive.file(rels)!.async("string")).replaceAll(`/${partType}"`, '/chartsheet"')); }, reason: /unsupported.*relationship/ },
    { name: "target outside the package", change: async (archive: JSZip) => { archive.file(rels, (await archive.file(rels)!.async("string")).replace(/Target="[^"]+"/, 'Target="../../outside.xml"')); }, reason: /outside the package/ },
    { name: "unrecognized manifest entry", change: async (archive: JSZip) => { archive.file(main, (await archive.file(main)!.async("string")).replace('r:id="part2"', 'xmlns="urn:unsupported" xmlns:p="urn:unsupported" r:id="part2"')); }, reason: /unsupported entry/ },
  ]) {
    test(`${kind}: ${scenario.name} produces a useful path-only reference without partial text`, async (t) => {
      const archive = officeFixture(kind);
      await scenario.change(archive);
      const loaded = await attachment(t, kind, archive);
      assert.equal(loaded.mode, "path_only_reference");
      assert.equal(loaded.includedInPrompt, false);
      assert.equal(loaded.text, null);
      assert.match(loaded.reason!, scenario.reason);
    });
  }
}

test("Office package root and part relationships resolve relocated and encoded part names", async () => {
  const archive = officeFixture("pptx", 1);
  archive.file("_rels/.rels", relationships([{ id: "document", target: "/custom/main.xml", type: "officeDocument" }]));
  archive.file("custom/main.xml", await archive.file("ppt/presentation.xml")!.async("string"));
  archive.file("custom/_rels/main.xml.rels", relationships([{ id: "part1", target: "../slides/first%20slide.xml", type: "slide" }]));
  archive.file("slides/first slide.xml", await archive.file("ppt/slides/slide1.xml")!.async("string"));
  archive.remove("ppt");
  const loaded = await readableAttachmentText("relocated.pptx", await archive.generateAsync({ type: "nodebuffer" }));
  assert.equal(loaded.text, "Slide 1\n\nMARKER_1_END");
});

for (const scenario of ["missing part", "malformed part", "missing value"] as const) {
  test(`Excel ${scenario} in shared strings does not substitute numeric references as cell text`, async (t) => {
    const archive = officeFixture("xlsx", 1);
    archive.file("xl/_rels/workbook.xml.rels", relationships([
      { id: "part1", target: "worksheets/sheet1.xml", type: "worksheet" },
      { id: "strings", target: "sharedStrings.xml", type: "sharedStrings" },
    ]));
    archive.file("xl/worksheets/sheet1.xml", `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row><c t="s"><v>1</v></c></row></sheetData></worksheet>`);
    if (scenario !== "missing part") archive.file("xl/sharedStrings.xml", scenario === "malformed part" ? `<sst xmlns="${spreadsheetNamespace}"><si>` : `<sst xmlns="${spreadsheetNamespace}"><si><t>Only index zero</t></si></sst>`);
    const loaded = await attachment(t, "xlsx", archive);
    assert.equal(loaded.mode, "path_only_reference");
    assert.equal(loaded.text, null);
    assert.match(loaded.reason!, /missing required part|malformed XML|missing shared-string value/);
  });
}

test("Office XML uses namespace identity and decodes text once", async () => {
  const archive = officeFixture("pptx", 1);
  archive.file("ppt/slides/slide1.xml", `<s:sld xmlns:s="${presentationNamespace}" xmlns:d="${drawingNamespace}"><d:p><d:r><d:t>&lt;title&gt; &amp;amp; <![CDATA[<verbatim>]]></d:t></d:r></d:p></s:sld>`);
  const loaded = await readableAttachmentText("text.pptx", await archive.generateAsync({ type: "nodebuffer" }));
  assert.equal(loaded.text, "Slide 1\n\n<title> &amp; <verbatim>");
});

test("Office extraction keeps the decompressed per-part safety bound", async (t) => {
  const archive = officeFixture("pptx", 1);
  archive.file("ppt/slides/slide1.xml", " ".repeat(8 * 1024 * 1024 + 1));
  const loaded = await attachment(t, "pptx", archive);
  assert.equal(loaded.mode, "path_only_reference");
  assert.equal(loaded.text, null);
  assert.match(loaded.reason!, /too large to extract safely/);
});

test("Office extraction bounds inflation even when ZIP metadata understates the part size", async () => {
  const archive = officeFixture("pptx", 1);
  const part = "ppt/slides/slide1.xml";
  archive.file(part, " ".repeat(8 * 1024 * 1024 + 1));
  const bytes = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  let patched = false;
  // Alter the central record that JSZip trusts, preserving real compressed data.
  for (let offset = 0; offset <= bytes.length - 46; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = bytes.readUInt16LE(offset + 28);
    if (bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8") !== part) continue;
    bytes.writeUInt32LE(100, offset + 24);
    const localOffset = bytes.readUInt32LE(offset + 42);
    bytes.writeUInt32LE(100, localOffset + 22);
    patched = true;
    break;
  }
  assert.equal(patched, true);
  await assert.rejects(readableAttachmentText("forged.pptx", bytes), /too large to extract safely/);
});

test("shared strings cannot amplify bounded worksheet XML into unbounded attachment text", async () => {
  const archive = officeFixture("xlsx", 1);
  archive.file("xl/_rels/workbook.xml.rels", relationships([
    { id: "part1", target: "worksheets/sheet1.xml", type: "worksheet" },
    { id: "strings", target: "sharedStrings.xml", type: "sharedStrings" },
  ]));
  archive.file("xl/sharedStrings.xml", `<sst xmlns="${spreadsheetNamespace}"><si><t>${"x".repeat(1024 * 1024)}</t></si></sst>`);
  archive.file("xl/worksheets/sheet1.xml", `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row>${'<c t="s"><v>0</v></c>'.repeat(65)}</row></sheetData></worksheet>`);
  await assert.rejects(readableAttachmentText("amplified.xlsx", await archive.generateAsync({ type: "nodebuffer" })), /too much extracted text/);
});

test("invalid XML encoding produces a path-only attachment instead of replacement characters", async (t) => {
  const archive = officeFixture("pptx", 1);
  const source = await archive.file("ppt/slides/slide1.xml")!.async("nodebuffer");
  const marker = source.indexOf("MARKER_1_END");
  source[marker] = 0xff;
  archive.file("ppt/slides/slide1.xml", source);
  const loaded = await attachment(t, "pptx", archive);
  assert.equal(loaded.mode, "path_only_reference");
  assert.equal(loaded.text, null);
  assert.match(loaded.reason!, /not valid UTF-8 XML/);
});

test("valid deflated Office packages retain complete UTF-8 text including a BOM", async () => {
  const archive = officeFixture("pptx", 1);
  archive.file("ppt/slides/slide1.xml", `\ufeff${await archive.file("ppt/slides/slide1.xml")!.async("string")}`);
  const loaded = await readableAttachmentText("compressed.pptx", await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  assert.equal(loaded.text, "Slide 1\n\nMARKER_1_END");
});
