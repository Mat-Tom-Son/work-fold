import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  normalizeRestrictedAppCredential,
  RestrictedAppError,
  type RestrictedAppConnectionBinding,
  type RestrictedAppConnectionFeatureScope,
  type RestrictedAppConnectionStatus,
  type RestrictedAppConnectionStore,
  type RestrictedAppCredential,
  type RestrictedAppEffectAuthorizer,
} from "./restricted-app-connections.js";
import {
  parseRestrictedAppManifest,
  restrictedAppNetworkOrigin,
  type RestrictedAppAutomationDeclaration,
  type RestrictedAppManifest,
} from "./restricted-app-manifest.js";
import { RestrictedAppFileBroker, type RestrictedAppFileGrant } from "./restricted-app-files.js";
import type {
  FileRestrictedAppStorage,
  RestrictedAppStorageOwner,
  RestrictedAppStorageUsage,
} from "./restricted-app-storage.js";
import { RestrictedAppOAuthError, type RestrictedAppOAuthPkceClient } from "./restricted-app-oauth.js";
import {
  inspectRestrictedAppPackage,
  snapshotRestrictedAppPackage,
  stageRestrictedAppReleaseArtifact,
  stageRestrictedAppPackage,
} from "./restricted-app-package.js";
import {
  appReleaseDefaultLimits,
  assembleAppRelease,
  verifyAppRelease,
  type AppReleaseEnvelope,
  type AppReleaseFeatureInput,
  type AppReleasePresentation,
} from "./app-platform-release.js";
import {
  planLocalAppInstanceUpdate,
  type LocalAppInstanceUpdatePlan,
  type LocalAppUpdateContinuityPolicy,
} from "./app-instance-update.js";
import {
  workFoldAutomationMaxErrorLength,
  WorkFoldAutomationService,
  type WorkFoldAutomationClock,
  type WorkFoldAutomationRunContext,
  type WorkFoldAutomationRunResult,
} from "./work-fold-automation-service.js";
import {
  advanceAuthorityStamp,
  authorityStampsEqual,
  computeDeclarationDigest,
  createAuthorityGeneration,
  createAuthorityStamp,
  createDataNamespaceId,
  createFeatureInstallationId,
  createPrincipalId,
  createProjectId,
  createRuntimeInstanceId,
  createTenantId,
  parseAuthorityGeneration,
  parseAuthorityStamp,
  parseDataNamespaceId,
  parseFeatureInstallationId,
  parsePrincipalId,
  parseProjectId,
  parseRuntimeInstanceId,
  parseSha256Digest,
  parseTenantId,
  type AuthorityGeneration,
  type AuthorityStamp,
  type DataNamespaceId,
  type FeatureInstallationId,
  type EffectivePrincipal,
  type PrincipalId,
  type ProjectId,
  type RuntimeInstanceId,
  type Sha256Digest,
  type TenantId,
} from "./app-platform-contract.js";
import {
  parseAppPlatformArtifactDigest,
  type AppPlatformArtifactDigest,
} from "./app-platform-artifact.js";
import {
  LocalAppReleaseStore,
  LocalAppReleaseStoreError,
  type LocalAppReleaseStoreVerifiedProjection,
} from "./local-app-release-store.js";
import { RestrictedAppRegistryVersionUnsupportedError } from "./restricted-app-registry-error.js";
export interface RestrictedAppReview {
  packageName: string;
  version: string;
  digest: string;
  artifactDigest: AppPlatformArtifactDigest;
  manifest: RestrictedAppManifest;
  fileCount: number;
  totalBytes: number;
}

export interface RestrictedAppInstalled extends RestrictedAppReview {
  spaceId: string;
  sourceSpaceId: string;
  projectId: ProjectId;
  tenantId: TenantId;
  principalId: PrincipalId;
  runtimeInstanceId: RuntimeInstanceId;
  runtimeInstanceKind: "development" | "app";
  releaseDigest: Sha256Digest | null;
  featureInstallationId: FeatureInstallationId;
  dataNamespaceId: DataNamespaceId;
  authority: Readonly<AuthorityStamp>;
  networkGrants: string[];
  fileGrants: RestrictedAppFileGrant[];
  notificationGrants: string[];
  automations: RestrictedAppAutomationState[];
  installedAt: string;
  updatedAt: string;
}

export interface LocalAppProject {
  spaceId: string;
  projectId: ProjectId;
  presentation: AppReleasePresentation;
  createdAt: string;
  updatedAt: string;
}

export interface LocalAppRelease {
  projectId: ProjectId;
  sourceSpaceId: string;
  releaseDigest: Sha256Digest;
  displayVersion: string;
  presentation: AppReleasePresentation;
  featureIds: string[];
  state: "prepared" | "published";
  preparedAt: string;
  publishedAt: string | null;
}

export interface LocalAppInstance {
  runtimeInstanceId: RuntimeInstanceId;
  projectId: ProjectId;
  spaceId: string;
  releaseDigest: Sha256Digest;
  displayVersion: string;
  presentation: AppReleasePresentation;
  featureIds: string[];
  installedAt: string;
  updatedAt: string;
}

export interface LocalAppInstallPlan {
  operationId: string;
  kind: "install";
  projectId: ProjectId;
  targetSpaceId: string;
  releaseDigest: Sha256Digest;
  runtimeInstanceId: RuntimeInstanceId;
  features: Array<{
    featureId: string;
    featureInstallationId: FeatureInstallationId;
    dataNamespaceId: DataNamespaceId;
  }>;
  preparedAt: string;
}

export interface LocalAppUpdatePlan {
  operationId: string;
  kind: "update";
  projectId: ProjectId;
  targetSpaceId: string;
  releaseDigest: Sha256Digest;
  runtimeInstanceId: RuntimeInstanceId;
  continuityPolicy: LocalAppUpdateContinuityPolicy;
  plan: LocalAppInstanceUpdatePlan;
  preparedAt: string;
}

export type LocalAppOperation = LocalAppInstallPlan | LocalAppUpdatePlan;

export interface LocalAppRetainedData {
  retainedDataId: string;
  projectId: ProjectId;
  runtimeInstanceId: RuntimeInstanceId;
  featureId: string;
  featureInstallationId: FeatureInstallationId;
  dataNamespaceId: DataNamespaceId;
  releaseDigest: Sha256Digest;
  removedAt: string;
}

export interface LocalAppStudioSnapshot {
  project: LocalAppProject | null;
  previews: RestrictedAppInstalled[];
  releases: LocalAppRelease[];
  instances: LocalAppInstance[];
  operations: LocalAppOperation[];
  retainedData: LocalAppRetainedData[];
}

export interface LocalAppSpaceRemovalImpact {
  activeSourceInstanceCount: number;
  activeTargetInstanceCount: number;
  retainedDataCount: number;
  incomingPreparedOperationCount: number;
}

export interface LocalAppReleaseDeletionResult {
  deleted: boolean;
  cleanupPending: boolean;
}

export interface RestrictedAppAutomationState {
  id: string;
  enabled: boolean;
  lastRunAt?: string;
  lastError?: string;
  nextRunAt?: string;
}

export interface RestrictedAppAutomationRunReceipt {
  receiptId: string;
  verification: "captured";
  runId: string;
  automationId: string;
  reason: "scheduled" | "manual" | "resume";
  scheduledAt: string;
  startedAt: string;
  finishedAt: string;
  outcome: "success" | "failure" | "skipped" | "cancelled" | "interrupted";
  error?: string;
  kind: "job";
  tenantId: TenantId;
  runtimeInstanceId: RuntimeInstanceId;
  featureInstallationId: FeatureInstallationId;
  featureRevisionDigest: AppPlatformArtifactDigest;
  dataNamespaceId: DataNamespaceId;
  effectivePrincipal: EffectivePrincipal;
  authority: Readonly<AuthorityStamp>;
  acceptedAt: string;
  state: "succeeded" | "failed" | "skipped" | "cancelled" | "expired";
  occurrenceId: string;
  attemptId: string;
}

export interface RestrictedAppRuntimeDescriptor extends RestrictedAppInstalled {
  stagedRoot: string;
}

export interface RestrictedAppRuntimeAuthority {
  spaceId: string;
  appId: string;
  digest: string;
  runtimeInstanceId: RuntimeInstanceId;
  featureInstallationId: FeatureInstallationId;
  authority: Readonly<AuthorityStamp>;
}

export interface RestrictedAppRuntimeHost {
  syncAuthority?(authorities: readonly RestrictedAppRuntimeAuthority[]): void;
  invoke(app: RestrictedAppRuntimeDescriptor, action: string, input: unknown): Promise<unknown>;
  runAutomation?(app: RestrictedAppRuntimeDescriptor, event: {
    runId: string;
    automationId: string;
    handler: string;
    reason: "scheduled" | "manual" | "resume";
    scheduledAt: string;
    effectivePrincipal: EffectivePrincipal;
  }, signal?: AbortSignal): Promise<void>;
  suspend?(): void;
  resume?(): void;
  stop(spaceId: string, appId: string, digest?: string): Promise<void>;
  close(): Promise<void>;
}

export interface RestrictedAppServiceOptions {
  rootPath: string;
  runtimeHost?: RestrictedAppRuntimeHost;
  connections?: RestrictedAppConnectionStore;
  storage?: FileRestrictedAppStorage;
  oauth?: RestrictedAppOAuthPkceClient;
  releaseStore?: LocalAppReleaseStore;
  now?: () => Date;
  /**
   * Persisted jobs are inert by default. Set this to false only when this
   * service is the top-level lifecycle owner and no recovery must run first.
   */
  deferAutomationStart?: boolean;
}

interface RestrictedAppRegistryFile {
  schemaVersion: 5;
  localIdentity: {
    tenantId: TenantId;
    principalId: PrincipalId;
    servicePrincipalId: PrincipalId;
    principalGeneration: AuthorityGeneration;
  };
  projects: RestrictedAppProjectRegistryEntry[];
  runtimeInstances: RestrictedAppRuntimeInstanceRegistryEntry[];
  installations: RestrictedAppRegistryEntry[];
  releases: LocalAppReleaseRegistryEntry[];
  operations: LocalAppOperation[];
  retainedData: LocalAppRetainedData[];
  adminReceipts: LocalAppAdminReceipt[];
  pendingCleanups: RestrictedAppPendingCleanup[];
  acceptedAutomationRuns: RestrictedAppAcceptedAutomationRegistryReceipt[];
  historicalAutomationRuns: RestrictedAppHistoricalAutomationRegistryReceipt[];
}

const restrictedAppRegistryMaximumBytes = 5 * 1024 * 1024;
const restrictedAppStagingTemporaryDirectoryPattern = /^\.(?:staging|release)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const restrictedAppRegistryLimits = Object.freeze({
  projects: 256,
  runtimeInstances: 1_024,
  installations: 2_048,
  releases: 1_024,
  operations: 128,
  retainedData: 2_048,
  adminReceipts: 1_000,
});

function assertRestrictedAppRegistryCapacity(
  collection: keyof typeof restrictedAppRegistryLimits,
  currentCount: number,
  additionalCount: number,
  label: string,
): void {
  const maximum = restrictedAppRegistryLimits[collection];
  if (currentCount + additionalCount <= maximum) return;
  throw new RestrictedAppError(
    "INPUT_INVALID",
    `Local App Studio has reached its ${label} limit of ${maximum}. Remove an unused item before continuing.`,
  );
}

interface RestrictedAppProjectRegistryEntry {
  spaceId: string;
  projectId: ProjectId;
  presentation: AppReleasePresentation;
  createdAt: string;
  updatedAt: string;
}

interface RestrictedAppRuntimeInstanceRegistryBase {
  spaceId: string;
  projectId: ProjectId;
  runtimeInstanceId: RuntimeInstanceId;
  runtimeInstanceGeneration: AuthorityGeneration;
  createdAt: string;
  updatedAt: string;
}

type RestrictedAppRuntimeInstanceRegistryEntry =
  | (RestrictedAppRuntimeInstanceRegistryBase & { kind: "development" })
  | (RestrictedAppRuntimeInstanceRegistryBase & {
      kind: "app";
      host: "local";
      activeReleaseDigest: Sha256Digest;
    });

interface LocalAppReleaseRegistryEntry extends LocalAppRelease {
  sourceFeatures: Array<{
    featureId: string;
    featureInstallationId: FeatureInstallationId;
    packageDigest: string;
    artifactDigest: AppPlatformArtifactDigest;
  }>;
}

interface LocalAppVerifiedReleaseProjection {
  readonly projectId: ProjectId;
  readonly displayVersion: string;
  readonly presentation: AppReleasePresentation;
  readonly features: readonly Readonly<{
    featureId: string;
    featureRevisionDigest: AppPlatformArtifactDigest;
    declarationDigest: Sha256Digest;
  }>[];
}

interface LocalAppAdminReceipt {
  receiptId: string;
  action: "release-prepared" | "release-published" | "release-deleted" | "install-prepared" | "installed"
    | "update-prepared" | "updated" | "uninstalled" | "retained-data-purged";
  projectId: ProjectId;
  runtimeInstanceId: RuntimeInstanceId | null;
  releaseDigest: Sha256Digest | null;
  dataDisposition: "retain" | "purge" | null;
  createdAt: string;
}

interface RestrictedAppPendingCleanup {
  cleanupId: string;
  connectionScope: RestrictedAppConnectionFeatureScope | null;
  storageOwner: RestrictedAppStorageOwner | null;
  packageDigest: string | null;
  createdAt: string;
}

interface RestrictedAppAutomationRegistryState {
  id: string;
  enabled: boolean;
  lastScheduledAt?: string;
  lastRunAt?: string;
  lastError?: string;
}

interface RestrictedAppAutomationRegistryReceipt extends RestrictedAppAutomationRunReceipt {
  packageDigest: string;
}

interface RestrictedAppAcceptedAutomationRegistryReceipt extends AcceptedAutomationContext {
  readonly receiptId: string;
  readonly verification: "captured";
  readonly kind: "job";
  readonly state: "accepted";
  readonly spaceId: string;
  readonly appId: string;
  readonly packageDigest: string;
  readonly runId: string;
  readonly automationId: string;
  readonly reason: "scheduled" | "manual" | "resume";
  readonly scheduledAt: string;
}

interface RestrictedAppHistoricalAutomationRegistryReceipt extends RestrictedAppAutomationRegistryReceipt {
  readonly spaceId: string;
  readonly appId: string;
}

interface AcceptedAutomationContext {
  readonly tenantId: TenantId;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly featureInstallationId: FeatureInstallationId;
  readonly featureRevisionDigest: AppPlatformArtifactDigest;
  readonly dataNamespaceId: DataNamespaceId;
  readonly effectivePrincipal: EffectivePrincipal;
  readonly authority: Readonly<AuthorityStamp>;
  readonly acceptedAt: string;
  readonly occurrenceId: string;
  readonly attemptId: string;
}

interface RestrictedAppRegistryEntry {
  spaceId: string;
  projectId: ProjectId;
  runtimeInstanceId: RuntimeInstanceId;
  runtimeInstanceKind: "development" | "app";
  releaseDigest: Sha256Digest | null;
  featureInstallationId: FeatureInstallationId;
  dataNamespaceId: DataNamespaceId;
  authority: Readonly<AuthorityStamp>;
  packageName: string;
  version: string;
  digest: string;
  artifactDigest: AppPlatformArtifactDigest;
  manifest: RestrictedAppManifest;
  networkGrants: string[];
  fileGrants: RestrictedAppFileGrant[];
  notificationGrants: string[];
  automations: RestrictedAppAutomationRegistryState[];
  automationRuns: RestrictedAppAutomationRegistryReceipt[];
  fileCount: number;
  totalBytes: number;
  installedAt: string;
  updatedAt: string;
}

export class RestrictedAppService {
  readonly #rootPath: string;
  readonly #registryPath: string;
  readonly #stagingPath: string;
  readonly #runtimeHost?: RestrictedAppRuntimeHost;
  readonly #connections?: RestrictedAppConnectionStore;
  readonly #storage?: FileRestrictedAppStorage;
  readonly #oauth?: RestrictedAppOAuthPkceClient;
  readonly #releaseStore: LocalAppReleaseStore;
  readonly #now: () => Date;
  readonly #automations: WorkFoldAutomationService;
  readonly #acceptedAutomations = new Map<string, AcceptedAutomationContext>();
  readonly #spaceRuntimeExclusions = new Set<string>();
  #registry: RestrictedAppRegistryFile;
  #queue: Promise<void> = Promise.resolve();
  #releaseReconciliationPending = false;
  #automationsStarted = false;
  #closed = false;

