import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendMessage, createConversation, readConversationSummary } from "../src/local/agent/chat-store.js";
import { RoutedPiExtensionUiBridge, type PiExtensionUiRequest } from "../src/local/agent/extension-ui.js";
import { startLocalApi } from "../src/local/server.js";
import type { WorkFoldRemotePrincipal, WorkFoldRemoteWatchProgress } from "../src/local/remote-work-fold-agent.js";
import { workFoldAgentRoot } from "../src/local/state-paths.js";

// The remote wave of the work-fold agent surfaces (docs/work-fold-agent-overview.md §The remote
// client home): management.overview and management.glanceSeen serve the digest
// with per-grant seen hygiene over the remote facade. The bridge never sees
// any of this in the clear; these tests drive the desktop facade the envelope
// dispatch calls. Needs you means questions (docs/receipts-not-gates.md,
// F24): there is no remote decision operation any more.

test("remote overview serves the digest with per-grant seen hygiene and revocation clears the grant's marker", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-remote-overview-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
  });
  const principalA: WorkFoldRemotePrincipal = { browserId: "browser-a", grantId: "grant-a", requestId: "request-a-1" };
  const principalB: WorkFoldRemotePrincipal = { browserId: "browser-b", grantId: "grant-b", requestId: "request-b-1" };
  try {
    // A recorded change gives the digest a cursor: a restore point in a work-folder.
    const workFolder = await api.actFacade.createWorkFolder({ name: "Glance work-folder" });
    await writeFile(join(workFolder.workFolder.workFolderRoot, "note.md"), "# Note\n", "utf8");
    await api.actFacade.historySave({ workFolder: workFolder.workFolder.id, label: "Milestone" });

    const first = await api.remoteFacade.execute("management.glance", {}, principalA) as {
      overview: { cursor: string; seen: Record<string, string>; changes: Array<{ kind: string }> };
    };
    assert.ok(first.overview.cursor, "a recorded restore point gives the digest a cursor");
    assert.ok(first.overview.changes.some((item) => item.kind === "checkpoint-saved"));
    assert.deepEqual(first.overview.seen, {}, "no marker has been acknowledged yet");

    // Marking seen advances only the requesting grant's own marker.
    const advanced = await api.remoteFacade.execute(
      "management.glanceSeen",
      { cursor: first.overview.cursor },
      principalB,
    ) as { advanced: boolean; seenThrough: string | null };
    assert.deepEqual(advanced, { advanced: true, seenThrough: first.overview.cursor });
    const replayed = await api.remoteFacade.execute(
      "management.glanceSeen",
      { cursor: first.overview.cursor },
      principalB,
    ) as { advanced: boolean };
    assert.equal(replayed.advanced, false, "a replayed advance is a no-op");
    await assert.rejects(
      () => api.remoteFacade.execute("management.glanceSeen", { cursor: "not-a-cursor" }, principalB),
      /rendered overview cursor/,
    );

    // Cross-grant hygiene: each projection carries only its own marker, and
    // one phone never reads another's acknowledgements.
    const overviewA = await api.remoteFacade.execute("management.glance", {}, principalA) as {
      overview: { seen: Record<string, string> };
    };
    assert.deepEqual(overviewA.overview.seen, {}, "grant A never sees grant B's marker");
    const overviewB = await api.remoteFacade.execute("management.glance", {}, principalB) as {
      overview: { seen: Record<string, string> };
    };
    assert.deepEqual(Object.keys(overviewB.overview.seen), ["remote:grant-b"]);

    // Browser revocation's desktop-local cascade: the grant's overview marker
    // is removed, while other grants' state stands untouched.
    await api.remoteFacade.revokeGrantAuthority?.("grant-b");
    const afterRevoke = await api.kernel.getOverview({ kind: "renderer" });
    assert.equal("remote:grant-b" in afterRevoke.seen, false, "the revoked grant's marker is deleted");

    // The all-grants cascade clears every remote marker.
    await api.remoteFacade.execute("management.glanceSeen", { cursor: first.overview.cursor }, {
      browserId: "browser-c", grantId: "grant-c", requestId: "request-c-1",
    });
    await api.remoteFacade.revokeGrantAuthority?.();
    const afterRevokeAll = await api.kernel.getOverview({ kind: "renderer" });
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
    workFolderBase: join(sandbox, "content"),
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
    // A watch names an existing work-fold agent or is refused.
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

test("aborting a real remote watch removes its subscription while the held turn can still be stopped", { timeout: 20_000 }, async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-remote-watch-cancel-test-"));
  const agentDir = join(sandbox, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "watch-hold.ts"), `export default function (pi) {
    pi.registerCommand("watch-hold", {
      description: "Hold a model-free test turn across watch cancellation",
      handler: async (_, ctx) => {
        await ctx.ui.input("Continue after watch cancellation");
        ctx.ui.setWorkingMessage("Private late progress");
        await ctx.ui.input("Held until Stop");
      },
    });
  }\n`, "utf8");
  const bridge = new RoutedPiExtensionUiBridge();
  let firstQuestion!: (request: PiExtensionUiRequest) => void;
  let secondQuestion!: (request: PiExtensionUiRequest) => void;
  const firstGate = new Promise<PiExtensionUiRequest>((resolve) => { firstQuestion = resolve; });
  const secondGate = new Promise<PiExtensionUiRequest>((resolve) => { secondQuestion = resolve; });
  bridge.on("request", (request) => {
    if (request.title === "Continue after watch cancellation") firstQuestion(request);
    if (request.title === "Held until Stop") secondQuestion(request);
  });
  const api = await startLocalApi({
    port: 0, stateBase: join(sandbox, "state"), workFolderBase: join(sandbox, "content"), loadEnv: false,
    extensionUiBridge: bridge, piRuntimeProvider: { async resolveRuntime() { return { agentDir }; } },
  });
  const cancelled = new AbortController();
  const current = new AbortController();
  t.after(async () => {
    cancelled.abort();
    current.abort();
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const principal: WorkFoldRemotePrincipal = { browserId: "browser-watch-cancel", grantId: "grant-watch-cancel", requestId: "watch-cancel-send" };
  const turn = await api.remoteFacade.execute("management.send", { content: "/watch-hold", newConversation: true }, principal) as {
    conversationId: string; taskId: string;
  };
  const gate = await firstGate;
  assert.equal(gate.taskId, turn.taskId);
  assert.ok(api.remoteFacade.watch);
  const progress: WorkFoldRemoteWatchProgress[] = [];
  const watch = api.remoteFacade.watch({ conversationId: turn.conversationId }, principal, (tick) => progress.push(tick), cancelled.signal);
  await waitForWatchSubscription(cancelled.signal);
  cancelled.abort();
  assert.deepEqual(await watch, { state: "cancelled", settled: false });
  assert.equal(getEventListeners(cancelled.signal, "abort").length, 0, "cancellation releases the signal listener");
  const emittedBeforeLateEvents = progress.length;
  assert.equal(bridge.respond(gate.id, { value: "continue" }), true);
  const stoppingGate = await secondGate;
  assert.equal(stoppingGate.taskId, turn.taskId, "cancelling a watch must leave the accepted turn running");
  assert.deepEqual(await api.remoteFacade.watch({ conversationId: turn.conversationId }, principal, (tick) => progress.push(tick), cancelled.signal),
    { state: "cancelled", settled: false }, "an already cancelled signal never subscribes");
  const activeWatch = api.remoteFacade.watch({ conversationId: turn.conversationId }, principal, () => {}, current.signal);
  await waitForWatchSubscription(current.signal);
  const stopped = await api.remoteFacade.execute("management.stop", { taskId: turn.taskId }, { ...principal, requestId: "watch-cancel-stop" }) as {
    stopped: { workFoldAgentAborted: boolean };
  };
  assert.equal(stopped.stopped.workFoldAgentAborted, true);
  assert.deepEqual(await activeWatch, { state: "settled", settled: true }, "normal Stop still settles an authorized watch");
  assert.equal(getEventListeners(current.signal, "abort").length, 0, "normal settlement also releases the signal listener");
  assert.equal(progress.length, emittedBeforeLateEvents, "the cancelled watch receives neither subsequent turn progress nor settlement");
});

async function waitForWatchSubscription(signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (getEventListeners(signal, "abort").length) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("The remote watch did not subscribe to cancellation.");
}

test("work-fold agent Chats can be renamed locally and deleted only into recoverable trash", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-agent-chat-delete-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
  });
  const principal: WorkFoldRemotePrincipal = { browserId: "browser-delete", grantId: "grant-delete", requestId: "request-delete" };
  const addChat = async (content: string) => {
    const conversation = await createConversation(workFoldAgentRoot());
    await appendMessage(workFoldAgentRoot(), conversation.id, {
      id: `message-${conversation.id}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    });
    return conversation.id;
  };
  try {
    const localConversationId = await addChat("Keep this transcript recoverable.");
    const renamed = await fetch(`${api.origin}/api/work-fold-agent/conversations/${localConversationId}/title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "  Local management notes  " }),
    });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json() as { conversation: { title: string } }).conversation.title, "Local management notes");

    const removed = await fetch(`${api.origin}/api/work-fold-agent/conversations/${localConversationId}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const localDeleted = await removed.json() as { deleted: { conversationId: string; recentlyDeleted: { entryId: string } } };
    assert.equal(localDeleted.deleted.conversationId, localConversationId);
    assert.equal(await readConversationSummary(workFoldAgentRoot(), localConversationId), null);
    const recentlyDeleted = await api.actFacade.recentlyDeletedList();
    const localRecentlyDeletedEntry = recentlyDeleted.entries.find((entry) => entry.id === localDeleted.deleted.recentlyDeleted.entryId);
    assert.equal(localRecentlyDeletedEntry?.reason, "agent.chat.delete");
    assert.equal(localRecentlyDeletedEntry?.name, "Local management notes", "Recently deleted identifies a Chat by its title, never its transcript UUID");
    await createConversation(workFoldAgentRoot(), "Replacement", localConversationId);
    await assert.rejects(
      () => api.actFacade.recentlyDeletedRestore({ entry: localDeleted.deleted.recentlyDeleted.entryId }),
      /identity already exists/,
      "a restore never collision-renames a transcript into a different Chat identity",
    );
    await rm(join(workFoldAgentRoot(), ".work-fold", "conversations", `${localConversationId}.jsonl`));
    await api.actFacade.recentlyDeletedRestore({ entry: localDeleted.deleted.recentlyDeleted.entryId });
    assert.equal((await readConversationSummary(workFoldAgentRoot(), localConversationId))?.title, "Local management notes");

    const remoteConversationId = await addChat("Delete me from a paired browser.");
    const summary = await api.remoteFacade.execute("management.summary", { conversationId: remoteConversationId }, principal) as {
      capabilities?: { delete?: boolean };
    };
    assert.equal(summary.capabilities?.delete, true);
    const remoteDeleted = await api.remoteFacade.execute("management.delete", { conversationId: remoteConversationId }, principal) as {
      deleted: { conversationId: string; recentlyDeleted: { entryId: string } };
    };
    assert.equal(remoteDeleted.deleted.conversationId, remoteConversationId);
    assert.ok(remoteDeleted.deleted.recentlyDeleted.entryId);
    const remoteDeleteReplay = await api.remoteFacade.execute("management.delete", { conversationId: remoteConversationId }, principal) as {
      deleted: { conversationId: string; recentlyDeleted: { entryId: string } };
    };
    assert.deepEqual(remoteDeleteReplay, remoteDeleted, "a dropped remote delete response replays its original recovery receipt");
    assert.equal(await readConversationSummary(workFoldAgentRoot(), remoteConversationId), null);
    await api.actFacade.recentlyDeletedRestore({ entry: remoteDeleted.deleted.recentlyDeleted.entryId });
    assert.ok(await readConversationSummary(workFoldAgentRoot(), remoteConversationId));
    const replayAfterRestore = await api.remoteFacade.execute("management.delete", { conversationId: remoteConversationId }, principal) as typeof remoteDeleted;
    assert.deepEqual(replayAfterRestore, remoteDeleted, "a durable remote receipt prevents a restored Chat from being deleted again by the same request");
    assert.ok(await readConversationSummary(workFoldAgentRoot(), remoteConversationId));
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
