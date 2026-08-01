import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalAppInstanceUpdateError,
  planLocalAppInstanceUpdate,
  type LocalAppAddedFeatureAllocation,
  type LocalAppFeatureState,
  type LocalAppInstanceState,
  type LocalAppInstanceUpdateInput,
} from "../src/local/agent/app-instance-update.js";
import {
  assembleAppRelease,
  type AppReleaseEnvelope,
  type AppReleaseFeatureInput,
  type AppReleaseMigrationInput,
  type AppReleaseMigrationSchemaInput,
} from "../src/local/agent/app-platform-release.js";
import {
  parseDataNamespaceId,
  parseFeatureInstallationId,
  parseProjectId,
  parseRuntimeInstanceId,
  parseSha256Digest,
} from "../src/local/agent/app-platform-contract.js";

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);
const projectId = parseProjectId("project_update-fixture");
const supportedRuntimeApi = { name: "work-fold.feature-broker", majorVersion: 1 } as const;

type Mutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends Uint8Array
    ? Uint8Array
    : T extends readonly (infer Item)[]
      ? Mutable<Item>[]
      : T extends object
        ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
        : T;

interface MigrationEdge {
  id: string;
  from: number;
  to: number;
  sourceFeatureId?: string;
  targetFeatureId?: string;
}

function schemaValue(featureId: string, version: number) {
  return { $id: `${featureId}-data`, featureId, version, type: "object" };
}

function migrationSchema(featureId: string, version: number): AppReleaseMigrationSchemaInput {
  return {
    schemaId: `${featureId}-data`,
    version,
    definition: {
      mediaType: "application/schema+json",
      value: schemaValue(featureId, version),
    },
  };
}

function migration(featureId: string, edge: MigrationEdge): AppReleaseMigrationInput {
  const sourceFeatureId = edge.sourceFeatureId ?? featureId;
  const targetFeatureId = edge.targetFeatureId ?? featureId;
  return {
    migrationId: edge.id,
    sourceSchema: migrationSchema(sourceFeatureId, edge.from),
    targetSchema: migrationSchema(targetFeatureId, edge.to),
    execution: {
      runtimeApi: { name: "work-fold.feature-broker", compatibleRange: "1.x" },
      mode: "maintenance",
      resourceLimits: {
        maxDurationMs: 30_000,
        maxMemoryBytes: 64 * 1024 * 1024,
        maxReadBytes: 16 * 1024 * 1024,
        maxWriteBytes: 16 * 1024 * 1024,
      },
      namespaceAccess: "feature-data-only",
      externalEffects: { network: false, connections: false, notifications: false },
      resumePolicy: "idempotent-restart",
      verification: {
        mediaType: "application/vnd.work-fold.migration-verification+json",
        value: { featureId, migrationId: edge.id, checks: ["schema", "invariants"] },
      },
      receiptStates: { success: "verified", failure: "failed", cancelled: "cancelled" },
    },
    artifact: {
      mediaType: "application/vnd.work-fold.migration+bundle",
      entries: [{ path: "migrate.js", bytes: bytes(`${featureId}/${edge.id}/${edge.from}->${edge.to}`) }],
    },
  };
}

function releaseFeature(
  featureId: string,
  marker: string,
  schemaVersion = 1,
  edges: readonly MigrationEdge[] = [],
): AppReleaseFeatureInput {
  return {
    featureId,
    featureRevision: {
      mediaType: "application/vnd.work-fold.feature+bundle",
      entries: [{ path: "worker.js", bytes: bytes(marker) }],
    },
    declaration: { mediaType: "application/json", value: { featureId, marker } },
    dataSchema: {
      schemaId: `${featureId}-data`,
      version: schemaVersion,
      definition: { mediaType: "application/schema+json", value: schemaValue(featureId, schemaVersion) },
    },
    migrations: edges.map((edge) => migration(featureId, edge)),
  };
}

function release(
  features: readonly AppReleaseFeatureInput[],
  options: Readonly<{ project?: string; displayVersion?: string; runtimeMajor?: number }> = {},
): AppReleaseEnvelope {
  const runtimeMajor = options.runtimeMajor ?? 1;
  return assembleAppRelease({
    projectId: parseProjectId(options.project ?? projectId),
    presentation: {
      title: "Test App",
      description: null,
      icon: null,
    },
    displayVersion: options.displayVersion ?? "1.0.0",
    runtimeApi: { name: "work-fold.feature-broker", compatibleRange: `${runtimeMajor}.x` },
    features,
    dependencyInventory: { mediaType: "application/json", value: { dependencies: [] } },
    buildProvenance: { mediaType: "application/json", value: { builder: "test" } },
    inspectionEvidence: { mediaType: "application/json", value: { findings: [] } },
    createdAt: "2026-07-15T12:00:00.000Z",
  });
}

