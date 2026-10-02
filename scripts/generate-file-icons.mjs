#!/usr/bin/env node
// Regenerates web-local/src/file-icons-data.ts: the vendored SVG markup for
// exactly the glyph ids that web-local/src/file-tree-icons.ts references.
//
// Usage:
//   node scripts/generate-file-icons.mjs
//   node scripts/generate-file-icons.mjs --from <dir>
//
// Without --from, the pinned Iconify JSON packages below are downloaded from
// the jsDelivr npm mirror; nothing is installed and the app never fetches
// icons at runtime. With --from, <dir> must hold each package's icons.json
// saved under the file name listed in `sources`.
// Licenses and attribution live in THIRD_PARTY_NOTICES.md.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mappingPath = join(rootDir, "web-local/src/file-tree-icons.ts");
const outputPath = join(rootDir, "web-local/src/file-icons-data.ts");

// One source: vscode-icons, full-color, drawn in its own fills.
const sources = {
  vs: { file: "vscode-icons.json", pkg: "@iconify-json/vscode-icons", version: "1.2.83", sha256: "d7143aa0208e83d421c7e9e4c5cba050f451703a458a39c9aee97bebd2f81673", credit: "vscode-icons by Roberto Huertas and contributors (MIT)" },
};

const args = process.argv.slice(2);
const fromIndex = args.indexOf("--from");
const fromDir = fromIndex >= 0 ? resolve(args[fromIndex + 1] ?? "") : null;

async function loadSet(prefix) {
  const source = sources[prefix];
  let text;
  if (fromDir) text = await readFile(join(fromDir, source.file), "utf8");
  else {
    const url = `https://cdn.jsdelivr.net/npm/${source.pkg}@${source.version}/icons.json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download ${url}: ${response.status}`);
    text = await response.text();
  }
  // The pinned version is also pinned by content, so a changed or tampered
  // download can never reach the vendored module.
  const digest = createHash("sha256").update(text).digest("hex");
  if (digest !== source.sha256) throw new Error(`${source.pkg}@${source.version} does not match its pinned sha256 (${digest}).`);
  return JSON.parse(text);
}

function findIcon(set, name) {
  let current = name;
  for (let depth = 0; depth < 8; depth += 1) {
    if (set.icons[current]) return set.icons[current];
    const alias = set.aliases?.[current];
    if (!alias) return undefined;
    if (Object.keys(alias).some((key) => key !== "parent")) throw new Error(`Alias ${name} transforms its parent; vendor it by hand.`);
    current = alias.parent;
  }
  return undefined;
}

// The markup is injected as SVG children, so it is parsed as real SVG and
// walked node by node: only inert drawing elements and attributes survive,
// presentation `class`/`style` are dropped, and anything else stops the
// generator. Values are checked after the parser has decoded entities.
const svgNamespace = "http://www.w3.org/2000/svg";
const xlinkNamespace = "http://www.w3.org/1999/xlink";
const allowedElements = new Set([
  "path", "g", "defs", "circle", "ellipse", "rect", "line", "polygon", "polyline", "use", "symbol",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "filter",
  "feGaussianBlur", "feFlood", "feBlend", "feColorMatrix", "feOffset", "feComposite", "feMerge", "feMergeNode",
]);
const allowedAttributes = new Set([
  "d", "fill", "fill-rule", "fill-opacity", "clip-rule", "clip-path", "mask", "filter", "opacity", "transform",
  "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity",
  "id", "href", "xlink:href", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "width", "height", "points", "viewBox",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod",
  "maskUnits", "maskContentUnits", "clipPathUnits", "filterUnits", "primitiveUnits", "color-interpolation-filters",
  "stdDeviation", "result", "in", "in2", "mode", "values", "type", "dx", "dy", "operator", "k1", "k2", "k3", "k4",
  "flood-color", "flood-opacity", "color", "display", "paint-order", "preserveAspectRatio",
]);
const droppedAttributes = new Set(["class", "style"]);

function parseBody(id, body) {
  const dom = new JSDOM(`<svg xmlns="${svgNamespace}" xmlns:xlink="${xlinkNamespace}">${body}</svg>`, { contentType: "image/svg+xml" });
  const root = dom.window.document.documentElement;
  if (root.localName !== "svg" || dom.window.document.getElementsByTagName("parsererror").length) throw new Error(`${id} is not well-formed SVG`);
  return { dom, root };
}

function sanitizeTree(id, root) {
  const visit = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        if (child.nodeValue.trim()) throw new Error(`${id} has text content`);
        child.remove();
        continue;
      }
      if (child.nodeType !== 1) throw new Error(`${id} has a comment, CDATA, or processing instruction`);
      if (child.namespaceURI !== svgNamespace || !allowedElements.has(child.localName)) throw new Error(`${id} uses unsupported element <${child.nodeName}>`);
      for (const attribute of [...child.attributes]) {
        const name = attribute.name;
        if (droppedAttributes.has(name)) { child.removeAttributeNode(attribute); continue; }
        if (!allowedAttributes.has(name)) throw new Error(`${id} uses unsupported attribute ${name}`);
        const value = attribute.value;
        if ((name === "href" || name === "xlink:href") && !value.startsWith("#")) throw new Error(`${id} links outside itself: ${value}`);
        if (/url\s*\(\s*(?!#)/i.test(value) || /javascript:|expression\s*\(|\\/i.test(value)) throw new Error(`${id} has an unsafe value in ${name}`);
      }
      visit(child);
    }
  };
  visit(root);
}

