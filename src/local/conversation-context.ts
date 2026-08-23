import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import { resizeImage } from "@earendil-works/pi-coding-agent";
import JSZip from "jszip";

import { OFFICE_OPEN_DOCUMENT_READ_NOTE, officeDocumentLockPresent } from "./office-lock-files.js";
import { resolveSpacePath } from "./space.js";

export type ConversationContextMode = "full_original_text" | "full_extracted_text" | "image" | "path_only_reference";

/** An image attachment prepared for the model: Pi's resize keeps it within provider limits. */
export interface ConversationContextImage {
  /** Base64-encoded image bytes. */
  data: string;
  mimeType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

export interface ConversationContextAttachment {
  sourcePath: string;
  sourceFileName: string;
  sourceSizeBytes: number;
  mode: ConversationContextMode;
  includedInPrompt: boolean;
  reason: string | null;
  estimatedTokens: number;
  budgetTokens: number;
  provenance: string[];
  warnings: string[];
  userLabel: string;
  detail: string;
}

export interface LoadedConversationContextAttachment extends ConversationContextAttachment {
  text: string | null;
  /** Present for `image` attachments; sent with the user message as image content. */
  image?: ConversationContextImage;
}

export async function previewConversationContextAttachment(
  spaceRoot: string,
  input: { path: string },
): Promise<ConversationContextAttachment> {
  const loaded = await loadAttachment(spaceRoot, normalizePath(input.path), chatContextBudgetTokens(), chatContextBudgetTokens());
  const { text: _text, image: _image, ...attachment } = loaded;
  return attachment;
}

export async function loadConversationContextAttachmentsForTurn(
  spaceRoot: string,
  paths: string[],
): Promise<LoadedConversationContextAttachment[]> {
  const budgetTokens = chatContextBudgetTokens();
  let remaining = budgetTokens;
  const result: LoadedConversationContextAttachment[] = [];
  for (const sourcePath of [...new Set(paths.map(normalizePath).filter(Boolean))].slice(0, 32)) {
    const attachment = await loadAttachment(spaceRoot, sourcePath, remaining, budgetTokens);
    if (attachment.includedInPrompt) remaining -= attachment.estimatedTokens;
    result.push(attachment);
  }
  return result;
}

async function loadAttachment(
  spaceRoot: string,
  sourcePath: string,
  remaining: number,
  budgetTokens: number,
): Promise<LoadedConversationContextAttachment> {
  const sourceFileName = basename(sourcePath);
  let sourceSizeBytes = 0;
  try {
    if (!sourcePath) throw new Error("Choose a file to attach to chat context.");
    const path = resolveSpacePath(spaceRoot, sourcePath);
    const info = await stat(path);
    if (!info.isFile()) throw new Error("Only files can be attached to chat context.");
    sourceSizeBytes = info.size;
    if (sourceSizeBytes > 32 * 1024 * 1024) throw new Error("The file is larger than the 32 MB chat attachment limit.");
    const bytes = await readFile(path);
    const imageMimeType = imageAttachmentMimeType(sourceFileName, bytes);
    if (imageMimeType) {
      return loadImageAttachment({ sourcePath, sourceFileName, sourceSizeBytes, bytes, mimeType: imageMimeType, remaining, budgetTokens });
    }
    const extracted = await readableAttachmentText(sourceFileName, bytes);
    const text = normalizeText(extracted.text);
    const estimatedTokens = estimateTokens(text);
    if (estimatedTokens > remaining) {
      return pathOnlyAttachment({
        sourcePath,
        sourceFileName,
        sourceSizeBytes,
        budgetTokens,
        estimatedTokens,
        reason: `The readable text is about ${estimatedTokens.toLocaleString()} tokens, which does not fit the remaining ${remaining.toLocaleString()} tokens of the chat context budget.`,
        provenance: extracted.provenance,
        warnings: extracted.warnings,
      });
    }
    const officeOpen = extracted.mode === "full_extracted_text" && await officeDocumentLockPresent(path);
    const warnings = officeOpen ? [...extracted.warnings, OFFICE_OPEN_DOCUMENT_READ_NOTE] : extracted.warnings;
    return {
      sourcePath,
      sourceFileName,
      sourceSizeBytes,
      mode: extracted.mode,
      includedInPrompt: true,
      reason: null,
      estimatedTokens,
      budgetTokens,
      provenance: extracted.provenance,
      warnings,
      userLabel: extracted.mode === "full_original_text" ? "Full text" : "Extracted text",
      detail: extracted.mode === "full_original_text"
        ? `Full text attached to this turn (about ${estimatedTokens.toLocaleString()} tokens).`
        : `Readable Office text attached to this turn (about ${estimatedTokens.toLocaleString()} tokens). Layout, formulas, comments, and binary formatting are not included.`,
      text,
    };
  } catch (error) {
    return pathOnlyAttachment({
      sourcePath,
      sourceFileName,
      sourceSizeBytes,
      budgetTokens,
      estimatedTokens: 0,
      reason: error instanceof Error ? error.message : String(error),
      provenance: [],
      warnings: [],
    });
  }
}

const imageExtensions = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/** Recognizes the inline image formats providers accept, by extension and magic bytes. */
export function imageAttachmentMimeType(fileName: string, bytes: Buffer): string | null {
  const byExtension = imageExtensions.get(extname(fileName).toLowerCase());
  if (!byExtension) return null;
  const sniffed = sniffImageMimeType(bytes);
  return sniffed === byExtension ? sniffed : null;
}

function sniffImageMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Provider-style image token estimate (pixels / 750), with a floor for tiny images. */
export function estimateImageTokens(width: number, height: number): number {
  return Math.max(85, Math.ceil((width * height) / 750));
}

async function loadImageAttachment(input: {
  sourcePath: string;
  sourceFileName: string;
  sourceSizeBytes: number;
  bytes: Buffer;
  mimeType: string;
  remaining: number;
  budgetTokens: number;
}): Promise<LoadedConversationContextAttachment> {
  const resized = await resizeImage(input.bytes, input.mimeType);
  if (!resized) throw new Error("The image could not be prepared for the model; Pi can still inspect it with the read tool.");
  const estimatedTokens = estimateImageTokens(resized.width, resized.height);
  const provenance = [
    resized.wasResized
      ? `Image resized locally from ${resized.originalWidth}×${resized.originalHeight} to ${resized.width}×${resized.height} for the model.`
      : `Image sent at its original ${resized.width}×${resized.height} size.`,
  ];
  if (estimatedTokens > input.remaining) {
    return pathOnlyAttachment({
      sourcePath: input.sourcePath,
      sourceFileName: input.sourceFileName,
      sourceSizeBytes: input.sourceSizeBytes,
      budgetTokens: input.budgetTokens,
      estimatedTokens,
      reason: `The image is about ${estimatedTokens.toLocaleString()} tokens, which does not fit the remaining ${input.remaining.toLocaleString()} tokens of the chat context budget.`,
      provenance,
      warnings: [],
    });
  }
  return {
    sourcePath: input.sourcePath,
    sourceFileName: input.sourceFileName,
    sourceSizeBytes: input.sourceSizeBytes,
    mode: "image",
    includedInPrompt: true,
    reason: null,
    estimatedTokens,
    budgetTokens: input.budgetTokens,
    provenance,
    warnings: [],
    userLabel: "Image",
    detail: `Image attached to this turn (${resized.width}×${resized.height}, about ${estimatedTokens.toLocaleString()} tokens).`,
    text: null,
    image: {
      data: resized.data,
      mimeType: resized.mimeType,
      width: resized.width,
      height: resized.height,
      originalWidth: resized.originalWidth,
      originalHeight: resized.originalHeight,
    },
  };
}

export async function readableAttachmentText(
  fileName: string,
  bytes: Buffer,
): Promise<{ text: string; mode: Exclude<ConversationContextMode, "path_only_reference">; provenance: string[]; warnings: string[] }> {
  const extension = extname(fileName).toLowerCase();
  if (wordExtensions.has(extension)) {
    return {
      text: await extractWordText(bytes),
      mode: "full_extracted_text",
      provenance: ["Readable text extracted locally from the Word OOXML package."],
      warnings: [],
    };
  }
  if (spreadsheetExtensions.has(extension)) {
    return {
      text: await extractSpreadsheetText(bytes),
      mode: "full_extracted_text",
      provenance: ["Readable cell values extracted locally from the Excel OOXML package."],
      warnings: [],
    };
  }
  if (presentationExtensions.has(extension)) {
    return {
      text: await extractPresentationText(bytes),
      mode: "full_extracted_text",
      provenance: ["Readable slide text extracted locally from the PowerPoint OOXML package."],
      warnings: [],
    };
  }
  if (looksBinary(bytes)) throw new Error("Binary files are attached by path; Pi can inspect them with an appropriate tool or Extension.");
  return {
    text: bytes.toString("utf8"),
    mode: "full_original_text",
    provenance: ["UTF-8 text attached with normalized line endings."],
    warnings: [],
  };
}

const wordExtensions = new Set([".docx", ".docm", ".dotx", ".dotm"]);
const spreadsheetExtensions = new Set([".xlsx", ".xlsm", ".xltx", ".xltm"]);
const presentationExtensions = new Set([".pptx", ".pptm", ".potx", ".potm"]);

async function extractWordText(bytes: Buffer): Promise<string> {
  const archive = await JSZip.loadAsync(bytes);
  const xml = await readZipText(archive, "word/document.xml", 16 * 1024 * 1024);
  if (!xml) throw new Error("The Word package has no readable document part.");
  return xmlText(xml, [
    [/<w:tab\b[^>]*\/>/gi, "\t"],
    [/<w:(?:br|cr)\b[^>]*\/>/gi, "\n"],
    [/<\/w:p>/gi, "\n"],
    [/<\/w:tr>/gi, "\n"],
    [/<\/w:tc>/gi, "\t"],
  ]);
}

async function extractPresentationText(bytes: Buffer): Promise<string> {
  const archive = await JSZip.loadAsync(bytes);
  const slides = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(naturalPartOrder)
    .slice(0, 500);
  if (!slides.length) throw new Error("The PowerPoint package has no readable slides.");
  const output: string[] = [];
  for (const [index, slide] of slides.entries()) {
    const xml = await readZipText(archive, slide, 8 * 1024 * 1024) ?? "";
    output.push(`Slide ${index + 1}`, xmlText(xml, [[/<\/a:p>/gi, "\n"]]));
  }
  return output.join("\n\n");
}

async function extractSpreadsheetText(bytes: Buffer): Promise<string> {
  const archive = await JSZip.loadAsync(bytes);
  const sharedXml = await readZipText(archive, "xl/sharedStrings.xml", 16 * 1024 * 1024) ?? "";
  const sharedStrings = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)]
    .map((match) => extractTaggedText(match[1] ?? "", "t"));
  const sheets = Object.keys(archive.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(naturalPartOrder)
    .slice(0, 500);
  if (!sheets.length) throw new Error("The Excel package has no readable worksheets.");
  const output: string[] = [];
  for (const [index, sheet] of sheets.entries()) {
    const xml = await readZipText(archive, sheet, 16 * 1024 * 1024) ?? "";
    const rows: string[] = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
      const cells: string[] = [];
      for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
        const attributes = cellMatch[1] ?? "";
        const body = cellMatch[2] ?? "";
        const type = /\bt="([^"]+)"/i.exec(attributes)?.[1] ?? "";
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)?.[1] ?? extractTaggedText(body, "t");
        const value = type === "s" && /^\d+$/.test(raw.trim()) ? sharedStrings[Number(raw.trim())] ?? raw : decodeXml(raw);
        cells.push(value.replace(/\s+/g, " ").trim());
      }
      if (cells.some(Boolean)) rows.push(cells.join("\t"));
    }
    output.push(`Worksheet ${index + 1}`, rows.join("\n") || "(no readable cell values)");
  }
  return output.join("\n\n");
}

