import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { workFoldCliBrokerPaths } from "../src/local/cli/broker.js";
import type { WorkFoldCliActReceipt } from "../src/local/cli/act-receipts.js";
import {
  normalizeWorkFoldAutomationDeclaration,
  workFoldAutomationDigest,
  workFoldAutomationWorkFolderRoles,
} from "../src/local/automations/automation-declarations.js";
import { startLocalApi } from "../src/local/server.js";
import { automationTriggerSummary, type FolderAutomationsResponse } from "../src/shared/automation-presentation.js";

const home = "space-0123456789abcdef";
const trip = "space-fedcba9876543210";
const other = "space-aaaaaaaaaaaaaaaa";

test("an automation's roles in a work-folder come from its trigger and the work-folder each step targets", () => {
  const declaration = normalizeWorkFoldAutomationDeclaration({
    kind: "work-fold.automation",
    version: 4,
    id: "automation-folder-roles",
    title: "Roles",
    createdBy: "human",
    createdAt: "2026-09-24T12:00:00.000Z",
    trigger: {
      kind: "files-changed",
      workFolder: home,
      watch: { kind: "tree", path: "Ready", recursive: false, extensions: [".md"] },
      debounceSeconds: 5,
      cooldownMinutes: 1,
    },
    steps: [
      { id: "adopt", kind: "chat", workFolder: trip, message: "Adopt the newest brief." },
      { id: "copy", kind: "files", fromWorkFolder: home, from: { kind: "paths", paths: ["Ready/brief.md"] }, toWorkFolder: trip, to: "Incoming" },
      { id: "verify", kind: "check", workFolder: trip },
      { id: "report", kind: "agent", message: "Done." },
    ],
  });
  assert.deepEqual(workFoldAutomationWorkFolderRoles(declaration, home), ["watches", "copies-from"]);
  assert.deepEqual(workFoldAutomationWorkFolderRoles(declaration, trip), ["copies-to", "chats-here", "checks-here"]);
  assert.deepEqual(workFoldAutomationWorkFolderRoles(declaration, other), [], "an agent step names no work-folder");

  const settled = normalizeWorkFoldAutomationDeclaration({
    kind: "work-fold.automation",
    version: 1,
    id: "automation-after-a-check",
    title: "After a Check",
    createdBy: "human",
    createdAt: "2026-09-24T12:00:00.000Z",
    trigger: { kind: "on-settled", source: { kind: "check-run", workFolder: other } },
    steps: [{ id: "tell", kind: "chat", workFolder: home, message: "A Check settled." }],
  });
  assert.deepEqual(workFoldAutomationWorkFolderRoles(settled, other), ["watches"]);
  assert.deepEqual(workFoldAutomationWorkFolderRoles(settled, home), ["chats-here"]);
});

test("the shared trigger summary is the one Settings and the work-folder view print", () => {
  assert.equal(automationTriggerSummary({ kind: "manual" }), "Manual only");
  assert.equal(automationTriggerSummary({ kind: "interval", intervalMinutes: 30 }), "Every 30 minutes");
  assert.equal(automationTriggerSummary({ kind: "interval", intervalMinutes: 120 }), "Every 2 hours");
  assert.equal(
    automationTriggerSummary({ kind: "on-settled", source: { kind: "check-run", workFolderId: home, workFolderName: "Home projects" } }),
    "After a Check settles in Home projects",
  );
});