// Many inline SVGs share one document, and a copy inside a hidden subtree can
// shadow a visible one's gradient. Every internal id therefore gets the
// placeholder prefix __WFID__, which the renderer replaces with an id unique
// to each rendered icon; every reference is rewritten to match.
function scopeIds(root, scope) {
  const elements = [...root.getElementsByTagName("*")];
  const known = new Set(elements.map((element) => element.getAttribute("id")).filter(Boolean));
  if (!known.size) return false;
  const scoped = (name) => (known.has(name) ? `${scope}-${name}` : name);
  for (const element of elements) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name === "id") attribute.value = scoped(attribute.value);
      else if (attribute.name === "href" || attribute.name === "xlink:href") attribute.value = `#${scoped(attribute.value.slice(1))}`;
      else if (attribute.value.includes("url(")) attribute.value = attribute.value.replace(/url\(\s*#([^)\s]+)\s*\)/g, (_, name) => `url(#${scoped(name)})`);
    }
  }
  return true;
}

// Glyphs drawn on a 32-unit grid carry more precision than an 18px icon can
// show. Paths are parsed command by command — arc flags included — and
// rewritten with rounded numbers.
const pathArity = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
function compactPathData(id, d, gridSize) {
  // A tenth of a grid unit on a 24–32 unit grid is under a twentieth of a
  // pixel at 18px, invisible but much smaller.
  const decimals = gridSize >= 100 ? 0 : gridSize >= 24 ? 1 : 2;
  let index = 0;
  const skip = () => { while (index < d.length && /[\s,]/.test(d[index])) index += 1; };
  const readNumber = () => {
    skip();
    const match = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(d.slice(index));
    if (!match) throw new Error(`${id} has a path number it cannot read near "${d.slice(index, index + 12)}"`);
    index += match[0].length;
    return Number(match[0]);
  };
  const readFlag = () => {
    skip();
    const flag = d[index];
    if (flag !== "0" && flag !== "1") throw new Error(`${id} has a malformed arc flag`);
    index += 1;
    return Number(flag);
  };
  const format = (value) => {
    let text = String(Number(value.toFixed(decimals)));
    if (text === "-0") text = "0";
    return text.replace(/^(-?)0\./, "$1.");
  };
  const out = [];
  let command = null;
  while (true) {
    skip();
    if (index >= d.length) break;
    if (/[a-zA-Z]/.test(d[index])) {
      command = d[index];
      index += 1;
      if (!(command.toLowerCase() in pathArity)) throw new Error(`${id} uses path command ${command}`);
      out.push(command);
      if (command.toLowerCase() === "z") continue;
    } else if (!command || command.toLowerCase() === "z") {
      throw new Error(`${id} has path numbers without a command`);
    }
    const lower = command.toLowerCase();
    const values = [];
    for (let position = 0; position < pathArity[lower]; position += 1) {
      values.push(lower === "a" && (position === 3 || position === 4) ? String(readFlag()) : format(readNumber()));
    }
    for (const value of values) {
      const last = out[out.length - 1];
      const needsSeparator = !/[a-zA-Z]$/.test(last) && !value.startsWith("-") && !(value.startsWith(".") && /\.\d*$/.test(last) && !/[eE]/.test(last));
      out.push(needsSeparator ? ` ${value}` : value);
    }
    // Implicit repeats: an M becomes an L after its first pair.
    if (command === "M") command = "L";
    else if (command === "m") command = "l";
  }
  return out.join("");
}

