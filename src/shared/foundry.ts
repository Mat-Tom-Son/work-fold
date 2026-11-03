export const AZURE_OPENAI_PROVIDER = "azure";
export const AZURE_OPENAI_DEPLOYMENTS_ENV = "WORKFOLD_AZURE_OPENAI_DEPLOYMENTS";

/** Separate Pi providers let all three formats coexist, including different resources/keys. */
export const FOUNDRY_PROVIDERS = [
  { id: AZURE_OPENAI_PROVIDER, name: "Microsoft Foundry / Azure (OpenAI)", api: "azure-openai-responses", catalogProvider: "azure", path: "/openai/v1", keyEnv: "AZURE_OPENAI_API_KEY", baseUrlEnv: "AZURE_OPENAI_BASE_URL" },
  { id: "azure-chat-completions", name: "Microsoft Foundry (Chat Completions)", api: "openai-completions", catalogProvider: "azure", path: "/openai/v1", keyEnv: "AZURE_OPENAI_API_KEY", baseUrlEnv: "AZURE_OPENAI_BASE_URL" },
  { id: "azure-anthropic", name: "Microsoft Foundry (Anthropic)", api: "anthropic-messages", catalogProvider: "anthropic", path: "/anthropic", keyEnv: "ANTHROPIC_FOUNDRY_API_KEY", baseUrlEnv: "ANTHROPIC_FOUNDRY_BASE_URL" },
] as const;

export function foundryProvider(id: string) { return FOUNDRY_PROVIDERS.find((item) => item.id === id); }

export interface FoundryConnection {
  baseUrl: string;
  deployments: string[];
  /** Optional native Pi model ids for deployments whose names hide their capabilities. */
  modelIds?: Record<string, string>;
}

export function parseAzureDeploymentNames(value: string): string[] {
  return [...new Set(value.split(/[,\n\r]+/).map((name) => name.trim()).filter(Boolean))];
}

export function normalizeFoundryConnection(value: unknown, providerId = AZURE_OPENAI_PROVIDER): FoundryConnection {
  const provider = foundryProvider(providerId);
  if (!provider) throw new Error("Choose a Microsoft Foundry connection type.");
  if (!value || typeof value !== "object") throw new Error("Azure connection settings are required.");
  const { baseUrl, deployments, modelIds } = value as Record<string, unknown>;
  if (typeof baseUrl !== "string" || !baseUrl.trim() || baseUrl.length > 2048) {
    throw new Error("Enter an Azure resource endpoint URL.");
  }
  let url: URL;
  try { url = new URL(baseUrl.trim()); } catch { throw new Error("Enter a valid Azure resource endpoint URL, starting with https://."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some((key) => key !== "api-version")) {
    throw new Error("Use an HTTPS Azure endpoint without credentials or extra query parameters.");
  }
  if (provider.api === "anthropic-messages" && (url.hostname.endsWith(".openai.azure.com") || url.hostname.endsWith(".cognitiveservices.azure.com"))) {
    throw new Error("For Claude, use the Foundry endpoint https://your-resource.services.ai.azure.com/anthropic.");
  }
  const paths = provider.api === "anthropic-messages"
    ? ["", "/anthropic", "/anthropic/v1", "/anthropic/v1/messages"]
    : ["", "/openai", "/openai/responses", "/openai/v1", "/openai/v1/responses", "/openai/v1/chat/completions"];
  if (!paths.includes(url.pathname.replace(/\/+$/, ""))) {
    throw new Error(provider.api === "anthropic-messages"
      ? "Paste the Foundry resource endpoint or Anthropic Messages URL."
      : "Paste the Azure resource endpoint or OpenAI Responses or Chat Completions URL, without a deployment path.");
  }
  // Pi's Azure Responses transport uses the v1 base, including for portal URLs.
  url.pathname = provider.path;
  url.search = "";
  if (!Array.isArray(deployments) || !deployments.length || deployments.length > 100) {
    throw new Error("Enter between 1 and 100 Azure deployment names.");
  }
  const names: string[] = [];
  for (const name of deployments) {
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(name.trim())) {
      throw new Error("Use deployment names with letters, numbers, periods, hyphens or underscores. Separate names with commas or new lines.");
    }
    if (!names.includes(name.trim())) names.push(name.trim());
  }
  const models: Record<string, string> = {};
  if (modelIds !== undefined) {
    if (!modelIds || typeof modelIds !== "object" || Array.isArray(modelIds)) throw new Error("Base models must name a model for each deployment.");
    for (const [name, id] of Object.entries(modelIds)) {
      if (!names.includes(name) || typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(id)) throw new Error("Choose a valid base model for an entered deployment.");
      Object.defineProperty(models, name, { value: id, enumerable: true });
    }
  }
  return { baseUrl: url.toString(), deployments: names, ...(Object.keys(models).length ? { modelIds: models } : {}) };
}