test("GET /api/work-folders/:id/automations lists only automations naming the work-folder; its acts are the Settings acts and refuse unrelated automations", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-folder-automations-"));
  const stateRoot = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase: stateRoot,
    workFolderBase: join(sandbox, "work-folders"),
    sessionToken: "folder-automations-session",
    loadEnv: false,
  });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const headers = { "content-type": "application/json", "x-work-fold-session": "folder-automations-session" };
  const get = async (workFolderId: string) => {
    const response = await fetch(`${api.origin}/api/work-folders/${workFolderId}/automations`, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as FolderAutomationsResponse;
  };
  const post = (workFolderId: string, automationId: string, action: string) =>
    fetch(`${api.origin}/api/work-folders/${workFolderId}/automations/${automationId}/${action}`, { method: "POST", headers });

  const a = (await api.actFacade.createWorkFolder({ name: "Folder A" })).workFolder;
  const b = (await api.actFacade.createWorkFolder({ name: "Folder B" })).workFolder;
  const c = (await api.actFacade.createWorkFolder({ name: "Folder C" })).workFolder;
  const d = (await api.actFacade.createWorkFolder({ name: "Folder D" })).workFolder;
  await writeFile(join(a.workFolderRoot, "notes.txt"), "folder handoff", "utf8");

  const declarations = [
    {
      kind: "work-fold.automation", version: 1, id: "automation-a-to-b-handoff", title: "A to B",
      createdBy: "human", createdAt: "2026-09-24T12:00:00.000Z",
      trigger: { kind: "manual" },
      steps: [{ id: "handoff", kind: "files", fromWorkFolder: a.id, from: { kind: "paths", paths: ["notes.txt"] }, toWorkFolder: b.id, to: "Incoming" }],
    },
    {
      kind: "work-fold.automation", version: 1, id: "automation-chat-in-c", title: "Chat in C",
      createdBy: "human", createdAt: "2026-09-24T12:00:00.000Z",
      trigger: { kind: "manual" },
      steps: [{ id: "ask", kind: "chat", workFolder: c.id, message: "Summarize the week." }],
    },
    {
      kind: "work-fold.automation", version: 1, id: "automation-after-b-check", title: "After a Check in B",
      createdBy: "human", createdAt: "2026-09-24T12:00:00.000Z",
      trigger: { kind: "on-settled", source: { kind: "check-run", workFolder: b.id } },
      steps: [{ id: "forward", kind: "files", fromWorkFolder: b.id, from: { kind: "paths", paths: ["Incoming/notes.txt"] }, toWorkFolder: c.id, to: "From B" }],
    },
  ].map((value) => normalizeWorkFoldAutomationDeclaration(value));
  for (const declaration of declarations) {
    await api.automations.enable({
      declaration,
      expectedDigest: workFoldAutomationDigest(declaration),
      grant: { requestId: `request-${declaration.id}`, surface: "main-window" },
    });
  }

  assert.deepEqual(await get(a.id), {
    automations: [{
      automationId: "automation-a-to-b-handoff",
      title: "A to B",
      state: "on",
      triggerSummary: "Manual only",
      nextRunAt: null,
      lastRun: null,
      roles: ["copies-from"],
    }],
  });
  const inB = await get(b.id);
  assert.deepEqual(inB.automations.map((item) => [item.automationId, item.roles]).sort(), [
    ["automation-a-to-b-handoff", ["copies-to"]],
    ["automation-after-b-check", ["watches", "copies-from"]],
  ]);
  assert.equal(
    inB.automations.find((item) => item.automationId === "automation-after-b-check")?.triggerSummary,
    "After a Check settles in Folder B",
    "the settled source is named by its work-folder name",
  );
  const inC = await get(c.id);
  assert.deepEqual(inC.automations.map((item) => [item.automationId, item.roles]).sort(), [
    ["automation-after-b-check", ["copies-to"]],
    ["automation-chat-in-c", ["chats-here"]],
  ]);
  assert.deepEqual(await get(d.id), { automations: [] }, "an untouched work-folder gets an empty list");

  // An automation that does not name the work-folder is refused and left unchanged.
  for (const action of ["disable", "enable", "run"]) {
    const refused = await post(a.id, "automation-chat-in-c", action);
    assert.equal(refused.status, 404, action);
    assert.match((await refused.json() as { error: string }).error, /does not touch this folder/);
  }
  assert.equal((await api.automations.getAutomation("automation-chat-in-c"))?.health, "enabled");
  assert.equal((await post(a.id, "automation-missing-one", "run")).status, 404);
  const unauthenticated = await fetch(`${api.origin}/api/work-folders/${a.id}/automations`);
  assert.equal(unauthenticated.status, 401);

  const disabled = await post(c.id, "automation-chat-in-c", "disable");
  assert.equal(disabled.status, 200, await disabled.clone().text());
  assert.equal((await disabled.json() as { disabled: boolean }).disabled, true);
  assert.equal((await get(c.id)).automations.find((item) => item.automationId === "automation-chat-in-c")?.state, "off");
  const enabled = await post(c.id, "automation-chat-in-c", "enable");
  assert.equal(enabled.status, 200, await enabled.clone().text());
  const enabledBody = await enabled.json() as { enabled: boolean; requestId: string };
  assert.equal(enabledBody.enabled, true);
  assert.match(enabledBody.requestId, /^settings:/);
  assert.equal((await api.automations.getAutomation("automation-chat-in-c"))?.grants.at(-1)?.surface, "main-window");
  assert.equal((await post(c.id, "automation-chat-in-c", "enable")).status, 409, "the Settings conflict carries through");

  const run = await post(b.id, "automation-a-to-b-handoff", "run");
  assert.equal(run.status, 200, await run.clone().text());
  const runBody = await run.json() as { accepted: boolean; requestId: string; runId: string };
  assert.equal(runBody.accepted, true);
  assert.match(runBody.requestId, /^settings:/);
  await waitFor(async () => {
    const text = await readFile(join(b.workFolderRoot, "Incoming", "notes.txt"), "utf8").catch(() => null);
    return text === "folder handoff";
  }, "the work-folder-view run to copy the file");
  await waitFor(async () => (await get(a.id)).automations[0]?.lastRun?.outcome === "succeeded", "the last run to settle");

  const actPath = join(workFoldCliBrokerPaths(stateRoot).root, "receipts", "act.jsonl");
  await waitFor(async () => (await jsonLines<WorkFoldCliActReceipt>(actPath))
    .some((entry) => entry.command === "automations.run" && entry.outcome === "ok"), "the run's terminal act receipt");
  const acts = (await jsonLines<WorkFoldCliActReceipt>(actPath)).filter((entry) => entry.command.startsWith("automations."));
  assert.ok(acts.every((entry) => entry.surface === "main-window" && entry.requestId.startsWith("settings:")),
    "the work-folder view writes exactly the receipts Settings writes");
  for (const command of ["automations.disable", "automations.enable", "automations.run"]) {
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
