import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  AppReleaseError,
  assembleAppRelease,
  attachAppReleaseSidecars,
  verifyAppRelease,
  verifyAppReleaseBundle,
  type AppReleaseAssemblyInput,
  type AppReleaseEnvelope,
  type AppReleaseErrorCode,
  type AppReleaseFeatureInput,
} from "../src/local/agent/app-platform-release.js";
import {
  parseProjectId,
  parseSha256Digest,
  type Sha256Digest,
} from "../src/local/agent/app-platform-contract.js";

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);
const sha256 = (character: string): Sha256Digest => parseSha256Digest(`sha256:${character.repeat(64)}`);
const schemaValue = (featureId: string, marker: string, version: number) => ({
  $id: `${featureId}-data`,
  type: "object",
  marker,
  version,
});
const migrationSchema = (featureId: string, marker: string, version: number) => ({
  schemaId: `${featureId}-data`,
  version,
  definition: {
    mediaType: "application/schema+json",
    value: schemaValue(featureId, marker, version),
  },
});

type Mutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends Uint8Array
    ? Uint8Array
    : T extends readonly (infer Item)[]
      ? Mutable<Item>[]
      : T extends object
        ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
        : T;

function feature(
  featureId: string,
  marker: string,
  migrations: readonly string[] = [],
): Mutable<AppReleaseFeatureInput> {
  const schemaVersion = migrations.length + 1;
  return {
    featureId,
    featureRevision: {
      mediaType: "application/vnd.work-fold.feature+bundle",
      entries: [
        { path: "worker.js", bytes: bytes(`export const marker = ${JSON.stringify(marker)};\n`) },
        { path: "assets/view.html", bytes: bytes(`<h1>${marker}</h1>\n`) },
      ],
    },
    declaration: {
      mediaType: "application/vnd.work-fold.feature-declaration+json",
      value: {
        featureId,
        network: [{ destinationId: `${featureId}-api`, origin: `https://${featureId}.example` }],
        jobs: [],
      },
    },
    dataSchema: {
      schemaId: `${featureId}-data`,
      version: schemaVersion,
      definition: {
        mediaType: "application/schema+json",
        value: schemaValue(featureId, marker, schemaVersion),
      },
    },
    migrations: migrations.map((migrationId, index) => ({
      migrationId,
      sourceSchema: migrationSchema(featureId, marker, index + 1),
      targetSchema: migrationSchema(featureId, marker, index + 2),
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
          value: { featureId, migrationId, invariants: ["schema-valid"] },
        },
        receiptStates: { success: "verified", failure: "failed", cancelled: "cancelled" },
      },
      artifact: {
        mediaType: "application/vnd.work-fold.migration+bundle",
        entries: [{ path: "migrate.js", bytes: bytes(`// ${featureId}/${migrationId}/${marker}\n`) }],
      },
    })),
  };
}

function fixture(features?: Mutable<AppReleaseFeatureInput>[]): Mutable<AppReleaseAssemblyInput> {
  return {
    projectId: parseProjectId("project_release-fixture"),
    presentation: {
      title: "Community Desk",
      description: "A calm home for shared garden work.",
      icon: "sprout",
    },
    displayVersion: "1.2.0-beta.1",
    runtimeApi: { name: "work-fold.feature-broker", compatibleRange: "1.x" },
    features: features ?? [
      feature("garden-calendar", "calendar"),
      feature("connected-inbox", "inbox", ["schema-v1-to-v2", "bootstrap-index"]),
    ],
    dependencyInventory: {
      mediaType: "application/vnd.cyclonedx+json",
      value: { bomFormat: "CycloneDX", specVersion: "1.6", components: [] },
    },
    buildProvenance: {
      mediaType: "application/vnd.work-fold.build-provenance+json",
      value: { builder: "work-fold.test-builder", recipeDigest: sha256("1") },
    },
    inspectionEvidence: {
      mediaType: "application/vnd.work-fold.inspection-evidence+json",
      value: { policyVersion: "policy-1", findings: [] },
    },
    createdAt: "2026-07-15T12:00:00.000Z",
  };
}

function jsonClone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

