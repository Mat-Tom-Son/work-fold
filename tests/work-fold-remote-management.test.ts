import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendMessage, createConversation, readConversationSummary } from "../src/local/agent/chat-store.js";
import { startLocalApi } from "../src/local/server.js";
import type { WorkFoldRemotePrincipal } from "../src/local/remote-management.js";
import { workFoldManagementRoot } from "../src/local/state-paths.js";

// The remote wave of the fold surfaces (docs/fold-glance.md §The remote
// client home): management.glance and management.glanceSeen serve the digest
// with per-grant seen hygiene over the remote facade. The bridge never sees
// any of this in the clear; these tests drive the desktop facade the envelope
// dispatch calls. Needs you means questions (docs/receipts-not-gates.md,
// F24): there is no remote decision operation any more.

test("remote glance serves the digest with per-grant seen hygiene and revocation clears the grant's marker", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-remote-glance-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
  });
  const principalA: WorkFoldRemotePrincipal = { browserId: "browser-a", grantId: "grant-a", requestId: "request-a-1" };
  const principalB: WorkFoldRemotePrincipal = { browserId: "browser-b", grantId: "grant-b", requestId: "request-b-1" };
  try {
    // A recorded change gives the digest a cursor: a restore point in a Space.
    const space = await api.actFacade.createSpace({ name: "Glance Space" });
    await writeFile(join(space.space.spaceRoot, "note.md"), "# Note\n", "utf8");
    await api.actFacade.historySave({ space: space.space.id, label: "Milestone" });

    const first = await api.remoteFacade.execute("management.glance", {}, principalA) as {
      glance: { cursor: string; seen: Record<string, string>; changes: Array<{ kind: string }> };
    };
    assert.ok(first.glance.cursor, "a recorded restore point gives the digest a cursor");
    assert.ok(first.glance.changes.some((item) => item.kind === "checkpoint-saved"));
    assert.deepEqual(first.glance.seen, {}, "no marker has been acknowledged yet");

    // Marking seen advances only the requesting grant's own marker.
    const advanced = await api.remoteFacade.execute(
      "management.glanceSeen",
      { cursor: first.glance.cursor },
      principalB,
    ) as { advanced: boolean; seenThrough: string | null };
    assert.deepEqual(advanced, { advanced: true, seenThrough: first.glance.cursor });
    const replayed = await api.remoteFacade.execute(
      "management.glanceSeen",
      { cursor: first.glance.cursor },
      principalB,
    ) as { advanced: boolean };
    assert.equal(replayed.advanced, false, "a replayed advance is a no-op");
    await assert.rejects(
      () => api.remoteFacade.execute("management.glanceSeen", { cursor: "not-a-cursor" }, principalB),
      /rendered glance cursor/,
    );

    // Cross-grant hygiene: each projection carries only its own marker, and
    // one phone never reads another's acknowledgements.
    const glanceA = await api.remoteFacade.execute("management.glance", {}, principalA) as {
      glance: { seen: Record<string, string> };
    };
    assert.deepEqual(glanceA.glance.seen, {}, "grant A never sees grant B's marker");
    const glanceB = await api.remoteFacade.execute("management.glance", {}, principalB) as {
      glance: { seen: Record<string, string> };
    };
    assert.deepEqual(Object.keys(glanceB.glance.seen), ["remote:grant-b"]);

    // Browser revocation's desktop-local cascade: the grant's glance marker
    // is removed, while other grants' state stands untouched.
    await api.remoteFacade.revokeGrantAuthority?.("grant-b");
    const afterRevoke = await api.kernel.getGlance({ kind: "renderer" });
    assert.equal("remote:grant-b" in afterRevoke.seen, false, "the revoked grant's marker is deleted");

    // The all-grants cascade clears every remote marker.
    await api.remoteFacade.execute("management.glanceSeen", { cursor: first.glance.cursor }, {
      browserId: "browser-c", grantId: "grant-c", requestId: "request-c-1",
    });
    await api.remoteFacade.revokeGrantAuthority?.();
    const afterRevokeAll = await api.kernel.getGlance({ kind: "renderer" });
    assert.equal(Object.keys(afterRevokeAll.seen).some((surface) => surface.startsWith("remote:")), false);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the summary advertises the live-watch capability and watch validates its conversation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-remote-watch-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
  });
  const principal: WorkFoldRemotePrincipal = { browserId: "browser-w", grantId: "grant-w", requestId: "request-w-1" };
  try {
    // The browser starts a watch only after seeing this advertisement, so an
    // older desktop — which never sends it — is never asked to watch.
    const summary = await api.remoteFacade.execute("management.summary", {}, principal) as {
      capabilities?: { watch?: boolean };
    };
    assert.equal(summary.capabilities?.watch, true);
    // A watch names an existing management conversation or is refused.
    assert.ok(api.remoteFacade.watch, "the facade exposes the watch port");
    await assert.rejects(
      () => api.remoteFacade.watch!({ conversationId: "missing-conversation" }, principal, () => {}),
      /Conversation not found/,
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("management Chats can be renamed locally and deleted only into recoverable trash", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-management-chat-delete-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
  });
  const principal: WorkFoldRemotePrincipal = { browserId: "browser-delete", grantId: "grant-delete", requestId: "request-delete" };
  const addChat = async (content: string) => {
    const conversation = await createConversation(workFoldManagementRoot());
    await appendMessage(workFoldManagementRoot(), conversation.id, {
      id: `message-${conversation.id}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    });
    return conversation.id;
  };
  try {
    const localConversationId = await addChat("Keep this transcript recoverable.");
    const renamed = await fetch(`${api.origin}/api/management/conversations/${localConversationId}/title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "  Local management notes  " }),
    });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json() as { conversation: { title: string } }).conversation.title, "Local management notes");

    const removed = await fetch(`${api.origin}/api/management/conversations/${localConversationId}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const localDeleted = await removed.json() as { deleted: { conversationId: string; trash: { entryId: string } } };
    assert.equal(localDeleted.deleted.conversationId, localConversationId);
    assert.equal(await readConversationSummary(workFoldManagementRoot(), localConversationId), null);
    const trash = await api.actFacade.trashList();
    const localTrashEntry = trash.entries.find((entry) => entry.id === localDeleted.deleted.trash.entryId);
    assert.equal(localTrashEntry?.reason, "management.chat.delete");
    assert.equal(localTrashEntry?.name, "Local management notes", "Recently deleted identifies a Chat by its title, never its transcript UUID");
    await createConversation(workFoldManagementRoot(), "Replacement", localConversationId);
    await assert.rejects(
      () => api.actFacade.trashRestore({ entry: localDeleted.deleted.trash.entryId }),
      /identity already exists/,
      "a restore never collision-renames a transcript into a different Chat identity",
    );
    await rm(join(workFoldManagementRoot(), ".work-fold", "conversations", `${localConversationId}.jsonl`));
    await api.actFacade.trashRestore({ entry: localDeleted.deleted.trash.entryId });
    assert.equal((await readConversationSummary(workFoldManagementRoot(), localConversationId))?.title, "Local management notes");

    const remoteConversationId = await addChat("Delete me from a paired browser.");
    const summary = await api.remoteFacade.execute("management.summary", { conversationId: remoteConversationId }, principal) as {
      capabilities?: { delete?: boolean };
    };
    assert.equal(summary.capabilities?.delete, true);
    const remoteDeleted = await api.remoteFacade.execute("management.delete", { conversationId: remoteConversationId }, principal) as {
      deleted: { conversationId: string; trash: { entryId: string } };
    };
    assert.equal(remoteDeleted.deleted.conversationId, remoteConversationId);
    assert.ok(remoteDeleted.deleted.trash.entryId);
    const remoteDeleteReplay = await api.remoteFacade.execute("management.delete", { conversationId: remoteConversationId }, principal) as {
      deleted: { conversationId: string; trash: { entryId: string } };
    };
    assert.deepEqual(remoteDeleteReplay, remoteDeleted, "a dropped remote delete response replays its original recovery receipt");
    assert.equal(await readConversationSummary(workFoldManagementRoot(), remoteConversationId), null);
    await api.actFacade.trashRestore({ entry: remoteDeleted.deleted.trash.entryId });
    assert.ok(await readConversationSummary(workFoldManagementRoot(), remoteConversationId));
    const replayAfterRestore = await api.remoteFacade.execute("management.delete", { conversationId: remoteConversationId }, principal) as typeof remoteDeleted;
    assert.deepEqual(replayAfterRestore, remoteDeleted, "a durable remote receipt prevents a restored Chat from being deleted again by the same request");
    assert.ok(await readConversationSummary(workFoldManagementRoot(), remoteConversationId));
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