  private constructor(options: RestrictedAppServiceOptions, registry: RestrictedAppRegistryFile) {
    this.#rootPath = resolve(options.rootPath);
    this.#registryPath = join(this.#rootPath, "registry.json");
    this.#stagingPath = join(this.#rootPath, "staged");
    this.#runtimeHost = options.runtimeHost;
    this.#connections = options.connections;
    this.#storage = options.storage;
    this.#oauth = options.oauth;
    this.#releaseStore = options.releaseStore ?? new LocalAppReleaseStore(join(this.#rootPath, "releases"));
    this.#now = options.now ?? (() => new Date());
    this.#registry = registry;
    const clock: WorkFoldAutomationClock = {
      now: this.#now,
      setTimeout(callback, delayMs) {
        const handle = setTimeout(callback, delayMs);
        handle.unref?.();
        return handle;
      },
      clearTimeout(handle) {
        clearTimeout(handle as NodeJS.Timeout);
      },
    };
    this.#automations = new WorkFoldAutomationService({
      clock,
      onResult: async (result) => { await this.#recordAutomationResult(result); },
    });
  }

  static async create(options: RestrictedAppServiceOptions): Promise<RestrictedAppService> {
    const rootPath = resolve(options.rootPath);
    await mkdir(rootPath, { recursive: true });
    await assertRestrictedAppStateRoot(rootPath);
    await recoverRestrictedAppRegistryTemps(rootPath);
    await mkdir(join(rootPath, "staged"), { recursive: true });
    await assertRestrictedAppStagingRoot(join(rootPath, "staged"));
    const now = options.now ?? (() => new Date());
    const loaded = await readRegistry(join(rootPath, "registry.json"));
    const reconciled = reconcileInterruptedAutomationRuns(loaded.registry, now().toISOString());
    const releaseStore = options.releaseStore ?? new LocalAppReleaseStore(join(rootPath, "releases"));
    const releaseRecovery = await releaseStore.recover();
    const releaseReconciliation = await releaseStore.reconcile(
      reconciled.registry.releases.map((release) => release.releaseDigest),
      async (verifiedReleases) => {
        const storedByDigest = new Map(verifiedReleases.map((release) => [release.releaseDigest, release]));
        const releaseProjections = new Map<Sha256Digest, LocalAppVerifiedReleaseProjection>();
        for (const release of reconciled.registry.releases) {
          const stored = storedByDigest.get(release.releaseDigest);
          if (!stored) throw new Error(`Local App Release ${release.releaseDigest} is unavailable.`);
          const projection = assertLocalRestrictedAppReleaseProjection(stored);
          if (projection.projectId !== release.projectId
            || projection.displayVersion !== release.displayVersion
            || JSON.stringify(projection.presentation) !== JSON.stringify(release.presentation)
            || projection.features.map((feature) => feature.featureId).join("\0") !== release.featureIds.join("\0")) {
            throw new Error(`Local App Release ${release.releaseDigest} does not match its registry metadata.`);
          }
          releaseProjections.set(release.releaseDigest, projection);
        }
        await assertReleaseBackedInstallationProjection(
          reconciled.registry,
          releaseProjections,
          join(rootPath, "staged"),
        );
      },
    );
    const service = new RestrictedAppService({ ...options, releaseStore, now }, reconciled.registry);
    service.#releaseReconciliationPending = releaseRecovery.cleanupPending || releaseReconciliation.cleanupPending;
    if (loaded.needsWrite || reconciled.needsWrite) await service.#writeRegistry(reconciled.registry);
    else service.#syncRuntimeAuthorities();
    await service.#drainPendingCleanups();
    await service.#cleanupStaging();
    if (options.deferAutomationStart === false) service.startAutomations();
    return service;
  }

  get automationsStarted(): boolean {
    return this.#automationsStarted;
  }

  async inspect(input: { spaceId: string; spaceRoot: string; sourcePath: string }): Promise<RestrictedAppReview> {
    this.#assertOpen();
    const sourceRoot = await restrictedSourceRoot(input.spaceRoot, input.sourcePath);
    const inspection = await inspectRestrictedAppPackage(sourceRoot);
    return reviewFromInspection(inspection);
  }

  async list(spaceId: string): Promise<RestrictedAppInstalled[]> {
    this.#assertOpen();
    await this.#queue.catch(() => undefined);
    return this.#registry.installations
      .filter((item) => item.spaceId === spaceId)
      .sort((left, right) => left.manifest.title.localeCompare(right.manifest.title) || left.manifest.id.localeCompare(right.manifest.id))
      .map((item) => this.#copyInstalled(item));
  }

  async declareLocalAppProject(input: {
    spaceId: string;
    presentation: AppReleasePresentation;
  }): Promise<LocalAppProject> {
    return await this.#mutate(async () => {
      const presentation = restrictedAppInput(() => presentationValue(input.presentation, "App Project presentation"));
      const hasProject = this.#registry.projects.some((item) => item.spaceId === input.spaceId);
      const hasDevelopmentRuntime = this.#registry.runtimeInstances.some((item) => (
        item.kind === "development" && item.spaceId === input.spaceId
      ));
      assertRestrictedAppRegistryCapacity("projects", this.#registry.projects.length, hasProject ? 0 : 1, "App Project");
      assertRestrictedAppRegistryCapacity(
        "runtimeInstances",
        this.#registry.runtimeInstances.length,
        hasDevelopmentRuntime ? 0 : 1,
        "Runtime Instance",
      );
      const timestamp = this.#now().toISOString();
      const context = developmentContext(this.#registry, input.spaceId, timestamp);
      const project: RestrictedAppProjectRegistryEntry = {
        ...context.project,
        presentation,
        updatedAt: timestamp,
      };
      await this.#writeRegistry({
        ...this.#registry,
        projects: context.projects.map((item) => item.projectId === project.projectId ? project : item),
        runtimeInstances: context.runtimeInstances,
      });
      return structuredClone(project);
    });
  }

  async localAppStudio(spaceId: string): Promise<LocalAppStudioSnapshot> {
    this.#assertOpen();
    await this.#queue.catch(() => undefined);
    const project = this.#registry.projects.find((item) => item.spaceId === spaceId) ?? null;
    if (!project) {
      return { project: null, previews: [], releases: [], instances: [], operations: [], retainedData: [] };
    }
    const releases = this.#registry.releases
      .filter((item) => item.projectId === project.projectId)
      .sort((left, right) => right.preparedAt.localeCompare(left.preparedAt))
      .map(copyLocalAppRelease);
    const releaseByDigest = new Map(releases.map((item) => [item.releaseDigest, item]));
    const instances = this.#registry.runtimeInstances
      .filter((item): item is Extract<RestrictedAppRuntimeInstanceRegistryEntry, { kind: "app" }> => (
        item.kind === "app" && item.projectId === project.projectId
      ))
      .map((runtime): LocalAppInstance => {
        const release = releaseByDigest.get(runtime.activeReleaseDigest);
        if (!release) throw new Error("Local App Instance Release metadata is unavailable.");
        const features = this.#registry.installations.filter((item) => item.runtimeInstanceId === runtime.runtimeInstanceId);
        return {
          runtimeInstanceId: runtime.runtimeInstanceId,
          projectId: runtime.projectId,
          spaceId: runtime.spaceId,
          releaseDigest: runtime.activeReleaseDigest,
          displayVersion: release.displayVersion,
          presentation: structuredClone(release.presentation),
          featureIds: features.map((item) => item.manifest.id).sort(),
          installedAt: features.map((item) => item.installedAt).sort()[0] ?? runtime.createdAt,
          updatedAt: runtime.updatedAt,
        };
      })
      .sort((left, right) => left.spaceId.localeCompare(right.spaceId));
    return structuredClone({
      project,
      previews: this.#registry.installations
        .filter((item) => item.projectId === project.projectId && item.runtimeInstanceKind === "development")
        .sort((left, right) => left.manifest.title.localeCompare(right.manifest.title))
        .map((item) => this.#copyInstalled(item)),
      releases,
      instances,
      operations: this.#registry.operations.filter((item) => item.projectId === project.projectId),
      retainedData: this.#registry.retainedData.filter((item) => item.projectId === project.projectId),
    });
  }

  async spaceRemovalMutationSpaceIds(spaceId: string): Promise<string[]> {
    this.#assertOpen();
    await this.#queue.catch(() => undefined);
    const spaceIds = new Set([spaceId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const project of this.#registry.projects) {
        const projectTouchesSelection = spaceIds.has(project.spaceId)
          || this.#registry.runtimeInstances.some((runtime) => (
            runtime.kind === "app" && runtime.projectId === project.projectId && spaceIds.has(runtime.spaceId)
          ))
          || this.#registry.operations.some((operation) => (
            operation.projectId === project.projectId && spaceIds.has(operation.targetSpaceId)
          ));
        if (!projectTouchesSelection) continue;
        const related = [
          project.spaceId,
          ...this.#registry.runtimeInstances
            .filter((runtime) => runtime.kind === "app" && runtime.projectId === project.projectId)
            .map((runtime) => runtime.spaceId),
          ...this.#registry.operations
            .filter((operation) => operation.projectId === project.projectId)
            .map((operation) => operation.targetSpaceId),
        ];
        for (const id of related) {
          if (spaceIds.has(id)) continue;
          spaceIds.add(id);
          changed = true;
        }
      }
    }
    return [...spaceIds].sort();
  }

  async spaceRemovalImpact(spaceId: string): Promise<LocalAppSpaceRemovalImpact> {
    this.#assertOpen();
    await this.#queue.catch(() => undefined);
    const sourceProject = this.#registry.projects.find((project) => project.spaceId === spaceId);
    return {
      activeSourceInstanceCount: sourceProject
        ? this.#registry.runtimeInstances.filter((runtime) => runtime.kind === "app" && runtime.projectId === sourceProject.projectId).length
        : 0,
      activeTargetInstanceCount: this.#registry.runtimeInstances.filter((runtime) => (
        runtime.kind === "app" && runtime.spaceId === spaceId
      )).length,
      retainedDataCount: sourceProject
        ? this.#registry.retainedData.filter((retained) => retained.projectId === sourceProject.projectId).length
        : 0,
      incomingPreparedOperationCount: this.#registry.operations.filter((operation) => {
        if (operation.targetSpaceId !== spaceId) return false;
        const project = this.#registry.projects.find((item) => item.projectId === operation.projectId);
        return Boolean(project && project.spaceId !== spaceId);
      }).length,
    };
  }

  async prepareLocalAppRelease(input: {
    spaceId: string;
    displayVersion: string;
  }): Promise<LocalAppRelease> {
    return await this.#mutate(async () => {
      await assertRestrictedAppStagingRoot(this.#stagingPath);
      const project = this.#registry.projects.find((item) => item.spaceId === input.spaceId);
      if (!project) throw new RestrictedAppError("INPUT_INVALID", "Create an App Project before preparing a Release.");
      const displayVersion = restrictedAppInput(() => nonempty(input.displayVersion, "App Release display version", 128));
      const entries = this.#registry.installations
        .filter((item) => item.projectId === project.projectId && item.runtimeInstanceKind === "development")
        .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
      if (entries.length === 0) {
        throw new RestrictedAppError("INPUT_INVALID", "Install at least one reviewed local preview before preparing a Release.");
      }
      assertLocalAppReleasePreparationBounds(entries);
      const sourceFeatures: LocalAppReleaseRegistryEntry["sourceFeatures"] = entries.map((entry) => ({
        featureId: entry.manifest.id,
        featureInstallationId: entry.featureInstallationId,
        packageDigest: entry.digest,
        artifactDigest: entry.artifactDigest,
      }));
      const sameVersion = this.#registry.releases.find((item) => item.projectId === project.projectId
        && item.displayVersion === displayVersion);
      if (sameVersion) {
        if (JSON.stringify(sameVersion.sourceFeatures) !== JSON.stringify(sourceFeatures)
          || JSON.stringify(sameVersion.presentation) !== JSON.stringify(project.presentation)) {
          throw new RestrictedAppError("REVISION_CHANGED", "This Release version already names different reviewed content. Choose a new version.");
        }
        await this.#releaseStore.read(sameVersion.releaseDigest);
        return copyLocalAppRelease(sameVersion);
      }
      assertRestrictedAppRegistryCapacity("releases", this.#registry.releases.length, 1, "Release");
      const features: AppReleaseFeatureInput[] = [];
      for (const entry of entries) {
        const snapshot = await snapshotRestrictedAppPackage(stageReceiptFromEntry(entry, this.#digestRoot(entry.digest)));
        features.push({
          featureId: entry.manifest.id,
          featureRevision: {
            mediaType: "application/vnd.work-fold.restricted-app-package+bundle",
            entries: [...snapshot.files].map(([path, bytes]) => ({ path, bytes })),
          },
          declaration: {
            mediaType: "application/vnd.work-fold.restricted-app-manifest+json",
            value: entry.manifest,
          },
          dataSchema: null,
          migrations: [],
        });
      }
      const timestamp = this.#now().toISOString();
      const envelope = assembleAppRelease({
        projectId: project.projectId,
        presentation: project.presentation,
        displayVersion,
        runtimeApi: { name: "work-fold.restricted-app-bridge", compatibleRange: "2.x" },
        features,
        dependencyInventory: {
          mediaType: "application/vnd.work-fold.restricted-app-dependencies+json",
          value: {
            formatVersion: 1,
            packages: entries.map((entry) => ({
              featureId: entry.manifest.id,
              packageName: entry.packageName,
              packageVersion: entry.version,
              packageDigest: entry.digest,
              artifactDigest: entry.artifactDigest,
            })),
          },
        },
        buildProvenance: {
          mediaType: "application/vnd.work-fold.local-app-build-provenance+json",
          value: {
            formatVersion: 1,
            builder: "work-fold.local-app-studio",
            input: "reviewed-development-instance",
          },
        },
        inspectionEvidence: {
          mediaType: "application/vnd.work-fold.restricted-app-inspection+json",
          value: {
            formatVersion: 1,
            policy: "agent-app-v2",
            execution: "not-run",
            featureArtifactDigests: entries.map((entry) => entry.artifactDigest),
          },
        },
        createdAt: timestamp,
      });
      try {
        await this.#releaseStore.put(envelope);
      } catch (error) {
        if (error instanceof LocalAppReleaseStoreError && error.code === "RELEASE_STORE_LIMIT_EXCEEDED") {
          throw new RestrictedAppError("INPUT_INVALID", error.message);
        }
        throw error;
      }
      const record: LocalAppReleaseRegistryEntry = {
        projectId: project.projectId,
        sourceSpaceId: project.spaceId,
        releaseDigest: envelope.releaseDigest,
        displayVersion: envelope.manifest.displayVersion,
        presentation: structuredClone(envelope.manifest.presentation),
        featureIds: envelope.manifest.features.map((feature) => feature.featureId),
        state: "prepared",
        preparedAt: timestamp,
        publishedAt: null,
        sourceFeatures,
      };
      try {
        await this.#writeRegistry({
          ...this.#registry,
          releases: [...this.#registry.releases, record],
          adminReceipts: appendAdminReceipt(this.#registry.adminReceipts, {
            action: "release-prepared",
            projectId: project.projectId,
            runtimeInstanceId: null,
            releaseDigest: record.releaseDigest,
            createdAt: timestamp,
          }),
        });
      } catch (error) {
        await this.#reconcileReleaseStore();
        throw error;
      }
      return copyLocalAppRelease(record);
    });
  }

  async publishLocalAppRelease(input: {
    spaceId: string;
    releaseDigest: string;
  }): Promise<LocalAppRelease> {
    return await this.#mutate(async () => {
      const digest = releaseDigestValue(input.releaseDigest);
      const release = this.#registry.releases.find((item) => item.releaseDigest === digest);
      if (!release || release.sourceSpaceId !== input.spaceId) {
        throw new RestrictedAppError("INPUT_INVALID", "The prepared Release does not belong to this App Project.");
      }
      if (release.state === "published") return copyLocalAppRelease(release);
      await this.#releaseStore.read(digest);
      const project = this.#registry.projects.find((item) => item.projectId === release.projectId);
      if (!project || JSON.stringify(project.presentation) !== JSON.stringify(release.presentation)) {
        throw new RestrictedAppError(
          "REVISION_CHANGED",
          "The App Project presentation changed after this Release was prepared. Prepare and review a new Release.",
        );
      }
      const current = this.#registry.installations
        .filter((item) => item.projectId === release.projectId && item.runtimeInstanceKind === "development")
        .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
      const stamps = current.map((entry) => ({
        featureId: entry.manifest.id,
        featureInstallationId: entry.featureInstallationId,
        packageDigest: entry.digest,
        artifactDigest: entry.artifactDigest,
      }));
      if (JSON.stringify(stamps) !== JSON.stringify(release.sourceFeatures)) {
        throw new RestrictedAppError("REVISION_CHANGED", "The local preview changed after this Release was prepared. Prepare and review a new Release.");
      }
      const timestamp = this.#now().toISOString();
      const published: LocalAppReleaseRegistryEntry = { ...release, state: "published", publishedAt: timestamp };
      await this.#writeRegistry({
        ...this.#registry,
        releases: this.#registry.releases.map((item) => item === release ? published : item),
        adminReceipts: appendAdminReceipt(this.#registry.adminReceipts, {
          action: "release-published",
          projectId: release.projectId,
          runtimeInstanceId: null,
          releaseDigest: release.releaseDigest,
          createdAt: timestamp,
        }),
      });
      return copyLocalAppRelease(published);
    });
  }

  async deleteLocalAppRelease(input: {
    spaceId: string;
    releaseDigest: string;
  }): Promise<LocalAppReleaseDeletionResult> {
    return await this.#mutate(async () => {
      const digest = releaseDigestValue(input.releaseDigest);
      const release = this.#registry.releases.find((item) => (
        item.releaseDigest === digest && item.sourceSpaceId === input.spaceId
      ));
      if (!release) {
        return { deleted: false, cleanupPending: this.#releaseReconciliationPending };
      }

      const blockers: string[] = [];
      if (this.#registry.runtimeInstances.some((runtime) => (
        runtime.kind === "app" && runtime.activeReleaseDigest === digest
      ))) {
        blockers.push("Uninstall every App Instance using it first.");
      }
      if (this.#registry.operations.some((operation) => (
        operation.releaseDigest === digest
        || (operation.kind === "update" && operation.plan.fromReleaseDigest === digest)
      ))) {
        blockers.push("Cancel every prepared install, update, or rollback using it first.");
      }
      if (this.#registry.retainedData.some((retained) => retained.releaseDigest === digest)) {
        blockers.push("Purge the retained App data that records it first.");
      }
      if (blockers.length > 0) {
        throw new RestrictedAppError(
          "INPUT_INVALID",
          `This Release is still required. ${blockers.join(" ")}`,
        );
      }

      const timestamp = this.#now().toISOString();
      await this.#writeRegistry({
        ...this.#registry,
        releases: this.#registry.releases.filter((item) => item !== release),
        adminReceipts: appendAdminReceipt(this.#registry.adminReceipts, {
          action: "release-deleted",
          projectId: release.projectId,
          runtimeInstanceId: null,
          releaseDigest: release.releaseDigest,
          createdAt: timestamp,
        }),
      });
      const reconciled = await this.#reconcileReleaseStore();
      return { deleted: true, cleanupPending: !reconciled };
    });
  }

  async prepareLocalAppInstall(input: {
    sourceSpaceId: string;
    targetSpaceId: string;
    releaseDigest: string;
  }): Promise<LocalAppInstallPlan> {
    return await this.#mutate(async () => {
      const sourceSpaceId = restrictedAppInput(() => nonempty(input.sourceSpaceId, "App Project source Space id", 200));
      const targetSpaceId = restrictedAppInput(() => nonempty(input.targetSpaceId, "App install target Space id", 200));
      const digest = releaseDigestValue(input.releaseDigest);
      const release = this.#publishedRelease(sourceSpaceId, digest);
      const envelope = await this.#releaseStore.read(digest);
      assertLocalRestrictedAppRelease(envelope);
      const existingRuntime = this.#registry.runtimeInstances.find((item): item is Extract<
        RestrictedAppRuntimeInstanceRegistryEntry,
        { kind: "app" }
      > => item.kind === "app" && item.projectId === release.projectId && item.spaceId === targetSpaceId);
      if (existingRuntime) {
        throw new RestrictedAppError(
          "INPUT_INVALID",
          existingRuntime.activeReleaseDigest === digest
            ? "This Release is already installed in that Space."
            : "This App is already installed in that Space. Prepare an update instead.",
        );
      }
      const conflict = envelope.manifest.features.find((feature) => this.#registry.installations.some((item) => (
        item.spaceId === targetSpaceId && item.manifest.id === feature.featureId
      )));
      if (conflict) {
        throw new RestrictedAppError(
          "INPUT_INVALID",
          `The target Space already contains the ${conflict.featureId} Feature. Choose another Space or remove the conflicting preview first.`,
        );
      }
      const pending = this.#registry.operations.find((item): item is LocalAppInstallPlan => item.kind === "install"
        && item.projectId === release.projectId && item.targetSpaceId === targetSpaceId);
      if (pending) {
        if (pending.releaseDigest !== digest) {
          throw new RestrictedAppError("INPUT_INVALID", "A different install is already prepared for this App and Space.");
        }
        return structuredClone(pending);
      }
      assertRestrictedAppRegistryCapacity("operations", this.#registry.operations.length, 1, "prepared operation");
      const timestamp = this.#now().toISOString();
      const operation: LocalAppInstallPlan = {
        operationId: `operation_${randomUUID()}`,
        kind: "install",
        projectId: release.projectId,
        targetSpaceId,
        releaseDigest: digest,
        runtimeInstanceId: createRuntimeInstanceId(),
        features: envelope.manifest.features.map((feature) => ({
          featureId: feature.featureId,
          featureInstallationId: createFeatureInstallationId(),
          dataNamespaceId: createDataNamespaceId(),
        })),
        preparedAt: timestamp,
      };
      await this.#writeRegistry({
        ...this.#registry,
        operations: [...this.#registry.operations, operation],
        adminReceipts: appendAdminReceipt(this.#registry.adminReceipts, {
          action: "install-prepared",
          projectId: release.projectId,
          runtimeInstanceId: operation.runtimeInstanceId,
          releaseDigest: digest,
          createdAt: timestamp,
        }),
      });
      return structuredClone(operation);
    });
  }

  async activateLocalAppInstall(operationId: string): Promise<{
    instance: LocalAppInstance;
    apps: RestrictedAppInstalled[];
  }> {
    return await this.#mutate(async () => {
      const id = restrictedAppInput(() => localAppOperationId(operationId));
      const operation = this.#registry.operations.find((item): item is LocalAppInstallPlan => (
        item.kind === "install" && item.operationId === id
      ));
      if (!operation) throw new RestrictedAppError("INPUT_INVALID", "The prepared App install is no longer available.");
      const release = this.#registry.releases.find((item) => item.releaseDigest === operation.releaseDigest
        && item.projectId === operation.projectId && item.state === "published");
      if (!release) throw new RestrictedAppError("REVISION_CHANGED", "The published Release is no longer available.");
      assertRestrictedAppRegistryCapacity("runtimeInstances", this.#registry.runtimeInstances.length, 1, "Runtime Instance");
      assertRestrictedAppRegistryCapacity(
        "installations",
        this.#registry.installations.length,
        release.featureIds.length,
        "Feature Installation",
      );
      const envelope = await this.#releaseStore.read(operation.releaseDigest);
      const packages = await this.#stageLocalReleasePackages(envelope);
      const conflict = packages.find(({ receipt }) => this.#registry.installations.some((item) => (
        item.spaceId === operation.targetSpaceId && item.manifest.id === receipt.manifest.id
      )));
      if (conflict) throw new RestrictedAppError("REVISION_CHANGED", `The target Space now contains the ${conflict.receipt.manifest.id} Feature.`);
      if (this.#registry.runtimeInstances.some((item) => item.runtimeInstanceId === operation.runtimeInstanceId)) {
        throw new RestrictedAppError("REVISION_CHANGED", "The prepared Runtime Instance id is no longer available.");
      }
      const timestamp = this.#now().toISOString();
      const runtime: RestrictedAppRuntimeInstanceRegistryEntry = {
        kind: "app",
        host: "local",
        spaceId: operation.targetSpaceId,
        projectId: operation.projectId,
        runtimeInstanceId: operation.runtimeInstanceId,
        runtimeInstanceGeneration: createAuthorityGeneration(),
        activeReleaseDigest: operation.releaseDigest,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const allocations = new Map(operation.features.map((feature) => [feature.featureId, feature]));
      const apps: RestrictedAppRegistryEntry[] = packages.map(({ feature, receipt }) => {
        const allocation = allocations.get(feature.featureId);
        if (!allocation) throw new Error(`Prepared App install is missing an allocation for ${feature.featureId}.`);
        return {
          spaceId: operation.targetSpaceId,
          projectId: operation.projectId,
          runtimeInstanceId: operation.runtimeInstanceId,
          runtimeInstanceKind: "app",
          releaseDigest: operation.releaseDigest,
          featureInstallationId: allocation.featureInstallationId,
          dataNamespaceId: allocation.dataNamespaceId,
          authority: authorityForContext(this.#registry, runtime),
          packageName: receipt.packageName,
          version: receipt.version,
          digest: receipt.digest,
          artifactDigest: receipt.artifactDigest,
          manifest: structuredClone(receipt.manifest),
          networkGrants: [],
          fileGrants: [],
          notificationGrants: [],
          automations: receipt.manifest.automations.map((automation) => ({ id: automation.id, enabled: false })),
          automationRuns: [],
          fileCount: receipt.fileCount,
          totalBytes: receipt.totalBytes,
          installedAt: timestamp,
          updatedAt: timestamp,
        };
      });
      await this.#writeRegistry({
        ...this.#registry,
        runtimeInstances: [...this.#registry.runtimeInstances, runtime],
        installations: [...this.#registry.installations, ...apps],
        operations: this.#registry.operations.filter((item) => item !== operation),
        adminReceipts: appendAdminReceipt(this.#registry.adminReceipts, {
          action: "installed",
          projectId: operation.projectId,
          runtimeInstanceId: operation.runtimeInstanceId,
          releaseDigest: operation.releaseDigest,
          createdAt: timestamp,
        }),
      });
      for (const app of apps) this.#syncAppAutomations(app);
      return {
        instance: localAppInstanceFrom(runtime, release, apps),
        apps: apps.map((app) => this.#copyInstalled(app)),
      };
    });
  }

  async prepareLocalAppUpdate(input: {
    sourceSpaceId: string;
    runtimeInstanceId: string;
    releaseDigest: string;
    continuityPolicy?: LocalAppUpdateContinuityPolicy;
  }): Promise<LocalAppUpdatePlan> {
    return await this.#mutate(async () => {
      const runtimeInstanceId = restrictedAppInput(() => parseRuntimeInstanceId(input.runtimeInstanceId));
      const runtime = this.#registry.runtimeInstances.find((item): item is Extract<
        RestrictedAppRuntimeInstanceRegistryEntry,
        { kind: "app" }
      > => item.kind === "app" && item.runtimeInstanceId === runtimeInstanceId);
      if (!runtime) throw new RestrictedAppError("INPUT_INVALID", "The local App Instance is no longer installed.");
      const targetDigest = releaseDigestValue(input.releaseDigest);
      const targetRelease = this.#publishedRelease(input.sourceSpaceId, targetDigest);
      if (targetRelease.projectId !== runtime.projectId) {
        throw new RestrictedAppError("INPUT_INVALID", "The target Release belongs to a different App Project.");
      }
      if (runtime.activeReleaseDigest === targetDigest) {
        throw new RestrictedAppError("INPUT_INVALID", "That Release is already active in this Space.");
      }
      const continuityPolicy = input.continuityPolicy ?? "eligible";
      if (continuityPolicy !== "eligible" && continuityPolicy !== "reset") {
        throw new RestrictedAppError("INPUT_INVALID", "App update continuity must be eligible or reset.");
      }
      const pending = this.#registry.operations.find((item): item is LocalAppUpdatePlan => (
        item.kind === "update" && item.runtimeInstanceId === runtime.runtimeInstanceId
      ));
      if (pending) {
        if (pending.releaseDigest !== targetDigest) {
          throw new RestrictedAppError("INPUT_INVALID", "A different update is already prepared for this App Instance.");
        }
        if (pending.continuityPolicy !== continuityPolicy) {
          throw new RestrictedAppError(
            "INPUT_INVALID",
            "This update is already prepared with a different access policy. Cancel it before preparing another policy.",
          );
        }
        return structuredClone(pending);
      }
      assertRestrictedAppRegistryCapacity("operations", this.#registry.operations.length, 1, "prepared operation");
      const operationId = `operation_${randomUUID()}`;
      const currentEntries = this.#registry.installations.filter((item) => item.runtimeInstanceId === runtime.runtimeInstanceId);
      const targetEnvelope = assertLocalRestrictedAppRelease(await this.#releaseStore.read(targetDigest));
      const conflict = targetEnvelope.manifest.features.find((feature) => this.#registry.installations.some((item) => (
        item.spaceId === runtime.spaceId
        && item.runtimeInstanceId !== runtime.runtimeInstanceId
        && item.manifest.id === feature.featureId
      )));
      if (conflict) {
        throw new RestrictedAppError(
          "INPUT_INVALID",
          `The target Space already contains the ${conflict.featureId} Feature outside this App Instance. Remove that conflicting preview or App first.`,
        );
      }
      const currentIds = new Set(currentEntries.map((entry) => entry.manifest.id));
      const allocations = targetEnvelope.manifest.features
        .filter((feature) => !currentIds.has(feature.featureId))
        .map((feature) => ({
          featureId: feature.featureId,
          featureInstallationId: createFeatureInstallationId(),
          dataNamespaceId: createDataNamespaceId(),
        }));
      const plan = await this.#buildLocalAppUpdatePlan(runtime, targetEnvelope, continuityPolicy, operationId, allocations);
      const timestamp = this.#now().toISOString();
      const operation: LocalAppUpdatePlan = {
        operationId,
        kind: "update",
        projectId: runtime.projectId,
        targetSpaceId: runtime.spaceId,
        releaseDigest: targetDigest,
        runtimeInstanceId: runtime.runtimeInstanceId,
        continuityPolicy,
        plan,
        preparedAt: timestamp,
      };
      await this.#writeRegistry({
        ...this.#registry,
        operations: [...this.#registry.operations, operation],
        adminReceipts: appendAdminReceipt(this.#registry.adminReceipts, {
          action: "update-prepared",
          projectId: runtime.projectId,
          runtimeInstanceId: runtime.runtimeInstanceId,
          releaseDigest: targetDigest,
          createdAt: timestamp,
        }),
      });
      return structuredClone(operation);
    });
  }

  async activateLocalAppUpdate(operationId: string): Promise<{
    instance: LocalAppInstance;
    apps: RestrictedAppInstalled[];
  }> {
    return await this.#mutate(async () => {
      const id = restrictedAppInput(() => localAppOperationId(operationId));
      const operation = this.#registry.operations.find((item): item is LocalAppUpdatePlan => (
        item.kind === "update" && item.operationId === id
      ));
      if (!operation) throw new RestrictedAppError("INPUT_INVALID", "The prepared App update is no longer available.");
      const runtime = this.#registry.runtimeInstances.find((item): item is Extract<
        RestrictedAppRuntimeInstanceRegistryEntry,
        { kind: "app" }
      > => item.kind === "app" && item.runtimeInstanceId === operation.runtimeInstanceId);
      if (!runtime || runtime.activeReleaseDigest !== operation.plan.fromReleaseDigest) {
        throw new RestrictedAppError("REVISION_CHANGED", "The App Instance changed after this update was prepared.");
      }
      const targetRelease = this.#registry.releases.find((item) => item.releaseDigest === operation.releaseDigest
        && item.projectId === operation.projectId && item.state === "published");
      if (!targetRelease) throw new RestrictedAppError("REVISION_CHANGED", "The target Release is no longer published.");
      const targetEnvelope = assertLocalRestrictedAppRelease(await this.#releaseStore.read(operation.releaseDigest));
      const addedAllocations = operation.plan.transitions
        .filter((transition) => transition.action === "add")
        .map((transition) => ({
          featureId: transition.featureId,
          featureInstallationId: transition.featureInstallationId,
          dataNamespaceId: transition.dataNamespaceId,
        }));
      const recomputed = await this.#buildLocalAppUpdatePlan(
        runtime,
        targetEnvelope,
        operation.continuityPolicy,
        operation.operationId,
        addedAllocations,
      );
      if (recomputed.planDigest !== operation.plan.planDigest || JSON.stringify(recomputed) !== JSON.stringify(operation.plan)) {
        throw new RestrictedAppError("REVISION_CHANGED", "The App update plan no longer matches current durable state.");
      }
      if (!recomputed.canCommit) {
        throw new RestrictedAppError("INPUT_INVALID", recomputed.blockedReasons.join(" ") || "This App update cannot be activated safely.");
      }
      const currentFeatureCount = this.#registry.installations.filter((item) => (
        item.runtimeInstanceId === runtime.runtimeInstanceId
      )).length;
      const nextFeatureCount = recomputed.transitions.filter((transition) => transition.action !== "remove").length;
      const retainedDataAdditions = recomputed.transitions.filter((transition) => transition.action === "remove").length;
      assertRestrictedAppRegistryCapacity(
        "installations",
        this.#registry.installations.length - currentFeatureCount,
        nextFeatureCount,
        "Feature Installation",
      );
      assertRestrictedAppRegistryCapacity(
        "retainedData",
        this.#registry.retainedData.length,
        retainedDataAdditions,
        "retained-data record",
      );
      const packages = await this.#stageLocalReleasePackages(targetEnvelope);
      const conflict = packages.find(({ feature }) => this.#registry.installations.some((item) => (
        item.spaceId === runtime.spaceId
        && item.runtimeInstanceId !== runtime.runtimeInstanceId
        && item.manifest.id === feature.featureId
      )));
      if (conflict) {
        throw new RestrictedAppError(
          "REVISION_CHANGED",
          `The target Space now contains the ${conflict.feature.featureId} Feature outside this App Instance.`,
        );
      }
      const packagesByFeature = new Map(packages.map((item) => [item.feature.featureId, item]));
      const current = this.#registry.installations.filter((item) => item.runtimeInstanceId === runtime.runtimeInstanceId);
      await Promise.all(current.map((app) => this.#runtimeHost?.stop(app.spaceId, app.manifest.id, app.digest)));
      // Connection reset is a revocation boundary, so remove the predecessor
      // credentials before committing the successor authority. Deferring this
      // cleanup is unsafe for exact-revision resets because the old and new
      // Feature identities intentionally match. A failure here leaves the
      // reviewed operation intact and the predecessor installation active,
      // but without the credentials the person explicitly chose to revoke.
      for (const transition of recomputed.transitions) {
        if (transition.action !== "remove" && !transition.resets.includes("connections")) continue;
        const existing = current.find((item) => item.manifest.id === transition.featureId);
        if (!existing) throw new Error(`App update connection reset is missing Feature ${transition.featureId}.`);
        // Invalidate OAuth's per-binding generation before deleting the shared
        // credential scope. An in-flight refresh or browser callback must not
        // recreate the exact binding after an explicit reset.
        await this.#invalidateOAuthApp(existing);
        if (this.#connections) {
          await this.#connections.deleteFeature(connectionFeatureScope(existing, this.#registry.localIdentity));
        }
      }
      const timestamp = this.#now().toISOString();
      const nextRuntime: Extract<RestrictedAppRuntimeInstanceRegistryEntry, { kind: "app" }> = {
        ...runtime,
        runtimeInstanceGeneration: createAuthorityGeneration(),
        activeReleaseDigest: operation.releaseDigest,
        updatedAt: timestamp,
      };
      const nextApps: RestrictedAppRegistryEntry[] = [];
      const retainedData = [...this.#registry.retainedData];
      const pendingCleanups = [...this.#registry.pendingCleanups];
      for (const transition of recomputed.transitions) {
        const existing = current.find((item) => item.manifest.id === transition.featureId);
        if (transition.action === "remove") {
          if (!existing) throw new Error(`App update removal is missing Feature ${transition.featureId}.`);
          retainedData.push(retainedDataForEntry(existing, operation.plan.fromReleaseDigest, timestamp));
          pendingCleanups.push(pendingPackageCleanupForEntry(existing, timestamp));
          continue;
        }
        const target = packagesByFeature.get(transition.featureId);
        if (!target) throw new Error(`App update target is missing Feature ${transition.featureId}.`);
        if (!existing) {
          nextApps.push({
            spaceId: runtime.spaceId,
            projectId: runtime.projectId,
            runtimeInstanceId: runtime.runtimeInstanceId,
            runtimeInstanceKind: "app",
            releaseDigest: operation.releaseDigest,
            featureInstallationId: transition.featureInstallationId,
            dataNamespaceId: transition.dataNamespaceId,
            authority: authorityForContext(this.#registry, nextRuntime),
            packageName: target.receipt.packageName,
            version: target.receipt.version,
            digest: target.receipt.digest,
            artifactDigest: target.receipt.artifactDigest,
            manifest: structuredClone(target.receipt.manifest),
            networkGrants: [],
            fileGrants: [],
            notificationGrants: [],
            automations: target.receipt.manifest.automations.map((automation) => ({ id: automation.id, enabled: false })),
            automationRuns: [],
            fileCount: target.receipt.fileCount,
            totalBytes: target.receipt.totalBytes,
            installedAt: timestamp,
            updatedAt: timestamp,
          });
          continue;
        }
        const exactContinuity = transition.resets.length === 0 && transition.action === "keep";
        let authority = existing.authority;
        if (transition.featureFenceFields.length > 0) {
          authority = advanceAuthorityStamp(authority, transition.featureFenceFields);
        }
        authority = parseAuthorityStamp({ ...authority, runtimeInstanceGeneration: nextRuntime.runtimeInstanceGeneration });
        if (!exactContinuity) {
          pendingCleanups.push(pendingPackageCleanupForEntry(existing, timestamp));
        } else if (existing.digest !== target.receipt.digest) {
          pendingCleanups.push({
            cleanupId: `cleanup_${randomUUID()}`,
            connectionScope: null,
            storageOwner: null,
            packageDigest: existing.digest,
            createdAt: timestamp,
          });
        }
        nextApps.push({
          ...existing,
          releaseDigest: operation.releaseDigest,
          authority,
          packageName: target.receipt.packageName,
          version: target.receipt.version,
          digest: target.receipt.digest,
          artifactDigest: target.receipt.artifactDigest,
          manifest: structuredClone(target.receipt.manifest),
          networkGrants: exactContinuity ? existing.networkGrants : [],
          fileGrants: exactContinuity ? existing.fileGrants : [],
          notificationGrants: exactContinuity ? existing.notificationGrants : [],
          automations: exactContinuity
            ? existing.automations
            : target.receipt.manifest.automations.map((automation) => ({ id: automation.id, enabled: false })),
          automationRuns: exactContinuity ? existing.automationRuns : [],
          fileCount: target.receipt.fileCount,
          totalBytes: target.receipt.totalBytes,
          updatedAt: timestamp,
        });
      }
      const otherApps = this.#registry.installations.filter((item) => item.runtimeInstanceId !== runtime.runtimeInstanceId);
      await this.#writeRegistry({
        ...this.#registry,
        runtimeInstances: this.#registry.runtimeInstances.map((item) => item === runtime ? nextRuntime : item),
        installations: [...otherApps, ...nextApps],
        operations: this.#registry.operations.filter((item) => item !== operation),
        retainedData,
        pendingCleanups,
        adminReceipts: appendAdminReceipt(this.#registry.adminReceipts, {
          action: "updated",
          projectId: runtime.projectId,
          runtimeInstanceId: runtime.runtimeInstanceId,
          releaseDigest: operation.releaseDigest,
          createdAt: timestamp,
        }),
      });
      for (const app of current) this.#unregisterAppAutomations(app);
      for (const app of nextApps) this.#syncAppAutomations(app);
      await this.#drainPendingCleanups();
      return {
        instance: localAppInstanceFrom(nextRuntime, targetRelease, nextApps),
        apps: nextApps.map((app) => this.#copyInstalled(app)),
      };
    });
  }

  async cancelLocalAppOperation(operationId: string): Promise<boolean> {
    return await this.#mutate(async () => {
      const id = restrictedAppInput(() => localAppOperationId(operationId));
      const operation = this.#registry.operations.find((item) => item.operationId === id);
      if (!operation) return false;
      await this.#writeRegistry({
        ...this.#registry,
        operations: this.#registry.operations.filter((item) => item !== operation),
      });
      return true;
    });
  }

  async uninstallLocalApp(input: {
    runtimeInstanceId: string;
    dataDisposition: "retain" | "purge";
  }): Promise<{ removed: boolean; retainedData: LocalAppRetainedData[]; cleanupPending: boolean }> {
    return await this.#mutate(async () => {
      const runtimeInstanceId = restrictedAppInput(() => parseRuntimeInstanceId(input.runtimeInstanceId));
      if (input.dataDisposition !== "retain" && input.dataDisposition !== "purge") {
        throw new RestrictedAppError("INPUT_INVALID", "Choose whether to retain or purge this App's local data.");
      }
      const runtime = this.#registry.runtimeInstances.find((item): item is Extract<
        RestrictedAppRuntimeInstanceRegistryEntry,
        { kind: "app" }
      > => item.kind === "app" && item.runtimeInstanceId === runtimeInstanceId);
      if (!runtime) return { removed: false, retainedData: [], cleanupPending: this.#registry.pendingCleanups.length > 0 };
      const apps = this.#registry.installations.filter((item) => item.runtimeInstanceId === runtimeInstanceId);
      if (input.dataDisposition === "retain") {
        assertRestrictedAppRegistryCapacity(
          "retainedData",
          this.#registry.retainedData.length,
          apps.length,
          "retained-data record",
        );
      }
      await Promise.all(apps.map((app) => this.#runtimeHost?.stop(app.spaceId, app.manifest.id, app.digest)));
      await Promise.all(apps.map((app) => this.#invalidateOAuthApp(app)));
      const timestamp = this.#now().toISOString();
      const previouslyRetained = this.#registry.retainedData.filter((item) => item.runtimeInstanceId === runtimeInstanceId);
      const retained = input.dataDisposition === "retain"
        ? apps.map((app) => retainedDataForEntry(app, runtime.activeReleaseDigest, timestamp))
        : [];
      const retainedData = input.dataDisposition === "purge"
        ? this.#registry.retainedData.filter((item) => item.runtimeInstanceId !== runtimeInstanceId)
        : [...this.#registry.retainedData, ...retained];
      await this.#writeRegistry({
        ...this.#registry,
        runtimeInstances: this.#registry.runtimeInstances.filter((item) => item !== runtime),
        installations: this.#registry.installations.filter((item) => item.runtimeInstanceId !== runtimeInstanceId),
        operations: this.#registry.operations.filter((item) => item.runtimeInstanceId !== runtimeInstanceId),
        retainedData,
        pendingCleanups: [
          ...this.#registry.pendingCleanups,
          ...apps.map((app) => pendingCleanupForEntry(
            app,
            this.#registry.localIdentity,
            input.dataDisposition === "purge",
            timestamp,
          )),
          ...(input.dataDisposition === "purge"
            ? previouslyRetained.map((item) => pendingCleanupForRetainedData(item, this.#registry.localIdentity, timestamp))
            : []),
        ],
        adminReceipts: appendAdminReceipt(this.#registry.adminReceipts, {
          action: "uninstalled",
          projectId: runtime.projectId,
          runtimeInstanceId: runtime.runtimeInstanceId,
          releaseDigest: runtime.activeReleaseDigest,
          dataDisposition: input.dataDisposition,
          createdAt: timestamp,
        }),
      });
      for (const app of apps) this.#unregisterAppAutomations(app);
      await this.#drainPendingCleanups();
      return {
        removed: true,
        retainedData: structuredClone(retained),
        cleanupPending: this.#registry.pendingCleanups.length > 0,
      };
    });
  }

  async purgeLocalAppRetainedData(retainedDataId: string): Promise<{ purged: boolean; cleanupPending: boolean }> {
    return await this.#mutate(async () => {
      const id = restrictedAppInput(() => nonempty(retainedDataId, "Local App retained data id", 64));
      const retained = this.#registry.retainedData.find((item) => item.retainedDataId === id);
      if (!retained) return { purged: false, cleanupPending: this.#registry.pendingCleanups.length > 0 };
      const timestamp = this.#now().toISOString();
      const cleanup: RestrictedAppPendingCleanup = {
        cleanupId: `cleanup_${randomUUID()}`,
        connectionScope: null,
        storageOwner: {
          ownerClass: "instance",
          tenantId: this.#registry.localIdentity.tenantId,
          runtimeInstanceId: retained.runtimeInstanceId,
          featureInstallationId: retained.featureInstallationId,
          dataNamespaceId: retained.dataNamespaceId,
        },
        packageDigest: null,
        createdAt: timestamp,
      };
      await this.#writeRegistry({
        ...this.#registry,
        retainedData: this.#registry.retainedData.filter((item) => item !== retained),
        pendingCleanups: [...this.#registry.pendingCleanups, cleanup],
        adminReceipts: appendAdminReceipt(this.#registry.adminReceipts, {
          action: "retained-data-purged",
          projectId: retained.projectId,
          runtimeInstanceId: retained.runtimeInstanceId,
          releaseDigest: retained.releaseDigest,
          createdAt: timestamp,
        }),
      });
      await this.#drainPendingCleanups();
      return { purged: true, cleanupPending: this.#registry.pendingCleanups.length > 0 };
    });
  }

  async runtimeDescriptor(spaceId: string, appId: string, expectedDigest: string): Promise<RestrictedAppRuntimeDescriptor> {
    this.#assertOpen();
    await this.#queue.catch(() => undefined);
    await assertRestrictedAppStagingRoot(this.#stagingPath);
    const app = this.#installed(spaceId, appId, expectedDigest);
    return { ...app, stagedRoot: this.#digestRoot(app.digest) };
  }

  async install(input: {
    spaceId: string;
    spaceRoot: string;
    sourcePath: string;
    expectedDigest: string;
  }): Promise<RestrictedAppInstalled> {
    return await this.#mutate(async () => {
      const expectedDigest = digestValue(input.expectedDigest);
      const sourceRoot = await restrictedSourceRoot(input.spaceRoot, input.sourcePath);
      const inspection = await inspectRestrictedAppPackage(sourceRoot);
      if (inspection.digest !== expectedDigest) throw new RestrictedAppError("REVISION_CHANGED", "The package changed after review. Review the new revision before installing it.");
      const existing = this.#registry.installations.find((item) => item.spaceId === input.spaceId && item.manifest.id === inspection.manifest.id);
      if (existing?.runtimeInstanceKind === "app") {
        throw new RestrictedAppError("INPUT_INVALID", "An installed Release already contributes this Feature in the Space. Choose another Space or uninstall it first.");
      }
      if (existing?.digest === inspection.digest) {
        try {
          await stageRestrictedAppPackage(sourceRoot, this.#stagingPath, expectedDigest);
        } catch (error) {
          throw new RestrictedAppError("REVISION_CHANGED", errorMessage(error));
        }
        return this.#copyInstalled(existing);
      }
      if (existing && existing.packageName !== inspection.packageName) {
        throw new RestrictedAppError("INPUT_INVALID", "A different package already owns this restricted app id in the Space.");
      }
      const hasProject = this.#registry.projects.some((item) => item.spaceId === input.spaceId);
      const hasDevelopmentRuntime = this.#registry.runtimeInstances.some((item) => (
        item.kind === "development" && item.spaceId === input.spaceId
      ));
      assertRestrictedAppRegistryCapacity("projects", this.#registry.projects.length, hasProject ? 0 : 1, "App Project");
      assertRestrictedAppRegistryCapacity(
        "runtimeInstances",
        this.#registry.runtimeInstances.length,
        hasDevelopmentRuntime ? 0 : 1,
        "Runtime Instance",
      );
      assertRestrictedAppRegistryCapacity(
        "installations",
        this.#registry.installations.length - (existing ? 1 : 0),
        1,
        "Feature Installation",
      );
      let staged: Awaited<ReturnType<typeof stageRestrictedAppPackage>>;
      try {
        staged = await stageRestrictedAppPackage(sourceRoot, this.#stagingPath, expectedDigest);
      } catch (error) {
        throw new RestrictedAppError("REVISION_CHANGED", errorMessage(error));
      }
      if (staged.digest !== expectedDigest) throw new RestrictedAppError("REVISION_CHANGED", "The package changed while it was being staged.");
      if (existing) {
        await this.#runtimeHost?.stop(input.spaceId, existing.manifest.id, existing.digest);
        await this.#invalidateOAuthApp(existing);
      }
      const timestamp = this.#now().toISOString();
      const hadProject = hasProject;
      const context = developmentContext(this.#registry, input.spaceId, timestamp);
      const project = hadProject ? context.project : {
        ...context.project,
        presentation: presentationFromManifest(staged.manifest),
        updatedAt: timestamp,
      };
      const projects = hadProject
        ? context.projects
        : context.projects.map((item) => item === context.project ? project : item);
      const entry: RestrictedAppRegistryEntry = {
        spaceId: input.spaceId,
        projectId: project.projectId,
        runtimeInstanceId: context.runtimeInstance.runtimeInstanceId,
        runtimeInstanceKind: "development",
        releaseDigest: null,
        featureInstallationId: existing?.featureInstallationId ?? createFeatureInstallationId(),
        dataNamespaceId: existing?.dataNamespaceId ?? createDataNamespaceId(),
        authority: existing
          ? advanceAuthorityStamp(existing.authority, [
            "featureInstallationGeneration",
            "grantGeneration",
            "connectionGeneration",
            "jobGeneration",
          ])
          : authorityForContext(this.#registry, context.runtimeInstance),
        packageName: staged.packageName,
        version: staged.version,
        digest: staged.digest,
        artifactDigest: staged.artifactDigest,
        manifest: structuredClone(staged.manifest),
        networkGrants: [],
        fileGrants: [],
        notificationGrants: [],
        automations: staged.manifest.automations.map((automation) => ({ id: automation.id, enabled: false })),
        automationRuns: [],
        fileCount: staged.fileCount,
        totalBytes: staged.totalBytes,
        installedAt: existing?.installedAt ?? timestamp,
        updatedAt: timestamp,
      };
      const next = this.#registry.installations.filter((item) => !(item.spaceId === input.spaceId && item.manifest.id === entry.manifest.id));
      next.push(entry);
      const pendingCleanups = existing
        ? [...this.#registry.pendingCleanups, pendingCleanupForEntry(existing, this.#registry.localIdentity, false, timestamp)]
        : this.#registry.pendingCleanups;
      await this.#writeRegistry({
        ...this.#registry,
        projects,
        runtimeInstances: context.runtimeInstances,
        installations: next,
        pendingCleanups,
      });
      if (existing) {
        this.#unregisterAppAutomations(existing);
        await this.#drainPendingCleanups();
      }
      this.#syncAppAutomations(entry);
      return this.#copyInstalled(entry);
    });
  }

  async remove(input: { spaceId: string; appId: string; expectedDigest?: string }): Promise<boolean> {
    return await this.#mutate(async () => {
      const appId = appIdValue(input.appId);
      const existing = this.#registry.installations.find((item) => item.spaceId === input.spaceId && item.manifest.id === appId);
      if (!existing) return false;
      if (existing.runtimeInstanceKind === "app") {
        throw new RestrictedAppError("INPUT_INVALID", "Installed Releases must be uninstalled from App Studio with an explicit data choice.");
      }
      if (input.expectedDigest !== undefined && digestValue(input.expectedDigest) !== existing.digest) {
        throw new RestrictedAppError("REVISION_CHANGED", "The installed app revision changed. Refresh before removing it.");
      }
      await this.#runtimeHost?.stop(input.spaceId, appId, existing.digest);
      await this.#invalidateOAuthApp(existing);
      const timestamp = this.#now().toISOString();
      await this.#writeRegistry({
        ...this.#registry,
        installations: this.#registry.installations.filter((item) => item !== existing),
        pendingCleanups: [
          ...this.#registry.pendingCleanups,
          pendingCleanupForEntry(existing, this.#registry.localIdentity, true, timestamp),
        ],
      });
      this.#unregisterAppAutomations(existing);
      await this.#drainPendingCleanups();
      return true;
    });
  }

  async removeSpace(spaceId: string): Promise<void> {
    await this.#mutate(async () => {
      const attachedInstance = this.#registry.runtimeInstances.find((item) => item.kind === "app" && item.spaceId === spaceId);
      const sourceProject = this.#registry.projects.find((item) => item.spaceId === spaceId);
      const publishedInstance = sourceProject && this.#registry.runtimeInstances.find((item) => item.kind === "app"
        && item.projectId === sourceProject.projectId);
      if (attachedInstance || publishedInstance) {
        throw new RestrictedAppError("INPUT_INVALID", "Uninstall release-backed Apps from this Space before removing it.");
      }
      if (sourceProject && this.#registry.retainedData.some((item) => item.projectId === sourceProject.projectId)) {
        throw new RestrictedAppError(
          "INPUT_INVALID",
          "Purge this App Project's retained local data in App Studio before removing its source Space.",
        );
      }
      const removed = this.#registry.installations.filter((item) => item.spaceId === spaceId
        && item.runtimeInstanceKind === "development");
      const hasContext = this.#registry.projects.some((item) => item.spaceId === spaceId)
        || this.#registry.runtimeInstances.some((item) => item.kind === "development" && item.spaceId === spaceId)
        || this.#registry.operations.some((item) => item.targetSpaceId === spaceId);
      if (!removed.length && !hasContext) return;
      await Promise.all(removed.map((app) => this.#runtimeHost?.stop(spaceId, app.manifest.id, app.digest)));
      await Promise.all(removed.map((app) => this.#invalidateOAuthApp(app)));
      const timestamp = this.#now().toISOString();
      const project = sourceProject;
      await this.#writeRegistry({
        ...this.#registry,
        projects: this.#registry.projects.filter((item) => item.spaceId !== spaceId),
        runtimeInstances: this.#registry.runtimeInstances.filter((item) => !(item.kind === "development" && item.spaceId === spaceId)),
        installations: this.#registry.installations.filter((item) => !(item.spaceId === spaceId && item.runtimeInstanceKind === "development")),
        releases: project
          ? this.#registry.releases.filter((item) => item.projectId !== project.projectId)
          : this.#registry.releases,
        operations: this.#registry.operations.filter((item) => item.targetSpaceId !== spaceId
          && (!project || item.projectId !== project.projectId)),
        adminReceipts: project
          ? this.#registry.adminReceipts.filter((item) => item.projectId !== project.projectId)
          : this.#registry.adminReceipts,
        pendingCleanups: [
          ...this.#registry.pendingCleanups,
          ...removed.map((app) => pendingCleanupForEntry(app, this.#registry.localIdentity, true, timestamp)),
        ],
      });
      if (project) {
        await this.#reconcileReleaseStore();
      }
      for (const app of removed) this.#unregisterAppAutomations(app);
      await this.#drainPendingCleanups();
    });
  }

  async invoke(input: { spaceId: string; appId: string; expectedDigest: string; action: string; input: unknown }): Promise<unknown> {
    this.#assertOpen();
    await this.#queue.catch(() => undefined);
    if (!this.#runtimeHost) throw new RestrictedAppError("APP_UNAVAILABLE", "Restricted apps can run only in the work-fold desktop host.");
    const app = this.#installed(input.spaceId, input.appId, input.expectedDigest);
    const action = app.manifest.tools.find((tool) => tool.action === input.action)?.action;
    if (!action) throw new RestrictedAppError("ACTION_UNKNOWN", "The restricted app action is not declared.");
    return await this.#runtimeHost.invoke({ ...app, stagedRoot: this.#digestRoot(app.digest) }, action, input.input);
  }

  async connectionStatus(spaceId: string, appId: string, expectedDigest: string): Promise<RestrictedAppConnectionStatus[]> {
    this.#assertOpen();
    const app = this.#installed(spaceId, appId, expectedDigest);
    return await Promise.all(app.manifest.permissions.network.map(async (destination) => {
      const none = destination.auth.some((item) => item.kind === "none");
      if (none) return { destinationId: destination.id, owner: "instance" as const, kind: "none" as const, configured: true };
      const binding = connectionBinding(app, this.#registry.localIdentity, destination);
      const credential = await this.#connections?.get(binding);
      return {
        destinationId: destination.id,
        owner: binding.owner.kind,
        kind: credential?.kind ?? null,
        configured: Boolean(credential),
        ...(credential?.kind === "oauth2-pkce" && credential.diagnostics?.length
          ? { diagnostics: credential.diagnostics.map((diagnostic) => ({ ...diagnostic })) }
          : {}),
      };
    }));
  }

  async setConnection(input: { spaceId: string; appId: string; expectedDigest: string; destinationId: string; credential: unknown }): Promise<RestrictedAppConnectionStatus> {
    return await this.#mutate(async () => {
      if (!this.#connections) throw new RestrictedAppError("APP_UNAVAILABLE", "Encrypted app connections require the work-fold desktop host.");
      const app = this.#installed(input.spaceId, input.appId, input.expectedDigest);
      const destination = app.manifest.permissions.network.find((item) => item.id === input.destinationId);
      if (!destination) throw new RestrictedAppError("NETWORK_DENIED", "The app did not declare this connection destination.");
      let credential: RestrictedAppCredential;
      try {
        credential = normalizeRestrictedAppCredential(input.credential);
      } catch (error) {
        throw new RestrictedAppError("INPUT_INVALID", errorMessage(error));
      }
      if (credential.kind === "oauth2-pkce") throw new RestrictedAppError("INPUT_INVALID", "OAuth tokens can be created only by work-fold's browser sign-in flow.");
      if (!destination.auth.some((item) => item.kind === credential.kind)) throw new RestrictedAppError("AUTH_REQUIRED", "This connection type is not accepted by the app revision.");
      await this.#runtimeHost?.stop(app.spaceId, app.manifest.id, app.digest);
      const authorized = await this.#advanceInstalledAuthority(app, ["connectionGeneration"]);
      const authorizeEffect = () => this.#assertInstalledAuthority(authorized);
      await this.#invalidateOAuthDestination(authorized, destination, authorizeEffect);
      await this.#connections.set(
        connectionBinding(authorized, this.#registry.localIdentity, destination),
        credential,
        authorizeEffect,
      );
      return { destinationId: destination.id, owner: "instance", kind: credential.kind, configured: true };
    });
  }

  async deleteConnection(input: { spaceId: string; appId: string; expectedDigest: string; destinationId: string }): Promise<boolean> {
    return await this.#mutate(async () => {
      if (!this.#connections) return false;
      const app = this.#installed(input.spaceId, input.appId, input.expectedDigest);
      const destination = app.manifest.permissions.network.find((item) => item.id === input.destinationId);
      if (!destination) return false;
      await this.#runtimeHost?.stop(app.spaceId, app.manifest.id, app.digest);
      const authorized = await this.#advanceInstalledAuthority(app, ["connectionGeneration"]);
      const authorizeEffect = () => this.#assertInstalledAuthority(authorized);
      const oauthRemoved = await this.#invalidateOAuthDestination(authorized, destination, authorizeEffect);
      const removed = oauthRemoved !== undefined
        ? oauthRemoved
        : await this.#connections.delete(
          connectionBinding(authorized, this.#registry.localIdentity, destination),
          authorizeEffect,
        );
      return removed;
    });
  }

  async connectOAuth(input: { spaceId: string; appId: string; expectedDigest: string; destinationId: string }): Promise<RestrictedAppConnectionStatus> {
    this.#assertOpen();
    if (!this.#oauth) throw new RestrictedAppError("APP_UNAVAILABLE", "OAuth browser sign-in requires the work-fold desktop host.");
    await this.#queue.catch(() => undefined);
    const app = this.#installed(input.spaceId, input.appId, input.expectedDigest);
    const destination = app.manifest.permissions.network.find((item) => item.id === input.destinationId);
    const declaration = destination?.auth.find((item) => item.kind === "oauth2-pkce");
    if (!destination || destination.target.kind !== "public-https" || !declaration) {
      throw new RestrictedAppError("AUTH_REQUIRED", "This app destination does not declare OAuth browser sign-in.");
    }
    try {
      await this.#runtimeHost?.stop(app.spaceId, app.manifest.id, app.digest);
      const authorized = await this.#mutate(async () => {
        const current = this.#installed(input.spaceId, input.appId, input.expectedDigest);
        return await this.#advanceInstalledAuthority(current, ["connectionGeneration"]);
      });
      const status = await this.#oauth.connect(
        connectionBinding(authorized, this.#registry.localIdentity, destination),
        declaration,
        undefined,
        () => this.#assertInstalledAuthority(authorized),
      );
      return {
        destinationId: destination.id,
        owner: "instance",
        kind: status.kind,
        configured: true,
        ...(status.diagnostics?.length
          ? { diagnostics: status.diagnostics.map((diagnostic) => ({ ...diagnostic })) }
          : {}),
      };
    } catch (error) {
      if (!(error instanceof RestrictedAppOAuthError)) throw error;
      throw new RestrictedAppError(
        error.code === "AUTH_CANCELLED" || error.code === "AUTH_DENIED" || error.code === "AUTH_REQUIRED" ? "AUTH_REQUIRED"
          : error.code === "STORAGE_FAILED" ? "STORAGE_FAILED" : "NETWORK_FAILED",
        error.message,
      );
    }
  }

  async grantNetwork(input: { spaceId: string; appId: string; expectedDigest: string; destinationId: string }): Promise<RestrictedAppInstalled> {
    return await this.#setNetworkGrant(input, true);
  }

  async revokeNetwork(input: { spaceId: string; appId: string; expectedDigest: string; destinationId: string }): Promise<RestrictedAppInstalled> {
    return await this.#setNetworkGrant(input, false);
  }

  async grantFiles(input: { spaceId: string; spaceRoot: string; appId: string; expectedDigest: string; permissionId: string; root: string }): Promise<RestrictedAppInstalled> {
    return await this.#setFileGrant(input, true);
  }

  async revokeFiles(input: { spaceId: string; appId: string; expectedDigest: string; permissionId: string }): Promise<RestrictedAppInstalled> {
    return await this.#setFileGrant(input, false);
  }

  async grantNotifications(input: { spaceId: string; appId: string; expectedDigest: string; permissionId: string }): Promise<RestrictedAppInstalled> {
    return await this.#setNotificationGrant(input, true);
  }

  async revokeNotifications(input: { spaceId: string; appId: string; expectedDigest: string; permissionId: string }): Promise<RestrictedAppInstalled> {
    return await this.#setNotificationGrant(input, false);
  }

  async setAutomationEnabled(input: {
    spaceId: string;
    appId: string;
    expectedDigest: string;
    automationId: string;
    enabled: boolean;
  }): Promise<RestrictedAppInstalled> {
    return await this.#mutate(async () => {
      const app = this.#installed(input.spaceId, input.appId, input.expectedDigest);
      const declaration = automationDeclaration(app.manifest, input.automationId);
      if (input.enabled) this.#assertAutomationRuntime();
      const existing = this.#registry.installations.find((item) => item.spaceId === app.spaceId && item.manifest.id === app.manifest.id)!;
      const state = existing.automations.find((item) => item.id === declaration.id)!;
      if (state.enabled === input.enabled) return this.#copyInstalled(existing);
      const nextState: RestrictedAppAutomationRegistryState = {
        ...state,
        enabled: input.enabled,
        ...(input.enabled ? { lastScheduledAt: this.#now().toISOString() } : { lastError: undefined }),
      };
      const next: RestrictedAppRegistryEntry = {
        ...existing,
        authority: advanceAuthorityStamp(existing.authority, ["jobGeneration"]),
        automations: existing.automations.map((item) => item === state ? nextState : item),
      };
      if (!input.enabled) this.#syncAutomation(next, declaration);
      try {
        if (!input.enabled) await this.#runtimeHost?.stop(app.spaceId, app.manifest.id, app.digest);
        await this.#writeRegistry({
          ...this.#registry,
          installations: this.#registry.installations.map((item) => item === existing ? next : item),
        });
      } catch (error) {
        if (!input.enabled) this.#syncAutomation(existing, declaration);
        throw error;
      }
      this.#syncAutomation(next, declaration);
      return this.#copyInstalled(next);
    });
  }

  async runAutomationNow(input: {
    spaceId: string;
    appId: string;
    expectedDigest: string;
    automationId: string;
  }): Promise<{ app: RestrictedAppInstalled; run: RestrictedAppAutomationRunReceipt }> {
    const app = this.#installed(input.spaceId, input.appId, input.expectedDigest);
    const declaration = automationDeclaration(app.manifest, input.automationId);
    this.#assertAutomationRuntime();
    if (!this.#automationsStarted || this.#spaceRuntimeExclusions.has(app.spaceId)) {
      throw new RestrictedAppError("APP_UNAVAILABLE", "Automations are not active for this Space.");
    }
    const entry = this.#registry.installations.find((item) => item.runtimeInstanceId === app.runtimeInstanceId
      && item.featureInstallationId === app.featureInstallationId)!;
    const key = automationKey(entry, declaration.id);
    if (!this.#automations.has(key)) {
      this.#syncAutomation(entry, declaration);
    }
    const result = await this.#automations.runNow(key);
    const recorded = await this.#recordAutomationResult(result);
    if (!recorded) throw new RestrictedAppError("APP_UNAVAILABLE", "The automation receipt could not be persisted.");
    return {
      app: this.#installed(input.spaceId, input.appId, input.expectedDigest),
      run: recorded,
    };
  }

  async listAutomationRuns(
    spaceId: string,
    appId: string,
    expectedDigest: string,
    automationId: string,
  ): Promise<RestrictedAppAutomationRunReceipt[]> {
    const app = this.#installed(spaceId, appId, expectedDigest);
    const declaration = automationDeclaration(app.manifest, automationId);
    const entry = this.#registry.installations.find((item) => item.spaceId === app.spaceId && item.manifest.id === app.manifest.id)!;
    return entry.automationRuns
      .filter((run) => run.automationId === declaration.id && run.packageDigest === app.digest)
      .slice(-50)
      .reverse()
      .map(({ packageDigest: _packageDigest, ...run }) => structuredClone(run));
  }

  /**
   * Starts persisted jobs after higher-level lifecycle recovery. Exclusions are
   * persistent until the removal coordinator explicitly releases a completed
   * removal, so repeated startup calls cannot reactivate a pending Space.
   */
  startAutomations(excludedSpaceIds: readonly string[] = []): void {
    this.#assertOpen();
    if (!Array.isArray(excludedSpaceIds)) {
      throw new RestrictedAppError("INPUT_INVALID", "Automation startup exclusions must be an array of Space ids.");
    }
    const parsedSpaceIds = excludedSpaceIds.map((value) => (
      restrictedAppInput(() => nonempty(value, "Automation startup Space id", 200))
    ));
    const newlyExcluded = new Set<string>();
    for (const spaceId of parsedSpaceIds) {
      if (!this.#spaceRuntimeExclusions.has(spaceId)) newlyExcluded.add(spaceId);
      this.#spaceRuntimeExclusions.add(spaceId);
    }
    for (const app of this.#registry.installations) {
      if (newlyExcluded.has(app.spaceId)) this.#unregisterAppAutomations(app);
    }
    if (parsedSpaceIds.length > 0) this.#syncRuntimeAuthorities();
    if (this.#automationsStarted) return;
    this.#automationsStarted = true;
    this.#syncAllAutomations();
  }

  /** Fences every runtime effect and scheduled launch after a durable Space-removal intent. */
  fenceSpaceRemoval(spaceId: string): void {
    this.#assertOpen();
    const parsedSpaceId = restrictedAppInput(() => nonempty(spaceId, "Space id", 200));
    if (!this.#spaceRuntimeExclusions.has(parsedSpaceId)) {
      this.#spaceRuntimeExclusions.add(parsedSpaceId);
      for (const app of this.#registry.installations) {
        if (app.spaceId === parsedSpaceId) this.#unregisterAppAutomations(app);
      }
    }
    this.#syncRuntimeAuthorities();
  }

  /** Releases an in-process fence only after the durable removal fully commits. */
  releaseSpaceRemovalFence(spaceId: string): void {
    this.#assertOpen();
    const parsedSpaceId = restrictedAppInput(() => nonempty(spaceId, "Space id", 200));
    if (!this.#spaceRuntimeExclusions.delete(parsedSpaceId)) return;
    this.#syncRuntimeAuthorities();
  }

  suspendAutomations(): void {
    this.#automations.suspend();
    this.#runtimeHost?.suspend?.();
  }

  resumeAutomations(): void {
    if (this.#closed) return;
    this.#runtimeHost?.resume?.();
    this.#automations.resume();
  }

  async storageUsage(spaceId: string, appId: string, expectedDigest: string): Promise<RestrictedAppStorageUsage> {
    const app = this.#installed(spaceId, appId, expectedDigest);
    if (!this.#storage) throw new RestrictedAppError("APP_UNAVAILABLE", "Restricted app storage requires the work-fold desktop host.");
    return await this.#storage.usage(storageOwnerFromEntry(app, this.#registry.localIdentity));
  }

  async clearStorage(spaceId: string, appId: string, expectedDigest: string): Promise<RestrictedAppStorageUsage> {
    return await this.#mutate(async () => {
      const app = this.#installed(spaceId, appId, expectedDigest);
      if (!this.#storage) throw new RestrictedAppError("APP_UNAVAILABLE", "Restricted app storage requires the work-fold desktop host.");
      await this.#runtimeHost?.stop(app.spaceId, app.manifest.id, app.digest);
      await this.#advanceInstalledAuthority(app, ["dataGeneration"]);
      return await this.#storage.clear(storageOwnerFromEntry(app, this.#registry.localIdentity));
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#automations.close();
    await this.#queue.catch(() => undefined);
    await this.#runtimeHost?.close();
  }

  #installed(spaceId: string, appId: string, expectedDigest: string): RestrictedAppInstalled {
    const id = appIdValue(appId);
    const digest = digestValue(expectedDigest);
    const entry = this.#registry.installations.find((item) => item.spaceId === spaceId && item.manifest.id === id);
    if (!entry) throw new RestrictedAppError("APP_UNAVAILABLE", "The restricted app is not installed in this Space.");
    if (entry.digest !== digest) throw new RestrictedAppError("REVISION_CHANGED", "The restricted app revision changed. Refresh before using it.");
    return this.#copyInstalled(entry);
  }

  #copyInstalled(entry: RestrictedAppRegistryEntry): RestrictedAppInstalled {
    const sourceSpaceId = this.#registry.projects.find((item) => item.projectId === entry.projectId)?.spaceId;
    if (!sourceSpaceId) throw new Error("Restricted app Project source Space is unavailable.");
    const installed = copyInstalled(entry, this.#registry.localIdentity, sourceSpaceId);
    installed.automations = installed.automations.map((state) => {
      const nextRunAt = this.#automations.nextScheduledAt(automationKey(entry, state.id));
      return { ...state, ...(nextRunAt ? { nextRunAt } : {}) };
    });
    return installed;
  }

  async #advanceInstalledAuthority(
    app: Pick<RestrictedAppInstalled, "spaceId" | "digest" | "manifest">,
    fields: readonly Parameters<typeof advanceAuthorityStamp>[1][number][],
  ): Promise<RestrictedAppInstalled> {
    const existing = this.#registry.installations.find((item) => item.spaceId === app.spaceId
      && item.manifest.id === app.manifest.id && item.digest === app.digest);
    if (!existing) throw new RestrictedAppError("REVISION_CHANGED", "The restricted app authority changed before the operation completed.");
    const next = { ...existing, authority: advanceAuthorityStamp(existing.authority, fields) };
    await this.#writeRegistry({
      ...this.#registry,
      installations: this.#registry.installations.map((item) => item === existing ? next : item),
    });
    return this.#copyInstalled(next);
  }

  #assertInstalledAuthority(expected: Pick<RestrictedAppInstalled,
    "runtimeInstanceId" | "featureInstallationId" | "artifactDigest" | "authority">): void {
    const current = this.#registry.installations.find((item) => item.runtimeInstanceId === expected.runtimeInstanceId
      && item.featureInstallationId === expected.featureInstallationId
      && item.artifactDigest === expected.artifactDigest);
    if (!current || !authorityStampsEqual(current.authority, expected.authority)) {
      throw new RestrictedAppError("AUTHORITY_STALE", "The restricted app authority changed before the effect committed.");
    }
  }

  async #setNetworkGrant(
    input: { spaceId: string; appId: string; expectedDigest: string; destinationId: string },
    granted: boolean,
  ): Promise<RestrictedAppInstalled> {
    return await this.#mutate(async () => {
      const app = this.#installed(input.spaceId, input.appId, input.expectedDigest);
      const destination = app.manifest.permissions.network.find((item) => item.id === input.destinationId);
      if (!destination) throw new RestrictedAppError("NETWORK_DENIED", "The app did not declare this network destination.");
      const currentlyGranted = app.networkGrants.includes(destination.id);
      if (currentlyGranted === granted) return app;
      const existing = this.#registry.installations.find((item) => item.spaceId === app.spaceId && item.manifest.id === app.manifest.id)!;
      await this.#runtimeHost?.stop(app.spaceId, app.manifest.id, app.digest);
      const next: RestrictedAppRegistryEntry = {
        ...existing,
        authority: advanceAuthorityStamp(existing.authority, ["grantGeneration"]),
        networkGrants: granted
          ? [...existing.networkGrants, destination.id].sort()
          : existing.networkGrants.filter((id) => id !== destination.id),
      };
      await this.#writeRegistry({
        ...this.#registry,
        installations: this.#registry.installations.map((item) => item === existing ? next : item),
      });
      return this.#copyInstalled(next);
    });
  }

  async #setFileGrant(
    input: { spaceId: string; spaceRoot?: string; appId: string; expectedDigest: string; permissionId: string; root?: string },
    granted: boolean,
  ): Promise<RestrictedAppInstalled> {
    return await this.#mutate(async () => {
      const app = this.#installed(input.spaceId, input.appId, input.expectedDigest);
      const permission = app.manifest.permissions.files.find((item) => item.id === input.permissionId);
      if (!permission) throw new RestrictedAppError("FILE_DENIED", "The app did not declare this Space file permission.");
      const currentlyGranted = app.fileGrants.some((item) => item.declarationId === permission.id);
      if (currentlyGranted === granted) return app;
      const existing = this.#registry.installations.find((item) => item.spaceId === app.spaceId && item.manifest.id === app.manifest.id)!;
      const nextGrant = granted ? {
        id: permission.id,
        declarationId: permission.id,
        root: restrictedAppGrantRoot(input.root),
        access: permission.access,
      } : undefined;
      if (nextGrant) {
        if (!input.spaceRoot) throw new RestrictedAppError("FILE_DENIED", "The app's Space is no longer registered.");
        try {
          await new RestrictedAppFileBroker().validateGrant({
            spaceRoot: input.spaceRoot,
            declarations: [permission],
            grants: [nextGrant],
          }, nextGrant.id);
        } catch (error) {
          throw new RestrictedAppError("FILE_DENIED", errorMessage(error));
        }
      }
      await this.#runtimeHost?.stop(app.spaceId, app.manifest.id, app.digest);
      const next: RestrictedAppRegistryEntry = {
        ...existing,
        authority: advanceAuthorityStamp(existing.authority, ["grantGeneration"]),
        fileGrants: granted
          ? [...existing.fileGrants, nextGrant!].sort((left, right) => left.id.localeCompare(right.id))
          : existing.fileGrants.filter((item) => item.declarationId !== permission.id),
      };
      await this.#writeRegistry({
        ...this.#registry,
        installations: this.#registry.installations.map((item) => item === existing ? next : item),
      });
      return this.#copyInstalled(next);
    });
  }

  async #setNotificationGrant(
    input: { spaceId: string; appId: string; expectedDigest: string; permissionId: string },
    granted: boolean,
  ): Promise<RestrictedAppInstalled> {
    return await this.#mutate(async () => {
      const app = this.#installed(input.spaceId, input.appId, input.expectedDigest);
      const permission = app.manifest.permissions.notifications.find((item) => item.id === input.permissionId);
      if (!permission) throw new RestrictedAppError("INPUT_INVALID", "The app did not declare this notification category.");
      const currentlyGranted = app.notificationGrants.includes(permission.id);
      if (currentlyGranted === granted) return app;
      const existing = this.#registry.installations.find((item) => item.spaceId === app.spaceId && item.manifest.id === app.manifest.id)!;
      await this.#runtimeHost?.stop(app.spaceId, app.manifest.id, app.digest);
      const next: RestrictedAppRegistryEntry = {
        ...existing,
        authority: advanceAuthorityStamp(existing.authority, ["grantGeneration"]),
        notificationGrants: granted
          ? [...existing.notificationGrants, permission.id].sort()
          : existing.notificationGrants.filter((id) => id !== permission.id),
      };
      await this.#writeRegistry({
        ...this.#registry,
        installations: this.#registry.installations.map((item) => item === existing ? next : item),
      });
      return this.#copyInstalled(next);
    });
  }

  #syncAllAutomations(): void {
    for (const app of this.#registry.installations) this.#syncAppAutomations(app);
  }

  #syncAppAutomations(app: RestrictedAppRegistryEntry): void {
    if (!this.#automationsStarted || this.#spaceRuntimeExclusions.has(app.spaceId)) return;
    for (const declaration of app.manifest.automations) this.#syncAutomation(app, declaration);
  }

  #syncAutomation(app: RestrictedAppRegistryEntry, declaration: RestrictedAppAutomationDeclaration): void {
    if (!this.#automationsStarted || this.#spaceRuntimeExclusions.has(app.spaceId)) return;
    const state = app.automations.find((item) => item.id === declaration.id);
    if (!state) throw new Error(`Restricted app automation state is missing for ${declaration.id}.`);
    const definition = {
      key: automationKey(app, declaration.id),
      intervalMinutes: declaration.trigger.intervalMinutes,
      enabled: state.enabled,
      catchUp: declaration.catchUp,
      ...(state.lastScheduledAt ? { lastScheduledAt: state.lastScheduledAt } : {}),
      run: (context: WorkFoldAutomationRunContext) => this.#executeAutomation(
        app.runtimeInstanceId,
        app.featureInstallationId,
        app.digest,
        declaration.id,
        context,
      ),
    };
    if (this.#automations.has(definition.key)) this.#automations.update(definition);
    else this.#automations.register(definition);
  }

  #unregisterAppAutomations(app: RestrictedAppRegistryEntry): void {
    for (const declaration of app.manifest.automations) {
      this.#automations.unregister(automationKey(app, declaration.id));
    }
  }

  async #executeAutomation(
    runtimeInstanceId: RuntimeInstanceId,
    featureInstallationId: FeatureInstallationId,
    digest: string,
    automationId: string,
    context: WorkFoldAutomationRunContext,
  ): Promise<void> {
    let execution: Promise<void> | undefined;
    await this.#mutate(async () => {
      const entry = this.#registry.installations.find((item) => item.runtimeInstanceId === runtimeInstanceId
        && item.featureInstallationId === featureInstallationId);
      if (!entry || entry.digest !== digest) {
        throw new RestrictedAppError("REVISION_CHANGED", "The automation Feature revision changed before it could start.");
      }
      if (this.#spaceRuntimeExclusions.has(entry.spaceId)) {
        throw new RestrictedAppError("APP_UNAVAILABLE", "Automations are not active for this Space.");
      }
      const current = this.#copyInstalled(entry);
      const declaration = automationDeclaration(current.manifest, automationId);
      const state = current.automations.find((item) => item.id === declaration.id)!;
      if (context.reason !== "manual" && !state.enabled) {
        throw new RestrictedAppError("APP_UNAVAILABLE", "The automation was disabled before it could start.");
      }
      this.#assertAutomationRuntime();
      const effectivePrincipal = Object.freeze({
        principalId: context.reason === "manual"
          ? this.#registry.localIdentity.principalId
          : this.#registry.localIdentity.servicePrincipalId,
        kind: context.reason === "manual" ? "human" as const : "service" as const,
        realm: "local" as const,
      });
      const scoped: RestrictedAppRuntimeDescriptor = {
        ...current,
        networkGrants: current.networkGrants.filter((id) => declaration.permissions.network.includes(id)),
        fileGrants: current.fileGrants.filter((grant) => declaration.permissions.files.includes(grant.declarationId)),
        notificationGrants: current.notificationGrants.filter((id) => declaration.permissions.notifications.includes(id)),
        automations: current.automations.filter((automation) => automation.id === declaration.id),
        stagedRoot: this.#digestRoot(current.digest),
      };
      const acceptedAt = this.#now().toISOString();
      const accepted: RestrictedAppAcceptedAutomationRegistryReceipt = {
        receiptId: `receipt_${randomUUID()}`,
        verification: "captured",
        kind: "job",
        state: "accepted",
        spaceId: current.spaceId,
        appId: current.manifest.id,
        packageDigest: current.digest,
        runId: context.runId,
        automationId: declaration.id,
        reason: context.reason,
        scheduledAt: context.scheduledAt,
        tenantId: current.tenantId,
        runtimeInstanceId: current.runtimeInstanceId,
        featureInstallationId: current.featureInstallationId,
        featureRevisionDigest: current.artifactDigest,
        dataNamespaceId: current.dataNamespaceId,
        effectivePrincipal,
        authority: parseAuthorityStamp(current.authority),
        acceptedAt,
        occurrenceId: `occurrence_${context.runId}`,
        attemptId: `attempt_${context.runId}`,
      };
      if (this.#registry.acceptedAutomationRuns.some((item) => item.runId === context.runId)
        || this.#registry.historicalAutomationRuns.some((item) => item.runId === context.runId)) {
        throw new RestrictedAppError("APP_UNAVAILABLE", "The automation run id is already present in the durable receipt ledger.");
      }
      if (this.#registry.acceptedAutomationRuns.length >= 1_000) {
        throw new RestrictedAppError("APP_UNAVAILABLE", "The durable accepted-run ledger is full and requires recovery before another automation can start.");
      }
      const next = {
        ...this.#registry,
        acceptedAutomationRuns: [...this.#registry.acceptedAutomationRuns, accepted],
      };
      assertRegistryPersistenceBound(reconcileInterruptedAutomationRuns(
        next,
        acceptedAt,
        "\0".repeat(workFoldAutomationMaxErrorLength),
      ).registry);
      await this.#writeRegistry(next);
      if (this.#spaceRuntimeExclusions.has(current.spaceId)) {
        throw new RestrictedAppError("APP_UNAVAILABLE", "Automations are not active for this Space.");
      }
      this.#acceptedAutomations.set(context.runId, accepted);
      execution = this.#runtimeHost!.runAutomation!(scoped, {
        runId: context.runId,
        automationId: declaration.id,
        handler: declaration.handler,
        reason: context.reason,
        scheduledAt: context.scheduledAt,
        effectivePrincipal,
      }, context.signal);
    });
    if (!execution) throw new RestrictedAppError("APP_UNAVAILABLE", "The automation could not start.");
    await execution;
  }

  async #recordAutomationResult(result: WorkFoldAutomationRunResult): Promise<RestrictedAppAutomationRunReceipt | undefined> {
    if (this.#closed) return undefined;
    const owner = automationOwner(result.key.ownerId);
    let recorded: RestrictedAppAutomationRunReceipt | undefined;
    try {
      await this.#mutate(async () => {
        const historicalDuplicate = this.#registry.historicalAutomationRuns.find((run) => run.runId === result.runId);
        if (historicalDuplicate) {
          const {
            packageDigest: _packageDigest,
            spaceId: _spaceId,
            appId: _appId,
            ...receipt
          } = historicalDuplicate;
          recorded = structuredClone(receipt);
          return;
        }
        const existing = this.#registry.installations.find((item) => item.runtimeInstanceId === owner.runtimeInstanceId
          && item.featureInstallationId === owner.featureInstallationId && item.digest === owner.digest);
        const pending = this.#registry.acceptedAutomationRuns.find((item) => item.runId === result.runId);
        if (!pending && !existing) return;
        if (pending && (pending.runtimeInstanceId !== owner.runtimeInstanceId
          || pending.featureInstallationId !== owner.featureInstallationId
          || pending.packageDigest !== owner.digest
          || pending.automationId !== result.key.jobId
          || pending.reason !== result.reason
          || pending.scheduledAt !== result.scheduledAt)) {
          throw new Error("Automation result does not match its durable accepted receipt.");
        }
        const declaration = existing?.manifest.automations.find((item) => item.id === result.key.jobId);
        const state = existing?.automations.find((item) => item.id === result.key.jobId);
        const accepted = pending ?? this.#acceptedAutomations.get(result.runId) ?? (existing
          ? acceptedAutomationContext(existing, this.#registry.localIdentity, result)
          : undefined);
        if (!accepted) return;
        const publicReceipt = capturedAutomationRun(result, accepted);
        const packageDigest = pending?.packageDigest ?? existing!.digest;
        const spaceId = pending?.spaceId ?? existing!.spaceId;
        const appId = pending?.appId ?? existing!.manifest.id;
        const receipt: RestrictedAppAutomationRegistryReceipt = { ...publicReceipt, packageDigest };
        const historical: RestrictedAppHistoricalAutomationRegistryReceipt = {
          ...receipt,
          spaceId,
          appId,
        };
        let installations = this.#registry.installations;
        if (existing && declaration && state) {
          const nextState: RestrictedAppAutomationRegistryState = {
            ...state,
            ...(result.reason === "manual" ? {} : { lastScheduledAt: result.scheduledAt }),
            ...(result.outcome === "success" || result.outcome === "failure" ? { lastRunAt: result.finishedAt } : {}),
            ...(result.outcome === "failure" ? { lastError: result.error ?? "Automation run failed." }
              : result.outcome === "success" ? { lastError: undefined }
              : {}),
          };
          const next: RestrictedAppRegistryEntry = {
            ...existing,
            automations: existing.automations.map((item) => item === state ? nextState : item),
            automationRuns: [...existing.automationRuns, receipt].slice(-200),
          };
          installations = installations.map((item) => item === existing ? next : item);
        }
        await this.#writeRegistry({
          ...this.#registry,
          installations,
          acceptedAutomationRuns: this.#registry.acceptedAutomationRuns.filter((item) => item.runId !== result.runId),
          historicalAutomationRuns: [...this.#registry.historicalAutomationRuns, historical].slice(-1_000),
        });
        recorded = publicReceipt;
      });
    } finally {
      this.#acceptedAutomations.delete(result.runId);
    }
    return recorded;
  }

  #assertAutomationRuntime(): void {
    if (!this.#runtimeHost?.runAutomation) {
      throw new RestrictedAppError("APP_UNAVAILABLE", "Automations require the work-fold desktop host.");
    }
  }

  async #invalidateOAuthApp(app: Pick<RestrictedAppRegistryEntry,
    "runtimeInstanceId" | "featureInstallationId" | "artifactDigest" | "manifest">): Promise<void> {
    if (!this.#oauth) return;
    for (const destination of app.manifest.permissions.network) {
      await this.#invalidateOAuthDestination(app, destination);
    }
  }

  async #invalidateOAuthDestination(
    app: Pick<RestrictedAppRegistryEntry,
      "runtimeInstanceId" | "featureInstallationId" | "artifactDigest" | "manifest">,
    destination: RestrictedAppManifest["permissions"]["network"][number],
    authorizeEffect?: RestrictedAppEffectAuthorizer,
  ): Promise<boolean | undefined> {
    if (!this.#oauth || !destination.auth.some((item) => item.kind === "oauth2-pkce")) return undefined;
    try {
      return await this.#oauth.disconnect(
        connectionBinding(app, this.#registry.localIdentity, destination),
        authorizeEffect,
      );
    } catch (error) {
      if (!(error instanceof RestrictedAppOAuthError)) throw error;
      throw new RestrictedAppError(error.code === "STORAGE_FAILED" ? "STORAGE_FAILED" : "AUTH_REQUIRED", error.message);
    }
  }

  async #buildLocalAppUpdatePlan(
    runtime: Extract<RestrictedAppRuntimeInstanceRegistryEntry, { kind: "app" }>,
    target: AppReleaseEnvelope,
    continuityPolicy: LocalAppUpdateContinuityPolicy,
    operationId: string,
    addedFeatureAllocations: Array<{
      featureId: string;
      featureInstallationId: FeatureInstallationId;
      dataNamespaceId: DataNamespaceId;
    }>,
  ): Promise<LocalAppInstanceUpdatePlan> {
    const activeRelease = assertLocalRestrictedAppRelease(await this.#releaseStore.read(runtime.activeReleaseDigest));
    const activeById = new Map(activeRelease.manifest.features.map((feature) => [feature.featureId, feature]));
    const entries = this.#registry.installations
      .filter((item) => item.runtimeInstanceId === runtime.runtimeInstanceId)
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
    if (entries.length !== activeById.size || entries.some((entry) => !activeById.has(entry.manifest.id))) {
      throw new Error("Local App Instance Feature state does not match its active Release.");
    }
    const features = [];
    for (const entry of entries) {
      const released = activeById.get(entry.manifest.id)!;
      const connections: string[] = [];
      if (this.#connections) {
        for (const destination of entry.manifest.permissions.network) {
          if (destination.auth.some((item) => item.kind === "none")) continue;
          if (await this.#connections.get(connectionBinding(entry, this.#registry.localIdentity, destination))) {
            connections.push(destination.id);
          }
        }
      }
      features.push({
        featureId: entry.manifest.id,
        featureInstallationId: entry.featureInstallationId,
        dataNamespaceId: entry.dataNamespaceId,
        featureRevisionDigest: entry.artifactDigest,
        declarationDigest: released.declaration.digest,
        dataSchema: null,
        grants: [
          ...entry.networkGrants.map((id) => `network:${id}`),
          ...entry.fileGrants.map((grant) => `file:${grant.declarationId}`),
          ...entry.notificationGrants.map((id) => `notification:${id}`),
        ].sort(),
        connections: connections.sort(),
        enabledJobs: entry.automations.filter((automation) => automation.enabled).map((automation) => automation.id).sort(),
      });
    }
    return planLocalAppInstanceUpdate({
      operationId,
      current: {
        runtimeInstanceId: runtime.runtimeInstanceId,
        projectId: runtime.projectId,
        activeRelease,
        features,
      },
      target,
      supportedRuntimeApi: { name: "work-fold.restricted-app-bridge", majorVersion: 2 },
      continuityPolicy,
      addedFeatureAllocations,
    });
  }

  #publishedRelease(sourceSpaceId: string, releaseDigest: Sha256Digest): LocalAppReleaseRegistryEntry {
    const release = this.#registry.releases.find((item) => item.releaseDigest === releaseDigest
      && item.sourceSpaceId === sourceSpaceId && item.state === "published");
    if (!release) throw new RestrictedAppError("INPUT_INVALID", "Choose a published Release from this App Project.");
    return release;
  }

  async #stageLocalReleasePackages(envelopeValue: unknown) {
    const envelope = assertLocalRestrictedAppRelease(envelopeValue);
    const packages = [];
    for (const feature of envelope.manifest.features) {
      const artifact = envelope.closure.artifacts.find((item) => item.digest === feature.featureRevision.digest);
      const declaration = envelope.closure.records.find((item) => item.digest === feature.declaration.digest);
      if (!artifact || !declaration) throw new Error(`App Release closure is incomplete for ${feature.featureId}.`);
      const declaredManifest = parseRestrictedAppManifest(declaration.value);
      if (declaredManifest.id !== feature.featureId) {
        throw new Error(`App Release Feature ${feature.featureId} does not match its restricted-app declaration.`);
      }
      const receipt = await stageRestrictedAppReleaseArtifact(
        artifact.entries,
        feature.featureRevision.digest,
        this.#stagingPath,
      );
      if (receipt.manifest.id !== feature.featureId
        || receipt.artifactDigest !== feature.featureRevision.digest
        || String(computeDeclarationDigest(receipt.manifest)) !== String(feature.declaration.digest)
        || JSON.stringify(receipt.manifest) !== JSON.stringify(declaredManifest)) {
        throw new Error(`Staged App Release Feature ${feature.featureId} does not match its immutable declaration.`);
      }
      packages.push({ feature, receipt });
    }
    return packages;
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise;
      rejectResult = rejectPromise;
    });
    const queued = this.#queue.catch(() => undefined).then(async () => {
      try {
        if (this.#releaseReconciliationPending) await this.#reconcileReleaseStore();
        await this.#drainPendingCleanups();
        resolveResult(await operation());
      } catch (error) {
        rejectResult(error);
      }
    });
    this.#queue = queued;
    await queued;
    return await result;
  }

  async #reconcileReleaseStore(): Promise<boolean> {
    try {
      const recovery = await this.#releaseStore.recover();
      const result = await this.#releaseStore.reconcile(
        this.#registry.releases.map((release) => release.releaseDigest),
      );
      this.#releaseReconciliationPending = recovery.cleanupPending || result.cleanupPending;
      return !this.#releaseReconciliationPending;
    } catch {
      this.#releaseReconciliationPending = true;
      return false;
    }
  }

  async #writeRegistry(next: RestrictedAppRegistryFile): Promise<void> {
    await mkdir(this.#rootPath, { recursive: true });
    const temporary = `${this.#registryPath}.${randomUUID()}.tmp`;
    const projected: unknown = JSON.parse(serializeRegistryFile(next));
    if (!projected || typeof projected !== "object" || Array.isArray(projected)) {
      throw new Error("Restricted app registry projection must be an object.");
    }
    const validated = registryFileV5(projected as Record<string, unknown>);
    const source = serializeRegistryFile(validated);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, this.#registryPath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
    // Atomic replacement is the commit point. From here on, memory and runtime
    // authority must never fall back to the predecessor registry, even when a
    // filesystem cannot confirm the parent-directory flush.
    this.#registry = validated;
    this.#syncRuntimeAuthorities();
    try {
      await syncRestrictedAppDirectory(this.#rootPath);
    } catch {
      process.emitWarning(
        "Restricted app registry committed, but its parent-directory durability flush could not be confirmed.",
        { code: "WORKFOLD_RESTRICTED_APP_REGISTRY_DIRSYNC" },
      );
    }
  }

  #syncRuntimeAuthorities(): void {
    this.#runtimeHost?.syncAuthority?.(this.#registry.installations
      .filter((item) => !this.#spaceRuntimeExclusions.has(item.spaceId))
      .map((item) => ({
      spaceId: item.spaceId,
      appId: item.manifest.id,
      digest: item.digest,
      runtimeInstanceId: item.runtimeInstanceId,
      featureInstallationId: item.featureInstallationId,
      authority: item.authority,
      })));
  }

  async #drainPendingCleanups(): Promise<void> {
    for (const cleanup of [...this.#registry.pendingCleanups]) {
      let complete = true;
      if (cleanup.connectionScope) {
        if (!this.#connections) complete = false;
        else {
          try {
            await this.#connections.deleteFeature(cleanup.connectionScope);
          } catch {
            complete = false;
          }
        }
      }
      if (cleanup.storageOwner) {
        if (!this.#storage) complete = false;
        else {
          try {
            await this.#storage.deleteApp(cleanup.storageOwner);
          } catch {
            complete = false;
          }
        }
      }
      if (cleanup.packageDigest) {
        try {
          await this.#garbageCollectDigest(cleanup.packageDigest);
        } catch {
          complete = false;
        }
      }
      if (!complete) continue;
      await this.#writeRegistry({
        ...this.#registry,
        pendingCleanups: this.#registry.pendingCleanups.filter((item) => item.cleanupId !== cleanup.cleanupId),
      });
    }
  }

  async #cleanupStaging(): Promise<void> {
    await assertRestrictedAppStagingRoot(this.#stagingPath);
    const referenced = new Set(this.#registry.installations.map((item) => item.digest));
    for (const entry of await readdir(this.#stagingPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (restrictedAppStagingTemporaryDirectoryPattern.test(entry.name)
        || (/^[0-9a-f]{64}$/.test(entry.name) && !referenced.has(entry.name))) {
        await removeOwnedRestrictedAppStagingDirectory(this.#stagingPath, entry.name);
      }
    }
  }

  async #garbageCollectDigest(digest: string): Promise<void> {
    if (this.#registry.installations.some((item) => item.digest === digest)) return;
    await assertRestrictedAppStagingRoot(this.#stagingPath);
    const root = this.#digestRoot(digest);
    const info = await lstat(root).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (info && !info.isSymbolicLink() && info.isDirectory()) {
      await removeOwnedRestrictedAppStagingDirectory(this.#stagingPath, digest);
    }
  }

  #digestRoot(digest: string): string {
    const value = digestValue(digest);
    const root = resolve(this.#stagingPath, value);
    if (relative(this.#stagingPath, root) !== value) throw new Error("Restricted app staging path is invalid.");
    return root;
  }

  #assertOpen(): void {
    if (this.#closed) throw new RestrictedAppError("APP_UNAVAILABLE", "The restricted app service is closed.");
  }
}

async function removeOwnedRestrictedAppStagingDirectory(stagingRoot: string, ownedName: string): Promise<void> {
  const root = resolve(stagingRoot);
  const ownedRoot = resolve(root, ownedName);
  if ((!restrictedAppStagingTemporaryDirectoryPattern.test(ownedName) && !/^[0-9a-f]{64}$/.test(ownedName))
    || dirname(ownedRoot) !== root || relative(root, ownedRoot) !== ownedName) {
    throw new Error("Restricted app staging cleanup path is invalid.");
  }
  await assertRestrictedAppStagingRoot(root);
  const rootInfo = await lstat(ownedRoot).catch((error: NodeJS.ErrnoException) => (
    error.code === "ENOENT" ? null : Promise.reject(error)
  ));
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return;
  // Discovery is deliberately limited to direct children with exact owned
  // names. Node's recursive rm removes a link entry rather than traversing a
  // directory symlink, avoiding a path-walking lstat/readdir race here.
  await assertRestrictedAppStagingRoot(root);
  if (dirname(resolve(root, ownedName)) !== root || relative(root, resolve(root, ownedName)) !== ownedName) {
    throw new Error("Restricted app staging cleanup path changed before removal.");
  }
  await rm(ownedRoot, { recursive: true, force: false, maxRetries: 0 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function readRegistry(
  path: string,
): Promise<{ registry: RestrictedAppRegistryFile; needsWrite: boolean }> {
  if (!existsSync(path)) return { registry: freshRegistry(), needsWrite: true };
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > restrictedAppRegistryMaximumBytes) {
    throw new Error("Restricted app registry is unsafe or too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`work-fold could not read the restricted app registry: ${errorMessage(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Restricted app registry must be an object.");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion === 5) return { registry: registryFileV5(record), needsWrite: false };
  throw new RestrictedAppRegistryVersionUnsupportedError(record.schemaVersion, 5);
}

async function syncRestrictedAppDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EISDIR" && code !== "EPERM" && code !== "ENOTSUP") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertRestrictedAppStagingRoot(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Restricted app staging root must be a regular directory, not a link.");
  }
}

async function assertRestrictedAppStateRoot(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Restricted app state root must be a regular directory, not a link.");
  }
}

async function recoverRestrictedAppRegistryTemps(rootPath: string): Promise<void> {
  const temporaryPattern = /^registry\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
  let changed = false;
  for (const entry of await readdir(rootPath, { withFileTypes: true })) {
    if (!temporaryPattern.test(entry.name)) continue;
    const path = join(rootPath, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Restricted app registry temporary state is unsafe.");
    }
    await unlink(path);
    changed = true;
  }
  if (changed) await syncRestrictedAppDirectory(rootPath);
}

function freshRegistry(): RestrictedAppRegistryFile {
  return {
    schemaVersion: 5,
    localIdentity: {
      tenantId: createTenantId(),
      principalId: createPrincipalId(),
      servicePrincipalId: createPrincipalId(),
      principalGeneration: createAuthorityGeneration(),
    },
    projects: [],
    runtimeInstances: [],
    installations: [],
    releases: [],
    operations: [],
    retainedData: [],
    adminReceipts: [],
    pendingCleanups: [],
    acceptedAutomationRuns: [],
    historicalAutomationRuns: [],
  };
}

function reconcileInterruptedAutomationRuns(
  registry: RestrictedAppRegistryFile,
  recoveredAt: string,
  recoveryError = "work-fold restarted after accepting this automation run; completion of external effects is unknown.",
): { registry: RestrictedAppRegistryFile; needsWrite: boolean } {
  if (registry.acceptedAutomationRuns.length === 0) return { registry, needsWrite: false };
  const recovered = registry.acceptedAutomationRuns.map((accepted): RestrictedAppHistoricalAutomationRegistryReceipt => {
    const finishedAt = Date.parse(recoveredAt) >= Date.parse(accepted.acceptedAt) ? recoveredAt : accepted.acceptedAt;
    return {
      receiptId: accepted.receiptId,
      verification: "captured",
      kind: "job",
      tenantId: accepted.tenantId,
      runtimeInstanceId: accepted.runtimeInstanceId,
      featureInstallationId: accepted.featureInstallationId,
      featureRevisionDigest: accepted.featureRevisionDigest,
      dataNamespaceId: accepted.dataNamespaceId,
      effectivePrincipal: accepted.effectivePrincipal,
      authority: parseAuthorityStamp(accepted.authority),
      acceptedAt: accepted.acceptedAt,
      state: "expired",
      occurrenceId: accepted.occurrenceId,
      attemptId: accepted.attemptId,
      runId: accepted.runId,
      automationId: accepted.automationId,
      reason: accepted.reason,
      scheduledAt: accepted.scheduledAt,
      startedAt: accepted.acceptedAt,
      finishedAt,
      outcome: "interrupted",
      error: recoveryError,
      packageDigest: accepted.packageDigest,
      spaceId: accepted.spaceId,
      appId: accepted.appId,
    };
  });
  const installations = registry.installations.map((entry) => {
    const matches = recovered.filter((receipt) => receipt.spaceId === entry.spaceId
      && receipt.appId === entry.manifest.id
      && receipt.packageDigest === entry.digest
      && receipt.runtimeInstanceId === entry.runtimeInstanceId
      && receipt.featureInstallationId === entry.featureInstallationId);
    if (matches.length === 0) return entry;
    const byAutomation = new Map(matches.map((receipt) => [receipt.automationId, receipt]));
    const automations = entry.automations.map((automation) => {
      const receipt = byAutomation.get(automation.id);
      return receipt ? { ...automation, lastRunAt: receipt.finishedAt, lastError: receipt.error } : automation;
    });
    const automationRuns = [...entry.automationRuns];
    for (const { spaceId: _spaceId, appId: _appId, ...receipt } of matches) {
      if (!automationRuns.some((item) => item.runId === receipt.runId)) automationRuns.push(receipt);
    }
    return { ...entry, automations, automationRuns: automationRuns.slice(-200) };
  });
  return {
    needsWrite: true,
    registry: {
      ...registry,
      installations,
      acceptedAutomationRuns: [],
      historicalAutomationRuns: [...registry.historicalAutomationRuns, ...recovered].slice(-1_000),
    },
  };
}

function assertRegistryPersistenceBound(registry: RestrictedAppRegistryFile): void {
  serializeRegistryFile(registry);
}

function serializeRegistryFile(registry: RestrictedAppRegistryFile): string {
  const source = `${JSON.stringify(registry, null, 2)}\n`;
  if (Buffer.byteLength(source, "utf8") > restrictedAppRegistryMaximumBytes) {
    throw new Error(`Restricted app registry exceeds the ${restrictedAppRegistryMaximumBytes}-byte persistence limit.`);
  }
  return source;
}

function registryFileV5(record: Record<string, unknown>): RestrictedAppRegistryFile {
  exactObjectKeys(record, [
    "schemaVersion", "localIdentity", "projects", "runtimeInstances", "installations", "pendingCleanups",
    "releases", "operations", "retainedData", "adminReceipts", "acceptedAutomationRuns", "historicalAutomationRuns",
  ], "Restricted app registry");
  if (record.schemaVersion !== 5) throw new Error("Restricted app registry schema version must be 5.");
  const local = objectValue(record.localIdentity, "Restricted app local identity");
  exactObjectKeys(local, ["tenantId", "principalId", "servicePrincipalId", "principalGeneration"], "Restricted app local identity");
  const localIdentity = {
    tenantId: parseTenantId(local.tenantId),
    principalId: parsePrincipalId(local.principalId),
    servicePrincipalId: parsePrincipalId(local.servicePrincipalId),
    principalGeneration: parseAuthorityGeneration(local.principalGeneration, "Restricted app local Principal generation"),
  };
  const projects = arrayValue(record.projects, "Restricted app projects").map(projectRegistryEntry);
  const runtimeInstances = arrayValue(record.runtimeInstances, "Restricted app Runtime Instances").map(runtimeInstanceRegistryEntry);
  const installations = arrayValue(record.installations, "Restricted app Feature Installations").map(registryEntry);
  const releases = arrayValue(record.releases, "Local App Releases").map(localAppReleaseRegistryEntry);
  const operations = arrayValue(record.operations, "Local App operations").map(localAppOperationValue);
  const retainedData = arrayValue(record.retainedData, "Local App retained data").map(localAppRetainedDataValue);
  const adminReceipts = arrayValue(record.adminReceipts, "Local App admin receipts").map(localAppAdminReceiptValue);
  const pendingCleanups = arrayValue(record.pendingCleanups, "Restricted app pending cleanups").map(pendingCleanupEntry);
  const acceptedAutomationRuns = arrayValue(record.acceptedAutomationRuns, "Restricted app accepted automation receipts")
    .map(acceptedAutomationRunReceiptValue);
  const historicalAutomationRuns = arrayValue(record.historicalAutomationRuns, "Restricted app historical automation receipts")
    .map(historicalAutomationRunReceiptValue);
  if (acceptedAutomationRuns.length > 1_000 || historicalAutomationRuns.length > 1_000) {
    throw new Error("Restricted app automation receipt ledger exceeds its retention bound.");
  }
  if (projects.length > restrictedAppRegistryLimits.projects
    || runtimeInstances.length > restrictedAppRegistryLimits.runtimeInstances
    || installations.length > restrictedAppRegistryLimits.installations
    || releases.length > restrictedAppRegistryLimits.releases
    || operations.length > restrictedAppRegistryLimits.operations
    || retainedData.length > restrictedAppRegistryLimits.retainedData
    || adminReceipts.length > restrictedAppRegistryLimits.adminReceipts) {
    throw new Error("Local App registry exceeds a lifecycle collection bound.");
  }

  assertUnique(projects.map((item) => item.spaceId), "Restricted app registry contains duplicate Space projects.");
  assertUnique(projects.map((item) => item.projectId), "Restricted app registry contains duplicate project ids.");
  assertUnique(
    runtimeInstances.filter((item) => item.kind === "development").map((item) => item.spaceId),
    "Restricted app registry contains duplicate Space Development Instances.",
  );
  assertUnique(
    runtimeInstances.filter((item) => item.kind === "app").map((item) => `${item.projectId}:${item.spaceId}`),
    "Local App registry contains duplicate Project App Instances in one Space.",
  );
  assertUnique(runtimeInstances.map((item) => item.runtimeInstanceId), "Restricted app registry contains duplicate Runtime Instance ids.");
  assertUnique(installations.map((item) => `${item.spaceId}:${item.manifest.id}`), "Restricted app registry contains duplicate Space Feature ids.");
  assertUnique(installations.map((item) => item.featureInstallationId), "Restricted app registry contains duplicate Feature Installation ids.");
  assertUnique(installations.map((item) => item.dataNamespaceId), "Restricted app registry contains duplicate data namespace ids.");
  assertUnique(releases.map((item) => item.releaseDigest), "Local App registry contains duplicate Release digests.");
  assertUnique(operations.map((item) => item.operationId), "Local App registry contains duplicate operation ids.");
  assertUnique(retainedData.map((item) => item.retainedDataId), "Local App registry contains duplicate retained data ids.");
  assertUnique(
    [...installations.map((item) => item.dataNamespaceId), ...retainedData.map((item) => item.dataNamespaceId)],
    "Local App registry contains a data namespace that is both active and retained.",
  );
  assertUnique(adminReceipts.map((item) => item.receiptId), "Local App registry contains duplicate admin receipt ids.");
  assertUnique(pendingCleanups.map((item) => item.cleanupId), "Restricted app registry contains duplicate pending cleanup ids.");
  assertUnique(acceptedAutomationRuns.map((item) => item.runId), "Restricted app registry contains duplicate accepted automation run ids.");
  assertUnique(historicalAutomationRuns.map((item) => item.runId), "Restricted app registry contains duplicate historical automation run ids.");
  if (acceptedAutomationRuns.some((item) => historicalAutomationRuns.some((receipt) => receipt.runId === item.runId))) {
    throw new Error("Restricted app automation run cannot be both accepted and terminal.");
  }

  for (const runtime of runtimeInstances) {
    const project = projects.find((item) => item.projectId === runtime.projectId);
    if (!project || (runtime.kind === "development" && project.spaceId !== runtime.spaceId)) {
      throw new Error("Restricted app Runtime Instance does not match its App Project.");
    }
    if (runtime.kind === "app" && !releases.some((release) => release.projectId === runtime.projectId
      && release.releaseDigest === runtime.activeReleaseDigest && release.state === "published")) {
      throw new Error("Local App Instance does not reference a published Release in its Project lineage.");
    }
  }
  for (const release of releases) {
    const project = projects.find((item) => item.projectId === release.projectId);
    if (!project || project.spaceId !== release.sourceSpaceId) {
      throw new Error("Local App Release does not match its source Project.");
    }
  }
  for (const operation of operations) {
    const release = releases.find((item) => item.releaseDigest === operation.releaseDigest);
    if (!release || release.projectId !== operation.projectId || release.state !== "published") {
      throw new Error("Local App operation does not reference a published Release in its Project lineage.");
    }
    const runtime = runtimeInstances.find((item) => item.runtimeInstanceId === operation.runtimeInstanceId);
    if ((operation.kind === "install" && runtime)
      || (operation.kind === "update" && (!runtime || runtime.kind !== "app" || runtime.spaceId !== operation.targetSpaceId))) {
      throw new Error("Local App operation does not match its Runtime Instance lifecycle state.");
    }
    if (operation.kind === "update") {
      const fromRelease = releases.find((item) => item.releaseDigest === operation.plan.fromReleaseDigest);
      if (!fromRelease || fromRelease.projectId !== operation.projectId || fromRelease.state !== "published"
        || runtime?.kind !== "app" || runtime.activeReleaseDigest !== operation.plan.fromReleaseDigest) {
        throw new Error("Local App update operation does not reference its exact active source Release.");
      }
    }
  }
  for (const retained of retainedData) {
    const project = projects.find((item) => item.projectId === retained.projectId);
    const release = releases.find((item) => item.releaseDigest === retained.releaseDigest);
    const runtime = runtimeInstances.find((item) => item.runtimeInstanceId === retained.runtimeInstanceId);
    if (!project || !release || release.projectId !== retained.projectId || release.state !== "published"
      || !release.featureIds.includes(retained.featureId)
      || (runtime !== undefined && (runtime.kind !== "app" || runtime.projectId !== retained.projectId))) {
      throw new Error("Local App retained data does not reference a published Release in its Project lineage.");
    }
  }
  for (const installation of installations) {
    const project = projects.find((item) => item.projectId === installation.projectId);
    const runtime = runtimeInstances.find((item) => item.runtimeInstanceId === installation.runtimeInstanceId);
    if (!project || !runtime || installation.projectId !== project.projectId
      || installation.projectId !== runtime.projectId
      || installation.spaceId !== runtime.spaceId
      || installation.runtimeInstanceKind !== runtime.kind
      || (runtime.kind === "development" ? installation.releaseDigest !== null : installation.releaseDigest !== runtime.activeReleaseDigest)
      || installation.authority.runtimeInstanceGeneration !== runtime.runtimeInstanceGeneration
      || installation.authority.principalGeneration !== localIdentity.principalGeneration) {
      throw new Error("Restricted app Feature Installation does not match its host-owned context or authority.");
    }
    for (const receipt of installation.automationRuns) {
      if (receipt.verification !== "captured") continue;
      const expectedPrincipalId = receipt.reason === "manual"
        ? localIdentity.principalId
        : localIdentity.servicePrincipalId;
      const expectedPrincipalKind = receipt.reason === "manual" ? "human" : "service";
      if (receipt.tenantId !== localIdentity.tenantId
        || receipt.runtimeInstanceId !== installation.runtimeInstanceId
        || receipt.featureInstallationId !== installation.featureInstallationId
        || receipt.featureRevisionDigest !== installation.artifactDigest
        || receipt.dataNamespaceId !== installation.dataNamespaceId
        || receipt.effectivePrincipal?.realm !== "local"
        || receipt.effectivePrincipal.principalId !== expectedPrincipalId
        || receipt.effectivePrincipal.kind !== expectedPrincipalKind) {
        throw new Error("Restricted app automation receipt does not match its owning installation context.");
      }
    }
  }
  for (const cleanup of pendingCleanups) {
    if (!cleanup.connectionScope && !cleanup.storageOwner && !cleanup.packageDigest) {
      throw new Error("Restricted app pending cleanup has no owned cleanup target.");
    }
    if (cleanup.connectionScope) {
      if (cleanup.connectionScope.tenantId !== localIdentity.tenantId) {
        throw new Error("Restricted app pending connection cleanup belongs to another Tenant.");
      }
      const stillActive = installations.some((installation) => (
        installation.runtimeInstanceId === cleanup.connectionScope!.runtimeInstanceId
        && installation.manifest.id === cleanup.connectionScope!.featureId
        && installation.featureInstallationId === cleanup.connectionScope!.featureInstallationId
        && installation.artifactDigest === cleanup.connectionScope!.featureRevisionDigest
      ));
      if (stillActive) {
        throw new Error("Restricted app pending connection cleanup still belongs to an active Feature Installation.");
      }
    }
    if (cleanup.storageOwner) {
      if (cleanup.storageOwner.tenantId !== localIdentity.tenantId) {
        throw new Error("Restricted app pending storage cleanup belongs to another Tenant.");
      }
      const stillActive = installations.some((installation) => (
        installation.runtimeInstanceId === cleanup.storageOwner!.runtimeInstanceId
        && installation.featureInstallationId === cleanup.storageOwner!.featureInstallationId
        && installation.dataNamespaceId === cleanup.storageOwner!.dataNamespaceId
      ));
      const stillRetained = retainedData.some((retained) => (
        retained.runtimeInstanceId === cleanup.storageOwner!.runtimeInstanceId
        && retained.featureInstallationId === cleanup.storageOwner!.featureInstallationId
        && retained.dataNamespaceId === cleanup.storageOwner!.dataNamespaceId
      ));
      if (stillActive || stillRetained) {
        throw new Error("Restricted app pending storage cleanup still belongs to active or retained App data.");
      }
    }
  }
  return {
    schemaVersion: 5,
    localIdentity,
    projects,
    runtimeInstances,
    installations,
    releases,
    operations,
    retainedData,
    adminReceipts,
    pendingCleanups,
    acceptedAutomationRuns,
    historicalAutomationRuns,
  };
}

async function assertReleaseBackedInstallationProjection(
  registry: RestrictedAppRegistryFile,
  releases: ReadonlyMap<Sha256Digest, LocalAppVerifiedReleaseProjection>,
  stagingPath: string,
): Promise<void> {
  for (const runtime of registry.runtimeInstances) {
    if (runtime.kind !== "app") continue;
    const release = releases.get(runtime.activeReleaseDigest);
    if (!release || release.projectId !== runtime.projectId) {
      throw new Error("Local App Instance does not have its exact active Release closure.");
    }
    const installed = registry.installations
      .filter((item) => item.runtimeInstanceId === runtime.runtimeInstanceId)
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
    const features = [...release.features]
      .sort((left, right) => left.featureId.localeCompare(right.featureId));
    if (installed.length !== features.length) {
      throw new Error("Local App Instance Feature Installations do not exactly project its active Release.");
    }
    for (let index = 0; index < features.length; index += 1) {
      const feature = features[index]!;
      const installation = installed[index]!;
      if (installation.projectId !== runtime.projectId
        || installation.runtimeInstanceKind !== "app"
        || installation.releaseDigest !== runtime.activeReleaseDigest
        || installation.manifest.id !== feature.featureId
        || installation.artifactDigest !== feature.featureRevisionDigest
        || String(computeDeclarationDigest(installation.manifest)) !== String(feature.declarationDigest)) {
        throw new Error(`Local App Feature ${feature.featureId} does not exactly project its active Release.`);
      }
      await snapshotRestrictedAppPackage(stageReceiptFromEntry(
        installation,
        join(stagingPath, installation.digest),
      ));
    }
  }
}

export function assertLocalAppReleasePreparationBounds(
  entries: readonly Readonly<{ totalBytes: number }>[],
): void {
  if (entries.length > appReleaseDefaultLimits.features) {
    throw new RestrictedAppError(
      "INPUT_INVALID",
      `An App Release can contain at most ${appReleaseDefaultLimits.features} Features. Remove previews before preparing it.`,
    );
  }
  let artifactBytes = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.totalBytes) || entry.totalBytes < 0) {
      throw new RestrictedAppError("INPUT_INVALID", "A local preview has an invalid staged-byte count.");
    }
    if (entry.totalBytes > appReleaseDefaultLimits.closureBytes - artifactBytes) {
      throw new RestrictedAppError(
        "INPUT_INVALID",
        `The reviewed previews exceed the ${appReleaseDefaultLimits.closureBytes}-byte Release closure limit.`,
      );
    }
    artifactBytes += entry.totalBytes;
  }
}

