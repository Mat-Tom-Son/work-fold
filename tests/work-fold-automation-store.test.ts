import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  workFoldOverviewAutomationReceiptsFile,
  workFoldOverviewAutomationReceiptsRotatedFile,
} from "../src/local/overview.js";
import {
  normalizeWorkFoldAutomationDeclaration,
  workFoldAutomationBounds,
  workFoldAutomationDigest,
} from "../src/local/automations/automation-declarations.js";
import {
  WorkFoldAutomationReceipts,
  WorkFoldAutomationStore,
  WorkFoldAutomationStoreError,
  workFoldAutomationReceiptsFile,
  workFoldAutomationReceiptsRotatedFile,
  type WorkFoldAutomationEnableInput,
  type WorkFoldAutomationReceiptV1,
} from "../src/local/automations/automation-store.js";

const workFolderA = "space-aaaaaaaaaaaaaaaa";
const workFolderB = "space-bbbbbbbbbbbbbbbb";
const workFolderC = "space-cccccccccccccccc";
const fixedNow = new Date("2026-08-10T17:00:00.000Z");

function declarationInput(id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "work-fold.automation",
    version: 1,
    id,
    title: `Automation ${id}`,
    createdBy: "assistant",
    createdAt: "2026-08-01T00:00:00.000Z",
    trigger: { kind: "interval", intervalMinutes: 60 },
    steps: [{ id: "notify", kind: "chat", workFolder: workFolderA, message: "Review the queue." }],
    ...overrides,
  };
}

function enableInput(raw: unknown, requestId: string): WorkFoldAutomationEnableInput {
  const declaration = normalizeWorkFoldAutomationDeclaration(raw);
  return {
    declaration,
    expectedDigest: workFoldAutomationDigest(declaration),
    grant: { requestId, surface: "popover" },
  };
}

async function createSandbox(prefix: string): Promise<{
  sandbox: string;
  receipts: WorkFoldAutomationReceipts;
  store: WorkFoldAutomationStore;
  statePath: string;
  journalPath: string;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), prefix));
  const journalPath = join(sandbox, "automations", "receipts.jsonl");
  const statePath = join(sandbox, "automations", "automations.json");
  const receipts = new WorkFoldAutomationReceipts({ path: journalPath, now: () => fixedNow });
  const store = await WorkFoldAutomationStore.create({ path: statePath, receipts, now: () => fixedNow });
  return { sandbox, receipts, store, statePath, journalPath };
}

async function readJournal(path: string): Promise<WorkFoldAutomationReceiptV1[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as WorkFoldAutomationReceiptV1);
}

test("the receipts journal path is the exact contract the overview's tolerant reader consumes", () => {
  const root = join(tmpdir(), "automation-path-contract");
  assert.equal(workFoldAutomationReceiptsFile(root), workFoldOverviewAutomationReceiptsFile(root));
  assert.equal(workFoldAutomationReceiptsRotatedFile(root), workFoldOverviewAutomationReceiptsRotatedFile(root));
});

