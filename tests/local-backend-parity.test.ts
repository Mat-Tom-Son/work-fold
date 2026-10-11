import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { loadConversationContextAttachmentsForTurn, previewConversationContextAttachment } from "../src/local/conversation-context.js";
import { createWorkFolderCheckpoint, listFileVersions, restoreFileVersion } from "../src/local/history.js";
import { startLocalApi } from "../src/local/server.js";
import { configureWorkFoldStateRoot, workFolderConversationDir, workFolderManifestFile, workFolderStateDir } from "../src/local/state-paths.js";
import { readWorkFolderIgnoreState, setWorkFolderIgnoreState } from "../src/local/work-folder-ignore.js";
import { getWorkFolderEntryInfo, registerLinkedWorkFolder, scanWorkFolderTree } from "../src/local/work-folder.js";

test("linked work-folders keep portable identity in .work-fold while legacy metadata and operational state remain external", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-parity-linked-"));
  const root = join(sandbox, "ordinary-folder");
  const state = join(sandbox, "state");
  await mkdir(join(root, "Drafts"), { recursive: true });
  await mkdir(join(root, ".workspace"), { recursive: true });
  await writeFile(join(root, ".workspace", "work-folder.json"), "legacy metadata", "utf8");
  await writeFile(join(root, "Drafts", "notes.txt"), "first version\n", "utf8");
  configureWorkFoldStateRoot(state);
  t.after(async () => {
    configureWorkFoldStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  const workFolder = await registerLinkedWorkFolder(root);
  await setWorkFolderIgnoreState(root, ["Drafts/notes.txt"], true);
  assert.deepEqual((await readWorkFolderIgnoreState(root)).patterns, ["Drafts/notes.txt"]);
  assert.equal((await scanWorkFolderTree(root)).entries[0]?.children?.[0]?.ignored, true);
  const lazyTree = (await scanWorkFolderTree(root, 0)).entries;
  assert.deepEqual(lazyTree[0]?.children, []);
  assert.equal(lazyTree[0]?.hasChildren, true, "a shallow tree must advertise folders that can be expanded lazily");
  assert.equal((await scanWorkFolderTree(root, 0, "Drafts")).entries[0]?.path, "Drafts/notes.txt");
  const visibleTree = (await scanWorkFolderTree(root, 20, "", { includeIgnored: false })).entries;
  assert.equal(visibleTree[0]?.path, "Drafts");
  assert.deepEqual(visibleTree[0]?.children, []);
  assert.equal((await scanWorkFolderTree(root, 0, "", { includeIgnored: false })).entries[0]?.hasChildren, false);

  const first = await createWorkFolderCheckpoint(root, { reason: "manual", label: "First" });
  await writeFile(join(root, "Drafts", "notes.txt"), "second version\n", "utf8");
  await createWorkFolderCheckpoint(root, { reason: "manual", label: "Second" });
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

  const info = await getWorkFolderEntryInfo(root, "Plan.docx");
  assert.equal(info.officeDocument, true);
  assert.equal(info.hashSha256?.length, 64);
  assert.equal(existsSync(workFolderManifestFile(root)), true);
  assert.equal(existsSync(join(root, ".kai")), false);
  assert.equal(existsSync(join(root, ".kaiignore")), false);
  assert.equal(existsSync(workFolderStateDir(root)), true);
  assert.deepEqual((await readdir(root)).sort(), [".work-fold", ".workspace", "Drafts", "Plan.docx"]);
  assert.deepEqual((await scanWorkFolderTree(root)).entries.map((entry) => entry.name), ["Drafts", "Plan.docx"]);
  assert.equal(workFolder.location.storage, "linked");
});

test("local API exposes path-safe file operations, undo checkpoints, chat rename, attachments, and file events", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-parity-api-"));
  const historyEvents: Array<{ reason: "pre_turn" | "post_turn" }> = [];
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    onHistoryCheckpoint: (event) => historyEvents.push(event),
  });
  t.after(async () => {
    await api.close();
    configureWorkFoldStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  const created = await json(`${api.origin}/api/work-folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Operations" }),
  }) as { workFolder: { id: string; workFolderRoot: string } };
  const { id, workFolderRoot } = created.workFolder;

  const files = new FormData();
  files.set("targetFolderPath", "");
  files.set("relativePaths", JSON.stringify(["Drafts/note.txt", "Archive/.keep"]));
  files.append("files", new Blob(["before\n"]), "note.txt");
  files.append("files", new Blob(["keep\n"]), ".keep");
  await ok(`${api.origin}/api/work-folders/${id}/upload-local-files`, { method: "POST", body: files });

  const createdFolder = await json(`${api.origin}/api/work-folders/${id}/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentPath: "", name: "Inbox" }),
  }) as { folder: { path: string } };
  assert.equal(createdFolder.folder.path, "Inbox");
  const createdFile = await json(`${api.origin}/api/work-folders/${id}/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentPath: "Inbox", name: "draft.md", text: "draft\n" }),
  }) as { file: { path: string } };
  assert.equal(createdFile.file.path, "Inbox/draft.md");
  const renamedFile = await json(`${api.origin}/api/work-folders/${id}/rename-local-entry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Inbox/draft.md", newName: "final.md" }),
  }) as { renamed: { path: string } };
  assert.equal(renamedFile.renamed.path, "Inbox/final.md");

  const info = await json(`${api.origin}/api/work-folders/${id}/file-info?path=Drafts%2Fnote.txt`) as { kind: string; hashSha256: string };
  assert.equal(info.kind, "file");
  assert.equal(info.hashSha256.length, 64);

  // The file tab's inline preview: bounded text renders with its size, a
  // recognized image extension defers to the raw-file route, and binary
  // content declines with its reason instead of decoding garbage.
  const textPreview = await json(`${api.origin}/api/work-folders/${id}/file-preview?path=Drafts%2Fnote.txt`) as { preview: { kind: string; content: string; truncated: boolean } };
  assert.equal(textPreview.preview.kind, "text");
  assert.equal(textPreview.preview.content, "before\n");
  assert.equal(textPreview.preview.truncated, false);
  await writeFile(join(workFolderRoot, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  const imagePreview = await json(`${api.origin}/api/work-folders/${id}/file-preview?path=photo.png`) as { preview: { kind: string } };
  assert.equal(imagePreview.preview.kind, "image");
  await writeFile(join(workFolderRoot, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 5, 6, 7]));
  const binaryPreview = await json(`${api.origin}/api/work-folders/${id}/file-preview?path=blob.bin`) as { preview: { kind: string; reason: string } };
  assert.equal(binaryPreview.preview.kind, "none");
  assert.equal(binaryPreview.preview.reason, "binary");
  const previewTraversal = await fetch(`${api.origin}/api/work-folders/${id}/file-preview?path=..%2Foutside.txt`);
  assert.equal(previewTraversal.ok, false);
  const existing = await json(`${api.origin}/api/work-folders/${id}/paths-exist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: ["note.txt", "missing.txt"] }),
  }) as { existing: string[] };
  assert.deepEqual(existing.existing, ["Drafts/note.txt"]);

  const edited = await json(`${api.origin}/api/work-folders/${id}/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Drafts/note.txt", text: "after\n" }),
  }) as { safetyCheckpointId: string };
  assert.match(edited.safetyCheckpointId, /^cp-/);

  const moved = await json(`${api.origin}/api/work-folders/${id}/move-local-entry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourcePath: "Drafts/note.txt", targetFolderPath: "Archive" }),
  }) as { moved: { path: string }; safetyCheckpointId: string };
  assert.equal(moved.moved.path, "Archive/note.txt");
  assert.match(moved.safetyCheckpointId, /^cp-/);

  const deleted = await json(`${api.origin}/api/work-folders/${id}/local-file`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Archive/note.txt" }),
  }) as { deleted: true; safetyCheckpointId: string };
  assert.equal(deleted.deleted, true);
  assert.equal(existsSync(join(workFolderRoot, "Archive", "note.txt")), false);
  await ok(`${api.origin}/api/work-folders/${id}/history/checkpoints/${deleted.safetyCheckpointId}/restore`, { method: "POST" });
  assert.equal(await readFile(join(workFolderRoot, "Archive", "note.txt"), "utf8"), "after\n");

  const deletedFolder = await json(`${api.origin}/api/work-folders/${id}/local-file`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Inbox" }),
  }) as { kind: string; safetyCheckpointId: string };
  assert.equal(deletedFolder.kind, "folder");
  assert.equal(existsSync(join(workFolderRoot, "Inbox")), false);
  await ok(`${api.origin}/api/work-folders/${id}/history/checkpoints/${deletedFolder.safetyCheckpointId}/restore`, { method: "POST" });
  assert.equal(await readFile(join(workFolderRoot, "Inbox", "final.md"), "utf8"), "draft\n");

  const versions = await json(`${api.origin}/api/work-folders/${id}/history/file-versions?path=Drafts%2Fnote.txt`) as { versions: unknown[] };
  assert.ok(versions.versions.length >= 1);

  const conversation = await json(`${api.origin}/api/work-folders/${id}/conversations`, { method: "POST" }) as { conversation: { id: string } };
  const renamed = await json(`${api.origin}/api/work-folders/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Planning notes" }),
  }) as { conversation: { title: string } };
  assert.equal(renamed.conversation.title, "Planning notes");
  assert.equal(existsSync(join(workFolderConversationDir(workFolderRoot), `${conversation.conversation.id}.jsonl`)), true);

  const archived = await json(`${api.origin}/api/work-folders/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  }) as { conversation: { archivedAt: string | null; snoozedUntil: string | null } };
  assert.ok(archived.conversation.archivedAt);
  assert.equal(archived.conversation.snoozedUntil, null);

  const restored = await json(`${api.origin}/api/work-folders/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: false }),
  }) as { conversation: { archivedAt: string | null } };
  assert.equal(restored.conversation.archivedAt, null);

  const snoozedUntil = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const snoozed = await json(`${api.origin}/api/work-folders/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snoozedUntil }),
  }) as { conversation: { snoozedUntil: string | null } };
  assert.equal(snoozed.conversation.snoozedUntil, snoozedUntil);

  const rejectedSnoozedTurn = await fetch(`${api.origin}/api/work-folders/${id}/conversations/${conversation.conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "Do not continue this deferred Chat yet.", contextPaths: [] }),
  });
  assert.equal(rejectedSnoozedTurn.status, 409);
  assert.match(await rejectedSnoozedTurn.text(), /Resume this Chat/);

  const invalidLifecycleMutation = await fetch(`${api.origin}/api/work-folders/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true, snoozedUntil: null }),
  });
  assert.equal(invalidLifecycleMutation.status, 400);

  await ok(`${api.origin}/api/work-folders/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snoozedUntil: null }),
  });

  const rejectedTurn = await fetch(`${api.origin}/api/work-folders/${id}/conversations/${conversation.conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "This must not be appended", selectedPath: "../outside.txt", contextPaths: [] }),
  });
  assert.equal(rejectedTurn.status, 400);
  const transcriptAfterRejectedTurn = await json(`${api.origin}/api/work-folders/${id}/conversations/${conversation.conversation.id}`) as {
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(transcriptAfterRejectedTurn.messages.some((message) => message.content === "This must not be appended"), false);
  const acceptedAfterRejectedTurn = await fetch(`${api.origin}/api/work-folders/${id}/conversations/${conversation.conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "/session", selectedPath: "Inbox/final.md", contextPaths: [] }),
  });
  assert.equal(acceptedAfterRejectedTurn.status, 202, await acceptedAfterRejectedTurn.text());
  await waitFor(() => historyEvents.some((event) => event.reason === "post_turn"));
  assert.deepEqual(historyEvents.map((event) => event.reason), ["pre_turn", "post_turn"]);

  const attachment = await json(`${api.origin}/api/work-folders/${id}/context-attachments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Archive/note.txt" }),
  }) as { attachment: { mode: string; includedInPrompt: boolean } };
  assert.deepEqual(attachment.attachment, { ...attachment.attachment, mode: "path_only_reference", includedInPrompt: false });

  const controller = new AbortController();
  const eventsResponse = await fetch(`${api.origin}/api/work-folders/${id}/file-events`, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
  });
  assert.equal(eventsResponse.ok, true);
  assert.ok(eventsResponse.body);
  const events = readWorkFolderFileEvents(eventsResponse.body);
  try {
    assert.equal((await events.next()).value?.type, "ready");
    // The server's ready frame means fs.watch has returned, not that the
    // platform has delivered a native event. Establish that separately before
    // asserting one post-readiness write. Only this startup probe is repeated;
    // a lost watch-me.txt event must still fail the test. The fetch signal puts
    // a hard bound on both startup and target delivery under shared-runner load.
    const nativeReady = waitForWorkFolderFileEvent(events, "watch-ready.txt").then(
      () => ({ ready: true as const }),
      (error: unknown) => ({ error }),
    );
    for (let attempt = 0; ; attempt += 1) {
      await writeFile(join(workFolderRoot, "watch-ready.txt"), `ready ${attempt}\n`, "utf8");
      const result = await Promise.race([
        nativeReady,
        new Promise<null>((resolvePromise) => setTimeout(() => resolvePromise(null), 100)),
      ]);
      if (!result) continue;
      if ("error" in result) throw result.error;
      break;
    }
    await writeFile(join(workFolderRoot, "watch-me.txt"), "watch\n", "utf8");
    await waitForWorkFolderFileEvent(events, "watch-me.txt");
  } finally {
    controller.abort();
    await events.return();
  }

  const traversal = await fetch(`${api.origin}/api/work-folders/${id}/file-info?path=..%2Foutside.txt`);
  assert.equal(traversal.ok, false);
  const unsafeRename = await fetch(`${api.origin}/api/work-folders/${id}/rename-local-entry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Inbox/final.md", newName: "../escape.md" }),
  });
  assert.equal(unsafeRename.ok, false);
  const rootDelete = await fetch(`${api.origin}/api/work-folders/${id}/local-file`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "./" }),
  });
  assert.equal(rootDelete.ok, false);
  assert.equal(existsSync(workFolderRoot), true);
});