type CommonRegistryEntry = Omit<RestrictedAppRegistryEntry,
  "projectId" | "runtimeInstanceId" | "runtimeInstanceKind" | "releaseDigest"
  | "featureInstallationId" | "dataNamespaceId" | "authority" | "artifactDigest">;

function registryEntry(value: unknown, index: number): RestrictedAppRegistryEntry {
  const item = objectValue(value, `Restricted app registry entry ${index + 1}`);
  exactObjectKeys(item, [
    "spaceId", "projectId", "runtimeInstanceId", "runtimeInstanceKind", "releaseDigest",
    "featureInstallationId", "dataNamespaceId", "authority",
    "packageName", "version", "digest", "artifactDigest", "manifest", "networkGrants", "fileGrants",
    "notificationGrants", "automations", "automationRuns", "fileCount", "totalBytes", "installedAt", "updatedAt",
  ], "Restricted app registry entry");
  const common = commonRegistryEntry(value, index);
  if (item.runtimeInstanceKind !== "development" && item.runtimeInstanceKind !== "app") {
    throw new Error("Restricted app registry Runtime Instance kind is invalid.");
  }
  return {
    ...common,
    projectId: parseProjectId(item.projectId),
    runtimeInstanceId: parseRuntimeInstanceId(item.runtimeInstanceId),
    runtimeInstanceKind: item.runtimeInstanceKind,
    releaseDigest: item.releaseDigest === null ? null : parseSha256Digest(item.releaseDigest, "Restricted app Release digest"),
    featureInstallationId: parseFeatureInstallationId(item.featureInstallationId),
    dataNamespaceId: parseDataNamespaceId(item.dataNamespaceId),
    authority: parseAuthorityStamp(item.authority),
    artifactDigest: parseAppPlatformArtifactDigest(item.artifactDigest),
  };
}

