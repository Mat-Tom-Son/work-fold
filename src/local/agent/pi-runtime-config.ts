import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  AuthStorage,
  DefaultPackageManager,
  ModelRegistry,
  ProjectTrustStore,
  SettingsManager,
  VERSION as PI_SDK_VERSION,
  createAgentSessionServices,
  hasTrustRequiringProjectResources,
  type AuthStatus,
  type ProviderConfig,
  type ProgressEvent,
} from "@earendil-works/pi-coding-agent";

import { defaultAgentSdkDir, spaceSessionDir } from "./agent-data-dir.js";
import type { PiExtensionUiBridge } from "./extension-ui.js";

export interface PiPreferredModel {
  provider: string;
  id: string;
}

export interface PiProjectTrustRequest {
  spaceRoot: string;
  hasProjectResources: boolean;
  savedDecision: boolean | null;
  defaultDecision: "ask" | "always" | "never";
}

export interface PiProjectTrustDecision {
  trusted: boolean;
  remember?: boolean;
}

export interface PiProjectTrustPolicy {
  /** One-run override, equivalent to Pi's --approve/--no-approve. */
  override?: boolean;
  request?: (
    request: PiProjectTrustRequest,
  ) => Promise<boolean | PiProjectTrustDecision>;
}

export interface PiRuntimeMetadata {
  piVersion?: string;
  nodeVersion?: string;
  provider?: string;
  model?: string;
}

/**
 * Cwd-specific runtime inputs. Hosts may inject secure AuthStorage and shared
 * model/settings services; otherwise Pi's native persistent files are used.
 */
export interface PiRuntimeConfig {
  agentDir?: string;
  sessionDir?: string;
  authStorage?: AuthStorage;
  flushAuthStorage?: () => Promise<void>;
  settingsManager?: SettingsManager;
  modelRegistry?: ModelRegistry;
  /** Host-fetched catalogs applied to each fresh cwd-specific registry. */
  modelCatalogs?: PiModelCatalog[];
  preferredModel?: PiPreferredModel;
  projectTrust?: PiProjectTrustPolicy;
  extensionUi?: PiExtensionUiBridge;
  additionalExtensionPaths?: string[];
  additionalSkillPaths?: string[];
  additionalPromptTemplatePaths?: string[];
  additionalThemePaths?: string[];
  metadata?: PiRuntimeMetadata;
}

export interface PiRuntimeProvider {
  resolveRuntime(spaceRoot: string): Promise<PiRuntimeConfig>;
  setPreferredModel?(spaceRoot: string, model: PiPreferredModel): Promise<void>;
  refreshModelCatalog?(providerId: string): Promise<PiModelCatalogRefreshResult>;
  listModelCatalogs?(): Promise<PiModelCatalogStatus[]>;
}

export interface PiModelCatalog {
  provider: string;
  refreshedAt: string;
  liveModelCount: number;
  config: ProviderConfig;
}

export interface PiModelCatalogStatus {
  provider: string;
  refreshable: boolean;
  source: "built_in" | "live";
  refreshedAt?: string;
  modelCount?: number;
}

export interface PiModelCatalogRefreshResult {
  provider: string;
  refreshedAt: string;
  modelCount: number;
}

export interface ResolvedPiRuntime {
  config: PiRuntimeConfig;
  agentDir: string;
  sessionDir: string;
  authStorage: AuthStorage;
  settingsManager: SettingsManager;
  modelRegistry: ModelRegistry;
  preferredModel?: PiPreferredModel;
  projectTrust: {
    required: boolean;
    trusted: boolean;
    savedDecision: boolean | null;
  };
  flushAuthStorage(): Promise<void>;
}

export interface PiProviderSetupStatus {
  id: string;
  name: string;
  configured: boolean;
  authSource?: AuthStatus["source"];
  authLabel?: string;
  oauth: boolean;
  modelCount: number;
}

