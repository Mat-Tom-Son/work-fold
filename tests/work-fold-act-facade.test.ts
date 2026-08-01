import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WorkFoldCliError } from "../src/local/cli/index.js";
import { startLocalApi } from "../src/local/server.js";

test("the act facade drives Space, conversation, and file-addition lifecycles with CLI semantics", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-act-facade-test-"));
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
    const createdSpace = await facade.createSpace({ name: "Act Space" });
    assert.ok(createdSpace.space.id);
    assert.equal(createdSpace.space.name, "Act Space");
    await assert.rejects(() => facade.createSpace({ name: "  " }), /Space name is required/);

    // Space selection follows the CLI id-or-exact-name semantics.
    const byName = await facade.listConversations({ space: "Act Space" });
    assert.deepEqual(byName.conversations, []);
    await assert.rejects(
      () => facade.listConversations({ space: "Missing Space" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );

    const registeredRoot = join(sandbox, "external-folder");
    await mkdir(registeredRoot, { recursive: true });
    const registered = await facade.registerSpace({ spaceRoot: registeredRoot });
    assert.equal(registered.space.spaceRoot, registeredRoot);
    await assert.rejects(() => facade.registerSpace({ spaceRoot: "relative/path" }), /absolute folder path/);

    // Checks remain inert until an explicit enable act, operate over the exact
    // designated file, and use their own task-scoped result lifecycle.
    const checkProposalPath = join(sandbox, "required-delivery.work-fold-check.json");
    await writeFile(checkProposalPath, JSON.stringify({
      kind: "work-fold.check-proposal",
      version: 1,
      name: "Required delivery",
      createdBy: "human",
      createdAt: "2026-08-01T00:00:00.000Z",
      check: {
        title: "The signed delivery exists",
        severity: "error",
        trigger: "manual",
        sensor: { id: "work-fold.file-presence", revision: 1, parameters: { expect: "present" } },
        targets: [{ kind: "file", role: "primary", path: "Delivery/signed.pdf" }],
      },
    }), "utf8");
    const check = await facade.checksEnable({
      space: createdSpace.space.id,
      proposalPath: checkProposalPath,
      cwd: sandbox,
    });
    assert.equal(check.check.targetCount, 1);
    const checkRun = await facade.checksRun({ space: createdSpace.space.id, checkId: check.check.id });
    await waitForAsync(async () => {
      const status = await facade.checksTask({ space: createdSpace.space.id, taskId: checkRun.taskId });
      return status.task.state !== "accepted" && status.task.state !== "running";
    });
    const checkResult = await facade.checksResult({ space: createdSpace.space.id, taskId: checkRun.taskId });
    assert.equal(checkResult.run.state, "succeeded");
    assert.equal(checkResult.run.findings.length, 1);
    const checkProblems = await facade.checksProblems({ space: createdSpace.space.id, checkId: check.check.id });
    assert.equal(checkProblems.findings.length, 1);
    await facade.checksDecide({
      space: createdSpace.space.id,
      findingId: checkProblems.findings[0]!.id,
      decision: "reject",
    });
    assert.equal((await facade.checksProblems({ space: createdSpace.space.id })).findings.length, 0);

    const conversation = await facade.createConversation({ space: createdSpace.space.id });
    await assert.rejects(
      () => facade.sendMessage({ space: createdSpace.space.id, content: "hello" }),
      /--conversation <id> or --new/,
    );
    const send = await facade.sendMessage({
      space: createdSpace.space.id,
      conversationId: conversation.conversation.id,
      content: "/hold",
    });
    assert.equal(send.conversationId, conversation.conversation.id);
    assert.ok(send.taskId);
    const runningTasks = await api.kernel.getTasks({ kind: "system" });
    const turnTask = runningTasks.tasks.find((task) => task.id === send.taskId);
    assert.equal(turnTask?.actor.kind, "cli", "act-lane turns must record a cli actor in the kernel");

    await assert.rejects(
      () => facade.sendMessage({ space: createdSpace.space.id, conversationId: conversation.conversation.id, content: "again" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict",
    );

    // Waiting is task-scoped: follow the exact accepted turn to a terminal
    // outcome instead of polling the conversation for idleness.
    await waitForAsync(async () =>
      (await facade.turnStatus({ space: createdSpace.space.id, taskId: send.taskId })).task.state !== "running");
    const settled = await facade.turnStatus({ space: createdSpace.space.id, taskId: send.taskId });
    assert.equal(settled.task.state, "succeeded");
    assert.equal(settled.task.conversationId, conversation.conversation.id);
    assert.ok(settled.task.messageId, "a succeeded turn must record its response message id");
    const turnResult = await facade.turnResult({ space: createdSpace.space.id, taskId: send.taskId });
    assert.equal(turnResult.message.content, "Command completed.");
    assert.equal(turnResult.message.id, settled.task.messageId);
    assert.equal(turnResult.task.state, "succeeded");

    const unknownTask = await facade.turnStatus({ space: createdSpace.space.id, taskId: "task-unknown" });
    assert.equal(unknownTask.task.state, "unknown");
    await assert.rejects(
      () => facade.turnResult({ space: createdSpace.space.id, taskId: "task-unknown" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );

    const result = await facade.conversationResult({
      space: createdSpace.space.id,
      conversationId: conversation.conversation.id,
      messages: 5,
    });
    assert.equal(result.lastAssistant, "Command completed.");
    assert.equal(result.messages.at(-1)?.role, "assistant");
    assert.equal(result.messages.some((message) => message.content === "/hold"), true);
    assert.equal(result.state, "idle");

    // A failing turn (no provider is configured, so a plain prompt fails)
    // must settle as failed for its own task — even though the newest
    // conversation-scoped assistant message is still the old success.
    const failing = await facade.sendMessage({
      space: createdSpace.space.id,
      conversationId: conversation.conversation.id,
      content: "summarize this space",
    });
    await waitForAsync(async () =>
      (await facade.turnStatus({ space: createdSpace.space.id, taskId: failing.taskId })).task.state !== "running");
    const failedStatus = await facade.turnStatus({ space: createdSpace.space.id, taskId: failing.taskId });
    assert.equal(failedStatus.task.state, "failed");
    assert.ok(failedStatus.task.error, "a failed turn must record its error");
    await assert.rejects(
      () => facade.turnResult({ space: createdSpace.space.id, taskId: failing.taskId }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "failure",
    );
    const staleTail = await facade.conversationResult({ space: createdSpace.space.id, conversationId: conversation.conversation.id });
    assert.equal(staleTail.lastAssistant, "Command completed.", "the stale success the task-scoped path protects against");
    await assert.rejects(
      () => facade.conversationResult({ space: createdSpace.space.id, conversationId: "chat-missing" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );

    const aborted = await facade.abortTurn({ space: createdSpace.space.id, conversationId: conversation.conversation.id });
    assert.equal(aborted.aborted, false, "aborting an idle Chat must report false");

    // files add copies external material and records an additive restore point.
    const sourceDir = join(sandbox, "incoming");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "report.txt"), "external", "utf8");
    await writeFile(join(sandbox, "notes.md"), "note", "utf8");
    const added = await facade.addFiles({
      space: createdSpace.space.id,
      fromPaths: [join(sourceDir, "report.txt"), "notes.md"],
      toDir: "Inbox",
      cwd: sandbox,
    });
    assert.deepEqual(added.copied, ["Inbox/report.txt", "Inbox/notes.md"]);
    assert.ok(added.checkpointId, "files add must record a restore point");
    assert.equal(existsSync(join(createdSpace.space.spaceRoot, "Inbox", "report.txt")), true);

    if (process.platform !== "win32") {
      await symlink(join(sourceDir, "report.txt"), join(sandbox, "linked.txt"));
      await assert.rejects(
        () => facade.addFiles({ space: createdSpace.space.id, fromPaths: [join(sandbox, "linked.txt")], cwd: sandbox }),
        /Symbolic-link/,
      );
    }
    await assert.rejects(
      () => facade.addFiles({ space: createdSpace.space.id, fromPaths: [join(sandbox, "content")], cwd: sandbox }),
      /contains this Space/,
    );
    await assert.rejects(
      () => facade.addFiles({
        space: createdSpace.space.id,
        fromPaths: [join(createdSpace.space.spaceRoot, "Inbox", "report.txt")],
        cwd: sandbox,
      }),
      /already inside this Space/,
    );
    await assert.rejects(
      () => facade.addFiles({ space: createdSpace.space.id, fromPaths: [join(sandbox, "missing.bin")], cwd: sandbox }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );

    // A folder copy that fails partway must leave no partial destination.
    if (process.platform !== "win32") {
      const partialSource = join(sandbox, "partial-source");
      await mkdir(partialSource, { recursive: true });
      await writeFile(join(partialSource, "readable.txt"), "ok", "utf8");
      await writeFile(join(partialSource, "unreadable.txt"), "secret", "utf8");
      await chmod(join(partialSource, "unreadable.txt"), 0o000);
      try {
        await assert.rejects(() =>
          facade.addFiles({ space: createdSpace.space.id, fromPaths: [partialSource], cwd: sandbox }));
        assert.equal(
          existsSync(join(createdSpace.space.spaceRoot, "partial-source")),
          false,
          "a failed folder copy must leave no partial destination",
        );
      } finally {
        await chmod(join(partialSource, "unreadable.txt"), 0o600);
      }
    }
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