test("enable is journal-first exact-digest authority: declaration and enable receipt commit together", async (t) => {
  const { sandbox, store, statePath, journalPath } = await createSandbox("work-fold-automation-store-enable-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const record = await store.enable(enableInput(declarationInput("automation-weekly-handoff"), "request-1"));
  assert.equal(record.health, "enabled");
  assert.equal(record.digest, workFoldAutomationDigest(record.declaration));
  assert.deepEqual(record.grants, [{
    digest: record.digest,
    requestId: "request-1",
    enabledAt: fixedNow.toISOString(),
    surface: "popover",
  }]);
  assert.equal(record.lastScheduledAt, fixedNow.toISOString(), "an interval enablement anchors its cadence at enable time");

  const journal = await readJournal(journalPath);
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.scope, "automation");
  assert.equal(journal[0]?.outcome, "enabled");
  assert.equal(journal[0]?.digest, record.digest);
  assert.equal(journal[0]?.requestId, "request-1");
  assert.equal(journal[0]?.decisionId, undefined, "receipts-not-gates: nothing writes a decision id any more");
  assert.equal(journal[0]?.surface, "popover");

  const reloaded = await WorkFoldAutomationStore.create({ path: statePath, now: () => fixedNow });
  assert.deepEqual(await reloaded.list(), [record], "the enablement round-trips through the durable state file");

  await assert.rejects(
    () => store.enable({ ...enableInput(declarationInput("automation-weekly-handoff"), "request-2"), expectedDigest: "0".repeat(64) }),
    (error: unknown) => error instanceof WorkFoldAutomationStoreError && error.code === "DIGEST_MISMATCH",
    "a declaration that does not hash to the pinned digest is refused",
  );
  for (const surface of ["policy", "unrestricted"] as const) {
    await assert.rejects(
      () => store.enable({
        ...enableInput(declarationInput("automation-weekly-handoff"), "request-3"),
        grant: { requestId: "request-3", surface: surface as never },
      }),
      (error: unknown) => error instanceof WorkFoldAutomationStoreError && error.code === "INPUT_INVALID"
        && /act surface/.test(error.message),
      `a legacy ${surface} surface is never written again`,
    );
  }
  await assert.rejects(
    () => store.enable({
      ...enableInput(declarationInput("automation-weekly-handoff"), "request-4"),
      grant: { requestId: "request-4", surface: "remote_web" },
    }),
    (error: unknown) => error instanceof WorkFoldAutomationStoreError && error.code === "INPUT_INVALID",
    "a remote enablement must record the paired browser identity",
  );
  const remote = await store.enable({
    ...enableInput(declarationInput("automation-weekly-handoff"), "request-5"),
    grant: { requestId: "request-5", surface: "remote_web", browserId: "browser-1" },
  });
  assert.equal(remote.grants.length, 2, "re-enablement appends a fresh receipt instead of rewriting history");
  assert.deepEqual(remote.grants[1], {
    digest: remote.digest,
    requestId: "request-5",
    enabledAt: fixedNow.toISOString(),
    surface: "remote_web",
    browserId: "browser-1",
  });
});

test("an unwritable journal refuses enablement before any state changes", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-automation-store-journal-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await writeFile(join(sandbox, "blocker"), "a file where the journal directory must go", "utf8");
  const receipts = new WorkFoldAutomationReceipts({ path: join(sandbox, "blocker", "receipts.jsonl") });
  const statePath = join(sandbox, "automations.json");
  const store = await WorkFoldAutomationStore.create({ path: statePath, receipts, now: () => fixedNow });

  await assert.rejects(
    () => store.enable(enableInput(declarationInput("automation-weekly-handoff"), "decision-1")),
    (error: unknown) => error instanceof WorkFoldAutomationStoreError && error.code === "JOURNAL_UNAVAILABLE",
  );
  assert.equal(await stat(statePath).catch(() => null), null, "a refused enablement leaves no authority state behind");
});

test("stores more than the former machine automation cap and reloads the saved declarations", async (t) => {
  const { sandbox, store } = await createSandbox("work-fold-automation-store-bound-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  for (let index = 0; index < 33; index += 1) {
    await store.enable(enableInput(declarationInput(`automation-bound-${String(index).padStart(4, "0")}`), `decision-${index}`));
  }
  assert.equal((await store.list()).length, 33);
  const reloaded = await WorkFoldAutomationStore.create({ path: join(sandbox, "automations", "automations.json"), now: () => fixedNow });
  assert.equal((await reloaded.list()).length, 33, "saved declarations beyond the former cap remain valid");
  const again = await store.enable(enableInput(declarationInput("automation-bound-0000"), "decision-again"));
  assert.equal(again.grants.length, 2, "re-enabling an existing automation never counts against the machine bound");
});