export interface PiSetupStatus {
  ready: boolean;
  configured: boolean;
  piVersion: string;
  agentDir: string;
  provider?: string;
  model?: string;
  projectTrusted: boolean;
  error: string | null;
  preferredModel?: PiPreferredModel;
  preferredModelAvailable: boolean;
  providers: PiProviderSetupStatus[];
  projectTrust: ResolvedPiRuntime["projectTrust"];
  errors: string[];
}

export interface PiModelSummary {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  configured: boolean;
  authConfigured: boolean;
  authSource?: AuthStatus["source"];
  authLabel?: string;
  authType?: "api_key" | "oauth";
  oauthSupported: boolean;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
}

export interface PiOAuthHooks {
  openUrl(info: { url: string; instructions?: string }): Promise<void> | void;
  showDeviceCode(info: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }): Promise<void> | void;
  prompt(input: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
  select(input: {
    message: string;
    options: Array<{ id: string; label: string }>;
  }): Promise<string | undefined>;
  progress?(message: string): void;
  manualCodeInput?(): Promise<string>;
  signal?: AbortSignal;
}

export interface PiPackageMutationOptions {
  scope?: "user" | "project";
  runtimeProvider?: PiRuntimeProvider;
  onProgress?: (event: ProgressEvent) => void;
}

export interface PiConfiguredPackage {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  installedPath?: string;
}

/**
 * Project capability writes require an explicit, persistent trust policy. Pi
 * treats a project with no trust-gated files as runtime-trusted, but that
 * implicit state must not authorize work-fold to create executable project
 * configuration on the user's behalf.
 */
export function hasExplicitPiProjectMutationTrust(runtime: ResolvedPiRuntime): boolean {
  const override = runtime.config.projectTrust?.override;
  if (typeof override === "boolean") return override;
  const savedDecision = runtime.projectTrust.savedDecision;
  if (typeof savedDecision === "boolean") return savedDecision;
  return runtime.settingsManager.getDefaultProjectTrust() === "always";
}

export async function isPiProjectMutationTrusted(
  spaceRoot: string,
  runtimeProvider?: PiRuntimeProvider,
): Promise<boolean> {
  const runtime = await resolvePiRuntime(spaceRoot, runtimeProvider, { requestProjectTrust: false });
  return hasExplicitPiProjectMutationTrust(runtime);
}

export async function resolvePiRuntime(
  spaceRoot: string,
  provider?: PiRuntimeProvider,
  options: { requestProjectTrust?: boolean } = {},
): Promise<ResolvedPiRuntime> {
  const config = await provider?.resolveRuntime(spaceRoot) ?? {};
  const agentDir = config.agentDir ?? defaultAgentSdkDir();
  await mkdir(agentDir, { recursive: true });

  const authStorage = config.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
  const initialSettings = config.settingsManager
    ?? SettingsManager.create(spaceRoot, agentDir, { projectTrusted: false });
  const trust = await resolveProjectTrust(
    spaceRoot,
    agentDir,
    initialSettings,
    config.projectTrust,
    options.requestProjectTrust !== false,
  );
  initialSettings.setProjectTrusted(trust.trusted);
  await initialSettings.reload();

  const modelRegistry = config.modelRegistry
    ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  applyModelCatalogs(modelRegistry, config.modelCatalogs ?? []);
  const settingsPreferred = preferredModelFromSettings(initialSettings);
  const metadataPreferred = config.metadata?.provider && config.metadata.model
    ? { provider: config.metadata.provider, id: config.metadata.model }
    : undefined;

  return {
    config,
    agentDir,
    sessionDir: config.sessionDir ?? spaceSessionDir(spaceRoot, agentDir),
    authStorage,
    settingsManager: initialSettings,
    modelRegistry,
    preferredModel: config.preferredModel ?? settingsPreferred ?? metadataPreferred,
    projectTrust: trust,
    flushAuthStorage: config.flushAuthStorage ?? (async () => undefined),
  };
}

