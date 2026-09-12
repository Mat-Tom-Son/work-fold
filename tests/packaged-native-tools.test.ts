import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createPackage } from "@electron/asar";
import { verifyPackagedImageSize, verifyPackagedNativeTools } from "../scripts/verify-packaged-native-tools.mjs";

async function copyReviewedParser(source: string) {
  const manifest = JSON.parse(await readFile(new URL("../patches/included-tools/manifest.json", import.meta.url), "utf8"));
  const entry = manifest.find((item: { package: string }) => item.package === "image-size");
  for (const relative of ["package.json", ...entry.files.map((file: { path: string }) => file.path)]) {
    const path = join(source, "node_modules/image-size", relative);
    await mkdir(dirname(path), { recursive: true });
    await copyFile(new URL(`../node_modules/image-size/${relative}`, import.meta.url), path);
  }
}

test("packaged parser guard accepts reviewed bytes and rejects omitted, replaced or wrong-version image-size", async t => {
  const root = await mkdtemp(join(tmpdir(), "workfold-packaged-parser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const state of ["reviewed", "missing", "replaced", "wrong-version"]) {
    const source = join(root, state), archive = join(root, `${state}.asar`);
    await mkdir(source); await copyReviewedParser(source);
    if (state === "missing") await rm(join(source, "node_modules/image-size/dist/types/icns.js"));
    if (state === "replaced") await writeFile(join(source, "node_modules/image-size/dist/types/utils.js"), "module.exports = {};\n");
    if (state === "wrong-version") await writeFile(join(source, "node_modules/image-size/package.json"), JSON.stringify({ name: "image-size", version: "1.2.0" }));
    await createPackage(source, archive);
    if (state === "reviewed") assert.match(await verifyPackagedImageSize(archive), /PASS packaged image-size 1\.2\.1: 2 reviewed parser file hashes/);
    else await assert.rejects(() => verifyPackagedImageSize(archive), /Packaged image-size security verification failed/);
  }
});

test("full built-ASAR smoke rejects missing packaged dependencies without borrowing the contributor runtime", { skip: process.platform !== "darwin", timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "workfold-incomplete-built-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), archive = join(root, "app.asar");
  await mkdir(source); await mkdir(`${archive}.unpacked`);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "work-fold-desktop", type: "module" }));
  await copyReviewedParser(source);
  await createPackage(source, archive);
  await assert.rejects(() => verifyPackagedNativeTools(archive), error => error instanceof Error && /Packaged native tool smoke failed/.test(error.message) && /Cannot find module 'jiti'|Jiti must come from the built archive/.test(error.message));
});