function stateFrom(feature: AppReleaseEnvelope["manifest"]["features"][number]): LocalAppFeatureState {
  return {
    featureId: feature.featureId,
    featureInstallationId: parseFeatureInstallationId(`feature-installation_${feature.featureId}`),
    dataNamespaceId: parseDataNamespaceId(`data-namespace_${feature.featureId}`),
    featureRevisionDigest: feature.featureRevision.digest,
    declarationDigest: feature.declaration.digest,
    dataSchema: feature.dataSchema && {
      schemaId: feature.dataSchema.schemaId,
      version: feature.dataSchema.version,
      digest: feature.dataSchema.definition.digest,
    },
    grants: ["mail-api"],
    connections: ["instance-mail"],
    enabledJobs: ["refresh-mail"],
  };
}

function instance(activeRelease: AppReleaseEnvelope): LocalAppInstanceState {
  return {
    runtimeInstanceId: parseRuntimeInstanceId("runtime-instance_local"),
    projectId: activeRelease.manifest.projectId,
    activeRelease,
    features: activeRelease.manifest.features.map(stateFrom),
  };
}

function allocation(featureId: string, suffix = featureId): Mutable<LocalAppAddedFeatureAllocation> {
  return {
    featureId,
    featureInstallationId: parseFeatureInstallationId(`feature-installation_allocated-${suffix}`),
    dataNamespaceId: parseDataNamespaceId(`data-namespace_allocated-${suffix}`),
  };
}

function updateInput(
  currentRelease: AppReleaseEnvelope,
  target: AppReleaseEnvelope,
  options: Partial<LocalAppInstanceUpdateInput> = {},
): LocalAppInstanceUpdateInput {
  const current = options.current ?? instance(currentRelease);
  const currentIds = new Set(current.features.map((feature) => feature.featureId));
  const added = target.manifest.features
    .filter((feature) => !currentIds.has(feature.featureId))
    .map((feature) => allocation(feature.featureId));
  return {
    operationId: options.operationId ?? "update-operation-001",
    current,
    target: options.target ?? target,
    supportedRuntimeApi: options.supportedRuntimeApi ?? supportedRuntimeApi,
    continuityPolicy: options.continuityPolicy ?? "eligible",
    addedFeatureAllocations: options.addedFeatureAllocations ?? added,
  };
}

function mutableClone<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}

test("exact Feature continuity and caller-owned added allocations are deterministic across retries", () => {
  const currentRelease = release([releaseFeature("connected-inbox", "one")]);
  const target = release([
    releaseFeature("connected-inbox", "one"),
    releaseFeature("garden", "new"),
  ]);
  const durableAllocation = allocation("garden", "durable-garden");
  const input = updateInput(currentRelease, target, { addedFeatureAllocations: [durableAllocation] });
  const first = planLocalAppInstanceUpdate(input);
  const retry = planLocalAppInstanceUpdate(input);

  assert.deepEqual(retry, first);
  assert.equal(first.planDigest, retry.planDigest);
  assert.deepEqual(first.transitions.map(({ featureId, action }) => [featureId, action]), [
    ["connected-inbox", "keep"],
    ["garden", "add"],
  ]);
  assert.deepEqual(first.transitions[0]!.continuity, {
    grants: ["mail-api"],
    connections: ["instance-mail"],
    enabledJobs: ["refresh-mail"],
  });
  assert.equal(first.transitions[1]!.featureInstallationId, durableAllocation.featureInstallationId);
  assert.equal(first.transitions[1]!.dataNamespaceId, durableAllocation.dataNamespaceId);
  assert.deepEqual(first.instanceFenceFields, ["runtimeInstanceGeneration"]);
  assert.deepEqual(first.transitions[0]!.featureFenceFields, []);
  assert.deepEqual(first.transitions[1]!.featureFenceFields, []);
  assert.equal(Object.isFrozen(first), true);
});

