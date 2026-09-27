import { readFile, stat } from "node:fs/promises";
import { basename, extname, posix } from "node:path";
import { inflateRaw } from "node:zlib";

import { resizeImage } from "@earendil-works/pi-coding-agent";
import JSZip from "jszip";
import { SaxesParser, type SaxesTagNS } from "saxes";

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
  const parts = await officeParts(bytes);
  const main = await officeMainPart(parts);
  const slides = await orderedOfficeParts(parts, main, "presentation", "sldIdLst", "sldId", "slide");
  const output: string[] = [];
  const reserveText = officeTextBudget();
  for (const [index, slide] of slides.entries()) {
    const text: string[] = [];
    parseOfficeXml(await parts.read(slide.path, 8 * 1024 * 1024), slide.path, "sld", "presentation", {
      text(value, ancestors) {
        if (officeTag(ancestors.at(-1), "t", "drawing")) { reserveText(value); text.push(value); }
      },
      close(tag) {
        if (officeTag(tag, "p", "drawing") || officeTag(tag, "br", "drawing")) { reserveText("\n"); text.push("\n"); }
      },
    });
    const heading = `Slide ${index + 1}`;
    reserveText(heading, 4);
    output.push(heading, text.join("").trim());
  }
  return output.join("\n\n");
}

async function extractSpreadsheetText(bytes: Buffer): Promise<string> {
  const parts = await officeParts(bytes);
  const main = await officeMainPart(parts);
  const relationships = await officeRelationships(parts, main);
  const sheets = await orderedOfficeParts(parts, main, "workbook", "sheets", "sheet", "worksheet", relationships);
  const sharedReferences = [...relationships.values()].filter((relationship) => officeRelationshipType(relationship, "sharedStrings"));
  if (sharedReferences.length > 1) throw new Error("The Excel package has ambiguous shared-string relationships; complete cell values cannot be extracted.");
  const sharedStrings: string[] = [];
  if (sharedReferences[0]) {
    const sharedPath = officeRelationshipPath(main, sharedReferences[0], "sharedStrings");
    let value = "";
    parseOfficeXml(await parts.read(sharedPath, 16 * 1024 * 1024), sharedPath, "sst", "spreadsheet", {
      open(tag) { if (officeTag(tag, "si", "spreadsheet")) value = ""; },
      text(text, ancestors) {
        if (officeTag(ancestors.at(-1), "t", "spreadsheet") && !ancestors.some((tag) => officeTag(tag, "rPh", "spreadsheet"))) value += text;
      },
      // Normalize once: one large shared string can be referenced by many cells.
      close(tag) { if (officeTag(tag, "si", "spreadsheet")) sharedStrings.push(value.replace(/\s+/g, " ").trim()); },
    });
  }
  const output: string[] = [];
  const reserveText = officeTextBudget();
  for (const [index, sheet] of sheets.entries()) {
    const rows: string[] = [];
    let cells: string[] = [];
    let cell: { type: string; raw: string; inline: string } | null = null;
    parseOfficeXml(await parts.read(sheet.path, 16 * 1024 * 1024), sheet.path, "worksheet", "spreadsheet", {
      open(tag, ancestors) {
        if (officeTag(tag, "row", "spreadsheet") && officeTag(ancestors.at(-1), "sheetData", "spreadsheet")) cells = [];
        if (officeTag(tag, "c", "spreadsheet") && officeTag(ancestors.at(-1), "row", "spreadsheet")) {
          cell = { type: officeAttribute(tag, "t"), raw: "", inline: "" };
        }
      },
      text(value, ancestors) {
        if (!cell) return;
        if (officeTag(ancestors.at(-1), "v", "spreadsheet")) cell.raw += value;
        if (officeTag(ancestors.at(-1), "t", "spreadsheet") && !ancestors.some((tag) => officeTag(tag, "rPh", "spreadsheet"))) cell.inline += value;
      },
      close(tag) {
        if (officeTag(tag, "c", "spreadsheet") && cell) {
          let value = (cell.type === "inlineStr" ? cell.inline : cell.raw).replace(/\s+/g, " ").trim();
          if (cell.type === "s") {
            const reference = cell.raw.trim();
            if (!/^\d+$/.test(reference) || sharedStrings[Number(reference)] === undefined) {
              throw new Error(`${sheet.path} references a missing shared-string value; complete cell values cannot be extracted.`);
            }
            value = sharedStrings[Number(reference)]!;
          }
          reserveText(value, 1); // Covers the cell separator or row ending too.
          cells.push(value);
          cell = null;
        }
        if (officeTag(tag, "row", "spreadsheet") && cells.some(Boolean)) rows.push(cells.join("\t"));
      },
    });
    const heading = `Worksheet ${index + 1}: ${sheet.name}`;
    reserveText(heading, 4);
    if (!rows.length) reserveText("(no readable cell values)");
    output.push(heading, rows.join("\n") || "(no readable cell values)");
  }
  return output.join("\n\n");
}

