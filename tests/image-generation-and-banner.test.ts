import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { deflateSync } from "node:zlib";

import { chooseImageModel, createImageGenerationTool, generateImageFile, listImageModels, resolveImagePath, type ImageModelSource } from "../src/local/agent/image-generation-tool.js";
import { openAIImageSize } from "../src/local/agent/direct-image-models.js";
import { parseWorkFoldCliActArgv } from "../src/local/cli/act-commands.js";
import { WorkFoldCliError } from "../src/local/cli/protocol.js";
import { startLocalApi } from "../src/local/server.js";

/** A tiny, real PNG (solid color) so Pi's resizer can decode it. */
function png(width: number, height: number, rgb: [number, number, number] = [47, 125, 109]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

type FakeModel = { provider: string; id: string; name: string; api: string; type: "image"; output: string[] };
const model = (provider: string, id: string, api = "openrouter-images"): FakeModel => ({ provider, id, name: id, api, type: "image", output: ["image"] });

function fakeSource(
  models: FakeModel[],
  reply: (payload: Record<string, unknown>) => unknown,
  providers: { connected?: string[]; baseUrl?: (provider: string) => string } = {},
): ImageModelSource & { calls: Array<{ id: string; payload: Record<string, unknown> }> } {
  const calls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const connected = new Set(providers.connected ?? []);
  return {
    calls,
    hasConfiguredAuth: (provider: string) => connected.has(provider),
    getAuth: async (provider: string) => (connected.has(provider) ? { auth: { apiKey: `key-${provider}` } } : undefined),
    getModels: (provider: string) => (providers.baseUrl ? [{ baseUrl: providers.baseUrl(provider) }] : []),
    async getAvailableOfType() { return models as never; },
    async generateImages(chosen: never, _context: never, options?: { onPayload?: (params: unknown, model: unknown) => unknown }) {
      const base = { model: (chosen as FakeModel).id };
      const payload = (options?.onPayload ? await options.onPayload(base, chosen) : base) as Record<string, unknown>;
      calls.push({ id: (chosen as FakeModel).id, payload });
      return reply(payload) as never;
    },
  } as never;
}

test("work-fold picks a preferred connected image model, never a router, and names what is missing", async () => {
  const connected = [model("openrouter", "openrouter/auto"), model("openrouter", "recraft/recraft-v4"), model("openrouter", "openai/gpt-image-2"), model("openrouter", "google/gemini-3.1-flash-image")];
  assert.equal((await chooseImageModel(fakeSource(connected, () => null))).id, "google/gemini-3.1-flash-image");
  assert.equal((await chooseImageModel(fakeSource(connected.slice(0, 3), () => null))).id, "openai/gpt-image-2");
  assert.equal((await chooseImageModel(fakeSource(connected.slice(0, 2), () => null))).id, "recraft/recraft-v4", "any connected model beats none");
  assert.equal((await chooseImageModel(fakeSource([model("openai", "gpt-image-2", "openai-images")], () => null))).provider, "openai", "the same preference finds a provider's own model");
  assert.equal((await chooseImageModel(fakeSource(connected, () => null), { provider: "openrouter", id: "recraft/recraft-v4" })).id, "recraft/recraft-v4");
  await assert.rejects(() => chooseImageModel(fakeSource(connected, () => null), { provider: "openai", id: "dall-e-9" }), /not a connected image model/);
  await assert.rejects(() => chooseImageModel(fakeSource([model("openrouter", "openrouter/auto")], () => null)), /No image model is connected/);
});

test("image paths stay inside the folder, avoid hidden folders, and follow the format the model returned", () => {
  const root = "/tmp/work-folder";
  assert.equal(resolveImagePath(root, "images/banner.png", "image/png"), "images/banner.png");
  assert.equal(resolveImagePath(root, "images/banner.png", "image/jpeg"), "images/banner.jpg");
  assert.equal(resolveImagePath(root, "images/banner", "image/webp"), "images/banner.webp");
  assert.equal(resolveImagePath(root, "notes.v2", "image/png"), "notes.v2.png");
  for (const bad of ["/etc/banner.png", "../banner.png", "images/../../x.png", ".work-fold/banner.png", ".git/x.png", ""]) {
    assert.throws(() => resolveImagePath(root, bad, "image/png"), /relative path inside this folder|hidden/, bad);
  }
});

test("generate_image saves the model's picture, asks OpenRouter for the shape, and reports plainly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-image-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const picture = png(42, 18);
  const source = fakeSource([model("openrouter", "google/gemini-3.1-flash-image")], () => ({
    stopReason: "stop",
    output: [{ type: "image", data: picture.toString("base64"), mimeType: "image/png" }],
    usage: { cost: { total: 0.0034 } },
  }));
  const made = await generateImageFile({ root, source, prompt: "Soft teal paper waves, no text", path: "images/banner.png", shape: "wide", includePreview: true });
  assert.equal(made.path, "images/banner.png");
  assert.deepEqual(await readFile(join(root, "images", "banner.png")), picture);
  assert.equal(made.width, 42);
  assert.equal(made.height, 18);
  assert.equal(made.cost, 0.0034);
  assert.ok(made.preview?.data, "a small copy for a model that sees images");
  assert.deepEqual(source.calls[0]!.payload.image_config, { aspect_ratio: "21:9" });

  // The tool's own result: plain words, the file, and the preview only for a model that sees images.
  const tool = createImageGenerationTool({ root, models: source });
  const seeing = await tool.execute("call-1", { prompt: "A square receipt icon, no text", path: "icon.png", shape: "square" }, undefined, undefined, { model: { input: ["text", "image"] } } as never);
  assert.match((seeing.content[0] as { text: string }).text, /^Saved the image to icon\.png \(42×18\) with google\/gemini-3\.1-flash-image \(openrouter\)\. It cost about \$0\.0034\./);
  assert.equal(seeing.content.length, 2);
  assert.deepEqual(source.calls[1]!.payload.image_config, { aspect_ratio: "1:1" });
  const blind = await tool.execute("call-2", { prompt: "Another", path: "other.png" }, undefined, undefined, { model: { input: ["text"] } } as never);
  assert.equal(blind.content.length, 1, "no image block for a model that cannot see it");

  // A temporary picture (a banner about to be applied) never lands in the folder.
  const temporary = await generateImageFile({ root, source, prompt: "A banner", path: "nested/banner.png", shape: "wide", temporary: true });
  assert.ok(temporary.path.startsWith(join(tmpdir(), "work-fold-images")), temporary.path);
  assert.ok(temporary.path.endsWith("/banner.png"), "only the file name is kept");
  assert.deepEqual(await readFile(temporary.path), picture);
  await assert.rejects(() => readFile(join(root, "nested", "banner.png")), /ENOENT/);
  await rm(dirname(temporary.path), { recursive: true, force: true });

  // Failures say what happened instead of writing anything.
  const refusing = fakeSource([model("openrouter", "google/gemini-3.1-flash-image")], () => ({ stopReason: "stop", output: [{ type: "text", text: "I can't draw that." }] }));
  await assert.rejects(() => generateImageFile({ root, source: refusing, prompt: "x", path: "nope.png" }), /returned no image\. It said: I can't draw that\./);
  const failing = fakeSource([model("openrouter", "google/gemini-3.1-flash-image")], () => ({ stopReason: "error", errorMessage: "Insufficient credits", output: [] }));
  await assert.rejects(() => generateImageFile({ root, source: failing, prompt: "x", path: "nope.png" }), /Insufficient credits/);
});

test("appearance apply changes just the named banner image, icon, or color, and undo steps back", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-appearance-parts-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return {}; } },
  });
  try {
    const facade = api.actFacade;
    const { workFolder } = await facade.createWorkFolder({ name: "Receipts" });
    await mkdir(join(workFolder.workFolderRoot, "images"), { recursive: true });
    await writeFile(join(workFolder.workFolderRoot, "images", "banner.png"), png(2400, 1000));
    const current = async () => {
      const body = await (await fetch(`${api.origin}/api/appearance`)).json() as { appearance: { customizations: Record<string, any> } };
      return body.appearance.customizations[workFolder.id] ?? null;
    };

    const applied = await facade.workFoldersAppearanceApply({
      workFolder: workFolder.id,
      parts: { bannerImagePath: "images/banner.png", icon: "Receipt", color: "#2F7D6D" },
      cwd: workFolder.workFolderRoot,
    });
    assert.equal(applied.proposalName, "banner image, icon, and color");
    let look = await current();
    assert.match(look?.bannerImage ?? "", /^data:image\/(png|jpeg);base64,/);
    assert.ok((look?.bannerImage ?? "").length <= 700_000, "within the stored bound");
    assert.equal(look?.iconName, "receipt");
    assert.equal(look?.primary?.referenceHex, "#2f7d6d");

    // Only the color changes; the banner and icon stay.
    const banner = look?.bannerImage;
    await facade.workFoldersAppearanceApply({ workFolder: workFolder.id, parts: { color: "#7a4cc2" }, cwd: workFolder.workFolderRoot });
    look = await current();
    assert.equal(look?.bannerImage, banner);
    assert.equal(look?.iconName, "receipt");
    assert.equal(look?.primary?.referenceHex, "#7a4cc2");
    const undone = await facade.workFoldersAppearanceUndo({ workFolder: workFolder.id });
    assert.ok(undone.restoredAppearanceRef);
    assert.equal((await current())?.primary?.referenceHex, "#2f7d6d", "undo is one step back");

    for (const [parts, code, pattern] of [
      [{ bannerImagePath: "images/missing.png" }, "notFound", /was not found/],
      [{ bannerImagePath: "notes.txt" }, "usage", /PNG, JPEG, WebP, or GIF/],
      [{ color: "teal" }, "usage", /hex color/],
      [{ icon: "../etc" }, "usage", /icon name/],
      [{}, "usage", /banner image, icon, or color/],
    ] as const) {
      await assert.rejects(
        () => facade.workFoldersAppearanceApply({ workFolder: workFolder.id, parts, cwd: workFolder.workFolderRoot }),
        (error: unknown) => error instanceof WorkFoldCliError && error.code === code && pattern.test(error.message),
        JSON.stringify(parts),
      );
    }
    assert.equal((await current())?.primary?.referenceHex, "#2f7d6d", "a refusal changes nothing");
  } finally {
    await api.close();
  }
});

