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

test("trusted Settings manages routings through staged authority with bounded run history and global receipts", async (t) => {
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
    decision: { decisionId: "decision-settings-fixture", surface: "main-window" },
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
  const staged = await api.routingSettings.stageEnable(declaration.id);
  assert.equal(staged.state, "staged", "Reviewed mode keeps routing enablement waiting for a person");
  const stagedAct = await api.stagedActs.get(staged.decisionId);
  assert.equal(stagedAct?.provenance.stagedVia, "desktop-settings");
  assert.match(stagedAct?.provenance.requestId ?? "", /^settings:/);
  const cardsResponse = await fetch(`${api.origin}/api/management/decisions`);
  assert.equal(cardsResponse.status, 200);
  const cards = (await cardsResponse.json()) as {
    decisions: Array<{ id: string; facts: Array<{ label: string; value: string }> }>;
  };
  const routingCard = cards.decisions.find((decision) => decision.id === staged.decisionId);
  assert.ok(routingCard);
  const routingFacts = new Map(routingCard.facts.map((fact) => [fact.label, fact.value]));
  assert.equal(routingFacts.get("Title"), "Settings handoff");
  assert.equal(routingFacts.get("Trigger"), "Manual only");
  assert.match(routingFacts.get("Step 1 · Files · handoff") ?? "", /Routing source/);
  assert.match(routingFacts.get("Step 1 · Files · handoff") ?? "", /notes\.txt/);
  assert.match(routingFacts.get("Step 1 · Files · handoff") ?? "", /Routing destination/);
  await api.foldDecisions.decide(staged.decisionId, { decision: "approved", surface: "main-window" });
  assert.equal((await api.routings.getRouting(declaration.id))?.health, "enabled");
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
  for (const command of ["routings.run", "routings.disable", "routings.stage", "routings.delete"]) {
    const entries = settingsActs.filter((entry) => entry.command === command);
    assert.ok(entries.some((entry) => entry.outcome === "accepted"), `${command} records acceptance first`);
    assert.ok(entries.some((entry) => entry.outcome === "ok"), `${command} records a terminal outcome`);
  }

  const domain = await jsonLines<WorkFoldRoutingReceiptV1>(domainPath);
  const runNow = domain.find((entry) => entry.scope === "run" && entry.outcome === "accepted" && entry.cause?.kind === "run-now");
  assert.equal(runNow?.surface, "main-window");
  assert.equal(runNow?.requestId, accepted.requestId);
});

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function jsonLines<T>(path: string): Promise<T[]> {
  await mkdir(dirname(path), { recursive: true });
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}
