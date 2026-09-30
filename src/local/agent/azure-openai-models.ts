import { type AuthStorage, type ModelRegistry, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { AZURE_OPENAI_DEPLOYMENTS_ENV, AZURE_OPENAI_PROVIDER, normalizeAzureOpenAIConnection, type AzureOpenAIConnection } from "../../shared/azure-openai.js";

const applied = new WeakMap<ModelRegistry, string>();

export function storedAzureOpenAIConnection(auth: AuthStorage): AzureOpenAIConnection | undefined {
  const env = auth.getProviderEnv(AZURE_OPENAI_PROVIDER);
  if (!env?.[AZURE_OPENAI_DEPLOYMENTS_ENV]) return undefined;
  return normalizeAzureOpenAIConnection({
    baseUrl: env.AZURE_OPENAI_BASE_URL,
    deployments: JSON.parse(env[AZURE_OPENAI_DEPLOYMENTS_ENV]),
  });
}

/** Register the person's deployments in every runtime, including after restart. */
export function applyAzureOpenAIDeployments(auth: AuthStorage, registry: ModelRegistry): void {
  const settings = storedAzureOpenAIConnection(auth);
  const signature = JSON.stringify(settings);
  if (applied.get(registry) === signature) return;
  if (applied.has(registry)) {
    registry.unregisterProvider(AZURE_OPENAI_PROVIDER);
    applied.delete(registry);
  }
  if (!settings) return;
  const models = settings.deployments.map((id) => {
    // Use Pi's existing CLI metadata/fallback policy. Deployment routing must be
    // exact even when the CLI's fuzzy matcher suggests a different catalog id.
    const resolved = resolveCliModel({ cliProvider: AZURE_OPENAI_PROVIDER, cliModel: id, modelRegistry: registry });
    if (!resolved.model) throw new Error(resolved.error ?? "Azure OpenAI is unavailable in Pi.");
    return { ...resolved.model, id, name: id, baseUrl: settings.baseUrl };
  });
  registry.registerProvider(AZURE_OPENAI_PROVIDER, {
    name: "Azure OpenAI Responses",
    api: "azure-openai-responses",
    apiKey: "$AZURE_OPENAI_API_KEY",
    baseUrl: settings.baseUrl,
    models,
  });
  applied.set(registry, signature);
}
