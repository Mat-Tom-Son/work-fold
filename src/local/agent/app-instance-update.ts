import {
  canonicalizeJson,
  computeDeclarationDigest,
  parseDataNamespaceId,
  parseFeatureInstallationId,
  parseProjectId,
  parseRuntimeInstanceId,
  parseSha256Digest,
  type AuthorityStampField,
  type DataNamespaceId,
  type FeatureInstallationId,
  type ProjectId,
  type RuntimeInstanceId,
  type Sha256Digest,
} from "./app-platform-contract.js";
import {
  parseAppPlatformArtifactDigest,
  type AppPlatformArtifactDigest,
} from "./app-platform-artifact.js";
import {
  verifyAppRelease,
  type AppReleaseEnvelope,
  type AppReleaseFeature,
  type AppReleaseSchemaIdentity,
} from "./app-platform-release.js";

export type LocalAppUpdateContinuityPolicy = "reset" | "eligible";

export interface LocalAppFeatureState {
  readonly featureId: string;
  readonly featureInstallationId: FeatureInstallationId;
  readonly dataNamespaceId: DataNamespaceId;
  readonly featureRevisionDigest: AppPlatformArtifactDigest;
  readonly declarationDigest: Sha256Digest;
  readonly dataSchema: AppReleaseSchemaIdentity | null;
  readonly grants: readonly string[];
  readonly connections: readonly string[];
  readonly enabledJobs: readonly string[];
}

export interface LocalAppInstanceState {
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly projectId: ProjectId;
  /** Exact active bytes; planning never trusts a digest-only current-state claim. */
  readonly activeRelease: unknown;
  readonly features: readonly LocalAppFeatureState[];
}

export interface LocalAppSupportedRuntimeApi {
  readonly name: string;
  readonly majorVersion: number;
}

export interface LocalAppAddedFeatureAllocation {
  readonly featureId: string;
  readonly featureInstallationId: FeatureInstallationId;
  readonly dataNamespaceId: DataNamespaceId;
}

export type LocalAppFeatureUpdateAction = "add" | "keep" | "update" | "remove";
export type LocalAppDataTransition = "create" | "retain" | "migrate" | "retain-disabled";
export type LocalAppFeatureFenceField = Exclude<
  AuthorityStampField,
  "runtimeInstanceGeneration" | "principalGeneration"
>;

export interface LocalAppFeatureUpdateTransition {
  readonly featureId: string;
  readonly action: LocalAppFeatureUpdateAction;
  readonly featureInstallationId: FeatureInstallationId;
  readonly dataNamespaceId: DataNamespaceId;
  readonly fromRevisionDigest: AppPlatformArtifactDigest | null;
  readonly toRevisionDigest: AppPlatformArtifactDigest | null;
  readonly data: LocalAppDataTransition;
  readonly migrationIds: readonly string[];
  readonly migrationDigests: readonly AppPlatformArtifactDigest[];
  readonly continuity: Readonly<{
    grants: readonly string[];
    connections: readonly string[];
    enabledJobs: readonly string[];
  }>;
  readonly resets: readonly ("grants" | "connections" | "jobs")[];
  /** Feature-scoped generations only; runtimeInstanceGeneration is instance-wide. */
  readonly featureFenceFields: readonly LocalAppFeatureFenceField[];
  readonly blockedReason?: string;
}

export interface LocalAppInstanceUpdatePlan {
  readonly planDigest: Sha256Digest;
  readonly operationId: string;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly projectId: ProjectId;
  readonly fromReleaseDigest: Sha256Digest;
  readonly toReleaseDigest: Sha256Digest;
  readonly supportedRuntimeApi: LocalAppSupportedRuntimeApi;
  readonly continuityPolicy: LocalAppUpdateContinuityPolicy;
  readonly transitions: readonly LocalAppFeatureUpdateTransition[];
  readonly instanceFenceFields: readonly ["runtimeInstanceGeneration"];
  readonly canCommit: boolean;
  readonly blockedReasons: readonly string[];
  readonly activation: readonly [
    "verify-target-closure",
    "fence-current-effects",
    "prepare-data-and-features",
    "commit-one-release-pointer",
    "retire-predecessor",
  ];
}

export class LocalAppInstanceUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAppInstanceUpdateError";
  }
}

