import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { admitAttachments, availableAttachmentTokens } from "../src/local/agent/attachment-budget.js";
import { buildTurnContextMessage } from "../src/local/agent/pi-client.js";
import { loadConversationContextAttachmentsForTurn, previewConversationContextAttachment, type LoadedConversationContextAttachment } from "../src/local/conversation-context.js";

function session(contextWindow: number, occupied = 0) {
  return {
    model: { contextWindow, maxTokens: 16_384 },
    messages: [], systemPrompt: "Follow the user's request.", state: { tools: [] },
    getContextUsage: () => ({ tokens: occupied }),
    settingsManager: SettingsManager.inMemory({}),
  } as unknown as Parameters<typeof availableAttachmentTokens>[0];
}
const render = (attachment: LoadedConversationContextAttachment) => buildTurnContextMessage({ contextAttachments: [attachment] });

test("attachment admission uses the selected model and existing context, including text and image metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-context-capacity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "large.txt"), "a".repeat(400_000));
  const smallBudget = availableAttachmentTokens(session(32_768), "Read the attachment.", "");
  const bigBudget = availableAttachmentTokens(session(262_144), "Read the attachment.", "");
  assert.ok(smallBudget < 32_768);
  assert.ok(bigBudget > 90_000, "the old fixed ceiling does not constrain a larger model");
  const small = await loadConversationContextAttachmentsForTurn(root, ["large.txt"], smallBudget);
  const big = await loadConversationContextAttachmentsForTurn(root, ["large.txt"], bigBudget);
  assert.equal(small[0]!.mode, "path_only_reference");
  assert.equal(big[0]!.mode, "full_original_text");
  assert.equal(admitAttachments(big, bigBudget, render)[0]!.includedInPrompt, true);
  const crowdedBudget = availableAttachmentTokens(session(262_144, 245_000), "Read the attachment.", "");
  const crowded = admitAttachments(big, crowdedBudget, render);
  assert.equal(crowded[0]!.includedInPrompt, false);
  assert.equal(crowded[0]!.sourcePath, "large.txt");
  assert.match(crowded[0]!.reason!, /Read the file with tools/);
  assert.equal(big[0]!.includedInPrompt, true, "admission does not mutate prepared input");
  const preview = await previewConversationContextAttachment(root, { path: "large.txt" });
  assert.equal(preview.budgetStatus, "preview");
  assert.match(preview.detail, /selected model and current conversation/);
});

test("unknown context capacity and exhausted capacity preserve all file references", () => {
  assert.equal(availableAttachmentTokens(session(0), "", ""), 0);
  assert.equal(availableAttachmentTokens(session(16_384, 16_384), "", ""), 0);
  const attachment: LoadedConversationContextAttachment = {
    sourcePath: "image.png", sourceFileName: "image.png", sourceSizeBytes: 100,
    mode: "image", includedInPrompt: true, reason: null, estimatedTokens: 500,
    budgetTokens: 1000, provenance: [], warnings: [], userLabel: "Image", detail: "", text: null,
    image: { data: "AA==", mimeType: "image/png", width: 600, height: 600, originalWidth: 600, originalHeight: 600 },
  };
  const limited = admitAttachments([attachment, { ...attachment, sourcePath: "second.png" }], 600, render);
  assert.equal(limited.length, 2);
  assert.equal(limited.filter((item) => item.image).length, 0, "reference overhead is reserved before admitting image bodies");
  const admitted = admitAttachments([attachment], 1000, render);
  assert.equal(admitted[0]!.image?.data, "AA==");
});

test("context accounting includes new user text, host context, system instructions and active tools", () => {
  const empty = session(100_000);
  const base = availableAttachmentTokens(empty, "", "");
  const populated = {
    ...empty, systemPrompt: "s".repeat(14_000),
    state: { tools: [{ name: "example", description: "d".repeat(7000), parameters: { type: "object" } }] },
    messages: [{ role: "user", content: "m".repeat(12_000), timestamp: 0 }],
  } as unknown as Parameters<typeof availableAttachmentTokens>[0];
  assert.ok(availableAttachmentTokens(populated, "u".repeat(7000), "c".repeat(7000)) < base - 12_000);
});

test("explicit attachment configuration only narrows the live model budget", () => {
  const previous = process.env.WORKFOLD_CHAT_CONTEXT_BUDGET_TOKENS;
  try {
    process.env.WORKFOLD_CHAT_CONTEXT_BUDGET_TOKENS = "200000";
    assert.ok(availableAttachmentTokens(session(16_384), "", "") < 16_384);
    process.env.WORKFOLD_CHAT_CONTEXT_BUDGET_TOKENS = "1000";
    assert.equal(availableAttachmentTokens(session(262_144), "", ""), 1000);
  } finally {
    if (previous === undefined) delete process.env.WORKFOLD_CHAT_CONTEXT_BUDGET_TOKENS;
    else process.env.WORKFOLD_CHAT_CONTEXT_BUDGET_TOKENS = previous;
  }
});


