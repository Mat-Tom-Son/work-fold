import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, type Stats } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { spaceConversationDir, spaceStateDir } from "../state-paths.js";
import {
  normalizeConversationTitle,
  untitledConversationTitle,
} from "../../shared/chat-title.js";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  kind?: "conversation_title" | "conversation_lifecycle";
  titleSource?: "placeholder" | "generated" | "manual";
  lifecycle?: ConversationLifecyclePatch;
  landing?: ChatMessageLanding;
  interruption?: ChatMessageInterruption;
  attachments?: ChatMessageAttachmentRef[];
}

/**
 * Reference-style attachment metadata persisted with a user message. The
 * management conversation records absolute paths and links here; the content
 * itself is never copied into the transcript.
 */
export interface ChatMessageAttachmentRef {
  kind: "file" | "folder" | "url";
  target: string;
  name: string;
}

export interface ChatMessageInterruption {
  reason: "provider_error" | "setup_error" | "assistant_error";
  message: string;
  retryAttempts: number;
  provider: string | null;
  model: string | null;
  activities: ChatMessageInterruptionActivity[];
}

export interface ChatMessageInterruptionActivity {
  message: string;
  detail?: string;
  toolName?: string;
  phase?: "queued" | "running" | "streaming" | "complete" | "error";
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  snoozedUntil: string | null;
}

export interface ConversationLifecyclePatch {
  archived?: boolean;
  snoozedUntil?: string | null;
}

export interface ChatMessageLanding {
  summary: string;
  nextActions: string[];
  followUpPrompt: string | null;
  conversationTitle?: string;
  generatedAt: string;
  provider: string;
  model: string;
}

