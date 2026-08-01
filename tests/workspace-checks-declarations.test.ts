import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeWorkspaceCheckProposal } from "../src/shared/checks.js";
import {
  discoverWorkspaceCheckDeclarations,
  readWorkspaceCheckProposal,
  writeWorkspaceCheckDeclaration,
} from "../src/local/checks/check-declarations.js";
import { WorkspaceCheckStore } from "../src/local/checks/check-store.js";
import { workspaceFilePresenceSensorDigest } from "../src/local/checks/check-sensors.js";

const proposalValue = {
  kind: "workspace.check-proposal",
  version: 1,
  name: "Required delivery",
  createdBy: "assistant",
  createdAt: "2026-08-01T00:00:00.000Z",
  check: {
    title: "The signed delivery exists",
    severity: "error",
    trigger: "manual",
    sensor: { id: "workspace.file-presence", revision: 1, parameters: { expect: "present" } },
    targets: [{ kind: "file", role: "primary", path: "Deliverables/signed.pdf" }],
  },
} as const;

test("portable declarations remain inert until exact machine-local authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-check-declaration-"));
  const proposalPath = join(root, "proposal.workspace-check.json");
  await writeFile(proposalPath, `${JSON.stringify(proposalValue)}\n`);
  const proposal = await readWorkspaceCheckProposal(proposalPath);
  const written = await writeWorkspaceCheckDeclaration(root, proposal);

  const discovery = await discoverWorkspaceCheckDeclarations(root);
  assert.equal(discovery.errors.length, 0);
  assert.equal(discovery.declarations.length, 1);
  assert.equal(discovery.declarations[0]?.digest, written.digest);
  assert.deepEqual(discovery.declarations[0]?.declaration, written.declaration);
  assert.match(await readFile(written.path, "utf8"), /workspace\.file-presence/);

  const statePath = join(root, "machine-state.json");
  const store = await WorkspaceCheckStore.create("space-delivery", { path: statePath });
  assert.deepEqual(store.snapshot().authorizations, {}, "discovery must not grant authority");
  await store.authorize(written.declaration, written.digest, "human", workspaceFilePresenceSensorDigest);
  assert.equal(store.snapshot().authorizations[written.declaration.id]?.declarationDigest, written.digest);
});

test("declaration discovery isolates malformed and mismatched records without enabling them", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-check-malformed-"));
  const directory = join(root, ".workspace", "checks");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "broken.json"), "{not-json");
  await writeFile(join(directory, "wrong-name.json"), JSON.stringify({
    kind: "workspace.check",
    version: 1,
    id: "check-12345678",
    ...proposalValue.check,
    createdBy: "assistant",
    createdAt: "2026-08-01T00:00:00.000Z",
  }));
  const discovery = await discoverWorkspaceCheckDeclarations(root);
  assert.equal(discovery.declarations.length, 0);
  assert.equal(discovery.errors.length, 2);
  assert.match(discovery.errors.map((item) => item.message).join("\n"), /filename|JSON/i);
});

test("proposal parsing rejects declarations that try to carry execution authority", () => {
  assert.throws(() => normalizeWorkspaceCheckProposal({
    ...proposalValue,
    check: {
      ...proposalValue.check,
      sensor: { ...proposalValue.check.sensor, parameters: { expect: "present", command: "find ." } },
    },
  }), /not allowed/);
  assert.throws(() => normalizeWorkspaceCheckProposal({ ...proposalValue, enabled: true }), /unsupported field/);
});