test("a schema update resolves and orders one exact multi-step migration path", () => {
  const currentRelease = release([releaseFeature("connected-inbox", "one", 1)]);
  const currentFeature = stateFrom(currentRelease.manifest.features[0]!);
  const target = release([releaseFeature("connected-inbox", "two", 3, [
    { id: "schema-v2-to-v3", from: 2, to: 3 },
    { id: "schema-v1-to-v2", from: 1, to: 2 },
  ])]);
  const plan = planLocalAppInstanceUpdate(updateInput(currentRelease, target));
  const transition = plan.transitions[0]!;

  assert.equal(plan.canCommit, true);
  assert.equal(transition.action, "update");
  assert.equal(transition.featureInstallationId, currentFeature.featureInstallationId);
  assert.equal(transition.dataNamespaceId, currentFeature.dataNamespaceId);
  assert.equal(transition.data, "migrate");
  assert.deepEqual(transition.migrationIds, ["schema-v1-to-v2", "schema-v2-to-v3"]);
  assert.equal(transition.migrationDigests.length, 2);
  assert.deepEqual(transition.resets, ["grants", "connections", "jobs"]);
  assert.deepEqual(transition.featureFenceFields, [
    "featureInstallationGeneration",
    "grantGeneration",
    "connectionGeneration",
    "jobGeneration",
    "dataGeneration",
  ]);
  assert.equal(transition.featureFenceFields.includes("runtimeInstanceGeneration"), false);
});

test("migration planning blocks gaps, reverse-only paths, and wrong schema identities", () => {
  const currentRelease = release([releaseFeature("connected-inbox", "one", 1)]);
  const cases = [
    release([releaseFeature("connected-inbox", "gap", 3, [{ id: "only-first-step", from: 1, to: 2 }])]),
    release([releaseFeature("connected-inbox", "reverse", 3, [{ id: "reverse-only", from: 3, to: 1 }])]),
    release([releaseFeature("connected-inbox", "wrong", 2, [{
      id: "wrong-source",
      from: 1,
      to: 2,
      sourceFeatureId: "different-feature",
    }])]),
  ];
  for (const target of cases) {
    const plan = planLocalAppInstanceUpdate(updateInput(currentRelease, target));
    assert.equal(plan.canCommit, false);
    assert.equal(plan.transitions[0]!.data, "retain-disabled");
    assert.match(plan.blockedReasons[0]!, /no complete migration path/);
  }
});

test("migration planning rejects ambiguous and cyclic graphs", () => {
  const currentRelease = release([releaseFeature("connected-inbox", "one", 1)]);
  const ambiguous = release([releaseFeature("connected-inbox", "ambiguous", 3, [
    { id: "direct", from: 1, to: 3 },
    { id: "first", from: 1, to: 2 },
    { id: "second", from: 2, to: 3 },
  ])]);
  const ambiguousPlan = planLocalAppInstanceUpdate(updateInput(currentRelease, ambiguous));
  assert.equal(ambiguousPlan.canCommit, false);
  assert.match(ambiguousPlan.blockedReasons[0]!, /more than one migration path/);

  const cyclic = release([releaseFeature("connected-inbox", "cyclic", 3, [
    { id: "forward", from: 1, to: 2 },
    { id: "backward", from: 2, to: 1 },
    { id: "finish", from: 2, to: 3 },
  ])]);
  const cyclicPlan = planLocalAppInstanceUpdate(updateInput(currentRelease, cyclic));
  assert.equal(cyclicPlan.canCommit, false);
  assert.match(cyclicPlan.blockedReasons[0]!, /cyclic/);
});

test("schema changes without an exact closed path block atomic activation", () => {
  const currentRelease = release([releaseFeature("connected-inbox", "one", 1)]);
  const target = release([releaseFeature("connected-inbox", "two", 2)]);
  const plan = planLocalAppInstanceUpdate(updateInput(currentRelease, target, { continuityPolicy: "reset" }));

  assert.equal(plan.canCommit, false);
  assert.equal(plan.transitions[0]!.data, "retain-disabled");
  assert.match(plan.blockedReasons[0]!, /no complete migration path/);
});

