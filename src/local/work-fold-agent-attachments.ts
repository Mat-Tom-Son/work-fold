import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import {
  chatContextBudgetTokens,
  estimateTokens,
  normalizeText,
  readableAttachmentText,
  type LoadedConversationContextAttachment,
} from "./conversation-context.js";
import { containsReservedWorkFolderPathSegment } from "./work-folder-path-policy.js";

/**
 * work-fold agent attachments are references, not copies. A Worker Chat
 * stages dropped material inside the work-folder because its transcript is
 * portable data; the work-fold agent transcript is deliberately machine-local,
 * so its attachments carry absolute local paths (or links) and the only copy
 * in the flow stays the restore-pointed `files add` into a destination
 * work-folder.
 */
export type WorkFoldAgentAttachmentKind = "file" | "folder" | "url";

export interface WorkFoldAgentAttachmentRef {
  kind: WorkFoldAgentAttachmentKind;
  /** Absolute local path for file/folder attachments, or the full http(s) link. */
  target: string;
  /** Short display name: the base name, or the link without its scheme. */
  name: string;
}

export const maxWorkFoldAgentAttachments = 1_000;
const maxWorkFoldAgentAttachmentTargetLength = 4_096;
const maxWorkFoldAgentAttachmentFileBytes = 32 * 1024 * 1024;

/**
 * Classifies raw `--attach` values (or popover drops) into typed references.
 * Relative paths resolve against the caller's working directory, links must be
 * http(s), and missing sources are rejected at send time — a clear refusal
 * beats accepting a turn about material that is not there.
 */