export async function getPiSetupStatus(
  spaceRoot: string,
  provider?: PiRuntimeProvider,
): Promise<PiSetupStatus> {
  const runtime = await resolvePiRuntime(spaceRoot, provider, { requestProjectTrust: false });
  const providerDiagnostics = await loadRuntimeProviders(spaceRoot, runtime);
  const models = runtime.modelRegistry.getAll();
  const oauthProviders = new Set(runtime.authStorage.getOAuthProviders().map((item) => item.id));
  const providerIds = new Set([...models.map((model) => model.provider), ...oauthProviders]);
  const providers = [...providerIds].map((id) => {
    const providerModels = models.filter((model) => model.provider === id);
    const auth = runtime.modelRegistry.getProviderAuthStatus(id);
    return {
      id,
      name: runtime.modelRegistry.getProviderDisplayName(id),
      configured: auth.configured,
      ...(auth.source ? { authSource: auth.source } : {}),
      ...(auth.label ? { authLabel: auth.label } : {}),
      oauth: oauthProviders.has(id),
      modelCount: providerModels.length,
    } satisfies PiProviderSetupStatus;
  }).sort((left, right) => left.name.localeCompare(right.name));

  const errors = [
    runtime.modelRegistry.getError(),
    ...runtime.authStorage.drainErrors().map(errorMessage),
    ...providerDiagnostics.filter((item) => item.type === "error").map((item) => item.message),
  ]
    .filter((value): value is string => Boolean(value));
  const preferredModelAvailable = runtime.preferredModel
    ? Boolean(runtime.modelRegistry.find(runtime.preferredModel.provider, runtime.preferredModel.id))
    : false;

  const configured = runtime.modelRegistry.getAvailable().length > 0;
  return {
    ready: errors.length === 0,
    configured,
    piVersion: runtime.config.metadata?.piVersion ?? PI_SDK_VERSION,
    agentDir: runtime.agentDir,
    ...(runtime.preferredModel ? {
      provider: runtime.preferredModel.provider,
      model: runtime.preferredModel.id,
    } : {}),
    projectTrusted: runtime.projectTrust.trusted,
    error: errors[0] ?? null,
    ...(runtime.preferredModel ? { preferredModel: runtime.preferredModel } : {}),
    preferredModelAvailable,
    providers,
    projectTrust: runtime.projectTrust,
    errors,
  };
}

export async function listPiModels(
  spaceRoot: string,
  provider?: PiRuntimeProvider,
): Promise<PiModelSummary[]> {
  const runtime = await resolvePiRuntime(spaceRoot, provider, { requestProjectTrust: false });
  await loadRuntimeProviders(spaceRoot, runtime);
  const oauthProviders = new Set(runtime.authStorage.getOAuthProviders().map((item) => item.id));
  return runtime.modelRegistry.getAll().map((model) => {
    const auth = runtime.modelRegistry.getProviderAuthStatus(model.provider);
    const storedCredential = runtime.authStorage.get(model.provider);
    const configured = runtime.modelRegistry.hasConfiguredAuth(model);
    return {
      provider: model.provider,
      providerName: runtime.modelRegistry.getProviderDisplayName(model.provider),
      id: model.id,
      name: model.name,
      configured,
      authConfigured: configured,
      ...(auth.source ? { authSource: auth.source } : {}),
      ...(auth.label ? { authLabel: auth.label } : {}),
      ...(storedCredential ? { authType: storedCredential.type } : {}),
      oauthSupported: oauthProviders.has(model.provider),
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    } satisfies PiModelSummary;
  }).sort((left, right) =>
    left.providerName.localeCompare(right.providerName) || left.name.localeCompare(right.name));
}

export async function savePiApiKey(
  spaceRoot: string,
  providerId: string,
  apiKey: string,
  options: { env?: Record<string, string>; runtimeProvider?: PiRuntimeProvider } = {},
): Promise<void> {
  const id = cleanProviderId(providerId);
  const key = apiKey.trim();
  if (!key) throw new Error("API key is required.");
  const runtime = await resolvePiRuntime(spaceRoot, options.runtimeProvider, { requestProjectTrust: false });
  runtime.authStorage.set(id, {
    type: "api_key",
    key,
    ...(options.env && Object.keys(options.env).length > 0 ? { env: cleanStringRecord(options.env) } : {}),
  });
  await runtime.flushAuthStorage();
  runtime.modelRegistry.refresh();
}

