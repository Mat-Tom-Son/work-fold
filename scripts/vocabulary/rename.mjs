// Re-runnable vocabulary migration: rewrites identifiers, identifier-like
// strings, CSS tokens, file names, and (with --prose) prose to the interface's
// vocabulary (scripts/vocabulary/GLOSSARY.md). Run it on any branch to bring
// that branch's code across:
//
//   node scripts/vocabulary/rename.mjs --dry-run --report <file>
//   node scripts/vocabulary/rename.mjs            # code, strings, CSS, paths
//   node scripts/vocabulary/rename.mjs --prose    # then prose (review the diff)
//
// Explicit decisions live in overrides.json; everything else follows the word
// rules below, preserving each token's case style.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scriptExtensions, scriptRegions, tokenPattern, trackedFiles } from "./scan.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const here = dirname(fileURLToPath(import.meta.url));

/** Word rules applied to every token (lowercased word sequences). */
export const wordRules = [
  { from: ["spaces"], to: ["work", "folders"] },
  { from: ["space"], to: ["work", "folder"] },
  { from: ["routings"], to: ["automations"] },
  { from: ["routing"], to: ["automation"] },
  { from: ["trash"], to: ["recently", "deleted"] },
  { from: ["glance"], to: ["overview"] },
];

/** Word sequences that are never product vocabulary. */
export const keepSequences = [
  ["work", "fold"],
  ["white", "space"],
  ["space", "between"],
  ["space", "around"],
  ["space", "evenly"],
  ["user", "space", "on", "use"],
  ["color", "space"],
  ["name", "space"],
];