test("disable narrows and delete removes only inert automations; receipts survive the object", async (t) => {
  const { sandbox, store, journalPath } = await createSandbox("work-fold-automation-store-lifecycle-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const record = await store.enable(enableInput(declarationInput("automation-weekly-handoff"), "decision-1"));
  await assert.rejects(
    () => store.delete("automation-weekly-handoff"),
    (error: unknown) => error instanceof WorkFoldAutomationStoreError && error.code === "HEALTH_INVALID" && error.health === "enabled",
    "an enabled automation must be disabled before deletion so revocation stops stale work first",
  );

  const disabled = await store.disable("automation-weekly-handoff");
  assert.equal(disabled.health, "disabled");
  assert.equal(disabled.disabledAt, fixedNow.toISOString());
  assert.deepEqual(disabled.grants, record.grants, "disable never destroys the grant history");
  await assert.rejects(
    () => store.disable("automation-weekly-handoff"),
    (error: unknown) => error instanceof WorkFoldAutomationStoreError && error.code === "HEALTH_INVALID" && error.health === "disabled",
  );

  const deleted = await store.delete("automation-weekly-handoff");
  assert.equal(deleted.declaration.id, "automation-weekly-handoff");
  assert.equal(await store.get("automation-weekly-handoff"), undefined);
  await assert.rejects(
    () => store.delete("automation-weekly-handoff"),
    (error: unknown) => error instanceof WorkFoldAutomationStoreError && error.code === "NOT_FOUND",
  );

  const outcomes = (await readJournal(journalPath)).map((line) => `${line.scope}:${line.outcome}`);
  assert.deepEqual(outcomes, ["automation:enabled", "automation:disabled", "automation:deleted"], "audit records survive the object");
});

test("work-folder removal suspends exactly the enabled automations that reference it, durably and cumulatively", async (t) => {
  const { sandbox, store, statePath } = await createSandbox("work-fold-automation-store-suspend-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const crossWorkFolder = declarationInput("automation-cross-work-folder", {
    steps: [
      { id: "review", kind: "chat", workFolder: workFolderA, message: "Review chapters for unresolved notes." },
      { id: "handoff", kind: "files", fromWorkFolder: workFolderA, from: { kind: "paths", paths: ["reports/weekly.md"] }, toWorkFolder: workFolderB, to: "Incoming" },
    ],
  });
  await store.enable(enableInput(crossWorkFolder, "decision-1"));
  await store.enable(enableInput(declarationInput("automation-unrelated", {
    steps: [{ id: "notify", kind: "chat", workFolder: workFolderC, message: "Tidy the inbox." }],
  }), "decision-2"));
  await store.enable(enableInput(declarationInput("automation-disabled-ref"), "decision-3"));
  await store.disable("automation-disabled-ref");

  const first = await store.suspendForWorkFolderRemoval(workFolderA, fixedNow);
  assert.deepEqual(first.suspended.map((record) => record.declaration.id), ["automation-cross-work-folder"]);
  assert.deepEqual(first.noted, []);
  assert.deepEqual(first.suspended[0]?.suspension, {
    at: fixedNow.toISOString(),
    missingWorkFolderIds: [workFolderA],
    reRegisteredWorkFolderIds: [],
  });
  assert.equal(first.suspended[0]?.lastScheduledAt, undefined, "suspension revokes the cadence anchor with the grant");
  assert.equal((await store.get("automation-unrelated"))?.health, "enabled", "automations that never reference the work-folder are untouched");
  assert.equal((await store.get("automation-disabled-ref"))?.health, "disabled", "a disabled automation holds no grant to revoke");

  const second = await store.suspendForWorkFolderRemoval(workFolderB, fixedNow);
  assert.deepEqual(second.suspended, []);
  assert.deepEqual(second.noted.map((record) => record.declaration.id), ["automation-cross-work-folder"]);
  assert.deepEqual(second.noted[0]?.suspension?.missingWorkFolderIds, [workFolderA, workFolderB]);

  const noted = await store.noteWorkFolderReRegistered(workFolderA);
  assert.deepEqual(noted[0]?.suspension?.reRegisteredWorkFolderIds, [workFolderA], "re-registration is copy-level detail");
  assert.equal(noted[0]?.health, "suspended", "registration never silently re-arms standing behavior");
  assert.deepEqual(await store.noteWorkFolderReRegistered(workFolderA), [], "the note is recorded once");

  await assert.rejects(
    () => store.disable("automation-cross-work-folder"),
    (error: unknown) => error instanceof WorkFoldAutomationStoreError && error.code === "HEALTH_INVALID" && error.health === "suspended",
    "there is no enablement left to disable on a suspended automation",
  );

  const reloaded = await WorkFoldAutomationStore.create({ path: statePath, now: () => fixedNow });
  assert.equal((await reloaded.get("automation-cross-work-folder"))?.health, "suspended", "suspension is durable across restarts");

  const reEnabled = await store.enable(enableInput(crossWorkFolder, "decision-fresh"));
  assert.equal(reEnabled.health, "enabled");
  assert.equal(reEnabled.suspension, undefined, "leaving suspension is a fresh receipted enablement over the unchanged declaration");
  assert.equal(reEnabled.grants.length, 2);
});

