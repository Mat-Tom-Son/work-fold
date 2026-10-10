// Classify every occurrence of the legacy product vocabulary by syntactic
// context, so mechanical renames (identifiers, identifier-like strings) and
// prose rewrites (comments, UI copy) can be handled separately.
//
// Usage: node scripts/vocabulary/scan.mjs [--json <out>] [--stems space,fold,...]
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const scriptExtensions = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

/** Paths whose wording is dated evidence or third-party code. */
export const excludedPaths = [
  /^docs\/archive\//,
  /^docs\/releases\//,
  /^patches\//,
  /^desktop\/assets\//,
  /^resources\/included-tools\/.*\/vendor\//,
  /^scripts\/vocabulary\//,
  /package-lock\.json$/,
  /\.(png|jpe?g|webp|gif|ico|icns|woff2?|ttf|otf|pdf|zip|node|dylib|mp4|mov|svg)$/,
];

export function trackedFiles() {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((file) => !excludedPaths.some((pattern) => pattern.test(file)));
}

/** Identifier-shaped token: camelCase, PascalCase, snake, kebab, dotted. */
export const tokenPattern = /[A-Za-z_$][A-Za-z0-9_$]*(?:[-.][A-Za-z0-9_$]+)*/g;

/** Split an identifier-shaped token into lowercase word parts. */
export function wordParts(token) {
  return token
    .split(/[-._$]+/)
    .flatMap((piece) => piece.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

/**
 * Walk a script file and yield every text region with its syntactic class:
 * ident (code identifier), string (literal or template text), jsx (JSX text),
 * comment.
 */
export function* scriptRegions(file, text) {
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : /\.(m|c)?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const seenComments = new Set();
  const comments = [];
  const collectComments = (pos) => {
    for (const range of [...(ts.getLeadingCommentRanges(text, pos) ?? []), ...(ts.getTrailingCommentRanges(text, pos) ?? [])]) {
      if (seenComments.has(range.pos)) continue;
      seenComments.add(range.pos);
      comments.push({ cls: "comment", start: range.pos, end: range.end });
    }
  };
  const regions = [];
  const visit = (node) => {
    collectComments(node.getFullStart());
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      regions.push({ cls: "ident", start: node.getStart(source), end: node.getEnd() });
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      regions.push({ cls: "string", start: node.getStart(source) + 1, end: node.getEnd() - 1 });
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const start = node.getStart(source);
      const raw = text.slice(start, node.getEnd());
      const openLen = raw.startsWith("`") || raw.startsWith("}") ? 1 : 0;
      const closeLen = raw.endsWith("${") ? 2 : raw.endsWith("`") ? 1 : 0;
      regions.push({ cls: "string", start: start + openLen, end: node.getEnd() - closeLen });
    } else if (ts.isJsxText(node)) {
      regions.push({ cls: "jsx", start: node.getStart(source, false), end: node.getEnd() });
    } else if (ts.isRegularExpressionLiteral(node)) {
      regions.push({ cls: "regex", start: node.getStart(source), end: node.getEnd() });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  collectComments(source.endOfFileToken.getFullStart());
  yield* [...regions, ...comments].sort((a, b) => a.start - b.start);
}

/** A string region is identifier-like when it has no whitespace (keys, routes, ids, paths). */
export function isIdentifierLikeString(value) {
  return value.length > 0 && !/\s/.test(value);
}

function classify(file, text) {
  if (scriptExtensions.test(file)) {
    return [...scriptRegions(file, text)].map((region) => {
      const value = text.slice(region.start, region.end);
      const cls = region.cls === "string" ? (isIdentifierLikeString(value) ? "idstring" : "prose-string") : region.cls;
      return { ...region, cls, value };
    });
  }
  if (/\.(md|txt)$/.test(file)) return [{ cls: "doc", start: 0, end: text.length, value: text }];
  if (/\.css$/.test(file)) return [{ cls: "css", start: 0, end: text.length, value: text }];
  if (/\.(json|jsonl)$/.test(file)) return [{ cls: "json", start: 0, end: text.length, value: text }];
  return [{ cls: "other", start: 0, end: text.length, value: text }];
}

function main() {
  const args = process.argv.slice(2);
  const stems = (args[args.indexOf("--stems") + 1] && args.includes("--stems") ? args[args.indexOf("--stems") + 1] : "space,spaces,fold,folds,routing,routings,assistant,assistants,glance,trash,library,manage,management,personal")
    .split(",");
  const stemSet = new Set(stems);
  const tally = new Map();
  for (const file of trackedFiles()) {
    let text;
    try { text = readFileSync(join(root, file), "utf8"); } catch { continue; }
    for (const region of classify(file, text)) {
      for (const match of region.value.matchAll(tokenPattern)) {
        const parts = wordParts(match[0]);
        const hit = parts.find((part) => stemSet.has(part));
        if (!hit) continue;
        const key = `${region.cls}\t${match[0]}`;
        const entry = tally.get(key) ?? { cls: region.cls, token: match[0], stem: hit, count: 0, files: new Set() };
        entry.count += 1;
        entry.files.add(file);
        tally.set(key, entry);
      }
    }
  }
  const rows = [...tally.values()].sort((a, b) => b.count - a.count);
  const byClass = new Map();
  for (const row of rows) byClass.set(row.cls, (byClass.get(row.cls) ?? 0) + row.count);
  console.log("occurrences by class:", Object.fromEntries(byClass));
  console.log("distinct tokens:", rows.length);
  const outIndex = args.indexOf("--json");
  if (outIndex >= 0) {
    writeFileSync(args[outIndex + 1], JSON.stringify(rows.map((row) => ({ ...row, files: [...row.files].slice(0, 8), fileCount: row.files.size })), null, 1));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
