import { createHash, randomUUID } from "node:crypto";

import type { AppPlatformArtifactDigest } from "./app-platform-artifact.js";

declare const appPlatformBrand: unique symbol;

type BrandedString<Name extends string> = string & {
  readonly [appPlatformBrand]: Name;
};

export type ProjectId = BrandedString<"ProjectId">;
export type CloudProjectId = BrandedString<"CloudProjectId">;
export type RuntimeInstanceId = BrandedString<"RuntimeInstanceId">;
export type FeatureInstallationId = BrandedString<"FeatureInstallationId">;
export type DataNamespaceId = BrandedString<"DataNamespaceId">;
export type TenantId = BrandedString<"TenantId">;
export type PrincipalId = BrandedString<"PrincipalId">;
export type AuthorityGeneration = BrandedString<"AuthorityGeneration">;
export type Sha256Digest = BrandedString<"Sha256Digest">;
export type DeclarationDigest = BrandedString<"DeclarationDigest">;

export const appPlatformIdPrefixes = Object.freeze({
  projectId: "project_",
  cloudProjectId: "cloud-project_",
  runtimeInstanceId: "runtime-instance_",
  featureInstallationId: "feature-installation_",
  dataNamespaceId: "data-namespace_",
  tenantId: "tenant_",
  principalId: "principal_",
} as const);

const opaqueIdSuffixPattern = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const authorityGenerationPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/;

export function parseProjectId(value: unknown): ProjectId {
  return parseOpaqueId(value, appPlatformIdPrefixes.projectId, "projectId") as ProjectId;
}

export function createProjectId(): ProjectId {
  return createOpaqueId(appPlatformIdPrefixes.projectId) as ProjectId;
}

export function parseCloudProjectId(value: unknown): CloudProjectId {
  return parseOpaqueId(value, appPlatformIdPrefixes.cloudProjectId, "cloudProjectId") as CloudProjectId;
}

export function createCloudProjectId(): CloudProjectId {
  return createOpaqueId(appPlatformIdPrefixes.cloudProjectId) as CloudProjectId;
}

export function parseRuntimeInstanceId(value: unknown): RuntimeInstanceId {
  return parseOpaqueId(value, appPlatformIdPrefixes.runtimeInstanceId, "runtimeInstanceId") as RuntimeInstanceId;
}

export function createRuntimeInstanceId(): RuntimeInstanceId {
  return createOpaqueId(appPlatformIdPrefixes.runtimeInstanceId) as RuntimeInstanceId;
}

export function parseFeatureInstallationId(value: unknown): FeatureInstallationId {
  return parseOpaqueId(value, appPlatformIdPrefixes.featureInstallationId, "featureInstallationId") as FeatureInstallationId;
}

export function createFeatureInstallationId(): FeatureInstallationId {
  return createOpaqueId(appPlatformIdPrefixes.featureInstallationId) as FeatureInstallationId;
}

export function parseDataNamespaceId(value: unknown): DataNamespaceId {
  return parseOpaqueId(value, appPlatformIdPrefixes.dataNamespaceId, "dataNamespaceId") as DataNamespaceId;
}

export function createDataNamespaceId(): DataNamespaceId {
  return createOpaqueId(appPlatformIdPrefixes.dataNamespaceId) as DataNamespaceId;
}

export function parseTenantId(value: unknown): TenantId {
  return parseOpaqueId(value, appPlatformIdPrefixes.tenantId, "tenantId") as TenantId;
}

export function createTenantId(): TenantId {
  return createOpaqueId(appPlatformIdPrefixes.tenantId) as TenantId;
}

export function parsePrincipalId(value: unknown): PrincipalId {
  return parseOpaqueId(value, appPlatformIdPrefixes.principalId, "principalId") as PrincipalId;
}

export function createPrincipalId(): PrincipalId {
  return createOpaqueId(appPlatformIdPrefixes.principalId) as PrincipalId;
}

