/**
 * Small, forgiving scanners for a page's HTML and CSS: just enough to find
 * the references a page folder makes (docs/pages.md, "How a page runs") and
 * where they sit in the text, so the assembler can inline them. They never
 * execute anything and never fail; malformed markup yields fewer tags.
 */

export interface HtmlAttribute {
  /** Lowercased attribute name. */
  name: string;
  /** Entity-decoded value; "" for a bare attribute. */
  value: string;
  /** The whole attribute, `name="value"`, in the source. */
  start: number;
  end: number;
  /** The value as written, including any quotes; equal to `end` when there is no value. */
  valueStart: number;
  valueEnd: number;
  hasValue: boolean;
}

export interface HtmlTag {
  /** Lowercased tag name. */
  name: string;
  kind: "start" | "end";
  start: number;
  /** Just after the tag's `>`. */
  end: number;
  attributes: HtmlAttribute[];
  /** Raw text elements (`script`, `style`, …): the content's span and the end of the closing tag. */
  content?: { start: number; end: number; closeEnd: number };
}

const rawTextElements = new Set(["script", "style", "textarea", "title", "xmp", "noembed", "noframes"]);

export function scanHtml(html: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  const length = html.length;
  let index = 0;
  while (index < length) {
    const open = html.indexOf("<", index);
    if (open < 0) break;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      index = close < 0 ? length : close + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", open)) {
      const close = html.indexOf("]]>", open + 9);
      index = close < 0 ? length : close + 3;
      continue;
    }
    if (html[open + 1] === "!" || html[open + 1] === "?") {
      const close = html.indexOf(">", open + 2);
      index = close < 0 ? length : close + 1;
      continue;
    }
    const isEnd = html[open + 1] === "/";
    const nameStart = open + (isEnd ? 2 : 1);
    if (!/[A-Za-z]/u.test(html[nameStart] ?? "")) {
      index = open + 1;
      continue;
    }
    let cursor = nameStart;
    while (cursor < length && !/[\s/>]/u.test(html[cursor]!)) cursor += 1;
    const name = html.slice(nameStart, cursor).toLowerCase();
    const attributes: HtmlAttribute[] = [];
    // Attributes, until the tag's `>`.
    while (cursor < length) {
      while (cursor < length && /[\s/]/u.test(html[cursor]!)) cursor += 1;
      if (cursor >= length || html[cursor] === ">") break;
      const attributeStart = cursor;
      // An attribute name may begin with `=`; it ends at whitespace, `/`, `>`, or `=`.
      cursor += 1;
      while (cursor < length && !/[\s/>=]/u.test(html[cursor]!)) cursor += 1;
      const attributeName = html.slice(attributeStart, cursor).toLowerCase();
      let probe = cursor;
      while (probe < length && /\s/u.test(html[probe]!)) probe += 1;
      if (html[probe] !== "=") {
        attributes.push({ name: attributeName, value: "", start: attributeStart, end: cursor, valueStart: cursor, valueEnd: cursor, hasValue: false });
        continue;
      }
      probe += 1;
      while (probe < length && /\s/u.test(html[probe]!)) probe += 1;
      const valueStart = probe;
      let raw: string;
      if (html[probe] === "\"" || html[probe] === "'") {
        const quote = html[probe]!;
        const close = html.indexOf(quote, probe + 1);
        const valueEnd = close < 0 ? length : close + 1;
        raw = html.slice(probe + 1, close < 0 ? length : close);
        cursor = valueEnd;
      } else {
        while (probe < length && !/[\s>]/u.test(html[probe]!)) probe += 1;
        raw = html.slice(valueStart, probe);
        cursor = probe;
      }
      attributes.push({
        name: attributeName,
        value: decodeHtmlEntities(raw),
        start: attributeStart,
        end: cursor,
        valueStart,
        valueEnd: cursor,
        hasValue: true,
      });
    }
    const end = Math.min(cursor + 1, length);
    const tag: HtmlTag = { name, kind: isEnd ? "end" : "start", start: open, end, attributes };
    index = end;
    if (!isEnd && rawTextElements.has(name)) {
      const closePattern = new RegExp(`</${name}[\\s/>]`, "giu");
      closePattern.lastIndex = end;
      const close = closePattern.exec(html);
      const contentEnd = close ? close.index : length;
      const closeEnd = close ? (html.indexOf(">", close.index) + 1 || length) : length;
      tag.content = { start: end, end: contentEnd, closeEnd };
      index = closeEnd;
    }
    tags.push(tag);
  }
  return tags;
}

const namedEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" };

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return namedEntities[body.toLowerCase()] ?? match;
  });
}

/** Escapes text for a double-quoted attribute value. */
export function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function getAttribute(tag: HtmlTag, name: string): HtmlAttribute | undefined {
  return tag.attributes.find((attribute) => attribute.name === name);
}

