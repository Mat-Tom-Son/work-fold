/**
 * Person-authored HTML as a rung-2 page (docs/fold-publishing.md). The page
 * stays inert three times over: this desktop-side strip runs before
 * encryption, the viewer shell places the document in a sandboxed frame
 * without `allow-scripts`, and the viewer origin's CSP allows no inline or
 * remote script. Anything interactive is an app (rung 3).
 *
 * The strip is a small tokenizer over tags, not one regex per pattern. It
 * reads the source the way a browser tokenizer does and then re-serializes
 * every token it keeps, so the output holds these properties whatever the
 * source did:
 *
 * - every `<` begins a tag this module wrote: text escapes `<` and `>`,
 *   attribute values are always double-quoted with `"`, `<`, and `>`
 *   escaped, `<style>` content carries no `<` at all (it becomes the CSS
 *   escape `\3c `), and `<title>`/`<textarea>` content is escaped;
 * - comments, processing instructions, CDATA, and doctypes are dropped
 *   (the shell writes its own doctype);
 * - no `script`, `iframe`, `object`, `embed`, `applet`, `base`, `link`,
 *   `form`, `noscript`, `frame`, `frameset`, `portal`, `fencedframe`,
 *   `xmp`, `plaintext`, `noembed`, `noframes`, or SVG `animate`/`set`
 *   element survives, and no `<meta http-equiv>`;
 * - no `on*`, `srcdoc`, `formaction`, `formtarget`, or `ping` attribute
 *   survives, nor any attribute whose value (entity-decoded, whitespace and
 *   control characters removed) begins with `javascript:`, `vbscript:`,
 *   `data:text/html`, `data:application/xhtml+xml`, or `data:text/xml`, or
 *   whose apparent scheme still holds an entity after decoding;
 * - every `<a>`/`<area>` with a link opens a new window with
 *   `rel="noopener noreferrer"`, so a link cannot navigate the viewer.
 *
 * Headings, inline styles, `<style>`, `<img src="data:…">`, tables, SVG
 * drawings, and links are kept. External `src`/`href` stay as written; the
 * viewer CSP blocks remote loads.
 */

/** The same desktop-side pre-render bound as every other page source. */
export const WORKFOLD_PUBLICATION_HTML_MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export class WorkFoldPublicationHtmlTooLargeError extends Error {
  constructor() {
    super("The designated file is larger than a shareable page (8 MiB).");
    this.name = "WorkFoldPublicationHtmlTooLargeError";
  }
}

/** Removed with everything up to their end tag; the browser reads their content as raw text. */
const DROPPED_RAW_TEXT_ELEMENTS = new Set(["script", "iframe", "noembed", "noframes"]);

/** Removed as tags; their inner content is kept and read as ordinary markup. */
const DROPPED_TAGS = new Set([
  "object",
  "embed",
  "applet",
  "base",
  "link",
  "form",
  "noscript",
  "frame",
  "frameset",
  "portal",
  "fencedframe",
  "param",
  "isindex",
  "animate",
  "set",
  "animatemotion",
  "animatetransform",
]);

/** Kept, with their raw content escaped so it can only ever be text. */
const ESCAPED_RAW_ELEMENTS = new Set(["title", "textarea"]);

const DROPPED_ATTRIBUTES = new Set(["srcdoc", "formaction", "formtarget", "ping"]);

const DANGEROUS_VALUE_PREFIXES = [
  "javascript:",
  "vbscript:",
  "data:text/html",
  "data:application/xhtml+xml",
  "data:text/xml",
];

const TAG_NAME = /^[a-z][a-z0-9-]*$/;
const ATTRIBUTE_NAME = /^[a-z_:][a-z0-9_:.-]*$/;

interface ParsedAttribute {
  name: string;
  value: string | null;
}

interface ParsedTag {
  attributes: ParsedAttribute[];
  selfClosing: boolean;
  end: number;
}

/**
 * The whole inert page: one self-contained document with the stripped
 * source as its content. Throws past the 8 MiB pre-render bound.
 */
export function renderInertHtmlDocument(source: string): string {
  return `<!DOCTYPE html>\n<meta charset="utf-8">\n<meta name="referrer" content="no-referrer">\n${stripPublicationHtml(source)}`;
}