function commonRegistryEntry(value: unknown, index: number): CommonRegistryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Restricted app registry entry ${index + 1} is invalid.`);
  const item = value as Partial<RestrictedAppRegistryEntry>;
  const manifest = parseRestrictedAppManifest(item.manifest);
  const spaceId = nonempty(item.spaceId, "Restricted app registry Space id", 200);
  const packageName = nonempty(item.packageName, "Restricted app registry package name", 214);
  const version = nonempty(item.version, "Restricted app registry version", 100);
  const digest = digestValue(item.digest);
  if (!Array.isArray(item.networkGrants)) throw new Error("Restricted app registry network grants are missing.");
  const networkGrants = item.networkGrants.map((grant) => nonempty(grant, "Restricted app network grant", 64));
  if (new Set(networkGrants).size !== networkGrants.length || networkGrants.some((grant) => !manifest.permissions.network.some((item) => item.id === grant))) {
    throw new Error("Restricted app registry has invalid network grants.");
  }
  if (!Array.isArray(item.fileGrants)) throw new Error("Restricted app registry file grants are missing.");
  const fileGrants = item.fileGrants.map((grant) => restrictedAppFileGrantValue(grant, manifest));
  if (new Set(fileGrants.map((grant) => grant.id)).size !== fileGrants.length) {
    throw new Error("Restricted app registry has invalid file grants.");
  }
  if (!Array.isArray(item.notificationGrants)) throw new Error("Restricted app registry notification grants are missing.");
  const notificationGrants = item.notificationGrants
    .map((grant) => nonempty(grant, "Restricted app notification grant", 64));
  if (new Set(notificationGrants).size !== notificationGrants.length
    || notificationGrants.some((grant) => !manifest.permissions.notifications.some((item) => item.id === grant))) {
    throw new Error("Restricted app registry has invalid notification grants.");
  }
  const declarations = manifest.automations;
  if (!Array.isArray(item.automations)) throw new Error("Restricted app registry automation states are missing.");
  const automations = item.automations.map((state) => automationRegistryStateValue(state, declarations));
  if (automations.length !== declarations.length
    || new Set(automations.map((state) => state.id)).size !== declarations.length
    || declarations.some((declaration) => !automations.some((state) => state.id === declaration.id))) {
    throw new Error("Restricted app registry automation states do not match the reviewed manifest.");
  }
  if (!Array.isArray(item.automationRuns) || item.automationRuns.length > 200) {
    throw new Error("Restricted app automation run history is invalid.");
  }
  const automationRuns = item.automationRuns.map((run) => automationRunReceiptValue(
    run,
    declarations,
    digest,
  ));
  if (new Set(automationRuns.map((run) => run.runId)).size !== automationRuns.length) {
    throw new Error("Restricted app automation run history contains duplicate run ids.");
  }
  return {
    spaceId,
    packageName,
    version,
    digest,
    manifest,
    networkGrants,
    fileGrants,
    notificationGrants,
    automations,
    automationRuns,
    fileCount: boundedInteger(item.fileCount, "Restricted app registry file count", 1, 2_048),
    totalBytes: boundedInteger(item.totalBytes, "Restricted app registry byte count", 1, 50 * 1024 * 1024),
    installedAt: isoDate(item.installedAt, "Restricted app installed time"),
    updatedAt: isoDate(item.updatedAt, "Restricted app updated time"),
  };
}

function projectRegistryEntry(value: unknown, index: number): RestrictedAppProjectRegistryEntry {
  const item = objectValue(value, `Restricted app project ${index + 1}`);
  exactObjectKeys(item, ["spaceId", "projectId", "presentation", "createdAt", "updatedAt"], "Restricted app project");
  return {
    spaceId: nonempty(item.spaceId, "Restricted app project Space id", 200),
    projectId: parseProjectId(item.projectId),
    presentation: presentationValue(item.presentation, "Restricted app project presentation"),
    createdAt: isoDate(item.createdAt, "Restricted app project creation time"),
    updatedAt: isoDate(item.updatedAt, "Restricted app project update time"),
  };
}

function runtimeInstanceRegistryEntry(value: unknown, index: number): RestrictedAppRuntimeInstanceRegistryEntry {
  const item = objectValue(value, `Restricted app Runtime Instance ${index + 1}`);
  const commonKeys = ["kind", "spaceId", "projectId", "runtimeInstanceId", "runtimeInstanceGeneration", "createdAt", "updatedAt"];
  exactObjectKeys(item, item.kind === "app" ? [...commonKeys, "host", "activeReleaseDigest"] : commonKeys, "Restricted app Runtime Instance");
  if (item.kind !== "development" && item.kind !== "app") throw new Error("Local restricted app Runtime Instance kind is invalid.");
  const common: RestrictedAppRuntimeInstanceRegistryBase = {
    spaceId: nonempty(item.spaceId, "Restricted app Runtime Instance Space id", 200),
    projectId: parseProjectId(item.projectId),
    runtimeInstanceId: parseRuntimeInstanceId(item.runtimeInstanceId),
    runtimeInstanceGeneration: parseAuthorityGeneration(item.runtimeInstanceGeneration, "Restricted app Runtime Instance generation"),
    createdAt: isoDate(item.createdAt, "Restricted app Runtime Instance creation time"),
    updatedAt: isoDate(item.updatedAt, "Restricted app Runtime Instance update time"),
  };
  if (item.kind === "development") return { kind: "development", ...common };
  if (item.host !== "local") throw new Error("Local App Instance host must be local.");
  return {
    kind: "app",
    ...common,
    host: "local",
    activeReleaseDigest: parseSha256Digest(item.activeReleaseDigest, "Local App active Release digest"),
  };
}

function localAppReleaseRegistryEntry(value: unknown, index: number): LocalAppReleaseRegistryEntry {
  const item = objectValue(value, `Local App Release ${index + 1}`);
  exactObjectKeys(item, [
    "projectId", "sourceSpaceId", "releaseDigest", "displayVersion", "presentation", "featureIds",
    "state", "preparedAt", "publishedAt", "sourceFeatures",
  ], "Local App Release");
  const featureIds = stringIdArray(item.featureIds, "Local App Release Feature ids");
  const sourceFeatures = arrayValue(item.sourceFeatures, "Local App Release source Features").map((value, sourceIndex) => {
    const source = objectValue(value, `Local App Release source Feature ${sourceIndex + 1}`);
    exactObjectKeys(source, ["featureId", "featureInstallationId", "packageDigest", "artifactDigest"], "Local App Release source Feature");
    return {
      featureId: appIdValue(source.featureId),
      featureInstallationId: parseFeatureInstallationId(source.featureInstallationId),
      packageDigest: digestValue(source.packageDigest),
      artifactDigest: parseAppPlatformArtifactDigest(source.artifactDigest),
    };
  });
  assertUnique(sourceFeatures.map((feature) => feature.featureId), "Local App Release source Feature ids must be unique.");
  if (sourceFeatures.length !== featureIds.length
    || sourceFeatures.some((feature, featureIndex) => feature.featureId !== featureIds[featureIndex])) {
    throw new Error("Local App Release source Features must exactly match its canonical Feature ids.");
  }
  if (item.state !== "prepared" && item.state !== "published") throw new Error("Local App Release state is invalid.");
  const publishedAt = item.publishedAt === null ? null : isoDate(item.publishedAt, "Local App Release publication time");
  if ((item.state === "prepared") !== (publishedAt === null)) {
    throw new Error("Local App Release state and publication time disagree.");
  }
  return {
    projectId: parseProjectId(item.projectId),
    sourceSpaceId: nonempty(item.sourceSpaceId, "Local App Release source Space id", 200),
    releaseDigest: parseSha256Digest(item.releaseDigest, "Local App Release digest"),
    displayVersion: nonempty(item.displayVersion, "Local App Release display version", 128),
    presentation: presentationValue(item.presentation, "Local App Release presentation"),
    featureIds,
    state: item.state,
    preparedAt: isoDate(item.preparedAt, "Local App Release preparation time"),
    publishedAt,
    sourceFeatures,
  };
}

function localAppOperationValue(value: unknown, index: number): LocalAppOperation {
  const item = objectValue(value, `Local App operation ${index + 1}`);
  if (item.kind === "install") {
    exactObjectKeys(item, [
      "operationId", "kind", "projectId", "targetSpaceId", "releaseDigest", "runtimeInstanceId", "features", "preparedAt",
    ], "Local App install operation");
    const features = arrayValue(item.features, "Local App install operation Features").map((value, featureIndex) => {
      const feature = objectValue(value, `Local App install operation Feature ${featureIndex + 1}`);
      exactObjectKeys(feature, ["featureId", "featureInstallationId", "dataNamespaceId"], "Local App install operation Feature");
      return {
        featureId: appIdValue(feature.featureId),
        featureInstallationId: parseFeatureInstallationId(feature.featureInstallationId),
        dataNamespaceId: parseDataNamespaceId(feature.dataNamespaceId),
      };
    });
    assertUnique(features.map((feature) => feature.featureId), "Local App install operation Feature ids must be unique.");
    return {
      operationId: localAppOperationId(item.operationId),
      kind: "install",
      projectId: parseProjectId(item.projectId),
      targetSpaceId: nonempty(item.targetSpaceId, "Local App target Space id", 200),
      releaseDigest: parseSha256Digest(item.releaseDigest, "Local App operation Release digest"),
      runtimeInstanceId: parseRuntimeInstanceId(item.runtimeInstanceId),
      features,
      preparedAt: isoDate(item.preparedAt, "Local App operation preparation time"),
    };
  }
  if (item.kind === "update") {
    exactObjectKeys(item, [
      "operationId", "kind", "projectId", "targetSpaceId", "releaseDigest", "runtimeInstanceId",
      "continuityPolicy", "plan", "preparedAt",
    ], "Local App update operation");
    const operationId = localAppOperationId(item.operationId);
    const projectId = parseProjectId(item.projectId);
    const releaseDigest = parseSha256Digest(item.releaseDigest, "Local App operation Release digest");
    const runtimeInstanceId = parseRuntimeInstanceId(item.runtimeInstanceId);
    if (item.continuityPolicy !== "eligible" && item.continuityPolicy !== "reset") {
      throw new Error("Local App update continuity policy is invalid.");
    }
    const plan = objectValue(item.plan, "Local App stored update plan") as unknown as LocalAppInstanceUpdatePlan;
    if (parseSha256Digest(plan.planDigest, "Local App update plan digest") !== plan.planDigest
      || localAppOperationId(plan.operationId) !== operationId
      || parseProjectId(plan.projectId) !== projectId
      || parseRuntimeInstanceId(plan.runtimeInstanceId) !== runtimeInstanceId
      || parseSha256Digest(plan.toReleaseDigest, "Local App update target Release digest") !== releaseDigest
      || !Array.isArray(plan.transitions) || !Array.isArray(plan.blockedReasons) || !Array.isArray(plan.activation)) {
      throw new Error("Local App stored update plan does not match its operation envelope.");
    }
    return {
      operationId,
      kind: "update",
      projectId,
      targetSpaceId: nonempty(item.targetSpaceId, "Local App target Space id", 200),
      releaseDigest,
      runtimeInstanceId,
      continuityPolicy: item.continuityPolicy,
      plan: structuredClone(plan),
      preparedAt: isoDate(item.preparedAt, "Local App operation preparation time"),
    };
  }
  throw new Error("Local App operation kind is invalid.");
}

function localAppRetainedDataValue(value: unknown, index: number): LocalAppRetainedData {
  const item = objectValue(value, `Local App retained data ${index + 1}`);
  exactObjectKeys(item, [
    "retainedDataId", "projectId", "runtimeInstanceId", "featureId", "featureInstallationId",
    "dataNamespaceId", "releaseDigest", "removedAt",
  ], "Local App retained data");
  const retainedDataId = nonempty(item.retainedDataId, "Local App retained data id", 64);
  if (!/^retained_[0-9a-f-]{36}$/i.test(retainedDataId)) throw new Error("Local App retained data id is invalid.");
  return {
    retainedDataId,
    projectId: parseProjectId(item.projectId),
    runtimeInstanceId: parseRuntimeInstanceId(item.runtimeInstanceId),
    featureId: appIdValue(item.featureId),
    featureInstallationId: parseFeatureInstallationId(item.featureInstallationId),
    dataNamespaceId: parseDataNamespaceId(item.dataNamespaceId),
    releaseDigest: parseSha256Digest(item.releaseDigest, "Local App retained data Release digest"),
    removedAt: isoDate(item.removedAt, "Local App retained data removal time"),
  };
}

function localAppAdminReceiptValue(value: unknown, index: number): LocalAppAdminReceipt {
  const item = objectValue(value, `Local App admin receipt ${index + 1}`);
  exactObjectKeys(item, ["receiptId", "action", "projectId", "runtimeInstanceId", "releaseDigest", "dataDisposition", "createdAt"], "Local App admin receipt");
  const receiptId = nonempty(item.receiptId, "Local App admin receipt id", 64);
  if (!/^admin_[0-9a-f-]{36}$/i.test(receiptId)) throw new Error("Local App admin receipt id is invalid.");
  const actions = new Set<LocalAppAdminReceipt["action"]>([
    "release-prepared", "release-published", "release-deleted", "install-prepared", "installed", "update-prepared", "updated", "uninstalled", "retained-data-purged",
  ]);
  if (!actions.has(item.action as LocalAppAdminReceipt["action"])) throw new Error("Local App admin receipt action is invalid.");
  const action = item.action as LocalAppAdminReceipt["action"];
  const dataDisposition = item.dataDisposition === "retain" || item.dataDisposition === "purge"
    ? item.dataDisposition
    : item.dataDisposition === null ? null : undefined;
  if (dataDisposition === undefined || (action === "uninstalled") !== (dataDisposition !== null)) {
    throw new Error("Local App admin receipt data disposition does not match its action.");
  }
  return {
    receiptId,
    action,
    projectId: parseProjectId(item.projectId),
    runtimeInstanceId: item.runtimeInstanceId === null ? null : parseRuntimeInstanceId(item.runtimeInstanceId),
    releaseDigest: item.releaseDigest === null ? null : parseSha256Digest(item.releaseDigest, "Local App admin receipt Release digest"),
    dataDisposition,
    createdAt: isoDate(item.createdAt, "Local App admin receipt creation time"),
  };
}

function pendingCleanupEntry(value: unknown, index: number): RestrictedAppPendingCleanup {
  const item = objectValue(value, `Restricted app pending cleanup ${index + 1}`);
  exactObjectKeys(item, ["cleanupId", "connectionScope", "storageOwner", "packageDigest", "createdAt"], "Restricted app pending cleanup");
  const cleanupId = nonempty(item.cleanupId, "Restricted app cleanup id", 64);
  if (!/^cleanup_[0-9a-f-]{36}$/i.test(cleanupId)) throw new Error("Restricted app cleanup id is invalid.");

  let connectionScope: RestrictedAppConnectionFeatureScope | null = null;
  if (item.connectionScope !== null) {
    const scope = objectValue(item.connectionScope, "Restricted app cleanup connection scope");
    exactObjectKeys(scope, [
      "tenantId", "runtimeInstanceId", "featureId", "featureInstallationId", "featureRevisionDigest",
    ], "Restricted app cleanup connection scope");
    connectionScope = {
      tenantId: parseTenantId(scope.tenantId),
      runtimeInstanceId: parseRuntimeInstanceId(scope.runtimeInstanceId),
      featureId: appIdValue(scope.featureId),
      featureInstallationId: parseFeatureInstallationId(scope.featureInstallationId),
      featureRevisionDigest: parseAppPlatformArtifactDigest(scope.featureRevisionDigest),
    };
  }

  let storageOwner: RestrictedAppStorageOwner | null = null;
  if (item.storageOwner !== null) {
    const owner = objectValue(item.storageOwner, "Restricted app cleanup storage owner");
    exactObjectKeys(owner, [
      "ownerClass", "tenantId", "runtimeInstanceId", "featureInstallationId", "dataNamespaceId",
    ], "Restricted app cleanup storage owner");
    if (owner.ownerClass !== "instance") throw new Error("Restricted app cleanup storage owner class is invalid.");
    storageOwner = {
      ownerClass: "instance",
      tenantId: parseTenantId(owner.tenantId),
      runtimeInstanceId: parseRuntimeInstanceId(owner.runtimeInstanceId),
      featureInstallationId: parseFeatureInstallationId(owner.featureInstallationId),
      dataNamespaceId: parseDataNamespaceId(owner.dataNamespaceId),
    };
  }

  return {
    cleanupId,
    connectionScope,
    storageOwner,
    packageDigest: item.packageDigest === null ? null : digestValue(item.packageDigest),
    createdAt: isoDate(item.createdAt, "Restricted app cleanup creation time"),
  };
}

function developmentContext(
  registry: RestrictedAppRegistryFile,
  spaceId: string,
  timestamp: string,
): {
  project: RestrictedAppProjectRegistryEntry;
  runtimeInstance: RestrictedAppRuntimeInstanceRegistryEntry;
  projects: RestrictedAppProjectRegistryEntry[];
  runtimeInstances: RestrictedAppRuntimeInstanceRegistryEntry[];
} {
  const project = registry.projects.find((item) => item.spaceId === spaceId) ?? {
    spaceId,
    projectId: createProjectId(),
    presentation: {
      title: "Untitled App",
      description: null,
      icon: null,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const existingRuntime = registry.runtimeInstances.find((item) => item.kind === "development" && item.spaceId === spaceId);
  if (existingRuntime && existingRuntime.projectId !== project.projectId) {
    throw new Error("Restricted app Development Instance does not match its App Project.");
  }
  const runtimeInstance = existingRuntime ?? {
    kind: "development" as const,
    spaceId,
    projectId: project.projectId,
    runtimeInstanceId: createRuntimeInstanceId(),
    runtimeInstanceGeneration: createAuthorityGeneration(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    project,
    runtimeInstance,
    projects: registry.projects.includes(project) ? registry.projects : [...registry.projects, project],
    runtimeInstances: registry.runtimeInstances.includes(runtimeInstance)
      ? registry.runtimeInstances
      : [...registry.runtimeInstances, runtimeInstance],
  };
}

function authorityForContext(
  registry: RestrictedAppRegistryFile,
  runtimeInstance: RestrictedAppRuntimeInstanceRegistryEntry,
): Readonly<AuthorityStamp> {
  return parseAuthorityStamp({
    ...createAuthorityStamp(),
    runtimeInstanceGeneration: runtimeInstance.runtimeInstanceGeneration,
    principalGeneration: registry.localIdentity.principalGeneration,
  });
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function exactObjectKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(record);
  const unsupported = keys.find((key) => !expected.includes(key));
  if (unsupported) throw new Error(`${label} contains unsupported field: ${unsupported}.`);
  const missing = expected.find((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (missing) throw new Error(`${label} is missing required field: ${missing}.`);
}

function assertUnique(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message);
}

async function restrictedSourceRoot(spaceRoot: string, sourcePath: string): Promise<string> {
  if (!sourcePath || sourcePath.includes("\0") || isAbsolute(sourcePath)) throw new RestrictedAppError("INPUT_INVALID", "Choose a relative package folder inside the Space.");
  const segments = sourcePath.replace(/\\/g, "/").split("/");
  const firstSegment = segments[0]?.toLocaleLowerCase("en-US");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")
    || firstSegment === ".pi" || firstSegment === ".work-fold" || firstSegment === ".workspace") {
    throw new RestrictedAppError("INPUT_INVALID", "Restricted app source must be a normal visible folder in the Space.");
  }
  const root = await realpath(spaceRoot);
  const candidate = resolve(root, ...segments);
  const sourceInfo = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new RestrictedAppError("INPUT_INVALID", "The restricted app package folder was not found.");
    throw error;
  });
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new RestrictedAppError("INPUT_INVALID", "Restricted app source must be a normal folder, not a link or file.");
  }
  const resolved = await realpath(candidate);
  const child = relative(root, resolved);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new RestrictedAppError("INPUT_INVALID", "Restricted app source escapes the Space.");
  return resolved;
}

function reviewFromInspection(inspection: Awaited<ReturnType<typeof inspectRestrictedAppPackage>>): RestrictedAppReview {
  return {
    packageName: inspection.packageName,
    version: inspection.packageVersion,
    digest: inspection.digest,
    artifactDigest: inspection.artifactDigest,
    manifest: structuredClone(inspection.manifest),
    fileCount: inspection.files.length,
    totalBytes: inspection.totalBytes,
  };
}

function assertLocalRestrictedAppRelease(value: unknown): AppReleaseEnvelope {
  const release = verifyAppRelease(value);
  if (release.manifest.runtimeApi.name !== "work-fold.restricted-app-bridge"
    || release.manifest.runtimeApi.compatibleRange !== "2.x") {
    throw new RestrictedAppError("INPUT_INVALID", "This Release does not target the local restricted App runtime.");
  }
  for (const feature of release.manifest.features) {
    if (feature.featureRevision.mediaType !== "application/vnd.work-fold.restricted-app-package+bundle"
      || feature.declaration.mediaType !== "application/vnd.work-fold.restricted-app-manifest+json"
      || feature.dataSchema !== null || feature.migrations.length !== 0) {
      throw new RestrictedAppError(
        "INPUT_INVALID",
        `Feature ${feature.featureId} uses a Release capability that the local restricted App runtime does not support.`,
      );
    }
  }
  return release;
}

function assertLocalRestrictedAppReleaseProjection(
  release: LocalAppReleaseStoreVerifiedProjection,
): LocalAppVerifiedReleaseProjection {
  if (release.runtimeApi.name !== "work-fold.restricted-app-bridge"
    || release.runtimeApi.compatibleRange !== "2.x") {
    throw new RestrictedAppError("INPUT_INVALID", "This Release does not target the local restricted App runtime.");
  }
  for (const feature of release.features) {
    if (feature.featureRevisionMediaType !== "application/vnd.work-fold.restricted-app-package+bundle"
      || feature.declarationMediaType !== "application/vnd.work-fold.restricted-app-manifest+json"
      || feature.hasDataSchema || feature.migrationCount !== 0) {
      throw new RestrictedAppError(
        "INPUT_INVALID",
        `Feature ${feature.featureId} uses a Release capability that the local restricted App runtime does not support.`,
      );
    }
  }
  return {
    projectId: release.projectId,
    displayVersion: release.displayVersion,
    presentation: structuredClone(release.presentation),
    features: release.features.map((feature) => ({
      featureId: feature.featureId,
      featureRevisionDigest: parseAppPlatformArtifactDigest(feature.featureRevisionDigest),
      declarationDigest: parseSha256Digest(feature.declarationDigest, "Local App Release declaration digest"),
    })),
  };
}

function releaseDigestValue(value: unknown): Sha256Digest {
  try {
    return parseSha256Digest(value, "App Release digest");
  } catch (error) {
    throw new RestrictedAppError("INPUT_INVALID", errorMessage(error));
  }
}

function copyInstalled(
  item: RestrictedAppRegistryEntry,
  localIdentity: RestrictedAppRegistryFile["localIdentity"],
  sourceSpaceId: string,
): RestrictedAppInstalled {
  return structuredClone({
    spaceId: item.spaceId,
    sourceSpaceId,
    projectId: item.projectId,
    tenantId: localIdentity.tenantId,
    principalId: localIdentity.principalId,
    runtimeInstanceId: item.runtimeInstanceId,
    runtimeInstanceKind: item.runtimeInstanceKind,
    releaseDigest: item.releaseDigest,
    featureInstallationId: item.featureInstallationId,
    dataNamespaceId: item.dataNamespaceId,
    authority: item.authority,
    packageName: item.packageName,
    version: item.version,
    digest: item.digest,
    artifactDigest: item.artifactDigest,
    manifest: item.manifest,
    networkGrants: item.networkGrants,
    fileGrants: item.fileGrants,
    notificationGrants: item.notificationGrants,
    automations: item.automations.map(({ lastScheduledAt: _lastScheduledAt, ...automation }) => automation),
    fileCount: item.fileCount,
    totalBytes: item.totalBytes,
    installedAt: item.installedAt,
    updatedAt: item.updatedAt,
  });
}

function copyLocalAppRelease(item: LocalAppReleaseRegistryEntry): LocalAppRelease {
  const { sourceFeatures: _sourceFeatures, ...release } = item;
  return structuredClone(release);
}

function localAppInstanceFrom(
  runtime: Extract<RestrictedAppRuntimeInstanceRegistryEntry, { kind: "app" }>,
  release: LocalAppReleaseRegistryEntry,
  apps: readonly RestrictedAppRegistryEntry[],
): LocalAppInstance {
  return structuredClone({
    runtimeInstanceId: runtime.runtimeInstanceId,
    projectId: runtime.projectId,
    spaceId: runtime.spaceId,
    releaseDigest: runtime.activeReleaseDigest,
    displayVersion: release.displayVersion,
    presentation: release.presentation,
    featureIds: apps.map((item) => item.manifest.id).sort(),
    installedAt: apps.map((item) => item.installedAt).sort()[0] ?? runtime.createdAt,
    updatedAt: runtime.updatedAt,
  });
}

function stageReceiptFromEntry(item: RestrictedAppRegistryEntry, stagedRoot: string) {
  return {
    id: item.manifest.id,
    packageName: item.packageName,
    version: item.version,
    digest: item.digest,
    artifactDigest: item.artifactDigest,
    stagedRoot,
    fileCount: item.fileCount,
    totalBytes: item.totalBytes,
    manifest: structuredClone(item.manifest),
  };
}

function appendAdminReceipt(
  receipts: readonly LocalAppAdminReceipt[],
  input: Omit<LocalAppAdminReceipt, "receiptId" | "dataDisposition"> & {
    dataDisposition?: LocalAppAdminReceipt["dataDisposition"];
  },
): LocalAppAdminReceipt[] {
  return [...receipts, {
    receiptId: `admin_${randomUUID()}`,
    ...input,
    dataDisposition: input.dataDisposition ?? null,
  }].slice(-restrictedAppRegistryLimits.adminReceipts);
}

function connectionFeatureScope(
  item: Pick<RestrictedAppRegistryEntry, "runtimeInstanceId" | "featureInstallationId" | "artifactDigest" | "manifest">,
  localIdentity: RestrictedAppRegistryFile["localIdentity"],
): RestrictedAppConnectionFeatureScope {
  return {
    tenantId: localIdentity.tenantId,
    runtimeInstanceId: item.runtimeInstanceId,
    featureId: item.manifest.id,
    featureInstallationId: item.featureInstallationId,
    featureRevisionDigest: item.artifactDigest,
  };
}

function connectionBinding(
  item: Pick<RestrictedAppRegistryEntry, "runtimeInstanceId" | "featureInstallationId" | "artifactDigest" | "manifest">,
  localIdentity: RestrictedAppRegistryFile["localIdentity"],
  declaration: RestrictedAppManifest["permissions"]["network"][number],
): RestrictedAppConnectionBinding {
  return {
    ...connectionFeatureScope(item, localIdentity),
    declarationId: declaration.id,
    declarationDigest: computeDeclarationDigest(declaration),
    targetIdentity: restrictedAppNetworkOrigin(declaration),
    owner: { kind: "instance", runtimeInstanceId: item.runtimeInstanceId },
  };
}

function storageOwnerFromEntry(
  item: Pick<RestrictedAppRegistryEntry, "runtimeInstanceId" | "featureInstallationId" | "dataNamespaceId">,
  localIdentity: RestrictedAppRegistryFile["localIdentity"],
): RestrictedAppStorageOwner {
  return {
    ownerClass: "instance",
    tenantId: localIdentity.tenantId,
    runtimeInstanceId: item.runtimeInstanceId,
    featureInstallationId: item.featureInstallationId,
    dataNamespaceId: item.dataNamespaceId,
  };
}

function pendingCleanupForEntry(
  item: RestrictedAppRegistryEntry,
  localIdentity: RestrictedAppRegistryFile["localIdentity"],
  deleteStorage: boolean,
  createdAt: string,
): RestrictedAppPendingCleanup {
  return {
    cleanupId: `cleanup_${randomUUID()}`,
    connectionScope: connectionFeatureScope(item, localIdentity),
    storageOwner: deleteStorage ? storageOwnerFromEntry(item, localIdentity) : null,
    packageDigest: item.digest,
    createdAt,
  };
}

function pendingPackageCleanupForEntry(
  item: Pick<RestrictedAppRegistryEntry, "digest">,
  createdAt: string,
): RestrictedAppPendingCleanup {
  return {
    cleanupId: `cleanup_${randomUUID()}`,
    connectionScope: null,
    storageOwner: null,
    packageDigest: item.digest,
    createdAt,
  };
}

function pendingCleanupForRetainedData(
  item: LocalAppRetainedData,
  localIdentity: RestrictedAppRegistryFile["localIdentity"],
  createdAt: string,
): RestrictedAppPendingCleanup {
  return {
    cleanupId: `cleanup_${randomUUID()}`,
    connectionScope: null,
    storageOwner: storageOwnerFromEntry(item, localIdentity),
    packageDigest: null,
    createdAt,
  };
}

function retainedDataForEntry(
  item: RestrictedAppRegistryEntry,
  releaseDigest: Sha256Digest,
  removedAt: string,
): LocalAppRetainedData {
  return {
    retainedDataId: `retained_${randomUUID()}`,
    projectId: item.projectId,
    runtimeInstanceId: item.runtimeInstanceId,
    featureId: item.manifest.id,
    featureInstallationId: item.featureInstallationId,
    dataNamespaceId: item.dataNamespaceId,
    releaseDigest,
    removedAt,
  };
}

function digestValue(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new RestrictedAppError("INPUT_INVALID", "Restricted app digest is invalid.");
  return value;
}

function appIdValue(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new RestrictedAppError("INPUT_INVALID", "Restricted app id is invalid.");
  return value;
}

function localAppOperationId(value: unknown): string {
  const id = nonempty(value, "Local App operation id", 64);
  if (!/^operation_[0-9a-f-]{36}$/i.test(id)) throw new Error("Local App operation id is invalid.");
  return id;
}

function stringIdArray(value: unknown, label: string): string[] {
  const result = arrayValue(value, label).map((item) => appIdValue(item));
  assertUnique(result, `${label} must be unique.`);
  const sorted = [...result].sort((left, right) => left.localeCompare(right));
  if (sorted.some((item, index) => item !== result[index])) throw new Error(`${label} must be canonically sorted.`);
  return result;
}

function presentationFromManifest(manifest: RestrictedAppManifest): AppReleasePresentation {
  return {
    title: manifest.title,
    description: manifest.description ?? null,
    icon: manifest.ui.icon ?? null,
  };
}

function presentationValue(value: unknown, label: string): AppReleasePresentation {
  const item = objectValue(value, label);
  exactObjectKeys(item, ["title", "description", "icon"], label);
  const title = nonempty(item.title, `${label} title`, 80);
  const description = item.description === null ? null : nonempty(item.description, `${label} description`, 280);
  let icon: string | null = null;
  if (item.icon !== null) {
    icon = nonempty(item.icon, `${label} icon`, 64);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(icon)) throw new Error(`${label} icon is invalid.`);
  }
  return { title, description, icon };
}

function nonempty(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || hasLoneSurrogate(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} is invalid.`);
  return value as number;
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} is invalid.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function restrictedAppInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof RestrictedAppError) throw error;
    throw new RestrictedAppError("INPUT_INVALID", errorMessage(error));
  }
}