export async function removePiProviderAuth(
  spaceRoot: string,
  providerId: string,
  runtimeProvider?: PiRuntimeProvider,
): Promise<void> {
  const id = cleanProviderId(providerId);
  const runtime = await resolvePiRuntime(spaceRoot, runtimeProvider, { requestProjectTrust: false });
  runtime.authStorage.logout(id);
  await runtime.flushAuthStorage();
  runtime.modelRegistry.refresh();
}

export async function loginPiOAuth(
  spaceRoot: string,
  providerId: string,
  hooks: PiOAuthHooks,
  runtimeProvider?: PiRuntimeProvider,
): Promise<void> {
  const id = cleanProviderId(providerId);
  const runtime = await resolvePiRuntime(spaceRoot, runtimeProvider, { requestProjectTrust: false });
  await loadRuntimeProviders(spaceRoot, runtime);
  const oauthProvider = runtime.authStorage.getOAuthProviders().find((item) => item.id === id);
  if (!oauthProvider) throw new Error(`Provider ${id} does not offer Pi OAuth login.`);

  await runtime.authStorage.login(id, {
    onAuth: (info) => {
      void hooks.openUrl(info);
    },
    onDeviceCode: (info) => {
      void hooks.showDeviceCode(info);
      void hooks.openUrl({ url: info.verificationUri });
    },
    onPrompt: hooks.prompt,
    onProgress: hooks.progress,
    onManualCodeInput: hooks.manualCodeInput,
    onSelect: hooks.select,
    signal: hooks.signal,
  });
  await runtime.flushAuthStorage();
  runtime.modelRegistry.refresh();
}

export async function setPiDefaultModel(
  spaceRoot: string,
  model: PiPreferredModel,
  runtimeProvider?: PiRuntimeProvider,
): Promise<void> {
  const runtime = await resolvePiRuntime(spaceRoot, runtimeProvider, { requestProjectTrust: false });
  await loadRuntimeProviders(spaceRoot, runtime);
  const selected = runtime.modelRegistry.find(model.provider.trim(), model.id.trim());
  if (!selected) throw new Error(`Model not found: ${model.provider}/${model.id}`);
  if (runtimeProvider?.setPreferredModel) {
    await runtimeProvider.setPreferredModel(spaceRoot, { provider: selected.provider, id: selected.id });
    return;
  }
  runtime.settingsManager.setDefaultModelAndProvider(selected.provider, selected.id);
  await runtime.settingsManager.flush();
}

export async function listPiModelCatalogs(runtimeProvider?: PiRuntimeProvider): Promise<PiModelCatalogStatus[]> {
  return runtimeProvider?.listModelCatalogs ? runtimeProvider.listModelCatalogs() : [];
}

export async function refreshPiModelCatalog(
  providerId: string,
  runtimeProvider?: PiRuntimeProvider,
): Promise<PiModelCatalogRefreshResult> {
  const provider = cleanProviderId(providerId);
  if (!runtimeProvider?.refreshModelCatalog) throw new Error(`${provider} does not offer live model refresh.`);
  return runtimeProvider.refreshModelCatalog(provider);
}

export async function setPiProjectTrust(
  spaceRoot: string,
  decision: boolean | null,
  runtimeProvider?: PiRuntimeProvider,
): Promise<void> {
  const config = await runtimeProvider?.resolveRuntime(spaceRoot) ?? {};
  const agentDir = config.agentDir ?? defaultAgentSdkDir();
  await mkdir(agentDir, { recursive: true });
  new ProjectTrustStore(agentDir).set(spaceRoot, decision);
}

export async function listPiPackages(
  spaceRoot: string,
  runtimeProvider?: PiRuntimeProvider,
): Promise<PiConfiguredPackage[]> {
  const runtime = await resolvePiRuntime(spaceRoot, runtimeProvider, { requestProjectTrust: false });
  return createPackageManager(spaceRoot, runtime).listConfiguredPackages();
}

