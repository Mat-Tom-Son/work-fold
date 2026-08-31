import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

import type { PiModelCatalog, PiModelCatalogRefreshResult, PiModelCatalogStatus } from "./pi-runtime-config.js";

const openRouterModelsUrl = "https://openrouter.ai/api/v1/models?supported_parameters=tools";
const maximumCatalogBytes = 10 * 1024 * 1024;

interface OpenRouterCacheFile {
  version: 1;
  provider: "openrouter";
  refreshedAt: string;
  models: NonNullable<ProviderConfig["models"]>;
}

interface OpenRouterApiModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
  };
  supported_parameters?: unknown;
  top_provider?: {
    max_completion_tokens?: unknown;
  };
}

/** Fetches and persists OpenRouter's tool-capable text model catalog. */
export class OpenRouterModelCatalog {
  readonly #cachePath: string;
  readonly #fetch: typeof fetch;

  constructor(options: { cachePath: string; fetch?: typeof fetch }) {
    this.#cachePath = options.cachePath;
    this.#fetch = options.fetch ?? fetch;
  }

  async load(): Promise<PiModelCatalog | undefined> {
    const cached = await this.#readCache();
    return cached ? catalogFromCache(cached) : undefined;
  }

  async status(): Promise<PiModelCatalogStatus> {
    const cached = await this.#readCache();
    return {
      provider: "openrouter",
      refreshable: true,
      source: cached ? "live" : "built_in",
      ...(cached ? { refreshedAt: cached.refreshedAt, modelCount: cached.models.length } : {}),
    };
  }

  async refresh(apiKey: string): Promise<PiModelCatalogRefreshResult> {
    if (!apiKey.trim()) throw new Error("Connect OpenRouter before refreshing its models.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let source: string;
    try {
      const response = await this.#fetch(openRouterModelsUrl, {
        headers: { authorization: `Bearer ${apiKey.trim()}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OpenRouter model refresh failed (${response.status}).`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maximumCatalogBytes) {
        throw new Error("OpenRouter returned a model catalog that is too large.");
      }
      source = await response.text();
      if (Buffer.byteLength(source, "utf8") > maximumCatalogBytes) {
        throw new Error("OpenRouter returned a model catalog that is too large.");
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error("OpenRouter model refresh timed out.");
      if (error instanceof Error && error.message.startsWith("OpenRouter ")) throw error;
      throw new Error(`OpenRouter model refresh failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
    }
    const models = parseOpenRouterModels(source);
    if (!models.length) throw new Error("OpenRouter returned no tool-capable text models.");
    const refreshedAt = new Date().toISOString();
    const cached: OpenRouterCacheFile = { version: 1, provider: "openrouter", refreshedAt, models };
    await mkdir(dirname(this.#cachePath), { recursive: true });
    const temporaryPath = `${this.#cachePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(cached, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.#cachePath);
    return { provider: "openrouter", refreshedAt, modelCount: models.length };
  }

  async #readCache(): Promise<OpenRouterCacheFile | undefined> {
    let source: string;
    try {
      source = await readFile(this.#cachePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error("The cached OpenRouter model catalog is not valid JSON.");
    }
    if (!isOpenRouterCache(parsed)) throw new Error("The cached OpenRouter model catalog is invalid.");
    return parsed;
  }
}

export function parseOpenRouterModels(source: string): NonNullable<ProviderConfig["models"]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("OpenRouter returned invalid JSON.");
  }
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { data?: unknown }).data
    : undefined;
  if (!Array.isArray(data)) throw new Error("OpenRouter returned an invalid model catalog.");
  const models = new Map<string, NonNullable<ProviderConfig["models"]>[number]>();
  for (const raw of data.slice(0, 2_000)) {
    const model = normalizeOpenRouterModel(raw as OpenRouterApiModel);
    if (model) models.set(model.id, model);
  }
  return [...models.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function normalizeOpenRouterModel(raw: OpenRouterApiModel): NonNullable<ProviderConfig["models"]>[number] | null {
  const id = cleanString(raw?.id, 256);
  const name = cleanString(raw?.name, 512) || id;
  const contextWindow = positiveInteger(raw?.context_length);
  const inputModalities = stringArray(raw?.architecture?.input_modalities);
  const outputModalities = stringArray(raw?.architecture?.output_modalities);
  const supportedParameters = stringArray(raw?.supported_parameters);
  if (!id || !name || !contextWindow || !inputModalities.includes("text")) return null;
  if (outputModalities.length && !outputModalities.includes("text")) return null;
  if (supportedParameters.length && !supportedParameters.includes("tools")) return null;
  const maximumCompletion = positiveInteger(raw?.top_provider?.max_completion_tokens);
  const maxTokens = Math.min(contextWindow, maximumCompletion ?? 32_768);
  return {
    id,
    name,
    reasoning: supportedParameters.includes("reasoning") || supportedParameters.includes("include_reasoning"),
    input: inputModalities.includes("image") ? ["text", "image"] : ["text"],
    cost: {
      input: perTokenToPerMillion(raw?.pricing?.prompt),
      output: perTokenToPerMillion(raw?.pricing?.completion),
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow,
    maxTokens,
    compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
  };
}

function catalogFromCache(cache: OpenRouterCacheFile): PiModelCatalog {
  return {
    provider: "openrouter",
    refreshedAt: cache.refreshedAt,
    liveModelCount: cache.models.length,
    config: {
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "$OPENROUTER_API_KEY",
      api: "openai-completions",
      models: cache.models,
    },
  };
}

function isOpenRouterCache(value: unknown): value is OpenRouterCacheFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cache = value as Partial<OpenRouterCacheFile>;
  return cache.version === 1
    && cache.provider === "openrouter"
    && typeof cache.refreshedAt === "string"
    && !Number.isNaN(Date.parse(cache.refreshedAt))
    && Array.isArray(cache.models)
    && cache.models.length > 0;
}

function cleanString(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function perTokenToPerMillion(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : 0;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