export interface LocalAppInstanceUpdateInput {
  readonly operationId: string;
  readonly current: LocalAppInstanceState;
  readonly target: unknown;
  readonly supportedRuntimeApi: LocalAppSupportedRuntimeApi;
  readonly continuityPolicy: LocalAppUpdateContinuityPolicy;
  /** Durable caller-owned ids make retries produce byte-for-byte identical plans. */
  readonly addedFeatureAllocations: readonly LocalAppAddedFeatureAllocation[];
}

/**
 * Builds a side-effect-free, all-or-nothing activation plan. The caller must
 * durably reserve operationId and every added Feature allocation before using
 * the plan, then persist the accepted plan before advancing its fences.
 */
export function planLocalAppInstanceUpdate(inputValue: LocalAppInstanceUpdateInput): LocalAppInstanceUpdatePlan {
  const input = expectRecord(inputValue, "Update input");
  expectExactKeys(input, [
    "operationId",
    "current",
    "target",
    "supportedRuntimeApi",
    "continuityPolicy",
    "addedFeatureAllocations",
  ], "Update input");
  const operationId = parseOperationId(input.operationId);
  const supportedRuntimeApi = normalizeSupportedRuntimeApi(input.supportedRuntimeApi);
  const current = normalizeCurrent(input.current);
  const currentRelease = verifyRelease(inputFromCurrentRelease(current));
  const target = verifyRelease(input.target);
  if (input.continuityPolicy !== "reset" && input.continuityPolicy !== "eligible") {
    throw invalid("Update continuityPolicy must be reset or eligible.");
  }
  assertReleaseBinding(current, currentRelease);
  assertRuntimeSupported(currentRelease, supportedRuntimeApi, "Current App Release");
  assertRuntimeSupported(target, supportedRuntimeApi, "Target App Release");
  if (target.manifest.projectId !== current.projectId) {
    throw invalid("Target App Release belongs to a different project lineage.");
  }
  if (currentRelease.releaseDigest === target.releaseDigest) throw invalid("Target release is already active.");

  const currentById = new Map(current.features.map((feature) => [feature.featureId, feature]));
  const targetById = new Map(target.manifest.features.map((feature) => [feature.featureId, feature]));
  const featureIds = [...new Set([...currentById.keys(), ...targetById.keys()])].sort(compareStrings);
  const addedFeatureIds = featureIds.filter((featureId) => !currentById.has(featureId) && targetById.has(featureId));
  const allocations = normalizeAllocations(input.addedFeatureAllocations, addedFeatureIds, current.features);
  const transitions = featureIds.map((featureId) => transitionFor(
    featureId,
    currentById.get(featureId),
    targetById.get(featureId),
    allocations.get(featureId),
    input.continuityPolicy as LocalAppUpdateContinuityPolicy,
  ));
  const blockedReasons = transitions.flatMap((transition) => transition.blockedReason ? [transition.blockedReason] : []);
  const planWithoutDigest = {
    operationId,
    runtimeInstanceId: current.runtimeInstanceId,
    projectId: current.projectId,
    fromReleaseDigest: currentRelease.releaseDigest,
    toReleaseDigest: target.releaseDigest,
    supportedRuntimeApi,
    continuityPolicy: input.continuityPolicy as LocalAppUpdateContinuityPolicy,
    transitions,
    instanceFenceFields: ["runtimeInstanceGeneration"] as const,
    canCommit: blockedReasons.length === 0,
    blockedReasons,
    activation: [
      "verify-target-closure",
      "fence-current-effects",
      "prepare-data-and-features",
      "commit-one-release-pointer",
      "retire-predecessor",
    ] as const,
  };
  const planDigest = parseSha256Digest(computeDeclarationDigest({
    domain: "work-fold.local-app-instance-update-plan",
    version: 2,
    ...planWithoutDigest,
  }), "App Instance update plan digest");
  return deepFreeze({ planDigest, ...planWithoutDigest });
}