const officeNamespaces = {
  presentation: ["http://schemas.openxmlformats.org/presentationml/2006/main", "http://purl.oclc.org/ooxml/presentationml/main"],
  spreadsheet: ["http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"],
  drawing: ["http://schemas.openxmlformats.org/drawingml/2006/main", "http://purl.oclc.org/ooxml/drawingml/main"],
  relationship: ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"],
  package: ["http://schemas.openxmlformats.org/package/2006/relationships"],
};
type OfficeNamespace = keyof typeof officeNamespaces;
type OfficeParts = { read(path: string, maxBytes: number): Promise<string> };
type OfficeRelationship = { id: string; type: string; target: string; mode: string };

/** Shared-string references can amplify small XML into arbitrarily large text. */
function officeTextBudget(): (text: string, separators?: number) => void {
  let remaining = 64 * 1024 * 1024;
  return (text, separators = 0) => {
    remaining -= Buffer.byteLength(text, "utf8") + separators;
    if (remaining < 0) throw new Error("The Office package produces too much extracted text to attach safely. Inspect the file with tools.");
  };
}

/** Bound decompressed input across parts as well as within each part. No partial text escapes on failure. */
async function officeParts(bytes: Buffer): Promise<OfficeParts> {
  const archive = await JSZip.loadAsync(bytes);
  let remaining = 64 * 1024 * 1024;
  return {
    async read(path, maxBytes) {
      const text = await readZipText(archive, path, Math.min(maxBytes, remaining));
      if (text === null) throw new Error(`The Office package is missing required part ${path}; complete text cannot be extracted.`);
      remaining -= Buffer.byteLength(text, "utf8");
      return text;
    },
  };
}

function officeTag(tag: SaxesTagNS | undefined, local: string, namespace: OfficeNamespace): boolean {
  return tag?.local === local && officeNamespaces[namespace].includes(tag.uri);
}

function officeAttribute(tag: SaxesTagNS, local: string, namespace?: OfficeNamespace): string {
  return Object.values(tag.attributes).find((attribute) => attribute.local === local
    && (namespace ? officeNamespaces[namespace].includes(attribute.uri) : !attribute.uri))?.value ?? "";
}

