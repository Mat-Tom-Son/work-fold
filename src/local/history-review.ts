import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  HISTORY_REVIEW_LIMITS,
  type HistoryFileComparison,
  type HistoryFileObservation,
  type HistoryFileRead,
  type HistoryFileReadOptions,
  type HistoryFileRange,
  type HistoryTextDiff,
} from "../shared/history-review.js";
import { getWorkFolderCheckpoint, type WorkFolderCheckpoint } from "./history.js";
import { pathHasAlwaysSkippedSegment } from "./history-capture-policy.js";
import { isOfficeLockFileName } from "./office-lock-files.js";
import { containsReservedWorkFolderPathSegment } from "./work-folder-path-policy.js";
import { assertWorkFolderDoesNotContainState, ensureSafeWorkFolderRoot, nestedRegisteredWorkFolderPaths, resolveWorkFolderPath, withWorkFolderHistoryOperation } from "./work-folder.js";
import { workFolderHistoryRoot } from "./state-paths.js";

/** Reads only content owned by this checkpoint and path, never an arbitrary blob hash. */
export async function readHistoryFile(
  workFolderRoot: string,
  input: HistoryFileReadOptions,
): Promise<HistoryFileRead> {
  return withWorkFolderHistoryOperation(workFolderRoot, async () => {
    const { root, path } = await reviewPath(workFolderRoot, input.path);
    if (input.signal?.aborted) throw Object.assign(new Error("History read cancelled."), { name: "AbortError" });
    const observation = await checkpointObservation(root, path, input.checkpointId);
    if (input.expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/u.test(input.expectedSha256) || input.expectedSha256 !== observation.hashSha256)) throw requestError("The selected History source does not match expectedSha256.", 409);
    const range = input.offsetBytes !== undefined || input.lengthBytes !== undefined
      ? await checkpointRange(root, path, observation, input) : undefined;
    return { schemaVersion: 1, path, observation, limits: { ...HISTORY_REVIEW_LIMITS }, ...(range ? { range } : {}) };
  });
}

/** Omission of toCheckpointId means one bounded observation of the current file. */
export async function compareHistoryFile(
  workFolderRoot: string,
  input: { path: string; fromCheckpointId: string; toCheckpointId?: string },
): Promise<HistoryFileComparison> {
  return withWorkFolderHistoryOperation(workFolderRoot, async () => {
    const { root, path } = await reviewPath(workFolderRoot, input.path);
    const before = await checkpointObservation(root, path, input.fromCheckpointId);
    const after = input.toCheckpointId === undefined
      ? await currentObservation(root, path)
      : await checkpointObservation(root, path, input.toCheckpointId);
    const change = compareObservations(before, after);
    const diff = change === "unchanged"
      ? { status: "not_needed" as const, truncated: false }
      : makeDiff(path, before, after);
    return { schemaVersion: 1, path, before, after, change, diff, limits: { ...HISTORY_REVIEW_LIMITS } };
  });
}

async function reviewPath(workFolderRoot: string, value: string): Promise<{ root: string; path: string }> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  assertWorkFolderDoesNotContainState(root);
  // Reject controls so filenames cannot inject apparent diff headers or terminal commands.
  if (typeof value !== "string" || !value || value.length > 1_024 || /[\x00-\x1f\x7f]/u.test(value)
    || value.includes("\\") || /^[A-Za-z]:/u.test(value)) {
    throw requestError("History requires a bounded relative file path.", 400);
  }
  let absolutePath: string;
  try { absolutePath = resolveWorkFolderPath(root, value); }
  catch (error) { throw requestError(error instanceof Error ? error.message : "Invalid History path.", 400); }
  const path = relative(root, absolutePath).split(sep).join("/");
  if (!path) throw requestError("The work-folder root cannot be used as a History file.", 400);
  // resolveWorkFolderPath uses existsSync; lstat also catches dangling links.
  let cursor = root;
  const ancestors: Array<{ dev: number; ino: number }> = [];
  for (const segment of path.split("/")) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink()) throw requestError("History paths cannot traverse symbolic links or junctions.", 400);
    if (info.isDirectory()) ancestors.push(info);
  }
  const nested = await nestedRegisteredWorkFolderPaths(root);
  // Filesystem identities also catch alternate casing on case-insensitive volumes.
  const nestedInfo = await Promise.all(nested.map((child) => lstat(join(root, child)).catch(() => null)));
  if (nested.some((child) => covers(child, path)) || nestedInfo.some((child) => child && ancestors.some((parent) => child.dev === parent.dev && child.ino === parent.ino))) {
    throw requestError("This History path belongs to another registered work-folder.", 403);
  }
  return { root, path };
}

