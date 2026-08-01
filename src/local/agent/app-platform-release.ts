import { Buffer } from "node:buffer";

import {
  appPlatformArtifactDefaultLimits,
  AppPlatformArtifactError,
  hashAppPlatformArtifact,
  parseAppPlatformArtifactDigest,
  type AppPlatformArtifactDigest,
  type AppPlatformArtifactEntry,
} from "./app-platform-artifact.js";
import {
  canonicalizeJson,
  computeDeclarationDigest,
  parseProjectId,
  parseSha256Digest,
  type ProjectId,
  type Sha256Digest,
} from "./app-platform-contract.js";

export const appReleaseFormat = "work-fold.app-release" as const;
export const appReleaseFormatVersion = 2 as const;
export const appReleaseRecordVersion = 1 as const;

export const appReleaseDefaultLimits = Object.freeze({
  features: 64,
  migrationsPerFeature: 64,
  closureRecords: 256,
  closureArtifacts: 256,
  recordBytes: 2 * 1024 * 1024,
  jsonDepth: 64,
  jsonNodes: 100_000,
  artifactFiles: appPlatformArtifactDefaultLimits.files,
  artifactPathBytes: appPlatformArtifactDefaultLimits.pathBytes,
  artifactFileBytes: appPlatformArtifactDefaultLimits.fileBytes,
  artifactBytes: appPlatformArtifactDefaultLimits.totalBytes,
  closureBytes: 256 * 1024 * 1024,
  sidecars: 256,
} as const);

export interface AppReleaseLimits {
  features?: number;
  migrationsPerFeature?: number;
  closureRecords?: number;
  closureArtifacts?: number;
  recordBytes?: number;
  jsonDepth?: number;
  jsonNodes?: number;
  artifactFiles?: number;
  artifactPathBytes?: number;
  artifactFileBytes?: number;
  artifactBytes?: number;
  closureBytes?: number;
  sidecars?: number;
}

export type AppReleaseErrorCode =
  | "RELEASE_INVALID"
  | "RELEASE_LIMIT_EXCEEDED"
  | "RELEASE_DUPLICATE_REFERENCE"
  | "RELEASE_OBJECT_MISSING"
  | "RELEASE_OBJECT_UNREFERENCED"
  | "RELEASE_DIGEST_MISMATCH"
  | "RELEASE_NON_CANONICAL";

export class AppReleaseError extends Error {
  constructor(
    readonly code: AppReleaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppReleaseError";
  }
}

export interface AppReleaseRecordInput {
  readonly mediaType: string;
  readonly value: unknown;
}

export interface AppReleaseArtifactInput {
  readonly mediaType: string;
  readonly entries: readonly AppPlatformArtifactEntry[];
}

export interface AppReleaseMigrationInput {
  readonly migrationId: string;
  readonly sourceSchema: AppReleaseMigrationSchemaInput;
  readonly targetSchema: AppReleaseMigrationSchemaInput;
  readonly execution: AppReleaseMigrationExecutionInput;
  readonly artifact: AppReleaseArtifactInput;
}

export interface AppReleaseSchemaIdentity {
  readonly schemaId: string;
  readonly version: number;
  readonly digest: Sha256Digest;
}

export interface AppReleaseMigrationSchemaInput {
  readonly schemaId: string;
  readonly version: number;
  readonly definition: AppReleaseRecordInput;
}

export interface AppReleaseSchemaReference extends AppReleaseSchemaIdentity {
  readonly definition: AppReleaseRecordReference;
}

export interface AppReleaseMigrationExecutionInput {
  readonly runtimeApi: Readonly<{
    name: string;
    compatibleRange: string;
  }>;
  readonly mode: "online" | "maintenance";
  readonly resourceLimits: Readonly<{
    maxDurationMs: number;
    maxMemoryBytes: number;
    maxReadBytes: number;
    maxWriteBytes: number;
  }>;
  readonly namespaceAccess: "feature-data-only";
  readonly externalEffects: Readonly<{
    network: false;
    connections: false;
    notifications: false;
  }>;
  readonly resumePolicy: "idempotent-restart" | "checkpointed";
  readonly verification: AppReleaseRecordInput;
  readonly receiptStates: Readonly<{
    success: "verified";
    failure: "failed";
    cancelled: "cancelled";
  }>;
}

export interface AppReleaseDataSchemaInput {
  readonly schemaId: string;
  readonly version: number;
  readonly definition: AppReleaseRecordInput;
}

export interface AppReleaseFeatureInput {
  readonly featureId: string;
  readonly featureRevision: AppReleaseArtifactInput;
  readonly declaration: AppReleaseRecordInput;
  readonly dataSchema: AppReleaseDataSchemaInput | null;
  readonly migrations: readonly AppReleaseMigrationInput[];
}

export interface AppReleaseAssemblyInput {
  readonly projectId: ProjectId;
  readonly presentation: AppReleasePresentation;
  readonly displayVersion: string;
  readonly runtimeApi: Readonly<{
    name: string;
    compatibleRange: string;
  }>;
  readonly features: readonly AppReleaseFeatureInput[];
  readonly dependencyInventory: AppReleaseRecordInput;
  readonly buildProvenance: AppReleaseRecordInput;
  readonly inspectionEvidence: AppReleaseRecordInput;
  readonly createdAt: string;
}

export interface AppReleasePresentation {
  readonly title: string;
  readonly description: string | null;
  readonly icon: string | null;
}

