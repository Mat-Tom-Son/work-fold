import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildTurnContextMessage, type PiSpaceTurnContext } from "../src/local/agent/pi-client.js";
import { appendAssistantInstructions } from "../src/local/agent/pi-runtime-config.js";
import {
  appendSpaceOperationsGuide,
  spaceOperationsGuideForScope,
  workFoldSpaceOperationsGuide,
  workFoldSpaceOperationsGuideHeading,
  workFoldSpaceOperationsGuideMaxBytes,
} from "../src/local/agent/space-operations-guide.js";
import { buildSpaceTurnContext, spaceTurnParentHandle } from "../src/local/agent/space-turn-context.js";
import { startLocalApi } from "../src/local/server.js";
import { workFoldManagementScopeId } from "../src/local/state-paths.js";

/**
 * Space turns get their own context (docs/collaboration-contract.md, F26):
 * this Space's id, this turn's task id, its request id, and — when another
 * request delegated the work — an opaque handle plus the assignment. Never
 * another Space, the registry, the fold's conversation, or the parent's real
 * task id.
 */

const bannedWords = /\bstaged\b|\bapprove[sd]?\b|\bapproval\b|\bpolic(y|ies)\b|\bcard\b|\bmode\b|\bsandboxed\b|\bdigest\b/i;
const bannedNames = /\bReviewed\b|\bUnrestricted\b/;