test("reference overflow preserves every selected path in a body-free ordinary manifest", async (t) => {
  const { readFile, readdir, stat } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { prepareAttachmentContext } = await import("../src/local/agent/attachment-budget.js");
  const root = await mkdtemp(join(tmpdir(), "work-fold-reference-overflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attachments: LoadedConversationContextAttachment[] = Array.from({ length: 75 }, (_, index) => ({
    sourcePath: `selected/${index}.txt`, sourceFileName: `${index}.txt`, sourceSizeBytes: 4096,
    mode: "full_original_text", includedInPrompt: true, reason: null, estimatedTokens: 2000,
    budgetTokens: 2000, provenance: ["SHOULD_NOT_COPY_PROVENANCE"], warnings: ["SHOULD_NOT_COPY_WARNINGS"], userLabel: "Text", detail: "", text: "SHOULD_NOT_COPY_BODY",
  }));
  const result = await prepareAttachmentContext(attachments, 100, render, { cwd: join(root, "folder"), conversationId: "selected-turn", taskId: "task-1", stateRoot: root });
  assert.deepEqual(result.attachments, []);
  assert.equal(result.referenceManifest?.count, 75);
  assert.ok(result.referenceManifest!.path.startsWith(join(root, "attachment-artifacts")));
  const text = await readFile(result.referenceManifest!.path, "utf8");
  const manifest = JSON.parse(text);
  assert.equal(manifest.owner.conversationId, "selected-turn"); assert.equal(manifest.owner.taskId, "task-1");
  assert.equal(manifest.references.length, 75); assert.equal(manifest.references.at(-1).path, "selected/74.txt");
  assert.deepEqual(manifest.references.map((item: { path: string }) => item.path), attachments.map((item) => item.sourcePath));
  assert.equal(result.referenceManifest!.sha256, createHash("sha256").update(text).digest("hex"));
  assert.doesNotMatch(text, /SHOULD_NOT_COPY/);
  assert.equal((await stat(result.referenceManifest!.path)).mode & 0o777, 0o600);
  assert.match(manifest.retention, /until deliberately removed/);
  const prompt = buildTurnContextMessage({ attachmentReferenceManifest: result.referenceManifest });
  assert.match(prompt, /75 attachment paths/); assert.ok(prompt.includes(result.referenceManifest!.path));
  assert.match(prompt, /Read the manifest.*in ranges/); assert.doesNotMatch(prompt, /selected\/74.txt/);
  const second = await prepareAttachmentContext(attachments, 0, render, { cwd: root, conversationId: "other-turn", stateRoot: root });
  assert.notEqual(second.referenceManifest!.path, result.referenceManifest!.path);
  assert.equal((await readdir(join(root, "attachment-artifacts"))).length, 2, "another turn never overwrites or cleans the first manifest");
  assert.equal(await readFile(result.referenceManifest!.path, "utf8"), text);
});

test("fitting attachment references stay inline without creating artifacts and session fallback is explicit", async (t) => {
  const { access, readFile } = await import("node:fs/promises");
  const { prepareAttachmentContext } = await import("../src/local/agent/attachment-budget.js");
  const root = await mkdtemp(join(tmpdir(), "work-fold-reference-inline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attachment: LoadedConversationContextAttachment = { sourcePath: "one.txt", sourceFileName: "one.txt", sourceSizeBytes: 4,
    mode: "full_original_text", includedInPrompt: true, reason: null, estimatedTokens: 2, budgetTokens: 1000,
    provenance: [], warnings: [], userLabel: "Text", detail: "", text: "text" };
  const inline = await prepareAttachmentContext([attachment], 1000, render, { cwd: root, conversationId: "inline", sessionDir: root });
  assert.equal(inline.attachments[0]!.text, "text"); assert.equal(inline.referenceManifest, undefined);
  await assert.rejects(access(join(root, "attachment-artifacts")), { code: "ENOENT" });
  const overflow = await prepareAttachmentContext([attachment], 0, render, { cwd: root, conversationId: "overflow", sessionDir: root });
  assert.ok(overflow.referenceManifest!.path.startsWith(join(root, "attachment-artifacts")));
  assert.equal(JSON.parse(await readFile(overflow.referenceManifest!.path, "utf8")).references[0].path, "one.txt");
  const empty = await prepareAttachmentContext([], 0, render, { cwd: root, conversationId: "empty", sessionDir: root });
  assert.deepEqual(empty, { attachments: [] });
});
