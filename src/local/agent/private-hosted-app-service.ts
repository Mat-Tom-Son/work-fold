import { createHash, randomUUID } from "node:crypto";

import {
  authorityStampsEqual,
  canonicalizeJson,
  createAuthorityGeneration,
  createAuthorityStamp,
  createDataNamespaceId,
  createFeatureInstallationId,
  createRuntimeError,
  createRuntimeInstanceId,
  parseAuthorityStamp,
  parseCloudProjectId,
  parseDataNamespaceId,
  parseFeatureInstallationId,
  parsePrincipalId,
  parseProjectId,
  parseRuntimeInstanceId,
  parseSha256Digest,
  parseTenantId,
  type AuthorityStamp,
  type CloudProjectId,
  type EffectivePrincipal,
  type FeatureInstallationId,
  type PrincipalId,
  type ProjectId,
  type RuntimeError,
  type RuntimeErrorCode,
  type RuntimeInstanceId,
  type RuntimeReceipt,
  type Sha256Digest,
  type TenantId,
  type DataNamespaceId,
} from "./app-platform-contract.js";
import {
  verifyAppRelease,
  type AppReleaseEnvelope,
  type AppReleaseFeature,
} from "./app-platform-release.js";
import {
  parseAppPlatformArtifactDigest,
  type AppPlatformArtifactDigest,
} from "./app-platform-artifact.js";

const featureDeclarationMediaType = "application/vnd.work-fold.feature-declaration+json";
const featureDeclarationFormat = "work-fold.feature-declaration";
const maximumSecretBytes = 64 * 1024;
const maximumDurableStateBytes = 16 * 1024 * 1024;
const maximumPendingMutationsPerPrincipal = 32;
const maximumPendingMutationsPerInstance = 256;
const pendingMutationTtlMs = 15 * 60 * 1_000;
const maximumRecordsPerPartition = 512;
const maximumRecordsPerInstance = 4_096;
const maximumReceiptsPerInstance = 10_000;
const maximumReceiptsTotal = 50_000;
const recoveryReceiptReserveBytes = 16 * 1024;
const cleanupMergeAttempts = 3;
const stableIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const updateIdPattern = /^update_[a-z0-9-]{1,128}$/;

export type HostedProjectRole = "owner" | "reviewer" | "publisher";
export type HostedTenantRole = "owner" | "admin" | "member";
export type HostedInstanceStatus = "active" | "suspended" | "delete-pending" | "purged";
export type HostedDataOwnerClass = "instance" | "principal" | "role";
export type HostedDataAction = "list" | "read" | "create" | "update" | "delete";

export class HostedAppPlatformError extends Error {
  readonly runtimeError: Readonly<RuntimeError>;

  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    options: Readonly<{ retryable?: boolean; receiptId?: string }> = {},
  ) {
    super(message);
    this.name = "HostedAppPlatformError";
    this.runtimeError = createRuntimeError(code, message, {
      retryable: options.retryable ?? false,
      ...(options.receiptId === undefined ? {} : { receiptId: options.receiptId }),
    });
  }
}

/** Auth adapters return a host-derived Principal; request bodies never select it. */
export interface HostedPrincipalAuthenticator {
  authenticate(authentication: string): unknown;
}

/** Registry adapter resolves an authenticated server-issued binding; callers never choose its id. */
export interface HostedCloudProjectRegistry {
  resolveBinding(input: Readonly<{
    projectId: ProjectId;
    effectivePrincipal: EffectivePrincipal;
  }>): unknown;
}

/**
 * The vault owns secret bytes. Every returned secretRef is a globally unique,
 * immutable allocation identity that is never reassigned to another binding,
 * including after destroy/cancel. The reference is trusted-host internal.
 */
export interface HostedSecretVault {
  /** Idempotent for binding.operationId and returns the same reference on retry. */
  store(
    secret: Uint8Array,
    binding: Readonly<{
      tenantId: TenantId;
      operationId: string;
      projectId: ProjectId;
      cloudProjectId: CloudProjectId;
      runtimeInstanceId: RuntimeInstanceId;
      releaseDigest: Sha256Digest;
      featureId: string;
      featureInstallationId: FeatureInstallationId;
      featureRevisionDigest: AppPlatformArtifactDigest;
      declarationDigest: Sha256Digest;
      connectionId: string;
      declarationId: string;
      networkDeclarationId: string;
      authKind: "bearer" | "api-key";
      origin: string;
      targetIdentity: string;
      owner: Readonly<{ kind: "instance"; runtimeInstanceId: RuntimeInstanceId }>;
      authority: Readonly<AuthorityStamp>;
    }>,
  ): string;
  /** Idempotently destroys only that globally unique original allocation. */
  destroy(secretRef: string): void;
  /**
   * Durably and idempotently cancels this operation before returning, destroys
   * any existing allocation, and forward-fences any later store with the same
   * operationId. Recovery may race a live caller after its reservation commit.
   */
  cancelStore(operationId: string): void;
}

/**
 * A trusted hosted egress adapter must invoke authorizeEffect immediately before
 * the external effect. Neither the secret bytes nor secret reference cross back
 * into Feature code or public service results.
 */
export interface HostedConnectionEffectBroker {
  // The adapter also owns DNS/IP classification, redirect revalidation, quotas,
  // and timeout policy; a reviewed origin alone is not an SSRF defense.
  // Delivery is intentionally at-least-once across a crash after the external
  // effect but before its terminal receipt commit. The broker must durably
  // deduplicate idempotencyKey while preserving the exact identity below.
  execute(input: Readonly<{
    tenantId: TenantId;
    projectId: ProjectId;
    cloudProjectId: CloudProjectId;
    runtimeInstanceId: RuntimeInstanceId;
    releaseDigest: Sha256Digest;
    featureId: string;
    featureInstallationId: FeatureInstallationId;
    featureRevisionDigest: AppPlatformArtifactDigest;
    declarationDigest: Sha256Digest;
    jobId: string;
    declarationId: string;
    networkDeclarationId: string;
    connectionDeclarationId: string;
    connectionId: string;
    targetIdentity: string;
    owner: Readonly<{ kind: "instance"; runtimeInstanceId: RuntimeInstanceId }>;
    authKind: "bearer" | "api-key";
    origin: string;
    secretRef: string;
    acceptedAuthority: Readonly<AuthorityStamp>;
    acceptedAt: string;
    scheduleId: string;
    leaseId: string;
    claimOperationId: string;
    occurrenceId: string;
    runId: string;
    attemptId: string;
    /** Stable for one coordinator attempt. Brokers must deduplicate this key. */
    idempotencyKey: string;
    authorizeEffect: () => void;
  }>): Promise<void>;
}

/**
 * Trusted persistence boundary. Implementations must make compare-and-swap
 * durable before returning and must never expose the snapshot to an untrusted
 * client: it contains opaque vault references, though never secret bytes. load
 * and compareAndSwap are linearizable. The adapter must resolve ambiguous storage
 * outcomes internally: any surfaced compareAndSwap error guarantees nextState did
 * not commit. The service's exact readback is defense in depth, not a substitute
 * for that failure-atomic adapter contract.
 */
export interface HostedDurableStateRepository {
  load(): unknown | undefined;
  compareAndSwap(expectedRevision: number, nextState: unknown): void;
}

export interface HostedJobLease {
  readonly leaseId: string;
  readonly scheduleId: string;
  readonly occurrenceId: string;
  readonly runId: string;
  readonly attemptId: string;
}

/**
 * Durable scheduler/lease authority; occurrence identity is host-owned.
 * scheduleId and leaseId are globally unique immutable allocation identities,
 * never reassigned after disable, cancellation, or finish. Cleanup is
 * idempotent for only the exact original identity, including after restores.
 */
export interface HostedJobCoordinator {
  /** Idempotent for input.operationId and returns the same schedule id on retry. */
  enable(input: Readonly<{
    operationId: string;
    tenantId: TenantId;
    runtimeInstanceId: RuntimeInstanceId;
    featureInstallationId: FeatureInstallationId;
    jobId: string;
    schedule: Readonly<{ kind: "interval"; everySeconds: number }>;
  }>): string;
  /**
   * Durably and idempotently cancels this operation before returning, disables
   * any existing schedule, and forward-fences a later enable with operationId.
   */
  cancelEnable(operationId: string): void;
  /** Idempotently disables only that globally unique original schedule. */
  disable(scheduleId: string): void;
  /** Idempotent for input.operationId and returns the same exact lease on retry. */
  claim(input: Readonly<{
    operationId: string;
    tenantId: TenantId;
    runtimeInstanceId: RuntimeInstanceId;
    featureInstallationId: FeatureInstallationId;
    jobId: string;
    scheduleId: string;
    authority: Readonly<AuthorityStamp>;
  }>): HostedJobLease;
  /**
   * Durably and idempotently cancels a claim operation, forward-fences a later
   * claim with the same operationId, and returns the same lease identity if one
   * was acquired, including on every recovery retry. Recovery may race a live
   * caller after its reservation commit.
   */
  cancelClaim(operationId: string): HostedJobLease | undefined;
  /** Effect-time validation must fail unless this exact lease attempt is current. */
  validate(input: Readonly<HostedJobLease & {
    operationId: string;
    tenantId: TenantId;
    runtimeInstanceId: RuntimeInstanceId;
    featureInstallationId: FeatureInstallationId;
    jobId: string;
    authority: Readonly<AuthorityStamp>;
  }>): void;
  /** Idempotent for one globally unique exact lease/state pair; delivery is retried. */
  finish(leaseId: string, state: "succeeded" | "failed" | "cancelled"): void;
}

export interface HostedInstanceRevocationHighWater {
  /**
   * Non-rollbackable and idempotent for an exact marker. The only permitted
   * mutation is a monotonic advance of that identity from delete-pending to
   * purged. Once raised, reads must survive application-state restore so an
   * older backup cannot regain authority or data.
   */
  raise(marker: Readonly<HostedInstanceRevocationMarker>): void;
  read(runtimeInstanceId: RuntimeInstanceId): unknown | undefined;
}

export interface HostedInstanceRevocationMarker {
  readonly revocationId: string;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly cloudProjectId: CloudProjectId;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly tombstonedAt: string;
  readonly effectivePrincipal: EffectivePrincipal;
  readonly deleteReceipts: readonly Readonly<{
    featureInstallationId: FeatureInstallationId;
    receiptId: string;
  }>[];
  readonly phase: "delete-pending" | "purged";
  readonly purgedAt?: string;
  readonly purgedBy?: EffectivePrincipal;
  readonly purgeReceipts?: readonly Readonly<{
    featureInstallationId: FeatureInstallationId;
    receiptId: string;
  }>[];
}

export interface HostedRoleSeed {
  readonly projectRoles: readonly Readonly<{
    projectId: ProjectId;
    principalId: PrincipalId;
    roles: readonly HostedProjectRole[];
  }>[];
  readonly tenantRoles: readonly Readonly<{
    tenantId: TenantId;
    principalId: PrincipalId;
    roles: readonly HostedTenantRole[];
  }>[];
}

export interface PrivateHostedAppServiceOptions extends HostedRoleSeed {
  readonly authenticator: HostedPrincipalAuthenticator;
  readonly cloudProjectRegistry: HostedCloudProjectRegistry;
  readonly secretVault: HostedSecretVault;
  readonly effectBroker: HostedConnectionEffectBroker;
  readonly stateRepository: HostedDurableStateRepository;
  readonly jobCoordinator: HostedJobCoordinator;
  readonly revocationHighWater: HostedInstanceRevocationHighWater;
  readonly now?: () => Date;
}

interface NetworkDeclaration {
  readonly declarationId: string;
  readonly origin: string;
}

interface ConnectionDeclaration {
  readonly declarationId: string;
  readonly networkDeclarationId: string;
  readonly authKind: "bearer" | "api-key";
}

interface JobDeclaration {
  readonly jobId: string;
  readonly networkDeclarationId: string;
  readonly connectionDeclarationId: string;
  readonly schedule: Readonly<{ kind: "interval"; everySeconds: number }>;
}

interface DataCollectionDeclaration {
  readonly collectionId: string;
  readonly ownerClass: HostedDataOwnerClass;
  readonly allowedActions: readonly HostedDataAction[];
  readonly allowedRoles: readonly string[];
}

interface HostedFeatureDeclaration {
  readonly format: typeof featureDeclarationFormat;
  readonly formatVersion: 1;
  readonly networkDestinations: readonly NetworkDeclaration[];
  readonly connections: readonly ConnectionDeclaration[];
  readonly jobs: readonly JobDeclaration[];
  readonly collections: readonly DataCollectionDeclaration[];
}

interface RegistryRelease {
  readonly release: AppReleaseEnvelope;
  readonly declarations: ReadonlyMap<string, HostedFeatureDeclaration>;
  reviewedBy: EffectivePrincipal;
  reviewedAt: string;
  publishedBy?: EffectivePrincipal;
  publishedAt?: string;
}

interface NetworkGrant {
  readonly declarationId: string;
  readonly origin: string;
  readonly grantedAt: string;
  readonly grantedBy: PrincipalId;
}

interface InstanceConnection {
  readonly connectionId: string;
  readonly declarationId: string;
  readonly networkDeclarationId: string;
  readonly origin: string;
  readonly targetIdentity: string;
  readonly authKind: "bearer" | "api-key";
  readonly featureRevisionDigest: AppPlatformArtifactDigest;
  readonly declarationDigest: Sha256Digest;
  readonly owner: Readonly<{ kind: "instance"; runtimeInstanceId: RuntimeInstanceId }>;
  readonly secretRef: string;
  readonly boundAt: string;
  readonly boundBy: PrincipalId;
}

interface InstanceJob {
  readonly jobId: string;
  enabled: boolean;
  enabledAt?: string;
  enabledBy?: PrincipalId;
  scheduleId?: string;
}

interface HostedDataRecord {
  readonly recordId: string;
  revision: number;
  value: unknown;
  updatedAt: string;
  updatedBy: PrincipalId;
}

interface HostedDataCollection {
  readonly collectionId: string;
  readonly ownerClass: HostedDataOwnerClass;
  readonly partitions: Map<string, Map<string, HostedDataRecord>>;
}

interface PendingDataMutation {
  readonly mutationId: string;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly featureId: string;
  readonly featureInstallationId: FeatureInstallationId;
  readonly collectionId: string;
  readonly partitionId: string;
  readonly action: "create" | "update" | "delete";
  readonly recordId: string;
  readonly expectedRevision: number | null;
  readonly value?: unknown;
  readonly principal: EffectivePrincipal;
  readonly authority: Readonly<AuthorityStamp>;
  readonly preparedAt: string;
  readonly expiresAt: string;
}

interface SecretCleanupTask {
  readonly secretRef: string;
  readonly runtimeInstanceId: RuntimeInstanceId;
}

interface ScheduleCleanupTask {
  readonly scheduleId: string;
  readonly runtimeInstanceId: RuntimeInstanceId;
}

interface LeaseCompletionTask {
  readonly leaseId: string;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly state: "succeeded" | "failed" | "cancelled";
}

interface PendingExternalAllocation {
  readonly operationId: string;
  readonly kind: "vault-store" | "schedule-enable";
  readonly runtimeInstanceId: RuntimeInstanceId;
}

interface PendingJobClaim {
  readonly operationId: string;
  readonly tenantId: TenantId;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly featureId: string;
  readonly featureInstallationId: FeatureInstallationId;
  readonly dataNamespaceId: DataNamespaceId;
  readonly releaseDigest: Sha256Digest;
  readonly featureRevisionDigest: AppPlatformArtifactDigest;
  readonly jobId: string;
  readonly declarationId: string;
  readonly networkDeclarationId: string;
  readonly connectionDeclarationId: string;
  readonly connectionId: string;
  readonly scheduleId: string;
  readonly principal: EffectivePrincipal;
  readonly authority: Readonly<AuthorityStamp>;
  readonly acceptedAt: string;
}

interface PendingInstanceTransition {
  // Durable semantic-core reservation. Its marker preallocates the exact audit
  // receipt ids; every non-purged snapshot carries lifecycle recovery byte
  // headroom so older backups can terminalize those receipts as well.
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly marker: Readonly<HostedInstanceRevocationMarker>;
}

interface HostedFeatureInstallation {
  readonly featureId: string;
  readonly featureInstallationId: FeatureInstallationId;
  readonly dataNamespaceId: DataNamespaceId;
  featureRevisionDigest: AppPlatformArtifactDigest;
  declarationDigest: Sha256Digest;
  dataSchemaIdentity: string | null;
  authority: Readonly<AuthorityStamp>;
  readonly networkGrants: Map<string, NetworkGrant>;
  readonly connections: Map<string, InstanceConnection>;
  readonly jobs: Map<string, InstanceJob>;
  readonly dataCollections: Map<string, HostedDataCollection>;
}

interface HostedInstance {
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly cloudProjectId: CloudProjectId;
  releaseDigest: Sha256Digest;
  status: HostedInstanceStatus;
  readonly createdAt: string;
  readonly installations: Map<string, HostedFeatureInstallation>;
  readonly instanceRoles: Map<string, Set<string>>;
  deletedAt?: string;
  revocationId?: string;
  purgedAt?: string;
}

interface StoredUpdateReview {
  readonly updateId: string;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly fromReleaseDigest: Sha256Digest;
  readonly toReleaseDigest: Sha256Digest;
  readonly reviewedBy: EffectivePrincipal;
  readonly reviewedAt: string;
  readonly capturedAuthorities: ReadonlyMap<string, Readonly<AuthorityStamp>>;
  readonly decisions: readonly HostedUpdateFeatureDecision[];
}

export interface HostedUpdateFeatureDecision {
  readonly featureId: string;
  readonly revision: "unchanged" | "changed";
  readonly grants: "eligible-to-retain" | "reset";
  readonly connections: "eligible-to-retain" | "reset";
  readonly jobs: "eligible-to-retain" | "reset";
  readonly data: "compatible";
}

export interface HostedUpdateReview {
  readonly updateId: string;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly fromReleaseDigest: Sha256Digest;
  readonly toReleaseDigest: Sha256Digest;
  readonly reviewedBy: EffectivePrincipal;
  readonly reviewedAt: string;
  readonly decisions: readonly HostedUpdateFeatureDecision[];
}

export type HostedManagementAction =
  | "cloud-project-bound"
  | "release-reviewed"
  | "release-published"
  | "instance-deployed"
  | "network-granted"
  | "network-revoked"
  | "connection-bound"
  | "connection-disconnected"
  | "job-enabled"
  | "job-disabled"
  | "instance-role-assigned"
  | "instance-role-removed"
  | "update-reviewed"
  | "update-activated"
  | "instance-suspended"
  | "instance-resumed"
  | "principal-revoked"
  | "principal-data-exported"
  | "instance-exported"
  | "instance-delete-requested"
  | "instance-purged";

export interface HostedManagementReceipt {
  readonly receiptId: string;
  readonly kind: "admin-transition";
  readonly action: HostedManagementAction;
  readonly effectivePrincipal: EffectivePrincipal;
  readonly acceptedAt: string;
  readonly state: "succeeded";
  readonly projectId?: ProjectId;
  readonly cloudProjectId?: CloudProjectId;
  readonly tenantId?: TenantId;
  readonly runtimeInstanceId?: RuntimeInstanceId;
  readonly featureInstallationId?: FeatureInstallationId;
  readonly authority?: Readonly<AuthorityStamp>;
  readonly releaseDigest?: Sha256Digest;
  readonly predecessorReleaseDigest?: Sha256Digest;
  readonly featureId?: string;
  readonly declarationId?: string;
  readonly connectionId?: string;
  readonly jobId?: string;
  readonly scheduleId?: string;
  readonly collectionId?: string;
  readonly recordId?: string;
  readonly dataAction?: HostedDataAction;
  readonly updateId?: string;
  readonly roleId?: string;
  readonly affectedPrincipalId?: PrincipalId;
}

/** RuntimeReceipt plus the artifact-scheme identity used by App Release v1. */
export interface HostedJobReceipt extends RuntimeReceipt {
  readonly kind: "job";
  readonly releaseDigest: Sha256Digest;
  readonly featureRevisionDigest: AppPlatformArtifactDigest;
  readonly jobId: string;
  readonly declarationId: string;
  readonly networkDeclarationId: string;
  readonly connectionDeclarationId: string;
  readonly connectionId: string;
  readonly scheduleId: string;
  readonly leaseId: string;
  readonly claimOperationId: string;
}

export interface HostedDataReceipt extends RuntimeReceipt {
  readonly kind: "resource-mutation";
  readonly featureRevisionDigest: AppPlatformArtifactDigest;
  readonly collectionId: string;
  readonly recordId: string;
  readonly dataAction: "create" | "update" | "delete";
  readonly recordRevision: number;
}

export interface HostedDataRecordView {
  readonly recordId: string;
  readonly revision: number;
  readonly value: unknown;
  readonly updatedAt: string;
}

export interface HostedPreparedDataMutation {
  readonly mutationId: string;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly featureInstallationId: FeatureInstallationId;
  readonly collectionId: string;
  readonly recordId: string;
  readonly dataAction: "create" | "update" | "delete";
  readonly authority: Readonly<AuthorityStamp>;
  readonly preparedAt: string;
}

export interface HostedInstanceView {
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly cloudProjectId: CloudProjectId;
  readonly releaseDigest: Sha256Digest;
  readonly host: "hosted";
  readonly status: HostedInstanceStatus;
  readonly features: readonly Readonly<{
    featureId: string;
    featureInstallationId: FeatureInstallationId;
    dataNamespaceId: DataNamespaceId;
    featureRevisionDigest: AppPlatformArtifactDigest;
    declarationDigest: Sha256Digest;
    authority: Readonly<AuthorityStamp>;
    networkGrants: readonly Readonly<{ declarationId: string; origin: string }>[];
    connections: readonly Readonly<{
      connectionId: string;
      declarationId: string;
      origin: string;
      targetIdentity: string;
      featureRevisionDigest: AppPlatformArtifactDigest;
      declarationDigest: Sha256Digest;
      owner: Readonly<{ kind: "instance"; runtimeInstanceId: RuntimeInstanceId }>;
      status: "active";
    }>[];
    jobs: readonly Readonly<{ jobId: string; enabled: boolean; scheduleId?: string }>[];
    collections: readonly Readonly<{ collectionId: string; ownerClass: HostedDataOwnerClass }>[];
  }>[];
  readonly instanceRoles: readonly Readonly<{ principalId: PrincipalId; roles: readonly string[] }>[];
}

export interface HostedInstanceExport {
  readonly format: "work-fold.hosted-instance-export";
  readonly formatVersion: 1;
  readonly generatedAt: string;
  readonly instance: HostedInstanceView;
  readonly receipts: readonly (HostedManagementReceipt | HostedJobReceipt | HostedDataReceipt)[];
  readonly data: readonly Readonly<{
    featureId: string;
    collectionId: string;
    ownerClass: HostedDataOwnerClass;
    partitions: readonly Readonly<{
      partitionId: string;
      records?: readonly Readonly<{ recordId: string; revision: number; value: unknown; updatedAt: string }>[];
      omittedPrincipalPrivateRecords?: number;
    }>[];
  }>[];
  readonly completeness: Readonly<{
    secretsIncluded: false;
    projectSourceIncluded: false;
    immutableReleaseIncluded: false;
    principalPrivateContents: "requester-only";
    receiptsCompleteThrough: string;
  }>;
}

export interface HostedPrincipalDataExport {
  readonly format: "work-fold.hosted-principal-data-export";
  readonly formatVersion: 1;
  readonly generatedAt: string;
  readonly tenantId: TenantId;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly principalId: PrincipalId;
  readonly data: readonly Readonly<{
    featureId: string;
    collectionId: string;
    records: readonly HostedDataRecordView[];
  }>[];
  readonly secretsIncluded: false;
}

export class PrivateHostedAppService {
  readonly #authenticator: HostedPrincipalAuthenticator;
  readonly #cloudProjectRegistry: HostedCloudProjectRegistry;
  readonly #secretVault: HostedSecretVault;
  readonly #effectBroker: HostedConnectionEffectBroker;
  readonly #stateRepository: HostedDurableStateRepository;
  readonly #jobCoordinator: HostedJobCoordinator;
  readonly #revocationHighWater: HostedInstanceRevocationHighWater;
  readonly #now: () => Date;
  readonly #projectRoles = new Map<string, Map<string, Set<HostedProjectRole>>>();
  readonly #tenantRoles = new Map<string, Map<string, Set<HostedTenantRole>>>();
  readonly #cloudProjectsByProject = new Map<string, CloudProjectId>();
  readonly #projectsByCloudProject = new Map<string, ProjectId>();
  readonly #registry = new Map<string, RegistryRelease>();
  readonly #instances = new Map<string, HostedInstance>();
  readonly #updateReviews = new Map<string, StoredUpdateReview>();
  readonly #managementReceipts: HostedManagementReceipt[] = [];
  readonly #runtimeReceipts: HostedJobReceipt[] = [];
  readonly #dataReceipts: HostedDataReceipt[] = [];
  readonly #pendingDataMutations = new Map<string, PendingDataMutation>();
  readonly #pendingSecretCleanup = new Map<string, SecretCleanupTask>();
  readonly #pendingScheduleCleanup = new Map<string, ScheduleCleanupTask>();
  readonly #pendingLeaseCompletions = new Map<string, LeaseCompletionTask>();
  readonly #pendingExternalAllocations = new Map<string, PendingExternalAllocation>();
  readonly #pendingJobClaims = new Map<string, PendingJobClaim>();
  readonly #pendingInstanceTransitions = new Map<RuntimeInstanceId, PendingInstanceTransition>();
  readonly #revokedTenantPrincipals = new Set<string>();
  #stateRevision = 0;

