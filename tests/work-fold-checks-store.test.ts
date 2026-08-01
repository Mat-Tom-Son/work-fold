import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  declarationFromWorkFoldCheckProposal,
  normalizeWorkFoldCheckProposal,
} from "../src/shared/checks.js";
import { workFoldCheckDigest } from "../src/local/checks/check-integrity.js";
import { WorkFoldCheckStore } from "../src/local/checks/check-store.js";
import { workFoldFilePresenceSensorDigest } from "../src/local/checks/check-sensors.js";
import type { WorkFoldCheckRunRecord } from "../src/local/checks/check-types.js";

const now = "2026-08-01T00:00:00.000Z";
const sensorDigest = workFoldFilePresenceSensorDigest;
const declaration = declarationFromWorkFoldCheckProposal(normalizeWorkFoldCheckProposal({
  kind: "work-fold.check-proposal",
  version: 1,
  name: "Required itinerary",
  createdBy: "human",
  createdAt: now,
  check: {
    title: "The itinerary exists",
    severity: "warning",
    trigger: "manual",
    sensor: { id: "work-fold.file-presence", revision: 1, parameters: { expect: "present" } },
    targets: [{ kind: "file", role: "primary", path: "Trip/itinerary.pdf" }],
  },
}), "check-12345678");

test("Check authority is exact-digest machine state and disabling preserves its audit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "work-fold-check-store-"));
  const path = join(directory, "state.json");
  const store = await WorkFoldCheckStore.create("space-trip", { path });
  const digest = workFoldCheckDigest(declaration);

  const authorization = await store.authorize(declaration, digest, "human", sensorDigest, new Date(now));
  assert.equal(authorization.declarationDigest, digest);
  assert.equal(store.snapshot().revision, 1);
  assert.deepEqual(Object.keys(store.snapshot().authorizations), [declaration.id]);

  await store.decide({
    fingerprint: "finding-0123456789abcdef0123456789abcdef",
    decision: "defer",
    actor: "human",
    deferUntil: "2026-08-03T00:00:00.000Z",
    now: new Date(now),
  });
  assert.equal(await store.disable(declaration.id), true);
  assert.deepEqual(store.snapshot().authorizations, {});
  assert.equal(store.snapshot().decisions["finding-0123456789abcdef0123456789abcdef"]?.decision, "defer");

  const reloaded = await WorkFoldCheckStore.create("space-trip", { path });
  assert.deepEqual(reloaded.snapshot(), store.snapshot());
});

test("unfinished Check runs recover as interrupted and are never replayed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "work-fold-check-run-"));
  const path = join(directory, "state.json");
  const store = await WorkFoldCheckStore.create("space-trip", { path });
  const digest = workFoldCheckDigest(declaration);
  const accepted: WorkFoldCheckRunRecord = {
    id: "run-12345678",
    taskId: "check-task-12345678",
    checkIds: [declaration.id],
    authorities: [{
      checkId: declaration.id,
      declarationDigest: digest,
      sensorId: declaration.sensor.id,
      sensorRevision: declaration.sensor.revision,
      sensorDigest,
    }],
    limits: {
      maximumFiles: 100,
      maximumFileBytes: 10_000,
      maximumTotalBytes: 100_000,
      maximumFindings: 100,
      timeoutMs: 30_000,
    },
    startedAt: now,
    state: "accepted",
    inputs: [],
    findings: [],
    admittedCount: 0,
    discardedCount: 0,
    skippedCount: 0,
  };
  await store.acceptRun(accepted);
  await store.markRunRunning(accepted.id);

  const recovered = await WorkFoldCheckStore.create("space-trip", { path });
  const run = recovered.snapshot().runs[0]!;
  assert.equal(run.state, "interrupted");
  assert.ok(run.endedAt);
  assert.match(run.error ?? "", /not retried/i);
});

test("future and damaged Check authority state fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "work-fold-check-damaged-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({ version: 99, revision: 0, authorizations: {}, decisions: {}, runs: [] }));
  await assert.rejects(() => WorkFoldCheckStore.create("space-trip", { path }), /unsupported version/);

  await writeFile(path, "{ definitely-not-json");
  await assert.rejects(() => WorkFoldCheckStore.create("space-trip", { path }), /could not read Check state/);
  assert.equal(await readFile(path, "utf8"), "{ definitely-not-json");
});

test("backup recovery preserves the last known good backup while repairing primary state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "work-fold-check-backup-"));
  const path = join(directory, "state.json");
  const store = await WorkFoldCheckStore.create("space-trip", { path });
  const digest = workFoldCheckDigest(declaration);
  await store.authorize(declaration, digest, "human", sensorDigest, new Date(now));
  await store.decide({
    fingerprint: "finding-11111111111111111111111111111111",
    decision: "accept",
    actor: "human",
    now: new Date(now),
  });
  await writeFile(path, "{ damaged primary");

  const recovered = await WorkFoldCheckStore.create("space-trip", { path });
  assert.deepEqual(recovered.snapshot().authorizations, {}, "backup fallback must revoke possibly stale grants");
  await recovered.decide({
    fingerprint: "finding-22222222222222222222222222222222",
    decision: "resolve",
    actor: "human",
    now: new Date("2026-08-01T01:00:00.000Z"),
  });
  assert.deepEqual(JSON.parse(await readFile(`${path}.bak`, "utf8")).authorizations, {});
  assert.equal(JSON.parse(await readFile(path, "utf8")).decisions["finding-22222222222222222222222222222222"].decision, "resolve");
});

test("backup fallback never resurrects a disabled Check grant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "work-fold-check-revocation-backup-"));
  const path = join(directory, "state.json");
  const store = await WorkFoldCheckStore.create("space-trip", { path });
  const digest = workFoldCheckDigest(declaration);
  await store.authorize(declaration, digest, "human", sensorDigest, new Date(now));
  await store.disable(declaration.id);
  assert.ok(JSON.parse(await readFile(`${path}.bak`, "utf8")).authorizations[declaration.id], "fixture backup predates disable");
  await writeFile(path, "{ damaged newer primary");

  const recovered = await WorkFoldCheckStore.create("space-trip", { path });
  assert.deepEqual(recovered.snapshot().authorizations, {});
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).authorizations, {});
});

test("repeating an identical decision is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "work-fold-check-decision-idempotent-"));
  const store = await WorkFoldCheckStore.create("space-trip", { path: join(directory, "state.json") });
  const input = {
    fingerprint: "finding-33333333333333333333333333333333",
    decision: "reject" as const,
    actor: "human" as const,
    now: new Date(now),
  };
  const first = await store.decide(input);
  const revision = store.snapshot().revision;
  const second = await store.decide({ ...input, now: new Date("2026-08-02T00:00:00.000Z") });
  assert.deepEqual(second, first);
  assert.equal(store.snapshot().revision, revision);
});
