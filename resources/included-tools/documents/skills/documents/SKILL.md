---
name: document-work
description: Create and inspect Word documents, Excel workbooks, PowerPoint decks, and PDFs using the bundled document_run JavaScript runtime. Render selected PDF pages as images to check layout. Use normal files and the person's existing document apps.
---

# Document work

Use `document_run` for document scripts without relying on a separate Node or Python installation. Write an ordinary `.mjs` file, then pass its path to the tool. Standard JavaScript imports and relative helper modules work. Project dependencies resolve normally, with bundled packages available as a fallback. A script's default async function receives the context below. `.cjs` files may use `module.exports = async (context) => { ... }`.

The runtime is full trust, like Pi's shell. Its separate worker makes Stop effective for synchronous loops; it does not sandbox code or undo work. Do not automatically rerun a stopped or failed script: inspect files and external effects first. Avoid starting child processes or daemons; Stop terminates the worker, not independent processes it creates.

## Libraries and paths

The provided `libraries` contains `docx` (Word creation), `ExcelJS` (spreadsheet reading/writing), `PptxGenJS` (PowerPoint creation), `pdfLib` (PDF creation/modification), `pdfjs` (PDF reading/rendering), `canvas` (PNG/image rendering), and `JSZip` (Office archive inspection). These are the ordinary upstream libraries. Use their published APIs; do not construct document formats by hand. ICNS, JXL and HEIF image-size detection is disabled in the PowerPoint library because its archived readers have known malformed-input loops; use PNG or JPEG images.

Use `resolve("relative/file")` for every input/output path that belongs in the current Chat's folder. `cwd` is that folder; `process.cwd()` remains the desktop process's directory. `args` is the string array supplied to the tool. Creating a file does not automatically attach it or send it to a model.

```js
import { writeFile } from "node:fs/promises";
export default async ({ libraries, resolve }) => {
  const { Document, Packer, Paragraph, HeadingLevel } = libraries.docx;
  const document = new Document({ sections: [{ children: [
    new Paragraph({ text: "Project brief", heading: HeadingLevel.TITLE }),
    new Paragraph("The agreed scope and next steps."),
  ] }] });
  const output = resolve("project-brief.docx");
  await writeFile(output, await Packer.toBuffer(document));
  return { output };
};
```

For Excel, construct `new libraries.ExcelJS.Workbook()`, `addWorksheet()`, set cells with values or `{formula, result}`, and `await workbook.xlsx.writeFile(resolve("budget.xlsx"))`. In ExcelJS, formula strings omit the leading `=` used in the spreadsheet UI: use `{formula:"B2*2", result:84}`. Reopen with `xlsx.readFile()` to verify sheets, cell types, values, formulas and formatting. ExcelJS preserves formulas but does not calculate them; verify cached results separately and never claim recalculation took place. A zero cached result is valid: do not test its existence with a truthiness check. `workbook.calcProperties.fullCalcOnLoad = true` asks compatible spreadsheet apps to recalculate on opening; it does not run a calculation here.

For PowerPoint, construct `new libraries.PptxGenJS()`, set `layout`, use `addSlide()`, then `addText`, `addImage`, `addChart`, or `addTable` and `await deck.writeFile({fileName:resolve("deck.pptx")})`. Use real editable objects. Inspect the resulting ZIP with JSZip to verify expected slide count, text, media and relationships.

For PDF, use `libraries.pdfLib.PDFDocument.create()` or `.load(bytes)`, embed fonts/images and save. Word and PowerPoint creation does not imply visual rendering support: the bundled libraries do not render DOCX/PPTX to PDF. Open them in the person's existing compatible app for visual inspection or export when available. Do not claim a file was visually checked based only on ZIP structure.

## Read, render, inspect

`readPdf(path, {pages?, password?})` returns source path and SHA-256, total and omitted page counts, renderer version, and per-page text with truncation flags. Page numbers are one-based. Text extraction is not OCR; scanned PDFs require visual reading or an explicitly chosen OCR tool.

`renderPdf(path, {pages?, scale?, outputDir?})` renders using PDF.js and the bundled native canvas. It returns the same source provenance plus each PNG's path, digest, page, scale and dimensions. Source bytes are captured once for that operation. By default, PNGs are temporary review images in machine-local storage, removed when this tool call finishes or stops. Call `emitImage` within the same script to inspect them; its captured image bytes and provenance remain in the conversation. Temporary review paths are not deliverables and should not be linked to the person. Supply an explicit `outputDir` only when persistent PNG files are wanted. Their filenames include the page, source digest and scale; use a fresh directory when repeating an identical persistent render. The renderer refuses to overwrite existing files.

```js
export default async ({ readPdf, renderPdf, emitImage }) => {
  const text = await readPdf("report.pdf", {pages:[1, 2]});
  const rendered = await renderPdf("report.pdf", {pages:[1, 2]});
  for (const page of rendered.pages) await emitImage(page.path);
  return {text, rendered};
};
```

`emitImage(path)` deliberately places a PNG in the tool result for the model to inspect. Generic PNGs include their path, digest and dimensions. PDF renders additionally carry the source digest, page and renderer details; changing a render before emission rejects that provenance. Inspect the returned images for overflow, clipping, alignment, type size, readable charts and missing content. Revise the source and rerender as needed.

Each helper call admits up to 8 PDF pages from a source up to 64 MiB. Omitted pages are explicit. Rendering is limited to 4 million pixels per page and scale at most 4. One tool result admits up to 4 PNGs, each at most 2 MiB, 8 MiB combined. Return text and logs each have a 64 KiB cap and explicit truncation. Scripts default to 60 seconds, with a maximum 120 seconds. Split longer documents into deliberate batches. These limits bound the helper results; ordinary library use remains available inside the full-trust script.
