import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPackage } from "@electron/asar";
import { verifyPackagedNativeTools } from "../scripts/verify-packaged-native-tools.mjs";

test("full built-ASAR smoke rejects missing packaged dependencies without borrowing the contributor runtime", { skip: process.platform !== "darwin", timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "workfold-incomplete-built-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), archive = join(root, "app.asar");
  await mkdir(source); await mkdir(`${archive}.unpacked`);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "work-fold-desktop", type: "module" }));
  await createPackage(source, archive);
  await assert.rejects(() => verifyPackagedNativeTools(archive), error => error instanceof Error && /Packaged native tool smoke failed/.test(error.message) && /Cannot find module 'jiti'|Jiti must come from the built archive/.test(error.message));
});