test("the CLI takes a proposal or named parts, never both", () => {
  const parsed = parseWorkFoldCliActArgv(["work-folders", "appearance", "apply", "--work-folder", "Receipts", "--banner-image", "images/banner.png", "--icon", "receipt"]);
  assert.deepEqual(parsed.appearanceParts, { bannerImagePath: "images/banner.png", icon: "receipt" });
  assert.equal(parsed.proposalPath, undefined);
  assert.equal(parseWorkFoldCliActArgv(["work-folders", "appearance", "apply", "--work-folder", "Receipts", "--proposal", "look.json"]).proposalPath, "look.json");
  assert.throws(() => parseWorkFoldCliActArgv(["work-folders", "appearance", "apply", "--work-folder", "Receipts", "--proposal", "look.json", "--color", "#112233"]), /not both/);
  assert.throws(() => parseWorkFoldCliActArgv(["work-folders", "appearance", "apply", "--work-folder", "Receipts"]), /--proposal <path>, or at least one of/);
});

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("OpenAI and Google image models work straight from their own APIs with the key Pi already holds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-direct-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const picture = png(64, 27).toString("base64");
  const seen: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];
  let refuse = false;
  const server = createServer(async (request, response) => {
    const payload = await body(request);
    seen.push({ path: request.url ?? "", auth: (request.headers.authorization ?? request.headers["x-goog-api-key"]) as string | undefined, body: payload });
    response.setHeader("content-type", "application/json");
    if (refuse) { response.statusCode = 403; response.end(JSON.stringify({ error: { message: "Your organization must be verified to use this model." } })); return; }
    if (request.url === "/openai/images/generations") { response.end(JSON.stringify({ data: [{ b64_json: picture }] })); return; }
    if (request.url === "/google/interactions") {
      response.end(JSON.stringify({ steps: [{ type: "model_output", content: [{ type: "text", text: "Here is your banner." }, { type: "image", data: picture }] }] }));
      return;
    }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const both = fakeSource([], () => { throw new Error("Pi's image API is not used for direct models"); }, { connected: ["openai", "google"], baseUrl: (provider) => `${origin}/${provider}` });

  // Connected providers bring their own image models; Nano Banana 2 is preferred.
  const listed = await listImageModels(both);
  assert.ok(listed.some((model) => model.provider === "openai" && model.id === "gpt-image-2"));
  assert.equal((await chooseImageModel(both)).id, "gemini-3.1-flash-image");

  const fromGoogle = await generateImageFile({ root, source: both, prompt: "Sage tile, no text", path: "banner.png", shape: "wide" });
  assert.equal(fromGoogle.model.provider, "google");
  assert.deepEqual(await readFile(join(root, "banner.png")), Buffer.from(picture, "base64"));
  assert.equal(seen[0]!.path, "/google/interactions");
  assert.equal(seen[0]!.auth, "key-google");
  assert.deepEqual(seen[0]!.body.response_format, { type: "image", mime_type: "image/png", aspect_ratio: "16:9" });

  const fromOpenAI = await generateImageFile({ root, source: both, prompt: "A receipt icon", path: "icon.png", shape: "wide", model: { provider: "openai", id: "gpt-image-2" } });
  assert.equal(fromOpenAI.model.name, "GPT Image 2");
  assert.equal(seen[1]!.path, "/openai/images/generations");
  assert.equal(seen[1]!.auth, "Bearer key-openai");
  assert.equal(seen[1]!.body.size, "2048x864");
  assert.equal(openAIImageSize("gpt-image-1-mini", "wide"), "1536x1024", "GPT Image 1 takes only its fixed sizes");

  refuse = true;
  await assert.rejects(
    () => generateImageFile({ root, source: both, prompt: "x", path: "x.png", model: { provider: "openai", id: "gpt-image-2" } }),
    /GPT Image 2 refused the request: Your organization must be verified/,
  );

  // A provider whose image models Pi lists itself is reached only through Pi.
  const native = fakeSource([model("openai", "gpt-image-2", "openai-images")], () => null, { connected: ["openai"] });
  assert.deepEqual((await listImageModels(native)).map((item) => `${item.provider}/${item.id}`), ["openai/gpt-image-2"]);
  // Nothing connected, nothing listed.
  assert.deepEqual(await listImageModels(fakeSource([], () => null)), []);
});