function parseOfficeXml(xml: string, path: string, root: string, namespace: OfficeNamespace, handlers: {
  open?: (tag: SaxesTagNS, ancestors: SaxesTagNS[]) => void;
  text?: (text: string, ancestors: SaxesTagNS[]) => void;
  close?: (tag: SaxesTagNS, ancestors: SaxesTagNS[]) => void;
}): void {
  const parser = new SaxesParser({ xmlns: true });
  const ancestors: SaxesTagNS[] = [];
  parser.on("error", () => { throw new Error(`${path} contains malformed XML; complete text cannot be extracted.`); });
  parser.on("doctype", () => { throw new Error(`${path} contains an unsupported XML document type; complete text cannot be extracted.`); });
  parser.on("opentag", (tag) => {
    if (!ancestors.length && !officeTag(tag, root, namespace)) throw new Error(`${path} has an unsupported document root; complete text cannot be extracted.`);
    if (ancestors.length >= 128) throw new Error(`${path} is nested too deeply to extract safely.`);
    if (tag.local === "AlternateContent" && tag.uri === "http://schemas.openxmlformats.org/markup-compatibility/2006") {
      throw new Error(`${path} contains alternative content that this text extractor cannot resolve completely.`);
    }
    handlers.open?.(tag, ancestors);
    ancestors.push(tag);
  });
  parser.on("text", (text) => handlers.text?.(text, ancestors));
  parser.on("cdata", (text) => handlers.text?.(text, ancestors));
  parser.on("closetag", (tag) => {
    ancestors.pop();
    handlers.close?.(tag, ancestors);
  });
  parser.write(xml).close();
}

async function officeRelationships(parts: OfficeParts, source: string): Promise<Map<string, OfficeRelationship>> {
  const path = source ? posix.join(posix.dirname(source), "_rels", `${posix.basename(source)}.rels`) : "_rels/.rels";
  const relationships = new Map<string, OfficeRelationship>();
  parseOfficeXml(await parts.read(path, 4 * 1024 * 1024), path, "Relationships", "package", {
    open(tag, ancestors) {
      if (ancestors.length !== 1 || !officeTag(tag, "Relationship", "package")) return;
      const relationship = {
        id: officeAttribute(tag, "Id"), type: officeAttribute(tag, "Type"),
        target: officeAttribute(tag, "Target"), mode: officeAttribute(tag, "TargetMode") || "Internal",
      };
      if (!relationship.id || !relationship.type || !relationship.target || relationships.has(relationship.id)) {
        throw new Error(`${path} has a missing or duplicate relationship; complete text cannot be extracted.`);
      }
      relationships.set(relationship.id, relationship);
    },
  });
  return relationships;
}

function officeRelationshipType(relationship: OfficeRelationship, type: string): boolean {
  return officeNamespaces.relationship.some((namespace) => relationship.type === `${namespace}/${type}`);
}

function officeRelationshipPath(source: string, relationship: OfficeRelationship, type: string): string {
  if (!officeRelationshipType(relationship, type) || relationship.mode !== "Internal") {
    throw new Error(`The Office package has an unsupported ${type} relationship ${relationship.id}; complete text cannot be extracted.`);
  }
  const target = relationship.target;
  if (/^[a-z][a-z\d+.-]*:|^\/\/|[\\?#]/i.test(target)) throw new Error(`The Office package has an invalid part target for ${relationship.id}.`);
  const segments = target.startsWith("/") || !source ? [] : posix.dirname(source).split("/").filter((part) => part !== ".");
  for (const encoded of target.split("/")) {
    let segment: string;
    try { segment = decodeURIComponent(encoded); } catch { throw new Error(`The Office package has an invalid part target for ${relationship.id}.`); }
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) throw new Error(`The Office package has a part target outside the package for ${relationship.id}.`);
      segments.pop();
    } else {
      if (/[\\/\u0000]/.test(segment)) throw new Error(`The Office package has an invalid part target for ${relationship.id}.`);
      segments.push(segment);
    }
  }
  return segments.join("/");
}

async function officeMainPart(parts: OfficeParts): Promise<string> {
  const candidates = [...(await officeRelationships(parts, "")).values()].filter((relationship) => officeRelationshipType(relationship, "officeDocument"));
  if (candidates.length !== 1) throw new Error("The Office package has no unique document relationship; complete text cannot be extracted.");
  return officeRelationshipPath("", candidates[0]!, "officeDocument");
}

