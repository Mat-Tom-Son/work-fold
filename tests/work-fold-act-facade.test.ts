import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendMessage } from "../src/local/agent/chat-store.js";
import { RoutedRestrictedAppProposalHost } from "../src/local/agent/restricted-app-proposals.js";
import { RestrictedAppService } from "../src/local/agent/restricted-app-service.js";
import { FileRestrictedAppStorage } from "../src/local/agent/restricted-app-storage.js";
import { WorkFoldCliError } from "../src/local/cli/index.js";
import { uploadResourceFiles } from "../src/local/resources.js";
import {
  normalizeWorkFoldRoutingDeclaration,
  workFoldRoutingDigest,
} from "../src/local/routings/routing-declarations.js";
import { startLocalApi } from "../src/local/server.js";
import { setSpaceIgnoreState } from "../src/local/space-ignore.js";

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
    // settles as failed for its own task and saves a sanitized Assistant
    // result instead of leaving an older success looking current.
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
    assert.ok(failedStatus.task.messageId, "a non-cancelled failure must record its durable result message");
    await assert.rejects(
      () => facade.turnResult({ space: createdSpace.space.id, taskId: failing.taskId }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "failure",
    );
    const failedTail = await facade.conversationResult({ space: createdSpace.space.id, conversationId: conversation.conversation.id });
    assert.match(failedTail.lastAssistant ?? "", /Settings → Assistant/);
    assert.equal(failedTail.messages.at(-1)?.interrupted, true);
    assert.doesNotMatch(JSON.stringify(failedTail), /No API key|node_modules|providers\.md/);
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

test("the act facade drives Chat lifecycle and History families with ledger conflict rules", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-act-fold-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 400)),
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
    const { space } = await facade.createSpace({ name: "Fold Space" });
    const conversation = (await facade.createConversation({ space: space.id })).conversation;

    // Rename appends a manual title record and reports the prior title for
    // the receipt's undo reference.
    const renamed = await facade.chatRename({ space: space.id, conversationId: conversation.id, title: "Weekly plan" });
    assert.equal(renamed.conversation.title, "Weekly plan");
    assert.equal(renamed.priorTitle, "New Chat");
    await assert.rejects(
      () => facade.chatRename({ space: space.id, conversationId: "chat-missing", title: "x" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );
    await assert.rejects(
      () => facade.chatRename({ space: space.id, conversationId: conversation.id, title: "   " }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "usage",
    );

    // Snooze requires a future time and records the prior lifecycle state.
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const snoozed = await facade.chatSnooze({ space: space.id, conversationId: conversation.id, until });
    assert.equal(snoozed.conversation.snoozedUntil, until);
    assert.deepEqual(snoozed.priorLifecycle, { archivedAt: null, snoozedUntil: null });
    await assert.rejects(
      () => facade.chatSnooze({
        space: space.id,
        conversationId: conversation.id,
        until: new Date(Date.now() - 1000).toISOString(),
      }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "usage" && /future snooze time/.test(error.message),
    );

    // Sending into a future-snoozed Chat is refused until an explicit resume.
    await assert.rejects(
      () => facade.sendMessage({ space: space.id, conversationId: conversation.id, content: "hello" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict",
    );
    const resumedFromSnooze = await facade.chatResume({ space: space.id, conversationId: conversation.id });
    assert.equal(resumedFromSnooze.conversation.snoozedUntil, null);
    assert.equal(resumedFromSnooze.priorLifecycle.snoozedUntil, until);
    await assert.rejects(
      () => facade.chatResume({ space: space.id, conversationId: conversation.id }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict" && /already active/.test(error.message),
    );

    // Archive wins over snooze rules: one lifecycle change per act, and the
    // inverse verb is resume.
    const archived = await facade.chatArchive({ space: space.id, conversationId: conversation.id });
    assert.ok(archived.conversation.archivedAt);
    assert.deepEqual(archived.priorLifecycle, { archivedAt: null, snoozedUntil: null });
    await assert.rejects(
      () => facade.chatArchive({ space: space.id, conversationId: conversation.id }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict" && /already archived/.test(error.message),
    );
    await assert.rejects(
      () => facade.chatSnooze({ space: space.id, conversationId: conversation.id, until }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict" && /Unarchive this Chat/.test(error.message),
    );
    await assert.rejects(
      () => facade.sendMessage({ space: space.id, conversationId: conversation.id, content: "hello" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict" && /Restore this Chat/.test(error.message),
    );
    const resumedFromArchive = await facade.chatResume({ space: space.id, conversationId: conversation.id });
    assert.equal(resumedFromArchive.conversation.archivedAt, null);
    assert.ok(resumedFromArchive.priorLifecycle.archivedAt);

    // Lifecycle changes are append-only records in the Chat's portable log.
    const transcript = await readFile(
      join(space.spaceRoot, ".work-fold", "conversations", `${conversation.id}.jsonl`),
      "utf8",
    );
    assert.equal(transcript.split("\n").filter((line) => line.includes("\"conversation_lifecycle\"")).length, 4);

    // History: saving is additive and honestly reports an unchanged Space.
    await writeFile(join(space.spaceRoot, "notes.md"), "first draft", "utf8");
    const firstSave = await facade.historySave({ space: space.id, label: "draft one" });
    assert.equal(firstSave.created, true);
    assert.equal(firstSave.checkpoint.label, "draft one");
    assert.ok(firstSave.checkpoint.fileCount >= 1);
    const unchangedSave = await facade.historySave({ space: space.id });
    assert.equal(unchangedSave.created, false);
    assert.equal(unchangedSave.checkpoint.checkpointId, firstSave.checkpoint.checkpointId);

    await writeFile(join(space.spaceRoot, "notes.md"), "second draft", "utf8");
    const secondSave = await facade.historySave({ space: space.id });
    assert.equal(secondSave.created, true);
    assert.notEqual(secondSave.checkpoint.checkpointId, firstSave.checkpoint.checkpointId);
    const listed = await facade.historyList({ space: space.id });
    assert.deepEqual(
      listed.checkpoints.slice(0, 2).map((checkpoint) => checkpoint.checkpointId),
      [secondSave.checkpoint.checkpointId, firstSave.checkpoint.checkpointId],
    );

    // File versions are content-addressed and restorable one file at a time,
    // with the safety restore point History itself records.
    const versions = await facade.historyVersions({ space: space.id, path: "notes.md" });
    assert.equal(versions.versions.length, 2);
    const firstVersion = versions.versions.find((version) => version.checkpointId === firstSave.checkpoint.checkpointId);
    assert.ok(firstVersion);
    const fileRestore = await facade.historyRestoreFile({
      space: space.id,
      path: "notes.md",
      version: firstVersion.hashSha256,
    });
    assert.equal(fileRestore.restored, true);
    assert.ok(fileRestore.safetyCheckpointId);
    assert.ok(fileRestore.previousHashSha256);
    assert.equal(await readFile(join(space.spaceRoot, "notes.md"), "utf8"), "first draft");
    await assert.rejects(
      () => facade.historyRestoreFile({ space: space.id, path: "notes.md", version: "not-a-hash" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "usage",
    );
    await assert.rejects(
      () => facade.historyRestoreFile({ space: space.id, path: "notes.md", version: "0".repeat(64) }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );
    await mkdir(join(space.spaceRoot, "docs"), { recursive: true });
    await assert.rejects(
      () => facade.historyRestoreFile({ space: space.id, path: "docs", version: firstVersion.hashSha256 }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict" && /currently a folder/.test(error.message),
    );

    // Whole-Space restore returns to the restore point and records its own
    // pre-restore safety restore point.
    await writeFile(join(space.spaceRoot, "notes.md"), "unsaved third draft", "utf8");
    const restored = await facade.historyRestore({ space: space.id, checkpointId: secondSave.checkpoint.checkpointId });
    assert.equal(restored.restored, true);
    assert.equal(restored.checkpointId, secondSave.checkpoint.checkpointId);
    assert.ok(restored.safetyCheckpointId);
    assert.ok(restored.restoredFileCount >= 1);
    assert.equal(await readFile(join(space.spaceRoot, "notes.md"), "utf8"), "second draft");
    await assert.rejects(
      () => facade.historyRestore({ space: space.id, checkpointId: "cp-00000000000000-missing" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );

    // Ledger conflict rules: lifecycle verbs, compaction, and whole-Space
    // restore are refused while an Assistant turn runs in that Chat / Space.
    const holdConversation = (await facade.createConversation({ space: space.id })).conversation;
    const running = await facade.sendMessage({ space: space.id, conversationId: holdConversation.id, content: "/hold" });
    await assert.rejects(
      () => facade.chatRename({ space: space.id, conversationId: holdConversation.id, title: "Busy" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict" && /Assistant turn to finish/.test(error.message),
    );
    await assert.rejects(
      () => facade.chatCompact({ space: space.id, conversationId: holdConversation.id }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict" && /Assistant turn to finish/.test(error.message),
    );
    await assert.rejects(
      () => facade.historyRestore({ space: space.id, checkpointId: secondSave.checkpoint.checkpointId }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict" && /running Assistant turn in this Space/.test(error.message),
    );
    const desktopRestore = await fetch(`${api.origin}/api/spaces/${space.id}/history/checkpoints/${secondSave.checkpoint.checkpointId}/restore`, { method: "POST" });
    assert.equal(desktopRestore.status, 409, "desktop checkpoint restore uses the same running-work fence");
    const desktopFileRestore = await fetch(`${api.origin}/api/spaces/${space.id}/history/file-versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes.md", hashSha256: firstVersion.hashSha256 }),
    });
    assert.equal(desktopFileRestore.status, 409, "desktop file restore cannot bypass the Space fence");
    await waitForAsync(async () =>
      (await facade.turnStatus({ space: space.id, taskId: running.taskId })).task.state !== "running");

    // chat compact reuses the renderer's compaction internals with the
    // kernel-task discipline. No provider is configured here, so the
    // compaction fails through the same runtime path as the renderer — and
    // the kernel compaction task is finished on that failure, never leaked.
    await assert.rejects(
      () => facade.chatCompact({ space: space.id, conversationId: "chat-missing" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );
    await assert.rejects(
      () => facade.chatCompact({ space: space.id, conversationId: holdConversation.id }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "failure",
    );
    assert.deepEqual(
      (await api.kernel.getTasks({ kind: "system" })).tasks,
      [],
      "a failed compaction finishes its kernel task instead of leaving a ghost",
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the act facade drives file, search, and Library families with ledger safety rules", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-act-files-test-"));
  await mkdir(join(sandbox, "agent"), { recursive: true });
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
    const { space } = await facade.createSpace({ name: "Files Space" });

    // Creation runs the desktop create internals: additive, name-collision
    // refused, and undone by files delete rather than a restore point.
    const folder = await facade.filesMkdir({ space: space.id, path: "notes" });
    assert.equal(folder.path, "notes");
    assert.equal(folder.kind, "folder");
    assert.ok(folder.safetyCheckpointId);
    assert.equal(existsSync(join(space.spaceRoot, "notes")), true);
    await assert.rejects(() => facade.filesMkdir({ space: space.id, path: "notes" }), /already exists/);

    const created = await facade.filesCreate({ space: space.id, path: "notes/todo.md" });
    assert.equal(created.path, "notes/todo.md");
    assert.equal(created.kind, "file");
    assert.equal(await readFile(join(space.spaceRoot, "notes", "todo.md"), "utf8"), "");
    await assert.rejects(() => facade.filesCreate({ space: space.id, path: "notes/todo.md" }), /already exists/);

    // Reserved metadata is never a valid endpoint, exactly as in the renderer.
    await assert.rejects(() => facade.filesCreate({ space: space.id, path: ".pi/hack.md" }), /reserved/);
    await assert.rejects(() => facade.filesMkdir({ space: space.id, path: ".work-fold/extra" }), /reserved/);
    await assert.rejects(
      () => facade.filesMkdir({ space: space.id, path: "   ", parentTaskId: undefined }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "usage",
    );

    // Move records the same pre-move safety restore point as the desktop
    // route, and restoring it is the undo.
    await mkdir(join(space.spaceRoot, "docs"), { recursive: true });
    await writeFile(join(space.spaceRoot, "docs", "plan.md"), "plan", "utf8");
    const moved = await facade.filesMove({ space: space.id, fromPath: "docs/plan.md", toDir: "notes" });
    assert.equal(moved.fromPath, "docs/plan.md");
    assert.equal(moved.path, "notes/plan.md");
    assert.equal(moved.kind, "file");
    assert.equal(existsSync(join(space.spaceRoot, "notes", "plan.md")), true);
    assert.equal(existsSync(join(space.spaceRoot, "docs", "plan.md")), false);
    const movedBack = await facade.historyRestore({ space: space.id, checkpointId: moved.safetyCheckpointId });
    assert.equal(movedBack.movedEntryCount, 1);
    assert.equal(existsSync(join(space.spaceRoot, "docs", "plan.md")), true);
    assert.equal(existsSync(join(space.spaceRoot, "notes", "plan.md")), false);
    await assert.rejects(
      () => facade.filesMove({ space: space.id, fromPath: "notes", toDir: "notes/sub" }),
      /into themselves/,
    );

    // Rename reports the prior name for the receipt's undo reference.
    const renamed = await facade.filesRename({ space: space.id, path: "notes/todo.md", newName: "done.md" });
    assert.equal(renamed.priorName, "todo.md");
    assert.equal(renamed.fromPath, "notes/todo.md");
    assert.equal(renamed.path, "notes/done.md");
    assert.ok(renamed.safetyCheckpointId);
    await assert.rejects(
      () => facade.filesRename({ space: space.id, path: "notes/done.md", newName: "done.md" }),
      /already has this name/,
    );

    // Delete's safety restore point is the durable form of the Undo toast.
    await writeFile(join(space.spaceRoot, "notes", "done.md"), "keep me", "utf8");
    const deletedEntry = await facade.filesDelete({ space: space.id, path: "notes/done.md" });
    assert.equal(deletedEntry.deleted, true);
    assert.equal(deletedEntry.kind, "file");
    assert.equal(existsSync(join(space.spaceRoot, "notes", "done.md")), false);
    await facade.historyRestore({ space: space.id, checkpointId: deletedEntry.safetyCheckpointId });
    assert.equal(await readFile(join(space.spaceRoot, "notes", "done.md"), "utf8"), "keep me");

    // F20: a delete whose restore point cannot cover every matched file never
    // refuses. The whole selected entry moves to Recently deleted, the
    // receipt's undo reference is that entry, and restoring it puts the
    // entry back byte for byte — links included.
    await mkdir(join(space.spaceRoot, "bulk"), { recursive: true });
    await writeFile(join(space.spaceRoot, "bulk", "big.bin"), "0123456789", "utf8");
    if (process.platform !== "win32") {
      await symlink(join(space.spaceRoot, "notes", "done.md"), join(space.spaceRoot, "bulk", "link.md"));
    }
    const checkpointsBefore = (await facade.historyList({ space: space.id })).checkpoints.length;
    process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES = "4";
    let uncoverable;
    try {
      uncoverable = await facade.filesDelete({ space: space.id, path: "bulk" });
    } finally {
      delete process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES;
    }
    assert.equal(uncoverable.deleted, true);
    assert.equal(uncoverable.kind, "folder");
    assert.equal(existsSync(join(space.spaceRoot, "bulk")), false, "the entry moves out of the Space");
    assert.equal(uncoverable.recovery.kind, "trash");
    assert.equal(
      (await facade.historyList({ space: space.id })).checkpoints.length,
      checkpointsBefore + 1,
      "the delete still records its restore point for what History could cover",
    );
    const uncoveredReasons = uncoverable.recovery.kind === "trash"
      ? uncoverable.recovery.uncovered.map((file) => `${file.path}:${file.reason}`).sort()
      : [];
    assert.ok(uncoveredReasons.includes("bulk/big.bin:too_large"), uncoveredReasons.join(","));
    if (process.platform !== "win32") {
      assert.ok(uncoveredReasons.includes("bulk/link.md:symbolic_link"), uncoveredReasons.join(","));
    }
    const kept = (await api.trash.list()).entries;
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.kind, "folder");
    assert.equal(kept[0]?.originalPath, "bulk");
    assert.equal(kept[0]?.spaceId, space.id);
    const restored = await facade.trashRestore({ entry: kept[0]!.id });
    assert.equal(restored.restored.kind, "folder");
    assert.equal(await readFile(join(space.spaceRoot, "bulk", "big.bin"), "utf8"), "0123456789");
    if (process.platform !== "win32") {
      assert.equal((await lstat(join(space.spaceRoot, "bulk", "link.md"))).isSymbolicLink(), true);
      await rm(join(space.spaceRoot, "bulk", "link.md"));
    }
    assert.deepEqual((await api.trash.list()).entries, [], "a restored item leaves Recently deleted");

    // Search reuses the Space search service: ignore rules hold, scopes
    // narrow, and malformed queries map to usage errors.
    await mkdir(join(space.spaceRoot, "vendor"), { recursive: true });
    await writeFile(join(space.spaceRoot, "vendor", "bundle.js"), "quarterly budget in a dependency", "utf8");
    await writeFile(join(space.spaceRoot, "notes", "report.md"), "the quarterly budget is due", "utf8");
    await appendMessage(space.spaceRoot, "chat-1", {
      id: "m1",
      role: "user",
      content: "check the quarterly budget",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    await setSpaceIgnoreState(space.spaceRoot, ["vendor"], true);
    const found = await facade.search({ space: space.id, query: "quarterly budget" });
    assert.equal(found.scope, "all");
    assert.equal(found.query, "quarterly budget");
    assert.deepEqual(found.files.map((match) => match.path), ["notes/report.md"]);
    assert.equal(found.files[0]?.line, 1);
    assert.equal(found.chats.length, 1);
    assert.equal(found.chats[0]?.conversationId, "chat-1");
    assert.equal(found.truncated, false);
    const filesOnly = await facade.search({ space: space.id, query: "quarterly budget", scope: "files" });
    assert.equal(filesOnly.chats.length, 0);
    assert.equal(filesOnly.files.length, 1);
    await assert.rejects(
      () => facade.search({ space: space.id, query: "   " }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "usage",
    );
    await assert.rejects(
      () => facade.search({ space: space.id, query: "x".repeat(201) }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "usage",
    );

    // Library: passive personal collection; copy-in is explicit, lands under
    // From Library, records a restore point in the destination Space, and
    // leaves the Library original untouched.
    await uploadResourceFiles("", [{ fileName: "template.md", data: Buffer.from("library template", "utf8") }]);
    const library = await facade.libraryList();
    assert.deepEqual(library.items, [{ path: "template.md", kind: "file", sizeBytes: 16 }]);
    assert.equal(library.truncated, false);
    const copyIn = await facade.libraryCopy({ item: "template.md", space: space.id });
    assert.equal(copyIn.copied, "From Library/template.md");
    assert.ok(copyIn.checkpointId);
    assert.equal(await readFile(join(space.spaceRoot, "From Library", "template.md"), "utf8"), "library template");
    await facade.historyRestore({ space: space.id, checkpointId: copyIn.checkpointId! });
    assert.equal(existsSync(join(space.spaceRoot, "From Library", "template.md")), false, "the destination restore point undoes the copy-in");
    assert.deepEqual((await facade.libraryList()).items.map((item) => item.path), ["template.md"]);
    await assert.rejects(() => facade.libraryCopy({ item: "missing.md", space: space.id }), /Library item not found/);
    await assert.rejects(
      () => facade.libraryCopy({ item: "   ", space: space.id }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "usage",
    );

    // library add copies external files into the passive personal collection
    // through the desktop upload internals: Space-free, no restore point,
    // folder sources walked file-by-file with the folder name preserved, and
    // name collisions resolved exactly like the upload route.
    const inbox = join(sandbox, "library-inbox");
    await mkdir(join(inbox, "nested"), { recursive: true });
    await writeFile(join(inbox, "cover.md"), "cover", "utf8");
    await writeFile(join(inbox, "nested", "detail.md"), "detail", "utf8");
    await writeFile(join(sandbox, "loose.md"), "loose", "utf8");
    const addedToLibrary = await facade.libraryAdd({
      fromPaths: [inbox, "loose.md"],
      cwd: sandbox,
    });
    assert.deepEqual(
      addedToLibrary.added.map((file) => file.path).sort(),
      ["library-inbox/cover.md", "library-inbox/nested/detail.md", "loose.md"],
    );
    assert.deepEqual(
      (await facade.libraryList()).items.map((item) => item.path).sort(),
      ["library-inbox", "library-inbox/cover.md", "library-inbox/nested", "library-inbox/nested/detail.md", "loose.md", "template.md"],
    );
    const collided = await facade.libraryAdd({ fromPaths: ["loose.md"], toDir: "", cwd: sandbox });
    assert.deepEqual(collided.added.map((file) => file.path), ["loose (2).md"], "collisions rename, never overwrite");
    await assert.rejects(
      () => facade.libraryAdd({ fromPaths: [join(sandbox, "not-there.md")], cwd: sandbox }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );
    if (process.platform !== "win32") {
      await symlink(join(sandbox, "loose.md"), join(inbox, "alias.md"));
      await assert.rejects(
        () => facade.libraryAdd({ fromPaths: [inbox], cwd: sandbox }),
        (error: unknown) => error instanceof WorkFoldCliError
          && error.code === "usage"
          && /Symbolic-link sources cannot be added to the Library/.test(error.message),
      );
      await rm(join(inbox, "alias.md"));
    }

    // New Library folders are top-level, name-validated, and collision-refused.
    const libraryFolder = await facade.libraryFolderCreate({ name: "Contracts" });
    assert.deepEqual(libraryFolder, { created: true, path: "Contracts" });
    await assert.rejects(() => facade.libraryFolderCreate({ name: "Contracts" }), /already exists/);
    await assert.rejects(() => facade.libraryFolderCreate({ name: "nested/inside" }), /not allowed/);
    await assert.rejects(
      () => facade.libraryFolderCreate({ name: "   " }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "usage",
    );

    // Mutation verbs refuse a named management parent that is not active.
    await assert.rejects(
      () => facade.filesMkdir({ space: space.id, path: "orphan", parentTaskId: "task-gone" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict",
    );
    assert.equal(existsSync(join(space.spaceRoot, "orphan")), false);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the act facade drives Space rename, appearance, tools, and App Studio families with ledger rules", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-act-studio-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 300)),
    });
  }\n`, "utf8");
  const restrictedApps = await RestrictedAppService.create({
    rootPath: join(sandbox, "restricted-apps"),
    deferAutomationStart: true,
  });
  const restrictedAppProposals = await RoutedRestrictedAppProposalHost.create({
    service: restrictedApps,
    registryPath: join(sandbox, "restricted-apps", "proposals.json"),
  });
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    restrictedAppService: restrictedApps,
    restrictedAppProposalHost: restrictedAppProposals,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const facade = api.actFacade;
    const { space } = await facade.createSpace({ name: "Fold One" });
    await facade.createSpace({ name: "Fold Two" });

    // Renaming refuses a case-insensitive duplicate — the CLI selector folds
    // names the same way, so a duplicate would make --space ambiguous — but a
    // Space may still change its own casing.
    await assert.rejects(
      () => facade.spacesRename({ space: space.id, name: "fold two" }),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "conflict"
        && /already named Fold Two/.test(error.message),
    );
    const renamed = await facade.spacesRename({ space: space.id, name: "Fold Prime" });
    assert.equal(renamed.priorName, "Fold One");
    assert.equal(renamed.space.name, "Fold Prime");
    const recased = await facade.spacesRename({ space: "Fold Prime", name: "FOLD PRIME" });
    assert.equal(recased.priorName, "Fold Prime");
    assert.equal(recased.space.name, "FOLD PRIME");

    // Appearance undo is refused with a typed error while no receipted
    // appearance act has recorded a prior customization for the Space.
    await assert.rejects(
      () => facade.spacesAppearanceUndo({ space: space.id }),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "conflict"
        && /No receipted appearance act/.test(error.message),
    );

    // Only the typed proposal file is accepted, and an explicit target for a
    // different Space is a refusal, not a silent restyle.
    const proposalPath = join(sandbox, "calm.work-fold-appearance.json");
    await writeFile(proposalPath, JSON.stringify({
      kind: "work-fold.space-appearance",
      version: 1,
      name: "Calm blue",
      customization: { color: "#3366aa" },
      createdBy: "human",
    }), "utf8");
    const mismatchPath = join(sandbox, "elsewhere.work-fold-appearance.json");
    await writeFile(mismatchPath, JSON.stringify({
      kind: "work-fold.space-appearance",
      version: 1,
      name: "Elsewhere",
      target: { spaceId: "space-elsewhere" },
      customization: { color: "#3366aa" },
    }), "utf8");
    await assert.rejects(
      () => facade.spacesAppearanceApply({ space: space.id, proposalPath: mismatchPath, cwd: sandbox }),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "conflict"
        && /targets a different Space \(space-elsewhere\)/.test(error.message),
    );
    const notProposalPath = join(sandbox, "not-a-proposal.json");
    await writeFile(notProposalPath, JSON.stringify({ hello: "world" }), "utf8");
    await assert.rejects(
      () => facade.spacesAppearanceApply({ space: space.id, proposalPath: notProposalPath, cwd: sandbox }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "usage",
    );
    await assert.rejects(
      () => facade.spacesAppearanceApply({ space: space.id, proposalPath: "missing.json", cwd: sandbox }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );

    const applied = await facade.spacesAppearanceApply({ space: space.id, proposalPath, cwd: sandbox });
    assert.equal(applied.proposalName, "Calm blue");
    assert.match(applied.appearanceRef ?? "", /^sha256:[0-9a-f]{16}$/);
    assert.equal(applied.priorAppearanceRef, null);

    // Undo is one act and its own inverse: default -> applied -> default.
    const undone = await facade.spacesAppearanceUndo({ space: space.id });
    assert.equal(undone.restoredAppearanceRef, null);
    assert.equal(undone.displacedAppearanceRef, applied.appearanceRef);
    const redone = await facade.spacesAppearanceUndo({ space: space.id });
    assert.equal(redone.restoredAppearanceRef, applied.appearanceRef);
    assert.equal(redone.displacedAppearanceRef, null);

    const reset = await facade.spacesAppearanceReset({ space: space.id });
    assert.equal(reset.changed, true);
    assert.equal(reset.priorAppearanceRef, applied.appearanceRef);
    const resetAgain = await facade.spacesAppearanceReset({ space: space.id });
    assert.equal(resetAgain.changed, false);
    assert.equal(resetAgain.priorAppearanceRef, null);

    // A desktop-side appearance change makes the recorded prior state stale,
    // so undo refuses instead of restoring a state its receipt never named.
    const desktopEdit = await fetch(`${api.origin}/api/spaces/${space.id}/appearance`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customization: { color: "#aa3366" } }),
    });
    assert.equal(desktopEdit.ok, true);
    await assert.rejects(
      () => facade.spacesAppearanceUndo({ space: space.id }),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "conflict"
        && /changed outside the act lane/.test(error.message),
    );

    // Tools removal reuses the desktop capability fencing unchanged: personal
    // scope is fenced against any running Assistant work, Space scope against
    // that Space's work.
    const conversation = await facade.createConversation({ space: space.id });
    const holding = await facade.sendMessage({
      space: space.id,
      conversationId: conversation.conversation.id,
      content: "/hold",
    });
    await assert.rejects(
      () => facade.toolsRemove({ scope: "personal", source: "./missing-tool-pkg" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict",
    );
    await assert.rejects(
      () => facade.toolsRemove({ scope: "space", space: space.id, source: "./missing-tool-pkg" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict",
    );
    await waitForAsync(async () =>
      (await facade.turnStatus({ space: space.id, taskId: holding.taskId })).task.state !== "running");
    const personalRemoval = await facade.toolsRemove({ scope: "personal", source: "./missing-tool-pkg" });
    assert.deepEqual(personalRemoval, { scope: "personal", source: "./missing-tool-pkg", removed: false });
    const spaceRemoval = await facade.toolsRemove({ scope: "space", space: space.id, source: "./missing-tool-pkg" });
    assert.equal(spaceRemoval.removed, false);
    assert.equal(spaceRemoval.space?.id, space.id);

    // Unregistering removes the registration while the folder and its
    // portable identity remain; re-registering restores the same Space id.
    const linkedRoot = join(sandbox, "linked-fold");
    await mkdir(linkedRoot, { recursive: true });
    await writeFile(join(linkedRoot, "keep.md"), "still here", "utf8");
    const linked = await facade.registerSpace({ spaceRoot: linkedRoot });
    const unregistered = await facade.spacesUnregister({ space: linked.space.id });
    assert.equal(unregistered.storage, "linked");
    assert.equal(unregistered.removed, true);
    assert.equal(await readFile(join(linkedRoot, "keep.md"), "utf8"), "still here");
    assert.equal(existsSync(join(linkedRoot, ".work-fold", "space.json")), true, "the portable identity persists");
    await assert.rejects(
      () => facade.listConversations({ space: linked.space.id }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );
    const reRegistered = await facade.registerSpace({ spaceRoot: linkedRoot });
    assert.equal(reRegistered.space.id, linked.space.id, "re-registration restores the persisted identity");

    // A managed Space unregisters the same way: the registration and
    // runtime authorization go, while the managed folder and its portable
    // identity provably survive — deleting the folder is `spaces delete`.
    const managedKeep = await facade.createSpace({ name: "Managed Keep" });
    await writeFile(join(managedKeep.space.spaceRoot, "keep.md"), "still managed", "utf8");
    const managedRemoval = await facade.spacesUnregister({ space: managedKeep.space.id });
    assert.equal(managedRemoval.storage, "managed");
    assert.equal(managedRemoval.removed, true);
    assert.equal(await readFile(join(managedKeep.space.spaceRoot, "keep.md"), "utf8"), "still managed");
    assert.equal(
      existsSync(join(managedKeep.space.spaceRoot, ".work-fold", "space.json")),
      true,
      "the managed folder keeps its portable identity",
    );
    await assert.rejects(
      () => facade.listConversations({ space: managedKeep.space.id }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );

    // App Studio's authority-neutral spine, through the exact desktop route
    // internals. The preview install stays the receipted act it is on
    // the desktop, so the test performs it directly on the service.
    const studio = (await facade.createSpace({ name: "Studio Space" })).space;
    const targetRoot = join(sandbox, "studio-target-fold");
    await mkdir(targetRoot, { recursive: true });
    const target = (await facade.registerSpace({ spaceRoot: targetRoot })).space;

    const presentationPath = join(sandbox, "presentation.json");
    await writeFile(presentationPath, JSON.stringify({
      title: "Connected Inbox Studio",
      description: "A deliberately declared local App Project.",
      icon: "mail",
    }), "utf8");
    const declared = await facade.appsProjectDeclare({ space: studio.id, presentationPath, cwd: sandbox });
    assert.equal(declared.project.presentation.title, "Connected Inbox Studio");
    assert.equal(declared.priorPresentation, null);
    assert.equal(declared.priorPresentationRef, null);
    const presentationPath2 = join(sandbox, "presentation-2.json");
    await writeFile(presentationPath2, JSON.stringify({ title: "Connected Inbox" }), "utf8");
    const redeclared = await facade.appsProjectDeclare({ space: studio.id, presentationPath: presentationPath2, cwd: sandbox });
    assert.equal(redeclared.project.presentation.title, "Connected Inbox");
    assert.equal(redeclared.project.presentation.description, null);
    assert.equal(redeclared.priorPresentation?.title, "Connected Inbox Studio");
    assert.match(redeclared.priorPresentationRef ?? "", /^sha256:[0-9a-f]{16}$/);
    await assert.rejects(
      () => facade.appsProjectDeclare({ space: studio.id, presentationPath: notProposalPath, cwd: sandbox }),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "usage"
        && /App title/.test(error.message),
    );

    const packageRoot = join(studio.spaceRoot, "apps", "connected-inbox");
    await writeStudioPackage(packageRoot, "release-one-reviewed-bytes");
    const reviewOne = await restrictedApps.inspect({ spaceId: studio.id, spaceRoot: studio.spaceRoot, sourcePath: "apps/connected-inbox" });
    await restrictedApps.install({
      spaceId: studio.id,
      spaceRoot: studio.spaceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: reviewOne.digest,
    });

    const prepared = await facade.appsReleasePrepare({ space: studio.id, version: "1.0.0" });
    assert.equal(prepared.release.state, "prepared");
    assert.equal(prepared.release.publishedAt, null);
    assert.equal(prepared.release.featureCount, 1);
    const versionOne = prepared.release.releaseDigest;

    // Preparation is not publication: an install prepared from an unpublished
    // Release is refused by the service guard, unchanged.
    await assert.rejects(
      () => facade.appsInstallPrepare({ space: studio.id, release: versionOne, targetSpace: target.id }),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "usage"
        && /published Release/i.test(error.message),
    );

    const published = await facade.appsReleasePublish({ space: studio.id, release: versionOne });
    assert.equal(published.release.state, "published");
    assert.ok(published.release.publishedAt);

    // The target Space resolves with the CLI's id-or-exact-name semantics
    // (a registered folder is named by its basename; the match folds case).
    const installPlan = await facade.appsInstallPrepare({ space: studio.id, release: versionOne, targetSpace: "STUDIO-TARGET-FOLD" });
    assert.equal(installPlan.operation.kind, "install");
    assert.equal(installPlan.targetSpace.id, target.id);
    assert.equal(installPlan.operation.targetSpaceId, target.id);

    const activatedInstall = await facade.appsOperationActivate({ space: studio.id, operation: installPlan.operation.operationId });
    assert.equal(activatedInstall.operationKind, "install");
    assert.equal(activatedInstall.instance.releaseDigest, versionOne);
    assert.equal(activatedInstall.instance.spaceId, target.id);

    // Unregistration runs the desktop's App Studio impact checks: a Space
    // holding a release-backed Instance is refused.
    await assert.rejects(
      () => facade.spacesUnregister({ space: target.id }),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "usage"
        && /Uninstall release-backed Apps/.test(error.message),
    );

    await writeStudioPackage(packageRoot, "release-two-reviewed-bytes");
    const reviewTwo = await restrictedApps.inspect({ spaceId: studio.id, spaceRoot: studio.spaceRoot, sourcePath: "apps/connected-inbox" });
    await restrictedApps.install({
      spaceId: studio.id,
      spaceRoot: studio.spaceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: reviewTwo.digest,
    });
    const preparedTwo = await facade.appsReleasePrepare({ space: studio.id, version: "1.1.0" });
    const versionTwo = preparedTwo.release.releaseDigest;
    assert.notEqual(versionTwo, versionOne);
    await facade.appsReleasePublish({ space: studio.id, release: versionTwo });

    const updatePlan = await facade.appsUpdatePrepare({
      space: studio.id,
      instance: activatedInstall.instance.runtimeInstanceId,
      release: versionTwo,
    });
    assert.equal(updatePlan.operation.kind, "update");
    assert.equal(updatePlan.operation.fromReleaseDigest, versionOne);
    assert.equal(updatePlan.operation.releaseDigest, versionTwo);
    assert.equal(updatePlan.targetSpace.id, target.id);

    // Cancelling a prepared operation is the prepare verbs' undo; a second
    // cancel finds nothing.
    const cancelled = await facade.appsOperationCancel({ space: studio.id, operation: updatePlan.operation.operationId });
    assert.equal(cancelled.cancelled, true);
    await assert.rejects(
      () => facade.appsOperationCancel({ space: studio.id, operation: updatePlan.operation.operationId }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );

    const updateAgain = await facade.appsUpdatePrepare({
      space: studio.id,
      instance: activatedInstall.instance.runtimeInstanceId,
      release: versionTwo,
    });
    const activatedUpdate = await facade.appsOperationActivate({ space: studio.id, operation: updateAgain.operation.operationId });
    assert.equal(activatedUpdate.operationKind, "update");
    assert.equal(activatedUpdate.instance.releaseDigest, versionTwo);

    // Uninstall is retain-only through the facade; retained namespaces are
    // named for the receipt and do not remain runnable.
    const uninstalled = await facade.appsUninstall({ space: target.id, instance: activatedUpdate.instance.runtimeInstanceId });
    assert.equal(uninstalled.removed, true);
    assert.equal(uninstalled.retainedNamespaceIds.length, 1);
    await assert.rejects(
      () => facade.appsUninstall({ space: target.id, instance: activatedUpdate.instance.runtimeInstanceId }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );

    // With no Instance left the target unregisters cleanly.
    const targetRemoval = await facade.spacesUnregister({ space: target.id });
    assert.equal(targetRemoval.storage, "linked");
    assert.equal(existsSync(targetRoot), true);

    // Release deletion honours the service guards: an unused Release deletes,
    // one still recorded by retained data is refused.
    const deletedOne = await facade.appsReleaseDelete({ space: studio.id, release: versionOne });
    assert.equal(deletedOne.deleted, true);
    await assert.rejects(
      () => facade.appsReleaseDelete({ space: studio.id, release: versionTwo }),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "usage"
        && /retained App data/.test(error.message),
    );

    // The Space-app authority direct verbs, over a reviewed development app
    // with declared permissions: narrowing works without a digest on argv
    // (the facade pins the resolved installed revision), and the honest
    // no-change answers stay honest.
    const authorityRoot = join(studio.spaceRoot, "apps", "authority-demo");
    await writeAuthorityPackage(authorityRoot);
    const authorityReview = await restrictedApps.inspect({
      spaceId: studio.id,
      spaceRoot: studio.spaceRoot,
      sourcePath: "apps/authority-demo",
    });
    await restrictedApps.install({
      spaceId: studio.id,
      spaceRoot: studio.spaceRoot,
      sourcePath: "apps/authority-demo",
      expectedDigest: authorityReview.digest,
    });
    await mkdir(join(studio.spaceRoot, "reports"), { recursive: true });
    await restrictedApps.grantFiles({
      spaceId: studio.id,
      spaceRoot: studio.spaceRoot,
      appId: "authority-demo",
      expectedDigest: authorityReview.digest,
      permissionId: "exports",
      root: "reports",
    });

    // Proposals are Chat-bound receipts that install the preview in the same
    // call (docs/receipts-not-gates.md, F21): list is scoped, an installed
    // receipt is not dismissable, and a mismatched Chat is not-found rather
    // than a leak.
    const proposalChat = (await facade.createConversation({ space: studio.id })).conversation;
    const proposed = await restrictedAppProposals.propose({
      spaceId: studio.id,
      spaceRoot: studio.spaceRoot,
      conversationId: proposalChat.id,
      sourcePath: "apps/authority-demo",
    });
    assert.equal(proposed.status, "installed");
    assert.equal(proposed.app?.digest, authorityReview.digest, "the already-installed revision is an idempotent install");
    const proposalList = await facade.appsProposalsList({ space: studio.id, conversationId: proposalChat.id });
    assert.equal(proposalList.proposals.length, 1);
    assert.equal(proposalList.proposals[0]?.id, proposed.proposal!.id);
    assert.equal(proposalList.proposals[0]?.status, "installed");
    assert.equal(proposalList.proposals[0]?.digest, authorityReview.digest);
    await assert.rejects(
      () => facade.appsProposalsList({ space: studio.id, conversationId: "chat-missing" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );
    await assert.rejects(
      () => facade.appsProposalsDismiss({ space: space.id, conversationId: proposalChat.id, proposal: proposed.proposal!.id }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
      "a proposal is bound to its own Space and Chat",
    );
    const dismissed = await facade.appsProposalsDismiss({
      space: studio.id,
      conversationId: proposalChat.id,
      proposal: proposed.proposal!.id,
    });
    assert.equal(dismissed.dismissed, false, "an installed receipt is the record of the install and reports no dismissal");
    const dismissedAgain = await facade.appsProposalsDismiss({
      space: studio.id,
      conversationId: proposalChat.id,
      proposal: proposed.proposal!.id,
    });
    assert.equal(dismissedAgain.dismissed, false, "a settled proposal reports no second dismissal");

    const authorityInstallation = (await restrictedApps.list(studio.id)).find((app) => app.manifest.id === "authority-demo")!;
    const revoked = await facade.appsRevoke({
      space: studio.id,
      app: authorityInstallation.featureInstallationId,
      digest: authorityReview.digest,
      kind: "files",
      declaration: "exports",
    });
    assert.equal(revoked.revoked, true);
    assert.deepEqual(
      (await restrictedApps.list(studio.id)).find((app) => app.manifest.id === "authority-demo")?.fileGrants,
      [],
      "revocation lands in the service registry",
    );
    // The destination was on since the install (docs/receipts-not-gates.md,
    // F21); revoking it narrows, and a second revoke is an honest no-op.
    const revokeNetwork = { space: studio.id, app: "authority-demo", digest: authorityReview.digest, kind: "network" as const, declaration: "mail-api" };
    assert.equal((await facade.appsRevoke(revokeNetwork)).revoked, true, "the install-time destination grant can be taken away");
    const revokeMiss = await facade.appsRevoke(revokeNetwork);
    assert.equal(revokeMiss.revoked, false, "an already-revoked declaration honestly reports no authority change");

    const disconnected = await facade.appsDisconnect({ space: studio.id, app: "authority-demo", destination: "mail-api" });
    assert.equal(disconnected.disconnected, false, "no connection store exists in this host, so nothing was removed");

    const disabledAutomation = await facade.appsAutomationDisable({
      space: studio.id,
      app: "authority-demo",
      automation: "export-digest",
    });
    assert.equal(disabledAutomation.disabled, true);
    assert.equal(disabledAutomation.wasEnabled, true, "automations are on when the app is added; disabling narrows");
    const disabledAgain = await facade.appsAutomationDisable({ space: studio.id, app: "authority-demo", automation: "export-digest" });
    assert.equal(disabledAgain.wasEnabled, false, "a second disable reports the no-change honestly");
    await assert.rejects(
      () => facade.appsAutomationRun({ space: studio.id, app: "authority-demo", automation: "export-digest" }),
      /desktop host/,
    );

    await assert.rejects(
      () => facade.appsRemove({ space: studio.id, app: "ghost-app" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );
    const removedApp = await facade.appsRemove({ space: studio.id, app: authorityInstallation.featureInstallationId });
    assert.equal(removedApp.removed, true);
    assert.equal(removedApp.digest, authorityReview.digest);
    assert.equal(
      (await restrictedApps.list(studio.id)).some((app) => app.manifest.id === "authority-demo"),
      false,
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the direct act path executes formerly gated verbs behind fences, receipts, and honest refusals", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-act-direct-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 500)),
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
    const doomed = await facade.createSpace({ name: "Doomed" });

    // `spaces delete` runs the shared removal orchestration on the first
    // call: the folder is gone, the registration is gone, the result is the
    // effect, and no decision identity exists anywhere
    // (docs/receipts-not-gates.md, F19).
    const deleted = await facade.spacesDelete({ space: doomed.space.id, requestId: "req-delete-1" });
    assert.equal(deleted.removed, true);
    assert.equal(deleted.storage, "managed");
    assert.equal("staged" in deleted, false);
    assert.equal("decisionId" in deleted, false);
    assert.equal(existsSync(doomed.space.spaceRoot), false, "the managed folder is deleted on the first call");
    await assert.rejects(
      () => facade.listConversations({ space: doomed.space.id }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );
    // No ghost kernel task survives an execution.
    assert.deepEqual((await api.kernel.getTasks({ kind: "system" })).tasks, []);

    // The fence refuses while Assistant work runs in the affected Space,
    // and a refused act changes nothing; a second attempt is a fresh call.
    const held = await facade.createSpace({ name: "Busy" });
    const heldChat = await facade.createConversation({ space: held.space.id });
    const heldTurn = await facade.sendMessage({
      space: held.space.id,
      conversationId: heldChat.conversation.id,
      content: "/hold",
    });
    await assert.rejects(
      () => facade.spacesDelete({ space: held.space.id, requestId: "req-delete-busy" }),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "conflict"
        && /Wait for affected/.test(error.message),
    );
    assert.equal(existsSync(held.space.spaceRoot), true, "a refused act changes nothing");
    await waitForAsync(async () =>
      (await facade.turnStatus({ space: held.space.id, taskId: heldTurn.taskId })).task.state !== "running");
    assert.deepEqual((await api.kernel.getTasks({ kind: "system" })).tasks, []);

    // A skill import runs at once at Personal scope and reports where the
    // bundle landed; the result is the effect, not a pending record.
    await writeFile(join(sandbox, "SKILL.md"), "---\nname: notes\n---\n# Notes\n", "utf8");
    const imported = await facade.toolsImportSkill({ scope: "personal", from: "SKILL.md", cwd: sandbox, requestId: "req-import-1" });
    assert.deepEqual(imported.skillNames, ["notes"]);
    assert.equal(imported.scope, "personal");
    assert.ok(imported.bundlePath, "the effect names the imported bundle");
    assert.equal(existsSync(imported.bundlePath), true);
    assert.equal("staged" in imported, false);

    // Needs you means questions: the glance carries no decision items.
    const glance = await facade.manageGlance();
    assert.equal(glance.kind, "work-fold.glance.experimental");
    assert.ok(glance.needsYou.every((item) => (item.kind as string) !== "pending-decision"));
    assert.ok(glance.changes.every((item) => (item.kind as string) !== "decision-recorded"));
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("space unregister blocks on live publications and suspends routing authority", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-act-unregister-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return {}; } },
  });
  try {
    const facade = api.actFacade;
    const root = join(sandbox, "shared-folder");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "report.md"), "# Weekly\n\nAll clear.\n", "utf8");
    const registered = await facade.registerSpace({ spaceRoot: root });

    const publication = await api.publications.activate(
      { spaceId: registered.space.id, relativePath: "report.md", title: "Weekly report" },
      { requestId: "req-pub-activate" },
    );
    assert.equal(publication.state, "active");

    const routingId = "routing-weekly-glue";
    const declaration = {
      kind: "work-fold.routing",
      version: 1,
      id: routingId,
      title: "Weekly glue",
      createdBy: "human",
      createdAt: "2026-08-01T00:00:00.000Z",
      trigger: { kind: "manual" },
      steps: [{ id: "review", kind: "chat", space: registered.space.id, message: "Review the report." }],
    };
    const enabled = await api.routings.enable({
      declaration,
      expectedDigest: workFoldRoutingDigest(normalizeWorkFoldRoutingDeclaration(declaration)),
      grant: { requestId: "request-routing-1", surface: "main-window" },
    });
    assert.equal(enabled.health, "enabled");

    // A live page served from the Space refuses removal by name.
    await assert.rejects(
      () => facade.spacesUnregister({ space: registered.space.id }),
      /Stop sharing the page served from this Space before removing it: "Weekly report"/,
    );
    assert.equal(enabled.health, "enabled");

    const revoked = await api.publications.revoke(publication.publicationId, { requestId: "req-pub-revoke" });
    assert.equal(revoked.state, "revoked");

    const removal = await facade.spacesUnregister({ space: registered.space.id });
    assert.equal(removal.removed, true);
    assert.equal(existsSync(root), true, "a linked registration removal leaves the folder");
    const suspended = await api.routings.getRouting(routingId);
    assert.equal(suspended?.health, "suspended");
    assert.deepEqual(suspended?.suspension?.missingSpaceIds, [registered.space.id]);

    // Re-registration is noted in copy only; the routing stays suspended.
    const reRegistered = await facade.registerSpace({ spaceRoot: root });
    assert.equal(reRegistered.space.id, registered.space.id, "portable identity survives re-registration");
    const noted = await api.routings.getRouting(routingId);
    assert.equal(noted?.health, "suspended", "registration never silently re-arms standing behavior");
    assert.deepEqual(noted?.suspension?.reRegisteredSpaceIds, [registered.space.id]);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("routing runs drive live chat hops with receipts, stop honestly, and refuse after shutdown", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-act-routing-run-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 4000)),
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
  let closed = false;
  try {
    const facade = api.actFacade;
    const space = await facade.createSpace({ name: "Glue target" });
    const handoffTarget = await facade.createSpace({ name: "Handoff target" });
    const bystander = await facade.createSpace({ name: "Bystander" });
    await writeFile(join(space.space.spaceRoot, "notes.md"), "handoff", "utf8");
    const routingId = "routing-hold-review";
    const declaration = {
      kind: "work-fold.routing",
      version: 1,
      id: routingId,
      title: "Hold review",
      createdBy: "human",
      createdAt: "2026-08-01T00:00:00.000Z",
      trigger: { kind: "manual" },
      steps: [
        { id: "review", kind: "chat", space: space.space.id, message: "/hold" },
        {
          id: "handoff",
          kind: "files",
          fromSpace: space.space.id,
          from: { kind: "paths", paths: ["notes.md"] },
          toSpace: handoffTarget.space.id,
          to: "Inbox",
        },
      ],
    };
    await api.routings.enable({
      declaration,
      expectedDigest: workFoldRoutingDigest(normalizeWorkFoldRoutingDeclaration(declaration)),
      grant: { requestId: "request-routing-run", surface: "main-window" },
    });

    const run = api.routings.runNow(routingId, { requestId: "req-run-now" });
    // The hop dispatches a real turn into a fresh Chat in the target Space.
    await waitForAsync(async () => {
      const conversations = await facade.listConversations({ space: space.space.id });
      if (!conversations.conversations.length) return false;
      const status = await facade.conversationStatus({
        space: space.space.id,
        conversationId: conversations.conversations[0]!.id,
      });
      return status.state === "running";
    }, 60_000);

    // The ledger's History-restore fence (conflict rule 7): while this run is
    // active, a whole-Space restore of the files hop's target Space refuses
    // through the kernel-checked rule — and a Space the run never writes into
    // restores past the fence (here to its own honest not-found).
    await assert.rejects(
      () => facade.historyRestore({ space: handoffTarget.space.id, checkpointId: "cp-00000000000000-missing" }),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "conflict"
        && /routing run .*routing-hold-review/.test(error.message)
        && /files hop into this Space/.test(error.message),
    );
    await assert.rejects(
      () => facade.historyRestore({ space: bystander.space.id, checkpointId: "cp-00000000000000-missing" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );
    const stopped = api.routings.stopRun(routingId);
    assert.ok(stopped?.runId, "an active run is stoppable by routing id");
    const result = await run;
    assert.equal(result.outcome, "failure", "a stopped run never reads as success in the scheduler history");

    const receiptsText = await readFile(join(sandbox, "state", "routings", "receipts.jsonl"), "utf8");
    const receipts = receiptsText.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const runReceipts = receipts.filter((entry) => entry.runId === stopped!.runId && entry.scope === "run");
    assert.deepEqual(
      runReceipts.map((entry) => entry.outcome),
      ["accepted", "stopped"],
      "the run journals acceptance before hop 1 and settles stopped",
    );
    const hopReceipts = receipts.filter((entry) => entry.runId === stopped!.runId && entry.scope === "hop");
    assert.equal(hopReceipts[0]?.outcome, "accepted");
    const stoppedChatHop = hopReceipts.find((entry) => entry.hopId === "review" && entry.outcome === "stopped");
    assert.ok(stoppedChatHop?.taskId, "the stopped chat hop names the aborted turn task");
    assert.equal(
      hopReceipts.find((entry) => entry.hopId === "handoff")?.outcome,
      "skipped",
      "the files hop after the stop is recorded skipped, never silently dropped",
    );
    assert.deepEqual((await api.kernel.getTasks({ kind: "system" })).tasks, [], "no ghost tasks survive a stopped run");
    await assert.rejects(
      () => facade.historyRestore({ space: handoffTarget.space.id, checkpointId: "cp-00000000000000-missing" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
      "a settled run releases the restore fence",
    );

    // The glance renders the settled run from the receipts journal.
    const glance = await facade.manageGlance();
    assert.ok(
      glance.changes.some((item) => item.kind === "routing-run-settled" && item.ref?.runId === stopped!.runId),
      "a settled routing run is a change item",
    );

    closed = true;
    await api.close();
    await assert.rejects(
      () => api.routings.runNow(routingId),
      (error: unknown) => (error as { code?: string }).code === "SERVICE_DAMAGED"
        && /closed/.test((error as Error).message),
      "the executor refuses new runs after shutdown",
    );
  } finally {
    if (!closed) await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("routing enablement and page exposure execute on one call with one request identity", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-act-enable-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return {}; } },
  });
  try {
    const facade = api.actFacade;
    const space = await facade.createSpace({ name: "Glue Space" });
    await writeFile(join(space.space.spaceRoot, "weekly.md"), "# Weekly\n", "utf8");

    const tooSoonPath = join(sandbox, "too-soon.work-fold-routing.json");
    await writeFile(tooSoonPath, JSON.stringify({
      kind: "work-fold.routing-proposal",
      version: 2,
      name: "Too soon",
      createdBy: "assistant",
      createdAt: new Date().toISOString(),
      routing: {
        title: "Too soon",
        trigger: { kind: "at", at: new Date(Date.now() + 30_000).toISOString(), ifMissed: "run" },
        steps: [{ id: "review", kind: "chat", space: space.space.id, message: "Review the report." }],
      },
    }, null, 2), "utf8");
    await assert.rejects(
      () => facade.routingsEnable({ proposalPath: tooSoonPath, cwd: sandbox, requestId: "req-routing-too-soon" }),
      /between 1 minute and 366 days/,
      "an unusable one-time routing is refused before anything is enabled",
    );

    // Routing enablement: `routings enable` normalizes the inert typed
    // proposal and executes the routing service's enablement at once, with
    // the act's request id as the grant identity (docs/receipts-not-gates.md,
    // F23). No holding area is ever written.
    const proposalPath = join(sandbox, "weekly.work-fold-routing.json");
    const oneTimeAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await writeFile(proposalPath, JSON.stringify({
      kind: "work-fold.routing-proposal",
      version: 2,
      name: "Weekly glue",
      createdBy: "assistant",
      createdAt: "2026-08-01T00:00:00.000Z",
      routing: {
        title: "Weekly glue",
        trigger: { kind: "at", at: oneTimeAt, ifMissed: "run" },
        steps: [{ id: "review", kind: "chat", space: space.space.id, message: "Review the report." }],
      },
    }, null, 2), "utf8");
    const enabled = await facade.routingsEnable({ proposalPath, cwd: sandbox, requestId: "req-routing-enable" });
    assert.equal(enabled.health, "enabled");
    assert.equal(enabled.title, "Weekly glue");
    assert.deepEqual(enabled.referencedSpaceIds, [space.space.id]);
    assert.match(enabled.routingId, /^routing-[a-f0-9]{16}$/, "a proposal gains a deterministic content-derived id");
    assert.equal("staged" in enabled, false);
    assert.equal(existsSync(join(sandbox, "state", "fold", "staged-routings")), false, "no holding area is ever written");
    const routing = await api.routings.getRouting(enabled.routingId);
    assert.equal(routing?.health, "enabled");
    assert.equal(routing?.digest, enabled.declarationDigest);
    assert.deepEqual(routing?.declaration.trigger, { kind: "at", at: oneTimeAt, ifMissed: "run" });
    assert.equal(routing?.grants.at(-1)?.requestId, "req-routing-enable", "the enablement receipt carries the act's request id");
    assert.equal(routing?.grants.at(-1)?.surface, "cli");
    assert.equal(enabled.alreadyEnabled, false);
    assert.equal(enabled.stoppedRunId, null);

    // Enabling the identical declaration again is a no-op: the same routing,
    // no fresh receipt, and nothing in flight disturbed.
    const twice = await facade.routingsEnable({ proposalPath, cwd: sandbox, requestId: "req-routing-enable-again" });
    assert.equal(twice.alreadyEnabled, true);
    assert.equal(twice.routingId, enabled.routingId);
    assert.equal((await api.routings.getRouting(enabled.routingId))?.grants.length, 1);

    // A proposal naming a Space this machine does not have never arms.
    const strangerPath = join(sandbox, "stranger.work-fold-routing.json");
    await writeFile(strangerPath, JSON.stringify({
      kind: "work-fold.routing-proposal",
      version: 2,
      name: "Stranger",
      createdBy: "assistant",
      createdAt: "2026-08-01T00:00:00.000Z",
      routing: {
        title: "Stranger",
        trigger: { kind: "manual" },
        steps: [{ id: "review", kind: "chat", space: "space-0123456789abcdef", message: "Review the report." }],
      },
    }, null, 2), "utf8");
    await assert.rejects(
      () => facade.routingsEnable({ proposalPath: strangerPath, cwd: sandbox, requestId: "req-routing-stranger" }),
      /not registered on this machine/,
    );

    // An unknown placeholder is a declaration error, refused when enabling.
    const unknownPlaceholderPath = join(sandbox, "unknown-placeholder.work-fold-routing.json");
    await writeFile(unknownPlaceholderPath, JSON.stringify({
      kind: "work-fold.routing-proposal",
      version: 4,
      name: "Unknown placeholder",
      createdBy: "assistant",
      createdAt: "2026-08-01T00:00:00.000Z",
      routing: {
        title: "Unknown placeholder",
        trigger: { kind: "manual" },
        steps: [{ id: "review", kind: "chat", space: space.space.id, message: "Review {{nope}}." }],
      },
    }, null, 2), "utf8");
    await assert.rejects(
      () => facade.routingsEnable({ proposalPath: unknownPlaceholderPath, cwd: sandbox, requestId: "req-routing-unknown" }),
      /unknown placeholder \{\{nope\}\}/,
    );
    assert.equal((await api.routings.listRoutings()).length, 1, "a refused declaration arms nothing");

    // Page exposure: `pages stage` pins the publication shape per the
    // publishing mutation ledger and activates through the publication
    // service on the same call, under a derived request id.
    const shared = await facade.pagesStage({
      space: space.space.id,
      path: "weekly.md",
      title: "Weekly report",
      requestId: "req-page-share",
    });
    assert.equal(shared.publication.state, "active");
    assert.equal(shared.publication.relativePath, "weekly.md");
    assert.equal(shared.publication.title, "Weekly report");
    assert.equal(shared.publication.serveRatePerMinute, 60);
    assert.equal(shared.publication.snapshotEnabled, false);
    assert.equal("staged" in shared, false);
    const publications = await api.publications.list();
    assert.equal(publications.length, 1);
    assert.equal(publications[0]?.state, "active");

    const receiptsText = await readFile(join(sandbox, "state", "cli", "receipts", "act.jsonl"), "utf8");
    const receipts = receiptsText.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const activation = receipts.filter((entry) => entry.command === "pages activate");
    assert.deepEqual(activation.map((entry) => entry.outcome), ["accepted", "ok"]);
    assert.equal(activation[0]?.requestId, "req-page-share:activate", "activation journals under the act's derived request id");
    assert.equal(activation[0]?.surface, "cli");
    assert.equal(activation[0]?.decisionId, undefined);
    assert.equal(receipts.some((entry) => String(entry.requestId).startsWith("fold-decision:")), false);

    // A second identical call refuses: the page is already shared.
    await assert.rejects(
      () => facade.pagesStage({ space: space.space.id, path: "weekly.md", title: "Weekly report", requestId: "req-page-share-2" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict" && /already shared/.test(error.message),
    );
    // A missing source refuses honestly and exposes nothing.
    await assert.rejects(
      () => facade.pagesStage({ space: space.space.id, path: "missing.md", title: "Missing", requestId: "req-page-missing" }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );
    assert.equal((await api.publications.list()).length, 1);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the act facade lists what an installed app can do and runs one of its declared tools", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-act-apps-test-"));
  const invocations: Array<{ digest: string; action: string; input: unknown }> = [];
  const runtimeHost = {
    async invoke(app: { digest: string }, action: string, input: unknown) {
      invocations.push({ digest: app.digest, action, input: structuredClone(input) });
      return { count: 3 };
    },
    async runAutomation() { /* unused */ },
    async stop() { /* unused */ },
    async close() { /* unused */ },
  };
  const restrictedApps = await RestrictedAppService.create({
    rootPath: join(sandbox, "restricted-apps"),
    deferAutomationStart: true,
    runtimeHost: runtimeHost as never,
  });
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    restrictedAppService: restrictedApps,
  });
  try {
    const facade = api.actFacade;
    const { space } = await facade.createSpace({ name: "Apps Fold" });
    const empty = await facade.appsList({ space: space.id });
    assert.deepEqual(empty.apps, []);
    assert.equal(empty.truncated, false);

    const packageRoot = join(space.spaceRoot, "apps", "connected-inbox");
    await writeStudioPackage(packageRoot, "inbox-bytes");
    const review = await restrictedApps.inspect({ spaceId: space.id, spaceRoot: space.spaceRoot, sourcePath: "apps/connected-inbox" });
    const installed = await restrictedApps.install({
      spaceId: space.id,
      spaceRoot: space.spaceRoot,
      sourcePath: "apps/connected-inbox",
      expectedDigest: review.digest,
    });

    // The listing carries everything a caller needs to build an invocation
    // without opening the package.
    const listed = await facade.appsList({ space: "Apps Fold" });
    assert.equal(listed.apps.length, 1);
    const app = listed.apps[0]!;
    assert.equal(app.appId, "connected-inbox");
    assert.equal(app.kind, "preview");
    assert.equal(app.digest, installed.digest);
    assert.equal(app.description, "Search a deliberately restricted inbox.");
    assert.deepEqual(app.tools.map((tool) => tool.name), ["inbox_search"]);
    assert.equal((app.tools[0]!.inputSchema as { type: string }).type, "object");
    assert.deepEqual(app.connections, []);
    assert.deepEqual(app.automations, []);
    assert.deepEqual(app.assistantActions, []);

    const invoked = await facade.appsInvoke({ space: space.id, app: "connected-inbox", tool: "inbox_search", input: { query: "north" } });
    assert.deepEqual(invoked.result, { count: 3 });
    assert.equal(invoked.action, "search");
    assert.equal(invoked.digest, installed.digest);
    assert.equal(invoked.featureInstallationId, installed.featureInstallationId);
    // The revision resolved by the lookup is the revision that ran.
    assert.deepEqual(invocations, [{ digest: installed.digest, action: "search", input: { query: "north" } }]);

    await assert.rejects(
      () => facade.appsInvoke({ space: space.id, app: "connected-inbox", tool: "not_a_tool", input: {} }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound" && /has no tool named not_a_tool/.test(error.message),
    );
    // Input is handed to the app's own runtime unchanged; that runtime holds
    // the schema check, exactly as it does for a Chat tool call.
    await assert.rejects(
      () => facade.appsInvoke({ space: space.id, app: "missing-app", tool: "inbox_search", input: {} }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );
    assert.equal(invocations.length, 1, "a refused invocation never reaches the app");
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

test("hosted-app exposure activates from an installed Instance and puts the app at your address", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-act-rung3-test-"));
  const storage = new FileRestrictedAppStorage(join(sandbox, "restricted-apps", "data"));
  const restrictedApps = await RestrictedAppService.create({
    rootPath: join(sandbox, "restricted-apps"),
    deferAutomationStart: true,
    storage,
  });
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    restrictedAppService: restrictedApps,
    piRuntimeProvider: { async resolveRuntime() { return {}; } },
  });
  try {
    const facade = api.actFacade;
    const studio = (await facade.createSpace({ name: "Viewer Studio" })).space;
    const targetRoot = join(sandbox, "viewer-target-fold");
    await mkdir(targetRoot, { recursive: true });
    const target = (await facade.registerSpace({ spaceRoot: targetRoot })).space;

    const packageRoot = join(studio.spaceRoot, "apps", "viewer-inbox");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "viewer-inbox",
      version: "0.1.0",
      private: true,
      type: "module",
      agentApp: "agent-app.json",
    }), "utf8");
    await writeFile(join(packageRoot, "agent-app.json"), JSON.stringify({
      version: 2,
      id: "viewer-inbox",
      title: "Viewer inbox",
      runtime: { kind: "sandboxed-web", entry: "index.html" },
      ui: {},
      tools: [],
      permissions: { network: [], files: [], notifications: [] },
      automations: [],
      viewer: { entry: "viewer.html", readable: ["public/"] },
    }), "utf8");
    await writeFile(join(packageRoot, "index.html"), "<!doctype html><main>desktop</main>", "utf8");
    await writeFile(join(packageRoot, "viewer.html"), "<!doctype html><main>audience</main>", "utf8");
    const review = await restrictedApps.inspect({ spaceId: studio.id, spaceRoot: studio.spaceRoot, sourcePath: "apps/viewer-inbox" });
    await restrictedApps.install({
      spaceId: studio.id,
      spaceRoot: studio.spaceRoot,
      sourcePath: "apps/viewer-inbox",
      expectedDigest: review.digest,
    });

    // A development preview is never exposable: exposure requires an
    // installed App Instance of a prepared Release.
    const development = (await restrictedApps.list(studio.id)).find((app) => app.runtimeInstanceKind === "development");
    await assert.rejects(
      () => facade.pagesStageApp({ space: studio.id, instance: development!.featureInstallationId, requestId: "req-rung3-dev" }),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "conflict"
        && /prepared Release/.test(error.message),
    );

    const prepared = await facade.appsReleasePrepare({ space: studio.id, version: "1.0.0" });
    await facade.appsReleasePublish({ space: studio.id, release: prepared.release.releaseDigest });
    const installPlan = await facade.appsInstallPrepare({
      space: studio.id,
      release: prepared.release.releaseDigest,
      targetSpace: target.id,
    });
    const activated = await facade.appsOperationActivate({ space: studio.id, operation: installPlan.operation.operationId });
    const installed = (await restrictedApps.list(target.id)).find((app) => app.runtimeInstanceKind === "app");
    assert.ok(installed);

    // The verb accepts the Runtime Instance id like the other apps verbs,
    // pins the App Instance identity plus the complete viewer surface, and
    // activates the exposure on the first call.
    const shared = await facade.pagesStageApp({
      space: target.id,
      instance: activated.instance.runtimeInstanceId,
      requestId: "req-rung3-share",
    });
    assert.equal(shared.publication.kind, "app");
    assert.equal(shared.publication.state, "active");
    assert.equal(shared.publication.appInstanceId, installed.featureInstallationId);
    assert.equal(shared.publication.releaseDigest, prepared.release.releaseDigest);
    assert.equal(shared.publication.viewerEntry, "viewer.html");
    assert.deepEqual(shared.publication.viewerSurface, ["entry:viewer.html", "data:public/"]);
    assert.equal("staged" in shared, false);
    const publications = await api.publications.list();
    assert.equal(publications.length, 1);
    const exposure = publications[0]!;
    assert.equal(exposure.kind, "app");
    assert.equal(exposure.title, "Viewer inbox");
    assert.equal(exposure.spaceId, target.id);
    assert.equal(exposure.viewerPath, `/a/${exposure.publicationId}`);
    assert.equal(exposure.snapshotEnabled, false, "apps have no snapshot lane");
    assert.deepEqual(exposure.app, {
      appInstanceId: installed.featureInstallationId,
      releaseDigest: prepared.release.releaseDigest,
      viewerEntry: "viewer.html",
      viewerSurface: ["entry:viewer.html", "data:public/"],
    });

    // The activation receipts carry the act's derived request identity,
    // exactly as page activation does.
    const receiptsText = await readFile(join(sandbox, "state", "cli", "receipts", "act.jsonl"), "utf8");
    const receipts = receiptsText.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const activation = receipts.filter((entry) => entry.command === "pages activate-app");
    assert.deepEqual(activation.map((entry) => entry.outcome), ["accepted", "ok"]);
    assert.equal(activation[0]?.requestId, "req-rung3-share:activate");
    assert.equal(activation[0]?.surface, "cli");
    assert.equal(activation[0]?.decisionId, undefined);

    // The live serve path enforces the viewer-safe subset over the real
    // installed instance: reviewed entry bytes serve; instance-owned
    // viewer-readable data serves; everything else refuses typed.
    await storage.set({
      ownerClass: "instance",
      tenantId: installed.tenantId,
      runtimeInstanceId: installed.runtimeInstanceId,
      featureInstallationId: installed.featureInstallationId,
      dataNamespaceId: installed.dataNamespaceId,
    }, "public/greeting", "hello audience");
    const servedEntry = await api.publications.serveViewerAppCall(exposure.publicationId, { kind: "entry" });
    assert.equal(servedEntry.state, "served");
    const servedData = await api.publications.serveViewerAppCall(exposure.publicationId, { kind: "data.get", key: "public/greeting" });
    assert.equal(servedData.state, "served");
    const deniedWrite = await api.publications.serveViewerAppCall(exposure.publicationId, { kind: "data.set", key: "public/greeting", value: "x" });
    assert.equal(deniedWrite.state, "served", "a write attempt is a typed viewer-visible denial, not a page state");

    // One App Instance holds one active exposure; sharing again while live is
    // refused before anything activates.
    // Revocation is the direct undo; the Instance keeps running locally and
    // sharing again mints a fresh publication.
    const revoked = await facade.pagesRevoke({ publication: exposure.publicationId, requestId: "req-rung3-revoke" });
    assert.equal(revoked.publication.state, "revoked");
    assert.deepEqual(await api.publications.serveViewerAppCall(exposure.publicationId, { kind: "entry" }), {
      state: "nothing-here",
      publicationId: exposure.publicationId,
    });
    assert.ok((await restrictedApps.list(target.id)).some((app) => app.runtimeInstanceKind === "app"),
      "revoking exposure never uninstalls the Instance");
    const reshared = await facade.pagesStageApp({
      space: target.id,
      instance: activated.instance.runtimeInstanceId,
      requestId: "req-rung3-reshare",
    });
    assert.equal(reshared.publication.state, "active");
    assert.notEqual(reshared.publication.publicationId, exposure.publicationId, "sharing again mints a fresh publication");
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function writeStudioPackage(root: string, marker: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "connected-inbox",
    version: "0.1.0",
    private: true,
    type: "module",
    agentApp: "agent-app.json",
  }), "utf8");
  await writeFile(join(root, "agent-app.json"), JSON.stringify({
    version: 2,
    id: "connected-inbox",
    title: "Connected inbox",
    description: "Search a deliberately restricted inbox.",
    runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
    ui: { icon: "mail" },
    tools: [{
      name: "inbox_search",
      description: "Search the connected inbox.",
      action: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", maxLength: 500 } },
        required: ["query"],
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 0 } },
        required: ["count"],
        additionalProperties: false,
      },
    }],
    automations: [],
    permissions: { network: [], files: [], notifications: [] },
  }), "utf8");
  await writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8");
  await writeFile(join(root, "app.js"), "export {};\n", "utf8");
  await writeFile(join(root, "worker.js"), `// ${marker}\nexport async function handleAction() { return { count: 0 }; }\n`, "utf8");
}

async function writeAuthorityPackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "authority-demo",
    version: "0.1.0",
    private: true,
    type: "module",
    agentApp: "agent-app.json",
  }), "utf8");
  await writeFile(join(root, "agent-app.json"), JSON.stringify({
    version: 2,
    id: "authority-demo",
    title: "Authority demo",
    description: "Declares narrow authority for revocation tests.",
    runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
    ui: { icon: "shield" },
    tools: [],
    automations: [{
      id: "export-digest",
      title: "Export digest",
      description: "Write a digest into the granted reports folder.",
      handler: "export-digest",
      trigger: { kind: "interval", intervalMinutes: 60 },
      permissions: { network: [], files: ["exports"], notifications: [] },
      catchUp: "none",
      overlap: "skip",
    }],
    permissions: {
      network: [{
        id: "mail-api",
        target: { kind: "public-https", origin: "https://mail.example.com" },
        methods: ["GET"],
        auth: [{ kind: "api-key", header: "x-api-key" }],
      }],
      files: [{ id: "exports", target: "directory", access: "read-write" }],
      notifications: [],
    },
  }), "utf8");
  await writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8");
  await writeFile(join(root, "app.js"), "export {};\n", "utf8");
  await writeFile(
    join(root, "worker.js"),
    "// Inert during review and installation.\nexport async function handleAction() { return {}; }\nexport async function handleAutomation() {}\n",
    "utf8",
  );
}
