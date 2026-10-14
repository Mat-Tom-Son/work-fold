import { AZURE_OPENAI_DEPLOYMENTS_ENV, AZURE_OPENAI_PROVIDER, normalizeAzureOpenAIConnection, type AzureOpenAIConnection } from "../../shared/azure-openai.js";
import { applyAzureOpenAIDeployments, storedAzureOpenAIConnection } from "./azure-openai-models.js";
import { resolvePiRuntime, type PiRuntimeProvider } from "./pi-runtime-config.js";

/** Only these non-secret fields may leave Pi's credential store. */
export async function getAzureOpenAIConnection(workFolderRoot: string, provider?: PiRuntimeProvider): Promise<AzureOpenAIConnection> {
  const runtime = await resolvePiRuntime(workFolderRoot, provider, { requestProjectTrust: false });
  const saved = await storedAzureOpenAIConnection(runtime.credentials);
  if (saved) return saved;
  const credential = await runtime.credentials.read(AZURE_OPENAI_PROVIDER);
  const env = credential?.type === "api_key" ? credential.env : undefined;
  const resource = env?.AZURE_OPENAI_RESOURCE_NAME || process.env.AZURE_OPENAI_RESOURCE_NAME;
  const endpoint = env?.AZURE_OPENAI_BASE_URL || process.env.AZURE_OPENAI_BASE_URL
    || (resource ? `https://${resource}.openai.azure.com` : "");
  let baseUrl = "";
  try {
    const url = new URL(endpoint);
    // Never project credentials embedded in manually configured URLs.
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    baseUrl = url.toString();
  } catch { /* An unconfigured endpoint is an empty field. */ }
  return {
    baseUrl,
    deployments: [],
  };
}

export async function saveAzureOpenAIConnection(
  workFolderRoot: string,
  value: unknown,
  apiKey: string | undefined,
  provider?: PiRuntimeProvider,
): Promise<void> {
  const settings = normalizeAzureOpenAIConnection(value);
  const runtime = await resolvePiRuntime(workFolderRoot, provider, { requestProjectTrust: false });
  const existing = await runtime.credentials.read(AZURE_OPENAI_PROVIDER);
  const key = apiKey?.trim() || (existing?.type === "api_key" ? existing.key : undefined)
    || (process.env.AZURE_OPENAI_API_KEY ? "$AZURE_OPENAI_API_KEY" : undefined);
  if (!key) throw new Error("Enter an Azure OpenAI API key to save this connection.");
  await runtime.credentials.modify(AZURE_OPENAI_PROVIDER, async () => ({
    type: "api_key",
    key,
    env: {
      ...(existing?.type === "api_key" ? existing.env : {}),
      AZURE_OPENAI_BASE_URL: settings.baseUrl,
      AZURE_OPENAI_API_VERSION: "v1",
      [AZURE_OPENAI_DEPLOYMENTS_ENV]: JSON.stringify(settings.deployments),
      // Explicit identity mappings prevent ambient aliases from rerouting these names.
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: settings.deployments.map((name) => `${name}=${name}`).join(","),
    },
  }));
  await runtime.flushCredentials();
  await applyAzureOpenAIDeployments(runtime.credentials, runtime.modelRuntime);
}