async function checkpointObservation(root: string, path: string, checkpointId: string): Promise<HistoryFileObservation> {
  const checkpoint = typeof checkpointId === "string" ? await getWorkFolderCheckpoint(root, checkpointId) : null;
  if (!checkpoint || checkpoint.checkpointId !== checkpointId) throw requestError("Restore point not found in this work-folder.", 404);
  if (!validCheckpoint(checkpoint)) return { source: "checkpoint", checkpointId, status: "unavailable", reason: "invalid_checkpoint" };
  const base = { source: "checkpoint" as const, checkpointId, capturedAt: checkpoint.createdAt };
  const entries = checkpoint.files.filter((file) => file.path === path);
  if (entries.length > 1) return { ...base, status: "unavailable", reason: "invalid_checkpoint" };
  const file = entries[0];
  const skipped = checkpoint.skippedFiles.find((item) => covers(item.path, path));
  if (skipped) {
    return { ...base, status: "uncaptured", reason: `skipped_${skipped.reason}`,
      ...(skipped.path === path ? { sizeBytes: skipped.sizeBytes } : {}) };
  }
  if (!file) {
    if (checkpoint.directories.includes(path)) return { ...base, status: "unavailable", reason: "not_regular_file" };
    // These entries may be omitted altogether by capture, e.g. Office lock files.
    if (pathHasAlwaysSkippedSegment(path) || isOfficeLockFileName(path.split("/").at(-1)!)) {
      return { ...base, status: "uncaptured", reason: "skipped_excluded" };
    }
    const covered = checkpoint.scope === "full" || [...checkpoint.captureRoots, ...checkpoint.deleteOnRestore].some((item) => covers(item, path));
    return covered ? { ...base, status: "absent" } : { ...base, status: "uncaptured", reason: "outside_capture" };
  }
  const metadata = { ...base, sizeBytes: file.sizeBytes, hashSha256: file.hashSha256, hashVerified: false };
  if (file.sizeBytes > HISTORY_REVIEW_LIMITS.maxFileBytes) return { ...metadata, status: "too_large", reason: "file_size_limit" };
  const hash = file.hashSha256;
  // The hash only reaches this path after exact selected-work-folder/checkpoint/file membership.
  const blobPath = join(workFolderHistoryRoot(root), "objects", hash.slice(0, 2), hash.slice(2));
  const result = await boundedRead(blobPath);
  if (result.kind !== "bytes") {
    return { ...metadata, status: "unavailable", reason: result.kind === "absent" ? "missing_blob"
      : result.kind === "too_large" || result.kind === "not_regular_file" ? "corrupt_blob" : result.kind === "changed" ? "changed_during_read" : "unreadable" };
  }
  if (result.bytes.length !== file.sizeBytes || digest(result.bytes) !== hash) return { ...metadata, status: "unavailable", reason: "corrupt_blob" };
  return { ...metadata, hashVerified: true, ...classifyBytes(result.bytes) };
}

