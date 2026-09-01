import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  workFoldGlanceRoutingReceiptsFile,
  workFoldGlanceRoutingReceiptsRotatedFile,
} from "../src/local/glance.js";
import {
  normalizeWorkFoldRoutingDeclaration,
  workFoldRoutingBounds,
  workFoldRoutingDigest,
} from "../src/local/routings/routing-declarations.js";
import {
  WorkFoldRoutingReceipts,
  WorkFoldRoutingStore,
  WorkFoldRoutingStoreError,
  workFoldRoutingReceiptsFile,
  workFoldRoutingReceiptsRotatedFile,
  type WorkFoldRoutingEnableInput,
  type WorkFoldRoutingReceiptV1,
} from "../src/local/routings/routing-store.js";

const spaceA = "space-aaaaaaaaaaaaaaaa";
const spaceB = "space-bbbbbbbbbbbbbbbb";
const spaceC = "space-cccccccccccccccc";
const fixedNow = new Date("2026-08-10T17:00:00.000Z");

function declarationInput(id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "work-fold.routing",
    version: 1,
    id,
    title: `Routing ${id}`,
    createdBy: "assistant",
    createdAt: "2026-08-01T00:00:00.000Z",
    trigger: { kind: "interval", intervalMinutes: 60 },
    steps: [{ id: "notify", kind: "chat", space: spaceA, message: "Review the queue." }],
    ...overrides,
  };
}

function enableInput(raw: unknown, decisionId: string): WorkFoldRoutingEnableInput {
  const declaration = normalizeWorkFoldRoutingDeclaration(raw);
  return {
    declaration,
    expectedDigest: workFoldRoutingDigest(declaration),
    decision: { decisionId, surface: "popover" },
  };
}

async function createSandbox(prefix: string): Promise<{
  sandbox: string;
  receipts: WorkFoldRoutingReceipts;
  store: WorkFoldRoutingStore;
  statePath: string;
  journalPath: string;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), prefix));
  const journalPath = join(sandbox, "routings", "receipts.jsonl");
  const statePath = join(sandbox, "routings", "routings.json");
  const receipts = new WorkFoldRoutingReceipts({ path: journalPath, now: () => fixedNow });
  const store = await WorkFoldRoutingStore.create({ path: statePath, receipts, now: () => fixedNow });
  return { sandbox, receipts, store, statePath, journalPath };
}

async function readJournal(path: string): Promise<WorkFoldRoutingReceiptV1[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as WorkFoldRoutingReceiptV1);
}

test("the receipts journal path is the exact contract the glance's tolerant reader consumes", () => {
  const root = join(tmpdir(), "routing-path-contract");
  assert.equal(workFoldRoutingReceiptsFile(root), workFoldGlanceRoutingReceiptsFile(root));
  assert.equal(workFoldRoutingReceiptsRotatedFile(root), workFoldGlanceRoutingReceiptsRotatedFile(root));
});

test("enable is journal-first exact-digest authority: declaration and grant commit together", async (t) => {
  const { sandbox, store, statePath, journalPath } = await createSandbox("work-fold-routing-store-enable-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const record = await store.enable(enableInput(declarationInput("routing-weekly-handoff"), "decision-1"));
  assert.equal(record.health, "enabled");
  assert.equal(record.digest, workFoldRoutingDigest(record.declaration));
  assert.deepEqual(record.grants, [{
    digest: record.digest,
    decisionId: "decision-1",
    approvedAt: fixedNow.toISOString(),
    surface: "popover",
  }]);
  assert.equal(record.lastScheduledAt, fixedNow.toISOString(), "an interval enablement anchors its cadence at enable time");

  const journal = await readJournal(journalPath);
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.scope, "routing");
  assert.equal(journal[0]?.outcome, "enabled");
  assert.equal(journal[0]?.digest, record.digest);
  assert.equal(journal[0]?.decisionId, "decision-1");
  assert.equal(journal[0]?.surface, "popover");

  const reloaded = await WorkFoldRoutingStore.create({ path: statePath, now: () => fixedNow });
  assert.deepEqual(await reloaded.list(), [record], "the enablement round-trips through the durable state file");

  await assert.rejects(
    () => store.enable({ ...enableInput(declarationInput("routing-weekly-handoff"), "decision-2"), expectedDigest: "0".repeat(64) }),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "DIGEST_MISMATCH",
    "a declaration that does not hash to the reviewed digest is refused",
  );
  await assert.rejects(
    () => store.enable({
      ...enableInput(declarationInput("routing-weekly-handoff"), "decision-3"),
      decision: { decisionId: "decision-3", surface: "policy" },
    }),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "INPUT_INVALID"
      && /not policy-eligible/.test(error.message),
    "routing.enable always takes the unforgeable human click",
  );
  await assert.rejects(
    () => store.enable({
      ...enableInput(declarationInput("routing-weekly-handoff"), "decision-4"),
      decision: { decisionId: "decision-4", surface: "remote_web" },
    }),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "INPUT_INVALID",
    "a remote decision must record the approving browser identity",
  );
  const remote = await store.enable({
    ...enableInput(declarationInput("routing-weekly-handoff"), "decision-5"),
    decision: { decisionId: "decision-5", surface: "remote_web", browserId: "browser-1", browserGrantId: "grant-1" },
  });
  assert.equal(remote.grants.length, 2, "re-enablement appends a fresh grant instead of rewriting history");
  assert.deepEqual(remote.grants[1], {
    digest: remote.digest,
    decisionId: "decision-5",
    approvedAt: fixedNow.toISOString(),
    surface: "remote_web",
    browserId: "browser-1",
    browserGrantId: "grant-1",
  });
});

