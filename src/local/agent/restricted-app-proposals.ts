import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { RestrictedAppError } from "./restricted-app-connections.js";
import {
  type RestrictedAppInstalled,
  type RestrictedAppReview,
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
      };
      const proposals = [...this.#registry.proposals, receipt]
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .slice(-100);
      await this.#writeRegistry({ schemaVersion: 2, proposals });
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
      await this.#writeRegistry(this.#registry);
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
      if (proposals.length === this.#registry.proposals.length) return;
      await this.#writeRegistry({ schemaVersion: 2, proposals });
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
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.#registryPath);
    this.#registry = next;
  }
}

async function readRegistry(path: string): Promise<ProposalRegistryFile> {
  try {
    return normalizeRegistry(JSON.parse(await readFile(path, "utf8")));
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || caught instanceof SyntaxError) return { schemaVersion: 2, proposals: [] };
    throw caught;
  }
}

function normalizeRegistry(value: unknown): ProposalRegistryFile {
  const proposals = value && typeof value === "object"
    && (value as Partial<ProposalRegistryFile>).schemaVersion === 2
    && Array.isArray((value as ProposalRegistryFile).proposals)
    ? (value as ProposalRegistryFile).proposals.filter(validReceipt).map(copyReceipt).slice(-100)
    : [];
  return { schemaVersion: 2, proposals };
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
    && ["pending", "installed", "dismissed", "revision-changed"].includes(String(receipt.status))
    && Boolean(receipt.review && typeof receipt.review.digest === "string");
}

function copyReceipt(receipt: RestrictedAppProposalReceipt): RestrictedAppProposalReceipt {
  return structuredClone(receipt);
}
