import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { containsReservedSpacePathSegment } from "../space-path-policy.js";
import {
  maxAssistantPresentationSegments,
  maxChatToolEditDiffBytes,
  type AssistantPresentation,
  type AssistantPresentationSegment,
  type ChatToolEdit,
} from "../../shared/chat-presentation.js";

export function turnPresentation(
  texts: readonly string[],
  finalIndex: number | null,
  command: boolean,
  orders?: readonly (number | undefined)[],
): AssistantPresentation | undefined {
  const segments: AssistantPresentationSegment[] = [];
  let offset = 0;
  let truncated = false;
  for (const [index, text] of texts.entries()) {
    const length = text.trim().length;
    if (!length) continue;
    if (segments.length === maxAssistantPresentationSegments) { truncated = true; break; }
    if (segments.length) offset += 2;
    segments.push({ start: offset, end: offset + length, kind: command ? "command" : index === finalIndex ? "final" : "progress", ...(orders?.[index] === undefined ? {} : { order: orders[index] }) });
    offset += length;
  }
  return segments.length ? { version: 1, segments, truncated } : undefined;
}

/** Bad optional metadata is discarded without losing a historical message. */
export function parseAssistantPresentation(value: unknown, content: string): AssistantPresentation | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.truncated !== "boolean"
    || !Array.isArray(value.segments) || !value.segments.length || value.segments.length > maxAssistantPresentationSegments) return undefined;
  const segments: AssistantPresentationSegment[] = [];
  let offset = 0;
  for (const candidate of value.segments) {
    if (!isRecord(candidate) || !Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.end)
      || candidate.start !== offset || (candidate.end as number) <= offset || (candidate.end as number) > content.length
      || (candidate.kind !== "progress" && candidate.kind !== "final" && candidate.kind !== "command")) return undefined;
    if (segments.length && content.slice(offset - 2, offset) !== "\n\n") return undefined;
    if (!content.slice(offset, candidate.end as number).trim()) return undefined;
    if (segments.some((segment) => segment.kind === "final")) return undefined;
    if (candidate.order !== undefined && (!Number.isSafeInteger(candidate.order) || (candidate.order as number) < 0
      || segments.some((segment) => segment.order !== undefined && segment.order >= (candidate.order as number)))) return undefined;
    segments.push({ start: offset, end: candidate.end as number, kind: candidate.kind,
      ...(candidate.order === undefined ? {} : { order: candidate.order as number }) });
    offset = (candidate.end as number) + 2;
  }
  const end = segments.at(-1)!.end;
  if ((!value.truncated && end !== content.length) || (value.truncated && (end >= content.length || segments.at(-1)?.kind === "final"))) return undefined;
  return { version: 1, segments, truncated: value.truncated };
}

/** Conservative admission: ambiguous native path spellings simply keep generic tool activity. */
export function localEditPath(spaceRoot: string, value: unknown): string | undefined {
  const windowsAbsolutePath = typeof value === "string" && process.platform === "win32" && /^[A-Za-z]:[\\/]/u.test(value);
  if (typeof value !== "string" || !value.length || value.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(value) || process.platform !== "win32" && value.includes("\\")
    || /^[~@]/u.test(value) || !windowsAbsolutePath && /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)
    || /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(value) || containsReservedSpacePathSegment(value)) return undefined;
  try {
    const root = resolve(spaceRoot);
    const target = resolve(root, value);
    const path = relative(root, target).split(sep).join("/");
    if (!isPortableEditPath(path) || lstatSync(root).isSymbolicLink()) return undefined;
    let current = root;
    for (const segment of path.split("/")) {
      current = join(current, segment);
      const info = lstatSync(current);
      if (info.isSymbolicLink() || (info.isDirectory() && hasPortableFolderIdentity(current))) return undefined;
    }
    if (!lstatSync(target).isFile()) return undefined;
    const canonicalRelative = relative(realpathSync(root), realpathSync(target)).split(sep).join("/");
    if (canonicalRelative !== path) return undefined;
    return path;
  } catch {
    return undefined;
  }
}

/** Child Folder transcripts travel independently, even after their registration is removed. */
function hasPortableFolderIdentity(path: string): boolean {
  for (const entry of readdirSync(path)) {
    if (entry.toLowerCase() !== ".work-fold") continue;
    const metadata = join(path, entry);
    // Never follow a purported identity's symlink just to decide presentation scope.
    if (lstatSync(metadata).isSymbolicLink()) return true;
    if (readdirSync(metadata).some((name) => name.toLowerCase() === "space.json")) return true;
  }
  return false;
}

export function projectNativeEdit(path: string, details: unknown, remainingBytes: number): ChatToolEdit | undefined {
  if (!isPortableEditPath(path) || !isRecord(details) || typeof details.diff !== "string" || !details.diff.length || remainingBytes <= 0) return undefined;
  const limit = Math.min(maxChatToolEditDiffBytes, remainingBytes);
  // Bound the allocation too: a native result can describe a very large edit.
  let prefix = details.diff.slice(0, limit);
  if (prefix.length < details.diff.length && /[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  const bytes = Buffer.from(prefix, "utf8");
  // Drop an incomplete UTF-8 tail rather than inventing a replacement character.
  let end = Math.min(bytes.length, limit);
  while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const diff = bytes.subarray(0, end).toString("utf8");
  if (!diff) return undefined;
  return {
    path,
    diff,
    ...(Number.isSafeInteger(details.firstChangedLine) && (details.firstChangedLine as number) > 0 ? { firstChangedLine: details.firstChangedLine as number } : {}),
    truncated: end < bytes.length || prefix.length < details.diff.length,
  };
}

export function parseChatToolEdit(value: unknown): ChatToolEdit | undefined {
  if (!isRecord(value) || !isPortableEditPath(value.path) || typeof value.diff !== "string" || !value.diff.length
    || value.diff.length > maxChatToolEditDiffBytes || Buffer.byteLength(value.diff, "utf8") > maxChatToolEditDiffBytes || typeof value.truncated !== "boolean"
    || (value.firstChangedLine !== undefined && (!Number.isSafeInteger(value.firstChangedLine) || (value.firstChangedLine as number) < 1))) return undefined;
  return {
    path: value.path,
    diff: value.diff,
    ...(value.firstChangedLine === undefined ? {} : { firstChangedLine: value.firstChangedLine as number }),
    truncated: value.truncated,
  };
}

function isPortableEditPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096
    && !isAbsolute(value) && !/[\u0000-\u001f\u007f\\:]/u.test(value)
    && !containsReservedSpacePathSegment(value)
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