function transitionFor(
  featureId: string,
  current: LocalAppFeatureState | undefined,
  target: AppReleaseFeature | undefined,
  allocation: LocalAppAddedFeatureAllocation | undefined,
  policy: LocalAppUpdateContinuityPolicy,
): LocalAppFeatureUpdateTransition {
  if (!current && target) {
    if (!allocation) throw invalid(`Added Feature ${featureId} is missing its durable allocation.`);
    return {
      featureId,
      action: "add",
      featureInstallationId: allocation.featureInstallationId,
      dataNamespaceId: allocation.dataNamespaceId,
      fromRevisionDigest: null,
      toRevisionDigest: target.featureRevision.digest,
      data: "create",
      migrationIds: [],
      migrationDigests: [],
      continuity: emptyContinuity(),
      resets: [],
      featureFenceFields: [],
    };
  }
  if (current && !target) {
    const resets = liveAuthorityResets(current);
    const transition = {
      featureId,
      action: "remove" as const,
      featureInstallationId: current.featureInstallationId,
      dataNamespaceId: current.dataNamespaceId,
      fromRevisionDigest: current.featureRevisionDigest,
      toRevisionDigest: null,
      data: "retain-disabled" as const,
      migrationIds: [],
      migrationDigests: [],
      continuity: emptyContinuity(),
      resets,
    };
    return { ...transition, featureFenceFields: featureFenceFieldsFor(transition, true) };
  }
  if (!current || !target) throw invalid("Feature transition is incomplete.");

  const exactRevision = current.featureRevisionDigest === target.featureRevision.digest;
  const exactDeclaration = current.declarationDigest === target.declaration.digest;
  const exactFeature = exactRevision && exactDeclaration;
  const dataDecision = dataTransition(current, target);
  const action: LocalAppFeatureUpdateAction = exactFeature && dataDecision.data === "retain" ? "keep" : "update";
  const continuity = policy === "eligible" && exactFeature
    ? {
        grants: [...current.grants],
        connections: [...current.connections],
        enabledJobs: [...current.enabledJobs],
      }
    : emptyContinuity();
  const resets = policy === "eligible" && exactFeature ? [] : liveAuthorityResets(current);
  const transition = {
    featureId,
    action,
    featureInstallationId: current.featureInstallationId,
    dataNamespaceId: current.dataNamespaceId,
    fromRevisionDigest: current.featureRevisionDigest,
    toRevisionDigest: target.featureRevision.digest,
    data: dataDecision.data,
    migrationIds: dataDecision.migrationIds,
    migrationDigests: dataDecision.migrationDigests,
    continuity,
    resets,
    ...(dataDecision.blockedReason ? { blockedReason: dataDecision.blockedReason } : {}),
  };
  return { ...transition, featureFenceFields: featureFenceFieldsFor(transition, true) };
}

function dataTransition(
  current: LocalAppFeatureState,
  target: AppReleaseFeature,
): Pick<LocalAppFeatureUpdateTransition, "data" | "migrationIds" | "migrationDigests" | "blockedReason"> {
  if (current.dataSchema === null && target.dataSchema === null) {
    return { data: "retain", migrationIds: [], migrationDigests: [] };
  }
  if (current.dataSchema && target.dataSchema
    && schemaIdentitiesEqual(current.dataSchema, schemaIdentityFromRelease(target))) {
    return { data: "retain", migrationIds: [], migrationDigests: [] };
  }
  if (!current.dataSchema || !target.dataSchema) {
    return blockedMigration(
      `Feature ${current.featureId} changes between unversioned and versioned data without an exact migration endpoint.`,
    );
  }
  const resolution = resolveMigrationPath(current.dataSchema, schemaIdentityFromRelease(target), target);
  if ("blockedReason" in resolution) return blockedMigration(resolution.blockedReason);
  return {
    data: "migrate",
    migrationIds: resolution.path.map((migration) => migration.migrationId),
    migrationDigests: resolution.path.map((migration) => migration.artifact.digest),
  };
}