function serializeChildren(dom, root) {
  const serializer = new dom.window.XMLSerializer();
  return [...root.childNodes].map((node) => serializer.serializeToString(node)).join("")
    .replace(/ xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "")
    .replace(/ xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink"/g, "");
}

// Relative luminance (WCAG) of every color a glyph paints with. A glyph whose
// brightest color is near black disappears on the dark sidebar, and one whose
// darkest color is near white disappears on the light one; those are flagged
// so the frame can lift or deepen them without changing their hues.
function paintLuminances(root) {
  const values = [];
  for (const element of root.getElementsByTagName("*")) {
    for (const name of ["fill", "stroke", "stop-color", "color"]) {
      const value = element.getAttribute(name);
      const match = value && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
      if (!match) continue;
      const hex = match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1];
      const [r, g, b] = [0, 2, 4].map((offset) => {
        const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      values.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    }
  }
  return values;
}

function glyphRecord(id, set, iconData, scope) {
  const width = iconData.width ?? set.width ?? 16;
  const height = iconData.height ?? set.height ?? 16;
  const viewBox = `${iconData.left ?? set.left ?? 0} ${iconData.top ?? set.top ?? 0} ${width} ${height}`;
  const { dom, root } = parseBody(id, iconData.body);
  sanitizeTree(id, root);
  for (const element of root.getElementsByTagName("path")) {
    const d = element.getAttribute("d");
    if (d) element.setAttribute("d", compactPathData(id, d, Math.max(width, height)));
  }
  const scoped = scopeIds(root, scope);
  const luminances = paintLuminances(root);
  const contrast = luminances.length && Math.max(...luminances) < 0.06 ? "dark" : luminances.length && Math.min(...luminances) > 0.5 ? "pale" : null;
  const body = serializeChildren(dom, root);
  // Re-parse the result: what ships must pass the same walk it was built from.
  sanitizeTree(`${id} (output)`, parseBody(id, body.replaceAll("__WFID__", "wf")).root);
  if (Buffer.byteLength(body) > maxGlyphBytes) oversized.push(`${id} (${Buffer.byteLength(body)} bytes)`);
  return { viewBox, body, scoped, contrast };
}

// One Files row must never inject a heavyweight drawing.
const maxGlyphBytes = 12 * 1024;
const oversized = [];

const mapping = await readFile(mappingPath, "utf8");
const ids = [...new Set([...mapping.matchAll(/"(vs:[a-z0-9-]+)"/g)].map((match) => match[1]))].sort();
const sets = {};
for (const prefix of Object.keys(sources)) sets[prefix] = await loadSet(prefix);

const counts = Object.fromEntries(Object.keys(sources).map((prefix) => [prefix, 0]));
let lightCount = 0;
const lines = [];
for (const id of ids) {
  const [prefix, name] = id.split(":");
  const set = sets[prefix];
  const iconData = findIcon(set, name);
  if (!iconData) throw new Error(`Icon ${id} does not exist.`);
  const glyph = glyphRecord(id, set, iconData, "__WFID__");
  counts[prefix] += 1;
  const fields = [`viewBox: ${JSON.stringify(glyph.viewBox)}`, `body: ${JSON.stringify(glyph.body)}`];
  if (glyph.scoped) fields.push("scoped: true");
  if (glyph.contrast) fields.push(`contrast: ${JSON.stringify(glyph.contrast)}`);
  // vscode-icons draws some types twice: the plain icon for dark themes and a
  // `file-type-light-*` variant for light themes.
  const lightName = name.startsWith("file-type-") ? name.replace(/^file-type-/, "file-type-light-") : null;
  const lightData = prefix === "vs" && lightName ? findIcon(set, lightName) : undefined;
  if (lightData) {
    const light = glyphRecord(`${id}-light`, set, lightData, "__WFID__-l");
    fields.push(`light: { viewBox: ${JSON.stringify(light.viewBox)}, body: ${JSON.stringify(light.body)}${light.scoped ? ", scoped: true" : ""} }`);
    lightCount += 1;
  }
  lines.push(`  ${JSON.stringify(id)}: { ${fields.join(", ")} },`);
}

if (oversized.length) {
  throw new Error(`These glyphs exceed ${maxGlyphBytes} bytes after compaction; map their kinds to lighter glyphs:\n  ${oversized.join("\n  ")}`);
}

const header = `// Generated by scripts/generate-file-icons.mjs from the glyph ids used in
// file-tree-icons.ts. Do not edit by hand; rerun the script instead.
//
// Sources (see THIRD_PARTY_NOTICES.md for licenses and attribution):
${Object.entries(sources).map(([prefix, source]) => `//   ${prefix}: ${source.credit} — ${source.pkg}@${source.version}`).join("\n")}
//
// Bodies are sanitized SVG children. Internal ids start with the placeholder
// __WFID__; use fileIconArtworkMarkup() to make them unique per rendered icon.

export interface FileIconArtwork {
  viewBox: string;
  /** Inert SVG child markup. */
  body: string;
  /** The body defines ids prefixed with __WFID__. */
  scoped?: true;
  /** Every paint is near black ("dark") or near white ("pale"), so one theme needs a lift. */
  contrast?: "dark" | "pale";
}

export interface FileIconGlyph extends FileIconArtwork {
  /** A variant drawn for light themes. */
  light?: FileIconArtwork;
}

export function fileIconArtworkMarkup(artwork: FileIconArtwork, instanceId: string): string {
  return artwork.scoped ? artwork.body.replaceAll("__WFID__", instanceId) : artwork.body;
}

export const fileIconGlyphs: Readonly<Record<string, FileIconGlyph>> = {
`;

await writeFile(outputPath, `${header}${lines.join("\n")}\n};\n`);
console.log(`Wrote ${ids.length} glyphs (${Object.entries(counts).map(([prefix, count]) => `${prefix} ${count}`).join(", ")}; ${lightCount} light variants) to ${outputPath.slice(rootDir.length + 1)}`);