function restrictedAppFileGrantValue(value: unknown, manifest: RestrictedAppManifest): RestrictedAppFileGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Restricted app file grant is invalid.");
  const record = value as Partial<RestrictedAppFileGrant>;
  const id = nonempty(record.id, "Restricted app file grant id", 64);
  const declarationId = nonempty(record.declarationId, "Restricted app file declaration id", 64);
  const declaration = manifest.permissions.files.find((item) => item.id === declarationId);
  if (!declaration || id !== declarationId || record.access !== declaration.access) throw new Error("Restricted app file grant exceeds its declaration.");
  return { id, declarationId, root: restrictedAppGrantRoot(record.root), access: declaration.access };
}

function restrictedAppGrantRoot(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\\") || value.includes(":") || value.includes("\0") || isAbsolute(value)) {
    throw new RestrictedAppError("INPUT_INVALID", "Choose a safe path inside the Space for this app.");
  }
  if (value === ".") return value;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new RestrictedAppError("INPUT_INVALID", "Choose a safe path inside the Space for this app.");
  }
  if (segments.some((segment) => {
    const normalized = segment.toLocaleLowerCase("en-US");
    return normalized === ".work-fold" || normalized === ".workspace" || normalized === ".pi";
  })) {
    throw new RestrictedAppError("FILE_DENIED", "work-fold metadata and executable Pi configuration cannot be granted to an app.");
  }
  return segments.join("/");
}

