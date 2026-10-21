#!/usr/bin/env tsx
/**
 * Hidden checks for the document-checking evaluation (2026-10-18).
 *
 * Runs after a Worker's turn, outside its sandbox and context. It uses the
 * installed LibreOffice to recalculate and render the deliverable, measures it
 * against values derived from the seeded inputs, and writes page images for a
 * person to look at.
 *
 * Usage: tsx scripts/document-eval/check.ts <task> <work-folder> <results-dir>
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { runDocumentEngine } from "../../resources/included-tools/documents/engines.mjs";
import { budgetTargets, findings, transactions, workstreams, type DocumentTask } from "./fixtures.js";

const run = promisify(execFile);
const normalize = (text: string) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
const near = (actual: unknown, expected: number, tolerance = 0.006) => typeof actual === "number" && Math.abs(actual - expected) <= tolerance;

async function render(source: string, results: string, name: string) {
  const pdf = join(results, `${name}-${Date.now()}.pdf`);
  await runDocumentEngine({ operation: "render", source, output: pdf, cwd: results, stateRoot: results, timeoutMs: 120_000 });
  // Page images are for a person's review, not scored.
  await run("pdftoppm", ["-png", "-r", "60", pdf, join(results, name)]).catch(() => undefined);
  return pdf;
}

interface TextItem { text: string; left: number; right: number; top: number; bottom: number }
async function pdfPages(path: string) {
  const task = pdfjs.getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: true });
  const document = await task.promise;
  const pages: Array<{ width: number; height: number; items: TextItem[]; text: string }> = [];
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: TextItem[] = [];
    for (const item of content.items as Array<{ str: string; transform: number[]; width: number; height: number }>) {
      if (!item.str?.trim()) continue;
      const [, , , , x, y] = item.transform; const height = item.height || Math.abs(item.transform[3]!);
      // Top-left coordinates, like the slide and page layouts.
      items.push({ text: item.str, left: x!, right: x! + item.width, top: viewport.height - y! - height, bottom: viewport.height - y! + height * 0.25 });
    }
    pages.push({ width: viewport.width, height: viewport.height, items, text: items.map((item) => item.text).join(" ") });
  }
  await task.destroy();
  return pages;
}

const offPage = (page: { width: number; height: number; items: TextItem[] }, margin = 2) =>
  page.items.filter((item) => item.left < -margin || item.top < -margin || item.right > page.width + margin || item.bottom > page.height + margin);

function cellNumber(value: ExcelJS.CellValue): unknown {
  if (value && typeof value === "object" && "result" in value) return (value as { result?: unknown }).result;
  return value;
}
const isFormula = (value: ExcelJS.CellValue) => Boolean(value && typeof value === "object" && ("formula" in value || "sharedFormula" in value));
const formulaText = (value: ExcelJS.CellValue) => value && typeof value === "object" ? String((value as { formula?: string; sharedFormula?: string }).formula ?? (value as { sharedFormula?: string }).sharedFormula ?? "") : "";
const text = (value: ExcelJS.CellValue) => value === null || value === undefined ? "" : typeof value === "object" ? "richText" in value ? value.richText.map((part) => part.text).join("") : "result" in value ? String(value.result ?? "") : "text" in value ? String(value.text) : "" : String(value);

/** ExcelJS drops a cached formula result of exactly 0 when reading, so formula cells without one are read from the sheet XML. */
async function rawCachedValues(path: string) {
  const zip = await JSZip.loadAsync(await readFile(path));
  const workbook = await zip.file("xl/workbook.xml")!.async("string");
  const relations = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const values = new Map<string, number | string>();
  for (const sheet of workbook.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = relations.match(new RegExp(`Id="${sheet[2]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${sheet[2]}"`));
    const file = target && zip.file(`xl/${(target[1] ?? target[2])!.replace(/^\/?xl\//, "")}`);
    if (!file) continue;
    for (const cell of (await file.async("string")).matchAll(/<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const value = cell[3]!.match(/<v>([^<]*)<\/v>/)?.[1];
      if (value !== undefined && /<f[ >]/.test(cell[3]!)) values.set(`${sheet[1]!.replace(/&amp;/g, "&")}!${cell[1]}`, /t="(str|s|e)"/.test(cell[2]!) ? value : Number(value));
    }
  }
  return values;
}

async function checkBudget(folder: string, results: string) {
  const path = join(folder, "budget.xlsx");
  if (!existsSync(path)) return { exists: false };
  const delivered = new ExcelJS.Workbook(); await delivered.xlsx.readFile(path);
  const recalculatedPath = join(results, `budget-recalculated-${Date.now()}.xlsx`);
  await runDocumentEngine({ operation: "recalculate", source: path, output: recalculatedPath, cwd: results, stateRoot: results, timeoutMs: 120_000 });
  const recalculated = new ExcelJS.Workbook(); await recalculated.xlsx.readFile(recalculatedPath);
  await render(path, results, "budget");
  const sheet = (workbook: ExcelJS.Workbook, name: string) => workbook.worksheets.find((item) => normalize(item.name) === normalize(name));
  const sheetsPresent = ["Transactions", "By Category", "Summary"].filter((name) => sheet(delivered, name)).length;
  const actuals: Record<string, number> = {};
  for (const [, , category, amount] of transactions) actuals[category] = (actuals[category] ?? 0) + amount;
  const expected: Array<{ where: string; value: number | string; formula?: RegExp; format?: RegExp; find: (workbook: ExcelJS.Workbook) => ExcelJS.Cell | undefined }> = [];
  const byCategory = sheet(delivered, "By Category");
  const header = (label: RegExp) => {
    let found: { row: number; column: number } | undefined;
    byCategory?.eachRow((row, rowNumber) => row.eachCell((cell, column) => { if (!found && label.test(text(cell.value))) found = { row: rowNumber, column }; }));
    return found;
  };
  const columns = { budget: header(/^\s*budget/i), actual: header(/^\s*actual/i), difference: header(/^\s*difference/i), status: header(/^\s*status/i) };
  const rowOf = (label: RegExp) => { let found: number | undefined; byCategory?.eachRow((row, rowNumber) => row.eachCell((cell) => { if (!found && label.test(text(cell.value).trim())) found = rowNumber; })); return found; };
  const at = (row: number | undefined, column: { column: number } | undefined) => (workbook: ExcelJS.Workbook) => row && column ? sheet(workbook, "By Category")?.getRow(row).getCell(column.column) : undefined;
  for (const [category, budget] of Object.entries(budgetTargets)) {
    const row = rowOf(new RegExp(`^${category}$`, "i"));
    const actual = Math.round(actuals[category]! * 100) / 100;
    expected.push({ where: `${category} actual`, value: actual, formula: /sumif/i, format: /\$/, find: at(row, columns.actual) });
    expected.push({ where: `${category} difference`, value: Math.round((budget - actual) * 100) / 100, find: at(row, columns.difference) });
    expected.push({ where: `${category} status`, value: actual > budget ? "Over" : "OK", formula: /if/i, find: at(row, columns.status) });
  }
  const totalBudget = Object.values(budgetTargets).reduce((sum, value) => sum + value, 0);
  const totalActual = Math.round(Object.values(actuals).reduce((sum, value) => sum + value, 0) * 100) / 100;
  const total = rowOf(/^total$/i);
  expected.push({ where: "Total budget (By Category)", value: totalBudget, find: at(total, columns.budget) });
  expected.push({ where: "Total actual (By Category)", value: totalActual, formula: /./, find: at(total, columns.actual) });
  expected.push({ where: "Total difference (By Category)", value: Math.round((totalBudget - totalActual) * 100) / 100, find: at(total, columns.difference) });
  const summaryCell = (label: RegExp) => (workbook: ExcelJS.Workbook) => {
    let found: ExcelJS.Cell | undefined;
    sheet(workbook, "Summary")?.eachRow((row) => {
      if (found) return;
      const cells: ExcelJS.Cell[] = []; row.eachCell((cell) => cells.push(cell));
      const index = cells.findIndex((cell) => label.test(text(cell.value)));
      if (index >= 0) found = cells.slice(index + 1).find((cell) => cell.value !== null && cell.value !== "");
    });
    return found;
  };
  expected.push({ where: "Summary total budget", value: totalBudget, formula: /by category/i, find: summaryCell(/total budget/i) });
  expected.push({ where: "Summary total spent", value: totalActual, formula: /by category/i, find: summaryCell(/total spent/i) });
  expected.push({ where: "Summary percent used", value: totalActual / totalBudget, formula: /./, format: /%/, find: summaryCell(/percent/i) });

  const raw = { delivered: await rawCachedValues(path), recalculated: await rawCachedValues(recalculatedPath) };
  const cached = (cell: ExcelJS.Cell | undefined, values: Map<string, number | string>) => {
    if (!cell) return undefined;
    const value = cellNumber(cell.value);
    return value && typeof value === "object" && "formula" in value ? values.get(`${cell.worksheet.name}!${cell.address}`) : value;
  };
  const outcome = expected.map((item) => {
    const cell = item.find(delivered), calculatedCell = item.find(recalculated);
    const matches = (value: unknown) => typeof item.value === "number" ? near(value, item.value, item.where.includes("percent") ? 0.0005 : 0.006) : normalize(String(value ?? "")) === normalize(item.value);
    return {
      where: item.where, expected: item.value, found: Boolean(cell),
      cached: cached(cell, raw.delivered), calculated: cached(calculatedCell, raw.recalculated),
      cachedCorrect: Boolean(cell) && matches(cached(cell, raw.delivered)), calculatedCorrect: Boolean(calculatedCell) && matches(cached(calculatedCell, raw.recalculated)),
      formulaOk: !item.formula || (cell ? isFormula(cell.value) && item.formula.test(formulaText(cell.value)) : false),
      formatOk: !item.format || (cell ? item.format.test(cell.numFmt ?? "") : false),
      formula: cell ? formulaText(cell.value) : undefined, numFmt: cell?.numFmt,
    };
  });
  const errors: string[] = [];
  recalculated.eachSheet((item) => item.eachRow((row) => row.eachCell((cell) => {
    const result = cellNumber(cell.value);
    if (result && typeof result === "object" && "error" in result) errors.push(`${item.name}!${cell.address} ${(result as { error: string }).error}`);
  })));
  return {
    exists: true, sheetsPresent,
    calculatedCorrect: outcome.filter((item) => item.calculatedCorrect).length, cachedCorrect: outcome.filter((item) => item.cachedCorrect).length,
    formulasOk: outcome.filter((item) => item.formulaOk).length, formatsOk: outcome.filter((item) => item.formatOk).length, checks: outcome.length,
    errorsAfterRecalculation: errors, cells: outcome,
  };
}

async function checkDeck(folder: string, results: string) {
  const path = join(folder, "findings.pptx");
  if (!existsSync(path)) return { exists: false };
  const zip = await JSZip.loadAsync(await readFile(path));
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/g)!.at(-1)) - Number(b.match(/\d+/g)!.at(-1)));
  const presentation = await zip.file("ppt/presentation.xml")!.async("string");
  const size = presentation.match(/<p:sldSz cx="(\d+)" cy="(\d+)"/);
  const shapeBoxes = (xml: string) => [...xml.matchAll(/<p:(?:sp|graphicFrame)>[\s\S]*?<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>[\s\S]*?<\/p:(?:sp|graphicFrame)>/g)]
    .map((match) => ({ left: Number(match[1]) / 12700, top: Number(match[2]) / 12700, right: (Number(match[1]) + Number(match[3])) / 12700, bottom: (Number(match[2]) + Number(match[4])) / 12700 }));
  // Text can also come from the slide's layout and master, such as a footer defined once for every slide.
  const related = async (name: string, kind: "slideLayouts" | "slideMasters") => {
    const relations = await zip.file(name.replace(/([^/]+)$/, "_rels/$1.rels"))?.async("string");
    const target = relations?.match(new RegExp(`Target="\\.\\./(${kind}/[^"]+)"`))?.[1];
    return target ? `ppt/${target}` : undefined;
  };
  const inherited = async (name: string): Promise<string[]> => {
    const layout = await related(name, "slideLayouts");
    const master = layout && await related(layout, "slideMasters");
    return Promise.all([layout, master].filter((path): path is string => Boolean(path)).map((path) => zip.file(path)!.async("string")));
  };
  const slides = await Promise.all(slideNames.map(async (name) => {
    const xml = await zip.file(name)!.async("string");
    const layouts = await inherited(name);
    const paragraphs = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((match) => [...match[1]!.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((part) => part[1]).join(""));
    const sizes = [...xml.matchAll(/<a:(?:rPr|defRPr|endParaRPr)[^>]*\ssz="(\d+)"/g)].map((match) => Number(match[1]) / 100);
    // Shape rectangles in points from the top-left, for text that runs out of its box.
    const boxes = [xml, ...layouts].flatMap(shapeBoxes);
    return { text: normalize(paragraphs.join(" ")), sizes, boxes, autofit: /<a:normAutofit|<a:spAutoFit/.test(xml) };
  }));
  // A line counts as inside a box when its centre is within the box across and it stays within the box's height;
  // letter-spaced labels can measure a little wider than their box without spilling.
  const spills = (pages: Awaited<ReturnType<typeof pdfPages>>) => pages.map((page, index) => {
    const boxes = slides[index]?.boxes ?? [];
    const tolerance = 4;
    return page.items.filter((item) => {
      const centre = (item.left + item.right) / 2;
      return !boxes.some((box) => centre >= box.left - tolerance && centre <= box.right + tolerance && item.top >= box.top - tolerance && item.bottom <= box.bottom + tolerance);
    }).map((item) => item.text);
  });
  const outside = spills(await pdfPages(await render(path, results, "deck")));
  const findingCounts = slides.map((slide) => findings.filter((finding) => slide.text.includes(normalize(finding))).length);
  const findingsSlide = findingCounts.indexOf(Math.max(...findingCounts));
  // PowerPoint applies a bare shrink-on-overflow flag only after the text is edited, while LibreOffice applies it
  // when rendering. Rendering without the flag shows the deck as PowerPoint first opens it.
  let outsideWithoutAutofit: string[][] | null = null;
  if (slides.some((slide) => slide.autofit)) {
    for (const name of slideNames) zip.file(name, (await zip.file(name)!.async("string")).replace(/<a:normAutofit[^>]*\/>|<a:normAutofit[^>]*>[\s\S]*?<\/a:normAutofit>/g, "<a:noAutofit/>"));
    const copy = join(results, "deck-without-autofit.pptx");
    await writeFile(copy, await zip.generateAsync({ type: "nodebuffer" }));
    outsideWithoutAutofit = spills(await pdfPages(await render(copy, results, "deck-without-autofit")));
  }
  return {
    exists: true, slides: slides.length, slideSizeInches: size ? [Number(size[1]) / 914400, Number(size[2]) / 914400] : null,
    findingsSlide: findingsSlide + 1, findingsWordForWord: findingCounts[findingsSlide] ?? 0,
    findingsFontPoints: slides[findingsSlide] ? { min: Math.min(...slides[findingsSlide]!.sizes), max: Math.max(...slides[findingsSlide]!.sizes) } : null,
    autofit: slides.map((slide, index) => slide.autofit ? index + 1 : 0).filter(Boolean),
    slidesWithTextOutsideItsBox: outside.map((items, index) => items.length ? index + 1 : 0).filter(Boolean),
    textOutsideItsBox: outside.map((items) => items.slice(0, 4)),
    slidesWithTextOutsideItsBoxWithoutAutofit: outsideWithoutAutofit?.map((items, index) => items.length ? index + 1 : 0).filter(Boolean) ?? null,
    textOutsideItsBoxWithoutAutofit: outsideWithoutAutofit?.map((items) => items.slice(0, 4)) ?? null,
  };
}

