import { resolve } from "node:path";

import type {
  PiModelCatalogRefreshResult,
  PiModelCatalogStatus,
  PiPreferredModel,
  PiRuntimeConfig,
  PiRuntimeProvider,
} from "./pi-runtime-config.js";

/**
 * In work-fold, registering a work-folder is the host-level grant to load its Pi
 * project resources. The ordinary work-folder registry remains the durable source
 * of truth; Pi's own trust store is left untouched for native Pi consumers.
 */
export class RegisteredWorkFolderTrustAuthority {
  readonly #roots = new Set<string>();

  constructor(rootPaths: Iterable<string> = []) {
    for (const rootPath of rootPaths) this.grant(rootPath);
  }

  grant(rootPath: string): void {
    this.#roots.add(rootKey(rootPath));
  }

  revoke(rootPath: string): void {
    this.#roots.delete(rootKey(rootPath));
  }

  isRegistered(rootPath: string): boolean {
    return this.#roots.has(rootKey(rootPath));
  }
}

/**
 * Applies the work-folder registry decision at the host boundary. An accidental call
 * with an unregistered root is explicitly denied even if another Pi host has
 * trusted that folder independently.
 */
export class RegisteredWorkFolderRuntimeProvider implements PiRuntimeProvider {
  readonly setPreferredModel?: (workFolderRoot: string, model: PiPreferredModel) => Promise<void>;
  readonly getWorkerInstructions?: (workFolderRoot: string) => Promise<string>;
  readonly setWorkerInstructions?: (workFolderRoot: string, instructions: string) => Promise<void>;
  readonly refreshModelCatalog?: (providerId: string) => Promise<PiModelCatalogRefreshResult>;
  readonly listModelCatalogs?: () => Promise<PiModelCatalogStatus[]>;

  constructor(
    private readonly base: PiRuntimeProvider,
    private readonly authority: RegisteredWorkFolderTrustAuthority,
  ) {
    if (base.setPreferredModel) {
      this.setPreferredModel = (workFolderRoot, model) => base.setPreferredModel!(workFolderRoot, model);
    }
    if (base.getWorkerInstructions) {
      this.getWorkerInstructions = (workFolderRoot) => base.getWorkerInstructions!(workFolderRoot);
    }
    if (base.setWorkerInstructions) {
      this.setWorkerInstructions = (workFolderRoot, instructions) => base.setWorkerInstructions!(workFolderRoot, instructions);
    }
    if (base.refreshModelCatalog) {
      this.refreshModelCatalog = (providerId) => base.refreshModelCatalog!(providerId);
    }
    if (base.listModelCatalogs) {
      this.listModelCatalogs = () => base.listModelCatalogs!();
    }
  }

  async resolveRuntime(workFolderRoot: string): Promise<PiRuntimeConfig> {
    const runtime = await this.base.resolveRuntime(workFolderRoot);
    return {
      ...runtime,
      projectTrust: {
        ...runtime.projectTrust,
        override: this.authority.isRegistered(workFolderRoot),
      },
    };
  }

}

function rootKey(rootPath: string): string {
  const normalized = resolve(rootPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