function automationDeclaration(manifest: RestrictedAppManifest, automationId: string): RestrictedAppAutomationDeclaration {
  const id = appIdValue(automationId);
  const declaration = manifest.automations.find((automation) => automation.id === id);
  if (!declaration) throw new RestrictedAppError("INPUT_INVALID", "The app did not declare this automation.");
  return declaration;
}

function automationKey(
  app: Pick<RestrictedAppRegistryEntry, "runtimeInstanceId" | "featureInstallationId" | "digest">,
  automationId: string,
): {
  ownerId: string;
  jobId: string;
} {
  return {
    ownerId: JSON.stringify([app.runtimeInstanceId, app.featureInstallationId, app.digest]),
    jobId: automationId,
  };
}

function automationOwner(value: string): {
  runtimeInstanceId: RuntimeInstanceId;
  featureInstallationId: FeatureInstallationId;
  digest: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Automation owner id is invalid.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error("Automation owner id is invalid.");
  return {
    runtimeInstanceId: parseRuntimeInstanceId(parsed[0]),
    featureInstallationId: parseFeatureInstallationId(parsed[1]),
    digest: digestValue(parsed[2]),
  };
}

function acceptedAutomationContext(
  entry: RestrictedAppRegistryEntry,
  localIdentity: RestrictedAppRegistryFile["localIdentity"],
  result: WorkFoldAutomationRunResult,
): AcceptedAutomationContext {
  return {
    tenantId: localIdentity.tenantId,
    runtimeInstanceId: entry.runtimeInstanceId,
    featureInstallationId: entry.featureInstallationId,
    featureRevisionDigest: entry.artifactDigest,
    dataNamespaceId: entry.dataNamespaceId,
    effectivePrincipal: Object.freeze({
      principalId: result.reason === "manual" ? localIdentity.principalId : localIdentity.servicePrincipalId,
      kind: result.reason === "manual" ? "human" : "service",
      realm: "local",
    }),
    authority: parseAuthorityStamp(entry.authority),
    acceptedAt: result.scheduledAt,
    occurrenceId: `occurrence_${result.runId}`,
    attemptId: `attempt_${result.runId}`,
  };
}

