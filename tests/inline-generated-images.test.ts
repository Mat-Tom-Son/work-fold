import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";

import { writeDesktopClipboard } from "../desktop/src/clipboard.js";
import { GeneratedImageStore, isGeneratedImageId } from "../src/local/agent/generated-image-store.js";
import { createImageGenerationTool, type ImageModelSource } from "../src/local/agent/image-generation-tool.js";
import { appendMessage, readConversation, type ChatMessage } from "../src/local/agent/chat-store.js";
import { parseChatToolImage } from "../src/local/agent/turn-presentation.js";
import { startLocalApi } from "../src/local/server.js";
import { createDomHarness } from "./support/dom.js";

const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const assets = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:image-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === "test:image-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
    if (/\.(png|svg)$/.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
    return next(url, context);
  },
});
const { GeneratedImages, turnGeneratedImages } = await import("../web-local/src/components/chat/GeneratedImages.js");
assets.deregister();

/** Eight bytes that say PNG; enough for the store and the routes, which never decode. */
const pictureBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const imageId = "0123456789abcdef0123456789abcdef";

test("the picture store keeps bytes and a name in app state, by an id nothing else can spell", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-generated-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GeneratedImageStore(join(root, "generated-images"));
  const saved = await store.save(pictureBytes, "image/png", "../Sage tile.jpg");
  assert.ok(isGeneratedImageId(saved.id));
  assert.equal(saved.name, "Sage tile.png", "a plain name with the picture's own extension, never a path");
  assert.equal(saved.file, join(root, "generated-images", `${saved.id}.png`));
  assert.deepEqual((await store.read(saved.id))?.bytes, pictureBytes);

  await store.noteAdded(saved.id, "work-folder-a", "Images/Sage tile.png");
  assert.deepEqual((await store.get(saved.id))?.added, { "work-folder-a": "Images/Sage tile.png" });

  for (const bad of ["../x", "0123", `${saved.id}.json`, saved.id.toUpperCase()]) assert.equal(await store.get(bad), null, bad);
  await assert.rejects(() => store.save(pictureBytes, "image/svg+xml", "x"), /Unsupported picture type/);
});

test("a picture made without a path shows in the Chat and stays out of the folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-inline-image-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "folder");
  await writeFile(join(root, "placeholder"), "");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(folder));
  const store = new GeneratedImageStore(join(root, "state", "generated-images"));
  const source = {
    hasConfiguredAuth: () => false,
    getAuth: async () => undefined,
    getModels: () => [],
    async getAvailableOfType() { return [{ provider: "openrouter", id: "google/gemini-3.1-flash-image", name: "Nano Banana 2", api: "openrouter-images", type: "image", output: ["image"] }] as never; },
    async generateImages() { return { stopReason: "stop", output: [{ type: "image", data: pictureBytes.toString("base64"), mimeType: "image/png" }] } as never; },
  } as unknown as ImageModelSource;

  const tool = createImageGenerationTool({ root: folder, models: source, store });
  assert.match(tool.description, /shows in the Chat/);
  const result = await tool.execute("call-1", { prompt: "A sage paper tile, no text, no letters", shape: "square" }, undefined, undefined, { model: { input: ["text"] } } as never);
  const details = result.details as Record<string, unknown>;
  assert.ok(isGeneratedImageId(details.imageId));
  assert.equal(details.path, undefined);
  assert.equal(details.name, "A sage paper tile.png", "named from the start of the description");
  assert.deepEqual(await readdir(folder), [], "nothing was added to the folder");
  assert.deepEqual((await store.read(details.imageId as string))?.bytes, pictureBytes);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /It shows in the Chat\. It is not in this folder; the person can add it from the Chat\./);
  assert.ok(text.includes(String(details.file)), "the file path to apply as a banner");

  // What the Chat keeps: the id, name, type, and size, never the bytes.
  assert.deepEqual(parseChatToolImage(details), { id: details.imageId, name: "A sage paper tile.png", mimeType: "image/png" });

  // Saved in the folder when asked, and still shown in the Chat.
  const saved = await tool.execute("call-2", { prompt: "A banner", path: "Images/banner.png" }, undefined, undefined, { model: { input: ["text"] } } as never);
  assert.equal((saved.details as Record<string, unknown>).path, "Images/banner.png");
  assert.deepEqual(await readFile(join(folder, "Images", "banner.png")), pictureBytes);
  assert.equal(parseChatToolImage(saved.details)?.path, "Images/banner.png");

  // Without a store (the work-fold agent today), nothing claims the Chat shows it.
  const plain = createImageGenerationTool({ root: folder, models: source });
  assert.doesNotMatch(plain.description, /shows in the Chat/);
  const unstored = await plain.execute("call-3", { prompt: "A quick sketch" }, undefined, undefined, { model: { input: ["text"] } } as never);
  assert.doesNotMatch((unstored.content[0] as { text: string }).text, /Chat/);
  assert.equal(parseChatToolImage(unstored.details), undefined);
  await rm(String((unstored.details as Record<string, unknown>).file), { force: true });
});

