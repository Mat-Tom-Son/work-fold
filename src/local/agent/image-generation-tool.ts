/**
 * generate_image: a Worker or work-fold agent tool that makes a picture with a
 * connected image model through Pi's own image API (`ModelRuntime.generateImages`)
 * and saves it as an ordinary file in the folder the session works in, where
 * History captures it like any other change (docs/image-generation.md).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";

import type { AssistantImages, ImageApi, ImageModel, ImagesContext } from "@earendil-works/pi-ai";
import { resizeImage, type ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ImageShape = "wide" | "square" | "tall";

/** Aspect ratios each shape asks for; a wide image suits a work-folder banner. */
export const imageShapeAspectRatios: Record<ImageShape, string> = { wide: "21:9", square: "1:1", tall: "2:3" };

/**
 * Tried in order when the caller names no model: quick, inexpensive, and good at
 * clean artwork. Matched by model id with or without a vendor prefix, so the same
 * entry finds a model through OpenRouter or straight from its own provider.
 */
export const preferredImageModelIds = [
  "gemini-3.1-flash-image",
  "gpt-image-2",
  "gemini-2.5-flash-image",
  "gpt-image-1-mini",
  "flux.2-pro",
];

const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const typeExtensions: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
const reservedFolders = new Set([".work-fold", ".pi", ".git", ".workspace"]);
const maxPromptCharacters = 32_000;

export type ImageModelSource = Pick<ModelRuntime, "getAvailableOfType" | "generateImages">;

export interface GeneratedImage {
  path: string;
  mimeType: string;
  width: number;
  height: number;
  model: { provider: string; id: string; name: string };
  cost?: number;
  /** A small copy for the model to look at, when the session's model sees images. */
  preview?: { data: string; mimeType: string };
}

/** The connected image model to use: the one named, or the first preferred one that is connected. */
export async function chooseImageModel(
  source: ImageModelSource,
  requested?: { provider: string; id: string },
): Promise<ImageModel<ImageApi>> {
  // Routers pick a model per request; a named image model keeps results predictable.
  const available = (await source.getAvailableOfType("image")).filter((model) => !/^openrouter\/auto/.test(model.id));
  if (requested) {
    const named = available.find((model) => model.provider === requested.provider && model.id === requested.id);
    if (!named) {
      throw new Error(`${requested.id} (${requested.provider}) is not a connected image model. Leave the model out to use a connected one, or connect its provider in Settings → AI Models.`);
    }
    return named;
  }
  for (const preferred of preferredImageModelIds) {
    const match = available.find((model) => model.id === preferred || model.id.endsWith(`/${preferred}`));
    if (match) return match;
  }
  const first = available[0];
  if (!first) {
    throw new Error("No image model is connected. Connect a provider that offers image models, such as OpenRouter, in Settings → AI Models.");
  }
  return first;
}

/** A save path inside `root`, with an image extension that matches what the model returned. */
export function resolveImagePath(root: string, requested: string, mimeType: string): string {
  const trimmed = requested.trim().replace(/\\/g, "/");
  if (!trimmed || isAbsolute(trimmed) || trimmed.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Save the image to a relative path inside this folder, for example images/banner.png.");
  }
  if (reservedFolders.has(trimmed.split("/")[0]!.toLowerCase())) throw new Error("Images cannot be saved in hidden work-fold, Pi, or Git folders.");
  const extension = extname(trimmed).toLowerCase();
  const actual = typeExtensions[mimeType] ?? ".png";
  // The model decides the format; the file name follows it rather than lying about it.
  const relativePath = imageTypes[extension] === mimeType
    ? trimmed
    : `${extension && imageTypes[extension] ? trimmed.slice(0, -extension.length) : trimmed}${actual}`;
  const target = join(root, normalize(relativePath));
  const inside = relative(root, target);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || inside.split(sep).includes("..")) {
    throw new Error("The image must be saved inside this folder.");
  }
  return relativePath;
}