test("release assembly has a stable closed conformance digest and canonical multi-feature ordering", () => {
  const input = fixture();
  const first = assembleAppRelease(input);
  const reordered = assembleAppRelease({
    ...input,
    features: [...input.features].reverse().map((item) => ({
      ...item,
      featureRevision: { ...item.featureRevision, entries: [...item.featureRevision.entries].reverse() },
      migrations: [...item.migrations].reverse(),
    })),
    dependencyInventory: {
      ...input.dependencyInventory,
      value: { components: [], specVersion: "1.6", bomFormat: "CycloneDX" },
    },
  });

  assert.equal(first.releaseDigest, "sha256:bcdceb7a560f74dfaff8801a22ad92355a3e416dee89289c161debeadb421f1e");
  assert.equal(reordered.releaseDigest, first.releaseDigest);
  assert.deepEqual(reordered, first);
  assert.deepEqual(first.manifest.features.map((item) => item.featureId), ["connected-inbox", "garden-calendar"]);
  assert.deepEqual(
    first.manifest.features[0]!.migrations.map((item) => item.migrationId),
    ["bootstrap-index", "schema-v1-to-v2"],
  );
  assert.deepEqual(first.closure.records.map((item) => item.digest), [...first.closure.records.map((item) => item.digest)].sort());
  assert.deepEqual(first.closure.artifacts.map((item) => item.digest), [...first.closure.artifacts.map((item) => item.digest)].sort());
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.manifest.features[0]!.migrations), true);
});

test("a JSON round trip verifies fully offline and returns an immutable defensive value", () => {
  const release = assembleAppRelease(fixture());
  const transported = jsonClone(release);
  const verified = verifyAppRelease(transported);

  assert.deepEqual(verified, release);
  assert.equal(Object.isFrozen(verified.closure.artifacts[0]!.entries), true);
  transported.manifest.displayVersion = "mutated-after-verification";
  assert.equal(verified.manifest.displayVersion, "1.2.0-beta.1");
});

test("offline verification rejects changed artifact bytes, canonical records, sizes, and roots", () => {
  const release = assembleAppRelease(fixture());

  const changedArtifact = jsonClone(release);
  changedArtifact.closure.artifacts[0]!.entries[0]!.bytesBase64 = Buffer.from("tampered").toString("base64");
  assertReleaseError(() => verifyAppRelease(changedArtifact), "RELEASE_DIGEST_MISMATCH");

  const changedRecord = jsonClone(release);
  (changedRecord.closure.records[0]!.value as { tampered?: boolean }).tampered = true;
  assertReleaseError(() => verifyAppRelease(changedRecord), "RELEASE_DIGEST_MISMATCH");

  const changedSize = jsonClone(release);
  changedSize.closure.artifacts[0]!.sizeBytes += 1;
  assertReleaseError(() => verifyAppRelease(changedSize), "RELEASE_DIGEST_MISMATCH");

  const changedRoot = jsonClone(release);
  changedRoot.releaseDigest = sha256("f");
  assertReleaseError(() => verifyAppRelease(changedRoot), "RELEASE_DIGEST_MISMATCH");

  const changedPresentation = jsonClone(release);
  changedPresentation.manifest.presentation.title = "Tampered title";
  assertReleaseError(() => verifyAppRelease(changedPresentation), "RELEASE_DIGEST_MISMATCH");
});

test("release presentation is required, exact, bounded, and Unicode-safe", () => {
  const atLimits = fixture();
  atLimits.presentation = {
    title: "t".repeat(80),
    description: "d".repeat(280),
    icon: "i".repeat(64),
  };
  assert.deepEqual(assembleAppRelease(atLimits).manifest.presentation, atLimits.presentation);

  for (const presentation of [
    { title: "", description: null, icon: null },
    { title: "t".repeat(81), description: null, icon: null },
    { title: "unsafe\ud800", description: null, icon: null },
    { title: "Valid", description: "", icon: null },
    { title: "Valid", description: "d".repeat(281), icon: null },
    { title: "Valid", description: null, icon: "Not-Stable" },
  ]) {
    assertReleaseError(
      () => assembleAppRelease({ ...fixture(), presentation }),
      "RELEASE_INVALID",
    );
  }

  const missing = jsonClone(assembleAppRelease(fixture())) as unknown as {
    manifest: { presentation?: unknown };
  };
  delete missing.manifest.presentation;
  assertReleaseError(() => verifyAppRelease(missing), "RELEASE_INVALID");

  const unknown = jsonClone(assembleAppRelease(fixture())) as unknown as {
    manifest: { presentation: { unsupported?: boolean } };
  };
  unknown.manifest.presentation.unsupported = true;
  assertReleaseError(() => verifyAppRelease(unknown), "RELEASE_INVALID");
});

