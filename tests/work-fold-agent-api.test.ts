import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  executeWorkFoldCliActRequest,
  parseWorkFoldCliActArgv,
} from "../src/local/cli/act-commands.js";
import { createWorkFoldCliActRequest } from "../src/local/cli/act-protocol.js";
import type { WorkFoldActFacade } from "../src/local/cli/act-facade.js";
import { WorkFoldCliActReceipts, type WorkFoldCliActReceiptV1 } from "../src/local/cli/act-receipts.js";
import { WorkFoldCliError } from "../src/local/cli/protocol.js";
import { startLocalApi } from "../src/local/server.js";
import { setWorkFolderIgnoreState } from "../src/local/work-folder-ignore.js";

test("act argv parsing carries agent send attachments and the agent stop command", () => {
  const send = parseWorkFoldCliActArgv([
    "agent", "send", "--message", "file this",
    "--attach", "/tmp/report.pdf",
    "--attach", "https://example.com/repo",
  ]);
  assert.equal(send.name, "agent.send");
  assert.deepEqual(send.attachments, ["/tmp/report.pdf", "https://example.com/repo"]);

  const stop = parseWorkFoldCliActArgv(["agent", "stop", "--task", "task-1", "--json"]);
  assert.equal(stop.name, "agent.stop");
  assert.equal(stop.task, "task-1");
  assert.equal(stop.output, "json");

  assert.throws(() => parseWorkFoldCliActArgv(["agent", "stop"]), /--task/);
  assert.throws(() => parseWorkFoldCliActArgv(["files", "add", "--work-folder", "s", "--from", "a", "--attach", "b"]), /--attach cannot be used/);
  assert.throws(() => parseWorkFoldCliActArgv(["chat", "send", "--work-folder", "s", "--new", "--message", "m", "--attach", "b"]), /--attach cannot be used/);
  const attributed = parseWorkFoldCliActArgv([
    "files", "add", "--work-folder", "s", "--from", "a", "--parent-task", "task-parent",
  ]);
  assert.equal(attributed.parentTaskId, "task-parent");
  assert.throws(() => parseWorkFoldCliActArgv(["agent", "list", "--parent-task", "task-parent"]), /cannot be used/);
});