async function checkReport(folder: string, results: string) {
  const path = join(folder, "report.docx");
  if (!existsSync(path)) return { exists: false };
  const zip = await JSZip.loadAsync(await readFile(path));
  const xml = await zip.file("word/document.xml")!.async("string");
  const tables = [...xml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)].map((match) => {
    const rows = [...match[1]!.matchAll(/<w:tr[ >]([\s\S]*?)<\/w:tr>/g)].map((row) => (row[1]!.match(/<w:tc>/g) ?? []).length);
    const grid = [...match[1]!.matchAll(/<w:gridCol w:w="(\d+)"/g)].map((column) => Number(column[1]));
    return { rows: rows.length, columns: Math.max(0, ...rows), gridInches: grid.map((width) => Math.round(width / 1440 * 100) / 100) };
  });
  const main = tables.sort((a, b) => b.rows * b.columns - a.rows * a.columns)[0];
  const page = xml.match(/<w:pgSz w:w="(\d+)" w:h="(\d+)"/);
  const margins = xml.match(/<w:pgMar w:top="(\d+)" w:right="(\d+)" w:bottom="(\d+)" w:left="(\d+)"/);
  const textWidth = page && margins ? (Number(page[1]) - Number(margins[2]) - Number(margins[4])) / 1440 : null;
  // Font sizes are stored in half-points. Only runs that carry visible text count, so unused styles do not.
  // A small label can be a design choice, so this is a pointer for the visual review, not a score.
  const runs = [...xml.matchAll(/<w:r>([\s\S]*?)<\/w:r>|<w:r [^>]*>([\s\S]*?)<\/w:r>/g)].map((match) => match[1] ?? match[2] ?? "")
    .filter((run) => /<w:t[^>]*>[^<]*\S/.test(run) && /<w:sz w:val="\d+"/.test(run))
    .map((run) => ({ points: Number(run.match(/<w:sz w:val="(\d+)"/)![1]) / 2, text: [...run.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((part) => part[1]).join("") }));
  const smallest = runs.reduce<typeof runs[number] | undefined>((least, run) => !least || run.points < least.points ? run : least, undefined);
  const pdf = await render(path, results, "report");
  const pages = await pdfPages(pdf);
  const all = normalize(pages.map((item) => item.text).join(" "));
  const present = (value: string) => all.includes(normalize(value));
  return {
    exists: true, smallestFontPoints: smallest?.points ?? null, smallestFontText: smallest?.text.slice(0, 60) ?? null, pages: pages.length, pageInches: page ? [Number(page[1]) / 1440, Number(page[2]) / 1440] : null, textWidthInches: textWidth,
    mainTable: main ?? null, tableGridWiderThanText: Boolean(main && textWidth && main.gridInches.reduce((sum, value) => sum + value, 0) > textWidth + 0.05),
    narrowestColumnInches: main?.gridInches.length ? Math.min(...main.gridInches) : null,
    workstreamsShown: workstreams.filter((row) => present(row[0])).length, ownersShown: workstreams.filter((row) => present(row[1])).length,
    notesShown: workstreams.filter((row) => present(row[8].split(" ").slice(0, 4).join(" "))).length,
    pagesWithTextOffPage: pages.map((item, index) => offPage(item).length ? index + 1 : 0).filter(Boolean),
    pagesWithTextInMargin: pages.map((item, index) => item.items.some((text) => text.right > item.width - 18 || text.left < 18) ? index + 1 : 0).filter(Boolean),
  };
}

const [taskId, folderArgument, resultsArgument] = process.argv.slice(2) as [DocumentTask["id"], string, string];
const folder = resolve(folderArgument), results = resolve(resultsArgument);
await mkdir(results, { recursive: true });
const checks = { budget: checkBudget, deck: checkDeck, report: checkReport };
const outcome = await checks[taskId](folder, results);
await writeFile(join(results, "check.json"), `${JSON.stringify(outcome, null, 2)}\n`);
console.log(JSON.stringify(outcome));