test("every manifest edge resolves exactly once and every closure object is referenced", () => {
  const release = assembleAppRelease(fixture());

  const missing = jsonClone(release);
  const missingDigest = missing.manifest.features[0]!.featureRevision.digest;
  missing.closure.artifacts = missing.closure.artifacts.filter((item) => item.digest !== missingDigest);
  assertReleaseError(() => verifyAppRelease(missing), "RELEASE_OBJECT_MISSING");

  const duplicateObject = jsonClone(release);
  duplicateObject.closure.records.push(jsonClone(duplicateObject.closure.records[0]!));
  assertReleaseError(() => verifyAppRelease(duplicateObject), "RELEASE_DUPLICATE_REFERENCE");

  const duplicateEdge = jsonClone(release);
  duplicateEdge.manifest.buildProvenance = jsonClone(duplicateEdge.manifest.dependencyInventory);
  assertReleaseError(() => verifyAppRelease(duplicateEdge), "RELEASE_OBJECT_UNREFERENCED");

  const other = assembleAppRelease({
    ...fixture([feature("other-feature", "other")]),
    dependencyInventory: { mediaType: "application/json", value: { unique: "unreferenced-object" } },
  });
  const unreferenced = jsonClone(release);
  unreferenced.closure.records.push(jsonClone(other.closure.records.find((item) => (
    (item.value as { unique?: string }).unique === "unreferenced-object"
  ))!));
  unreferenced.closure.records.sort((left, right) => left.digest.localeCompare(right.digest));
  assertReleaseError(() => verifyAppRelease(unreferenced), "RELEASE_OBJECT_UNREFERENCED");
});

test("the verifier rejects non-canonical feature, migration, closure, and artifact ordering", () => {
  const release = assembleAppRelease(fixture());

  const features = jsonClone(release);
  features.manifest.features.reverse();
  assertReleaseError(() => verifyAppRelease(features), "RELEASE_NON_CANONICAL");

  const migrations = jsonClone(release);
  migrations.manifest.features[0]!.migrations.reverse();
  assertReleaseError(() => verifyAppRelease(migrations), "RELEASE_NON_CANONICAL");

  const records = jsonClone(release);
  records.closure.records.reverse();
  assertReleaseError(() => verifyAppRelease(records), "RELEASE_NON_CANONICAL");

  const artifactEntries = jsonClone(release);
  const multiEntryArtifact = artifactEntries.closure.artifacts.find((item) => item.entries.length > 1)!;
  multiEntryArtifact.entries.reverse();
  assertReleaseError(() => verifyAppRelease(artifactEntries), "RELEASE_NON_CANONICAL");
});

test("strict parsing rejects unknown fields, malformed references, base64, timestamps, and array holes", () => {
  const release = assembleAppRelease(fixture());

  const unknownEnvelope = jsonClone(release) as AppReleaseEnvelope & { surprise?: boolean };
  unknownEnvelope.surprise = true;
  assertReleaseError(() => verifyAppRelease(unknownEnvelope), "RELEASE_INVALID");

  const unknownManifest = jsonClone(release) as AppReleaseEnvelope & { manifest: AppReleaseEnvelope["manifest"] & { sidecars?: unknown[] } };
  unknownManifest.manifest.sidecars = [];
  assertReleaseError(() => verifyAppRelease(unknownManifest), "RELEASE_INVALID");

  const malformedReference = jsonClone(release);
  malformedReference.manifest.features[0]!.declaration.digest = (
    `sha256:${"A".repeat(64)}` as unknown as typeof malformedReference.manifest.features[0]["declaration"]["digest"]
  );
  assertReleaseError(() => verifyAppRelease(malformedReference), "RELEASE_INVALID");

  const malformedBase64 = jsonClone(release);
  malformedBase64.closure.artifacts[0]!.entries[0]!.bytesBase64 = "YR==";
  assertReleaseError(() => verifyAppRelease(malformedBase64), "RELEASE_INVALID");

  const malformedTimestamp = jsonClone(release);
  malformedTimestamp.manifest.createdAt = "2026-07-15T12:00:00Z";
  assertReleaseError(() => verifyAppRelease(malformedTimestamp), "RELEASE_INVALID");

  const arrayHole = jsonClone(release);
  delete (arrayHole.manifest.features as unknown[])[0];
  assertReleaseError(() => verifyAppRelease(arrayHole), "RELEASE_INVALID");
});