export interface AppReleaseRecordReference {
  readonly kind: "record";
  readonly digest: Sha256Digest;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

export interface AppReleaseArtifactReference {
  readonly kind: "artifact";
  readonly digest: AppPlatformArtifactDigest;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

export interface AppReleaseFeature {
  readonly featureId: string;
  readonly featureRevision: AppReleaseArtifactReference;
  readonly declaration: AppReleaseRecordReference;
  readonly dataSchema: Readonly<{
    schemaId: string;
    version: number;
    definition: AppReleaseRecordReference;
  }> | null;
  readonly migrations: readonly Readonly<{
    migrationId: string;
    sourceSchema: AppReleaseSchemaReference;
    targetSchema: AppReleaseSchemaReference;
    execution: Readonly<{
      runtimeApi: AppReleaseManifest["runtimeApi"];
      mode: "online" | "maintenance";
      resourceLimits: Readonly<{
        maxDurationMs: number;
        maxMemoryBytes: number;
        maxReadBytes: number;
        maxWriteBytes: number;
      }>;
      namespaceAccess: "feature-data-only";
      externalEffects: Readonly<{
        network: false;
        connections: false;
        notifications: false;
      }>;
      resumePolicy: "idempotent-restart" | "checkpointed";
      verification: AppReleaseRecordReference;
      receiptStates: Readonly<{
        success: "verified";
        failure: "failed";
        cancelled: "cancelled";
      }>;
    }>;
    artifact: AppReleaseArtifactReference;
  }>[];
}

export interface AppReleaseManifest {
  readonly format: typeof appReleaseFormat;
  readonly formatVersion: typeof appReleaseFormatVersion;
  readonly projectId: ProjectId;
  readonly presentation: AppReleasePresentation;
  readonly displayVersion: string;
  readonly runtimeApi: Readonly<{
    name: string;
    compatibleRange: string;
  }>;
  readonly features: readonly AppReleaseFeature[];
  readonly dependencyInventory: AppReleaseRecordReference;
  readonly buildProvenance: AppReleaseRecordReference;
  readonly inspectionEvidence: AppReleaseRecordReference;
  readonly createdAt: string;
}

export interface AppReleaseClosureRecord extends AppReleaseRecordReference {
  readonly value: unknown;
}

export interface AppReleaseClosureArtifact extends AppReleaseArtifactReference {
  readonly entries: readonly Readonly<{
    path: string;
    bytesBase64: string;
  }>[];
}

export interface AppReleaseEnvelope {
  readonly recordVersion: typeof appReleaseRecordVersion;
  /** Outside the canonical digest input: a release never hashes itself. */
  readonly releaseDigest: Sha256Digest;
  readonly manifest: AppReleaseManifest;
  readonly closure: Readonly<{
    records: readonly AppReleaseClosureRecord[];
    artifacts: readonly AppReleaseClosureArtifact[];
  }>;
}

export interface AppReleaseSidecar {
  readonly recordVersion: 1;
  readonly kind: string;
  readonly releaseDigest: Sha256Digest;
  readonly digest: Sha256Digest;
  readonly createdAt: string;
}

export interface AppReleaseBundle {
  readonly release: AppReleaseEnvelope;
  /** Mutable policy and append-only attestations are deliberately out of identity. */
  readonly sidecars: readonly AppReleaseSidecar[];
}

interface NormalizedLimits {
  features: number;
  migrationsPerFeature: number;
  closureRecords: number;
  closureArtifacts: number;
  recordBytes: number;
  jsonDepth: number;
  jsonNodes: number;
  artifactFiles: number;
  artifactPathBytes: number;
  artifactFileBytes: number;
  artifactBytes: number;
  closureBytes: number;
  sidecars: number;
}

interface MutableAssembly {
  records: AppReleaseClosureRecord[];
  artifacts: AppReleaseClosureArtifact[];
  objects: Map<string, AppReleaseClosureRecord | AppReleaseClosureArtifact>;
  closureBytes: number;
}

const encoder = new TextEncoder();
const stableIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const mediaTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function assembleAppRelease(
  value: AppReleaseAssemblyInput,
  limits: AppReleaseLimits = {},
): AppReleaseEnvelope {
  const bounded = normalizeLimits(limits);
  const input = expectRecord(value, "Release assembly input");
  expectExactKeys(input, [
    "projectId",
    "presentation",
    "displayVersion",
    "runtimeApi",
    "features",
    "dependencyInventory",
    "buildProvenance",
    "inspectionEvidence",
    "createdAt",
  ], "Release assembly input");

  const runtimeApi = parseRuntimeApi(input.runtimeApi);
  const featuresInput = expectArray(input.features, "Release features", bounded.features, true);
  const projectId = parseProjectIdOrReleaseError(input.projectId);
  const assembly: MutableAssembly = { records: [], artifacts: [], objects: new Map(), closureBytes: 0 };
  const features = featuresInput.map((feature, index) => assembleFeature(
    feature,
    index,
    assembly,
    bounded,
    runtimeApi,
  ));
  sortAndRejectDuplicateIds(features, "featureId", "Feature");

  const manifest: AppReleaseManifest = {
    format: appReleaseFormat,
    formatVersion: appReleaseFormatVersion,
    projectId,
    presentation: parsePresentation(input.presentation),
    displayVersion: parseBoundedString(input.displayVersion, "displayVersion", 128),
    runtimeApi,
    features,
    dependencyInventory: addRecord(input.dependencyInventory, "dependencyInventory", assembly, bounded),
    buildProvenance: addRecord(input.buildProvenance, "buildProvenance", assembly, bounded),
    inspectionEvidence: addRecord(input.inspectionEvidence, "inspectionEvidence", assembly, bounded),
    createdAt: parseTimestamp(input.createdAt, "createdAt"),
  };

  assembly.records.sort((left, right) => compareStrings(left.digest, right.digest));
  assembly.artifacts.sort((left, right) => compareStrings(left.digest, right.digest));
  const closure = { records: assembly.records, artifacts: assembly.artifacts };
  const releaseDigest = computeReleaseDigest(manifest, closure);
  return deepFreeze({
    recordVersion: appReleaseRecordVersion,
    releaseDigest,
    manifest,
    closure,
  });
}

export function verifyAppRelease(
  value: unknown,
  limits: AppReleaseLimits = {},
): AppReleaseEnvelope {
  const bounded = normalizeLimits(limits);
  const envelope = expectRecord(value, "App Release envelope");
  expectExactKeys(envelope, ["recordVersion", "releaseDigest", "manifest", "closure"], "App Release envelope");
  if (envelope.recordVersion !== appReleaseRecordVersion) {
    throw invalid(`App Release recordVersion must be ${appReleaseRecordVersion}.`);
  }
  const releaseDigest = parseSha256OrReleaseError(envelope.releaseDigest, "releaseDigest");
  const manifest = parseManifest(envelope.manifest, bounded);
  const closure = parseClosure(envelope.closure, bounded);
  verifyClosureReferences(manifest, closure);
  const computedDigest = computeReleaseDigest(manifest, closure);
  if (computedDigest !== releaseDigest) {
    throw new AppReleaseError("RELEASE_DIGEST_MISMATCH", "App Release digest does not match its manifest and closure.");
  }
  return deepFreeze({ recordVersion: appReleaseRecordVersion, releaseDigest, manifest, closure });
}

export function attachAppReleaseSidecars(
  releaseValue: unknown,
  sidecarValue: unknown,
  limits: AppReleaseLimits = {},
): AppReleaseBundle {
  const bounded = normalizeLimits(limits);
  const release = verifyAppRelease(releaseValue, bounded);
  const sidecars = parseSidecars(sidecarValue, release.releaseDigest, bounded);
  return deepFreeze({ release, sidecars });
}

export function verifyAppReleaseBundle(
  value: unknown,
  limits: AppReleaseLimits = {},
): AppReleaseBundle {
  const bundle = expectRecord(value, "App Release bundle");
  expectExactKeys(bundle, ["release", "sidecars"], "App Release bundle");
  return attachAppReleaseSidecars(bundle.release, bundle.sidecars, limits);
}

function assembleFeature(
  value: unknown,
  index: number,
  assembly: MutableAssembly,
  limits: NormalizedLimits,
  releaseRuntimeApi: AppReleaseManifest["runtimeApi"],
): AppReleaseFeature {
  const label = `Feature ${index + 1}`;
  const record = expectRecord(value, label);
  expectExactKeys(record, ["featureId", "featureRevision", "declaration", "dataSchema", "migrations"], label);
  const featureId = parseStableId(record.featureId, `${label} featureId`);
  const migrationsInput = expectArray(record.migrations, `${label} migrations`, limits.migrationsPerFeature);
  const migrations = migrationsInput.map((migration, migrationIndex) => {
    const migrationLabel = `${label} migration ${migrationIndex + 1}`;
    const migrationRecord = expectRecord(migration, migrationLabel);
    expectExactKeys(
      migrationRecord,
      ["migrationId", "sourceSchema", "targetSchema", "execution", "artifact"],
      migrationLabel,
    );
    return {
      migrationId: parseStableId(migrationRecord.migrationId, `${migrationLabel} migrationId`),
      sourceSchema: assembleMigrationSchema(
        migrationRecord.sourceSchema,
        `${migrationLabel} sourceSchema`,
        assembly,
        limits,
      ),
      targetSchema: assembleMigrationSchema(
        migrationRecord.targetSchema,
        `${migrationLabel} targetSchema`,
        assembly,
        limits,
      ),
      execution: assembleMigrationExecution(
        migrationRecord.execution,
        `${migrationLabel} execution`,
        assembly,
        limits,
        releaseRuntimeApi,
      ),
      artifact: addArtifact(migrationRecord.artifact, `${migrationLabel} artifact`, assembly, limits),
    };
  });
  sortAndRejectDuplicateIds(migrations, "migrationId", `${label} migration`);

  let dataSchema: AppReleaseFeature["dataSchema"] = null;
  if (record.dataSchema !== null) {
    const schema = expectRecord(record.dataSchema, `${label} dataSchema`);
    expectExactKeys(schema, ["schemaId", "version", "definition"], `${label} dataSchema`);
    dataSchema = {
      schemaId: parseStableId(schema.schemaId, `${label} dataSchema schemaId`),
      version: parsePositiveInteger(schema.version, `${label} dataSchema version`),
      definition: addRecord(schema.definition, `${label} dataSchema definition`, assembly, limits),
    };
  }
  return {
    featureId,
    featureRevision: addArtifact(record.featureRevision, `${label} featureRevision`, assembly, limits),
    declaration: addRecord(record.declaration, `${label} declaration`, assembly, limits),
    dataSchema,
    migrations,
  };
}

function assembleMigrationExecution(
  value: unknown,
  label: string,
  assembly: MutableAssembly,
  limits: NormalizedLimits,
  releaseRuntimeApi: AppReleaseManifest["runtimeApi"],
): AppReleaseFeature["migrations"][number]["execution"] {
  const record = expectRecord(value, label);
  expectExactKeys(record, [
    "runtimeApi",
    "mode",
    "resourceLimits",
    "namespaceAccess",
    "externalEffects",
    "resumePolicy",
    "verification",
    "receiptStates",
  ], label);
  const runtimeApi = parseRuntimeApi(record.runtimeApi);
  assertRuntimeApiMatches(runtimeApi, releaseRuntimeApi, label);
  return {
    runtimeApi,
    mode: parseMigrationMode(record.mode, `${label} mode`),
    resourceLimits: parseMigrationResourceLimits(record.resourceLimits, `${label} resourceLimits`),
    namespaceAccess: parseMigrationNamespaceAccess(record.namespaceAccess, `${label} namespaceAccess`),
    externalEffects: parseMigrationExternalEffects(record.externalEffects, `${label} externalEffects`),
    resumePolicy: parseMigrationResumePolicy(record.resumePolicy, `${label} resumePolicy`),
    verification: addRecord(record.verification, `${label} verification`, assembly, limits),
    receiptStates: parseMigrationReceiptStates(record.receiptStates, `${label} receiptStates`),
  };
}

function assembleMigrationSchema(
  value: unknown,
  label: string,
  assembly: MutableAssembly,
  limits: NormalizedLimits,
): AppReleaseSchemaReference {
  const record = expectRecord(value, label);
  expectExactKeys(record, ["schemaId", "version", "definition"], label);
  const definition = addRecord(record.definition, `${label} definition`, assembly, limits);
  return {
    schemaId: parseStableId(record.schemaId, `${label} schemaId`),
    version: parsePositiveInteger(record.version, `${label} version`),
    digest: definition.digest,
    definition,
  };
}

function addRecord(
  value: unknown,
  label: string,
  assembly: MutableAssembly,
  limits: NormalizedLimits,
): AppReleaseRecordReference {
  const input = expectRecord(value, label);
  expectExactKeys(input, ["mediaType", "value"], label);
  const mediaType = parseMediaType(input.mediaType, `${label} mediaType`);
  const canonical = canonicalJson(input.value, label, limits);
  const sizeBytes = encoder.encode(canonical).byteLength;
  if (sizeBytes > limits.recordBytes) throw limit(`${label} exceeds the ${limits.recordBytes}-byte record limit.`);
  const digest = parseSha256OrReleaseError(computeDeclarationDigest(JSON.parse(canonical)), `${label} digest`);
  const existing = assembly.objects.get(digest);
  if (existing) {
    if (existing.kind !== "record" || existing.mediaType !== mediaType || existing.sizeBytes !== sizeBytes) {
      throw new AppReleaseError(
        "RELEASE_DUPLICATE_REFERENCE",
        `${label} reuses closure digest ${digest} with conflicting metadata.`,
      );
    }
    return { kind: "record", digest, mediaType, sizeBytes };
  }
  if (assembly.records.length >= limits.closureRecords) {
    throw limit(`Release cannot contain more than ${limits.closureRecords} closure records.`);
  }
  addClosureBytes(assembly, sizeBytes, limits);
  const closureRecord = { kind: "record" as const, digest, mediaType, sizeBytes, value: JSON.parse(canonical) };
  assembly.objects.set(digest, closureRecord);
  assembly.records.push(closureRecord);
  return { kind: "record", digest, mediaType, sizeBytes };
}

function addArtifact(
  value: unknown,
  label: string,
  assembly: MutableAssembly,
  limits: NormalizedLimits,
): AppReleaseArtifactReference {
  const input = expectRecord(value, label);
  expectExactKeys(input, ["mediaType", "entries"], label);
  const entryValues = expectArray(input.entries, `${label} entries`, limits.artifactFiles);
  const entries: AppPlatformArtifactEntry[] = [];
  let artifactBytes = 0;
  for (const entryValue of entryValues) {
    const entry = expectRecord(entryValue, `${label} entry`);
    expectExactKeys(entry, ["path", "bytes"], `${label} entry`);
    if (typeof entry.path !== "string" || !(entry.bytes instanceof Uint8Array)) {
      throw invalid(`${label} entries require a string path and Uint8Array bytes.`);
    }
    if (entry.bytes.byteLength > limits.artifactFileBytes) {
      throw limit(`${label} file ${entry.path} exceeds the ${limits.artifactFileBytes}-byte limit.`);
    }
    artifactBytes = safeAdd(artifactBytes, entry.bytes.byteLength, `${label} size`);
    if (artifactBytes > limits.artifactBytes) {
      throw limit(`${label} exceeds the ${limits.artifactBytes}-byte artifact limit.`);
    }
    entries.push({ path: entry.path, bytes: new Uint8Array(entry.bytes) });
  }
  const digest = hashArtifact(entries, limits, label);
  const sizeBytes = artifactBytes;
  const mediaType = parseMediaType(input.mediaType, `${label} mediaType`);
  const existing = assembly.objects.get(digest);
  if (existing) {
    if (existing.kind !== "artifact" || existing.mediaType !== mediaType || existing.sizeBytes !== sizeBytes) {
      throw new AppReleaseError(
        "RELEASE_DUPLICATE_REFERENCE",
        `${label} reuses closure digest ${digest} with conflicting metadata.`,
      );
    }
    return { kind: "artifact", digest, mediaType, sizeBytes };
  }
  if (assembly.artifacts.length >= limits.closureArtifacts) {
    throw limit(`Release cannot contain more than ${limits.closureArtifacts} closure artifacts.`);
  }
  addClosureBytes(assembly, sizeBytes, limits);
  const encodedEntries = entries
    .map((entry) => ({ path: entry.path, bytesBase64: Buffer.from(entry.bytes).toString("base64") }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const closureArtifact = { kind: "artifact" as const, digest, mediaType, sizeBytes, entries: encodedEntries };
  assembly.objects.set(digest, closureArtifact);
  assembly.artifacts.push(closureArtifact);
  return { kind: "artifact", digest, mediaType, sizeBytes };
}

function parseManifest(value: unknown, limits: NormalizedLimits): AppReleaseManifest {
  const record = expectRecord(value, "App Release manifest");
  expectExactKeys(record, [
    "format",
    "formatVersion",
    "projectId",
    "presentation",
    "displayVersion",
    "runtimeApi",
    "features",
    "dependencyInventory",
    "buildProvenance",
    "inspectionEvidence",
    "createdAt",
  ], "App Release manifest");
  if (record.format !== appReleaseFormat || record.formatVersion !== appReleaseFormatVersion) {
    throw invalid(`App Release manifest format must be ${appReleaseFormat} version ${appReleaseFormatVersion}.`);
  }
  const featureValues = expectArray(record.features, "App Release features", limits.features, true);
  const features = featureValues.map((feature, index) => parseFeature(feature, index, limits));
  assertCanonicalIds(features, "featureId", "App Release features");
  const runtimeApi = parseRuntimeApi(record.runtimeApi);
  for (const feature of features) {
    for (const migration of feature.migrations) {
      assertRuntimeApiMatches(migration.execution.runtimeApi, runtimeApi, `Migration ${feature.featureId}/${migration.migrationId}`);
    }
  }
  return {
    format: appReleaseFormat,
    formatVersion: appReleaseFormatVersion,
    projectId: parseProjectIdOrReleaseError(record.projectId),
    presentation: parsePresentation(record.presentation),
    displayVersion: parseBoundedString(record.displayVersion, "displayVersion", 128),
    runtimeApi,
    features,
    dependencyInventory: parseReference(record.dependencyInventory, "record", "dependencyInventory"),
    buildProvenance: parseReference(record.buildProvenance, "record", "buildProvenance"),
    inspectionEvidence: parseReference(record.inspectionEvidence, "record", "inspectionEvidence"),
    createdAt: parseTimestamp(record.createdAt, "createdAt"),
  };
}

function parseFeature(value: unknown, index: number, limits: NormalizedLimits): AppReleaseFeature {
  const label = `Feature ${index + 1}`;
  const record = expectRecord(value, label);
  expectExactKeys(record, ["featureId", "featureRevision", "declaration", "dataSchema", "migrations"], label);
  const migrationValues = expectArray(record.migrations, `${label} migrations`, limits.migrationsPerFeature);
  const migrations = migrationValues.map((migration, migrationIndex) => {
    const migrationLabel = `${label} migration ${migrationIndex + 1}`;
    const migrationRecord = expectRecord(migration, migrationLabel);
    expectExactKeys(
      migrationRecord,
      ["migrationId", "sourceSchema", "targetSchema", "execution", "artifact"],
      migrationLabel,
    );
    return {
      migrationId: parseStableId(migrationRecord.migrationId, `${migrationLabel} migrationId`),
      sourceSchema: parseSchemaReference(migrationRecord.sourceSchema, `${migrationLabel} sourceSchema`),
      targetSchema: parseSchemaReference(migrationRecord.targetSchema, `${migrationLabel} targetSchema`),
      execution: parseMigrationExecution(migrationRecord.execution, `${migrationLabel} execution`),
      artifact: parseReference(migrationRecord.artifact, "artifact", `${migrationLabel} artifact`),
    };
  });
  assertCanonicalIds(migrations, "migrationId", `${label} migrations`);

  let dataSchema: AppReleaseFeature["dataSchema"] = null;
  if (record.dataSchema !== null) {
    const schema = expectRecord(record.dataSchema, `${label} dataSchema`);
    expectExactKeys(schema, ["schemaId", "version", "definition"], `${label} dataSchema`);
    dataSchema = {
      schemaId: parseStableId(schema.schemaId, `${label} dataSchema schemaId`),
      version: parsePositiveInteger(schema.version, `${label} dataSchema version`),
      definition: parseReference(schema.definition, "record", `${label} dataSchema definition`),
    };
  }
  return {
    featureId: parseStableId(record.featureId, `${label} featureId`),
    featureRevision: parseReference(record.featureRevision, "artifact", `${label} featureRevision`),
    declaration: parseReference(record.declaration, "record", `${label} declaration`),
    dataSchema,
    migrations,
  };
}

function parseMigrationExecution(
  value: unknown,
  label: string,
): AppReleaseFeature["migrations"][number]["execution"] {
  const record = expectRecord(value, label);
  expectExactKeys(record, [
    "runtimeApi",
    "mode",
    "resourceLimits",
    "namespaceAccess",
    "externalEffects",
    "resumePolicy",
    "verification",
    "receiptStates",
  ], label);
  return {
    runtimeApi: parseRuntimeApi(record.runtimeApi),
    mode: parseMigrationMode(record.mode, `${label} mode`),
    resourceLimits: parseMigrationResourceLimits(record.resourceLimits, `${label} resourceLimits`),
    namespaceAccess: parseMigrationNamespaceAccess(record.namespaceAccess, `${label} namespaceAccess`),
    externalEffects: parseMigrationExternalEffects(record.externalEffects, `${label} externalEffects`),
    resumePolicy: parseMigrationResumePolicy(record.resumePolicy, `${label} resumePolicy`),
    verification: parseReference(record.verification, "record", `${label} verification`),
    receiptStates: parseMigrationReceiptStates(record.receiptStates, `${label} receiptStates`),
  };
}

function parseSchemaReference(value: unknown, label: string): AppReleaseSchemaReference {
  const record = expectRecord(value, label);
  expectExactKeys(record, ["schemaId", "version", "digest", "definition"], label);
  const definition = parseReference(record.definition, "record", `${label} definition`);
  const digest = parseSha256OrReleaseError(record.digest, `${label} digest`);
  if (definition.digest !== digest) throw digestMismatch(`${label} digest must match its exact definition reference.`);
  return {
    schemaId: parseStableId(record.schemaId, `${label} schemaId`),
    version: parsePositiveInteger(record.version, `${label} version`),
    digest,
    definition,
  };
}

function parseMigrationMode(value: unknown, label: string): "online" | "maintenance" {
  if (value !== "online" && value !== "maintenance") throw invalid(`${label} must be online or maintenance.`);
  return value;
}

function parseMigrationResourceLimits(
  value: unknown,
  label: string,
): AppReleaseFeature["migrations"][number]["execution"]["resourceLimits"] {
  const record = expectRecord(value, label);
  expectExactKeys(record, ["maxDurationMs", "maxMemoryBytes", "maxReadBytes", "maxWriteBytes"], label);
  return {
    maxDurationMs: parsePositiveInteger(record.maxDurationMs, `${label} maxDurationMs`),
    maxMemoryBytes: parsePositiveInteger(record.maxMemoryBytes, `${label} maxMemoryBytes`),
    maxReadBytes: parsePositiveInteger(record.maxReadBytes, `${label} maxReadBytes`),
    maxWriteBytes: parsePositiveInteger(record.maxWriteBytes, `${label} maxWriteBytes`),
  };
}

function parseMigrationNamespaceAccess(value: unknown, label: string): "feature-data-only" {
  if (value !== "feature-data-only") throw invalid(`${label} must be feature-data-only.`);
  return value;
}

function parseMigrationExternalEffects(
  value: unknown,
  label: string,
): AppReleaseFeature["migrations"][number]["execution"]["externalEffects"] {
  const record = expectRecord(value, label);
  expectExactKeys(record, ["network", "connections", "notifications"], label);
  if (record.network !== false || record.connections !== false || record.notifications !== false) {
    throw invalid(`${label} must disable network, connections, and notifications.`);
  }
  return { network: false, connections: false, notifications: false };
}

function parseMigrationResumePolicy(
  value: unknown,
  label: string,
): "idempotent-restart" | "checkpointed" {
  if (value !== "idempotent-restart" && value !== "checkpointed") {
    throw invalid(`${label} must be idempotent-restart or checkpointed.`);
  }
  return value;
}

function parseMigrationReceiptStates(
  value: unknown,
  label: string,
): AppReleaseFeature["migrations"][number]["execution"]["receiptStates"] {
  const record = expectRecord(value, label);
  expectExactKeys(record, ["success", "failure", "cancelled"], label);
  if (record.success !== "verified" || record.failure !== "failed" || record.cancelled !== "cancelled") {
    throw invalid(`${label} must use verified, failed, and cancelled terminal states.`);
  }
  return { success: "verified", failure: "failed", cancelled: "cancelled" };
}

function assertRuntimeApiMatches(
  actual: AppReleaseManifest["runtimeApi"],
  expected: AppReleaseManifest["runtimeApi"],
  label: string,
): void {
  if (actual.name !== expected.name || actual.compatibleRange !== expected.compatibleRange) {
    throw invalid(`${label} runtimeApi must exactly match the enclosing Release runtimeApi.`);
  }
}

function parseClosure(
  value: unknown,
  limits: NormalizedLimits,
): AppReleaseEnvelope["closure"] {
  const record = expectRecord(value, "App Release closure");
  expectExactKeys(record, ["records", "artifacts"], "App Release closure");
  const recordValues = expectArray(record.records, "App Release closure records", limits.closureRecords);
  const artifactValues = expectArray(record.artifacts, "App Release closure artifacts", limits.closureArtifacts);
  let closureBytes = 0;
  const digests = new Set<string>();
  const records = recordValues.map((item, index) => {
    const label = `Closure record ${index + 1}`;
    const entry = expectRecord(item, label);
    expectExactKeys(entry, ["kind", "digest", "mediaType", "sizeBytes", "value"], label);
    if (entry.kind !== "record") throw invalid(`${label} kind must be record.`);
    const mediaType = parseMediaType(entry.mediaType, `${label} mediaType`);
    const canonical = canonicalJson(entry.value, label, limits);
    const sizeBytes = encoder.encode(canonical).byteLength;
    if (sizeBytes > limits.recordBytes) throw limit(`${label} exceeds the ${limits.recordBytes}-byte record limit.`);
    if (entry.sizeBytes !== sizeBytes) throw digestMismatch(`${label} size does not match its canonical bytes.`);
    closureBytes = addBoundedClosureBytes(closureBytes, sizeBytes, limits);
    const digest = parseSha256OrReleaseError(entry.digest, `${label} digest`);
    if (parseSha256OrReleaseError(computeDeclarationDigest(JSON.parse(canonical)), `${label} computed digest`) !== digest) {
      throw digestMismatch(`${label} digest does not match its canonical value.`);
    }
    registerDigest(digests, digest, label);
    return { kind: "record" as const, digest, mediaType, sizeBytes, value: JSON.parse(canonical) };
  });
  assertCanonicalDigests(records, "Closure records");

  const artifacts = artifactValues.map((item, index) => {
    const label = `Closure artifact ${index + 1}`;
    const entry = expectRecord(item, label);
    expectExactKeys(entry, ["kind", "digest", "mediaType", "sizeBytes", "entries"], label);
    if (entry.kind !== "artifact") throw invalid(`${label} kind must be artifact.`);
    const entryValues = expectArray(entry.entries, `${label} entries`, limits.artifactFiles);
    const decoded: AppPlatformArtifactEntry[] = [];
    let artifactBytes = 0;
    for (let entryIndex = 0; entryIndex < entryValues.length; entryIndex += 1) {
      const entryValue = entryValues[entryIndex];
      const entryLabel = `${label} entry ${entryIndex + 1}`;
      const content = expectRecord(entryValue, entryLabel);
      expectExactKeys(content, ["path", "bytesBase64"], entryLabel);
      if (typeof content.path !== "string") throw invalid(`${entryLabel} path must be a string.`);
      const byteLength = base64ByteLength(content.bytesBase64, entryLabel, limits.artifactFileBytes);
      artifactBytes = safeAdd(artifactBytes, byteLength, `${label} size`);
      if (artifactBytes > limits.artifactBytes) {
        throw limit(`${label} exceeds the ${limits.artifactBytes}-byte artifact limit.`);
      }
      if (safeAdd(closureBytes, artifactBytes, "Release closure size") > limits.closureBytes) {
        throw limit(`Release closure exceeds the ${limits.closureBytes}-byte limit.`);
      }
      decoded.push({ path: content.path, bytes: decodeBase64(content.bytesBase64, entryLabel, byteLength) });
    }
    assertCanonicalArtifactPaths(decoded, `${label} entries`);
    const digest = parseArtifactDigestOrReleaseError(entry.digest, `${label} digest`);
    if (hashArtifact(decoded, limits, label) !== digest) {
      throw digestMismatch(`${label} digest does not match its entries.`);
    }
    const sizeBytes = artifactBytes;
    if (entry.sizeBytes !== sizeBytes) throw digestMismatch(`${label} size does not match its entry bytes.`);
    closureBytes = addBoundedClosureBytes(closureBytes, sizeBytes, limits);
    registerDigest(digests, digest, label);
    return {
      kind: "artifact" as const,
      digest,
      mediaType: parseMediaType(entry.mediaType, `${label} mediaType`),
      sizeBytes,
      entries: decoded.map((content) => ({
        path: content.path,
        bytesBase64: Buffer.from(content.bytes).toString("base64"),
      })),
    };
  });
  assertCanonicalDigests(artifacts, "Closure artifacts");
  return { records, artifacts };
}

function verifyClosureReferences(manifest: AppReleaseManifest, closure: AppReleaseEnvelope["closure"]): void {
  const objects = new Map<string, AppReleaseClosureRecord | AppReleaseClosureArtifact>();
  for (const object of [...closure.records, ...closure.artifacts]) objects.set(object.digest, object);
  const referenced = new Set<string>();
  const visit = (reference: AppReleaseRecordReference | AppReleaseArtifactReference, label: string): void => {
    referenced.add(reference.digest);
    const object = objects.get(reference.digest);
    if (!object) throw new AppReleaseError("RELEASE_OBJECT_MISSING", `${label} references a missing closure object.`);
    if (object.kind !== reference.kind || object.mediaType !== reference.mediaType || object.sizeBytes !== reference.sizeBytes) {
      throw digestMismatch(`${label} metadata does not match its closure object.`);
    }
  };
  for (const feature of manifest.features) {
    visit(feature.featureRevision, `Feature ${feature.featureId} revision`);
    visit(feature.declaration, `Feature ${feature.featureId} declaration`);
    if (feature.dataSchema) visit(feature.dataSchema.definition, `Feature ${feature.featureId} data schema`);
    for (const migration of feature.migrations) {
      visit(migration.artifact, `Migration ${feature.featureId}/${migration.migrationId}`);
      visit(migration.sourceSchema.definition, `Migration ${feature.featureId}/${migration.migrationId} source schema`);
      visit(migration.targetSchema.definition, `Migration ${feature.featureId}/${migration.migrationId} target schema`);
      visit(migration.execution.verification, `Migration ${feature.featureId}/${migration.migrationId} verification`);
    }
  }
  visit(manifest.dependencyInventory, "Dependency inventory");
  visit(manifest.buildProvenance, "Build provenance");
  visit(manifest.inspectionEvidence, "Inspection evidence");
  for (const digest of objects.keys()) {
    if (!referenced.has(digest)) {
      throw new AppReleaseError("RELEASE_OBJECT_UNREFERENCED", `Closure object ${digest} is not referenced by the manifest.`);
    }
  }
}

function parseSidecars(value: unknown, releaseDigest: Sha256Digest, limits: NormalizedLimits): AppReleaseSidecar[] {
  const values = expectArray(value, "App Release sidecars", limits.sidecars);
  const seen = new Set<string>();
  return values.map((item, index) => {
    const label = `Sidecar ${index + 1}`;
    const record = expectRecord(item, label);
    expectExactKeys(record, ["recordVersion", "kind", "releaseDigest", "digest", "createdAt"], label);
    if (record.recordVersion !== 1) throw invalid(`${label} recordVersion must be 1.`);
    const boundDigest = parseSha256OrReleaseError(record.releaseDigest, `${label} releaseDigest`);
    if (boundDigest !== releaseDigest) throw digestMismatch(`${label} names a different App Release.`);
    const digest = parseSha256OrReleaseError(record.digest, `${label} digest`);
    if (seen.has(digest)) throw new AppReleaseError("RELEASE_DUPLICATE_REFERENCE", `${label} digest is duplicated.`);
    seen.add(digest);
    return {
      recordVersion: 1 as const,
      kind: parseStableId(record.kind, `${label} kind`),
      releaseDigest: boundDigest,
      digest,
      createdAt: parseTimestamp(record.createdAt, `${label} createdAt`),
    };
  });
}

function computeReleaseDigest(
  manifest: AppReleaseManifest,
  closure: AppReleaseEnvelope["closure"],
): Sha256Digest {
  const closureRoot = {
    records: closure.records.map(({ kind, digest, mediaType, sizeBytes }) => ({ kind, digest, mediaType, sizeBytes })),
    artifacts: closure.artifacts.map(({ kind, digest, mediaType, sizeBytes }) => ({ kind, digest, mediaType, sizeBytes })),
  };
  return parseSha256OrReleaseError(computeDeclarationDigest({
    domain: "work-fold.app-release.root",
    formatVersion: appReleaseFormatVersion,
    manifest,
    closure: closureRoot,
  }), "computed release digest");
}

function parseReference(value: unknown, expectedKind: "record", label: string): AppReleaseRecordReference;
function parseReference(value: unknown, expectedKind: "artifact", label: string): AppReleaseArtifactReference;
function parseReference(
  value: unknown,
  expectedKind: "record" | "artifact",
  label: string,
): AppReleaseRecordReference | AppReleaseArtifactReference {
  const record = expectRecord(value, label);
  expectExactKeys(record, ["kind", "digest", "mediaType", "sizeBytes"], label);
  if (record.kind !== expectedKind) throw invalid(`${label} kind must be ${expectedKind}.`);
  const common = {
    mediaType: parseMediaType(record.mediaType, `${label} mediaType`),
    sizeBytes: parseNonNegativeInteger(record.sizeBytes, `${label} sizeBytes`),
  };
  return expectedKind === "record"
    ? { kind: "record", digest: parseSha256OrReleaseError(record.digest, `${label} digest`), ...common }
    : { kind: "artifact", digest: parseArtifactDigestOrReleaseError(record.digest, `${label} digest`), ...common };
}

function parseRuntimeApi(value: unknown): AppReleaseManifest["runtimeApi"] {
  const record = expectRecord(value, "runtimeApi");
  expectExactKeys(record, ["name", "compatibleRange"], "runtimeApi");
  return {
    name: parseBoundedString(record.name, "runtimeApi name", 128),
    compatibleRange: parseBoundedString(record.compatibleRange, "runtimeApi compatibleRange", 128),
  };
}

function parsePresentation(value: unknown): AppReleasePresentation {
  const record = expectRecord(value, "presentation");
  expectExactKeys(record, ["title", "description", "icon"], "presentation");
  return {
    title: parseBoundedString(record.title, "presentation title", 80),
    description: record.description === null
      ? null
      : parseBoundedString(record.description, "presentation description", 280),
    icon: record.icon === null ? null : parseStableId(record.icon, "presentation icon"),
  };
}

function canonicalJson(value: unknown, label: string, limits: NormalizedLimits): string {
  assertJsonBounds(value, label, limits);
  try {
    return canonicalizeJson(value);
  } catch (error) {
    throw invalid(`${label} must be canonicalizable I-JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertJsonBounds(value: unknown, label: string, limits: NormalizedLimits): void {
  const stack: Array<{ value: unknown; depth: number; exiting?: boolean }> = [{ value, depth: 1 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  let stringBytes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.exiting) {
      ancestors.delete(current.value as object);
      continue;
    }
    nodes += 1;
    if (nodes > limits.jsonNodes) throw limit(`${label} exceeds the ${limits.jsonNodes}-node JSON limit.`);
    if (current.depth > limits.jsonDepth) throw limit(`${label} exceeds the ${limits.jsonDepth}-level JSON depth limit.`);
    if (typeof current.value === "string") {
      stringBytes = safeAdd(stringBytes, Buffer.byteLength(current.value, "utf8"), `${label} JSON string size`);
      if (stringBytes > limits.recordBytes) {
        throw limit(`${label} exceeds the ${limits.recordBytes}-byte pre-canonical JSON string limit.`);
      }
    }
    if (!current.value || typeof current.value !== "object") continue;
    const object = current.value as object;
    if (ancestors.has(object)) throw invalid(`${label} contains a cyclic reference.`);
    const prototype = Object.getPrototypeOf(object);
    if (!Array.isArray(object) && prototype !== Object.prototype && prototype !== null) {
      throw invalid(`${label} contains an unsupported object type.`);
    }
    ancestors.add(object);
    stack.push({ value: current.value, depth: current.depth, exiting: true });
    const children: unknown[] = [];
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key === "symbol") throw invalid(`${label} contains an unsupported symbol property.`);
      if (Array.isArray(object) && key === "length") continue;
      if (!Array.isArray(object)) {
        stringBytes = safeAdd(stringBytes, Buffer.byteLength(key, "utf8"), `${label} JSON string size`);
        if (stringBytes > limits.recordBytes) {
          throw limit(`${label} exceeds the ${limits.recordBytes}-byte pre-canonical JSON string limit.`);
        }
      }
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw invalid(`${label} contains an unsupported property descriptor.`);
      }
      if (Array.isArray(object)
        && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= object.length)) {
        throw invalid(`${label} contains an unsupported array property.`);
      }
      children.push(descriptor.value);
    }
    if (Array.isArray(object) && children.length !== object.length) {
      throw invalid(`${label} contains an array hole.`);
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: current.depth + 1 });
    }
  }
}

function hashArtifact(entries: AppPlatformArtifactEntry[], limits: NormalizedLimits, label: string): AppPlatformArtifactDigest {
  try {
    return hashAppPlatformArtifact(entries, {
      files: limits.artifactFiles,
      pathBytes: limits.artifactPathBytes,
      fileBytes: limits.artifactFileBytes,
      totalBytes: limits.artifactBytes,
    });
  } catch (error) {
    if (error instanceof AppPlatformArtifactError && error.code === "ARTIFACT_LIMIT_EXCEEDED") {
      throw limit(`${label} exceeds an artifact bound: ${error.message}`);
    }
    throw invalid(`${label} is not a valid closed artifact: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeLimits(value: AppReleaseLimits): NormalizedLimits {
  const record = expectRecord(value, "App Release limits");
  const keys = Object.keys(appReleaseDefaultLimits) as (keyof NormalizedLimits)[];
  expectOnlyKeys(record, keys, "App Release limits");
  const result = {} as NormalizedLimits;
  for (const key of keys) {
    const specified = record[key];
    const fallback = appReleaseDefaultLimits[key];
    const minimum = key === "artifactPathBytes" ? 1 : 0;
    const maximum = key === "artifactFiles" || key === "artifactPathBytes" ? 0xffff_ffff : Number.MAX_SAFE_INTEGER;
    if (specified !== undefined
      && (!Number.isSafeInteger(specified) || (specified as number) < minimum || (specified as number) > maximum)) {
      throw invalid(`App Release ${key} limit must be a safe integer from ${minimum} through ${maximum}.`);
    }
    result[key] = (specified ?? fallback) as number;
  }
  return result;
}

function base64ByteLength(value: unknown, label: string, maximumBytes: number): number {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw invalid(`${label} bytesBase64 must be canonical RFC 4648 base64.`);
  }
  if (value.length > Math.ceil(maximumBytes / 3) * 4) {
    throw limit(`${label} exceeds the ${maximumBytes}-byte artifact file limit.`);
  }
  if (!canonicalBase64Pattern.test(value)) throw invalid(`${label} bytesBase64 must be canonical RFC 4648 base64.`);
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const expectedBytes = (value.length / 4) * 3 - padding;
  if (expectedBytes > maximumBytes) throw limit(`${label} exceeds the ${maximumBytes}-byte artifact file limit.`);
  return expectedBytes;
}

function decodeBase64(value: unknown, label: string, expectedBytes: number): Uint8Array {
  if (typeof value !== "string") throw invalid(`${label} bytesBase64 must be canonical RFC 4648 base64.`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== expectedBytes || decoded.toString("base64") !== value) {
    throw invalid(`${label} bytesBase64 is not canonical.`);
  }
  return new Uint8Array(decoded);
}

function parseProjectIdOrReleaseError(value: unknown): ProjectId {
  try {
    return parseProjectId(value);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}

function parseSha256OrReleaseError(value: unknown, label: string): Sha256Digest {
  try {
    return parseSha256Digest(value, label);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}

function parseArtifactDigestOrReleaseError(value: unknown, label: string): AppPlatformArtifactDigest {
  try {
    return parseAppPlatformArtifactDigest(value);
  } catch (error) {
    throw invalid(`${label} must be a work-fold.artifact.v1 digest: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseMediaType(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 128 || !mediaTypePattern.test(value)) {
    throw invalid(`${label} must be a lowercase media type without parameters.`);
  }
  return value;
}

function parseStableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !stableIdPattern.test(value)) {
    throw invalid(`${label} must use 1-64 lowercase letters, numbers, or hyphens.`);
  }
  return value;
}

function parseBoundedString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength || hasLoneSurrogate(value)) {
    throw invalid(`${label} must be a non-empty Unicode string of at most ${maximumLength} UTF-16 code units.`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  const timestamp = parseBoundedString(value, label, 64);
  const parsed = new Date(timestamp);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
    || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw invalid(`${label} must be a canonical UTC timestamp with milliseconds.`);
  }
  return timestamp;
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalid(`${label} must be a positive safe integer.`);
  return value as number;
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(`${label} must be a non-negative safe integer.`);
  return value as number;
}

function registerDigest(digests: Set<string>, digest: string, label: string): void {
  if (digests.has(digest)) {
    throw new AppReleaseError(
      "RELEASE_DUPLICATE_REFERENCE",
      `${label} duplicates closure digest ${digest}; each immutable closure object must be uniquely referenced.`,
    );
  }
  digests.add(digest);
}

function sortAndRejectDuplicateIds<T extends Record<Key, string>, Key extends keyof T>(
  values: T[],
  key: Key,
  label: string,
): void {
  values.sort((left, right) => compareStrings(left[key], right[key]));
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]![key] === values[index]![key]) {
      throw new AppReleaseError("RELEASE_DUPLICATE_REFERENCE", `${label} id ${values[index]![key]} is duplicated.`);
    }
  }
}

function assertCanonicalIds<T extends Record<Key, string>, Key extends keyof T>(
  values: readonly T[],
  key: Key,
  label: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    const order = compareStrings(values[index - 1]![key], values[index]![key]);
    if (order === 0) throw new AppReleaseError("RELEASE_DUPLICATE_REFERENCE", `${label} contains duplicate id ${values[index]![key]}.`);
    if (order > 0) throw new AppReleaseError("RELEASE_NON_CANONICAL", `${label} must be ordered by id.`);
  }
}

function assertCanonicalDigests(values: readonly { digest: string }[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareStrings(values[index - 1]!.digest, values[index]!.digest) >= 0) {
      throw new AppReleaseError("RELEASE_NON_CANONICAL", `${label} must have unique digests in canonical order.`);
    }
  }
}

function assertCanonicalArtifactPaths(values: readonly { path: string }[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareUtf8(values[index - 1]!.path, values[index]!.path) >= 0) {
      throw new AppReleaseError("RELEASE_NON_CANONICAL", `${label} must have unique paths in canonical UTF-8 order.`);
    }
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const shared = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < shared; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function addClosureBytes(assembly: MutableAssembly, bytes: number, limits: NormalizedLimits): void {
  assembly.closureBytes = addBoundedClosureBytes(assembly.closureBytes, bytes, limits);
}

function addBoundedClosureBytes(current: number, bytes: number, limits: NormalizedLimits): number {
  const total = safeAdd(current, bytes, "Release closure size");
  if (total > limits.closureBytes) throw limit(`Release closure exceeds the ${limits.closureBytes}-byte limit.`);
  return total;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw limit(`${label} exceeds the safe integer range.`);
  return result;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid(`${label} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw invalid(`${label} contains an unsupported symbol field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid(`${label} contains an unsupported field descriptor.`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string, maximum: number, requireNonEmpty = false): unknown[] {
  if (!Array.isArray(value)) throw invalid(`${label} must be an array.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw invalid(`${label} contains an unsupported symbol property.`);
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      throw invalid(`${label} contains an unsupported array property.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(`${label} contains an unsupported array property descriptor.`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw invalid(`${label} cannot contain array holes.`);
  }
  if (requireNonEmpty && value.length === 0) throw invalid(`${label} must contain at least one item.`);
  if (value.length > maximum) throw limit(`${label} cannot contain more than ${maximum} items.`);
  return value;
}

function expectExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  expectOnlyKeys(record, keys, label);
  const missing = keys.find((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (missing) throw invalid(`${label} is missing required field ${missing}.`);
}

function expectOnlyKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const accepted = new Set(keys);
  const unsupported = Object.keys(record).find((key) => !accepted.has(key));
  if (unsupported) throw invalid(`${label} contains unsupported field ${unsupported}.`);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function invalid(message: string): AppReleaseError {
  return new AppReleaseError("RELEASE_INVALID", message);
}

function limit(message: string): AppReleaseError {
  return new AppReleaseError("RELEASE_LIMIT_EXCEEDED", message);
}

function digestMismatch(message: string): AppReleaseError {
  return new AppReleaseError("RELEASE_DIGEST_MISMATCH", message);
}
