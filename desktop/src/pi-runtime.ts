import {
  VERSION as PI_SDK_VERSION,
  ModelRuntime,
  type ProgressEvent,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { IncludedToolsConfiguration } from "../../src/local/agent/included-tools.js";

import {
  createPersistentPiAuthStorage,
  type PersistentPiAuthStorage,
  type PiAuthStorageHost,
} from "../../src/local/agent/auth-storage.js";
import type { PiExtensionUiBridge } from "../../src/local/agent/extension-ui.js";
import { ModelPreferenceStore } from "../../src/local/agent/model-preferences.js";
import { OpenRouterModelCatalog } from "../../src/local/agent/openrouter-model-catalog.js";
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
  type PiModelCatalogRefreshResult,
  type PiModelCatalogStatus,
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
  includedTools?: IncludedToolsConfiguration;
  /** Pi config, packages, models, and session root outside registered work-folders. */
  agentDir: string;
  /** Optional Electron-safeStorage implementation; native auth.json is the fallback. */
  authStorageHost?: PiAuthStorageHost;
  mcpCredentialBackend?: PiRuntimeConfig["mcpCredentialBackend"];
  /** Machine-local, non-secret Worker model preferences keyed by work-folder identity. */
  modelPreferencesPath?: string;
  /** Machine-local cache of OpenRouter's live model catalog. */
  openRouterCatalogPath?: string;
  /** App-owned root for the work-fold agent's own model preference. */
  workFoldAgentRootPath?: string;
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
  private credentialsPromise: Promise<PersistentPiAuthStorage> | null = null;
  private readonly preferences: ModelPreferenceStore;
  private readonly openRouterCatalog: OpenRouterModelCatalog;

  constructor(private readonly options: PackagedPiRuntimeOptions) {
    this.preferences = new ModelPreferenceStore({
      filePath: options.modelPreferencesPath ?? join(options.agentDir, "work-fold-model-preferences.json"),
      ...(options.workFoldAgentRootPath ? { workFoldAgentRootPath: options.workFoldAgentRootPath } : {}),
    });
    this.openRouterCatalog = new OpenRouterModelCatalog({
      cachePath: options.openRouterCatalogPath ?? join(options.agentDir, "openrouter-models.json"),
    });
  }

  async resolveRuntime(workFolderRoot: string): Promise<PiRuntimeConfig> {
    const auth = await this.credentials();
    const scopedPreferredModel = await this.preferences.get(workFolderRoot).catch(() => undefined);
    const workerInstructions = await this.preferences.getInstructions(workFolderRoot).catch(() => "");
    const openRouterCatalog = await this.openRouterCatalog.load().catch(() => undefined);
    const preferredModel = this.options.preferredModel ?? scopedPreferredModel;
    return {
      ...(this.options.includedTools ? { includedTools: this.options.includedTools } : {}),
      agentDir: this.options.agentDir,
      credentials: auth.credentials,
      mcpCredentialBackend: this.options.mcpCredentialBackend,
      flushCredentials: () => auth.flush(),
      ...(openRouterCatalog ? { modelCatalogs: [openRouterCatalog] } : {}),
      ...(this.options.extensionUi ? { extensionUi: this.options.extensionUi } : {}),
      ...(preferredModel ? { preferredModel } : {}),
      ...(workerInstructions ? { workerInstructions } : {}),
      ...(this.options.projectTrust ? { projectTrust: this.options.projectTrust } : {}),
      ...(this.options.additionalExtensionPaths ? { additionalExtensionPaths: this.options.additionalExtensionPaths } : {}),
      ...(this.options.additionalSkillPaths ? { additionalSkillPaths: this.options.additionalSkillPaths } : {}),
      ...(this.options.additionalPromptTemplatePaths ? { additionalPromptTemplatePaths: this.options.additionalPromptTemplatePaths } : {}),
      ...(this.options.additionalThemePaths ? { additionalThemePaths: this.options.additionalThemePaths } : {}),
      metadata: {
        piVersion: PI_SDK_VERSION,
        nodeVersion: process.version,
        ...(preferredModel ? {
          provider: preferredModel.provider,
          model: preferredModel.id,
        } : {}),
      },
    };
  }

  async health(workFolderRoot = process.cwd()): Promise<PackagedPiRuntimeHealth> {
    try {
      const status = await this.getSetupStatus(workFolderRoot);
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

  getSetupStatus(workFolderRoot: string): Promise<PiSetupStatus> {
    return getPiSetupStatus(workFolderRoot, this);
  }

  listModels(workFolderRoot: string): Promise<PiModelSummary[]> {
    return listPiModels(workFolderRoot, this);
  }

  async saveApiKey(
    workFolderRoot: string,
    provider: string,
    apiKey: string,
    env?: Record<string, string>,
  ): Promise<void> {
    await savePiApiKey(workFolderRoot, provider, apiKey, { env, runtimeProvider: this });
  }

  removeAuth(workFolderRoot: string, provider: string): Promise<void> {
    return removePiProviderAuth(workFolderRoot, provider, this);
  }

  loginOAuth(workFolderRoot: string, provider: string, hooks: PiOAuthHooks): Promise<void> {
    return loginPiOAuth(workFolderRoot, provider, hooks, this);
  }

  setDefaultModel(workFolderRoot: string, model: PiPreferredModel): Promise<void> {
    return setPiDefaultModel(workFolderRoot, model, this);
  }

  setPreferredModel(workFolderRoot: string, model: PiPreferredModel): Promise<void> {
    return this.preferences.set(workFolderRoot, model);
  }

  getWorkerInstructions(workFolderRoot: string): Promise<string> {
    return this.preferences.getInstructions(workFolderRoot);
  }

  setWorkerInstructions(workFolderRoot: string, instructions: string): Promise<void> {
    return this.preferences.setInstructions(workFolderRoot, instructions);
  }

  async refreshModelCatalog(providerId: string): Promise<PiModelCatalogRefreshResult> {
    if (providerId !== "openrouter") throw new Error(`${providerId} does not offer live model refresh.`);
    const auth = await this.credentials();
    const modelRuntime = await ModelRuntime.create({ credentials: auth.credentials, modelsPath: join(this.options.agentDir, "models.json") });
    const apiKey = (await modelRuntime.getAuth("openrouter"))?.auth.apiKey;
    if (!apiKey) throw new Error("Connect OpenRouter before refreshing its models.");
    return this.openRouterCatalog.refresh(apiKey);
  }

  async listModelCatalogs(): Promise<PiModelCatalogStatus[]> {
    return [await this.openRouterCatalog.status()];
  }

  setProjectTrust(workFolderRoot: string, decision: boolean | null): Promise<void> {
    return setPiProjectTrust(workFolderRoot, decision, this);
  }

  listPackages(workFolderRoot: string): Promise<PiConfiguredPackage[]> {
    return listPiPackages(workFolderRoot, this);
  }

  installPackage(
    workFolderRoot: string,
    source: string,
    options: Omit<PiPackageMutationOptions, "runtimeProvider"> = {},
  ): Promise<void> {
    return installPiPackage(workFolderRoot, source, { ...options, runtimeProvider: this });
  }

  removePackage(
    workFolderRoot: string,
    source: string,
    options: Omit<PiPackageMutationOptions, "runtimeProvider"> = {},
  ): Promise<boolean> {
    return removePiPackage(workFolderRoot, source, { ...options, runtimeProvider: this });
  }

  updatePackages(
    workFolderRoot: string,
    source?: string,
    options: { onProgress?: (event: ProgressEvent) => void } = {},
  ): Promise<void> {
    return updatePiPackages(workFolderRoot, source, { ...options, runtimeProvider: this });
  }

  importSkillBundle(
    workFolderRoot: string,
    input: { fileName: string; bytes: Uint8Array; scope?: "user" | "project" },
  ): Promise<PiSkillBundleImportResult> {
    return importPiSkillBundle(workFolderRoot, input, this);
  }

  async flush(): Promise<void> {
    if (this.credentialsPromise) await (await this.credentialsPromise).flush();
  }

  getExtensionUiBridge(): PiExtensionUiBridge | undefined {
    return this.options.extensionUi;
  }

  private credentials(): Promise<PersistentPiAuthStorage> {
    this.credentialsPromise ??= createPersistentPiAuthStorage({
      agentDir: this.options.agentDir,
      ...(this.options.authStorageHost ? { host: this.options.authStorageHost } : {}),
    });
    return this.credentialsPromise;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