export async function listConversations(spaceRoot: string): Promise<ConversationSummary[]> {
  const files = new Set<string>();
  const dir = conversationsDir(spaceRoot);
  if (existsSync(dir)) {
    for (const file of await readdir(dir)) if (file.endsWith(".jsonl")) files.add(file);
  }
  const cachedIndex = await readConversationIndex(spaceRoot);
  const nextIndex = new Map<string, ConversationIndexEntry>();
  const summaries: ConversationSummary[] = [];
  let recomputed = 0;
  for (const file of files) {
    const conversationId = file.replace(/\.jsonl$/, "");
    if (!isValidConversationId(conversationId)) continue;
    // work-fold writes are append-only, but transcripts remain ordinary files
    // that sync tools and editors may replace. Include filesystem change
    // identity as well as size and mtime so a metadata-preserving rewrite
    // cannot leave the Chat list indefinitely stale.
    const info = await stat(existingConversationPath(spaceRoot, conversationId)).catch(() => null);
    const cached = info ? cachedIndex.get(conversationId) : undefined;
    if (info && cached && conversationIndexMatches(cached, info)) {
      nextIndex.set(conversationId, cached);
      summaries.push(cached.summary);
      continue;
    }
    const { messages, malformedLineCount } = await readConversationFile(spaceRoot, conversationId);
    if (!messages.some((message) => message.role !== "system")) {
      if (malformedLineCount === 0) await unlink(existingConversationPath(spaceRoot, conversationId));
      continue;
    }
    recomputed += 1;
    const summary = conversationSummary(conversationId, messages);
    if (info) nextIndex.set(conversationId, conversationIndexEntry(info, summary));
    summaries.push(summary);
  }
  // Rebuilding the map from scratch drops entries for transcripts that no
  // longer exist, so the cache cannot outgrow the Space it describes.
  if (recomputed || nextIndex.size !== cachedIndex.size) await writeConversationIndex(spaceRoot, nextIndex);
  return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function createConversation(spaceRoot: string, title = untitledConversationTitle): Promise<ConversationSummary> {
  const now = new Date().toISOString();
  const id = `chat-${randomUUID()}`;
  const normalizedTitle = normalizeConversationTitle(title) || untitledConversationTitle;
  await appendMessage(spaceRoot, id, {
    id: randomUUID(),
    role: "system",
    kind: "conversation_title",
    titleSource: normalizedTitle === untitledConversationTitle ? "placeholder" : "manual",
    content: normalizedTitle,
    createdAt: now,
  });
  return { id, title: normalizedTitle, createdAt: now, updatedAt: now, archivedAt: null, snoozedUntil: null };
}

export async function renameConversation(spaceRoot: string, conversationId: string, title: string): Promise<ConversationSummary> {
  const now = new Date().toISOString();
  const normalizedTitle = normalizeConversationTitle(title);
  if (!normalizedTitle) throw new Error("Conversation title is required.");
  if (!(await readConversation(spaceRoot, conversationId)).length) throw new Error("Conversation not found.");
  await appendMessage(spaceRoot, conversationId, {
    id: randomUUID(),
    role: "system",
    kind: "conversation_title",
    titleSource: "manual",
    content: normalizedTitle,
    createdAt: now,
  });
  const messages = await readConversation(spaceRoot, conversationId);
  return conversationSummary(conversationId, messages);
}

export async function setGeneratedConversationTitle(
  spaceRoot: string,
  conversationId: string,
  title: string,
): Promise<ConversationSummary> {
  const messages = await readConversation(spaceRoot, conversationId);
  if (!messages.length) throw new Error("Conversation not found.");
  const current = conversationSummary(conversationId, messages);
  const normalizedTitle = normalizeConversationTitle(title);
  if (!normalizedTitle || manualConversationTitle(messages) || generatedConversationTitle(messages)) return current;
  await appendMessage(spaceRoot, conversationId, {
    id: randomUUID(),
    role: "system",
    kind: "conversation_title",
    titleSource: "generated",
    content: normalizedTitle,
    createdAt: new Date().toISOString(),
  });
  return conversationSummary(conversationId, await readConversation(spaceRoot, conversationId));
}

export async function updateConversationLifecycle(
  spaceRoot: string,
  conversationId: string,
  patch: ConversationLifecyclePatch,
): Promise<ConversationSummary> {
  const messages = await readConversation(spaceRoot, conversationId);
  if (!messages.length) throw new Error("Conversation not found.");
  const current = conversationSummary(conversationId, messages);
  if (typeof patch.snoozedUntil === "string" && Date.parse(patch.snoozedUntil) <= Date.now()) {
    throw new Error("Choose a future snooze time.");
  }
  const lifecycle = normalizeLifecyclePatch(patch);
  if (lifecycle.snoozedUntil && current.archivedAt && lifecycle.archived !== false) {
    throw new Error("Unarchive this Chat before snoozing it.");
  }
  if (lifecycle.archived === true) lifecycle.snoozedUntil = null;
  const now = new Date().toISOString();
  await appendMessage(spaceRoot, conversationId, {
    id: randomUUID(),
    role: "system",
    kind: "conversation_lifecycle",
    content: lifecycleMessage(lifecycle),
    lifecycle,
    createdAt: now,
  });
  return conversationSummary(conversationId, await readConversation(spaceRoot, conversationId));
}

export async function readConversation(spaceRoot: string, conversationId: string): Promise<ChatMessage[]> {
  return (await readConversationFile(spaceRoot, conversationId)).messages;
}

export async function readConversationSummary(
  spaceRoot: string,
  conversationId: string,
): Promise<ConversationSummary | null> {
  const messages = await readConversation(spaceRoot, conversationId);
  return messages.length ? conversationSummary(conversationId, messages) : null;
}

async function readConversationFile(spaceRoot: string, conversationId: string): Promise<{ messages: ChatMessage[]; malformedLineCount: number }> {
  const path = existingConversationPath(spaceRoot, conversationId);
  if (!existsSync(path)) return { messages: [], malformedLineCount: 0 };
  const messages: ChatMessage[] = [];
  let malformedLineCount = 0;
  for (const rawLine of (await readFile(path, "utf8")).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseChatMessage(line);
    if (parsed) messages.push(parsed);
    else malformedLineCount += 1;
  }
  return { messages, malformedLineCount };
}

export async function appendMessage(spaceRoot: string, conversationId: string, message: ChatMessage): Promise<void> {
  const path = conversationPath(spaceRoot, conversationId);
  await mkdir(conversationsDir(spaceRoot), { recursive: true });
  const prefix = await needsLineBreakBeforeAppend(path) ? "\n" : "";
  await appendFile(path, `${prefix}${JSON.stringify(message)}\n`, "utf8");
}

export function conversationsDir(spaceRoot: string): string {
  return spaceConversationDir(spaceRoot);
}

interface ConversationIndexEntry {
  sizeBytes: number;
  modifiedAt: string;
  changedAt: string;
  device: string;
  inode: string;
  summary: ConversationSummary;
}

// Bump whenever conversationSummary title or lifecycle semantics change so a
// structurally valid cache cannot preserve an obsolete derived result.
const conversationIndexVersion = 3;

function conversationIndexFile(spaceRoot: string): string {
  return join(spaceStateDir(spaceRoot), "conversation-index.json");
}

/**
 * A derived summary cache for the Chat list. It lives in machine-local
 * application state rather than the Space's portable `.work-fold/` records
 * because it can always be rebuilt from the transcripts themselves, and every
 * failure path here falls back to doing exactly that.
 */
async function readConversationIndex(spaceRoot: string): Promise<Map<string, ConversationIndexEntry>> {
  const entries = new Map<string, ConversationIndexEntry>();
  try {
    const parsed = JSON.parse(await readFile(conversationIndexFile(spaceRoot), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return entries;
    const record = parsed as { version?: unknown; entries?: unknown };
    if (record.version !== conversationIndexVersion) return entries;
    if (!record.entries || typeof record.entries !== "object" || Array.isArray(record.entries)) return entries;
    for (const [conversationId, value] of Object.entries(record.entries as Record<string, unknown>)) {
      if (!isValidConversationId(conversationId)) continue;
      const entry = parseConversationIndexEntry(conversationId, value);
      if (entry) entries.set(conversationId, entry);
    }
  } catch {
    // A missing, unreadable, or malformed cache is not an error.
  }
  return entries;
}

/**
 * Cache records are ordinary local files, so a summary is rebuilt from the
 * transcript unless every field it claims is well formed and self-consistent.
 */
function parseConversationIndexEntry(conversationId: string, value: unknown): ConversationIndexEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as {
    sizeBytes?: unknown;
    modifiedAt?: unknown;
    changedAt?: unknown;
    device?: unknown;
    inode?: unknown;
    summary?: unknown;
  };
  if (typeof record.sizeBytes !== "number" || !Number.isInteger(record.sizeBytes) || record.sizeBytes < 0) return null;
  if (typeof record.modifiedAt !== "string" || typeof record.changedAt !== "string"
    || typeof record.device !== "string" || typeof record.inode !== "string") return null;
  if (!record.summary || typeof record.summary !== "object" || Array.isArray(record.summary)) return null;
  const summary = record.summary as Partial<ConversationSummary>;
  if (summary.id !== conversationId) return null;
  if (typeof summary.title !== "string" || typeof summary.createdAt !== "string" || typeof summary.updatedAt !== "string") return null;
  if (summary.archivedAt !== null && typeof summary.archivedAt !== "string") return null;
  if (summary.snoozedUntil !== null && typeof summary.snoozedUntil !== "string") return null;
  return {
    sizeBytes: record.sizeBytes,
    modifiedAt: record.modifiedAt,
    changedAt: record.changedAt,
    device: record.device,
    inode: record.inode,
    summary: {
      id: conversationId,
      title: summary.title,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      archivedAt: summary.archivedAt,
      snoozedUntil: summary.snoozedUntil,
    },
  };
}

function conversationIndexMatches(
  entry: ConversationIndexEntry,
  info: Stats,
): boolean {
  return entry.sizeBytes === info.size
    && entry.modifiedAt === info.mtime.toISOString()
    && entry.changedAt === info.ctime.toISOString()
    && entry.device === String(info.dev)
    && entry.inode === String(info.ino);
}

function conversationIndexEntry(
  info: Stats,
  summary: ConversationSummary,
): ConversationIndexEntry {
  return {
    sizeBytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    changedAt: info.ctime.toISOString(),
    device: String(info.dev),
    inode: String(info.ino),
    summary,
  };
}

async function writeConversationIndex(spaceRoot: string, entries: Map<string, ConversationIndexEntry>): Promise<void> {
  const path = conversationIndexFile(spaceRoot);
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await mkdir(spaceStateDir(spaceRoot), { recursive: true });
    const payload = { version: conversationIndexVersion, entries: Object.fromEntries(entries) };
    await writeFile(temporary, `${JSON.stringify(payload)}\n`, "utf8");
    await rename(temporary, path);
  } catch {
    // Losing the cache only costs a rebuild on the next listing.
    await unlink(temporary).catch(() => undefined);
  }
}

function conversationPath(spaceRoot: string, conversationId: string): string {
  assertValidConversationId(conversationId);
  const path = join(conversationsDir(spaceRoot), `${conversationId}.jsonl`);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("Conversation logs cannot be symbolic links or junctions.");
  }
  return path;
}