test("a Chat log keeps a valid picture reference on a finished generate_image step only", async (t) => {
  const workFolderRoot = await mkdtemp(join(tmpdir(), "work-fold-chat-image-"));
  t.after(() => rm(workFolderRoot, { recursive: true, force: true }));
  for (const bad of [{ id: "nope", name: "x.png", mimeType: "image/png" }, { id: imageId, name: "a/b.png", mimeType: "image/png" }, { id: imageId, name: "x.svg", mimeType: "image/svg+xml" }]) {
    assert.equal(parseChatToolImage(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(parseChatToolImage({ id: imageId, name: "x.png", mimeType: "image/png", path: "../x.png" })?.path, undefined, "a path outside the folder is dropped");
  const image = { id: imageId, name: "Sage tile.png", mimeType: "image/png", width: 1024, height: 1024 };
  const message: ChatMessage = {
    id: "assistant-image",
    role: "assistant",
    content: "Here it is.",
    createdAt: "2026-10-11T00:00:00Z",
    workTrail: [
      { kind: "tool", text: "Generate image", toolName: "generate_image", phase: "complete", image },
      { kind: "tool", text: "Read complete", detail: "notes.md", toolName: "read", phase: "complete", image } as never,
    ],
  };
  await appendMessage(workFolderRoot, "chat-image", message);
  const [read] = await readConversation(workFolderRoot, "chat-image");
  assert.deepEqual(read?.workTrail?.[0]?.image, image);
  assert.equal(read?.workTrail?.[1]?.image, undefined, "only generate_image carries a picture");
});

test("Copy carries one PNG or JPEG picture across the desktop bridge and nothing else", () => {
  const written: unknown[] = [];
  const write = (content: unknown) => { written.push(content); };
  writeDesktopClipboard({ text: "", image: "data:image/png;base64,iVBORw0KGgo=" }, write);
  assert.deepEqual(written, [{ text: "", image: "data:image/png;base64,iVBORw0KGgo=" }]);
  for (const bad of [
    { text: "", image: "data:image/gif;base64,R0lGOD" },
    { text: "", image: "javascript:alert(1)" },
    { text: "", image: "data:image/png;base64,<svg>" },
    { text: "", image: 42 },
    { text: 42 },
    { text: "", file: "/etc/passwd" },
  ]) {
    assert.throws(() => writeDesktopClipboard(bad, write), /Invalid clipboard content/, JSON.stringify(bad));
  }
  assert.equal(written.length, 1);
});

test("the routes serve a picture and add it to a folder once, with a restore point", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-image-routes-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const stateBase = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase,
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return {}; } },
  });
  try {
    const { workFolder } = await api.actFacade.createWorkFolder({ name: "Garden" });
    const store = new GeneratedImageStore(join(stateBase, "generated-images"));
    const saved = await store.save(pictureBytes, "image/png", "Sage tile");
    const base = `${api.origin}/api/work-folders/${encodeURIComponent(workFolder.id)}/generated-images/${saved.id}`;

    const bytes = await fetch(`${api.origin}/api/generated-images/${saved.id}`);
    assert.equal(bytes.status, 200);
    assert.equal(bytes.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), pictureBytes);
    assert.equal((await fetch(`${api.origin}/api/generated-images/${imageId}`)).status, 404);
    assert.equal((await fetch(`${api.origin}/api/generated-images/..%2Fimage-model.json`)).status, 404);

    assert.deepEqual(await (await fetch(base)).json(), { name: "Sage tile.png", mimeType: "image/png" });
    const first = await fetch(`${base}/add`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), { path: "Sage tile.png", added: true });
    assert.deepEqual(await readFile(join(workFolder.workFolderRoot, "Sage tile.png")), pictureBytes);
    const { checkpoints } = await (await fetch(`${api.origin}/api/work-folders/${encodeURIComponent(workFolder.id)}/history/checkpoints`)).json() as {
      checkpoints: Array<{ reason: string; deleteOnRestore: string[] }>;
    };
    assert.ok(checkpoints.some((item) => item.reason === "pre_upload" && item.deleteOnRestore.includes("Sage tile.png")), "restoring takes the picture back out");

    const again = await fetch(`${base}/add`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.deepEqual(await again.json(), { path: "Sage tile.png", added: false }, "a second click shows the same file");
    assert.deepEqual((await readdir(workFolder.workFolderRoot)).filter((name) => !name.startsWith(".")), ["Sage tile.png"]);
    assert.deepEqual(await (await fetch(base)).json(), { name: "Sage tile.png", mimeType: "image/png", addedPath: "Sage tile.png" });

    // Once the person deletes or moves the file, the Chat offers Add to folder again.
    await rm(join(workFolder.workFolderRoot, "Sage tile.png"));
    assert.deepEqual(await (await fetch(base)).json(), { name: "Sage tile.png", mimeType: "image/png" });
    await writeFile(join(workFolder.workFolderRoot, "Sage tile.png"), "someone else's file");
    const beside = await (await fetch(`${base}/add`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { path: string };
    assert.notEqual(beside.path, "Sage tile.png", "never over a file that is already there");
    assert.equal(await readFile(join(workFolder.workFolderRoot, "Sage tile.png"), "utf8"), "someone else's file");
  } finally {
    await api.close();
  }
});

