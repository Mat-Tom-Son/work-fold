import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  RegisteredSpaceRuntimeProvider,
  RegisteredSpaceTrustAuthority,
} from "../src/local/agent/registered-space-runtime.js";
import { loadAgentSkillCatalog } from "../src/local/agent/skill-catalog.js";
import { WorkFoldCliError } from "../src/local/cli/index.js";
import { startLocalApi } from "../src/local/server.js";
import { setSpaceIgnoreState } from "../src/local/space-ignore.js";
import { workFoldManagementRoot, workFoldManagementScopeId } from "../src/local/state-paths.js";

test("the management conversation runs above all Spaces on the shared turn machinery", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-management-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 300)),
    });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const facade = api.actFacade;

    // Starting the API materializes the management scope's app-owned Pi
    // configuration, and Pi's own loader picks both resources up: the
    // AGENTS.md context file stays in the session context, and the
    // manage-spaces Skill is a project-scope skill of the management
    // root — not of the person's personal scope.
    const managementRoot = workFoldManagementRoot();
    assert.equal(existsSync(join(managementRoot, "AGENTS.md")), true);
    assert.equal(existsSync(join(managementRoot, ".pi", "skills", "manage-spaces", "SKILL.md")), true);
    // Discovery uses the same trust wrapper the running API applies: the
    // management root is app-granted, so its project resources load.
    const catalog = await loadAgentSkillCatalog(managementRoot, new RegisteredSpaceRuntimeProvider(
      {
        async resolveRuntime() {
          return { agentDir: join(sandbox, "agent") };
        },
      },
      new RegisteredSpaceTrustAuthority([managementRoot]),
    ));
    const managementSkill = catalog.skills.find((skill) => skill.name === "manage-spaces");
    assert.equal(managementSkill?.source.scope, "project", "the management skill must load at project scope");
    assert.equal(
      catalog.contextFiles.some((file) => file.path.endsWith("AGENTS.md") && file.content.includes("management conversation")),
      true,
      "the management AGENTS.md must load as a Pi context file",
    );
    const managementContext = catalog.contextFiles.find((file) => file.path.endsWith("AGENTS.md"))?.content ?? "";
    assert.match(managementContext, /Checks are optional, manual expectations/);
    assert.match(managementContext, /Never turn an ordinary request.*standing behavior/);
    assert.match(managementContext, /not-configured.*unknown, not clear/);
    assert.match(managementContext, /Only after an explicit enable instruction/);

    // Before any send there is no conversation to inspect.
    await assert.rejects(
      () => facade.manageConversationStatus({}),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );

    // The first send creates the default management conversation and runs a
    // real turn through the personal-scope /hold extension — proving the
    // management client loads personal Pi capabilities without any Space.
    const send = await facade.manageSend({ content: "/hold" });
    assert.ok(send.conversationId);
    assert.ok(send.taskId);
    const running = await api.kernel.getTasks({ kind: "system" });
    const managementTask = running.tasks.find((task) => task.id === send.taskId);
    assert.equal(managementTask?.spaceId, workFoldManagementScopeId, "management turns must be tracked under the management scope id");
    assert.equal(managementTask?.actor.kind, "cli");

    await waitForAsync(async () => (await facade.manageTurnStatus({ taskId: send.taskId })).task.state !== "running");
    const settled = await facade.manageTurnStatus({ taskId: send.taskId });
    assert.equal(settled.task.state, "succeeded");
    assert.equal(settled.task.conversationId, send.conversationId);

    const result = await facade.manageTurnResult({ taskId: send.taskId });
    assert.equal(result.message.content, "Command completed.");
    assert.equal(result.conversationId, send.conversationId);

    // The transcript is machine-local application state, not Space content.
    assert.equal(managementRoot.startsWith(join(sandbox, "state")), true, "management records live under the app state root");
    const transcripts = await readdir(join(managementRoot, ".work-fold", "conversations"));
    assert.equal(transcripts.some((file) => file === `${send.conversationId}.jsonl`), true);
    assert.equal(existsSync(join(sandbox, "content", "management")), false, "no Space folder is created for the management scope");

    // Selector-free commands keep targeting the same default conversation.
    const second = await facade.manageSend({ content: "/hold" });
    assert.equal(second.conversationId, send.conversationId);
    await waitForAsync(async () => (await facade.manageTurnStatus({ taskId: second.taskId })).task.state !== "running");

    const status = await facade.manageConversationStatus({});
    assert.equal(status.conversation.id, send.conversationId);
    assert.equal(status.state, "idle");
    const tail = await facade.manageConversationResult({ messages: 10 });
    assert.equal(tail.lastAssistant, "Command completed.");
    assert.equal(tail.conversationId, send.conversationId);
    assert.equal((await facade.manageList()).conversations.length, 1);
    assert.equal((await facade.manageAbort({})).aborted, false);

    // --new starts a separate management conversation on request.
    const fresh = await facade.manageSend({ content: "/hold", newConversation: true });
    assert.notEqual(fresh.conversationId, send.conversationId);
    await waitForAsync(async () => (await facade.manageTurnStatus({ taskId: fresh.taskId })).task.state !== "running");
    assert.equal((await facade.manageList()).conversations.length, 2);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the management conversation fails closed when its required instructions cannot be prepared", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-management-fail-closed-test-"));
  const stateBase = join(sandbox, "state");
  await mkdir(stateBase, { recursive: true });
  // Occupy the management root with a regular file. The rest of work-fold
  // must still start, but this full-trust scope must not run uninstructed.
  await writeFile(join(stateBase, "management"), "not a directory", "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase,
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
  });
  try {
    await assert.rejects(
      () => api.actFacade.manageList(),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "unavailable"
        && /required instructions/.test(error.message),
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("remote access reuses the canonical management conversation through a bounded path-safe facade", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-remote-management-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 180)),
    });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; },
    },
  });
  try {
    const principal = { browserId: "browser-1", grantId: "grant-1", requestId: "request-1" };
    const initial = await api.remoteFacade.execute("management.summary", {}, principal) as { conversation: unknown };
    assert.equal(initial.conversation, null);

    const space = await api.actFacade.createSpace({ name: "Remote Files" });
    await writeFile(join(space.space.spaceRoot, "brief.txt"), "private content", "utf8");
    const spaces = await api.remoteFacade.execute("spaces.list", {}, principal) as { spaces: Array<Record<string, unknown>> };
    assert.deepEqual(spaces.spaces, [{ id: space.space.id, name: "Remote Files" }], "absolute roots never cross the remote facade");
    const tree = await api.remoteFacade.execute("spaces.tree", { spaceId: space.space.id, path: "" }, principal) as {
      tree: Array<{ name: string; path: string }>;
    };
    assert.deepEqual(tree.tree.map((entry) => ({ name: entry.name, path: entry.path })), [{ name: "brief.txt", path: "brief.txt" }]);
    await assert.rejects(
      () => api.remoteFacade.execute("spaces.tree", { spaceId: space.space.id, path: "../outside" }, principal),
      /Space-relative/,
    );

    const sent = await api.remoteFacade.execute("management.send", { content: "/hold" }, principal) as {
      conversationId: string;
      taskId: string;
    };
    const running = await api.kernel.getTasks({ kind: "system" });
    assert.equal(running.tasks.find((task) => task.id === sent.taskId)?.actor.kind, "renderer", "the stable kernel actor vocabulary treats the approved web client as a renderer surface");

    const duplicate = await api.remoteFacade.execute("management.send", { content: "/hold" }, principal) as { duplicate?: boolean; taskId: string | null };
    assert.equal(duplicate.duplicate, true, "the signed request id is idempotent at the semantic adapter");
    assert.equal(duplicate.taskId, null);
    await waitForAsync(async () => (await api.actFacade.manageTurnStatus({ taskId: sent.taskId })).task.state !== "running");

    const transcript = await api.remoteFacade.execute(
      "management.transcript",
      { conversationId: sent.conversationId },
      { ...principal, requestId: "request-2" },
    ) as { messages: Array<{ role: string; content: string; source?: string }> };
    const remoteMessage = transcript.messages.find((message) => message.role === "user" && message.content === "/hold");
    assert.equal(remoteMessage?.source, "remote_web");
    assert.equal((await api.actFacade.manageConversationStatus({})).conversation.id, sent.conversationId, "web and menu-bar/CLI views resolve the same transcript");
    assert.equal(transcript.messages.filter((message) => message.role === "user" && message.content === "/hold").length, 1);

    const newChatPrincipal = { ...principal, requestId: "request-new-chat" };
    const fresh = await api.remoteFacade.execute(
      "management.send",
      { content: "/hold", newConversation: true },
      newChatPrincipal,
    ) as { conversationId: string; taskId: string };
    assert.notEqual(fresh.conversationId, sent.conversationId, "New chat starts a separate saved transcript");
    const freshDuplicate = await api.remoteFacade.execute(
      "management.send",
      { content: "/hold", newConversation: true },
      newChatPrincipal,
    ) as { conversationId: string; duplicate?: boolean; taskId: string | null };
    assert.equal(freshDuplicate.duplicate, true, "recovery does not create another transcript for the same signed request");
    assert.equal(freshDuplicate.conversationId, fresh.conversationId);
    assert.equal(freshDuplicate.taskId, null);
    await waitForAsync(async () => (await api.actFacade.manageTurnStatus({ taskId: fresh.taskId })).task.state !== "running");
    assert.equal((await api.actFacade.manageConversationStatus({})).conversation.id, fresh.conversationId);

    const chats = await api.remoteFacade.execute(
      "management.chats",
      {},
      { ...principal, requestId: "request-list-chats" },
    ) as { conversations: Array<{ id: string }>; truncated: boolean };
    assert.deepEqual(new Set(chats.conversations.map((conversation) => conversation.id)), new Set([sent.conversationId, fresh.conversationId]));
    assert.equal(chats.truncated, false);

    const resumed = await api.remoteFacade.execute(
      "management.send",
      { content: "/hold", conversationId: sent.conversationId },
      { ...principal, requestId: "request-existing-chat" },
    ) as { conversationId: string; taskId: string };
    assert.equal(resumed.conversationId, sent.conversationId, "an explicit saved Chat wins over the most recently used Chat");
    await waitForAsync(async () => (await api.actFacade.manageTurnStatus({ taskId: resumed.taskId })).task.state !== "running");
    const selectedSummary = await api.remoteFacade.execute(
      "management.summary",
      { conversationId: sent.conversationId },
      { ...principal, requestId: "request-selected-summary" },
    ) as { conversation: { id: string }; latestRequest: { conversationId: string } };
    assert.equal(selectedSummary.conversation.id, sent.conversationId);
    assert.equal(selectedSummary.latestRequest.conversationId, sent.conversationId);

    const managementUploadRequestId = "request-management-upload";
    const uploadedToManagement = await api.remoteFacade.execute(
      "management.send",
      {
        content: "/hold",
        conversationId: sent.conversationId,
        attachments: [{ name: "brief-upload.txt", data: Buffer.from("remote brief", "utf8").toString("base64url") }],
      },
      { ...principal, requestId: managementUploadRequestId },
    ) as {
      conversationId: string;
      taskId: string;
      uploads: Array<{ name: string; sizeBytes: number }>;
    };
    assert.deepEqual(uploadedToManagement.uploads, [{ name: "brief-upload.txt", sizeBytes: 12 }]);
    assert.doesNotMatch(JSON.stringify(uploadedToManagement), new RegExp(sandbox.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const stagedManagementPath = join(
      workFoldManagementRoot(),
      "Incoming",
      "Remote",
      principal.grantId,
      managementUploadRequestId,
      "brief-upload.txt",
    );
    assert.equal(existsSync(stagedManagementPath), true);
    await waitForAsync(async () => (await api.actFacade.manageTurnStatus({ taskId: uploadedToManagement.taskId })).task.state !== "running");
    const uploadTranscript = await api.remoteFacade.execute(
      "management.transcript",
      { conversationId: sent.conversationId },
      { ...principal, requestId: "request-management-upload-transcript" },
    ) as { messages: Array<{ role: string; attachments?: Array<{ kind: string; name: string; target?: string }> }> };
    const uploadMessage = uploadTranscript.messages.find((message) => message.attachments?.some((attachment) => attachment.name === "brief-upload.txt"));
    assert.deepEqual(uploadMessage?.attachments, [{ kind: "file", name: "brief-upload.txt" }], "remote transcripts expose attachment identity without local paths");

    const spaceUploadPrincipal = { ...principal, requestId: "request-space-upload" };
    const spaceTurn = await api.remoteFacade.execute(
      "spaces.send",
      {
        spaceId: space.space.id,
        content: "/hold",
        newConversation: true,
        attachments: [{ name: "notes.txt", data: Buffer.from("space notes", "utf8").toString("base64url") }],
      },
      spaceUploadPrincipal,
    ) as {
      conversationId: string;
      taskId: string;
      uploads: Array<{ name: string; path: string; sizeBytes: number }>;
      safetyCheckpointId: string | null;
    };
    assert.equal(spaceTurn.uploads[0]?.name, "notes.txt");
    assert.match(spaceTurn.uploads[0]?.path ?? "", /^Dropped\/\d{4}-\d{2}-\d{2}\/notes\.txt$/);
    assert.equal(existsSync(join(space.space.spaceRoot, spaceTurn.uploads[0]!.path)), true);
    assert.ok(spaceTurn.safetyCheckpointId, "placing a remote upload in a Space records a restore point");
    await waitForAsync(async () => {
      const tasks = await api.kernel.getTasks({ kind: "system" });
      return !tasks.tasks.some((task) => task.id === spaceTurn.taskId);
    });
    const spaceChats = await api.remoteFacade.execute(
      "spaces.chats",
      { spaceId: space.space.id },
      { ...principal, requestId: "request-space-chats" },
    ) as { space: { id: string }; conversations: Array<{ id: string }>; truncated: boolean };
    assert.equal(spaceChats.space.id, space.space.id);
    assert.equal(spaceChats.conversations.some((conversation) => conversation.id === spaceTurn.conversationId), true);
    assert.equal(spaceChats.truncated, false);
    const spaceTranscript = await api.remoteFacade.execute(
      "spaces.transcript",
      { spaceId: space.space.id, conversationId: spaceTurn.conversationId },
      { ...principal, requestId: "request-space-transcript" },
    ) as { messages: Array<{ role: string; content: string; source?: string }> };
    assert.equal(spaceTranscript.messages.some((message) => message.role === "user" && message.content === "/hold" && message.source === "remote_web"), true);

    const stoppable = await api.remoteFacade.execute(
      "spaces.send",
      { spaceId: space.space.id, content: "/hold", conversationId: spaceTurn.conversationId },
      { ...principal, requestId: "request-space-stop" },
    ) as { conversationId: string; taskId: string };
    const stopped = await api.remoteFacade.execute(
      "spaces.stop",
      { spaceId: space.space.id, taskId: stoppable.taskId },
      { ...principal, requestId: "request-space-stop-action" },
    ) as { stopped: boolean; taskId: string };
    assert.equal(stopped.taskId, stoppable.taskId);
    assert.equal(stopped.stopped, true);

    await writeFile(join(space.space.spaceRoot, "secret.txt"), "ignored", "utf8");
    await setSpaceIgnoreState(space.space.spaceRoot, ["secret.txt"], true);
    await assert.rejects(
      () => api.remoteFacade.execute(
        "spaces.send",
        { spaceId: space.space.id, content: "/hold", newConversation: true, contextPaths: ["secret.txt"] },
        { ...principal, requestId: "request-ignored-context" },
      ),
      /visible, non-ignored/,
    );
    await assert.rejects(
      () => api.remoteFacade.execute(
        "spaces.send",
        {
          spaceId: space.space.id,
          content: "/hold",
          newConversation: true,
          attachments: [{ name: "../escape.txt", data: "eA" }],
        },
        { ...principal, requestId: "request-unsafe-upload" },
      ),
      /plain names/,
    );

    await api.remoteFacade.purgeUploads(principal.grantId);
    assert.equal(existsSync(stagedManagementPath), false, "revoking a browser can purge its staged management uploads");

    await assert.rejects(
      () => api.remoteFacade.execute(
        "management.send",
        { content: "no", newConversation: "yes" },
        { ...principal, requestId: "request-bad-new-chat" },
      ),
      /newConversation must be a boolean/,
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}
