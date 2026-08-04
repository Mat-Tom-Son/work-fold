const tokenOpen = "\u0001";
const tokenClose = "\u0002";

export function renderMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const language = fence[1].trim().match(/^[A-Za-z0-9_+-]+$/)?.[0];
      blocks.push(`<pre><code${language ? ` class="language-${escapeAttribute(language)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (isTable(lines, index)) {
      const headers = tableCells(lines[index]);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      const width = headers.length;
      blocks.push(`<div class="markdown-table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${Array.from({ length: width }, (_, column) => `<td>${renderInline(row[column] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2].replace(/\s+#+\s*$/, ""))}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push("<hr />");
      index += 1;
      continue;
    }

    const unordered = line.match(/^\s{0,3}[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s{0,3}\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const tag = ordered ? "ol" : "ul";
      const items = [];
      while (index < lines.length) {
        const match = tag === "ol"
          ? lines[index].match(/^\s{0,3}\d+[.)]\s+(.+)$/)
          : lines[index].match(/^\s{0,3}[-+*]\s+(.+)$/);
        if (!match) break;
        items.push(`<li>${renderInline(match[1])}</li>`);
        index += 1;
      }
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s{0,3}>\s?(.*)$/);
        if (!match) break;
        quoted.push(match[1]);
        index += 1;
      }
      blocks.push(`<blockquote><p>${renderInline(quoted.join("\n"), true)}</p></blockquote>`);
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(`<p>${renderInline(paragraph.join("\n"), true)}</p>`);
  }

  return blocks.join("");
}

function startsBlock(lines, index) {
  const line = lines[index];
  return /^\s*```/.test(line)
    || /^\s{0,3}#{1,6}\s+/.test(line)
    || /^\s{0,3}[-+*]\s+/.test(line)
    || /^\s{0,3}\d+[.)]\s+/.test(line)
    || /^\s{0,3}>/.test(line)
    || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
    || isTable(lines, index);
}

function isTable(lines, index) {
  if (index + 1 >= lines.length || !lines[index].includes("|")) return false;
  const headers = tableCells(lines[index]);
  const delimiters = tableCells(lines[index + 1]);
  return headers.length > 0
    && headers.length === delimiters.length
    && delimiters.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function tableCells(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function renderInline(source, preserveBreaks = false) {
  const tokens = [];
  const stash = (html) => `${tokenOpen}${tokens.push(html) - 1}${tokenClose}`;
  let text = String(source).replaceAll(tokenOpen, "").replaceAll(tokenClose, "");

  text = text.replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    const safeHref = safeWebUrl(href);
    if (!safeHref) return stash(escapeHtml(match));
    return stash(`<a href="${escapeAttribute(safeHref)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`);
  });

  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?])/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, "$1<em>$2</em>");

  if (preserveBreaks) text = text.replace(/\n/g, "<br />");
  return text.replace(new RegExp(`${tokenOpen}(\\d+)${tokenClose}`, "g"), (_match, index) => tokens[Number(index)] ?? "");
}

function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