export async function installPiPackage(
  spaceRoot: string,
  source: string,
  options: PiPackageMutationOptions = {},
): Promise<void> {
  const packageSource = source.trim();
  if (!packageSource) throw new Error("Package source is required.");
  const runtime = await resolvePiRuntime(spaceRoot, options.runtimeProvider, { requestProjectTrust: false });
  assertPiProjectMutationTrusted(runtime, options.scope);
  const manager = createPackageManager(spaceRoot, runtime, options.onProgress);
  await manager.installAndPersist(packageSource, { local: options.scope === "project" });
  await runtime.settingsManager.flush();
}

export async function removePiPackage(
  spaceRoot: string,
  source: string,
  options: PiPackageMutationOptions = {},
): Promise<boolean> {
  const packageSource = source.trim();
  if (!packageSource) throw new Error("Package source is required.");
  const runtime = await resolvePiRuntime(spaceRoot, options.runtimeProvider, { requestProjectTrust: false });
  assertPiProjectMutationTrusted(runtime, options.scope);
  const manager = createPackageManager(spaceRoot, runtime, options.onProgress);
  const configured = manager.listConfiguredPackages().find((item) =>
    item.source === packageSource && item.scope === (options.scope ?? "user"));
  // Local project sources are persisted relative to `.pi/settings.json` while
  // remove input is normally resolved from the Space root. Feed the resolved
  // path back to Pi so a source copied directly from listPiPackages matches.
  const removalSource = configured?.installedPath && !isManagedPackageSource(packageSource)
    ? configured.installedPath
    : packageSource;
  const removed = await manager.removeAndPersist(removalSource, { local: options.scope === "project" });
  await runtime.settingsManager.flush();
  return removed;
}

export async function updatePiPackages(
  spaceRoot: string,
  source: string | undefined,
  options: PiPackageMutationOptions = {},
): Promise<void> {
  const runtime = await resolvePiRuntime(spaceRoot, options.runtimeProvider, { requestProjectTrust: false });
  assertPiProjectMutationTrusted(runtime, options.scope);
  const manager = createPackageManager(spaceRoot, runtime, options.onProgress);
  const packageSource = source?.trim() || undefined;
  if (!options.scope) {
    await manager.update(packageSource);
    return;
  }

  if (!packageSource) throw new Error("Package source is required for a scoped update.");
  const configured = manager.listConfiguredPackages().find((item) =>
    item.source === packageSource && item.scope === options.scope);
  if (!configured) throw new Error(`Package is not configured in the requested scope: ${packageSource}`);

  // A local source is a live reference rather than a managed checkout, so
  // there is nothing to update after confirming it is still present.
  if (!isManagedPackageSource(packageSource)) {
    if (!configured.installedPath) throw new Error(`Package path does not exist: ${packageSource}`);
    return;
  }

  // install() refreshes the exact npm/git source in the requested storage
  // scope without changing settings. This avoids DefaultPackageManager's
  // identity-based update() touching a same-name package in the other scope.
  await manager.install(packageSource, { local: options.scope === "project" });
}

function assertPiProjectMutationTrusted(
  runtime: ResolvedPiRuntime,
  scope: PiPackageMutationOptions["scope"],
): void {
  if (scope === "project" && !hasExplicitPiProjectMutationTrust(runtime)) {
    throw new Error("Trust this Space before changing Space-scoped capabilities.");
  }
}

function isManagedPackageSource(source: string): boolean {
  return /^(?:npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/)/i.test(source);
}

function preferredModelFromSettings(settings: SettingsManager): PiPreferredModel | undefined {
  const provider = settings.getDefaultProvider()?.trim();
  const id = settings.getDefaultModel()?.trim();
  return provider && id ? { provider, id } : undefined;
}

