import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { workFoldCliBrokerPaths } from "../src/local/cli/broker.js";
import type { WorkFoldCliActReceipt } from "../src/local/cli/act-receipts.js";
import {
  normalizeWorkFoldAutomationDeclaration,
  workFoldAutomationDigest,
} from "../src/local/automations/automation-declarations.js";
import type { WorkFoldAutomationReceiptV1 } from "../src/local/automations/automation-store.js";
import { startLocalApi } from "../src/local/server.js";
import { workFoldAgentRoot } from "../src/local/state-paths.js";

test("trusted Settings manages automations with receipted enablement, bounded run history, and global receipts", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-automation-settings-"));
  const stateRoot = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase: stateRoot,
    workFolderBase: join(sandbox, "work-folders"),
    loadEnv: false,
  });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  const source = await api.actFacade.createWorkFolder({ name: "Automation source" });
  const destination = await api.actFacade.createWorkFolder({ name: "Automation destination" });
  await writeFile(join(source.workFolder.workFolderRoot, "notes.txt"), "scheduled handoff", "utf8");
  const declaration = normalizeWorkFoldAutomationDeclaration({
    kind: "work-fold.automation",
    version: 1,
    id: "automation-settings-handoff",
    title: "Settings handoff",
    createdBy: "human",
    createdAt: "2026-09-01T12:00:00.000Z",
    trigger: { kind: "manual" },
    steps: [{
      id: "handoff",
      kind: "files",
      fromWorkFolder: source.workFolder.id,
      from: { kind: "paths", paths: ["notes.txt"] },
      toWorkFolder: destination.workFolder.id,
      to: "Incoming",
    }],
  });
  await api.automations.enable({
    declaration,
    expectedDigest: workFoldAutomationDigest(declaration),
    grant: { requestId: "request-settings-fixture", surface: "main-window" },
  });

  const listed = await api.automationSettings.list();
  assert.equal(listed.automations[0]?.title, "Settings handoff");
  assert.equal(listed.automations[0]?.health, "enabled");
  const shown = await api.automationSettings.show(declaration.id);
  assert.deepEqual([...shown.automation.workFolders].sort((left, right) => left.workFolderName!.localeCompare(right.workFolderName!)), [
    { workFolderId: destination.workFolder.id, workFolderName: "Automation destination" },
    { workFolderId: source.workFolder.id, workFolderName: "Automation source" },
  ]);

  const accepted = await api.automationSettings.run(declaration.id);
  assert.equal(accepted.accepted, true, "Run now acknowledges durable command acceptance without waiting for every hop");
  assert.match(accepted.requestId, /^settings:/);
  assert.match(accepted.runId, /.+/, "Settings receives the exact admitted run id for status polling");
  await waitFor(async () => {
    const text = await readFile(join(destination.workFolder.workFolderRoot, "Incoming", "notes.txt"), "utf8").catch(() => null);
    return text === "scheduled handoff";
  }, "the Settings run to complete");
  await waitFor(async () => (await api.automationSettings.history(declaration.id)).runs[0]?.outcome === "succeeded", "the run receipt to settle");
  const history = await api.automationSettings.history(declaration.id);
  assert.equal(history.runs[0]?.outcome, "succeeded");
  assert.equal(history.runs[0]?.runId, accepted.runId, "the admitted id is the stable UI status channel");
  assert.equal(history.runs[0]?.cause, "Run Now");
  assert.ok(history.runs[0]?.hops[0]?.evidence?.some((item) => item.label === "Files" && item.value === "1"));

  const domainPath = join(stateRoot, "automations", "receipts.jsonl");
  const noise = Array.from({ length: 501 }, (_, index) => JSON.stringify({
    v: 1,
    at: new Date(Date.parse("2026-09-01T13:00:00.000Z") + index).toISOString(),
    scope: "run",
    outcome: "skipped",
    automationId: "automation-busy-neighbor",
    runId: `noise-${index}`,
  })).join("\n");
  await appendFile(domainPath, `${noise}\n`, "utf8");
  const globalReceipts = await api.actFacade.automationsReceipts({});
  assert.equal(globalReceipts.receipts.length, 500, "the shared CLI projection stays globally bounded");
  assert.equal(globalReceipts.truncated, true);
  assert.ok(globalReceipts.receipts.every((receipt) => receipt.automationId === "automation-busy-neighbor"));
  assert.equal(globalReceipts.receipts[0]?.runId, "noise-1", "the stable CLI projection remains chronological");
  assert.equal(globalReceipts.receipts.at(-1)?.runId, "noise-500");
  const retained = (await api.automationSettings.list()).automations.find((automation) => automation.automationId === declaration.id);
  assert.equal(retained?.lastRun?.runId, accepted.runId, "busy neighboring automations cannot evict this automation's last run");

  const disabled = await api.automationSettings.disable(declaration.id);
  assert.equal(disabled.disabled, true);
  // Enabling from Settings runs at once through the prepared-act path
  // (docs/receipts-not-gates.md, F19/F23) under a Settings-minted request id.
  const enabled = await api.automationSettings.enable(declaration.id);
  assert.deepEqual(enabled, {
    automationId: declaration.id,
    requestId: enabled.requestId,
    enabled: true,
    alreadyEnabled: false,
  });
  assert.match(enabled.requestId, /^settings:/);
  const reEnabled = await api.automations.getAutomation(declaration.id);
  assert.equal(reEnabled?.health, "enabled");
  assert.equal(reEnabled?.grants.at(-1)?.requestId, enabled.requestId, "the enablement receipt carries the act's request id");
  assert.ok(reEnabled?.grants.at(-1)?.enabledAt, "the receipt records when it was enabled");
  assert.equal(reEnabled?.grants.at(-1)?.surface, "main-window");
  await assert.rejects(() => api.automationSettings.enable(declaration.id), /already on/);
  await api.automationSettings.disable(declaration.id);
  assert.equal((await api.automationSettings.delete(declaration.id)).deleted, true);

  const actPath = join(workFoldCliBrokerPaths(stateRoot).root, "receipts", "act.jsonl");
  await waitFor(async () => {
    const entries = await jsonLines<WorkFoldCliActReceipt>(actPath);
    return entries.some((entry) => entry.command === "automations.run" && entry.outcome === "ok");
  }, "the asynchronous Settings run terminal act receipt");
  const settingsActs = (await jsonLines<WorkFoldCliActReceipt>(actPath))
    .filter((entry) => entry.command.startsWith("automations."));
  assert.ok(settingsActs.length >= 10);
  assert.ok(settingsActs.every((entry) => entry.surface === "main-window"));
  assert.ok(settingsActs.every((entry) => entry.requestId.startsWith("settings:")));
  for (const command of ["automations.run", "automations.disable", "automations.enable", "automations.delete"]) {
    const entries = settingsActs.filter((entry) => entry.command === command);
    assert.ok(entries.some((entry) => entry.outcome === "accepted"), `${command} records acceptance first`);
    assert.ok(entries.some((entry) => entry.outcome === "ok"), `${command} records a terminal outcome`);
  }

  const domain = await jsonLines<WorkFoldAutomationReceiptV1>(domainPath);
  const runNow = domain.find((entry) => entry.scope === "run" && entry.outcome === "accepted" && entry.cause?.kind === "run-now");
  assert.equal(runNow?.surface, "main-window");
  assert.equal(runNow?.requestId, accepted.requestId);
});


