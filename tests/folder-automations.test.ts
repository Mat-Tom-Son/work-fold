import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { workFoldCliBrokerPaths } from "../src/local/cli/broker.js";
import type { WorkFoldCliActReceipt } from "../src/local/cli/act-receipts.js";
import {
  normalizeWorkFoldRoutingDeclaration,
  workFoldRoutingDigest,
  workFoldRoutingSpaceRoles,
} from "../src/local/routings/routing-declarations.js";
import { startLocalApi } from "../src/local/server.js";
import { routingTriggerSummary, type FolderAutomationsResponse } from "../src/shared/routing-presentation.js";

const home = "space-0123456789abcdef";
const trip = "space-fedcba9876543210";
const other = "space-aaaaaaaaaaaaaaaa";

test("a routing's roles in a Folder come from its trigger and the Space each step targets", () => {
  const declaration = normalizeWorkFoldRoutingDeclaration({
    kind: "work-fold.routing",
    version: 4,
    id: "routing-folder-roles",
    title: "Roles",
    createdBy: "human",
    createdAt: "2026-09-24T12:00:00.000Z",
    trigger: {
      kind: "files-changed",
      space: home,
      watch: { kind: "tree", path: "Ready", recursive: false, extensions: [".md"] },
      debounceSeconds: 5,
      cooldownMinutes: 1,
    },
    steps: [
      { id: "adopt", kind: "chat", space: trip, message: "Adopt the newest brief." },
      { id: "copy", kind: "files", fromSpace: home, from: { kind: "paths", paths: ["Ready/brief.md"] }, toSpace: trip, to: "Incoming" },
      { id: "verify", kind: "check", space: trip },
      { id: "report", kind: "fold", message: "Done." },
    ],
  });
  assert.deepEqual(workFoldRoutingSpaceRoles(declaration, home), ["watches", "copies-from"]);
  assert.deepEqual(workFoldRoutingSpaceRoles(declaration, trip), ["copies-to", "chats-here", "checks-here"]);
  assert.deepEqual(workFoldRoutingSpaceRoles(declaration, other), [], "a fold step names no Folder");

  const settled = normalizeWorkFoldRoutingDeclaration({
    kind: "work-fold.routing",
    version: 1,
    id: "routing-after-a-check",
    title: "After a Check",
    createdBy: "human",
    createdAt: "2026-09-24T12:00:00.000Z",
    trigger: { kind: "on-settled", source: { kind: "check-run", space: other } },
    steps: [{ id: "tell", kind: "chat", space: home, message: "A Check settled." }],
  });
  assert.deepEqual(workFoldRoutingSpaceRoles(settled, other), ["watches"]);
  assert.deepEqual(workFoldRoutingSpaceRoles(settled, home), ["chats-here"]);
});

test("the shared trigger summary is the one Settings and the Folder view print", () => {
  assert.equal(routingTriggerSummary({ kind: "manual" }), "Manual only");
  assert.equal(routingTriggerSummary({ kind: "interval", intervalMinutes: 30 }), "Every 30 minutes");
  assert.equal(routingTriggerSummary({ kind: "interval", intervalMinutes: 120 }), "Every 2 hours");
  assert.equal(
    routingTriggerSummary({ kind: "on-settled", source: { kind: "check-run", spaceId: home, spaceName: "Home projects" } }),
    "After a Check settles in Home projects",
  );
});

