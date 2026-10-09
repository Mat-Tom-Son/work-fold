import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  DefaultPackageManager,
  ModelRuntime,
  type McpOAuthCredentialStore,
  ProjectTrustStore,
  SettingsManager,
  VERSION as PI_SDK_VERSION,
  createAgentSessionServices,
  hasTrustRequiringProjectResources,
  type ProviderConfig,
  type ProgressEvent,
} from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai/compat";

import type { CredentialStore, AuthInteraction, AuthType } from "@earendil-works/pi-ai";
import { createPersistentPiAuthStorage } from "./auth-storage.js";

type AuthStatus = ReturnType<ModelRuntime["getProviderAuthStatus"]>;

import { applyAzureOpenAIDeployments } from "./azure-openai-models.js";
import { defaultAgentSdkDir, spaceSessionDir } from "./agent-data-dir.js";
import type { PiExtensionUiBridge } from "./extension-ui.js";
import type { ModelContextInspector } from "./model-context-inspector.js";
import { includedResourceOptions, type IncludedToolsConfiguration } from "./included-tools.js";

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
 * Cwd-specific runtime inputs. Hosts may inject secure credentials and shared
 * model/settings services; otherwise Pi's native persistent files are used.
 */
export interface PiRuntimeConfig {
  includedTools?: IncludedToolsConfiguration;
  agentDir?: string;
  sessionDir?: string;
  credentials?: CredentialStore;
  mcpCredentialBackend?: NonNullable<ConstructorParameters<typeof McpOAuthCredentialStore>[0]>;
  flushCredentials?: () => Promise<void>;
  settingsManager?: SettingsManager;
  modelRuntime?: ModelRuntime;
  /** Host-fetched catalogs applied to each fresh cwd-specific registry. */
  modelCatalogs?: PiModelCatalog[];
  preferredModel?: PiPreferredModel;
  /** Machine-local instructions appended to this Space's Pi system prompt. */
  assistantInstructions?: string;
  projectTrust?: PiProjectTrustPolicy;
  extensionUi?: PiExtensionUiBridge;
  /** Optional local diagnostic recorder; never a source of model context. */
  modelContextInspector?: ModelContextInspector;
  additionalExtensionPaths?: string[];
  additionalSkillPaths?: string[];
  additionalPromptTemplatePaths?: string[];
  additionalThemePaths?: string[];
  metadata?: PiRuntimeMetadata;
}

export interface PiRuntimeProvider {
  resolveRuntime(spaceRoot: string): Promise<PiRuntimeConfig>;
  setPreferredModel?(spaceRoot: string, model: PiPreferredModel): Promise<void>;
  getAssistantInstructions?(spaceRoot: string): Promise<string>;
  setAssistantInstructions?(spaceRoot: string, instructions: string): Promise<void>;
  refreshModelCatalog?(providerId: string): Promise<PiModelCatalogRefreshResult>;
  listModelCatalogs?(): Promise<PiModelCatalogStatus[]>;
}

export async function getPiAssistantInstructions(
  spaceRoot: string,
  provider?: PiRuntimeProvider,
): Promise<string> {
  if (provider?.getAssistantInstructions) return provider.getAssistantInstructions(spaceRoot);
  return (await provider?.resolveRuntime(spaceRoot))?.assistantInstructions ?? "";
}

export async function setPiAssistantInstructions(
  spaceRoot: string,
  instructions: string,
  provider?: PiRuntimeProvider,
): Promise<void> {
  if (!provider?.setAssistantInstructions) {
    throw new Error("This Assistant runtime does not support Space instructions.");
  }
  await provider.setAssistantInstructions(spaceRoot, instructions);
}

export function appendAssistantInstructions(base: string[], instructions: string | undefined): string[] {
  const value = instructions?.trim();
  return value ? [...base, `## Space instructions\n\n${value}`] : base;
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
  credentials: CredentialStore;
  settingsManager: SettingsManager;
  modelRuntime: ModelRuntime;
  preferredModel?: PiPreferredModel;
  projectTrust: {
    required: boolean;
    trusted: boolean;
    savedDecision: boolean | null;
  };
  flushCredentials(): Promise<void>;
}

export interface PiProviderSetupStatus {
  id: string;
  name: string;
  configured: boolean;
  authSource?: AuthStatus["source"];
  authLabel?: string;
  authType?: AuthType;
  apiKey: boolean;
  apiKeyLabel?: string;
  oauth: boolean;
  oauthLabel?: string;
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

export interface PiComposerState {
  model?: { provider: string; id: string; name: string };
  thinkingLevel: string;
  thinkingLevels: string[];
}

export interface PiOAuthHooks {
  openUrl(info: { url: string; instructions?: string }): Promise<void> | void;
  showDeviceCode(info: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }): Promise<void> | void;
  prompt(input: { message: string; placeholder?: string; allowEmpty?: boolean; secret?: boolean; signal?: AbortSignal }): Promise<string>;
  select(input: {
    message: string;
    options: Array<{ id: string; label: string; description?: string }>;
    signal?: AbortSignal;
  }): Promise<string | undefined>;
  progress?(message: string): void;
  info?(input: { message: string; links?: readonly { url: string; label?: string }[] }): Promise<void> | void;
  manualCodeInput?(signal?: AbortSignal, input?: { message: string; placeholder?: string }): Promise<string>;
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

