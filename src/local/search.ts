import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";

import { isOfficeLockFileName } from "./office-lock-files.js";
import { listConversations, readConversation } from "./agent/chat-store.js";
import { decodeRetrievalCursor, encodeRetrievalCursor, retrievalError } from "./retrieval-cursor.js";
import { isAlwaysHiddenWorkFolderEntry, isWorkFolderIgnored, readWorkFolderIgnoreState } from "./work-folder-ignore.js";
import { assertWorkFolderDoesNotContainState, ensureSafeWorkFolderRoot, nestedRegisteredWorkFolderPaths, resolveWorkFolderPath } from "./work-folder.js";

export interface WorkFolderFileMatch { path: string; line: number; preview: string; }
export interface WorkFolderChatMatch { conversationId: string; title: string; role: "user" | "assistant" | "system"; createdAt: string; preview: string; }
export interface WorkFolderSearchCoverage {
  /** Counters describe this page, including excluded directory roots, not their descendants. */
  ignored: number; internal: number; symbolicLink: number; binary: number; unreadable: number; changed: number; nonRegular: number;
  scannedBytes: number;
  /** Live observations, not an atomic filesystem snapshot. */
  consistency: "live";
  complete: boolean;
}
export interface WorkFolderSearchResult {
  query: string; files: WorkFolderFileMatch[]; chats: WorkFolderChatMatch[]; truncated: boolean; scannedFiles: number;
  nextCursor: string | null; coverage: WorkFolderSearchCoverage;
}
export interface WorkFolderSearchOptions {
  includeFiles?: boolean; includeChats?: boolean; maxMatches?: number; maxScannedFiles?: number;
  /** Deprecated spelling, now a resumable page byte budget; never excludes a large file. */
  maxFileBytes?: number;
  maxScannedBytes?: number;
  path?: string; cursor?: string; signal?: AbortSignal;
}
interface DirectoryPosition { path: string; after: string | null; version: string; }
interface FilePosition { path: string; version: string; offset: number; line: number; tail: string; matched: boolean; sampled?: boolean; }
interface SearchCursor { scope: string; stack: DirectoryPosition[]; current?: FilePosition; filesDone: boolean; chatIndex: number; messageIndex: number; chatVersion?: string; transcriptVersion?: string; incomplete: boolean; }

