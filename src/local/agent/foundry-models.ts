import { envApiKeyAuth, type CredentialStore } from "@earendil-works/pi-ai";
import { azureProvider } from "@earendil-works/pi-ai/providers/azure";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { type ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { AZURE_OPENAI_DEPLOYMENTS_ENV, AZURE_OPENAI_PROVIDER, FOUNDRY_PROVIDERS, foundryProvider, normalizeFoundryConnection, type FoundryConnection } from "../../shared/foundry.js";

const applied = new WeakMap<ModelRuntime, { signature: string; registered: string[] }>();

export async function storedFoundryConnection(auth: CredentialStore, providerId = AZURE_OPENAI_PROVIDER): Promise<FoundryConnection | undefined> {
  const spec = foundryProvider(providerId)!;
  const credential = await auth.read(providerId);
  const env = credential?.type === "api_key" ? credential.env : undefined;
  if (!env?.[AZURE_OPENAI_DEPLOYMENTS_ENV]) return undefined;
  return normalizeFoundryConnection({
    baseUrl: env[spec.baseUrlEnv],
    deployments: JSON.parse(env[AZURE_OPENAI_DEPLOYMENTS_ENV]),
    ...(env.WORKFOLD_FOUNDRY_MODEL_IDS ? { modelIds: JSON.parse(env.WORKFOLD_FOUNDRY_MODEL_IDS) } : {}),
  }, providerId);
}

export function foundryBaseModels(providerId: string) {
  return foundryProvider(providerId)?.catalogProvider === "anthropic" ? anthropicProvider().getModels() : azureProvider().getModels();
}

/** Resolve capabilities with Pi, while keeping the exact deployment and chosen wire format. */
export async function foundryDeploymentModels(settings: FoundryConnection, providerId: string, registry: ModelRuntime, options: { skipUnavailableBaseModels?: boolean } = {}) {
  const spec = foundryProvider(providerId)!;
  const models = await Promise.all(settings.deployments.map(async (id) => {
    const baseId = settings.modelIds && Object.hasOwn(settings.modelIds, id) ? settings.modelIds[id] : undefined;
    const native = foundryBaseModels(providerId).find((model) => model.id === (baseId ?? id));
    const explicit = baseId ? registry.getModel(spec.catalogProvider, baseId) ?? native : undefined;
    if (baseId && !explicit) {
      // A catalog update must not strand the person outside Settings or prevent
      // removal. Leave this deployment unavailable until its metadata is fixed.
      if (options.skipUnavailableBaseModels) return undefined;
      throw new Error(`The base model ${baseId} is not in Pi's ${spec.catalogProvider} catalog.`);
    }
    if (!baseId && !native && providerId !== AZURE_OPENAI_PROVIDER) {
      // Pi's provider registration requires capability metadata. Keep unknown
      // aliases conservative until a base model is chosen, rather than copying
      // an unrelated GPT's reasoning, image support, output limit, or pricing.
      return { id, name: id, provider: providerId, api: spec.api, baseUrl: settings.baseUrl, reasoning: false,
        input: (spec.api === "anthropic-messages" ? ["text", "image"] : ["text"]) as ("text" | "image")[],
        contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    }
    const resolved = explicit ?? native ?? (await resolveCliModel({ cliProvider: spec.catalogProvider, cliModel: id, modelRuntime: registry })).model;
    if (!resolved) throw new Error(`${spec.name} is unavailable in Pi.`);
    // The original Azure provider already used Pi's per-model API choice.
    // Preserve existing Chat Completions deployments when upgrading or editing.
    const api = providerId === AZURE_OPENAI_PROVIDER && resolved.api === "openai-completions" ? resolved.api : spec.api;
    // Endpoint and auth belong to this connection, never to the source model.
    const { headers: _headers, compat, ...metadata } = resolved;
    // Foundry does not support Anthropic's server-side fallback parameter/beta.
    // Retain other native capabilities while disabling that source-only feature.
    const connectionCompat = api === "anthropic-messages" && compat ? { ...compat, allowedFallbackModels: [] } : compat;
    return { ...metadata, ...(resolved.api === api ? { compat: connectionCompat } : {}),
      ...(api === "anthropic-messages" && /^claude-sonnet-4-5(?:-|$)/.test(resolved.id) ? { contextWindow: Math.min(resolved.contextWindow, 200000) } : {}),
      provider: providerId, api, id, name: id, baseUrl: settings.baseUrl };
  }));
  return models.filter((model) => model !== undefined);
}

/** Register the person's deployments in every runtime, including after restart. */
export async function applyFoundryDeployments(auth: CredentialStore, registry: ModelRuntime): Promise<void> {
  const settings = await Promise.all(FOUNDRY_PROVIDERS.map(async (spec) => {
    try { return await storedFoundryConnection(auth, spec.id); }
    catch { return null; } // Isolate malformed saved data; Settings owns correction/removal.
  }));
  const signature = JSON.stringify(settings);
  const previous = applied.get(registry);
  if (previous?.signature === signature) return;
  if (previous) {
    for (const id of previous.registered) registry.unregisterProvider(id);
    applied.delete(registry);
  }
  const models = await Promise.all(settings.map((value, i) => value ? foundryDeploymentModels(value, FOUNDRY_PROVIDERS[i]!.id, registry, { skipUnavailableBaseModels: true }) : []));
  const registered: string[] = [];
  for (const [i, spec] of FOUNDRY_PROVIDERS.entries()) {
    const value = settings[i];
    // Keep Azure's native catalog/environment setup when no app connection is saved.
    if (value === undefined && spec.id === AZURE_OPENAI_PROVIDER) {
      registry.registerProvider(spec.id, { name: spec.name });
      registered.push(spec.id);
      continue;
    }
    if (value === undefined) {
      // Advertise setup without replacing the person's current or future Pi
      // models.json definitions, endpoint, or native provider implementation.
      if (!registry.getProvider(spec.id)) {
        registry.registerProvider(spec.id, { name: spec.name, api: spec.api, apiKey: `$${spec.keyEnv}` });
        registered.push(spec.id);
      }
      continue;
    }
    const native = spec.catalogProvider === "anthropic" ? anthropicProvider() : azureProvider();
    const deployments = models[i]!;
    const keyAuth = envApiKeyAuth(`${spec.name} API key`, [spec.keyEnv]);
    // A native base lets Pi compose models.json above these app declarations.
    // The legacy extension models list would replace that user-owned layer.
    registry.registerNativeProvider({
      ...native, id: spec.id, name: spec.name, baseUrl: value?.baseUrl,
      auth: { apiKey: {
        ...keyAuth,
        async resolve(input) {
          if (value === null) return undefined; // No endpoint is authoritative until malformed settings are repaired.
          const resolved = await keyAuth.resolve(input);
          if (!resolved) return undefined;
          // Pi applies ModelAuth.baseUrl at request time, after models.json.
          // Bind the stored key to the endpoint shown in Settings, including
          // additional model definitions that share this provider connection.
          return { ...resolved, auth: { ...resolved.auth, ...(value ? { baseUrl: value.baseUrl } : {}) } };
        },
      } },
      getModels: () => deployments,
      getAllModels: () => deployments,
    });
    registered.push(spec.id);
  }
  applied.set(registry, { signature, registered });
}
