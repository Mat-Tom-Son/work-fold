import { AZURE_OPENAI_DEPLOYMENTS_ENV, AZURE_OPENAI_PROVIDER, FOUNDRY_PROVIDERS, foundryProvider, normalizeFoundryConnection, type FoundryConnection } from "../../shared/foundry.js";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { applyFoundryDeployments, foundryBaseModels, foundryDeploymentModels, storedFoundryConnection } from "./foundry-models.js";
import { resolvePiRuntime, type PiRuntimeProvider } from "./pi-runtime-config.js";

/** Only these non-secret fields may leave Pi's credential store. */
export async function getFoundryConnection(workFolderRoot: string, provider?: PiRuntimeProvider, providerId = AZURE_OPENAI_PROVIDER): Promise<FoundryConnection> {
  const runtime = await resolvePiRuntime(workFolderRoot, provider, { requestProjectTrust: false });
  return readConnection(runtime.credentials, providerId);
}

async function readConnection(credentials: CredentialStore, providerId: string): Promise<FoundryConnection> {
  const spec = foundryProvider(providerId)!;
  const saved = await storedFoundryConnection(credentials, providerId);
  if (saved) return saved;
  const credential = await credentials.read(providerId);
  const env = credential?.type === "api_key" ? credential.env : undefined;
  const resource = env?.AZURE_OPENAI_RESOURCE_NAME || process.env.AZURE_OPENAI_RESOURCE_NAME;
  const endpoint = env?.[spec.baseUrlEnv] || process.env[spec.baseUrlEnv]
    || (resource && spec.catalogProvider === "azure" ? `https://${resource}.openai.azure.com` : "");
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

export async function saveFoundryConnection(
  workFolderRoot: string,
  value: unknown,
  apiKey: string | undefined,
  provider?: PiRuntimeProvider,
  providerId = AZURE_OPENAI_PROVIDER,
): Promise<void> {
  const spec = foundryProvider(providerId)!;
  const settings = normalizeFoundryConnection(value, providerId);
  const runtime = await resolvePiRuntime(workFolderRoot, provider, { requestProjectTrust: false });
  // Validate explicit metadata before changing any persisted credential or catalog.
  await foundryDeploymentModels(settings, providerId, runtime.modelRuntime);
  const existing = await runtime.credentials.read(providerId);
  const key = apiKey?.trim() || (existing?.type === "api_key" ? existing.key : undefined)
    || (process.env[spec.keyEnv] ? `$${spec.keyEnv}` : undefined);
  if (!key) throw new Error(`Enter an API key for ${spec.name} to save this connection.`);
  await runtime.credentials.modify(providerId, async (current) => ({
    type: "api_key",
    // modify receives Pi's raw stored value; read may have resolved $ENV or a
    // command. Editing deployment settings must preserve that original binding.
    key: apiKey?.trim() || (current?.type === "api_key" ? current.key : undefined) || key,
    env: {
      ...(existing?.type === "api_key" ? existing.env : {}),
      [spec.baseUrlEnv]: settings.baseUrl,
      ...(spec.catalogProvider === "azure" ? { AZURE_OPENAI_API_VERSION: "v1" } : {}),
      [AZURE_OPENAI_DEPLOYMENTS_ENV]: JSON.stringify(settings.deployments),
      WORKFOLD_FOUNDRY_MODEL_IDS: JSON.stringify(settings.modelIds ?? {}),
      // Explicit identity mappings prevent ambient aliases from rerouting these names.
      ...(spec.catalogProvider === "azure" ? { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: settings.deployments.map((name) => `${name}=${name}`).join(",") } : {}),
    },
  }));
  await runtime.flushCredentials();
  await applyFoundryDeployments(runtime.credentials, runtime.modelRuntime);
}

export async function getFoundrySettings(workFolderRoot: string, provider?: PiRuntimeProvider) {
  const runtime = await resolvePiRuntime(workFolderRoot, provider, { requestProjectTrust: false });
  const connections: Record<string, FoundryConnection> = {};
  const foundryErrors: Record<string, string> = {};
  for (const spec of FOUNDRY_PROVIDERS) {
    try { connections[spec.id] = await readConnection(runtime.credentials, spec.id); }
    catch {
      connections[spec.id] = { baseUrl: "", deployments: [] };
      // JSON parser errors can echo raw credential-store values. Never project them.
      foundryErrors[spec.id] = "Saved connection settings need correction. Enter the endpoint and deployment names again, or remove this connection.";
    }
  }
  return {
    azure: connections[AZURE_OPENAI_PROVIDER],
    foundry: connections,
    foundryErrors,
    foundryModels: Object.fromEntries(FOUNDRY_PROVIDERS.map((spec) => [spec.id, foundryBaseModels(spec.id).map((model) => ({ id: model.id, name: model.name }))])),
  };
}