test("the act executor forwards attachments to the facade and stamps lineage on receipts", async () => {
  const appended: Array<Omit<WorkFoldCliActReceiptV1, "v" | "at">> = [];
  const receipts = {
    append: (entry: Omit<WorkFoldCliActReceiptV1, "v" | "at">) => {
      appended.push(entry);
      return Promise.resolve(true);
    },
    hasAccepted: () => Promise.resolve(false),
  };
  let sendInput: unknown = null;
  const facade = {
    agentSend: (input: unknown) => {
      sendInput = input;
      return Promise.resolve({ conversationId: "chat-1", messageId: "m-1", taskId: "task-1", attachments: [] });
    },
    agentStop: () => Promise.resolve({ taskId: "task-1", workFoldAgentAborted: false, children: [] }),
    createWorkFolder: (input: { name: string }) => input.name === "Fail"
      ? Promise.reject(new Error("create failed"))
      : Promise.resolve({ workFolder: { id: "work-folder-1", name: "Created", workFolderRoot: "/tmp/created" } }),
  } as unknown as WorkFoldActFacade;
  const token = "act-token-for-tests-0123456789";
  const cwd = process.cwd();

  const sendResponse = await executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({
      id: "11111111-1111-4111-8111-111111111111",
      argv: ["agent", "send", "--message", "hi", "--attach", "/tmp/a.txt", "--attach", "https://example.com", "--json"],
      cwd,
      actToken: token,
    }),
    {
      version: "0.0.0",
      getActFacade: () => ({ facade, token }),
      receipts,
      resolveLineageParent: () => null,
    },
  );
  assert.equal(sendResponse.exitCode, 0);
  assert.deepEqual((sendInput as { attachments?: string[] }).attachments, ["/tmp/a.txt", "https://example.com"]);
  assert.equal((sendInput as { cwd?: string }).cwd, cwd);

  const attributedResponse = await executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({
      id: "22222222-2222-4222-8222-222222222222",
      argv: ["work-folders", "create", "--name", "Created", "--parent-task", "task-parent"],
      cwd,
      actToken: token,
    }),
    {
      version: "0.0.0",
      getActFacade: () => ({ facade, token }),
      receipts,
      resolveLineageParent: (taskId) => taskId === "task-parent" ? { taskId } : null,
    },
  );
  assert.equal(attributedResponse.exitCode, 0);
  const attributedReceipts = appended.filter((entry) => entry.command === "work-folders.create");
  assert.equal(attributedReceipts.length, 2);
  assert.equal(attributedReceipts[0]!.outcome, "accepted");
  assert.equal(attributedReceipts[0]!.parentTaskId, "task-parent", "explicit lineage lands in the journal before the mutation");
  assert.equal(attributedReceipts[1]!.outcome, "ok");
  assert.equal(attributedReceipts[1]!.parentTaskId, "task-parent");
  const failedResponse = await executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({
      id: "33333333-3333-4333-8333-333333333333",
      argv: ["work-folders", "create", "--name", "Fail", "--parent-task", "task-parent"],
      cwd,
      actToken: token,
    }),
    {
      version: "0.0.0",
      getActFacade: () => ({ facade, token }),
      receipts,
      resolveLineageParent: (taskId) => ({ taskId }),
    },
  );
  assert.notEqual(failedResponse.exitCode, 0);
  const terminalError = appended.find((entry) => entry.requestId === "33333333-3333-4333-8333-333333333333" && entry.outcome === "error");
  assert.equal(terminalError?.parentTaskId, "task-parent", "terminal errors keep the accepted request lineage");
  const sendReceipts = appended.filter((entry) => entry.command === "agent.send");
  assert.equal(sendReceipts.some((entry) => "parentTaskId" in entry && entry.parentTaskId !== undefined), false, "no lineage parent means no stamped parent");
});

