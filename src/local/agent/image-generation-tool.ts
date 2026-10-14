/**
 * generate_image: a Worker or work-fold agent tool that makes a picture with a
 * connected image model through Pi's own image API (`ModelRuntime.generateImages`)
 * and saves it as an ordinary file in the folder the session works in, where
 * History captures it like any other change (docs/image-generation.md).
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";

import type { AssistantImages, ImageApi, ImageModel, ImagesContext } from "@earendil-works/pi-ai";
import { resizeImage, type ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  directImageDefaultBaseUrls,
  directImageModels,
  generateDirectImage,
  isDirectImageModel,
  type DirectImageModel,
} from "./direct-image-models.js";

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

export type ImageModelSource = Pick<ModelRuntime, "getAvailableOfType" | "generateImages" | "hasConfiguredAuth" | "getAuth" | "getModels">;
/** A model from Pi's image catalog, or one work-fold reaches directly with the provider's own credential. */
export type ChosenImageModel = ImageModel<ImageApi> | DirectImageModel;

/**
 * Every image model a session can use: Pi's connected image models, then the
 * direct ones for each connected provider Pi has no image models for.
 */
export async function listImageModels(source: ImageModelSource): Promise<ChosenImageModel[]> {
  // Routers pick a model per request; a named image model keeps results predictable.
  const native = (await source.getAvailableOfType("image")).filter((model) => !/^openrouter\/auto/.test(model.id));
  const nativeProviders = new Set(native.map((model) => model.provider));
  const direct = directImageModels.filter((model) => !nativeProviders.has(model.provider) && source.hasConfiguredAuth(model.provider));
  return [...native, ...direct];
}

/** Where pictures are kept for the Chat to show (GeneratedImageStore in the app). */
export interface GeneratedImageSink {
  save(bytes: Buffer, mimeType: string, name: string): Promise<{ id: string; name: string; file: string }>;
}