test("the cadence anchor persists for enabled interval automations only", async (t) => {
  const { sandbox, store, statePath } = await createSandbox("work-fold-automation-store-cadence-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  await store.enable(enableInput(declarationInput("automation-weekly-handoff"), "decision-1"));
  assert.equal(await store.recordCadence("automation-weekly-handoff", "2026-08-10T18:00:00.000Z"), true);
  const reloaded = await WorkFoldAutomationStore.create({ path: statePath, now: () => fixedNow });
  assert.equal((await reloaded.get("automation-weekly-handoff"))?.lastScheduledAt, "2026-08-10T18:00:00.000Z");

  assert.equal(await store.recordCadence("automation-missing", "2026-08-10T18:00:00.000Z"), false);
  await store.disable("automation-weekly-handoff");
  assert.equal(await store.recordCadence("automation-weekly-handoff", "2026-08-10T19:00:00.000Z"), false, "a disabled automation keeps no advancing cadence");
  await assert.rejects(
    () => store.recordCadence("automation-weekly-handoff", "not-a-time"),
    (error: unknown) => error instanceof WorkFoldAutomationStoreError && error.code === "INPUT_INVALID",
  );
});

test("one-time enablement rechecks its admission horizon and a durable claim completes exactly one occurrence", async (t) => {
  const { sandbox, receipts, store, statePath, journalPath } = await createSandbox("work-fold-automation-store-at-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const atDeclaration = (id: string, at: string) => declarationInput(id, {
    version: 2,
    trigger: { kind: "at", at, ifMissed: "run" },
  });

  await assert.rejects(
    () => store.enable(enableInput(atDeclaration("automation-at-too-soon", new Date(fixedNow.getTime() + workFoldAutomationBounds.minAtAdvanceMs - 1).toISOString()), "decision-too-soon")),
    /in the future, and at most ten years ahead/,
  );
  await assert.rejects(
    () => store.enable(enableInput(atDeclaration("automation-at-too-far", new Date(fixedNow.getTime() + workFoldAutomationBounds.maxAtAdvanceMs + 1).toISOString()), "decision-too-far")),
    /in the future, and at most ten years ahead/,
  );

  const enabled = await store.enable(enableInput(
    atDeclaration("automation-at-once1", "2026-08-10T17:01:00.000Z"),
    "decision-at",
  ));
  assert.equal(enabled.health, "enabled");
  assert.equal(enabled.lastScheduledAt, undefined);
  const claimed = await store.claimAtOccurrence(
    "automation-at-once1",
    "2026-08-10T17:01:00.000Z",
    "run-at-1",
    new Date("2026-08-10T17:01:00.000Z"),
  );
  assert.equal(claimed?.health, "completed");
  assert.match(claimed?.atOccurrence?.occurrenceId ?? "", /^at-[a-f0-9]{32}$/);
  assert.equal(claimed?.atOccurrence?.runId, "run-at-1");
  assert.equal(await store.claimAtOccurrence(
    "automation-at-once1",
    "2026-08-10T17:01:00.000Z",
    "run-at-2",
  ), null, "the completed health transition is the single-fire gate");
  assert.equal(await store.finishAtOccurrence(
    "automation-at-once1",
    "run-at-1",
    "2026-08-10T17:01:05.000Z",
  ), true);

  const reloaded = await WorkFoldAutomationStore.create({ path: statePath, receipts, now: () => fixedNow });
  const durable = await reloaded.get("automation-at-once1");
  assert.equal(durable?.health, "completed");
  assert.equal(durable?.atOccurrence?.finishedAt, "2026-08-10T17:01:05.000Z");
  await assert.rejects(
    () => reloaded.disable("automation-at-once1"),
    (error: unknown) => error instanceof WorkFoldAutomationStoreError
      && error.code === "HEALTH_INVALID"
      && error.health === "completed",
  );
  await reloaded.delete("automation-at-once1", { requestId: "request-delete-at", surface: "main-window" });
  const deleted = (await readJournal(journalPath)).at(-1);
  assert.equal(deleted?.requestId, "request-delete-at");
  assert.equal(deleted?.surface, "main-window");
});

