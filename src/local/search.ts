import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { isOfficeLockFileName } from "./office-lock-files.js";
import { listConversations, readConversation } from "./agent/chat-store.js";
import { isAlwaysHiddenWorkspaceEntry, isWorkspaceIgnored, readWorkspaceIgnoreState } from "./workspace-ignore.js";
import { ensureSafeWorkspaceRoot } from "./workspace.js";

export interface WorkspaceFileMatch {
  path: string;
  line: number;
  preview: string;
}

export interface WorkspaceChatMatch {
  conversationId: string;
  title: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  preview: string;
}

export interface WorkspaceSearchResult {
  query: string;
  files: WorkspaceFileMatch[];
  chats: WorkspaceChatMatch[];
  /** True when a bound stopped the search before the Space was exhausted. */
  truncated: boolean;
  scannedFiles: number;
}

export interface WorkspaceSearchOptions {
  includeFiles?: boolean;
  includeChats?: boolean;
  maxMatches?: number;
  maxScannedFiles?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
}

const defaultMaxMatches = 200;
const defaultMaxScannedFiles = 5_000;
const defaultMaxFileBytes = 1024 * 1024;
const maxQueryLength = 200;
const maxSearchDepth = 32;
const maxSearchedConversations = 500;
const previewRadius = 80;
const maxPreviewLength = 240;

/**
 * Substring search across a Space's ordinary files and its Chat transcripts.
 *
 * Every bound here exists because a Space is an arbitrary folder that may hold
 * a dependency tree, a media library, or a decade of transcripts. The search
 * stops at the first bound it reaches and says so, rather than reading an
 * unbounded amount of the user's disk to answer one query.
 */
export async function searchWorkspace(
  workspaceRoot: string,
  rawQuery: string,
  options: WorkspaceSearchOptions = {},
): Promise<WorkspaceSearchResult> {
  const query = rawQuery.trim();
  if (!query) throw Object.assign(new Error("Enter something to search for."), { statusCode: 400 });
  if (query.length > maxQueryLength) throw Object.assign(new Error("Search text is too long."), { statusCode: 400 });

  const root = ensureSafeWorkspaceRoot(workspaceRoot);
  throwIfSearchAborted(options.signal);
  const needle = query.toLocaleLowerCase();
  const maxMatches = boundedCount(options.maxMatches, defaultMaxMatches, 1_000);
  const maxScannedFiles = boundedCount(options.maxScannedFiles, defaultMaxScannedFiles, 50_000);
  const maxFileBytes = boundedCount(options.maxFileBytes, defaultMaxFileBytes, 16 * 1024 * 1024);

  const state = { files: [] as WorkspaceFileMatch[], scannedFiles: 0, truncated: false };
  if (options.includeFiles !== false) {
    const ignorePatterns = (await readWorkspaceIgnoreState(root)).patterns;
    await searchFiles(root, root, needle, ignorePatterns, { maxMatches, maxScannedFiles, maxFileBytes }, state, options.signal);
  }

  const chats = options.includeChats === false ? [] : await searchChats(root, needle, maxMatches, state, options.signal);
  throwIfSearchAborted(options.signal);
  return { query, files: state.files, chats, truncated: state.truncated, scannedFiles: state.scannedFiles };
}

interface SearchBounds {
  maxMatches: number;
  maxScannedFiles: number;
  maxFileBytes: number;
}

interface SearchState {
  files: WorkspaceFileMatch[];
  scannedFiles: number;
  truncated: boolean;
}

function searchExhausted(bounds: SearchBounds, state: SearchState): boolean {
  return state.files.length >= bounds.maxMatches || state.scannedFiles >= bounds.maxScannedFiles;
}