  constructor(options: PrivateHostedAppServiceOptions) {
    const record = expectRecord(options, "Private hosted service options");
    expectOnlyKeys(record, ["authenticator", "cloudProjectRegistry", "secretVault", "effectBroker", "stateRepository", "jobCoordinator", "revocationHighWater", "now", "projectRoles", "tenantRoles"], "Private hosted service options");
    if (!options.authenticator || typeof options.authenticator.authenticate !== "function") {
      throw invalid("Private hosted service requires an authenticator.");
    }
    if (!options.cloudProjectRegistry || typeof options.cloudProjectRegistry.resolveBinding !== "function") {
      throw invalid("Private hosted service requires a cloud Project registry.");
    }
    if (!options.secretVault || typeof options.secretVault.store !== "function" || typeof options.secretVault.destroy !== "function"
      || typeof options.secretVault.cancelStore !== "function") {
      throw invalid("Private hosted service requires a secret vault.");
    }
    if (!options.effectBroker || typeof options.effectBroker.execute !== "function") {
      throw invalid("Private hosted service requires a connection effect broker.");
    }
    if (!options.stateRepository || typeof options.stateRepository.load !== "function"
      || typeof options.stateRepository.compareAndSwap !== "function") {
      throw invalid("Private hosted service requires a durable state repository.");
    }
    if (!options.jobCoordinator || typeof options.jobCoordinator.enable !== "function"
      || typeof options.jobCoordinator.disable !== "function"
      || typeof options.jobCoordinator.cancelEnable !== "function"
      || typeof options.jobCoordinator.claim !== "function"
      || typeof options.jobCoordinator.cancelClaim !== "function"
      || typeof options.jobCoordinator.validate !== "function"
      || typeof options.jobCoordinator.finish !== "function") {
      throw invalid("Private hosted service requires a durable job coordinator.");
    }
    if (!options.revocationHighWater || typeof options.revocationHighWater.raise !== "function"
      || typeof options.revocationHighWater.read !== "function") {
      throw invalid("Private hosted service requires a non-rollbackable instance revocation high-water adapter.");
    }
    if (options.now !== undefined && typeof options.now !== "function") throw invalid("now must be a function.");
    this.#authenticator = options.authenticator;
    this.#cloudProjectRegistry = options.cloudProjectRegistry;
    this.#secretVault = options.secretVault;
    this.#effectBroker = options.effectBroker;
    this.#stateRepository = options.stateRepository;
    this.#jobCoordinator = options.jobCoordinator;
    this.#revocationHighWater = options.revocationHighWater;
    this.#now = options.now ?? (() => new Date());
    this.#seedProjectRoles(options.projectRoles);
    this.#seedTenantRoles(options.tenantRoles);
    this.#loadDurableState();
    this.#recoverPendingInstanceTransitions();
    this.#reconcileRevocationHighWater();
    this.#retryExternalAllocations();
    this.#retryPendingJobClaims();
    this.#retryUnresolvedAcceptedReceipts();
    this.#retrySecretCleanup();
    this.#retryScheduleCleanup();
    this.#retryLeaseCompletions();
  }

  bindCloudProject(input: Readonly<{
    authentication: string;
    projectId: string;
  }>): Readonly<{ projectId: ProjectId; cloudProjectId: CloudProjectId }> {
    const record = exactInput(input, ["authentication", "projectId"], "Bind cloud Project input");
    const principal = this.#authenticate(record.authentication);
    const projectId = project(record.projectId);
    this.#requireProjectRole(projectId, principal.principalId, "owner");
    let resolved: unknown;
    try {
      resolved = this.#cloudProjectRegistry.resolveBinding({ projectId, effectivePrincipal: principal });
    } catch (error) {
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", `The cloud Project registry could not resolve the binding: ${message(error)}`, { retryable: true });
    }
    if (resolved === null || resolved === undefined) {
      throw new HostedAppPlatformError("RESOURCE_DENIED", "The authenticated registry has no binding for this App Project.");
    }
    const cloudProjectId = cloudProject(resolved);
    if (this.#cloudProjectsByProject.has(projectId) || this.#projectsByCloudProject.has(cloudProjectId)) {
      throw conflict("The local or cloud App Project is already bound.");
    }
    this.#assertReceiptCapacity(undefined, 1);
    const checkpoint = this.#checkpoint();
    const now = this.#timestamp();
    this.#cloudProjectsByProject.set(projectId, cloudProjectId);
    this.#projectsByCloudProject.set(cloudProjectId, projectId);
    this.#appendManagementReceipt("cloud-project-bound", principal, now, { projectId, cloudProjectId });
    this.#commitOrRestore(checkpoint);
    return Object.freeze({ projectId, cloudProjectId });
  }

