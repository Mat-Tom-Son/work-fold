/**
 * Turns a page folder's entry file into one self-contained document
 * (docs/pages.md, "How a page runs"): stylesheets, scripts, CSS `url()` and
 * `@import` targets, images, media, fonts, icons, and `srcset` candidates that
 * point at files inside the folder are inlined, binary files as data URLs.
 * The same pass, in "check" mode, finds every reference problem without
 * reading binary files. The page runtime and the sandbox policy are not added
 * here; the page tab's frame host adds them.
 */
import { Buffer } from "node:buffer";
import { posix } from "node:path";

import type { PageProblem } from "../../shared/pages/index.js";
import type { PageFolderFile } from "./page-folder-files.js";
import {
  escapeHtmlAttribute,
  getAttribute,
  moduleScriptImportsFiles,
  parseSrcset,
  scanCss,
  scanHtml,
  type HtmlAttribute,
  type HtmlTag,
} from "./page-markup.js";

export interface PageDocumentSource {
  /** The page's files, by page-folder-relative path. */
  files: ReadonlyMap<string, PageFolderFile>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
}

export type PageDocumentMode = "check" | "assemble";

const maxCssImportDepth = 16;

/** `<link rel>` values that never load anything. Any other `<link href>` is a resource. */
const nonResourceLinkRels = new Set([
  "alternate", "author", "bookmark", "canonical", "external", "help", "license", "me", "next",
  "nofollow", "noopener", "noreferrer", "opener", "prev", "search", "tag",
]);

/** Elements whose attributes load a file. `srcset` is handled separately. */
const resourceAttributes: Record<string, readonly string[]> = {
  img: ["src"],
  source: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  input: ["src"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
  feimage: ["href", "xlink:href"],
};

const embeddingElements = new Set(["iframe", "frame", "embed", "object", "portal", "applet"]);

/** Attributes an inlined script no longer needs. */
const droppedScriptAttributes = new Set(["src", "integrity", "crossorigin", "defer", "async", "referrerpolicy", "fetchpriority"]);

const mediaTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp", ".apng": "image/apng",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".flac": "audio/flac", ".opus": "audio/opus", ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg",
  ".mov": "video/quicktime", ".vtt": "text/vtt", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".txt": "text/plain", ".html": "text/html",
  ".xml": "application/xml", ".pdf": "application/pdf",
};

export function pageFileMediaType(path: string): string {
  return mediaTypes[posix.extname(path).toLowerCase()] ?? "application/octet-stream";
}

type Classified =
  | { kind: "skip" }
  | { kind: "remote" }
  | { kind: "scheme" }
  | { kind: "outside" }
  | { kind: "file"; path: string; fragment: string };

