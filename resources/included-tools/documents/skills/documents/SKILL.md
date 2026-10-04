---
name: document-work
description: Create and inspect Word documents, Excel workbooks, PowerPoint decks, and PDFs using the bundled document_run JavaScript runtime. Render selected PDF pages as images to check layout. Use normal files and the person's existing document apps.
---

# Document work

Use `document_run` for document scripts without relying on a separate Node or Python installation. Write an ordinary `.mjs` file, then pass its path to the tool. Standard JavaScript imports and relative helper modules work. Project dependencies resolve normally, with bundled packages available as a fallback. A script's default async function receives the context below. `.cjs` files may use `module.exports = async (context) => { ... }`.

The runtime is full trust, like Pi's shell. Its separate worker makes Stop effective for synchronous loops; it does not sandbox code or undo work. Do not automatically rerun a stopped or failed script: inspect files and external effects first. Avoid starting child processes or daemons; Stop terminates the worker, not independent processes it creates.

## Libraries and paths

The provided `libraries` contains `docx` (Word creation), `ExcelJS` (spreadsheet reading/writing), `PptxGenJS` (PowerPoint creation), `pdfLib` (PDF creation/modification), `pdfjs` (PDF reading/rendering), `canvas` (PNG/image rendering), and `JSZip` (Office archive inspection). These are the ordinary upstream libraries. Use their published APIs; do not construct document formats by hand. Prefer PNG or JPEG images for Office compatibility.

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

Page numbers are one-based. `openPdf(path, {password?, expectedSha256?, maxSourceBytes?})` captures and hashes the source once and returns a configured PDF.js handle with `source`, `totalPages`, `readText(options)`, `render(options)`, and `close()`. Reuse it when reading and rendering the same PDF, and close it in `finally`. The runtime closes remaining handles at settlement. This uses bundled fonts, CMaps, WASM and native canvas without an external installation. A handle continues to observe its captured bytes if the original file changes; reopening observes the new file.

`readPdf(path, options)` and `renderPdf(path, options)` are convenience wrappers that open and close a handle for one operation. `options.pages` selects any distinct page numbers explicitly; there is no eight-page limit. With no page selection, the helpers start at page 1 and proceed through the document within their response budgets. Every result identifies the source SHA-256, total pages, selected pages, omitted pages, and renderer. Check `complete` and `continuation`; never infer that a bounded response covered the whole PDF.

`readText({pages?, maxBytes?, continuation?})` returns per-page text, character `offset`/`nextOffset`, and truncation flags. Its default text budget is 32 KiB; choose 4–65536 bytes for one response. A dense page can continue at its next character offset instead of repeating its prefix. Pass the returned `continuation` unchanged to the next call. It pins the source digest and selected page order, and also works across scripts through `readPdf(path, {continuation})`. Changed source bytes reject the old continuation; deliberately open the new source to start a new observation. Text extraction is not OCR; scanned PDFs require visual reading or an explicitly chosen OCR tool.

`render({pages?, scale?, region?, fitToBudget?, outputDir?, continuation?})` returns each PNG's path, digest, page, requested and actual scale, dimensions, crop region and retained artifact reference. `scale` defaults to 1.5 and can exceed 4. `region: {x, y, width, height}` uses top-left coordinates in the rotated page's scale-1 viewport; crop a small region to inspect details at higher scale. By default, `fitToBudget` reduces scale when needed to fit the canvas's 4 million pixels and native dimension limit, reporting `fitted: true`. Set it to false to receive an explicit error and select another region/scale yourself. Rendering metadata also has a response budget; continue with the returned cursor and the same rendering options to cover further selected pages.

Default PNG paths are temporary review files removed when the tool finishes or stops. Their `artifact.path` copies persist in the run's evidence directory and can be inspected later. Call `emitImage(page.path)` within the script to select immediate visual observations. Supply an explicit `outputDir` when persistent PNG deliverables are wanted; these files are never automatically deleted. Filenames include page, source digest, actual scale and crop identity. Use a fresh directory when repeating an identical persistent render: existing files are never overwritten.

```js
export default async ({ openPdf, emitImage, progress }) => {
  const pdf = await openPdf("report.pdf");
  try {
    const text = await pdf.readText({pages:[1, 2]});
    const rendered = await pdf.render({pages:[1, 2]});
    const selections = [];
    for (const page of rendered.pages) selections.push(await emitImage(page.path));
    await progress({completed: "Reviewed the selected pages", source: pdf.source});
    return {text, rendered, selections};
  } finally { await pdf.close(); }
};
```