test("automations enable is direct and an agent step opens a new management thread", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-automation-agent-step-"));
  const stateRoot = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase: stateRoot,
    workFolderBase: join(sandbox, "work-folders"),
    loadEnv: false,
  });
  t.after(async () => {
    await api.close();
    // The work-fold agent hop's own turn may still be flushing a best-effort receipt as
    // the API closes; retry so a racing write never fails the test.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(sandbox, { recursive: true, force: true });
        return;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    await rm(sandbox, { recursive: true, force: true });
  });

  // An inert typed proposal on disk is the whole input; `automations enable`
  // reads it, pins its digest, and turns the automation on at once.
  const proposalPath = join(sandbox, "digest.work-fold-automation.json");
  await writeFile(proposalPath, JSON.stringify({
    kind: "work-fold.automation-proposal",
    version: 4,
    name: "Fold digest",
    createdBy: "assistant",
    createdAt: "2026-09-01T12:00:00.000Z",
    automation: {
      title: "Fold digest",
      trigger: { kind: "manual" },
      steps: [{ id: "digest", kind: "agent", message: "{{trigger.summary}} Say hello." }],
    },
  }), "utf8");

  const enabled = await api.actFacade.automationsEnable({ proposalPath, cwd: sandbox, requestId: "act:agent-step-enable" });
  assert.equal(enabled.health, "enabled");
  assert.equal(enabled.alreadyEnabled, false);
  assert.deepEqual(enabled.referencedWorkFolderIds, [], "an agent step names no work-folder");
  assert.match(enabled.automationId, /^automation-[a-f0-9]{16}$/);
  const again = await api.actFacade.automationsEnable({ proposalPath, cwd: sandbox, requestId: "act:agent-step-enable-2" });
  assert.equal(again.alreadyEnabled, true, "enabling the same declaration again changes nothing");
  assert.equal((await api.automations.getAutomation(enabled.automationId))?.grants.length, 1);

  await api.automationSettings.run(enabled.automationId);
  // A fold hop opens a real work-fold agent Chat and runs a real Pi turn against
  // it. Building that session is the slowest thing in the suite: measured
  // between 4 s idle and 17 s while the rest of the suite shares the machine,
  // so the budget is generous on purpose. It bounds a hang, not a slow start.
  await waitFor(async () => {
    const history = await api.automationSettings.history(enabled.automationId);
    return history.runs[0]?.hops[0]?.outcome !== undefined && history.runs[0]?.hops[0]?.outcome !== "accepted";
  }, "the work-fold agent hop to settle", 120_000);
  const hop = (await api.automationSettings.history(enabled.automationId)).runs[0]?.hops[0];
  assert.equal(hop?.kind, "agent");

  const receipts = (await api.actFacade.automationsReceipts({ automation: enabled.automationId })).receipts;
  const terminal = receipts.find((receipt) => receipt.hopId === "digest" && receipt.outcome !== "accepted");
  assert.equal(terminal?.hopKind, "agent");
  assert.deepEqual(terminal?.placeholders, [{
    name: "trigger.summary",
    text: "Started by hand.",
    bytes: "Started by hand.".length,
    truncated: false,
  }], "the receipt records exactly what work-fold filled in");
  assert.equal(terminal?.messageBytes, "Started by hand. Say hello.".length);

  // In this sandbox the work-fold agent turn settles on its own (the hop records
  // `succeeded` with a real conversation id). Without prepared management
  // instructions the hop would instead fail honestly, so both branches are
  // asserted; what must hold either way is that a *new* management thread
  // carries the filled-in message as its first person-visible message.
  if (terminal?.conversationId) {
    const transcript = await readFile(
      join(workFoldAgentRoot(), ".work-fold", "conversations", `${terminal.conversationId}.jsonl`),
      "utf8",
    );
    const first = transcript.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as {
      role?: string;
      content?: string;
    }).find((entry) => entry.role === "user");
    assert.equal(first?.content, "Started by hand. Say hello.");
  } else {
    assert.match(terminal?.detail ?? "", /management conversation is unavailable/);
  }
});