function parseOpaqueId(value: unknown, prefix: string, label: string): string {
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error(`${label} must be a string beginning with ${prefix}.`);
  }
  const suffix = value.slice(prefix.length);
  if (!opaqueIdSuffixPattern.test(suffix)) {
    throw new Error(`${label} must contain a 1-128 character lowercase opaque suffix.`);
  }
  return value;
}

function createOpaqueId(prefix: string): string {
  return `${prefix}${randomUUID()}`;
}

export const authorityStampFields = Object.freeze([
  "runtimeInstanceGeneration",
  "featureInstallationGeneration",
  "grantGeneration",
  "connectionGeneration",
  "jobGeneration",
  "principalGeneration",
  "dataGeneration",
] as const);

export type AuthorityStampField = (typeof authorityStampFields)[number];

export interface AuthorityStamp {
  readonly runtimeInstanceGeneration: AuthorityGeneration;
  readonly featureInstallationGeneration: AuthorityGeneration;
  readonly grantGeneration: AuthorityGeneration;
  readonly connectionGeneration: AuthorityGeneration;
  readonly jobGeneration: AuthorityGeneration;
  readonly principalGeneration: AuthorityGeneration;
  readonly dataGeneration: AuthorityGeneration;
}

export type AuthorityStampProjection = Readonly<Partial<AuthorityStamp>>;

const authorityStampFieldSet = new Set<string>(authorityStampFields);

export function createAuthorityGeneration(): AuthorityGeneration {
  return randomUUID() as AuthorityGeneration;
}

export function createAuthorityStamp(): Readonly<AuthorityStamp> {
  return Object.freeze({
    runtimeInstanceGeneration: createAuthorityGeneration(),
    featureInstallationGeneration: createAuthorityGeneration(),
    grantGeneration: createAuthorityGeneration(),
    connectionGeneration: createAuthorityGeneration(),
    jobGeneration: createAuthorityGeneration(),
    principalGeneration: createAuthorityGeneration(),
    dataGeneration: createAuthorityGeneration(),
  });
}

export function advanceAuthorityStamp(
  value: AuthorityStamp,
  fields: readonly AuthorityStampField[],
): Readonly<AuthorityStamp> {
  const current = parseAuthorityStamp(value);
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("AuthorityStamp advance must name at least one field.");
  }
  const next: Record<AuthorityStampField, AuthorityGeneration> = { ...current };
  const seen = new Set<string>();
  for (const field of fields as readonly string[]) {
    if (!authorityStampFieldSet.has(field)) throw new Error(`Unknown AuthorityStamp field: ${field}.`);
    if (seen.has(field)) throw new Error(`AuthorityStamp advance field is duplicated: ${field}.`);
    seen.add(field);
    next[field as AuthorityStampField] = createAuthorityGeneration();
  }
  return parseAuthorityStamp(next);
}

export function parseAuthorityStamp(value: unknown): Readonly<AuthorityStamp> {
  const record = expectPlainRecord(value, "AuthorityStamp");
  expectExactKeys(record, authorityStampFields, "AuthorityStamp");
  return Object.freeze({
    runtimeInstanceGeneration: parseAuthorityGeneration(record.runtimeInstanceGeneration, "runtimeInstanceGeneration"),
    featureInstallationGeneration: parseAuthorityGeneration(record.featureInstallationGeneration, "featureInstallationGeneration"),
    grantGeneration: parseAuthorityGeneration(record.grantGeneration, "grantGeneration"),
    connectionGeneration: parseAuthorityGeneration(record.connectionGeneration, "connectionGeneration"),
    jobGeneration: parseAuthorityGeneration(record.jobGeneration, "jobGeneration"),
    principalGeneration: parseAuthorityGeneration(record.principalGeneration, "principalGeneration"),
    dataGeneration: parseAuthorityGeneration(record.dataGeneration, "dataGeneration"),
  });
}

export function copyAuthorityStamp(value: AuthorityStamp): Readonly<AuthorityStamp> {
  return parseAuthorityStamp(value);
}

export function authorityStampsEqual(left: AuthorityStamp, right: AuthorityStamp): boolean {
  const parsedLeft = parseAuthorityStamp(left);
  const parsedRight = parseAuthorityStamp(right);
  return authorityStampFields.every((field) => parsedLeft[field] === parsedRight[field]);
}