test("assembly rejects unsupported self-reference fields, duplicate ids, and unsafe artifacts", () => {
  const selfReferential = { ...fixture(), releaseDigest: sha256("a") };
  assertReleaseError(
    () => assembleAppRelease(selfReferential as unknown as AppReleaseAssemblyInput),
    "RELEASE_INVALID",
  );

  const duplicateFeature = feature("connected-inbox", "second-copy");
  assertReleaseError(
    () => assembleAppRelease(fixture([feature("connected-inbox", "first-copy"), duplicateFeature])),
    "RELEASE_DUPLICATE_REFERENCE",
  );

  const duplicateMigration = feature("connected-inbox", "inbox", ["same-migration", "same-migration"]);
  duplicateMigration.migrations[1]!.artifact.entries = [
    { path: "migrate.js", bytes: bytes("// different content") },
  ];
  assertReleaseError(
    () => assembleAppRelease(fixture([duplicateMigration])),
    "RELEASE_DUPLICATE_REFERENCE",
  );

  const unsafe = feature("unsafe-feature", "unsafe");
  unsafe.featureRevision.entries = [
    { path: "same.js", bytes: bytes("one") },
    { path: "same.js", bytes: bytes("two") },
  ];
  assertReleaseError(() => assembleAppRelease(fixture([unsafe])), "RELEASE_INVALID");
});

test("multiple manifest edges share one deduplicated immutable closure object", () => {
  const input = fixture();
  input.buildProvenance = input.dependencyInventory;
  const sharedArtifactBytes = new Uint8Array(64 * 1024).fill(0x5a);
  input.features[0]!.featureRevision.entries = [{ path: "shared.bin", bytes: sharedArtifactBytes }];
  input.features[1]!.featureRevision.entries = [{ path: "shared.bin", bytes: sharedArtifactBytes }];
  const release = assembleAppRelease(input);
  const exactClosureBytes = [...release.closure.records, ...release.closure.artifacts]
    .reduce((total, item) => total + item.sizeBytes, 0);
  const bounded = assembleAppRelease(input, { closureBytes: exactClosureBytes });

  assert.equal(release.manifest.buildProvenance.digest, release.manifest.dependencyInventory.digest);
  assert.equal(
    release.closure.records.filter((record) => record.digest === release.manifest.dependencyInventory.digest).length,
    1,
  );
  assert.equal(release.manifest.features[0]!.featureRevision.digest, release.manifest.features[1]!.featureRevision.digest);
  assert.equal(release.closure.artifacts.filter((artifact) => artifact.digest === release.manifest.features[0]!.featureRevision.digest).length, 1);
  assert.deepEqual(bounded, release, "a duplicate artifact reference consumes no additional closure bytes");
  assert.deepEqual(verifyAppRelease(jsonClone(release)), release);
});

test("migration declarations bind exact endpoints and restricted execution metadata", () => {
  const input = fixture([feature("connected-inbox", "inbox", ["schema-v1-to-v2"])]);
  const migration = input.features[0]!.migrations[0]!;
  assert.equal(migration.sourceSchema.version, 1);
  assert.equal(migration.targetSchema.version, 2);
  assert.equal(migration.execution.namespaceAccess, "feature-data-only");

  const release = assembleAppRelease(input);
  const releasedMigration = release.manifest.features[0]!.migrations[0]!;
  assert.equal(releasedMigration.sourceSchema.digest, releasedMigration.sourceSchema.definition.digest);
  assert.equal(releasedMigration.targetSchema.digest, releasedMigration.targetSchema.definition.digest);
  const tamperedEndpoint = jsonClone(release);
  tamperedEndpoint.manifest.features[0]!.migrations[0]!.sourceSchema.digest = sha256("f");
  assertReleaseError(() => verifyAppRelease(tamperedEndpoint), "RELEASE_DIGEST_MISMATCH");

  migration.execution.externalEffects.network = true as false;
  assertReleaseError(() => assembleAppRelease(input), "RELEASE_INVALID");

  const wrongRuntime = fixture([feature("connected-inbox", "inbox", ["schema-v1-to-v2"])]);
  wrongRuntime.features[0]!.migrations[0]!.execution.runtimeApi.compatibleRange = "2.x";
  assertReleaseError(() => assembleAppRelease(wrongRuntime), "RELEASE_INVALID");
});