test("a turn's pictures show once each, finished ones only", () => {
  const image = { id: imageId, name: "a.png", mimeType: "image/png" };
  const other = { ...image, id: "f".repeat(32), name: "b.png" };
  assert.deepEqual(turnGeneratedImages([
    { kind: "thinking" },
    { kind: "tool", phase: "running", image: other },
    { kind: "tool", phase: "complete", image },
    { kind: "tool", image },
    { kind: "tool", phase: "complete", image: other },
  ]), [image, other]);
});

test("hovering a picture offers Copy and Add to folder, then Show in Files", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const requests: Array<{ url: string; method: string; session: string | null }> = [];
  const clipboard: unknown[] = [];
  const opened: string[] = [];
  let addedPath: string | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    // The renderer's connect-src policy refuses blob: and data: fetches, so the component must never make one.
    if (url.startsWith("blob:") || url.startsWith("data:")) throw new TypeError(`Refused to connect to ${url.slice(0, 5)} under the Content Security Policy.`);
    const method = init?.method ?? "GET";
    requests.push({ url, method, session: new Headers(init?.headers).get("x-work-fold-session") });
    const path = new URL(url).pathname;
    if (path === `/api/generated-images/${imageId}`) return new Response(new Blob([pictureBytes], { type: "image/png" }));
    if (path.endsWith(`/generated-images/${imageId}`)) return Response.json({ name: "Sage tile.png", mimeType: "image/png", ...(addedPath ? { addedPath } : {}) });
    if (path.endsWith(`/generated-images/${imageId}/add`) && method === "POST") { addedPath = "Sage tile.png"; return Response.json({ path: addedPath, added: true }, { status: 201 }); }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  (window as unknown as Record<string, unknown>).workFoldDesktop = {
    api: { baseUrl: "http://work-fold.test/", getSessionHeaders: async () => ({ "x-work-fold-session": "session-1" }) },
    clipboard: { write: async (content: unknown) => { clipboard.push(content); } },
  };

  await dom.render(createElement(GeneratedImages, {
    images: [{ id: imageId, name: "Sage tile.png", mimeType: "image/png", width: 1600, height: 900 }],
    workFolderId: "garden",
    onOpenWorkFolderFile: (path: string) => { opened.push(path); },
  }));
  await dom.waitFor(() => Boolean(document.querySelector(".generated-image img")));
  const figure = document.querySelector<HTMLElement>(".generated-image")!;
  assert.equal(figure.style.getPropertyValue("--generated-image-ratio"), String(1600 / 900));
  assert.equal(document.querySelector("img")!.getAttribute("alt"), "Sage tile.png");
  assert.ok(requests.every((request) => request.session === "session-1"), "every request carries the session");
  const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>(".generated-image-actions button")).find((item) => item.textContent === label);
  assert.deepEqual(Array.from(document.querySelectorAll(".generated-image-actions button")).map((item) => item.textContent), ["Copy", "Add to folder"]);

  await dom.act(() => button("Copy")!.click());
  await dom.waitFor(() => Boolean(button("Copied")));
  assert.deepEqual(clipboard, [{ text: "", image: `data:image/png;base64,${pictureBytes.toString("base64")}` }]);

  await dom.act(() => button("Add to folder")!.click());
  await dom.waitFor(() => Boolean(button("Show in Files")));
  assert.ok(requests.some((request) => request.method === "POST" && request.url === `http://work-fold.test/api/work-folders/garden/generated-images/${imageId}/add`));
  await dom.act(() => button("Show in Files")!.click());
  assert.deepEqual(opened, ["Sage tile.png"]);

  // A picture from another computer says so instead of showing a broken image.
  await dom.render(createElement(GeneratedImages, {
    images: [{ id: "e".repeat(32), name: "Elsewhere.png", mimeType: "image/png" }],
    workFolderId: "garden",
  }));
  await dom.waitFor(() => Boolean(document.querySelector(".generated-image-missing")));
  assert.equal(document.querySelector(".generated-image-missing")!.textContent, "Elsewhere.png is not on this computer.");
  delete (window as unknown as Record<string, unknown>).workFoldDesktop;
});
