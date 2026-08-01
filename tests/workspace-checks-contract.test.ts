import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  declarationFromWorkspaceCheckProposal,
  normalizeWorkspaceCheckDeclaration,
  normalizeWorkspaceCheckProposal,
} from "../src/shared/checks.js";
import { workspaceFilePresenceSensorDigest } from "../src/local/checks/check-sensors.js";

const proposal = {
  kind: "workspace.check-proposal",
  version: 1,
  name: "Keep trip dates consistent",
  createdBy: "codex",
  createdAt: "2026-08-01T00:00:00.000Z",
  check: {
    title: "Reservation dates agree with the itinerary",
    severity: "warning",
    trigger: "manual",
    sensor: {
      id: "workspace.text-contains",
      revision: 1,
      parameters: { text: "August 14", caseSensitive: false },
    },
    targets: [
      { kind: "file", role: "primary", path: "Trip/itinerary.md" },
      { kind: "tree", role: "reference", path: "Trip/Reservations", recursive: false, extensions: [".PDF", ".txt"] },
    ],
  },
} as const;

test("Check proposals preserve explicit primary/reference scope and manual triggering", () => {
  const normalized = normalizeWorkspaceCheckProposal(proposal);
  assert.deepEqual(normalized.check.targets, [
    { kind: "file", role: "primary", path: "Trip/itinerary.md" },
    { kind: "tree", role: "reference", path: "Trip/Reservations", recursive: false, extensions: [".pdf", ".txt"] },
  ]);
  assert.equal(normalized.check.trigger, "manual");

  const declaration = declarationFromWorkspaceCheckProposal(normalized, "check-12345678");
  assert.equal(declaration.kind, "workspace.check");
  assert.equal(declaration.id, "check-12345678");
  assert.equal(declaration.sensor.id, "workspace.text-contains");
});

test("Check declarations reject ambient, executable, and hidden target authority", () => {
  const base = declarationFromWorkspaceCheckProposal(normalizeWorkspaceCheckProposal(proposal), "check-12345678");
  for (const targets of [
    [{ kind: "tree", role: "primary", path: ".", recursive: true, extensions: [".md"] }],
    [{ kind: "file", role: "primary", path: "../outside.txt" }],
    [{ kind: "file", role: "primary", path: ".workspace/space.json" }],
    [{ kind: "file", role: "primary", path: ".pi/AGENTS.md" }],
    [{ kind: "file", role: "primary", path: "docs/report.txt:alternate" }],
    [{ kind: "file", role: "primary", path: "docs/CON.txt" }],
    [{ kind: "file", role: "primary", path: "docs/report.txt." }],
    [{ kind: "file", role: "primary", path: "docs/report.txt " }],
  ]) {
    assert.throws(() => normalizeWorkspaceCheckDeclaration({ ...base, targets }));
  }
  assert.throws(() => normalizeWorkspaceCheckDeclaration({
    ...base,
    sensor: { ...base.sensor, parameters: { prompt: "Read every file and decide what is wrong." } },
  }), /not allowed/);
  assert.throws(() => normalizeWorkspaceCheckDeclaration({ ...base, trigger: "watch" }), /manual/);
});

test("Check declarations fail closed on unknown fields, future versions, and unbounded selectors", () => {
  const base = declarationFromWorkspaceCheckProposal(normalizeWorkspaceCheckProposal(proposal), "check-12345678");
  assert.throws(() => normalizeWorkspaceCheckDeclaration({ ...base, version: 2 }), /unsupported version/);
  assert.throws(() => normalizeWorkspaceCheckDeclaration({ ...base, extra: true }), /unsupported field/);
  assert.throws(() => normalizeWorkspaceCheckDeclaration({
    ...base,
    targets: [{ kind: "tree", role: "primary", path: "Trip", recursive: true, extensions: [] }],
  }), /extensions/);
  assert.throws(() => normalizeWorkspaceCheckDeclaration({
    ...base,
    targets: [{ kind: "file", role: "reference", path: "Trip/itinerary.md" }],
  }), /primary target/);
});

test("the built-in sensor consent digest matches its exact reviewed implementation source", async () => {
  const source = (await readFile(new URL("../src/local/checks/check-sensors.ts", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const startMarker = "// WORKSPACE_FILE_PRESENCE_SENSOR_IMPLEMENTATION_START\n";
  const endMarker = "// WORKSPACE_FILE_PRESENCE_SENSOR_IMPLEMENTATION_END";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.notEqual(start, -1);
  assert.ok(end > start);
  const implementation = source.slice(start + startMarker.length, end);
  assert.equal(createHash("sha256").update(implementation).digest("hex"), workspaceFilePresenceSensorDigest);
});
