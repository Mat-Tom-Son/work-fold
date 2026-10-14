import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConversationContextReferencesForTurn, previewConversationContextReference } from "../src/local/conversation-context.js";
import { buildTurnContextMessage, turnImages } from "../src/local/agent/pi-client.js";

test("Folder attachments reference original documents regardless of format or extraction size", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-file-references-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "notes.md"), "BODY_MUST_NOT_BE_INLINED");
  await writeFile(join(root, "document.docx"), "This is not an OOXML archive.");
  await writeFile(join(root, "scan.pdf"), Buffer.from([0, 1, 2, 3]));
  const large = await open(join(root, "large.bin"), "w");
  await large.truncate(40 * 1024 * 1024);
  await large.close();
  const paths = ["notes.md", "document.docx", "scan.pdf", "large.bin"];
  for (const path of paths) {
    const staged = await previewConversationContextReference(root, { path });
    assert.equal(staged.sourcePath, path);
    assert.equal(staged.mode, "path_only_reference");
    assert.equal(staged.reason, null, "a normal reference is not an extraction failure");
    assert.deepEqual(staged.warnings, []);
    assert.equal("text" in staged, false);
  }
  const loaded = await loadConversationContextReferencesForTurn(root, [...paths, "notes.md"], 100);
  assert.deepEqual(loaded.map((attachment) => attachment.sourcePath), paths);
  assert.ok(loaded.every((attachment) => !attachment.includedInPrompt && attachment.text === null && attachment.reason === null));
  const context = buildTurnContextMessage({ contextAttachments: loaded });
  for (const path of paths) assert.ok(context.includes(JSON.stringify(path)));
  assert.match(context, /person attached this file path/);
  assert.match(context, /Use your file or document tools/);
  assert.doesNotMatch(context, /BODY_MUST_NOT_BE_INLINED|not an OOXML archive|Attachment note/);
});

test("staging rejects unavailable files and unsafe paths; a later deletion remains visible to the Worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-file-reference-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "Notes"));
  await assert.rejects(previewConversationContextReference(root, { path: "missing.txt" }), /File not found/);
  await assert.rejects(previewConversationContextReference(root, { path: "Notes" }), /Only files/);
  await assert.rejects(previewConversationContextReference(root, { path: "../outside.txt" }));
  await assert.rejects(previewConversationContextReference(root, { path: ".pi/config.json" }));
  await writeFile(join(root, "notes.txt"), "Original");
  await previewConversationContextReference(root, { path: "notes.txt" });
  await rm(join(root, "notes.txt"));
  const loaded = await loadConversationContextReferencesForTurn(root, ["notes.txt"]);
  assert.equal(loaded[0]!.sourcePath, "notes.txt");
  assert.match(loaded[0]!.reason ?? "", /File not found/);
  assert.match(buildTurnContextMessage({ contextAttachments: loaded }), /Attachment note: File not found: notes.txt/);
});

test("referencing work-folder files preserves image vision and never inlines a renamed text file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-image-references-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "screenshot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  await writeFile(join(root, "fake.png"), "TEXT_MUST_NOT_BE_INLINED");
  const loaded = await loadConversationContextReferencesForTurn(root, ["screenshot.png", "fake.png"], 10_000);
  assert.equal(loaded[0]!.mode, "image");
  assert.equal(turnImages({ contextAttachments: loaded }).length, 1);
  assert.equal(loaded[1]!.mode, "path_only_reference");
  assert.equal(loaded[1]!.text, null);
  assert.doesNotMatch(buildTurnContextMessage({ contextAttachments: loaded }), /TEXT_MUST_NOT_BE_INLINED/);
});