/** Verifies the entire immutable source with fixed memory before releasing any range. */
async function checkpointRange(root: string, path: string, observation: HistoryFileObservation, input: HistoryFileReadOptions): Promise<HistoryFileRange | undefined> {
  const offset = input.offsetBytes ?? 0;
  const length = input.lengthBytes ?? HISTORY_REVIEW_LIMITS.maxFileBytes;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 4 || length > HISTORY_REVIEW_LIMITS.maxFileBytes) {
    throw requestError(`History ranges require a nonnegative byte offset and 4–${HISTORY_REVIEW_LIMITS.maxFileBytes} bytes per page.`, 400);
  }
  if (input.expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/u.test(input.expectedSha256) || input.expectedSha256 !== observation.hashSha256)) {
    throw requestError("The selected History source does not match expectedSha256.", 409);
  }
  if (!observation.hashSha256 || observation.sizeBytes === undefined || !["text", "binary", "too_large"].includes(observation.status)) return undefined;
  const hash = observation.hashSha256;
  const totalBytes = observation.sizeBytes;
  if (offset > totalBytes) throw requestError("History byte offset is beyond the saved file.", 400);
  const base = { offsetBytes: offset, lengthBytes: 0, totalBytes, nextOffsetBytes: null, complete: false, hashSha256: hash, hashVerified: false };
  const blobPath = join(workFolderHistoryRoot(root), "objects", hash.slice(0, 2), hash.slice(2));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const abort = () => { if (input.signal?.aborted) throw Object.assign(new Error("History read cancelled."), { name: "AbortError" }); };
  try {
    abort();
    const initial = await lstat(blobPath, { bigint: true });
    if (!initial.isFile() || initial.size !== BigInt(totalBytes)) return { ...base, status: "unavailable", reason: "corrupt_blob" };
    handle = await open(blobPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!sameFile(initial, before)) return { ...base, status: "unavailable", reason: "changed_during_read" };
    const digest = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let binaryReason: "binary_content" | "invalid_utf8" | undefined;
    const buffer = Buffer.alloc(64 * 1024);
    const selected = Buffer.alloc(Math.min(length + 3, totalBytes - offset));
    let position = 0;
    while (position < totalBytes) {
      abort();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, totalBytes - position), position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      if (!binaryReason) {
        try { if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(decoder.decode(chunk, { stream: true }))) binaryReason = "binary_content"; }
        catch { binaryReason = "invalid_utf8"; }
      }
      const from = Math.max(position, offset);
      const to = Math.min(position + bytesRead, offset + selected.length);
      if (to > from) chunk.copy(selected, from - offset, from - position, to - position);
      position += bytesRead;
    }
    if (!binaryReason) { try { decoder.decode(); } catch { binaryReason = "invalid_utf8"; } }
    abort();
    await reviewPath(root, path);
    const after = await handle.stat({ bigint: true });
    const current = await lstat(blobPath, { bigint: true });
    if (!sameFile(before, after) || !sameFile(after, current)) return { ...base, status: "unavailable", reason: "changed_during_read" };
    if (position !== totalBytes || digest.digest("hex") !== hash) return { ...base, status: "unavailable", reason: "corrupt_blob" };
    if (binaryReason) return { ...base, status: "binary", reason: binaryReason, hashVerified: true };
    if (selected.length && (selected[0]! & 0xc0) === 0x80) throw requestError("History byte offset must start at a UTF-8 character boundary. Use nextOffsetBytes from the previous page.", 400);
    let count = Math.min(length, selected.length);
    while (count < selected.length && count > 0 && (selected[count]! & 0xc0) === 0x80) count -= 1;
    const end = offset + count;
    return { ...base, status: "text", lengthBytes: count, nextOffsetBytes: end < totalBytes ? end : null,
      complete: offset === 0 && end === totalBytes, hashVerified: true, text: selected.subarray(0, count).toString("utf8") };
  } catch (error) {
    if ((error as Error).name === "AbortError" || (error as { statusCode?: number }).statusCode) throw error;
    return { ...base, status: "unavailable", reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing_blob" : "unreadable" };
  } finally { await handle?.close().catch(() => undefined); }
}

function validCheckpoint(checkpoint: WorkFolderCheckpoint): boolean {
  return (checkpoint.scope === "full" || checkpoint.scope === "targeted")
    && typeof checkpoint.createdAt === "string" && checkpoint.createdAt.length <= 64 && Number.isFinite(Date.parse(checkpoint.createdAt))
    && Array.isArray(checkpoint.captureRoots) && checkpoint.captureRoots.every((path) => validStoredPath(path, false))
    && Array.isArray(checkpoint.deleteOnRestore) && checkpoint.deleteOnRestore.every((path) => validStoredPath(path, false))
    && Array.isArray(checkpoint.directories) && checkpoint.directories.every((path) => validStoredPath(path, false))
    && Array.isArray(checkpoint.skippedFiles) && checkpoint.skippedFiles.every((file) => file && validStoredPath(file.path, true)
      && ["too_large", "unreadable", "symbolic_link", "excluded"].includes(file.reason) && validSize(file.sizeBytes))
    && Array.isArray(checkpoint.files) && checkpoint.files.every((file) => file && validStoredPath(file.path, false)
      && !containsReservedWorkFolderPathSegment(file.path) && typeof file.hashSha256 === "string" && /^[a-f0-9]{64}$/u.test(file.hashSha256) && validSize(file.sizeBytes));
}