export function projectAuthorityStamp<const Fields extends readonly AuthorityStampField[]>(
  value: AuthorityStamp,
  fields: Fields,
): Readonly<Pick<AuthorityStamp, Fields[number]>> {
  const stamp = parseAuthorityStamp(value);
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("AuthorityStamp projection must name at least one field.");
  }
  const projected: Partial<Record<AuthorityStampField, AuthorityGeneration>> = {};
  const seen = new Set<string>();
  for (const field of fields as readonly string[]) {
    if (!authorityStampFieldSet.has(field)) throw new Error(`Unknown AuthorityStamp field: ${field}.`);
    if (seen.has(field)) throw new Error(`AuthorityStamp projection field is duplicated: ${field}.`);
    seen.add(field);
    const typedField = field as AuthorityStampField;
    projected[typedField] = stamp[typedField];
  }
  return Object.freeze(projected) as Readonly<Pick<AuthorityStamp, Fields[number]>>;
}

export function parseAuthorityStampProjection(value: unknown): AuthorityStampProjection {
  const record = expectPlainRecord(value, "AuthorityStamp projection");
  const keys = Object.keys(record);
  if (keys.length === 0) throw new Error("AuthorityStamp projection must name at least one field.");
  const parsed: Partial<Record<AuthorityStampField, AuthorityGeneration>> = {};
  for (const key of keys) {
    if (!authorityStampFieldSet.has(key)) throw new Error(`Unknown AuthorityStamp field: ${key}.`);
    const field = key as AuthorityStampField;
    parsed[field] = parseAuthorityGeneration(record[field], field);
  }
  return Object.freeze(parsed);
}

export function authorityStampMatchesProjection(
  value: AuthorityStamp,
  projection: AuthorityStampProjection,
): boolean {
  const stamp = parseAuthorityStamp(value);
  const parsedProjection = parseAuthorityStampProjection(projection);
  return (Object.keys(parsedProjection) as AuthorityStampField[])
    .every((field) => stamp[field] === parsedProjection[field]);
}

export function parseAuthorityGeneration(value: unknown, label = "authority generation"): AuthorityGeneration {
  if (typeof value !== "string" || !authorityGenerationPattern.test(value)) {
    throw new Error(`${label} must be a 1-128 character opaque generation token.`);
  }
  return value as AuthorityGeneration;
}

export type RuntimeInstanceContext =
  | Readonly<{
      kind: "development";
      runtimeInstanceId: RuntimeInstanceId;
      workFolderId: string;
      projectId: ProjectId;
    }>
  | Readonly<{
      kind: "app";
      runtimeInstanceId: RuntimeInstanceId;
      host: "local" | "hosted";
      releaseDigest: Sha256Digest;
    }>;

export function parseRuntimeInstanceContext(value: unknown): RuntimeInstanceContext {
  const record = expectPlainRecord(value, "RuntimeInstanceContext");
  if (record.kind === "development") {
    expectExactKeys(record, ["kind", "runtimeInstanceId", "workFolderId", "projectId"], "Development RuntimeInstanceContext");
    return Object.freeze({
      kind: "development",
      runtimeInstanceId: parseRuntimeInstanceId(record.runtimeInstanceId),
      workFolderId: parseContextId(record.workFolderId, "workFolderId"),
      projectId: parseProjectId(record.projectId),
    });
  }
  if (record.kind === "app") {
    expectExactKeys(record, ["kind", "runtimeInstanceId", "host", "releaseDigest"], "App RuntimeInstanceContext");
    if (record.host !== "local" && record.host !== "hosted") {
      throw new Error("App RuntimeInstanceContext host must be local or hosted.");
    }
    return Object.freeze({
      kind: "app",
      runtimeInstanceId: parseRuntimeInstanceId(record.runtimeInstanceId),
      host: record.host,
      releaseDigest: parseSha256Digest(record.releaseDigest, "releaseDigest"),
    });
  }
  throw new Error("RuntimeInstanceContext kind must be development or app.");
}

