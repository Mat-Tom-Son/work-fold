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
import { setSpaceIgnoreState } from "../src/local/space-ignore.js";

test("act argv parsing carries manage send attachments and the manage stop command", () => {
  const send = parseWorkFoldCliActArgv([
    "manage", "send", "--message", "file this",
    "--attach", "/tmp/report.pdf",
    "--attach", "https://example.com/repo",
  ]);
  assert.equal(send.name, "manage.send");
  assert.deepEqual(send.attachments, ["/tmp/report.pdf", "https://example.com/repo"]);

  const stop = parseWorkFoldCliActArgv(["manage", "stop", "--task", "task-1", "--json"]);
  assert.equal(stop.name, "manage.stop");
  assert.equal(stop.task, "task-1");
  assert.equal(stop.output, "json");

  assert.throws(() => parseWorkFoldCliActArgv(["manage", "stop"]), /--task/);
  assert.throws(() => parseWorkFoldCliActArgv(["files", "add", "--space", "s", "--from", "a", "--attach", "b"]), /--attach cannot be used/);
  assert.throws(() => parseWorkFoldCliActArgv(["chat", "send", "--space", "s", "--new", "--message", "m", "--attach", "b"]), /--attach cannot be used/);
  const attributed = parseWorkFoldCliActArgv([
    "files", "add", "--space", "s", "--from", "a", "--parent-task", "task-parent",
  ]);
  assert.equal(attributed.parentTaskId, "task-parent");
  assert.throws(() => parseWorkFoldCliActArgv(["manage", "list", "--parent-task", "task-parent"]), /cannot be used/);
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
    manageSend: (input: unknown) => {
      sendInput = input;
      return Promise.resolve({ conversationId: "chat-1", messageId: "m-1", taskId: "task-1", attachments: [] });
    },
    manageStop: () => Promise.resolve({ taskId: "task-1", managementAborted: false, children: [] }),
    createSpace: (input: { name: string }) => input.name === "Fail"
      ? Promise.reject(new Error("create failed"))
      : Promise.resolve({ space: { id: "space-1", name: "Created", spaceRoot: "/tmp/created" } }),
  } as unknown as WorkFoldActFacade;
  const token = "act-token-for-tests-0123456789";
  const cwd = process.cwd();

  const sendResponse = await executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({
      id: "11111111-1111-4111-8111-111111111111",
      argv: ["manage", "send", "--message", "hi", "--attach", "/tmp/a.txt", "--attach", "https://example.com", "--json"],
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
      argv: ["spaces", "create", "--name", "Created", "--parent-task", "task-parent"],
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
  const attributedReceipts = appended.filter((entry) => entry.command === "spaces.create");
  assert.equal(attributedReceipts.length, 2);
  assert.equal(attributedReceipts[0]!.outcome, "accepted");
  assert.equal(attributedReceipts[0]!.parentTaskId, "task-parent", "explicit lineage lands in the journal before the mutation");
  assert.equal(attributedReceipts[1]!.outcome, "ok");
  assert.equal(attributedReceipts[1]!.parentTaskId, "task-parent");
  const failedResponse = await executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({
      id: "33333333-3333-4333-8333-333333333333",
      argv: ["spaces", "create", "--name", "Fail", "--parent-task", "task-parent"],
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
  const sendReceipts = appended.filter((entry) => entry.command === "manage.send");
  assert.equal(sendReceipts.some((entry) => "parentTaskId" in entry && entry.parentTaskId !== undefined), false, "no lineage parent means no stamped parent");
});

test("management requests carry attachments, record lineage, and expose honest phases over the local API", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-management-api-test-"));
  let heldConversationId: string | null = null;
  let changedConversationId: string | null = null;
  let changedSpaceRoot = "";
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
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
    async beforeAgentPrompt(event) {
      if (event.conversationId === changedConversationId) {
        await writeFile(join(changedSpaceRoot, "comparison.md"), "North: $42\n");
        await writeFile(join(changedSpaceRoot, "private.md"), "Hidden result\n");
      }
      if (event.conversationId !== heldConversationId) return;
      reportHeldPrompt();
      await heldPromptGate;
    },
    async beforeManagementActionRecord(event) {
      if (!holdChildAttribution || event.command !== "chat.send") return;
      reportChildAttribution();
      await childAttributionGate;
    },
  });
  try {
    const facade = api.actFacade;
    const target = await facade.createSpace({ name: "Target Space" });
    const sourceDir = join(sandbox, "incoming");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "report.txt"), "external report", "utf8");
    await writeFile(join(sourceDir, "notes.md"), "reusable notes", "utf8");

    assert.equal(api.resolveManagementLineageParent("task-missing"), null);

    // Attachment validation refuses ghosts at send time.
    await assert.rejects(
      () => facade.manageSend({ content: "file this", attachments: [join(sandbox, "missing.txt")], cwd: sandbox }),
      /not found/,
    );

    const send = await facade.manageSend({
      content: "/hold",
      attachments: [join(sourceDir, "report.txt"), sourceDir, join(sourceDir, "notes.md"), "https://example.com/owner/project"],
      cwd: sandbox,
    });
    assert.deepEqual(send.attachments.map((ref) => ref.kind), ["file", "folder", "file", "url"]);
    assert.equal(api.resolveManagementLineageParent(send.taskId)?.taskId, send.taskId, "an active management turn validates its explicit lineage id");

    // Only acts carrying the explicit parent id attribute to this request.
    const added = await facade.addFiles({
      space: target.space.id,
      fromPaths: [join(sourceDir, "report.txt")],
      toDir: "Inbox",
      cwd: sandbox,
      parentTaskId: send.taskId,
    });
    assert.ok(added.checkpointId);
    const libraryAdded = await facade.libraryAdd({
      fromPaths: [join(sourceDir, "notes.md")],
      cwd: sandbox,
      parentTaskId: send.taskId,
    });
    assert.equal(libraryAdded.added.length, 1);
    const childConversation = await facade.createConversation({ space: target.space.id });
    changedConversationId = childConversation.conversation.id;
    changedSpaceRoot = target.space.spaceRoot;
    await writeFile(join(changedSpaceRoot, "private.md"), "Previous hidden content\n");
    await setSpaceIgnoreState(changedSpaceRoot, ["private.md"], true);
    const childSend = await facade.sendMessage({
      space: target.space.id,
      conversationId: childConversation.conversation.id,
      content: "/hold",
      parentTaskId: send.taskId,
    });

    await waitForAsync(async () =>
      (await facade.manageTurnStatus({ taskId: send.taskId })).task.state !== "running");
    assert.equal(api.resolveManagementLineageParent(send.taskId), null, "a settled management turn no longer validates as a lineage parent");

    const afterParent = await facade.manageTurnStatus({ taskId: send.taskId });
    assert.equal(afterParent.task.state, "succeeded");
    assert.ok(afterParent.request, "a management turn always has a request record");
    const request = afterParent.request!;
    assert.equal(request.children.length, 1);
    assert.equal(request.children[0]!.taskId, childSend.taskId);
    assert.equal(request.children[0]!.spaceName, "Target Space");
    // The durable record beneath the phase (docs/collaboration-contract.md, F25).
    assert.match(request.requestId, /^req-/);
    assert.equal(request.kind, "management");
    assert.equal(request.rootId, request.requestId, "a management turn is its own root");
    assert.ok(["working", "handed_off", "done"].includes(request.state));
    assert.deepEqual(request.questions, []);
    assert.deepEqual(request.results, []);
    const childRecord = api.requests.byTaskId(childSend.taskId);
    assert.ok(childRecord, "a delegated chat send is a child request");
    assert.equal(childRecord!.rootId, request.requestId, "the child keeps the management request's root");
    assert.equal(childRecord!.depth, 1);
    assert.equal(childRecord!.parentTaskId, send.taskId);
    assert.equal(childRecord!.kind, "cli");
    assert.equal(childRecord!.owner.spaceId, target.space.id);
    const placed = request.dispositions.find((item) => item.attachment.name === "report.txt")!;
    assert.equal(placed.status, "placed");
    assert.equal(placed.spaceName, "Target Space");
    assert.equal(placed.checkpointId, added.checkpointId);
    assert.equal(request.dispositions.find((item) => item.attachment.kind === "url")!.status, "unrecorded");
    // An attachment that entered the personal Library is accounted for as
    // exactly that: Space-free, no restore point, the Library-relative
    // destinations from the attributed `library add`.
    const libraryDisposition = request.dispositions.find((item) => item.attachment.name === "notes.md")!;
    assert.equal(libraryDisposition.status, "library");
    assert.deepEqual(libraryDisposition.copied, libraryAdded.added.map((file) => file.path));
    assert.equal(libraryDisposition.spaceName, undefined, "the Library is Space-free");
    assert.equal(libraryDisposition.checkpointId, undefined, "the Library records no restore point");

    // "Done" is never claimed while the delegated Space turn still runs.
    if (request.children[0]!.state === "running") {
      assert.equal(request.phase, "handed_off");
    }
    await waitForAsync(async () => {
      const view = await facade.manageTurnStatus({ taskId: send.taskId });
      return view.request?.children[0]?.state !== "running";
    });
    const settledView = (await facade.manageTurnStatus({ taskId: send.taskId })).request!;
    assert.equal(settledView.phase, "done");
    assert.equal(settledView.reply?.content, "Command completed.");
    assert.deepEqual(settledView.children[0]!.files, ["comparison.md"], "History-derived child results exclude currently ignored files");
    await setSpaceIgnoreState(changedSpaceRoot, ["comparison.md"], true);
    assert.equal((await facade.manageTurnStatus({ taskId: send.taskId })).request!.children[0]!.files, undefined, "result projection rechecks current visibility");
    await setSpaceIgnoreState(changedSpaceRoot, ["comparison.md"], false);
    const remoteView = await api.remoteFacade.execute("management.summary", { conversationId: send.conversationId },
      { browserId: "different-browser", grantId: "different-grant", requestId: "read-summary" }) as { latestRequest: { children: Array<{ files?: string[] }> } };
    assert.equal(remoteView.latestRequest.children[0]!.files, undefined, "another browser's summary cannot acquire task result references");

    // The same truth over HTTP for the popover.
    const summary = await getJson(api.origin, "/api/management/summary");
    assert.equal(summary.available, true);
    assert.equal((summary.latestRequest as { taskId?: string }).taskId, send.taskId);
    const httpRequest = await getJson(api.origin, `/api/management/requests/${send.taskId}`);
    assert.equal((httpRequest.request as { phase?: string }).phase, "done");

    const transcript = await getJson(api.origin, `/api/management/conversations/${send.conversationId}`);
    const userMessage = (transcript.messages as Array<{ role: string; attachments?: Array<{ kind: string }> }>)
      .find((message) => message.role === "user" && message.attachments);
    assert.ok(userMessage, "the management transcript persists attachment references");
    assert.deepEqual(userMessage!.attachments!.map((item) => item.kind), ["file", "folder", "file", "url"]);

    // The fold composer reads and changes the same real Pi thinking state as
    // a Space Chat. Unsupported decorative values are refused.
    const managementRuntime = await getJson(api.origin, `/api/management/conversations/${send.conversationId}/runtime`);
    const foldRuntime = managementRuntime.runtime as { thinkingLevel: string; thinkingLevels: string[] };
    assert.ok(foldRuntime.thinkingLevels.includes(foldRuntime.thinkingLevel));
    const nextThinkingLevel = foldRuntime.thinkingLevels.find((level) => level !== foldRuntime.thinkingLevel);
    if (nextThinkingLevel) {
      const changed = await postJson(api.origin, `/api/management/conversations/${send.conversationId}/thinking`, { level: nextThinkingLevel });
      assert.equal(changed.status, 200);
      assert.equal((changed.body as { runtime: { thinkingLevel: string } }).runtime.thinkingLevel, nextThinkingLevel);
    }
    const invalidThinking = await postJson(api.origin, `/api/management/conversations/${send.conversationId}/thinking`, { level: "galaxy-brain" });
    assert.equal(invalidThinking.status, 400);

    // Stop is request-scoped and honest about what it touched.
    const stopped = await facade.manageStop({ taskId: send.taskId });
    assert.equal(stopped.managementAborted, false, "a settled turn has nothing to abort");
    assert.deepEqual(stopped.children, []);

    // Stopping an active request marks the request itself and every running
    // child; neither can later be projected as Done.
    const activeStopParent = await facade.manageSend({ content: "/hold" });
    const activeStopConversation = await facade.createConversation({ space: target.space.id });
    const activeStopChild = await facade.sendMessage({
      space: target.space.id,
      conversationId: activeStopConversation.conversation.id,
      content: "/hold",
      parentTaskId: activeStopParent.taskId,
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const activeStop = await facade.manageStop({ taskId: activeStopParent.taskId });
    assert.equal(activeStop.managementAborted, true);
    assert.equal(activeStop.children.some((child) => child.taskId === activeStopChild.taskId && child.aborted), true);
    await waitForAsync(async () => {
      const view = await facade.manageTurnStatus({ taskId: activeStopParent.taskId });
      return view.task.state !== "running" && view.request?.children.every((child) => child.state !== "running") === true;
    });
    assert.equal((await facade.manageTurnStatus({ taskId: activeStopParent.taskId })).request?.phase, "stopped");

    // A delegated child can be cancelled after acceptance but before its Pi
    // prompt exists (for example while attachments or History are preparing).
    // The task-id latch must stop that whole window, not just live Pi sessions.
    const prePromptParent = await facade.manageSend({ content: "/hold" });
    const prePromptConversation = await facade.createConversation({ space: target.space.id });
    heldConversationId = prePromptConversation.conversation.id;
    const prePromptChild = await facade.sendMessage({
      space: target.space.id,
      conversationId: prePromptConversation.conversation.id,
      content: "/hold",
      parentTaskId: prePromptParent.taskId,
    });
    await heldPromptReached;
    const prePromptStop = await facade.manageStop({ taskId: prePromptParent.taskId });
    assert.equal(prePromptStop.managementAborted, true);
    assert.equal(prePromptStop.children.find((child) => child.taskId === prePromptChild.taskId)?.aborted, true);
    releaseHeldPrompt();
    await waitForAsync(async () => {
      const view = await facade.manageTurnStatus({ taskId: prePromptParent.taskId });
      return view.task.state !== "running" && view.request?.children.every((child) => child.state !== "running") === true;
    });
    const prePromptView = (await facade.manageTurnStatus({ taskId: prePromptParent.taskId })).request!;
    assert.equal(prePromptView.children.find((child) => child.taskId === prePromptChild.taskId)?.state, "aborted");
    assert.equal(prePromptView.phase, "stopped");

    // Stopping the parent between its check and the child's acceptance
    // refuses the child at acceptance: no child request, no child turn, and
    // no user message in the Space Chat (docs/collaboration-contract.md, F25).
    const admissionRaceParent = await facade.manageSend({ content: "/hold" });
    const admissionRaceConversation = await facade.createConversation({ space: target.space.id });
    holdChildAttribution = true;
    const admissionRaceChildPromise = facade.sendMessage({
      space: target.space.id,
      conversationId: admissionRaceConversation.conversation.id,
      content: "/hold",
      parentTaskId: admissionRaceParent.taskId,
    });
    await childAttributionReached;
    const admissionRaceStop = await facade.manageStop({ taskId: admissionRaceParent.taskId });
    assert.equal(admissionRaceStop.managementAborted, true);
    assert.deepEqual(admissionRaceStop.children, [], "the child has not been accepted at the stop snapshot");
    releaseChildAttribution();
    await assert.rejects(
      () => admissionRaceChildPromise,
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict" && /stopping or has already finished/.test(error.message),
    );
    await waitForAsync(async () =>
      (await facade.manageTurnStatus({ taskId: admissionRaceParent.taskId })).task.state !== "running");
    const admissionRaceView = (await facade.manageTurnStatus({ taskId: admissionRaceParent.taskId })).request!;
    assert.deepEqual(admissionRaceView.children, [], "the refused child never became a child request");
    assert.equal(admissionRaceView.phase, "stopped");
    const admissionRaceTranscript = await getJson(api.origin, `/api/spaces/${target.space.id}/conversations/${admissionRaceConversation.conversation.id}`);
    assert.deepEqual(
      (admissionRaceTranscript.messages as Array<{ role: string }>).filter((message) => message.role === "user"),
      [],
      "a refused child leaves no user message behind",
    );

    // A failed delegated turn is a failed request, not a green parent success.
    const failedParent = await facade.manageSend({ content: "/hold" });
    const failedConversation = await facade.createConversation({ space: target.space.id });
    const failedChild = await facade.sendMessage({
      space: target.space.id,
      conversationId: failedConversation.conversation.id,
      content: "This turn deliberately requires an unavailable model.",
      parentTaskId: failedParent.taskId,
    });
    await waitForAsync(async () => {
      const view = await facade.manageTurnStatus({ taskId: failedParent.taskId });
      return view.task.state !== "running" && view.request?.children.every((child) => child.state !== "running") === true;
    });
    const failedView = (await facade.manageTurnStatus({ taskId: failedParent.taskId })).request!;
    assert.equal(failedView.children.find((child) => child.taskId === failedChild.taskId)?.state, "failed");
    assert.equal(failedView.phase, "failed");
    assert.match(failedView.error ?? "", /Settings → Assistant/);
    assert.doesNotMatch(JSON.stringify(failedView), /No API key|node_modules|providers\.md/);
    const missingStop = await fetch(new URL("/api/management/requests/task-missing/stop", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missingStop.status, 404);

    // Route validation refuses malformed sends.
    const badSend = await fetch(new URL("/api/management/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", attachments: [join(sandbox, "nope.txt")] }),
    });
    assert.equal(badSend.status, 400);
    const emptySend = await fetch(new URL("/api/management/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachments: [] }),
    });
    assert.equal(emptySend.status, 400);
    const malformedSelection = await fetch(new URL("/api/management/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", conversationId: 42, newConversation: "yes" }),
    });
    assert.equal(malformedSelection.status, 400);
    const conflictingSelection = await fetch(new URL("/api/management/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", conversationId: send.conversationId, newConversation: true }),
    });
    assert.equal(conflictingSelection.status, 400);
    const staleContinuation = await fetch(new URL("/api/management/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", conversationId: send.conversationId, continuationTaskId: send.taskId }),
    });
    assert.equal(staleContinuation.status, 409, "only a needs-you request can be continued");

    // A renderer send over HTTP is accepted through the same path.
    const httpSend = await fetch(new URL("/api/management/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/hold" }),
    });
    assert.equal(httpSend.status, 202);
    const httpSendBody = await httpSend.json() as { taskId: string };
    await waitForAsync(async () =>
      (await facade.manageTurnStatus({ taskId: httpSendBody.taskId })).task.state !== "running");
  } finally {
    releaseHeldPrompt();
    releaseChildAttribution();
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("renderer glance routes serve the digest without management readiness and advance markers monotonically", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-glance-api-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
  });
  try {
    // The digest is served before any recorded change exists: an empty digest
    // means nothing is recorded, not an error.
    const empty = await getJson(api.origin, "/api/management/glance");
    const emptyGlance = empty.glance as Record<string, unknown>;
    assert.equal(emptyGlance.kind, "work-fold.glance.experimental");
    assert.equal(emptyGlance.cursor, "");
    assert.deepEqual(emptyGlance.seen, {});

    // A recorded restore point gives the digest a change item and a cursor.
    const space = await api.actFacade.createSpace({ name: "Glance Space" });
    await writeFile(join(space.space.spaceRoot, "note.md"), "# Note\n", "utf8");
    await api.actFacade.historySave({ space: space.space.id, label: "Milestone" });
    const recorded = await getJson(api.origin, "/api/management/glance");
    const glance = recorded.glance as { cursor: string; changes: Array<{ kind: string }>; seen: Record<string, string> };
    assert.ok(glance.cursor, "a recorded restore point gives the digest a cursor");
    assert.ok(glance.changes.some((item) => item.kind === "checkpoint-saved"));

    // Acknowledgement is an explicit post-render report, monotonic through
    // the API: a replayed advance is a no-op, and fetching never advanced it.
    assert.deepEqual(glance.seen, {}, "fetching the digest never advances a marker");
    const advanced = await postJson(api.origin, "/api/management/glance/seen", {
      surface: "popover",
      cursor: glance.cursor,
    });
    assert.equal(advanced.status, 200);
    assert.deepEqual(advanced.body, { advanced: true, seenThrough: glance.cursor });
    const replayed = await postJson(api.origin, "/api/management/glance/seen", {
      surface: "popover",
      cursor: glance.cursor,
    });
    assert.deepEqual((replayed.body as { advanced: boolean }).advanced, false);
    const afterSeen = await getJson(api.origin, "/api/management/glance");
    assert.deepEqual((afterSeen.glance as { seen: Record<string, string> }).seen, { popover: glance.cursor });

    // The renderer lane advances only the two desktop surfaces: remote
    // markers move exclusively through the paired browser's signed
    // envelope, and malformed cursors are refused.
    for (const surface of ["remote:grant-1", "cli", 42]) {
      const refused = await postJson(api.origin, "/api/management/glance/seen", {
        surface: surface as never,
        cursor: glance.cursor,
      });
      assert.equal(refused.status, 400, `surface ${String(surface)} must be refused on the renderer lane`);
    }
    assert.equal((await postJson(api.origin, "/api/management/glance/seen", {
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