test("an unwritable journal refuses enablement before any state changes", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-routing-store-journal-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await writeFile(join(sandbox, "blocker"), "a file where the journal directory must go", "utf8");
  const receipts = new WorkFoldRoutingReceipts({ path: join(sandbox, "blocker", "receipts.jsonl") });
  const statePath = join(sandbox, "routings.json");
  const store = await WorkFoldRoutingStore.create({ path: statePath, receipts, now: () => fixedNow });

  await assert.rejects(
    () => store.enable(enableInput(declarationInput("routing-weekly-handoff"), "decision-1")),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "JOURNAL_UNAVAILABLE",
  );
  assert.equal(await stat(statePath).catch(() => null), null, "a refused enablement leaves no authority state behind");
});

test("the 32-routing machine bound applies to new ids at enablement, not to re-enablement", async (t) => {
  const { sandbox, store } = await createSandbox("work-fold-routing-store-bound-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  for (let index = 0; index < workFoldRoutingBounds.maxRoutingsPerMachine; index += 1) {
    await store.enable(enableInput(declarationInput(`routing-bound-${String(index).padStart(4, "0")}`), `decision-${index}`));
  }
  await assert.rejects(
    () => store.enable(enableInput(declarationInput("routing-bound-overflow"), "decision-33")),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "BOUND_EXCEEDED",
  );
  const again = await store.enable(enableInput(declarationInput("routing-bound-0000"), "decision-again"));
  assert.equal(again.grants.length, 2, "re-consecrating an existing routing never counts against the machine bound");
});