  const credentials = config.credentials ?? (await createPersistentPiAuthStorage({ agentDir })).credentials;
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
  applyPiRuntimeDefaults(initialSettings);

  const modelRuntime = config.modelRuntime
    ?? await ModelRuntime.create({ credentials, authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  applyModelCatalogs(modelRuntime, config.modelCatalogs ?? []);
  await applyAzureOpenAIDeployments(credentials, modelRuntime);
  const settingsPreferred = preferredModelFromSettings(initialSettings);
  const metadataPreferred = config.metadata?.provider && config.metadata.model
    ? { provider: config.metadata.provider, id: config.metadata.model }
    : undefined;

  return {
    config,
    agentDir,
    sessionDir: config.sessionDir ?? spaceSessionDir(spaceRoot, agentDir),
    credentials,
    settingsManager: initialSettings,
    modelRuntime,
    preferredModel: config.preferredModel ?? settingsPreferred ?? metadataPreferred,
    projectTrust: trust,
    flushCredentials: config.flushCredentials ?? (async () => undefined),
  };
}

/** Apply after resource loading too: Pi reloads SettingsManager while resolving resources. */
const constrainedWarmingSettings = new WeakSet<SettingsManager>();
export function applyPiRuntimeDefaults(settings: SettingsManager): void {
  if (!constrainedWarmingSettings.has(settings)) {
    const nativeMode = settings.getCacheWarmingMode.bind(settings);
    // Pi intentionally reads this preference from global settings, bypassing
    // applyOverrides. Keep the preference intact while bounding host execution.
    settings.getCacheWarmingMode = () => nativeMode() === "idle" ? "streaming" : nativeMode();
    constrainedWarmingSettings.add(settings);
  }
  if (settings.getDefaultTools() === undefined) settings.applyOverrides({ defaultTools: ["+codemode", "+tool_search"] });
}

export async function getPiSetupStatus(
  spaceRoot: string,
  provider?: PiRuntimeProvider,
): Promise<PiSetupStatus> {
  const runtime = await resolvePiRuntime(spaceRoot, provider, { requestProjectTrust: false });
  const providerDiagnostics = await loadRuntimeProviders(spaceRoot, runtime);
  const models = runtime.modelRuntime.getAllModels();
  const stored = new Map((await runtime.credentials.list()).map((item) => [item.providerId, item]));
  const providerIds = new Set(runtime.modelRuntime.getProviders().map((item) => item.id));
  const providers = [...providerIds].map((id) => {
    const providerModels = models.filter((model) => model.provider === id);
    const auth = runtime.modelRuntime.getProviderAuthStatus(id);
    const provider = runtime.modelRuntime.getProvider(id)!;
    return {
      id,
      name: runtime.modelRuntime.getProvider(id)?.name ?? id,
      configured: auth.configured,
      ...(auth.source ? { authSource: auth.source } : {}),
      ...(auth.label ? { authLabel: auth.label } : {}),
      ...(stored.get(id) ? { authType: stored.get(id)!.type } : {}),
      apiKey: Boolean(provider.auth?.apiKey?.login),
      ...(provider.auth?.apiKey ? { apiKeyLabel: provider.auth.apiKey.name } : {}),
      oauth: Boolean(provider.auth?.oauth),
      ...(provider.auth?.oauth ? { oauthLabel: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name } : {}),
      modelCount: providerModels.length,
    } satisfies PiProviderSetupStatus;
  }).sort((left, right) => left.name.localeCompare(right.name));

  const errors = [
    runtime.modelRuntime.getError(),
    ...providerDiagnostics.filter((item) => item.type === "error").map((item) => item.message),
  ]
    .filter((value): value is string => Boolean(value));
  const preferredModelAvailable = runtime.preferredModel
    ? Boolean(runtime.modelRuntime.getModel(runtime.preferredModel.provider, runtime.preferredModel.id))
    : false;

  const configured = (await runtime.modelRuntime.getAvailable()).length > 0;
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
  const oauthProviders = new Set(runtime.modelRuntime.getProviders().filter((item) => item.auth?.oauth).map((item) => item.id));
  const stored = new Map((await runtime.credentials.list()).map((item) => [item.providerId, item]));
  return runtime.modelRuntime.getModels().map((model) => {
    const auth = runtime.modelRuntime.getProviderAuthStatus(model.provider);
    const storedCredential = stored.get(model.provider);
    const configured = runtime.modelRuntime.hasConfiguredAuth(model.provider);
    return {
      provider: model.provider,
      providerName: runtime.modelRuntime.getProvider(model.provider)?.name ?? model.provider,
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

/**
 * Projects the model and reasoning state a brand-new Chat will start with.
 * This intentionally uses Pi's own capability/clamping helpers so the
 * composer can be truthful before a conversation session has been created.
 */
export async function getPiComposerState(
  spaceRoot: string,
  provider?: PiRuntimeProvider,
): Promise<PiComposerState> {
  const runtime = await resolvePiRuntime(spaceRoot, provider, { requestProjectTrust: false });
  await loadRuntimeProviders(spaceRoot, runtime);
  const preferred = runtime.preferredModel
    ? runtime.modelRuntime.getModel(runtime.preferredModel.provider, runtime.preferredModel.id)
    : undefined;
  const model = preferred && runtime.modelRuntime.hasConfiguredAuth(preferred.provider)
    ? preferred
    : (await runtime.modelRuntime.getAvailable())[0];
  if (!model) return { thinkingLevel: "off", thinkingLevels: [] };
  const thinkingLevels = [...getSupportedThinkingLevels(model)];
  const requested = runtime.settingsManager.getDefaultThinkingLevel() ?? "medium";
  return {
    model: { provider: model.provider, id: model.id, name: model.name },
    thinkingLevel: clampThinkingLevel(model, requested),
    thinkingLevels,
  };
}

/**
 * Saves the level Pi will apply to the next Chat session. Once a Chat exists,
 * its conversation endpoint remains authoritative and persists the choice in
 * that session as usual.
 */
export async function setPiDefaultThinkingLevel(
  spaceRoot: string,
  level: string,
  provider?: PiRuntimeProvider,
): Promise<PiComposerState> {
  const runtime = await resolvePiRuntime(spaceRoot, provider, { requestProjectTrust: false });
  await loadRuntimeProviders(spaceRoot, runtime);
  const preferred = runtime.preferredModel
    ? runtime.modelRuntime.getModel(runtime.preferredModel.provider, runtime.preferredModel.id)
    : undefined;
  const model = preferred && runtime.modelRuntime.hasConfiguredAuth(preferred.provider)
    ? preferred
    : (await runtime.modelRuntime.getAvailable())[0];
  if (!model) throw new Error("Choose a model before setting a thinking level.");
  const available = [...getSupportedThinkingLevels(model)];
  const requested = level.trim().toLowerCase();
  if (!available.includes(requested as ModelThinkingLevel)) {
    throw new Error(`Thinking level must be one of: ${available.join(", ")}.`);
  }
  runtime.settingsManager.setDefaultThinkingLevel(requested as ModelThinkingLevel);
  return {
    model: { provider: model.provider, id: model.id, name: model.name },
    thinkingLevel: requested,
    thinkingLevels: available,
  };
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
  await loadRuntimeProviders(spaceRoot, runtime);
  if (!runtime.modelRuntime.getProvider(id)?.auth?.apiKey?.login) throw new Error(`Provider ${id} does not offer API-key setup.`);
  await runtime.credentials.modify(id, async (current) => ({
    type: "api_key",
    key,
    ...(options.env !== undefined ? { env: cleanStringRecord(options.env) }
      : current?.type === "api_key" && current.env ? { env: current.env } : {}),
  }));
  await runtime.flushCredentials();
  await runtime.modelRuntime.refresh({ allowNetwork: true, providers: [id], signal: AbortSignal.timeout(15_000) });
}

export async function removePiProviderAuth(
  spaceRoot: string,
  providerId: string,
  runtimeProvider?: PiRuntimeProvider,
): Promise<void> {
  const id = cleanProviderId(providerId);
  const runtime = await resolvePiRuntime(spaceRoot, runtimeProvider, { requestProjectTrust: false });
  await runtime.modelRuntime.logout(id);
  await runtime.flushCredentials();
  await runtime.modelRuntime.refresh({ allowNetwork: false, providers: [id] });
}

export async function loginPiOAuth(
  spaceRoot: string,
  providerId: string,
  hooks: PiOAuthHooks,
  runtimeProvider?: PiRuntimeProvider,
): Promise<void> {
  return loginPiProvider(spaceRoot, providerId, "oauth", hooks, runtimeProvider);
}

/** Pi owns the prompts and the complete credential, including provider-scoped configuration. */
export async function loginPiProvider(
  spaceRoot: string,
  providerId: string,
  method: AuthType,
  hooks: PiOAuthHooks,
  runtimeProvider?: PiRuntimeProvider,
): Promise<void> {
  const id = cleanProviderId(providerId);
  const runtime = await resolvePiRuntime(spaceRoot, runtimeProvider, { requestProjectTrust: false });
  await loadRuntimeProviders(spaceRoot, runtime);
  const auth = runtime.modelRuntime.getProvider(id)?.auth;
  if (method === "oauth" ? !auth?.oauth : !auth?.apiKey?.login) throw new Error(`Provider ${id} does not offer ${method} login.`);
  try {
    await runtime.modelRuntime.login(id, method, piAuthInteraction(hooks), {
      agentName: "work-fold",
      getDeviceId: () => runtime.settingsManager.getOrCreateDeviceId(),
    });
  } finally {
    // Pi creates the installation identity lazily. Keep it across failed logins too.
    await runtime.settingsManager.flush();
  }
  await runtime.flushCredentials();
  await runtime.modelRuntime.refresh({ allowNetwork: true, providers: [id], signal: AbortSignal.timeout(15_000) });
}

export async function setPiDefaultModel(
  spaceRoot: string,
  model: PiPreferredModel,
  runtimeProvider?: PiRuntimeProvider,
): Promise<void> {
  const runtime = await resolvePiRuntime(spaceRoot, runtimeProvider, { requestProjectTrust: false });
  await loadRuntimeProviders(spaceRoot, runtime);
  const selected = runtime.modelRuntime.getModel(model.provider.trim(), model.id.trim());
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

function applyModelCatalogs(registry: ModelRuntime, catalogs: PiModelCatalog[]): void {
  for (const catalog of catalogs) {
    const provider = catalog.provider.trim();
    if (!provider || !catalog.config.models?.length) continue;
    const models = new Map(catalog.config.models.map((model) => [model.id, model]));
    // Keep Pi custom/static entries that are absent from the live response so
    // refreshing cannot silently remove a person's models.json additions.
    for (const model of registry.getModels()) {
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
  await runtime.modelRuntime.refresh({ allowNetwork: false });
  const services = await createAgentSessionServices({
    cwd: spaceRoot,
    agentDir: runtime.agentDir,
    settingsManager: runtime.settingsManager,
    modelRuntime: runtime.modelRuntime,
    resourceLoaderOptions: {
      additionalExtensionPaths: runtime.config.additionalExtensionPaths,
      additionalSkillPaths: runtime.config.additionalSkillPaths,
      additionalPromptTemplatePaths: runtime.config.additionalPromptTemplatePaths,
      additionalThemePaths: runtime.config.additionalThemePaths,
      appendSystemPromptOverride: (base) => appendAssistantInstructions(base, runtime.config.assistantInstructions),
      ...await includedResourceOptions(spaceRoot, runtime, "catalog"),
    },
  });
  applyPiRuntimeDefaults(runtime.settingsManager);
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

/** Translate native Pi auth interactions onto the trusted setup bridge. */
export function piAuthInteraction(hooks: PiOAuthHooks): AuthInteraction {
  const notifications = new AbortController();
  const signal = hooks.signal ? AbortSignal.any([hooks.signal, notifications.signal]) : notifications.signal;
  const notify = (operation: () => void | Promise<void>) => {
    try { void Promise.resolve(operation()).catch(() => notifications.abort(new Error("Provider sign-in could not open its setup surface."))); }
    catch { notifications.abort(new Error("Provider sign-in could not open its setup surface.")); }
  };
  return {
    signal,
    async prompt(prompt) {
      const owned = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
      owned.throwIfAborted();
      const operation = prompt.type === "select"
        ? hooks.select({ message: prompt.message, options: prompt.options.map(({ id, label, description }) => ({ id, label, description })), signal: owned })
        : prompt.type === "manual_code" && hooks.manualCodeInput
          ? hooks.manualCodeInput(owned, prompt)
          : hooks.prompt({ message: prompt.message, placeholder: prompt.placeholder, allowEmpty: prompt.type === "text", secret: prompt.type === "secret", signal: owned });
      const value = await new Promise<string | undefined>((resolve, reject) => {
        const abort = () => reject(owned.reason);
        owned.addEventListener("abort", abort, { once: true });
        Promise.resolve(operation).then(resolve, reject).finally(() => owned.removeEventListener("abort", abort));
        if (owned.aborted) abort();
      });
      owned.throwIfAborted();
      if (value === undefined) throw new Error("Provider login cancelled.");
      return value;
    },
    notify(event) {
      if (event.type === "auth_url") notify(() => hooks.openUrl({ url: event.url, instructions: event.instructions }));
      else if (event.type === "device_code") { notify(() => hooks.showDeviceCode(event)); notify(() => hooks.openUrl({ url: event.verificationUri })); }
      else if (event.type === "info" && hooks.info) notify(() => hooks.info!(event));
      else if (event.type === "progress" || event.type === "info") hooks.progress?.(event.message);
    },
  };
}