/** Fixed allocations and resumable page budgets; ordinary text files have no size ceiling. */
export async function searchWorkFolder(workFolderRoot: string, rawQuery: string, options: WorkFolderSearchOptions = {}): Promise<WorkFolderSearchResult> {
  const query = rawQuery.trim();
  if (!query) throw retrievalError("Enter something to search for.");
  if (query.length > 64 * 1024) throw retrievalError("Search text is too long.");
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  assertWorkFolderDoesNotContainState(root);
  aborted(options.signal);
  if (options.includeFiles === false && options.path) throw retrievalError("Search path narrows files; use files or all scope.");
  const selected = options.path ? relative(await realpath(root), await realpath(resolveWorkFolderPath(root, options.path))).split(sep).join("/") : "";
  const ignore = (await readWorkFolderIgnoreState(root)).patterns;
  const nested = await nestedRegisteredWorkFolderPaths(root);
  const scope = digest(JSON.stringify([root, query, selected, options.includeFiles !== false, options.includeChats !== false, ignore, nested]));
  const cursor = options.cursor ? decodeRetrievalCursor<SearchCursor>(options.cursor) : undefined;
  if (cursor && cursor.scope !== scope) throw retrievalError("Search selection or ignore rules changed. Start the search again.", 409);
  const state: SearchCursor = cursor ?? { scope, stack: [], filesDone: options.includeFiles === false, chatIndex: 0, messageIndex: 0, incomplete: false };
  const files: WorkFolderFileMatch[] = []; const chats: WorkFolderChatMatch[] = [];
  let resultBytes = 0; let resultBudgetReached = false;
  const admit = (match: WorkFolderFileMatch | WorkFolderChatMatch): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(match));
    if (resultBytes + bytes > 512 * 1024) { resultBudgetReached = true; return false; }
    resultBytes += bytes; return true;
  };
  const coverage: WorkFolderSearchCoverage = { ignored: 0, internal: 0, symbolicLink: 0, binary: 0, unreadable: 0, changed: 0, nonRegular: 0, scannedBytes: 0, consistency: "live", complete: false };
  const maxMatches = count(options.maxMatches, 200, 1000);
  const maxFiles = count(options.maxScannedFiles, 5000, 50000);
  const maxBytes = count(options.maxScannedBytes ?? options.maxFileBytes, 8 * 1024 * 1024, 64 * 1024 * 1024);
  let scannedFiles = 0; let visited = 0;
  const directoryEntries = new Map<string, { entries: import("node:fs").Dirent[]; index: number }>();
  const excluded = (path: string): boolean => {
    if (path.split("/").some((name) => isAlwaysHiddenWorkFolderEntry(name) || isOfficeLockFileName(name))) { coverage.internal++; return true; }
    if (nested.some((child) => path === child || path.startsWith(`${child}/`))) { coverage.internal++; return true; }
    if (isWorkFolderIgnored(path, ignore)) { coverage.ignored++; return true; }
    return false;
  };
  const safe = async (path: string): Promise<BigIntStats> => {
    aborted(options.signal);
    // Recheck ancestors on every open; a continuation cannot follow a replaced symlink.
    const absolute = resolveWorkFolderPath(root, path);
    const info = await lstat(absolute, { bigint: true });
    if (info.isSymbolicLink()) throw retrievalError("Search source became a symbolic link. Start the search again.", 409);
    return info;
  };
  if (!cursor && !state.filesDone) {
    if (selected && excluded(selected)) state.filesDone = true;
    else {
      const info = await safe(selected);
      if (info.isDirectory()) state.stack.push({ path: selected, after: null, version: identity(info) });
      else if (info.isFile()) state.current = filePosition(selected, info);
      else { coverage.nonRegular++; state.filesDone = true; }
    }
  }
  for (const frame of state.stack) {
    if (identity(await safe(frame.path).catch(() => { throw retrievalError("A searched directory changed. Start the search again.", 409); })) !== frame.version) throw retrievalError("A searched directory changed. Start the search again.", 409);
  }
  while (!state.filesDone && !resultBudgetReached && files.length < maxMatches && scannedFiles < maxFiles && visited < maxFiles && coverage.scannedBytes < maxBytes) {
    aborted(options.signal);
    if (state.current) {
      const current = state.current;
      const initial = await safe(current.path).catch((error) => {
        if (cursor) throw retrievalError("A searched file changed or disappeared. Start the search again.", 409);
        if ((error as { statusCode?: number }).statusCode) throw error;
        coverage.unreadable++; state.incomplete = true; return null;
      });
      if (initial && identity(initial) !== current.version) throw retrievalError("A searched file changed. Start the search again.", 409);
      scannedFiles++;
      if (!initial || await scanFile(root, current, initial, query.toLocaleLowerCase(), maxMatches, maxBytes, files, coverage, admit, options.signal)) delete state.current;
      if (!state.current && !state.stack.length) state.filesDone = true;
      continue;
    }
    const frame = state.stack.at(-1);
    if (!frame) { state.filesDone = true; break; }
    let listing = directoryEntries.get(frame.path);
    if (!listing) {
      const entries = await readdir(resolveWorkFolderPath(root, frame.path), { withFileTypes: true }).catch(() => null);
      if (!entries) { coverage.unreadable++; state.incomplete = true; state.stack.pop(); continue; }
      // Sort once per directory/page, then advance by index. A wide directory
      // must not be sorted or searched again for every individual entry.
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      let index = 0;
      if (frame.after !== null) {
        let end = entries.length;
        while (index < end) {
          const middle = Math.floor((index + end) / 2);
          if (entries[middle]!.name <= frame.after) index = middle + 1;
          else end = middle;
        }
      }
      listing = { entries, index }; directoryEntries.set(frame.path, listing);
    }
    const entry = listing.entries[listing.index++];
    if (!entry) { state.stack.pop(); directoryEntries.delete(frame.path); continue; }
    frame.after = entry.name; visited++;
    const path = frame.path ? `${frame.path}/${entry.name}` : entry.name;
    if (excluded(path)) continue;
    if (entry.isSymbolicLink()) { coverage.symbolicLink++; continue; }
    const info = await safe(path).catch(() => null);
    if (!info) { coverage.unreadable++; state.incomplete = true; continue; }
    if (info.isDirectory()) state.stack.push({ path, after: null, version: identity(info) });
    else if (info.isFile()) state.current = filePosition(path, info);
    else coverage.nonRegular++;
  }
  // Empty stack after the final file has an exact end, not a fake extra page.
  if (!state.current && !state.stack.length) state.filesDone = true;
  let chatsDone = options.includeChats === false;
  if (state.filesDone && !chatsDone) {
    const conversations = await listConversations(root);
    const version = digest(JSON.stringify(conversations));
    if (state.chatVersion && state.chatVersion !== version) throw retrievalError("Chats changed. Start the search again.", 409);
    state.chatVersion = version;
    let inspected = 0;
    while (state.chatIndex < conversations.length && !resultBudgetReached && chats.length + files.length < maxMatches && inspected < maxFiles) {
      aborted(options.signal);
      const conversation = conversations[state.chatIndex]!;
      const messages = await readConversation(root, conversation.id);
      const transcriptVersion = digest(JSON.stringify(messages));
      if (state.transcriptVersion && state.transcriptVersion !== transcriptVersion) throw retrievalError("A searched Chat changed. Start the search again.", 409);
      state.transcriptVersion = transcriptVersion; inspected++;
      while (state.messageIndex < messages.length && chats.length + files.length < maxMatches) {
        const message = messages[state.messageIndex++]!;
        if (["conversation_lifecycle", "conversation_title", "assistant_continuation"].includes(message.kind ?? "")) continue;
        const text = message.content.replace(/\s+/g, " ");
        const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
        if (at >= 0) {
          const match = { conversationId: conversation.id, title: conversation.title, role: message.role, createdAt: message.createdAt, preview: preview(text, at, query.length) };
          if (!admit(match)) { state.messageIndex--; break; }
          chats.push(match);
        }
      }
      if (state.messageIndex < messages.length) break;
      state.chatIndex++; state.messageIndex = 0; delete state.transcriptVersion;
    }
    chatsDone = state.chatIndex >= conversations.length;
  }
  aborted(options.signal);
  state.incomplete ||= coverage.unreadable > 0 || coverage.changed > 0;
  const more = !state.filesDone || !chatsDone;
  coverage.complete = !more && !state.incomplete;
  return { query, files, chats, scannedFiles, truncated: !coverage.complete, nextCursor: more ? encodeRetrievalCursor(state) : null, coverage };
}