test("disable narrows and delete removes only inert routings; receipts survive the object", async (t) => {
  const { sandbox, store, journalPath } = await createSandbox("work-fold-routing-store-lifecycle-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const record = await store.enable(enableInput(declarationInput("routing-weekly-handoff"), "decision-1"));
  await assert.rejects(
    () => store.delete("routing-weekly-handoff"),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "HEALTH_INVALID" && error.health === "enabled",
    "an enabled routing must be disabled before deletion so revocation stops stale work first",
  );

  const disabled = await store.disable("routing-weekly-handoff");
  assert.equal(disabled.health, "disabled");
  assert.equal(disabled.disabledAt, fixedNow.toISOString());
  assert.deepEqual(disabled.grants, record.grants, "disable never destroys the grant history");
  await assert.rejects(
    () => store.disable("routing-weekly-handoff"),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "HEALTH_INVALID" && error.health === "disabled",
  );

  const deleted = await store.delete("routing-weekly-handoff");
  assert.equal(deleted.declaration.id, "routing-weekly-handoff");
  assert.equal(await store.get("routing-weekly-handoff"), undefined);
  await assert.rejects(
    () => store.delete("routing-weekly-handoff"),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "NOT_FOUND",
  );

  const outcomes = (await readJournal(journalPath)).map((line) => `${line.scope}:${line.outcome}`);
  assert.deepEqual(outcomes, ["routing:enabled", "routing:disabled", "routing:deleted"], "audit records survive the object");
});

test("Space removal suspends exactly the enabled routings that reference it, durably and cumulatively", async (t) => {
  const { sandbox, store, statePath } = await createSandbox("work-fold-routing-store-suspend-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const crossSpace = declarationInput("routing-cross-space", {
    steps: [
      { id: "review", kind: "chat", space: spaceA, message: "Review chapters for unresolved notes." },
      { id: "handoff", kind: "files", fromSpace: spaceA, from: { kind: "paths", paths: ["reports/weekly.md"] }, toSpace: spaceB, to: "Incoming" },
    ],
  });
  await store.enable(enableInput(crossSpace, "decision-1"));
  await store.enable(enableInput(declarationInput("routing-unrelated", {
    steps: [{ id: "notify", kind: "chat", space: spaceC, message: "Tidy the inbox." }],
  }), "decision-2"));
  await store.enable(enableInput(declarationInput("routing-disabled-ref"), "decision-3"));
  await store.disable("routing-disabled-ref");

  const first = await store.suspendForSpaceRemoval(spaceA, fixedNow);
  assert.deepEqual(first.suspended.map((record) => record.declaration.id), ["routing-cross-space"]);
  assert.deepEqual(first.noted, []);
  assert.deepEqual(first.suspended[0]?.suspension, {
    at: fixedNow.toISOString(),
    missingSpaceIds: [spaceA],
    reRegisteredSpaceIds: [],
  });
  assert.equal(first.suspended[0]?.lastScheduledAt, undefined, "suspension revokes the cadence anchor with the grant");
  assert.equal((await store.get("routing-unrelated"))?.health, "enabled", "routings that never reference the Space are untouched");
  assert.equal((await store.get("routing-disabled-ref"))?.health, "disabled", "a disabled routing holds no grant to revoke");

  const second = await store.suspendForSpaceRemoval(spaceB, fixedNow);
  assert.deepEqual(second.suspended, []);
  assert.deepEqual(second.noted.map((record) => record.declaration.id), ["routing-cross-space"]);
  assert.deepEqual(second.noted[0]?.suspension?.missingSpaceIds, [spaceA, spaceB]);

  const noted = await store.noteSpaceReRegistered(spaceA);
  assert.deepEqual(noted[0]?.suspension?.reRegisteredSpaceIds, [spaceA], "re-registration is copy-level detail");
  assert.equal(noted[0]?.health, "suspended", "registration never silently re-arms standing behavior");
  assert.deepEqual(await store.noteSpaceReRegistered(spaceA), [], "the note is recorded once");

  await assert.rejects(
    () => store.disable("routing-cross-space"),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "HEALTH_INVALID" && error.health === "suspended",
    "there is no enablement left to disable on a suspended routing",
  );

  const reloaded = await WorkFoldRoutingStore.create({ path: statePath, now: () => fixedNow });
  assert.equal((await reloaded.get("routing-cross-space"))?.health, "suspended", "suspension is durable across restarts");

  const reEnabled = await store.enable(enableInput(crossSpace, "decision-fresh"));
  assert.equal(reEnabled.health, "enabled");
  assert.equal(reEnabled.suspension, undefined, "leaving suspension is a fresh consecration over the unchanged declaration");
  assert.equal(reEnabled.grants.length, 2);
});