function resolveMigrationPath(
  source: AppReleaseSchemaIdentity,
  target: AppReleaseSchemaIdentity,
  feature: AppReleaseFeature,
): Readonly<{ path: AppReleaseFeature["migrations"] }> | Readonly<{ blockedReason: string }> {
  const migrations = feature.migrations;
  if (migrationGraphHasCycle(migrations)) {
    return { blockedReason: `Feature ${feature.featureId} migration graph is cyclic.` };
  }
  const bySource = new Map<string, AppReleaseFeature["migrations"][number][]>();
  for (const migration of migrations) {
    const key = schemaKey(migration.sourceSchema);
    const edges = bySource.get(key) ?? [];
    edges.push(migration);
    bySource.set(key, edges);
  }
  for (const edges of bySource.values()) edges.sort((left, right) => compareStrings(left.migrationId, right.migrationId));

  const paths: AppReleaseFeature["migrations"][number][][] = [];
  const walk = (schema: AppReleaseSchemaIdentity, path: AppReleaseFeature["migrations"][number][]): void => {
    if (paths.length > 1) return;
    if (schemaIdentitiesEqual(schema, target)) {
      paths.push(path);
      return;
    }
    for (const migration of bySource.get(schemaKey(schema)) ?? []) {
      walk(migration.targetSchema, [...path, migration]);
    }
  };
  walk(source, []);
  if (paths.length === 0) {
    return {
      blockedReason: `Feature ${feature.featureId} has no complete migration path from ${printSchema(source)} to ${printSchema(target)}.`,
    };
  }
  if (paths.length > 1) {
    return {
      blockedReason: `Feature ${feature.featureId} has more than one migration path from ${printSchema(source)} to ${printSchema(target)}.`,
    };
  }
  return { path: paths[0]! };
}

function migrationGraphHasCycle(migrations: AppReleaseFeature["migrations"]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const migration of migrations) {
    const source = schemaKey(migration.sourceSchema);
    const targets = adjacency.get(source) ?? [];
    targets.push(schemaKey(migration.targetSchema));
    adjacency.set(source, targets);
  }
  const state = new Map<string, "visiting" | "visited">();
  const visit = (node: string): boolean => {
    const current = state.get(node);
    if (current === "visiting") return true;
    if (current === "visited") return false;
    state.set(node, "visiting");
    for (const target of adjacency.get(node) ?? []) if (visit(target)) return true;
    state.set(node, "visited");
    return false;
  };
  for (const node of adjacency.keys()) if (visit(node)) return true;
  return false;
}

function blockedMigration(blockedReason: string): Pick<
  LocalAppFeatureUpdateTransition,
  "data" | "migrationIds" | "migrationDigests" | "blockedReason"
> {
  return { data: "retain-disabled", migrationIds: [], migrationDigests: [], blockedReason };
}

function normalizeCurrent(value: unknown): LocalAppInstanceState {
  const record = expectRecord(value, "Current App Instance");
  expectExactKeys(record, ["runtimeInstanceId", "projectId", "activeRelease", "features"], "Current App Instance");
  const runtimeInstanceId = parseId(() => parseRuntimeInstanceId(record.runtimeInstanceId));
  const projectId = parseId(() => parseProjectId(record.projectId));
  const featureValues = expectArray(record.features, "Current Feature state", 64);
  const features = featureValues.map((feature) => normalizeFeature(feature));
  if (new Set(features.map((feature) => feature.featureId)).size !== features.length) {
    throw invalid("Current Feature ids must be unique.");
  }
  if (new Set(features.map((feature) => feature.featureInstallationId)).size !== features.length) {
    throw invalid("Current Feature Installation ids must be unique.");
  }
  if (new Set(features.map((feature) => feature.dataNamespaceId)).size !== features.length) {
    throw invalid("Current Data Namespace ids must be unique.");
  }
  features.sort((left, right) => compareStrings(left.featureId, right.featureId));
  return { runtimeInstanceId, projectId, activeRelease: record.activeRelease, features };
}

function normalizeFeature(value: unknown): LocalAppFeatureState {
  const record = expectRecord(value, "Current Feature state");
  expectExactKeys(record, [
    "featureId",
    "featureInstallationId",
    "dataNamespaceId",
    "featureRevisionDigest",
    "declarationDigest",
    "dataSchema",
    "grants",
    "connections",
    "enabledJobs",
  ], "Current Feature state");
  const featureId = stableId(record.featureId, "Feature id");
  const dataSchema = record.dataSchema === null ? null : normalizeSchemaIdentity(record.dataSchema, "Current data schema");
  return {
    featureId,
    featureInstallationId: parseId(() => parseFeatureInstallationId(record.featureInstallationId)),
    dataNamespaceId: parseId(() => parseDataNamespaceId(record.dataNamespaceId)),
    featureRevisionDigest: parseId(() => parseAppPlatformArtifactDigest(record.featureRevisionDigest)),
    declarationDigest: parseId(() => parseSha256Digest(record.declarationDigest, "Feature declaration digest")),
    dataSchema,
    grants: stringSet(record.grants, "grants"),
    connections: stringSet(record.connections, "connections"),
    enabledJobs: stringSet(record.enabledJobs, "enabled jobs"),
  };
}

