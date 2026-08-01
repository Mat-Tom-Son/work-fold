import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeWorkFoldCheckProposal } from "../src/shared/checks.js";
import {
  discoverWorkFoldCheckDeclarations,
  readWorkFoldCheckProposal,
  writeWorkFoldCheckDeclaration,
} from "../src/local/checks/check-declarations.js";
import { WorkFoldCheckStore } from "../src/local/checks/check-store.js";
import { workFoldFilePresenceSensorDigest } from "../src/local/checks/check-sensors.js";

const proposalValue = {
  kind: "work-fold.check-proposal",
  version: 1,
  name: "Required delivery",
  createdBy: "assistant",
  createdAt: "2026-08-01T00:00:00.000Z",
  check: {
    title: "The signed delivery exists",
    severity: "error",
    trigger: "manual",
    sensor: { id: "work-fold.file-presence", revision: 1, parameters: { expect: "present" } },
    targets: [{ kind: "file", role: "primary", path: "Deliverables/signed.pdf" }],
  },
} as const;

test("portable declarations remain inert until exact machine-local authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-check-declaration-"));
  const proposalPath = join(root, "proposal.work-fold-check.json");
  await writeFile(proposalPath, `${JSON.stringify(proposalValue)}\n`);
  const proposal = await readWorkFoldCheckProposal(proposalPath);
  const written = await writeWorkFoldCheckDeclaration(root, proposal);

  const discovery = await discoverWorkFoldCheckDeclarations(root);
  assert.equal(discovery.errors.length, 0);
  assert.equal(discovery.declarations.length, 1);
  assert.equal(discovery.declarations[0]?.digest, written.digest);
  assert.deepEqual(discovery.declarations[0]?.declaration, written.declaration);
  assert.match(await readFile(written.path, "utf8"), /work-fold\.file-presence/);

  const statePath = join(root, "machine-state.json");
  const store = await WorkFoldCheckStore.create("space-delivery", { path: statePath });
  assert.deepEqual(store.snapshot().authorizations, {}, "discovery must not grant authority");
  await store.authorize(written.declaration, written.digest, "human", workFoldFilePresenceSensorDigest);
  assert.equal(store.snapshot().authorizations[written.declaration.id]?.declarationDigest, written.digest);
});

test("declaration discovery isolates malformed and mismatched records without enabling them", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-check-malformed-"));
  const directory = join(root, ".work-fold", "checks");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "broken.json"), "{not-json");
  await writeFile(join(directory, "wrong-name.json"), JSON.stringify({
    kind: "work-fold.check",
    version: 1,
    id: "check-12345678",
    ...proposalValue.check,
    createdBy: "assistant",
    createdAt: "2026-08-01T00:00:00.000Z",
  }));
  const discovery = await discoverWorkFoldCheckDeclarations(root);
  assert.equal(discovery.declarations.length, 0);
  assert.equal(discovery.errors.length, 2);
  assert.match(discovery.errors.map((item) => item.message).join("\n"), /filename|JSON/i);
});

test("proposal parsing rejects declarations that try to carry execution authority", () => {
  assert.throws(() => normalizeWorkFoldCheckProposal({
    ...proposalValue,
    check: {
      ...proposalValue.check,
      sensor: { ...proposalValue.check.sensor, parameters: { expect: "present", command: "find ." } },
    },
  }), /not allowed/);
  assert.throws(() => normalizeWorkFoldCheckProposal({ ...proposalValue, enabled: true }), /unsupported field/);
});