async function readZipText(archive: JSZip, path: string, maxBytes: number): Promise<string | null> {
  const entry = archive.file(path);
  if (!entry) return null;
  const internal = entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } };
  const declaredSize = Number(internal._data?.uncompressedSize ?? 0);
  if (declaredSize > maxBytes) throw new Error(`${path} is too large to extract safely.`);
  const text = await entry.async("text");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`${path} is too large to extract safely.`);
  return text;
}

function xmlText(xml: string, replacements: Array<[RegExp, string]>): string {
  let prepared = xml;
  for (const [pattern, replacement] of replacements) prepared = prepared.replace(pattern, replacement);
  prepared = prepared.replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi, "$1").replace(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi, "$1");
  return decodeXml(prepared.replace(/<[^>]+>/g, "")).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractTaggedText(xml: string, localName: string): string {
  const expression = new RegExp(`<(?:(?:\\w+):)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${localName}>`, "gi");
  return [...xml.matchAll(expression)].map((match) => decodeXml((match[1] ?? "").replace(/<[^>]+>/g, ""))).join("");
}

function naturalPartOrder(left: string, right: string): number {
  const leftNumber = Number(/(\d+)(?=\.xml$)/i.exec(left)?.[1] ?? 0);
  const rightNumber = Number(/(\d+)(?=\.xml$)/i.exec(right)?.[1] ?? 0);
  return leftNumber - rightNumber || left.localeCompare(right);
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function pathOnlyAttachment(input: {
  sourcePath: string;
  sourceFileName: string;
  sourceSizeBytes: number;
  budgetTokens: number;
  estimatedTokens: number;
  reason: string;
  provenance: string[];
  warnings: string[];
}): LoadedConversationContextAttachment {
  return {
    ...input,
    mode: "path_only_reference",
    includedInPrompt: false,
    userLabel: "Path only",
    detail: `The Space-relative path is attached. Pi can inspect the file with tools. Reason: ${input.reason}`,
    text: null,
  };
}

export function chatContextBudgetTokens(): number {
  const configured = Number(process.env.WORKFOLD_CHAT_CONTEXT_BUDGET_TOKENS);
  return Number.isFinite(configured) && configured > 1000 ? Math.floor(configured) : 90_000;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
}

export function normalizeText(value: string): string {
  const text = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  return `${text}\n`;
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  return sample.length > 0 && controls / sample.length > 0.1;
}
