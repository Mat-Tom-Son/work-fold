import type { CredentialStore } from "@earendil-works/pi-ai";
import { type ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { AZURE_OPENAI_DEPLOYMENTS_ENV, AZURE_OPENAI_PROVIDER, normalizeAzureOpenAIConnection, type AzureOpenAIConnection } from "../../shared/azure-openai.js";

const applied = new WeakMap<ModelRuntime, string>();

export async function storedAzureOpenAIConnection(auth: CredentialStore): Promise<AzureOpenAIConnection | undefined> {
  const credential = await auth.read(AZURE_OPENAI_PROVIDER);
  const env = credential?.type === "api_key" ? credential.env : undefined;
  if (!env?.[AZURE_OPENAI_DEPLOYMENTS_ENV]) return undefined;
  return normalizeAzureOpenAIConnection({
    baseUrl: env.AZURE_OPENAI_BASE_URL,
    deployments: JSON.parse(env[AZURE_OPENAI_DEPLOYMENTS_ENV]),
  });
}

/** Register the person's deployments in every runtime, including after restart. */
export async function applyAzureOpenAIDeployments(auth: CredentialStore, registry: ModelRuntime): Promise<void> {
  const settings = await storedAzureOpenAIConnection(auth);
  const signature = JSON.stringify(settings);
  if (applied.get(registry) === signature) return;
  if (applied.has(registry)) {
    registry.unregisterProvider(AZURE_OPENAI_PROVIDER);
    applied.delete(registry);
  }
  if (!settings) return;
  const models = await Promise.all(settings.deployments.map(async (id) => {
    // Use Pi's existing CLI metadata/fallback policy. Deployment routing must be
    // exact even when the CLI's fuzzy matcher suggests a different catalog id.
    const resolved = await resolveCliModel({ cliProvider: AZURE_OPENAI_PROVIDER, cliModel: id, modelRuntime: registry });
    if (!resolved.model) throw new Error(resolved.error ?? "Azure OpenAI is unavailable in Pi.");
    return { ...resolved.model, id, name: id, baseUrl: settings.baseUrl };
  }));
  registry.registerProvider(AZURE_OPENAI_PROVIDER, {
    name: "Azure OpenAI Responses",
    api: "azure-openai-responses",
    apiKey: "$AZURE_OPENAI_API_KEY",
    baseUrl: settings.baseUrl,
    models,
  });
  applied.set(registry, signature);
}