test("Settings lists pending proposal files and turns one on by path through the CLI enable path", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-automation-proposals-"));
  const stateRoot = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase: stateRoot,
    workFolderBase: join(sandbox, "work-folders"),
    loadEnv: false,
  });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  const alpha = await api.actFacade.createWorkFolder({ name: "Alpha" });
  const beta = await api.actFacade.createWorkFolder({ name: "Beta" });
  const root = workFoldAgentRoot();
  await mkdir(root, { recursive: true });
  const proposal = (title: string, workFolder: string) => JSON.stringify({
    kind: "work-fold.automation-proposal",
    version: 1,
    name: title,
    createdBy: "assistant",
    createdAt: "2026-09-24T12:00:00.000Z",
    automation: {
      title,
      trigger: { kind: "interval", intervalMinutes: 60 },
      steps: [{ id: "hello", kind: "chat", workFolder, message: "Say hello." }],
    },
  });
  const readyPath = join(root, "hourly.work-fold-automation.json");
  await writeFile(readyPath, proposal("Hourly hello", alpha.workFolder.id), "utf8");
  await writeFile(join(root, "broken.work-fold-automation.json"), "{", "utf8");
  await writeFile(join(root, "gone.work-fold-automation.json"), proposal("Gone folder", "space-00000000000000ff"), "utf8");

  const pending = await api.automationSettings.proposals();
  assert.equal(pending.truncated, false);
  assert.deepEqual(pending.proposals.map((entry) => [entry.fileName, entry.valid]), [
    ["broken.work-fold-automation.json", false],
    ["gone.work-fold-automation.json", false],
    ["hourly.work-fold-automation.json", true],
  ]);
  const ready = pending.proposals.find((entry) => entry.valid);
  assert.ok(ready?.valid);
  assert.equal(ready.title, "Hourly hello");
  assert.deepEqual(ready.trigger, { kind: "interval", intervalMinutes: 60 });
  assert.equal(ready.path, readyPath);
  const gone = pending.proposals.find((entry) => entry.fileName === "gone.work-fold-automation.json");
  assert.match(gone?.valid === false ? gone.problem : "", /Names a work-folder that is not on this computer/);

  // Only a proposal file directly inside the agent's working folder is admitted.
  const outside = join(sandbox, "outside.work-fold-automation.json");
  await writeFile(outside, proposal("Outside", alpha.workFolder.id), "utf8");
  await assert.rejects(() => api.automationSettings.enableProposal(outside), /Only automation files in the work-fold agent's folder/);
  await assert.rejects(() => api.automationSettings.enableProposal(join(root, "..", "outside.work-fold-automation.json")), /Only automation files/);
  await assert.rejects(() => api.automationSettings.enableProposal("hourly.work-fold-automation.json"), /absolute automation file path/);
  await assert.rejects(() => api.automationSettings.enableProposal(join(root, "broken.work-fold-automation.json")), /not readable JSON/);
  const linked = join(root, "linked.work-fold-automation.json");
  await symlink(outside, linked);
  await assert.rejects(() => api.automationSettings.enableProposal(linked), /regular file/);
  await rm(linked);
  assert.deepEqual(await api.automations.listAutomations(), [], "refused paths enable nothing");

  const enabled = await api.automationSettings.enableProposal(readyPath);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.alreadyEnabled, false);
  assert.equal(enabled.automationId, ready.automationId, "the scanned id is exactly what enabling pins");
  assert.match(enabled.requestId, /^settings:/);
  assert.equal(enabled.automation.health, "enabled");
  assert.equal(enabled.automation.title, "Hourly hello");
  assert.deepEqual(enabled.automation.workFolders, [{ workFolderId: alpha.workFolder.id, workFolderName: "Alpha" }]);
  const stored = await api.automations.getAutomation(enabled.automationId);
  assert.equal(stored?.digest, ready.digest);
  assert.equal(stored?.grants.at(-1)?.surface, "main-window");
  assert.equal(stored?.grants.at(-1)?.requestId, enabled.requestId);

  // An enabled proposal shows once, in the main list — and still once after it is turned off.
  const after = await api.automationSettings.proposals();
  assert.ok(!after.proposals.some((entry) => entry.fileName === "hourly.work-fold-automation.json"));
  await api.automationSettings.disable(enabled.automationId);
  assert.ok(!(await api.automationSettings.proposals()).proposals.some((entry) => entry.fileName === "hourly.work-fold-automation.json"));
  assert.equal((await api.automationSettings.enableProposal(readyPath)).alreadyEnabled, false, "turning a stored-but-off file on again re-enables it");
  assert.equal((await api.automationSettings.enableProposal(readyPath)).alreadyEnabled, true, "the same digest again changes nothing");

  // Editing the file makes it a new pending proposal with a new digest.
  await writeFile(readyPath, proposal("Hourly hello, Beta", beta.workFolder.id), "utf8");
  const edited = (await api.automationSettings.proposals()).proposals.find((entry) => entry.fileName === "hourly.work-fold-automation.json");
  assert.equal(edited?.valid, true);
  assert.notEqual(edited?.valid ? edited.digest : "", ready.digest);

  const listed = await api.automationSettings.list();
  assert.deepEqual(listed.automations[0]?.workFolders, [{ workFolderId: alpha.workFolder.id, workFolderName: "Alpha" }], "summaries carry the work-folders for the filter");

  const actPath = join(workFoldCliBrokerPaths(stateRoot).root, "receipts", "act.jsonl");
  const enables = (await jsonLines<WorkFoldCliActReceipt>(actPath)).filter((entry) => entry.command === "automations.enable");
  assert.ok(enables.some((entry) => entry.outcome === "accepted" && entry.surface === "main-window"));
  assert.ok(enables.some((entry) => entry.outcome === "ok" && /from hourly\.work-fold-automation\.json/.test(entry.detail ?? "")));
  assert.ok(enables.some((entry) => entry.outcome === "error"), "a refused read after acceptance records its error");
});