test("bounded assembly and verification fail closed before accepting oversized structures", () => {
  const input = fixture();
  assertReleaseError(() => assembleAppRelease(input, { features: 1 }), "RELEASE_LIMIT_EXCEEDED");
  assertReleaseError(() => assembleAppRelease(input, { artifactFiles: 1 }), "RELEASE_LIMIT_EXCEEDED");
  assertReleaseError(() => assembleAppRelease(input, { recordBytes: 8 }), "RELEASE_LIMIT_EXCEEDED");
  assertReleaseError(() => assembleAppRelease(input, { closureBytes: 64 }), "RELEASE_LIMIT_EXCEEDED");

  const aggregateArtifact = fixture([feature("bounded-feature", "bounded")]);
  aggregateArtifact.features[0]!.featureRevision.entries = [
    { path: "first.bin", bytes: bytes("123456") },
    { path: "second.bin", bytes: bytes("abcdef") },
  ];
  assertReleaseError(
    () => assembleAppRelease(aggregateArtifact, { artifactFileBytes: 6, artifactBytes: 10 }),
    "RELEASE_LIMIT_EXCEEDED",
  );

  const release = assembleAppRelease(input);
  assertReleaseError(() => verifyAppRelease(release, { closureRecords: 1 }), "RELEASE_LIMIT_EXCEEDED");
  assertReleaseError(() => verifyAppRelease(release, { artifactFileBytes: 4 }), "RELEASE_LIMIT_EXCEEDED");
  assertReleaseError(() => verifyAppRelease(release, { artifactFileBytes: 40, artifactBytes: 40 }), "RELEASE_LIMIT_EXCEEDED");

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const cyclicInput = fixture();
  cyclicInput.inspectionEvidence = { mediaType: "application/json", value: cyclic };
  assertReleaseError(() => assembleAppRelease(cyclicInput), "RELEASE_INVALID");
});

test("sidecars bind to but remain structurally outside immutable release identity", () => {
  const release = assembleAppRelease(fixture());
  const firstSidecars = [{
    recordVersion: 1,
    kind: "release-review",
    releaseDigest: release.releaseDigest,
    digest: sha256("a"),
    createdAt: "2026-07-15T12:30:00.000Z",
  }];
  const secondSidecars = [{
    recordVersion: 1,
    kind: "registry-policy",
    releaseDigest: release.releaseDigest,
    digest: sha256("b"),
    createdAt: "2026-07-15T13:00:00.000Z",
  }];

  const first = attachAppReleaseSidecars(release, firstSidecars);
  const second = attachAppReleaseSidecars(release, secondSidecars);
  assert.equal(first.release.releaseDigest, second.release.releaseDigest);
  assert.deepEqual(first.release, second.release);
  assert.notDeepEqual(first.sidecars, second.sidecars);
  assert.deepEqual(verifyAppReleaseBundle(jsonClone(first)), first);

  const wrongRelease = jsonClone(firstSidecars);
  wrongRelease[0]!.releaseDigest = sha256("c");
  assertReleaseError(() => attachAppReleaseSidecars(release, wrongRelease), "RELEASE_DIGEST_MISMATCH");

  assertReleaseError(
    () => attachAppReleaseSidecars(release, [...firstSidecars, { ...firstSidecars[0] }]),
    "RELEASE_DUPLICATE_REFERENCE",
  );
});

function assertReleaseError(
  operation: () => unknown,
  code: AppReleaseErrorCode,
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof AppReleaseError);
    assert.equal(error.code, code);
    return true;
  });
}
