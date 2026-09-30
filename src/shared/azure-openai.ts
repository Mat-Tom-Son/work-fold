export const AZURE_OPENAI_PROVIDER = "azure-openai-responses";
export const AZURE_OPENAI_DEPLOYMENTS_ENV = "WORKFOLD_AZURE_OPENAI_DEPLOYMENTS";

export interface AzureOpenAIConnection {
  baseUrl: string;
  deployments: string[];
}

export function parseAzureDeploymentNames(value: string): string[] {
  return [...new Set(value.split(/[,\n\r]+/).map((name) => name.trim()).filter(Boolean))];
}

export function normalizeAzureOpenAIConnection(value: unknown): AzureOpenAIConnection {
  if (!value || typeof value !== "object") throw new Error("Azure connection settings are required.");
  const { baseUrl, deployments } = value as Record<string, unknown>;
  if (typeof baseUrl !== "string" || !baseUrl.trim() || baseUrl.length > 2048) {
    throw new Error("Enter an Azure resource endpoint URL.");
  }
  let url: URL;
  try { url = new URL(baseUrl.trim()); } catch { throw new Error("Enter a valid Azure resource endpoint URL, starting with https://."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some((key) => key !== "api-version")) {
    throw new Error("Use an HTTPS Azure endpoint without credentials or extra query parameters.");
  }
  if (!["", "/openai", "/openai/responses", "/openai/v1", "/openai/v1/responses"].includes(url.pathname.replace(/\/+$/, ""))) {
    throw new Error("Paste the Azure resource endpoint or Responses URL, without a deployment path.");
  }
  // Pi's Azure Responses transport uses the v1 base, including for portal URLs.
  url.pathname = "/openai/v1";
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
  return { baseUrl: url.toString(), deployments: names };
}