test("current state is bound to a verified active Release and exact project lineage", () => {
  const currentRelease = release([releaseFeature("connected-inbox", "one")]);
  const target = release([releaseFeature("connected-inbox", "two")]);

  const mismatchedProject = mutableClone(instance(currentRelease));
  mismatchedProject.projectId = parseProjectId("project_different");
  assertUpdateError(
    () => planLocalAppInstanceUpdate(updateInput(currentRelease, target, { current: mismatchedProject })),
    /projectId does not match/,
  );

  const fabricatedFeature = mutableClone(instance(currentRelease));
  fabricatedFeature.features[0]!.declarationDigest = parseSha256Digest(`sha256:${"f".repeat(64)}`);
  assertUpdateError(
    () => planLocalAppInstanceUpdate(updateInput(currentRelease, target, { current: fabricatedFeature })),
    /does not match its verified active Release/,
  );

  const tamperedCurrent = mutableClone(instance(currentRelease));
  (tamperedCurrent.activeRelease as Mutable<AppReleaseEnvelope>).manifest.displayVersion = "tampered";
  assertUpdateError(
    () => planLocalAppInstanceUpdate(updateInput(currentRelease, target, { current: tamperedCurrent })),
    /verification failed/,
  );

  const otherProjectTarget = release(
    [releaseFeature("connected-inbox", "two")],
    { project: "project_other-lineage" },
  );
  assertUpdateError(
    () => planLocalAppInstanceUpdate(updateInput(currentRelease, otherProjectTarget)),
    /different project lineage/,
  );
});

test("planning enforces the locally supported Feature and migration broker API", () => {
  const currentRelease = release([releaseFeature("connected-inbox", "one")]);
  const target = release([releaseFeature("connected-inbox", "two")], { runtimeMajor: 2 });

  assertUpdateError(
    () => planLocalAppInstanceUpdate(updateInput(currentRelease, target)),
    /unsupported runtimeApi/,
  );
  assertUpdateError(
    () => planLocalAppInstanceUpdate(updateInput(currentRelease, target, {
      supportedRuntimeApi: { name: "different-broker", majorVersion: 1 },
    })),
    /unsupported runtimeApi/,
  );
});

test("added Feature allocations must be exact, unique, non-colliding durable input", () => {
  const currentRelease = release([releaseFeature("connected-inbox", "one")]);
  const target = release([
    releaseFeature("connected-inbox", "one"),
    releaseFeature("garden", "new"),
  ]);
  assertUpdateError(
    () => planLocalAppInstanceUpdate(updateInput(currentRelease, target, { addedFeatureAllocations: [] })),
    /must exactly match/,
  );
  assertUpdateError(
    () => planLocalAppInstanceUpdate(updateInput(currentRelease, target, {
      addedFeatureAllocations: [allocation("garden"), allocation("extra")],
    })),
    /must exactly match/,
  );

  const colliding = allocation("garden");
  colliding.featureInstallationId = instance(currentRelease).features[0]!.featureInstallationId;
  assertUpdateError(
    () => planLocalAppInstanceUpdate(updateInput(currentRelease, target, { addedFeatureAllocations: [colliding] })),
    /must not reuse/,
  );
});

test("removed Features fence only their own authority domains and retain data disabled", () => {
  const currentRelease = release([
    releaseFeature("connected-inbox", "one"),
    releaseFeature("garden", "garden"),
  ]);
  const target = release([releaseFeature("garden", "garden")]);
  const plan = planLocalAppInstanceUpdate(updateInput(currentRelease, target));
  const removed = plan.transitions.find((transition) => transition.featureId === "connected-inbox")!;
  const kept = plan.transitions.find((transition) => transition.featureId === "garden")!;

  assert.equal(removed.action, "remove");
  assert.equal(removed.data, "retain-disabled");
  assert.deepEqual(removed.featureFenceFields, [
    "featureInstallationGeneration",
    "grantGeneration",
    "connectionGeneration",
    "jobGeneration",
    "dataGeneration",
  ]);
  assert.deepEqual(kept.featureFenceFields, []);
  assert.deepEqual(plan.instanceFenceFields, ["runtimeInstanceGeneration"]);
});

test("planning verifies both closures offline and rejects already-active or duplicate current state", () => {
  const currentRelease = release([releaseFeature("connected-inbox", "one")]);
  assertUpdateError(
    () => planLocalAppInstanceUpdate(updateInput(currentRelease, currentRelease)),
    /already active/,
  );

  const target = release([releaseFeature("connected-inbox", "two")]);
  const tampered = mutableClone(target);
  tampered.manifest.displayVersion = "tampered";
  assertUpdateError(
    () => planLocalAppInstanceUpdate(updateInput(currentRelease, target, { target: tampered })),
    /verification failed/,
  );

  const duplicate = mutableClone(instance(currentRelease));
  duplicate.features.push(mutableClone(duplicate.features[0]!));
  assertUpdateError(
    () => planLocalAppInstanceUpdate(updateInput(currentRelease, target, { current: duplicate })),
    /unique/,
  );
});

function assertUpdateError(operation: () => unknown, message: RegExp): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof LocalAppInstanceUpdateError);
    assert.match(error.message, message);
    return true;
  });
}