/** The strip alone, without the document shell. Throws past the 8 MiB pre-render bound. */
export function stripPublicationHtml(source: string): string {
  const text = String(source ?? "");
  if (Buffer.byteLength(text, "utf8") > WORKFOLD_PUBLICATION_HTML_MAX_SOURCE_BYTES) {
    throw new WorkFoldPublicationHtmlTooLargeError();
  }
  const out: string[] = [];
  const length = text.length;
  let position = 0;

  while (position < length) {
    const open = text.indexOf("<", position);
    if (open < 0) {
      out.push(escapeText(text.slice(position)));
      break;
    }
    if (open > position) out.push(escapeText(text.slice(position, open)));
    position = open;
    const next = text.charAt(position + 1);

    if (isAsciiLetter(next)) {
      // A start tag. The name runs to whitespace, `/`, or `>` exactly as a
      // browser reads it, so `<scr<script>` is one (discarded) odd name.
      let nameEnd = position + 1;
      while (nameEnd < length && !isTagNameTerminator(text.charAt(nameEnd))) nameEnd += 1;
      const rawName = text.slice(position + 1, nameEnd);
      const name = rawName.toLowerCase();
      const tag = parseTagBody(text, nameEnd);
      if (!tag) break; // End of file inside a tag: a browser emits nothing more either.
      position = tag.end;

      if (DROPPED_RAW_TEXT_ELEMENTS.has(name)) {
        position = skipPastEndTag(text, position, name);
        continue;
      }
      if (name === "style") {
        const close = findEndTag(text, position, name);
        const css = text.slice(position, close < 0 ? length : close);
        out.push(serializeStartTag(name, tag), css.replace(/</g, "\\3c "), "</style>");
        position = close < 0 ? length : skipEndTagAt(text, close);
        continue;
      }
      if (ESCAPED_RAW_ELEMENTS.has(name)) {
        const close = findEndTag(text, position, name);
        const content = text.slice(position, close < 0 ? length : close);
        out.push(serializeStartTag(name, tag), escapeText(content), `</${name}>`);
        position = close < 0 ? length : skipEndTagAt(text, close);
        continue;
      }
      if (name === "xmp") {
        const close = findEndTag(text, position, name);
        out.push(escapeText(text.slice(position, close < 0 ? length : close)));
        position = close < 0 ? length : skipEndTagAt(text, close);
        continue;
      }
      if (name === "plaintext") {
        out.push(escapeText(text.slice(position)));
        position = length;
        continue;
      }
      if (!TAG_NAME.test(name) || DROPPED_TAGS.has(name)) continue;
      if (name === "meta" && tag.attributes.some((attribute) => attribute.name.toLowerCase() === "http-equiv")) continue;
      out.push(serializeStartTag(name, tag));
      continue;
    }

    if (next === "/") {
      const after = text.charAt(position + 2);
      if (isAsciiLetter(after)) {
        let nameEnd = position + 2;
        while (nameEnd < length && !isTagNameTerminator(text.charAt(nameEnd))) nameEnd += 1;
        const name = text.slice(position + 2, nameEnd).toLowerCase();
        const tag = parseTagBody(text, nameEnd);
        if (!tag) break;
        position = tag.end;
        if (!TAG_NAME.test(name) || DROPPED_TAGS.has(name) || DROPPED_RAW_TEXT_ELEMENTS.has(name)
          || name === "xmp" || name === "plaintext") continue;
        out.push(`</${name}>`);
        continue;
      }
      if (after === ">") {
        position += 3;
        continue;
      }
      if (position + 2 >= length) {
        out.push("&lt;/");
        position = length;
        continue;
      }
      // `</` followed by anything else is a bogus comment up to `>`.
      position = skipBogusComment(text, position + 2);
      continue;
    }

    if (next === "!") {
      if (text.startsWith("<!--", position)) {
        position = skipComment(text, position + 4);
        continue;
      }
      // Doctype, CDATA, and every other `<!…>` form: dropped.
      position = skipBogusComment(text, position + 2);
      continue;
    }

    if (next === "?") {
      position = skipBogusComment(text, position + 2);
      continue;
    }

    // A lone `<` is text.
    out.push("&lt;");
    position += 1;
  }

  return out.join("");
}

/**
 * Attributes and the closing `>` of one tag, read the way a browser
 * tokenizer reads them. Null when the file ends inside the tag.
 */
function parseTagBody(text: string, start: number): ParsedTag | null {
  const length = text.length;
  const attributes: ParsedAttribute[] = [];
  let position = start;
  let selfClosing = false;
  while (true) {
    while (position < length && isWhitespace(text.charAt(position))) position += 1;
    if (position >= length) return null;
    const character = text.charAt(position);
    if (character === ">") {
      position += 1;
      break;
    }
    if (character === "/") {
      position += 1;
      if (text.charAt(position) === ">") {
        selfClosing = true;
        position += 1;
        break;
      }
      continue;
    }
    // The first name character is taken as-is, even `=`, as a browser does.
    const nameStart = position;
    position += 1;
    while (position < length && !isAttributeNameTerminator(text.charAt(position))) position += 1;
    const name = text.slice(nameStart, position);
    while (position < length && isWhitespace(text.charAt(position))) position += 1;
    let value: string | null = null;
    if (text.charAt(position) === "=") {
      position += 1;
      while (position < length && isWhitespace(text.charAt(position))) position += 1;
      const quote = text.charAt(position);
      if (quote === "\"" || quote === "'") {
        const close = text.indexOf(quote, position + 1);
        if (close < 0) return null;
        value = text.slice(position + 1, close);
        position = close + 1;
      } else if (quote === ">") {
        value = "";
      } else {
        const valueStart = position;
        while (position < length && !isWhitespace(text.charAt(position)) && text.charAt(position) !== ">") position += 1;
        value = text.slice(valueStart, position);
      }
    }
    attributes.push({ name, value });
  }
  return { attributes, selfClosing, end: position };
}

