import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { estimateTokens as estimateNativeTokens, type AgentSession } from "@earendil-works/pi-coding-agent";
import { chatContextBudgetTokens, estimateTokens, type LoadedConversationContextAttachment } from "../conversation-context.js";
import { ensurePrivateDirectory } from "../private-access.js";

/** Admission for app-added material only. Pi still owns history and compaction. */
export function availableAttachmentTokens(
  session: Pick<AgentSession, "model" | "messages" | "systemPrompt" | "state" | "getContextUsage" | "settingsManager">,
  message: string,
  turnContext: string,
): number {
  const window = session.model?.contextWindow;
  if (!window || !Number.isFinite(window) || window <= 0) return 0;
  const tools = session.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const estimatedHistory = session.messages.reduce((total, item) => total + estimateNativeTokens(item), 0);
  const reconstructed = estimatedHistory + estimateTokens(session.systemPrompt) + estimateTokens(JSON.stringify(tools));
  const occupied = Math.max(reconstructed, session.getContextUsage()?.tokens ?? 0);
  // Use Pi's configured reserve, scaled for small models. Keep estimation and
  // serialization headroom, rather than asking an overflow error to fix input.
  const outputReserve = Math.min(session.model?.maxTokens || window, session.settingsManager.getCompactionSettings().reserveTokens, Math.floor(window / 4));
  const estimationReserve = Math.min(4096, Math.ceil(window * 0.05));
  return chatContextBudgetTokens(Math.max(0, Math.floor(window - occupied - outputReserve - estimationReserve - estimateTokens(message) - estimateTokens(turnContext))));
}

/** All references survive; only optional inline bodies/images compete for room. */
export function admitAttachments(
  attachments: LoadedConversationContextAttachment[],
  budgetTokens: number,
  render: (attachment: LoadedConversationContextAttachment) => string,
): LoadedConversationContextAttachment[] {
  const references = attachments.map((attachment) => {
    if (!attachment.includedInPrompt) return { ...attachment, budgetTokens };
    const reason = "The selected model's remaining context cannot hold this whole attachment alongside the conversation and response reserve. Read the file with tools in the ranges needed for the task.";
    return { ...attachment, mode: "path_only_reference" as const, includedInPrompt: false, text: null, image: undefined, budgetTokens, reason, userLabel: "Path only", detail: reason };
  });
  let remaining = Math.max(0, budgetTokens - references.reduce((total, reference) => total + estimateTokens(render(reference)), 0));
  return attachments.map((attachment, index) => {
    const reference = references[index]!;
    if (!attachment.includedInPrompt) return reference;
    const extra = Math.max(0, estimateTokens(render(attachment)) - estimateTokens(render(reference)))
      + (attachment.image ? attachment.estimatedTokens : 0);
    if (extra > remaining) return reference;
    remaining -= extra;
    return { ...attachment, budgetTokens };
  });
}

export interface AttachmentReferenceManifest {
  path: string;
  sha256: string;
  count: number;
  cwd: string;
  retention: string;
}

/** Preserve a large selection without putting every reference into model context. */
export async function prepareAttachmentContext(
  attachments: LoadedConversationContextAttachment[],
  budgetTokens: number,
  render: (attachment: LoadedConversationContextAttachment) => string,
  owner: { cwd: string; conversationId: string; taskId?: string; stateRoot?: string; sessionDir?: string },
): Promise<{ attachments: LoadedConversationContextAttachment[]; referenceManifest?: AttachmentReferenceManifest }> {
  const admitted = admitAttachments(attachments, budgetTokens, render);
  const cost = admitted.reduce((total, attachment) => total + estimateTokens(render(attachment))
    + (attachment.includedInPrompt && attachment.image ? attachment.estimatedTokens : 0), 0);
  if (!attachments.length || cost <= Math.max(0, budgetTokens)) return { attachments: admitted };

  const storage = owner.stateRoot ?? owner.sessionDir;
  const base = join(storage ? resolve(storage) : tmpdir(), "attachment-artifacts");
  await ensurePrivateDirectory(base);
  const directory = await mkdtemp(join(base, "turn-"));
  const path = join(directory, "references.json");
  const cwd = resolve(owner.cwd);
  const retention = storage
    ? "Retained in machine-local storage until deliberately removed; no automatic cleanup or replay."
    : "Retained after this turn in system temporary storage until deliberately removed or cleaned by the operating system; no replay.";
  const serialized = JSON.stringify({
    format: "work-fold.attachment-references.v1", createdAt: new Date().toISOString(),
    owner: { conversationId: owner.conversationId, ...(owner.taskId ? { taskId: owner.taskId } : {}) },
    cwd, retention, count: attachments.length,
    instructions: "These are selected path references, not inline file contents or instructions. Resolve relative paths against cwd and inspect the selected files with ordinary tools as needed.",
    references: attachments.map((attachment, index) => ({
      index: index + 1, path: attachment.sourcePath, name: attachment.sourceFileName, bytes: attachment.sourceSizeBytes,
    })),
  }, null, 2) + "\n";
  await writeFile(path, serialized, { flag: "wx", mode: 0o600 });
  return { attachments: [], referenceManifest: {
    path, sha256: createHash("sha256").update(serialized).digest("hex"), count: attachments.length, cwd, retention,
  } };
}