/** Where a reference written in `baseDir` (page-folder-relative) points. A leading `/` means the page folder. */
export function classifyPageReference(raw: string, baseDir: string): Classified {
  const value = raw.trim();
  if (!value || value.startsWith("#")) return { kind: "skip" };
  if (/^(?:data|blob|about):/iu.test(value)) return { kind: "skip" };
  if (/^(?:https?:)?[\\/]{2}/iu.test(value) || /^https?:/iu.test(value)) return { kind: "remote" };
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return { kind: "scheme" };
  const hashAt = value.indexOf("#");
  const fragment = hashAt >= 0 ? value.slice(hashAt) : "";
  let path = value.replaceAll("\\", "/").replace(/[?#].*$/su, "");
  try { path = decodeURIComponent(path); } catch { /* Keep it as written. */ }
  const segments = path.startsWith("/") || !baseDir ? [] : baseDir.split("/");
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return { kind: "outside" };
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { kind: "file", path: segments.join("/"), fragment };
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(text: string, edits: Edit[]): string {
  if (!edits.length) return text;
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let result = "";
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor) continue;
    result += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return result + text.slice(cursor);
}

/** Keeps `</script` and `<!-- … <script` from ending or confusing an inline script. */
function escapeInlineScript(code: string): string {
  let escaped = code.replace(/<\/(script)/giu, "<\\/$1");
  if (/<script/iu.test(escaped)) escaped = escaped.replaceAll("<!--", "<\\!--");
  return escaped;
}

function escapeInlineStyle(css: string): string {
  return css.replace(/<\/(style)/giu, "<\\/$1");
}

/**
 * Checks (and in "assemble" mode, inlines) everything the entry file refers
 * to. Problems name the file the reference is written in. `html` is the
 * assembled document in "assemble" mode, or null in "check" mode.
 */
export async function processPageEntry(
  entry: string,
  source: PageDocumentSource,
  mode: PageDocumentMode,
): Promise<{ html: string | null; problems: PageProblem[] }> {
  const problems: PageProblem[] = [];
  const assemble = mode === "assemble";
  const error = (file: string, message: string) => { problems.push({ file, message, severity: "error" }); };
  const dataUrls = new Map<string, string>();
  const textCache = new Map<string, string | null>();

  const readText = async (path: string): Promise<string | null> => {
    if (textCache.has(path)) return textCache.get(path)!;
    let text: string | null = null;
    try { text = await source.readText(path); } catch (failure) { error(path, failureMessage(failure)); }
    textCache.set(path, text);
    return text;
  };
  const dataUrl = async (path: string): Promise<string | null> => {
    const cached = dataUrls.get(path);
    if (cached) return cached;
    try {
      const bytes = await source.readBytes(path);
      const url = `data:${pageFileMediaType(path)};base64,${Buffer.from(bytes).toString("base64")}`;
      dataUrls.set(path, url);
      return url;
    } catch (failure) {
      error(path, failureMessage(failure));
      return null;
    }
  };
  /** The page-folder file `raw` names, or null after reporting why it can't be used. */
  const reference = (raw: string, baseDir: string, fromFile: string): { path: string; fragment: string } | null => {
    const classified = classifyPageReference(raw, baseDir);
    switch (classified.kind) {
      case "skip":
        return null;
      case "remote":
        error(fromFile, `Loads "${raw.trim()}" from the internet. Pages can't use the network: save the file into the page folder and refer to it there.`);
        return null;
      case "scheme":
        error(fromFile, `Refers to "${raw.trim()}", which isn't a file in the page folder.`);
        return null;
      case "outside":
        error(fromFile, `Refers to "${raw.trim()}", which is outside the page folder.`);
        return null;
      case "file":
        if (!source.files.has(classified.path)) {
          error(fromFile, `Refers to "${raw.trim()}", which isn't in the page folder.`);
          return null;
        }
        return { path: classified.path, fragment: classified.fragment };
    }
  };

  /** Checks (and inlines) a stylesheet's `url()` and `@import` references. */
  const processCss = async (css: string, fromFile: string, baseDir: string, stack: readonly string[]): Promise<string> => {
    const edits: Edit[] = [];
    for (const item of scanCss(css)) {
      const target = reference(item.url, baseDir, fromFile);
      if (!target) continue;
      if (item.kind === "url") {
        if (!assemble) continue;
        const url = await dataUrl(target.path);
        if (url) edits.push({ start: item.start, end: item.end, text: `url("${url}${target.fragment}")` });
        continue;
      }
      if (stack.includes(target.path)) {
        error(fromFile, `Imports "${item.url}", which imports this stylesheet again.`);
        continue;
      }
      if (stack.length >= maxCssImportDepth) {
        error(fromFile, `Stylesheet imports are nested more than ${maxCssImportDepth} deep.`);
        continue;
      }
      const imported = await readText(target.path);
      if (imported === null) continue;
      const inlined = await processCss(imported, target.path, posix.dirname(target.path) === "." ? "" : posix.dirname(target.path), [...stack, target.path]);
      if (!assemble) continue;
      const body = inlined.replace(/@charset\s+["'][^"']*["']\s*;/giu, "");
      const conditions = item.conditions;
      edits.push({
        start: item.start,
        end: item.end,
        text: conditions && !/^(?:layer|supports)\b/iu.test(conditions) ? `@media ${conditions} {\n${body}\n}` : `\n${body}\n`,
      });
    }
    return assemble ? applyEdits(css, edits) : css;
  };

  const html = await readText(entry);
  if (html === null) return { html: null, problems };
  const entryDir = posix.dirname(entry) === "." ? "" : posix.dirname(entry);
  const tags = scanHtml(html);
  const edits: Edit[] = [];
  const deferredScripts: string[] = [];
  const attributeEdit = (attribute: HtmlAttribute, value: string): Edit => ({
    start: attribute.start,
    end: attribute.end,
    text: `${html.slice(attribute.start, attribute.start + attribute.name.length)}="${escapeHtmlAttribute(value)}"`,
  });

  for (const tag of tags) {
    if (tag.kind !== "start") continue;
    if (tag.name === "base") {
      if (getAttribute(tag, "href")) error(entry, "The <base> element isn't supported in a page. Use paths relative to the page instead.");
      continue;
    }
    if (tag.name === "script") {
      await processScript(tag);
      continue;
    }
    if (tag.name === "link") {
      await processLink(tag);
      continue;
    }
    if (tag.name === "style" && tag.content) {
      const css = html.slice(tag.content.start, tag.content.end);
      const processed = await processCss(css, entry, entryDir, [entry]);
      if (assemble && processed !== css) edits.push({ start: tag.content.start, end: tag.content.end, text: escapeInlineStyle(processed) });
    }
    if (embeddingElements.has(tag.name)) {
      for (const name of ["src", "data"]) {
        const attribute = getAttribute(tag, name);
        if (attribute && classifyPageReference(attribute.value, entryDir).kind !== "skip") {
          error(entry, `<${tag.name}> can't load "${attribute.value.trim()}": pages can't embed other pages, frames, or objects.`);
        }
      }
    }
    for (const name of resourceAttributes[tag.name] ?? []) {
      const attribute = getAttribute(tag, name);
      if (!attribute?.hasValue) continue;
      const target = reference(attribute.value, entryDir, entry);
      if (!target || !assemble) continue;
      const url = await dataUrl(target.path);
      if (url) edits.push(attributeEdit(attribute, `${url}${target.fragment}`));
    }
    if (tag.name === "img" || tag.name === "source") {
      const srcset = getAttribute(tag, "srcset");
      if (srcset?.hasValue) {
        let rewritten = "";
        let cursor = 0;
        for (const candidate of parseSrcset(srcset.value)) {
          const target = reference(candidate.url, entryDir, entry);
          rewritten += srcset.value.slice(cursor, candidate.start);
          const url = target && assemble ? await dataUrl(target.path) : null;
          rewritten += url ?? candidate.url;
          cursor = candidate.end;
        }
        rewritten += srcset.value.slice(cursor);
        if (assemble && rewritten !== srcset.value) edits.push(attributeEdit(srcset, rewritten));
      }
    }
    const style = getAttribute(tag, "style");
    if (style?.hasValue && /url\(/iu.test(style.value)) {
      const processed = await processCss(style.value, entry, entryDir, [entry]);
      if (assemble && processed !== style.value) edits.push(attributeEdit(style, processed));
    }
  }

  async function processScript(tag: HtmlTag): Promise<void> {
    const src = getAttribute(tag, "src");
    const type = (getAttribute(tag, "type")?.value ?? "").trim().toLowerCase();
    const isModule = type === "module";
    if (!src?.hasValue || !src.value.trim()) {
      if (isModule && tag.content && moduleScriptImportsFiles(html!.slice(tag.content.start, tag.content.end))) {
        error(entry, "A module script imports another file. Module scripts in a page can't import files: combine them into one script.");
      }
      return;
    }
    const target = reference(src.value, entryDir, entry);
    if (!target) return;
    if (!assemble && !isModule) return;
    const code = await readText(target.path);
    if (code === null) return;
    if (isModule && moduleScriptImportsFiles(code)) {
      error(target.path, "This module script imports another file. Module scripts in a page can't import files: combine them into one script.");
    }
    if (!assemble) return;
    const kept = tag.attributes.filter((attribute) => !droppedScriptAttributes.has(attribute.name)).map((attribute) => html!.slice(attribute.start, attribute.end));
    const element = `<script${kept.map((attribute) => ` ${attribute}`).join("")}>${escapeInlineScript(code)}</script>`;
    const elementEnd = tag.content?.closeEnd ?? tag.end;
    // Inline classic scripts run where they stand, so deferred ones move to
    // the end of the body to keep running after the page is parsed.
    if (!isModule && (getAttribute(tag, "defer") || getAttribute(tag, "async"))) {
      edits.push({ start: tag.start, end: elementEnd, text: "" });
      deferredScripts.push(element);
    } else {
      edits.push({ start: tag.start, end: elementEnd, text: element });
    }
  }

  async function processLink(tag: HtmlTag): Promise<void> {
    const href = getAttribute(tag, "href");
    if (!href?.hasValue || !href.value.trim()) return;
    const rel = (getAttribute(tag, "rel")?.value ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
    if (!rel.length || rel.every((token) => nonResourceLinkRels.has(token))) return;
    const target = reference(href.value, entryDir, entry);
    if (!target) return;
    if (rel.includes("stylesheet") && !rel.includes("alternate")) {
      const css = await readText(target.path);
      if (css === null) return;
      const baseDir = posix.dirname(target.path) === "." ? "" : posix.dirname(target.path);
      const processed = await processCss(css, target.path, baseDir, [target.path]);
      if (!assemble) return;
      const media = getAttribute(tag, "media");
      edits.push({
        start: tag.start,
        end: tag.end,
        text: `<style${media?.hasValue ? ` media="${escapeHtmlAttribute(media.value)}"` : ""}>${escapeInlineStyle(processed.replace(/@charset\s+["'][^"']*["']\s*;/giu, ""))}</style>`,
      });
      return;
    }
    if (!assemble) return;
    const url = await dataUrl(target.path);
    if (url) edits.push(attributeEdit(href, `${url}${target.fragment}`));
  }

  if (!assemble) return { html: null, problems };
  if (deferredScripts.length) {
    const bodyEnd = [...tags].reverse().find((tag) => tag.kind === "end" && tag.name === "body");
    const at = bodyEnd?.start ?? html.length;
    edits.push({ start: at, end: at, text: deferredScripts.join("\n") });
  }
  return { html: applyEdits(html, edits), problems };
}

function failureMessage(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  return /isn't UTF-8 text/u.test(message) ? "This file isn't UTF-8 text." : /larger than/u.test(message) ? message : "This file couldn't be read.";
}