test("the cadence anchor persists for enabled interval routings only", async (t) => {
  const { sandbox, store, statePath } = await createSandbox("work-fold-routing-store-cadence-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  await store.enable(enableInput(declarationInput("routing-weekly-handoff"), "decision-1"));
  assert.equal(await store.recordCadence("routing-weekly-handoff", "2026-08-10T18:00:00.000Z"), true);
  const reloaded = await WorkFoldRoutingStore.create({ path: statePath, now: () => fixedNow });
  assert.equal((await reloaded.get("routing-weekly-handoff"))?.lastScheduledAt, "2026-08-10T18:00:00.000Z");

  assert.equal(await store.recordCadence("routing-missing", "2026-08-10T18:00:00.000Z"), false);
  await store.disable("routing-weekly-handoff");
  assert.equal(await store.recordCadence("routing-weekly-handoff", "2026-08-10T19:00:00.000Z"), false, "a disabled routing keeps no advancing cadence");
  await assert.rejects(
    () => store.recordCadence("routing-weekly-handoff", "not-a-time"),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "INPUT_INVALID",
  );
});

test("one-time enablement rechecks the 1-minute to 366-day horizon and a durable claim completes exactly one occurrence", async (t) => {
  const { sandbox, receipts, store, statePath, journalPath } = await createSandbox("work-fold-routing-store-at-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const atDeclaration = (id: string, at: string) => declarationInput(id, {
    version: 2,
    trigger: { kind: "at", at, ifMissed: "run" },
  });

  await assert.rejects(
    () => store.enable(enableInput(atDeclaration("routing-at-too-soon", "2026-08-10T17:00:59.999Z"), "decision-too-soon")),
    /between 1 minute and 366 days/,
  );
  await assert.rejects(
    () => store.enable(enableInput(atDeclaration("routing-at-too-far", "2027-08-11T17:00:00.001Z"), "decision-too-far")),
    /between 1 minute and 366 days/,
  );

  const enabled = await store.enable(enableInput(
    atDeclaration("routing-at-once1", "2026-08-10T17:01:00.000Z"),
    "decision-at",
  ));
  assert.equal(enabled.health, "enabled");
  assert.equal(enabled.lastScheduledAt, undefined);
  const claimed = await store.claimAtOccurrence(
    "routing-at-once1",
    "2026-08-10T17:01:00.000Z",
    "run-at-1",
    new Date("2026-08-10T17:01:00.000Z"),
  );
  assert.equal(claimed?.health, "completed");
  assert.match(claimed?.atOccurrence?.occurrenceId ?? "", /^at-[a-f0-9]{32}$/);
  assert.equal(claimed?.atOccurrence?.runId, "run-at-1");
  assert.equal(await store.claimAtOccurrence(
    "routing-at-once1",
    "2026-08-10T17:01:00.000Z",
    "run-at-2",
  ), null, "the completed health transition is the single-fire gate");
  assert.equal(await store.finishAtOccurrence(
    "routing-at-once1",
    "run-at-1",
    "2026-08-10T17:01:05.000Z",
  ), true);

  const reloaded = await WorkFoldRoutingStore.create({ path: statePath, receipts, now: () => fixedNow });
  const durable = await reloaded.get("routing-at-once1");
  assert.equal(durable?.health, "completed");
  assert.equal(durable?.atOccurrence?.finishedAt, "2026-08-10T17:01:05.000Z");
  await assert.rejects(
    () => reloaded.disable("routing-at-once1"),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError
      && error.code === "HEALTH_INVALID"
      && error.health === "completed",
  );
  await reloaded.delete("routing-at-once1", { requestId: "request-delete-at", surface: "main-window" });
  const deleted = (await readJournal(journalPath)).at(-1);
  assert.equal(deleted?.requestId, "request-delete-at");
  assert.equal(deleted?.surface, "main-window");
});

test("schema 1 stores load into the version 2 writer while newer stores still fail closed", async (t) => {
  const { sandbox, store, statePath } = await createSandbox("work-fold-routing-store-v1-upgrade-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await store.enable(enableInput(declarationInput("routing-v1-upgrade"), "decision-v1"));
  const legacy = JSON.parse(await readFile(statePath, "utf8")) as { schemaVersion: number };
  legacy.schemaVersion = 1;
  await writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const upgraded = await WorkFoldRoutingStore.create({ path: statePath, now: () => fixedNow });
  assert.equal(upgraded.status().damaged, false);
  await upgraded.disable("routing-v1-upgrade");
  const rewritten = JSON.parse(await readFile(statePath, "utf8")) as { schemaVersion: number };
  assert.equal(rewritten.schemaVersion, 2);
});

test("damaged or tampered state disables the store and is never overwritten", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-routing-store-damage-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const receipts = new WorkFoldRoutingReceipts({ path: join(sandbox, "receipts.jsonl") });

  const unreadablePath = join(sandbox, "unreadable.json");
  await writeFile(unreadablePath, "{not json", "utf8");
  const unreadable = await WorkFoldRoutingStore.create({ path: unreadablePath, receipts });
  assert.equal(unreadable.status().damaged, true);
  await assert.rejects(
    () => unreadable.enable(enableInput(declarationInput("routing-weekly-handoff"), "decision-1")),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "STORE_DAMAGED",
  );
  await assert.rejects(
    () => unreadable.list(),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "STORE_DAMAGED",
  );
  assert.equal(await readFile(unreadablePath, "utf8"), "{not json", "damaged state is preserved for inspection, never overwritten");

  const futurePath = join(sandbox, "future.json");
  await writeFile(futurePath, JSON.stringify({ schemaVersion: 99, routings: [] }), "utf8");
  const future = await WorkFoldRoutingStore.create({ path: futurePath, receipts });
  assert.match(future.status().damageReason ?? "", /newer work-fold/);

  const goodPath = join(sandbox, "good.json");
  const goodReceipts = new WorkFoldRoutingReceipts({ path: join(sandbox, "good-receipts.jsonl") });
  const good = await WorkFoldRoutingStore.create({ path: goodPath, receipts: goodReceipts, now: () => fixedNow });
  await good.enable(enableInput(declarationInput("routing-weekly-handoff"), "decision-1"));
  const persisted = JSON.parse(await readFile(goodPath, "utf8")) as { routings: Array<{ digest: string }> };
  persisted.routings[0]!.digest = "f".repeat(64);
  await writeFile(goodPath, JSON.stringify(persisted), "utf8");
  const tampered = await WorkFoldRoutingStore.create({ path: goodPath, receipts: goodReceipts });
  assert.equal(tampered.status().damaged, true, "digest-mismatched authority never loads");
  assert.match(tampered.status().damageReason ?? "", /digest does not match/);
});

