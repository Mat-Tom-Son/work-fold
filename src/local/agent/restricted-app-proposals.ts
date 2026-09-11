import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { RestrictedAppError } from "./restricted-app-connections.js";
import {
  installationNeeds,
  type RestrictedAppInstallationNeeds,
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

/**
 * `pending` exists only between the receipt write and the install that the
 * same call performs (or after a crash between them); `failed` keeps a
 * bounded plain error and can be retried or dismissed.
 */
export type RestrictedAppProposalStatus = "pending" | "installed" | "failed" | "dismissed" | "revision-changed";

export interface RestrictedAppProposalReceipt extends RestrictedAppProposalScope {
  id: string;
  sourcePath: string;
  review: RestrictedAppReview;
  status: RestrictedAppProposalStatus;
  createdAt: string;
  updatedAt: string;
  installedApp?: RestrictedAppInstalled;
  /** Bounded plain text from the failed install; never a credential. */
  error?: string;
  /** What still needs a person after the install; the receipt is the record. */
  needs?: RestrictedAppInstallationNeeds;
  changeId?: string;
  expectedPreviewBase?: RestrictedAppPreviewBase;
}

export interface RestrictedAppProposalInstallContext {
  spaceId: string;
  conversationId: string;
}

/**
 * Performs the recorded proposal's install. The server supplies a variant that
 * waits for other Space work and never stops the proposing turn's own client.
 */
export type RestrictedAppProposalInstaller = (
  proposalId: string,
  context: RestrictedAppProposalInstallContext,
) => Promise<RestrictedAppInstalled | null>;

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
  status: "installed" | "failed" | "cancelled";
  proposal?: RestrictedAppProposalReceipt;
  app?: RestrictedAppInstalled;
  needs?: RestrictedAppInstallationNeeds;
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
 * folder, owns every review field and the digest used for installation, and
 * installs the local preview in the same call; the receipt is the record of
 * what was added and what still needs a person (docs/receipts-not-gates.md, F21).
 */
export class RoutedRestrictedAppProposalHost extends EventEmitter implements RestrictedAppProposalHost {
  readonly #service: RestrictedAppService;
  readonly #registryPath: string;
  readonly #installNow: RestrictedAppProposalInstaller;
  #registry: ProposalRegistryFile;
  #queue: Promise<void> = Promise.resolve();

  private constructor(service: RestrictedAppService, registryPath: string, registry: ProposalRegistryFile, installNow?: RestrictedAppProposalInstaller) {
    super();
    this.#service = service;
    this.#registryPath = registryPath;
    this.#registry = registry;
    this.#installNow = installNow ?? ((id) => this.install(id));
  }

  static async create(options: {
    service: RestrictedAppService;
    registryPath: string;
    installNow?: RestrictedAppProposalInstaller;
  }): Promise<RoutedRestrictedAppProposalHost> {
    const registryPath = resolve(options.registryPath);
    await mkdir(dirname(registryPath), { recursive: true });
    return new RoutedRestrictedAppProposalHost(options.service, registryPath, await readRegistry(registryPath), options.installNow);
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
        throw new RestrictedAppError("INPUT_INVALID", "Keep the app and package identity of this working copy before adding it.");
      }
      const existing = this.#registry.proposals.find((item) => (item.status === "pending" || item.status === "installed" || item.status === "failed")
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
    if (proposal.status === "pending") this.emit("request", proposal);
    if (signal?.aborted) return { status: "cancelled", proposal };
    let app: RestrictedAppInstalled | null;
    try {
      app = await this.#installNow(proposal.id, { spaceId: input.spaceId, conversationId: input.conversationId });
    } catch {
      // install() already recorded the failure and emitted its settlement.
      return { status: "failed", proposal: (await this.get(proposal.id)) ?? proposal };
    }
    const settled = (await this.get(proposal.id)) ?? proposal;
    if (!app || settled.status !== "installed") return { status: "failed", proposal: settled };
    return { status: "installed", proposal: settled, app, ...(settled.needs ? { needs: settled.needs } : {}) };
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

  /** Installs the recorded revision; idempotent once installed, retryable after a failure. */
  async install(id: string): Promise<RestrictedAppInstalled | null> {
    return await this.#mutate(async () => {
      const proposal = this.#registry.proposals.find((item) => item.id === id);
      if (!proposal) return null;
      if (proposal.status === "installed" && proposal.installedApp) return structuredClone(proposal.installedApp);
      if (proposal.status !== "pending" && proposal.status !== "failed") return null;
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
        // A changed preview base is terminal for this receipt (the person
        // starts the edit again); any other failure can be retried.
        const revisionChanged = caught instanceof RestrictedAppError && caught.code === "REVISION_CHANGED";
        proposal.status = revisionChanged ? "revision-changed" : "failed";
        proposal.updatedAt = new Date().toISOString();
        proposal.error = boundedError(caught);
        await this.#writeRegistry(this.#registry);
        this.emit("settled", { proposal: copyReceipt(proposal) } satisfies RestrictedAppProposalSettled);
        throw caught;
      }
      proposal.status = "installed";
      proposal.updatedAt = new Date().toISOString();
      proposal.installedApp = structuredClone(app);
      proposal.needs = await this.#needsFor(app);
      delete proposal.error;
      await this.#writeRegistry({ ...this.#registry, changes: this.#registry.changes.map((item) => item.id === proposal.changeId
        ? { ...item, previewBase: { featureInstallationId: app.featureInstallationId, digest: app.digest } } : item) });
      this.emit("settled", { proposal: copyReceipt(proposal) } satisfies RestrictedAppProposalSettled);
      return app;
    });
  }

  async #needsFor(app: RestrictedAppInstalled): Promise<RestrictedAppInstallationNeeds> {
    let statuses: Awaited<ReturnType<RestrictedAppService["connectionStatus"]>> = [];
    try {
      statuses = await this.#service.connectionStatus(app.spaceId, app.manifest.id, app.digest, app.featureInstallationId);
    } catch {
      // Without a connection store every credential-bearing destination still needs the person.
    }
    return installationNeeds(app, statuses);
  }

  async dismiss(id: string): Promise<boolean> {
    return await this.#mutate(async () => {
      const proposal = this.#registry.proposals.find((item) => item.id === id);
      if (!proposal || (proposal.status !== "pending" && proposal.status !== "failed")) return false;
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
    && (receipt.error === undefined || typeof receipt.error === "string" && receipt.error.length <= maximumErrorLength)
    && (receipt.needs === undefined || validNeeds(receipt.needs))
    && ["pending", "installed", "failed", "dismissed", "revision-changed"].includes(String(receipt.status))
    && Boolean(receipt.review && typeof receipt.review.digest === "string");
}

function validNeeds(value: unknown): value is RestrictedAppInstallationNeeds {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const needs = value as Record<string, unknown>;
  return ["connections", "files", "checks"].every((key) => Array.isArray(needs[key])
    && (needs[key] as unknown[]).every((item) => typeof item === "string" && item.length > 0 && item.length <= 64))
    && Object.keys(needs).every((key) => ["connections", "files", "checks"].includes(key));
}

const maximumErrorLength = 500;

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  const text = message.trim() || "The app could not be added.";
  return text.length > maximumErrorLength ? `${text.slice(0, maximumErrorLength - 1)}…` : text;
}

function copyReceipt(receipt: RestrictedAppProposalReceipt): RestrictedAppProposalReceipt {
  return structuredClone(receipt);
}