/** Lines whose literal text stays exactly as written (keyboard codes, etc.). */
export const protectedLines = [
  /event\.code\s*[!=]==?\s*"Space"/,
  // Where app-managed work-folders live: moving it would move user content and
  // re-key every path-derived store (History, per-folder state, Pi sessions).
  /join\(workFoldStateRoot\(\), "spaces"\)/,
  // Path-derived storage keys must keep deriving the same key for existing folders.
  /cleaned \|\| "space";/,
  /\.slice\(0, (?:40|48)\) \|\| "space";/,
  // An emoji search keyword, not a capability scope.
  /option\("smile", "Smile"/,
];

const overrides = loadOverrides();

function loadOverrides() {
  const path = join(here, "overrides.json");
  if (!existsSync(path)) return { rename: {}, keep: new Set(), paths: {} };
  const value = JSON.parse(readFileSync(path, "utf8"));
  return { rename: value.rename ?? {}, keep: new Set(value.keep ?? []), paths: value.paths ?? {} };
}

// --- token anatomy ----------------------------------------------------------

/**
 * Splits a token into pieces { sep, word }: `sep` is the separator before the
 * piece ("" for a camel hump or the start), `word` keeps its original case.
 */
export function pieces(token) {
  const out = [];
  const segments = token.split(/([-._$/])/);
  let sep = "";
  for (const segment of segments) {
    if (/^[-._$/]$/.test(segment)) { sep = segment; continue; }
    if (!segment) continue;
    const humps = segment.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(Boolean);
    humps.forEach((word, index) => out.push({ sep: index === 0 ? sep : "", word, segmentStart: index === 0, segmentSize: humps.length }));
    sep = "";
  }
  return out;
}

function caseOf(word) {
  if (word === word.toUpperCase() && /[A-Z]/.test(word)) return word.length === 1 ? "capital" : "upper";
  if (word[0] === word[0].toUpperCase() && /[A-Z]/.test(word[0])) return "capital";
  return "lower";
}

const capital = (word) => word[0].toUpperCase() + word.slice(1);

/**
 * Renders replacement words in the style of the piece they replace.
 * camel: inside a multi-hump segment, or an identifier → workFolder / WorkFolder
 * upper: UPPER word → WORK_FOLDER (joined with "_")
 * kebab: a lone lowercase word outside identifiers → work-folder
 */
function render(words, piece, cls) {
  const style = caseOf(piece.word);
  const camel = piece.segmentSize > 1 || cls === "ident";
  if (style === "upper") return words.map((word) => word.toUpperCase()).join("_");
  if (camel) {
    return words.map((word, index) => index === 0 ? (style === "capital" ? capital(word) : word) : capital(word)).join("");
  }
  // Standalone word outside code: product nouns stay lowercase (work-folder).
  return words.join("-");
}

/** Maps one token by the word rules, preserving case style. */
export function applyWordRules(token, cls) {
  const list = pieces(token);
  if (!list.length) return token;
  const lower = list.map((piece) => piece.word.toLowerCase());
  const protectedIndex = new Set();
  for (const sequence of keepSequences) {
    for (let index = 0; index + sequence.length <= lower.length; index += 1) {
      if (sequence.every((word, offset) => lower[index + offset] === word)) {
        for (let offset = 0; offset < sequence.length; offset += 1) protectedIndex.add(index + offset);
      }
    }
  }
  let changed = false;
  const rendered = list.map((piece, index) => {
    if (protectedIndex.has(index)) return piece.sep + piece.word;
    const rule = wordRules.find((candidate) => candidate.from.length === 1 && candidate.from[0] === lower[index]);
    if (!rule) return piece.sep + piece.word;
    changed = true;
    return piece.sep + render(rule.to, piece, cls);
  });
  return changed ? rendered.join("") : token;
}

/** The full mapping for one token: an explicit override first, then the word rules. */
export function mapToken(token, cls) {
  if (overrides.keep.has(token)) return token;
  const explicit = Object.hasOwn(overrides.rename, token) ? overrides.rename[token] : undefined;
  if (explicit !== undefined) return applyWordRules(explicit, cls);
  // File names and import paths: an override for the stem covers its extensions.
  const suffix = /(\.(?:test\.ts|d\.ts|tsx|ts|mts|cts|jsx|js|mjs|cjs|json|css|md))$/.exec(token)?.[1];
  if (suffix) {
    const stem = token.slice(0, -suffix.length);
    if (overrides.keep.has(stem)) return token;
    if (Object.hasOwn(overrides.rename, stem)) return applyWordRules(overrides.rename[stem], cls) + suffix;
  }
  return applyWordRules(token, cls);
}

// --- rewriting --------------------------------------------------------------

/**
 * Work-folder ids are opaque, portable identity written into every
 * registered folder (`space-<16 hex>`), so their established prefix stays:
 * literal ids, id patterns (`space-[`), id templates (`space-${`), and
 * removal transaction ids (`space-removal_`).
 */
export function isOpaqueIdPrefix(token, rest) {
  if (/^space-(?:[0-9a-f]{16}|removal_.*)$/.test(token)) return true;
  if (/^trash-\d{14}-[0-9a-f]{8}$/.test(token)) return true;
  if (token === "space" && (rest === "-" || /^-(?:\[|\$\{|removal_)/.test(rest))) return true;
  // Recently deleted entry ids keep their `trash-<timestamp>-<hex>` shape too.
  return token === "trash" && (rest === "-" || /^-(?:\\d|\$\{|\d)/.test(rest));
}

function rewriteTokens(text, cls, stats) {
  return text.replace(tokenPattern, (token, offset, whole) => {
    // A token glued to a preceding letter/digit is part of a larger word.
    if (offset > 0 && /[A-Za-z0-9_$]/.test(whole[offset - 1])) return token;
    if (cls !== "ident" && isOpaqueIdPrefix(token, whole.slice(offset + token.length, offset + token.length + 9))) return token;
    const next = mapToken(token, cls);
    if (next !== token) {
      stats.set(`${cls}\t${token}\t${next}`, (stats.get(`${cls}\t${token}\t${next}`) ?? 0) + 1);
    }
    return next;
  });
}

function lineAt(text, offset) {
  const start = text.lastIndexOf("\n", offset) + 1;
  const end = text.indexOf("\n", offset);
  return text.slice(start, end === -1 ? text.length : end);
}

const codeClasses = new Set(["ident", "idstring", "regex"]);

/** `className` values and other space-separated kebab lists are code, not prose. */
function isClassList(value) {
  const words = value.trim().split(/\s+/);
  return words.length > 0 && words.some((word) => word.includes("-")) && words.every((word) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(word));
}

function rewriteScript(file, text, stats, prose) {
  const regions = [...scriptRegions(file, text)];
  let out = "";
  let cursor = 0;
  for (const region of regions) {
    if (region.start < cursor) continue;
    const value = text.slice(region.start, region.end);
    const isProse = region.cls === "comment" || region.cls === "jsx" || (region.cls === "string" && /\s/.test(value) && !isClassList(value));
    const cls = region.cls === "string" ? (isProse ? "prose" : "idstring") : region.cls;
    let next = value;
    if (protectedLines.some((pattern) => pattern.test(lineAt(text, region.start)))) next = value;
    else if (prose ? isProse : codeClasses.has(cls) && !isProse) next = isProse ? rewriteProse(value, stats) : rewriteTokens(value, cls, stats);
    out += text.slice(cursor, region.start) + next;
    cursor = region.end;
  }
  return out + text.slice(cursor);
}

/** CSS: class names and custom properties (kebab tokens) outside string values. */
function rewriteCss(text, stats) {
  return text.replace(/(?<![\w-])([.#[]|--|var\(--)?([a-zA-Z][\w-]*)/g, (match, prefix = "", name, offset) => {
    if (!prefix && !/[.#[]/.test(text[offset - 1] ?? "")) {
      // Bare words are property names and values (white-space, space-between): leave them.
      return match;
    }
    return prefix + rewriteTokens(name, "css", stats);
  });
}

// --- prose ------------------------------------------------------------------

/** Phrase rules for prose, applied before word rules; order matters. */
export const proseRules = [
  [/\bManage Assistant tools \(Skills and Extensions\)/g, "Manage Skills & Extensions"],
  [/\bAssistant tools\b/g, "Skills & Extensions"],
  [/\bin the Apps tab\b/g, "in Settings → Apps"],
  [/\bfrom the Apps tab\b/g, "from Settings → Apps"],
  [/\bthe Apps tab\b/g, "Settings → Apps"],
  [/\bSpace Assistants\b/g, "Workers"],
  [/\bSpace Assistant\b/g, "Worker"],
  [/\bmanagement conversations\b/g, "work-fold agent chats"],
  [/\bmanagement conversation\b/g, "work-fold agent"],
  [/(?<!work-fold )\bmanagement (request|turn|Chat|chat|popover|instructions|parent|scope|transcript|folder|layer)(s?)\b/g, "work-fold agent $1$2"],
  [/\ba fold step\b/g, "an agent step"],
  [/(?<!work-)\bfold steps?\b/g, (match) => match.replace("fold", "agent")],
  [/(?<!work-)\bfold (model|turn|thread|transcript|conversation)\b/g, "work-fold agent $1"],
  [/`fold`/g, "`agent`"],
  [/\bPersonal and Space capabilities\b/g, "Everywhere and work-folder capabilities"],
  [/--scope personal\b/g, "--scope everywhere"],
  [/\bpersonal scope\b/g, "everywhere scope"],
  [/\bThe fold\b/g, "The work-fold agent"],
  [/\bthe fold\b/g, "the work-fold agent"],
  [/(?<!work-)\bfold's\b/g, "work-fold agent's"],
  [/(?<!work-)\bfold’s\b/g, "work-fold agent’s"],
  [/\ba routing\b/g, "an automation"],
  [/\bA routing\b/g, "An automation"],
  [/\ba Routing\b/g, "an Automation"],
  [/\bA Routing\b/g, "An Automation"],
  [/\bRoutings\b/g, "Automations"],
  [/\bRouting\b/g, "Automation"],
  [/\broutings\b/g, "automations"],
  [/\brouting\b/g, "automation"],
  [/\bglance\b/g, "overview"],
  [/\bthe Spaces\b/g, "the work-folders"],
  [/\bSpaces\b/g, "work-folders"],
  [/\bSpace\b/g, "work-folder"],
];

function rewriteProse(text, stats) {
  let next = text;
  for (const [pattern, replacement] of proseRules) next = next.replace(pattern, replacement);
  // Code-shaped tokens inside prose (flags, verbs, placeholders) follow the full mapping.
  next = next.replace(/(--|<|`|\|)([a-z][a-z0-9.-]*)/g, (match, lead, word) => lead + mapToken(word, "idstring"));
  // CLI words after the executable: `${executable} trash list`, `work-fold routings run`.
  next = next.replace(/((?:\$\{(?:executable|cmd)\}|work-fold) )([a-z][a-z-]*)((?: [a-z][a-z-]*)?)/g,
    (match, lead, first, second) => lead + mapToken(first, "idstring") + (second ? " " + mapToken(second.trim(), "idstring") : ""));
  next = next.replace(/\b(spaces|space)(?=[ .:,|>)\]]|$)/g, (word) => applyWordRules(word, "idstring"));
  if (next !== text) stats.set(`prose\t${text.slice(0, 40)}`, 1);
  return next;
}

// --- markdown ---------------------------------------------------------------

/** Code spans and fenced blocks follow the token rules; prose follows the phrase rules. */
function rewriteMarkdownBody(text, stats, prose) {
  const parts = text.split(/(```[\s\S]*?```)/);
  return parts.map((part) => {
    if (part.startsWith("```")) return prose ? part : rewriteTokens(part, "idstring", stats);
    return part.split(/(`[^`\n]+`)/).map((piece) => {
      if (piece.startsWith("`") && piece.endsWith("`")) return prose ? piece : rewriteTokens(piece, "idstring", stats);
      return prose ? rewriteProse(piece, stats) : piece;
    }).join("");
  }).join("");
}

/** Re-points relative links (markdown, src=, href=) after files move. */
function rewriteLinks(file, text, renames) {
  const oldDir = posixDirname(file);
  const newDir = posixDirname(renames.get(file) ?? file);
  return text.replace(/(\]\(|src="|href=")([^)"#\s]+)(#[^)"\s]*)?/g, (match, lead, target, hash = "") => {
    if (/^[a-z]+:/i.test(target) || target.startsWith("/")) return match;
    const resolved = posixNormalize(`${oldDir}/${target}`);
    const destination = renames.get(resolved) ?? resolved;
    if (destination === resolved && oldDir === newDir) return match;
    return lead + posixRelative(newDir, destination) + hash;
  });
}

function posixDirname(path) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function posixNormalize(path) {
  const out = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return out.join("/");
}

function posixRelative(fromDir, to) {
  const from = posixNormalize(fromDir).split("/").filter(Boolean);
  const target = to.split("/");
  let common = 0;
  while (common < from.length && common < target.length - 1 && from[common] === target[common]) common += 1;
  const up = from.slice(common).map(() => "..");
  return [...up, ...target.slice(common)].join("/") || target.at(-1);
}

// --- files ------------------------------------------------------------------

const datedPaths = [/^docs\/archive\//, /^docs\/releases\//];

function mapPath(path) {
  const explicit = overrides.paths?.[path];
  if (explicit) return explicit;
  if (path.startsWith("docs/")) return path;
  return path.split("/").map((segment) => segment.replace(tokenPattern, (token) => mapToken(token, "path"))).join("/");
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const prose = args.includes("--prose");
  const reportIndex = args.indexOf("--report");
  const stats = new Map();
  const all = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const files = new Set(trackedFiles());

  // Plan every move first, and refuse a collision before touching anything.
  const renames = new Map();
  for (const file of prose ? [] : files) {
    const target = mapPath(file);
    if (target !== file) renames.set(file, target);
  }
  const targets = new Map();
  for (const [from, to] of renames) {
    if (targets.has(to)) throw new Error(`Two files would move to ${to}: ${targets.get(to)} and ${from}`);
    targets.set(to, from);
    if (all.includes(to) && !renames.has(to)) throw new Error(`${from} would overwrite the existing ${to}`);
  }

  for (const file of all) {
    const full = join(root, file);
    const dated = datedPaths.some((pattern) => pattern.test(file));
    const inScope = files.has(file);
    if (!inScope && !(dated && /\.md$/.test(file))) continue;
    let text;
    try { text = readFileSync(full, "utf8"); } catch { continue; }
    let next = text;
    if (/\.md$/.test(file)) {
      if (!dated) next = rewriteMarkdownBody(next, stats, prose);
      if (!prose) next = rewriteLinks(file, next, renames);
    } else if (scriptExtensions.test(file)) next = rewriteScript(file, text, stats, prose);
    else if (prose) next = text;
    else if (/\.css$/.test(file)) next = rewriteCss(text, stats);
    else if (/\.(json|webmanifest|ps1|cmd|sh)$/.test(file) || /(^|\/)work-fold$/.test(file)) next = rewriteTokens(text, "idstring", stats);
    else if (/\.html$/.test(file)) next = rewriteLinks(file, rewriteTokens(text, "idstring", stats), renames);
    if (next !== text && !dryRun) writeFileSync(full, next);
  }
  if (!dryRun) {
    // A file may move into a name another file is vacating: move that one first.
    const pending = new Map(renames);
    while (pending.size) {
      const ready = [...pending].filter(([, to]) => !pending.has(to));
      if (!ready.length) throw new Error(`Rename cycle among: ${[...pending.keys()].join(", ")}`);
      for (const [from, to] of ready) {
        mkdirSync(dirname(join(root, to)), { recursive: true });
        execFileSync("git", ["-C", root, "mv", from, to]);
        pending.delete(from);
      }
    }
  }
  console.log(JSON.stringify({ tokenChanges: stats.size, renames: renames.size }));
  if (reportIndex >= 0) {
    const lines = [...stats.entries()].sort().map(([key, count]) => `${count}\t${key}`);
    writeFileSync(args[reportIndex + 1], [...lines, "", "# renames", ...[...renames].map(([a, b]) => `${a} -> ${b}`)].join("\n"));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