test("journal rotation waits for open runs, and the recovery scan fails closed on damage", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-routing-receipts-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const path = join(sandbox, "receipts.jsonl");
  const rotatedPath = join(sandbox, "receipts.1.jsonl");
  const receipts = new WorkFoldRoutingReceipts({ path, rotatedPath, maxBytes: 600, now: () => fixedNow });

  assert.equal(await receipts.append({ scope: "run", outcome: "accepted", routingId: "routing-weekly-handoff", runId: "run-1" }), true);
  assert.equal(await receipts.append({ scope: "hop", outcome: "accepted", routingId: "routing-weekly-handoff", runId: "run-1", hopId: "notify" }), true);
  for (let index = 0; index < 6; index += 1) {
    await receipts.append({ scope: "routing", outcome: "enabled", routingId: `routing-filler-${String(index).padStart(4, "0")}` });
  }
  assert.equal(await stat(rotatedPath).catch(() => null), null, "rotation waits while run-1 is still open");
  assert.deepEqual(await receipts.scanOpenRuns(), [
    { routingId: "routing-weekly-handoff", runId: "run-1", openHopIds: ["notify"] },
  ]);

  await receipts.append({ scope: "hop", outcome: "succeeded", routingId: "routing-weekly-handoff", runId: "run-1", hopId: "notify" });
  await receipts.append({ scope: "run", outcome: "succeeded", routingId: "routing-weekly-handoff", runId: "run-1" });
  await receipts.append({ scope: "routing", outcome: "enabled", routingId: "routing-after-close" });
  assert.notEqual(await stat(rotatedPath).catch(() => null), null, "a closed journal over the size bound rotates");
  assert.deepEqual(await receipts.scanOpenRuns(), [], "the scan reads the rotated and live files together");

  await writeFile(path, `${await readFile(path, "utf8")}not-json\n`, "utf8");
  await assert.rejects(
    () => receipts.scanOpenRuns(),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "JOURNAL_DAMAGED",
    "an unreadable journal line refuses recovery instead of guessing",
  );
});

test("suspension persists even when its journal line cannot be written: revocation is never blocked", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-routing-store-narrow-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const journalPath = join(sandbox, "receipts.jsonl");
  const receipts = new WorkFoldRoutingReceipts({ path: journalPath, now: () => fixedNow });
  const statePath = join(sandbox, "routings.json");
  const store = await WorkFoldRoutingStore.create({ path: statePath, receipts, now: () => fixedNow });
  await store.enable(enableInput(declarationInput("routing-weekly-handoff"), "decision-1"));

  // Replace the journal with a directory so every further append fails.
  await rm(journalPath, { force: true });
  await mkdir(journalPath);

  const { suspended } = await store.suspendForSpaceRemoval(spaceA, fixedNow);
  assert.deepEqual(suspended.map((record) => record.declaration.id), ["routing-weekly-handoff"]);
  const reloaded = await WorkFoldRoutingStore.create({ path: statePath, now: () => fixedNow });
  assert.equal((await reloaded.get("routing-weekly-handoff"))?.health, "suspended", "narrowing persisted without its receipt line");

  await assert.rejects(
    () => store.delete("routing-weekly-handoff"),
    (error: unknown) => error instanceof WorkFoldRoutingStoreError && error.code === "JOURNAL_UNAVAILABLE",
    "deletion destroys the audit anchor, so it stays strictly journal-first",
  );
  assert.equal((await store.get("routing-weekly-handoff"))?.health, "suspended");
});