function capturedAutomationRun(
  result: WorkFoldAutomationRunResult,
  accepted: AcceptedAutomationContext,
): RestrictedAppAutomationRunReceipt {
  const state = result.outcome === "success"
    ? "succeeded"
    : result.outcome === "failure"
      ? "failed"
      : result.outcome;
  return {
    receiptId: `receipt_${randomUUID()}`,
    verification: "captured",
    kind: "job",
    tenantId: accepted.tenantId,
    runtimeInstanceId: accepted.runtimeInstanceId,
    featureInstallationId: accepted.featureInstallationId,
    featureRevisionDigest: accepted.featureRevisionDigest,
    dataNamespaceId: accepted.dataNamespaceId,
    effectivePrincipal: accepted.effectivePrincipal,
    authority: parseAuthorityStamp(accepted.authority),
    acceptedAt: accepted.acceptedAt,
    state,
    occurrenceId: accepted.occurrenceId,
    attemptId: accepted.attemptId,
    runId: result.runId,
    automationId: result.key.jobId,
    reason: result.reason,
    scheduledAt: result.scheduledAt,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    outcome: result.outcome,
    ...(result.error ? { error: result.error } : {}),
  };
}

function automationRegistryStateValue(
  value: unknown,
  declarations: RestrictedAppAutomationDeclaration[],
): RestrictedAppAutomationRegistryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Restricted app automation state is invalid.");
  }
  const item = value as Partial<RestrictedAppAutomationRegistryState>;
  const id = appIdValue(item.id);
  if (!declarations.some((declaration) => declaration.id === id) || typeof item.enabled !== "boolean") {
    throw new Error("Restricted app automation state exceeds its reviewed declaration.");
  }
  const lastScheduledAt = item.lastScheduledAt === undefined
    ? undefined
    : isoDate(item.lastScheduledAt, "Restricted app automation scheduled time");
  const lastRunAt = item.lastRunAt === undefined
    ? undefined
    : isoDate(item.lastRunAt, "Restricted app automation run time");
  const lastError = item.lastError === undefined
    ? undefined
    : nonempty(item.lastError, "Restricted app automation error", 300);
  return {
    id,
    enabled: item.enabled,
    ...(lastScheduledAt ? { lastScheduledAt } : {}),
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(lastError ? { lastError } : {}),
  };
}