function validStoredPath(value: unknown, allowRoot: boolean): value is string {
  return typeof value === "string" && (allowRoot && value === "" || value.length > 0 && !value.startsWith("/")
    && !value.includes("\\") && !value.includes("\0") && !/^[A-Za-z]:/u.test(value)
    && value.split("/").every((segment) => segment !== "." && segment !== ".." && segment !== ""));
}

function validSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function currentObservation(root: string, path: string): Promise<HistoryFileObservation> {
  const base = { source: "current" as const, observedAt: new Date().toISOString() };
  const absolutePath = resolveWorkFolderPath(root, path);
  const result = await boundedRead(absolutePath, () => { resolveWorkFolderPath(root, path); });
  if (result.kind === "absent") return { ...base, status: "absent" };
  if (result.kind === "too_large") return { ...base, status: "too_large", sizeBytes: result.sizeBytes, reason: "file_size_limit" };
  if (result.kind !== "bytes") return { ...base, status: "unavailable",
    reason: result.kind === "changed" ? "changed_during_read" : result.kind === "not_regular_file" ? "not_regular_file" : "unreadable" };
  return { ...base, sizeBytes: result.bytes.length, hashSha256: digest(result.bytes), hashVerified: true, ...classifyBytes(result.bytes) };
}

type BoundedRead = { kind: "bytes"; bytes: Buffer } | { kind: "too_large"; sizeBytes: number }
  | { kind: "absent" | "unreadable" | "changed" | "not_regular_file" };

/** Fixed allocation and fixed read budget, even if an outside writer grows the file. */
async function boundedRead(path: string, recheckPath?: () => void): Promise<BoundedRead> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let beganReading = false;
  try {
    const initial = await lstat(path, { bigint: true });
    if (!initial.isFile()) return { kind: "not_regular_file" };
    if (initial.size > BigInt(HISTORY_REVIEW_LIMITS.maxFileBytes)) return { kind: "too_large", sizeBytes: Number(initial.size) };
    recheckPath?.();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    beganReading = true;
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFile(initial, before)) return { kind: "changed" };
    const bytes = Buffer.alloc(Number(initial.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    recheckPath?.();
    const current = await lstat(path, { bigint: true });
    if (!sameFile(before, after) || !sameFile(after, current) || BigInt(length) !== after.size) return { kind: "changed" };
    return { kind: "bytes", bytes: bytes.subarray(0, length) };
  } catch (error) {
    if (beganReading) return { kind: "changed" };
    const code = (error as NodeJS.ErrnoException).code;
    return { kind: code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable" };
  } finally { await handle?.close().catch(() => undefined); }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode;
}

function classifyBytes(bytes: Buffer): Pick<HistoryFileObservation, "status" | "reason" | "text"> {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { status: "binary", reason: "invalid_utf8" }; }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) return { status: "binary", reason: "binary_content" };
  return { status: "text", text };
}

function compareObservations(before: HistoryFileObservation, after: HistoryFileObservation): HistoryFileComparison["change"] {
  const present = (item: HistoryFileObservation) => item.hashVerified === true && (item.status === "text" || item.status === "binary");
  if (before.status === "absent" && after.status === "absent") return "unchanged";
  if (before.status === "absent" && present(after)) return "added";
  if (present(before) && after.status === "absent") return "deleted";
  if (present(before) && present(after)) return before.hashSha256 === after.hashSha256 ? "unchanged" : "modified";
  return "unknown";
}

type DiffLine = { kind: " " | "+" | "-"; text: string };