function assertReleaseBinding(current: LocalAppInstanceState, release: AppReleaseEnvelope): void {
  if (current.projectId !== release.manifest.projectId) {
    throw invalid("Current App Instance projectId does not match its verified active Release.");
  }
  if (current.features.length !== release.manifest.features.length) {
    throw invalid("Current Feature state does not exactly project the verified active Release.");
  }
  const releaseById = new Map(release.manifest.features.map((feature) => [feature.featureId, feature]));
  for (const feature of current.features) {
    const released = releaseById.get(feature.featureId);
    if (!released
      || released.featureRevision.digest !== feature.featureRevisionDigest
      || released.declaration.digest !== feature.declarationDigest
      || !optionalSchemasEqual(feature.dataSchema, released)) {
      throw invalid(`Current Feature ${feature.featureId} does not match its verified active Release.`);
    }
  }
}

function optionalSchemasEqual(current: AppReleaseSchemaIdentity | null, released: AppReleaseFeature): boolean {
  if (!current || !released.dataSchema) return current === null && released.dataSchema === null;
  return schemaIdentitiesEqual(current, schemaIdentityFromRelease(released));
}

function normalizeAllocations(
  value: unknown,
  addedFeatureIds: readonly string[],
  currentFeatures: readonly LocalAppFeatureState[],
): Map<string, LocalAppAddedFeatureAllocation> {
  const values = expectArray(value, "Added Feature allocations", 64);
  const allocations = values.map((item, index) => {
    const label = `Added Feature allocation ${index + 1}`;
    const record = expectRecord(item, label);
    expectExactKeys(record, ["featureId", "featureInstallationId", "dataNamespaceId"], label);
    return {
      featureId: stableId(record.featureId, `${label} featureId`),
      featureInstallationId: parseId(() => parseFeatureInstallationId(record.featureInstallationId)),
      dataNamespaceId: parseId(() => parseDataNamespaceId(record.dataNamespaceId)),
    };
  });
  const byFeature = new Map(allocations.map((allocation) => [allocation.featureId, allocation]));
  if (byFeature.size !== allocations.length) throw invalid("Added Feature allocation featureIds must be unique.");
  const expected = [...addedFeatureIds].sort(compareStrings);
  const actual = [...byFeature.keys()].sort(compareStrings);
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    throw invalid("Added Feature allocations must exactly match the Features added by this update.");
  }
  const installationIds = [
    ...currentFeatures.map((feature) => feature.featureInstallationId),
    ...allocations.map((allocation) => allocation.featureInstallationId),
  ];
  const namespaceIds = [
    ...currentFeatures.map((feature) => feature.dataNamespaceId),
    ...allocations.map((allocation) => allocation.dataNamespaceId),
  ];
  if (new Set(installationIds).size !== installationIds.length) {
    throw invalid("Feature Installation allocations must not reuse an existing or added id.");
  }
  if (new Set(namespaceIds).size !== namespaceIds.length) {
    throw invalid("Data Namespace allocations must not reuse an existing or added id.");
  }
  return byFeature;
}

function normalizeSupportedRuntimeApi(value: unknown): LocalAppSupportedRuntimeApi {
  const record = expectRecord(value, "Supported runtimeApi");
  expectExactKeys(record, ["name", "majorVersion"], "Supported runtimeApi");
  if (typeof record.name !== "string" || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(record.name)) {
    throw invalid("Supported runtimeApi name is invalid.");
  }
  return { name: record.name, majorVersion: positiveInteger(record.majorVersion, "runtimeApi majorVersion") };
}

function assertRuntimeSupported(
  release: AppReleaseEnvelope,
  supported: LocalAppSupportedRuntimeApi,
  label: string,
): void {
  const expectedRange = `${supported.majorVersion}.x`;
  if (release.manifest.runtimeApi.name !== supported.name
    || release.manifest.runtimeApi.compatibleRange !== expectedRange) {
    throw invalid(`${label} requires unsupported runtimeApi ${release.manifest.runtimeApi.name} ${release.manifest.runtimeApi.compatibleRange}.`);
  }
}