async function scanFile(root: string, current: FilePosition, initial: BigIntStats, needle: string, maxMatches: number, maxBytes: number, files: WorkFolderFileMatch[], coverage: WorkFolderSearchCoverage, admit: (match: WorkFolderFileMatch) => boolean, signal?: AbortSignal): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const resultStart = files.length;
  try {
    handle = await open(resolveWorkFolderPath(root, current.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (identity(await handle.stat({ bigint: true })) !== current.version) throw retrievalError("A searched file changed. Start the search again.", 409);
    if (!current.sampled) {
      const sample = Buffer.alloc(Math.min(8192, maxBytes - coverage.scannedBytes));
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      coverage.scannedBytes += bytesRead; current.sampled = true;
      if (looksBinary(sample.subarray(0, bytesRead))) { coverage.binary++; return true; }
    }
    const buffer = Buffer.alloc(64 * 1024 + 4);
    while (current.offset < Number(initial.size) && files.length < maxMatches && coverage.scannedBytes < maxBytes) {
      aborted(signal);
      const size = Math.min(64 * 1024, Math.max(4, maxBytes - coverage.scannedBytes), Number(initial.size) - current.offset);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(size + 3, buffer.length), current.offset);
      if (!bytesRead) break;
      let length = Math.min(size, bytesRead);
      while (length < bytesRead && length > 0 && (buffer[length]! & 0xc0) === 0x80) length--;
      if (!length) length = Math.min(4, bytesRead);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
      catch { files.splice(resultStart); coverage.binary++; return true; }
      const parts = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
      for (const part of parts) {
        if (files.length >= maxMatches) break;
        const terminated = part.endsWith("\n");
        const body = terminated ? part.slice(0, -1).replace(/\r$/u, "") : part;
        const joined = current.tail + body;
        const at = current.matched ? -1 : joined.toLocaleLowerCase().indexOf(needle);
        if (at >= 0) {
          const match = { path: current.path, line: current.line, preview: preview(joined, at, needle.length) };
          if (!admit(match)) {
            if (identity(await handle.stat({ bigint: true })) !== current.version) throw retrievalError("A searched file changed. Start the search again.", 409);
            return false;
          }
          files.push(match); current.matched = true;
        }
        const consumed = Buffer.byteLength(part);
        current.offset += consumed; coverage.scannedBytes += consumed;
        current.tail = terminated ? "" : joined.slice(-(needle.length + 80));
        if (terminated) { current.line++; current.matched = false; }
      }
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(resolveWorkFolderPath(root, current.path), { bigint: true });
    if (identity(after) !== current.version || identity(pathAfter) !== current.version) {
      files.splice(resultStart); coverage.changed++; return true;
    }
    return current.offset >= Number(initial.size);
  } catch (error) {
    if ((error as Error).name === "AbortError" || (error as { statusCode?: number }).statusCode) throw error;
    files.splice(resultStart); coverage.unreadable++; return true;
  } finally { await handle?.close().catch(() => undefined); }
}
function filePosition(path: string, info: BigIntStats): FilePosition { return { path, version: identity(info), offset: 0, line: 1, tail: "", matched: false }; }
function identity(info: BigIntStats): string { return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(":"); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function preview(line: string, at: number, length: number): string { const start = Math.max(0, at - 80); const value = `${start ? "…" : ""}${line.slice(start, at + length + 80).trim()}`; return value.length > 240 ? `${value.slice(0, 240)}…` : value; }
function looksBinary(bytes: Buffer): boolean { if (bytes.includes(0)) return true; let controls = 0; for (const byte of bytes) if (byte < 9 || byte > 13 && byte < 32) controls++; return bytes.length > 0 && controls / bytes.length > 0.1; }
function count(value: number | undefined, fallback: number, maximum: number): number { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw retrievalError(`Search page budget must be between 1 and ${maximum}.`); return value; }
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw Object.assign(new Error("Search cancelled."), { name: "AbortError" }); }