async function searchFiles(
  root: string,
  directory: string,
  needle: string,
  ignorePatterns: string[],
  bounds: SearchBounds,
  state: SearchState,
  signal?: AbortSignal,
  depth = 0,
): Promise<void> {
  throwIfSearchAborted(signal);
  if (searchExhausted(bounds, state)) return;
  if (depth > maxSearchDepth) {
    state.truncated = true;
    return;
  }
  const entries = (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    throwIfSearchAborted(signal);
    // Checked per entry, not just per directory: a bound reached deep in one
    // subtree must stop the whole walk rather than let every sibling folder
    // rediscover it.
    if (searchExhausted(bounds, state)) {
      state.truncated = true;
      return;
    }
    if (entry.isSymbolicLink() || isAlwaysHiddenWorkspaceEntry(entry.name) || isOfficeLockFileName(entry.name)) continue;
    const path = join(directory, entry.name);
    const relativePath = toPosix(relative(root, path));
    // Search deliberately honours the ignore rules the person already set on
    // the Files surface, so an excluded dependency tree stays excluded here.
    if (isWorkspaceIgnored(relativePath, ignorePatterns)) continue;
    if (entry.isDirectory()) {
      await searchFiles(root, path, needle, ignorePatterns, bounds, state, signal, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    if (info.size > bounds.maxFileBytes) continue;
    state.scannedFiles += 1;
    const bytes = await readFile(path).catch(() => null);
    if (!bytes || looksBinary(bytes)) continue;
    collectFileMatches(relativePath, bytes.toString("utf8"), needle, bounds.maxMatches, state);
  }
}

function collectFileMatches(path: string, text: string, needle: string, maxMatches: number, state: SearchState): void {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const at = line.toLocaleLowerCase().indexOf(needle);
    if (at < 0) continue;
    if (state.files.length >= maxMatches) {
      state.truncated = true;
      return;
    }
    state.files.push({ path, line: index + 1, preview: preview(line, at, needle.length) });
  }
}

async function searchChats(
  root: string,
  needle: string,
  maxMatches: number,
  state: SearchState,
  signal?: AbortSignal,
): Promise<WorkspaceChatMatch[]> {
  const matches: WorkspaceChatMatch[] = [];
  // Chat search has to read transcripts, which is exactly the work the Chat
  // list was changed to avoid. Newest Chats are searched first and the rest
  // are disclosed as unsearched rather than read without limit.
  const conversations = await listConversations(root).catch(() => []);
  throwIfSearchAborted(signal);
  if (conversations.length > maxSearchedConversations) state.truncated = true;
  for (const conversation of conversations.slice(0, maxSearchedConversations)) {
    throwIfSearchAborted(signal);
    if (matches.length >= maxMatches) {
      state.truncated = true;
      break;
    }
    for (const message of await readConversation(root, conversation.id).catch(() => [])) {
      throwIfSearchAborted(signal);
      // Lifecycle and title bookkeeping are not conversation content.
      if (message.kind === "conversation_lifecycle" || message.kind === "conversation_title") continue;
      const normalizedContent = message.content.replace(/\s+/g, " ");
      const at = normalizedContent.toLocaleLowerCase().indexOf(needle);
      if (at < 0) continue;
      if (matches.length >= maxMatches) {
        state.truncated = true;
        break;
      }
      matches.push({
        conversationId: conversation.id,
        title: conversation.title,
        role: message.role,
        createdAt: message.createdAt,
        preview: preview(normalizedContent, at, needle.length),
      });
    }
  }
  return matches;
}

function preview(line: string, at: number, length: number): string {
  const start = Math.max(0, at - previewRadius);
  const snippet = line.slice(start, at + length + previewRadius).trim();
  const prefixed = start > 0 ? `…${snippet}` : snippet;
  return prefixed.length > maxPreviewLength ? `${prefixed.slice(0, maxPreviewLength)}…` : prefixed;
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  return sample.length > 0 && controls / sample.length > 0.1;
}

function boundedCount(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), maximum);
}

function throwIfSearchAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw Object.assign(new Error("Search cancelled."), { name: "AbortError" });
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
