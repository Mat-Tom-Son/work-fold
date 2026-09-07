import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { RestrictedAppError } from "./restricted-app-connections.js";
import {
  type RestrictedAppInstalled,
  type RestrictedAppReview,
  type RestrictedAppPreviewBase,
  RestrictedAppService,
} from "./restricted-app-service.js";

export interface RestrictedAppProposalScope {
  spaceId: string;
  spaceRoot: string;
  conversationId: string;
}

export type RestrictedAppProposalStatus = "pending" | "installed" | "dismissed" | "revision-changed";

export interface RestrictedAppProposalReceipt extends RestrictedAppProposalScope {
  id: string;
  sourcePath: string;
  review: RestrictedAppReview;
  status: RestrictedAppProposalStatus;
  createdAt: string;
  updatedAt: string;
  installedApp?: RestrictedAppInstalled;
  changeId?: string;
  expectedPreviewBase?: RestrictedAppPreviewBase;
}

/** Machine-local provenance. This record is never copied into a portable Chat. */
export interface RestrictedAppChangeReceipt {
  id: string;
  status: "preparing" | "ready";
  sourceSpaceId: string;
  sourcePath: string;
  appId: string;
  packageName: string;
  title: string;
  version: string;
  baseDigest: string;
  baseFeatureInstallationId: string;
  targetSpaceId: string;
  targetRuntimeInstanceId: string;
  baseReleaseDigest: string | null;
  previewBase: RestrictedAppPreviewBase;
  buildConversationId: string | null;
  updateTarget?: { spaceId: string; runtimeInstanceId: string } | null;
  createdAt: string;
}

export interface RestrictedAppBuildContext {
  sourceSpaceId: string;
  sourcePath: string | null;
  buildConversationId: string | null;
  updateTargetRuntimeInstanceId: string | null;
}

export interface RestrictedAppProposalResult {
  status: "pending" | "cancelled";
  proposal?: RestrictedAppProposalReceipt;
}

export interface RestrictedAppProposalSettled {
  proposal: RestrictedAppProposalReceipt;
}

export interface RestrictedAppProposalHost {
  propose(
    input: RestrictedAppProposalScope & { sourcePath: string },
    signal?: AbortSignal,
  ): Promise<RestrictedAppProposalResult>;
}

interface ProposalRegistryFile {
  schemaVersion: 2;
  proposals: RestrictedAppProposalReceipt[];
  changes: RestrictedAppChangeReceipt[];
}

/**
 * Machine-local, conversation-bound receipts for app packages proposed by Pi.
 * The model supplies only a Space-relative folder. work-fold inspects that
 * folder and owns every review field and the digest used for installation.
 */
export class RoutedRestrictedAppProposalHost extends EventEmitter implements RestrictedAppProposalHost {
  readonly #service: RestrictedAppService;
  readonly #registryPath: string;
  #registry: ProposalRegistryFile;
  #queue: Promise<void> = Promise.resolve();

  private constructor(service: RestrictedAppService, registryPath: string, registry: ProposalRegistryFile) {
    super();
    this.#service = service;
    this.#registryPath = registryPath;
    this.#registry = registry;
  }

  static async create(options: { service: RestrictedAppService; registryPath: string }): Promise<RoutedRestrictedAppProposalHost> {
    const registryPath = resolve(options.registryPath);
    await mkdir(dirname(registryPath), { recursive: true });
    return new RoutedRestrictedAppProposalHost(options.service, registryPath, await readRegistry(registryPath));
  }

