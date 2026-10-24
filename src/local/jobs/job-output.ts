/**
 * A background job's output on disk (docs/background-jobs.md, F33): one
 * writer per running job, and the reads every surface shares.
 *
 * Output is the command's combined stdout and stderr, kept byte for byte in
 * `output.log`. When a segment reaches its size the previous segment is
 * dropped and the current one becomes `output.1.log`, so at most two
 * segments are ever kept and the end of the output is always available.
 * Writes are synchronous appends: a chunk is at most a pipe buffer, the page
 * cache absorbs it, and listeners see exactly the bytes already on disk.
 */
import { closeSync, existsSync, openSync, renameSync, statSync, writeSync, unlinkSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { truncateTail } from "@earendil-works/pi-coding-agent";

import { workFoldBackgroundJobLimits } from "../../shared/work-fold-limits.js";
import type { WorkFoldJobOutputCounters } from "./job-records.js";

export const jobOutputFileName = "output.log";
export const jobPreviousOutputFileName = "output.1.log";

function countNewlines(chunk: Buffer): number {
  let count = 0;
  let index = chunk.indexOf(10);
  while (index !== -1) {
    count += 1;
    index = chunk.indexOf(10, index + 1);
  }
  return count;
}

export class JobOutputWriter {
  readonly directory: string;
  readonly #segmentBytes: number;
  #fd: number | null;
  #segmentWritten = 0;
  #segmentNewlines = 0;
  #previousNewlines = 0;
  #bytes = 0;
  #newlines = 0;
  #endsWithNewline = true;
  #droppedBytes = 0;
  #droppedLines = 0;

  constructor(directory: string, options: { segmentBytes?: number } = {}) {
    this.directory = directory;
    this.#segmentBytes = options.segmentBytes ?? workFoldBackgroundJobLimits.outputSegmentBytes;
    this.#fd = openSync(join(directory, jobOutputFileName), "a", 0o600);
  }

  get counters(): WorkFoldJobOutputCounters {
    return {
      bytes: this.#bytes,
      lines: this.#newlines + (this.#endsWithNewline ? 0 : 1),
      droppedBytes: this.#droppedBytes,
      droppedLines: this.#droppedLines,
    };
  }

  /** Bytes of output still kept on disk; a reader scans exactly this much. */
  get keptBytes(): number {
    return this.#bytes - this.#droppedBytes;
  }

  write(chunk: Buffer): void {
    if (this.#fd === null || !chunk.length) return;
    if (this.#segmentWritten > 0 && this.#segmentWritten + chunk.length > this.#segmentBytes) {
      // Segments end on a line boundary, so the first kept line is always
      // whole. Only a single line longer than a segment is split.
      if (this.#endsWithNewline) {
        this.#rotate();
      } else {
        const newline = chunk.indexOf(10);
        if (newline !== -1) {
          this.#append(chunk.subarray(0, newline + 1));
          this.#rotate();
          chunk = chunk.subarray(newline + 1);
          if (!chunk.length) return;
        } else if (this.#segmentWritten + chunk.length > this.#segmentBytes * 2) {
          this.#rotate();
        }
      }
    }
    this.#append(chunk);
  }

  #append(chunk: Buffer): void {
    if (this.#fd === null) return;
    let offset = 0;
    while (offset < chunk.length) offset += writeSync(this.#fd, chunk, offset, chunk.length - offset);
    const newlines = countNewlines(chunk);
    this.#segmentWritten += chunk.length;
    this.#segmentNewlines += newlines;
    this.#bytes += chunk.length;
    this.#newlines += newlines;
    this.#endsWithNewline = chunk[chunk.length - 1] === 10;
  }

  close(): void {
    if (this.#fd === null) return;
    closeSync(this.#fd);
    this.#fd = null;
  }

  #rotate(): void {
    if (this.#fd === null) return;
    closeSync(this.#fd);
    this.#fd = null;
    const previous = join(this.directory, jobPreviousOutputFileName);
    if (existsSync(previous)) {
      // The segment before the previous one leaves: its bytes and lines are
      // dropped from the front of what is kept, and the counters say so.
      this.#droppedBytes += statSync(previous).size;
      this.#droppedLines += this.#previousNewlines;
      unlinkSync(previous);
    }
    renameSync(join(this.directory, jobOutputFileName), previous);
    this.#previousNewlines = this.#segmentNewlines;
    this.#segmentWritten = 0;
    this.#segmentNewlines = 0;
    this.#fd = openSync(join(this.directory, jobOutputFileName), "a", 0o600);
  }
}

// --- presentation ---------------------------------------------------------

/**
 * What a model reads: escape sequences removed, a carriage-return rewrite
 * (a progress bar) reduced to the text it finally showed, and control
 * characters other than tab and newline dropped. Newlines are never added
 * or removed, so line numbers match the bytes on disk.
 */
export function sanitizeJobOutput(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .split("\n")
    .map((line) => {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!trimmed.includes("\r")) return trimmed;
      const parts = trimmed.split("\r").filter((part) => part.length > 0);
      return parts.at(-1) ?? "";
    })
    .join("\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￹-￻]/g, "");
}

export interface JobOutputRead {
  text: string;
  /** First and last line numbers shown, counted from the job's first line; 0 when nothing was shown. */
  fromLine: number;
  toLine: number;
  totalLines: number;
  totalBytes: number;
  droppedLines: number;
  /** More output exists than was shown. */
  truncated: boolean;
  /** Pass as `offset` to read on from here. */
  nextOffset: number;
}

interface Segment {
  path: string;
  size: number;
}

/** The kept segments, oldest first, limited to the bytes the writer reported as kept. */
async function keptSegments(directory: string, keptBytes?: number): Promise<Segment[]> {
  const segments: Segment[] = [];
  for (const name of [jobPreviousOutputFileName, jobOutputFileName]) {
    const path = join(directory, name);
    const info = await stat(path).catch(() => null);
    if (info) segments.push({ path, size: info.size });
  }
  if (keptBytes === undefined) return segments;
  // A live writer may append after the caller's snapshot; never read past it.
  let budget = keptBytes;
  return segments.map((segment) => {
    const size = Math.min(segment.size, Math.max(0, budget));
    budget -= size;
    return { ...segment, size };
  }).filter((segment) => segment.size > 0);
}

async function readRange(path: string, start: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/** Streams kept output line by line, oldest first; `visit` returns false to stop. */
export async function scanJobOutputLines(
  directory: string,
  options: { keptBytes?: number; firstLine: number },
  visit: (line: string, lineNumber: number, terminated: boolean) => boolean,
): Promise<void> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let lineNumber = options.firstLine;
  const chunkSize = 1024 * 1024;
  for (const segment of await keptSegments(directory, options.keptBytes)) {
    for (let start = 0; start < segment.size; start += chunkSize) {
      pending += decoder.write(await readRange(segment.path, start, Math.min(chunkSize, segment.size - start)));
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        if (!visit(pending.slice(0, newline), lineNumber, true)) return;
        lineNumber += 1;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
  }
  pending += decoder.end();
  if (pending.length) visit(pending, lineNumber, false);
}

/**
 * The end of the output, within Pi's `bash` bounds unless told otherwise.
 * Raw bytes are read generously from the end because removing escape
 * sequences shrinks the text before the bounds apply.
 */
export async function readJobOutputTail(
  directory: string,
  counters: WorkFoldJobOutputCounters,
  options: { maxLines?: number; maxBytes?: number; keptBytes?: number } = {},
): Promise<JobOutputRead> {
  const maxLines = options.maxLines ?? workFoldBackgroundJobLimits.readMaxLines;
  const maxBytes = options.maxBytes ?? workFoldBackgroundJobLimits.readMaxBytes;
  const want = maxBytes * 4 + 4096;
  const segments = await keptSegments(directory, options.keptBytes);
  const pieces: Buffer[] = [];
  let need = want;
  let startedMidway = false;
  for (const segment of [...segments].reverse()) {
    if (need <= 0) break;
    const take = Math.min(need, segment.size);
    pieces.unshift(await readRange(segment.path, segment.size - take, take));
    need -= take;
    if (take < segment.size) startedMidway = true;
  }
  if (need <= 0 && segments.length) startedMidway = true;
  let text = Buffer.concat(pieces).toString("utf8");
  // A read that began inside a line or a character starts at the next full line.
  if (startedMidway) {
    const newline = text.indexOf("\n");
    text = newline === -1 ? text : text.slice(newline + 1);
  }
  const endsWithNewline = text.endsWith("\n");
  const body = endsWithNewline ? text.slice(0, -1) : text;
  const tail = truncateTail(sanitizeJobOutput(body), { maxLines, maxBytes });
  const shownLines = body.length ? tail.outputLines : 0;
  const totalLines = counters.lines;
  const fromLine = shownLines ? totalLines - shownLines + 1 : 0;
  return {
    text: body.length ? tail.content : "",
    fromLine,
    toLine: shownLines ? totalLines : 0,
    totalLines,
    totalBytes: counters.bytes,
    droppedLines: counters.droppedLines,
    truncated: shownLines < totalLines - counters.droppedLines || tail.truncated,
    nextOffset: totalLines + 1,
  };
}

/** A page of lines starting at `offset` (1-based, counted from the job's first line). */
export async function readJobOutputPage(
  directory: string,
  counters: WorkFoldJobOutputCounters,
  options: { offset: number; limit?: number; maxBytes?: number; keptBytes?: number },
): Promise<JobOutputRead> {
  const limit = Math.max(1, options.limit ?? workFoldBackgroundJobLimits.readMaxLines);
  const maxBytes = options.maxBytes ?? workFoldBackgroundJobLimits.readMaxBytes;
  const firstKept = counters.droppedLines + 1;
  const start = Math.max(options.offset, firstKept);
  const lines: string[] = [];
  let bytes = 0;
  let fromLine = 0;
  let toLine = 0;
  let cut = false;
  await scanJobOutputLines(directory, { keptBytes: options.keptBytes, firstLine: firstKept }, (raw, lineNumber) => {
    if (lineNumber < start) return true;
    const line = sanitizeJobOutput(raw);
    const size = Buffer.byteLength(line, "utf8") + (lines.length ? 1 : 0);
    if (lines.length >= limit || (lines.length && bytes + size > maxBytes)) {
      cut = true;
      return false;
    }
    lines.push(lines.length || size <= maxBytes ? line : Buffer.from(line, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/u, ""));
    bytes += size;
    if (!fromLine) fromLine = lineNumber;
    toLine = lineNumber;
    return true;
  });
  return {
    text: lines.join("\n"),
    fromLine,
    toLine,
    totalLines: counters.lines,
    totalBytes: counters.bytes,
    droppedLines: counters.droppedLines,
    truncated: cut || (toLine > 0 && toLine < counters.lines) || start > firstKept,
    nextOffset: toLine ? toLine + 1 : Math.max(start, counters.lines + 1),
  };
}

/** One header line a model or a person reads above the output text. */
export function describeJobOutputRead(read: JobOutputRead): string {
  if (!read.totalLines) return "No output yet.";
  const lines = (count: number) => `${count} line${count === 1 ? "" : "s"}`;
  const dropped = read.droppedLines ? `; the first ${lines(read.droppedLines)} were dropped to bound disk use` : "";
  if (!read.fromLine) return `Output: ${lines(read.totalLines)} (${formatBytes(read.totalBytes)})${dropped}; nothing at that offset.`;
  if (read.fromLine === 1 && read.toLine === read.totalLines) return `Output: ${lines(read.totalLines)} (${formatBytes(read.totalBytes)})${dropped}.`;
  return `Output: lines ${read.fromLine}–${read.toLine} of ${read.totalLines} (${formatBytes(read.totalBytes)} in all)${dropped}.`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Fences text with more backticks than any run inside it. */
export function fenceJobOutput(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * The first address on this computer a job's output announces, such as a dev
 * server's "Local: http://localhost:5173/", so a Worker can open it in the
 * built-in browser (docs/built-in-browser.md). An all-interfaces address
 * (0.0.0.0, [::]) is opened as localhost.
 */
export function localServerAddress(text: string): string | null {
  const match = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9-]+\.localhost)(?::\d{2,5})?(?:\/[^\s"'<>`)\]]*)?/i.exec(sanitizeJobOutput(text));
  if (!match) return null;
  try {
    const url = new URL(match[0].replace(/[.,;:!?]+$/, ""));
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "localhost";
    return url.toString();
  } catch {
    return null;
  }
}
