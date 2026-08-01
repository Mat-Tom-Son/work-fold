import {
  VERSION as PI_SDK_VERSION,
  type ProgressEvent,
} from "@earendil-works/pi-coding-agent";

import {
  createPersistentPiAuthStorage,
  type PersistentPiAuthStorage,
  type PiAuthStorageHost,
} from "../../src/local/agent/auth-storage.js";
import type { PiExtensionUiBridge } from "../../src/local/agent/extension-ui.js";
import { importPiSkillBundle, type PiSkillBundleImportResult } from "../../src/local/agent/skill-import.js";
import {
  getPiSetupStatus,
  installPiPackage,
  listPiModels,
  listPiPackages,
  loginPiOAuth,
  removePiPackage,
  removePiProviderAuth,
  savePiApiKey,
  setPiDefaultModel,
  setPiProjectTrust,
  updatePiPackages,
  type PiConfiguredPackage,
  type PiModelSummary,
  type PiOAuthHooks,
  type PiPackageMutationOptions,
  type PiPreferredModel,
  type PiProjectTrustPolicy,
  type PiRuntimeConfig,
  type PiRuntimeProvider,
  type PiSetupStatus,
} from "../../src/local/agent/pi-runtime-config.js";

export interface PackagedPiRuntimeOptions {
  /** Pi config, packages, models, and session root outside registered Spaces. */
  agentDir: string;
  /** Optional Electron-safeStorage implementation; native auth.json is the fallback. */
  authStorageHost?: PiAuthStorageHost;
  /** Shared HTTP/SSE or IPC bridge used by all extension sessions. */
  extensionUi?: PiExtensionUiBridge;
  preferredModel?: PiPreferredModel;
  projectTrust?: PiProjectTrustPolicy;
  additionalExtensionPaths?: string[];
  additionalSkillPaths?: string[];
  additionalPromptTemplatePaths?: string[];
  additionalThemePaths?: string[];
}

export interface PackagedPiRuntimeHealth {
  ok: boolean;
  configured: boolean;
  version: string;
  message?: string;
}

/** Native, provider-neutral Pi host used by the Electron main process. */
export class PackagedPiRuntimeProvider implements PiRuntimeProvider {
  private authStoragePromise: Promise<PersistentPiAuthStorage> | null = null;

  constructor(private readonly options: PackagedPiRuntimeOptions) {}

  async resolveRuntime(): Promise<PiRuntimeConfig> {
    const auth = await this.authStorage();
    return {
      agentDir: this.options.agentDir,
      authStorage: auth.authStorage,
      flushAuthStorage: () => auth.flush(),
      ...(this.options.extensionUi ? { extensionUi: this.options.extensionUi } : {}),
      ...(this.options.preferredModel ? { preferredModel: this.options.preferredModel } : {}),
      ...(this.options.projectTrust ? { projectTrust: this.options.projectTrust } : {}),
      ...(this.options.additionalExtensionPaths ? { additionalExtensionPaths: this.options.additionalExtensionPaths } : {}),
      ...(this.options.additionalSkillPaths ? { additionalSkillPaths: this.options.additionalSkillPaths } : {}),
      ...(this.options.additionalPromptTemplatePaths ? { additionalPromptTemplatePaths: this.options.additionalPromptTemplatePaths } : {}),
      ...(this.options.additionalThemePaths ? { additionalThemePaths: this.options.additionalThemePaths } : {}),
      metadata: {
        piVersion: PI_SDK_VERSION,
        nodeVersion: process.version,
        ...(this.options.preferredModel ? {
          provider: this.options.preferredModel.provider,
          model: this.options.preferredModel.id,
        } : {}),
      },
    };
  }

  async health(spaceRoot = process.cwd()): Promise<PackagedPiRuntimeHealth> {
    try {
      const status = await this.getSetupStatus(spaceRoot);
      return {
        ok: status.error === null,
        configured: status.configured,
        version: status.piVersion,
        ...(status.error ? { message: status.error } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        configured: false,
        version: PI_SDK_VERSION,
        message: errorMessage(error),
      };
    }
  }

  getSetupStatus(spaceRoot: string): Promise<PiSetupStatus> {
    return getPiSetupStatus(spaceRoot, this);
  }

  listModels(spaceRoot: string): Promise<PiModelSummary[]> {
    return listPiModels(spaceRoot, this);
  }

  async saveApiKey(
    spaceRoot: string,
    provider: string,
    apiKey: string,
    env?: Record<string, string>,
  ): Promise<void> {
    await savePiApiKey(spaceRoot, provider, apiKey, { env, runtimeProvider: this });
  }

  removeAuth(spaceRoot: string, provider: string): Promise<void> {
    return removePiProviderAuth(spaceRoot, provider, this);
  }

  loginOAuth(spaceRoot: string, provider: string, hooks: PiOAuthHooks): Promise<void> {
    return loginPiOAuth(spaceRoot, provider, hooks, this);
  }

  setDefaultModel(spaceRoot: string, model: PiPreferredModel): Promise<void> {
    return setPiDefaultModel(spaceRoot, model, this);
  }

  setProjectTrust(spaceRoot: string, decision: boolean | null): Promise<void> {
    return setPiProjectTrust(spaceRoot, decision, this);
  }

  listPackages(spaceRoot: string): Promise<PiConfiguredPackage[]> {
    return listPiPackages(spaceRoot, this);
  }

  installPackage(
    spaceRoot: string,
    source: string,
    options: Omit<PiPackageMutationOptions, "runtimeProvider"> = {},
  ): Promise<void> {
    return installPiPackage(spaceRoot, source, { ...options, runtimeProvider: this });
  }

  removePackage(
    spaceRoot: string,
    source: string,
    options: Omit<PiPackageMutationOptions, "runtimeProvider"> = {},
  ): Promise<boolean> {
    return removePiPackage(spaceRoot, source, { ...options, runtimeProvider: this });
  }

  updatePackages(
    spaceRoot: string,
    source?: string,
    options: { onProgress?: (event: ProgressEvent) => void } = {},
  ): Promise<void> {
    return updatePiPackages(spaceRoot, source, { ...options, runtimeProvider: this });
  }

  importSkillBundle(
    spaceRoot: string,
    input: { fileName: string; bytes: Uint8Array; scope?: "user" | "project" },
  ): Promise<PiSkillBundleImportResult> {
    return importPiSkillBundle(spaceRoot, input, this);
  }

  async flush(): Promise<void> {
    if (this.authStoragePromise) await (await this.authStoragePromise).flush();
  }

  getExtensionUiBridge(): PiExtensionUiBridge | undefined {
    return this.options.extensionUi;
  }

  private authStorage(): Promise<PersistentPiAuthStorage> {
    this.authStoragePromise ??= createPersistentPiAuthStorage({
      agentDir: this.options.agentDir,
      ...(this.options.authStorageHost ? { host: this.options.authStorageHost } : {}),
    });
    return this.authStoragePromise;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
