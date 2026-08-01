import { resolve } from "node:path";

import type { PiRuntimeConfig, PiRuntimeProvider } from "./pi-runtime-config.js";

/**
 * In work-fold, registering a Space is the host-level grant to load its Pi
 * project resources. The ordinary Space registry remains the durable source
 * of truth; Pi's own trust store is left untouched for native Pi consumers.
 */
export class RegisteredSpaceTrustAuthority {
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
 * Applies the Space registry decision at the host boundary. An accidental call
 * with an unregistered root is explicitly denied even if another Pi host has
 * trusted that folder independently.
 */
export class RegisteredSpaceRuntimeProvider implements PiRuntimeProvider {
  constructor(
    private readonly base: PiRuntimeProvider,
    private readonly authority: RegisteredSpaceTrustAuthority,
  ) {}

  async resolveRuntime(spaceRoot: string): Promise<PiRuntimeConfig> {
    const runtime = await this.base.resolveRuntime(spaceRoot);
    return {
      ...runtime,
      projectTrust: {
        ...runtime.projectTrust,
        override: this.authority.isRegistered(spaceRoot),
      },
    };
  }
}

function rootKey(rootPath: string): string {
  const normalized = resolve(rootPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
