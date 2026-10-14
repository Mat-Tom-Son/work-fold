/**
 * Image generation straight from providers whose image models Pi's catalog
 * does not list yet: OpenAI (GPT Image, through the Images API) and Google
 * (Nano Banana, through the Gemini Interactions API). work-fold calls them
 * with the credential Pi already holds for that provider
 * (`ModelRuntime.getAuth`) and never changes the provider's chat models. A
 * provider whose image models Pi lists natively is always reached through Pi
 * instead (docs/image-generation.md).
 */
import type { AssistantImages } from "@earendil-works/pi-ai";

export type DirectImageApi = "openai-images" | "google-interactions-images";
export type DirectImageShape = "wide" | "square" | "tall";

export interface DirectImageModel {
  type: "image";
  direct: true;
  provider: "openai" | "google";
  id: string;
  name: string;
  api: DirectImageApi;
  output: ["image"];
}

const openAI = (id: string, name: string): DirectImageModel => ({ type: "image", direct: true, provider: "openai", id, name, api: "openai-images", output: ["image"] });
const google = (id: string, name: string): DirectImageModel => ({ type: "image", direct: true, provider: "google", id, name, api: "google-interactions-images", output: ["image"] });

/** Model ids as each provider's own API names them (checked against their documentation, October 2026). */
export const directImageModels: readonly DirectImageModel[] = [
  openAI("gpt-image-2", "GPT Image 2"),
  openAI("gpt-image-2.5-flare", "GPT Image 2.5 Flare"),
  openAI("gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst"),
  openAI("gpt-image-1-mini", "GPT Image 1 Mini"),
  openAI("gpt-image-1", "GPT Image 1"),
  google("gemini-3.1-flash-image", "Nano Banana 2 (Gemini 3.1 Flash Image)"),
  google("gemini-3.1-flash-lite-image", "Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)"),
  google("gemini-3-pro-image", "Nano Banana Pro (Gemini 3 Pro Image)"),
  google("gemini-nano-banana-2.1", "Nano Banana 2.1"),
  google("gemini-2.5-flash-image", "Nano Banana (Gemini 2.5 Flash Image)"),
];

export const directImageDefaultBaseUrls: Record<DirectImageModel["provider"], string> = {
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
};

export function isDirectImageModel(model: unknown): model is DirectImageModel {
  return Boolean(model && typeof model === "object" && (model as { direct?: unknown }).direct === true);
}

/**
 * GPT Image 2 and later take a custom size (multiples of 16, at most 3:1);
 * GPT Image 1 models take only their three fixed sizes.
 */
export function openAIImageSize(modelId: string, shape: DirectImageShape): string {
  const classic = modelId.startsWith("gpt-image-1");
  if (shape === "square") return "1024x1024";
  if (shape === "tall") return "1024x1536";
  return classic ? "1536x1024" : "2048x864";
}

/** Ratios every Nano Banana model accepts. */
const googleAspectRatios: Record<DirectImageShape, string> = { wide: "16:9", square: "1:1", tall: "9:16" };

export async function generateDirectImage(input: {
  model: DirectImageModel;
  prompt: string;
  shape: DirectImageShape;
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<AssistantImages> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const result = (stopReason: AssistantImages["stopReason"], output: AssistantImages["output"], errorMessage?: string): AssistantImages => ({
    api: input.model.api,
    provider: input.model.provider,
    model: input.model.id,
    output,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  });
  const request: { url: string; headers: Record<string, string>; body: unknown } = input.model.api === "openai-images"
    ? {
      url: `${base}/images/generations`,
      headers: { authorization: `Bearer ${input.apiKey}` },
      body: { model: input.model.id, prompt: input.prompt, size: openAIImageSize(input.model.id, input.shape), n: 1, output_format: "png" },
    }
    : {
      url: `${base}/interactions`,
      headers: { "x-goog-api-key": input.apiKey },
      body: {
        model: input.model.id,
        input: [{ type: "text", text: input.prompt }],
        response_format: { type: "image", mime_type: "image/png", aspect_ratio: googleAspectRatios[input.shape] },
      },
    };
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...input.headers, ...request.headers },
      body: JSON.stringify(request.body),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (input.signal?.aborted) return result("aborted", []);
    return result("error", [], `Could not reach ${input.model.provider === "openai" ? "OpenAI" : "Google"}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const message = errorText(payload) ?? `${response.status} ${response.statusText}`.trim();
    return result("error", [], `${input.model.name} refused the request: ${message}`);
  }
  const images = input.model.api === "openai-images" ? openAIImages(payload) : googleImages(payload);
  const text = input.model.api === "google-interactions-images" ? googleText(payload) : "";
  return result("stop", [
    ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
    ...(text ? [{ type: "text" as const, text }] : []),
  ]);
}

function errorText(payload: Record<string, unknown> | null): string | undefined {
  const error = payload?.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return undefined;
}

function openAIImages(payload: Record<string, unknown> | null): Array<{ data: string; mimeType: string }> {
  const data = Array.isArray(payload?.data) ? payload!.data as Array<Record<string, unknown>> : [];
  return data.flatMap((item) => typeof item.b64_json === "string" && item.b64_json
    ? [{ data: item.b64_json, mimeType: sniffImageType(item.b64_json) ?? "image/png" }]
    : []);
}

/** Image blocks from an interaction: each model_output step's content, then the output_image convenience field. */
function googleImages(payload: Record<string, unknown> | null): Array<{ data: string; mimeType: string }> {
  const found: Array<{ data: string; mimeType: string }> = [];
  const take = (block: unknown) => {
    if (!block || typeof block !== "object") return;
    const value = block as Record<string, unknown>;
    if (value.type !== "image" || typeof value.data !== "string" || !value.data) return;
    const declared = typeof value.mime_type === "string" ? value.mime_type : typeof value.mimeType === "string" ? value.mimeType : undefined;
    found.push({ data: value.data, mimeType: declared ?? sniffImageType(value.data) ?? "image/png" });
  };
  for (const step of Array.isArray(payload?.steps) ? payload!.steps as Array<Record<string, unknown>> : []) {
    for (const block of Array.isArray(step.content) ? step.content : []) take(block);
  }
  if (!found.length) take({ type: "image", ...(payload?.output_image as Record<string, unknown> | undefined) });
  return found;
}

function googleText(payload: Record<string, unknown> | null): string {
  const parts: string[] = [];
  for (const step of Array.isArray(payload?.steps) ? payload!.steps as Array<Record<string, unknown>> : []) {
    for (const block of Array.isArray(step.content) ? step.content as Array<Record<string, unknown>> : []) {
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join(" ").trim();
}

export function sniffImageType(base64: string): string | undefined {
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  return undefined;
}
