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
import { WorkspaceCliError } from "../src/local/cli/index.js";
import { startLocalApi } from "../src/local/server.js";
import { workspaceManagementRoot, workspaceManagementScopeId } from "../src/local/state-paths.js";

test("the management conversation runs above all Spaces on the shared turn machinery", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-management-test-"));
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
    workspaceBase: join(sandbox, "content"),
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
    // manage-workspaces Skill is a project-scope skill of the management
    // root — not of the person's personal scope.
    const managementRoot = workspaceManagementRoot();
    assert.equal(existsSync(join(managementRoot, "AGENTS.md")), true);
    assert.equal(existsSync(join(managementRoot, ".pi", "skills", "manage-workspaces", "SKILL.md")), true);
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
    const managementSkill = catalog.skills.find((skill) => skill.name === "manage-workspaces");
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
      (error: unknown) => error instanceof WorkspaceCliError && error.code === "notFound",
    );

    // The first send creates the default management conversation and runs a
    // real turn through the personal-scope /hold extension — proving the
    // management client loads personal Pi capabilities without any Space.
    const send = await facade.manageSend({ content: "/hold" });
    assert.ok(send.conversationId);
    assert.ok(send.taskId);
    const running = await api.kernel.getTasks({ kind: "system" });
    const managementTask = running.tasks.find((task) => task.id === send.taskId);
    assert.equal(managementTask?.workspaceId, workspaceManagementScopeId, "management turns must be tracked under the management scope id");
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
    const transcripts = await readdir(join(managementRoot, ".workspace", "conversations"));
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
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-management-fail-closed-test-"));
  const stateBase = join(sandbox, "state");
  await mkdir(stateBase, { recursive: true });
  // Occupy the management root with a regular file. The rest of Workspace
  // must still start, but this full-trust scope must not run uninstructed.
  await writeFile(join(stateBase, "management"), "not a directory", "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase,
    workspaceBase: join(sandbox, "content"),
    loadEnv: false,
  });
  try {
    await assert.rejects(
      () => api.actFacade.manageList(),
      (error: unknown) => error instanceof WorkspaceCliError
        && error.code === "unavailable"
        && /required instructions/.test(error.message),
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