test("a stored one-time proposal stays out of pending files after its admission horizon passes", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-automation-proposal-expiry-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "work-folders"),
    loadEnv: false,
  });
  t.after(async () => {
    t.mock.timers.reset();
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const workFolder = (await api.actFacade.createWorkFolder({ name: "Scheduled folder" })).workFolder;
  const at = Date.now() + 5 * 60_000;
  const value = {
    kind: "work-fold.automation-proposal", version: 2, name: "One reminder",
    createdBy: "assistant", createdAt: new Date().toISOString(),
    automation: {
      title: "One reminder", trigger: { kind: "at", at: new Date(at).toISOString(), ifMissed: "skip" },
      steps: [{ id: "hello", kind: "chat", workFolder: workFolder.id, message: "Say hello." }],
    },
  };
  const root = workFoldAgentRoot();
  await mkdir(root, { recursive: true });
  const path = join(root, "reminder.work-fold-automation.json");
  await writeFile(path, JSON.stringify(value));
  const enabled = await api.automationSettings.enableProposal(path);
  await api.automationSettings.disable(enabled.automationId);

  t.mock.timers.enable({ apis: ["Date"], now: at + 60_000 });
  assert.deepEqual((await api.automationSettings.proposals()).proposals, [], "the unchanged stored proposal still appears only in the main list");
  await writeFile(path, JSON.stringify({ ...value, name: "Another reminder" }));
  const pending = (await api.automationSettings.proposals()).proposals;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.valid, false, "an unstored expired proposal remains invalid");
});

// A wall-clock budget, not an attempt count: every attempt awaits a real API
// call, so a count means nothing under full-suite load.
async function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function jsonLines<T>(path: string): Promise<T[]> {
  await mkdir(dirname(path), { recursive: true });
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}