function existingConversationPath(spaceRoot: string, conversationId: string): string {
  return conversationPath(spaceRoot, conversationId);
}

function parseChatMessage(line: string): ChatMessage | null {
  try {
    const parsed = JSON.parse(line) as Partial<ChatMessage>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.id !== "string") return null;
    if (parsed.role !== "user" && parsed.role !== "assistant" && parsed.role !== "system") return null;
    if (typeof parsed.content !== "string") return null;
    if (typeof parsed.createdAt !== "string") return null;
    const message: ChatMessage = {
      id: parsed.id,
      role: parsed.role,
      content: parsed.content,
      createdAt: parsed.createdAt,
    };
    if (parsed.kind === "conversation_title") {
      message.kind = parsed.kind;
      if (parsed.titleSource === "placeholder" || parsed.titleSource === "generated" || parsed.titleSource === "manual") {
        message.titleSource = parsed.titleSource;
      }
    }
    if (parsed.kind === "conversation_lifecycle") {
      if (!isConversationLifecyclePatch(parsed.lifecycle)) return null;
      message.kind = parsed.kind;
      message.lifecycle = normalizeLifecyclePatch(parsed.lifecycle);
    }
    if (isChatMessageLanding(parsed.landing)) message.landing = parsed.landing;
    if (isChatMessageInterruption(parsed.interruption)) message.interruption = parsed.interruption;
    if (Array.isArray(parsed.attachments)) {
      const attachments = parsed.attachments.filter(isChatMessageAttachmentRef).slice(0, 32);
      if (attachments.length) message.attachments = attachments;
    }
    return message;
  } catch {
    return null;
  }
}