  async propose(
    input: RestrictedAppProposalScope & { sourcePath: string },
    signal?: AbortSignal,
  ): Promise<RestrictedAppProposalResult> {
    if (signal?.aborted) return { status: "cancelled" };
    const sourcePath = input.sourcePath.trim();
    const review = await this.#service.inspect({
      spaceId: input.spaceId,
      spaceRoot: input.spaceRoot,
      sourcePath,
    });
    if (signal?.aborted) return { status: "cancelled" };
    const proposal = await this.#mutate(async () => {
      const change = this.#registry.changes.find((item) => item.sourceSpaceId === input.spaceId
        && resolve(input.spaceRoot, item.sourcePath) === resolve(input.spaceRoot, sourcePath));
      if (change && (change.status !== "ready" || change.appId !== review.manifest.id || change.packageName !== review.packageName)) {
        throw new RestrictedAppError("INPUT_INVALID", "Keep the app and package identity of this working copy before submitting it for review.");
      }
      const existing = this.#registry.proposals.find((item) => item.status === "pending"
        && item.spaceId === input.spaceId
        && item.conversationId === input.conversationId
        && item.sourcePath === sourcePath
        && item.review.digest === review.digest);
      if (existing) return copyReceipt(existing);
      const timestamp = new Date().toISOString();
      const receipt: RestrictedAppProposalReceipt = {
        ...input,
        id: randomUUID(),
        sourcePath,
        review,
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(change ? { changeId: change.id, expectedPreviewBase: change.previewBase } : {}),
      };
      const proposals = [...this.#registry.proposals, receipt]
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .slice(-100);
      await this.#writeRegistry({ ...this.#registry, proposals });
      return copyReceipt(receipt);
    });
    this.emit("request", proposal);
    return { status: "pending", proposal };
  }

  async get(id: string): Promise<RestrictedAppProposalReceipt | undefined> {
    await this.#queue.catch(() => undefined);
    const proposal = this.#registry.proposals.find((item) => item.id === id);
    return proposal ? copyReceipt(proposal) : undefined;
  }

  async buildContext(spaceId: string, appId: string, expectedDigest: string, featureInstallationId?: string): Promise<RestrictedAppBuildContext> {
    const app = await this.#service.runtimeDescriptor(spaceId, appId, expectedDigest, featureInstallationId);
    await this.#queue.catch(() => undefined);
    const context = this.#sourceContext(app);
    const origin = context.updateTarget;
    const target = app.runtimeInstanceKind === "app" ? app : origin
      ? (await this.#service.list(origin.spaceId)).find((item) => item.runtimeInstanceKind === "app"
        && item.runtimeInstanceId === origin.runtimeInstanceId && item.projectId === app.projectId && item.manifest.id === appId)
      : undefined;
    return { sourceSpaceId: app.sourceSpaceId, sourcePath: context.sourcePath,
      buildConversationId: context.buildConversationId, updateTargetRuntimeInstanceId: target?.runtimeInstanceId ?? null };
  }

  #sourceContext(app: RestrictedAppInstalled) {
    const proposal = this.#registry.proposals.filter((item) => item.status === "installed"
      && item.spaceId === app.sourceSpaceId && item.review.digest === app.digest)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const changes = this.#registry.changes.filter((item) => item.sourceSpaceId === app.sourceSpaceId
      && item.appId === app.manifest.id && item.packageName === app.packageName && item.status === "ready"
      && (item.baseDigest === app.digest || item.previewBase?.digest === app.digest))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const linked = this.#registry.changes.find((item) => item.id === proposal?.changeId);
    const origin = linked ?? changes[0];
    const releaseOrigin = linked?.baseReleaseDigest ? linked : changes.find((item) => item.baseReleaseDigest !== null
      && item.previewBase?.digest === app.digest);
    return {
      sourcePath: proposal?.sourcePath ?? origin?.sourcePath ?? null,
      buildConversationId: proposal && !proposal.conversationId.startsWith("work-fold.act.")
        ? proposal.conversationId : origin?.buildConversationId ?? null,
      updateTarget: origin?.updateTarget ?? (releaseOrigin
        ? { spaceId: releaseOrigin.targetSpaceId, runtimeInstanceId: releaseOrigin.targetRuntimeInstanceId } : null),
    };
  }

  async prepareChange(input: { id: string; spaceId: string; appId: string; expectedDigest: string; featureInstallationId?: string },
    materialize: (change: RestrictedAppChangeReceipt, files: ReadonlyMap<string, Uint8Array>) => Promise<void>,
  ): Promise<RestrictedAppChangeReceipt> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.id)) {
      throw new RestrictedAppError("INPUT_INVALID", "A unique app-change request is required.");
    }
    return this.#mutate(async () => {
      let change = this.#registry.changes.find((item) => item.id === input.id);
      if (change && (change.targetSpaceId !== input.spaceId || change.appId !== input.appId || change.baseDigest !== input.expectedDigest
        || (input.featureInstallationId !== undefined && change.baseFeatureInstallationId !== input.featureInstallationId))) {
        throw new RestrictedAppError("INPUT_INVALID", "This app-change request already belongs to a different revision.");
      }
      if (change?.status === "ready") return structuredClone(change);
      if (!change && this.#registry.changes.length >= 1_000) {
        throw new RestrictedAppError("INPUT_INVALID", "This computer has reached its saved app-change limit.");
      }
      const snapshot = await this.#service.snapshotForChange(input.spaceId, input.appId, input.expectedDigest, input.featureInstallationId);
      const app = snapshot.app;
      if (change && (change.baseFeatureInstallationId !== app.featureInstallationId || change.targetRuntimeInstanceId !== app.runtimeInstanceId)) {
        throw new RestrictedAppError("REVISION_CHANGED", "The app was reinstalled while its working copy was being prepared.");
      }
      if (!change) {
        const build = this.#sourceContext(app);
        change = {
          id: input.id, status: "preparing", sourceSpaceId: app.sourceSpaceId,
          sourcePath: `${app.manifest.id}-change-${input.id}`,
          appId: app.manifest.id, packageName: app.packageName, title: app.manifest.title,
          version: app.version, baseDigest: app.digest,
          baseFeatureInstallationId: app.featureInstallationId,
          targetSpaceId: app.spaceId, targetRuntimeInstanceId: app.runtimeInstanceId,
          baseReleaseDigest: app.releaseDigest, previewBase: snapshot.previewBase,
          buildConversationId: build.buildConversationId, createdAt: new Date().toISOString(),
          updateTarget: app.runtimeInstanceKind === "app"
            ? { spaceId: app.spaceId, runtimeInstanceId: app.runtimeInstanceId } : build.updateTarget,
        };
        await this.#writeRegistry({ ...this.#registry, changes: [...this.#registry.changes, change] });
      }
      await materialize(structuredClone(change), snapshot.files);
      const ready = { ...change, status: "ready" as const };
      await this.#writeRegistry({ ...this.#registry, changes: this.#registry.changes.map((item) => item.id === ready.id ? ready : item) });
      return structuredClone(ready);
    });
  }

  async list(scope?: Partial<Pick<RestrictedAppProposalScope, "spaceId" | "conversationId">>): Promise<RestrictedAppProposalReceipt[]> {
    await this.#queue.catch(() => undefined);
    return this.#registry.proposals
      .filter((item) => (!scope?.spaceId || item.spaceId === scope.spaceId)
        && (!scope?.conversationId || item.conversationId === scope.conversationId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(copyReceipt);
  }

  async install(id: string): Promise<RestrictedAppInstalled | null> {
    return await this.#mutate(async () => {
      const proposal = this.#registry.proposals.find((item) => item.id === id);
      if (!proposal) return null;
      if (proposal.status === "installed" && proposal.installedApp) return structuredClone(proposal.installedApp);
      if (proposal.status !== "pending") return null;
      let app: RestrictedAppInstalled;
      try {
        app = await this.#service.install({
          spaceId: proposal.spaceId,
          spaceRoot: proposal.spaceRoot,
          sourcePath: proposal.sourcePath,
          expectedDigest: proposal.review.digest,
          ...(proposal.expectedPreviewBase !== undefined ? { expectedPreviewBase: proposal.expectedPreviewBase } : {}),
        });
      } catch (caught) {
        if (caught instanceof RestrictedAppError && caught.code === "REVISION_CHANGED") {
          proposal.status = "revision-changed";
          proposal.updatedAt = new Date().toISOString();
          await this.#writeRegistry(this.#registry);
          this.emit("settled", { proposal: copyReceipt(proposal) } satisfies RestrictedAppProposalSettled);
        }
        throw caught;
      }
      proposal.status = "installed";
      proposal.updatedAt = new Date().toISOString();
      proposal.installedApp = structuredClone(app);
      await this.#writeRegistry({ ...this.#registry, changes: this.#registry.changes.map((item) => item.id === proposal.changeId
        ? { ...item, previewBase: { featureInstallationId: app.featureInstallationId, digest: app.digest } } : item) });
      this.emit("settled", { proposal: copyReceipt(proposal) } satisfies RestrictedAppProposalSettled);
      return app;
    });
  }

  async dismiss(id: string): Promise<boolean> {
    return await this.#mutate(async () => {
      const proposal = this.#registry.proposals.find((item) => item.id === id);
      if (!proposal || proposal.status !== "pending") return false;
      proposal.status = "dismissed";
      proposal.updatedAt = new Date().toISOString();
      await this.#writeRegistry(this.#registry);
      this.emit("settled", { proposal: copyReceipt(proposal) } satisfies RestrictedAppProposalSettled);
      return true;
    });
  }

  async removeSpace(spaceId: string): Promise<void> {
    await this.#mutate(async () => {
      const proposals = this.#registry.proposals.filter((item) => item.spaceId !== spaceId);
      // A removed target does not erase guards on working copies still in their source Space.
      const changes = this.#registry.changes.filter((item) => item.sourceSpaceId !== spaceId);
      if (proposals.length === this.#registry.proposals.length && changes.length === this.#registry.changes.length) return;
      await this.#writeRegistry({ ...this.#registry, proposals, changes });
    });
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return await result;
  }

  async #writeRegistry(registry: ProposalRegistryFile): Promise<void> {
    const next = normalizeRegistry(registry);
    const temporaryPath = `${this.#registryPath}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporaryPath, this.#registryPath);
    let directory;
    try {
      directory = await open(dirname(this.#registryPath), "r");
      await directory.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!["EINVAL", "ENOTSUP", "EBADF"].includes(code)
        && !(process.platform === "win32" && ["EISDIR", "EPERM"].includes(code))) throw error;
    } finally { await directory?.close(); }
    this.#registry = next;
  }
}

async function readRegistry(path: string): Promise<ProposalRegistryFile> {
  try {
    return normalizeRegistry(JSON.parse(await readFile(path, "utf8")));
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { schemaVersion: 2, proposals: [], changes: [] };
    throw caught;
  }
}

function normalizeRegistry(value: unknown): ProposalRegistryFile {
  if (!value || typeof value !== "object" || (value as Partial<ProposalRegistryFile>).schemaVersion !== 2
    || !Array.isArray((value as ProposalRegistryFile).proposals)) {
    throw new Error("The app proposal registry is invalid or uses an unsupported version.");
  }
  const proposals = (value as ProposalRegistryFile).proposals.filter(validReceipt).map(copyReceipt).slice(-100);
  const rawChanges = (value as Partial<ProposalRegistryFile>).changes;
  if (rawChanges !== undefined && (!Array.isArray(rawChanges) || rawChanges.length > 1_000 || !rawChanges.every(validChange)
    || new Set(rawChanges.map((item) => item.id)).size !== rawChanges.length)) {
    throw new Error("App-change provenance is invalid. Restore the machine-local proposal registry before continuing.");
  }
  return { schemaVersion: 2, proposals, changes: structuredClone(rawChanges ?? []) };
}

function validChange(value: unknown): value is RestrictedAppChangeReceipt {
  if (!value || typeof value !== "object") return false;
  const item = value as RestrictedAppChangeReceipt;
  return typeof item.id === "string" && /^[0-9a-f-]{36}$/.test(item.id)
    && ["preparing", "ready"].includes(item.status)
    && [item.sourceSpaceId, item.appId, item.packageName, item.title, item.version, item.baseFeatureInstallationId,
      item.targetSpaceId, item.targetRuntimeInstanceId, item.createdAt].every((field) => typeof field === "string" && field.length > 0)
    && item.sourcePath === `${item.appId}-change-${item.id}` && /^[a-z0-9][a-z0-9._-]*$/.test(item.appId)
    && /^[a-f0-9]{64}$/.test(item.baseDigest)
    && (item.baseReleaseDigest === null || typeof item.baseReleaseDigest === "string")
    && (item.buildConversationId === null || typeof item.buildConversationId === "string")
    && (item.updateTarget === undefined || item.updateTarget === null || typeof item.updateTarget === "object"
      && typeof item.updateTarget.spaceId === "string" && typeof item.updateTarget.runtimeInstanceId === "string")
    && validPreviewBase(item.previewBase);
}

function validPreviewBase(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const item = value as Exclude<RestrictedAppPreviewBase, null>;
  return typeof item.featureInstallationId === "string" && typeof item.digest === "string" && /^[a-f0-9]{64}$/.test(item.digest);
}

function validReceipt(value: unknown): value is RestrictedAppProposalReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<RestrictedAppProposalReceipt>;
  return typeof receipt.id === "string"
    && typeof receipt.spaceId === "string"
    && typeof receipt.spaceRoot === "string"
    && typeof receipt.conversationId === "string"
    && typeof receipt.sourcePath === "string"
    && typeof receipt.createdAt === "string"
    && typeof receipt.updatedAt === "string"
    && (receipt.changeId === undefined || typeof receipt.changeId === "string" && receipt.expectedPreviewBase !== undefined)
    && (receipt.expectedPreviewBase === undefined || validPreviewBase(receipt.expectedPreviewBase))
    && ["pending", "installed", "dismissed", "revision-changed"].includes(String(receipt.status))
    && Boolean(receipt.review && typeof receipt.review.digest === "string");
}

function copyReceipt(receipt: RestrictedAppProposalReceipt): RestrictedAppProposalReceipt {
  return structuredClone(receipt);
}