  reviewRelease(input: Readonly<{ authentication: string; release: unknown }>): Readonly<{ releaseDigest: Sha256Digest }> {
    const record = exactInput(input, ["authentication", "release"], "Review Release input");
    const principal = this.#authenticate(record.authentication);
    let release: AppReleaseEnvelope;
    try {
      release = verifyAppRelease(record.release);
    } catch (error) {
      throw invalid(`Release verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.#requireProjectRole(release.manifest.projectId, principal.principalId, "reviewer");
    if (!this.#cloudProjectsByProject.has(release.manifest.projectId)) {
      throw new HostedAppPlatformError("RESOURCE_DENIED", "Bind this local App Project to an authenticated cloud Project before hosted review.");
    }
    const declarations = parseReleaseDeclarations(release);
    const existing = this.#registry.get(release.releaseDigest);
    if (existing) {
      if (existing.release.manifest.projectId !== release.manifest.projectId) throw conflict("Release digest is already registered to another Project.");
      throw conflict("This immutable Release has already been reviewed.");
    }
    this.#assertReceiptCapacity(undefined, 1);
    const checkpoint = this.#checkpoint();
    const now = this.#timestamp();
    this.#registry.set(release.releaseDigest, {
      release,
      declarations,
      reviewedBy: principal,
      reviewedAt: now,
    });
    this.#appendManagementReceipt("release-reviewed", principal, now, {
      projectId: release.manifest.projectId,
      releaseDigest: release.releaseDigest,
    });
    this.#commitOrRestore(checkpoint);
    return Object.freeze({ releaseDigest: release.releaseDigest });
  }

  publishReviewedRelease(input: Readonly<{ authentication: string; releaseDigest: string }>): Readonly<{ releaseDigest: Sha256Digest; publishedAt: string }> {
    const record = exactInput(input, ["authentication", "releaseDigest"], "Publish Release input");
    const principal = this.#authenticate(record.authentication);
    const releaseDigest = digest(record.releaseDigest, "releaseDigest");
    const entry = this.#registry.get(releaseDigest);
    if (!entry) throw notFound("The reviewed Release was not found.");
    this.#requireProjectRole(entry.release.manifest.projectId, principal.principalId, "publisher");
    if (entry.publishedAt) throw conflict("This immutable Release is already published.");
    this.#assertReceiptCapacity(undefined, 1);
    const checkpoint = this.#checkpoint();
    const now = this.#timestamp();
    entry.publishedAt = now;
    entry.publishedBy = principal;
    this.#appendManagementReceipt("release-published", principal, now, {
      projectId: entry.release.manifest.projectId,
      releaseDigest,
    });
    this.#commitOrRestore(checkpoint);
    return Object.freeze({ releaseDigest, publishedAt: now });
  }

  deployHostedInstance(input: Readonly<{ authentication: string; tenantId: string; releaseDigest: string }>): HostedInstanceView {
    const record = exactInput(input, ["authentication", "tenantId", "releaseDigest"], "Deploy hosted instance input");
    const principal = this.#authenticate(record.authentication);
    const tenantId = tenant(record.tenantId);
    const releaseDigest = digest(record.releaseDigest, "releaseDigest");
    this.#requireTenantRole(tenantId, principal.principalId, "admin");
    const registryEntry = this.#registry.get(releaseDigest);
    if (!registryEntry?.publishedAt) throw notFound("The published Release was not found.");
    const runtimeInstanceId = createRuntimeInstanceId();
    this.#assertReceiptCapacity(runtimeInstanceId, 1 + registryEntry.release.manifest.features.length * 2);
    const checkpoint = this.#checkpoint();
    const now = this.#timestamp();
    const installations = new Map<string, HostedFeatureInstallation>();
    for (const feature of registryEntry.release.manifest.features) {
      const declaration = registryEntry.declarations.get(feature.featureId)!;
      installations.set(feature.featureId, createInstallation(feature, declaration));
    }
    const instance: HostedInstance = {
      runtimeInstanceId,
      tenantId,
      projectId: registryEntry.release.manifest.projectId,
      cloudProjectId: this.#cloudProjectsByProject.get(registryEntry.release.manifest.projectId)!,
      releaseDigest,
      status: "active",
      createdAt: now,
      installations,
      instanceRoles: new Map(),
    };
    this.#instances.set(runtimeInstanceId, instance);
    this.#appendManagementReceipt("instance-deployed", principal, now, {
      projectId: instance.projectId,
      tenantId,
      runtimeInstanceId,
      releaseDigest,
    });
    this.#commitOrRestore(checkpoint);
    return instanceView(instance);
  }

  getInstance(input: Readonly<{ authentication: string; runtimeInstanceId: string }>): HostedInstanceView {
    const record = exactInput(input, ["authentication", "runtimeInstanceId"], "Get instance input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#instance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "member");
    return instanceView(instance);
  }

  grantNetwork(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    featureId: string;
    declarationId: string;
  }>): HostedInstanceView {
    const record = exactInput(input, ["authentication", "runtimeInstanceId", "featureId", "declarationId"], "Grant network input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#activeInstance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "admin");
    const installation = this.#installation(instance, stableId(record.featureId, "featureId"));
    const declarationId = stableId(record.declarationId, "declarationId");
    const declaration = this.#declaration(instance, installation.featureId);
    const destination = declaration.networkDestinations.find((item) => item.declarationId === declarationId);
    if (!destination) throw new HostedAppPlatformError("NETWORK_DENIED", "The reviewed Feature does not declare this network destination.");
    if (installation.networkGrants.has(declarationId)) throw conflict("This network destination is already granted.");
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 1);
    const checkpoint = this.#checkpoint();
    const now = this.#timestamp();
    installation.networkGrants.set(declarationId, {
      declarationId,
      origin: destination.origin,
      grantedAt: now,
      grantedBy: principal.principalId,
    });
    installation.authority = advanceFields(installation.authority, ["grantGeneration"]);
    this.#appendInstallationReceipt("network-granted", principal, now, instance, installation, { declarationId });
    this.#commitOrRestore(checkpoint);
    return instanceView(instance);
  }

  bindInstanceConnection(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    featureId: string;
    declarationId: string;
    secret: Uint8Array;
  }>): HostedInstanceView {
    const record = exactInput(input, ["authentication", "runtimeInstanceId", "featureId", "declarationId", "secret"], "Bind connection input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#activeInstance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "admin");
    const installation = this.#installation(instance, stableId(record.featureId, "featureId"));
    const declarationId = stableId(record.declarationId, "declarationId");
    const declaration = this.#declaration(instance, installation.featureId);
    const requested = declaration.connections.find((item) => item.declarationId === declarationId);
    if (!requested) throw new HostedAppPlatformError("RESOURCE_DENIED", "The reviewed Feature does not declare this connection.");
    const networkGrant = installation.networkGrants.get(requested.networkDeclarationId);
    if (!networkGrant) throw new HostedAppPlatformError("NETWORK_DENIED", "Grant the connection's exact network destination first.");
    if ([...installation.connections.values()].some((item) => item.declarationId === declarationId)) {
      throw conflict("This instance-owned connection is already bound.");
    }
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 1);
    const secret = parseSecret(record.secret);
    try {
      const connectionAuthority = advanceFields(installation.authority, ["connectionGeneration"]);
      const connectionId = `connection_${randomUUID()}`;
      const operationId = `allocation_${randomUUID()}`;
      const reservationCheckpoint = this.#checkpoint();
      this.#pendingExternalAllocations.set(operationId, { operationId, kind: "vault-store", runtimeInstanceId: instance.runtimeInstanceId });
      this.#commitOrRestore(reservationCheckpoint);
      const secretRef = this.#secretVault.store(secret, {
        tenantId: instance.tenantId,
        operationId,
        projectId: instance.projectId,
        cloudProjectId: instance.cloudProjectId,
        runtimeInstanceId: instance.runtimeInstanceId,
        releaseDigest: instance.releaseDigest,
        featureId: installation.featureId,
        featureInstallationId: installation.featureInstallationId,
        featureRevisionDigest: installation.featureRevisionDigest,
        declarationDigest: installation.declarationDigest,
        connectionId,
        declarationId,
        networkDeclarationId: requested.networkDeclarationId,
        authKind: requested.authKind,
        origin: networkGrant.origin,
        targetIdentity: networkGrant.origin,
        owner: { kind: "instance", runtimeInstanceId: instance.runtimeInstanceId },
        authority: connectionAuthority,
      });
      if (typeof secretRef !== "string" || secretRef.length < 1 || secretRef.length > 512) {
        throw invalid("The secret vault returned an invalid opaque reference.");
      }
      const finalizeCheckpoint = this.#checkpoint();
      const now = this.#timestamp();
      installation.connections.set(connectionId, {
        connectionId,
        declarationId,
        networkDeclarationId: requested.networkDeclarationId,
        origin: networkGrant.origin,
        targetIdentity: networkGrant.origin,
        authKind: requested.authKind,
        featureRevisionDigest: installation.featureRevisionDigest,
        declarationDigest: installation.declarationDigest,
        owner: { kind: "instance", runtimeInstanceId: instance.runtimeInstanceId },
        secretRef,
        boundAt: now,
        boundBy: principal.principalId,
      });
      installation.authority = connectionAuthority;
      this.#pendingExternalAllocations.delete(operationId);
      this.#appendInstallationReceipt("connection-bound", principal, now, instance, installation, {
        declarationId,
        connectionId,
      });
      this.#commitOrRestore(finalizeCheckpoint);
      return instanceView(instance);
    } catch (error) {
      this.#retryExternalAllocations();
      if (error instanceof HostedAppPlatformError) throw error;
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The hosted secret vault could not bind the connection.", { retryable: true });
    } finally {
      secret.fill(0);
    }
  }

  enableJob(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    featureId: string;
    jobId: string;
  }>): HostedInstanceView {
    const record = exactInput(input, ["authentication", "runtimeInstanceId", "featureId", "jobId"], "Enable job input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#activeInstance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "admin");
    const installation = this.#installation(instance, stableId(record.featureId, "featureId"));
    const jobId = stableId(record.jobId, "jobId");
    const declaration = this.#declaration(instance, installation.featureId);
    const jobDeclaration = declaration.jobs.find((item) => item.jobId === jobId);
    if (!jobDeclaration) throw new HostedAppPlatformError("ACTION_UNDECLARED", "The reviewed Feature does not declare this named job.");
    this.#requireJobDependencies(installation, jobDeclaration);
    const job = installation.jobs.get(jobId);
    if (!job) throw new HostedAppPlatformError("ACTION_UNDECLARED", "The named job is unavailable.");
    if (job.enabled) throw conflict("This named job is already enabled.");
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 1);
    const operationId = `allocation_${randomUUID()}`;
    const reservationCheckpoint = this.#checkpoint();
    this.#pendingExternalAllocations.set(operationId, { operationId, kind: "schedule-enable", runtimeInstanceId: instance.runtimeInstanceId });
    this.#commitOrRestore(reservationCheckpoint);
    try {
      const scheduleId = this.#jobCoordinator.enable({
        operationId,
        tenantId: instance.tenantId,
        runtimeInstanceId: instance.runtimeInstanceId,
        featureInstallationId: installation.featureInstallationId,
        jobId,
        schedule: jobDeclaration.schedule,
      });
      if (typeof scheduleId !== "string" || scheduleId.length < 1 || scheduleId.length > 256) {
        throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The job coordinator returned an invalid schedule id.");
      }
      const finalizeCheckpoint = this.#checkpoint();
      const now = this.#timestamp();
      job.enabled = true;
      job.enabledAt = now;
      job.enabledBy = principal.principalId;
      job.scheduleId = scheduleId;
      installation.authority = advanceFields(installation.authority, ["jobGeneration"]);
      this.#pendingExternalAllocations.delete(operationId);
      this.#appendInstallationReceipt("job-enabled", principal, now, instance, installation, { jobId, scheduleId });
      this.#commitOrRestore(finalizeCheckpoint);
      return instanceView(instance);
    } catch (error) {
      this.#retryExternalAllocations();
      if (error instanceof HostedAppPlatformError) throw error;
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The durable job coordinator could not enable the schedule.", { retryable: true });
    }
  }

  disableJob(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    featureId: string;
    jobId: string;
  }>): HostedInstanceView {
    const record = exactInput(input, ["authentication", "runtimeInstanceId", "featureId", "jobId"], "Disable job input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#instance(record.runtimeInstanceId);
    this.#requireMutableInstance(instance);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "admin");
    const installation = this.#installation(instance, stableId(record.featureId, "featureId"));
    const jobId = stableId(record.jobId, "jobId");
    const job = installation.jobs.get(jobId);
    if (!job?.enabled || !job.scheduleId) throw conflict("This named job is already disabled.");
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 1);
    const checkpoint = this.#checkpoint();
    const scheduleId = job.scheduleId;
    const now = this.#timestamp();
    job.enabled = false;
    delete job.scheduleId;
    installation.authority = advanceFields(installation.authority, ["jobGeneration"]);
    this.#appendInstallationReceipt("job-disabled", principal, now, instance, installation, { jobId, scheduleId });
    this.#queueScheduleCleanup(instance.runtimeInstanceId, scheduleId);
    this.#commitOrRestore(checkpoint);
    this.#retryScheduleCleanup();
    return instanceView(instance);
  }

  disconnectConnection(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    featureId: string;
    connectionId: string;
  }>): HostedInstanceView {
    const record = exactInput(input, ["authentication", "runtimeInstanceId", "featureId", "connectionId"], "Disconnect connection input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#instance(record.runtimeInstanceId);
    this.#requireMutableInstance(instance);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "admin");
    const installation = this.#installation(instance, stableId(record.featureId, "featureId"));
    const connectionId = parseConnectionId(record.connectionId);
    const connection = installation.connections.get(connectionId);
    if (!connection) throw notFound("The instance-owned connection was not found.");
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 1);
    const checkpoint = this.#checkpoint();
    const declaration = this.#declaration(instance, installation.featureId);
    const schedules: string[] = [];
    for (const job of installation.jobs.values()) {
      const jobDeclaration = declaration.jobs.find((item) => item.jobId === job.jobId);
      if (jobDeclaration?.connectionDeclarationId !== connection.declarationId || !job.enabled) continue;
      job.enabled = false;
      if (job.scheduleId) schedules.push(job.scheduleId);
      delete job.scheduleId;
    }
    const now = this.#timestamp();
    installation.connections.delete(connectionId);
    installation.authority = advanceFields(installation.authority, ["connectionGeneration", "jobGeneration"]);
    this.#appendInstallationReceipt("connection-disconnected", principal, now, instance, installation, {
      declarationId: connection.declarationId,
      connectionId,
    });
    this.#queueSecretCleanup(instance.runtimeInstanceId, connection.secretRef);
    for (const scheduleId of schedules) this.#queueScheduleCleanup(instance.runtimeInstanceId, scheduleId);
    this.#commitOrRestore(checkpoint);
    this.#retrySecretCleanup();
    this.#retryScheduleCleanup();
    return instanceView(instance);
  }

  async runNamedJob(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    featureId: string;
    jobId: string;
  }>): Promise<Readonly<HostedJobReceipt>> {
    const record = exactInput(input, ["authentication", "runtimeInstanceId", "featureId", "jobId"], "Run job input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#activeInstance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "member");
    const installation = this.#installation(instance, stableId(record.featureId, "featureId"));
    const jobId = stableId(record.jobId, "jobId");
    const declaration = this.#declaration(instance, installation.featureId);
    const jobDeclaration = declaration.jobs.find((item) => item.jobId === jobId);
    if (!jobDeclaration) throw new HostedAppPlatformError("ACTION_UNDECLARED", "The reviewed Feature does not declare this named job.");
    const job = installation.jobs.get(jobId);
    if (!job?.enabled) throw new HostedAppPlatformError("RESOURCE_DENIED", "This named job is disabled by default or has been revoked.");
    const connection = this.#requireJobDependencies(installation, jobDeclaration);
    if (!job.scheduleId) throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The enabled job has no durable schedule.");
    const authority = parseAuthorityStamp(installation.authority);
    const releaseDigest = instance.releaseDigest;
    const featureRevisionDigest = installation.featureRevisionDigest;
    const acceptedAt = this.#timestamp();
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 2);
    const operationId = `claim_${randomUUID()}`;
    const claimReservation: PendingJobClaim = {
      operationId,
      tenantId: instance.tenantId,
      runtimeInstanceId: instance.runtimeInstanceId,
      featureId: installation.featureId,
      featureInstallationId: installation.featureInstallationId,
      dataNamespaceId: installation.dataNamespaceId,
      releaseDigest,
      featureRevisionDigest,
      jobId,
      declarationId: jobDeclaration.jobId,
      networkDeclarationId: jobDeclaration.networkDeclarationId,
      connectionDeclarationId: jobDeclaration.connectionDeclarationId,
      connectionId: connection.connectionId,
      scheduleId: job.scheduleId,
      principal,
      authority,
      acceptedAt,
    };
    const claimReservationCheckpoint = this.#checkpoint();
    this.#pendingJobClaims.set(operationId, claimReservation);
    this.#commitOrRestore(claimReservationCheckpoint);
    let lease: HostedJobLease;
    try {
      lease = this.#jobCoordinator.claim({
        operationId,
        tenantId: instance.tenantId,
        runtimeInstanceId: instance.runtimeInstanceId,
        featureInstallationId: installation.featureInstallationId,
        jobId,
        scheduleId: job.scheduleId,
        authority,
      });
    } catch {
      this.#retryPendingJobClaims();
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The durable job coordinator could not acquire a lease.", { retryable: true });
    }
    const { runId, attemptId, occurrenceId, leaseId, scheduleId } = parseJobLease(lease, job.scheduleId);
    const idempotencyKey = jobEffectIdempotencyKey({
      runtimeInstanceId: instance.runtimeInstanceId,
      featureInstallationId: installation.featureInstallationId,
      jobId,
      scheduleId,
      occurrenceId,
      runId,
      attemptId,
    });
    const acceptedCheckpoint = this.#checkpoint();
    let accepted: Readonly<HostedJobReceipt>;
    try {
      accepted = this.#appendJobReceipt({
        instance,
        installation,
        principal,
        authority,
        acceptedAt,
        state: "accepted",
        runId,
        attemptId,
        occurrenceId,
        releaseDigest,
        featureRevisionDigest,
        jobId,
        declarationId: jobDeclaration.jobId,
        networkDeclarationId: jobDeclaration.networkDeclarationId,
        connectionDeclarationId: jobDeclaration.connectionDeclarationId,
        connectionId: connection.connectionId,
        scheduleId,
        leaseId,
        claimOperationId: operationId,
      });
      this.#pendingJobClaims.delete(operationId);
      this.#commitOrRestore(acceptedCheckpoint);
    } catch (error) {
      this.#retryPendingJobClaims();
      throw error;
    }
    let effectError: unknown;
    try {
      await this.#effectBroker.execute({
        tenantId: instance.tenantId,
        projectId: instance.projectId,
        cloudProjectId: instance.cloudProjectId,
        runtimeInstanceId: instance.runtimeInstanceId,
        releaseDigest,
        featureId: installation.featureId,
        featureInstallationId: installation.featureInstallationId,
        featureRevisionDigest,
        declarationDigest: installation.declarationDigest,
        jobId,
        declarationId: jobDeclaration.jobId,
        networkDeclarationId: jobDeclaration.networkDeclarationId,
        connectionDeclarationId: jobDeclaration.connectionDeclarationId,
        connectionId: connection.connectionId,
        targetIdentity: connection.targetIdentity,
        owner: connection.owner,
        authKind: connection.authKind,
        origin: connection.origin,
        secretRef: connection.secretRef,
        acceptedAuthority: authority,
        acceptedAt,
        scheduleId,
        leaseId,
        occurrenceId,
        runId,
        attemptId,
        claimOperationId: operationId,
        idempotencyKey,
        authorizeEffect: () => this.#authorizeJobEffect({
          runtimeInstanceId: instance.runtimeInstanceId,
          featureInstallationId: installation.featureInstallationId,
          featureId: installation.featureId,
          jobId,
          connectionId: connection.connectionId,
          principalId: principal.principalId,
          authority,
          scheduleId,
          leaseId,
          occurrenceId,
          runId,
          attemptId,
          claimOperationId: operationId,
        }),
      });
    } catch (error) {
      effectError = error;
    }
    if (effectError !== undefined) {
      const failure = toRuntimeFailure(effectError);
      const terminalCheckpoint = this.#checkpoint();
      const receipt = this.#appendJobReceipt({
        instance,
        installation,
        principal,
        authority,
        acceptedAt,
        state: "failed",
        runId,
        attemptId,
        occurrenceId,
        releaseDigest,
        featureRevisionDigest,
        jobId,
        declarationId: jobDeclaration.jobId,
        networkDeclarationId: jobDeclaration.networkDeclarationId,
        connectionDeclarationId: jobDeclaration.connectionDeclarationId,
        connectionId: connection.connectionId,
        scheduleId,
        leaseId,
        claimOperationId: operationId,
        parentReceiptId: accepted.receiptId,
        error: failure,
      });
      this.#queueLeaseCompletion(instance.runtimeInstanceId, leaseId, "failed");
      this.#commitOrRestore(terminalCheckpoint);
      this.#retryLeaseCompletions();
      if (effectError instanceof HostedAppPlatformError) {
        throw new HostedAppPlatformError(effectError.code, effectError.message, { retryable: effectError.runtimeError.retryable, receiptId: receipt.receiptId });
      }
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The hosted connection effect failed.", {
        retryable: true,
        receiptId: receipt.receiptId,
      });
    }
    const terminalCheckpoint = this.#checkpoint();
    const receipt = this.#appendJobReceipt({
      instance,
      installation,
      principal,
      authority,
      acceptedAt,
      state: "succeeded",
      runId,
      attemptId,
      occurrenceId,
      releaseDigest,
      featureRevisionDigest,
      jobId,
      declarationId: jobDeclaration.jobId,
      networkDeclarationId: jobDeclaration.networkDeclarationId,
      connectionDeclarationId: jobDeclaration.connectionDeclarationId,
      connectionId: connection.connectionId,
      scheduleId,
      leaseId,
      claimOperationId: operationId,
      parentReceiptId: accepted.receiptId,
    });
    this.#queueLeaseCompletion(instance.runtimeInstanceId, leaseId, "succeeded");
    this.#commitOrRestore(terminalCheckpoint);
    this.#retryLeaseCompletions();
    return receipt;
  }

  revokeNetwork(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    featureId: string;
    declarationId: string;
  }>): HostedInstanceView {
    const record = exactInput(input, ["authentication", "runtimeInstanceId", "featureId", "declarationId"], "Revoke network input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#instance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "admin");
    this.#requireMutableInstance(instance);
    const installation = this.#installation(instance, stableId(record.featureId, "featureId"));
    const declarationId = stableId(record.declarationId, "declarationId");
    if (!installation.networkGrants.has(declarationId)) throw notFound("The network grant was not found.");
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 1);
    const checkpoint = this.#checkpoint();
    const now = this.#timestamp();
    installation.networkGrants.delete(declarationId);
    const removedConnections = [...installation.connections.values()]
      .filter((item) => item.networkDeclarationId === declarationId);
    for (const connection of removedConnections) installation.connections.delete(connection.connectionId);
    const declaration = this.#declaration(instance, installation.featureId);
    const scheduleIds: string[] = [];
    for (const job of installation.jobs.values()) {
      const jobDeclaration = declaration.jobs.find((item) => item.jobId === job.jobId);
      if (jobDeclaration?.networkDeclarationId === declarationId) {
        job.enabled = false;
        if (job.scheduleId) scheduleIds.push(job.scheduleId);
        delete job.scheduleId;
      }
    }
    installation.authority = advanceFields(installation.authority, ["grantGeneration", "connectionGeneration", "jobGeneration"]);
    this.#appendInstallationReceipt("network-revoked", principal, now, instance, installation, { declarationId });
    for (const connection of removedConnections) this.#queueSecretCleanup(instance.runtimeInstanceId, connection.secretRef);
    for (const scheduleId of scheduleIds) this.#queueScheduleCleanup(instance.runtimeInstanceId, scheduleId);
    this.#commitOrRestore(checkpoint);
    this.#retrySecretCleanup();
    this.#retryScheduleCleanup();
    return instanceView(instance);
  }

  reviewReleaseUpdate(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    toReleaseDigest: string;
  }>): HostedUpdateReview {
    const record = exactInput(input, ["authentication", "runtimeInstanceId", "toReleaseDigest"], "Review update input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#activeInstance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "admin");
    const toReleaseDigest = digest(record.toReleaseDigest, "toReleaseDigest");
    if (toReleaseDigest === instance.releaseDigest) throw conflict("The instance already runs this Release.");
    const target = this.#publishedRelease(toReleaseDigest);
    if (target.release.manifest.projectId !== instance.projectId) throw new HostedAppPlatformError("RESOURCE_DENIED", "An instance cannot change App Project lineage.");
    const outstanding = [...this.#updateReviews.values()].find((review) => review.runtimeInstanceId === instance.runtimeInstanceId);
    if (outstanding && outstanding.toReleaseDigest === toReleaseDigest
      && outstanding.fromReleaseDigest === instance.releaseDigest
      && [...instance.installations.values()].every((installation) => {
        const captured = outstanding.capturedAuthorities.get(installation.featureId);
        return captured !== undefined && authorityStampsEqual(captured, installation.authority);
      })) {
      throw conflict("This App Instance already has an outstanding current reviewed update.");
    }
    const decisions = this.#computeUpdateDecisions(instance, target);
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 1);
    const checkpoint = this.#checkpoint();
    const updateId = `update_${randomUUID()}`;
    const reviewedAt = this.#timestamp();
    const capturedAuthorities = new Map<string, Readonly<AuthorityStamp>>();
    for (const installation of instance.installations.values()) {
      capturedAuthorities.set(installation.featureId, parseAuthorityStamp(installation.authority));
    }
    const review: StoredUpdateReview = {
      updateId,
      runtimeInstanceId: instance.runtimeInstanceId,
      fromReleaseDigest: instance.releaseDigest,
      toReleaseDigest,
      reviewedBy: principal,
      reviewedAt,
      capturedAuthorities,
      decisions,
    };
    this.#deleteUpdateReviewsForInstance(instance.runtimeInstanceId);
    this.#updateReviews.set(updateId, review);
    this.#appendManagementReceipt("update-reviewed", principal, reviewedAt, {
      projectId: instance.projectId,
      tenantId: instance.tenantId,
      runtimeInstanceId: instance.runtimeInstanceId,
      releaseDigest: toReleaseDigest,
      predecessorReleaseDigest: instance.releaseDigest,
      updateId,
    });
    this.#commitOrRestore(checkpoint);
    return publicUpdateReview(review);
  }

  activateReviewedUpdate(input: Readonly<{ authentication: string; updateId: string }>): HostedInstanceView {
    const record = exactInput(input, ["authentication", "updateId"], "Activate update input");
    const principal = this.#authenticate(record.authentication);
    const updateId = parsePrefixedId(record.updateId, updateIdPattern, "updateId");
    const review = this.#updateReviews.get(updateId);
    if (!review) throw notFound("The reviewed update was not found.");
    const instance = this.#activeInstance(review.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "admin");
    if (instance.releaseDigest !== review.fromReleaseDigest) throw stale("The instance Release changed after update review.");
    for (const installation of instance.installations.values()) {
      const captured = review.capturedAuthorities.get(installation.featureId);
      if (!captured || !authorityStampsEqual(captured, installation.authority)) {
        throw stale("Instance authority changed after update review; review the transition again.");
      }
    }
    const target = this.#publishedRelease(review.toReleaseDigest);
    const current = this.#publishedRelease(instance.releaseDigest);
    this.#assertReceiptCapacity(instance.runtimeInstanceId, instance.installations.size);
    const checkpoint = this.#checkpoint();
    const now = this.#timestamp();
    const currentById = new Map(current.release.manifest.features.map((feature) => [feature.featureId, feature]));
    const targetById = new Map(target.release.manifest.features.map((feature) => [feature.featureId, feature]));
    const runtimeGeneration = createAuthorityGeneration();
    const secretsToDestroy: string[] = [];
    const schedulesToDisable: string[] = [];
    for (const installation of instance.installations.values()) {
      const oldFeature = currentById.get(installation.featureId)!;
      const newFeature = targetById.get(installation.featureId)!;
      const unchanged = sameFeatureAuthoritySurface(oldFeature, newFeature);
      if (!unchanged) {
        for (const connection of installation.connections.values()) secretsToDestroy.push(connection.secretRef);
        for (const job of installation.jobs.values()) if (job.scheduleId) schedulesToDisable.push(job.scheduleId);
        installation.networkGrants.clear();
        installation.connections.clear();
        for (const job of installation.jobs.values()) job.enabled = false;
        installation.featureRevisionDigest = newFeature.featureRevision.digest;
        installation.declarationDigest = newFeature.declaration.digest;
        installation.dataSchemaIdentity = dataSchemaIdentity(newFeature);
        const nextDeclaration = target.declarations.get(installation.featureId)!;
        installation.jobs.clear();
        for (const job of nextDeclaration.jobs) installation.jobs.set(job.jobId, { jobId: job.jobId, enabled: false });
        installation.authority = advanceFields(installation.authority, [
          "featureInstallationGeneration",
          "grantGeneration",
          "connectionGeneration",
          "jobGeneration",
        ], runtimeGeneration);
      } else {
        installation.authority = withRuntimeGeneration(installation.authority, runtimeGeneration);
      }
    }
    instance.releaseDigest = review.toReleaseDigest;
    this.#deleteUpdateReviewsForInstance(instance.runtimeInstanceId);
    for (const installation of instance.installations.values()) {
      this.#appendInstallationReceipt("update-activated", principal, now, instance, installation, {
        predecessorReleaseDigest: review.fromReleaseDigest,
        updateId,
      });
    }
    for (const secretRef of secretsToDestroy) this.#queueSecretCleanup(instance.runtimeInstanceId, secretRef);
    for (const scheduleId of schedulesToDisable) this.#queueScheduleCleanup(instance.runtimeInstanceId, scheduleId);
    this.#commitOrRestore(checkpoint);
    this.#retrySecretCleanup();
    this.#retryScheduleCleanup();
    return instanceView(instance);
  }

  suspendInstance(input: Readonly<{ authentication: string; runtimeInstanceId: string }>): HostedInstanceView {
    return this.#setSuspended(input, true);
  }

  resumeInstance(input: Readonly<{ authentication: string; runtimeInstanceId: string }>): HostedInstanceView {
    return this.#setSuspended(input, false);
  }

  revokePrincipalAccess(input: Readonly<{
    authentication: string;
    tenantId: string;
    principalId: string;
  }>): void {
    const record = exactInput(input, ["authentication", "tenantId", "principalId"], "Revoke Principal input");
    const principal = this.#authenticate(record.authentication);
    const tenantId = tenant(record.tenantId);
    const revokedPrincipalId = actorId(record.principalId);
    this.#requireTenantRole(tenantId, principal.principalId, "owner");
    if (principal.principalId === revokedPrincipalId) throw conflict("A Tenant owner cannot revoke their own current access through this operation.");
    const tenantRoles = this.#tenantRoles.get(tenantId);
    if (!tenantRoles?.has(revokedPrincipalId)) throw notFound("The Principal has no role in this Tenant.");
    const affectedInstances = [...this.#instances.values()].filter((instance) => instance.tenantId === tenantId);
    this.#assertReceiptCapacity(undefined, affectedInstances.length);
    for (const instance of affectedInstances) this.#assertReceiptCapacity(instance.runtimeInstanceId, 1);
    const checkpoint = this.#checkpoint();
    this.#revokedTenantPrincipals.add(`${tenantId}\u0000${revokedPrincipalId}`);
    const now = this.#timestamp();
    for (const instance of this.#instances.values()) {
      if (instance.tenantId !== tenantId) continue;
      for (const installation of instance.installations.values()) {
        installation.authority = advanceFields(installation.authority, ["principalGeneration"]);
      }
      this.#appendManagementReceipt("principal-revoked", principal, now, {
        projectId: instance.projectId,
        tenantId,
        runtimeInstanceId: instance.runtimeInstanceId,
        releaseDigest: instance.releaseDigest,
        affectedPrincipalId: revokedPrincipalId,
      });
    }
    this.#commitOrRestore(checkpoint);
  }

  assignInstanceRole(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    principalId: string;
    roleId: string;
  }>): HostedInstanceView {
    return this.#setInstanceRole(input, true);
  }

  removeInstanceRole(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    principalId: string;
    roleId: string;
  }>): HostedInstanceView {
    return this.#setInstanceRole(input, false);
  }

  listCollection(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    featureId: string;
    collectionId: string;
  }>): readonly HostedDataRecordView[] {
    const record = exactInput(input, ["authentication", "runtimeInstanceId", "featureId", "collectionId"], "List collection input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#activeInstance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "member");
    const installation = this.#installation(instance, stableId(record.featureId, "featureId"));
    const collectionId = stableId(record.collectionId, "collectionId");
    const { collection, partitionId } = this.#authorizeCollection(instance, installation, principal, collectionId, "list");
    const partition = collection.partitions.get(partitionId);
    return deepFreeze([...(partition?.values() ?? [])]
      .sort((left, right) => left.recordId.localeCompare(right.recordId))
      .map(({ recordId, revision, value, updatedAt }) => ({
        recordId,
        revision,
        value: cloneJson(value),
        updatedAt,
      })));
  }

  readRecord(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    featureId: string;
    collectionId: string;
    recordId: string;
  }>): HostedDataRecordView {
    const record = exactInput(input, ["authentication", "runtimeInstanceId", "featureId", "collectionId", "recordId"], "Read data record input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#activeInstance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "member");
    const installation = this.#installation(instance, stableId(record.featureId, "featureId"));
    const collectionId = stableId(record.collectionId, "collectionId");
    const recordId = stableId(record.recordId, "recordId");
    const { collection, partitionId } = this.#authorizeCollection(instance, installation, principal, collectionId, "read");
    const item = collection.partitions.get(partitionId)?.get(recordId);
    if (!item) throw notFound("The data record was not found in the effective Principal's partition.");
    return deepFreeze({ recordId, revision: item.revision, value: cloneJson(item.value), updatedAt: item.updatedAt });
  }

  prepareDataMutation(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    featureId: string;
    collectionId: string;
    action: "create" | "update" | "delete";
    recordId: string;
    expectedRevision: number | null;
    value?: unknown;
  }>): HostedPreparedDataMutation {
    const expectedKeys = input?.action === "delete"
      ? ["authentication", "runtimeInstanceId", "featureId", "collectionId", "action", "recordId", "expectedRevision"]
      : ["authentication", "runtimeInstanceId", "featureId", "collectionId", "action", "recordId", "expectedRevision", "value"];
    const record = exactInput(input, expectedKeys, "Prepare data mutation input");
    if (record.action !== "create" && record.action !== "update" && record.action !== "delete") {
      throw invalid("Data mutation action must be create, update, or delete.");
    }
    const principal = this.#authenticate(record.authentication);
    const instance = this.#activeInstance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "member");
    const installation = this.#installation(instance, stableId(record.featureId, "featureId"));
    const collectionId = stableId(record.collectionId, "collectionId");
    const action = record.action;
    const { partitionId } = this.#authorizeCollection(instance, installation, principal, collectionId, action);
    const recordId = stableId(record.recordId, "recordId");
    const expectedRevision = parseExpectedRevision(record.expectedRevision, action);
    const value = action === "delete" ? undefined : boundedJson(record.value, "data mutation value");
    const mutationId = `mutation_${randomUUID()}`;
    const checkpoint = this.#checkpoint();
    const preparedAt = this.#timestamp();
    const preparedAtMs = Date.parse(preparedAt);
    this.#expirePendingDataMutations(preparedAtMs);
    const principalPending = [...this.#pendingDataMutations.values()].filter((item) =>
      item.runtimeInstanceId === instance.runtimeInstanceId && item.principal.principalId === principal.principalId).length;
    const instancePending = [...this.#pendingDataMutations.values()].filter((item) =>
      item.runtimeInstanceId === instance.runtimeInstanceId).length;
    if (principalPending >= maximumPendingMutationsPerPrincipal || instancePending >= maximumPendingMutationsPerInstance) {
      this.#restoreDurableState(checkpoint);
      throw quota("The pending data mutation quota has been reached for this Principal or App Instance.");
    }
    const authority = parseAuthorityStamp(installation.authority);
    this.#pendingDataMutations.set(mutationId, {
      mutationId,
      runtimeInstanceId: instance.runtimeInstanceId,
      featureId: installation.featureId,
      featureInstallationId: installation.featureInstallationId,
      collectionId,
      partitionId,
      action,
      recordId,
      expectedRevision,
      ...(value === undefined ? {} : { value }),
      principal,
      authority,
      preparedAt,
      expiresAt: new Date(preparedAtMs + pendingMutationTtlMs).toISOString(),
    });
    this.#commitOrRestore(checkpoint);
    return deepFreeze({
      mutationId,
      runtimeInstanceId: instance.runtimeInstanceId,
      featureInstallationId: installation.featureInstallationId,
      collectionId,
      recordId,
      dataAction: action,
      authority,
      preparedAt,
    });
  }

  commitDataMutation(input: Readonly<{
    authentication: string;
    mutationId: string;
  }>): Readonly<HostedDataReceipt> {
    const record = exactInput(input, ["authentication", "mutationId"], "Commit data mutation input");
    const principal = this.#authenticate(record.authentication);
    const mutationId = parseMutationId(record.mutationId);
    const mutation = this.#pendingDataMutations.get(mutationId);
    if (!mutation) throw notFound("The prepared data mutation was not found.");
    if (mutation.principal.principalId !== principal.principalId) {
      throw new HostedAppPlatformError("RESOURCE_DENIED", "A prepared data mutation belongs to its effective Principal.");
    }
    if (Date.parse(this.#timestamp()) >= Date.parse(mutation.expiresAt)) {
      const expiredCheckpoint = this.#checkpoint();
      this.#pendingDataMutations.delete(mutationId);
      this.#commitOrRestore(expiredCheckpoint);
      throw new HostedAppPlatformError("AUTHORITY_EXPIRED", "The prepared data mutation expired before commit.");
    }
    const instance = this.#instances.get(mutation.runtimeInstanceId);
    if (!instance || instance.status !== "active") throw stale("The App Instance changed before data commit.");
    const installation = instance.installations.get(mutation.featureId);
    if (!installation || installation.featureInstallationId !== mutation.featureInstallationId
      || !authorityStampsEqual(installation.authority, mutation.authority)) {
      throw stale("Data authority changed after the operation was prepared.");
    }
    const { collection, partitionId } = this.#authorizeCollection(
      instance,
      installation,
      principal,
      mutation.collectionId,
      mutation.action,
    );
    if (partitionId !== mutation.partitionId) throw stale("The data owner partition changed before commit.");
    const existingPartition = collection.partitions.get(partitionId);
    const current = existingPartition?.get(mutation.recordId);
    if (mutation.action === "create" ? current !== undefined : current?.revision !== mutation.expectedRevision) {
      throw conflict("The data record revision changed before commit.");
    }
    if (mutation.action === "create" && ((existingPartition?.size ?? 0) >= maximumRecordsPerPartition
      || this.#countInstanceRecords(instance) >= maximumRecordsPerInstance)) {
      throw quota("The hosted data record quota has been reached for this partition or App Instance.");
    }
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 1);
    const checkpoint = this.#checkpoint();
    const partition = existingPartition ?? mapValue(collection.partitions, partitionId, () => new Map());
    const now = this.#timestamp();
    let recordRevision: number;
    if (mutation.action === "delete") {
      recordRevision = current!.revision + 1;
      partition.delete(mutation.recordId);
    } else if (mutation.action === "create") {
      recordRevision = 1;
      partition.set(mutation.recordId, {
        recordId: mutation.recordId,
        revision: recordRevision,
        value: cloneJson(mutation.value),
        updatedAt: now,
        updatedBy: principal.principalId,
      });
    } else {
      recordRevision = current!.revision + 1;
      current!.revision = recordRevision;
      current!.value = cloneJson(mutation.value);
      current!.updatedAt = now;
      current!.updatedBy = principal.principalId;
    }
    installation.authority = advanceFields(installation.authority, ["dataGeneration"]);
    this.#pendingDataMutations.delete(mutationId);
    const receipt: HostedDataReceipt = deepFreeze({
      receiptId: `receipt_${randomUUID()}`,
      kind: "resource-mutation",
      tenantId: instance.tenantId,
      runtimeInstanceId: instance.runtimeInstanceId,
      featureInstallationId: installation.featureInstallationId,
      dataNamespaceId: installation.dataNamespaceId,
      featureRevisionDigest: installation.featureRevisionDigest,
      effectivePrincipal: principal,
      authority: parseAuthorityStamp(mutation.authority),
      acceptedAt: mutation.preparedAt,
      startedAt: mutation.preparedAt,
      finishedAt: now,
      state: "succeeded",
      collectionId: mutation.collectionId,
      recordId: mutation.recordId,
      dataAction: mutation.action,
      recordRevision,
    });
    this.#dataReceipts.push(receipt);
    this.#commitOrRestore(checkpoint);
    return receipt;
  }

  exportPrincipalData(input: Readonly<{ authentication: string; runtimeInstanceId: string }>): HostedPrincipalDataExport {
    const record = exactInput(input, ["authentication", "runtimeInstanceId"], "Export Principal data input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#instance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "member");
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 1);
    const checkpoint = this.#checkpoint();
    const generatedAt = this.#timestamp();
    const data: HostedPrincipalDataExport["data"][number][] = [];
    for (const installation of [...instance.installations.values()].sort((left, right) => left.featureId.localeCompare(right.featureId))) {
      for (const collection of [...installation.dataCollections.values()]
        .filter((item) => item.ownerClass === "principal")
        .sort((left, right) => left.collectionId.localeCompare(right.collectionId))) {
        const partition = collection.partitions.get(principal.principalId);
        data.push({
          featureId: installation.featureId,
          collectionId: collection.collectionId,
          records: [...(partition?.values() ?? [])]
            .sort((left, right) => left.recordId.localeCompare(right.recordId))
            .map(({ recordId, revision, value, updatedAt }) => ({ recordId, revision, value: cloneJson(value), updatedAt })),
        });
      }
    }
    this.#appendManagementReceipt("principal-data-exported", principal, generatedAt, {
      projectId: instance.projectId,
      tenantId: instance.tenantId,
      runtimeInstanceId: instance.runtimeInstanceId,
      releaseDigest: instance.releaseDigest,
      affectedPrincipalId: principal.principalId,
    });
    this.#commitOrRestore(checkpoint);
    return deepFreeze({
      format: "work-fold.hosted-principal-data-export",
      formatVersion: 1,
      generatedAt,
      tenantId: instance.tenantId,
      runtimeInstanceId: instance.runtimeInstanceId,
      principalId: principal.principalId,
      data,
      secretsIncluded: false,
    });
  }

  exportInstance(input: Readonly<{ authentication: string; runtimeInstanceId: string }>): HostedInstanceExport {
    const record = exactInput(input, ["authentication", "runtimeInstanceId"], "Export instance input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#instance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "admin");
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 1);
    const checkpoint = this.#checkpoint();
    const generatedAt = this.#timestamp();
    this.#appendManagementReceipt("instance-exported", principal, generatedAt, {
      projectId: instance.projectId,
      tenantId: instance.tenantId,
      runtimeInstanceId: instance.runtimeInstanceId,
      releaseDigest: instance.releaseDigest,
    });
    this.#commitOrRestore(checkpoint);
    const receipts = this.#receiptsForInstance(instance.runtimeInstanceId);
    const data = exportHostedData(instance, principal.principalId);
    return deepFreeze({
      format: "work-fold.hosted-instance-export",
      formatVersion: 1,
      generatedAt,
      instance: instanceView(instance),
      receipts,
      data,
      completeness: {
        secretsIncluded: false,
        projectSourceIncluded: false,
        immutableReleaseIncluded: false,
        principalPrivateContents: "requester-only",
        receiptsCompleteThrough: generatedAt,
      },
    });
  }

  deleteInstance(input: Readonly<{ authentication: string; runtimeInstanceId: string }>): HostedInstanceView {
    const record = exactInput(input, ["authentication", "runtimeInstanceId"], "Delete instance input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#instance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "owner");
    if (instance.status === "delete-pending" || instance.status === "purged") throw conflict("Instance deletion is already pending or complete.");
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 0);
    const priorMarker = this.#readRevocation(instance.runtimeInstanceId);
    const now = priorMarker?.tombstonedAt ?? this.#timestamp();
    const revocationId = priorMarker?.revocationId ?? `revocation_${randomUUID()}`;
    const marker: HostedInstanceRevocationMarker = {
      revocationId,
      tenantId: instance.tenantId,
      projectId: instance.projectId,
      cloudProjectId: instance.cloudProjectId,
      runtimeInstanceId: instance.runtimeInstanceId,
      tombstonedAt: now,
      effectivePrincipal: priorMarker?.effectivePrincipal ?? principal,
      deleteReceipts: [...instance.installations.values()].map((installation) => ({
        featureInstallationId: installation.featureInstallationId,
        receiptId: `receipt_${randomUUID()}`,
      })),
      phase: "delete-pending",
    };
    const reservationCheckpoint = this.#checkpoint();
    this.#pendingInstanceTransitions.set(instance.runtimeInstanceId, { runtimeInstanceId: instance.runtimeInstanceId, marker });
    this.#commitOrRestore(reservationCheckpoint);
    const reservedCheckpoint = this.#checkpoint();
    this.#applyHighWaterDeletion(instance, marker);
    this.#pendingInstanceTransitions.delete(instance.runtimeInstanceId);
    try {
      this.#revocationHighWater.raise(marker);
    } catch (error) {
      this.#restoreDurableState(reservedCheckpoint);
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", `The non-rollbackable instance revocation could not be raised: ${message(error)}`, { retryable: true });
    }
    this.#commitOrRestore(reservedCheckpoint);
    this.#retrySecretCleanup();
    this.#retryScheduleCleanup();
    return instanceView(instance);
  }

  purgeInstance(input: Readonly<{ authentication: string; runtimeInstanceId: string }>): HostedInstanceView {
    const record = exactInput(input, ["authentication", "runtimeInstanceId"], "Purge instance input");
    const principal = this.#authenticate(record.authentication);
    let instance = this.#instance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "owner");
    if (instance.status !== "delete-pending") throw conflict("Only a delete-pending instance can be purged.");
    const marker = this.#readRevocation(instance.runtimeInstanceId);
    if (!marker || marker.revocationId !== instance.revocationId || marker.tombstonedAt !== instance.deletedAt
      || marker.tenantId !== instance.tenantId || marker.projectId !== instance.projectId
      || marker.cloudProjectId !== instance.cloudProjectId || marker.phase !== "delete-pending") {
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The durable instance revocation high-water is missing or does not match deletion state.", { retryable: true });
    }
    this.#retrySecretCleanup();
    this.#retryScheduleCleanup();
    this.#retryLeaseCompletions();
    this.#retryExternalAllocations();
    this.#retryPendingJobClaims();
    this.#retryUnresolvedAcceptedReceipts();
    this.#refreshDurableState();
    instance = this.#instance(record.runtimeInstanceId);
    if (instance.status !== "delete-pending") throw conflict("Only a delete-pending instance can be purged.");
    if (this.#hasInstanceCleanup(instance.runtimeInstanceId)) {
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", "Instance-owned secret, schedule, or lease cleanup is still pending.", { retryable: true });
    }
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 0);
    const now = this.#timestamp();
    const purgeMarker: HostedInstanceRevocationMarker = {
      ...marker,
      phase: "purged",
      purgedAt: now,
      purgedBy: principal,
      purgeReceipts: [...instance.installations.values()].map((installation) => ({
        featureInstallationId: installation.featureInstallationId,
        receiptId: `receipt_${randomUUID()}`,
      })),
    };
    const reservationCheckpoint = this.#checkpoint();
    this.#pendingInstanceTransitions.set(instance.runtimeInstanceId, { runtimeInstanceId: instance.runtimeInstanceId, marker: purgeMarker });
    this.#commitOrRestore(reservationCheckpoint);
    const reservedCheckpoint = this.#checkpoint();
    this.#applyHighWaterPurge(instance, purgeMarker);
    this.#pendingInstanceTransitions.delete(instance.runtimeInstanceId);
    try {
      this.#revocationHighWater.raise(purgeMarker);
    } catch (error) {
      this.#restoreDurableState(reservedCheckpoint);
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", `The non-rollbackable purge revocation could not be raised: ${message(error)}`, { retryable: true });
    }
    this.#commitOrRestore(reservedCheckpoint);
    return instanceView(instance);
  }

  listReceipts(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
  }>): readonly (HostedManagementReceipt | HostedJobReceipt | HostedDataReceipt)[] {
    const record = exactInput(input, ["authentication", "runtimeInstanceId"], "List receipts input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#instance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "admin");
    return this.#receiptsForInstance(instance.runtimeInstanceId);
  }

  #receiptsForInstance(
    runtimeInstanceId: RuntimeInstanceId,
  ): readonly (HostedManagementReceipt | HostedJobReceipt | HostedDataReceipt)[] {
    return deepFreeze([
      ...this.#managementReceipts.filter((receipt) => receipt.runtimeInstanceId === runtimeInstanceId),
      ...this.#runtimeReceipts.filter((receipt) => receipt.runtimeInstanceId === runtimeInstanceId),
      ...this.#dataReceipts.filter((receipt) => receipt.runtimeInstanceId === runtimeInstanceId),
    ].sort((left, right) => receiptEventAt(left).localeCompare(receiptEventAt(right)) || receiptLineageOrder(left, right)));
  }

  #setSuspended(input: Readonly<{ authentication: string; runtimeInstanceId: string }>, suspend: boolean): HostedInstanceView {
    const record = exactInput(input, ["authentication", "runtimeInstanceId"], suspend ? "Suspend instance input" : "Resume instance input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#instance(record.runtimeInstanceId);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "admin");
    if (instance.status === "delete-pending" || instance.status === "purged") throw conflict("A deleted or purged instance cannot change suspension state.");
    if (suspend ? instance.status === "suspended" : instance.status === "active") {
      throw conflict(suspend ? "The instance is already suspended." : "The instance is already active.");
    }
    this.#assertReceiptCapacity(instance.runtimeInstanceId, 1);
    const checkpoint = this.#checkpoint();
    const now = this.#timestamp();
    instance.status = suspend ? "suspended" : "active";
    if (suspend) this.#deleteUpdateReviewsForInstance(instance.runtimeInstanceId);
    const runtimeGeneration = createAuthorityGeneration();
    for (const installation of instance.installations.values()) {
      installation.authority = withRuntimeGeneration(installation.authority, runtimeGeneration);
    }
    this.#appendManagementReceipt(suspend ? "instance-suspended" : "instance-resumed", principal, now, {
      projectId: instance.projectId,
      tenantId: instance.tenantId,
      runtimeInstanceId: instance.runtimeInstanceId,
      releaseDigest: instance.releaseDigest,
    });
    this.#commitOrRestore(checkpoint);
    return instanceView(instance);
  }

  #setInstanceRole(input: Readonly<{
    authentication: string;
    runtimeInstanceId: string;
    principalId: string;
    roleId: string;
  }>, assign: boolean): HostedInstanceView {
    const record = exactInput(input, ["authentication", "runtimeInstanceId", "principalId", "roleId"], assign ? "Assign instance role input" : "Remove instance role input");
    const principal = this.#authenticate(record.authentication);
    const instance = this.#instance(record.runtimeInstanceId);
    this.#requireMutableInstance(instance);
    this.#requireTenantRole(instance.tenantId, principal.principalId, "admin");
    const affectedPrincipalId = actorId(record.principalId);
    this.#requireTenantRole(instance.tenantId, affectedPrincipalId, "member");
    const roleId = stableId(record.roleId, "roleId");
    const existingRoles = instance.instanceRoles.get(affectedPrincipalId);
    if (assign ? existingRoles?.has(roleId) : !existingRoles?.has(roleId)) {
      throw conflict(assign ? "The Principal already has this instance role." : "The Principal does not have this instance role.");
    }
    this.#assertReceiptCapacity(instance.runtimeInstanceId, instance.installations.size);
    const checkpoint = this.#checkpoint();
    const roles = mapValue(instance.instanceRoles, affectedPrincipalId, () => new Set());
    if (assign) roles.add(roleId);
    else {
      roles.delete(roleId);
      if (roles.size === 0) instance.instanceRoles.delete(affectedPrincipalId);
    }
    const runtimeGeneration = createAuthorityGeneration();
    const now = this.#timestamp();
    for (const installation of instance.installations.values()) {
      installation.authority = advanceFields(installation.authority, ["principalGeneration"], runtimeGeneration);
      this.#appendInstallationReceipt(assign ? "instance-role-assigned" : "instance-role-removed", principal, now, instance, installation, {
        roleId,
        affectedPrincipalId,
      });
    }
    this.#commitOrRestore(checkpoint);
    return instanceView(instance);
  }

  #authorizeCollection(
    instance: HostedInstance,
    installation: HostedFeatureInstallation,
    principal: EffectivePrincipal,
    collectionId: string,
    action: HostedDataAction,
  ): Readonly<{ collection: HostedDataCollection; partitionId: string }> {
    const declaration = this.#declaration(instance, installation.featureId).collections
      .find((item) => item.collectionId === collectionId);
    const collection = installation.dataCollections.get(collectionId);
    if (!declaration || !collection || declaration.ownerClass !== collection.ownerClass) {
      throw new HostedAppPlatformError("RESOURCE_DENIED", "The reviewed Feature does not declare this data collection.");
    }
    if (!declaration.allowedActions.includes(action)) {
      throw new HostedAppPlatformError("RESOURCE_DENIED", `The reviewed collection does not allow ${action}.`);
    }
    if (declaration.ownerClass === "principal") return { collection, partitionId: principal.principalId };
    if (declaration.ownerClass === "role") {
      const roles = instance.instanceRoles.get(principal.principalId);
      if (!roles || !declaration.allowedRoles.some((role) => roles.has(role))) {
        throw new HostedAppPlatformError("RESOURCE_DENIED", "The effective Principal lacks a declared collection role.");
      }
      return { collection, partitionId: "role" };
    }
    return { collection, partitionId: "instance" };
  }

  #requireMutableInstance(instance: HostedInstance): void {
    this.#assertNotRevoked(instance);
    if (instance.status === "delete-pending" || instance.status === "purged") {
      throw conflict("A deleted or purged App Instance cannot mutate runtime policy.");
    }
  }

  #authorizeJobEffect(input: Readonly<{
    runtimeInstanceId: RuntimeInstanceId;
    featureInstallationId: FeatureInstallationId;
    featureId: string;
    jobId: string;
    connectionId: string;
    principalId: PrincipalId;
    authority: Readonly<AuthorityStamp>;
    scheduleId: string;
    leaseId: string;
    occurrenceId: string;
    runId: string;
    attemptId: string;
    claimOperationId: string;
  }>): void {
    this.#refreshDurableState();
    if (this.#pendingInstanceTransitions.has(input.runtimeInstanceId)) {
      throw stale("The hosted instance has an accepted deletion or purge transition.");
    }
    const instance = this.#instances.get(input.runtimeInstanceId);
    if (!instance || instance.status !== "active") throw stale("The hosted instance is no longer active.");
    this.#assertNotRevoked(instance);
    if (!this.#hasTenantRole(instance.tenantId, input.principalId, "member")) throw stale("The effective Principal no longer has instance access.");
    const installation = instance.installations.get(input.featureId);
    if (!installation || installation.featureInstallationId !== input.featureInstallationId) throw stale("The Feature Installation changed.");
    if (!authorityStampsEqual(installation.authority, input.authority)) throw stale("The job's AuthorityStamp is stale.");
    const job = installation.jobs.get(input.jobId);
    if (!job?.enabled || job.scheduleId !== input.scheduleId) throw stale("The named job lease no longer belongs to the enabled schedule.");
    const declaration = this.#declaration(instance, installation.featureId);
    const jobDeclaration = declaration.jobs.find((item) => item.jobId === input.jobId);
    if (!jobDeclaration) throw stale("The named job declaration changed.");
    const connectionDeclaration = declaration.connections.find((item) => item.declarationId === jobDeclaration.connectionDeclarationId);
    const networkDeclaration = declaration.networkDestinations.find((item) => item.declarationId === jobDeclaration.networkDeclarationId);
    if (!connectionDeclaration || !networkDeclaration
      || connectionDeclaration.networkDeclarationId !== jobDeclaration.networkDeclarationId) {
      throw stale("The exact connection declaration changed.");
    }
    const connection = installation.connections.get(input.connectionId);
    if (!connection
      || connection.declarationId !== jobDeclaration.connectionDeclarationId
      || connection.networkDeclarationId !== jobDeclaration.networkDeclarationId
      || connection.authKind !== connectionDeclaration.authKind
      || connection.origin !== networkDeclaration.origin
      || connection.featureRevisionDigest !== installation.featureRevisionDigest
      || connection.declarationDigest !== installation.declarationDigest
      || connection.owner.kind !== "instance"
      || connection.owner.runtimeInstanceId !== instance.runtimeInstanceId
      || connection.targetIdentity !== connection.origin) {
      throw stale("The exact connection binding identity changed.");
    }
    const grant = installation.networkGrants.get(jobDeclaration.networkDeclarationId);
    if (!grant || grant.origin !== connection.origin) throw stale("The network grant changed.");
    try {
      this.#jobCoordinator.validate({
        operationId: input.claimOperationId,
        tenantId: instance.tenantId,
        runtimeInstanceId: instance.runtimeInstanceId,
        featureInstallationId: installation.featureInstallationId,
        jobId: input.jobId,
        authority: input.authority,
        scheduleId: input.scheduleId,
        leaseId: input.leaseId,
        occurrenceId: input.occurrenceId,
        runId: input.runId,
        attemptId: input.attemptId,
      });
    } catch {
      throw stale("The durable job lease is no longer current for this exact attempt.");
    }
  }

  #appendJobReceipt(input: Readonly<{
    instance: HostedInstance;
    installation: HostedFeatureInstallation;
    principal: EffectivePrincipal;
    authority: Readonly<AuthorityStamp>;
    acceptedAt: string;
    state: "accepted" | "succeeded" | "failed" | "cancelled";
    runId: string;
    attemptId: string;
    occurrenceId: string;
    releaseDigest: Sha256Digest;
    featureRevisionDigest: AppPlatformArtifactDigest;
    jobId: string;
    declarationId: string;
    networkDeclarationId: string;
    connectionDeclarationId: string;
    connectionId: string;
    scheduleId: string;
    leaseId: string;
    claimOperationId: string;
    parentReceiptId?: string;
    error?: Readonly<RuntimeError>;
  }>): Readonly<HostedJobReceipt> {
    const finishedAt = input.state === "accepted" ? undefined : this.#timestamp();
    const receipt: HostedJobReceipt = deepFreeze({
      receiptId: `receipt_${randomUUID()}`,
      kind: "job",
      tenantId: input.instance.tenantId,
      runtimeInstanceId: input.instance.runtimeInstanceId,
      featureInstallationId: input.installation.featureInstallationId,
      dataNamespaceId: input.installation.dataNamespaceId,
      releaseDigest: input.releaseDigest,
      featureRevisionDigest: input.featureRevisionDigest,
      jobId: input.jobId,
      declarationId: input.declarationId,
      networkDeclarationId: input.networkDeclarationId,
      connectionDeclarationId: input.connectionDeclarationId,
      connectionId: input.connectionId,
      scheduleId: input.scheduleId,
      leaseId: input.leaseId,
      claimOperationId: input.claimOperationId,
      effectivePrincipal: input.principal,
      authority: parseAuthorityStamp(input.authority),
      acceptedAt: input.acceptedAt,
      ...(finishedAt === undefined ? {} : { startedAt: input.acceptedAt, finishedAt }),
      state: input.state,
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.parentReceiptId === undefined ? {} : { parentReceiptId: input.parentReceiptId }),
      occurrenceId: input.occurrenceId,
      runId: input.runId,
      attemptId: input.attemptId,
    });
    this.#runtimeReceipts.push(receipt);
    return receipt;
  }

  #appendInstallationReceipt(
    action: HostedManagementAction,
    principal: EffectivePrincipal,
    acceptedAt: string,
    instance: HostedInstance,
    installation: HostedFeatureInstallation,
    extra: Readonly<{
      predecessorReleaseDigest?: Sha256Digest;
      declarationId?: string;
      connectionId?: string;
      jobId?: string;
      scheduleId?: string;
      collectionId?: string;
      recordId?: string;
      dataAction?: HostedDataAction;
      updateId?: string;
      roleId?: string;
      affectedPrincipalId?: PrincipalId;
    }> = {},
    receiptId?: string,
  ): void {
    this.#appendManagementReceipt(action, principal, acceptedAt, {
      projectId: instance.projectId,
      tenantId: instance.tenantId,
      runtimeInstanceId: instance.runtimeInstanceId,
      featureInstallationId: installation.featureInstallationId,
      featureId: installation.featureId,
      authority: installation.authority,
      releaseDigest: instance.releaseDigest,
      ...extra,
    }, receiptId);
  }

  #appendManagementReceipt(
    action: HostedManagementAction,
    principal: EffectivePrincipal,
    acceptedAt: string,
    scope: Omit<HostedManagementReceipt, "receiptId" | "kind" | "action" | "effectivePrincipal" | "acceptedAt" | "state">,
    receiptId = `receipt_${randomUUID()}`,
  ): void {
    this.#managementReceipts.push(deepFreeze({
      receiptId,
      kind: "admin-transition",
      action,
      effectivePrincipal: principal,
      acceptedAt,
      state: "succeeded",
      ...scope,
      ...(scope.authority === undefined ? {} : { authority: parseAuthorityStamp(scope.authority) }),
    }));
  }

  #computeUpdateDecisions(instance: HostedInstance, target: RegistryRelease): readonly HostedUpdateFeatureDecision[] {
    const current = this.#publishedRelease(instance.releaseDigest);
    const currentFeatures = current.release.manifest.features;
    const targetFeatures = target.release.manifest.features;
    if (currentFeatures.length !== targetFeatures.length
      || currentFeatures.some((feature, index) => feature.featureId !== targetFeatures[index]?.featureId)) {
      throw conflict("This private hosted slice requires an unchanged Feature set across an update.");
    }
    return deepFreeze(currentFeatures.map((feature, index) => {
      const targetFeature = targetFeatures[index]!;
      if (dataSchemaIdentity(feature) !== dataSchemaIdentity(targetFeature)) {
        throw conflict(`Feature ${feature.featureId} requires a migration; this hosted slice accepts compatible schemas only.`);
      }
      const currentCollections = current.declarations.get(feature.featureId)!.collections;
      const targetCollections = target.declarations.get(feature.featureId)!.collections;
      if (canonicalizeJson(currentCollections) !== canonicalizeJson(targetCollections)) {
        throw conflict(`Feature ${feature.featureId} changes declared data ownership or policy and requires a reviewed migration.`);
      }
      const unchanged = sameFeatureAuthoritySurface(feature, targetFeature);
      return {
        featureId: feature.featureId,
        revision: unchanged ? "unchanged" : "changed",
        grants: unchanged ? "eligible-to-retain" : "reset",
        connections: unchanged ? "eligible-to-retain" : "reset",
        jobs: unchanged ? "eligible-to-retain" : "reset",
        data: "compatible",
      };
    }));
  }

  #requireJobDependencies(installation: HostedFeatureInstallation, declaration: JobDeclaration): InstanceConnection {
    const grant = installation.networkGrants.get(declaration.networkDeclarationId);
    if (!grant) throw new HostedAppPlatformError("NETWORK_DENIED", "The job's exact network destination is not granted.");
    const connection = [...installation.connections.values()]
      .find((item) => item.declarationId === declaration.connectionDeclarationId);
    if (!connection
      || connection.networkDeclarationId !== declaration.networkDeclarationId
      || connection.origin !== grant.origin
      || connection.targetIdentity !== grant.origin
      || connection.featureRevisionDigest !== installation.featureRevisionDigest
      || connection.declarationDigest !== installation.declarationDigest
      || connection.owner.kind !== "instance") {
      throw new HostedAppPlatformError("RESOURCE_DENIED", "The job's instance-owned connection is not active.");
    }
    return connection;
  }

  #declaration(instance: HostedInstance, featureId: string): HostedFeatureDeclaration {
    const release = this.#registry.get(instance.releaseDigest);
    const declaration = release?.declarations.get(featureId);
    if (!declaration) throw new HostedAppPlatformError("REVISION_CHANGED", "The active Feature declaration could not be resolved.");
    return declaration;
  }

  #publishedRelease(releaseDigest: Sha256Digest): RegistryRelease {
    const release = this.#registry.get(releaseDigest);
    if (!release?.publishedAt) throw notFound("The published Release was not found.");
    return release;
  }

  #installation(instance: HostedInstance, featureId: string): HostedFeatureInstallation {
    const installation = instance.installations.get(featureId);
    if (!installation) throw notFound("The Feature Installation was not found.");
    return installation;
  }

  #instance(value: unknown): HostedInstance {
    const runtimeInstanceId = instanceId(value);
    const instance = this.#instances.get(runtimeInstanceId);
    if (!instance) throw notFound("The hosted App Instance was not found.");
    return instance;
  }

  #activeInstance(value: unknown): HostedInstance {
    const instance = this.#instance(value);
    if (instance.status !== "active") throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The hosted App Instance is not active.", { retryable: false });
    this.#assertNotRevoked(instance);
    return instance;
  }

  #authenticate(value: unknown): EffectivePrincipal {
    this.#refreshDurableState();
    this.#recoverPendingInstanceTransitions();
    this.#reconcileRevocationHighWater();
    const authentication = boundedString(value, "authentication", 4_096);
    let resolved: unknown;
    try {
      resolved = this.#authenticator.authenticate(authentication);
    } catch {
      throw new HostedAppPlatformError("AUTHENTICATION_REQUIRED", "Authentication could not be verified.");
    }
    if (resolved === null || resolved === undefined) {
      throw new HostedAppPlatformError("AUTHENTICATION_REQUIRED", "Authentication is required.");
    }
    return parseEffectivePrincipal(resolved);
  }

  #requireProjectRole(projectId: ProjectId, principalId: PrincipalId, required: HostedProjectRole): void {
    const roles = this.#projectRoles.get(projectId)?.get(principalId);
    if (!roles || (!roles.has("owner") && !roles.has(required))) {
      throw new HostedAppPlatformError("RESOURCE_DENIED", `The authenticated Principal lacks the ${required} Project role.`);
    }
  }

  #requireTenantRole(tenantId: TenantId, principalId: PrincipalId, required: HostedTenantRole): void {
    if (!this.#hasTenantRole(tenantId, principalId, required)) {
      throw new HostedAppPlatformError("RESOURCE_DENIED", `The authenticated Principal lacks the required ${required} Tenant role.`);
    }
  }

  #hasTenantRole(tenantId: TenantId, principalId: PrincipalId, required: HostedTenantRole): boolean {
    const roles = this.#tenantRoles.get(tenantId)?.get(principalId);
    if (this.#revokedTenantPrincipals.has(`${tenantId}\u0000${principalId}`)) return false;
    if (!roles) return false;
    if (roles.has("owner")) return true;
    if (required === "member") return roles.has("admin") || roles.has("member");
    return required === "admin" && roles.has("admin");
  }

  #seedProjectRoles(values: readonly HostedRoleSeed["projectRoles"][number][]): void {
    if (!Array.isArray(values)) throw invalid("projectRoles must be an array.");
    for (const [index, item] of values.entries()) {
      const record = exactInput(item, ["projectId", "principalId", "roles"], `projectRoles[${index}]`);
      const projectId = project(record.projectId);
      const principalId = actorId(record.principalId);
      const roles = parseRoleArray(record.roles, ["owner", "reviewer", "publisher"], `projectRoles[${index}].roles`);
      const byPrincipal = mapValue(this.#projectRoles, projectId, () => new Map());
      if (byPrincipal.has(principalId)) throw invalid(`projectRoles duplicates ${projectId}/${principalId}.`);
      byPrincipal.set(principalId, new Set(roles as HostedProjectRole[]));
    }
  }

  #seedTenantRoles(values: readonly HostedRoleSeed["tenantRoles"][number][]): void {
    if (!Array.isArray(values)) throw invalid("tenantRoles must be an array.");
    for (const [index, item] of values.entries()) {
      const record = exactInput(item, ["tenantId", "principalId", "roles"], `tenantRoles[${index}]`);
      const tenantId = tenant(record.tenantId);
      const principalId = actorId(record.principalId);
      const roles = parseRoleArray(record.roles, ["owner", "admin", "member"], `tenantRoles[${index}].roles`);
      const byPrincipal = mapValue(this.#tenantRoles, tenantId, () => new Map());
      if (byPrincipal.has(principalId)) throw invalid(`tenantRoles duplicates ${tenantId}/${principalId}.`);
      byPrincipal.set(principalId, new Set(roles as HostedTenantRole[]));
    }
  }

  #timestamp(): string {
    const value = this.#now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The hosted clock returned an invalid time.");
    return value.toISOString();
  }

  #readRevocation(runtimeInstanceId: RuntimeInstanceId): Readonly<HostedInstanceRevocationMarker> | undefined {
    let value: unknown;
    try { value = this.#revocationHighWater.read(runtimeInstanceId); }
    catch (error) {
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", `The instance revocation high-water could not be read: ${message(error)}`, { retryable: true });
    }
    return value === undefined ? undefined : parseRevocationMarker(value, runtimeInstanceId);
  }

  #deleteUpdateReviewsForInstance(runtimeInstanceId: RuntimeInstanceId): void {
    for (const [updateId, review] of this.#updateReviews) {
      if (review.runtimeInstanceId === runtimeInstanceId) this.#updateReviews.delete(updateId);
    }
  }

  #recoverPendingInstanceTransitions(): void {
    for (const transition of this.#pendingInstanceTransitions.values()) {
      const current = this.#readRevocation(transition.runtimeInstanceId);
      if (current) {
        if (!this.#sameRevocationIdentity(current, transition.marker)) {
          throw new HostedAppPlatformError("HOST_UNAVAILABLE", "A reserved instance transition conflicts with its non-rollbackable high-water.");
        }
        if (current.phase === "purged" && transition.marker.phase === "delete-pending") continue;
        if (current.phase === transition.marker.phase) {
          if (canonicalizeJson(current) !== canonicalizeJson(transition.marker)) {
            throw new HostedAppPlatformError("HOST_UNAVAILABLE", "A reserved instance transition differs from its same-phase high-water.");
          }
          continue;
        }
      }
      try {
        this.#revocationHighWater.raise(transition.marker);
      } catch (error) {
        throw new HostedAppPlatformError("HOST_UNAVAILABLE", `A reserved instance transition could not raise its non-rollbackable high-water: ${message(error)}`, { retryable: true });
      }
    }
  }

  #sameRevocationIdentity(
    left: Readonly<HostedInstanceRevocationMarker>,
    right: Readonly<HostedInstanceRevocationMarker>,
  ): boolean {
    return left.revocationId === right.revocationId
      && left.tenantId === right.tenantId
      && left.projectId === right.projectId
      && left.cloudProjectId === right.cloudProjectId
      && left.runtimeInstanceId === right.runtimeInstanceId
      && left.tombstonedAt === right.tombstonedAt
      && canonicalizeJson(left.effectivePrincipal) === canonicalizeJson(right.effectivePrincipal)
      && canonicalizeJson(left.deleteReceipts) === canonicalizeJson(right.deleteReceipts);
  }

  #reconcileRevocationHighWater(): void {
    for (let attempt = 0; attempt < cleanupMergeAttempts; attempt += 1) {
      const pending: Array<Readonly<{
        instance: HostedInstance;
        marker: Readonly<HostedInstanceRevocationMarker>;
        applyDeletion: boolean;
        applyPurge: boolean;
      }>> = [];
      for (const instance of this.#instances.values()) {
        const marker = this.#readRevocation(instance.runtimeInstanceId);
        if (!marker) continue;
        if (marker.tenantId !== instance.tenantId || marker.projectId !== instance.projectId
          || marker.cloudProjectId !== instance.cloudProjectId) {
          throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The instance revocation high-water identity conflicts with hosted state.");
        }
        this.#validateMarkerReceiptReservations(instance, marker);
        let applyDeletion = false;
        let applyPurge = false;
        if (instance.status === "active" || instance.status === "suspended") {
          applyDeletion = true;
          applyPurge = marker.phase === "purged";
        } else {
          if (instance.revocationId !== marker.revocationId || instance.deletedAt !== marker.tombstonedAt) {
            throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The durable instance revocation high-water does not match deletion state.");
          }
          if (instance.status === "delete-pending") applyPurge = marker.phase === "purged";
          else if (marker.phase !== "purged" || instance.purgedAt !== marker.purgedAt) {
            throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The durable purge high-water does not match purged hosted state.");
          }
        }
        const reservation = this.#pendingInstanceTransitions.get(instance.runtimeInstanceId);
        if (reservation && canonicalizeJson(reservation.marker) !== canonicalizeJson(marker)
          && !(marker.phase === "purged" && reservation.marker.phase === "delete-pending"
            && this.#sameRevocationIdentity(marker, reservation.marker))) {
          throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The reserved instance transition conflicts with its non-rollbackable high-water.");
        }
        if (applyDeletion || applyPurge || reservation) pending.push({ instance, marker, applyDeletion, applyPurge });
      }
      if (pending.length === 0) return;
      const checkpoint = this.#checkpoint();
      try {
        for (const item of pending) {
          if (item.applyDeletion) this.#applyHighWaterDeletion(item.instance, item.marker);
          if (item.applyPurge) this.#applyHighWaterPurge(item.instance, item.marker);
          this.#pendingInstanceTransitions.delete(item.instance.runtimeInstanceId);
        }
        this.#commitOrRestore(checkpoint);
        return;
      } catch (error) {
        this.#restoreDurableState(checkpoint);
        if (error instanceof HostedAppPlatformError && error.code !== "HOST_UNAVAILABLE") throw error;
        this.#refreshDurableState();
      }
    }
    throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The durable instance revocation high-water could not be reconciled after concurrent hosted-state changes.", { retryable: true });
  }

  #applyHighWaterDeletion(instance: HostedInstance, marker: Readonly<HostedInstanceRevocationMarker>): void {
    instance.status = "delete-pending";
    instance.deletedAt = marker.tombstonedAt;
    instance.revocationId = marker.revocationId;
    this.#deleteUpdateReviewsForInstance(instance.runtimeInstanceId);
    const runtimeGeneration = createAuthorityGeneration();
    for (const installation of instance.installations.values()) {
      for (const connection of installation.connections.values()) {
        this.#queueSecretCleanup(instance.runtimeInstanceId, connection.secretRef);
      }
      installation.networkGrants.clear();
      installation.connections.clear();
      for (const job of installation.jobs.values()) {
        job.enabled = false;
        if (job.scheduleId) this.#queueScheduleCleanup(instance.runtimeInstanceId, job.scheduleId);
        delete job.scheduleId;
      }
      installation.authority = advanceFields(installation.authority, [
        "grantGeneration",
        "connectionGeneration",
        "jobGeneration",
        "dataGeneration",
      ], runtimeGeneration);
      const receipt = marker.deleteReceipts.find((item) => item.featureInstallationId === installation.featureInstallationId);
      if (!receipt) throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The deletion high-water lacks a Feature receipt reservation.");
      this.#appendInstallationReceipt("instance-delete-requested", marker.effectivePrincipal, marker.tombstonedAt, instance, installation, {}, receipt.receiptId);
    }
  }

  #validateMarkerReceiptReservations(instance: HostedInstance, marker: Readonly<HostedInstanceRevocationMarker>): void {
    const expected = new Set([...instance.installations.values()].map((installation) => installation.featureInstallationId));
    const matches = (receipts: readonly Readonly<{ featureInstallationId: FeatureInstallationId }>[]): boolean =>
      receipts.length === expected.size && receipts.every((receipt) => expected.has(receipt.featureInstallationId));
    if (!matches(marker.deleteReceipts) || (marker.phase === "purged" && !matches(marker.purgeReceipts ?? []))) {
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The instance revocation high-water receipt reservations differ from hosted Feature Installations.");
    }
  }

  #applyHighWaterPurge(instance: HostedInstance, marker: Readonly<HostedInstanceRevocationMarker>): void {
    if (marker.phase !== "purged" || marker.purgedAt === undefined || marker.purgedBy === undefined) {
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The purge high-water is incomplete.");
    }
    instance.status = "purged";
    instance.purgedAt = marker.purgedAt;
    this.#deleteUpdateReviewsForInstance(instance.runtimeInstanceId);
    for (const installation of instance.installations.values()) {
      for (const collection of installation.dataCollections.values()) collection.partitions.clear();
      installation.authority = advanceFields(installation.authority, ["dataGeneration"]);
      const receipt = marker.purgeReceipts?.find((item) => item.featureInstallationId === installation.featureInstallationId);
      if (!receipt) throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The purge high-water lacks a Feature receipt reservation.");
      this.#appendInstallationReceipt("instance-purged", marker.purgedBy, marker.purgedAt, instance, installation, {}, receipt.receiptId);
    }
    for (const [mutationId, mutation] of this.#pendingDataMutations) {
      if (mutation.runtimeInstanceId === instance.runtimeInstanceId) this.#pendingDataMutations.delete(mutationId);
    }
  }

  #assertNotRevoked(instance: HostedInstance): void {
    const marker = this.#readRevocation(instance.runtimeInstanceId);
    if (!marker) return;
    if (marker.tenantId !== instance.tenantId || marker.projectId !== instance.projectId
      || marker.cloudProjectId !== instance.cloudProjectId) {
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The instance revocation high-water identity conflicts with hosted state.");
    }
    throw stale("This App Instance has a non-rollbackable deletion tombstone.");
  }

  #expirePendingDataMutations(nowMs: number): void {
    for (const [mutationId, mutation] of this.#pendingDataMutations) {
      if (Date.parse(mutation.expiresAt) <= nowMs) this.#pendingDataMutations.delete(mutationId);
    }
  }

  #countInstanceRecords(instance: HostedInstance): number {
    let count = 0;
    for (const installation of instance.installations.values()) {
      for (const collection of installation.dataCollections.values()) {
        for (const partition of collection.partitions.values()) count += partition.size;
      }
    }
    return count;
  }

  #assertReceiptCapacity(runtimeInstanceId: RuntimeInstanceId | undefined, additional: number): void {
    const all = [...this.#managementReceipts, ...this.#runtimeReceipts, ...this.#dataReceipts];
    const unresolved = unresolvedAcceptedJobReceipts(this.#runtimeReceipts);
    const unresolvedAccepted = unresolved.length;
    const pendingClaimReservations = this.#pendingJobClaims.size * 2;
    const lifecycleReservations = lifecycleRecoveryReceiptCount(this.#instances);
    const instanceReceipts = runtimeInstanceId === undefined ? [] : all.filter((receipt) => receipt.runtimeInstanceId === runtimeInstanceId);
    const instanceUnresolved = runtimeInstanceId === undefined ? 0 : unresolved
      .filter((receipt) => receipt.runtimeInstanceId === runtimeInstanceId).length;
    const instancePendingClaims = runtimeInstanceId === undefined ? 0 : [...this.#pendingJobClaims.values()]
      .filter((claim) => claim.runtimeInstanceId === runtimeInstanceId).length * 2;
    const capacityInstance = runtimeInstanceId === undefined ? undefined : this.#instances.get(runtimeInstanceId);
    const instanceLifecycleReservations = capacityInstance === undefined
      ? 0
      : capacityInstance.status === "active" || capacityInstance.status === "suspended"
        ? capacityInstance.installations.size * 2
        : capacityInstance.status === "delete-pending" ? capacityInstance.installations.size : 0;
    if (all.length + unresolvedAccepted + pendingClaimReservations + lifecycleReservations + additional > maximumReceiptsTotal
      || (runtimeInstanceId !== undefined
        && instanceReceipts.length + instanceUnresolved + instancePendingClaims + instanceLifecycleReservations + additional > maximumReceiptsPerInstance)) {
      throw quota("The durable receipt quota has been reached.");
    }
  }

  #retrySecretCleanup(): void {
    this.#drainCleanupMap(this.#pendingSecretCleanup, (task) => this.#secretVault.destroy(task.secretRef));
  }

  #retryScheduleCleanup(): void {
    this.#drainCleanupMap(this.#pendingScheduleCleanup, (task) => this.#jobCoordinator.disable(task.scheduleId));
  }

  #retryLeaseCompletions(): void {
    this.#drainCleanupMap(this.#pendingLeaseCompletions, (task) => this.#jobCoordinator.finish(task.leaseId, task.state));
  }

  #retryExternalAllocations(): void {
    this.#drainCleanupMap(this.#pendingExternalAllocations, (task) => {
      if (task.kind === "vault-store") this.#secretVault.cancelStore(task.operationId);
      else this.#jobCoordinator.cancelEnable(task.operationId);
    });
  }

  #retryPendingJobClaims(): void {
    for (let attempt = 0; attempt < cleanupMergeAttempts && this.#pendingJobClaims.size > 0; attempt += 1) {
      const checkpoint = this.#checkpoint();
      let changed = false;
      for (const [operationId, pending] of [...this.#pendingJobClaims]) {
        let lease: HostedJobLease | undefined;
        try { lease = this.#jobCoordinator.cancelClaim(operationId); }
        catch { continue; }
        if (lease !== undefined) this.#appendRecoveredCancelledClaim(pending, parseJobLease(lease, pending.scheduleId));
        this.#pendingJobClaims.delete(operationId);
        changed = true;
      }
      if (!changed) return;
      try {
        this.#commitOrRestore(checkpoint);
        return;
      } catch {
        try { this.#refreshDurableState(); } catch { return; }
      }
    }
  }

  #retryUnresolvedAcceptedReceipts(): void {
    for (let attempt = 0; attempt < cleanupMergeAttempts; attempt += 1) {
      const unresolved = unresolvedAcceptedJobReceipts(this.#runtimeReceipts);
      if (unresolved.length === 0) return;
      const checkpoint = this.#checkpoint();
      let changed = false;
      for (const accepted of unresolved) {
        let recoveredLease: HostedJobLease | undefined;
        try { recoveredLease = this.#jobCoordinator.cancelClaim(accepted.claimOperationId); }
        catch { continue; }
        if (recoveredLease !== undefined) {
          const lease = parseJobLease(recoveredLease, accepted.scheduleId);
          if (lease.leaseId !== accepted.leaseId || lease.occurrenceId !== accepted.occurrenceId
            || lease.runId !== accepted.runId || lease.attemptId !== accepted.attemptId) {
            throw new HostedAppPlatformError("HOST_UNAVAILABLE", "Coordinator recovery returned a different lease for an accepted attempt.");
          }
        }
        const finishedAt = this.#timestamp();
        this.#runtimeReceipts.push(deepFreeze({
          ...accepted,
          receiptId: `receipt_${randomUUID()}`,
          startedAt: accepted.acceptedAt,
          finishedAt,
          state: "cancelled",
          error: createRuntimeError(
            "HOST_UNAVAILABLE",
            "The host recovered an interrupted accepted attempt; its external effect outcome is unknown and it was not automatically retried.",
            { retryable: false },
          ),
          parentReceiptId: accepted.receiptId,
        }));
        if (recoveredLease === undefined) this.#queueLeaseCompletion(accepted.runtimeInstanceId, accepted.leaseId, "cancelled");
        changed = true;
      }
      if (!changed) return;
      try {
        this.#commitOrRestore(checkpoint);
        return;
      } catch {
        try { this.#refreshDurableState(); } catch { return; }
      }
    }
  }

  #appendRecoveredCancelledClaim(pending: PendingJobClaim, lease: HostedJobLease): void {
    const accepted: HostedJobReceipt = deepFreeze({
      receiptId: `receipt_${randomUUID()}`,
      kind: "job",
      tenantId: pending.tenantId,
      runtimeInstanceId: pending.runtimeInstanceId,
      featureInstallationId: pending.featureInstallationId,
      dataNamespaceId: pending.dataNamespaceId,
      releaseDigest: pending.releaseDigest,
      featureRevisionDigest: pending.featureRevisionDigest,
      jobId: pending.jobId,
      declarationId: pending.declarationId,
      networkDeclarationId: pending.networkDeclarationId,
      connectionDeclarationId: pending.connectionDeclarationId,
      connectionId: pending.connectionId,
      scheduleId: lease.scheduleId,
      leaseId: lease.leaseId,
      claimOperationId: pending.operationId,
      effectivePrincipal: pending.principal,
      authority: pending.authority,
      acceptedAt: pending.acceptedAt,
      state: "accepted",
      occurrenceId: lease.occurrenceId,
      runId: lease.runId,
      attemptId: lease.attemptId,
    });
    const finishedAt = this.#timestamp();
    const cancelled: HostedJobReceipt = deepFreeze({
      ...accepted,
      receiptId: `receipt_${randomUUID()}`,
      startedAt: pending.acceptedAt,
      finishedAt,
      state: "cancelled",
      error: createRuntimeError("CANCELLED", "The host recovered and cancelled a claimed attempt before its accepted receipt became durable.", { retryable: true }),
      parentReceiptId: accepted.receiptId,
    });
    this.#runtimeReceipts.push(accepted, cancelled);
  }

  #drainCleanupMap<T>(tasks: Map<string, T>, effect: (task: T) => void): void {
    for (let attempt = 0; attempt < cleanupMergeAttempts && tasks.size > 0; attempt += 1) {
      const checkpoint = this.#checkpoint();
      let changed = false;
      for (const [identity, task] of [...tasks]) {
        try {
          effect(task);
          tasks.delete(identity);
          changed = true;
        } catch {
          // The durable task remains. External cleanup adapters are required to be idempotent.
        }
      }
      if (!changed) return;
      try {
        this.#commitOrRestore(checkpoint);
        return;
      } catch {
        try { this.#refreshDurableState(); } catch { return; }
      }
    }
  }

  #queueSecretCleanup(runtimeInstanceId: RuntimeInstanceId, secretRef: string): void {
    boundedString(secretRef, "secretRef", 512);
    this.#pendingSecretCleanup.set(secretRef, { secretRef, runtimeInstanceId });
  }

  #queueScheduleCleanup(runtimeInstanceId: RuntimeInstanceId, scheduleId: string): void {
    boundedString(scheduleId, "scheduleId", 256);
    this.#pendingScheduleCleanup.set(scheduleId, { scheduleId, runtimeInstanceId });
  }

  #queueLeaseCompletion(
    runtimeInstanceId: RuntimeInstanceId,
    leaseId: string,
    state: LeaseCompletionTask["state"],
  ): void {
    boundedString(leaseId, "leaseId", 256);
    const existing = this.#pendingLeaseCompletions.get(leaseId);
    if (existing && (existing.runtimeInstanceId !== runtimeInstanceId || existing.state !== state)) {
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", "A durable lease completion identity was reused with conflicting state.");
    }
    this.#pendingLeaseCompletions.set(leaseId, { leaseId, runtimeInstanceId, state });
  }

  #hasInstanceCleanup(runtimeInstanceId: RuntimeInstanceId): boolean {
    return [...this.#pendingSecretCleanup.values()].some((task) => task.runtimeInstanceId === runtimeInstanceId)
      || [...this.#pendingScheduleCleanup.values()].some((task) => task.runtimeInstanceId === runtimeInstanceId)
      || [...this.#pendingLeaseCompletions.values()].some((task) => task.runtimeInstanceId === runtimeInstanceId)
      || [...this.#pendingExternalAllocations.values()].some((task) => task.runtimeInstanceId === runtimeInstanceId)
      || [...this.#pendingJobClaims.values()].some((task) => task.runtimeInstanceId === runtimeInstanceId)
      || unresolvedAcceptedJobReceipts(this.#runtimeReceipts)
        .some((receipt) => receipt.runtimeInstanceId === runtimeInstanceId);
  }

  #checkpoint(): Readonly<Record<string, unknown>> {
    return this.#durableSnapshot(this.#stateRevision);
  }

  #preflightCurrentMutation(checkpoint: Readonly<Record<string, unknown>>): void {
    try { this.#durableSnapshot(this.#stateRevision + 1); }
    catch (error) {
      this.#restoreDurableState(checkpoint);
      throw error;
    }
  }

  #commitOrRestore(checkpoint: Readonly<Record<string, unknown>>): void {
    const expectedRevision = this.#stateRevision;
    const nextRevision = expectedRevision + 1;
    try {
      const next = this.#durableSnapshot(nextRevision);
      try {
        this.#stateRepository.compareAndSwap(expectedRevision, next);
        this.#stateRevision = nextRevision;
        return;
      } catch (error) {
        try {
          const observed = this.#stateRepository.load();
          if (observed !== undefined && canonicalizeJson(observed) === canonicalizeJson(next)) {
            this.#stateRevision = nextRevision;
            return;
          }
        } catch {
          // The original commit failure remains authoritative when readback is unavailable.
        }
        throw error;
      }
    } catch (error) {
      this.#restoreDurableState(checkpoint);
      if (error instanceof HostedAppPlatformError) throw error;
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", `Durable hosted state commit failed: ${message(error)}`, { retryable: true });
    }
  }

  #loadDurableState(): void {
    let stored: unknown;
    try { stored = this.#stateRepository.load(); }
    catch (error) {
      throw new HostedAppPlatformError("HOST_UNAVAILABLE", `Durable hosted state load failed: ${message(error)}`, { retryable: true });
    }
    if (stored !== undefined) this.#restoreDurableState(stored);
  }

  #refreshDurableState(): void {
    let stored: unknown;
    try { stored = this.#stateRepository.load(); }
    catch (error) { throw new HostedAppPlatformError("HOST_UNAVAILABLE", `Durable hosted state refresh failed: ${message(error)}`, { retryable: true }); }
    if (stored === undefined) {
      if (this.#stateRevision !== 0) throw new HostedAppPlatformError("HOST_UNAVAILABLE", "Durable hosted state disappeared.");
      return;
    }
    const record = expectRecord(stored, "Hosted durable state");
    if (!Number.isSafeInteger(record.revision)) throw invalid("Hosted durable state revision is invalid.");
    const revision = record.revision as number;
    if (revision < this.#stateRevision) throw new HostedAppPlatformError("HOST_UNAVAILABLE", "Durable hosted state moved backwards.");
    if (revision > this.#stateRevision) this.#restoreDurableState(stored);
  }

  #durableSnapshot(revision: number): Readonly<Record<string, unknown>> {
    const snapshot = deepFreeze({
      recordVersion: 1,
      revision,
      payload: encodeDurableValue({
        cloudProjectsByProject: this.#cloudProjectsByProject,
        projectsByCloudProject: this.#projectsByCloudProject,
        registry: this.#registry,
        instances: this.#instances,
        updateReviews: this.#updateReviews,
        managementReceipts: this.#managementReceipts,
        runtimeReceipts: this.#runtimeReceipts,
        dataReceipts: this.#dataReceipts,
        pendingDataMutations: this.#pendingDataMutations,
        pendingSecretCleanup: this.#pendingSecretCleanup,
        pendingScheduleCleanup: this.#pendingScheduleCleanup,
        pendingLeaseCompletions: this.#pendingLeaseCompletions,
        pendingExternalAllocations: this.#pendingExternalAllocations,
        pendingJobClaims: this.#pendingJobClaims,
        pendingInstanceTransitions: this.#pendingInstanceTransitions,
        revokedTenantPrincipals: this.#revokedTenantPrincipals,
      }),
    } satisfies Record<string, unknown>);
    const recoveryReserve = this.#pendingJobClaims.size * recoveryReceiptReserveBytes * 2
      + lifecycleRecoveryByteReserveCount(this.#instances, this.#pendingInstanceTransitions) * recoveryReceiptReserveBytes
      + unresolvedAcceptedJobReceipts(this.#runtimeReceipts).length * recoveryReceiptReserveBytes;
    if (durableByteLength(snapshot) + recoveryReserve > maximumDurableStateBytes) {
      throw quota(`Hosted durable state exceeds ${maximumDurableStateBytes} bytes.`);
    }
    return snapshot;
  }

  #restoreDurableState(value: unknown): void {
    if (durableByteLength(value) > maximumDurableStateBytes) throw invalid("Hosted durable state exceeds its byte limit.");
    const snapshot = exactInput(value, ["recordVersion", "revision", "payload"], "Hosted durable state");
    if (snapshot.recordVersion !== 1 || !Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0) {
      throw invalid("Hosted durable state version or revision is invalid.");
    }
    const payload = exactInput(decodeDurableValue(snapshot.payload), [
      "cloudProjectsByProject",
      "projectsByCloudProject",
      "registry",
      "instances",
      "updateReviews",
      "managementReceipts",
      "runtimeReceipts",
      "dataReceipts",
      "pendingDataMutations",
      "pendingSecretCleanup",
      "pendingScheduleCleanup",
      "pendingLeaseCompletions",
      "pendingExternalAllocations",
      "pendingJobClaims",
      "pendingInstanceTransitions",
      "revokedTenantPrincipals",
    ], "Hosted durable payload");
    const cloudProjectsByProject = expectMap(payload.cloudProjectsByProject, "cloudProjectsByProject");
    const projectsByCloudProject = expectMap(payload.projectsByCloudProject, "projectsByCloudProject");
    for (const [projectId, cloudProjectId] of cloudProjectsByProject) {
      const parsedProjectId = project(projectId);
      const parsedCloudProjectId = cloudProject(cloudProjectId);
      if (projectsByCloudProject.get(parsedCloudProjectId) !== parsedProjectId) throw invalid("Cloud Project bindings are not bijective.");
    }
    if (cloudProjectsByProject.size !== projectsByCloudProject.size) throw invalid("Cloud Project bindings are not bijective.");
    const registry = expectMap(payload.registry, "registry");
    const rebuiltRegistry = new Map<string, RegistryRelease>();
    for (const [key, rawEntry] of registry) {
      const releaseDigest = digest(key, "releaseDigest");
      const entry = expectRecord(rawEntry, "Stored registry Release");
      expectOnlyKeys(entry, ["release", "declarations", "reviewedBy", "reviewedAt", "publishedBy", "publishedAt"], "Stored registry Release");
      for (const required of ["release", "declarations", "reviewedBy", "reviewedAt"] as const) {
        if (!Object.prototype.hasOwnProperty.call(entry, required)) throw invalid(`Stored registry Release is missing ${required}.`);
      }
      const release = verifyAppRelease(entry.release);
      if (release.releaseDigest !== releaseDigest) throw invalid("Stored registry Release key does not match its digest.");
      if (!cloudProjectsByProject.has(release.manifest.projectId)) throw invalid("Stored registry Release has no cloud Project binding.");
      const declarations = parseReleaseDeclarations(release);
      validateStoredDeclarationProjection(entry.declarations, declarations);
      if ((entry.publishedBy === undefined) !== (entry.publishedAt === undefined)) {
        throw invalid("Stored registry publication identity and timestamp must appear together.");
      }
      rebuiltRegistry.set(releaseDigest, {
        release,
        declarations,
        reviewedBy: parseEffectivePrincipal(entry.reviewedBy),
        reviewedAt: parseTimestampValue(entry.reviewedAt, "reviewedAt"),
        ...(entry.publishedBy === undefined ? {} : { publishedBy: parseEffectivePrincipal(entry.publishedBy) }),
        ...(entry.publishedAt === undefined ? {} : { publishedAt: parseTimestampValue(entry.publishedAt, "publishedAt") }),
      });
    }
    const instances = parseStoredInstances(payload.instances, rebuiltRegistry, cloudProjectsByProject);
    const updateReviews = parseStoredUpdateReviews(payload.updateReviews, instances, rebuiltRegistry);
    const pendingDataMutations = parsePendingMutations(payload.pendingDataMutations, instances, rebuiltRegistry);
    const managementReceipts = parseManagementReceipts(payload.managementReceipts, instances, rebuiltRegistry);
    const runtimeReceipts = parseJobReceipts(payload.runtimeReceipts, instances, rebuiltRegistry);
    const dataReceipts = parseDataReceipts(payload.dataReceipts, instances);
    validateReceiptLineage(runtimeReceipts);
    const externalAllocations = parseExternalAllocationMap(payload.pendingExternalAllocations, instances);
    const pendingJobClaims = parsePendingJobClaimMap(payload.pendingJobClaims, instances, rebuiltRegistry);
    const pendingInstanceTransitions = parsePendingInstanceTransitionMap(payload.pendingInstanceTransitions, instances);
    const unresolvedAcceptedCount = unresolvedAcceptedJobReceipts(runtimeReceipts).length;
    if (durableByteLength(value) + pendingJobClaims.size * recoveryReceiptReserveBytes * 2
      + lifecycleRecoveryByteReserveCount(instances, pendingInstanceTransitions) * recoveryReceiptReserveBytes
      + unresolvedAcceptedCount * recoveryReceiptReserveBytes > maximumDurableStateBytes) {
      throw invalid("Hosted durable state lacks required recovery receipt headroom.");
    }
    validateReceiptQuotas(managementReceipts, runtimeReceipts, dataReceipts, pendingJobClaims, pendingInstanceTransitions, instances);
    const cleanup = parseSecretCleanupMap(payload.pendingSecretCleanup);
    const scheduleCleanup = parseScheduleCleanupMap(payload.pendingScheduleCleanup);
    const leaseCompletions = parseLeaseCompletionMap(payload.pendingLeaseCompletions);
    const revokedTenantPrincipals = expectSet(payload.revokedTenantPrincipals, "revokedTenantPrincipals");
    for (const key of revokedTenantPrincipals) parseRevokedPrincipalKey(key);
    validateCleanupRelationships(instances, cleanup, scheduleCleanup, leaseCompletions, externalAllocations, pendingJobClaims, runtimeReceipts, pendingDataMutations);

    this.#cloudProjectsByProject.clear();
    this.#projectsByCloudProject.clear();
    for (const [key, item] of cloudProjectsByProject) this.#cloudProjectsByProject.set(project(key), cloudProject(item));
    for (const [key, item] of projectsByCloudProject) this.#projectsByCloudProject.set(cloudProject(key), project(item));
    replaceMap(this.#registry, rebuiltRegistry);
    replaceMap(this.#instances, instances);
    replaceMap(this.#updateReviews, updateReviews);
    replaceMap(this.#pendingDataMutations, pendingDataMutations);
    replaceArray(this.#managementReceipts, managementReceipts.map((receipt) => deepFreeze(receipt)));
    replaceArray(this.#runtimeReceipts, runtimeReceipts.map((receipt) => deepFreeze(receipt)));
    replaceArray(this.#dataReceipts, dataReceipts.map((receipt) => deepFreeze(receipt)));
    this.#pendingSecretCleanup.clear();
    for (const [secretRef, task] of cleanup) this.#pendingSecretCleanup.set(secretRef, task);
    this.#pendingScheduleCleanup.clear();
    for (const [scheduleId, task] of scheduleCleanup) this.#pendingScheduleCleanup.set(scheduleId, task);
    this.#pendingLeaseCompletions.clear();
    for (const [leaseId, task] of leaseCompletions) this.#pendingLeaseCompletions.set(leaseId, task);
    this.#pendingExternalAllocations.clear();
    for (const [operationId, task] of externalAllocations) this.#pendingExternalAllocations.set(operationId, task);
    this.#pendingJobClaims.clear();
    for (const [operationId, task] of pendingJobClaims) this.#pendingJobClaims.set(operationId, task);
    this.#pendingInstanceTransitions.clear();
    for (const [runtimeInstanceId, transition] of pendingInstanceTransitions) this.#pendingInstanceTransitions.set(runtimeInstanceId, transition);
    this.#revokedTenantPrincipals.clear();
    for (const key of revokedTenantPrincipals) this.#revokedTenantPrincipals.add(key as string);
    this.#stateRevision = snapshot.revision as number;
  }
}

function parseReleaseDeclarations(release: AppReleaseEnvelope): ReadonlyMap<string, HostedFeatureDeclaration> {
  if (release.manifest.runtimeApi.name !== "work-fold.feature-broker"
    || release.manifest.runtimeApi.compatibleRange !== "1.x") {
    throw new HostedAppPlatformError(
      "CAPABILITY_UNSUPPORTED",
      "This private hosted runtime supports work-fold.feature-broker 1.x Releases only.",
    );
  }
  const records = new Map(release.closure.records.map((record) => [record.digest, record]));
  const result = new Map<string, HostedFeatureDeclaration>();
  for (const feature of release.manifest.features) {
    const record = records.get(feature.declaration.digest);
    if (!record || record.mediaType !== featureDeclarationMediaType) {
      throw invalid(`Feature ${feature.featureId} must use the hosted feature declaration media type.`);
    }
    result.set(feature.featureId, parseFeatureDeclaration(record.value, feature.featureId));
  }
  return result;
}

function parseFeatureDeclaration(value: unknown, featureId: string): HostedFeatureDeclaration {
  const record = exactInput(value, ["format", "formatVersion", "networkDestinations", "connections", "jobs", "collections"], `Feature ${featureId} declaration`);
  if (record.format !== featureDeclarationFormat || record.formatVersion !== 1) {
    throw invalid(`Feature ${featureId} declaration format is unsupported.`);
  }
  const networkValues = boundedArray(record.networkDestinations, `Feature ${featureId} networkDestinations`, 64);
  const networkDestinations = networkValues.map((item, index) => {
    const entry = exactInput(item, ["declarationId", "origin"], `Feature ${featureId} networkDestinations[${index}]`);
    return {
      declarationId: stableId(entry.declarationId, "declarationId"),
      origin: parseHostedOrigin(entry.origin),
    };
  });
  assertOrderedUnique(networkDestinations, (item) => item.declarationId, `Feature ${featureId} networkDestinations`);
  const connectionValues = boundedArray(record.connections, `Feature ${featureId} connections`, 64);
  const connections = connectionValues.map((item, index) => {
    const entry = exactInput(item, ["declarationId", "networkDeclarationId", "authKind"], `Feature ${featureId} connections[${index}]`);
    const authKind: ConnectionDeclaration["authKind"] = entry.authKind === "bearer" ? "bearer" : "api-key";
    if (entry.authKind !== "bearer" && entry.authKind !== "api-key") throw invalid("Connection authKind must be bearer or api-key.");
    const networkDeclarationId = stableId(entry.networkDeclarationId, "networkDeclarationId");
    if (!networkDestinations.some((network) => network.declarationId === networkDeclarationId)) {
      throw invalid(`Feature ${featureId} connection refers to an unknown network declaration.`);
    }
    return { declarationId: stableId(entry.declarationId, "declarationId"), networkDeclarationId, authKind };
  });
  assertOrderedUnique(connections, (item) => item.declarationId, `Feature ${featureId} connections`);
  const jobValues = boundedArray(record.jobs, `Feature ${featureId} jobs`, 64);
  const jobs = jobValues.map((item, index) => {
    const entry = exactInput(item, ["jobId", "networkDeclarationId", "connectionDeclarationId", "schedule"], `Feature ${featureId} jobs[${index}]`);
    const networkDeclarationId = stableId(entry.networkDeclarationId, "networkDeclarationId");
    const connectionDeclarationId = stableId(entry.connectionDeclarationId, "connectionDeclarationId");
    const connection = connections.find((candidate) => candidate.declarationId === connectionDeclarationId);
    if (!connection || connection.networkDeclarationId !== networkDeclarationId) {
      throw invalid(`Feature ${featureId} job must reference one compatible connection and network declaration.`);
    }
    const scheduleRecord = exactInput(entry.schedule, ["kind", "everySeconds"], `Feature ${featureId} job schedule`);
    if (scheduleRecord.kind !== "interval" || !Number.isSafeInteger(scheduleRecord.everySeconds)
      || (scheduleRecord.everySeconds as number) < 60 || (scheduleRecord.everySeconds as number) > 31_536_000) {
      throw invalid(`Feature ${featureId} job schedule must be an interval from 60 to 31536000 seconds.`);
    }
    return {
      jobId: stableId(entry.jobId, "jobId"),
      networkDeclarationId,
      connectionDeclarationId,
      schedule: { kind: "interval" as const, everySeconds: scheduleRecord.everySeconds as number },
    };
  });
  assertOrderedUnique(jobs, (item) => item.jobId, `Feature ${featureId} jobs`);
  const collectionValues = boundedArray(record.collections, `Feature ${featureId} collections`, 64);
  const collections = collectionValues.map((item, index) => {
    const entry = exactInput(item, ["collectionId", "ownerClass", "allowedActions", "allowedRoles"], `Feature ${featureId} collections[${index}]`);
    if (entry.ownerClass !== "instance" && entry.ownerClass !== "principal" && entry.ownerClass !== "role") {
      throw invalid(`Feature ${featureId} collection ownerClass is invalid.`);
    }
    const allowedActions = boundedArray(entry.allowedActions, "allowedActions", 5).map((action) => {
      if (action !== "list" && action !== "read" && action !== "create" && action !== "update" && action !== "delete") {
        throw invalid(`Feature ${featureId} collection action is invalid.`);
      }
      return action;
    });
    if (allowedActions.length === 0) throw invalid(`Feature ${featureId} collection must declare at least one action.`);
    assertOrderedUnique(allowedActions, (action) => action, `Feature ${featureId} collection actions`);
    const allowedRoles = boundedArray(entry.allowedRoles, "allowedRoles", 32).map((role) => stableId(role, "role"));
    assertOrderedUnique(allowedRoles, (role) => role, `Feature ${featureId} collection roles`);
    if (entry.ownerClass === "role" ? allowedRoles.length === 0 : allowedRoles.length !== 0) {
      throw invalid(`Feature ${featureId} role collections require roles and other owner classes forbid them.`);
    }
    return {
      collectionId: stableId(entry.collectionId, "collectionId"),
      ownerClass: entry.ownerClass as HostedDataOwnerClass,
      allowedActions: allowedActions as HostedDataAction[],
      allowedRoles,
    };
  });
  assertOrderedUnique(collections, (item) => item.collectionId, `Feature ${featureId} collections`);
  return deepFreeze({
    format: featureDeclarationFormat,
    formatVersion: 1,
    networkDestinations,
    connections,
    jobs,
    collections,
  });
}

function createInstallation(feature: AppReleaseFeature, declaration: HostedFeatureDeclaration): HostedFeatureInstallation {
  const jobs = new Map<string, InstanceJob>();
  for (const job of declaration.jobs) jobs.set(job.jobId, { jobId: job.jobId, enabled: false });
  const dataCollections = new Map<string, HostedDataCollection>();
  for (const collection of declaration.collections) {
    dataCollections.set(collection.collectionId, {
      collectionId: collection.collectionId,
      ownerClass: collection.ownerClass,
      partitions: new Map(),
    });
  }
  return {
    featureId: feature.featureId,
    featureInstallationId: createFeatureInstallationId(),
    dataNamespaceId: createDataNamespaceId(),
    featureRevisionDigest: feature.featureRevision.digest,
    declarationDigest: feature.declaration.digest,
    dataSchemaIdentity: dataSchemaIdentity(feature),
    authority: createAuthorityStamp(),
    networkGrants: new Map(),
    connections: new Map(),
    jobs,
    dataCollections,
  };
}

function instanceView(instance: HostedInstance): HostedInstanceView {
  const features = [...instance.installations.values()]
    .sort((left, right) => left.featureId.localeCompare(right.featureId))
    .map((installation) => ({
      featureId: installation.featureId,
      featureInstallationId: installation.featureInstallationId,
      dataNamespaceId: installation.dataNamespaceId,
      featureRevisionDigest: installation.featureRevisionDigest,
      declarationDigest: installation.declarationDigest,
      authority: parseAuthorityStamp(installation.authority),
      networkGrants: [...installation.networkGrants.values()]
        .sort((left, right) => left.declarationId.localeCompare(right.declarationId))
        .map(({ declarationId, origin }) => ({ declarationId, origin })),
      connections: [...installation.connections.values()]
        .sort((left, right) => left.connectionId.localeCompare(right.connectionId))
        .map(({ connectionId, declarationId, origin, targetIdentity, featureRevisionDigest, declarationDigest, owner }) => ({
          connectionId,
          declarationId,
          origin,
          targetIdentity,
          featureRevisionDigest,
          declarationDigest,
          owner,
          status: "active" as const,
        })),
      jobs: [...installation.jobs.values()]
        .sort((left, right) => left.jobId.localeCompare(right.jobId))
        .map(({ jobId, enabled, scheduleId }) => ({ jobId, enabled, ...(scheduleId === undefined ? {} : { scheduleId }) })),
      collections: [...installation.dataCollections.values()]
        .sort((left, right) => left.collectionId.localeCompare(right.collectionId))
        .map(({ collectionId, ownerClass }) => ({ collectionId, ownerClass })),
    }));
  return deepFreeze({
    runtimeInstanceId: instance.runtimeInstanceId,
    tenantId: instance.tenantId,
    projectId: instance.projectId,
    cloudProjectId: instance.cloudProjectId,
    releaseDigest: instance.releaseDigest,
    host: "hosted",
    status: instance.status,
    features,
    instanceRoles: [...instance.instanceRoles.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([principalId, roles]) => ({
        principalId: actorId(principalId),
        roles: [...roles].sort(),
      })),
  });
}

function publicUpdateReview(review: StoredUpdateReview): HostedUpdateReview {
  return deepFreeze({
    updateId: review.updateId,
    runtimeInstanceId: review.runtimeInstanceId,
    fromReleaseDigest: review.fromReleaseDigest,
    toReleaseDigest: review.toReleaseDigest,
    reviewedBy: review.reviewedBy,
    reviewedAt: review.reviewedAt,
    decisions: review.decisions,
  });
}

function sameFeatureAuthoritySurface(left: AppReleaseFeature, right: AppReleaseFeature): boolean {
  return left.featureRevision.digest === right.featureRevision.digest
    && left.declaration.digest === right.declaration.digest;
}

function dataSchemaIdentity(feature: AppReleaseFeature): string | null {
  if (!feature.dataSchema) return null;
  return `${feature.dataSchema.schemaId}:${feature.dataSchema.version}:${feature.dataSchema.definition.digest}`;
}

function advanceFields(
  authority: AuthorityStamp,
  fields: readonly (keyof AuthorityStamp)[],
  runtimeGeneration?: AuthorityStamp["runtimeInstanceGeneration"],
): Readonly<AuthorityStamp> {
  const next: { -readonly [Field in keyof AuthorityStamp]: AuthorityStamp[Field] } = { ...parseAuthorityStamp(authority) };
  for (const field of fields) next[field] = createAuthorityGeneration();
  if (runtimeGeneration !== undefined) next.runtimeInstanceGeneration = runtimeGeneration;
  return parseAuthorityStamp(next);
}

function withRuntimeGeneration(
  authority: AuthorityStamp,
  runtimeInstanceGeneration: AuthorityStamp["runtimeInstanceGeneration"],
): Readonly<AuthorityStamp> {
  return parseAuthorityStamp({ ...authority, runtimeInstanceGeneration });
}

function parseEffectivePrincipal(value: unknown): EffectivePrincipal {
  const record = exactInput(value, ["principalId", "kind", "realm"], "Authenticated Principal");
  if (record.kind !== "human" && record.kind !== "agent" && record.kind !== "service" && record.kind !== "system") {
    throw new HostedAppPlatformError("AUTHENTICATION_REQUIRED", "The authenticated Principal kind is invalid.");
  }
  if (record.realm !== "local" && record.realm !== "cloud") {
    throw new HostedAppPlatformError("AUTHENTICATION_REQUIRED", "The authenticated Principal realm is invalid.");
  }
  return Object.freeze({ principalId: actorId(record.principalId), kind: record.kind, realm: record.realm });
}

function parseHostedOrigin(value: unknown): string {
  const source = boundedString(value, "network origin", 2_048);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw invalid("Hosted network origin must be an absolute URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw invalid("Hosted network origin must be a credential-free HTTPS origin without path, query, or fragment.");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || isIpLiteral(hostname)) {
    throw invalid("Hosted network origin must not target localhost, local names, or IP literals.");
  }
  if (url.origin !== source) throw invalid(`Hosted network origin must use canonical form ${url.origin}.`);
  return source;
}

function isIpLiteral(hostname: string): boolean {
  return /^\[.*\]$/.test(hostname) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function parseSecret(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximumSecretBytes) {
    throw invalid(`secret must be a non-empty Uint8Array of at most ${maximumSecretBytes} bytes.`);
  }
  return new Uint8Array(value);
}

function parseJobLease(value: unknown, expectedScheduleId: string): HostedJobLease {
  const record = exactInput(value, ["leaseId", "scheduleId", "occurrenceId", "runId", "attemptId"], "Hosted job lease");
  const lease = {
    leaseId: boundedString(record.leaseId, "leaseId", 256),
    scheduleId: boundedString(record.scheduleId, "scheduleId", 256),
    occurrenceId: boundedString(record.occurrenceId, "occurrenceId", 256),
    runId: boundedString(record.runId, "runId", 256),
    attemptId: boundedString(record.attemptId, "attemptId", 256),
  };
  if (lease.scheduleId !== expectedScheduleId) throw new HostedAppPlatformError("HOST_UNAVAILABLE", "The job coordinator returned a lease for another schedule.");
  return deepFreeze(lease);
}

function jobEffectIdempotencyKey(input: Readonly<{
  runtimeInstanceId: RuntimeInstanceId;
  featureInstallationId: FeatureInstallationId;
  jobId: string;
  scheduleId: string;
  occurrenceId: string;
  runId: string;
  attemptId: string;
}>): string {
  const hash = createHash("sha256").update(canonicalizeJson(input), "utf8").digest("hex");
  return `job-effect-${hash}`;
}

function parseConnectionId(value: unknown): string {
  if (typeof value !== "string" || !/^connection_[a-z0-9-]{1,128}$/.test(value)) throw invalid("connectionId is invalid.");
  return value;
}

function parseMutationId(value: unknown): string {
  if (typeof value !== "string" || !/^mutation_[a-z0-9-]{1,128}$/.test(value)) throw invalid("mutationId is invalid.");
  return value;
}

function parseExpectedRevision(value: unknown, action: "create" | "update" | "delete"): number | null {
  if (action === "create") {
    if (value !== null) throw invalid("Create requires expectedRevision null.");
    return null;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalid(`${action} requires a positive expectedRevision.`);
  return value as number;
}

function boundedJson(value: unknown, label: string): unknown {
  let canonical: string;
  try { canonical = canonicalizeJson(value); } catch (error) { throw invalid(`${label} must be I-JSON: ${message(error)}`); }
  if (new TextEncoder().encode(canonical).byteLength > 256 * 1024) throw invalid(`${label} exceeds 262144 bytes.`);
  return deepFreeze(JSON.parse(canonical));
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(canonicalizeJson(value));
}

function exportHostedData(instance: HostedInstance, requester: PrincipalId): HostedInstanceExport["data"] {
  const exported: HostedInstanceExport["data"][number][] = [];
  for (const installation of [...instance.installations.values()].sort((left, right) => left.featureId.localeCompare(right.featureId))) {
    for (const collection of [...installation.dataCollections.values()].sort((left, right) => left.collectionId.localeCompare(right.collectionId))) {
      const partitions = [...collection.partitions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([partitionId, records]) => {
          if (collection.ownerClass === "principal" && partitionId !== requester) {
            return { partitionId, omittedPrincipalPrivateRecords: records.size };
          }
          return {
            partitionId,
            records: [...records.values()]
              .sort((left, right) => left.recordId.localeCompare(right.recordId))
              .map(({ recordId, revision, value, updatedAt }) => ({
                recordId,
                revision,
                value: cloneJson(value),
                updatedAt,
              })),
          };
        });
      exported.push({
        featureId: installation.featureId,
        collectionId: collection.collectionId,
        ownerClass: collection.ownerClass,
        partitions,
      });
    }
  }
  return deepFreeze(exported);
}

function toRuntimeFailure(error: unknown): Readonly<RuntimeError> {
  if (error instanceof HostedAppPlatformError) return error.runtimeError;
  return createRuntimeError("HOST_UNAVAILABLE", "The hosted connection effect failed.", { retryable: true });
}

function project(value: unknown): ProjectId {
  try { return parseProjectId(value); } catch (error) { throw invalid(message(error)); }
}

function cloudProject(value: unknown): CloudProjectId {
  try { return parseCloudProjectId(value); } catch (error) { throw invalid(message(error)); }
}

function parseFeatureInstallationIdValue(value: unknown): FeatureInstallationId {
  try { return parseFeatureInstallationId(value); } catch (error) { throw invalid(message(error)); }
}

function parseDataNamespaceIdValue(value: unknown): DataNamespaceId {
  try { return parseDataNamespaceId(value); } catch (error) { throw invalid(message(error)); }
}

function tenant(value: unknown): TenantId {
  try { return parseTenantId(value); } catch (error) { throw invalid(message(error)); }
}

function actorId(value: unknown): PrincipalId {
  try { return parsePrincipalId(value); } catch (error) { throw invalid(message(error)); }
}

function instanceId(value: unknown): RuntimeInstanceId {
  try { return parseRuntimeInstanceId(value); } catch (error) { throw invalid(message(error)); }
}

function digest(value: unknown, label: string): Sha256Digest {
  try { return parseSha256Digest(value, label); } catch (error) { throw invalid(message(error)); }
}

function artifactDigest(value: unknown, label: string): AppPlatformArtifactDigest {
  try { return parseAppPlatformArtifactDigest(value); } catch (error) { throw invalid(`${label} is invalid: ${message(error)}`); }
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !stableIdPattern.test(value)) throw invalid(`${label} must use 1-64 lowercase letters, numbers, or hyphens.`);
  return value;
}

function parsePrefixedId(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw invalid(`${label} is invalid.`);
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || hasLoneSurrogate(value)) {
    throw invalid(`${label} must be a non-empty bounded Unicode string.`);
  }
  return value;
}

function boundedArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid(`${label} must be an array of at most ${maximum} items.`);
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

function parseRoleArray(value: unknown, allowed: readonly string[], label: string): string[] {
  const items = boundedArray(value, label, allowed.length);
  if (items.length === 0) throw invalid(`${label} must not be empty.`);
  const roles = items.map((role) => {
    if (typeof role !== "string" || !allowed.includes(role)) throw invalid(`${label} contains an unsupported role.`);
    return role;
  });
  if (new Set(roles).size !== roles.length) throw invalid(`${label} contains a duplicate role.`);
  return roles;
}

function assertOrderedUnique<T>(items: readonly T[], key: (item: T) => string, label: string): void {
  for (let index = 1; index < items.length; index += 1) {
    if (key(items[index - 1]!) >= key(items[index]!)) throw invalid(`${label} must be uniquely ordered by id.`);
  }
}

function exactInput(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const record = expectRecord(value, label);
  expectOnlyKeys(record, keys, label);
  const missing = keys.find((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (missing) throw invalid(`${label} is missing ${missing}.`);
  return record;
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

function expectOnlyKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const accepted = new Set(keys);
  const unsupported = Object.keys(record).find((key) => !accepted.has(key));
  if (unsupported) throw invalid(`${label} contains unsupported field ${unsupported}.`);
}

function mapValue<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function replaceArray<T>(target: T[], source: readonly T[]): void {
  target.splice(0, target.length, ...source);
}

function encodeDurableValue(value: unknown, depth = 0, nodes = { count: 0 }): unknown {
  nodes.count += 1;
  if (nodes.count > 250_000 || depth > 96) throw invalid("Hosted durable state exceeds structural limits.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("Hosted durable state contains a non-finite number.");
    return value;
  }
  if (value instanceof Map) {
    return {
      $hostedType: "map",
      entries: [...value.entries()].map(([key, item]) => [
        encodeDurableValue(key, depth + 1, nodes),
        encodeDurableValue(item, depth + 1, nodes),
      ]),
    };
  }
  if (value instanceof Set) {
    return { $hostedType: "set", values: [...value].map((item) => encodeDurableValue(item, depth + 1, nodes)) };
  }
  if (Array.isArray(value)) return value.map((item) => encodeDurableValue(item, depth + 1, nodes));
  const record = expectRecord(value, "Hosted durable value");
  const encoded: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (item === undefined) continue;
    encoded[key] = encodeDurableValue(item, depth + 1, nodes);
  }
  return encoded;
}

function decodeDurableValue(value: unknown, depth = 0, nodes = { count: 0 }): unknown {
  nodes.count += 1;
  if (nodes.count > 250_000 || depth > 96) throw invalid("Hosted durable state exceeds structural limits.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("Hosted durable state contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => decodeDurableValue(item, depth + 1, nodes));
  const record = expectRecord(value, "Encoded hosted durable value");
  if (record.$hostedType === "map") {
    const tagged = exactInput(record, ["$hostedType", "entries"], "Encoded hosted Map");
    const entries = boundedArray(tagged.entries, "Encoded hosted Map entries", 250_000);
    const result = new Map<unknown, unknown>();
    for (const entry of entries) {
      const pair = boundedArray(entry, "Encoded hosted Map entry", 2);
      if (pair.length !== 2) throw invalid("Encoded hosted Map entry must contain two values.");
      const key = decodeDurableValue(pair[0], depth + 1, nodes);
      if (result.has(key)) throw invalid("Encoded hosted Map contains a duplicate key.");
      result.set(key, decodeDurableValue(pair[1], depth + 1, nodes));
    }
    return result;
  }
  if (record.$hostedType === "set") {
    const tagged = exactInput(record, ["$hostedType", "values"], "Encoded hosted Set");
    const values = boundedArray(tagged.values, "Encoded hosted Set values", 250_000);
    const result = new Set<unknown>();
    for (const item of values) {
      const decoded = decodeDurableValue(item, depth + 1, nodes);
      if (result.has(decoded)) throw invalid("Encoded hosted Set contains a duplicate value.");
      result.add(decoded);
    }
    return result;
  }
  if (Object.prototype.hasOwnProperty.call(record, "$hostedType")) throw invalid("Hosted durable state contains an unknown tagged type.");
  const decoded: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) decoded[key] = decodeDurableValue(item, depth + 1, nodes);
  return decoded;
}

function expectMap(value: unknown, label: string): Map<unknown, unknown> {
  if (!(value instanceof Map)) throw invalid(`${label} must be a durable Map.`);
  return value;
}

function expectSet(value: unknown, label: string): Set<unknown> {
  if (!(value instanceof Set)) throw invalid(`${label} must be a durable Set.`);
  return value;
}

function parseSecretCleanupMap(value: unknown): Map<string, SecretCleanupTask> {
  const raw = expectMap(value, "pendingSecretCleanup");
  const parsed = new Map<string, SecretCleanupTask>();
  for (const [key, item] of raw) {
    const secretRef = boundedString(key, "secretRef", 512);
    const record = exactInput(item, ["secretRef", "runtimeInstanceId"], "Secret cleanup task");
    if (record.secretRef !== secretRef) throw invalid("Secret cleanup key does not match its task.");
    parsed.set(secretRef, { secretRef, runtimeInstanceId: instanceId(record.runtimeInstanceId) });
  }
  return parsed;
}

function parseScheduleCleanupMap(value: unknown): Map<string, ScheduleCleanupTask> {
  const raw = expectMap(value, "pendingScheduleCleanup");
  const parsed = new Map<string, ScheduleCleanupTask>();
  for (const [key, item] of raw) {
    const scheduleId = boundedString(key, "scheduleId", 256);
    const record = exactInput(item, ["scheduleId", "runtimeInstanceId"], "Schedule cleanup task");
    if (record.scheduleId !== scheduleId) throw invalid("Schedule cleanup key does not match its task.");
    parsed.set(scheduleId, { scheduleId, runtimeInstanceId: instanceId(record.runtimeInstanceId) });
  }
  return parsed;
}

function parseLeaseCompletionMap(value: unknown): Map<string, LeaseCompletionTask> {
  const raw = expectMap(value, "pendingLeaseCompletions");
  const parsed = new Map<string, LeaseCompletionTask>();
  for (const [key, item] of raw) {
    const leaseId = boundedString(key, "leaseId", 256);
    const record = exactInput(item, ["leaseId", "runtimeInstanceId", "state"], "Lease completion task");
    if (record.leaseId !== leaseId) throw invalid("Lease completion key does not match its task.");
    if (record.state !== "succeeded" && record.state !== "failed" && record.state !== "cancelled") {
      throw invalid("Lease completion state is invalid.");
    }
    parsed.set(leaseId, { leaseId, runtimeInstanceId: instanceId(record.runtimeInstanceId), state: record.state });
  }
  return parsed;
}

function parseExternalAllocationMap(
  value: unknown,
  instances: ReadonlyMap<string, HostedInstance>,
): Map<string, PendingExternalAllocation> {
  const raw = expectMap(value, "pendingExternalAllocations");
  const parsed = new Map<string, PendingExternalAllocation>();
  for (const [key, item] of raw) {
    const operationId = parsePrefixedId(key, /^allocation_[0-9a-f-]{36}$/, "allocation operationId");
    const record = exactInput(item, ["operationId", "kind", "runtimeInstanceId"], "Pending external allocation");
    const runtimeInstanceId = instanceId(record.runtimeInstanceId);
    if (record.operationId !== operationId || (record.kind !== "vault-store" && record.kind !== "schedule-enable")
      || !instances.has(runtimeInstanceId)) {
      throw invalid("Pending external allocation identity, kind, or owner is invalid.");
    }
    parsed.set(operationId, { operationId, kind: record.kind, runtimeInstanceId });
  }
  return parsed;
}

function parsePendingInstanceTransitionMap(
  value: unknown,
  instances: ReadonlyMap<string, HostedInstance>,
): Map<RuntimeInstanceId, PendingInstanceTransition> {
  const raw = expectMap(value, "pendingInstanceTransitions");
  const parsed = new Map<RuntimeInstanceId, PendingInstanceTransition>();
  for (const [key, item] of raw) {
    const runtimeInstanceId = instanceId(key);
    const record = exactInput(item, ["runtimeInstanceId", "marker"], "Pending instance transition");
    if (instanceId(record.runtimeInstanceId) !== runtimeInstanceId) throw invalid("Pending instance transition key does not match its owner.");
    const instance = instances.get(runtimeInstanceId);
    const marker = parseRevocationMarker(record.marker, runtimeInstanceId);
    if (!instance || marker.tenantId !== instance.tenantId || marker.projectId !== instance.projectId
      || marker.cloudProjectId !== instance.cloudProjectId
      || (marker.phase === "delete-pending" && instance.status !== "active" && instance.status !== "suspended")
      || (marker.phase === "purged" && instance.status !== "delete-pending")) {
      throw invalid("Pending instance transition has an invalid phase or hosted identity.");
    }
    const expectedInstallations = new Set([...instance.installations.values()].map((installation) => installation.featureInstallationId));
    const receiptSetMatches = (receipts: readonly Readonly<{ featureInstallationId: FeatureInstallationId }>[]): boolean =>
      receipts.length === expectedInstallations.size && receipts.every((receipt) => expectedInstallations.has(receipt.featureInstallationId));
    if (!receiptSetMatches(marker.deleteReceipts)
      || (marker.phase === "purged" && !receiptSetMatches(marker.purgeReceipts ?? []))) {
      throw invalid("Pending instance transition receipt reservations differ from hosted Feature Installations.");
    }
    parsed.set(runtimeInstanceId, { runtimeInstanceId, marker });
  }
  return parsed;
}

function parsePendingJobClaimMap(
  value: unknown,
  instances: ReadonlyMap<string, HostedInstance>,
  registry: ReadonlyMap<string, RegistryRelease>,
): Map<string, PendingJobClaim> {
  const raw = expectMap(value, "pendingJobClaims");
  const parsed = new Map<string, PendingJobClaim>();
  for (const [key, item] of raw) {
    const operationId = parsePrefixedId(key, /^claim_[0-9a-f-]{36}$/, "claim operationId");
    const record = exactInput(item, ["operationId", "tenantId", "runtimeInstanceId", "featureId", "featureInstallationId", "dataNamespaceId", "releaseDigest", "featureRevisionDigest", "jobId", "declarationId", "networkDeclarationId", "connectionDeclarationId", "connectionId", "scheduleId", "principal", "authority", "acceptedAt"], "Pending job claim");
    const runtimeInstanceId = instanceId(record.runtimeInstanceId);
    const instance = instances.get(runtimeInstanceId);
    const featureId = stableId(record.featureId, "featureId");
    const installation = instance?.installations.get(featureId);
    const featureInstallationId = parseFeatureInstallationIdValue(record.featureInstallationId);
    const dataNamespaceId = parseDataNamespaceIdValue(record.dataNamespaceId);
    const releaseDigest = digest(record.releaseDigest, "releaseDigest");
    const release = registry.get(releaseDigest);
    const releaseFeature = release?.release.manifest.features.find((feature) => feature.featureId === featureId);
    const jobId = stableId(record.jobId, "jobId");
    const job = release?.declarations.get(featureId)?.jobs.find((candidate) => candidate.jobId === jobId);
    if (record.operationId !== operationId || !instance
      || instance.tenantId !== tenant(record.tenantId) || !installation
      || installation.featureInstallationId !== featureInstallationId || installation.dataNamespaceId !== dataNamespaceId
      || !releaseFeature || !job || artifactDigest(record.featureRevisionDigest, "featureRevisionDigest") !== releaseFeature.featureRevision.digest
      || record.declarationId !== job.jobId || record.networkDeclarationId !== job.networkDeclarationId
      || record.connectionDeclarationId !== job.connectionDeclarationId) {
      throw invalid("Pending job claim has an invalid exact instance, Release, or declaration identity.");
    }
    parsed.set(operationId, {
      operationId,
      tenantId: instance.tenantId,
      runtimeInstanceId,
      featureId,
      featureInstallationId,
      dataNamespaceId,
      releaseDigest,
      featureRevisionDigest: releaseFeature.featureRevision.digest,
      jobId,
      declarationId: job.jobId,
      networkDeclarationId: job.networkDeclarationId,
      connectionDeclarationId: job.connectionDeclarationId,
      connectionId: parseConnectionId(record.connectionId),
      scheduleId: boundedString(record.scheduleId, "scheduleId", 256),
      principal: parseEffectivePrincipal(record.principal),
      authority: parseAuthorityStamp(record.authority),
      acceptedAt: parseTimestampValue(record.acceptedAt, "acceptedAt"),
    });
  }
  return parsed;
}

function parseRevocationMarker(value: unknown, expectedInstanceId?: RuntimeInstanceId): Readonly<HostedInstanceRevocationMarker> {
  const record = expectRecord(value, "Instance revocation marker");
  expectOnlyKeys(record, ["revocationId", "tenantId", "projectId", "cloudProjectId", "runtimeInstanceId", "tombstonedAt", "effectivePrincipal", "deleteReceipts", "phase", "purgedAt", "purgedBy", "purgeReceipts"], "Instance revocation marker");
  for (const required of ["revocationId", "tenantId", "projectId", "cloudProjectId", "runtimeInstanceId", "tombstonedAt", "effectivePrincipal", "deleteReceipts", "phase"] as const) {
    if (!Object.prototype.hasOwnProperty.call(record, required)) throw invalid(`Instance revocation marker is missing ${required}.`);
  }
  const runtimeInstanceId = instanceId(record.runtimeInstanceId);
  if (expectedInstanceId !== undefined && runtimeInstanceId !== expectedInstanceId) {
    throw invalid("Instance revocation marker belongs to another App Instance.");
  }
  if (record.phase !== "delete-pending" && record.phase !== "purged") {
    throw invalid("Instance revocation marker phase is invalid.");
  }
  const purgedAt = record.purgedAt === undefined ? undefined : parseTimestampValue(record.purgedAt, "purgedAt");
  const purgedBy = record.purgedBy === undefined ? undefined : parseEffectivePrincipal(record.purgedBy);
  const deleteReceipts = parseRevocationReceiptReservations(record.deleteReceipts, "deleteReceipts");
  const purgeReceipts = record.purgeReceipts === undefined
    ? undefined
    : parseRevocationReceiptReservations(record.purgeReceipts, "purgeReceipts");
  if ((record.phase === "purged" && (purgedAt === undefined || purgedBy === undefined))
    || (record.phase === "purged" && purgeReceipts === undefined)
    || (record.phase === "delete-pending" && (purgedAt !== undefined || purgedBy !== undefined || purgeReceipts !== undefined))) {
    throw invalid("Instance revocation marker purge phase and identity disagree.");
  }
  const receiptIds = [...deleteReceipts, ...(purgeReceipts ?? [])].map((receipt) => receipt.receiptId);
  if (new Set(receiptIds).size !== receiptIds.length) throw invalid("Instance revocation marker receipt reservations are duplicated.");
  return deepFreeze({
    revocationId: parsePrefixedId(record.revocationId, /^revocation_[0-9a-f-]{36}$/, "revocationId"),
    tenantId: tenant(record.tenantId),
    projectId: project(record.projectId),
    cloudProjectId: cloudProject(record.cloudProjectId),
    runtimeInstanceId,
    tombstonedAt: parseTimestampValue(record.tombstonedAt, "tombstonedAt"),
    effectivePrincipal: parseEffectivePrincipal(record.effectivePrincipal),
    deleteReceipts,
    phase: record.phase,
    ...(purgedAt === undefined ? {} : { purgedAt, purgedBy: purgedBy!, purgeReceipts: purgeReceipts! }),
  });
}

function parseRevocationReceiptReservations(
  value: unknown,
  label: string,
): readonly Readonly<{ featureInstallationId: FeatureInstallationId; receiptId: string }>[] {
  const values = boundedArray(value, label, 64);
  const installations = new Set<FeatureInstallationId>();
  const parsed = values.map((item, index) => {
    const record = exactInput(item, ["featureInstallationId", "receiptId"], `${label}[${index}]`);
    const featureInstallationId = parseFeatureInstallationIdValue(record.featureInstallationId);
    if (installations.has(featureInstallationId)) throw invalid(`${label} duplicates a Feature Installation.`);
    installations.add(featureInstallationId);
    return deepFreeze({ featureInstallationId, receiptId: parseReceiptIdValue(record.receiptId, "receiptId") });
  });
  return deepFreeze(parsed);
}

function durableByteLength(value: unknown): number {
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch (error) { throw invalid(`Hosted durable state cannot be serialized: ${message(error)}`); }
  if (serialized === undefined) throw invalid("Hosted durable state cannot be serialized.");
  return new TextEncoder().encode(serialized).byteLength;
}

function expectArrayValue(value: unknown, label: string): unknown[] {
  return boundedArray(value, label, 250_000);
}

function validateStoredDeclarationProjection(
  value: unknown,
  expected: ReadonlyMap<string, HostedFeatureDeclaration>,
): void {
  const stored = expectMap(value, "Stored declaration projection");
  if (stored.size !== expected.size) throw invalid("Stored declaration projection has the wrong Feature set.");
  for (const [featureId, declaration] of expected) {
    if (!stored.has(featureId)
      || canonicalizeJson(stored.get(featureId)) !== canonicalizeJson(declaration)) {
      throw invalid("Stored declaration projection does not match the verified immutable Release.");
    }
  }
}

function parseStoredInstances(
  value: unknown,
  registry: ReadonlyMap<string, RegistryRelease>,
  cloudBindings: ReadonlyMap<unknown, unknown>,
): Map<string, HostedInstance> {
  const raw = expectMap(value, "instances");
  const result = new Map<string, HostedInstance>();
  const installationIds = new Set<string>();
  const namespaceIds = new Set<string>();
  const secretRefs = new Set<string>();
  for (const [key, rawInstance] of raw) {
    const runtimeInstanceId = instanceId(key);
    const record = expectRecord(rawInstance, "Stored hosted instance");
    expectOnlyKeys(record, ["runtimeInstanceId", "tenantId", "projectId", "cloudProjectId", "releaseDigest", "status", "createdAt", "installations", "instanceRoles", "deletedAt", "revocationId", "purgedAt"], "Stored hosted instance");
    for (const required of ["runtimeInstanceId", "tenantId", "projectId", "cloudProjectId", "releaseDigest", "status", "createdAt", "installations", "instanceRoles"] as const) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) throw invalid(`Stored hosted instance is missing ${required}.`);
    }
    if (instanceId(record.runtimeInstanceId) !== runtimeInstanceId) throw invalid("Stored instance key does not match runtimeInstanceId.");
    const tenantId = tenant(record.tenantId);
    const projectId = project(record.projectId);
    const cloudProjectId = cloudProject(record.cloudProjectId);
    if (cloudBindings.get(projectId) !== cloudProjectId) throw invalid("Stored instance cloud Project binding is stale.");
    const releaseDigest = digest(record.releaseDigest, "releaseDigest");
    const releaseEntry = registry.get(releaseDigest);
    if (!releaseEntry || releaseEntry.release.manifest.projectId !== projectId || !releaseEntry.publishedAt) {
      throw invalid("Stored instance Release is unavailable, unpublished, or belongs to another Project.");
    }
    const status = parseInstanceStatus(record.status);
    const createdAt = parseTimestampValue(record.createdAt, "createdAt");
    const deletedAt = record.deletedAt === undefined ? undefined : parseTimestampValue(record.deletedAt, "deletedAt");
    const revocationId = record.revocationId === undefined ? undefined
      : parsePrefixedId(record.revocationId, /^revocation_[0-9a-f-]{36}$/, "revocationId");
    const purgedAt = record.purgedAt === undefined ? undefined : parseTimestampValue(record.purgedAt, "purgedAt");
    if ((status === "active" || status === "suspended") && (deletedAt || revocationId || purgedAt)) {
      throw invalid("A live stored instance cannot contain deletion or purge fields.");
    }
    if ((status === "delete-pending" || status === "purged") && (!deletedAt || !revocationId)) {
      throw invalid("A deleted stored instance requires its deletion timestamp and revocation id.");
    }
    if ((status === "purged") !== (purgedAt !== undefined)) throw invalid("Stored purge status and timestamp disagree.");
    const instanceRoles = parseStoredInstanceRoles(record.instanceRoles);
    const installationsRaw = expectMap(record.installations, "Stored Feature Installations");
    const manifestFeatures = new Map(releaseEntry.release.manifest.features.map((feature) => [feature.featureId, feature]));
    if (installationsRaw.size !== manifestFeatures.size) throw invalid("Stored Feature Installation set differs from the active Release.");
    const installations = new Map<string, HostedFeatureInstallation>();
    let instanceRecordCount = 0;
    for (const [featureKey, rawInstallation] of installationsRaw) {
      const featureId = stableId(featureKey, "featureId");
      const feature = manifestFeatures.get(featureId);
      const declaration = releaseEntry.declarations.get(featureId);
      if (!feature || !declaration) throw invalid("Stored Feature Installation is absent from the active Release.");
      const parsed = parseStoredInstallation(rawInstallation, {
        runtimeInstanceId,
        feature,
        declaration,
        status,
        installationIds,
        namespaceIds,
        secretRefs,
      });
      installations.set(featureId, parsed.installation);
      instanceRecordCount += parsed.recordCount;
    }
    if (instanceRecordCount > maximumRecordsPerInstance) throw invalid("Stored instance exceeds its data record quota.");
    result.set(runtimeInstanceId, {
      runtimeInstanceId,
      tenantId,
      projectId,
      cloudProjectId,
      releaseDigest,
      status,
      createdAt,
      installations,
      instanceRoles,
      ...(deletedAt === undefined ? {} : { deletedAt }),
      ...(revocationId === undefined ? {} : { revocationId }),
      ...(purgedAt === undefined ? {} : { purgedAt }),
    });
  }
  return result;
}

function parseStoredInstallation(
  value: unknown,
  context: Readonly<{
    runtimeInstanceId: RuntimeInstanceId;
    feature: AppReleaseFeature;
    declaration: HostedFeatureDeclaration;
    status: HostedInstanceStatus;
    installationIds: Set<string>;
    namespaceIds: Set<string>;
    secretRefs: Set<string>;
  }>,
): Readonly<{ installation: HostedFeatureInstallation; recordCount: number }> {
  const record = exactInput(value, ["featureId", "featureInstallationId", "dataNamespaceId", "featureRevisionDigest", "declarationDigest", "dataSchemaIdentity", "authority", "networkGrants", "connections", "jobs", "dataCollections"], "Stored Feature Installation");
  const featureId = stableId(record.featureId, "featureId");
  if (featureId !== context.feature.featureId) throw invalid("Stored Feature Installation key or id does not match the active Release.");
  const featureInstallationId = parseFeatureInstallationIdValue(record.featureInstallationId);
  const dataNamespaceId = parseDataNamespaceIdValue(record.dataNamespaceId);
  if (context.installationIds.has(featureInstallationId) || context.namespaceIds.has(dataNamespaceId)) {
    throw invalid("Stored Feature or data namespace identity is reused.");
  }
  context.installationIds.add(featureInstallationId);
  context.namespaceIds.add(dataNamespaceId);
  const featureRevisionDigest = artifactDigest(record.featureRevisionDigest, "featureRevisionDigest");
  const declarationDigest = digest(record.declarationDigest, "declarationDigest");
  const schemaIdentity = record.dataSchemaIdentity === null ? null : boundedString(record.dataSchemaIdentity, "dataSchemaIdentity", 512);
  if (featureRevisionDigest !== context.feature.featureRevision.digest
    || declarationDigest !== context.feature.declaration.digest
    || schemaIdentity !== dataSchemaIdentity(context.feature)) {
    throw invalid("Stored Feature revision projection differs from the active Release.");
  }
  const authority = parseAuthorityStamp(record.authority);
  const networkGrants = parseStoredNetworkGrants(record.networkGrants, context.declaration);
  const connections = parseStoredConnections(record.connections, {
    runtimeInstanceId: context.runtimeInstanceId,
    featureRevisionDigest,
    declarationDigest,
    declaration: context.declaration,
    networkGrants,
    secretRefs: context.secretRefs,
  });
  const jobs = parseStoredJobs(record.jobs, context.declaration);
  const data = parseStoredCollections(record.dataCollections, context.declaration, context.status);
  if (context.status === "delete-pending" || context.status === "purged") {
    if (networkGrants.size !== 0 || connections.size !== 0 || [...jobs.values()].some((job) => job.enabled || job.scheduleId)) {
      throw invalid("A deleted stored instance retains active runtime authority.");
    }
  }
  return {
    installation: {
      featureId,
      featureInstallationId,
      dataNamespaceId,
      featureRevisionDigest,
      declarationDigest,
      dataSchemaIdentity: schemaIdentity,
      authority,
      networkGrants,
      connections,
      jobs,
      dataCollections: data.collections,
    },
    recordCount: data.recordCount,
  };
}

function parseStoredNetworkGrants(value: unknown, declaration: HostedFeatureDeclaration): Map<string, NetworkGrant> {
  const raw = expectMap(value, "Stored network grants");
  const result = new Map<string, NetworkGrant>();
  for (const [key, item] of raw) {
    const declarationId = stableId(key, "declarationId");
    const reviewed = declaration.networkDestinations.find((candidate) => candidate.declarationId === declarationId);
    if (!reviewed) throw invalid("Stored network grant is not declared by the active Release.");
    const record = exactInput(item, ["declarationId", "origin", "grantedAt", "grantedBy"], "Stored network grant");
    if (record.declarationId !== declarationId || parseHostedOrigin(record.origin) !== reviewed.origin) {
      throw invalid("Stored network grant identity differs from its reviewed declaration.");
    }
    result.set(declarationId, {
      declarationId,
      origin: reviewed.origin,
      grantedAt: parseTimestampValue(record.grantedAt, "grantedAt"),
      grantedBy: actorId(record.grantedBy),
    });
  }
  return result;
}

function parseStoredConnections(value: unknown, context: Readonly<{
  runtimeInstanceId: RuntimeInstanceId;
  featureRevisionDigest: AppPlatformArtifactDigest;
  declarationDigest: Sha256Digest;
  declaration: HostedFeatureDeclaration;
  networkGrants: ReadonlyMap<string, NetworkGrant>;
  secretRefs: Set<string>;
}>): Map<string, InstanceConnection> {
  const raw = expectMap(value, "Stored instance connections");
  if (raw.size > context.declaration.connections.length) {
    throw invalid("Stored instance connections exceed the reviewed declaration set.");
  }
  const result = new Map<string, InstanceConnection>();
  const boundDeclarations = new Set<string>();
  for (const [key, item] of raw) {
    const connectionId = parseConnectionId(key);
    const record = exactInput(item, ["connectionId", "declarationId", "networkDeclarationId", "origin", "targetIdentity", "authKind", "featureRevisionDigest", "declarationDigest", "owner", "secretRef", "boundAt", "boundBy"], "Stored instance connection");
    if (record.connectionId !== connectionId) throw invalid("Stored connection key does not match connectionId.");
    const declarationId = stableId(record.declarationId, "declarationId");
    const reviewed = context.declaration.connections.find((candidate) => candidate.declarationId === declarationId);
    if (!reviewed) throw invalid("Stored connection is absent from the reviewed declaration.");
    if (boundDeclarations.has(declarationId)) {
      throw invalid("Stored connection declaration is bound more than once.");
    }
    boundDeclarations.add(declarationId);
    const networkDeclarationId = stableId(record.networkDeclarationId, "networkDeclarationId");
    const grant = context.networkGrants.get(networkDeclarationId);
    const origin = parseHostedOrigin(record.origin);
    const targetIdentity = parseHostedOrigin(record.targetIdentity);
    if (reviewed.networkDeclarationId !== networkDeclarationId || !grant || grant.origin !== origin
      || targetIdentity !== origin || record.authKind !== reviewed.authKind
      || artifactDigest(record.featureRevisionDigest, "featureRevisionDigest") !== context.featureRevisionDigest
      || digest(record.declarationDigest, "declarationDigest") !== context.declarationDigest) {
      throw invalid("Stored connection does not match its exact reviewed target and revision identity.");
    }
    const owner = exactInput(record.owner, ["kind", "runtimeInstanceId"], "Stored connection owner");
    if (owner.kind !== "instance" || instanceId(owner.runtimeInstanceId) !== context.runtimeInstanceId) {
      throw invalid("Stored connection owner is invalid.");
    }
    const secretRef = boundedString(record.secretRef, "secretRef", 512);
    if (context.secretRefs.has(secretRef)) throw invalid("Stored vault reference is bound to more than one connection.");
    context.secretRefs.add(secretRef);
    result.set(connectionId, {
      connectionId,
      declarationId,
      networkDeclarationId,
      origin,
      targetIdentity,
      authKind: reviewed.authKind,
      featureRevisionDigest: context.featureRevisionDigest,
      declarationDigest: context.declarationDigest,
      owner: { kind: "instance", runtimeInstanceId: context.runtimeInstanceId },
      secretRef,
      boundAt: parseTimestampValue(record.boundAt, "boundAt"),
      boundBy: actorId(record.boundBy),
    });
  }
  return result;
}

function parseStoredJobs(value: unknown, declaration: HostedFeatureDeclaration): Map<string, InstanceJob> {
  const raw = expectMap(value, "Stored named jobs");
  if (raw.size !== declaration.jobs.length) throw invalid("Stored named job set differs from the reviewed declaration.");
  const result = new Map<string, InstanceJob>();
  for (const reviewed of declaration.jobs) {
    const item = raw.get(reviewed.jobId);
    if (item === undefined) throw invalid("Stored named job set differs from the reviewed declaration.");
    const record = expectRecord(item, "Stored named job");
    expectOnlyKeys(record, ["jobId", "enabled", "enabledAt", "enabledBy", "scheduleId"], "Stored named job");
    if (record.jobId !== reviewed.jobId || typeof record.enabled !== "boolean") throw invalid("Stored named job identity or state is invalid.");
    const enabledAt = record.enabledAt === undefined ? undefined : parseTimestampValue(record.enabledAt, "enabledAt");
    const enabledBy = record.enabledBy === undefined ? undefined : actorId(record.enabledBy);
    if ((enabledAt === undefined) !== (enabledBy === undefined)) throw invalid("Stored named job enable identity and timestamp disagree.");
    const scheduleId = record.scheduleId === undefined ? undefined : boundedString(record.scheduleId, "scheduleId", 256);
    if (record.enabled ? scheduleId === undefined || enabledAt === undefined : scheduleId !== undefined) {
      throw invalid("Stored named job enabled state and schedule disagree.");
    }
    result.set(reviewed.jobId, {
      jobId: reviewed.jobId,
      enabled: record.enabled,
      ...(enabledAt === undefined ? {} : { enabledAt }),
      ...(enabledBy === undefined ? {} : { enabledBy }),
      ...(scheduleId === undefined ? {} : { scheduleId }),
    });
  }
  return result;
}

function parseStoredCollections(
  value: unknown,
  declaration: HostedFeatureDeclaration,
  status: HostedInstanceStatus,
): Readonly<{ collections: Map<string, HostedDataCollection>; recordCount: number }> {
  const raw = expectMap(value, "Stored data collections");
  if (raw.size !== declaration.collections.length) throw invalid("Stored data collection set differs from the reviewed declaration.");
  const collections = new Map<string, HostedDataCollection>();
  let recordCount = 0;
  for (const reviewed of declaration.collections) {
    const item = raw.get(reviewed.collectionId);
    if (item === undefined) throw invalid("Stored data collection set differs from the reviewed declaration.");
    const record = exactInput(item, ["collectionId", "ownerClass", "partitions"], "Stored data collection");
    if (record.collectionId !== reviewed.collectionId || record.ownerClass !== reviewed.ownerClass) {
      throw invalid("Stored data collection ownership differs from the reviewed declaration.");
    }
    const partitionsRaw = expectMap(record.partitions, "Stored data partitions");
    const partitions = new Map<string, Map<string, HostedDataRecord>>();
    for (const [partitionKey, recordsValue] of partitionsRaw) {
      const partitionId = parsePartitionId(partitionKey, reviewed.ownerClass);
      const recordsRaw = expectMap(recordsValue, "Stored data record partition");
      if (recordsRaw.size > maximumRecordsPerPartition) throw invalid("Stored data partition exceeds its record quota.");
      const records = new Map<string, HostedDataRecord>();
      for (const [recordKey, rawRecord] of recordsRaw) {
        const recordId = stableId(recordKey, "recordId");
        const dataRecord = exactInput(rawRecord, ["recordId", "revision", "value", "updatedAt", "updatedBy"], "Stored data record");
        if (dataRecord.recordId !== recordId || !Number.isSafeInteger(dataRecord.revision) || (dataRecord.revision as number) < 1) {
          throw invalid("Stored data record identity or revision is invalid.");
        }
        records.set(recordId, {
          recordId,
          revision: dataRecord.revision as number,
          value: boundedJson(dataRecord.value, "stored data value"),
          updatedAt: parseTimestampValue(dataRecord.updatedAt, "updatedAt"),
          updatedBy: actorId(dataRecord.updatedBy),
        });
      }
      if (status === "purged" && records.size !== 0) throw invalid("A purged stored instance retains data records.");
      recordCount += records.size;
      partitions.set(partitionId, records);
    }
    collections.set(reviewed.collectionId, {
      collectionId: reviewed.collectionId,
      ownerClass: reviewed.ownerClass,
      partitions,
    });
  }
  return { collections, recordCount };
}

function parseStoredInstanceRoles(value: unknown): Map<string, Set<string>> {
  const raw = expectMap(value, "Stored instance roles");
  const result = new Map<string, Set<string>>();
  for (const [key, rolesValue] of raw) {
    const principalId = actorId(key);
    const rolesRaw = expectSet(rolesValue, "Stored Principal instance roles");
    if (rolesRaw.size === 0 || rolesRaw.size > 64) throw invalid("Stored Principal instance roles have an invalid count.");
    const roles = new Set<string>();
    for (const role of rolesRaw) roles.add(stableId(role, "roleId"));
    result.set(principalId, roles);
  }
  return result;
}

function parsePendingMutations(
  value: unknown,
  instances: ReadonlyMap<string, HostedInstance>,
  registry: ReadonlyMap<string, RegistryRelease>,
): Map<string, PendingDataMutation> {
  const raw = expectMap(value, "pendingDataMutations");
  const result = new Map<string, PendingDataMutation>();
  const perPrincipal = new Map<string, number>();
  const perInstance = new Map<string, number>();
  for (const [key, mutationValue] of raw) {
    const mutationId = parseMutationId(key);
    const record = expectRecord(mutationValue, "Stored pending data mutation");
    expectOnlyKeys(record, ["mutationId", "runtimeInstanceId", "featureId", "featureInstallationId", "collectionId", "partitionId", "action", "recordId", "expectedRevision", "value", "principal", "authority", "preparedAt", "expiresAt"], "Stored pending data mutation");
    for (const required of ["mutationId", "runtimeInstanceId", "featureId", "featureInstallationId", "collectionId", "partitionId", "action", "recordId", "expectedRevision", "principal", "authority", "preparedAt", "expiresAt"] as const) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) throw invalid(`Stored pending data mutation is missing ${required}.`);
    }
    if (record.mutationId !== mutationId || (record.action !== "create" && record.action !== "update" && record.action !== "delete")) {
      throw invalid("Stored pending data mutation identity or action is invalid.");
    }
    const runtimeInstanceId = instanceId(record.runtimeInstanceId);
    const instance = instances.get(runtimeInstanceId);
    const featureId = stableId(record.featureId, "featureId");
    const installation = instance?.installations.get(featureId);
    const featureInstallationId = parseFeatureInstallationIdValue(record.featureInstallationId);
    if (!instance || instance.status === "purged" || !installation || installation.featureInstallationId !== featureInstallationId) {
      throw invalid("Stored pending data mutation refers to an unavailable Feature Installation.");
    }
    const collectionId = stableId(record.collectionId, "collectionId");
    const declaration = registry.get(instance.releaseDigest)?.declarations.get(featureId)?.collections
      .find((item) => item.collectionId === collectionId);
    const partitionId = boundedString(record.partitionId, "partitionId", 256);
    if (!declaration || parsePartitionId(partitionId, declaration.ownerClass) !== partitionId) {
      throw invalid("Stored pending data mutation refers to an invalid data partition.");
    }
    const action = record.action;
    const expectedRevision = parseExpectedRevision(record.expectedRevision, action);
    if (action === "delete" ? record.value !== undefined : !Object.prototype.hasOwnProperty.call(record, "value")) {
      throw invalid("Stored pending data mutation value does not match its action.");
    }
    const principal = parseEffectivePrincipal(record.principal);
    if (!declaration.allowedActions.includes(action)) throw invalid("Stored pending data mutation action is not allowed by its declaration.");
    if (declaration.ownerClass === "principal" && partitionId !== principal.principalId) {
      throw invalid("Stored Principal-owned mutation partition differs from its captured Principal.");
    }
    const preparedAt = parseTimestampValue(record.preparedAt, "preparedAt");
    const expiresAt = parseTimestampValue(record.expiresAt, "expiresAt");
    if (Date.parse(expiresAt) - Date.parse(preparedAt) !== pendingMutationTtlMs) throw invalid("Stored pending data mutation TTL is invalid.");
    const principalKey = `${runtimeInstanceId}\u0000${principal.principalId}`;
    perPrincipal.set(principalKey, (perPrincipal.get(principalKey) ?? 0) + 1);
    perInstance.set(runtimeInstanceId, (perInstance.get(runtimeInstanceId) ?? 0) + 1);
    if (perPrincipal.get(principalKey)! > maximumPendingMutationsPerPrincipal
      || perInstance.get(runtimeInstanceId)! > maximumPendingMutationsPerInstance) {
      throw invalid("Stored pending data mutations exceed their quota.");
    }
    result.set(mutationId, {
      mutationId,
      runtimeInstanceId,
      featureId,
      featureInstallationId,
      collectionId,
      partitionId,
      action,
      recordId: stableId(record.recordId, "recordId"),
      expectedRevision,
      ...(action === "delete" ? {} : { value: boundedJson(record.value, "stored mutation value") }),
      principal,
      authority: parseAuthorityStamp(record.authority),
      preparedAt,
      expiresAt,
    });
  }
  return result;
}

function parseStoredUpdateReviews(
  value: unknown,
  instances: ReadonlyMap<string, HostedInstance>,
  registry: ReadonlyMap<string, RegistryRelease>,
): Map<string, StoredUpdateReview> {
  const raw = expectMap(value, "updateReviews");
  const result = new Map<string, StoredUpdateReview>();
  const reviewedInstances = new Set<RuntimeInstanceId>();
  for (const [key, item] of raw) {
    const updateId = parsePrefixedId(key, updateIdPattern, "updateId");
    const record = exactInput(item, ["updateId", "runtimeInstanceId", "fromReleaseDigest", "toReleaseDigest", "reviewedBy", "reviewedAt", "capturedAuthorities", "decisions"], "Stored update review");
    if (record.updateId !== updateId) throw invalid("Stored update review key does not match updateId.");
    const runtimeInstanceId = instanceId(record.runtimeInstanceId);
    if (reviewedInstances.has(runtimeInstanceId)) throw invalid("Stored update reviews duplicate an App Instance.");
    reviewedInstances.add(runtimeInstanceId);
    const instance = instances.get(runtimeInstanceId);
    const fromReleaseDigest = digest(record.fromReleaseDigest, "fromReleaseDigest");
    const toReleaseDigest = digest(record.toReleaseDigest, "toReleaseDigest");
    const from = registry.get(fromReleaseDigest);
    const to = registry.get(toReleaseDigest);
    if (!instance || instance.status !== "active" || instance.releaseDigest !== fromReleaseDigest
      || !from || !to?.publishedAt || from.release.manifest.projectId !== instance.projectId
      || to.release.manifest.projectId !== instance.projectId) {
      throw invalid("Stored update review does not describe the active instance and a published Project Release.");
    }
    if (from.release.manifest.features.length !== to.release.manifest.features.length
      || from.release.manifest.features.some((feature, index) => feature.featureId !== to.release.manifest.features[index]?.featureId)) {
      throw invalid("Stored update review changes the Feature set.");
    }
    const capturedRaw = expectMap(record.capturedAuthorities, "Stored update captured authorities");
    if (capturedRaw.size !== instance.installations.size) throw invalid("Stored update authority projection has the wrong Feature set.");
    const capturedAuthorities = new Map<string, Readonly<AuthorityStamp>>();
    for (const featureId of instance.installations.keys()) {
      if (!capturedRaw.has(featureId)) throw invalid("Stored update authority projection has the wrong Feature set.");
      capturedAuthorities.set(featureId, parseAuthorityStamp(capturedRaw.get(featureId)));
    }
    const decisionsRaw = boundedArray(record.decisions, "Stored update decisions", 64);
    if (decisionsRaw.length !== instance.installations.size) throw invalid("Stored update decision set has the wrong Feature set.");
    const decisions: HostedUpdateFeatureDecision[] = decisionsRaw.map((decisionValue, index) => {
      const decision = exactInput(decisionValue, ["featureId", "revision", "grants", "connections", "jobs", "data"], `Stored update decision ${index}`);
      const featureId = stableId(decision.featureId, "featureId");
      const fromFeature = from.release.manifest.features.find((feature) => feature.featureId === featureId);
      const toFeature = to.release.manifest.features.find((feature) => feature.featureId === featureId);
      if (!fromFeature || !toFeature || decision.data !== "compatible") throw invalid("Stored update decision Feature or data policy is invalid.");
      if (dataSchemaIdentity(fromFeature) !== dataSchemaIdentity(toFeature)
        || canonicalizeJson(from.declarations.get(featureId)!.collections) !== canonicalizeJson(to.declarations.get(featureId)!.collections)) {
        throw invalid("Stored update review claims compatibility across a schema or data-policy change.");
      }
      const unchanged = sameFeatureAuthoritySurface(fromFeature, toFeature);
      const expectedRevision = unchanged ? "unchanged" : "changed";
      const expectedPolicy = unchanged ? "eligible-to-retain" : "reset";
      if (decision.revision !== expectedRevision || decision.grants !== expectedPolicy
        || decision.connections !== expectedPolicy || decision.jobs !== expectedPolicy) {
        throw invalid("Stored update decision differs from the verified Release transition.");
      }
      return { featureId, revision: expectedRevision, grants: expectedPolicy, connections: expectedPolicy, jobs: expectedPolicy, data: "compatible" };
    });
    assertOrderedUnique(decisions, (decision) => decision.featureId, "Stored update decisions");
    result.set(updateId, {
      updateId,
      runtimeInstanceId,
      fromReleaseDigest,
      toReleaseDigest,
      reviewedBy: parseEffectivePrincipal(record.reviewedBy),
      reviewedAt: parseTimestampValue(record.reviewedAt, "reviewedAt"),
      capturedAuthorities,
      decisions: deepFreeze(decisions),
    });
  }
  return result;
}

const hostedManagementActions: readonly HostedManagementAction[] = [
  "cloud-project-bound", "release-reviewed", "release-published", "instance-deployed", "network-granted",
  "network-revoked", "connection-bound", "connection-disconnected", "job-enabled", "job-disabled",
  "instance-role-assigned", "instance-role-removed", "update-reviewed", "update-activated", "instance-suspended",
  "instance-resumed", "principal-revoked", "principal-data-exported", "instance-exported",
  "instance-delete-requested", "instance-purged",
];

function parseManagementReceipts(
  value: unknown,
  instances: ReadonlyMap<string, HostedInstance>,
  registry: ReadonlyMap<string, RegistryRelease>,
): HostedManagementReceipt[] {
  const raw = expectArrayValue(value, "managementReceipts");
  const seen = new Set<string>();
  return raw.map((item, index) => {
    const record = expectRecord(item, `Management receipt ${index}`);
    const allowed = ["receiptId", "kind", "action", "effectivePrincipal", "acceptedAt", "state", "projectId", "cloudProjectId", "tenantId", "runtimeInstanceId", "featureInstallationId", "authority", "releaseDigest", "predecessorReleaseDigest", "featureId", "declarationId", "connectionId", "jobId", "scheduleId", "collectionId", "recordId", "dataAction", "updateId", "roleId", "affectedPrincipalId"];
    expectOnlyKeys(record, allowed, `Management receipt ${index}`);
    for (const required of ["receiptId", "kind", "action", "effectivePrincipal", "acceptedAt", "state"] as const) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) throw invalid(`Management receipt ${index} is missing ${required}.`);
    }
    const receiptId = parseReceiptId(record.receiptId, seen);
    if (record.kind !== "admin-transition" || record.state !== "succeeded"
      || typeof record.action !== "string" || !hostedManagementActions.includes(record.action as HostedManagementAction)) {
      throw invalid("Stored management receipt kind, action, or state is invalid.");
    }
    if (record.projectId !== undefined) project(record.projectId);
    if (record.cloudProjectId !== undefined) cloudProject(record.cloudProjectId);
    if (record.tenantId !== undefined) tenant(record.tenantId);
    if (record.runtimeInstanceId !== undefined && !instances.has(instanceId(record.runtimeInstanceId))) throw invalid("Stored management receipt refers to an unknown instance.");
    if (record.featureInstallationId !== undefined) parseFeatureInstallationIdValue(record.featureInstallationId);
    if (record.authority !== undefined) parseAuthorityStamp(record.authority);
    if (record.releaseDigest !== undefined && !registry.has(digest(record.releaseDigest, "releaseDigest"))) throw invalid("Stored management receipt refers to an unknown Release.");
    if (record.predecessorReleaseDigest !== undefined && !registry.has(digest(record.predecessorReleaseDigest, "predecessorReleaseDigest"))) throw invalid("Stored management receipt refers to an unknown predecessor Release.");
    if (record.featureId !== undefined) stableId(record.featureId, "featureId");
    if (record.declarationId !== undefined) stableId(record.declarationId, "declarationId");
    if (record.connectionId !== undefined) parseConnectionId(record.connectionId);
    if (record.jobId !== undefined) stableId(record.jobId, "jobId");
    if (record.scheduleId !== undefined) boundedString(record.scheduleId, "scheduleId", 256);
    if (record.collectionId !== undefined) stableId(record.collectionId, "collectionId");
    if (record.recordId !== undefined) stableId(record.recordId, "recordId");
    if (record.dataAction !== undefined && !["list", "read", "create", "update", "delete"].includes(record.dataAction as string)) throw invalid("Stored management receipt has an invalid data action.");
    if (record.updateId !== undefined) parsePrefixedId(record.updateId, updateIdPattern, "updateId");
    if (record.roleId !== undefined) stableId(record.roleId, "roleId");
    if (record.affectedPrincipalId !== undefined) actorId(record.affectedPrincipalId);
    parseEffectivePrincipal(record.effectivePrincipal);
    parseTimestampValue(record.acceptedAt, "acceptedAt");
    return deepFreeze({ ...record, receiptId }) as unknown as HostedManagementReceipt;
  });
}

function parseJobReceipts(
  value: unknown,
  instances: ReadonlyMap<string, HostedInstance>,
  registry: ReadonlyMap<string, RegistryRelease>,
): HostedJobReceipt[] {
  const raw = expectArrayValue(value, "runtimeReceipts");
  const seen = new Set<string>();
  return raw.map((item, index) => {
    const record = expectRecord(item, `Job receipt ${index}`);
    const allowed = ["receiptId", "kind", "tenantId", "runtimeInstanceId", "featureInstallationId", "dataNamespaceId", "releaseDigest", "featureRevisionDigest", "jobId", "declarationId", "networkDeclarationId", "connectionDeclarationId", "connectionId", "scheduleId", "leaseId", "claimOperationId", "effectivePrincipal", "authority", "acceptedAt", "startedAt", "finishedAt", "state", "error", "parentReceiptId", "occurrenceId", "runId", "attemptId"];
    expectOnlyKeys(record, allowed, `Job receipt ${index}`);
    for (const required of ["receiptId", "kind", "tenantId", "runtimeInstanceId", "featureInstallationId", "dataNamespaceId", "releaseDigest", "featureRevisionDigest", "jobId", "declarationId", "networkDeclarationId", "connectionDeclarationId", "connectionId", "scheduleId", "leaseId", "claimOperationId", "effectivePrincipal", "authority", "acceptedAt", "state", "occurrenceId", "runId", "attemptId"] as const) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) throw invalid(`Job receipt ${index} is missing ${required}.`);
    }
    const receiptId = parseReceiptId(record.receiptId, seen);
    if (record.kind !== "job" || (record.state !== "accepted" && record.state !== "succeeded"
      && record.state !== "failed" && record.state !== "cancelled")) {
      throw invalid("Stored job receipt kind or state is invalid.");
    }
    const runtimeInstanceId = instanceId(record.runtimeInstanceId);
    const instance = instances.get(runtimeInstanceId);
    const releaseDigest = digest(record.releaseDigest, "releaseDigest");
    const release = registry.get(releaseDigest);
    const featureInstallationId = parseFeatureInstallationIdValue(record.featureInstallationId);
    const installation = instance?.installations.get(stableReceiptFeatureId(featureInstallationId, instance));
    if (!instance || !release || instance.tenantId !== tenant(record.tenantId) || !installation
      || installation.dataNamespaceId !== parseDataNamespaceIdValue(record.dataNamespaceId)) {
      throw invalid("Stored job receipt instance or Feature identity is invalid.");
    }
    const feature = release.release.manifest.features.find((candidate) => candidate.featureId === installation.featureId);
    const declaration = release.declarations.get(installation.featureId);
    const jobId = stableId(record.jobId, "jobId");
    const job = declaration?.jobs.find((candidate) => candidate.jobId === jobId);
    if (!feature || !job || artifactDigest(record.featureRevisionDigest, "featureRevisionDigest") !== feature.featureRevision.digest
      || record.declarationId !== job.jobId || record.networkDeclarationId !== job.networkDeclarationId
      || record.connectionDeclarationId !== job.connectionDeclarationId) {
      throw invalid("Stored job receipt declaration or immutable revision identity is invalid.");
    }
    const acceptedAt = parseTimestampValue(record.acceptedAt, "acceptedAt");
    const terminal = record.state !== "accepted";
    if (terminal) {
      if (parseTimestampValue(record.startedAt, "startedAt") !== acceptedAt) throw invalid("Stored terminal job receipt startedAt differs from acceptedAt.");
      parseTimestampValue(record.finishedAt, "finishedAt");
      parseReceiptIdValue(record.parentReceiptId, "parentReceiptId");
      if ((record.state === "succeeded") === (record.error !== undefined)) throw invalid("Stored terminal job state and error disagree.");
    } else if (record.startedAt !== undefined || record.finishedAt !== undefined || record.parentReceiptId !== undefined || record.error !== undefined) {
      throw invalid("Stored accepted job receipt contains terminal fields.");
    }
    if (record.error !== undefined) parseRuntimeError(record.error);
    parseEffectivePrincipal(record.effectivePrincipal);
    parseAuthorityStamp(record.authority);
    parseConnectionId(record.connectionId);
    boundedString(record.scheduleId, "scheduleId", 256);
    boundedString(record.leaseId, "leaseId", 256);
    parsePrefixedId(record.claimOperationId, /^claim_[0-9a-f-]{36}$/, "claimOperationId");
    boundedString(record.occurrenceId, "occurrenceId", 256);
    boundedString(record.runId, "runId", 256);
    boundedString(record.attemptId, "attemptId", 256);
    return deepFreeze({ ...record, receiptId }) as unknown as HostedJobReceipt;
  });
}

function parseDataReceipts(value: unknown, instances: ReadonlyMap<string, HostedInstance>): HostedDataReceipt[] {
  const raw = expectArrayValue(value, "dataReceipts");
  const seen = new Set<string>();
  return raw.map((item, index) => {
    const record = exactInput(item, ["receiptId", "kind", "tenantId", "runtimeInstanceId", "featureInstallationId", "dataNamespaceId", "featureRevisionDigest", "effectivePrincipal", "authority", "acceptedAt", "startedAt", "finishedAt", "state", "collectionId", "recordId", "dataAction", "recordRevision"], `Data receipt ${index}`);
    const receiptId = parseReceiptId(record.receiptId, seen);
    const runtimeInstanceId = instanceId(record.runtimeInstanceId);
    const instance = instances.get(runtimeInstanceId);
    if (!instance || instance.tenantId !== tenant(record.tenantId) || record.kind !== "resource-mutation" || record.state !== "succeeded") {
      throw invalid("Stored data receipt instance, kind, or state is invalid.");
    }
    const featureInstallationId = parseFeatureInstallationIdValue(record.featureInstallationId);
    const installation = [...instance.installations.values()].find((candidate) => candidate.featureInstallationId === featureInstallationId);
    if (!installation || installation.dataNamespaceId !== parseDataNamespaceIdValue(record.dataNamespaceId)) throw invalid("Stored data receipt Feature identity is invalid.");
    artifactDigest(record.featureRevisionDigest, "featureRevisionDigest");
    parseEffectivePrincipal(record.effectivePrincipal);
    parseAuthorityStamp(record.authority);
    const acceptedAt = parseTimestampValue(record.acceptedAt, "acceptedAt");
    if (parseTimestampValue(record.startedAt, "startedAt") !== acceptedAt) throw invalid("Stored data receipt startedAt differs from acceptedAt.");
    parseTimestampValue(record.finishedAt, "finishedAt");
    stableId(record.collectionId, "collectionId");
    stableId(record.recordId, "recordId");
    if (record.dataAction !== "create" && record.dataAction !== "update" && record.dataAction !== "delete") throw invalid("Stored data receipt action is invalid.");
    if (!Number.isSafeInteger(record.recordRevision) || (record.recordRevision as number) < 1) throw invalid("Stored data receipt revision is invalid.");
    return deepFreeze({ ...record, receiptId }) as unknown as HostedDataReceipt;
  });
}

function validateReceiptLineage(receipts: readonly HostedJobReceipt[]): void {
  const byId = new Map(receipts.map((receipt) => [receipt.receiptId, receipt]));
  const terminals = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.state === "accepted") continue;
    const parent = receipt.parentReceiptId === undefined ? undefined : byId.get(receipt.parentReceiptId);
    if (!parent || parent.state !== "accepted" || terminals.has(parent.receiptId)) throw invalid("Stored job receipt terminal lineage is missing, duplicated, or invalid.");
    for (const field of ["tenantId", "runtimeInstanceId", "featureInstallationId", "releaseDigest", "featureRevisionDigest", "jobId", "declarationId", "networkDeclarationId", "connectionDeclarationId", "connectionId", "scheduleId", "leaseId", "claimOperationId", "occurrenceId", "runId", "attemptId"] as const) {
      if (receipt[field] !== parent[field]) throw invalid(`Stored job receipt terminal lineage changed ${field}.`);
    }
    if (!authorityStampsEqual(receipt.authority, parent.authority)
      || canonicalizeJson(receipt.effectivePrincipal) !== canonicalizeJson(parent.effectivePrincipal)
      || receipt.acceptedAt !== parent.acceptedAt) throw invalid("Stored job receipt terminal lineage changed accepted authority or Principal identity.");
    terminals.add(parent.receiptId);
  }
}

function unresolvedAcceptedJobReceipts(receipts: readonly HostedJobReceipt[]): readonly HostedJobReceipt[] {
  const terminalParents = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.parentReceiptId !== undefined) terminalParents.add(receipt.parentReceiptId);
  }
  return receipts.filter((receipt) => receipt.state === "accepted" && !terminalParents.has(receipt.receiptId));
}

function validateReceiptQuotas(
  management: readonly HostedManagementReceipt[],
  jobs: readonly HostedJobReceipt[],
  data: readonly HostedDataReceipt[],
  pendingClaims: ReadonlyMap<string, PendingJobClaim>,
  pendingTransitions: ReadonlyMap<RuntimeInstanceId, PendingInstanceTransition>,
  instances: ReadonlyMap<string, HostedInstance>,
): void {
  const all = [...management, ...jobs, ...data];
  const ids = new Set<string>();
  const perInstance = new Map<string, number>();
  for (const receipt of all) {
    if (ids.has(receipt.receiptId)) throw invalid("Stored receipt id is duplicated across receipt collections.");
    ids.add(receipt.receiptId);
    if (receipt.runtimeInstanceId !== undefined) perInstance.set(receipt.runtimeInstanceId, (perInstance.get(receipt.runtimeInstanceId) ?? 0) + 1);
  }
  const unresolved = unresolvedAcceptedJobReceipts(jobs);
  const lifecycleReservations = lifecycleRecoveryReceiptCount(instances);
  if (all.length + unresolved.length + pendingClaims.size * 2 + lifecycleReservations > maximumReceiptsTotal) throw invalid("Stored receipts exceed the durable receipt quota.");
  for (const transition of pendingTransitions.values()) {
    const reserved = transition.marker.phase === "purged" ? transition.marker.purgeReceipts! : transition.marker.deleteReceipts;
    for (const receipt of reserved) {
      if (ids.has(receipt.receiptId)) throw invalid("A pending instance transition reuses a durable receipt id.");
      ids.add(receipt.receiptId);
    }
  }
  for (const instance of instances.values()) {
    const runtimeInstanceId = instance.runtimeInstanceId;
    const count = perInstance.get(runtimeInstanceId) ?? 0;
    const reservations = unresolved.filter((receipt) => receipt.runtimeInstanceId === runtimeInstanceId).length;
    const pending = [...pendingClaims.values()].filter((claim) => claim.runtimeInstanceId === runtimeInstanceId).length * 2;
    const lifecycle = instance.status === "active" || instance.status === "suspended"
      ? instance.installations.size * 2
      : instance.status === "delete-pending" ? instance.installations.size : 0;
    if (count + reservations + pending + lifecycle > maximumReceiptsPerInstance) throw invalid("Stored instance receipts exceed the durable receipt quota.");
  }
}

function lifecycleRecoveryReceiptCount(instances: ReadonlyMap<string, HostedInstance>): number {
  let count = 0;
  for (const instance of instances.values()) {
    const featureCount = instance.installations.size;
    if (instance.status === "active" || instance.status === "suspended") count += featureCount * 2;
    else if (instance.status === "delete-pending") count += featureCount;
  }
  return count;
}

function lifecycleRecoveryByteReserveCount(
  instances: ReadonlyMap<string, HostedInstance>,
  transitions: ReadonlyMap<RuntimeInstanceId, PendingInstanceTransition>,
): number {
  let occupiedReservations = 0;
  for (const transition of transitions.values()) {
    occupiedReservations += transition.marker.phase === "purged"
      ? transition.marker.purgeReceipts!.length
      : transition.marker.deleteReceipts.length;
  }
  return Math.max(0, lifecycleRecoveryReceiptCount(instances) - occupiedReservations);
}

function validateCleanupRelationships(
  instances: ReadonlyMap<string, HostedInstance>,
  secrets: ReadonlyMap<string, SecretCleanupTask>,
  schedules: ReadonlyMap<string, ScheduleCleanupTask>,
  leases: ReadonlyMap<string, LeaseCompletionTask>,
  allocations: ReadonlyMap<string, PendingExternalAllocation>,
  pendingClaims: ReadonlyMap<string, PendingJobClaim>,
  receipts: readonly HostedJobReceipt[],
  mutations: ReadonlyMap<string, PendingDataMutation>,
): void {
  const activeSecrets = new Set<string>();
  const activeSchedules = new Set<string>();
  for (const instance of instances.values()) {
    for (const installation of instance.installations.values()) {
      for (const connection of installation.connections.values()) activeSecrets.add(connection.secretRef);
      for (const job of installation.jobs.values()) if (job.scheduleId) activeSchedules.add(job.scheduleId);
    }
  }
  for (const task of secrets.values()) {
    const instance = instances.get(task.runtimeInstanceId);
    if (!instance || activeSecrets.has(task.secretRef)) throw invalid("Stored secret cleanup task ownership or liveness is invalid.");
  }
  for (const task of schedules.values()) {
    const instance = instances.get(task.runtimeInstanceId);
    if (!instance || activeSchedules.has(task.scheduleId)) throw invalid("Stored schedule cleanup task ownership or liveness is invalid.");
  }
  for (const task of leases.values()) {
    const terminal = receipts.find((receipt) => receipt.leaseId === task.leaseId && receipt.state === task.state);
    if (!instances.has(task.runtimeInstanceId)
      || !terminal || terminal.runtimeInstanceId !== task.runtimeInstanceId) throw invalid("Stored lease completion task has no exact terminal receipt.");
  }
  for (const task of allocations.values()) {
    if (!instances.has(task.runtimeInstanceId)) {
      throw invalid("Pending external allocation has an invalid instance owner.");
    }
  }
  for (const claim of pendingClaims.values()) {
    if (receipts.some((receipt) => receipt.claimOperationId === claim.operationId)) {
      throw invalid("Pending job claim already has a durable receipt.");
    }
  }
  for (const instance of instances.values()) {
    if (instance.status !== "purged") continue;
    if ([...mutations.values()].some((mutation) => mutation.runtimeInstanceId === instance.runtimeInstanceId)) {
      throw invalid("Purged stored instance retains pending data mutations.");
    }
  }
}

function parseInstanceStatus(value: unknown): HostedInstanceStatus {
  if (value !== "active" && value !== "suspended" && value !== "delete-pending" && value !== "purged") throw invalid("Stored instance status is invalid.");
  return value;
}

function parsePartitionId(value: unknown, ownerClass: HostedDataOwnerClass): string {
  if (ownerClass === "instance") {
    if (value !== "instance") throw invalid("Instance-owned data must use the instance partition.");
    return value;
  }
  if (ownerClass === "role") {
    if (value !== "role") throw invalid("Role-owned data must use the role partition.");
    return value;
  }
  return actorId(value);
}

function stableReceiptFeatureId(featureInstallationId: FeatureInstallationId, instance: HostedInstance | undefined): string {
  const installation = instance === undefined ? undefined : [...instance.installations.values()]
    .find((candidate) => candidate.featureInstallationId === featureInstallationId);
  if (!installation) throw invalid("Stored receipt Feature Installation is unavailable.");
  return installation.featureId;
}

function parseReceiptId(value: unknown, seen: Set<string>): string {
  const receiptId = parseReceiptIdValue(value, "receiptId");
  if (seen.has(receiptId)) throw invalid("Stored receipt id is duplicated.");
  seen.add(receiptId);
  return receiptId;
}

function parseReceiptIdValue(value: unknown, label: string): string {
  return parsePrefixedId(value, /^receipt_[0-9a-f-]{36}$/, label);
}

function parseRuntimeError(value: unknown): Readonly<RuntimeError> {
  const record = expectRecord(value, "Stored runtime error");
  expectOnlyKeys(record, ["code", "category", "message", "retryable", "retryAfterMs", "receiptId"], "Stored runtime error");
  if (typeof record.code !== "string" || typeof record.message !== "string" || typeof record.retryable !== "boolean") throw invalid("Stored runtime error fields are invalid.");
  let parsed: Readonly<RuntimeError>;
  try {
    parsed = createRuntimeError(record.code as RuntimeErrorCode, record.message, {
      retryable: record.retryable,
      ...(record.retryAfterMs === undefined ? {} : { retryAfterMs: record.retryAfterMs as number }),
      ...(record.receiptId === undefined ? {} : { receiptId: parseReceiptIdValue(record.receiptId, "error receiptId") }),
    });
  } catch (error) { throw invalid(`Stored runtime error is invalid: ${message(error)}`); }
  if (parsed.category !== record.category) throw invalid("Stored runtime error category does not match its code.");
  return parsed;
}

function parseRevokedPrincipalKey(value: unknown): void {
  const key = boundedString(value, "revoked Tenant Principal key", 512);
  const split = key.split("\u0000");
  if (split.length !== 2) throw invalid("Revoked Tenant Principal key is invalid.");
  tenant(split[0]);
  actorId(split[1]);
}

function parseTimestampValue(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
    || new Date(timestamp).toISOString() !== timestamp) throw invalid(`${label} must be a canonical UTC timestamp.`);
  return timestamp;
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function receiptEventAt(receipt: HostedManagementReceipt | HostedJobReceipt | HostedDataReceipt): string {
  return "finishedAt" in receipt && receipt.finishedAt ? receipt.finishedAt : receipt.acceptedAt;
}

function receiptLineageOrder(
  left: HostedManagementReceipt | HostedJobReceipt | HostedDataReceipt,
  right: HostedManagementReceipt | HostedJobReceipt | HostedDataReceipt,
): number {
  if ("parentReceiptId" in right && right.parentReceiptId === left.receiptId) return -1;
  if ("parentReceiptId" in left && left.parentReceiptId === right.receiptId) return 1;
  return left.receiptId.localeCompare(right.receiptId);
}

function invalid(message: string): HostedAppPlatformError {
  return new HostedAppPlatformError("INVALID_INPUT", message);
}

function conflict(message: string): HostedAppPlatformError {
  return new HostedAppPlatformError("CONFLICT", message);
}

function notFound(message: string): HostedAppPlatformError {
  return new HostedAppPlatformError("NOT_FOUND", message);
}

function stale(message: string): HostedAppPlatformError {
  return new HostedAppPlatformError("AUTHORITY_STALE", message);
}

function quota(message: string): HostedAppPlatformError {
  return new HostedAppPlatformError("QUOTA_EXCEEDED", message);
}
