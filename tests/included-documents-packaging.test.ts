import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { createPackageWithOptions } from "@electron/asar";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);

test("packaged document worker uses Electron's Node and archived libraries with native canvas", { skip: process.platform !== "darwin", timeout: 45_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "workfold-documents-asar-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stage = join(temporary, "app");
  await mkdir(join(stage, "resources", "included-tools"), { recursive: true });
  await cp(join(root, "resources", "included-tools", "documents"), join(stage, "resources", "included-tools", "documents"), { recursive: true });

  // Recreate only the real production dependency graph, preserving nested
  // versions. No symlink back into the contributor checkout may satisfy a load.
  const seen = new Set<string>();
  async function addPackage(name: string, from = join(root, "package.json"), optional = false): Promise<void> {
    const resolver = createRequire(from);
    let metadataPath: string;
    try { metadataPath = resolver.resolve(`${name}/package.json`); }
    catch {
      try {
        let directory = dirname(resolver.resolve(name));
        for (;;) {
          try {
            const candidate = join(directory, "package.json");
            if (JSON.parse(await readFile(candidate, "utf8")).name === name) { metadataPath = candidate; break; }
          } catch { /* Some packages expose only their entry point. */ }
          const parent = dirname(directory);
          if (parent === directory) throw new Error(`Cannot find ${name} package metadata.`);
          directory = parent;
        }
      } catch (error) { if (optional) return; throw error; }
    }
    if (seen.has(metadataPath!)) return;
    seen.add(metadataPath!);
    const metadata = JSON.parse(await readFile(metadataPath!, "utf8"));
    const directory = dirname(metadataPath!);
    await cp(directory, join(stage, relative(root, directory)), {
      recursive: true, filter: (path) => !relative(directory, path).split(/[\\/]/).includes("node_modules"),
    });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) await addPackage(dependency, metadataPath!);
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) await addPackage(dependency, metadataPath!, true);
  }
  for (const name of ["docx", "exceljs", "pptxgenjs", "pdf-lib", "pdfjs-dist", "@napi-rs/canvas", "jszip", "acorn"]) await addPackage(name);

  const output = join(temporary, "outputs");
  await mkdir(output);
  await writeFile(join(output, "bad.mjs"), 'export default async () => {\n const label = "Keep "Photos" Safe";\n};');
  await writeFile(join(stage, "package.json"), JSON.stringify({ name: "document-runtime-smoke", version: "1.0.0", main: "main.cjs" }));
  await writeFile(join(stage, "main.cjs"), `
    const {app}=require('electron');
    app.setPath('userData',${JSON.stringify(join(temporary, "profile"))});
    app.whenReady().then(async()=>{try{
      const {probeIncludedDocuments,runDocumentScript}=await import('./resources/included-tools/documents/runtime.mjs');
      const readiness=await probeIncludedDocuments(); if(readiness.state!=='ready')throw Error(readiness.reason);
      const result=await runDocumentScript({script:${JSON.stringify(join(root, "tests/fixtures/included-tools/documents/create-all.mjs"))},cwd:${JSON.stringify(output)}});
      if(result.logs)throw Error(result.logs);
      const parsed=JSON.parse(result.value);
      let diagnostic='';try{await runDocumentScript({script:'bad.mjs',cwd:${JSON.stringify(output)}})}catch(error){diagnostic=error.message;}
      console.log(JSON.stringify({readiness,diagnostic,files:parsed.files,text:parsed.text.pages[0].text,images:result.images.map(image=>image.provenance)}));
      app.exit(0);
    }catch(error){console.error(error);app.exit(1)}});
  `);
  const config = require("../electron-builder.desktop.cjs");
  assert.ok(config.asarUnpack.includes("resources/included-tools/documents/worker.mjs"));
  assert.ok(config.asarUnpack.includes("node_modules/@napi-rs/**/*.node"));
  const archive = join(temporary, "app.asar");
  // The low-level asar API matches absolute paths; electron-builder's file
  // matcher instead takes the same patterns relative to the app root.
  await createPackageWithOptions(stage, archive, { unpack: `{${config.asarUnpack.map((path: string) => `**/${path}`).join(",")}}` });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await promisify(execFile)(require("electron"), [archive, `--user-data-dir=${join(temporary, "profile")}`], { env, timeout: 30_000, maxBuffer: 512 * 1024 });
  assert.equal(stderr.trim(), "");
  const result = JSON.parse(stdout.trim());
  assert.equal(result.readiness.state, "ready");
  assert.ok(result.readiness.runtime.electron);
  assert.match(result.text, /Launch plan/);
  assert.match(result.diagnostic, /bad\.mjs:2:\d+/);
  assert.equal(result.images.length, 1);
  for (const path of result.files) assert.ok((await readFile(path)).length > 100);
  assert.equal(result.images[0].renderer, "pdfjs-dist@6.3.289");
});