function serializeStartTag(name: string, tag: ParsedTag): string {
  const kept: string[] = [];
  const isLink = name === "a" || name === "area";
  let hasHref = false;
  for (const attribute of tag.attributes) {
    const attributeName = attribute.name.toLowerCase();
    if (!ATTRIBUTE_NAME.test(attributeName)) continue;
    if (attributeName.startsWith("on")) continue;
    if (DROPPED_ATTRIBUTES.has(attributeName)) continue;
    if (attribute.value !== null && isDangerousValue(attribute.value)) continue;
    if (isLink && (attributeName === "target" || attributeName === "rel")) continue;
    if (isLink && (attributeName === "href" || attributeName === "xlink:href")) hasHref = true;
    kept.push(attribute.value === null ? attributeName : `${attributeName}="${escapeAttributeValue(attribute.value)}"`);
  }
  if (isLink && hasHref) kept.push("target=\"_blank\"", "rel=\"noopener noreferrer\"");
  return `<${name}${kept.length ? ` ${kept.join(" ")}` : ""}${tag.selfClosing ? "/" : ""}>`;
}

/**
 * True when a value could name a script or document URL. The check decodes
 * character references, removes every whitespace and control character,
 * and refuses an apparent scheme that still holds an unresolved reference.
 */
export function isDangerousValue(raw: string): boolean {
  const decoded = decodeCharacterReferences(raw)
    .replace(/[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g, "")
    .toLowerCase();
  if (DANGEROUS_VALUE_PREFIXES.some((prefix) => decoded.startsWith(prefix))) return true;
  const colon = decoded.indexOf(":");
  if (colon > 0 && decoded.slice(0, colon).includes("&")) return true;
  return false;
}

const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  colon: ":",
  tab: "\t",
  newline: "\n",
  nbsp: "\u00a0",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  sol: "/",
  bsol: "\\",
  lpar: "(",
  rpar: ")",
  semi: ";",
  comma: ",",
  period: ".",
  excl: "!",
  num: "#",
  percnt: "%",
  equals: "=",
  quest: "?",
  commat: "@",
  fjlig: "fj",
};

function decodeCharacterReferences(value: string): string {
  // Numeric references with or without the closing `;`, and the named
  // references that can spell or split a scheme. Repeated once so a
  // double-encoded `&amp;#106;` also reads as what a lenient reader might.
  let current = value;
  for (let pass = 0; pass < 2; pass += 1) {
    current = current
      .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => codePointText(Number.parseInt(hex, 16)))
      .replace(/&#([0-9]+);?/g, (_, decimal: string) => codePointText(Number.parseInt(decimal, 10)))
      .replace(/&([a-z]+);?/gi, (match, name: string) => NAMED_REFERENCES[name.toLowerCase()] ?? match);
  }
  return current;
}

function codePointText(codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return "\ufffd";
  return String.fromCodePoint(codePoint);
}

/** Index of the matching end tag (`</name` then whitespace, `/`, or `>`), or -1. */
function findEndTag(text: string, from: number, name: string): number {
  const pattern = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "gi");
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

/** Past the `>` of the end tag that starts at `index`. */
function skipEndTagAt(text: string, index: number): number {
  let nameEnd = index + 2;
  while (nameEnd < text.length && !isTagNameTerminator(text.charAt(nameEnd))) nameEnd += 1;
  const tag = parseTagBody(text, nameEnd);
  return tag ? tag.end : text.length;
}

function skipPastEndTag(text: string, from: number, name: string): number {
  const close = findEndTag(text, from, name);
  return close < 0 ? text.length : skipEndTagAt(text, close);
}

function skipComment(text: string, from: number): number {
  if (text.charAt(from) === ">") return from + 1;
  if (text.startsWith("->", from)) return from + 2;
  const pattern = /--!?>/g;
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match ? match.index + match[0].length : text.length;
}

function skipBogusComment(text: string, from: number): number {
  const close = text.indexOf(">", from);
  return close < 0 ? text.length : close + 1;
}

function escapeText(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttributeValue(value: string): string {
  return value.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isAsciiLetter(character: string): boolean {
  return /^[A-Za-z]$/.test(character);
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\f" || character === "\r";
}

function isTagNameTerminator(character: string): boolean {
  return isWhitespace(character) || character === "/" || character === ">";
}

function isAttributeNameTerminator(character: string): boolean {
  return isWhitespace(character) || character === "/" || character === ">" || character === "=";
}