test("work-fold agent requests carry attachments, record lineage, and expose honest phases over the local API", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-agent-api-test-"));
  let heldConversationId: string | null = null;
  let changedConversationId: string | null = null;
  let changedWorkFolderRoot = "";
  let releaseHeldPrompt!: () => void;
  let reportHeldPrompt!: () => void;
  const heldPromptGate = new Promise<void>((resolve) => { releaseHeldPrompt = resolve; });
  const heldPromptReached = new Promise<void>((resolve) => { reportHeldPrompt = resolve; });
  let holdChildAttribution = false;
  let releaseChildAttribution!: () => void;
  let reportChildAttribution!: () => void;
  const childAttributionGate = new Promise<void>((resolve) => { releaseChildAttribution = resolve; });
  const childAttributionReached = new Promise<void>((resolve) => { reportChildAttribution = resolve; });
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 1200)),
    });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
    async beforeAgentPrompt(event) {
      if (event.conversationId === changedConversationId) {
        await writeFile(join(changedWorkFolderRoot, "comparison.md"), "North: $42\n");
        await writeFile(join(changedWorkFolderRoot, "private.md"), "Hidden result\n");
      }
      if (event.conversationId !== heldConversationId) return;
      reportHeldPrompt();
      await heldPromptGate;
    },
    async beforeWorkFoldAgentActionRecord(event) {
      if (!holdChildAttribution || event.command !== "chat.send") return;
      reportChildAttribution();
      await childAttributionGate;
    },
  });
  try {
    const facade = api.actFacade;
    // This test pins attachments, lineage, and phases. Its delegated child
    // settles after the work-fold agent's turn ends, which is exactly when F28 would
    // bring the result back as a continuation turn and make that turn the
    // request's newest; tests/work-fold-collaboration-verbs.test.ts covers
    // that path, so here the setting is off and the projection stays put.
    await api.requests.setContinuationsEnabled(false);
    const target = await facade.createWorkFolder({ name: "Target work-folder" });
    const sourceDir = join(sandbox, "incoming");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "report.txt"), "external report", "utf8");
    await writeFile(join(sourceDir, "notes.md"), "reusable notes", "utf8");

    assert.equal(api.resolveWorkFoldAgentLineageParent("task-missing"), null);

    // Attachment validation refuses ghosts at send time.
    await assert.rejects(
      () => facade.agentSend({ content: "file this", attachments: [join(sandbox, "missing.txt")], cwd: sandbox }),
      /not found/,
    );

    const send = await facade.agentSend({
      content: "/hold",
      attachments: [join(sourceDir, "report.txt"), sourceDir, join(sourceDir, "notes.md"), "https://example.com/owner/project"],
      cwd: sandbox,
    });
    assert.deepEqual(send.attachments.map((ref) => ref.kind), ["file", "folder", "file", "url"]);
    assert.equal(api.resolveWorkFoldAgentLineageParent(send.taskId)?.taskId, send.taskId, "an active work-fold agent turn validates its explicit lineage id");

    // Only acts carrying the explicit parent id attribute to this request.
    const added = await facade.addFiles({
      workFolder: target.workFolder.id,
      fromPaths: [join(sourceDir, "report.txt")],
      toDir: "Inbox",
      cwd: sandbox,
      parentTaskId: send.taskId,
    });
    assert.ok(added.checkpointId);
    const childConversation = await facade.createConversation({ workFolder: target.workFolder.id });
    changedConversationId = childConversation.conversation.id;
    changedWorkFolderRoot = target.workFolder.workFolderRoot;
    await writeFile(join(changedWorkFolderRoot, "private.md"), "Previous hidden content\n");
    await setWorkFolderIgnoreState(changedWorkFolderRoot, ["private.md"], true);
    const childSend = await facade.sendMessage({
      workFolder: target.workFolder.id,
      conversationId: childConversation.conversation.id,
      content: "/hold",
      parentTaskId: send.taskId,
    });

    await waitForAsync(async () =>
      (await facade.agentTurnStatus({ taskId: send.taskId })).task.state !== "running");
    assert.equal(api.resolveWorkFoldAgentLineageParent(send.taskId), null, "a settled work-fold agent turn no longer validates as a lineage parent");

    const afterParent = await facade.agentTurnStatus({ taskId: send.taskId });
    assert.equal(afterParent.task.state, "succeeded");
    assert.ok(afterParent.request, "a work-fold agent turn always has a request record");
    const request = afterParent.request!;
    assert.equal(request.children.length, 1);
    assert.equal(request.children[0]!.taskId, childSend.taskId);
    assert.equal(request.children[0]!.workFolderName, "Target work-folder");
    // The durable record beneath the phase (docs/collaboration-contract.md, F25).
    assert.match(request.requestId, /^req-/);
    assert.equal(request.kind, "agent");
    assert.equal(request.rootId, request.requestId, "a work-fold agent turn is its own root");
    assert.ok(["working", "handed_off", "done"].includes(request.state));
    assert.deepEqual(request.questions, []);
    assert.deepEqual(request.results, []);
    const childRecord = api.requests.byTaskId(childSend.taskId);
    assert.ok(childRecord, "a delegated chat send is a child request");
    assert.equal(childRecord!.rootId, request.requestId, "the child keeps the work-fold agent request's root");
    assert.equal(childRecord!.depth, 1);
    assert.equal(childRecord!.parentTaskId, send.taskId);
    assert.equal(childRecord!.kind, "cli");
    assert.equal(childRecord!.owner.workFolderId, target.workFolder.id);
    const placed = request.dispositions.find((item) => item.attachment.name === "report.txt")!;
    assert.equal(placed.status, "placed");
    assert.equal(placed.workFolderName, "Target work-folder");
    assert.equal(placed.checkpointId, added.checkpointId);
    assert.equal(request.dispositions.find((item) => item.attachment.kind === "url")!.status, "unrecorded");

    // "Done" is never claimed while the delegated work-folder turn still runs.
    if (request.children[0]!.state === "running") {
      assert.equal(request.phase, "handed_off");
    }
    await waitForAsync(async () => {
      const view = await facade.agentTurnStatus({ taskId: send.taskId });
      return view.request?.children[0]?.state !== "running";
    });
    const settledView = (await facade.agentTurnStatus({ taskId: send.taskId })).request!;
    assert.equal(settledView.phase, "done");
    assert.equal(settledView.reply?.content, "Command completed.");
    assert.deepEqual(settledView.children[0]!.files, ["comparison.md"], "History-derived child results exclude currently ignored files");
    await setWorkFolderIgnoreState(changedWorkFolderRoot, ["comparison.md"], true);
    assert.equal((await facade.agentTurnStatus({ taskId: send.taskId })).request!.children[0]!.files, undefined, "result projection rechecks current visibility");
    await setWorkFolderIgnoreState(changedWorkFolderRoot, ["comparison.md"], false);
    const remoteView = await api.remoteFacade.execute("management.summary", { conversationId: send.conversationId },
      { browserId: "different-browser", grantId: "different-grant", requestId: "read-summary" }) as { latestRequest: { children: Array<{ files?: string[] }> } };
    assert.equal(remoteView.latestRequest.children[0]!.files, undefined, "another browser's summary cannot acquire task result references");

    // The same truth over HTTP for the popover.
    const summary = await getJson(api.origin, "/api/work-fold-agent/summary");
    assert.equal(summary.available, true);
    assert.equal((summary.latestRequest as { taskId?: string }).taskId, send.taskId);
    const httpRequest = await getJson(api.origin, `/api/work-fold-agent/requests/${send.taskId}`);
    assert.equal((httpRequest.request as { phase?: string }).phase, "done");

    const transcript = await getJson(api.origin, `/api/work-fold-agent/conversations/${send.conversationId}`);
    const userMessage = (transcript.messages as Array<{ role: string; attachments?: Array<{ kind: string }> }>)
      .find((message) => message.role === "user" && message.attachments);
    assert.ok(userMessage, "the work-fold agent transcript persists attachment references");
    assert.deepEqual(userMessage!.attachments!.map((item) => item.kind), ["file", "folder", "file", "url"]);

    // The work-fold agent composer reads and changes the same real Pi thinking state as
    // a work-folder Chat. Unsupported decorative values are refused.
    const workFoldAgentRuntime = await getJson(api.origin, `/api/work-fold-agent/conversations/${send.conversationId}/runtime`);
    const workFoldAgentRuntimeView = workFoldAgentRuntime.runtime as { thinkingLevel: string; thinkingLevels: string[] };
    assert.ok(workFoldAgentRuntimeView.thinkingLevels.includes(workFoldAgentRuntimeView.thinkingLevel));
    const nextThinkingLevel = workFoldAgentRuntimeView.thinkingLevels.find((level) => level !== workFoldAgentRuntimeView.thinkingLevel);
    if (nextThinkingLevel) {
      const changed = await postJson(api.origin, `/api/work-fold-agent/conversations/${send.conversationId}/thinking`, { level: nextThinkingLevel });
      assert.equal(changed.status, 200);
      assert.equal((changed.body as { runtime: { thinkingLevel: string } }).runtime.thinkingLevel, nextThinkingLevel);
    }
    const invalidThinking = await postJson(api.origin, `/api/work-fold-agent/conversations/${send.conversationId}/thinking`, { level: "galaxy-brain" });
    assert.equal(invalidThinking.status, 400);

    const newerChat = await facade.agentSend({ content: "/hold", newConversation: true });
    const history = await getJson(api.origin, "/api/work-fold-agent/conversations");
    const savedChats = history.conversations as Array<{ id: string; title: string }>;
    assert.ok(savedChats.some((chat) => chat.id === send.conversationId));
    assert.ok(savedChats.some((chat) => chat.id === newerChat.conversationId));
    assert.ok(!savedChats.some((chat) => chat.id === changedConversationId), "work-folder transcripts do not appear in fold history");
    const olderSummary = await getJson(api.origin, `/api/work-fold-agent/summary?conversationId=${send.conversationId}`);
    assert.equal((olderSummary.conversation as { id: string }).id, send.conversationId);
    assert.equal((olderSummary.latestRequest as { taskId: string }).taskId, send.taskId, "the selected Chat keeps its own request after a newer Chat starts");
    assert.equal((await fetch(`${api.origin}/api/work-fold-agent/summary?conversationId=missing-chat`)).status, 404);
    await facade.agentStop({ taskId: newerChat.taskId });
    await waitForAsync(async () => (await getJson(api.origin, `/api/work-fold-agent/summary?conversationId=${newerChat.conversationId}`)).state === "idle");

    // Stop is request-scoped and honest about what it touched.
    const stopped = await facade.agentStop({ taskId: send.taskId });
    assert.equal(stopped.workFoldAgentAborted, false, "a settled turn has nothing to abort");
    assert.deepEqual(stopped.children, []);

    // Stopping an active request marks the request itself and every running
    // child; neither can later be projected as Done.
    const activeStopParent = await facade.agentSend({ content: "/hold" });
    const activeStopConversation = await facade.createConversation({ workFolder: target.workFolder.id });
    const activeStopChild = await facade.sendMessage({
      workFolder: target.workFolder.id,
      conversationId: activeStopConversation.conversation.id,
      content: "/hold",
      parentTaskId: activeStopParent.taskId,
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const activeStop = await facade.agentStop({ taskId: activeStopParent.taskId });
    assert.equal(activeStop.workFoldAgentAborted, true);
    assert.equal(activeStop.children.some((child) => child.taskId === activeStopChild.taskId && child.aborted), true);
    await waitForAsync(async () => {
      const view = await facade.agentTurnStatus({ taskId: activeStopParent.taskId });
      return view.task.state !== "running" && view.request?.children.every((child) => child.state !== "running") === true;
    });
    assert.equal((await facade.agentTurnStatus({ taskId: activeStopParent.taskId })).request?.phase, "stopped");

    // A delegated child can be cancelled after acceptance but before its Pi
    // prompt exists (for example while attachments or History are preparing).
    // The task-id latch must stop that whole window, not just live Pi sessions.
    const prePromptParent = await facade.agentSend({ content: "/hold" });
    const prePromptConversation = await facade.createConversation({ workFolder: target.workFolder.id });
    heldConversationId = prePromptConversation.conversation.id;
    const prePromptChild = await facade.sendMessage({
      workFolder: target.workFolder.id,
      conversationId: prePromptConversation.conversation.id,
      content: "/hold",
      parentTaskId: prePromptParent.taskId,
    });
    await heldPromptReached;
    const prePromptStop = await facade.agentStop({ taskId: prePromptParent.taskId });
    assert.equal(prePromptStop.workFoldAgentAborted, true);
    assert.equal(prePromptStop.children.find((child) => child.taskId === prePromptChild.taskId)?.aborted, true);
    releaseHeldPrompt();
    await waitForAsync(async () => {
      const view = await facade.agentTurnStatus({ taskId: prePromptParent.taskId });
      return view.task.state !== "running" && view.request?.children.every((child) => child.state !== "running") === true;
    });
    const prePromptView = (await facade.agentTurnStatus({ taskId: prePromptParent.taskId })).request!;
    assert.equal(prePromptView.children.find((child) => child.taskId === prePromptChild.taskId)?.state, "aborted");
    assert.equal(prePromptView.phase, "stopped");

    // Stopping the parent between its check and the child's acceptance
    // refuses the child at acceptance: no child request, no child turn, and
    // no user message in the work-folder Chat (docs/collaboration-contract.md, F25).
    const admissionRaceParent = await facade.agentSend({ content: "/hold" });
    const admissionRaceConversation = await facade.createConversation({ workFolder: target.workFolder.id });
    holdChildAttribution = true;
    const admissionRaceChildPromise = facade.sendMessage({
      workFolder: target.workFolder.id,
      conversationId: admissionRaceConversation.conversation.id,
      content: "/hold",
      parentTaskId: admissionRaceParent.taskId,
    });
    await childAttributionReached;
    const admissionRaceStop = await facade.agentStop({ taskId: admissionRaceParent.taskId });
    assert.equal(admissionRaceStop.workFoldAgentAborted, true);
    assert.deepEqual(admissionRaceStop.children, [], "the child has not been accepted at the stop snapshot");
    releaseChildAttribution();
    await assert.rejects(
      () => admissionRaceChildPromise,
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict" && /stopping or has already finished/.test(error.message),
    );
    await waitForAsync(async () =>
      (await facade.agentTurnStatus({ taskId: admissionRaceParent.taskId })).task.state !== "running");
    const admissionRaceView = (await facade.agentTurnStatus({ taskId: admissionRaceParent.taskId })).request!;
    assert.deepEqual(admissionRaceView.children, [], "the refused child never became a child request");
    assert.equal(admissionRaceView.phase, "stopped");
    const admissionRaceTranscript = await getJson(api.origin, `/api/work-folders/${target.workFolder.id}/conversations/${admissionRaceConversation.conversation.id}`);
    assert.deepEqual(
      (admissionRaceTranscript.messages as Array<{ role: string }>).filter((message) => message.role === "user"),
      [],
      "a refused child leaves no user message behind",
    );

    // A failed delegated turn is a failed request, not a green parent success.
    const failedParent = await facade.agentSend({ content: "/hold" });
    const failedConversation = await facade.createConversation({ workFolder: target.workFolder.id });
    const failedChild = await facade.sendMessage({
      workFolder: target.workFolder.id,
      conversationId: failedConversation.conversation.id,
      content: "This turn deliberately requires an unavailable model.",
      parentTaskId: failedParent.taskId,
    });
    await waitForAsync(async () => {
      const view = await facade.agentTurnStatus({ taskId: failedParent.taskId });
      return view.task.state !== "running" && view.request?.children.every((child) => child.state !== "running") === true;
    });
    const failedView = (await facade.agentTurnStatus({ taskId: failedParent.taskId })).request!;
    assert.equal(failedView.children.find((child) => child.taskId === failedChild.taskId)?.state, "failed");
    assert.equal(failedView.phase, "failed");
    assert.match(failedView.error ?? "", /Settings → AI Models/);
    assert.doesNotMatch(JSON.stringify(failedView), /No API key|node_modules|providers\.md/);
    const missingStop = await fetch(new URL("/api/work-fold-agent/requests/task-missing/stop", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missingStop.status, 404);

    // Route validation refuses malformed sends.
    const badSend = await fetch(new URL("/api/work-fold-agent/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", attachments: [join(sandbox, "nope.txt")] }),
    });
    assert.equal(badSend.status, 400);
    const emptySend = await fetch(new URL("/api/work-fold-agent/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachments: [] }),
    });
    assert.equal(emptySend.status, 400);
    const malformedSelection = await fetch(new URL("/api/work-fold-agent/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", conversationId: 42, newConversation: "yes" }),
    });
    assert.equal(malformedSelection.status, 400);
    const conflictingSelection = await fetch(new URL("/api/work-fold-agent/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", conversationId: send.conversationId, newConversation: true }),
    });
    assert.equal(conflictingSelection.status, 400);
    const staleContinuation = await fetch(new URL("/api/work-fold-agent/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", conversationId: send.conversationId, continuationTaskId: send.taskId }),
    });
    assert.equal(staleContinuation.status, 409, "only a needs-you request can be continued");

    // A renderer send over HTTP is accepted through the same path.
    const httpSend = await fetch(new URL("/api/work-fold-agent/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/hold" }),
    });
    assert.equal(httpSend.status, 202);
    const httpSendBody = await httpSend.json() as { taskId: string };
    await waitForAsync(async () =>
      (await facade.agentTurnStatus({ taskId: httpSendBody.taskId })).task.state !== "running");
  } finally {
    releaseHeldPrompt();
    releaseChildAttribution();
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("renderer overview routes serve the digest without management readiness and advance markers monotonically", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-overview-api-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
  });
  try {
    // The digest is served before any recorded change exists: an empty digest
    // means nothing is recorded, not an error.
    const empty = await getJson(api.origin, "/api/work-fold-agent/overview");
    const emptyOverview = empty.overview as Record<string, unknown>;
    assert.equal(emptyOverview.kind, "work-fold.overview.experimental");
    assert.equal(emptyOverview.cursor, "");
    assert.deepEqual(emptyOverview.seen, {});

    // A recorded restore point gives the digest a change item and a cursor.
    const workFolder = await api.actFacade.createWorkFolder({ name: "Glance work-folder" });
    await writeFile(join(workFolder.workFolder.workFolderRoot, "note.md"), "# Note\n", "utf8");
    await api.actFacade.historySave({ workFolder: workFolder.workFolder.id, label: "Milestone" });
    const recorded = await getJson(api.origin, "/api/work-fold-agent/overview");
    const overview = recorded.overview as { cursor: string; changes: Array<{ kind: string }>; seen: Record<string, string> };
    assert.ok(overview.cursor, "a recorded restore point gives the digest a cursor");
    assert.ok(overview.changes.some((item) => item.kind === "checkpoint-saved"));

    // Acknowledgement is an explicit post-render report, monotonic through
    // the API: a replayed advance is a no-op, and fetching never advanced it.
    assert.deepEqual(overview.seen, {}, "fetching the digest never advances a marker");
    const advanced = await postJson(api.origin, "/api/work-fold-agent/overview/seen", {
      surface: "popover",
      cursor: overview.cursor,
    });
    assert.equal(advanced.status, 200);
    assert.deepEqual(advanced.body, { advanced: true, seenThrough: overview.cursor });
    const replayed = await postJson(api.origin, "/api/work-fold-agent/overview/seen", {
      surface: "popover",
      cursor: overview.cursor,
    });
    assert.deepEqual((replayed.body as { advanced: boolean }).advanced, false);
    const afterSeen = await getJson(api.origin, "/api/work-fold-agent/overview");
    assert.deepEqual((afterSeen.overview as { seen: Record<string, string> }).seen, { popover: overview.cursor });

    // The renderer lane advances only the two desktop surfaces: remote
    // markers move exclusively through the paired browser's signed
    // envelope, and malformed cursors are refused.
    for (const surface of ["remote:grant-1", "cli", 42]) {
      const refused = await postJson(api.origin, "/api/work-fold-agent/overview/seen", {
        surface: surface as never,
        cursor: overview.cursor,
      });
      assert.equal(refused.status, 400, `surface ${String(surface)} must be refused on the renderer lane`);
    }
    assert.equal((await postJson(api.origin, "/api/work-fold-agent/overview/seen", {
      surface: "main-window",
      cursor: "not-a-cursor",
    })).status, 400);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function getJson(origin: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, origin));
  assert.equal(response.status, 200, `${path} must answer 200`);
  return await response.json() as Record<string, unknown>;
}

async function postJson(
  origin: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}