function parseContextId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || hasLoneSurrogate(value)) {
    throw new Error(`${label} must be a non-empty bounded Unicode string.`);
  }
  return value;
}

export const principalKinds = Object.freeze(["human", "agent", "service", "system"] as const);
export type PrincipalKind = (typeof principalKinds)[number];
export type PrincipalRealm = "local" | "cloud";

export interface EffectivePrincipal {
  readonly principalId: PrincipalId;
  readonly kind: PrincipalKind;
  readonly realm: PrincipalRealm;
}

export const runtimeErrorCategories = Object.freeze([
  "invalid-input",
  "denied",
  "authentication",
  "not-found",
  "conflict",
  "quota",
  "rate-limit",
  "timeout",
  "cancelled",
  "stale-authority",
  "unavailable",
  "host-failure",
] as const);

export type RuntimeErrorCategory = (typeof runtimeErrorCategories)[number];

export const runtimeErrorCodes = Object.freeze([
  "INVALID_INPUT",
  "INVALID_OUTPUT",
  "ACTION_UNDECLARED",
  "NETWORK_DENIED",
  "RESOURCE_DENIED",
  "NOTIFICATION_DENIED",
  "AUTHENTICATION_REQUIRED",
  "NOT_FOUND",
  "CONFLICT",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "TIMEOUT",
  "CANCELLED",
  "AUTHORITY_STALE",
  "AUTHORITY_EXPIRED",
  "CAPABILITY_UNSUPPORTED",
  "REVISION_CHANGED",
  "HOST_UNAVAILABLE",
  "WORKER_CRASHED",
] as const);

export type RuntimeErrorCode = (typeof runtimeErrorCodes)[number];

const runtimeErrorCategoryByCode: Readonly<Record<RuntimeErrorCode, RuntimeErrorCategory>> = Object.freeze({
  INVALID_INPUT: "invalid-input",
  INVALID_OUTPUT: "invalid-input",
  ACTION_UNDECLARED: "not-found",
  NETWORK_DENIED: "denied",
  RESOURCE_DENIED: "denied",
  NOTIFICATION_DENIED: "denied",
  AUTHENTICATION_REQUIRED: "authentication",
  NOT_FOUND: "not-found",
  CONFLICT: "conflict",
  QUOTA_EXCEEDED: "quota",
  RATE_LIMITED: "rate-limit",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
  AUTHORITY_STALE: "stale-authority",
  AUTHORITY_EXPIRED: "stale-authority",
  CAPABILITY_UNSUPPORTED: "unavailable",
  REVISION_CHANGED: "stale-authority",
  HOST_UNAVAILABLE: "unavailable",
  WORKER_CRASHED: "host-failure",
});

export interface RuntimeError {
  readonly code: RuntimeErrorCode;
  readonly category: RuntimeErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly receiptId?: string;
}

export function createRuntimeError(
  code: RuntimeErrorCode,
  message: string,
  options: Readonly<{ retryable: boolean; retryAfterMs?: number; receiptId?: string }>,
): Readonly<RuntimeError> {
  if (!runtimeErrorCodes.includes(code)) throw new Error(`Unknown runtime error code: ${code}.`);
  if (typeof message !== "string" || message.length === 0 || message.length > 1_024 || hasLoneSurrogate(message)) {
    throw new Error("Runtime error message must be a non-empty bounded Unicode string.");
  }
  if (typeof options?.retryable !== "boolean") throw new Error("Runtime error retryable must be boolean.");
  if (options.retryAfterMs !== undefined && (!Number.isSafeInteger(options.retryAfterMs) || options.retryAfterMs < 0)) {
    throw new Error("Runtime error retryAfterMs must be a non-negative safe integer.");
  }
  if (options.receiptId !== undefined) parseContextId(options.receiptId, "receiptId");
  return Object.freeze({
    code,
    category: runtimeErrorCategoryByCode[code],
    message,
    retryable: options.retryable,
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.receiptId === undefined ? {} : { receiptId: options.receiptId }),
  });
}

