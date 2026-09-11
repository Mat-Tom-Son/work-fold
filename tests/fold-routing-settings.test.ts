import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { workFoldCliBrokerPaths } from "../src/local/cli/broker.js";
import type { WorkFoldCliActReceipt } from "../src/local/cli/act-receipts.js";
import {
  normalizeWorkFoldRoutingDeclaration,
  workFoldRoutingDigest,
} from "../src/local/routings/routing-declarations.js";
import type { WorkFoldRoutingReceiptV1 } from "../src/local/routings/routing-store.js";
import { startLocalApi } from "../src/local/server.js";
import { workFoldManagementRoot } from "../src/local/state-paths.js";

test("trusted Settings manages routings with receipted enablement, bounded run history, and global receipts", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-routing-settings-"));
  const stateRoot = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase: stateRoot,
    spaceBase: join(sandbox, "spaces"),
    loadEnv: false,
  });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  const source = await api.actFacade.createSpace({ name: "Routing source" });
  const destination = await api.actFacade.createSpace({ name: "Routing destination" });
  await writeFile(join(source.space.spaceRoot, "notes.txt"), "scheduled handoff", "utf8");
  const declaration = normalizeWorkFoldRoutingDeclaration({
    kind: "work-fold.routing",
    version: 1,
    id: "routing-settings-handoff",
    title: "Settings handoff",
    createdBy: "human",
    createdAt: "2026-09-01T12:00:00.000Z",
    trigger: { kind: "manual" },
    steps: [{
      id: "handoff",
      kind: "files",
      fromSpace: source.space.id,
      from: { kind: "paths", paths: ["notes.txt"] },
      toSpace: destination.space.id,
      to: "Incoming",
    }],
  });
  await api.routings.enable({
    declaration,
    expectedDigest: workFoldRoutingDigest(declaration),
    grant: { requestId: "request-settings-fixture", surface: "main-window" },
  });

  const listed = await api.routingSettings.list();
  assert.equal(listed.routings[0]?.title, "Settings handoff");
  assert.equal(listed.routings[0]?.health, "enabled");
  const shown = await api.routingSettings.show(declaration.id);
  assert.deepEqual([...shown.routing.spaces].sort((left, right) => left.spaceName!.localeCompare(right.spaceName!)), [
    { spaceId: destination.space.id, spaceName: "Routing destination" },
    { spaceId: source.space.id, spaceName: "Routing source" },
  ]);

  const accepted = await api.routingSettings.run(declaration.id);
  assert.equal(accepted.accepted, true, "Run now acknowledges durable command acceptance without waiting for every hop");
  assert.match(accepted.requestId, /^settings:/);
  assert.match(accepted.runId, /.+/, "Settings receives the exact admitted run id for status polling");
  await waitFor(async () => {
    const text = await readFile(join(destination.space.spaceRoot, "Incoming", "notes.txt"), "utf8").catch(() => null);
    return text === "scheduled handoff";
  }, "the Settings run to complete");
  await waitFor(async () => (await api.routingSettings.history(declaration.id)).runs[0]?.outcome === "succeeded", "the run receipt to settle");
  const history = await api.routingSettings.history(declaration.id);
  assert.equal(history.runs[0]?.outcome, "succeeded");
  assert.equal(history.runs[0]?.runId, accepted.runId, "the admitted id is the stable UI status channel");
  assert.equal(history.runs[0]?.cause, "Run now");
  assert.ok(history.runs[0]?.hops[0]?.evidence?.some((item) => item.label === "Files" && item.value === "1"));

  const domainPath = join(stateRoot, "routings", "receipts.jsonl");
  const noise = Array.from({ length: 501 }, (_, index) => JSON.stringify({
    v: 1,
    at: new Date(Date.parse("2026-09-01T13:00:00.000Z") + index).toISOString(),
    scope: "run",
    outcome: "skipped",
    routingId: "routing-busy-neighbor",
    runId: `noise-${index}`,
  })).join("\n");
  await appendFile(domainPath, `${noise}\n`, "utf8");
  const globalReceipts = await api.actFacade.routingsReceipts({});
  assert.equal(globalReceipts.receipts.length, 500, "the shared CLI projection stays globally bounded");
  assert.equal(globalReceipts.truncated, true);
  assert.ok(globalReceipts.receipts.every((receipt) => receipt.routingId === "routing-busy-neighbor"));
  assert.equal(globalReceipts.receipts[0]?.runId, "noise-1", "the stable CLI projection remains chronological");
  assert.equal(globalReceipts.receipts.at(-1)?.runId, "noise-500");
  const retained = (await api.routingSettings.list()).routings.find((routing) => routing.routingId === declaration.id);
  assert.equal(retained?.lastRun?.runId, accepted.runId, "busy neighboring routings cannot evict this routing's last run");

  const disabled = await api.routingSettings.disable(declaration.id);
  assert.equal(disabled.disabled, true);
  // Enabling from Settings runs at once through the prepared-act path
  // (docs/receipts-not-gates.md, F19/F23) under a Settings-minted request id.
  const enabled = await api.routingSettings.enable(declaration.id);
  assert.deepEqual(enabled, {
    routingId: declaration.id,
    requestId: enabled.requestId,
    enabled: true,
    alreadyEnabled: false,
  });
  assert.match(enabled.requestId, /^settings:/);
  const reEnabled = await api.routings.getRouting(declaration.id);
  assert.equal(reEnabled?.health, "enabled");
  assert.equal(reEnabled?.grants.at(-1)?.requestId, enabled.requestId, "the enablement receipt carries the act's request id");
  assert.ok(reEnabled?.grants.at(-1)?.enabledAt, "the receipt records when it was enabled");
  assert.equal(reEnabled?.grants.at(-1)?.surface, "main-window");
  await assert.rejects(() => api.routingSettings.enable(declaration.id), /already on/);
  await api.routingSettings.disable(declaration.id);
  assert.equal((await api.routingSettings.delete(declaration.id)).deleted, true);

  const actPath = join(workFoldCliBrokerPaths(stateRoot).root, "receipts", "act.jsonl");
  await waitFor(async () => {
    const entries = await jsonLines<WorkFoldCliActReceipt>(actPath);
    return entries.some((entry) => entry.command === "routings.run" && entry.outcome === "ok");
  }, "the asynchronous Settings run terminal act receipt");
  const settingsActs = (await jsonLines<WorkFoldCliActReceipt>(actPath))
    .filter((entry) => entry.command.startsWith("routings."));
  assert.ok(settingsActs.length >= 10);
  assert.ok(settingsActs.every((entry) => entry.surface === "main-window"));
  assert.ok(settingsActs.every((entry) => entry.requestId.startsWith("settings:")));
  for (const command of ["routings.run", "routings.disable", "routings.enable", "routings.delete"]) {
    const entries = settingsActs.filter((entry) => entry.command === command);
    assert.ok(entries.some((entry) => entry.outcome === "accepted"), `${command} records acceptance first`);
    assert.ok(entries.some((entry) => entry.outcome === "ok"), `${command} records a terminal outcome`);
  }

  const domain = await jsonLines<WorkFoldRoutingReceiptV1>(domainPath);
  const runNow = domain.find((entry) => entry.scope === "run" && entry.outcome === "accepted" && entry.cause?.kind === "run-now");
  assert.equal(runNow?.surface, "main-window");
  assert.equal(runNow?.requestId, accepted.requestId);
});