function makeDiff(path: string, before: HistoryFileObservation, after: HistoryFileObservation): HistoryTextDiff {
  const supported = (item: HistoryFileObservation) => item.status === "text" || item.status === "absent";
  if (!supported(before) || !supported(after)) return { status: "unsupported", reason: "content_unavailable", truncated: false };
  const left = splitLines(before.text ?? "");
  const right = splitLines(after.text ?? "");
  const limited = (reason: HistoryTextDiff["reason"]): HistoryTextDiff => ({ status: "limited", reason, truncated: true });
  if (left.length > HISTORY_REVIEW_LIMITS.maxDiffLines || right.length > HISTORY_REVIEW_LIMITS.maxDiffLines) return limited("line_limit");
  if ([...left, ...right].some((line) => line.length > HISTORY_REVIEW_LIMITS.maxLineCharacters)) return limited("long_line");
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix += 1;
  const oldLines = left.slice(prefix, left.length - suffix);
  const newLines = right.slice(prefix, right.length - suffix);
  const width = newLines.length + 1;
  if ((oldLines.length + 1) * width > HISTORY_REVIEW_LIMITS.maxDiffCells) return limited("computation_limit");
  const table = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldLines[i] === newLines[j] ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const lines: DiffLine[] = left.slice(0, prefix).map((text) => ({ kind: " ", text }));
  let i = 0; let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      lines.push({ kind: " ", text: oldLines[i++]! }); j += 1;
    } else if (i < oldLines.length && (j === newLines.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) {
      lines.push({ kind: "-", text: oldLines[i++]! });
    } else { lines.push({ kind: "+", text: newLines[j++]! }); }
  }
  lines.push(...left.slice(left.length - suffix).map((text): DiffLine => ({ kind: " ", text })));
  const hunks: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.kind === " ") continue;
    const start = Math.max(0, index - 3); const end = Math.min(lines.length, index + 4);
    const previous = hunks.at(-1);
    if (previous && start <= previous.end) previous.end = end;
    else hunks.push({ start, end });
  }
  const source = (item: HistoryFileObservation) => item.checkpointId ?? "current observation";
  const parts = [`--- ${before.status === "absent" ? "/dev/null" : JSON.stringify(`a/${path}`)}\t${source(before)}\n`,
    `+++ ${after.status === "absent" ? "/dev/null" : JSON.stringify(`b/${path}`)}\t${source(after)}\n`];
  let outputBytes = Buffer.byteLength(parts.join("")); let outputLines = 2;
  const append = (part: string): boolean => {
    const bytes = Buffer.byteLength(part);
    const count = part.split("\n").length - 1;
    if (outputBytes + bytes > HISTORY_REVIEW_LIMITS.maxDiffBytes || outputLines + count > HISTORY_REVIEW_LIMITS.maxDiffLines) return false;
    parts.push(part); outputBytes += bytes; outputLines += count; return true;
  };
  let oldPosition = 0; let newPosition = 0; let cursor = 0;
  for (const hunk of hunks) {
    while (cursor < hunk.start) { const line = lines[cursor++]!; if (line.kind !== "+") oldPosition += 1; if (line.kind !== "-") newPosition += 1; }
    const selected = lines.slice(hunk.start, hunk.end);
    const oldCount = selected.filter((line) => line.kind !== "+").length;
    const newCount = selected.filter((line) => line.kind !== "-").length;
    if (!append(`@@ -${oldPosition + (oldCount ? 1 : 0)},${oldCount} +${newPosition + (newCount ? 1 : 0)},${newCount} @@\n`)) {
      return { ...limited("output_limit"), text: parts.join("") };
    }
    for (const line of selected) {
      const part = line.kind + line.text + (line.text.endsWith("\n") ? "" : "\n\\ No newline at end of file\n");
      if (!append(part)) return { ...limited("output_limit"), text: parts.join("") };
      if (line.kind !== "+") oldPosition += 1;
      if (line.kind !== "-") newPosition += 1;
      cursor += 1;
    }
  }
  return { status: "available", text: parts.join(""), truncated: false };
}

function splitLines(text: string): string[] { return text.match(/[^\n]*\n|[^\n]+$/gu) ?? []; }
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function covers(parent: string, path: string): boolean { return !parent || parent === path || path.startsWith(`${parent}/`); }
function requestError(message: string, statusCode: number): Error { return Object.assign(new Error(message), { status: statusCode, statusCode }); }
