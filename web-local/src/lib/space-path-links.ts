import type { TreeEntry } from "../types";

export interface SpacePathMention {
  start: number;
  end: number;
  text: string;
  normalizedPath: string;
}

const knownFileExtensions = new Set([
  "csv",
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "doc",
  "docm",
  "docx",
  "dot",
  "dotm",
  "dotx",
  "gif",
  "htm",
  "html",
  "h",
  "hpp",
  "ini",
  "java",
  "js",
  "jsx",
  "jpeg",
  "jpg",
  "json",
  "kt",
  "log",
  "md",
  "markdown",
  "pdf",
  "png",
  "ps1",
  "py",
  "potx",
  "ppt",
  "pptm",
  "pptx",
  "rtf",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svg",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "webp",
  "xls",
  "xlsb",
  "xlsm",
  "xlsx",
  "xml",
  "yaml",
  "yml",
]);

const leadingPathPunctuation = /^[([{"'`<]+/;
const trailingPathPunctuation = /[)\].,;:!?"'`>]+$/;

export function collectSpacePathCandidates(markdown: string, limit = 32): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (candidate: string | null) => {
    if (!candidate || seen.has(candidate) || candidates.length >= limit) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  const codeSpans = inlineCodeSpans(markdown);
  for (const span of codeSpans) {
    addCandidate(spacePathCandidate(span.text, { allowSpaces: true }));
  }
  const markdownLinks = markdownLinkDestinations(markdown);
  for (const link of markdownLinks) {
    addCandidate(spacePathCandidate(link.text, { allowSpaces: true }));
  }
  const markdownWithoutStructuredPaths = maskRanges(markdown, [...codeSpans, ...markdownLinks]);
  for (const mention of findSpacePathMentions(markdownWithoutStructuredPaths)) {
    addCandidate(mention.normalizedPath);
  }
  return candidates;
}

export function findSpacePathMentions(text: string): SpacePathMention[] {
  const mentions: SpacePathMention[] = [];
  const tokenPattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text))) {
    const rawToken = match[0] ?? "";
    const leadingLength = rawToken.length - rawToken.replace(leadingPathPunctuation, "").length;
    const withoutLeading = rawToken.slice(leadingLength);
    const core = withoutLeading.replace(trailingPathPunctuation, "");
    const trailingLength = withoutLeading.length - core.length;
    const normalizedPath = spacePathCandidate(core, { allowSpaces: false });
    if (!normalizedPath) continue;
    mentions.push({
      start: match.index + leadingLength,
      end: match.index + rawToken.length - trailingLength,
      text: core,
      normalizedPath,
    });
  }
  return mentions;
}

export function spacePathCandidate(value: string, options: { allowSpaces: boolean }): string | null {
  let normalized = value.trim().replace(/^<|>$/g, "").replace(/\\/g, "/");
  try { normalized = decodeURIComponent(normalized); } catch { /* keep the literal path */ }
  normalized = normalized
    .replace(/^\.\//, "")
    .replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/i, "")
    .replace(/#[A-Za-z0-9_.-]+$/, "")
    .replace(/\/+$/g, "");
  if (!normalized) return null;
  if (!options.allowSpaces && /\s/.test(normalized)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return null;
  if (/^[A-Za-z]:\//.test(normalized)) return null;
  if (normalized.startsWith("/") || normalized.startsWith("~")) return null;
  if (normalized.includes("\0")) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const lastSegment = segments[segments.length - 1] ?? "";
  const extension = fileExtension(lastSegment);
  const hasSlash = normalized.includes("/");
  const hasKnownExtension = Boolean(extension && knownFileExtensions.has(extension));
  if (!hasSlash && !hasKnownExtension) return null;
  if (!hasSlash && /^\d+(?:\.\d+)+$/.test(normalized)) return null;
  return normalized;
}

export function resolveFixtureSpacePathCandidates(paths: string[], entries: TreeEntry[]): Map<string, string> {
  const files = collectFixtureFiles(entries);
  const byPath = new Map(files.map((entry) => [entry.path, entry.path]));
  const byLowerName = new Map<string, string[]>();
  for (const entry of files) {
    const name = entry.name.toLocaleLowerCase();
    byLowerName.set(name, [...(byLowerName.get(name) ?? []), entry.path]);
  }

  const resolved = new Map<string, string>();
  for (const path of paths) {
    const normalized = spacePathCandidate(path, { allowSpaces: true });
    if (!normalized) continue;
    const direct = byPath.get(normalized);
    if (direct) {
      resolved.set(normalized, direct);
      continue;
    }
    if (normalized.includes("/")) continue;
    const matches = byLowerName.get(normalized.toLocaleLowerCase()) ?? [];
    if (matches.length === 1 && matches[0]) resolved.set(normalized, matches[0]);
  }
  return resolved;
}

function inlineCodeSpans(markdown: string): Array<{ start: number; end: number; text: string }> {
  const spans: Array<{ start: number; end: number; text: string }> = [];
  const inlineCodePattern = /`([^`\n]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = inlineCodePattern.exec(markdown))) {
    spans.push({ start: match.index, end: match.index + match[0].length, text: match[1] ?? "" });
  }
  return spans;
}

function markdownLinkDestinations(markdown: string): Array<{ start: number; end: number; text: string }> {
  const destinations: Array<{ start: number; end: number; text: string }> = [];
  const linkPattern = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(markdown))) {
    destinations.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[1] ?? match[2] ?? "",
    });
  }
  return destinations;
}

function maskRanges(value: string, ranges: Array<{ start: number; end: number }>): string {
  if (!ranges.length) return value;
  const characters = [...value];
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) {
      characters[index] = " ";
    }
  }
  return characters.join("");
}

function collectFixtureFiles(entries: TreeEntry[]): TreeEntry[] {
  const files: TreeEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "file") {
      files.push(entry);
      continue;
    }
    if (entry.children?.length) files.push(...collectFixtureFiles(entry.children));
  }
  return files;
}

function fileExtension(path: string): string {
  const match = /\.([^.\\/]+)$/.exec(path);
  return match?.[1]?.toLocaleLowerCase() ?? "";
}