test("routings enable is direct and a fold step opens a new management thread", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-routing-fold-step-"));
  const stateRoot = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase: stateRoot,
    spaceBase: join(sandbox, "spaces"),
    loadEnv: false,
  });
  t.after(async () => {
    await api.close();
    // The fold hop's own turn may still be flushing a best-effort receipt as
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

  // An inert typed proposal on disk is the whole input; `routings enable`
  // reads it, pins its digest, and turns the routing on at once.
  const proposalPath = join(sandbox, "digest.work-fold-routing.json");
  await writeFile(proposalPath, JSON.stringify({
    kind: "work-fold.routing-proposal",
    version: 4,
    name: "Fold digest",
    createdBy: "assistant",
    createdAt: "2026-09-01T12:00:00.000Z",
    routing: {
      title: "Fold digest",
      trigger: { kind: "manual" },
      steps: [{ id: "digest", kind: "fold", message: "{{trigger.summary}} Say hello." }],
    },
  }), "utf8");

  const enabled = await api.actFacade.routingsEnable({ proposalPath, cwd: sandbox, requestId: "act:fold-step-enable" });
  assert.equal(enabled.health, "enabled");
  assert.equal(enabled.alreadyEnabled, false);
  assert.deepEqual(enabled.referencedSpaceIds, [], "a fold step names no Space");
  assert.match(enabled.routingId, /^routing-[a-f0-9]{16}$/);
  const again = await api.actFacade.routingsEnable({ proposalPath, cwd: sandbox, requestId: "act:fold-step-enable-2" });
  assert.equal(again.alreadyEnabled, true, "enabling the same declaration again changes nothing");
  assert.equal((await api.routings.getRouting(enabled.routingId))?.grants.length, 1);

  await api.routingSettings.run(enabled.routingId);
  // A fold hop opens a real management Chat and runs a real Pi turn against
  // it. Building that session is the slowest thing in the suite: measured
  // between 4 s idle and 17 s while the rest of the suite shares the machine,
  // so the budget is generous on purpose. It bounds a hang, not a slow start.
  await waitFor(async () => {
    const history = await api.routingSettings.history(enabled.routingId);
    return history.runs[0]?.hops[0]?.outcome !== undefined && history.runs[0]?.hops[0]?.outcome !== "accepted";
  }, "the fold hop to settle", 120_000);
  const hop = (await api.routingSettings.history(enabled.routingId)).runs[0]?.hops[0];
  assert.equal(hop?.kind, "fold");

  const receipts = (await api.actFacade.routingsReceipts({ routing: enabled.routingId })).receipts;
  const terminal = receipts.find((receipt) => receipt.hopId === "digest" && receipt.outcome !== "accepted");
  assert.equal(terminal?.hopKind, "fold");
  assert.deepEqual(terminal?.placeholders, [{
    name: "trigger.summary",
    text: "Started by hand.",
    bytes: "Started by hand.".length,
    truncated: false,
  }], "the receipt records exactly what work-fold filled in");
  assert.equal(terminal?.messageBytes, "Started by hand. Say hello.".length);

  // In this sandbox the management turn settles on its own (the hop records
  // `succeeded` with a real conversation id). Without prepared management
  // instructions the hop would instead fail honestly, so both branches are
  // asserted; what must hold either way is that a *new* management thread
  // carries the filled-in message as its first person-visible message.
  if (terminal?.conversationId) {
    const transcript = await readFile(
      join(workFoldManagementRoot(), ".work-fold", "conversations", `${terminal.conversationId}.jsonl`),
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