function isChatMessageAttachmentRef(value: unknown): value is ChatMessageAttachmentRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ChatMessageAttachmentRef>;
  return (record.kind === "file" || record.kind === "folder" || record.kind === "url")
    && typeof record.target === "string"
    && record.target.length > 0
    && record.target.length <= 4_096
    && typeof record.name === "string"
    && record.name.length > 0
    && record.name.length <= 512;
}

function isChatMessageInterruption(value: unknown): value is ChatMessageInterruption {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ChatMessageInterruption>;
  return (record.reason === "provider_error" || record.reason === "setup_error" || record.reason === "assistant_error")
    && typeof record.message === "string"
    && typeof record.retryAttempts === "number"
    && Number.isInteger(record.retryAttempts)
    && record.retryAttempts >= 0
    && (record.provider === null || typeof record.provider === "string")
    && (record.model === null || typeof record.model === "string")
    && Array.isArray(record.activities)
    && record.activities.every(isChatMessageInterruptionActivity);
}

function isChatMessageInterruptionActivity(value: unknown): value is ChatMessageInterruptionActivity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ChatMessageInterruptionActivity>;
  return typeof record.message === "string"
    && (record.detail === undefined || typeof record.detail === "string")
    && (record.toolName === undefined || typeof record.toolName === "string")
    && (
      record.phase === undefined
      || record.phase === "queued"
      || record.phase === "running"
      || record.phase === "streaming"
      || record.phase === "complete"
      || record.phase === "error"
    );
}

function isChatMessageLanding(value: unknown): value is ChatMessageLanding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ChatMessageLanding>;
  return (
    typeof record.summary === "string" &&
    Array.isArray(record.nextActions) &&
    record.nextActions.every((item) => typeof item === "string") &&
    (typeof record.followUpPrompt === "string" || record.followUpPrompt === null) &&
    (record.conversationTitle === undefined || typeof record.conversationTitle === "string") &&
    typeof record.generatedAt === "string" &&
    typeof record.provider === "string" &&
    typeof record.model === "string"
  );
}