function applyModelCatalogs(registry: ModelRegistry, catalogs: PiModelCatalog[]): void {
  for (const catalog of catalogs) {
    const provider = catalog.provider.trim();
    if (!provider || !catalog.config.models?.length) continue;
    const models = new Map(catalog.config.models.map((model) => [model.id, model]));
    // Keep Pi custom/static entries that are absent from the live response so
    // refreshing cannot silently remove a person's models.json additions.
    for (const model of registry.getAll()) {
      if (model.provider !== provider || models.has(model.id)) continue;
      models.set(model.id, {
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: [...model.input],
        cost: { ...model.cost },
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        ...(model.compat ? { compat: { ...model.compat } } : {}),
      });
    }
    registry.registerProvider(provider, { ...catalog.config, models: [...models.values()] });
  }
}

async function loadRuntimeProviders(
  spaceRoot: string,
  runtime: ResolvedPiRuntime,
): Promise<Array<{ type: "info" | "warning" | "error"; message: string }>> {
  runtime.modelRegistry.refresh();
  const services = await createAgentSessionServices({
    cwd: spaceRoot,
    agentDir: runtime.agentDir,
    authStorage: runtime.authStorage,
    settingsManager: runtime.settingsManager,
    modelRegistry: runtime.modelRegistry,
    resourceLoaderOptions: {
      additionalExtensionPaths: runtime.config.additionalExtensionPaths,
      additionalSkillPaths: runtime.config.additionalSkillPaths,
      additionalPromptTemplatePaths: runtime.config.additionalPromptTemplatePaths,
      additionalThemePaths: runtime.config.additionalThemePaths,
    },
  });
  return [
    ...services.diagnostics,
    ...services.resourceLoader.getExtensions().errors.map((item) => ({
      type: "error" as const,
      message: `${item.path}: ${item.error}`,
    })),
  ];
}

function createPackageManager(
  spaceRoot: string,
  runtime: ResolvedPiRuntime,
  onProgress?: (event: ProgressEvent) => void,
): DefaultPackageManager {
  const manager = new DefaultPackageManager({
    cwd: spaceRoot,
    agentDir: runtime.agentDir,
    settingsManager: runtime.settingsManager,
  });
  manager.setProgressCallback(onProgress);
  return manager;
}

async function resolveProjectTrust(
  spaceRoot: string,
  agentDir: string,
  settings: SettingsManager,
  policy: PiProjectTrustPolicy | undefined,
  allowRequest: boolean,
): Promise<ResolvedPiRuntime["projectTrust"]> {
  const required = hasTrustRequiringProjectResources(spaceRoot);
  const store = new ProjectTrustStore(agentDir);
  const savedDecision = store.get(spaceRoot);
  if (!required) return { required: false, trusted: true, savedDecision };
  if (typeof policy?.override === "boolean") {
    return { required: true, trusted: policy.override, savedDecision };
  }
  if (typeof savedDecision === "boolean") {
    return { required: true, trusted: savedDecision, savedDecision };
  }

  const defaultDecision = settings.getDefaultProjectTrust();
  if (defaultDecision === "always") return { required: true, trusted: true, savedDecision };
  if (defaultDecision === "never") return { required: true, trusted: false, savedDecision };
  if (!allowRequest || !policy?.request) return { required: true, trusted: false, savedDecision };

  const rawDecision = await policy.request({
    spaceRoot,
    hasProjectResources: true,
    savedDecision,
    defaultDecision,
  });
  const decision = typeof rawDecision === "boolean" ? { trusted: rawDecision } : rawDecision;
  if (decision.remember) store.set(spaceRoot, decision.trusted);
  return {
    required: true,
    trusted: decision.trusted,
    savedDecision: decision.remember ? decision.trusted : savedDecision,
  };
}

function cleanStringRecord(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values)
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter(([key, value]) => key && value));
}

function cleanProviderId(value: string): string {
  const provider = value.trim();
  if (!provider) throw new Error("Provider is required.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(provider) || ["__proto__", "prototype", "constructor"].includes(provider)) {
    throw new Error("Provider ID is invalid.");
  }
  return provider;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