export async function generateImageFile(input: {
  root: string;
  source: ImageModelSource;
  prompt: string;
  path: string;
  shape?: ImageShape;
  model?: { provider: string; id: string };
  includePreview?: boolean;
  signal?: AbortSignal;
}): Promise<GeneratedImage> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Describe the image to make.");
  if (prompt.length > maxPromptCharacters) throw new Error(`Keep the description under ${maxPromptCharacters.toLocaleString("en-US")} characters.`);
  const shape = input.shape ?? "square";
  const model = await chooseImageModel(input.source, input.model);
  const context: ImagesContext = { input: [{ type: "text", text: prompt }] };
  const aspectRatio = imageShapeAspectRatios[shape];
  const result: AssistantImages = await input.source.generateImages(model, context, {
    ...(input.signal ? { signal: input.signal } : {}),
    // OpenRouter takes the shape as an image option on the request; providers
    // that do not understand it still return an image, just in their default shape.
    ...(model.api === "openrouter-images"
      ? { onPayload: (params: unknown) => ({ ...(params as Record<string, unknown>), image_config: { aspect_ratio: aspectRatio } }) }
      : {}),
  });
  if (result.stopReason !== "stop") {
    throw new Error(result.errorMessage?.trim() || `${model.name} stopped before finishing the image (${result.stopReason}).`);
  }
  const image = result.output.find((part) => part.type === "image");
  if (!image || image.type !== "image") {
    const said = result.output.filter((part) => part.type === "text").map((part) => part.text).join(" ").trim();
    throw new Error(`${model.name} returned no image${said ? `. It said: ${said.slice(0, 400)}` : "."}`);
  }
  const bytes = Buffer.from(image.data, "base64");
  const relativePath = resolveImagePath(input.root, input.path, image.mimeType);
  const target = join(input.root, normalize(relativePath));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  const preview = await resizeImage(bytes, image.mimeType, { maxWidth: 1024, maxHeight: 1024, maxBytes: 900_000, jpegQuality: 80 }).catch(() => null);
  const cost = result.usage?.cost?.total;
  return {
    path: relativePath,
    mimeType: image.mimeType,
    width: preview?.originalWidth ?? 0,
    height: preview?.originalHeight ?? 0,
    model: { provider: model.provider, id: model.id, name: model.name },
    ...(typeof cost === "number" && cost > 0 ? { cost } : {}),
    ...(input.includePreview && preview ? { preview: { data: preview.data, mimeType: preview.mimeType } } : {}),
  };
}

export function createImageGenerationTool(input: { root: string; models: ImageModelSource }): ToolDefinition<any> {
  return {
    name: "generate_image",
    label: "Generate image",
    description: "Make a new picture from a description with a connected image model and save it as a file in this folder: banners, illustrations, backgrounds, and other images the person asks for.",
    promptSnippet: "Make an image from a description and save it in this folder",
    promptGuidelines: [
      "generate_image saves to the path you give, relative to this folder (png, jpg, or webp; the extension follows the format the model returns). Use shape \"wide\" for a work-folder banner, \"square\" for an icon-like picture, and \"tall\" for a poster. Describe the subject, style, mood, and colors. Say \"no text, no letters\" unless words are wanted, because image models misspell text.",
      "With no model named it uses a connected image model work-fold prefers; name one as {provider, id} only when the person asks for it. If no image model is connected, tell the person to connect a provider with image models in Settings → AI Models.",
      "To make a generated picture this work-folder's banner, apply it with work-fold work-folders appearance apply --work-folder <id> --banner-image <path>; it can be undone with work-folders appearance undo.",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: maxPromptCharacters, description: "What the image shows: subject, style, mood, and colors." },
        path: { type: "string", minLength: 1, maxLength: 1024, description: "Where to save it, relative to this folder, for example images/banner.png." },
        shape: { type: "string", enum: ["wide", "square", "tall"], description: "wide (about 21:9, for banners), square, or tall. Defaults to square." },
        model: {
          type: "object",
          properties: { provider: { type: "string", minLength: 1 }, id: { type: "string", minLength: 1 } },
          required: ["provider", "id"],
          additionalProperties: false,
          description: "A specific connected image model; leave it out to let work-fold choose.",
        },
      },
      required: ["prompt", "path"],
      additionalProperties: false,
    } as any,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const value = params as { prompt?: unknown; path?: unknown; shape?: unknown; model?: { provider?: unknown; id?: unknown } };
      const shape = value.shape === "wide" || value.shape === "tall" || value.shape === "square" ? value.shape : undefined;
      const model = value.model && typeof value.model.provider === "string" && typeof value.model.id === "string"
        ? { provider: value.model.provider, id: value.model.id }
        : undefined;
      const sees = Boolean(ctx?.model?.input?.includes("image"));
      const made = await generateImageFile({
        root: input.root,
        source: input.models,
        prompt: typeof value.prompt === "string" ? value.prompt : "",
        path: typeof value.path === "string" ? value.path : "",
        ...(shape ? { shape } : {}),
        ...(model ? { model } : {}),
        includePreview: sees,
        ...(signal ? { signal } : {}),
      });
      const size = made.width && made.height ? ` (${made.width}×${made.height})` : "";
      const cost = made.cost !== undefined ? ` It cost about $${made.cost.toFixed(4)}.` : "";
      const text = `Saved the image to ${made.path}${size} with ${made.model.name} (${made.model.provider}).${cost}${sees ? " A small copy is attached so you can check it." : ""}`;
      return {
        content: [
          { type: "text" as const, text },
          ...(made.preview ? [{ type: "image" as const, data: made.preview.data, mimeType: made.preview.mimeType }] : []),
        ],
        details: { path: made.path, mimeType: made.mimeType, width: made.width, height: made.height, model: made.model, ...(made.cost !== undefined ? { cost: made.cost } : {}) },
      };
    },
  };
}