function acceptedAutomationRunReceiptValue(value: unknown): RestrictedAppAcceptedAutomationRegistryReceipt {
  const item = objectValue(value, "Restricted app accepted automation receipt");
  exactObjectKeys(item, [
    "receiptId", "verification", "kind", "state", "spaceId", "appId", "packageDigest", "runId",
    "automationId", "reason", "scheduledAt", "tenantId", "runtimeInstanceId", "featureInstallationId",
    "featureRevisionDigest", "dataNamespaceId", "effectivePrincipal", "authority", "acceptedAt",
    "occurrenceId", "attemptId",
  ], "Restricted app accepted automation receipt");
  if (item.verification !== "captured" || item.kind !== "job" || item.state !== "accepted") {
    throw new Error("Restricted app accepted automation receipt state is invalid.");
  }
  if (item.reason !== "scheduled" && item.reason !== "manual" && item.reason !== "resume") {
    throw new Error("Restricted app accepted automation reason is invalid.");
  }
  const effectivePrincipal = effectivePrincipalValue(item.effectivePrincipal);
  const scheduledAt = isoDate(item.scheduledAt, "Restricted app accepted automation scheduled time");
  const acceptedAt = isoDate(item.acceptedAt, "Restricted app automation acceptance time");
  return {
    receiptId: nonempty(item.receiptId, "Restricted app automation receipt id", 200),
    verification: "captured",
    kind: "job",
    state: "accepted",
    spaceId: nonempty(item.spaceId, "Restricted app automation Space id", 200),
    appId: appIdValue(item.appId),
    packageDigest: digestValue(item.packageDigest),
    runId: nonempty(item.runId, "Restricted app automation run id", 200),
    automationId: appIdValue(item.automationId),
    reason: item.reason,
    scheduledAt,
    tenantId: parseTenantId(item.tenantId),
    runtimeInstanceId: parseRuntimeInstanceId(item.runtimeInstanceId),
    featureInstallationId: parseFeatureInstallationId(item.featureInstallationId),
    featureRevisionDigest: parseAppPlatformArtifactDigest(item.featureRevisionDigest),
    dataNamespaceId: parseDataNamespaceId(item.dataNamespaceId),
    effectivePrincipal,
    authority: parseAuthorityStamp(item.authority),
    acceptedAt,
    occurrenceId: nonempty(item.occurrenceId, "Restricted app automation occurrence id", 200),
    attemptId: nonempty(item.attemptId, "Restricted app automation attempt id", 200),
  };
}

function historicalAutomationRunReceiptValue(value: unknown): RestrictedAppHistoricalAutomationRegistryReceipt {
  const item = objectValue(value, "Restricted app historical automation receipt");
  const spaceId = nonempty(item.spaceId, "Restricted app automation Space id", 200);
  const appId = appIdValue(item.appId);
  const { spaceId: _spaceId, appId: _appId, ...terminal } = item;
  const parsed = automationRunReceiptValue(terminal, [], "");
  return { ...parsed, spaceId, appId };
}

function effectivePrincipalValue(value: unknown): EffectivePrincipal {
  const item = objectValue(value, "Restricted app automation effective Principal");
  exactObjectKeys(item, ["principalId", "kind", "realm"], "Restricted app automation effective Principal");
  if (item.kind !== "human" && item.kind !== "agent" && item.kind !== "service" && item.kind !== "system") {
    throw new Error("Restricted app automation effective Principal kind is invalid.");
  }
  if (item.realm !== "local" && item.realm !== "cloud") {
    throw new Error("Restricted app automation effective Principal realm is invalid.");
  }
  return Object.freeze({ principalId: parsePrincipalId(item.principalId), kind: item.kind, realm: item.realm });
}

function automationRunReceiptValue(
  value: unknown,
  declarations: RestrictedAppAutomationDeclaration[],
  expectedDigest: string,
): RestrictedAppAutomationRegistryReceipt {
  const item = objectValue(value, "Restricted app automation run receipt");
  const errorKeys = Object.prototype.hasOwnProperty.call(item, "error") ? ["error"] : [];
  exactObjectKeys(item, [
    "receiptId", "verification", "kind", "tenantId", "runtimeInstanceId", "featureInstallationId",
    "featureRevisionDigest", "dataNamespaceId", "effectivePrincipal", "authority", "acceptedAt", "state",
    "occurrenceId", "attemptId", "runId", "automationId", "reason", "scheduledAt", "startedAt", "finishedAt",
    "outcome", ...errorKeys, "packageDigest",
  ], "Captured restricted app automation run receipt");

  const runId = nonempty(item.runId, "Restricted app automation run id", 200);
  const automationId = appIdValue(item.automationId);
  const packageDigest = digestValue(item.packageDigest);
  if (expectedDigest && (!declarations.some((declaration) => declaration.id === automationId)
    || packageDigest !== expectedDigest)) {
    throw new Error("Restricted app automation run receipt does not match its reviewed revision.");
  }
  if (item.reason !== "scheduled" && item.reason !== "manual" && item.reason !== "resume") {
    throw new Error("Restricted app automation run reason is invalid.");
  }
  const reason: RestrictedAppAutomationRunReceipt["reason"] = item.reason;
  if (item.outcome !== "success" && item.outcome !== "failure" && item.outcome !== "skipped"
    && item.outcome !== "cancelled" && item.outcome !== "interrupted") {
    throw new Error("Restricted app automation run outcome is invalid.");
  }
  const outcome: RestrictedAppAutomationRunReceipt["outcome"] = item.outcome;
  const startedAt = isoDate(item.startedAt, "Restricted app automation start time");
  const finishedAt = isoDate(item.finishedAt, "Restricted app automation finish time");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new Error("Restricted app automation run times are invalid.");
  const error = item.error === undefined ? undefined : nonempty(item.error, "Restricted app automation run error", 300);
  if (item.outcome === "success" ? error !== undefined : error === undefined) {
    throw new Error("Restricted app automation run error does not match its outcome.");
  }

  const base = {
    receiptId: nonempty(item.receiptId, "Restricted app automation receipt id", 200),
    runId,
    automationId,
    reason,
    scheduledAt: isoDate(item.scheduledAt, "Restricted app automation scheduled time"),
    startedAt,
    finishedAt,
    outcome,
    ...(error ? { error } : {}),
    packageDigest,
  };
  if (item.verification !== "captured" || item.kind !== "job") {
    throw new Error("Captured restricted app automation receipt identity is invalid.");
  }
  const effectivePrincipal = effectivePrincipalValue(item.effectivePrincipal);
  const expectedState = outcome === "success"
    ? "succeeded"
    : outcome === "failure"
      ? "failed"
      : outcome === "interrupted"
        ? "expired"
        : outcome;
  if (item.state !== expectedState) throw new Error("Restricted app automation receipt state does not match its outcome.");
  return {
    ...base,
    verification: "captured",
    kind: "job",
    tenantId: parseTenantId(item.tenantId),
    runtimeInstanceId: parseRuntimeInstanceId(item.runtimeInstanceId),
    featureInstallationId: parseFeatureInstallationId(item.featureInstallationId),
    featureRevisionDigest: parseAppPlatformArtifactDigest(item.featureRevisionDigest),
    dataNamespaceId: parseDataNamespaceId(item.dataNamespaceId),
    effectivePrincipal,
    authority: parseAuthorityStamp(item.authority),
    acceptedAt: isoDate(item.acceptedAt, "Restricted app automation acceptance time"),
    state: expectedState,
    occurrenceId: nonempty(item.occurrenceId, "Restricted app automation occurrence id", 200),
    attemptId: nonempty(item.attemptId, "Restricted app automation attempt id", 200),
  };
}