test("a Space turn's identity block names exactly its own ids and the stay-inside rule", () => {
  const context = buildTurnContextMessage({
    spaceTurn: buildSpaceTurnContext({ spaceId: "space-1", taskId: "task-1", requestId: "req-1", handleSalt: "salt" }),
  });
  assert.match(context, /This turn's work-fold identity/);
  assert.match(context, /"spaceId": "space-1"/);
  assert.match(context, /"taskId": "task-1"/);
  assert.match(context, /"requestId": "req-1"/);
  assert.match(context, /A task id is accepted only while that exact turn is yours and running/);
  assert.match(context, /Work only in this Space/);
  assert.doesNotMatch(context, /"spaces":/, "no registry array");
  assert.doesNotMatch(context, /delegated this work/, "an undelegated turn has no parent block");
  assert.doesNotMatch(context, bannedWords);
  assert.doesNotMatch(context, bannedNames);
});

test("a delegated turn sees an opaque handle and its assignment, never the parent's task id", () => {
  const delegated = buildSpaceTurnContext({
    spaceId: "space-1",
    taskId: "task-1",
    requestId: "req-1",
    parentTaskId: "task-parent",
    handleSalt: "salt",
  });
  assert.match(delegated.delegated!.parentHandle, /^parent-[0-9a-f]{16}$/);
  assert.equal(delegated.delegated!.assignmentIsThisMessage, true, "the assignment defaults to this turn's own message");
  const rendered = buildTurnContextMessage({ spaceTurn: delegated });
  assert.doesNotMatch(rendered, /task-parent/);
  assert.match(rendered, /Refer to it as parent-[0-9a-f]{16}; that handle is all you get, and no command takes it/);
  assert.match(rendered, /Your assignment is the message in this turn/);
  assert.match(rendered, /chat ask --to parent/);

  const explicit = buildSpaceTurnContext({
    spaceId: "space-1",
    taskId: "task-1",
    requestId: "req-1",
    parentTaskId: "task-parent",
    assignment: "Adopt the brief and list its gaps.",
    handleSalt: "salt",
  });
  assert.equal(explicit.delegated!.assignment, "Adopt the brief and list its gaps.");
  assert.equal(explicit.delegated!.assignmentIsThisMessage, undefined);
  assert.match(buildTurnContextMessage({ spaceTurn: explicit }), /Your assignment from that request:\nAdopt the brief and list its gaps\./);

  const long = buildSpaceTurnContext({
    spaceId: "space-1",
    taskId: "task-1",
    requestId: "req-1",
    parentTaskId: "task-parent",
    assignment: "x".repeat(20 * 1024),
    handleSalt: "salt",
  });
  assert.equal(Buffer.byteLength(long.delegated!.assignment!, "utf8"), 16 * 1024, "the assignment is cut at the chat-message bound");
  assert.equal(long.delegated!.assignmentTruncated, true);
  assert.match(buildTurnContextMessage({ spaceTurn: long }), /\[The assignment was cut at 16 KB\.\]/);
});

test("parent handles are stable per salt, differ across salts, and refuse an empty salt", () => {
  assert.equal(spaceTurnParentHandle("task-parent", "salt-a"), spaceTurnParentHandle("task-parent", "salt-a"));
  assert.notEqual(spaceTurnParentHandle("task-parent", "salt-a"), spaceTurnParentHandle("task-parent", "salt-b"));
  assert.notEqual(spaceTurnParentHandle("task-parent", "salt-a"), spaceTurnParentHandle("task-other", "salt-a"));
  assert.throws(() => spaceTurnParentHandle("task-parent", "   "), /non-empty salt/);
  assert.throws(() => buildSpaceTurnContext({ spaceId: " ", taskId: "task-1", requestId: "req-1", handleSalt: "salt" }), /Space id/);
  // The builder emits no registry field under any input.
  const keys = Object.keys(buildSpaceTurnContext({ spaceId: "space-1", taskId: "task-1", requestId: "req-1", parentTaskId: "p", handleSalt: "s" }));
  assert.deepEqual(keys.sort(), ["delegated", "requestId", "spaceId", "taskId"]);
});

test("the operations guide names the verbs and the rules, stays bounded, and follows Space instructions", () => {
  const guide = workFoldSpaceOperationsGuide();
  assert.ok(guide.startsWith(workFoldSpaceOperationsGuideHeading));
  for (const verb of [
    "chat report", "chat ask", "chat answer", "chat handoff", "chat wait",
    "files delete", "history list|save|restore", "search", "library copy", "checks status", "apps list", "apps invoke", "help collaborate",
  ]) {
    assert.ok(guide.includes(verb), `the guide names ${verb}`);
  }
  assert.match(guide, /accepts a task id only while that exact turn is your own and running/);
  assert.match(guide, /not yours to read.*hand it off, or ask/s);
  assert.match(guide, /Never write cross-Space context into this Chat/);
  assert.ok(Buffer.byteLength(guide, "utf8") < workFoldSpaceOperationsGuideMaxBytes, "the guide stays under its budget");
  assert.doesNotMatch(guide, bannedWords);
  assert.doesNotMatch(guide, bannedNames);

  const appended = appendSpaceOperationsGuide(appendAssistantInstructions([], "Prefer short answers."), guide);
  assert.equal(appended.length, 2);
  assert.match(appended[0]!, /^## Space instructions/);
  assert.equal(appended[1], guide);
  assert.equal(spaceOperationsGuideForScope("space-1"), guide);
  assert.equal(spaceOperationsGuideForScope(workFoldManagementScopeId), undefined);
  assert.equal(workFoldSpaceOperationsGuide("wf").includes("`wf help collaborate`"), true, "the executable name substitutes");
});

test("the local API composes a Space turn's context from acceptance, never from the fold's registry", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-space-turn-context-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 300)),
    });
  }\n`, "utf8");
  const events: Array<{ spaceId: string; conversationId: string; taskId: string; spaceTurn?: PiSpaceTurnContext }> = [];
  let releaseManagement!: () => void;
  const managementGate = new Promise<void>((resolve) => { releaseManagement = resolve; });
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
    async beforeAgentPrompt(event) {
      events.push(event);
      if (event.spaceId === workFoldManagementScopeId) await managementGate;
    },
  });
  try {
    const { space } = await api.actFacade.createSpace({ name: "Brief" });
    const other = (await api.actFacade.createSpace({ name: "Elsewhere" })).space;
    const parent = await api.actFacade.manageSend({ content: "/hold" });
    await waitFor(() => events.some((event) => event.taskId === parent.taskId));

    const delegated = await api.actFacade.sendMessage({ space: space.id, newConversation: true, content: "Adopt the brief.", parentTaskId: parent.taskId });
    await waitFor(() => events.some((event) => event.taskId === delegated.taskId));
    const delegatedEvent = events.find((event) => event.taskId === delegated.taskId)!;
    assert.ok(delegatedEvent.spaceTurn, "a Space turn carries its identity");
    assert.equal(delegatedEvent.spaceTurn!.spaceId, space.id);
    assert.equal(delegatedEvent.spaceTurn!.taskId, delegated.taskId);
    assert.equal(delegatedEvent.spaceTurn!.requestId, api.requests.byTaskId(delegated.taskId)!.requestId, "the request id is the durable record's, never invented");
    assert.match(delegatedEvent.spaceTurn!.delegated!.parentHandle, /^parent-[0-9a-f]{16}$/);
    assert.notEqual(delegatedEvent.spaceTurn!.delegated!.parentHandle, parent.taskId);
    assert.equal(delegatedEvent.spaceTurn!.delegated!.assignmentIsThisMessage, true);
    const serialized = JSON.stringify(delegatedEvent.spaceTurn);
    assert.equal(serialized.includes(other.id), false, "no other Space's id");
    assert.equal(serialized.includes(other.spaceRoot), false, "no other Space's folder");
    assert.equal(serialized.includes(parent.taskId), false, "never the parent's real task id");

    const undelegated = await api.actFacade.sendMessage({ space: space.id, newConversation: true, content: "Just this Space." });
    await waitFor(() => events.some((event) => event.taskId === undelegated.taskId));
    const undelegatedEvent = events.find((event) => event.taskId === undelegated.taskId)!;
    assert.equal(undelegatedEvent.spaceTurn!.delegated, undefined);
    assert.equal(undelegatedEvent.spaceTurn!.requestId, api.requests.byTaskId(undelegated.taskId)!.requestId);

    const managementEvent = events.find((event) => event.taskId === parent.taskId)!;
    assert.equal(managementEvent.spaceTurn, undefined, "the fold's own turn carries no Space identity block");
  } finally {
    releaseManagement();
    await api.close();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