`emitImage(path)` deliberately selects a PNG for model inspection. Generic PNGs carry path, digest and dimensions; PDF renders also carry source digest, page and renderer details. Changing a render before emission rejects that provenance. Inspect images for clipping, alignment, readable charts and missing content. There is no image-count limit. One PNG may enter the response up to 2 MiB, and the combined serialized image response budget is 8 MiB, including base64 and metadata. Each selection returns `admitted` and a retained artifact. On budget overflow it returns `admitted: false`, the reason and a continuation instruction; it preserves prior observations and the script continues. Inspect a spilled image in a later call, or crop/downscale a PNG that exceeds the per-image budget using `libraries.canvas`. Do not rerun a document-producing script just to retrieve its images.

## Progress, failures and retained evidence

`document_run` accepts optional `timeoutMs` (a positive safe integer) and `artifactsDir` (a parent directory relative to `cwd` or absolute). There is no default deadline or 120-second maximum; choose a deadline for the work when useful, and Stop remains available. `await progress(value)` records completed work and provides bounded live progress. On an eventual failure or Stop, the latest recorded progress is identified by `valueIsProgress`, not claimed as the script's final result.

The tool response is a valid JSON envelope with outcome, result, logs, script digest, observations, omissions and artifact paths. A returned value over 64 KiB becomes a valid JSON overflow descriptor pointing to the complete `.json` or `.txt` artifact; it is never chopped into invalid JSON. The log preview and observation preview are each bounded at 64 KiB. Full logs and complete helper observations remain in `logs.txt` and `observations.ndjson`, alongside `run.json` and retained PNGs. Use ordinary file reads on these paths; opening them does not re-execute the script. A script exception, timeout, Stop or heap failure preserves evidence already delivered to the host and marks the native tool result as failed. A stopped synchronous script may have further filesystem or external effects not yet reported by a helper; inspect outputs before deciding what to do next. There is no automatic mutation replay.

Each run owns a uniquely named directory under `artifactsDir`, or machine-local `document-artifacts` by default. These evidence files persist until deliberately removed; they are not automatically attached or delivered. Temporary review files are cleaned separately. Explicit deliverables and other runs' evidence are never removed by this run's cleanup.

PDF capture defaults to 64 MiB per source; set `maxSourceBytes` deliberately when a larger PDF is needed, subject to available memory and honest allocation/read failures. The convenience wrappers accept this option too. Scripts remain bounded at 1 MiB, decoded canvases at 4 million pixels, and PNG reads at 20 MiB before decoding. Each worker has a 512 MiB JavaScript heap safeguard; native library and external buffer memory are outside this limit. Reuse PDF handles, release intermediate data and continue through bounded observations. These are resource and response safeguards, not a document-length or task-duration ceiling, and ordinary bundled library APIs remain available within the full-trust script.


## Installed rendering, calculation and OCR engines

Call `document_engine` with `{operation:"status"}` to detect optional installed engines.
The tool does not install programs. With LibreOffice available, use
`{operation:"render",source:"report.docx",output:"review/report.pdf"}` for Office-to-PDF,
or `{operation:"recalculate",source:"budget.xlsx",output:"review/calculated.xlsx"}`
for a recalculated copy. Then use `document_run` to render/inspect the PDF or reopen
the calculated workbook with ExcelJS and verify important formula results. Calc
compatibility is not identical to Excel; a file-save success does not establish
correctness of every formula. The isolated Calc profile forces OOXML recalculation
on load; the original file is never changed.

With Tesseract installed, `{operation:"ocr",source:"page.png",output:"page.txt",language:"eng"}`
recognizes a selected page image. Render PDF pages first. The `language` option accepts
installed Tesseract language identifiers, such as `eng+deu`. Compare important
recognized text with the image. Missing engines or language data are explicit failures;
use another available appropriate tool or explain the specific setup needed.

All operations require a new output path, return source/output hashes and engine version,
retain a log, and support Stop. `enginePath` selects an explicit installed executable.
There is no default deadline; optional `timeoutMs` must fit a Node timer. These
parent-owned engine processes are cancelled on Stop/session shutdown, unlike arbitrary
processes a document script independently starts. The tool deletes only its private
input copy and isolated profile, not delivered output or retained diagnostic logs.