test("work-folder lifecycle renames external metadata and removes linked versus managed roots safely", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-lifecycle-api-"));
  const stateRoot = join(sandbox, "state");
  const contentRoot = join(sandbox, "managed");
  const linkedRoot = join(sandbox, "linked-folder");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(join(linkedRoot, "keep.txt"), "keep", "utf8");
  const api = await startLocalApi({ port: 0, stateBase: stateRoot, workFolderBase: contentRoot, loadEnv: false });
  t.after(async () => {
    await api.close();
    configureWorkFoldStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  const linked = await json(`${api.origin}/api/work-folders/local-folder`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workFolderRoot: linkedRoot }),
  }) as { workFolder: { id: string; workFolderRoot: string } };
  const renamedLinked = await json(`${api.origin}/api/work-folders/${linked.workFolder.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Renamed linked work-folder" }),
  }) as { workFolder: { name: string; workFolderRoot: string } };
  assert.equal(renamedLinked.workFolder.name, "Renamed linked work-folder");
  assert.equal(renamedLinked.workFolder.workFolderRoot, linkedRoot);
  assert.equal(await readFile(join(linkedRoot, "keep.txt"), "utf8"), "keep");
  assert.equal(existsSync(workFolderManifestFile(linkedRoot)), true);
  const removedLinked = await json(`${api.origin}/api/work-folders/${linked.workFolder.id}`, { method: "DELETE" }) as { removed: true; deleted: boolean };
  // Removing a linked registration destroys nothing, so nothing is kept —
  // neither the folder nor any app data belonging to it.
  assert.deepEqual(removedLinked, { removed: true, deleted: false, workFolderRoot: linkedRoot, cleanupPending: false, recentlyDeleted: null, appRecentlyDeletedEntries: [] });
  assert.equal(existsSync(linkedRoot), true);
  assert.equal(existsSync(workFolderManifestFile(linkedRoot)), true);
  assert.equal(existsSync(workFolderStateDir(linkedRoot)), false);

  const managed = await json(`${api.origin}/api/work-folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Managed lifecycle" }),
  }) as { workFolder: { id: string; workFolderRoot: string } };
  await writeFile(join(managed.workFolder.workFolderRoot, "delete-with-work-folder.txt"), "managed", "utf8");
  const removedManaged = await json(`${api.origin}/api/work-folders/${managed.workFolder.id}`, { method: "DELETE" }) as {
    removed: true; deleted: boolean; workFolderRoot: string; recentlyDeleted: { entryId: string } | null;
  };
  assert.equal(removedManaged.deleted, true);
  assert.equal(removedManaged.workFolderRoot, managed.workFolder.workFolderRoot);
  assert.equal(existsSync(managed.workFolder.workFolderRoot), false);
  assert.equal(existsSync(workFolderStateDir(managed.workFolder.workFolderRoot)), false);
  // The managed folder moved to Recently deleted with its History state.
  const keptWorkFolders = (await api.recentlyDeleted.list()).entries.filter((entry) => entry.kind === "work-folder");
  assert.equal(keptWorkFolders.length, 1);
  assert.equal(keptWorkFolders[0]?.originalPath, managed.workFolder.workFolderRoot);
  assert.equal(removedManaged.recentlyDeleted?.entryId, keptWorkFolders[0]?.id);
});

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text) as unknown;
}