test("schema 1 and 2 stores load into the version 3 writer, converting the grants an older build wrote", async (t) => {
  const { sandbox, store, statePath, receipts, journalPath } = await createSandbox("work-fold-automation-store-v1-upgrade-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await store.enable(enableInput(declarationInput("automation-v1-upgrade"), "request-v1"));
  const legacy = JSON.parse(await readFile(statePath, "utf8")) as {
    schemaVersion: number;
    automations: Array<{ digest: string; grants: unknown[] }>;
  };
  legacy.schemaVersion = 2;
  // Exactly what a pre-receipts-not-gates build wrote: a decision-shaped
  // grant, including the surface an Unrestricted-mode execution recorded.
  legacy.automations[0]!.grants = [
    {
      digest: legacy.automations[0]!.digest,
      decisionId: "decision-v0",
      approvedAt: fixedNow.toISOString(),
      surface: "unrestricted",
    },
    {
      digest: legacy.automations[0]!.digest,
      decisionId: "decision-v1",
      approvedAt: fixedNow.toISOString(),
      surface: "remote_web",
      browserId: "browser-1",
      browserGrantId: "grant-1",
    },
  ];
  await writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const upgraded = await WorkFoldAutomationStore.create({ path: statePath, receipts, now: () => fixedNow });
  assert.equal(upgraded.status().damaged, false, "an older state file still opens");
  assert.deepEqual((await upgraded.list())[0]?.grants, [
    {
      digest: legacy.automations[0]!.digest,
      requestId: "decision-v0",
      enabledAt: fixedNow.toISOString(),
      surface: "unrestricted",
    },
    {
      // The browser grant id a decision card carried is dropped; the paired
      // browser identity stays.
      digest: legacy.automations[0]!.digest,
      requestId: "decision-v1",
      enabledAt: fixedNow.toISOString(),
      surface: "remote_web",
      browserId: "browser-1",
    },
  ]);
  await upgraded.disable("automation-v1-upgrade");
  const rewritten = JSON.parse(await readFile(statePath, "utf8")) as { schemaVersion: number };
  assert.equal(rewritten.schemaVersion, 3, "the first commit rewrites the file at the current schema version");
  assert.equal((await readJournal(journalPath)).at(-1)?.outcome, "disabled");

  const schema1 = JSON.parse(await readFile(statePath, "utf8")) as { schemaVersion: number };
  schema1.schemaVersion = 1;
  const schema1Path = join(sandbox, "automations", "schema1.json");
  await writeFile(schema1Path, `${JSON.stringify(schema1, null, 2)}\n`, "utf8");
  const oldest = await WorkFoldAutomationStore.create({ path: schema1Path, receipts, now: () => fixedNow });
  assert.equal(oldest.status().damaged, false);
});

test("damaged or tampered state disables the store and is never overwritten", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-automation-store-damage-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const receipts = new WorkFoldAutomationReceipts({ path: join(sandbox, "receipts.jsonl") });

  const unreadablePath = join(sandbox, "unreadable.json");
  await writeFile(unreadablePath, "{not json", "utf8");
  const unreadable = await WorkFoldAutomationStore.create({ path: unreadablePath, receipts });
  assert.equal(unreadable.status().damaged, true);
  await assert.rejects(
    () => unreadable.enable(enableInput(declarationInput("automation-weekly-handoff"), "decision-1")),
    (error: unknown) => error instanceof WorkFoldAutomationStoreError && error.code === "STORE_DAMAGED",
  );
  await assert.rejects(
    () => unreadable.list(),
    (error: unknown) => error instanceof WorkFoldAutomationStoreError && error.code === "STORE_DAMAGED",
  );
  assert.equal(await readFile(unreadablePath, "utf8"), "{not json", "damaged state is preserved for inspection, never overwritten");

  const futurePath = join(sandbox, "future.json");
  await writeFile(futurePath, JSON.stringify({ schemaVersion: 99, automations: [] }), "utf8");
  const future = await WorkFoldAutomationStore.create({ path: futurePath, receipts });
  assert.match(future.status().damageReason ?? "", /newer work-fold/);

  const goodPath = join(sandbox, "good.json");
  const goodReceipts = new WorkFoldAutomationReceipts({ path: join(sandbox, "good-receipts.jsonl") });
  const good = await WorkFoldAutomationStore.create({ path: goodPath, receipts: goodReceipts, now: () => fixedNow });
  await good.enable(enableInput(declarationInput("automation-weekly-handoff"), "decision-1"));
  const persisted = JSON.parse(await readFile(goodPath, "utf8")) as { automations: Array<{ digest: string }> };
  persisted.automations[0]!.digest = "f".repeat(64);
  await writeFile(goodPath, JSON.stringify(persisted), "utf8");
  const tampered = await WorkFoldAutomationStore.create({ path: goodPath, receipts: goodReceipts });
  assert.equal(tampered.status().damaged, true, "digest-mismatched authority never loads");
  assert.match(tampered.status().damageReason ?? "", /digest does not match/);
});

