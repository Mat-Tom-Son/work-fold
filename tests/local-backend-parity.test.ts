import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { loadConversationContextAttachmentsForTurn, previewConversationContextAttachment } from "../src/local/conversation-context.js";
import { createWorkspaceCheckpoint, listFileVersions, restoreFileVersion } from "../src/local/history.js";
import { startLocalApi } from "../src/local/server.js";
import { configureWorkspaceStateRoot, workspaceConversationDir, workspaceManifestFile, workspaceStateDir } from "../src/local/state-paths.js";
import { readWorkspaceIgnoreState, setWorkspaceIgnoreState } from "../src/local/workspace-ignore.js";
import { getWorkspaceEntryInfo, registerLinkedWorkspace, scanWorkspaceTree } from "../src/local/workspace.js";

test("linked Spaces keep portable identity in .workspace while operational state remains external", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-parity-linked-"));
  const root = join(sandbox, "ordinary-folder");
  const state = join(sandbox, "state");
  await mkdir(join(root, "Drafts"), { recursive: true });
  await writeFile(join(root, "Drafts", "notes.txt"), "first version\n", "utf8");
  configureWorkspaceStateRoot(state);
  t.after(async () => {
    configureWorkspaceStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  const space = await registerLinkedWorkspace(root);
  await setWorkspaceIgnoreState(root, ["Drafts/notes.txt"], true);
  assert.deepEqual((await readWorkspaceIgnoreState(root)).patterns, ["Drafts/notes.txt"]);
  assert.equal((await scanWorkspaceTree(root))[0]?.children?.[0]?.ignored, true);
  const lazyTree = await scanWorkspaceTree(root, 0);
  assert.deepEqual(lazyTree[0]?.children, []);
  assert.equal(lazyTree[0]?.hasChildren, true, "a shallow tree must advertise folders that can be expanded lazily");
  assert.equal((await scanWorkspaceTree(root, 0, "Drafts"))[0]?.path, "Drafts/notes.txt");
  const visibleTree = await scanWorkspaceTree(root, 20, "", { includeIgnored: false });
  assert.equal(visibleTree[0]?.path, "Drafts");
  assert.deepEqual(visibleTree[0]?.children, []);
  assert.equal((await scanWorkspaceTree(root, 0, "", { includeIgnored: false }))[0]?.hasChildren, false);

  const first = await createWorkspaceCheckpoint(root, { reason: "manual", label: "First" });
  await writeFile(join(root, "Drafts", "notes.txt"), "second version\n", "utf8");
  await createWorkspaceCheckpoint(root, { reason: "manual", label: "Second" });
  const versions = await listFileVersions(root, "Drafts/notes.txt");
  assert.equal(versions.length, 2);
  const firstVersion = versions.find((version) => version.checkpointId === first.checkpointId);
  assert.ok(firstVersion);
  const restored = await restoreFileVersion(root, "Drafts/notes.txt", firstVersion.hashSha256);
  assert.equal(restored.safetyCheckpointId.startsWith("cp-"), true);
  assert.equal(await readFile(join(root, "Drafts", "notes.txt"), "utf8"), "first version\n");

  const docx = new JSZip();
  docx.file("word/document.xml", [
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    "<w:body><w:p><w:r><w:t>Quarterly planning notes</w:t></w:r></w:p></w:body>",
    "</w:document>",
  ].join(""));
  await writeFile(join(root, "Plan.docx"), await docx.generateAsync({ type: "nodebuffer" }));
  const preview = await previewConversationContextAttachment(root, { path: "Plan.docx" });
  assert.equal(preview.mode, "full_extracted_text");
  assert.equal(preview.includedInPrompt, true);
  const [attachment] = await loadConversationContextAttachmentsForTurn(root, ["Plan.docx"]);
  assert.match(attachment?.text ?? "", /Quarterly planning notes/);

  const info = await getWorkspaceEntryInfo(root, "Plan.docx");
  assert.equal(info.officeDocument, true);
  assert.equal(info.hashSha256?.length, 64);
  assert.equal(existsSync(workspaceManifestFile(root)), true);
  assert.equal(existsSync(join(root, ".kai")), false);
  assert.equal(existsSync(join(root, ".kaiignore")), false);
  assert.equal(existsSync(workspaceStateDir(root)), true);
  assert.deepEqual((await readdir(root)).sort(), [".workspace", "Drafts", "Plan.docx"]);
  assert.deepEqual((await scanWorkspaceTree(root)).map((entry) => entry.name), ["Drafts", "Plan.docx"]);
  assert.equal(space.location.storage, "linked");
});

test("local API exposes path-safe file operations, undo checkpoints, chat rename, attachments, and file events", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-parity-api-"));
  const historyEvents: Array<{ reason: "pre_turn" | "post_turn" }> = [];
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workspaceBase: join(sandbox, "content"),
    loadEnv: false,
    onHistoryCheckpoint: (event) => historyEvents.push(event),
  });
  t.after(async () => {
    await api.close();
    configureWorkspaceStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  const created = await json(`${api.origin}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Operations" }),
  }) as { workspace: { id: string; rootPath: string } };
  const { id, rootPath } = created.workspace;

  const files = new FormData();
  files.set("targetFolderPath", "");
  files.set("relativePaths", JSON.stringify(["Drafts/note.txt", "Archive/.keep"]));
  files.append("files", new Blob(["before\n"]), "note.txt");
  files.append("files", new Blob(["keep\n"]), ".keep");
  await ok(`${api.origin}/api/workspaces/${id}/upload-local-files`, { method: "POST", body: files });

  const createdFolder = await json(`${api.origin}/api/workspaces/${id}/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentPath: "", name: "Inbox" }),
  }) as { folder: { path: string } };
  assert.equal(createdFolder.folder.path, "Inbox");
  const createdFile = await json(`${api.origin}/api/workspaces/${id}/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentPath: "Inbox", name: "draft.md", text: "draft\n" }),
  }) as { file: { path: string } };
  assert.equal(createdFile.file.path, "Inbox/draft.md");
  const renamedFile = await json(`${api.origin}/api/workspaces/${id}/rename-local-entry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Inbox/draft.md", newName: "final.md" }),
  }) as { renamed: { path: string } };
  assert.equal(renamedFile.renamed.path, "Inbox/final.md");

  const info = await json(`${api.origin}/api/workspaces/${id}/file-info?path=Drafts%2Fnote.txt`) as { kind: string; hashSha256: string };
  assert.equal(info.kind, "file");
  assert.equal(info.hashSha256.length, 64);
  const existing = await json(`${api.origin}/api/workspaces/${id}/paths-exist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: ["note.txt", "missing.txt"] }),
  }) as { existing: string[] };
  assert.deepEqual(existing.existing, ["Drafts/note.txt"]);

  const edited = await json(`${api.origin}/api/workspaces/${id}/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Drafts/note.txt", text: "after\n" }),
  }) as { safetyCheckpointId: string };
  assert.match(edited.safetyCheckpointId, /^cp-/);

  const moved = await json(`${api.origin}/api/workspaces/${id}/move-local-entry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourcePath: "Drafts/note.txt", targetFolderPath: "Archive" }),
  }) as { moved: { path: string }; safetyCheckpointId: string };
  assert.equal(moved.moved.path, "Archive/note.txt");
  assert.match(moved.safetyCheckpointId, /^cp-/);

  const deleted = await json(`${api.origin}/api/workspaces/${id}/local-file`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Archive/note.txt" }),
  }) as { deleted: true; safetyCheckpointId: string };
  assert.equal(deleted.deleted, true);
  assert.equal(existsSync(join(rootPath, "Archive", "note.txt")), false);
  await ok(`${api.origin}/api/workspaces/${id}/history/checkpoints/${deleted.safetyCheckpointId}/restore`, { method: "POST" });
  assert.equal(await readFile(join(rootPath, "Archive", "note.txt"), "utf8"), "after\n");

  const deletedFolder = await json(`${api.origin}/api/workspaces/${id}/local-file`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Inbox" }),
  }) as { kind: string; safetyCheckpointId: string };
  assert.equal(deletedFolder.kind, "folder");
  assert.equal(existsSync(join(rootPath, "Inbox")), false);
  await ok(`${api.origin}/api/workspaces/${id}/history/checkpoints/${deletedFolder.safetyCheckpointId}/restore`, { method: "POST" });
  assert.equal(await readFile(join(rootPath, "Inbox", "final.md"), "utf8"), "draft\n");

  const versions = await json(`${api.origin}/api/workspaces/${id}/history/file-versions?path=Drafts%2Fnote.txt`) as { versions: unknown[] };
  assert.ok(versions.versions.length >= 1);

  const conversation = await json(`${api.origin}/api/workspaces/${id}/conversations`, { method: "POST" }) as { conversation: { id: string } };
  const renamed = await json(`${api.origin}/api/workspaces/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Planning notes" }),
  }) as { conversation: { title: string } };
  assert.equal(renamed.conversation.title, "Planning notes");
  assert.equal(existsSync(join(workspaceConversationDir(rootPath), `${conversation.conversation.id}.jsonl`)), true);

  const archived = await json(`${api.origin}/api/workspaces/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  }) as { conversation: { archivedAt: string | null; snoozedUntil: string | null } };
  assert.ok(archived.conversation.archivedAt);
  assert.equal(archived.conversation.snoozedUntil, null);

  const restored = await json(`${api.origin}/api/workspaces/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: false }),
  }) as { conversation: { archivedAt: string | null } };
  assert.equal(restored.conversation.archivedAt, null);

  const snoozedUntil = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const snoozed = await json(`${api.origin}/api/workspaces/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snoozedUntil }),
  }) as { conversation: { snoozedUntil: string | null } };
  assert.equal(snoozed.conversation.snoozedUntil, snoozedUntil);

  const rejectedSnoozedTurn = await fetch(`${api.origin}/api/workspaces/${id}/conversations/${conversation.conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "Do not continue this deferred Chat yet.", contextPaths: [] }),
  });
  assert.equal(rejectedSnoozedTurn.status, 409);
  assert.match(await rejectedSnoozedTurn.text(), /Resume this Chat/);

  const invalidLifecycleMutation = await fetch(`${api.origin}/api/workspaces/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true, snoozedUntil: null }),
  });
  assert.equal(invalidLifecycleMutation.status, 400);

  await ok(`${api.origin}/api/workspaces/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snoozedUntil: null }),
  });

  const rejectedTurn = await fetch(`${api.origin}/api/workspaces/${id}/conversations/${conversation.conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "This must not be appended", selectedPath: "../outside.txt", contextPaths: [] }),
  });
  assert.equal(rejectedTurn.status, 400);
  const transcriptAfterRejectedTurn = await json(`${api.origin}/api/workspaces/${id}/conversations/${conversation.conversation.id}`) as {
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(transcriptAfterRejectedTurn.messages.some((message) => message.content === "This must not be appended"), false);
  const acceptedAfterRejectedTurn = await fetch(`${api.origin}/api/workspaces/${id}/conversations/${conversation.conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "/session", selectedPath: "Inbox/final.md", contextPaths: [] }),
  });
  assert.equal(acceptedAfterRejectedTurn.status, 202, await acceptedAfterRejectedTurn.text());
  await waitFor(() => historyEvents.some((event) => event.reason === "post_turn"));
  assert.deepEqual(historyEvents.map((event) => event.reason), ["pre_turn", "post_turn"]);

  const attachment = await json(`${api.origin}/api/workspaces/${id}/context-attachments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Archive/note.txt" }),
  }) as { attachment: { mode: string; includedInPrompt: boolean } };
  assert.deepEqual(attachment.attachment, { ...attachment.attachment, mode: "full_original_text", includedInPrompt: true });

  const controller = new AbortController();
  const eventsResponse = await fetch(`${api.origin}/api/workspaces/${id}/file-events`, { signal: controller.signal });
  assert.equal(eventsResponse.ok, true);
  const eventReader = eventsResponse.body?.getReader();
  const firstEvent = await eventReader?.read();
  assert.match(new TextDecoder().decode(firstEvent?.value), /"type":"ready"/);
  await writeFile(join(rootPath, "watch-me.txt"), "watch\n", "utf8");
  let eventTimeout: NodeJS.Timeout | undefined;
  const changedEvent = await Promise.race([
    eventReader?.read(),
    new Promise<never>((_, reject) => {
      eventTimeout = setTimeout(() => reject(new Error("Timed out waiting for a Space file event.")), 3_000);
      eventTimeout.unref();
    }),
  ]);
  if (eventTimeout) clearTimeout(eventTimeout);
  assert.match(new TextDecoder().decode(changedEvent?.value), /"type":"file_event"/);
  assert.match(new TextDecoder().decode(changedEvent?.value), /watch-me\.txt/);
  await eventReader?.cancel();
  controller.abort();

  const traversal = await fetch(`${api.origin}/api/workspaces/${id}/file-info?path=..%2Foutside.txt`);
  assert.equal(traversal.ok, false);
  const unsafeRename = await fetch(`${api.origin}/api/workspaces/${id}/rename-local-entry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Inbox/final.md", newName: "../escape.md" }),
  });
  assert.equal(unsafeRename.ok, false);
  const rootDelete = await fetch(`${api.origin}/api/workspaces/${id}/local-file`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "./" }),
  });
  assert.equal(rootDelete.ok, false);
  assert.equal(existsSync(rootPath), true);
});