interface WorkFolderFileEvent {
  type: string;
  path?: string | null;
  message?: string;
}

async function* readWorkFolderFileEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<WorkFolderFileEvent, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      buffer += decoder.decode(result.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6)) as WorkFolderFileEvent;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function waitForWorkFolderFileEvent(events: AsyncGenerator<WorkFolderFileEvent, void>, path: string): Promise<void> {
  for (;;) {
    const event = await events.next();
    assert.equal(event.done, false, `File event stream ended before ${path}.`);
    if (!event.value) continue;
    assert.notEqual(event.value.type, "error", event.value.message);
    if (event.value.type === "file_event" && event.value.path === path) return;
  }
}

test("file event assertions preserve split and combined SSE frames", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of [
      'data: {"type":"rea',
      'dy"}\n\n: keepalive\n\ndata: {"type":"file_event","path":"watch-ready.txt"}\n',
      '\ndata: {"type":"file_event","path":"watch-me.txt"}\n\n',
    ]) controller.enqueue(encoder.encode(chunk));
    controller.close();
  } });
  const events = readWorkFolderFileEvents(stream);
  assert.equal((await events.next()).value?.type, "ready");
  await waitForWorkFolderFileEvent(events, "watch-ready.txt");
  await waitForWorkFolderFileEvent(events, "watch-me.txt");
  assert.equal((await events.next()).done, true);
});

test("a native readiness event cannot satisfy the subsequent exact file event assertion", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"file_event","path":"watch-ready.txt"}\n\ndata: {"type":"file_event","path":"watch-ready.txt"}\n\n'));
    controller.close();
  } });
  const events = readWorkFolderFileEvents(stream);
  await waitForWorkFolderFileEvent(events, "watch-ready.txt");
  await assert.rejects(waitForWorkFolderFileEvent(events, "watch-me.txt"), /File event stream ended before watch-me\.txt/);
});

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