function conversationSummary(conversationId: string, messages: ChatMessage[]): ConversationSummary {
  const firstUser = messages.find((message) => message.role === "user");
  const lastActivity = [...messages].reverse().find((message) => message.kind !== "conversation_lifecycle");
  const lifecycle = conversationLifecycle(messages);
  return {
    id: conversationId,
    title: manualConversationTitle(messages)
      || generatedConversationTitle(messages)
      || firstUser?.content.slice(0, 70)
      || untitledConversationTitle,
    createdAt: messages[0]?.createdAt ?? new Date().toISOString(),
    updatedAt: lastActivity?.createdAt ?? new Date().toISOString(),
    archivedAt: lifecycle.archivedAt,
    snoozedUntil: lifecycle.snoozedUntil,
  };
}

function conversationLifecycle(messages: ChatMessage[]): { archivedAt: string | null; snoozedUntil: string | null } {
  let archivedAt: string | null = null;
  let snoozedUntil: string | null = null;
  for (const message of messages) {
    if (message.kind !== "conversation_lifecycle" || !message.lifecycle) continue;
    if (message.lifecycle.archived !== undefined) {
      archivedAt = message.lifecycle.archived ? message.createdAt : null;
    }
    if (message.lifecycle.snoozedUntil !== undefined) {
      snoozedUntil = message.lifecycle.snoozedUntil;
    }
  }
  return { archivedAt, snoozedUntil };
}

function manualConversationTitle(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "system" || message.kind !== "conversation_title") continue;
    const title = normalizeConversationTitle(message.content);
    if (message.titleSource === "placeholder" || message.titleSource === "generated") continue;
    // createConversation historically seeded every transcript with a manual
    // "New Chat" title. Treat only that first seed as a placeholder so an
    // Assistant-generated landing title can win, while a later intentional
    // rename to "New Chat" remains authoritative.
    if (index === 0 && title === untitledConversationTitle) continue;
    if (title) return title;
  }
  return null;
}

function generatedConversationTitle(messages: ChatMessage[]): string | null {
  for (const message of [...messages].reverse()) {
    if (message.role === "system" && message.kind === "conversation_title" && message.titleSource === "generated") {
      const title = normalizeConversationTitle(message.content);
      if (title) return title;
    }
    const title = message.landing?.conversationTitle?.replace(/\s+/g, " ").trim();
    if (title) return title.slice(0, 80);
  }
  return null;
}

function normalizeLifecyclePatch(patch: ConversationLifecyclePatch): ConversationLifecyclePatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Chat lifecycle update is required.");
  }
  const lifecycle: ConversationLifecyclePatch = {};
  if (patch.archived !== undefined) {
    if (typeof patch.archived !== "boolean") throw new Error("Archived state must be true or false.");
    lifecycle.archived = patch.archived;
  }
  if (patch.snoozedUntil !== undefined) {
    if (patch.snoozedUntil === null) {
      lifecycle.snoozedUntil = null;
    } else {
      const time = Date.parse(patch.snoozedUntil);
      if (!Number.isFinite(time)) throw new Error("Snooze time is invalid.");
      lifecycle.snoozedUntil = new Date(time).toISOString();
    }
  }
  if (lifecycle.archived === undefined && lifecycle.snoozedUntil === undefined) {
    throw new Error("Choose an archive or snooze change.");
  }
  return lifecycle;
}

function isConversationLifecyclePatch(value: unknown): value is ConversationLifecyclePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const patch = value as ConversationLifecyclePatch;
  const keys = Object.keys(patch);
  if (!keys.length || keys.some((key) => key !== "archived" && key !== "snoozedUntil")) return false;
  return (patch.archived === undefined || typeof patch.archived === "boolean")
    && (patch.snoozedUntil === undefined || patch.snoozedUntil === null || typeof patch.snoozedUntil === "string");
}

function lifecycleMessage(patch: ConversationLifecyclePatch): string {
  if (patch.archived === true) return "Chat archived.";
  if (patch.archived === false) return "Chat restored.";
  if (patch.snoozedUntil === null) return "Chat snooze cleared.";
  return `Chat snoozed until ${patch.snoozedUntil}.`;
}

function assertValidConversationId(conversationId: string): void {
  if (!isValidConversationId(conversationId)) {
    throw new Error("Invalid conversation id.");
  }
}

function isValidConversationId(conversationId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(conversationId);
}

async function needsLineBreakBeforeAppend(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (info.size === 0) return false;
    const lastByte = Buffer.alloc(1);
    await handle.read(lastByte, 0, 1, info.size - 1);
    return lastByte[0] !== 0x0a && lastByte[0] !== 0x0d;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