test("Space lifecycle renames external metadata and removes linked versus managed roots safely", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-lifecycle-api-"));
  const stateRoot = join(sandbox, "state");
  const contentRoot = join(sandbox, "managed");
  const linkedRoot = join(sandbox, "linked-folder");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(join(linkedRoot, "keep.txt"), "keep", "utf8");
  const api = await startLocalApi({ port: 0, stateBase: stateRoot, workspaceBase: contentRoot, loadEnv: false });
  t.after(async () => {
    await api.close();
    configureWorkspaceStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  const linked = await json(`${api.origin}/api/workspaces/local-folder`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rootPath: linkedRoot }),
  }) as { workspace: { id: string; rootPath: string } };
  const renamedLinked = await json(`${api.origin}/api/workspaces/${linked.workspace.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Renamed linked Space" }),
  }) as { workspace: { name: string; rootPath: string } };
  assert.equal(renamedLinked.workspace.name, "Renamed linked Space");
  assert.equal(renamedLinked.workspace.rootPath, linkedRoot);
  assert.equal(await readFile(join(linkedRoot, "keep.txt"), "utf8"), "keep");
  assert.equal(existsSync(workspaceManifestFile(linkedRoot)), true);
  const removedLinked = await json(`${api.origin}/api/workspaces/${linked.workspace.id}`, { method: "DELETE" }) as { removed: true; deleted: boolean };
  assert.deepEqual(removedLinked, { removed: true, deleted: false, rootPath: linkedRoot, cleanupPending: false });
  assert.equal(existsSync(linkedRoot), true);
  assert.equal(existsSync(workspaceManifestFile(linkedRoot)), true);
  assert.equal(existsSync(workspaceStateDir(linkedRoot)), false);

  const managed = await json(`${api.origin}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Managed lifecycle" }),
  }) as { workspace: { id: string; rootPath: string } };
  await writeFile(join(managed.workspace.rootPath, "delete-with-space.txt"), "managed", "utf8");
  const removedManaged = await json(`${api.origin}/api/workspaces/${managed.workspace.id}`, { method: "DELETE" }) as { removed: true; deleted: boolean; rootPath: string };
  assert.equal(removedManaged.deleted, true);
  assert.equal(removedManaged.rootPath, managed.workspace.rootPath);
  assert.equal(existsSync(managed.workspace.rootPath), false);
  assert.equal(existsSync(workspaceStateDir(managed.workspace.rootPath)), false);
});

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text) as unknown;
}

async function ok(url: string, init?: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, text);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for asynchronous API work.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}