test("journal rotation waits for open runs, and the recovery scan fails closed on damage", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-automation-receipts-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const path = join(sandbox, "receipts.jsonl");
  const rotatedPath = join(sandbox, "receipts.1.jsonl");
  const receipts = new WorkFoldAutomationReceipts({ path, rotatedPath, maxBytes: 600, now: () => fixedNow });

  assert.equal(await receipts.append({ scope: "run", outcome: "accepted", automationId: "automation-weekly-handoff", runId: "run-1" }), true);
  assert.equal(await receipts.append({ scope: "hop", outcome: "accepted", automationId: "automation-weekly-handoff", runId: "run-1", hopId: "notify" }), true);
  for (let index = 0; index < 6; index += 1) {
    await receipts.append({ scope: "automation", outcome: "enabled", automationId: `automation-filler-${String(index).padStart(4, "0")}` });
  }
  assert.equal(await stat(rotatedPath).catch(() => null), null, "rotation waits while run-1 is still open");
  assert.deepEqual(await receipts.scanOpenRuns(), [
    { automationId: "automation-weekly-handoff", runId: "run-1", openHopIds: ["notify"] },
  ]);

  await receipts.append({ scope: "hop", outcome: "succeeded", automationId: "automation-weekly-handoff", runId: "run-1", hopId: "notify" });
  await receipts.append({ scope: "run", outcome: "succeeded", automationId: "automation-weekly-handoff", runId: "run-1" });
  await receipts.append({ scope: "automation", outcome: "enabled", automationId: "automation-after-close" });
  assert.notEqual(await stat(rotatedPath).catch(() => null), null, "a closed journal over the size bound rotates");
  assert.deepEqual(await receipts.scanOpenRuns(), [], "the scan reads the rotated and live files together");

  await writeFile(path, `${await readFile(path, "utf8")}not-json\n`, "utf8");
  await assert.rejects(
    () => receipts.scanOpenRuns(),
    (error: unknown) => error instanceof WorkFoldAutomationStoreError && error.code === "JOURNAL_DAMAGED",
    "an unreadable journal line refuses recovery instead of guessing",
  );
});

test("suspension persists even when its journal line cannot be written: revocation is never blocked", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-automation-store-narrow-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const journalPath = join(sandbox, "receipts.jsonl");
  const receipts = new WorkFoldAutomationReceipts({ path: journalPath, now: () => fixedNow });
  const statePath = join(sandbox, "automations.json");
  const store = await WorkFoldAutomationStore.create({ path: statePath, receipts, now: () => fixedNow });
  await store.enable(enableInput(declarationInput("automation-weekly-handoff"), "decision-1"));

  // Replace the journal with a directory so every further append fails.
  await rm(journalPath, { force: true });
  await mkdir(journalPath);

  const { suspended } = await store.suspendForWorkFolderRemoval(workFolderA, fixedNow);
  assert.deepEqual(suspended.map((record) => record.declaration.id), ["automation-weekly-handoff"]);
  const reloaded = await WorkFoldAutomationStore.create({ path: statePath, now: () => fixedNow });
  assert.equal((await reloaded.get("automation-weekly-handoff"))?.health, "suspended", "narrowing persisted without its receipt line");

  await assert.rejects(
    () => store.delete("automation-weekly-handoff"),
    (error: unknown) => error instanceof WorkFoldAutomationStoreError && error.code === "JOURNAL_UNAVAILABLE",
    "deletion destroys the audit anchor, so it stays strictly journal-first",
  );
  assert.equal((await store.get("automation-weekly-handoff"))?.health, "suspended");
});