function schemaIdentityFromRelease(feature: AppReleaseFeature): AppReleaseSchemaIdentity {
  if (!feature.dataSchema) throw invalid(`Feature ${feature.featureId} has no data schema.`);
  return {
    schemaId: feature.dataSchema.schemaId,
    version: feature.dataSchema.version,
    digest: feature.dataSchema.definition.digest,
  };
}

function normalizeSchemaIdentity(value: unknown, label: string): AppReleaseSchemaIdentity {
  const record = expectRecord(value, label);
  expectExactKeys(record, ["schemaId", "version", "digest"], label);
  return {
    schemaId: stableId(record.schemaId, `${label} schemaId`),
    version: positiveInteger(record.version, `${label} version`),
    digest: parseId(() => parseSha256Digest(record.digest, `${label} digest`)),
  };
}

function schemaIdentitiesEqual(left: AppReleaseSchemaIdentity, right: AppReleaseSchemaIdentity): boolean {
  return left.schemaId === right.schemaId && left.version === right.version && left.digest === right.digest;
}

function schemaKey(schema: AppReleaseSchemaIdentity): string {
  return `${schema.schemaId}\u0000${schema.version}\u0000${schema.digest}`;
}

function printSchema(schema: AppReleaseSchemaIdentity): string {
  return `${schema.schemaId}@${schema.version} (${schema.digest})`;
}

function featureFenceFieldsFor(
  transition: Pick<LocalAppFeatureUpdateTransition, "action" | "resets" | "data">,
  existingInstallation: boolean,
): LocalAppFeatureFenceField[] {
  if (!existingInstallation) return [];
  const fields = new Set<LocalAppFeatureFenceField>();
  if (transition.action === "update" || transition.action === "remove") fields.add("featureInstallationGeneration");
  if (transition.resets.includes("grants")) fields.add("grantGeneration");
  if (transition.resets.includes("connections")) fields.add("connectionGeneration");
  if (transition.resets.includes("jobs")) fields.add("jobGeneration");
  if (transition.data === "migrate" || transition.data === "retain-disabled") fields.add("dataGeneration");
  const order: LocalAppFeatureFenceField[] = [
    "featureInstallationGeneration",
    "grantGeneration",
    "connectionGeneration",
    "jobGeneration",
    "dataGeneration",
  ];
  return order.filter((field) => fields.has(field));
}

function liveAuthorityResets(feature: LocalAppFeatureState): ("grants" | "connections" | "jobs")[] {
  return [
    ...(feature.grants.length ? ["grants" as const] : []),
    ...(feature.connections.length ? ["connections" as const] : []),
    ...(feature.enabledJobs.length ? ["jobs" as const] : []),
  ];
}

function emptyContinuity(): LocalAppFeatureUpdateTransition["continuity"] {
  return { grants: [], connections: [], enabledJobs: [] };
}

function stringSet(value: unknown, label: string): string[] {
  const values = expectArray(value, `Current Feature ${label}`, 256);
  if (values.some((item) => typeof item !== "string" || item.length === 0 || item.length > 256 || hasLoneSurrogate(item))) {
    throw invalid(`Current Feature ${label} are invalid.`);
  }
  const result = [...values] as string[];
  result.sort(compareStrings);
  if (new Set(result).size !== result.length) throw invalid(`Current Feature ${label} must be unique.`);
  return result;
}

function inputFromCurrentRelease(current: LocalAppInstanceState): unknown {
  return current.activeRelease;
}

function verifyRelease(value: unknown): AppReleaseEnvelope {
  try {
    return verifyAppRelease(value);
  } catch (error) {
    throw invalid(`App Release verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseOperationId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw invalid("Update operationId must be a bounded opaque token.");
  }
  return value;
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw invalid(`${label} is invalid.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw invalid(`${label} is invalid.`);
  return value as number;
}

function parseId<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : "App Instance identity is invalid.");
  }
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

function expectArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid(`${label} must be a bounded array.`);
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
  return value;
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

function expectExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const accepted = new Set(keys);
  const unsupported = Object.keys(record).find((key) => !accepted.has(key));
  if (unsupported) throw invalid(`${label} contains unsupported field ${unsupported}.`);
  const missing = keys.find((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (missing) throw invalid(`${label} is missing required field ${missing}.`);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  canonicalizeJson(value);
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function invalid(message: string): LocalAppInstanceUpdateError {
  return new LocalAppInstanceUpdateError(message);
}