test("GET /api/spaces/:id/automations lists only routings naming the Folder; its acts are the Settings acts and refuse unrelated routings", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-folder-automations-"));
  const stateRoot = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase: stateRoot,
    spaceBase: join(sandbox, "spaces"),
    sessionToken: "folder-automations-session",
    loadEnv: false,
  });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const headers = { "content-type": "application/json", "x-work-fold-session": "folder-automations-session" };
  const get = async (spaceId: string) => {
    const response = await fetch(`${api.origin}/api/spaces/${spaceId}/automations`, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as FolderAutomationsResponse;
  };
  const post = (spaceId: string, routingId: string, action: string) =>
    fetch(`${api.origin}/api/spaces/${spaceId}/automations/${routingId}/${action}`, { method: "POST", headers });

  const a = (await api.actFacade.createSpace({ name: "Folder A" })).space;
  const b = (await api.actFacade.createSpace({ name: "Folder B" })).space;
  const c = (await api.actFacade.createSpace({ name: "Folder C" })).space;
  const d = (await api.actFacade.createSpace({ name: "Folder D" })).space;
  await writeFile(join(a.spaceRoot, "notes.txt"), "folder handoff", "utf8");

  const declarations = [
    {
      kind: "work-fold.routing", version: 1, id: "routing-a-to-b-handoff", title: "A to B",
      createdBy: "human", createdAt: "2026-09-24T12:00:00.000Z",
      trigger: { kind: "manual" },
      steps: [{ id: "handoff", kind: "files", fromSpace: a.id, from: { kind: "paths", paths: ["notes.txt"] }, toSpace: b.id, to: "Incoming" }],
    },
    {
      kind: "work-fold.routing", version: 1, id: "routing-chat-in-c", title: "Chat in C",
      createdBy: "human", createdAt: "2026-09-24T12:00:00.000Z",
      trigger: { kind: "manual" },
      steps: [{ id: "ask", kind: "chat", space: c.id, message: "Summarize the week." }],
    },
    {
      kind: "work-fold.routing", version: 1, id: "routing-after-b-check", title: "After a Check in B",
      createdBy: "human", createdAt: "2026-09-24T12:00:00.000Z",
      trigger: { kind: "on-settled", source: { kind: "check-run", space: b.id } },
      steps: [{ id: "forward", kind: "files", fromSpace: b.id, from: { kind: "paths", paths: ["Incoming/notes.txt"] }, toSpace: c.id, to: "From B" }],
    },
  ].map((value) => normalizeWorkFoldRoutingDeclaration(value));
  for (const declaration of declarations) {
    await api.routings.enable({
      declaration,
      expectedDigest: workFoldRoutingDigest(declaration),
      grant: { requestId: `request-${declaration.id}`, surface: "main-window" },
    });
  }

  assert.deepEqual(await get(a.id), {
    automations: [{
      routingId: "routing-a-to-b-handoff",
      title: "A to B",
      state: "on",
      triggerSummary: "Manual only",
      nextRunAt: null,
      lastRun: null,
      roles: ["copies-from"],
    }],
  });
  const inB = await get(b.id);
  assert.deepEqual(inB.automations.map((item) => [item.routingId, item.roles]).sort(), [
    ["routing-a-to-b-handoff", ["copies-to"]],
    ["routing-after-b-check", ["watches", "copies-from"]],
  ]);
  assert.equal(
    inB.automations.find((item) => item.routingId === "routing-after-b-check")?.triggerSummary,
    "After a Check settles in Folder B",
    "the settled source is named by its Folder name",
  );
  const inC = await get(c.id);
  assert.deepEqual(inC.automations.map((item) => [item.routingId, item.roles]).sort(), [
    ["routing-after-b-check", ["copies-to"]],
    ["routing-chat-in-c", ["chats-here"]],
  ]);
  assert.deepEqual(await get(d.id), { automations: [] }, "an untouched Folder gets an empty list");

  // A routing that does not name the Folder is refused and left unchanged.
  for (const action of ["disable", "enable", "run"]) {
    const refused = await post(a.id, "routing-chat-in-c", action);
    assert.equal(refused.status, 404, action);
    assert.match((await refused.json() as { error: string }).error, /does not touch this folder/);
  }
  assert.equal((await api.routings.getRouting("routing-chat-in-c"))?.health, "enabled");
  assert.equal((await post(a.id, "routing-missing-one", "run")).status, 404);
  const unauthenticated = await fetch(`${api.origin}/api/spaces/${a.id}/automations`);
  assert.equal(unauthenticated.status, 401);

  const disabled = await post(c.id, "routing-chat-in-c", "disable");
  assert.equal(disabled.status, 200, await disabled.clone().text());
  assert.equal((await disabled.json() as { disabled: boolean }).disabled, true);
  assert.equal((await get(c.id)).automations.find((item) => item.routingId === "routing-chat-in-c")?.state, "off");
  const enabled = await post(c.id, "routing-chat-in-c", "enable");
  assert.equal(enabled.status, 200, await enabled.clone().text());
  const enabledBody = await enabled.json() as { enabled: boolean; requestId: string };
  assert.equal(enabledBody.enabled, true);
  assert.match(enabledBody.requestId, /^settings:/);
  assert.equal((await api.routings.getRouting("routing-chat-in-c"))?.grants.at(-1)?.surface, "main-window");
  assert.equal((await post(c.id, "routing-chat-in-c", "enable")).status, 409, "the Settings conflict carries through");

  const run = await post(b.id, "routing-a-to-b-handoff", "run");
  assert.equal(run.status, 200, await run.clone().text());
  const runBody = await run.json() as { accepted: boolean; requestId: string; runId: string };
  assert.equal(runBody.accepted, true);
  assert.match(runBody.requestId, /^settings:/);
  await waitFor(async () => {
    const text = await readFile(join(b.spaceRoot, "Incoming", "notes.txt"), "utf8").catch(() => null);
    return text === "folder handoff";
  }, "the Folder-view run to copy the file");
  await waitFor(async () => (await get(a.id)).automations[0]?.lastRun?.outcome === "succeeded", "the last run to settle");

  const actPath = join(workFoldCliBrokerPaths(stateRoot).root, "receipts", "act.jsonl");
  await waitFor(async () => (await jsonLines<WorkFoldCliActReceipt>(actPath))
    .some((entry) => entry.command === "routings.run" && entry.outcome === "ok"), "the run's terminal act receipt");
  const acts = (await jsonLines<WorkFoldCliActReceipt>(actPath)).filter((entry) => entry.command.startsWith("routings."));
  assert.ok(acts.every((entry) => entry.surface === "main-window" && entry.requestId.startsWith("settings:")),
    "the Folder view writes exactly the receipts Settings writes");
  for (const command of ["routings.disable", "routings.enable", "routings.run"]) {
    assert.ok(acts.some((entry) => entry.command === command && entry.outcome === "accepted"), `${command} accepted`);
    assert.ok(acts.some((entry) => entry.command === command && entry.outcome === "ok"), `${command} ok`);
  }
});

async function jsonLines<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${label}.`);
}