async function orderedOfficeParts(parts: OfficeParts, main: string, root: "presentation" | "workbook", list: string, item: string, type: "slide" | "worksheet", relationships?: Map<string, OfficeRelationship>): Promise<Array<{ path: string; name: string }>> {
  const namespace = root === "presentation" ? "presentation" : "spreadsheet";
  const refs: Array<{ id: string; name: string }> = [];
  parseOfficeXml(await parts.read(main, 4 * 1024 * 1024), main, root, namespace, {
    open(tag, ancestors) {
      if (ancestors.length !== 2 || !officeTag(ancestors[1], list, namespace)) return;
      if (!officeTag(tag, item, namespace)) throw new Error(`${main} has an unsupported entry in its ${type} list; complete text cannot be extracted.`);
      const id = officeAttribute(tag, "id", "relationship");
      const name = officeAttribute(tag, "name");
      if (!id || (type === "worksheet" && !name)) throw new Error(`${main} has a ${type} with missing identity; complete text cannot be extracted.`);
      refs.push({ id, name });
      if (refs.length > 500) throw new Error(`The Office package exceeds the 500 ${type}s extraction limit; complete text cannot be attached. Inspect the file with tools.`);
    },
  });
  if (!refs.length) throw new Error(`The Office package has no readable ${type}s in its document manifest.`);
  const rels = relationships ?? await officeRelationships(parts, main);
  const seen = new Set<string>();
  return refs.map(({ id, name }) => {
    const relationship = rels.get(id);
    if (!relationship) throw new Error(`${main} references missing ${type} relationship ${id}; complete text cannot be extracted.`);
    const path = officeRelationshipPath(main, relationship, type);
    if (seen.has(path)) throw new Error(`${main} contains a duplicate ${type} reference; complete text cannot be extracted.`);
    seen.add(path);
    return { path, name };
  });
}

async function readZipText(archive: JSZip, path: string, maxBytes: number): Promise<string | null> {
  const entry = archive.file(path);
  if (!entry) return null;
  // JSZip's async("text") allocates all inflated bytes before checking the ZIP's
  // claimed size. Its loaded-part metadata lets native zlib enforce a real
  // output bound even when that claim is forged. Both supported ZIP methods
  // are handled explicitly; never fall back to an unbounded extraction.
  const internal = entry as JSZip.JSZipObject & { _data?: {
    uncompressedSize?: number; compression?: { magic?: string }; compressedContent?: Uint8Array;
  } };
  const data = internal._data;
  if (!data || !Number.isSafeInteger(data.uncompressedSize) || data.uncompressedSize! < 0 || !(data.compressedContent instanceof Uint8Array)) {
    throw new Error(`${path} has unsupported ZIP part metadata; complete text cannot be extracted.`);
  }
  const tooLarge = () => new Error(`${path} is too large to extract safely.`);
  if (data.uncompressedSize! > maxBytes || maxBytes < 1) throw tooLarge();
  const compressed = data.compressedContent;
  let bytes: Uint8Array;
  if (data.compression?.magic === "\x00\x00") {
    if (compressed.byteLength > maxBytes) throw tooLarge();
    bytes = compressed;
  } else if (data.compression?.magic === "\x08\x00") {
    bytes = await new Promise<Buffer>((resolve, reject) => {
      inflateRaw(compressed, { maxOutputLength: maxBytes }, (error, result) => {
        if (error) reject((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? tooLarge() : error);
        else resolve(result);
      });
    });
  } else throw new Error(`${path} uses an unsupported ZIP compression method; complete text cannot be extracted.`);
  if (bytes.byteLength !== data.uncompressedSize) throw new Error(`${path} has an invalid decompressed size; complete text cannot be extracted.`);
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`${path} is not valid UTF-8 XML; complete text cannot be extracted.`); }
}

function xmlText(xml: string, replacements: Array<[RegExp, string]>): string {
  let prepared = xml;
  for (const [pattern, replacement] of replacements) prepared = prepared.replace(pattern, replacement);
  prepared = prepared.replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi, "$1").replace(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi, "$1");
  return decodeXml(prepared.replace(/<[^>]+>/g, "")).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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