/** One `srcset` candidate: the URL's span inside the attribute value. */
export interface SrcsetCandidate {
  url: string;
  start: number;
  end: number;
}

export function parseSrcset(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/u.test(value[index]!)) index += 1;
    if (index >= value.length) break;
    const start = index;
    while (index < value.length && !/\s/u.test(value[index]!)) index += 1;
    let end = index;
    // A URL ending in commas has them as separators, not part of the URL.
    while (end > start && value[end - 1] === ",") end -= 1;
    const url = value.slice(start, end);
    if (url) candidates.push({ url, start, end });
    if (end < index) continue;
    // Skip the descriptor up to the next comma.
    let depth = 0;
    while (index < value.length) {
      const character = value[index]!;
      if (character === "(") depth += 1;
      else if (character === ")") depth = Math.max(0, depth - 1);
      else if (character === "," && depth === 0) break;
      index += 1;
    }
  }
  return candidates;
}

export type CssReference =
  | { kind: "url"; url: string; start: number; end: number }
  | { kind: "import"; url: string; conditions: string; start: number; end: number };

/** `url(…)` tokens and `@import` rules in a stylesheet, skipping comments and strings. */
export function scanCss(css: string): CssReference[] {
  const references: CssReference[] = [];
  const length = css.length;
  let index = 0;
  while (index < length) {
    const character = css[index]!;
    if (character === "/" && css[index + 1] === "*") {
      const close = css.indexOf("*/", index + 2);
      index = close < 0 ? length : close + 2;
      continue;
    }
    if (character === "\"" || character === "'") {
      index = skipCssString(css, index).end;
      continue;
    }
    if (character === "@" && /^@import\b/iu.test(css.slice(index, index + 8))) {
      const start = index;
      let cursor = index + 7;
      while (cursor < length && /\s/u.test(css[cursor]!)) cursor += 1;
      let url: string | null = null;
      if (css[cursor] === "\"" || css[cursor] === "'") {
        const string = skipCssString(css, cursor);
        url = string.value;
        cursor = string.end;
      } else if (/^url\(/iu.test(css.slice(cursor, cursor + 4))) {
        const token = readCssUrl(css, cursor);
        url = token.url;
        cursor = token.end;
      }
      const semicolon = findCssStatementEnd(css, cursor);
      if (url !== null) {
        references.push({ kind: "import", url, conditions: css.slice(cursor, semicolon).trim(), start, end: Math.min(semicolon + 1, length) });
      }
      index = Math.min(semicolon + 1, length);
      continue;
    }
    if ((character === "u" || character === "U") && /^url\(/iu.test(css.slice(index, index + 4)) && !/[\w-]/u.test(css[index - 1] ?? "")) {
      const token = readCssUrl(css, index);
      references.push({ kind: "url", url: token.url, start: index, end: token.end });
      index = token.end;
      continue;
    }
    index += 1;
  }
  return references;
}

function skipCssString(css: string, start: number): { value: string; end: number } {
  const quote = css[start]!;
  let index = start + 1;
  let value = "";
  while (index < css.length && css[index] !== quote) {
    if (css[index] === "\\" && index + 1 < css.length) {
      value += css[index + 1];
      index += 2;
      continue;
    }
    if (css[index] === "\n") break;
    value += css[index];
    index += 1;
  }
  return { value, end: Math.min(index + 1, css.length) };
}

function readCssUrl(css: string, start: number): { url: string; end: number } {
  let index = start + 4;
  while (index < css.length && /\s/u.test(css[index]!)) index += 1;
  let url: string;
  if (css[index] === "\"" || css[index] === "'") {
    const string = skipCssString(css, index);
    url = string.value;
    index = string.end;
    while (index < css.length && css[index] !== ")") index += 1;
  } else {
    const close = css.indexOf(")", index);
    const end = close < 0 ? css.length : close;
    url = css.slice(index, end).trim();
    index = end;
  }
  return { url, end: Math.min(index + 1, css.length) };
}

function findCssStatementEnd(css: string, start: number): number {
  let index = start;
  while (index < css.length) {
    const character = css[index]!;
    if (character === ";") return index;
    if (character === "\"" || character === "'") {
      index = skipCssString(css, index).end;
      continue;
    }
    if (character === "{" || character === "}") return index - 1;
    index += 1;
  }
  return css.length;
}

const moduleImportPattern = /(?:^|[;\s})])(?:import\b\s*(?:[\w$*{}\s,]+?\s*from\s*)?["'`]|export\b\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'`])/u;

/** Whether a module script has a static `import`/`export … from` of another file. */
export function moduleScriptImportsFiles(source: string): boolean {
  return moduleImportPattern.test(source);
}