export async function classifyWorkFoldAgentAttachments(
  raw: readonly string[],
  cwd: string,
): Promise<WorkFoldAgentAttachmentRef[]> {
  if (raw.length > maxWorkFoldAgentAttachments) {
    throw new Error(`At most ${maxWorkFoldAgentAttachments} attachments are allowed per request.`);
  }
  const refs: WorkFoldAgentAttachmentRef[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Attachment values cannot be empty.");
    if (trimmed.length > maxWorkFoldAgentAttachmentTargetLength) {
      throw new Error(`Attachment values must be at most ${maxWorkFoldAgentAttachmentTargetLength} characters.`);
    }
    if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(trimmed)) {
      throw new Error("Attachment values contain unsupported control characters.");
    }
    if (/^https?:\/\//i.test(trimmed)) {
      if (/\s/.test(trimmed)) throw new Error(`Links cannot contain spaces: ${trimmed}`);
      let url: URL;
      try {
        url = new URL(trimmed);
      } catch {
        throw new Error(`Invalid link: ${trimmed}`);
      }
      if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
        throw new Error(`Only http(s) links can be attached: ${trimmed}`);
      }
      if (url.username || url.password) {
        throw new Error("Links containing embedded credentials cannot be attached.");
      }
      const ref: WorkFoldAgentAttachmentRef = {
        kind: "url",
        target: url.toString(),
        name: url.toString().replace(/^https?:\/\//i, "").replace(/\/+$/, "").slice(0, 120),
      };
      if (!seen.has(ref.target)) refs.push(ref);
      seen.add(ref.target);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      throw new Error(`Only http(s) links can be attached: ${trimmed}`);
    }
    const path = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
    if (containsReservedWorkFolderPathSegment(path)) {
      throw new Error("Reserved work-fold, legacy product, and Pi metadata cannot be attached.");
    }
    const info = await lstat(path).catch(() => null);
    if (!info) throw new Error(`Attachment not found: ${trimmed}`);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links cannot be attached: ${trimmed}`);
    if (!info.isFile() && !info.isDirectory()) throw new Error(`Only files, folders, and links can be attached: ${trimmed}`);
    const ref: WorkFoldAgentAttachmentRef = {
      kind: info.isDirectory() ? "folder" : "file",
      target: path,
      name: basename(path) || path,
    };
    if (!seen.has(ref.target)) refs.push(ref);
    seen.add(ref.target);
  }
  return refs;
}

export type WorkFoldAgentAttachmentDispositionStatus = "placed" | "registered" | "unrecorded";

export interface WorkFoldAgentAttachmentDisposition {
  attachment: WorkFoldAgentAttachmentRef;
  status: WorkFoldAgentAttachmentDispositionStatus;
  workFolderId?: string;
  workFolderName?: string;
  copied?: string[];
  checkpointId?: string | null;
}

/**
 * The slice of a recorded request action that disposition accounting reads.
 * Structural on purpose: the durable request record owns the full action
 * shape, and this module must not depend on it.
 */
export interface WorkFoldAgentAttachmentActionRef {
  command: string;
  workFolderId?: string;
  workFolderName?: string;
  sources?: string[];
  copied?: string[];
  checkpointId?: string | null;
  workFolderRoot?: string;
}

/**
 * Accounts for every attachment against the recorded actions. Nothing may
 * silently disappear from the story: an attachment with no mechanically
 * matched action is reported as `unrecorded`, and the work-fold agent's own
 * report remains the narrative for it.
 */
export function workFoldAgentAttachmentDispositions(input: {
  attachments: readonly WorkFoldAgentAttachmentRef[];
  actions: readonly WorkFoldAgentAttachmentActionRef[];
}): WorkFoldAgentAttachmentDisposition[] {
  return input.attachments.map((attachment) => {
    if (attachment.kind !== "url") {
      const placed = input.actions.find((action) =>
        action.command === "files.add" && action.sources?.includes(attachment.target));
      if (placed) {
        return {
          attachment,
          status: "placed" as const,
          workFolderId: placed.workFolderId,
          workFolderName: placed.workFolderName,
          copied: placed.copied ?? [],
          checkpointId: placed.checkpointId ?? null,
        };
      }
      const registered = input.actions.find((action) =>
        action.command === "work-folders.register" && action.workFolderRoot === attachment.target);
      if (registered) {
        return {
          attachment,
          status: "registered" as const,
          workFolderId: registered.workFolderId,
          workFolderName: registered.workFolderName,
        };
      }
    }
    return { attachment, status: "unrecorded" as const };
  });
}

/** Links are handed to the turn as a separate typed list, never as fake files. */
export function workFoldAgentAttachmentLinks(refs: readonly WorkFoldAgentAttachmentRef[]): string[] {
  return refs.filter((ref) => ref.kind === "url").map((ref) => ref.target);
}

/**
 * Loads file and folder references for one turn with the same degrade ladder
 * as Worker Chat context: readable files inline within the shared token
 * budget, folders and unreadable or oversized files stay honest path-only
 * references the work-fold agent inspects with its own tools.
 */
export async function loadWorkFoldAgentAttachmentsForTurn(
  refs: readonly WorkFoldAgentAttachmentRef[],
  availableTokens?: number,
): Promise<LoadedConversationContextAttachment[]> {
  const budgetTokens = chatContextBudgetTokens(availableTokens);
  let remaining = budgetTokens;
  const loaded: LoadedConversationContextAttachment[] = [];
  for (const ref of refs) {
    if (ref.kind === "url") continue;
    if (ref.kind === "folder") {
      loaded.push(pathOnlyWorkFoldAgentAttachment(ref, budgetTokens, "Folders are attached by path; inventory the folder with file tools before making claims about its contents."));
      continue;
    }
    loaded.push(await loadWorkFoldAgentFileAttachment(ref, remaining, budgetTokens));
    const last = loaded.at(-1)!;
    if (last.includedInPrompt) remaining -= last.estimatedTokens;
  }
  return loaded;
}

async function loadWorkFoldAgentFileAttachment(
  ref: WorkFoldAgentAttachmentRef,
  remaining: number,
  budgetTokens: number,
): Promise<LoadedConversationContextAttachment> {
  try {
    const info = await lstat(ref.target);
    if (!info.isFile()) throw new Error("The attached path is no longer an ordinary file.");
    if (remaining <= 0) throw new Error("No inline attachment capacity remains for this model and conversation. Read the file with tools.");
    if (info.size > maxWorkFoldAgentAttachmentFileBytes) {
      throw new Error("The file exceeds the 32 MB inline extraction budget. It remains available by path; inspect it with tools in the ranges needed.");
    }
    const bytes = await readFile(ref.target);
    const extracted = await readableAttachmentText(ref.name, bytes);
    const text = normalizeText(extracted.text);
    const estimatedTokens = estimateTokens(text);
    if (estimatedTokens > remaining) {
      return pathOnlyWorkFoldAgentAttachment(
        ref,
        budgetTokens,
        `The readable text is about ${estimatedTokens.toLocaleString()} tokens, which does not fit the remaining ${remaining.toLocaleString()} tokens of the context budget.`,
        info.size,
        estimatedTokens,
        extracted.provenance,
        extracted.warnings,
      );
    }
    return {
      sourcePath: ref.target,
      sourceFileName: ref.name,
      sourceSizeBytes: info.size,
      mode: extracted.mode,
      includedInPrompt: true,
      reason: null,
      estimatedTokens,
      budgetTokens,
      provenance: extracted.provenance,
      warnings: extracted.warnings,
      userLabel: extracted.mode === "full_original_text" ? "Full text" : "Extracted text",
      detail: `Attached from its original location (about ${estimatedTokens.toLocaleString()} tokens). The file was not copied anywhere; place it with \`work-fold files add\` when it belongs in a work-folder.`,
      text,
    };
  } catch (error) {
    return pathOnlyWorkFoldAgentAttachment(
      ref,
      budgetTokens,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function pathOnlyWorkFoldAgentAttachment(
  ref: WorkFoldAgentAttachmentRef,
  budgetTokens: number,
  reason: string,
  sourceSizeBytes = 0,
  estimatedTokens = 0,
  provenance: string[] = [],
  warnings: string[] = [],
): LoadedConversationContextAttachment {
  return {
    sourcePath: ref.target,
    sourceFileName: ref.name,
    sourceSizeBytes,
    mode: "path_only_reference",
    includedInPrompt: false,
    reason,
    estimatedTokens,
    budgetTokens,
    provenance,
    warnings,
    userLabel: "Path only",
    detail: `The absolute path is attached. Inspect it with file tools. Reason: ${reason}`,
    text: null,
  };
}