export interface GeneratedImage {
  /** work-folder-relative path, present only when the picture was saved in the folder. */
  path?: string;
  /** An absolute path to a copy on disk, for appearance apply --banner-image. */
  file: string;
  /** The file name used when the picture is added to the folder. */
  name: string;
  /** Present when the picture was kept for the Chat to show. */
  imageId?: string;
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
  /** The person's Settings choice; used while connected, otherwise Automatic. */
  preferred?: { provider: string; id: string },
): Promise<ChosenImageModel> {
  const available = await listImageModels(source);
  if (!requested && preferred) {
    const saved = available.find((model) => model.provider === preferred.provider && model.id === preferred.id);
    if (saved) return saved;
  }
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
  /** Where to save it in the folder; leave it out to keep it out of the folder. */
  path?: string;
  shape?: ImageShape;
  model?: { provider: string; id: string };
  /** The person's Settings choice (Settings → AI Models → Image model). */
  preferred?: { provider: string; id: string };
  includePreview?: boolean;
  /** Kept for older callers: the same as leaving out the path. */
  temporary?: boolean;
  /** Keeps the picture for the Chat to show; without one, an unsaved picture goes to temporary space. */
  store?: GeneratedImageSink;
  signal?: AbortSignal;
}): Promise<GeneratedImage> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Describe the image to make.");
  if (prompt.length > maxPromptCharacters) throw new Error(`Keep the description under ${maxPromptCharacters.toLocaleString("en-US")} characters.`);
  const shape = input.shape ?? "square";
  const model = await chooseImageModel(input.source, input.model, input.preferred);
  const context: ImagesContext = { input: [{ type: "text", text: prompt }] };
  const aspectRatio = imageShapeAspectRatios[shape];
  const result: AssistantImages = isDirectImageModel(model)
    ? await generateWithProviderCredential(input.source, model, prompt, shape, input.signal)
    : await input.source.generateImages(model, context, {
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
  const requestedPath = input.path?.trim() ?? "";
  const inFolder = Boolean(requestedPath) && !input.temporary;
  // In the folder only when a path was given; a quick picture stays out of it.
  const relativePath = inFolder ? resolveImagePath(input.root, requestedPath, image.mimeType) : undefined;
  const fileName = basename(resolveImagePath(input.root, basename(requestedPath.replace(/\\/g, "/")) || nameFromPrompt(prompt), image.mimeType));
  let file: string | undefined;
  if (relativePath) {
    file = join(input.root, normalize(relativePath));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const stored = input.store ? await input.store.save(bytes, image.mimeType, fileName).catch(() => null) : null;
  if (!file && stored) file = stored.file;
  if (!file) {
    const temporaryRoot = join(tmpdir(), "work-fold-images", randomUUID());
    file = join(temporaryRoot, fileName);
    await mkdir(temporaryRoot, { recursive: true });
    await writeFile(file, bytes);
  }
  const preview = await resizeImage(bytes, image.mimeType, { maxWidth: 1024, maxHeight: 1024, maxBytes: 900_000, jpegQuality: 80 }).catch(() => null);
  const cost = result.usage?.cost?.total;
  return {
    ...(relativePath ? { path: relativePath } : {}),
    file,
    name: fileName,
    ...(stored ? { imageId: stored.id } : {}),
    mimeType: image.mimeType,
    width: preview?.originalWidth ?? 0,
    height: preview?.originalHeight ?? 0,
    model: { provider: model.provider, id: model.id, name: model.name },
    ...(typeof cost === "number" && cost > 0 ? { cost } : {}),
    ...(input.includePreview && preview ? { preview: { data: preview.data, mimeType: preview.mimeType } } : {}),
  };
}

/** A file name from the first words of the description: "A calm teal banner, no text" → "A calm teal banner". */
function nameFromPrompt(prompt: string): string {
  const lead = prompt.split(/[,.;:!?\n]/).find((part) => part.trim()) ?? prompt;
  const words = lead.replace(/[^\p{L}\p{N}\s'-]+/gu, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return words.slice(0, 80).trim() || "Image";
}

async function generateWithProviderCredential(
  source: ImageModelSource,
  model: DirectImageModel,
  prompt: string,
  shape: ImageShape,
  signal?: AbortSignal,
): Promise<AssistantImages> {
  const resolved = await source.getAuth(model.provider);
  const apiKey = resolved?.auth.apiKey;
  if (!apiKey) {
    throw new Error(`${model.name} needs an API key for ${model.provider === "openai" ? "OpenAI" : "Google"}. Connect one in Settings → AI Models.`);
  }
  // The provider's own endpoint, as its chat models use it, so a configured proxy or region carries over.
  const baseUrl = resolved.auth.baseUrl ?? source.getModels(model.provider)[0]?.baseUrl ?? directImageDefaultBaseUrls[model.provider];
  return generateDirectImage({
    model,
    prompt,
    shape,
    apiKey,
    baseUrl,
    ...(resolved.auth.headers ? { headers: resolved.auth.headers as Record<string, string> } : {}),
    ...(signal ? { signal } : {}),
  });
}

export function createImageGenerationTool(input: {
  root: string;
  models: ImageModelSource;
  /** Reads the person's image model choice at call time, so a change applies to the next picture. */
  preferredModel?: () => Promise<{ provider: string; id: string } | undefined>;
  /** Keeps every picture so the Chat can show it and the person can copy it or add it to the folder. */
  store?: GeneratedImageSink;
}): ToolDefinition<any> {
  // With a store the Chat shows each picture; without one, it is a file the agent hands on.
  const inChat = Boolean(input.store);
  return {
    name: "generate_image",
    label: "Generate image",
    description: inChat
      ? "Make a new picture from a description with a connected image model: illustrations, banners, backgrounds, and any other image the person asks for. It shows in the Chat, where the person can copy it or add it to the folder; give a path only to save it in the folder yourself."
      : "Make a new picture from a description with a connected image model: illustrations, banners, backgrounds, and any other image the person asks for. The result gives the picture's file; give a path to save it in the folder instead.",
    promptSnippet: inChat ? "Make an image from a description; it shows in the Chat" : "Make an image from a description",
    promptGuidelines: [
      (inChat
        ? "generate_image shows the picture in the Chat for the person, who can copy it or add it to the folder from there, so leave out path unless the person asked you to save it in the folder (then path is relative to this folder; the extension follows the format the model returns)."
        : "generate_image returns the picture's file outside the folder; give a path relative to the folder only when it belongs there (the extension follows the format the model returns).")
        + " Use shape \"wide\" for a work-folder banner, \"square\" for an icon-like picture, and \"tall\" for a poster. Describe the subject, style, mood, and colors. Say \"no text, no letters\" unless words are wanted, because image models misspell text.",
      "With no model named it uses the image model chosen in Settings → AI Models, or a connected one work-fold prefers; name one as {provider, id} only when the person asks for it. If no image model is connected, tell the person to connect a provider with image models in Settings → AI Models.",
      "To make a generated picture this work-folder's banner, make it without a path, then apply the file path the result gives with work-fold work-folders appearance apply --work-folder <id> --banner-image <file>; it can be undone with work-folders appearance undo.",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: maxPromptCharacters, description: "What the image shows: subject, style, mood, and colors." },
        path: { type: "string", minLength: 1, maxLength: 1024, description: "Only to save it in this folder: a path relative to the folder, for example Images/garden.png. Leave it out to show the picture in the Chat without adding a file." },
        shape: { type: "string", enum: ["wide", "square", "tall"], description: "wide (about 21:9, for banners), square, or tall. Defaults to square." },
        temporary: {
          type: "boolean",
          description: "Older option; the same as leaving out path.",
        },
        model: {
          type: "object",
          properties: { provider: { type: "string", minLength: 1 }, id: { type: "string", minLength: 1 } },
          required: ["provider", "id"],
          additionalProperties: false,
          description: "A specific connected image model; leave it out to let work-fold choose.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    } as any,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const value = params as { prompt?: unknown; path?: unknown; shape?: unknown; temporary?: unknown; model?: { provider?: unknown; id?: unknown } };
      const shape = value.shape === "wide" || value.shape === "tall" || value.shape === "square" ? value.shape : undefined;
      const model = value.model && typeof value.model.provider === "string" && typeof value.model.id === "string"
        ? { provider: value.model.provider, id: value.model.id }
        : undefined;
      const sees = Boolean(ctx?.model?.input?.includes("image"));
      const preferred = model ? undefined : await input.preferredModel?.().catch(() => undefined);
      const made = await generateImageFile({
        root: input.root,
        source: input.models,
        prompt: typeof value.prompt === "string" ? value.prompt : "",
        ...(typeof value.path === "string" && value.path.trim() ? { path: value.path } : {}),
        ...(input.store ? { store: input.store } : {}),
        ...(shape ? { shape } : {}),
        ...(model ? { model } : {}),
        ...(preferred ? { preferred } : {}),
        includePreview: sees,
        ...(value.temporary === true ? { temporary: true } : {}),
        ...(signal ? { signal } : {}),
      });
      const size = made.width && made.height ? ` (${made.width}×${made.height})` : "";
      const cost = made.cost !== undefined ? ` It cost about $${made.cost.toFixed(4)}.` : "";
      const where = made.path
        ? `Saved it to ${made.path} in this folder.`
        : `It is not in this folder${made.imageId ? "; the person can add it from the Chat" : ""}. Its file is ${made.file} (use that path with appearance apply --banner-image).`;
      const text = `Made the image${size} with ${made.model.name} (${made.model.provider}).${made.imageId ? " It shows in the Chat." : ""} ${where}${cost}${sees ? " A small copy is attached so you can check it." : ""}`;
      return {
        content: [
          { type: "text" as const, text },
          ...(made.preview ? [{ type: "image" as const, data: made.preview.data, mimeType: made.preview.mimeType }] : []),
        ],
        details: {
          ...(made.imageId ? { imageId: made.imageId } : {}),
          name: made.name,
          ...(made.path ? { path: made.path } : {}),
          file: made.file,
          mimeType: made.mimeType,
          width: made.width,
          height: made.height,
          model: made.model,
          ...(made.cost !== undefined ? { cost: made.cost } : {}),
        },
      };
    },
  };
}
