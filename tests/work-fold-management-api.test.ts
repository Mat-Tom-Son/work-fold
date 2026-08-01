import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  executeWorkFoldCliActRequest,
  parseWorkFoldCliActArgv,
} from "../src/local/cli/act-commands.js";
import { createWorkFoldCliActRequest } from "../src/local/cli/act-protocol.js";
import type { WorkFoldActFacade } from "../src/local/cli/act-facade.js";
import type { WorkFoldCliActReceiptV1 } from "../src/local/cli/act-receipts.js";
import { startLocalApi } from "../src/local/server.js";

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
  });
  try {
    const facade = api.actFacade;
    const target = await facade.createSpace({ name: "Target Space" });
    const sourceDir = join(sandbox, "incoming");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "report.txt"), "external report", "utf8");

    assert.equal(api.resolveManagementLineageParent("task-missing"), null);

    // Attachment validation refuses ghosts at send time.
    await assert.rejects(
      () => facade.manageSend({ content: "file this", attachments: [join(sandbox, "missing.txt")], cwd: sandbox }),
      /not found/,
    );

    const send = await facade.manageSend({
      content: "/hold",
      attachments: [join(sourceDir, "report.txt"), sourceDir, "https://example.com/owner/project"],
      cwd: sandbox,
    });
    assert.deepEqual(send.attachments.map((ref) => ref.kind), ["file", "folder", "url"]);
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
    const childConversation = await facade.createConversation({ space: target.space.id });
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
    const placed = request.dispositions.find((item) => item.attachment.name === "report.txt")!;
    assert.equal(placed.status, "placed");
    assert.equal(placed.spaceName, "Target Space");
    assert.equal(placed.checkpointId, added.checkpointId);
    assert.equal(request.dispositions.find((item) => item.attachment.kind === "url")!.status, "unrecorded");

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
    assert.deepEqual(userMessage!.attachments!.map((item) => item.kind), ["file", "folder", "url"]);

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
    assert.match(failedView.error ?? "", /No API key/);
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
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function getJson(origin: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, origin));
  assert.equal(response.status, 200, `${path} must answer 200`);
  return await response.json() as Record<string, unknown>;
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}