export type RuntimeReceiptKind =
  | "action"
  | "job"
  | "migration"
  | "resource-mutation"
  | "notification"
  | "admin-transition";

export type RuntimeReceiptState =
  | "accepted"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"
  | "expired";

export interface RuntimeReceipt {
  readonly receiptId: string;
  readonly kind: RuntimeReceiptKind;
  readonly tenantId: TenantId;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly featureInstallationId?: FeatureInstallationId;
  readonly featureRevisionDigest?: AppPlatformArtifactDigest;
  readonly dataNamespaceId?: DataNamespaceId;
  readonly effectivePrincipal: EffectivePrincipal;
  readonly authority: AuthorityStamp;
  readonly acceptedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly state: RuntimeReceiptState;
  readonly error?: RuntimeError;
  readonly parentReceiptId?: string;
  readonly occurrenceId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
}

/**
 * Canonicalizes an already materialized I-JSON-compatible value using the JSON
 * Canonicalization Scheme (RFC 8785): ECMAScript number/string serialization,
 * recursive UTF-16 property ordering, and no Unicode normalization.
 *
 * Duplicate property names cannot exist in a JavaScript object after parsing,
 * so this function cannot detect duplicate names that a permissive raw JSON
 * parser has already collapsed. Raw untrusted JSON needs duplicate detection at
 * its parser boundary before this function receives the materialized value.
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalizeJsonValue(value, "$", new Set<object>());
}

export function computeDeclarationDigest(value: unknown): DeclarationDigest {
  const canonical = canonicalizeJson(value);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}` as DeclarationDigest;
}

export function parseSha256Digest(value: unknown, label = "digest"): Sha256Digest {
  if (typeof value !== "string" || !sha256DigestPattern.test(value)) {
    throw new Error(`${label} must be a lowercase sha256 digest.`);
  }
  return value as Sha256Digest;
}

function canonicalizeJsonValue(value: unknown, path: string, stack: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number.`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error(`${path} contains unsupported JSON type ${typeof value}.`);
  }
  if (stack.has(value)) throw new Error(`${path} contains a cyclic reference.`);
  stack.add(value);
  try {
    if (Array.isArray(value)) return canonicalizeJsonArray(value, path, stack);
    const record = expectCanonicalPlainObject(value, path);
    const keys = Object.keys(record).sort(compareUtf16);
    const entries = keys.map((key) => {
      assertUnicodeScalarString(key, `${path} property name`);
      return `${JSON.stringify(key)}:${canonicalizeJsonValue(record[key], `${path}[${JSON.stringify(key)}]`, stack)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function canonicalizeJsonArray(value: unknown[], path: string, stack: Set<object>): string {
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key === "symbol") throw new Error(`${path} contains an unsupported symbol property.`);
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      throw new Error(`${path} contains an unsupported array property.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${path} contains an unsupported array property descriptor.`);
    }
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error(`${path}[${index}] is an array hole.`);
    }
    items.push(canonicalizeJsonValue(value[index], `${path}[${index}]`, stack));
  }
  return `[${items.join(",")}]`;
}

function expectCanonicalPlainObject(value: object, path: string): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} contains an unsupported object type.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw new Error(`${path} contains an unsupported symbol property.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${path} contains an unsupported property descriptor.`);
    }
  }
  return value as Record<string, unknown>;
}

function compareUtf16(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function assertUnicodeScalarString(value: string, path: string): void {
  if (hasLoneSurrogate(value)) throw new Error(`${path} contains a lone Unicode surrogate.`);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function expectPlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw new Error(`${label} contains an unsupported symbol field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} contains an unsupported field descriptor.`);
    }
  }
  return value as Record<string, unknown>;
}

function expectExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected);
  const keys = Object.keys(record);
  const unsupported = keys.find((key) => !expectedSet.has(key));
  if (unsupported) throw new Error(`${label} contains unsupported field: ${unsupported}.`);
  const missing = expected.find((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (missing) throw new Error(`${label} is missing required field: ${missing}.`);
  if (keys.length !== expected.length) throw new Error(`${label} must contain exactly ${expected.length} fields.`);
}
